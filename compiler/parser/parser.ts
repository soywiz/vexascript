import { ListReader } from "compiler/utils/ListReader";
import { Token } from "./tokenizer";
import {
    ArrayLiteral,
    AssignmentExpression,
    BinaryExpression,
    BreakStatement,
    BlockStatement,
    ContinueStatement,
    ClassFieldMember,
    ClassMember,
    ClassMethodMember,
    ClassPrimaryConstructorParameter,
    ClassStatement,
    DoWhileStatement,
    Expr,
    ExprStatement,
    FunctionDeclarationKind,
    FunctionParameter,
    FunctionStatement,
    Identifier,
    IntLiteral,
    VarStatement,
    MemberExpression,
    ObjectLiteral,
    ObjectProperty,
    Program,
    Statement,
    StringLiteral,
    UnaryExpression,
    VariableDeclarationKind,
    ReturnStatement,
    WhileStatement
} from "compiler/ast/ast";

type BinaryOperator = BinaryExpression["operator"]
type AssignmentOperator = AssignmentExpression["operator"]
const ASSIGNMENT_OPERATORS: readonly AssignmentOperator[] = ["=", "+=", "-=", "%=", "*=", "/=", "&=", "|=", "&&=", "||="]
const VARIABLE_DECLARATION_KEYWORDS: readonly VariableDeclarationKind[] = ["let", "var", "val", "const"];
const FUNCTION_DECLARATION_KEYWORDS: readonly FunctionDeclarationKind[] = ["fun", "function"];

export interface ParseIssue {
    message: string;
    token?: Token;
}

type RecoveryHint = "block";

export class ParseError extends Error {
    token?: Token;
    recoveryHint?: RecoveryHint;

    constructor(message: string, token?: Token, recoveryHint?: RecoveryHint) {
        super(message);
        this.name = "ParseError";
        this.token = token;
        this.recoveryHint = recoveryHint;
    }
}

function fail(message: string, token?: Token, recoveryHint?: RecoveryHint): never {
    throw new ParseError(message, token, recoveryHint);
}

function getLastReadToken(r: ListReader<Token>): Token | undefined {
    if (r.offset <= 0) {
        return undefined;
    }
    return r.items[r.offset - 1];
}

function tokenAt(r: ListReader<Token>, preferred?: Token): Token | undefined {
    return preferred ?? r.peek() ?? getLastReadToken(r);
}

function hasLineBreakBetween(a: Token | undefined, b: Token | undefined): boolean {
    if (!a || !b) {
        return false;
    }
    return a.range.end.line < b.range.start.line;
}

function consumeStatementSeparator(
    r: ListReader<Token>,
    context: "file" | "block",
    previousToken: Token | undefined
): void {
    if (!r.hasMore) {
        return;
    }

    const next = r.peek();
    if (next?.type === "symbol" && next.value === ";") {
        r.skip();
        return;
    }

    if (context === "block" && next?.type === "symbol" && next.value === "}") {
        return;
    }

    if (hasLineBreakBetween(previousToken, next)) {
        return;
    }

    const suffix = context === "block" ? "or '}'" : "or end of file";
    fail(`Expected ';', newline, ${suffix} between statements`, next, context === "block" ? "block" : undefined);
}

function buildBinary(operator: BinaryOperator, left: Expr, right: Expr): BinaryExpression {
    return {
        kind: "BinaryExpression",
        operator,
        left,
        right
    }
}

function parseLeftAssociative(
    r: ListReader<Token>,
    operators: readonly BinaryOperator[],
    parseNext: (reader: ListReader<Token>) => Expr
): Expr {
    let left = parseNext(r)

    while (r.hasMore) {
        const token = r.peek()
        if (token?.type !== "symbol" || !operators.includes(token.value as BinaryOperator)) {
            break
        }

        r.skip()
        const right = parseNext(r)
        left = buildBinary(token.value as BinaryOperator, left, right)
    }

    return left
}

