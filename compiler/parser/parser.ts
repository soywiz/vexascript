import { ListReader } from "compiler/utils/ListReader";
import { Token } from "./tokenizer";
import {
    ArrayLiteral,
    AssignmentExpression,
    BigIntLiteral,
    BinaryExpression,
    BlockStatement,
    BreakStatement,
    CallExpression,
    CatchClause,
    ClassFieldMember,
    ClassMember,
    ClassMethodMember,
    ClassPrimaryConstructorParameter,
    ClassStatement,
    ConditionalExpression,
    ContinueStatement,
    DoWhileStatement,
    Expr,
    ExprStatement,
    ForStatement,
    FloatLiteral,
    FunctionDeclarationKind,
    FunctionParameter,
    FunctionStatement,
    Identifier,
    IfStatement,
    ImportSpecifier,
    ImportStatement,
    IntLiteral,
    LongLiteral,
    MemberExpression,
    NewExpression,
    Node,
    ObjectLiteral,
    ObjectProperty,
    Program,
    RangeExpression,
    ReturnStatement,
    Statement,
    StringLiteral,
    SwitchCase,
    SwitchStatement,
    ThrowStatement,
    TryStatement,
    UnaryExpression,
    UpdateExpression,
    VarDeclarator,
    VariableDeclarationKind,
    VarStatement,
    WhileStatement
} from "compiler/ast/ast";

type BinaryOperator = BinaryExpression["operator"];
type AssignmentOperator = AssignmentExpression["operator"];

const ASSIGNMENT_OPERATORS: readonly AssignmentOperator[] = ["=", "+=", "-=", "%=", "*=", "/=", "&=", "|=", "&&=", "||=", "??=", "<<=", ">>=", ">>>="];
const VARIABLE_DECLARATION_KEYWORDS: readonly VariableDeclarationKind[] = ["let", "var", "val", "const"];
const FUNCTION_DECLARATION_KEYWORDS: readonly FunctionDeclarationKind[] = ["fun", "function"];

export type ParseLanguage = "mylang" | "typescript";

export interface ParserOptions {
    language?: ParseLanguage;
}

export interface ParseIssue {
    message: string;
    token?: Token;
}

type RecoveryHint = "block" | "switch" | "statement";

export class ParseError extends Error {
    token: Token | undefined;
    recoveryHint: RecoveryHint | undefined;

    constructor(message: string, token?: Token, recoveryHint?: RecoveryHint) {
        super(message);
        this.name = "ParseError";
        this.token = token;
        this.recoveryHint = recoveryHint;
    }
}

export class Parser {
    public errors: ParseIssue[] = [];
    public readonly language: ParseLanguage;

    constructor(public tokens: ListReader<Token>, options: ParserOptions = {}) {
        this.language = options.language ?? "mylang";
    }

    parseExpression(): Expr | null {
        try {
            return this.parseExpressionOrThrow();
        } catch (error) {
            this.emitErrorFrom(error);
            return null;
        }
    }

    parseStatement(): Statement | null {
        try {
            return this.parseStatementOrThrow();
        } catch (error) {
            this.emitErrorFrom(error);
            if (error instanceof ParseError) {
                this.recover(error.recoveryHint, error.token);
            } else {
                this.recover();
            }
            return null;
        }
    }

    parseFile(): Program {
        const startToken = this.tokens.peek();
        const body: Statement[] = [];

        while (this.tokens.hasMore) {
            if (this.isEofToken(this.tokens.peek())) {
                this.tokens.skip();
                break;
            }

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
                this.consumeStatementSeparator("file", previousToken);
            } catch (error) {
                this.emitErrorFrom(error);
                if (error instanceof ParseError) {
                    this.recover(error.recoveryHint, error.token);
                } else {
                    this.recover();
                }
            }
        }

