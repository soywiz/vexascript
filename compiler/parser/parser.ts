import { ListReader } from "compiler/utils/ListReader";
import { Token } from "./tokenizer";
import {
    ArrowFunctionExpression,
    ArrayLiteral,
    AssignmentExpression,
    BigIntLiteral,
    BinaryExpression,
    BooleanLiteral,
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
    FunctionExpression,
    FunctionParameter,
    FunctionStatement,
    Identifier,
    InterfaceMember,
    InterfaceMethodMember,
    InterfacePropertyMember,
    InterfaceStatement,
    IfStatement,
    ImportSpecifier,
    ImportStatement,
    IntLiteral,
    LongLiteral,
    MemberExpression,
    NewExpression,
    NullLiteral,
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
    TypeAliasStatement,
    TypeParameter,
    TryStatement,
    UndefinedLiteral,
    UnaryExpression,
    UpdateExpression,
    VarDeclarator,
    VariableDeclarationKind,
    VarStatement,
    WhileStatement
} from "compiler/ast/ast";

type BinaryOperator = BinaryExpression["operator"];
type AssignmentOperator = AssignmentExpression["operator"];
type BinaryAssoc = "left" | "right";
type InfixOperator = BinaryOperator | "...";

const ASSIGNMENT_OPERATORS: readonly AssignmentOperator[] = ["=", "+=", "-=", "%=", "*=", "/=", "&=", "|=", "&&=", "||=", "??=", "<<=", ">>=", ">>>="];
const VARIABLE_DECLARATION_KEYWORDS: readonly VariableDeclarationKind[] = ["let", "var", "val", "const"];
const FUNCTION_DECLARATION_KEYWORDS: readonly FunctionDeclarationKind[] = ["fun", "function"];

const BINARY_OPERATOR_INFO: Record<InfixOperator, { precedence: number; assoc: BinaryAssoc }> = {
    "||": { precedence: 1, assoc: "left" },
    "??": { precedence: 1, assoc: "left" },
    "&&": { precedence: 2, assoc: "left" },
    "|": { precedence: 3, assoc: "left" },
    "^": { precedence: 4, assoc: "left" },
    "&": { precedence: 5, assoc: "left" },
    "==": { precedence: 6, assoc: "left" },
    "!=": { precedence: 6, assoc: "left" },
    "===": { precedence: 6, assoc: "left" },
    "!==": { precedence: 6, assoc: "left" },
    "<": { precedence: 7, assoc: "left" },
    ">": { precedence: 7, assoc: "left" },
    "<=": { precedence: 7, assoc: "left" },
    ">=": { precedence: 7, assoc: "left" },
    "in": { precedence: 7, assoc: "left" },
    "instanceof": { precedence: 7, assoc: "left" },
    "<<": { precedence: 8, assoc: "left" },
    ">>": { precedence: 8, assoc: "left" },
    ">>>": { precedence: 8, assoc: "left" },
    "...": { precedence: 9, assoc: "left" },
    "+": { precedence: 10, assoc: "left" },
    "-": { precedence: 10, assoc: "left" },
    "*": { precedence: 11, assoc: "left" },
    "/": { precedence: 11, assoc: "left" },
    "%": { precedence: 11, assoc: "left" },
    "**": { precedence: 12, assoc: "right" }
};

export type ParseLanguage = "mylang" | "typescript";

export interface ParserOptions {
    language?: ParseLanguage;
}

export interface ParseIssue {
    message: string;
    token?: Token;
}

type RecoveryHint = "block" | "switch" | "statement";

export interface ParseRecoveryMarker {
    token: Token;
    recoveryHint?: RecoveryHint;
}