function parseArrayLiteral(r: ListReader<Token>): ArrayLiteral {
    const elements: Expr[] = []

    if (r.peek()?.type === "symbol" && r.peek()?.value === "]") {
        r.skip()
        return {
            kind: "ArrayLiteral",
            elements
        } as ArrayLiteral
    }

    while (r.hasMore) {
        elements.push(parseExpression(r))

        const separator = r.peek()
        if (separator?.type === "symbol" && separator.value === ",") {
            r.skip()
            continue
        }

        if (separator?.type === "symbol" && separator.value === "]") {
            r.skip()
            return {
                kind: "ArrayLiteral",
                elements
            } as ArrayLiteral
        }

        break
    }

    fail("Expected ',' or ']' in array literal", tokenAt(r))
}

function parseObjectLiteral(r: ListReader<Token>): ObjectLiteral {
    const properties: ObjectProperty[] = []

    if (r.peek()?.type === "symbol" && r.peek()?.value === "}") {
        r.skip()
        return {
            kind: "ObjectLiteral",
            properties
        } as ObjectLiteral
    }

    while (r.hasMore) {
        const key = r.read()
        if (key?.type !== "identifier") {
            fail("Expected identifier key in object literal", key)
        }

        const colon = r.read()
        if (colon?.type !== "symbol" || colon.value !== ":") {
            fail("Expected ':' after object key", colon)
        }

        properties.push({
            kind: "ObjectProperty",
            key: { kind: "Identifier", name: key.value } as Identifier,
            value: parseExpression(r)
        } as ObjectProperty)

        const separator = r.peek()
        if (separator?.type === "symbol" && separator.value === ",") {
            r.skip()
            continue
        }

        if (separator?.type === "symbol" && separator.value === "}") {
            r.skip()
            return {
                kind: "ObjectLiteral",
                properties
            } as ObjectLiteral
        }

        break
    }

    fail("Expected ',' or '}' in object literal", tokenAt(r))
}

function parsePrimary(r: ListReader<Token>): Expr {
    const token = r.read();

    if (token?.type === "symbol" && token.value === "(") {
        const expr = parseExpression(r);
        const close = r.read();
        if (close?.type !== "symbol" || close.value !== ")") {
            fail("Expected ')' after parenthesized expression", tokenAt(r, close));
        }
        return expr;
    }

    if (token?.type === "symbol" && token.value === "[") {
        return parseArrayLiteral(r)
    }

    if (token?.type === "symbol" && token.value === "{") {
        return parseObjectLiteral(r)
    }

    if (token?.type === "number") {
        return { kind: "IntLiteral", value: parseInt(token.value, 10) } as IntLiteral;
    }

    if (token?.type === "string") {
        return { kind: "StringLiteral", value: token.value } as StringLiteral;
    }

    if (token?.type === "identifier") {
        return { kind: "Identifier", name: token.value } as Identifier;
    }

    fail("Expected a number literal, string literal, identifier, '(', '[' or '{'", tokenAt(r, token));
}

function parsePostfix(r: ListReader<Token>): Expr {
    let expr = parsePrimary(r)

    while (r.hasMore) {
        const token = r.peek()

        if (token?.type === "symbol" && (token.value === "." || token.value === "?." || token.value === "!.")) {
            r.skip()
            const property = r.read()
            if (property?.type !== "identifier") {
                fail(`Expected identifier after '${token.value}'`, tokenAt(r, property ?? token))
            }

            expr = {
                kind: "MemberExpression",
                object: expr,
                property: { kind: "Identifier", name: property.value } as Identifier,
                computed: false,
                optional: token.value === "?." ? true : undefined,
                nonNullAsserted: token.value === "!." ? true : undefined
            } as MemberExpression
            continue
        }

        if (token?.type === "symbol" && token.value === "[") {
            r.skip()
            const property = parseExpression(r)
            const close = r.read()
            if (close?.type !== "symbol" || close.value !== "]") {
                fail("Expected ']' after computed member access", tokenAt(r, close))
            }

            expr = {
                kind: "MemberExpression",
                object: expr,
                property,
                computed: true
            } as MemberExpression
            continue
        }

        break
    }

    return expr
}

