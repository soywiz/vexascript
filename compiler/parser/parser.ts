import { ListReader } from "compiler/utils/ListReader";
import { Token } from "./tokenizer";
import {
    ArrayLiteral,
    AssignmentExpression,
    BinaryExpression,
    Expr,
    Identifier,
    IntLiteral,
    LetStatement,
    MemberExpression,
    ObjectLiteral,
    ObjectProperty,
    Program,
    Statement,
    StringLiteral,
    UnaryExpression
} from "compiler/ast/ast";

type BinaryOperator = BinaryExpression["operator"]
type AssignmentOperator = AssignmentExpression["operator"]
const ASSIGNMENT_OPERATORS: readonly AssignmentOperator[] = ["+=", "-=", "%=", "*=", "/=", "&=", "|=", "&&=", "||="]

export interface ParseIssue {
    message: string;
    token?: Token;
}

export class ParseError extends Error {
    token?: Token;

    constructor(message: string, token?: Token) {
        super(message);
        this.name = "ParseError";
        this.token = token;
    }
}

function fail(message: string, token?: Token): never {
    throw new ParseError(message, token);
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

    fail("Expected ',' or ']' in array literal", r.peek())
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

    fail("Expected ',' or '}' in object literal", r.peek())
}

function parsePrimary(r: ListReader<Token>): Expr {
    const token = r.read();

    if (token?.type === "symbol" && token.value === "(") {
        const expr = parseExpression(r);
        const close = r.read();
        if (close?.type !== "symbol" || close.value !== ")") {
            fail("Expected ')' after parenthesized expression", close ?? r.peek());
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

    fail("Expected a number literal, string literal, identifier, '(', '[' or '{'", token ?? r.peek());
}

function parsePostfix(r: ListReader<Token>): Expr {
    let expr = parsePrimary(r)

    while (r.hasMore) {
        const token = r.peek()

        if (token?.type === "symbol" && token.value === ".") {
            r.skip()
            const property = r.read()
            if (property?.type !== "identifier") {
                fail("Expected identifier after '.'", property ?? r.peek())
            }

            expr = {
                kind: "MemberExpression",
                object: expr,
                property: { kind: "Identifier", name: property.value } as Identifier,
                computed: false
            } as MemberExpression
            continue
        }

        if (token?.type === "symbol" && token.value === "[") {
            r.skip()
            const property = parseExpression(r)
            const close = r.read()
            if (close?.type !== "symbol" || close.value !== "]") {
                fail("Expected ']' after computed member access", close ?? r.peek())
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

function parseBitwiseAnd(r: ListReader<Token>): Expr {
    return parseLeftAssociative(r, ["&"], parseAdditive)
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
        fail("Expected 'let' statement", letKeyword ?? r.peek())
    }

    const nameToken = r.read()
    if (nameToken?.type !== "identifier") {
        fail("Expected identifier after 'let'", nameToken ?? r.peek())
    }

    const equalsToken = r.read()
    if (equalsToken?.type !== "symbol" || equalsToken.value !== "=") {
        fail("Expected '=' in let statement", equalsToken ?? r.peek())
    }

    const initializer = parseExpression(r)
    return {
        kind: "LetStatement",
        name: { kind: "Identifier", name: nameToken.value } as Identifier,
        initializer
    } as LetStatement
}

export function parseStatement(r: ListReader<Token>): Statement {
    const token = r.peek()
    if (token?.type === "identifier" && token.value === "let") {
        return parseLetStatement(r)
    }

    fail("Expected statement", token)
}

export function parseFile(r: ListReader<Token>): Program {
    const body: Statement[] = []

    while (r.hasMore) {
        if (r.peek()?.type === "symbol" && r.peek()?.value === ";") {
            r.skip()
            continue
        }

        body.push(parseStatement(r))

        if (r.peek()?.type === "symbol" && r.peek()?.value === ";") {
            r.skip()
        } else if (r.hasMore) {
            fail("Expected ';' between statements", r.peek())
        }
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
            this.recover();
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

            const statement = this.parseStatement();
            if (statement) {
                body.push(statement);
            }
        }

        return { kind: "Program", body } as Program;
    }

    emitError(message: string, token: Token | undefined = this.tokens.peek()): void {
        this.errors.push({ message, token });
    }

    recover(): void {
        while (this.tokens.hasMore) {
            const token = this.tokens.peek();
            if (token?.type === "symbol" && token.value === ";") {
                this.tokens.skip();
                return;
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
