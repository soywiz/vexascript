import { ListReader } from "compiler/utils/ListReader";
import { Token } from "./tokenizer";
import {
    ArrayLiteral,
    AssignmentExpression,
    BinaryExpression,
    Expr,
    Identifier,
    IntLiteral,
    MemberExpression,
    ObjectLiteral,
    ObjectProperty,
    UnaryExpression
} from "compiler/ast/ast";

type BinaryOperator = BinaryExpression["operator"]
type AssignmentOperator = AssignmentExpression["operator"]
const ASSIGNMENT_OPERATORS: readonly AssignmentOperator[] = ["+=", "-=", "%=", "*=", "/=", "&=", "|=", "&&=", "||="]

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

    throw new Error("Expected ',' or ']' in array literal")
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
            throw new Error("Expected identifier key in object literal")
        }

        const colon = r.read()
        if (colon?.type !== "symbol" || colon.value !== ":") {
            throw new Error("Expected ':' after object key")
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

    throw new Error("Expected ',' or '}' in object literal")
}

function parsePrimary(r: ListReader<Token>): Expr {
    const token = r.read();

    if (token?.type === "symbol" && token.value === "(") {
        const expr = parseExpression(r);
        const close = r.read();
        if (close?.type !== "symbol" || close.value !== ")") {
            throw new Error("Expected ')' after parenthesized expression");
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

    if (token?.type === "identifier") {
        return { kind: "Identifier", name: token.value } as Identifier;
    }

    throw new Error("Expected a number literal, identifier, '(', '[' or '{'");
}

function parsePostfix(r: ListReader<Token>): Expr {
    let expr = parsePrimary(r)

    while (r.hasMore) {
        const token = r.peek()

        if (token?.type === "symbol" && token.value === ".") {
            r.skip()
            const property = r.read()
            if (property?.type !== "identifier") {
                throw new Error("Expected identifier after '.'")
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
                throw new Error("Expected ']' after computed member access")
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