function parseUnary(r: ListReader<Token>): Expr {
    const token = r.peek()
    if (token?.type === "symbol" && (token.value === "+" || token.value === "-")) {
        r.skip()
        const argument = parseUnary(r)
        return {
            kind: "UnaryExpression",
            operator: token.value,
            argument
        } as UnaryExpression
    }

    return parsePostfix(r)
}

function parseExponentiation(r: ListReader<Token>): Expr {
    const left = parseUnary(r)
    if (r.peek()?.type === "symbol" && r.peek()?.value === "**") {
        r.skip()
        const right = parseExponentiation(r)
        return buildBinary("**", left, right)
    }
    return left
}

function parseMultiplicative(r: ListReader<Token>): Expr {
    return parseLeftAssociative(r, ["*", "/", "%"], parseExponentiation)
}

function parseAdditive(r: ListReader<Token>): Expr {
    return parseLeftAssociative(r, ["+", "-"], parseMultiplicative)
}

function parseRelational(r: ListReader<Token>): Expr {
    return parseLeftAssociative(r, ["<", ">", "<=", ">="], parseAdditive)
}

function parseEquality(r: ListReader<Token>): Expr {
    return parseLeftAssociative(r, ["===", "!=="], parseRelational)
}

function parseBitwiseAnd(r: ListReader<Token>): Expr {
    return parseLeftAssociative(r, ["&"], parseEquality)
}

function parseBitwiseXor(r: ListReader<Token>): Expr {
    return parseLeftAssociative(r, ["^"], parseBitwiseAnd)
}

function parseBitwiseOr(r: ListReader<Token>): Expr {
    return parseLeftAssociative(r, ["|"], parseBitwiseXor)
}

function parseLogicalAnd(r: ListReader<Token>): Expr {
    return parseLeftAssociative(r, ["&&"], parseBitwiseOr)
}

function parseLogicalOr(r: ListReader<Token>): Expr {
    return parseLeftAssociative(r, ["||"], parseLogicalAnd)
}

function parseAssignment(r: ListReader<Token>): Expr {
    const left = parseLogicalOr(r)
    const token = r.peek()

    if (token?.type === "symbol" && ASSIGNMENT_OPERATORS.includes(token.value as AssignmentOperator)) {
        r.skip()
        const right = parseAssignment(r)
        return {
            kind: "AssignmentExpression",
            operator: token.value as AssignmentOperator,
            left,
            right
        } as AssignmentExpression
    }

    return left
}

export function parseExpression(r: ListReader<Token>): Expr {
    return parseAssignment(r)
}

function parseVarStatement(r: ListReader<Token>): VarStatement {
    const declarationKeyword = r.read()
    if (
        declarationKeyword?.type !== "identifier" ||
        !VARIABLE_DECLARATION_KEYWORDS.includes(declarationKeyword.value as VariableDeclarationKind)
    ) {
        fail("Expected variable declaration statement", tokenAt(r, declarationKeyword))
    }

    const nameToken = r.read()
    if (nameToken?.type !== "identifier") {
        fail("Expected identifier after 'let'", tokenAt(r, nameToken))
    }

    let typeAnnotation: Identifier | undefined
    const maybeColon = r.peek()
    if (maybeColon?.type === "symbol" && maybeColon.value === ":") {
        r.skip()
        const typeToken = r.read()
        if (typeToken?.type !== "identifier") {
            fail("Expected type identifier after ':' in let statement", tokenAt(r, typeToken))
        }
        typeAnnotation = { kind: "Identifier", name: typeToken.value } as Identifier
    }

    let initializer: Expr | undefined
    const maybeEquals = r.peek()
    if (maybeEquals?.type === "symbol" && maybeEquals.value === "=") {
        r.skip()
        initializer = parseExpression(r)
    }

    const statement: VarStatement = {
        kind: "VarStatement",
        declarationKind: declarationKeyword.value as VariableDeclarationKind,
        name: { kind: "Identifier", name: nameToken.value } as Identifier
    }
    if (typeAnnotation) {
        statement.typeAnnotation = typeAnnotation
    }
    if (initializer) {
        statement.initializer = initializer
    }
    return statement
}