        return this.attachNodeBounds(
            { kind: "Program", body } as Program,
            startToken,
            this.getLastNonEofReadToken() ?? startToken
        );
    }

    parseExpressionOrThrow(): Expr {
        return this.parseAssignment();
    }

    parseStatementOrThrow(): Statement {
        const token = this.tokens.peek();
        if (token?.type === "identifier" && this.isVariableDeclarationKeyword(token.value)) {
            return this.parseVarStatement();
        }
        if (token?.type === "identifier" && token.value === "import") {
            return this.parseImportStatement();
        }
        if (token?.type === "identifier" && this.isFunctionDeclarationKeyword(token.value)) {
            return this.parseFunctionStatement();
        }
        if (this.isDeclareFunctionStart()) {
            return this.parseDeclareFunctionStatement();
        }
        if (this.isDeclareVariableStart()) {
            return this.parseDeclareVariableStatement();
        }
        if (this.isDeclareClassStart()) {
            return this.parseDeclareClassStatement();
        }
        if (this.isDeclareNamespaceStart()) {
            return this.parseDeclareNamespaceStatement();
        }
        if (this.isTypeScriptExportAssignmentStart()) {
            return this.parseTypeScriptExportAssignmentStatement();
        }
        if (token?.type === "identifier" && token.value === "class") {
            return this.parseClassStatement();
        }
        if (token?.type === "identifier" && token.value === "do") {
            return this.parseDoWhileStatement();
        }
        if (token?.type === "identifier" && token.value === "for") {
            return this.parseForStatement();
        }
        if (token?.type === "identifier" && token.value === "if") {
            return this.parseIfStatement();
        }
        if (token?.type === "identifier" && token.value === "switch") {
            return this.parseSwitchStatement();
        }
        if (token?.type === "identifier" && token.value === "while") {
            return this.parseWhileStatement();
        }
        if (token?.type === "identifier" && token.value === "return") {
            return this.parseReturnStatement();
        }
        if (token?.type === "identifier" && token.value === "throw") {
            return this.parseThrowStatement();
        }
        if (token?.type === "identifier" && token.value === "continue") {
            return this.parseContinueStatement();
        }
        if (token?.type === "identifier" && token.value === "break") {
            return this.parseBreakStatement();
        }
        if (token?.type === "identifier" && token.value === "try") {
            return this.parseTryStatement();
        }
        if (token?.type === "symbol" && token.value === "{") {
            return this.parseBlockStatement();
        }

        const expression = this.parseExpressionOrThrow();
        return this.attachNodeBounds(
            {
                kind: "ExprStatement",
                expression
            } as ExprStatement,
            expression.firstToken,
            expression.lastToken
        );
    }

    parseFileOrThrow(): Program {
        const startToken = this.tokens.peek();
        const body: Statement[] = [];

        while (this.tokens.hasMore) {
            if (this.isEofToken(this.tokens.peek())) {
                this.tokens.skip();
                break;
            }

            if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === ";") {
                this.tokens.skip();
                continue;
            }

            const statement = this.parseStatementOrThrow();
            body.push(statement);
            this.consumeStatementSeparator("file", this.getLastReadToken());
        }

        return this.attachNodeBounds(
            {
                kind: "Program",
                body
            } as Program,
            startToken,
            this.getLastNonEofReadToken() ?? startToken
        );
    }

    emitError(message: string, token: Token | undefined = this.tokens.peek()): void {
        if (token) {
            this.errors.push({ message, token });
            return;
        }
        this.errors.push({ message });
    }

    recover(recoveryHint?: RecoveryHint, originToken?: Token): void {
        const startToken = originToken ?? this.tokens.peek();
        const startLine = startToken?.range.start.line ?? -1;
        const allowSwitchCaseLabels = recoveryHint === "switch";
        const localStatementRecovery = recoveryHint === "statement";

        if (originToken?.type === "symbol" && (originToken.value === ";" || originToken.value === "}")) {
            return;
        }
        if (
            allowSwitchCaseLabels &&
            originToken?.type === "identifier" &&
            (originToken.value === "case" || originToken.value === "default")
        ) {
            return;
        }
        let parenDepth = 0;
        let bracketDepth = 0;
        let braceDepth = 0;

        while (this.tokens.hasMore) {
            const token = this.tokens.peek();
            if (this.isEofToken(token)) {
                return;
            }

            if (token?.type === "symbol") {
                if (
                    localStatementRecovery &&
                    token.value === "}" &&
                    parenDepth === 0 &&
                    bracketDepth === 0 &&
                    braceDepth === 0
                ) {
                    return;
                }
                if (token.value === "(") {
                    parenDepth += 1;
                    this.tokens.skip();
                    continue;
                }
                if (token.value === "[") {
                    bracketDepth += 1;
                    this.tokens.skip();
                    continue;
                }
                if (token.value === "{") {
                    braceDepth += 1;
                    this.tokens.skip();
                    continue;
                }

                if (token.value === ")") {
                    if (parenDepth > 0) {
                        parenDepth -= 1;
                        this.tokens.skip();
                        continue;
                    }
                }
                if (token.value === "]") {
                    if (bracketDepth > 0) {
                        bracketDepth -= 1;
                        this.tokens.skip();
                        continue;
                    }
                }
                if (token.value === "}") {
                    if (braceDepth > 0) {
                        braceDepth -= 1;
                        this.tokens.skip();
                        continue;
                    }
                    return;
                }

                if (token.value === ";" && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0) {
                    this.tokens.skip();
                    return;
                }
            }

            if (
                localStatementRecovery &&
                startLine >= 0 &&
                token !== undefined &&
                token.range.start.line > startLine &&
                parenDepth === 0 &&
                bracketDepth === 0 &&
                braceDepth === 0
            ) {
                return;
            }
            if (
                allowSwitchCaseLabels &&
                parenDepth === 0 &&
                bracketDepth === 0 &&
                braceDepth === 0 &&
                token?.type === "identifier" &&
                (token.value === "case" || token.value === "default")
            ) {
                return;
            }
            if (
                startLine >= 0 &&
                token !== undefined &&
                token.range.start.line > startLine &&
                parenDepth === 0 &&
                bracketDepth === 0 &&
                braceDepth === 0 &&
                this.isLikelyStatementStart(token)
            ) {
                return;
            }
            this.tokens.skip();
        }
    }

    private isLikelyStatementStart(token: Token | undefined): boolean {
        if (!token) {
            return false;
        }
        if (token.type === "symbol" && (token.value === "}" || token.value === "{")) {
            return true;
        }
        if (token.type !== "identifier") {
            return false;
        }
        return (
            token.value === "let" ||
            token.value === "var" ||
            token.value === "val" ||
            token.value === "const" ||
            token.value === "fun" ||
            token.value === "function" ||
            token.value === "declare" ||
            token.value === "export" ||
            token.value === "class" ||
            token.value === "if" ||
            token.value === "for" ||
            token.value === "while" ||
            token.value === "do" ||
            token.value === "switch" ||
            token.value === "try" ||
            token.value === "catch" ||
            token.value === "finally" ||
            token.value === "return" ||
            token.value === "throw" ||
            token.value === "break" ||
            token.value === "continue" ||
            token.value === "case" ||
            token.value === "default"
        );
    }

    private emitErrorFrom(error: unknown): void {
        if (error instanceof ParseError) {
            this.emitError(error.message, error.token);
            return;
        }

        this.emitError(error instanceof Error ? error.message : String(error));
    }

    private attachNodeBounds<T extends Node>(node: T, firstToken?: Token, lastToken?: Token): T {
        const resolvedFirst = firstToken ?? this.getLastReadToken();
        const resolvedLast = lastToken ?? this.getLastReadToken() ?? resolvedFirst;
        if (resolvedFirst) {
            Object.defineProperty(node, "firstToken", {
                value: resolvedFirst,
                enumerable: false,
                writable: true,
                configurable: true
            });
        }
        if (resolvedLast) {
            Object.defineProperty(node, "lastToken", {
                value: resolvedLast,
                enumerable: false,
                writable: true,
                configurable: true
            });
        }
        return node;
    }

    private withNodeBounds<T extends Node>(startToken: Token | undefined, build: () => T): T {
        const node = build();
        return this.attachNodeBounds(node, startToken, this.getLastReadToken() ?? startToken);
    }

    private buildIdentifierFromToken(token: Token): Identifier {
        return this.attachNodeBounds(
            { kind: "Identifier", name: token.value } as Identifier,
            token,
            token
        );
    }

    private fail(message: string, token?: Token, recoveryHint?: RecoveryHint): never {
        throw new ParseError(message, token, recoveryHint);
    }

    private isVariableDeclarationKeyword(value: string): boolean {
        if (this.language === "typescript") {
            return value === "let" || value === "var" || value === "const";
        }
        return VARIABLE_DECLARATION_KEYWORDS.includes(value as VariableDeclarationKind);
    }

    private isFunctionDeclarationKeyword(value: string): boolean {
        if (this.language === "typescript") {
            return value === "function";
        }
        return FUNCTION_DECLARATION_KEYWORDS.includes(value as FunctionDeclarationKind);
    }

    private peekToken(offset: number = 0): Token | undefined {
        return this.tokens.items[this.tokens.offset + offset];
    }

    private isDeclareFunctionStart(): boolean {
        const first = this.peekToken(0);
        const second = this.peekToken(1);
        return (
            first?.type === "identifier" &&
            first.value === "declare" &&
            second?.type === "identifier" &&
            second.value === "function"
        );
    }

    private isDeclareVariableStart(): boolean {
        const first = this.peekToken(0);
        const second = this.peekToken(1);
        return (
            first?.type === "identifier" &&
            first.value === "declare" &&
            second?.type === "identifier" &&
            this.isVariableDeclarationKeyword(second.value)
        );
    }

    private isDeclareClassStart(): boolean {
        const first = this.peekToken(0);
        const second = this.peekToken(1);
        return (
            first?.type === "identifier" &&
            first.value === "declare" &&
            second?.type === "identifier" &&
            second.value === "class"
        );
    }

    private isDeclareNamespaceStart(): boolean {
        if (this.language !== "typescript") {
            return false;
        }

        const first = this.peekToken(0);
        const second = this.peekToken(1);
        return (
            first?.type === "identifier" &&
            first.value === "declare" &&
            second?.type === "identifier" &&
            (second.value === "namespace" || second.value === "module")
        );
    }

    private isTypeScriptExportAssignmentStart(): boolean {
        if (this.language !== "typescript") {
            return false;
        }

        const first = this.peekToken(0);
        const second = this.peekToken(1);
        return (
            first?.type === "identifier" &&
            first.value === "export" &&
            second?.type === "symbol" &&
            second.value === "="
        );
    }

    private skipUntilMatchingCloseParen(openParen: Token): Token {
        let depth = 1;

        while (this.tokens.hasMore) {
            const token = this.tokens.read();
            if (!token) {
                break;
            }

            if (token.type === "symbol" && token.value === "(") {
                depth += 1;
                continue;
            }
            if (token.type === "symbol" && token.value === ")") {
                depth -= 1;
                if (depth === 0) {
                    return token;
                }
            }
        }

        this.fail("Expected ')' after function parameters", this.tokenAt(openParen));
    }

    private skipUntilMatchingCloseSymbol(openToken: Token, openValue: string, closeValue: string, missingCloseMessage: string): Token {
        let depth = 1;

        while (this.tokens.hasMore) {
            const token = this.tokens.read();
            if (!token) {
                break;
            }

            if (token.type === "symbol" && token.value === openValue) {
                depth += 1;
                continue;
            }

            if (token.type === "symbol" && token.value === closeValue) {
                depth -= 1;
                if (depth === 0) {
                    return token;
                }
            }
        }

        this.fail(missingCloseMessage, this.tokenAt(openToken));
    }

    private skipTypeAnnotationUntilStatementEnd(): void {
        let parenDepth = 0;
        let bracketDepth = 0;
        let braceDepth = 0;

        while (this.tokens.hasMore) {
            const token = this.tokens.peek();
            if (!token) {
                return;
            }

            if (token.type === "symbol") {
                if (token.value === "(") {
                    parenDepth += 1;
                } else if (token.value === ")") {
                    if (parenDepth > 0) {
                        parenDepth -= 1;
                    }
                } else if (token.value === "[") {
                    bracketDepth += 1;
                } else if (token.value === "]") {
                    if (bracketDepth > 0) {
                        bracketDepth -= 1;
                    }
                } else if (token.value === "{") {
                    braceDepth += 1;
                } else if (token.value === "}") {
                    if (braceDepth > 0) {
                        braceDepth -= 1;
                    }
                }

                if (
                    token.value === ";" &&
                    parenDepth === 0 &&
                    bracketDepth === 0 &&
                    braceDepth === 0
                ) {
                    return;
                }
            }

            this.tokens.skip();
        }
    }

    private getLastReadToken(): Token | undefined {
        if (this.tokens.offset <= 0) {
            return undefined;
        }
        return this.tokens.items[this.tokens.offset - 1];
    }

    private getLastNonEofReadToken(): Token | undefined {
        for (let i = this.tokens.offset - 1; i >= 0; i -= 1) {
            const token = this.tokens.items[i];
            if (token?.type !== "eof") {
                return token;
            }
        }
        return undefined;
    }

    private tokenAt(preferred?: Token): Token | undefined {
        return preferred ?? this.tokens.peek() ?? this.getLastReadToken();
    }

    private isEofToken(token?: Token): boolean {
        return token?.type === "eof";
    }

    private hasLineBreakBetween(a: Token | undefined, b: Token | undefined): boolean {
        if (!a || !b) {
            return false;
        }
        return a.range.end.line < b.range.start.line;
    }

    private consumeStatementSeparator(
        context: "file" | "block",
        previousToken: Token | undefined
    ): void {
        if (!this.tokens.hasMore) {
            return;
        }

        const next = this.tokens.peek();
        if (context === "file" && this.isEofToken(next)) {
            this.tokens.skip();
            return;
        }

        if (next?.type === "symbol" && next.value === ";") {
            this.tokens.skip();
            return;
        }

        if (context === "block" && next?.type === "symbol" && next.value === "}") {
            return;
        }

        if (this.hasLineBreakBetween(previousToken, next)) {
            return;
        }

        const suffix = context === "block" ? "or '}'" : "or end of file";
        this.fail(`Expected ';', newline, ${suffix} between statements`, next, "statement");
    }

    private consumeSwitchStatementSeparator(previousToken: Token | undefined): void {
        if (!this.tokens.hasMore) {
            return;
        }

        const next = this.tokens.peek();
        if (next?.type === "symbol" && next.value === ";") {
            this.tokens.skip();
            return;
        }

        if (next?.type === "symbol" && next.value === "}") {
            return;
        }

        if (next?.type === "identifier" && (next.value === "case" || next.value === "default")) {
            return;
        }

        if (this.hasLineBreakBetween(previousToken, next)) {
            return;
        }

        this.fail("Expected ';', newline, 'case', 'default', or '}' between switch statements", next, "switch");
    }

    private buildBinary(operator: BinaryOperator, left: Expr, right: Expr): BinaryExpression {
        return this.attachNodeBounds({
            kind: "BinaryExpression",
            operator,
            left,
            right
        } as BinaryExpression, left.firstToken, right.lastToken ?? this.getLastReadToken());
    }

    private parseLeftAssociative(
        operators: readonly BinaryOperator[],
        parseNext: () => Expr
    ): Expr {
        let left = parseNext();

        while (this.tokens.hasMore) {
            const token = this.tokens.peek();
            if (token?.type !== "symbol" || !operators.includes(token.value as BinaryOperator)) {
                break;
            }

            this.tokens.skip();
            const right = parseNext();
            left = this.buildBinary(token.value as BinaryOperator, left, right);
        }

        return left;
    }

    private parseArrayLiteral(): ArrayLiteral {
        const startToken = this.getLastReadToken();
        const elements: Expr[] = [];

        if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === "]") {
            this.tokens.skip();
            return this.withNodeBounds(startToken, () => {
                return {
                    kind: "ArrayLiteral",
                    elements
                } as ArrayLiteral;
            });
        }

        while (this.tokens.hasMore) {
            elements.push(this.parseExpressionOrThrow());

            const separator = this.tokens.peek();
            if (separator?.type === "symbol" && separator.value === ",") {
                this.tokens.skip();
                continue;
            }

            if (separator?.type === "symbol" && separator.value === "]") {
                this.tokens.skip();
                return this.withNodeBounds(startToken, () => {
                    return {
                        kind: "ArrayLiteral",
                        elements
                    } as ArrayLiteral;
                });
            }

            break;
        }

        this.fail("Expected ',' or ']' in array literal", this.tokenAt());
    }

    private parseObjectLiteral(): ObjectLiteral {
        const startToken = this.getLastReadToken();
        const properties: ObjectProperty[] = [];

        if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === "}") {
            this.tokens.skip();
            return this.withNodeBounds(startToken, () => {
                return {
                    kind: "ObjectLiteral",
                    properties
                } as ObjectLiteral;
            });
        }

        while (this.tokens.hasMore) {
            const key = this.tokens.read();
            if (key?.type !== "identifier") {
                this.fail("Expected identifier key in object literal", key);
            }

            const colon = this.tokens.read();
            if (colon?.type !== "symbol" || colon.value !== ":") {
                this.fail("Expected ':' after object key", colon);
            }

            const value = this.parseExpressionOrThrow();
            properties.push(
                this.attachNodeBounds(
                    {
                        kind: "ObjectProperty",
                        key: this.buildIdentifierFromToken(key),
                        value
                    } as ObjectProperty,
                    key,
                    this.getLastReadToken() ?? key
                )
            );

            const separator = this.tokens.peek();
            if (separator?.type === "symbol" && separator.value === ",") {
                this.tokens.skip();
                continue;
            }

            if (separator?.type === "symbol" && separator.value === "}") {
                this.tokens.skip();
                return this.withNodeBounds(startToken, () => {
                    return {
                        kind: "ObjectLiteral",
                        properties
                    } as ObjectLiteral;
                });
            }

            break;
        }

        this.fail("Expected ',' or '}' in object literal", this.tokenAt());
    }

    private parsePrimary(): Expr {
        const token = this.tokens.read();

        if (token?.type === "symbol" && token.value === "(") {
            const expr = this.parseExpressionOrThrow();
            const close = this.tokens.read();
            if (close?.type !== "symbol" || close.value !== ")") {
                this.fail("Expected ')' after parenthesized expression", this.tokenAt(close));
            }
            return expr;
        }

        if (token?.type === "symbol" && token.value === "[") {
            return this.parseArrayLiteral();
        }

        if (token?.type === "symbol" && token.value === "{") {
            return this.parseObjectLiteral();
        }

        if (token?.type === "number") {
            if (token.value.endsWith("n") || token.value.endsWith("N")) {
                const raw = token.value.slice(0, -1);
                if (!/^\d+$/.test(raw)) {
                    this.fail("Invalid bigint literal", this.tokenAt(token));
                }
                return this.attachNodeBounds(
                    { kind: "BigIntLiteral", value: BigInt(raw) } as BigIntLiteral,
                    token,
                    token
                );
            }
            if (token.value.endsWith("L")) {
                const raw = token.value.slice(0, -1);
                if (!/^\d+$/.test(raw)) {
                    this.fail("Invalid long literal", this.tokenAt(token));
                }
                return this.attachNodeBounds(
                    { kind: "LongLiteral", value: BigInt(raw) } as LongLiteral,
                    token,
                    token
                );
            }
            const numericValue = Number(token.value);
            if (!Number.isFinite(numericValue)) {
                this.fail("Invalid numeric literal", this.tokenAt(token));
            }
            if (token.value.includes(".") || token.value.includes("e") || token.value.includes("E")) {
                return this.attachNodeBounds(
                    { kind: "FloatLiteral", value: numericValue } as FloatLiteral,
                    token,
                    token
                );
            }
            return this.attachNodeBounds(
                { kind: "IntLiteral", value: numericValue } as IntLiteral,
                token,
                token
            );
        }

        if (token?.type === "string") {
            return this.attachNodeBounds(
                { kind: "StringLiteral", value: token.value } as StringLiteral,
                token,
                token
            );
        }

        if (token?.type === "identifier") {
            return this.buildIdentifierFromToken(token);
        }

        this.fail("Expected a number literal, string literal, identifier, '(', '[' or '{'", this.tokenAt(token));
    }

    private parsePostfix(): Expr {
        let expr = this.parsePrimary();

        while (this.tokens.hasMore) {
            const token = this.tokens.peek();

            if (token?.type === "symbol" && (token.value === "." || token.value === "?." || token.value === "!.")) {
                this.tokens.skip();
                const property = this.tokens.read();
                if (property?.type !== "identifier") {
                    this.fail(
                        `Expected identifier after '${token.value}'`,
                        this.tokenAt(property?.type === "eof" ? token : property ?? token)
                    );
                }

                expr = {
                    kind: "MemberExpression",
                    object: expr,
                    property: this.buildIdentifierFromToken(property),
                    computed: false,
                    optional: token.value === "?." ? true : undefined,
                    nonNullAsserted: token.value === "!." ? true : undefined
                } as MemberExpression;
                this.attachNodeBounds(expr as MemberExpression, (expr as MemberExpression).object.firstToken, property);
                continue;
            }

            if (token?.type === "symbol" && token.value === "[") {
                this.tokens.skip();
                const property = this.parseExpressionOrThrow();
                const close = this.tokens.read();
                if (close?.type !== "symbol" || close.value !== "]") {
                    this.fail("Expected ']' after computed member access", this.tokenAt(close));
                }

                expr = {
                    kind: "MemberExpression",
                    object: expr,
                    property,
                    computed: true
                } as MemberExpression;
                this.attachNodeBounds(expr as MemberExpression, (expr as MemberExpression).object.firstToken, close);
                continue;
            }

            if (token?.type === "symbol" && token.value === "(") {
                this.tokens.skip();
                const args: Expr[] = [];

                if (!(this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === ")")) {
                    while (this.tokens.hasMore) {
                        args.push(this.parseExpressionOrThrow());
                        const separator = this.tokens.peek();
                        if (separator?.type === "symbol" && separator.value === ",") {
                            this.tokens.skip();
                            continue;
                        }
                        break;
                    }
                }

                const close = this.tokens.read();
                if (close?.type !== "symbol" || close.value !== ")") {
                    this.fail("Expected ')' after call arguments", this.tokenAt(close));
                }

                expr = this.attachNodeBounds({
                    kind: "CallExpression",
                    callee: expr,
                    arguments: args
                } as CallExpression, expr.firstToken, close);
                continue;
            }

            if (token?.type === "symbol" && (token.value === "++" || token.value === "--")) {
                this.tokens.skip();
                return this.attachNodeBounds({
                    kind: "UpdateExpression",
                    operator: token.value,
                    argument: expr,
                    prefix: false
                } as UpdateExpression, expr.firstToken, token);
            }

            break;
        }

        return expr;
    }

    private parseUnary(): Expr {
        const token = this.tokens.peek();
        if (token?.type === "identifier" && token.value === "new") {
            const newKeyword = this.tokens.read();
            const constructorTarget = this.parsePostfix();

            const statement: NewExpression = {
                kind: "NewExpression",
                callee: constructorTarget
            };

            if (constructorTarget.kind === "CallExpression") {
                const callTarget = constructorTarget as CallExpression;
                statement.callee = callTarget.callee;
                statement.arguments = callTarget.arguments;
            }

            return this.attachNodeBounds(statement, newKeyword, constructorTarget.lastToken ?? this.getLastReadToken() ?? newKeyword);
        }
        if (token?.type === "symbol" && (token.value === "++" || token.value === "--")) {
            this.tokens.skip();
            const argument = this.parseUnary();
            return this.attachNodeBounds({
                kind: "UpdateExpression",
                operator: token.value,
                argument,
                prefix: true
            } as UpdateExpression, token, argument.lastToken ?? this.getLastReadToken());
        }
        if (token?.type === "symbol" && (token.value === "+" || token.value === "-")) {
            this.tokens.skip();
            const argument = this.parseUnary();
            return this.attachNodeBounds({
                kind: "UnaryExpression",
                operator: token.value,
                argument
            } as UnaryExpression, token, argument.lastToken ?? this.getLastReadToken());
        }
        if (token?.type === "symbol" && (token.value === "!" || token.value === "~")) {
            this.tokens.skip();
            const argument = this.parseUnary();
            return this.attachNodeBounds({
                kind: "UnaryExpression",
                operator: token.value,
                argument
            } as UnaryExpression, token, argument.lastToken ?? this.getLastReadToken());
        }
        if (
            token?.type === "identifier" &&
            (token.value === "typeof" || token.value === "void" || token.value === "delete" || token.value === "await")
        ) {
            this.tokens.skip();
            const argument = this.parseUnary();
            return this.attachNodeBounds({
                kind: "UnaryExpression",
                operator: token.value,
                argument
            } as UnaryExpression, token, argument.lastToken ?? this.getLastReadToken());
        }

        return this.parsePostfix();
    }

    private parseExponentiation(): Expr {
        const left = this.parseUnary();
        if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === "**") {
            this.tokens.skip();
            const right = this.parseExponentiation();
            return this.buildBinary("**", left, right);
        }
        return left;
    }

    private parseMultiplicative(): Expr {
        return this.parseLeftAssociative(["*", "/", "%"], () => this.parseExponentiation());
    }

    private parseAdditive(): Expr {
        return this.parseLeftAssociative(["+", "-"], () => this.parseMultiplicative());
    }

    private parseRange(): Expr {
        let left = this.parseAdditive();

        while (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === "...") {
            this.tokens.skip();
            const right = this.parseAdditive();
            left = this.attachNodeBounds({
                kind: "RangeExpression",
                start: left,
                end: right
            } as RangeExpression, left.firstToken, right.lastToken ?? this.getLastReadToken());
        }

        return left;
    }

    private parseShift(): Expr {
        return this.parseLeftAssociative(["<<", ">>", ">>>"], () => this.parseRange());
    }

    private parseRelational(): Expr {
        let left = this.parseShift();

        while (this.tokens.hasMore) {
            const token = this.tokens.peek();
            if (
                !(
                    (token?.type === "symbol" && (token.value === "<" || token.value === ">" || token.value === "<=" || token.value === ">=")) ||
                    (token?.type === "identifier" && (token.value === "in" || token.value === "instanceof"))
                )
            ) {
                break;
            }

            this.tokens.skip();
            const right = this.parseShift();
            left = this.buildBinary(token.value as BinaryOperator, left, right);
        }

        return left;
    }

    private parseEquality(): Expr {
        return this.parseLeftAssociative(["==", "!=", "===", "!=="], () => this.parseRelational());
    }

    private parseBitwiseAnd(): Expr {
        return this.parseLeftAssociative(["&"], () => this.parseEquality());
    }

    private parseBitwiseXor(): Expr {
        return this.parseLeftAssociative(["^"], () => this.parseBitwiseAnd());
    }

    private parseBitwiseOr(): Expr {
        return this.parseLeftAssociative(["|"], () => this.parseBitwiseXor());
    }

    private parseLogicalAnd(): Expr {
        return this.parseLeftAssociative(["&&"], () => this.parseBitwiseOr());
    }

    private parseLogicalOr(): Expr {
        return this.parseLeftAssociative(["||", "??"], () => this.parseLogicalAnd());
    }

    private parseConditional(): Expr {
        const test = this.parseLogicalOr();
        const maybeQuestion = this.tokens.peek();
        if (!(maybeQuestion?.type === "symbol" && maybeQuestion.value === "?")) {
            return test;
        }

        this.tokens.skip();
        const consequent = this.parseAssignment();
        const colon = this.tokens.read();
        if (colon?.type !== "symbol" || colon.value !== ":") {
            this.fail("Expected ':' in conditional expression", this.tokenAt(colon));
        }
        const alternate = this.parseAssignment();

        return this.attachNodeBounds({
            kind: "ConditionalExpression",
            test,
            consequent,
            alternate
        } as ConditionalExpression, test.firstToken, alternate.lastToken ?? this.getLastReadToken());
    }

    private parseAssignment(): Expr {
        const left = this.parseConditional();
        const token = this.tokens.peek();

        if (token?.type === "symbol" && ASSIGNMENT_OPERATORS.includes(token.value as AssignmentOperator)) {
            this.tokens.skip();
            const right = this.parseAssignment();
            return this.attachNodeBounds({
                kind: "AssignmentExpression",
                operator: token.value as AssignmentOperator,
                left,
                right
            } as AssignmentExpression, left.firstToken, right.lastToken ?? this.getLastReadToken());
        }

        return left;
    }

    private parseVarStatement(): VarStatement {
        const declarationKeyword = this.tokens.read();
        if (
            declarationKeyword?.type !== "identifier" ||
            !VARIABLE_DECLARATION_KEYWORDS.includes(declarationKeyword.value as VariableDeclarationKind)
        ) {
            this.fail("Expected variable declaration statement", this.tokenAt(declarationKeyword));
        }

        const declarations: VarDeclarator[] = [];

        while (this.tokens.hasMore) {
            declarations.push(this.parseVarDeclarator());

            const separator = this.tokens.peek();
            if (!(separator?.type === "symbol" && separator.value === ",")) {
                break;
            }
            this.tokens.skip();
        }

        if (declarations.length === 0) {
            this.fail("Expected identifier after variable declaration keyword", this.tokenAt());
        }

        const firstDeclaration = declarations[0] as VarDeclarator;

        const statement: VarStatement = {
            kind: "VarStatement",
            declarationKind: declarationKeyword.value as VariableDeclarationKind,
            name: firstDeclaration.name
        };
        if (firstDeclaration.typeAnnotation) {
            statement.typeAnnotation = firstDeclaration.typeAnnotation;
        }
        if (firstDeclaration.initializer) {
            statement.initializer = firstDeclaration.initializer;
        }
        if (declarations.length > 1) {
            statement.declarations = declarations;
        }
        return this.attachNodeBounds(statement, declarationKeyword, this.getLastReadToken() ?? declarationKeyword);
    }

    private parseVarDeclarator(): VarDeclarator {
        const nameToken = this.tokens.read();
        if (nameToken?.type !== "identifier") {
            this.fail("Expected identifier in variable declaration", this.tokenAt(nameToken));
        }

        let typeAnnotation: Identifier | undefined;
        const maybeColon = this.tokens.peek();
        if (maybeColon?.type === "symbol" && maybeColon.value === ":") {
            this.tokens.skip();
            const typeToken = this.tokens.read();
            if (typeToken?.type !== "identifier") {
                this.fail("Expected type identifier after ':' in variable declaration", this.tokenAt(typeToken));
            }
            typeAnnotation = this.buildIdentifierFromToken(typeToken);
        }

        let initializer: Expr | undefined;
        const maybeEquals = this.tokens.peek();
        if (maybeEquals?.type === "symbol" && maybeEquals.value === "=") {
            this.tokens.skip();
            initializer = this.parseExpressionOrThrow();
        }

        const declarator: VarDeclarator = {
            kind: "VarDeclarator",
            name: this.buildIdentifierFromToken(nameToken)
        };
        if (typeAnnotation) {
            declarator.typeAnnotation = typeAnnotation;
        }
        if (initializer) {
            declarator.initializer = initializer;
        }

        return this.attachNodeBounds(declarator, nameToken, this.getLastReadToken() ?? nameToken);
    }

    private parseImportStatement(): ImportStatement {
        const importKeyword = this.tokens.read();
        if (importKeyword?.type !== "identifier" || importKeyword.value !== "import") {
            this.fail("Expected 'import' statement", this.tokenAt(importKeyword));
        }

        const openBrace = this.tokens.read();
        if (openBrace?.type !== "symbol" || openBrace.value !== "{") {
            this.fail("Expected '{' after 'import'", this.tokenAt(openBrace));
        }

        const specifiers: ImportSpecifier[] = [];
        while (this.tokens.hasMore) {
            const maybeCloseBrace = this.tokens.peek();
            if (maybeCloseBrace?.type === "symbol" && maybeCloseBrace.value === "}") {
                this.tokens.skip();
                break;
            }

            const nameToken = this.tokens.read();
            if (nameToken?.type !== "identifier") {
                this.fail("Expected imported symbol name", this.tokenAt(nameToken));
            }
            const imported = this.buildIdentifierFromToken(nameToken);
            specifiers.push(
                this.attachNodeBounds(
                    {
                        kind: "ImportSpecifier",
                        imported
                    } as ImportSpecifier,
                    nameToken,
                    nameToken
                )
            );

            const separator = this.tokens.peek();
            if (separator?.type === "symbol" && separator.value === ",") {
                this.tokens.skip();
                continue;
            }
            if (separator?.type === "symbol" && separator.value === "}") {
                this.tokens.skip();
                break;
            }
            this.fail("Expected ',' or '}' in import specifier list", this.tokenAt(separator));
        }

        if (specifiers.length === 0) {
            this.fail("Expected at least one imported symbol", this.tokenAt());
        }

        const fromKeyword = this.tokens.read();
        if (fromKeyword?.type !== "identifier" || fromKeyword.value !== "from") {
            this.fail("Expected 'from' after import specifiers", this.tokenAt(fromKeyword));
        }

        const sourceToken = this.tokens.read();
        if (sourceToken?.type !== "string") {
            this.fail("Expected string literal module path in import statement", this.tokenAt(sourceToken));
        }

        const statement: ImportStatement = {
            kind: "ImportStatement",
            specifiers,
            from: this.attachNodeBounds(
                {
                    kind: "StringLiteral",
                    value: sourceToken.value
                } as StringLiteral,
                sourceToken,
                sourceToken
            )
        };
        return this.attachNodeBounds(statement, importKeyword, this.getLastReadToken() ?? importKeyword);
    }

    private parseFunctionStatement(): FunctionStatement {
        const declarationKeyword = this.tokens.read();
        if (
            declarationKeyword?.type !== "identifier" ||
            !FUNCTION_DECLARATION_KEYWORDS.includes(declarationKeyword.value as FunctionDeclarationKind)
        ) {
            this.fail("Expected function declaration statement", this.tokenAt(declarationKeyword));
        }

        const nameToken = this.tokens.read();
        if (nameToken?.type !== "identifier") {
            this.fail("Expected function name after declaration keyword", this.tokenAt(nameToken));
        }

        const openParen = this.tokens.read();
        if (openParen?.type !== "symbol" || openParen.value !== "(") {
            this.fail("Expected '(' after function name", this.tokenAt(openParen));
        }

        const parameters: FunctionParameter[] = [];
        parameters.push(...this.parseFunctionParameters());

        const closeParen = this.tokens.read();
        if (closeParen?.type !== "symbol" || closeParen.value !== ")") {
            this.fail("Expected ')' after function parameters", this.tokenAt(closeParen));
        }

        let returnType: Identifier | undefined;
        if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === ":") {
            this.tokens.skip();
            const returnTypeToken = this.tokens.read();
            if (returnTypeToken?.type !== "identifier") {
                this.fail("Expected return type after ':' in function declaration", this.tokenAt(returnTypeToken));
            }
            returnType = this.buildIdentifierFromToken(returnTypeToken);
        }

        if (this.tokens.peek()?.type !== "symbol" || this.tokens.peek()?.value !== "{") {
            this.fail("Expected '{' to start function body", this.tokenAt());
        }
        const body = this.parseBlockStatement();

        const statement: FunctionStatement = {
            kind: "FunctionStatement",
            declarationKind: declarationKeyword.value as FunctionDeclarationKind,
            name: this.buildIdentifierFromToken(nameToken),
            parameters,
            body
        };
        if (returnType) {
            statement.returnType = returnType;
        }

        return this.attachNodeBounds(statement, declarationKeyword, this.getLastReadToken() ?? declarationKeyword);
    }

    private parseDeclareFunctionStatement(): FunctionStatement {
        const declareKeyword = this.tokens.read();
        if (declareKeyword?.type !== "identifier" || declareKeyword.value !== "declare") {
            this.fail("Expected 'declare' before function declaration", this.tokenAt(declareKeyword));
        }

        const functionKeyword = this.tokens.read();
        if (functionKeyword?.type !== "identifier" || functionKeyword.value !== "function") {
            this.fail("Expected 'function' after 'declare'", this.tokenAt(functionKeyword));
        }

        const nameToken = this.tokens.read();
        if (nameToken?.type !== "identifier") {
            this.fail("Expected function name after declaration keyword", this.tokenAt(nameToken));
        }

        const openParen = this.tokens.read();
        if (openParen?.type !== "symbol" || openParen.value !== "(") {
            this.fail("Expected '(' after function name", this.tokenAt(openParen));
        }

        this.skipUntilMatchingCloseParen(openParen);

        if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === ":") {
            this.tokens.skip();
            this.skipTypeAnnotationUntilStatementEnd();
        }

        const maybeSemicolon = this.tokens.peek();
        if (maybeSemicolon?.type === "symbol" && maybeSemicolon.value === ";") {
            this.tokens.skip();
        }

        const emptyBody = this.attachNodeBounds(
            { kind: "BlockStatement", body: [] } as BlockStatement,
            functionKeyword,
            functionKeyword
        );

        const statement: FunctionStatement = {
            kind: "FunctionStatement",
            declarationKind: "function",
            declared: true,
            name: this.buildIdentifierFromToken(nameToken),
            parameters: [],
            body: emptyBody
        };

        return this.attachNodeBounds(statement, declareKeyword, this.getLastReadToken() ?? declareKeyword);
    }

    private parseDeclareVariableStatement(): VarStatement {
        const declareKeyword = this.tokens.read();
        if (declareKeyword?.type !== "identifier" || declareKeyword.value !== "declare") {
            this.fail("Expected 'declare' before variable declaration", this.tokenAt(declareKeyword));
        }

        const variableKeyword = this.tokens.peek();
        if (variableKeyword?.type !== "identifier" || !this.isVariableDeclarationKeyword(variableKeyword.value)) {
            this.fail("Expected variable declaration keyword after 'declare'", this.tokenAt(variableKeyword));
        }

        const statement = this.parseVarStatement();
        statement.declared = true;

        const maybeSemicolon = this.tokens.peek();
        if (maybeSemicolon?.type === "symbol" && maybeSemicolon.value === ";") {
            this.tokens.skip();
        }

        return this.attachNodeBounds(statement, declareKeyword, this.getLastReadToken() ?? declareKeyword);
    }

    private parseDeclareClassStatement(): ClassStatement {
        const declareKeyword = this.tokens.read();
        if (declareKeyword?.type !== "identifier" || declareKeyword.value !== "declare") {
            this.fail("Expected 'declare' before class declaration", this.tokenAt(declareKeyword));
        }

        const classKeyword = this.tokens.peek();
        if (classKeyword?.type !== "identifier" || classKeyword.value !== "class") {
            this.fail("Expected 'class' after 'declare'", this.tokenAt(classKeyword));
        }

        const statement = this.parseClassStatement(true);
        statement.declared = true;

        const maybeSemicolon = this.tokens.peek();
        if (maybeSemicolon?.type === "symbol" && maybeSemicolon.value === ";") {
            this.tokens.skip();
        }

        return this.attachNodeBounds(statement, declareKeyword, this.getLastReadToken() ?? declareKeyword);
    }

    private parseDeclareNamespaceStatement(): Statement {
        const declareKeyword = this.tokens.read();
        if (declareKeyword?.type !== "identifier" || declareKeyword.value !== "declare") {
            this.fail("Expected 'declare' before namespace declaration", this.tokenAt(declareKeyword));
        }

        const namespaceKeyword = this.tokens.read();
        if (
            namespaceKeyword?.type !== "identifier" ||
            (namespaceKeyword.value !== "namespace" && namespaceKeyword.value !== "module")
        ) {
            this.fail("Expected 'namespace' or 'module' after 'declare'", this.tokenAt(namespaceKeyword));
        }

        const namespaceNameToken = this.tokens.read();
        if (namespaceNameToken?.type !== "identifier") {
            this.fail("Expected namespace name after declaration keyword", this.tokenAt(namespaceNameToken));
        }

        while (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === ".") {
            this.tokens.skip();
            const segmentToken = this.tokens.read();
            if (segmentToken?.type !== "identifier") {
                this.fail("Expected identifier after '.' in namespace name", this.tokenAt(segmentToken));
            }
        }

        const openBrace = this.tokens.read();
        if (openBrace?.type !== "symbol" || openBrace.value !== "{") {
            this.fail("Expected '{' to start namespace body", this.tokenAt(openBrace));
        }

        this.skipUntilMatchingCloseSymbol(openBrace, "{", "}", "Expected '}' to close namespace body");

        if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === ";") {
            this.tokens.skip();
        }

        return this.attachNodeBounds(
            { kind: "BlockStatement", body: [] } as BlockStatement,
            declareKeyword,
            this.getLastReadToken() ?? declareKeyword
        );
    }

    private parseTypeScriptExportAssignmentStatement(): ExprStatement {
        const exportKeyword = this.tokens.read();
        if (exportKeyword?.type !== "identifier" || exportKeyword.value !== "export") {
            this.fail("Expected 'export' in export assignment", this.tokenAt(exportKeyword));
        }

        const equalsToken = this.tokens.read();
        if (equalsToken?.type !== "symbol" || equalsToken.value !== "=") {
            this.fail("Expected '=' after 'export'", this.tokenAt(equalsToken));
        }

        const expression = this.parseExpressionOrThrow();
        if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === ";") {
            this.tokens.skip();
        }

        return this.attachNodeBounds(
            { kind: "ExprStatement", expression } as ExprStatement,
            exportKeyword,
            this.getLastReadToken() ?? exportKeyword
        );
    }

    private parseFunctionParameters(): FunctionParameter[] {
        const parameters: FunctionParameter[] = [];
        if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === ")") {
            return parameters;
        }

        while (this.tokens.hasMore) {
            const parameterNameToken = this.tokens.read();
            if (parameterNameToken?.type !== "identifier") {
                this.fail("Expected parameter name in function declaration", this.tokenAt(parameterNameToken));
            }

            let parameterOptional = false;
            if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === "?") {
                this.tokens.skip();
                parameterOptional = true;
            }

            let parameterTypeAnnotation: Identifier | undefined;
            if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === ":") {
                this.tokens.skip();
                const parameterTypeToken = this.tokens.read();
                if (parameterTypeToken?.type !== "identifier") {
                    this.fail("Expected parameter type after ':'", this.tokenAt(parameterTypeToken));
                }
                parameterTypeAnnotation = this.buildIdentifierFromToken(parameterTypeToken);
            }

            let parameterDefaultValue: Expr | undefined;
            if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === "=") {
                this.tokens.skip();
                parameterDefaultValue = this.parseExpressionOrThrow();
            }

            const parameter: FunctionParameter = {
                kind: "FunctionParameter",
                name: this.buildIdentifierFromToken(parameterNameToken)
            };
            if (parameterOptional) {
                parameter.optional = true;
            }
            if (parameterTypeAnnotation) {
                parameter.typeAnnotation = parameterTypeAnnotation;
            }
            if (parameterDefaultValue) {
                parameter.defaultValue = parameterDefaultValue;
            }
            parameters.push(this.attachNodeBounds(parameter, parameterNameToken, this.getLastReadToken() ?? parameterNameToken));

            const separator = this.tokens.peek();
            if (separator?.type === "symbol" && separator.value === ",") {
                this.tokens.skip();
                continue;
            }
            if (separator?.type === "symbol" && separator.value === ")") {
                break;
            }
            this.fail("Expected ',' or ')' in function parameter list", this.tokenAt(separator));
        }

        return parameters;
    }

    private parseClassMember(allowSignatureOnly: boolean = false): ClassMember {
        const memberNameToken = this.tokens.read();
        if (memberNameToken?.type !== "identifier") {
            this.fail("Expected class member name", this.tokenAt(memberNameToken));
        }

        if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === "(") {
            this.tokens.skip();
            const parameters = this.parseFunctionParameters();

            const closeParen = this.tokens.read();
            if (closeParen?.type !== "symbol" || closeParen.value !== ")") {
                this.fail("Expected ')' after method parameters", this.tokenAt(closeParen));
            }

            let returnType: Identifier | undefined;
            if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === ":") {
                this.tokens.skip();
                const returnTypeToken = this.tokens.read();
                if (returnTypeToken?.type !== "identifier") {
                    this.fail("Expected return type after ':' in class method", this.tokenAt(returnTypeToken));
                }
                returnType = this.buildIdentifierFromToken(returnTypeToken);
            }

            if (this.tokens.peek()?.type !== "symbol" || this.tokens.peek()?.value !== "{") {
                if (!allowSignatureOnly) {
                    this.fail("Expected '{' to start class method body", this.tokenAt());
                }

                const signatureOnlyBody = this.attachNodeBounds(
                    { kind: "BlockStatement", body: [] } as BlockStatement,
                    memberNameToken,
                    this.getLastReadToken() ?? memberNameToken
                );

                const signatureOnlyMethod: ClassMethodMember = {
                    kind: "ClassMethodMember",
                    name: this.buildIdentifierFromToken(memberNameToken),
                    parameters,
                    body: signatureOnlyBody
                };
                if (returnType) {
                    signatureOnlyMethod.returnType = returnType;
                }

                return this.attachNodeBounds(signatureOnlyMethod, memberNameToken, this.getLastReadToken() ?? memberNameToken);
            }

            const methodMember: ClassMethodMember = {
                kind: "ClassMethodMember",
                name: this.buildIdentifierFromToken(memberNameToken),
                parameters,
                body: this.parseBlockStatement()
            };
            if (returnType) {
                methodMember.returnType = returnType;
            }

            return this.attachNodeBounds(methodMember, memberNameToken, this.getLastReadToken() ?? memberNameToken);
        }

        let typeAnnotation: Identifier | undefined;
        if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === ":") {
            this.tokens.skip();
            const typeToken = this.tokens.read();
            if (typeToken?.type !== "identifier") {
                this.fail("Expected type identifier after ':' in class field", this.tokenAt(typeToken));
            }
            typeAnnotation = this.buildIdentifierFromToken(typeToken);
        }

        let initializer: Expr | undefined;
        if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === "=") {
            this.tokens.skip();
            initializer = this.parseExpressionOrThrow();
        }

        const fieldMember: ClassFieldMember = {
            kind: "ClassFieldMember",
            name: this.buildIdentifierFromToken(memberNameToken)
        };
        if (typeAnnotation) {
            fieldMember.typeAnnotation = typeAnnotation;
        }
        if (initializer) {
            fieldMember.initializer = initializer;
        }
        return this.attachNodeBounds(fieldMember, memberNameToken, this.getLastReadToken() ?? memberNameToken);
    }

    private parseClassPrimaryConstructorParameters(): ClassPrimaryConstructorParameter[] {
        const parameters: ClassPrimaryConstructorParameter[] = [];
        if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === ")") {
            return parameters;
        }

        while (this.tokens.hasMore) {
            const declarationToken = this.tokens.read();
            if (
                declarationToken?.type !== "identifier" ||
                !VARIABLE_DECLARATION_KEYWORDS.includes(declarationToken.value as VariableDeclarationKind)
            ) {
                this.fail("Expected declaration keyword in class primary constructor parameter", this.tokenAt(declarationToken));
            }

            const parameterNameToken = this.tokens.read();
            if (parameterNameToken?.type !== "identifier") {
                this.fail("Expected parameter name in class primary constructor", this.tokenAt(parameterNameToken));
            }

            let parameterTypeAnnotation: Identifier | undefined;
            if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === ":") {
                this.tokens.skip();
                const parameterTypeToken = this.tokens.read();
                if (parameterTypeToken?.type !== "identifier") {
                    this.fail("Expected parameter type after ':'", this.tokenAt(parameterTypeToken));
                }
                parameterTypeAnnotation = this.buildIdentifierFromToken(parameterTypeToken);
            }

            let parameterDefaultValue: Expr | undefined;
            if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === "=") {
                this.tokens.skip();
                parameterDefaultValue = this.parseExpressionOrThrow();
            }

            const parameter: ClassPrimaryConstructorParameter = {
                kind: "ClassPrimaryConstructorParameter",
                declarationKind: declarationToken.value as VariableDeclarationKind,
                name: this.buildIdentifierFromToken(parameterNameToken)
            };
            if (parameterTypeAnnotation) {
                parameter.typeAnnotation = parameterTypeAnnotation;
            }
            if (parameterDefaultValue) {
                parameter.defaultValue = parameterDefaultValue;
            }
            parameters.push(this.attachNodeBounds(parameter, declarationToken, this.getLastReadToken() ?? declarationToken));

            const separator = this.tokens.peek();
            if (separator?.type === "symbol" && separator.value === ",") {
                this.tokens.skip();
                continue;
            }
            if (separator?.type === "symbol" && separator.value === ")") {
                break;
            }
            this.fail("Expected ',' or ')' in class primary constructor parameter list", this.tokenAt(separator));
        }

        return parameters;
    }

    private parseClassStatement(declared: boolean = false): ClassStatement {
        const classKeyword = this.tokens.read();
        if (classKeyword?.type !== "identifier" || classKeyword.value !== "class") {
            this.fail("Expected class declaration statement", this.tokenAt(classKeyword));
        }

        const classNameToken = this.tokens.read();
        if (classNameToken?.type !== "identifier") {
            this.fail("Expected class name after 'class'", this.tokenAt(classNameToken));
        }

        let primaryConstructorParameters: ClassPrimaryConstructorParameter[] | undefined;
        if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === "(") {
            if (this.language !== "mylang") {
                this.fail("Class primary constructor syntax is only available in MyLang mode", this.tokenAt());
            }

            this.tokens.skip();
            primaryConstructorParameters = this.parseClassPrimaryConstructorParameters();

            const closeParen = this.tokens.read();
            if (closeParen?.type !== "symbol" || closeParen.value !== ")") {
                this.fail("Expected ')' after class primary constructor parameters", this.tokenAt(closeParen));
            }
        }

        const openBrace = this.tokens.peek();
        if (openBrace?.type !== "symbol" || openBrace.value !== "{") {
            if (this.language === "mylang") {
                const statement: ClassStatement = {
                    kind: "ClassStatement",
                    name: this.buildIdentifierFromToken(classNameToken),
                    members: []
                };
                if (declared) {
                    statement.declared = true;
                }
                if (primaryConstructorParameters && primaryConstructorParameters.length > 0) {
                    statement.primaryConstructorParameters = primaryConstructorParameters;
                }
                return this.attachNodeBounds(statement, classKeyword, this.getLastReadToken() ?? classKeyword);
            }

            this.fail("Expected '{' to start class body", this.tokenAt(openBrace));
        }
        this.tokens.skip();

        const members: ClassMember[] = [];
        while (this.tokens.hasMore) {
            const token = this.tokens.peek();
            if (this.isEofToken(token)) {
                this.fail("Expected '}' to close class body", this.tokenAt(openBrace), "block");
            }
            if (token?.type === "symbol" && token.value === "}") {
                this.tokens.skip();
                const statement: ClassStatement = {
                    kind: "ClassStatement",
                    name: this.buildIdentifierFromToken(classNameToken),
                    members
                };
                if (declared) {
                    statement.declared = true;
                }
                if (primaryConstructorParameters && primaryConstructorParameters.length > 0) {
                    statement.primaryConstructorParameters = primaryConstructorParameters;
                }
                return this.attachNodeBounds(statement, classKeyword, this.getLastReadToken() ?? classKeyword);
            }

            if (token?.type === "symbol" && token.value === ";") {
                this.tokens.skip();
                continue;
            }

            const member = this.parseClassMember(declared);
            members.push(member);
            this.consumeStatementSeparator("block", this.getLastReadToken());
        }

        this.fail("Expected '}' to close class body", this.tokenAt(openBrace), "block");
    }

    private parseBlockStatement(): BlockStatement {
        const openBrace = this.tokens.read();
        if (openBrace?.type !== "symbol" || openBrace.value !== "{") {
            this.fail("Expected '{' to start block statement", this.tokenAt(openBrace));
        }

        const body: Statement[] = [];

        while (this.tokens.hasMore) {
            const token = this.tokens.peek();
            if (this.isEofToken(token)) {
                this.fail("Expected '}' to close block statement", this.tokenAt(openBrace), "block");
            }

            if (token?.type === "symbol" && token.value === "}") {
                this.tokens.skip();
                return this.attachNodeBounds({
                    kind: "BlockStatement",
                    body
                } as BlockStatement, openBrace, this.getLastReadToken() ?? openBrace);
            }

            if (token?.type === "symbol" && token.value === ";") {
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
                this.consumeStatementSeparator("block", previousToken);
            } catch (error) {
                this.emitErrorFrom(error);
                if (error instanceof ParseError) {
                    this.recover(error.recoveryHint, error.token);
                } else {
                    this.recover();
                }
            }
        }

        this.fail("Expected '}' to close block statement", this.tokenAt(openBrace), "block");
    }

    private parseWhileStatement(): WhileStatement {
        const whileKeyword = this.tokens.read();
        if (whileKeyword?.type !== "identifier" || whileKeyword.value !== "while") {
            this.fail("Expected 'while' statement", this.tokenAt(whileKeyword));
        }

        const openParen = this.tokens.read();
        if (openParen?.type !== "symbol" || openParen.value !== "(") {
            this.fail("Expected '(' after 'while'", this.tokenAt(openParen));
        }

        const condition = this.parseExpressionOrThrow();

        const closeParen = this.tokens.read();
        if (closeParen?.type !== "symbol" || closeParen.value !== ")") {
            this.fail("Expected ')' after while condition", this.tokenAt(closeParen));
        }

        const body = this.parseStatementOrThrow();
        return this.attachNodeBounds({
            kind: "WhileStatement",
            condition,
            body
        } as WhileStatement, whileKeyword, this.getLastReadToken() ?? whileKeyword);
    }

    private parseDoWhileStatement(): DoWhileStatement {
        const doKeyword = this.tokens.read();
        if (doKeyword?.type !== "identifier" || doKeyword.value !== "do") {
            this.fail("Expected 'do' statement", this.tokenAt(doKeyword));
        }

        const body = this.parseStatementOrThrow();

        const whileKeyword = this.tokens.read();
        if (whileKeyword?.type !== "identifier" || whileKeyword.value !== "while") {
            this.fail("Expected 'while' after do-statement body", this.tokenAt(whileKeyword));
        }

        const openParen = this.tokens.read();
        if (openParen?.type !== "symbol" || openParen.value !== "(") {
            this.fail("Expected '(' after 'while'", this.tokenAt(openParen));
        }

        const condition = this.parseExpressionOrThrow();

        const closeParen = this.tokens.read();
        if (closeParen?.type !== "symbol" || closeParen.value !== ")") {
            this.fail("Expected ')' after do-while condition", this.tokenAt(closeParen));
        }

        return this.attachNodeBounds({
            kind: "DoWhileStatement",
            body,
            condition
        } as DoWhileStatement, doKeyword, this.getLastReadToken() ?? doKeyword);
    }

    private parseForStatement(): ForStatement {
        const forKeyword = this.tokens.read();
        if (forKeyword?.type !== "identifier" || forKeyword.value !== "for") {
            this.fail("Expected 'for' statement", this.tokenAt(forKeyword));
        }

        const openParen = this.tokens.read();
        if (openParen?.type !== "symbol" || openParen.value !== "(") {
            this.fail("Expected '(' after 'for'", this.tokenAt(openParen));
        }

        let initializer: VarStatement | Expr | undefined;
        if (!(this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === ";")) {
            const initialToken = this.tokens.peek();
            const secondToken = this.tokens.items[this.tokens.offset + 1];
            if (
                initialToken?.type === "identifier" &&
                this.isVariableDeclarationKeyword(initialToken.value)
            ) {
                initializer = this.parseVarStatement();
            } else if (
                this.language === "mylang" &&
                initialToken?.type === "identifier" &&
                secondToken?.type === "identifier" &&
                (secondToken.value === "in" || secondToken.value === "of")
            ) {
                const identifierToken = this.tokens.read();
                if (identifierToken?.type !== "identifier") {
                    this.fail("Expected identifier iterator in MyLang for-in/of statement", this.tokenAt(identifierToken));
                }
                initializer = this.buildIdentifierFromToken(identifierToken);
            } else {
                initializer = this.parseExpressionOrThrow();
            }
        }

        const maybeIterationKeyword = this.tokens.peek();
        if (
            maybeIterationKeyword?.type === "identifier" &&
            (maybeIterationKeyword.value === "in" || maybeIterationKeyword.value === "of")
        ) {
            if (!initializer) {
                this.fail(
                    "Expected iterator declaration before for-in/of keyword",
                    this.tokenAt(maybeIterationKeyword)
                );
            }

            if (initializer.kind === "VarStatement") {
                const iteratorDeclaration = initializer as VarStatement;
                if (iteratorDeclaration.declarations && iteratorDeclaration.declarations.length > 1) {
                    this.fail("for-in/of supports a single iterator declaration", iteratorDeclaration.firstToken);
                }
                if (iteratorDeclaration.initializer) {
                    this.fail("for-in/of iterator declaration cannot have an initializer", iteratorDeclaration.firstToken);
                }
            } else {
                if (this.language !== "mylang") {
                    this.fail(
                        "for-in/of without declaration keyword is only available in MyLang mode",
                        initializer.firstToken
                    );
                }
                if (initializer.kind !== "Identifier") {
                    this.fail("Expected identifier iterator in MyLang for-in/of statement", initializer.firstToken);
                }
            }

            this.tokens.skip();
            const iterable = this.parseExpressionOrThrow();

            const closeParen = this.tokens.read();
            if (closeParen?.type !== "symbol" || closeParen.value !== ")") {
                this.fail("Expected ')' after for-in/of iterable expression", this.tokenAt(closeParen));
            }

            const body = this.parseStatementOrThrow();
            return this.attachNodeBounds({
                kind: "ForStatement",
                iterationKind: maybeIterationKeyword.value as "in" | "of",
                iterator: initializer,
                iterable,
                body
            } as ForStatement, forKeyword, this.getLastReadToken() ?? forKeyword);
        }

        const firstSemicolon = this.tokens.read();
        if (firstSemicolon?.type !== "symbol" || firstSemicolon.value !== ";") {
            this.fail("Expected ';' after for initializer", this.tokenAt(firstSemicolon));
        }

        let condition: Expr | undefined;
        if (!(this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === ";")) {
            condition = this.parseExpressionOrThrow();
        }

        const secondSemicolon = this.tokens.read();
        if (secondSemicolon?.type !== "symbol" || secondSemicolon.value !== ";") {
            this.fail("Expected ';' after for condition", this.tokenAt(secondSemicolon));
        }

        let update: Expr | undefined;
        if (!(this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === ")")) {
            update = this.parseExpressionOrThrow();
        }

        const closeParen = this.tokens.read();
        if (closeParen?.type !== "symbol" || closeParen.value !== ")") {
            this.fail("Expected ')' after for update", this.tokenAt(closeParen));
        }

        const body = this.parseStatementOrThrow();
        const statement: ForStatement = {
            kind: "ForStatement",
            body
        };
        if (initializer) {
            statement.initializer = initializer;
        }
        if (condition) {
            statement.condition = condition;
        }
        if (update) {
            statement.update = update;
        }

        return this.attachNodeBounds(statement, forKeyword, this.getLastReadToken() ?? forKeyword);
    }

    private parseIfStatement(): IfStatement {
        const ifKeyword = this.tokens.read();
        if (ifKeyword?.type !== "identifier" || ifKeyword.value !== "if") {
            this.fail("Expected 'if' statement", this.tokenAt(ifKeyword));
        }

        const openParen = this.tokens.read();
        if (openParen?.type !== "symbol" || openParen.value !== "(") {
            this.fail("Expected '(' after 'if'", this.tokenAt(openParen));
        }

        const condition = this.parseExpressionOrThrow();

        const closeParen = this.tokens.read();
        if (closeParen?.type !== "symbol" || closeParen.value !== ")") {
            this.fail("Expected ')' after if condition", this.tokenAt(closeParen));
        }

        const thenBranch = this.parseStatementOrThrow();
        let elseBranch: Statement | undefined;
        if (this.tokens.peek()?.type === "identifier" && this.tokens.peek()?.value === "else") {
            this.tokens.skip();
            elseBranch = this.parseStatementOrThrow();
        }

        const statement: IfStatement = {
            kind: "IfStatement",
            condition,
            thenBranch
        };
        if (elseBranch) {
            statement.elseBranch = elseBranch;
        }
        return this.attachNodeBounds(statement, ifKeyword, this.getLastReadToken() ?? ifKeyword);
    }

    private parseSwitchStatement(): SwitchStatement {
        const switchKeyword = this.tokens.read();
        if (switchKeyword?.type !== "identifier" || switchKeyword.value !== "switch") {
            this.fail("Expected 'switch' statement", this.tokenAt(switchKeyword));
        }

        const openParen = this.tokens.read();
        if (openParen?.type !== "symbol" || openParen.value !== "(") {
            this.fail("Expected '(' after 'switch'", this.tokenAt(openParen));
        }

        const discriminant = this.parseExpressionOrThrow();

        const closeParen = this.tokens.read();
        if (closeParen?.type !== "symbol" || closeParen.value !== ")") {
            this.fail("Expected ')' after switch discriminant", this.tokenAt(closeParen));
        }

        const openBrace = this.tokens.read();
        if (openBrace?.type !== "symbol" || openBrace.value !== "{") {
            this.fail("Expected '{' to start switch body", this.tokenAt(openBrace));
        }

        const cases: SwitchCase[] = [];
        let currentCase: SwitchCase | undefined;

        while (this.tokens.hasMore) {
            const token = this.tokens.peek();
            if (this.isEofToken(token)) {
                this.fail("Expected '}' to close switch statement", this.tokenAt(openBrace), "switch");
            }

            if (token?.type === "symbol" && token.value === "}") {
                this.tokens.skip();
                return this.attachNodeBounds({
                    kind: "SwitchStatement",
                    discriminant,
                    cases
                } as SwitchStatement, switchKeyword, this.getLastReadToken() ?? switchKeyword);
            }

            if (token?.type === "symbol" && token.value === ";") {
                this.tokens.skip();
                continue;
            }

            if (token?.type === "identifier" && token.value === "case") {
                const caseKeyword = this.tokens.read();
                const test = this.parseExpressionOrThrow();
                const colon = this.tokens.read();
                if (colon?.type !== "symbol" || colon.value !== ":") {
                    this.fail("Expected ':' after switch case expression", this.tokenAt(colon));
                }

                currentCase = this.attachNodeBounds({
                    kind: "SwitchCase",
                    test,
                    consequent: []
                } as SwitchCase, caseKeyword, this.getLastReadToken() ?? caseKeyword);
                cases.push(currentCase);
                continue;
            }

            if (token?.type === "identifier" && token.value === "default") {
                const defaultKeyword = this.tokens.read();
                const colon = this.tokens.read();
                if (colon?.type !== "symbol" || colon.value !== ":") {
                    this.fail("Expected ':' after switch default", this.tokenAt(colon));
                }

                currentCase = this.attachNodeBounds({
                    kind: "SwitchCase",
                    consequent: []
                } as SwitchCase, defaultKeyword, this.getLastReadToken() ?? defaultKeyword);
                cases.push(currentCase);
                continue;
            }

            if (!currentCase) {
                this.fail("Expected 'case', 'default', or '}' in switch body", this.tokenAt(token), "switch");
            }

            const statementStartOffset = this.tokens.offset;
            const statement = this.parseStatement();
            if (!statement) {
                continue;
            }
            currentCase.consequent.push(statement);

            try {
                const previousToken =
                    this.tokens.offset > statementStartOffset
                        ? this.tokens.items[this.tokens.offset - 1]
                        : undefined;
                this.consumeSwitchStatementSeparator(previousToken);
            } catch (error) {
                this.emitErrorFrom(error);
                if (error instanceof ParseError) {
                    this.recover(error.recoveryHint, error.token);
                } else {
                    this.recover();
                }
            }
        }

        this.fail("Expected '}' to close switch statement", this.tokenAt(openBrace), "switch");
    }

    private parseReturnStatement(): ReturnStatement {
        const returnKeyword = this.tokens.read();
        if (returnKeyword?.type !== "identifier" || returnKeyword.value !== "return") {
            this.fail("Expected 'return' statement", this.tokenAt(returnKeyword));
        }

        const next = this.tokens.peek();
        if (!next) {
            return this.attachNodeBounds({ kind: "ReturnStatement" } as ReturnStatement, returnKeyword, returnKeyword);
        }
        if (this.isEofToken(next)) {
            return this.attachNodeBounds({ kind: "ReturnStatement" } as ReturnStatement, returnKeyword, returnKeyword);
        }
        if (next.type === "symbol" && (next.value === ";" || next.value === "}")) {
            return this.attachNodeBounds({ kind: "ReturnStatement" } as ReturnStatement, returnKeyword, returnKeyword);
        }
        if (this.hasLineBreakBetween(returnKeyword, next)) {
            return this.attachNodeBounds({ kind: "ReturnStatement" } as ReturnStatement, returnKeyword, returnKeyword);
        }

        return this.attachNodeBounds({
            kind: "ReturnStatement",
            expression: this.parseExpressionOrThrow()
        } as ReturnStatement, returnKeyword, this.getLastReadToken() ?? returnKeyword);
    }

    private parseContinueStatement(): ContinueStatement {
        const continueKeyword = this.tokens.read();
        if (continueKeyword?.type !== "identifier" || continueKeyword.value !== "continue") {
            this.fail("Expected 'continue' statement", this.tokenAt(continueKeyword));
        }
        return this.attachNodeBounds({ kind: "ContinueStatement" } as ContinueStatement, continueKeyword, continueKeyword);
    }

    private parseBreakStatement(): BreakStatement {
        const breakKeyword = this.tokens.read();
        if (breakKeyword?.type !== "identifier" || breakKeyword.value !== "break") {
            this.fail("Expected 'break' statement", this.tokenAt(breakKeyword));
        }
        return this.attachNodeBounds({ kind: "BreakStatement" } as BreakStatement, breakKeyword, breakKeyword);
    }

    private parseThrowStatement(): ThrowStatement {
        const throwKeyword = this.tokens.read();
        if (throwKeyword?.type !== "identifier" || throwKeyword.value !== "throw") {
            this.fail("Expected 'throw' statement", this.tokenAt(throwKeyword));
        }

        const next = this.tokens.peek();
        if (!next || this.isEofToken(next) || this.hasLineBreakBetween(throwKeyword, next)) {
            this.fail("Expected expression after 'throw'", this.tokenAt(next));
        }
        if (next.type === "symbol" && (next.value === ";" || next.value === "}")) {
            this.fail("Expected expression after 'throw'", this.tokenAt(next));
        }

        const expression = this.parseExpressionOrThrow();
        return this.attachNodeBounds({
            kind: "ThrowStatement",
            expression
        } as ThrowStatement, throwKeyword, this.getLastReadToken() ?? throwKeyword);
    }

    private parseTryStatement(): TryStatement {
        const tryKeyword = this.tokens.read();
        if (tryKeyword?.type !== "identifier" || tryKeyword.value !== "try") {
            this.fail("Expected 'try' statement", this.tokenAt(tryKeyword));
        }

        const tryBlock = this.parseBlockStatement();

        let catchClause: CatchClause | undefined;
        if (this.tokens.peek()?.type === "identifier" && this.tokens.peek()?.value === "catch") {
            const catchKeyword = this.tokens.read();
            let parameter: Identifier | undefined;
            if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === "(") {
                this.tokens.skip();
                const parameterToken = this.tokens.read();
                if (parameterToken?.type !== "identifier") {
                    this.fail("Expected catch parameter identifier", this.tokenAt(parameterToken));
                }
                parameter = this.buildIdentifierFromToken(parameterToken);

                const closeParen = this.tokens.read();
                if (closeParen?.type !== "symbol" || closeParen.value !== ")") {
                    this.fail("Expected ')' after catch parameter", this.tokenAt(closeParen));
                }
            }

            const catchBody = this.parseBlockStatement();
            catchClause = {
                kind: "CatchClause",
                body: catchBody
            } as CatchClause;
            if (parameter) {
                catchClause.parameter = parameter;
            }
            this.attachNodeBounds(catchClause, catchKeyword, catchBody.lastToken ?? this.getLastReadToken() ?? catchKeyword);
        }

        let finallyBlock: BlockStatement | undefined;
        if (this.tokens.peek()?.type === "identifier" && this.tokens.peek()?.value === "finally") {
            this.tokens.skip();
            finallyBlock = this.parseBlockStatement();
        }

        if (!catchClause && !finallyBlock) {
            this.fail("Expected 'catch' or 'finally' after try block", this.tokenAt());
        }

        const statement: TryStatement = {
            kind: "TryStatement",
            tryBlock
        };
        if (catchClause) {
            statement.catchClause = catchClause;
        }
        if (finallyBlock) {
            statement.finallyBlock = finallyBlock;
        }
        return this.attachNodeBounds(statement, tryKeyword, this.getLastReadToken() ?? tryKeyword);
    }
}

export function parseExpression(r: ListReader<Token>, options: ParserOptions = {}): Expr {
    return new Parser(r, options).parseExpressionOrThrow();
}

export function parseStatement(r: ListReader<Token>, options: ParserOptions = {}): Statement {
    return new Parser(r, options).parseStatementOrThrow();
}

export function parseFile(r: ListReader<Token>, options: ParserOptions = {}): Program {
    return new Parser(r, options).parseFileOrThrow();
}

export function parseProgram(r: ListReader<Token>, options: ParserOptions = {}): Program {
    return parseFile(r, options);
}