const RECOVERY_MARKERS_SYMBOL: unique symbol = Symbol("mylang.parseRecoveryMarkers");

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
    private readonly recoveryMarkers: ParseRecoveryMarker[] = [];

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

        const program = this.attachNodeBounds(
            { kind: "Program", body } as Program,
            startToken,
            this.getLastNonEofReadToken() ?? startToken
        );
        Object.defineProperty(program, RECOVERY_MARKERS_SYMBOL, {
            value: [...this.recoveryMarkers],
            enumerable: false,
            writable: true,
            configurable: true
        });
        return program;
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
        if (token?.type === "identifier" && token.value === "type") {
            return this.parseTypeAliasStatement();
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
        if (this.isDeclareInterfaceStart()) {
            return this.parseDeclareInterfaceStatement();
        }
        if (this.isDeclareNamespaceStart()) {
            return this.parseDeclareNamespaceStatement();
        }
        if (this.isTypeScriptExportAssignmentStart()) {
            return this.parseTypeScriptExportAssignmentStatement();
        }
        if (token?.type === "identifier" && (token.value === "class" || this.isAbstractClassStart())) {
            return this.parseClassStatement();
        }
        if (token?.type === "identifier" && token.value === "interface") {
            return this.parseInterfaceStatement();
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
        if (startToken && !this.isEofToken(startToken)) {
            this.recoveryMarkers.push({
                token: startToken,
                ...(recoveryHint ? { recoveryHint } : {})
            });
        }
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
                braceDepth === 0 &&
                this.isLikelyStatementStart(token)
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

    private parseTypeParameterList(): TypeParameter[] {
        const open = this.tokens.peek();
        if (!(open?.type === "symbol" && open.value === "<")) {
            return [];
        }
        this.tokens.skip();

        const parameters: TypeParameter[] = [];
        while (this.tokens.hasMore) {
            const token = this.tokens.read();
            if (token?.type !== "identifier") {
                this.fail("Expected type parameter name", this.tokenAt(token));
            }
            const parameter: TypeParameter = {
                kind: "TypeParameter",
                name: this.buildIdentifierFromToken(token)
            };
            if (this.tokens.peek()?.type === "identifier" && this.tokens.peek()?.value === "extends") {
                this.tokens.skip();
                parameter.constraint = this.parseTypeAnnotationNode();
            }
            parameters.push(this.attachNodeBounds(
                parameter,
                token,
                parameter.constraint?.lastToken ?? token
            ));

            const separator = this.tokens.peek();
            if (separator?.type === "symbol" && separator.value === ",") {
                this.tokens.skip();
                continue;
            }
            if (separator?.type === "symbol" && separator.value === ">") {
                this.tokens.skip();
                break;
            }
            this.fail("Expected ',' or '>' in type parameter list", this.tokenAt(separator));
        }

        return parameters;
    }

    private parseTypeAnnotationNode(): Identifier {
        const functionTypeStart = this.tokens.peek();
        if (functionTypeStart?.type === "symbol" && functionTypeStart.value === "(") {
            const openParen = this.tokens.read()!;
            let depth = 1;
            while (this.tokens.hasMore && depth > 0) {
                const token = this.tokens.read();
                if (!token) {
                    break;
                }
                if (token.type === "symbol" && token.value === "(") {
                    depth += 1;
                } else if (token.type === "symbol" && token.value === ")") {
                    depth -= 1;
                }
            }
            if (depth !== 0) {
                this.fail("Expected ')' to close function type annotation", this.tokenAt(openParen));
            }
            const arrow = this.tokens.read();
            if (arrow?.type !== "symbol" || arrow.value !== "=>") {
                this.fail("Expected '=>' in function type annotation", this.tokenAt(arrow));
            }
            const returnType = this.parseTypeAnnotationNode();
            return this.attachNodeBounds(
                { kind: "Identifier", name: `(...) => ${returnType.name}` } as Identifier,
                openParen,
                returnType.lastToken ?? this.getLastReadToken() ?? openParen
            );
        }

        const baseToken = this.tokens.read();
        if (baseToken?.type !== "identifier") {
            this.fail("Expected type identifier", this.tokenAt(baseToken));
        }

        let typeName = baseToken.value;
        if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === "<") {
            const argumentsText = this.parseTypeArgumentListText();
            typeName += `<${argumentsText.join(", ")}>`;
        }

        while (
            this.tokens.peek()?.type === "symbol" &&
            this.tokens.peek()?.value === "[" &&
            this.peekToken(1)?.type === "symbol" &&
            this.peekToken(1)?.value === "]"
        ) {
            this.tokens.skip();
            this.tokens.skip();
            typeName += "[]";
        }

        return this.attachNodeBounds(
            { kind: "Identifier", name: typeName } as Identifier,
            baseToken,
            this.getLastReadToken() ?? baseToken
        );
    }

    private parseTypeArgumentListText(): string[] {
        const open = this.tokens.read();
        if (open?.type !== "symbol" || open.value !== "<") {
            this.fail("Expected '<' to start type argument list", this.tokenAt(open));
        }

        const args: string[] = [];
        while (this.tokens.hasMore) {
            args.push(this.parseTypeAnnotationNode().name);
            const separator = this.tokens.peek();
            if (separator?.type === "symbol" && separator.value === ",") {
                this.tokens.skip();
                continue;
            }
            if (separator?.type === "symbol" && separator.value === ">") {
                this.tokens.skip();
                break;
            }
            this.fail("Expected ',' or '>' in type argument list", this.tokenAt(separator));
        }
        return args;
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

    private isDeclareInterfaceStart(): boolean {
        const first = this.peekToken(0);
        const second = this.peekToken(1);
        return (
            first?.type === "identifier" &&
            first.value === "declare" &&
            second?.type === "identifier" &&
            second.value === "interface"
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

    private isAbstractClassStart(): boolean {
        const first = this.peekToken(0);
        const second = this.peekToken(1);
        return (
            first?.type === "identifier" &&
            first.value === "abstract" &&
            second?.type === "identifier" &&
            second.value === "class"
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

    private binaryOperatorFromToken(token: Token | undefined): InfixOperator | undefined {
        if (!token) {
            return undefined;
        }

        if (token.type === "symbol") {
            const candidate = token.value as InfixOperator;
            return candidate in BINARY_OPERATOR_INFO ? candidate : undefined;
        }

        if (token.type === "identifier" && (token.value === "in" || token.value === "instanceof")) {
            return token.value as BinaryOperator;
        }

        return undefined;
    }

    private parseBinaryExpression(minPrecedence: number = 1): Expr {
        let left = this.parseUnary();

        while (this.tokens.hasMore) {
            const token = this.tokens.peek();
            const operator = this.binaryOperatorFromToken(token);
            if (!operator) {
                break;
            }

            const info = BINARY_OPERATOR_INFO[operator];
            if (!info || info.precedence < minPrecedence) {
                break;
            }

            this.tokens.skip();
            const nextMinPrecedence = info.assoc === "left" ? info.precedence + 1 : info.precedence;
            const right = this.parseBinaryExpression(nextMinPrecedence);

            if (operator === "...") {
                left = this.attachNodeBounds({
                    kind: "RangeExpression",
                    start: left,
                    end: right
                } as RangeExpression, left.firstToken, right.lastToken ?? this.getLastReadToken());
                continue;
            }

            left = this.buildBinary(operator, left, right);
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

    private parseFunctionExpression(functionKeyword: Token): FunctionExpression {
        let name: Identifier | undefined;
        const maybeName = this.tokens.peek();
        if (
            maybeName?.type === "identifier" &&
            this.peekToken(1)?.type === "symbol" &&
            this.peekToken(1)?.value === "("
        ) {
            this.tokens.skip();
            name = this.buildIdentifierFromToken(maybeName);
        }

        const openParen = this.tokens.read();
        if (openParen?.type !== "symbol" || openParen.value !== "(") {
            this.fail("Expected '(' after function keyword", this.tokenAt(openParen));
        }
        const parameters = this.parseFunctionParameters();
        const closeParen = this.tokens.read();
        if (closeParen?.type !== "symbol" || closeParen.value !== ")") {
            this.fail("Expected ')' after function parameters", this.tokenAt(closeParen));
        }
        let returnType: Identifier | undefined;
        const maybeColon = this.tokens.peek();
        if (maybeColon?.type === "symbol" && maybeColon.value === ":") {
            this.tokens.skip();
            returnType = this.parseTypeAnnotationNode();
        }
        const body = this.parseBlockStatement();
        const expression: FunctionExpression = {
            kind: "FunctionExpression",
            parameters,
            body
        };
        if (name) {
            expression.name = name;
        }
        if (returnType) {
            expression.returnType = returnType;
        }
        return this.attachNodeBounds(
            expression,
            functionKeyword,
            body.lastToken ?? this.getLastReadToken() ?? functionKeyword
        );
    }

    private parseArrowFunctionBody(): Expr | BlockStatement {
        const maybeBlock = this.tokens.peek();
        if (maybeBlock?.type === "symbol" && maybeBlock.value === "{") {
            return this.parseBlockStatement();
        }
        return this.parseAssignment();
    }

    private parseTailLambdaArgument(): ArrowFunctionExpression {
        const openBrace = this.tokens.peek();
        if (!(openBrace?.type === "symbol" && openBrace.value === "{")) {
            this.fail("Expected '{' to start tail lambda", this.tokenAt(openBrace));
        }
        this.tokens.skip();

        const explicitParametersStart = this.tokens.offset;
        const explicitParameters: FunctionParameter[] = [];
        let hasExplicitParameterArrow = false;
        if (this.tokens.peek()?.type === "identifier") {
            while (this.tokens.hasMore) {
                const parameterToken = this.tokens.peek();
                if (parameterToken?.type !== "identifier") {
                    break;
                }
                this.tokens.skip();
                let parameterOptional = false;
                if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === "?") {
                    this.tokens.skip();
                    parameterOptional = true;
                }
                let parameterTypeAnnotation: Identifier | undefined;
                if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === ":") {
                    this.tokens.skip();
                    parameterTypeAnnotation = this.parseTypeAnnotationNode();
                }

                const parameter: FunctionParameter = {
                    kind: "FunctionParameter",
                    name: this.buildIdentifierFromToken(parameterToken)
                };
                if (parameterOptional) {
                    parameter.optional = true;
                }
                if (parameterTypeAnnotation) {
                    parameter.typeAnnotation = parameterTypeAnnotation;
                }
                explicitParameters.push(
                    this.attachNodeBounds(
                        parameter,
                        parameterToken,
                        this.getLastReadToken() ?? parameterToken
                    )
                );
                const separator = this.tokens.peek();
                if (!(separator?.type === "symbol" && separator.value === ",")) {
                    break;
                }
                this.tokens.skip();
            }

            const maybeArrow = this.tokens.peek();
            if (maybeArrow?.type === "symbol" && maybeArrow.value === "->" && explicitParameters.length > 0) {
                hasExplicitParameterArrow = true;
                this.tokens.skip();
            } else {
                this.tokens.offset = explicitParametersStart;
            }
        }

        if (hasExplicitParameterArrow) {
            const bodyExpression = this.parseAssignment();
            const closeBrace = this.tokens.read();
            if (closeBrace?.type !== "symbol" || closeBrace.value !== "}") {
                this.fail("Expected '}' to close tail lambda", this.tokenAt(closeBrace));
            }
            return this.attachNodeBounds(
                {
                    kind: "ArrowFunctionExpression",
                    parameters: explicitParameters,
                    body: bodyExpression
                } as ArrowFunctionExpression,
                openBrace,
                closeBrace
            );
        }

        const statements: Statement[] = [];
        while (this.tokens.hasMore) {
            const token = this.tokens.peek();
            if (this.isEofToken(token)) {
                this.fail("Expected '}' to close tail lambda", this.tokenAt(openBrace), "block");
            }

            if (token?.type === "symbol" && token.value === "}") {
                this.tokens.skip();
                break;
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
            statements.push(statement);

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

        const block = this.attachNodeBounds(
            { kind: "BlockStatement", body: statements } as BlockStatement,
            openBrace,
            this.getLastReadToken() ?? openBrace
        );
        const implicitParameter = this.attachNodeBounds(
            {
                kind: "FunctionParameter",
                name: this.attachNodeBounds(
                    { kind: "Identifier", name: "it" } as Identifier,
                    openBrace,
                    openBrace
                )
            } as FunctionParameter,
            openBrace,
            openBrace
        );
        if (block.body.length === 1 && block.body[0]?.kind === "ExprStatement") {
            const expressionBody = (block.body[0] as ExprStatement).expression;
            return this.attachNodeBounds(
                {
                    kind: "ArrowFunctionExpression",
                    parameters: [implicitParameter],
                    body: expressionBody
                } as ArrowFunctionExpression,
                openBrace,
                block.lastToken ?? this.getLastReadToken() ?? openBrace
            );
        }
        return this.attachNodeBounds(
            {
                kind: "ArrowFunctionExpression",
                parameters: [implicitParameter],
                body: block
            } as ArrowFunctionExpression,
            openBrace,
            block.lastToken ?? this.getLastReadToken() ?? openBrace
        );
    }

    private tryParseArrowFunctionExpression(): ArrowFunctionExpression | null {
        const startOffset = this.tokens.offset;
        const first = this.tokens.peek();
        if (!first) {
            return null;
        }

        if (
            first.type === "identifier" &&
            this.peekToken(1)?.type === "symbol" &&
            this.peekToken(1)?.value === "=>"
        ) {
            this.tokens.skip();
            const parameter = this.attachNodeBounds(
                {
                    kind: "FunctionParameter",
                    name: this.buildIdentifierFromToken(first)
                } as FunctionParameter,
                first,
                first
            );
            this.tokens.skip();
            const body = this.parseArrowFunctionBody();
            return this.attachNodeBounds(
                {
                    kind: "ArrowFunctionExpression",
                    parameters: [parameter],
                    body
                } as ArrowFunctionExpression,
                first,
                body.lastToken ?? this.getLastReadToken() ?? first
            );
        }

        if (!(first.type === "symbol" && first.value === "(")) {
            return null;
        }

        try {
            const openParen = this.tokens.read();
            if (openParen?.type !== "symbol" || openParen.value !== "(") {
                this.tokens.offset = startOffset;
                return null;
            }
            const parameters = this.parseFunctionParameters();
            const closeParen = this.tokens.read();
            if (closeParen?.type !== "symbol" || closeParen.value !== ")") {
                this.tokens.offset = startOffset;
                return null;
            }
            const arrow = this.tokens.peek();
            if (!(arrow?.type === "symbol" && arrow.value === "=>")) {
                this.tokens.offset = startOffset;
                return null;
            }
            this.tokens.skip();
            const body = this.parseArrowFunctionBody();
            return this.attachNodeBounds(
                {
                    kind: "ArrowFunctionExpression",
                    parameters,
                    body
                } as ArrowFunctionExpression,
                first,
                body.lastToken ?? this.getLastReadToken() ?? first
            );
        } catch (error) {
            this.tokens.offset = startOffset;
            if (error instanceof ParseError) {
                return null;
            }
            throw error;
        }
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
            if (token.value === "function") {
                return this.parseFunctionExpression(token);
            }
            if (token.value === "true" || token.value === "false") {
                return this.attachNodeBounds(
                    { kind: "BooleanLiteral", value: token.value === "true" } as BooleanLiteral,
                    token,
                    token
                );
            }
            if (token.value === "null") {
                return this.attachNodeBounds({ kind: "NullLiteral" } as NullLiteral, token, token);
            }
            if (token.value === "undefined") {
                return this.attachNodeBounds({ kind: "UndefinedLiteral" } as UndefinedLiteral, token, token);
            }
            return this.buildIdentifierFromToken(token);
        }

        this.fail("Expected a number literal, string literal, identifier, '(', '[' or '{'", this.tokenAt(token));
    }

    private parsePostfix(): Expr {
        let expr = this.parsePrimary();
        let pendingTypeArguments: Identifier[] | undefined;

        while (this.tokens.hasMore) {
            const token = this.tokens.peek();

            if (token?.type === "symbol" && token.value === "<") {
                const parsedTypeArguments = this.tryParseInvocationTypeArguments();
                if (parsedTypeArguments) {
                    pendingTypeArguments = parsedTypeArguments;
                    continue;
                }
            }

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
                if (this.hasLineBreakBetween(expr.lastToken, token)) {
                    break;
                }
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
                    arguments: args,
                    ...(pendingTypeArguments ? { typeArguments: pendingTypeArguments } : {})
                } as CallExpression, expr.firstToken, close);
                pendingTypeArguments = undefined;
                continue;
            }

            if (token?.type === "symbol" && token.value === "{") {
                if (this.hasLineBreakBetween(expr.lastToken, token)) {
                    break;
                }
                const tailLambda = this.parseTailLambdaArgument();
                if (expr.kind === "CallExpression") {
                    const call = expr as CallExpression;
                    const newCall = this.attachNodeBounds(
                        {
                            kind: "CallExpression",
                            callee: call.callee,
                            arguments: [...call.arguments, tailLambda],
                            ...(call.typeArguments ? { typeArguments: call.typeArguments } : {})
                        } as CallExpression,
                        call.firstToken,
                        tailLambda.lastToken ?? this.getLastReadToken()
                    );
                    expr = newCall;
                    continue;
                }
                expr = this.attachNodeBounds(
                    {
                        kind: "CallExpression",
                        callee: expr,
                        arguments: [tailLambda]
                    } as CallExpression,
                    expr.firstToken,
                    tailLambda.lastToken ?? this.getLastReadToken()
                );
                continue;
            }

            if (token?.type === "symbol" && (token.value === "++" || token.value === "--")) {
                if (this.hasLineBreakBetween(expr.lastToken, token)) {
                    break;
                }
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
                if (callTarget.typeArguments) {
                    statement.typeArguments = callTarget.typeArguments;
                }
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

    private tryParseInvocationTypeArguments(): Identifier[] | null {
        const startOffset = this.tokens.offset;
        const open = this.tokens.peek();
        if (!(open?.type === "symbol" && open.value === "<")) {
            return null;
        }

        this.tokens.skip();
        const typeArguments: Identifier[] = [];

        try {
            while (this.tokens.hasMore) {
                typeArguments.push(this.parseTypeAnnotationNode());

                const separator = this.tokens.peek();
                if (separator?.type === "symbol" && separator.value === ",") {
                    this.tokens.skip();
                    continue;
                }
                if (separator?.type === "symbol" && separator.value === ">") {
                    this.tokens.skip();
                    break;
                }
                this.tokens.offset = startOffset;
                return null;
            }
        } catch (error) {
            this.tokens.offset = startOffset;
            if (error instanceof ParseError) {
                return null;
            }
            throw error;
        }

        const next = this.tokens.peek();
        if (!(next?.type === "symbol" && next.value === "(")) {
            this.tokens.offset = startOffset;
            return null;
        }

        return typeArguments;
    }

    private parseConditional(): Expr {
        const test = this.parseBinaryExpression();
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
        const arrowFunction = this.tryParseArrowFunctionExpression();
        if (arrowFunction) {
            return arrowFunction;
        }

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
            typeAnnotation = this.parseTypeAnnotationNode();
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


    private parseTypeAliasStatement(declared: boolean = false): TypeAliasStatement {
        const typeKeyword = this.tokens.read();
        if (typeKeyword?.type !== "identifier" || typeKeyword.value !== "type") {
            this.fail("Expected type alias declaration", this.tokenAt(typeKeyword));
        }

        const nameToken = this.tokens.read();
        if (nameToken?.type !== "identifier") {
            this.fail("Expected type alias name after 'type'", this.tokenAt(nameToken));
        }

        const typeParameters = this.parseTypeParameterList();

        const equalsToken = this.tokens.read();
        if (equalsToken?.type !== "symbol" || equalsToken.value !== "=") {
            this.fail("Expected '=' in type alias declaration", this.tokenAt(equalsToken));
        }

        const targetType = this.parseTypeAnnotationNode();
        const statement: TypeAliasStatement = {
            kind: "TypeAliasStatement",
            name: this.buildIdentifierFromToken(nameToken),
            targetType
        };
        if (declared) {
            statement.declared = true;
        }
        if (typeParameters.length > 0) {
            statement.typeParameters = typeParameters;
        }
        return this.attachNodeBounds(statement, typeKeyword, targetType.lastToken ?? this.getLastReadToken() ?? typeKeyword);
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

        const typeParameters = this.parseTypeParameterList();

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
            returnType = this.parseTypeAnnotationNode();
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
        if (typeParameters.length > 0) {
            statement.typeParameters = typeParameters;
        }
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

        const typeParameters = this.parseTypeParameterList();

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
        if (typeParameters.length > 0) {
            statement.typeParameters = typeParameters;
        }

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

    private parseDeclareInterfaceStatement(): InterfaceStatement {
        const declareKeyword = this.tokens.read();
        if (declareKeyword?.type !== "identifier" || declareKeyword.value !== "declare") {
            this.fail("Expected 'declare' before interface declaration", this.tokenAt(declareKeyword));
        }

        const interfaceKeyword = this.tokens.peek();
        if (interfaceKeyword?.type !== "identifier" || interfaceKeyword.value !== "interface") {
            this.fail("Expected 'interface' after 'declare'", this.tokenAt(interfaceKeyword));
        }

        const statement = this.parseInterfaceStatement(true);
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
                parameterTypeAnnotation = this.parseTypeAnnotationNode();
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
        const firstToken = this.tokens.peek();
        let memberStartToken = firstToken;
        let isOverrideMember = false;
        let accessModifier: ClassMember["accessModifier"] | undefined;
        let isReadonlyMember = false;
        let isStaticMember = false;
        let isAbstractMember = false;

        while (this.tokens.peek()?.type === "identifier" && this.isClassMemberModifier(this.tokens.peek()!.value)) {
            const modifierToken = this.tokens.read()!;
            memberStartToken ??= modifierToken;
            if (modifierToken.value === "override") {
                isOverrideMember = true;
            } else if (modifierToken.value === "public" || modifierToken.value === "private" || modifierToken.value === "protected") {
                accessModifier = modifierToken.value;
            } else if (modifierToken.value === "readonly") {
                isReadonlyMember = true;
            } else if (modifierToken.value === "static") {
                isStaticMember = true;
            } else if (modifierToken.value === "abstract") {
                isAbstractMember = true;
            }
        }

        const memberNameToken = this.tokens.read();
        if (memberNameToken?.type !== "identifier") {
            this.fail("Expected class member name", this.tokenAt(memberNameToken));
        }

        const methodTypeParameters = this.parseTypeParameterList();
        if ((methodTypeParameters.length > 0) || (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === "(")) {
            if (!(this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === "(")) {
                this.fail("Expected '(' after method type parameters", this.tokenAt(this.tokens.peek()));
            }
            this.tokens.skip();
            const parameters = this.parseFunctionParameters();

            const closeParen = this.tokens.read();
            if (closeParen?.type !== "symbol" || closeParen.value !== ")") {
                this.fail("Expected ')' after method parameters", this.tokenAt(closeParen));
            }

            let returnType: Identifier | undefined;
            if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === ":") {
                this.tokens.skip();
                returnType = this.parseTypeAnnotationNode();
            }

            if (this.tokens.peek()?.type !== "symbol" || this.tokens.peek()?.value !== "{") {
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
                this.applyClassMemberModifiers(signatureOnlyMethod, {
                    override: isOverrideMember,
                    accessModifier,
                    readonly: isReadonlyMember,
                    static: isStaticMember,
                    abstract: isAbstractMember
                });
                if (!allowSignatureOnly && !isAbstractMember) {
                    signatureOnlyMethod.missingBody = true;
                }
                if (methodTypeParameters.length > 0) {
                    signatureOnlyMethod.typeParameters = methodTypeParameters;
                }
                if (returnType) {
                    signatureOnlyMethod.returnType = returnType;
                }

                return this.attachNodeBounds(signatureOnlyMethod, memberStartToken, this.getLastReadToken() ?? memberNameToken);
            }

            const methodMember: ClassMethodMember = {
                kind: "ClassMethodMember",
                name: this.buildIdentifierFromToken(memberNameToken),
                parameters,
                body: this.parseBlockStatement()
            };
            this.applyClassMemberModifiers(methodMember, {
                override: isOverrideMember,
                accessModifier,
                readonly: isReadonlyMember,
                static: isStaticMember,
                abstract: isAbstractMember
            });
            if (methodTypeParameters.length > 0) {
                methodMember.typeParameters = methodTypeParameters;
            }
            if (returnType) {
                methodMember.returnType = returnType;
            }

            return this.attachNodeBounds(methodMember, memberStartToken, this.getLastReadToken() ?? memberNameToken);
        }

        let optional = false;
        if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === "?") {
            this.tokens.skip();
            optional = true;
        }

        let typeAnnotation: Identifier | undefined;
        if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === ":") {
            this.tokens.skip();
            typeAnnotation = this.parseTypeAnnotationNode();
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
        this.applyClassMemberModifiers(fieldMember, {
            override: isOverrideMember,
            accessModifier,
            readonly: isReadonlyMember,
            static: isStaticMember,
            abstract: isAbstractMember
        });
        if (optional) {
            fieldMember.optional = true;
        }
        if (typeAnnotation) {
            fieldMember.typeAnnotation = typeAnnotation;
        }
        if (initializer) {
            fieldMember.initializer = initializer;
        }
        return this.attachNodeBounds(fieldMember, memberStartToken, this.getLastReadToken() ?? memberNameToken);
    }

    private isClassMemberModifier(value: string): boolean {
        return value === "override" || value === "public" || value === "private" || value === "protected" || value === "readonly" || value === "static" || value === "abstract";
    }

    private applyClassMemberModifiers(
        member: ClassMember,
        modifiers: {
            override: boolean;
            accessModifier?: ClassMember["accessModifier"];
            readonly: boolean;
            static: boolean;
            abstract: boolean;
        }
    ): void {
        if (modifiers.override) {
            member.override = true;
        }
        if (modifiers.accessModifier) {
            member.accessModifier = modifiers.accessModifier;
        }
        if (modifiers.readonly) {
            member.readonly = true;
        }
        if (modifiers.static) {
            member.static = true;
        }
        if (modifiers.abstract) {
            member.abstract = true;
        }
    }

    private parseClassPrimaryConstructorParameters(): ClassPrimaryConstructorParameter[] {
        const parameters: ClassPrimaryConstructorParameter[] = [];
        if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === ")") {
            return parameters;
        }

        while (this.tokens.hasMore) {
            const firstToken = this.tokens.read();
            if (firstToken?.type !== "identifier") {
                this.fail("Expected parameter name in class primary constructor", this.tokenAt(firstToken));
            }

            let declarationKind: VariableDeclarationKind = "val";
            let parameterNameToken: Token | undefined;
            if (VARIABLE_DECLARATION_KEYWORDS.includes(firstToken.value as VariableDeclarationKind)) {
                declarationKind = firstToken.value as VariableDeclarationKind;
                parameterNameToken = this.tokens.read();
            } else {
                parameterNameToken = firstToken;
            }

            if (parameterNameToken?.type !== "identifier") {
                this.fail("Expected parameter name in class primary constructor", this.tokenAt(parameterNameToken));
            }

            let parameterTypeAnnotation: Identifier | undefined;
            if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === ":") {
                this.tokens.skip();
                parameterTypeAnnotation = this.parseTypeAnnotationNode();
            }

            let parameterDefaultValue: Expr | undefined;
            if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === "=") {
                this.tokens.skip();
                parameterDefaultValue = this.parseExpressionOrThrow();
            }

            const parameter: ClassPrimaryConstructorParameter = {
                kind: "ClassPrimaryConstructorParameter",
                declarationKind,
                name: this.buildIdentifierFromToken(parameterNameToken)
            };
            if (parameterTypeAnnotation) {
                parameter.typeAnnotation = parameterTypeAnnotation;
            }
            if (parameterDefaultValue) {
                parameter.defaultValue = parameterDefaultValue;
            }
            parameters.push(this.attachNodeBounds(parameter, firstToken, this.getLastReadToken() ?? firstToken));

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
        let classKeyword = this.tokens.read();
        let isAbstractClass = false;
        const startToken = classKeyword;
        if (classKeyword?.type === "identifier" && classKeyword.value === "abstract") {
            isAbstractClass = true;
            classKeyword = this.tokens.read();
        }
        if (classKeyword?.type !== "identifier" || classKeyword.value !== "class") {
            this.fail("Expected class declaration statement", this.tokenAt(classKeyword));
        }

        const classNameToken = this.tokens.read();
        if (classNameToken?.type !== "identifier") {
            this.fail("Expected class name after 'class'", this.tokenAt(classNameToken));
        }

        const typeParameters = this.parseTypeParameterList();

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

        let extendsType: Identifier | undefined;
        if (this.tokens.peek()?.type === "identifier" && this.tokens.peek()?.value === "extends") {
            this.tokens.skip();
            extendsType = this.parseTypeAnnotationNode();
        }

        let implementsTypes: Identifier[] | undefined;
        if (this.tokens.peek()?.type === "identifier" && this.tokens.peek()?.value === "implements") {
            this.tokens.skip();
            implementsTypes = [];
            while (this.tokens.hasMore) {
                implementsTypes.push(this.parseTypeAnnotationNode());

                const separator = this.tokens.peek();
                if (separator?.type === "symbol" && separator.value === ",") {
                    this.tokens.skip();
                    continue;
                }
                break;
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
                if (isAbstractClass) {
                    statement.abstract = true;
                }
                if (typeParameters.length > 0) {
                    statement.typeParameters = typeParameters;
                }
                if (extendsType) {
                    statement.extendsType = extendsType;
                }
                if (implementsTypes && implementsTypes.length > 0) {
                    statement.implementsTypes = implementsTypes;
                }
                if (primaryConstructorParameters && primaryConstructorParameters.length > 0) {
                    statement.primaryConstructorParameters = primaryConstructorParameters;
                }
                return this.attachNodeBounds(statement, startToken, this.getLastReadToken() ?? classKeyword);
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
                if (isAbstractClass) {
                    statement.abstract = true;
                }
                if (typeParameters.length > 0) {
                    statement.typeParameters = typeParameters;
                }
                if (extendsType) {
                    statement.extendsType = extendsType;
                }
                if (implementsTypes && implementsTypes.length > 0) {
                    statement.implementsTypes = implementsTypes;
                }
                if (primaryConstructorParameters && primaryConstructorParameters.length > 0) {
                    statement.primaryConstructorParameters = primaryConstructorParameters;
                }
                return this.attachNodeBounds(statement, startToken, this.getLastReadToken() ?? classKeyword);
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

    private parseInterfaceStatement(declared: boolean = false): InterfaceStatement {
        const interfaceKeyword = this.tokens.read();
        if (interfaceKeyword?.type !== "identifier" || interfaceKeyword.value !== "interface") {
            this.fail("Expected interface declaration statement", this.tokenAt(interfaceKeyword));
        }

        const interfaceNameToken = this.tokens.read();
        if (interfaceNameToken?.type !== "identifier") {
            this.fail("Expected interface name after 'interface'", this.tokenAt(interfaceNameToken));
        }

        const typeParameters = this.parseTypeParameterList();

        let extendsTypes: Identifier[] | undefined;
        if (this.tokens.peek()?.type === "identifier" && this.tokens.peek()?.value === "extends") {
            this.tokens.skip();
            extendsTypes = [];
            while (this.tokens.hasMore) {
                extendsTypes.push(this.parseTypeAnnotationNode());

                const separator = this.tokens.peek();
                if (separator?.type === "symbol" && separator.value === ",") {
                    this.tokens.skip();
                    continue;
                }
                break;
            }
        }

        const openBrace = this.tokens.read();
        if (openBrace?.type !== "symbol" || openBrace.value !== "{") {
            this.fail("Expected '{' to start interface body", this.tokenAt(openBrace));
        }

        const members: InterfaceMember[] = [];
        while (this.tokens.hasMore) {
            const token = this.tokens.peek();
            if (this.isEofToken(token)) {
                this.fail("Expected '}' to close interface body", this.tokenAt(openBrace), "block");
            }
            if (token?.type === "symbol" && token.value === "}") {
                this.tokens.skip();
                const statement: InterfaceStatement = {
                    kind: "InterfaceStatement",
                    name: this.buildIdentifierFromToken(interfaceNameToken),
                    members
                };
                if (declared) {
                    statement.declared = true;
                }
                if (typeParameters.length > 0) {
                    statement.typeParameters = typeParameters;
                }
                if (extendsTypes && extendsTypes.length > 0) {
                    statement.extendsTypes = extendsTypes;
                }
                return this.attachNodeBounds(statement, interfaceKeyword, this.getLastReadToken() ?? interfaceKeyword);
            }

            if (token?.type === "symbol" && token.value === ";") {
                this.tokens.skip();
                continue;
            }

            const memberNameToken = this.tokens.read();
            if (memberNameToken?.type !== "identifier") {
                this.fail("Expected interface member name", this.tokenAt(memberNameToken));
            }

            if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === "(") {
                this.tokens.skip();
                const parameters = this.parseFunctionParameters();
                const closeParen = this.tokens.read();
                if (closeParen?.type !== "symbol" || closeParen.value !== ")") {
                    this.fail("Expected ')' after interface method parameters", this.tokenAt(closeParen));
                }

                let returnType: Identifier | undefined;
                if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === ":") {
                    this.tokens.skip();
                    returnType = this.parseTypeAnnotationNode();
                }

                const member: InterfaceMethodMember = {
                    kind: "InterfaceMethodMember",
                    name: this.buildIdentifierFromToken(memberNameToken),
                    parameters
                };
                if (returnType) {
                    member.returnType = returnType;
                }
                members.push(this.attachNodeBounds(member, memberNameToken, this.getLastReadToken() ?? memberNameToken));
                this.consumeStatementSeparator("block", this.getLastReadToken());
                continue;
            }

            if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === "<") {
                this.parseTypeParameterList();
                if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === "(") {
                    this.tokens.skip();
                    const parameters = this.parseFunctionParameters();
                    const closeParen = this.tokens.read();
                    if (closeParen?.type !== "symbol" || closeParen.value !== ")") {
                        this.fail("Expected ')' after interface method parameters", this.tokenAt(closeParen));
                    }

                    let returnType: Identifier | undefined;
                    if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === ":") {
                        this.tokens.skip();
                        returnType = this.parseTypeAnnotationNode();
                    }

                    const member: InterfaceMethodMember = {
                        kind: "InterfaceMethodMember",
                        name: this.buildIdentifierFromToken(memberNameToken),
                        parameters
                    };
                    if (returnType) {
                        member.returnType = returnType;
                    }
                    members.push(this.attachNodeBounds(member, memberNameToken, this.getLastReadToken() ?? memberNameToken));
                    this.consumeStatementSeparator("block", this.getLastReadToken());
                    continue;
                }
            }

            if (!(this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === ":")) {
                this.fail("Expected ':' after interface property name", this.tokenAt(this.tokens.peek()));
            }
            this.tokens.skip();
            const propertyType = this.parseTypeAnnotationNode();
            const propertyMember: InterfacePropertyMember = {
                kind: "InterfacePropertyMember",
                name: this.buildIdentifierFromToken(memberNameToken),
                typeAnnotation: propertyType
            };
            members.push(this.attachNodeBounds(propertyMember, memberNameToken, this.getLastReadToken() ?? memberNameToken));
            this.consumeStatementSeparator("block", this.getLastReadToken());
        }

        this.fail("Expected '}' to close interface body", this.tokenAt(openBrace), "block");
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

export function getProgramRecoveryMarkers(program: Program): ParseRecoveryMarker[] {
    const markers = (program as unknown as { [RECOVERY_MARKERS_SYMBOL]?: ParseRecoveryMarker[] })[RECOVERY_MARKERS_SYMBOL];
    if (!markers) {
        return [];
    }
    return [...markers];
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