function parseFunctionStatement(r: ListReader<Token>): FunctionStatement {
    const declarationKeyword = r.read()
    if (
        declarationKeyword?.type !== "identifier" ||
        !FUNCTION_DECLARATION_KEYWORDS.includes(declarationKeyword.value as FunctionDeclarationKind)
    ) {
        fail("Expected function declaration statement", tokenAt(r, declarationKeyword))
    }

    const nameToken = r.read()
    if (nameToken?.type !== "identifier") {
        fail("Expected function name after declaration keyword", tokenAt(r, nameToken))
    }

    const openParen = r.read()
    if (openParen?.type !== "symbol" || openParen.value !== "(") {
        fail("Expected '(' after function name", tokenAt(r, openParen))
    }

    const parameters: FunctionParameter[] = []
    parameters.push(...parseFunctionParameters(r))

    const closeParen = r.read()
    if (closeParen?.type !== "symbol" || closeParen.value !== ")") {
        fail("Expected ')' after function parameters", tokenAt(r, closeParen))
    }

    let returnType: Identifier | undefined
    if (r.peek()?.type === "symbol" && r.peek()?.value === ":") {
        r.skip()
        const returnTypeToken = r.read()
        if (returnTypeToken?.type !== "identifier") {
            fail("Expected return type after ':' in function declaration", tokenAt(r, returnTypeToken))
        }
        returnType = { kind: "Identifier", name: returnTypeToken.value } as Identifier
    }

    if (r.peek()?.type !== "symbol" || r.peek()?.value !== "{") {
        fail("Expected '{' to start function body", tokenAt(r))
    }
    const body = parseBlockStatement(r)

    const statement: FunctionStatement = {
        kind: "FunctionStatement",
        declarationKind: declarationKeyword.value as FunctionDeclarationKind,
        name: { kind: "Identifier", name: nameToken.value } as Identifier,
        parameters,
        body
    }
    if (returnType) {
        statement.returnType = returnType
    }

    return statement
}

function parseFunctionParameters(r: ListReader<Token>): FunctionParameter[] {
    const parameters: FunctionParameter[] = []
    if (r.peek()?.type === "symbol" && r.peek()?.value === ")") {
        return parameters
    }

    while (r.hasMore) {
        const parameterNameToken = r.read()
        if (parameterNameToken?.type !== "identifier") {
            fail("Expected parameter name in function declaration", tokenAt(r, parameterNameToken))
        }

        let parameterOptional = false
        if (r.peek()?.type === "symbol" && r.peek()?.value === "?") {
            r.skip()
            parameterOptional = true
        }

        let parameterTypeAnnotation: Identifier | undefined
        if (r.peek()?.type === "symbol" && r.peek()?.value === ":") {
            r.skip()
            const parameterTypeToken = r.read()
            if (parameterTypeToken?.type !== "identifier") {
                fail("Expected parameter type after ':'", tokenAt(r, parameterTypeToken))
            }
            parameterTypeAnnotation = { kind: "Identifier", name: parameterTypeToken.value } as Identifier
        }

        let parameterDefaultValue: Expr | undefined
        if (r.peek()?.type === "symbol" && r.peek()?.value === "=") {
            r.skip()
            parameterDefaultValue = parseExpression(r)
        }

        const parameter: FunctionParameter = {
            kind: "FunctionParameter",
            name: { kind: "Identifier", name: parameterNameToken.value } as Identifier
        }
        if (parameterOptional) {
            parameter.optional = true
        }
        if (parameterTypeAnnotation) {
            parameter.typeAnnotation = parameterTypeAnnotation
        }
        if (parameterDefaultValue) {
            parameter.defaultValue = parameterDefaultValue
        }
        parameters.push(parameter)

        const separator = r.peek()
        if (separator?.type === "symbol" && separator.value === ",") {
            r.skip()
            continue
        }
        if (separator?.type === "symbol" && separator.value === ")") {
            break
        }
        fail("Expected ',' or ')' in function parameter list", tokenAt(r, separator))
    }

    return parameters
}

