import { ListReader } from "compiler/utils/ListReader";
import { Token } from "./tokenizer";
import {
    ArrayLiteral,
    AssignmentExpression,
    BinaryExpression,
    BlockStatement,
    DoWhileStatement,
    Expr,
    ExprStatement,
    Identifier,
    IntLiteral,
    LetStatement,
    MemberExpression,
    ObjectLiteral,
    ObjectProperty,
    Program,
    Statement,
    StringLiteral,
    UnaryExpression,
    WhileStatement
} from "compiler/ast/ast";

type BinaryOperator = BinaryExpression["operator"]
type AssignmentOperator = AssignmentExpression["operator"]
const ASSIGNMENT_OPERATORS: readonly AssignmentOperator[] = ["=", "+=", "-=", "%=", "*=", "/=", "&=", "|=", "&&=", "||="]

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

function parseLetStatement(r: ListReader<Token>): LetStatement {
    const letKeyword = r.read()
    if (letKeyword?.type !== "identifier" || letKeyword.value !== "let") {
        fail("Expected 'let' statement", tokenAt(r, letKeyword))
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

    const statement: LetStatement = {
        kind: "LetStatement",
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

export function parseStatement(r: ListReader<Token>): Statement {
    const token = r.peek()
    if (token?.type === "identifier" && token.value === "let") {
        return parseLetStatement(r)
    }
    if (token?.type === "identifier" && token.value === "do") {
        return parseDoWhileStatement(r)
    }
    if (token?.type === "identifier" && token.value === "while") {
        return parseWhileStatement(r)
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