function parseClassMember(r: ListReader<Token>): ClassMember {
    const memberNameToken = r.read()
    if (memberNameToken?.type !== "identifier") {
        fail("Expected class member name", tokenAt(r, memberNameToken))
    }

    if (r.peek()?.type === "symbol" && r.peek()?.value === "(") {
        r.skip()
        const parameters = parseFunctionParameters(r)

        const closeParen = r.read()
        if (closeParen?.type !== "symbol" || closeParen.value !== ")") {
            fail("Expected ')' after method parameters", tokenAt(r, closeParen))
        }

        let returnType: Identifier | undefined
        if (r.peek()?.type === "symbol" && r.peek()?.value === ":") {
            r.skip()
            const returnTypeToken = r.read()
            if (returnTypeToken?.type !== "identifier") {
                fail("Expected return type after ':' in class method", tokenAt(r, returnTypeToken))
            }
            returnType = { kind: "Identifier", name: returnTypeToken.value } as Identifier
        }

        if (r.peek()?.type !== "symbol" || r.peek()?.value !== "{") {
            fail("Expected '{' to start class method body", tokenAt(r))
        }

        const methodMember: ClassMethodMember = {
            kind: "ClassMethodMember",
            name: { kind: "Identifier", name: memberNameToken.value } as Identifier,
            parameters,
            body: parseBlockStatement(r)
        }
        if (returnType) {
            methodMember.returnType = returnType
        }

        return methodMember
    }

    let typeAnnotation: Identifier | undefined
    if (r.peek()?.type === "symbol" && r.peek()?.value === ":") {
        r.skip()
        const typeToken = r.read()
        if (typeToken?.type !== "identifier") {
            fail("Expected type identifier after ':' in class field", tokenAt(r, typeToken))
        }
        typeAnnotation = { kind: "Identifier", name: typeToken.value } as Identifier
    }

    let initializer: Expr | undefined
    if (r.peek()?.type === "symbol" && r.peek()?.value === "=") {
        r.skip()
        initializer = parseExpression(r)
    }

    const fieldMember: ClassFieldMember = {
        kind: "ClassFieldMember",
        name: { kind: "Identifier", name: memberNameToken.value } as Identifier
    }
    if (typeAnnotation) {
        fieldMember.typeAnnotation = typeAnnotation
    }
    if (initializer) {
        fieldMember.initializer = initializer
    }
    return fieldMember
}

function parseClassPrimaryConstructorParameters(r: ListReader<Token>): ClassPrimaryConstructorParameter[] {
    const parameters: ClassPrimaryConstructorParameter[] = []
    if (r.peek()?.type === "symbol" && r.peek()?.value === ")") {
        return parameters
    }

    while (r.hasMore) {
        const declarationToken = r.read()
        if (
            declarationToken?.type !== "identifier" ||
            !VARIABLE_DECLARATION_KEYWORDS.includes(declarationToken.value as VariableDeclarationKind)
        ) {
            fail("Expected declaration keyword in class primary constructor parameter", tokenAt(r, declarationToken))
        }

        const parameterNameToken = r.read()
        if (parameterNameToken?.type !== "identifier") {
            fail("Expected parameter name in class primary constructor", tokenAt(r, parameterNameToken))
        }

        let parameterTypeAnnotation: Identifier | undefined
        if (r.peek()?.type === "symbol" && r.peek()?.value === ":") {
            r.skip()
            const parameterTypeToken = r.read()
            if (parameterTypeToken?.type !== "identifier") {
                fail("Expected parameter type after ':'", tokenAt(r, parameterTypeToken))
            }
            parameterTypeAnnotation = { kind: "Identifier", name: parameterTypeToken.value } as Identifier
        }

        let parameterDefaultValue: Expr | undefined
        if (r.peek()?.type === "symbol" && r.peek()?.value === "=") {
            r.skip()
            parameterDefaultValue = parseExpression(r)
        }

        const parameter: ClassPrimaryConstructorParameter = {
            kind: "ClassPrimaryConstructorParameter",
            declarationKind: declarationToken.value as VariableDeclarationKind,
            name: { kind: "Identifier", name: parameterNameToken.value } as Identifier
        }
        if (parameterTypeAnnotation) {
            parameter.typeAnnotation = parameterTypeAnnotation
        }
        if (parameterDefaultValue) {
            parameter.defaultValue = parameterDefaultValue
        }
        parameters.push(parameter)

        const separator = r.peek()
        if (separator?.type === "symbol" && separator.value === ",") {
            r.skip()
            continue
        }
        if (separator?.type === "symbol" && separator.value === ")") {
            break
        }
        fail("Expected ',' or ')' in class primary constructor parameter list", tokenAt(r, separator))
    }

    return parameters
}

function parseClassStatement(r: ListReader<Token>): ClassStatement {
    const classKeyword = r.read()
    if (classKeyword?.type !== "identifier" || classKeyword.value !== "class") {
        fail("Expected class declaration statement", tokenAt(r, classKeyword))
    }

    const classNameToken = r.read()
    if (classNameToken?.type !== "identifier") {
        fail("Expected class name after 'class'", tokenAt(r, classNameToken))
    }

    let primaryConstructorParameters: ClassPrimaryConstructorParameter[] | undefined
    if (r.peek()?.type === "symbol" && r.peek()?.value === "(") {
        r.skip()
        primaryConstructorParameters = parseClassPrimaryConstructorParameters(r)

        const closeParen = r.read()
        if (closeParen?.type !== "symbol" || closeParen.value !== ")") {
            fail("Expected ')' after class primary constructor parameters", tokenAt(r, closeParen))
        }
    }

    const openBrace = r.read()
    if (openBrace?.type !== "symbol" || openBrace.value !== "{") {
        fail("Expected '{' to start class body", tokenAt(r, openBrace))
    }

    const members: ClassMember[] = []
    while (r.hasMore) {
        const token = r.peek()
        if (token?.type === "symbol" && token.value === "}") {
            r.skip()
            const statement: ClassStatement = {
                kind: "ClassStatement",
                name: { kind: "Identifier", name: classNameToken.value } as Identifier,
                members
            }
            if (primaryConstructorParameters && primaryConstructorParameters.length > 0) {
                statement.primaryConstructorParameters = primaryConstructorParameters
            }
            return statement
        }

        if (token?.type === "symbol" && token.value === ";") {
            r.skip()
            continue
        }

        const member = parseClassMember(r)
        members.push(member)
        consumeStatementSeparator(r, "block", getLastReadToken(r))
    }

    fail("Expected '}' to close class body", tokenAt(r, openBrace), "block")
}

function parseBlockStatement(r: ListReader<Token>): BlockStatement {
    const openBrace = r.read()
    if (openBrace?.type !== "symbol" || openBrace.value !== "{") {
        fail("Expected '{' to start block statement", tokenAt(r, openBrace))
    }

    const body: Statement[] = []

    while (r.hasMore) {
        const token = r.peek()

        if (token?.type === "symbol" && token.value === "}") {
            r.skip()
            return {
                kind: "BlockStatement",
                body
            } as BlockStatement
        }

        if (token?.type === "symbol" && token.value === ";") {
            r.skip()
            continue
        }

        try {
            const statement = parseStatement(r)
            body.push(statement)
            consumeStatementSeparator(r, "block", getLastReadToken(r))
        } catch (error) {
            if (error instanceof ParseError) {
                throw new ParseError(error.message, error.token, "block")
            }
            throw error
        }
    }

    fail("Expected '}' to close block statement", tokenAt(r, openBrace), "block")
}

function parseWhileStatement(r: ListReader<Token>): WhileStatement {
    const whileKeyword = r.read()
    if (whileKeyword?.type !== "identifier" || whileKeyword.value !== "while") {
        fail("Expected 'while' statement", tokenAt(r, whileKeyword))
    }

    const openParen = r.read()
    if (openParen?.type !== "symbol" || openParen.value !== "(") {
        fail("Expected '(' after 'while'", tokenAt(r, openParen))
    }

    const condition = parseExpression(r)

    const closeParen = r.read()
    if (closeParen?.type !== "symbol" || closeParen.value !== ")") {
        fail("Expected ')' after while condition", tokenAt(r, closeParen))
    }

    const body = parseStatement(r)
    return {
        kind: "WhileStatement",
        condition,
        body
    } as WhileStatement
}

function parseDoWhileStatement(r: ListReader<Token>): DoWhileStatement {
    const doKeyword = r.read()
    if (doKeyword?.type !== "identifier" || doKeyword.value !== "do") {
        fail("Expected 'do' statement", tokenAt(r, doKeyword))
    }

    const body = parseStatement(r)

    const whileKeyword = r.read()
    if (whileKeyword?.type !== "identifier" || whileKeyword.value !== "while") {
        fail("Expected 'while' after do-statement body", tokenAt(r, whileKeyword))
    }

    const openParen = r.read()
    if (openParen?.type !== "symbol" || openParen.value !== "(") {
        fail("Expected '(' after 'while'", tokenAt(r, openParen))
    }

    const condition = parseExpression(r)

    const closeParen = r.read()
    if (closeParen?.type !== "symbol" || closeParen.value !== ")") {
        fail("Expected ')' after do-while condition", tokenAt(r, closeParen))
    }

    return {
        kind: "DoWhileStatement",
        body,
        condition
    } as DoWhileStatement
}

function parseReturnStatement(r: ListReader<Token>): ReturnStatement {
    const returnKeyword = r.read()
    if (returnKeyword?.type !== "identifier" || returnKeyword.value !== "return") {
        fail("Expected 'return' statement", tokenAt(r, returnKeyword))
    }

    const next = r.peek()
    if (!next) {
        return { kind: "ReturnStatement" } as ReturnStatement
    }
    if (next.type === "symbol" && (next.value === ";" || next.value === "}")) {
        return { kind: "ReturnStatement" } as ReturnStatement
    }
    if (hasLineBreakBetween(returnKeyword, next)) {
        return { kind: "ReturnStatement" } as ReturnStatement
    }

    return {
        kind: "ReturnStatement",
        expression: parseExpression(r)
    } as ReturnStatement
}

function parseContinueStatement(r: ListReader<Token>): ContinueStatement {
    const continueKeyword = r.read()
    if (continueKeyword?.type !== "identifier" || continueKeyword.value !== "continue") {
        fail("Expected 'continue' statement", tokenAt(r, continueKeyword))
    }
    return { kind: "ContinueStatement" } as ContinueStatement
}

function parseBreakStatement(r: ListReader<Token>): BreakStatement {
    const breakKeyword = r.read()
    if (breakKeyword?.type !== "identifier" || breakKeyword.value !== "break") {
        fail("Expected 'break' statement", tokenAt(r, breakKeyword))
    }
    return { kind: "BreakStatement" } as BreakStatement
}

export function parseStatement(r: ListReader<Token>): Statement {
    const token = r.peek()
    if (token?.type === "identifier" && VARIABLE_DECLARATION_KEYWORDS.includes(token.value as VariableDeclarationKind)) {
        return parseVarStatement(r)
    }
    if (token?.type === "identifier" && FUNCTION_DECLARATION_KEYWORDS.includes(token.value as FunctionDeclarationKind)) {
        return parseFunctionStatement(r)
    }
    if (token?.type === "identifier" && token.value === "class") {
        return parseClassStatement(r)
    }
    if (token?.type === "identifier" && token.value === "do") {
        return parseDoWhileStatement(r)
    }
    if (token?.type === "identifier" && token.value === "while") {
        return parseWhileStatement(r)
    }
    if (token?.type === "identifier" && token.value === "return") {
        return parseReturnStatement(r)
    }
    if (token?.type === "identifier" && token.value === "continue") {
        return parseContinueStatement(r)
    }
    if (token?.type === "identifier" && token.value === "break") {
        return parseBreakStatement(r)
    }
    if (token?.type === "symbol" && token.value === "{") {
        return parseBlockStatement(r)
    }

    return {
        kind: "ExprStatement",
        expression: parseExpression(r)
    } as ExprStatement
}

export function parseFile(r: ListReader<Token>): Program {
    const body: Statement[] = []

    while (r.hasMore) {
        if (r.peek()?.type === "symbol" && r.peek()?.value === ";") {
            r.skip()
            continue
        }

        const statement = parseStatement(r)
        body.push(statement)
        consumeStatementSeparator(r, "file", getLastReadToken(r))
    }

    return {
        kind: "Program",
        body
    } as Program
}

export function parseProgram(r: ListReader<Token>): Program {
    return parseFile(r)
}

export class Parser {
    public errors: ParseIssue[] = [];

    constructor(public tokens: ListReader<Token>) { }

    parseExpression(): Expr | null {
        try {
            return parseExpression(this.tokens);
        } catch (error) {
            this.emitErrorFrom(error);
            return null;
        }
    }

    parseStatement(): Statement | null {
        try {
            return parseStatement(this.tokens);
        } catch (error) {
            this.emitErrorFrom(error);
            if (error instanceof ParseError) {
                this.recover(error.recoveryHint);
            } else {
                this.recover();
            }
            return null;
        }
    }

    parseFile(): Program {
        const body: Statement[] = [];

        while (this.tokens.hasMore) {
            if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === ";") {
                this.tokens.skip();
                continue;
            }

            const statementStartOffset = this.tokens.offset;
            const statement = this.parseStatement();
            if (!statement) {
                continue;
            }
            body.push(statement);

            try {
                const previousToken =
                    this.tokens.offset > statementStartOffset
                        ? this.tokens.items[this.tokens.offset - 1]
                        : undefined;
                consumeStatementSeparator(this.tokens, "file", previousToken);
            } catch (error) {
                this.emitErrorFrom(error);
                if (error instanceof ParseError) {
                    this.recover(error.recoveryHint);
                } else {
                    this.recover();
                }
            }
        }

        return { kind: "Program", body } as Program;
    }

    emitError(message: string, token: Token | undefined = this.tokens.peek()): void {
        this.errors.push({ message, token });
    }

    recover(recoveryHint?: RecoveryHint): void {
        if (recoveryHint === "block") {
            this.recoverBlock();
            return;
        }

        while (this.tokens.hasMore) {
            const token = this.tokens.peek();
            if (token?.type === "symbol" && token.value === ";") {
                this.tokens.skip();
                return;
            }
            this.tokens.skip();
        }
    }

    private recoverBlock(): void {
        let balance = 0;

        while (this.tokens.hasMore) {
            const token = this.tokens.peek();

            if (token?.type === "symbol" && token.value === "{") {
                balance += 1;
                this.tokens.skip();
                continue;
            }

            if (token?.type === "symbol" && token.value === "}") {
                balance -= 1;
                this.tokens.skip();
                if (balance < 0) {
                    return;
                }
                continue;
            }

            this.tokens.skip();
        }
    }

    private emitErrorFrom(error: unknown): void {
        if (error instanceof ParseError) {
            this.emitError(error.message, error.token);
            return;
        }

        this.emitError(error instanceof Error ? error.message : String(error));
    }
}
