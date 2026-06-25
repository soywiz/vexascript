import { ListReader } from "compiler/utils/ListReader";
import { Token } from "./tokenizer";
import { hasLineBreakBetween, isClassMemberModifier, isEofToken, isLikelyStatementStart, typeTokenText } from "./tokenHelpers";
import {
    AnnotationApplication,
    AnnotationStatement,
    ArrowFunctionExpression,
    ArrayLiteral,
    AsExpression,
    AssignmentExpression,
    BigIntLiteral,
    BindingElement,
    BindingName,
    BinaryExpression,
    BooleanLiteral,
    BlockStatement,
    BreakStatement,
    CallExpression,
    CatchClause,
    ChainExpression,
    ClassDelegate,
    ClassExpression,
    ClassFieldMember,
    ClassMember,
    ClassMethodMember,
    ClassPrimaryConstructorParameter,
    ClassStatement,
    ConditionalExpression,
    CommaExpression,
    ContinueStatement,
    DebuggerStatement,
    DeferStatement,
    DoWhileStatement,
    Expr,
    ExprStatement,
    EnumMember,
    EnumStatement,
    ExportSpecifier,
    ExportStatement,
    EmptyStatement,
    ForStatement,
    FloatLiteral,
    FunctionDeclarationKind,
    FunctionExpression,
    FunctionParameter,
    FunctionStatement,
    Identifier,
    JsxElement,
    JsxFragment,
    JsxAttribute,
    JsxAttributeLike,
    JsxSpreadAttribute,
    JsxExpressionContainer,
    JsxChild,
    JsxText,
    InterfaceMember,
    InterfaceMethodMember,
    InterfacePropertyMember,
    InterfaceStatement,
    IfStatement,
    ImportSpecifier,
    ImportStatement,
    IntLiteral,
    LongLiteral,
    LabeledStatement,
    MemberExpression,
    NewExpression,
    NamespaceStatement,
    NonNullExpression,
    NullLiteral,
    ObjectBindingPattern,
    ArrayBindingPattern,
    Node,
    ObjectLiteral,
    ObjectLiteralProperty,
    ObjectProperty,
    ObjectSpreadProperty,
    NamedArgument,
    OverloadableOperator,
    Program,
    PropertyReferenceExpression,
    RangeExpression,
    ReturnStatement,
    RegExpLiteral,
    SatisfiesExpression,
    Statement,
    StringLiteral,
    SpreadExpression,
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
    WhileStatement,
    WithStatement
} from "compiler/ast/ast";

type BinaryOperator = BinaryExpression["operator"];
type AssignmentOperator = AssignmentExpression["operator"];
type BinaryAssoc = "left" | "right";
type InfixOperator = BinaryOperator | "..." | "..<";

const ASSIGNMENT_OPERATORS: readonly AssignmentOperator[] = ["=", "+=", "-=", "%=", "*=", "/=", "&=", "|=", "^=", "&&=", "||=", "??=", "<<=", ">>=", ">>>="];
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
    "<=>": { precedence: 7, assoc: "left" },
    "in": { precedence: 7, assoc: "left" },
    "instanceof": { precedence: 7, assoc: "left" },
    "is": { precedence: 7, assoc: "left" },
    "<<": { precedence: 8, assoc: "left" },
    ">>": { precedence: 8, assoc: "left" },
    ">>>": { precedence: 8, assoc: "left" },
    "...": { precedence: 9, assoc: "left" },
    "..<": { precedence: 9, assoc: "left" },
    "+": { precedence: 10, assoc: "left" },
    "-": { precedence: 10, assoc: "left" },
    "*": { precedence: 11, assoc: "left" },
    "/": { precedence: 11, assoc: "left" },
    "%": { precedence: 11, assoc: "left" },
    "**": { precedence: 12, assoc: "right" }
};

/**
 * Applies JSX whitespace normalization to raw element text: whitespace runs that
 * span a line break collapse, leading/trailing blank lines are removed, and the
 * surviving lines are joined with single spaces. Text without a line break keeps
 * its inner spacing intact (matching JSX/TSX semantics).
 */
export function normalizeJsxText(raw: string): string {
    const lines = raw.split(/\r\n|\n|\r/);
    const pieces: string[] = [];
    for (let i = 0; i < lines.length; i += 1) {
        let line = lines[i] ?? "";
        if (i !== 0) {
            line = line.replace(/^[ \t]+/, "");
        }
        if (i !== lines.length - 1) {
            line = line.replace(/[ \t]+$/, "");
        }
        if (line.length > 0) {
            pieces.push(line);
        }
    }
    return pieces.join(" ");
}

export type ParseLanguage = "vexa" | "typescript";

export interface ParserOptions {
    language?: ParseLanguage;
    /**
     * Enables embedded XML/JSX and, when true, disables the `<Type>expr`
     * angle-bracket cast. Only meaningful in TypeScript mode: VexaScript always
     * behaves as if `jsx` were on (one mode that supports embedding XML). In
     * TypeScript mode it defaults to off so the angle-bracket cast keeps working.
     */
    jsx?: boolean;
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

interface TokenCheckpoint {
    offset: number;
    mutatedTokens: Map<number, Token>;
}

const RECOVERY_MARKERS_SYMBOL: unique symbol = Symbol("vexa.parseRecoveryMarkers");

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
    /**
     * Effective JSX mode. VexaScript always supports embedding XML; TypeScript
     * opts in through `jsx`. When on, the `<Type>expr` cast is disabled.
     */
    public readonly jsx: boolean;
    private readonly recoveryMarkers: ParseRecoveryMarker[] = [];
    private readonly tokenCheckpoints: TokenCheckpoint[] = [];

    constructor(public tokens: ListReader<Token>, options: ParserOptions = {}) {
        this.language = options.language ?? "vexa";
        this.jsx = this.language !== "typescript" ? true : (options.jsx ?? false);
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
            if (isEofToken(this.tokens.peek())) {
                this.tokens.skip();
                break;
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
        return this.parseCommaExpression();
    }

    parseStatementOrThrow(): Statement {
        const token = this.tokens.peek();
        if (token?.type === "symbol" && token.value === "@") {
            return this.parseAnnotatedStatement();
        }
        if (this.isTypeScriptExportAssignmentStart()) {
            return this.parseTypeScriptExportAssignmentStatement();
        }
        if (token?.type === "identifier" && token.value === "export") {
            return this.parseExportStatement();
        }
        if (token?.type === "identifier" && (token.value === "enum" || this.isConstEnumStart())) {
            return this.parseEnumStatement();
        }
        if (token?.type === "identifier" && token.value === "annotation") {
            return this.parseAnnotationStatement();
        }
        if (token?.type === "identifier" && this.isVariableDeclarationKeyword(token.value)) {
            return this.parseVarStatement();
        }
        if (token?.type === "identifier" && token.value === "import") {
            return this.parseImportStatement();
        }
        if (token?.type === "identifier" && (this.isFunctionDeclarationKeyword(token.value) || this.isAsyncFunctionDeclarationStart() || this.isSyncFunctionDeclarationStart())) {
            return this.parseFunctionStatement();
        }
        if (this.isTypeAliasStatementStart()) {
            return this.parseTypeAliasStatement();
        }
        if (this.isDeclareFunctionStart()) {
            return this.parseDeclareFunctionStatement();
        }
        if (this.isDeclareTypeAliasStart()) {
            return this.parseDeclareTypeAliasStatement();
        }
        if (this.isDeclareEnumStart()) {
            return this.parseDeclareEnumStatement();
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
            return this.parseNamespaceStatement(true);
        }
        if (token?.type === "identifier" && (token.value === "namespace" || token.value === "module")) {
            return this.parseNamespaceStatement(false);
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
        if (token?.type === "identifier" && token.value === "with") {
            return this.parseWithStatement();
        }
        if (token?.type === "identifier" && token.value === "return") {
            return this.parseReturnStatement();
        }
        if (token?.type === "identifier" && token.value === "throw") {
            return this.parseThrowStatement();
        }
        if (token?.type === "identifier" && token.value === "defer") {
            return this.parseDeferStatement();
        }
        if (token?.type === "identifier" && token.value === "continue") {
            return this.parseContinueStatement();
        }
        if (token?.type === "identifier" && token.value === "break") {
            return this.parseBreakStatement();
        }
        if (token?.type === "identifier" && token.value === "debugger") {
            return this.parseDebuggerStatement();
        }
        if (token?.type === "symbol" && token.value === ";") {
            const semicolon = this.tokens.read();
            return this.attachNodeBounds({ kind: "EmptyStatement" } as EmptyStatement, semicolon, semicolon);
        }
        if (token?.type === "identifier" && token.value === "try") {
            return this.parseTryStatement();
        }
        if (token?.type === "symbol" && token.value === "{") {
            return this.parseBlockStatement();
        }
        if (this.isLabeledStatementStart()) {
            return this.parseLabeledStatement();
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

    private parseAnnotatedStatement(): Statement {
        const annotations: AnnotationApplication[] = [];
        while (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === "@") {
            annotations.push(this.parseAnnotationApplication());
        }
        const statement = this.parseStatementOrThrow();
        statement.annotations = [...(statement.annotations ?? []), ...annotations];
        for (const annotation of annotations) {
            this.applyBuiltinAnnotation(statement, annotation);
        }
        return this.attachNodeBounds(statement, annotations[0]?.firstToken, statement.lastToken);
    }

    private parseAnnotationApplication(): AnnotationApplication {
        const atToken = this.tokens.read();
        const annotationName = this.tokens.read();
        if (atToken?.type !== "symbol" || atToken.value !== "@") {
            this.fail("Expected '@'", this.tokenAt(atToken));
        }
        if (annotationName?.type !== "identifier") {
            this.fail("Expected annotation name after '@'", this.tokenAt(annotationName));
        }
        const openParen = this.tokens.peek();
        if (openParen?.type !== "symbol" || openParen.value !== "(") {
            return this.attachNodeBounds(
                {
                    kind: "AnnotationApplication",
                    name: this.buildIdentifierFromToken(annotationName),
                    arguments: []
                } as AnnotationApplication,
                atToken,
                annotationName
            );
        }
        this.tokens.read();
        const args = this.parseDelimitedList(")", () => this.parseAssignment(), "annotation argument list");
        const closeParen = this.tokens.read();
        if (closeParen?.type !== "symbol" || closeParen.value !== ")") {
            this.fail(`Expected ')' after '@${annotationName.value}' arguments`, this.tokenAt(closeParen));
        }
        return this.attachNodeBounds(
            {
                kind: "AnnotationApplication",
                name: this.buildIdentifierFromToken(annotationName),
                arguments: args
            } as AnnotationApplication,
            atToken,
            closeParen
        );
    }

    private applyBuiltinAnnotation(statement: Statement, annotation: AnnotationApplication): void {
        const name = annotation.name.name;
        if (name !== "JsName" && name !== "JsInline") {
            return;
        }
        const argument = annotation.arguments[0];
        if (annotation.arguments.length !== 1 || argument?.kind !== "StringLiteral") {
            this.fail(`Expected a single string argument in '@${name}'`, this.tokenAt(argument?.firstToken));
        }
        if (name === "JsInline") {
            if (statement.kind !== "FunctionStatement") {
                this.fail("'@JsInline' can only be applied to a function declaration", this.tokenAt(annotation.name.firstToken));
            }
            (statement as FunctionStatement).jsInline = (argument as StringLiteral).value;
            return;
        }
        statement.jsName = (argument as StringLiteral).value;
    }

    private parseAnnotationStatement(): AnnotationStatement {
        const annotationKeyword = this.tokens.read();
        if (annotationKeyword?.type !== "identifier" || annotationKeyword.value !== "annotation") {
            this.fail("Expected annotation declaration statement", this.tokenAt(annotationKeyword));
        }
        const nameToken = this.tokens.read();
        if (nameToken?.type !== "identifier") {
            this.fail("Expected annotation name after 'annotation'", this.tokenAt(nameToken));
        }
        const openParen = this.tokens.peek();
        if (openParen?.type !== "symbol" || openParen.value !== "(") {
            const statement: AnnotationStatement = {
                kind: "AnnotationStatement",
                name: this.buildIdentifierFromToken(nameToken),
                parameters: []
            };
            return this.attachNodeBounds(statement, annotationKeyword, nameToken);
        }
        this.tokens.read();
        const parameters = this.parseAnnotationParameters();
        const closeParen = this.tokens.read();
        if (closeParen?.type !== "symbol" || closeParen.value !== ")") {
            this.fail("Expected ')' after annotation parameters", this.tokenAt(closeParen));
        }
        const statement: AnnotationStatement = {
            kind: "AnnotationStatement",
            name: this.buildIdentifierFromToken(nameToken),
            parameters
        };
        this.attachNonEnumerableToken(statement, "parametersCloseParen", closeParen);
        return this.attachNodeBounds(statement, annotationKeyword, closeParen);
    }

    private parseDelimitedList<T extends Node>(
        closingSymbol: string,
        parseItem: () => T,
        contextName: string
    ): T[] {
        const items: T[] = [];
        if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === closingSymbol) {
            return items;
        }
        while (this.tokens.hasMore) {
            items.push(parseItem());
            const separator = this.tokens.peek();
            if (separator?.type === "symbol" && separator.value === ",") {
                this.tokens.skip();
                continue;
            }
            if (separator?.type === "symbol" && separator.value === closingSymbol) {
                break;
            }
            this.fail(`Expected ',' or '${closingSymbol}' in ${contextName}`, this.tokenAt(separator));
        }
        return items;
    }

    parseFileOrThrow(): Program {
        const startToken = this.tokens.peek();
        const body: Statement[] = [];

        while (this.tokens.hasMore) {
            if (isEofToken(this.tokens.peek())) {
                this.tokens.skip();
                break;
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
        if (startToken && !isEofToken(startToken)) {
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
            if (isEofToken(token)) {
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
                isLikelyStatementStart(token)
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
                isLikelyStatementStart(token)
            ) {
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

    private attachNonEnumerableToken<T extends Node, K extends string>(node: T, property: K, token: Token): T {
        Object.defineProperty(node, property, {
            value: token,
            enumerable: false,
            writable: true,
            configurable: true
        });
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

    private buildComputedMemberIdentifier(key: Expr, openBracket: Token | undefined, closeBracket: Token): Identifier {
        const displayName = this.computedMemberKeyText(key);
        return this.attachNodeBounds(
            { kind: "Identifier", name: `[${displayName}]` } as Identifier,
            openBracket ?? key.firstToken,
            closeBracket
        );
    }

    private computedMemberKeyText(key: Expr): string {
        switch (key.kind) {
            case "Identifier":
                return (key as Identifier).name;
            case "StringLiteral":
                return JSON.stringify((key as StringLiteral).value);
            case "IntLiteral":
            case "FloatLiteral":
                return String((key as IntLiteral | FloatLiteral).value);
            case "MemberExpression": {
                const member = key as MemberExpression;
                if (
                    member.computed ||
                    member.object.kind !== "Identifier" ||
                    member.property.kind !== "Identifier"
                ) {
                    return "computed";
                }
                return `${this.computedMemberKeyText(member.object)}.${this.computedMemberKeyText(member.property)}`;
            }
            default:
                return "computed";
        }
    }

    private tryParsePrivateIdentifierToken(): Token | null {
        const hash = this.tokens.peek();
        const name = this.peekToken(1);
        if (
            hash?.type === "symbol" &&
            hash.value === "#" &&
            name?.type === "identifier"
        ) {
            this.tokens.skip();
            this.tokens.skip();
            return {
                ...name,
                value: `#${name.value}`,
                range: {
                    start: hash.range.start,
                    end: name.range.end
                }
            };
        }
        return null;
    }

    private parseTypeParameterList(): TypeParameter[] {
        const open = this.tokens.peek();
        if (!(open?.type === "symbol" && open.value === "<")) {
            return [];
        }
        this.tokens.skip();

        const parameters: TypeParameter[] = [];
        while (this.tokens.hasMore) {
            if (this.consumeGenericCloseAngle()) {
                break;
            }
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
            if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === "=") {
                this.tokens.skip();
                parameter.defaultType = this.parseTypeAnnotationNode();
            }
            parameters.push(this.attachNodeBounds(
                parameter,
                token,
                parameter.defaultType?.lastToken ?? parameter.constraint?.lastToken ?? token
            ));

            const separator = this.tokens.peek();
            if (separator?.type === "symbol" && separator.value === ",") {
                this.tokens.skip();
                if (this.consumeGenericCloseAngle()) {
                    break;
                }
                continue;
            }
            if (this.consumeGenericCloseAngle()) {
                break;
            }
            this.fail("Expected ',' or '>' in type parameter list", this.tokenAt(separator));
        }

        return parameters;
    }

    private parseTypeAnnotationNode(): Identifier {
        const firstToken = this.tokens.peek();
        const typeName = this.parseConditionalTypeAnnotationText();
        const lastToken = this.getLastReadToken() ?? firstToken;
        if (!firstToken || !lastToken) {
            this.fail("Expected type identifier", this.tokenAt(firstToken));
        }
        return this.attachNodeBounds(
            { kind: "Identifier", name: typeName } as Identifier,
            firstToken,
            lastToken
        );
    }

    // Parses a class heritage type (the operand of `extends`/`implements`).
    // Unlike parseTypeAnnotationNode it stops before a following `extends`, so a
    // surplus `extends`/`implements` clause is not mis-parsed as a conditional
    // type (`A extends B ? ... : ...`).
    private parseHeritageTypeNode(): Identifier {
        const firstToken = this.tokens.peek();
        const typeName = this.parseUnionTypeAnnotationText();
        const lastToken = this.getLastReadToken() ?? firstToken;
        if (!firstToken || !lastToken) {
            this.fail("Expected type identifier", this.tokenAt(firstToken));
        }
        return this.attachNodeBounds(
            { kind: "Identifier", name: typeName } as Identifier,
            firstToken,
            lastToken
        );
    }

    private beginTokenCheckpoint(): TokenCheckpoint {
        const checkpoint: TokenCheckpoint = {
            offset: this.tokens.offset,
            mutatedTokens: new Map()
        };
        this.tokenCheckpoints.push(checkpoint);
        return checkpoint;
    }

    private restoreTokenCheckpoint(checkpoint: TokenCheckpoint): void {
        this.tokens.offset = checkpoint.offset;
        for (const [index, token] of checkpoint.mutatedTokens) {
            this.tokens.items[index] = token;
        }
        if (this.tokenCheckpoints[this.tokenCheckpoints.length - 1] === checkpoint) {
            this.tokenCheckpoints.pop();
        }
    }

    private commitTokenCheckpoint(checkpoint: TokenCheckpoint): void {
        if (this.tokenCheckpoints[this.tokenCheckpoints.length - 1] === checkpoint) {
            this.tokenCheckpoints.pop();
        }
    }

    private recordTokenMutation(index: number): void {
        const token = this.tokens.items[index];
        if (!token) {
            return;
        }
        for (const checkpoint of this.tokenCheckpoints) {
            if (!checkpoint.mutatedTokens.has(index)) {
                checkpoint.mutatedTokens.set(index, token);
            }
        }
    }

    private consumeGenericCloseAngle(): boolean {
        const token = this.tokens.peek();
        if (token?.type !== "symbol" || ![">", ">>", ">>>"].includes(token.value)) {
            return false;
        }

        if (token.value === ">") {
            this.tokens.skip();
            return true;
        }

        this.recordTokenMutation(this.tokens.offset);
        this.tokens.items[this.tokens.offset] = {
            ...token,
            value: token.value.slice(1),
            range: {
                start: {
                    ...token.range.start,
                    offset: token.range.start.offset + 1,
                    column: token.range.start.column + 1
                },
                end: token.range.end
            }
        };
        return true;
    }

    private parseConditionalTypeAnnotationText(): string {
        const checkType = this.parseUnionTypeAnnotationText();
        const isKeyword = this.tokens.peek();
        if (isKeyword?.type === "identifier" && isKeyword.value === "is") {
            this.tokens.skip();
            return `${checkType} is ${this.parseUnionTypeAnnotationText()}`;
        }
        const extendsKeyword = this.tokens.peek();
        if (extendsKeyword?.type !== "identifier" || extendsKeyword.value !== "extends") {
            return checkType;
        }

        this.tokens.skip();
        const constraintType = this.parseUnionTypeAnnotationText();
        const question = this.tokens.read();
        if (question?.type !== "symbol" || question.value !== "?") {
            this.fail("Expected '?' in conditional type annotation", this.tokenAt(question));
        }
        const trueType = this.parseConditionalTypeAnnotationText();
        const colon = this.tokens.read();
        if (colon?.type !== "symbol" || colon.value !== ":") {
            this.fail("Expected ':' in conditional type annotation", this.tokenAt(colon));
        }
        const falseType = this.parseConditionalTypeAnnotationText();
        return `${checkType} extends ${constraintType} ? ${trueType} : ${falseType}`;
    }

    private parseUnionTypeAnnotationText(): string {
        while (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === "|") {
            this.tokens.skip();
        }
        let typeName = this.parseIntersectionTypeAnnotationText();
        while (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === "|") {
            this.tokens.skip();
            typeName += ` | ${this.parseIntersectionTypeAnnotationText()}`;
        }
        return typeName;
    }

    private parseIntersectionTypeAnnotationText(): string {
        let typeName = this.parsePrimaryTypeAnnotationText();
        while (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === "&") {
            this.tokens.skip();
            typeName += ` & ${this.parsePrimaryTypeAnnotationText()}`;
        }
        return typeName;
    }

    private parsePrimaryTypeAnnotationText(): string {
        const start = this.tokens.peek();

        const templateLiteralType = this.tryParseTemplateLiteralTypeText();
        if (templateLiteralType) {
            return `${templateLiteralType}${this.parseTypeAnnotationSuffixText()}`;
        }

        if (start?.type === "symbol" && start.value === "<") {
            const typeParameters = this.readAngleBracketTypeText();
            const openParen = this.tokens.read();
            if (openParen?.type !== "symbol" || openParen.value !== "(") {
                this.fail("Expected '(' after generic function type parameters", this.tokenAt(openParen));
            }
            const parameterText = this.readParenthesizedTypeText(openParen);
            const arrow = this.tokens.read();
            if (arrow?.type !== "symbol" || arrow.value !== "=>") {
                this.fail("Expected '=>' in function type annotation", this.tokenAt(arrow));
            }
            const returnType = this.parseConditionalTypeAnnotationText();
            return `<${typeParameters}>(${parameterText}) => ${returnType}`;
        }

        if (start?.type === "symbol" && start.value === "(") {
            const openParen = this.tokens.read()!;
            if (this.isFunctionTypeAnnotationStart()) {
                const parameterText = this.readParenthesizedTypeText(openParen);
                const arrow = this.tokens.read();
                if (arrow?.type !== "symbol" || arrow.value !== "=>") {
                    this.fail("Expected '=>' in function type annotation", this.tokenAt(arrow));
                }
                const returnType = this.parseConditionalTypeAnnotationText();
                return `(${parameterText}) => ${returnType}`;
            }

            const innerType = this.parseConditionalTypeAnnotationText();
            const closeParen = this.tokens.read();
            if (closeParen?.type !== "symbol" || closeParen.value !== ")") {
                this.fail("Expected ')' to close type annotation", this.tokenAt(closeParen));
            }
            return `(${innerType})${this.parseTypeAnnotationSuffixText()}`;
        }

        if (start?.type === "symbol" && start.value === "[") {
            this.tokens.skip();
            const elements: string[] = [];
            while (this.tokens.hasMore) {
                if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === "]") {
                    this.tokens.skip();
                    break;
                }
                let elementPrefix = "";
                if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === "...") {
                    this.tokens.skip();
                    elementPrefix = "...";
                }
                let elementType = `${elementPrefix}${this.parseConditionalTypeAnnotationText()}`;
                const optionalLabel = this.tokens.peek();
                if (optionalLabel?.type === "symbol" && optionalLabel.value === "?") {
                    const afterQuestion = this.tokens.items[this.tokens.offset + 1];
                    if (afterQuestion?.type === "symbol" && afterQuestion.value === ":") {
                        this.tokens.skip();
                        this.tokens.skip();
                        elementType += `?: ${this.parseConditionalTypeAnnotationText()}`;
                    } else if (
                        afterQuestion?.type === "symbol" &&
                        (afterQuestion.value === "," || afterQuestion.value === "]")
                    ) {
                        this.tokens.skip();
                        elementType += "?";
                    }
                } else if (optionalLabel?.type === "symbol" && optionalLabel.value === ":") {
                    this.tokens.skip();
                    elementType += `: ${this.parseConditionalTypeAnnotationText()}`;
                }
                elements.push(elementType);
                const separator = this.tokens.peek();
                if (separator?.type === "symbol" && separator.value === ",") {
                    this.tokens.skip();
                    continue;
                }
                if (separator?.type === "symbol" && separator.value === "]") {
                    this.tokens.skip();
                    break;
                }
                this.fail("Expected ',' or ']' in tuple type annotation", this.tokenAt(separator));
            }
            return `[${elements.join(", ")}]${this.parseTypeAnnotationSuffixText()}`;
        }

        if (start?.type === "symbol" && start.value === "{") {
            this.tokens.skip();
            const properties: string[] = [];
            while (this.tokens.hasMore) {
                if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === "}") {
                    this.tokens.skip();
                    break;
                }

                if (this.isMappedTypeMemberStart()) {
                    properties.push(this.parseMappedTypeMemberText());
                    const separator = this.tokens.peek();
                    if (separator?.type === "symbol" && (separator.value === "," || separator.value === ";")) {
                        this.tokens.skip();
                        continue;
                    }
                    if (separator?.type === "symbol" && separator.value === "}") {
                        this.tokens.skip();
                        break;
                    }
                    this.fail("Expected ',', ';', or '}' after mapped type member", this.tokenAt(separator));
                }

                if (this.isOpaqueTypeLiteralMemberStart()) {
                    properties.push(this.parseOpaqueTypeLiteralMemberText());
                    const separator = this.tokens.peek();
                    if (separator?.type === "symbol" && (separator.value === "," || separator.value === ";")) {
                        this.tokens.skip();
                        continue;
                    }
                    if (separator?.type === "symbol" && separator.value === "}") {
                        this.tokens.skip();
                        break;
                    }
                    this.fail("Expected ',', ';', or '}' in type literal", this.tokenAt(separator));
                }

                let readonlyText = "";
                if (
                    this.tokens.peek()?.type === "identifier" &&
                    this.tokens.peek()?.value === "readonly" &&
                    this.peekToken(1) &&
                    ["identifier", "string", "number"].includes(this.peekToken(1)!.type)
                ) {
                    readonlyText = `${this.tokens.read()!.value} `;
                }

                if (this.isTypeLiteralMethodSignatureStart()) {
                    properties.push(`${readonlyText}${this.parseTypeLiteralMethodSignatureText()}`);
                    const separator = this.tokens.peek();
                    if (separator?.type === "symbol" && (separator.value === "," || separator.value === ";")) {
                        this.tokens.skip();
                        continue;
                    }
                    if (separator?.type === "symbol" && separator.value === "}") {
                        this.tokens.skip();
                        break;
                    }
                    this.fail("Expected ',', ';', or '}' in type literal", this.tokenAt(separator));
                }

                const propertyName = this.tokens.read();
                if (!propertyName || !["identifier", "string", "number"].includes(propertyName.type)) {
                    this.fail("Expected property name in type literal", this.tokenAt(propertyName));
                }

                let nameText = `${readonlyText}${typeTokenText(propertyName)}`;
                if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === "?") {
                    this.tokens.skip();
                    nameText += "?";
                }

                const colon = this.tokens.read();
                if (colon?.type !== "symbol" || colon.value !== ":") {
                    this.fail("Expected ':' after type literal property name", this.tokenAt(colon));
                }

                properties.push(`${nameText}: ${this.parseConditionalTypeAnnotationText()}`);
                const separator = this.tokens.peek();
                if (separator?.type === "symbol" && (separator.value === "," || separator.value === ";")) {
                    this.tokens.skip();
                    continue;
                }
                if (separator?.type === "symbol" && separator.value === "}") {
                    this.tokens.skip();
                    break;
                }
                this.fail("Expected ',', ';', or '}' in type literal", this.tokenAt(separator));
            }
            return `{ ${properties.join(", ")} }${this.parseTypeAnnotationSuffixText()}`;
        }

        if (start?.type === "identifier" && start.value === "infer") {
            this.tokens.skip();
            let inferredType = `infer ${this.parsePrimaryTypeAnnotationText()}`;
            if (this.tokens.peek()?.type === "identifier" && this.tokens.peek()?.value === "extends") {
                this.tokens.skip();
                inferredType += ` extends ${this.parseUnionTypeAnnotationText()}`;
            }
            return inferredType;
        }

        if (start?.type === "identifier" && (start.value === "keyof" || start.value === "typeof")) {
            this.tokens.skip();
            const operand = start.value === "typeof"
                ? this.parseTypeQueryOperandText()
                : this.parsePrimaryTypeAnnotationText();
            return `${start.value} ${operand}${this.parseTypeAnnotationSuffixText()}`;
        }

        if (start?.type === "identifier" && start.value === "import") {
            this.tokens.skip();
            const openParen = this.tokens.read();
            if (openParen?.type !== "symbol" || openParen.value !== "(") {
                this.fail("Expected '(' after 'import' in type annotation", this.tokenAt(openParen));
            }
            const importPath = this.tokens.read();
            if (importPath?.type !== "string") {
                this.fail("Expected string literal inside import() type annotation", this.tokenAt(importPath));
            }
            const closeParen = this.tokens.read();
            if (closeParen?.type !== "symbol" || closeParen.value !== ")") {
                this.fail("Expected ')' after import() type annotation", this.tokenAt(closeParen));
            }
            let typeName = `import("${importPath.value}")`;
            while (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === "." && this.peekToken(1)?.type === "identifier") {
                this.tokens.skip();
                typeName += `.${this.tokens.read()!.value}`;
            }
            if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === "<") {
                const argumentsText = this.parseTypeArgumentListText();
                typeName += `<${argumentsText.join(", ")}>`;
            }
            typeName += this.parseTypeAnnotationSuffixText();
            return typeName;
        }

        if (start?.type === "identifier" && start.value === "unique") {
            this.tokens.skip();
            return `unique ${this.parsePrimaryTypeAnnotationText()}`;
        }

        if (start?.type === "identifier" && start.value === "readonly") {
            this.tokens.skip();
            return `readonly ${this.parsePrimaryTypeAnnotationText()}`;
        }

        if (start?.type === "identifier" && start.value === "asserts") {
            this.tokens.skip();
            const assertedTarget = this.parsePrimaryTypeAnnotationText();
            if (this.tokens.peek()?.type === "identifier" && this.tokens.peek()?.value === "is") {
                this.tokens.skip();
                return `asserts ${assertedTarget} is ${this.parseConditionalTypeAnnotationText()}`;
            }
            return `asserts ${assertedTarget}`;
        }

        if (start?.type === "identifier" && (start.value === "abstract" || start.value === "new")) {
            let prefix = "";
            if (start.value === "abstract") {
                this.tokens.skip();
                prefix = "abstract ";
                const newToken = this.tokens.read();
                if (newToken?.type !== "identifier" || newToken.value !== "new") {
                    this.fail("Expected 'new' after 'abstract' in construct signature", this.tokenAt(newToken));
                }
            } else {
                this.tokens.skip();
            }
            let typeParameters = "";
            if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === "<") {
                typeParameters = `<${this.readAngleBracketTypeText()}>`;
            }
            const openParen = this.tokens.read();
            if (openParen?.type !== "symbol" || openParen.value !== "(") {
                this.fail("Expected '(' after construct signature", this.tokenAt(openParen));
            }
            const parameterText = this.readParenthesizedTypeText(openParen);
            const arrow = this.tokens.read();
            if (arrow?.type !== "symbol" || arrow.value !== "=>") {
                this.fail("Expected '=>' in construct signature", this.tokenAt(arrow));
            }
            const returnType = this.parseConditionalTypeAnnotationText();
            return `${prefix}new${typeParameters} (${parameterText}) => ${returnType}`;
        }

        if (start?.type === "symbol" && start.value === "-") {
            this.tokens.skip();
            const literalToken = this.tokens.read();
            if (!literalToken || literalToken.type !== "number") {
                this.fail("Expected numeric literal after '-'", this.tokenAt(literalToken));
            }
            return `-${literalToken.value}${this.parseTypeAnnotationSuffixText()}`;
        }

        const token = this.tokens.read();
        if (!token || !["identifier", "string", "number"].includes(token.type)) {
            this.fail("Expected type identifier", this.tokenAt(token));
        }

        let typeName = typeTokenText(token);
        while (
            token.type === "identifier" &&
            this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === "." &&
            this.peekToken(1)?.type === "identifier"
        ) {
            this.tokens.skip();
            typeName += `.${this.tokens.read()!.value}`;
        }
        if (token.type === "identifier" && this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === "<") {
            const argumentsText = this.parseTypeArgumentListText();
            typeName += `<${argumentsText.join(", ")}>`;
        }

        typeName += this.parseTypeAnnotationSuffixText();
        return typeName;
    }

    private tryParseTemplateLiteralTypeText(): string | null {
        const checkpoint = this.beginTokenCheckpoint();
        const first = this.tokens.peek();
        if (first?.type !== "string") {
            this.restoreTokenCheckpoint(checkpoint);
            return null;
        }

        const firstPlus = this.peekToken(1);
        const firstInterpolationStart = this.peekToken(2);
        if (firstPlus?.type !== "symbol" || firstPlus.value !== "+" || !firstInterpolationStart) {
            this.restoreTokenCheckpoint(checkpoint);
            return null;
        }

        let text = `\`${first.value}`;
        this.tokens.skip();
        let sawTemplateSegment = false;

        while (this.tokens.hasMore) {
            const plus = this.tokens.peek();
            if (plus?.type !== "symbol" || plus.value !== "+") {
                break;
            }
            this.tokens.skip();

            const next = this.tokens.peek();
            if (next?.type === "symbol" && next.value === "(") {
                this.tokens.skip();
                text += "${";
                text += this.parseConditionalTypeAnnotationText();
                const closeParen = this.tokens.read();
                if (closeParen?.type !== "symbol" || closeParen.value !== ")") {
                    this.restoreTokenCheckpoint(checkpoint);
                    return null;
                }
                text += "}";
                sawTemplateSegment = true;
                continue;
            }

            if (next?.type === "string") {
                text += next.value;
                this.tokens.skip();
                sawTemplateSegment = true;
                continue;
            }

            this.restoreTokenCheckpoint(checkpoint);
            return null;
        }

        if (!sawTemplateSegment) {
            this.restoreTokenCheckpoint(checkpoint);
            return null;
        }

        text += "`";
        this.commitTokenCheckpoint(checkpoint);
        return text;
    }

    private isMappedTypeMemberStart(): boolean {
        const first = this.peekToken(0);
        if (first?.type === "symbol" && first.value === "[") {
            const second = this.peekToken(1);
            const third = this.peekToken(2);
            return second?.type === "identifier" && third?.type === "identifier" && third.value === "in";
        }
        if (first?.type === "identifier" && first.value === "readonly") {
            return this.peekToken(1)?.type === "symbol" && this.peekToken(1)?.value === "[";
        }
        return (
            first?.type === "symbol" &&
            (first.value === "+" || first.value === "-") &&
            this.peekToken(1)?.type === "identifier" &&
            this.peekToken(1)?.value === "readonly" &&
            this.peekToken(2)?.type === "symbol" &&
            this.peekToken(2)?.value === "["
        );
    }

    private parseMappedTypeMemberText(): string {
        let readonlyModifier = "";
        const first = this.tokens.peek();
        if (first?.type === "symbol" && (first.value === "+" || first.value === "-")) {
            readonlyModifier = this.tokens.read()!.value;
        }
        if (this.tokens.peek()?.type === "identifier" && this.tokens.peek()?.value === "readonly") {
            this.tokens.skip();
            readonlyModifier += "readonly ";
        }

        const openBracket = this.tokens.read();
        const parameter = this.tokens.read();
        if (parameter?.type !== "identifier") {
            this.fail("Expected type parameter name in mapped type", this.tokenAt(parameter ?? openBracket));
        }
        const inKeyword = this.tokens.read();
        if (inKeyword?.type !== "identifier" || inKeyword.value !== "in") {
            this.fail("Expected 'in' in mapped type", this.tokenAt(inKeyword));
        }
        const keyType = this.parseConditionalTypeAnnotationText();
        let remappedKey = "";
        if (this.tokens.peek()?.type === "identifier" && this.tokens.peek()?.value === "as") {
            this.tokens.skip();
            remappedKey = ` as ${this.parseConditionalTypeAnnotationText()}`;
        }
        const closeBracket = this.tokens.read();
        if (closeBracket?.type !== "symbol" || closeBracket.value !== "]") {
            this.fail("Expected ']' after mapped type key", this.tokenAt(closeBracket));
        }
        let optionalModifier = "";
        if (this.tokens.peek()?.type === "symbol" && (this.tokens.peek()?.value === "+" || this.tokens.peek()?.value === "-")) {
            optionalModifier = this.tokens.read()!.value;
        }
        if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === "?") {
            this.tokens.skip();
            optionalModifier += "?";
        } else if (optionalModifier !== "") {
            this.fail("Expected '?' after mapped type optional modifier", this.tokenAt(this.tokens.peek()));
        }
        const colon = this.tokens.read();
        if (colon?.type !== "symbol" || colon.value !== ":") {
            this.fail("Expected ':' after mapped type key", this.tokenAt(colon));
        }
        const valueType = this.parseConditionalTypeAnnotationText();
        return `${readonlyModifier}[${parameter.value} in ${keyType}${remappedKey}]${optionalModifier}: ${valueType}`;
    }

    private parseTypeAnnotationSuffixText(): string {
        let suffix = "";
        while (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === "[") {
            this.tokens.skip();
            if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === "]") {
                this.tokens.skip();
                suffix += "[]";
                continue;
            }

            const indexType = this.parseConditionalTypeAnnotationText();
            const close = this.tokens.read();
            if (close?.type !== "symbol" || close.value !== "]") {
                this.fail("Expected ']' to close indexed access type", this.tokenAt(close));
            }
            suffix += `[${indexType}]`;
        }
        if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === "?") {
            const nextToken = this.peekToken(1);
            const canEndOptionalType =
                !nextToken ||
                nextToken.type === "eof" ||
                (nextToken.type === "symbol" && ["|", "&", ")", "]", "}", ",", ";", "="].includes(nextToken.value));
            if (canEndOptionalType) {
                this.tokens.skip();
                suffix += "?";
            }
        }
        return suffix;
    }

    private parseTypeQueryOperandText(): string {
        const first = this.tokens.read();
        if (!first) {
            this.fail("Expected identifier after 'typeof' in type annotation", this.tokenAt(first));
        }

        let operand = "";
        if (first.type === "identifier" && first.value !== "import") {
            operand = first.value;
        } else if (first.type === "identifier" && first.value === "import") {
            operand = "import";
            const openParen = this.tokens.read();
            if (!openParen || openParen.type !== "symbol" || openParen.value !== "(") {
                this.fail("Expected '(' after 'import' in type query", this.tokenAt(openParen));
            }
            operand += "(";
            const moduleName = this.tokens.read();
            if (!moduleName || moduleName.type !== "string") {
                this.fail("Expected module string in 'import(...)' type query", this.tokenAt(moduleName));
            }
            operand += JSON.stringify(moduleName.value);
            const closeParen = this.tokens.read();
            if (!closeParen || closeParen.type !== "symbol" || closeParen.value !== ")") {
                this.fail("Expected ')' after module string in 'import(...)' type query", this.tokenAt(closeParen));
            }
            operand += ")";
        } else {
            this.fail("Expected identifier after 'typeof' in type annotation", this.tokenAt(first));
        }

        while (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === ".") {
            this.tokens.skip();
            const property = this.tokens.read();
            if (!property || property.type !== "identifier") {
                this.fail("Expected property name in 'typeof' type query", this.tokenAt(property));
            }
            operand += `.${property.value}`;
        }
        return operand;
    }

    private isFunctionTypeAnnotationStart(): boolean {
        let depth = 1;
        for (let offset = 0; this.peekToken(offset); offset += 1) {
            const token = this.peekToken(offset);
            if (!token) {
                return false;
            }
            if (token.type === "symbol" && token.value === "(") {
                depth += 1;
            } else if (token.type === "symbol" && token.value === ")") {
                depth -= 1;
                if (depth === 0) {
                    return this.peekToken(offset + 1)?.type === "symbol" && this.peekToken(offset + 1)?.value === "=>";
                }
            }
        }
        return false;
    }

    private readParenthesizedTypeText(openParen: Token): string {
        let text = "";
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
                if (depth === 0) {
                    break;
                }
            }
            text += typeTokenText(token);
        }
        if (depth !== 0) {
            this.fail("Expected ')' to close function type annotation", this.tokenAt(openParen));
        }
        return text;
    }

    private readAngleBracketTypeText(): string {
        const open = this.tokens.read();
        if (open?.type !== "symbol" || open.value !== "<") {
            this.fail("Expected '<' to start generic type text", this.tokenAt(open));
        }
        let text = "";
        let depth = 1;
        while (this.tokens.hasMore && depth > 0) {
            const token = this.tokens.read();
            if (!token) {
                break;
            }
            if (token.type === "symbol" && token.value === "<") {
                depth += 1;
                text += typeTokenText(token);
                continue;
            }
            if (token.type === "symbol" && [">", ">>", ">>>"].includes(token.value)) {
                let remaining = token.value.length;
                while (remaining > 0 && depth > 0) {
                    depth -= 1;
                    remaining -= 1;
                    if (depth > 0) {
                        text += ">";
                    }
                }
                if (remaining > 0) {
                    this.tokens.items.splice(this.tokens.offset, 0, { ...token, value: ">".repeat(remaining) });
                }
                continue;
            }
            text += typeTokenText(token);
        }
        if (depth !== 0) {
            this.fail("Expected '>' to close generic type text", this.tokenAt(open));
        }
        return text;
    }

    private isOpaqueTypeLiteralMemberStart(): boolean {
        const token = this.tokens.peek();
        const next = this.peekToken(1);
        if (!token) {
            return false;
        }
        if (token.type === "symbol" && (token.value === "[" || token.value === "<")) {
            return true;
        }
        if (token.type === "identifier" && token.value === "readonly" && next?.type === "symbol" && next.value === "[") {
            return true;
        }
        return false;
    }

    private isTypeLiteralMethodSignatureStart(): boolean {
        let offset = 0;
        const name = this.peekToken(offset);
        if (!name || !["identifier", "string", "number"].includes(name.type)) {
            return false;
        }
        offset += 1;
        if (this.peekToken(offset)?.type === "symbol" && this.peekToken(offset)?.value === "?") {
            offset += 1;
        }
        if (this.peekToken(offset)?.type === "symbol" && this.peekToken(offset)?.value === "<") {
            return true;
        }
        return this.peekToken(offset)?.type === "symbol" && this.peekToken(offset)?.value === "(";
    }

    private parseTypeLiteralMethodSignatureText(): string {
        const nameToken = this.tokens.read();
        if (!nameToken || !["identifier", "string", "number"].includes(nameToken.type)) {
            this.fail("Expected method name in type literal", this.tokenAt(nameToken));
        }

        let text = typeTokenText(nameToken);
        if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === "?") {
            this.tokens.skip();
            text += "?";
        }
        if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === "<") {
            text += `<${this.readAngleBracketTypeText()}>`;
        }
        const openParen = this.tokens.read();
        if (openParen?.type !== "symbol" || openParen.value !== "(") {
            this.fail("Expected '(' after type literal method name", this.tokenAt(openParen));
        }
        text += `(${this.readParenthesizedTypeText(openParen)})`;
        if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === ":") {
            this.tokens.skip();
            text += `: ${this.parseConditionalTypeAnnotationText()}`;
        }
        return text;
    }

    private parseOpaqueTypeLiteralMemberText(): string {
        let text = "";
        let parenDepth = 0;
        let bracketDepth = 0;
        let braceDepth = 0;
        let angleDepth = 0;
        while (this.tokens.hasMore) {
            const token = this.tokens.peek();
            if (!token) {
                break;
            }
            if (token.type === "symbol") {
                if (token.value === "(") parenDepth += 1;
                else if (token.value === ")") parenDepth -= 1;
                else if (token.value === "[") bracketDepth += 1;
                else if (token.value === "]") bracketDepth -= 1;
                else if (token.value === "{") braceDepth += 1;
                else if (token.value === "}") {
                    if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0 && angleDepth === 0) {
                        break;
                    }
                    braceDepth -= 1;
                } else if (token.value === "<") angleDepth += 1;
                else if (token.value === ">") angleDepth = Math.max(0, angleDepth - 1);
                else if ((token.value === ";" || token.value === ",") && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0 && angleDepth === 0) {
                    break;
                }
            }
            text += typeTokenText(this.tokens.read()!);
        }
        return text.trim();
    }

    private parseTypeArgumentListText(): string[] {
        const open = this.tokens.read();
        if (open?.type !== "symbol" || open.value !== "<") {
            this.fail("Expected '<' to start type argument list", this.tokenAt(open));
        }

        const args: string[] = [];
        while (this.tokens.hasMore) {
            args.push(this.parseConditionalTypeAnnotationText());
            const separator = this.tokens.peek();
            if (separator?.type === "symbol" && separator.value === ",") {
                this.tokens.skip();
                continue;
            }
            if (this.consumeGenericCloseAngle()) {
                break;
            }
            this.fail("Expected ',' or '>' in type argument list", this.tokenAt(separator));
        }
        return args;
    }

    private fail(message: string, token?: Token, recoveryHint?: RecoveryHint): never {
        throw new ParseError(message, token, recoveryHint);
    }

    private canRecoverMissingMemberIdentifier(operator: Token, nextToken?: Token): boolean {
        if (!nextToken || nextToken.type === "eof") {
            return false;
        }
        if (hasLineBreakBetween(operator, nextToken)) {
            return true;
        }
        return nextToken.type === "symbol" && (nextToken.value === "}" || nextToken.value === ";");
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
            this.isFunctionDeclarationKeyword(second.value)
        );
    }

    private isDeclareTypeAliasStart(): boolean {
        const first = this.peekToken(0);
        const second = this.peekToken(1);
        return (
            first?.type === "identifier" &&
            first.value === "declare" &&
            second?.type === "identifier" &&
            second.value === "type"
        );
    }

    private isTypeAliasStatementStart(): boolean {
        const first = this.peekToken(0);
        const second = this.peekToken(1);
        return (
            first?.type === "identifier" &&
            first.value === "type" &&
            second?.type === "identifier"
        );
    }

    private isDeclareVariableStart(): boolean {
        const first = this.peekToken(0);
        const second = this.peekToken(1);
        return (
            first?.type === "identifier" &&
            first.value === "declare" &&
            second?.type === "identifier" &&
            this.isVariableDeclarationKeyword(second.value) &&
            !(second.value === "const" && this.peekToken(2)?.type === "identifier" && this.peekToken(2)?.value === "enum")
        );
    }

    private isAsyncFunctionDeclarationStart(): boolean {
        const first = this.peekToken(0);
        const second = this.peekToken(1);
        return (
            first?.type === "identifier" &&
            first.value === "async" &&
            second?.type === "identifier" &&
            this.isFunctionDeclarationKeyword(second.value)
        );
    }

    private isSyncFunctionDeclarationStart(): boolean {
        const first = this.peekToken(0);
        const second = this.peekToken(1);
        return (
            first?.type === "identifier" &&
            first.value === "sync" &&
            second?.type === "identifier" &&
            this.isFunctionDeclarationKeyword(second.value)
        );
    }

    private isDeclareClassStart(): boolean {
        const first = this.peekToken(0);
        const second = this.peekToken(1);
        return (
            first?.type === "identifier" &&
            first.value === "declare" &&
            second?.type === "identifier" &&
            (second.value === "class" ||
                (second.value === "abstract" && this.peekToken(2)?.type === "identifier" && this.peekToken(2)?.value === "class"))
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
            (second.value === "namespace" || second.value === "module" || second.value === "global")
        );
    }

    private isConstEnumStart(): boolean {
        const first = this.peekToken(0);
        const second = this.peekToken(1);
        return (
            first?.type === "identifier" &&
            first.value === "const" &&
            second?.type === "identifier" &&
            second.value === "enum"
        );
    }

    private isDeclareEnumStart(): boolean {
        const first = this.peekToken(0);
        const second = this.peekToken(1);
        const third = this.peekToken(2);
        return (
            first?.type === "identifier" &&
            first.value === "declare" &&
            ((second?.type === "identifier" && second.value === "enum") ||
                (second?.type === "identifier" && second.value === "const" && third?.type === "identifier" && third.value === "enum"))
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

    private isLabeledStatementStart(): boolean {
        const first = this.peekToken(0);
        const second = this.peekToken(1);
        return first?.type === "identifier" && second?.type === "symbol" && second.value === ":";
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

    private consumeStatementSeparator(
        context: "file" | "block",
        previousToken: Token | undefined
    ): void {
        if (!this.tokens.hasMore) {
            return;
        }

        const next = this.tokens.peek();
        if (context === "file" && isEofToken(next)) {
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

        if (hasLineBreakBetween(previousToken, next)) {
            return;
        }

        if (
            previousToken?.type === "symbol" &&
            previousToken.value === "}" &&
            isLikelyStatementStart(next)
        ) {
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

        if (hasLineBreakBetween(previousToken, next)) {
            return;
        }

        this.fail("Expected ';', newline, 'case', 'default', or '}' between switch statements", next, "switch");
    }

    private buildBinary(operator: BinaryOperator, operatorToken: Token, left: Expr, right: Expr): BinaryExpression {
        const binary = this.attachNodeBounds({
            kind: "BinaryExpression",
            operator,
            left,
            right
        } as BinaryExpression, left.firstToken, right.lastToken ?? this.getLastReadToken());
        return this.attachNonEnumerableToken(binary, "operatorToken", operatorToken);
    }

    private binaryOperatorFromToken(token: Token | undefined): InfixOperator | undefined {
        if (!token) {
            return undefined;
        }

        if (token.type === "symbol") {
            const candidate = token.value as InfixOperator;
            return candidate in BINARY_OPERATOR_INFO ? candidate : undefined;
        }

        if (token.type === "identifier" && (token.value === "in" || token.value === "is" || token.value === "instanceof")) {
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

            if (operator === "..." || operator === "..<") {
                left = this.attachNodeBounds({
                    kind: "RangeExpression",
                    start: left,
                    end: right,
                    exclusive: operator === "..<"
                } as RangeExpression, left.firstToken, right.lastToken ?? this.getLastReadToken());
                continue;
            }

            left = this.buildBinary(operator, token as Token, left, right);
        }

        return left;
    }

    private parseArrayLiteral(): ArrayLiteral {
        const startToken = this.getLastReadToken();
        const elements: ArrayLiteral["elements"] = [];

        while (this.tokens.hasMore) {
            const token = this.tokens.peek();
            if (token?.type === "symbol" && token.value === "]") {
                this.tokens.skip();
                return this.withNodeBounds(startToken, () => {
                    return {
                        kind: "ArrayLiteral",
                        elements
                    } as ArrayLiteral;
                });
            }

            if (token?.type === "symbol" && token.value === ",") {
                const comma = this.tokens.read();
                elements.push(this.attachNodeBounds({ kind: "ArrayHole" }, comma, comma));
                continue;
            }

            elements.push(this.parseAssignment());

            const separator = this.tokens.peek();
            if (separator?.type === "symbol" && separator.value === ",") {
                this.tokens.skip();
                if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === "]") {
                    continue;
                }
                continue;
            }

            if (separator?.type === "symbol" && separator.value === "]") {
                continue;
            }

            break;
        }

        this.fail("Expected ',' or ']' in array literal", this.tokenAt());
    }

    private parseObjectLiteral(): ObjectLiteral {
        const startToken = this.getLastReadToken();
        if (!(startToken?.type === "symbol" && startToken.value === "{")) {
            this.fail("Expected '{' to start object literal", this.tokenAt(startToken));
        }
        return this.parseObjectLiteralFromConsumedOpen(startToken);
    }

    private parseObjectLiteralFromConsumedOpen(startToken: Token): ObjectLiteral {
        const properties: ObjectLiteralProperty[] = [];
        let trailingComma = false;

        if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === "}") {
            this.tokens.skip();
            return this.withNodeBounds(startToken, () => {
                return {
                    kind: "ObjectLiteral",
                    properties,
                    ...(trailingComma ? { trailingComma: true } : {})
                } as ObjectLiteral;
            });
        }

        while (this.tokens.hasMore) {
            const next = this.tokens.peek();
            if (next?.type === "symbol" && next.value === "}") {
                this.tokens.skip();
                return this.withNodeBounds(startToken, () => {
                    return {
                        kind: "ObjectLiteral",
                        properties,
                        ...(trailingComma ? { trailingComma: true } : {})
                    } as ObjectLiteral;
                });
            }

            if (next?.type === "symbol" && next.value === "...") {
                const spreadToken = this.tokens.read()!;
                const argument = this.parseAssignment();
                properties.push(
                    this.attachNodeBounds(
                        {
                            kind: "ObjectSpreadProperty",
                            argument
                        } as ObjectSpreadProperty,
                        spreadToken,
                        argument.lastToken ?? this.getLastReadToken() ?? spreadToken
                    )
                );
            } else {
                const objectMemberStart = this.tokens.offset;
                let accessorPrefix: "get" | "set" | undefined;
                let asyncModifier = false;
                let syncModifier = false;
                if (
                    next?.type === "identifier" &&
                    (next.value === "get" || next.value === "set") &&
                    this.peekToken(1) &&
                    ["identifier", "string", "number"].includes(this.peekToken(1)!.type)
                ) {
                    accessorPrefix = next.value as "get" | "set";
                    this.tokens.skip();
                } else if (
                    next?.type === "identifier" &&
                    (next.value === "async" || next.value === "sync") &&
                    this.peekToken(1) &&
                    ["identifier", "string", "number"].includes(this.peekToken(1)!.type)
                ) {
                    asyncModifier = next.value === "async";
                    syncModifier = next.value === "sync";
                    this.tokens.skip();
                }

                const { key, computed } = this.parseObjectLiteralKey();
                let separator = this.tokens.peek();

                if (!computed && key.kind === "Identifier" && (
                    separator?.type === "symbol" && (separator.value === "," || separator.value === "}")
                )) {
                    properties.push(
                        this.attachNodeBounds(
                            {
                                kind: "ObjectProperty",
                                key,
                                value: this.attachNodeBounds(
                                    { kind: "Identifier", name: (key as Identifier).name } as Identifier,
                                    key.firstToken,
                                    key.lastToken
                                ),
                                shorthand: true
                            } as ObjectProperty,
                            key.firstToken,
                            key.lastToken
                        )
                    );
                } else {
                    let methodTypeParameters: TypeParameter[] | undefined;
                    if (separator?.type === "symbol" && separator.value === "<") {
                        methodTypeParameters = this.parseTypeParameterList();
                        separator = this.tokens.peek();
                    }

                    if (separator?.type === "symbol" && separator.value === "(") {
                    const openParen = this.tokens.read();
                    const parameters = this.parseFunctionParameters();
                    const closeParen = this.tokens.read();
                    if (openParen?.type !== "symbol" || openParen.value !== "(") {
                        this.fail("Expected '(' before object method parameters", this.tokenAt(openParen));
                    }
                    if (closeParen?.type !== "symbol" || closeParen.value !== ")") {
                        this.fail("Expected ')' after object method parameters", this.tokenAt(closeParen));
                    }
                    let returnType: Identifier | undefined;
                    if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === ":") {
                        this.tokens.skip();
                        returnType = this.parseTypeAnnotationNode();
                    }
                    const body = this.parseBlockStatement();
                    const value: FunctionExpression = {
                        kind: "FunctionExpression",
                        ...(asyncModifier ? { async: true } : {}),
                        ...(syncModifier ? { sync: true } : {}),
                        parameters,
                        body
                    };
                    if (methodTypeParameters && methodTypeParameters.length > 0) {
                        value.typeParameters = methodTypeParameters;
                    }
                    if (!computed && key.kind === "Identifier") {
                        value.name = this.attachNodeBounds(
                            { kind: "Identifier", name: (key as Identifier).name } as Identifier,
                            key.firstToken,
                            key.lastToken
                        );
                    }
                    if (returnType) {
                        value.returnType = returnType;
                    }
                    properties.push(
                        this.attachNodeBounds(
                            {
                                kind: "ObjectProperty",
                                key,
                                value: this.attachNodeBounds(value, key.firstToken, body.lastToken ?? this.getLastReadToken() ?? key.lastToken ?? key.firstToken),
                                method: true,
                                ...(computed ? { computed: true } : {})
                            } as ObjectProperty,
                            key.firstToken,
                            body.lastToken ?? this.getLastReadToken() ?? key.lastToken ?? key.firstToken
                        )
                    );
                    } else {
                    if (accessorPrefix) {
                        this.tokens.offset = objectMemberStart;
                    }
                    const colon = this.tokens.read();
                    if (colon?.type !== "symbol" || colon.value !== ":") {
                        this.fail("Expected ':' after object key", colon);
                    }

                    const value = this.parseAssignment();
                    properties.push(
                        this.attachNodeBounds(
                            {
                                kind: "ObjectProperty",
                                key,
                                value,
                                ...(computed ? { computed: true } : {})
                            } as ObjectProperty,
                            key.firstToken,
                            this.getLastReadToken() ?? key.lastToken ?? key.firstToken
                        )
                    );
                    }
                }
            }

            const separator = this.tokens.peek();
            if (separator?.type === "symbol" && separator.value === ",") {
                this.tokens.skip();
                trailingComma = this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === "}";
                continue;
            }

            if (separator?.type === "symbol" && separator.value === "}") {
                this.tokens.skip();
                return this.withNodeBounds(startToken, () => {
                    return {
                        kind: "ObjectLiteral",
                        properties,
                        ...(trailingComma ? { trailingComma: true } : {})
                    } as ObjectLiteral;
                });
            }

            break;
        }

        this.fail("Expected ',' or '}' in object literal", this.tokenAt());
    }

    private parseObjectLiteralKey(): { key: Expr; computed: boolean } {
        const token = this.tokens.read();

        if (token?.type === "symbol" && token.value === "[") {
            const key = this.parseExpressionOrThrow();
            const close = this.tokens.read();
            if (close?.type !== "symbol" || close.value !== "]") {
                this.fail("Expected ']' after computed object key", this.tokenAt(close));
            }
            return { key, computed: true };
        }

        if (token?.type === "identifier") {
            return { key: this.buildIdentifierFromToken(token), computed: false };
        }

        if (token?.type === "string") {
            return {
                key: this.attachNodeBounds({ kind: "StringLiteral", value: token.value } as StringLiteral, token, token),
                computed: false
            };
        }

        if (token?.type === "number") {
            const normalizedNumberText = token.value.replace(/_/g, "");
            const numericValue = Number(normalizedNumberText);
            if (!Number.isFinite(numericValue) || normalizedNumberText.endsWith("n") || normalizedNumberText.endsWith("N") || normalizedNumberText.endsWith("L")) {
                this.fail("Expected identifier, string, number, or computed key in object literal", this.tokenAt(token));
            }
            const key = normalizedNumberText.includes(".") || normalizedNumberText.includes("e") || normalizedNumberText.includes("E")
                ? this.attachNodeBounds({ kind: "FloatLiteral", value: numericValue } as FloatLiteral, token, token)
                : this.attachNodeBounds({ kind: "IntLiteral", value: numericValue } as IntLiteral, token, token);
            return { key, computed: false };
        }

        this.fail("Expected identifier, string, number, or computed key in object literal", this.tokenAt(token));
    }

    private parseFunctionExpression(functionKeyword: Token, async: boolean = false, sync: boolean = false): FunctionExpression {
        let generator = false;
        if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === "*") {
            this.tokens.skip();
            generator = true;
        }

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
        if (async) {
            expression.async = true;
        }
        if (sync) {
            expression.sync = true;
        }
        if (generator) {
            expression.generator = true;
        }
        if (name) {
            expression.name = name;
        }
        this.attachNonEnumerableToken(expression, "parametersCloseParen", closeParen);
        if (returnType) {
            expression.returnType = returnType;
        }
        return this.attachNodeBounds(
            expression,
            functionKeyword,
            body.lastToken ?? this.getLastReadToken() ?? functionKeyword
        );
    }

    private parseClassLike(options: {
        declared?: boolean;
        expression?: boolean;
        classKeyword?: Token;
    } = {}): ClassStatement | ClassExpression {
        const declared = options.declared ?? false;
        const expression = options.expression ?? false;
        let classKeyword = options.classKeyword ?? this.tokens.read();
        let isAbstractClass = false;
        const startToken = classKeyword;
        if (!options.classKeyword && classKeyword?.type === "identifier" && classKeyword.value === "abstract") {
            isAbstractClass = true;
            classKeyword = this.tokens.read();
        }
        if (classKeyword?.type !== "identifier" || classKeyword.value !== "class") {
            this.fail("Expected class declaration statement", this.tokenAt(classKeyword));
        }

        let className: Identifier | undefined;
        const classNameToken = this.tokens.peek();
        if (
            classNameToken?.type === "identifier" &&
            classNameToken.value !== "extends" &&
            classNameToken.value !== "implements"
        ) {
            this.tokens.skip();
            className = this.buildIdentifierFromToken(classNameToken);
        } else if (!expression) {
            this.fail("Expected class name after 'class'", this.tokenAt(classNameToken));
        }

        const typeParameters = this.parseTypeParameterList();

        let primaryConstructorParameters: ClassPrimaryConstructorParameter[] | undefined;
        if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === "(") {
            if (this.language !== "vexa") {
                this.fail("Class primary constructor syntax is only available in VexaScript mode", this.tokenAt());
            }

            this.tokens.skip();
            primaryConstructorParameters = this.parseClassPrimaryConstructorParameters();

            const closeParen = this.tokens.read();
            if (closeParen?.type !== "symbol" || closeParen.value !== ")") {
                this.fail("Expected ')' after class primary constructor parameters", this.tokenAt(closeParen));
            }
        }

        let extendsType: Identifier | undefined;
        let implementsTypes: Identifier[] | undefined;
        const classDelegates: ClassDelegate[] = [];

        if (this.language === "vexa" && this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === ":") {
            this.tokens.skip();
            const colonTypes: Identifier[] = [];
            while (this.tokens.hasMore) {
                const typeAnnotation = this.parseTypeAnnotationNode();
                if (this.tokens.peek()?.type === "identifier" && this.tokens.peek()?.value === "by") {
                    const byToken = this.tokens.read()!;
                    const delegateExpression = this.parseClassDelegateExpression();
                    classDelegates.push(this.attachNodeBounds({
                        kind: "ClassDelegate",
                        typeAnnotation,
                        expression: delegateExpression
                    } as ClassDelegate, typeAnnotation.firstToken, delegateExpression.lastToken ?? this.getLastReadToken() ?? byToken));
                }
                colonTypes.push(typeAnnotation);
                const separator = this.tokens.peek();
                if (separator?.type === "symbol" && separator.value === ",") {
                    this.tokens.skip();
                    continue;
                }
                break;
            }
            if (colonTypes.length > 0) {
                extendsType = colonTypes[0];
                if (colonTypes.length > 1) {
                    implementsTypes = colonTypes.slice(1);
                }
            }
        }

        // Parse any number of `extends`/`implements` clauses, in any order, so
        // the input stays well-formed even when it has surplus clauses. Only the
        // first `extends` and the first `implements` are kept as the canonical
        // heritage; the rest are recorded as extras and flagged semantically.
        const extraExtendsTypes: Identifier[] = [];
        const extraImplementsTypes: Identifier[] = [];
        while (
            this.tokens.peek()?.type === "identifier" &&
            (this.tokens.peek()?.value === "extends" || this.tokens.peek()?.value === "implements")
        ) {
            const keyword = this.tokens.read()!.value;
            if (keyword === "extends") {
                const typeAnnotation = this.parseHeritageTypeNode();
                if (extendsType === undefined) {
                    extendsType = typeAnnotation;
                } else {
                    extraExtendsTypes.push(typeAnnotation);
                }
                continue;
            }
            const clauseTypes: Identifier[] = [];
            while (this.tokens.hasMore) {
                const typeAnnotation = this.parseHeritageTypeNode();
                if (this.tokens.peek()?.type === "identifier" && this.tokens.peek()?.value === "by") {
                    const byToken = this.tokens.read()!;
                    const delegateExpression = this.parseClassDelegateExpression();
                    classDelegates.push(this.attachNodeBounds({
                        kind: "ClassDelegate",
                        typeAnnotation,
                        expression: delegateExpression
                    } as ClassDelegate, typeAnnotation.firstToken, delegateExpression.lastToken ?? this.getLastReadToken() ?? byToken));
                }
                clauseTypes.push(typeAnnotation);

                const separator = this.tokens.peek();
                if (separator?.type === "symbol" && separator.value === ",") {
                    this.tokens.skip();
                    continue;
                }
                break;
            }
            if (implementsTypes === undefined || implementsTypes.length === 0) {
                implementsTypes = clauseTypes;
            } else {
                extraImplementsTypes.push(...clauseTypes);
            }
        }

        const buildClassLike = (members: ClassMember[]): ClassStatement | ClassExpression => {
            const classLike = expression
                ? { kind: "ClassExpression", members } as ClassExpression
                : { kind: "ClassStatement", members } as ClassStatement;
            if (declared) {
                (classLike as ClassStatement).declared = true;
            }
            if (isAbstractClass) {
                classLike.abstract = true;
            }
            if (className) {
                classLike.name = className;
            }
            if (typeParameters.length > 0) {
                classLike.typeParameters = typeParameters;
            }
            if (extendsType) {
                classLike.extendsType = extendsType;
            }
            if (implementsTypes && implementsTypes.length > 0) {
                classLike.implementsTypes = implementsTypes;
            }
            if (extraExtendsTypes.length > 0) {
                classLike.extraExtendsTypes = extraExtendsTypes;
            }
            if (extraImplementsTypes.length > 0) {
                classLike.extraImplementsTypes = extraImplementsTypes;
            }
            if (classDelegates.length > 0) {
                classLike.classDelegates = classDelegates;
            }
            if (primaryConstructorParameters && primaryConstructorParameters.length > 0) {
                classLike.primaryConstructorParameters = primaryConstructorParameters;
            }
            return classLike;
        };

        const openBrace = this.tokens.peek();
        if (openBrace?.type !== "symbol" || openBrace.value !== "{") {
            if (this.language === "vexa" && !expression) {
                return this.attachNodeBounds(buildClassLike([]), startToken, this.getLastReadToken() ?? classKeyword);
            }

            this.fail("Expected '{' to start class body", this.tokenAt(openBrace));
        }
        this.tokens.skip();

        const members: ClassMember[] = [];
        while (this.tokens.hasMore) {
            const token = this.tokens.peek();
            if (isEofToken(token)) {
                this.fail("Expected '}' to close class body", this.tokenAt(openBrace), "block");
            }
            if (token?.type === "symbol" && token.value === "}") {
                this.tokens.skip();
                return this.attachNodeBounds(buildClassLike(members), startToken, this.getLastReadToken() ?? classKeyword);
            }

            if (token?.type === "symbol" && token.value === ";") {
                this.tokens.skip();
                continue;
            }

            const parsedMembers = this.parseClassMember(declared);
            members.push(...parsedMembers);
            this.consumeStatementSeparator("block", this.getLastReadToken());
        }

        this.fail("Expected '}' to close class body", this.tokenAt(openBrace), "block");
    }

    private parseClassExpression(classKeyword: Token): ClassExpression {
        return this.parseClassLike({ expression: true, classKeyword }) as ClassExpression;
    }

    private parseArrowFunctionBody(): Expr | BlockStatement {
        const maybeBlock = this.tokens.peek();
        if (maybeBlock?.type === "symbol" && maybeBlock.value === "{") {
            return this.parseBlockStatement();
        }
        return this.parseAssignment();
    }

    private parseTailLambdaArgument(): ArrowFunctionExpression {
        return this.parseBraceLambdaExpression();
    }

    private parseBraceLambdaExpression(implicitParameterName: string | null = "it"): ArrowFunctionExpression {
        const openBrace = this.tokens.peek();
        if (!(openBrace?.type === "symbol" && openBrace.value === "{")) {
            this.fail("Expected '{' to start tail lambda", this.tokenAt(openBrace));
        }
        this.tokens.skip();
        return this.parseBraceLambdaExpressionFromConsumedOpen(openBrace, implicitParameterName);
    }

    private parseBraceLambdaExpressionFromConsumedOpen(openBrace: Token, implicitParameterName: string | null = "it"): ArrowFunctionExpression {
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

        const statements: Statement[] = [];
        while (this.tokens.hasMore) {
            const token = this.tokens.peek();
            if (isEofToken(token)) {
                this.fail("Expected '}' to close tail lambda", this.tokenAt(openBrace), "block");
            }

            if (token?.type === "symbol" && token.value === "}") {
                this.tokens.skip();
                break;
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

        const blockStatements = this.applyImplicitTailLambdaReturn(statements);
        const block = this.attachNodeBounds(
            { kind: "BlockStatement", body: blockStatements } as BlockStatement,
            openBrace,
            this.getLastReadToken() ?? openBrace
        );
        const parameters = hasExplicitParameterArrow
            ? explicitParameters
            : implicitParameterName
                ? [
                  this.attachNodeBounds(
                      {
                          kind: "FunctionParameter",
                          name: this.attachNodeBounds(
                              { kind: "Identifier", name: implicitParameterName } as Identifier,
                              openBrace,
                              openBrace
                          )
                      } as FunctionParameter,
                      openBrace,
                      openBrace
                  )
              ]
                : [];
        if (block.body.length === 1 && block.body[0]?.kind === "ExprStatement") {
            const expressionBody = (block.body[0] as ExprStatement).expression;
            return this.attachNodeBounds(
                {
                    kind: "ArrowFunctionExpression",
                    parameters,
                    body: expressionBody
                } as ArrowFunctionExpression,
                openBrace,
                block.lastToken ?? this.getLastReadToken() ?? openBrace
            );
        }
        return this.attachNodeBounds(
            {
                kind: "ArrowFunctionExpression",
                parameters,
                body: block
            } as ArrowFunctionExpression,
            openBrace,
            block.lastToken ?? this.getLastReadToken() ?? openBrace
        );
    }

    private attachContextualObjectLiteralToBraceLambda(lambda: ArrowFunctionExpression): ArrowFunctionExpression {
        if (lambda.contextualObjectLiteral) {
            return lambda;
        }
        if (
            lambda.body.kind !== "Identifier"
        ) {
            return lambda;
        }
        if (
            lambda.parameters.length > 1 ||
            (lambda.parameters.length === 1 && (
                lambda.parameters[0]?.name.kind !== "Identifier" ||
                lambda.parameters[0].name.name !== "it"
            ))
        ) {
            return lambda;
        }
        const identifier = lambda.body as Identifier;
        lambda.contextualObjectLiteral = {
            kind: "ObjectLiteral",
            properties: [{
                kind: "ObjectProperty",
                key: identifier,
                value: identifier,
                shorthand: true
            } as ObjectProperty]
        } as ObjectLiteral;
        return lambda;
    }

    private shouldTryObjectLiteralBeforeBraceLambda(): boolean {
        const first = this.tokens.peek();
        if (!first) {
            return false;
        }
        if (first.type === "symbol") {
            return first.value === "}" || first.value === "..." || first.value === "[";
        }
        if (first.type !== "identifier" && first.type !== "string" && first.type !== "number") {
            return false;
        }
        if (
            first.type === "identifier" &&
            (first.value === "get" || first.value === "set" || first.value === "async" || first.value === "sync")
        ) {
            const second = this.peekToken(1);
            if (
                second?.type === "identifier" ||
                second?.type === "string" ||
                second?.type === "number" ||
                (second?.type === "symbol" && second.value === "[")
            ) {
                return true;
            }
        }
        const second = this.peekToken(1);
        return second?.type === "symbol" && [":", ",", "(", "<", "}"].includes(second.value);
    }

    private parseBraceExpressionFromConsumedOpen(openBrace: Token): Expr {
        if (this.shouldTryObjectLiteralBeforeBraceLambda()) {
            const checkpoint = this.beginTokenCheckpoint();
            try {
                const objectLiteral = this.parseObjectLiteralFromConsumedOpen(openBrace);
                if (
                    !objectLiteral.trailingComma &&
                    objectLiteral.properties.length === 1 &&
                    objectLiteral.properties[0]?.kind === "ObjectProperty" &&
                    (objectLiteral.properties[0] as ObjectProperty).shorthand &&
                    (objectLiteral.properties[0] as ObjectProperty).key.kind === "Identifier"
                ) {
                    this.restoreTokenCheckpoint(checkpoint);
                    const lambda = this.parseBraceLambdaExpressionFromConsumedOpen(openBrace, null);
                    lambda.contextualObjectLiteral = objectLiteral;
                    return lambda;
                }
                this.commitTokenCheckpoint(checkpoint);
                return objectLiteral;
            } catch (error) {
                this.restoreTokenCheckpoint(checkpoint);
                if (!(error instanceof ParseError)) {
                    throw error;
                }
            }
        }
        return this.attachContextualObjectLiteralToBraceLambda(this.parseBraceLambdaExpressionFromConsumedOpen(openBrace, null));
    }


    private applyImplicitTailLambdaReturn(statements: Statement[]): Statement[] {
        if (statements.length <= 1) {
            return statements;
        }
        const lastStatement = statements[statements.length - 1];
        if (lastStatement?.kind !== "ExprStatement") {
            return statements;
        }
        const returnStatement = this.attachNodeBounds(
            {
                kind: "ReturnStatement",
                expression: (lastStatement as ExprStatement).expression
            } as ReturnStatement,
            lastStatement.firstToken ?? (lastStatement as ExprStatement).expression.firstToken,
            lastStatement.lastToken ?? (lastStatement as ExprStatement).expression.lastToken
        );
        return [...statements.slice(0, -1), returnStatement];
    }

    private tryParseArrowFunctionExpression(): ArrowFunctionExpression | null {
        const startOffset = this.tokens.offset;
        let async = false;
        let sync = false;
        let first = this.tokens.peek();
        let arrowParameterToken: Token | undefined;
        if (first?.type === "identifier" && first.value === "async" && this.peekToken(1)?.type === "symbol" && this.peekToken(1)?.value === "(") {
            async = true;
            this.tokens.skip();
            first = this.tokens.peek();
        } else if (first?.type === "identifier" && first.value === "sync" && this.peekToken(1)?.type === "symbol" && this.peekToken(1)?.value === "(") {
            sync = true;
            this.tokens.skip();
            first = this.tokens.peek();
        } else if (first?.type === "identifier" && first.value === "async" && this.peekToken(1)?.type === "identifier" && this.peekToken(2)?.type === "symbol" && this.peekToken(2)?.value === "=>") {
            async = true;
            this.tokens.skip();
            first = this.tokens.peek();
            arrowParameterToken = first ?? undefined;
        } else if (first?.type === "identifier" && first.value === "sync" && this.peekToken(1)?.type === "identifier" && this.peekToken(2)?.type === "symbol" && this.peekToken(2)?.value === "=>") {
            sync = true;
            this.tokens.skip();
            first = this.tokens.peek();
            arrowParameterToken = first ?? undefined;
        }
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
                    ...(async ? { async: true } : {}),
                    ...(sync ? { sync: true } : {}),
                    parameters: [parameter],
                    body
                } as ArrowFunctionExpression,
                arrowParameterToken ?? first,
                body.lastToken ?? this.getLastReadToken() ?? arrowParameterToken ?? first
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
            let returnType: Identifier | undefined;
            if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === ":") {
                this.tokens.skip();
                returnType = this.parseTypeAnnotationNode();
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
                    ...(async ? { async: true } : {}),
                    ...(sync ? { sync: true } : {}),
                    parameters,
                    ...(returnType ? { returnType } : {}),
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

        if (token?.type === "symbol" && token.value === "...") {
            const argument = this.parseUnary();
            return this.attachNodeBounds({
                kind: "SpreadExpression",
                argument
            } as SpreadExpression, token, argument.lastToken ?? this.getLastReadToken() ?? token);
        }

        if (token?.type === "symbol" && token.value === "(") {
            if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === ")") {
                const close = this.tokens.read();
                return this.attachNodeBounds({
                    kind: "MissingExpression"
                } as Expr, token, close ?? token);
            }
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
            return this.parseBraceExpressionFromConsumedOpen(token);
        }

        if (token?.type === "number") {
            const normalizedNumberText = token.value.replace(/_/g, "");
            if (normalizedNumberText.endsWith("n") || normalizedNumberText.endsWith("N")) {
                const raw = normalizedNumberText.slice(0, -1);
                try {
                    return this.attachNodeBounds(
                        { kind: "BigIntLiteral", value: BigInt(raw) } as BigIntLiteral,
                        token,
                        token
                    );
                } catch {
                    this.fail("Invalid bigint literal", this.tokenAt(token));
                }
            }
            if (normalizedNumberText.endsWith("L")) {
                const raw = normalizedNumberText.slice(0, -1);
                try {
                    return this.attachNodeBounds(
                        { kind: "LongLiteral", value: BigInt(raw) } as LongLiteral,
                        token,
                        token
                    );
                } catch {
                    this.fail("Invalid long literal", this.tokenAt(token));
                }
            }
            const numericValue = Number(normalizedNumberText);
            if (!Number.isFinite(numericValue)) {
                this.fail("Invalid numeric literal", this.tokenAt(token));
            }
            if (normalizedNumberText.includes(".") || normalizedNumberText.includes("e") || normalizedNumberText.includes("E")) {
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

        if (token?.type === "regexp") {
            const lastSlashIndex = token.value.lastIndexOf("/");
            const pattern = token.value.slice(1, lastSlashIndex);
            const flags = token.value.slice(lastSlashIndex + 1);
            return this.attachNodeBounds(
                { kind: "RegExpLiteral", pattern, flags } as RegExpLiteral,
                token,
                token
            );
        }

        if (token?.type === "identifier") {
            if (token.value === "function") {
                return this.parseFunctionExpression(token);
            }
            if (
                token.value === "async" &&
                this.tokens.peek()?.type === "identifier" &&
                this.tokens.peek()?.value === "function"
            ) {
                this.tokens.skip();
                return this.parseFunctionExpression(token, true);
            }
            if (
                token.value === "sync" &&
                this.tokens.peek()?.type === "identifier" &&
                this.tokens.peek()?.value === "function"
            ) {
                this.tokens.skip();
                return this.parseFunctionExpression(token, false, true);
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
            if (token.value === "class") {
                return this.parseClassExpression(token);
            }
            return this.buildIdentifierFromToken(token);
        }

        this.fail("Expected a number literal, string literal, identifier, '(', '[' or '{'", this.tokenAt(token));
    }

    private parsePostfix(): Expr {
        return this.parsePostfixFrom(this.parsePrimary());
    }

    private parsePropertyReferencePostfix(receiver: Expr, operator: Token): Expr {
        this.tokens.skip();
        const property = this.tokens.read();
        if (property?.type !== "identifier") {
            this.fail(
                "Expected identifier after '::'",
                this.tokenAt(property?.type === "eof" ? operator : property ?? operator)
            );
        }
        return this.attachNodeBounds({
            kind: "PropertyReferenceExpression",
            object: receiver,
            property: this.buildIdentifierFromToken(property)
        } as PropertyReferenceExpression, receiver.firstToken, property);
    }

    private parsePostfixFrom(initialExpr: Expr): Expr {
        let expr = initialExpr;
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

            if (token?.type === "symbol" && token.value === "?." && this.peekToken(1)?.type === "symbol" && this.peekToken(1)?.value === "(") {
                this.tokens.skip();
                const { args, close } = this.parseCallArgumentList();
                expr = this.attachNodeBounds({
                    kind: "CallExpression",
                    callee: expr,
                    arguments: args,
                    optional: true,
                    ...(pendingTypeArguments ? { typeArguments: pendingTypeArguments } : {})
                } as CallExpression, expr.firstToken, close);
                pendingTypeArguments = undefined;
                continue;
            }

            if (token?.type === "symbol" && token.value === "?." && this.peekToken(1)?.type === "symbol" && this.peekToken(1)?.value === "[") {
                this.tokens.skip();
                this.tokens.skip();
                const property = this.parseExpressionOrThrow();
                const close = this.tokens.read();
                if (close?.type !== "symbol" || close.value !== "]") {
                    this.fail("Expected ']' after optional computed member access", this.tokenAt(close));
                }

                expr = {
                    kind: "MemberExpression",
                    object: expr,
                    property,
                    computed: true,
                    optional: true
                } as MemberExpression;
                this.attachNodeBounds(expr as MemberExpression, (expr as MemberExpression).object.firstToken, close);
                continue;
            }

            if (token?.type === "symbol" && token.value === "::") {
                if (hasLineBreakBetween(expr.lastToken, token)) {
                    break;
                }
                expr = this.parsePropertyReferencePostfix(expr, token);
                continue;
            }

            if (token?.type === "symbol" && (token.value === "." || token.value === "?." || token.value === "!.")) {
                this.tokens.skip();
                const property = this.tryParsePrivateIdentifierToken() ?? this.tokens.read();
                if (property?.type !== "identifier") {
                    if (this.canRecoverMissingMemberIdentifier(token, property)) {
                        const errorToken = this.tokenAt(property?.type === "eof" ? token : property ?? token);
                        this.errors.push({
                            message: `Expected identifier after '${token.value}'`,
                            ...(errorToken ? { token: errorToken } : {})
                        });
                        if (property && property.type !== "eof") {
                            this.tokens.offset -= 1;
                        }
                        break;
                    }
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

            if (token?.type === "symbol" && token.value === "!" && !hasLineBreakBetween(expr.lastToken, token)) {
                this.tokens.skip();
                expr = this.attachNodeBounds({
                    kind: "NonNullExpression",
                    expression: expr
                } as NonNullExpression, expr.firstToken, token);
                continue;
            }

            if (token?.type === "symbol" && token.value === "[") {
                if (hasLineBreakBetween(expr.lastToken, token)) {
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
                const { args, close } = this.parseCallArgumentList();
                expr = this.attachNodeBounds({
                    kind: "CallExpression",
                    callee: expr,
                    arguments: args,
                    ...(pendingTypeArguments ? { typeArguments: pendingTypeArguments } : {})
                } as CallExpression, expr.firstToken, close);
                pendingTypeArguments = undefined;
                continue;
            }

            if (token?.type === "string" && !hasLineBreakBetween(expr.lastToken, token)) {
                this.tokens.skip();
                expr = this.attachNodeBounds({
                    kind: "CallExpression",
                    callee: expr,
                    arguments: [
                        this.attachNodeBounds(
                            { kind: "StringLiteral", value: token.value } as StringLiteral,
                            token,
                            token
                        )
                    ],
                    ...(pendingTypeArguments ? { typeArguments: pendingTypeArguments } : {})
                } as CallExpression, expr.firstToken, token);
                pendingTypeArguments = undefined;
                continue;
            }

            if (token?.type === "symbol" && token.value === "{") {
                if (hasLineBreakBetween(expr.lastToken, token)) {
                    break;
                }
                const tailLambda = this.parseTailLambdaArgument();
                if (expr.kind === "NewExpression") {
                    const newExpression = expr as NewExpression;
                    expr = this.attachNodeBounds(
                        {
                            kind: "NewExpression",
                            callee: newExpression.callee,
                            arguments: [...(newExpression.arguments ?? []), tailLambda],
                            ...(newExpression.typeArguments ? { typeArguments: newExpression.typeArguments } : {})
                        } as NewExpression,
                        newExpression.firstToken,
                        tailLambda.lastToken ?? this.getLastReadToken()
                    );
                    continue;
                }
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
                if (hasLineBreakBetween(expr.lastToken, token)) {
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

    private parseNewTarget(newKeyword?: Token): {
        callee: Expr;
        arguments?: Expr[];
        typeArguments?: Identifier[];
        lastToken?: Token;
    } {
        let expr: Expr;
        if (newKeyword && this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === ".") {
            const dotToken = this.tokens.read();
            const propertyToken = this.tokens.read();
            if (propertyToken?.type !== "identifier" || propertyToken.value !== "target") {
                this.fail("Expected 'target' after 'new.'", this.tokenAt(propertyToken ?? dotToken));
            }
            const metaObject = this.attachNodeBounds(
                { kind: "Identifier", name: "new" } as Identifier,
                newKeyword,
                newKeyword
            );
            expr = this.attachNodeBounds(
                {
                    kind: "MemberExpression",
                    object: metaObject,
                    property: this.buildIdentifierFromToken(propertyToken),
                    computed: false
                } as MemberExpression,
                newKeyword,
                propertyToken
            );
        } else {
            expr = this.parsePrimary();
        }
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

            if (token?.type === "symbol" && token.value === "?." && this.peekToken(1)?.type === "symbol" && this.peekToken(1)?.value === "[") {
                this.tokens.skip();
                this.tokens.skip();
                const property = this.parseExpressionOrThrow();
                const close = this.tokens.read();
                if (close?.type !== "symbol" || close.value !== "]") {
                    this.fail("Expected ']' after optional computed member access", this.tokenAt(close));
                }

                expr = {
                    kind: "MemberExpression",
                    object: expr,
                    property,
                    computed: true,
                    optional: true
                } as MemberExpression;
                this.attachNodeBounds(expr as MemberExpression, (expr as MemberExpression).object.firstToken, close);
                continue;
            }

            if (token?.type === "symbol" && token.value === "::") {
                if (hasLineBreakBetween(expr.lastToken, token)) {
                    break;
                }
                expr = this.parsePropertyReferencePostfix(expr, token);
                continue;
            }

            if (token?.type === "symbol" && (token.value === "." || token.value === "?." || token.value === "!.")) {
                this.tokens.skip();
                const property = this.tryParsePrivateIdentifierToken() ?? this.tokens.read();
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
                if (hasLineBreakBetween(expr.lastToken, token)) {
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
                const { args, close } = this.parseCallArgumentList();
                return {
                    callee: expr,
                    arguments: args,
                    ...(pendingTypeArguments ? { typeArguments: pendingTypeArguments } : {}),
                    ...(close ? { lastToken: close } : {})
                };
            }

            break;
        }

        return {
            callee: expr,
            ...(pendingTypeArguments ? { typeArguments: pendingTypeArguments } : {}),
            ...(expr.lastToken ? { lastToken: expr.lastToken } : {})
        };
    }



    private parseCallLambdaArgument(): ArrowFunctionExpression {
        return this.attachContextualObjectLiteralToBraceLambda(this.parseTailLambdaArgument());
    }

    private looksLikeCallLambdaArgument(): boolean {
        if (!(this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === "{")) {
            return false;
        }
        const first = this.peekToken(1);
        const second = this.peekToken(2);
        if (first?.type === "identifier" && second?.type === "symbol" && second.value === "}") {
            return true;
        }
        let nestedDelimiters = 0;
        for (let index = 1; ; index += 1) {
            const token = this.peekToken(index);
            if (!token || token.type === "eof") return false;
            if (token.type !== "symbol") continue;
            if (token.value === "(" || token.value === "[" || token.value === "{") {
                nestedDelimiters += 1;
                continue;
            }
            if (token.value === ")" || token.value === "]" || token.value === "}") {
                if (nestedDelimiters === 0) return false;
                nestedDelimiters -= 1;
                continue;
            }
            if (token.value === "->" && nestedDelimiters === 0) return true;
        }
    }

    /**
     * Parses a named call argument of the form `name: value`. Returns `null`
     * when the upcoming tokens are not a named argument (an identifier directly
     * followed by `:`), so the caller can fall back to a positional argument.
     * A leading `identifier :` is unambiguous in argument position: positional
     * expressions never start that way (ternaries begin with `cond ?`).
     */
    private tryParseNamedArgument(): NamedArgument | null {
        const nameToken = this.tokens.peek();
        const colonToken = this.peekToken(1);
        if (
            nameToken?.type !== "identifier" ||
            colonToken?.type !== "symbol" ||
            colonToken.value !== ":"
        ) {
            return null;
        }
        this.tokens.skip();
        this.tokens.skip();
        const value = this.parseAssignment();
        return this.attachNodeBounds(
            {
                kind: "NamedArgument",
                name: this.buildIdentifierFromToken(nameToken),
                value
            } as NamedArgument,
            nameToken,
            value.lastToken ?? this.getLastReadToken() ?? nameToken
        );
    }

    private parseCallArgumentList(): { args: Expr[]; close: Token } {
        const open = this.tokens.read();
        if (open?.type !== "symbol" || open.value !== "(") {
            this.fail("Expected '(' before call arguments", this.tokenAt(open));
        }
        const args: Expr[] = [];

        while (this.tokens.hasMore) {
            const next = this.tokens.peek();
            if (next?.type === "symbol" && next.value === ")") {
                break;
            }
            if (next?.type === "symbol" && next.value === ",") {
                const comma = this.tokens.read();
                const errorToken = this.tokenAt(comma);
                this.errors.push({
                    message: "Expected a number literal, string literal, identifier, '(', '[' or '{'",
                    ...(errorToken ? { token: errorToken } : {})
                });
                args.push(this.attachNodeBounds({
                    kind: "MissingExpression"
                } as Expr, comma, comma));
                continue;
            }

            if (!(this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === ")")) {
                const namedArgument = this.tryParseNamedArgument();
                args.push(namedArgument ?? (this.looksLikeCallLambdaArgument() ? this.parseCallLambdaArgument() : this.parseAssignment()));
                const separator = this.tokens.peek();
                if (separator?.type === "symbol" && separator.value === ",") {
                    this.tokens.skip();
                    if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === ")") {
                        break;
                    }
                    continue;
                }
                break;
            }
        }

        const close = this.tokens.read();
        if (close?.type !== "symbol" || close.value !== ")") {
            this.fail("Expected ')' after call arguments", this.tokenAt(close));
        }
        return { args, close };
    }

    private parseUnary(): Expr {
        if (this.jsx) {
            const token = this.tokens.peek();
            if (token?.type === "symbol" && token.value === "<") {
                return this.parseJsxElementOrFragment();
            }
        } else {
            const angleBracketAssertion = this.tryParseAngleBracketTypeAssertion();
            if (angleBracketAssertion) {
                return angleBracketAssertion;
            }
        }

        const token = this.tokens.peek();
        if (token?.type === "identifier" && token.value === "new") {
            const newKeyword = this.tokens.read();
            const constructorTarget = this.parseNewTarget(newKeyword);

            const statement: NewExpression = {
                kind: "NewExpression",
                callee: constructorTarget.callee
            };

            if (constructorTarget.arguments) {
                statement.arguments = constructorTarget.arguments;
            }
            if (constructorTarget.typeArguments) {
                statement.typeArguments = constructorTarget.typeArguments;
            }

            const newExpression = this.attachNodeBounds(
                statement,
                newKeyword,
                constructorTarget.lastToken ?? this.getLastReadToken() ?? newKeyword
            );
            return this.parsePostfixFrom(newExpression);
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
            (token.value === "typeof" || token.value === "void" || token.value === "delete" || token.value === "await" || token.value === "yield")
        ) {
            this.tokens.skip();
            let operator: UnaryExpression["operator"] = token.value;
            if (token.value === "yield" && this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === "*") {
                this.tokens.skip();
                operator = "yield*";
            }
            const argument = this.parseUnary();
            return this.attachNodeBounds({
                kind: "UnaryExpression",
                operator,
                argument
            } as UnaryExpression, token, argument.lastToken ?? this.getLastReadToken());
        }
        if (token?.type === "identifier" && token.value === "go") {
            const next = this.peekToken(1);
            // `go` is a contextual keyword: it only acts as the no-await operator when an operand
            // follows on the same line (a restricted production, like `yield`). Otherwise it is a
            // plain identifier, so existing code using `go` as a variable keeps working.
            const startsExpression =
                next?.type === "identifier" &&
                next.value !== "in" &&
                next.value !== "instanceof" &&
                next.value !== "is" &&
                next.value !== "as" &&
                next.range.start.line === token.range.end.line;
            if (startsExpression) {
                this.tokens.skip();
                const argument = this.parseUnary();
                return this.attachNodeBounds({
                    kind: "UnaryExpression",
                    operator: "go",
                    argument
                } as UnaryExpression, token, argument.lastToken ?? this.getLastReadToken());
            }
        }

        return this.parsePostfix();
    }

    private tryParseAngleBracketTypeAssertion(): AsExpression | null {
        const checkpoint = this.beginTokenCheckpoint();
        const open = this.tokens.peek();
        if (!(open?.type === "symbol" && open.value === "<")) {
            this.commitTokenCheckpoint(checkpoint);
            return null;
        }

        this.tokens.skip();
        try {
            const typeAnnotation = this.parseTypeAnnotationNode();
            if (!this.consumeGenericCloseAngle()) {
                this.restoreTokenCheckpoint(checkpoint);
                return null;
            }
            const expression = this.parseUnary();
            this.commitTokenCheckpoint(checkpoint);
            return this.attachNodeBounds({
                kind: "AsExpression",
                expression,
                typeAnnotation
            } as AsExpression, open, expression.lastToken ?? this.getLastReadToken() ?? open);
        } catch (error) {
            this.restoreTokenCheckpoint(checkpoint);
            if (error instanceof ParseError) {
                return null;
            }
            throw error;
        }
    }

    // --- Embedded XML / JSX ---------------------------------------------------

    private parseJsxElementOrFragment(): Expr {
        const open = this.tokens.read(); // '<'

        const next = this.tokens.peek();
        if (next?.type === "symbol" && next.value === ">") {
            this.tokens.skip(); // '>'
            const children = this.parseJsxChildren();
            this.consumeJsxClosingTag(null);
            const close = this.getLastReadToken();
            return this.attachNodeBounds(
                { kind: "JsxFragment", children } as JsxFragment,
                open,
                close ?? open
            );
        }

        const { text: tagName, reference } = this.parseJsxName();
        const attributes = this.parseJsxAttributes();

        const afterAttributes = this.tokens.read();
        if (afterAttributes?.type === "symbol" && afterAttributes.value === "/") {
            const gt = this.tokens.read();
            if (!(gt?.type === "symbol" && gt.value === ">")) {
                this.fail("Expected '>' to close self-closing JSX element", this.tokenAt(gt));
            }
            return this.attachNodeBounds(
                {
                    kind: "JsxElement",
                    tagName,
                    ...(reference ? { reference } : {}),
                    attributes,
                    children: [],
                    selfClosing: true
                } as JsxElement,
                open,
                gt
            );
        }
        if (!(afterAttributes?.type === "symbol" && afterAttributes.value === ">")) {
            this.fail("Expected '>' in JSX opening tag", this.tokenAt(afterAttributes));
        }

        const children = this.parseJsxChildren();
        this.consumeJsxClosingTag(tagName);
        const close = this.getLastReadToken();
        return this.attachNodeBounds(
            {
                kind: "JsxElement",
                tagName,
                ...(reference ? { reference } : {}),
                attributes,
                children,
                selfClosing: false
            } as JsxElement,
            open,
            close ?? open
        );
    }

    private consumeJsxClosingTag(expectedTagName: string | null): void {
        const closeLt = this.tokens.read();
        if (!(closeLt?.type === "symbol" && closeLt.value === "<")) {
            this.fail("Expected JSX closing tag", this.tokenAt(closeLt));
        }
        const slash = this.tokens.read();
        if (!(slash?.type === "symbol" && slash.value === "/")) {
            this.fail("Expected '/' in JSX closing tag", this.tokenAt(slash));
        }
        if (expectedTagName !== null) {
            const { text } = this.parseJsxName();
            if (text !== expectedTagName) {
                this.fail(`JSX closing tag </${text}> does not match opening tag <${expectedTagName}>`, this.tokenAt(closeLt));
            }
        }
        const gt = this.tokens.read();
        if (!(gt?.type === "symbol" && gt.value === ">")) {
            this.fail("Expected '>' to close JSX closing tag", this.tokenAt(gt));
        }
    }

    private parseJsxName(): { text: string; reference?: Expr } {
        const first = this.tokens.read();
        if (first?.type !== "identifier") {
            this.fail("Expected JSX tag name", this.tokenAt(first));
        }
        const segments = [first.value];
        let text = first.value;
        let reference: Expr = this.buildIdentifierFromToken(first);
        while (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === ".") {
            this.tokens.skip();
            const part = this.tokens.read();
            if (part?.type !== "identifier") {
                this.fail("Expected identifier after '.' in JSX tag name", this.tokenAt(part));
            }
            segments.push(part.value);
            text += "." + part.value;
            const property = this.buildIdentifierFromToken(part);
            reference = this.attachNodeBounds(
                { kind: "MemberExpression", object: reference, property, computed: false } as MemberExpression,
                first,
                part
            );
        }
        const isComponent = /^[A-Z]/.test(first.value) || segments.length > 1;
        return isComponent ? { text, reference } : { text };
    }

    private parseJsxAttributes(): JsxAttributeLike[] {
        const attributes: JsxAttributeLike[] = [];
        while (true) {
            const token = this.tokens.peek();
            if (token?.type === "symbol" && (token.value === ">" || token.value === "/")) {
                break;
            }
            if (token?.type === "symbol" && token.value === "{") {
                const openBrace = this.tokens.read();
                const dots = this.tokens.read();
                if (!(dots?.type === "symbol" && dots.value === "...")) {
                    this.fail("Expected '...' in JSX spread attribute", this.tokenAt(dots));
                }
                const expression = this.parseAssignment();
                const closeBrace = this.tokens.read();
                if (!(closeBrace?.type === "symbol" && closeBrace.value === "}")) {
                    this.fail("Expected '}' to close JSX spread attribute", this.tokenAt(closeBrace));
                }
                attributes.push(this.attachNodeBounds(
                    { kind: "JsxSpreadAttribute", expression } as JsxSpreadAttribute,
                    openBrace,
                    closeBrace
                ));
                continue;
            }
            const nameToken = this.tokens.read();
            if (nameToken?.type !== "identifier") {
                this.fail("Expected JSX attribute name", this.tokenAt(nameToken));
            }
            let value: JsxAttribute["value"];
            let lastToken: Token = nameToken;
            if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === "=") {
                this.tokens.skip();
                const valueToken = this.tokens.peek();
                if (valueToken?.type === "string") {
                    this.tokens.skip();
                    value = this.attachNodeBounds(
                        { kind: "StringLiteral", value: valueToken.value } as StringLiteral,
                        valueToken,
                        valueToken
                    );
                    lastToken = valueToken;
                } else if (valueToken?.type === "symbol" && valueToken.value === "{") {
                    const container = this.parseJsxExpressionContainer();
                    value = container;
                    lastToken = container.lastToken ?? valueToken;
                } else {
                    this.fail("Expected JSX attribute value", this.tokenAt(valueToken));
                }
            }
            attributes.push(this.attachNodeBounds(
                { kind: "JsxAttribute", name: nameToken.value, ...(value ? { value } : {}) } as JsxAttribute,
                nameToken,
                lastToken
            ));
        }
        return attributes;
    }

    private parseJsxExpressionContainer(): JsxExpressionContainer {
        const open = this.tokens.read(); // '{'
        const checkpoint = this.beginTokenCheckpoint();
        try {
            const expression = this.parseAssignment();
            const close = this.tokens.read();
            if (!(close?.type === "symbol" && close.value === "}")) {
                this.fail("Expected '}' to close JSX expression", this.tokenAt(close));
            }
            this.commitTokenCheckpoint(checkpoint);
            return this.attachNodeBounds(
                { kind: "JsxExpressionContainer", expression } as JsxExpressionContainer,
                open,
                close
            );
        } catch (error) {
            this.restoreTokenCheckpoint(checkpoint);
            if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === "{") {
                const expression = this.parseBraceLambdaExpression(null);
                const close = this.tokens.read();
                if (!(close?.type === "symbol" && close.value === "}")) {
                    this.fail("Expected '}' to close JSX expression", this.tokenAt(close));
                }
                return this.attachNodeBounds(
                    { kind: "JsxExpressionContainer", expression } as JsxExpressionContainer,
                    open,
                    close
                );
            }
            throw error;
        }
    }

    private parseJsxChildren(): JsxChild[] {
        const children: JsxChild[] = [];
        while (true) {
            const token = this.tokens.peek();
            if (!token || token.type === "eof") {
                this.fail("Unterminated JSX element", this.tokenAt(token));
            }
            if (token.type === "jsxText") {
                this.tokens.skip();
                const normalized = normalizeJsxText(token.value);
                if (normalized.length > 0) {
                    children.push(this.attachNodeBounds(
                        { kind: "JsxText", value: normalized } as JsxText,
                        token,
                        token
                    ));
                }
                continue;
            }
            if (token.type === "symbol" && token.value === "{") {
                const after = this.peekToken(1);
                if (after?.type === "symbol" && after.value === "}") {
                    // Empty/comment-only expression container: `{}` or `{/* ... */}`.
                    this.tokens.skip();
                    this.tokens.skip();
                    continue;
                }
                children.push(this.parseJsxExpressionContainer());
                continue;
            }
            if (token.type === "symbol" && token.value === "<") {
                const after = this.peekToken(1);
                if (after?.type === "symbol" && after.value === "/") {
                    break;
                }
                children.push(this.parseJsxElementOrFragment() as JsxChild);
                continue;
            }
            this.fail("Unexpected token in JSX children", this.tokenAt(token));
        }
        return children;
    }

    /**
     * Attempts to parse a generic receiver's type argument list for an extension
     * declaration, e.g. the `<T>` in `fun <T> Array<T>.demo()` or
     * `val <T> Array<T>.doubledLength => ...`. Only succeeds when the `<...>`
     * group is immediately followed by a `.` (the extension-member dot), so it
     * never consumes the type parameter list of a regular generic function such
     * as `fun foo<T>()`. Returns the parsed type arguments, or `null` (restoring
     * the token position) when the lookahead does not match.
     */
    private tryParseReceiverTypeArguments(): Identifier[] | null {
        const checkpoint = this.beginTokenCheckpoint();
        const open = this.tokens.peek();
        if (!(open?.type === "symbol" && open.value === "<")) {
            this.commitTokenCheckpoint(checkpoint);
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
                if (this.consumeGenericCloseAngle()) {
                    break;
                }
                this.restoreTokenCheckpoint(checkpoint);
                return null;
            }
        } catch (error) {
            this.restoreTokenCheckpoint(checkpoint);
            if (error instanceof ParseError) {
                return null;
            }
            throw error;
        }

        const next = this.tokens.peek();
        if (!(next?.type === "symbol" && next.value === ".")) {
            this.restoreTokenCheckpoint(checkpoint);
            return null;
        }

        this.commitTokenCheckpoint(checkpoint);
        return typeArguments;
    }

    private tryParseInvocationTypeArguments(): Identifier[] | null {
        const checkpoint = this.beginTokenCheckpoint();
        const open = this.tokens.peek();
        if (!(open?.type === "symbol" && open.value === "<")) {
            this.commitTokenCheckpoint(checkpoint);
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
                if (this.consumeGenericCloseAngle()) {
                    break;
                }
                this.restoreTokenCheckpoint(checkpoint);
                return null;
            }
        } catch (error) {
            this.restoreTokenCheckpoint(checkpoint);
            if (error instanceof ParseError) {
                return null;
            }
            throw error;
        }

        const next = this.tokens.peek();
        if (!(next?.type === "symbol" && next.value === "(")) {
            this.restoreTokenCheckpoint(checkpoint);
            return null;
        }

        this.commitTokenCheckpoint(checkpoint);
        return typeArguments;
    }

    private parseAsExpression(): Expr {
        let expression = this.parseBinaryExpression();
        while (
            this.tokens.peek()?.type === "identifier"
            && (this.tokens.peek()?.value === "as" || this.tokens.peek()?.value === "satisfies")
        ) {
            const operator = this.tokens.peek()?.value;
            this.tokens.skip();
            const typeAnnotation = this.parseTypeAnnotationNode();
            expression = operator === "satisfies"
                ? this.attachNodeBounds({
                    kind: "SatisfiesExpression",
                    expression,
                    typeAnnotation
                } as SatisfiesExpression, expression.firstToken, typeAnnotation.lastToken ?? this.getLastReadToken())
                : this.attachNodeBounds({
                    kind: "AsExpression",
                    expression,
                    typeAnnotation
                } as AsExpression, expression.firstToken, typeAnnotation.lastToken ?? this.getLastReadToken());
        }
        return expression;
    }

    private parseConditional(): Expr {
        const test = this.parseAsExpression();
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

    private parseCommaExpression(): Expr {
        const first = this.parseAssignment();
        const expressions: Expr[] = [first];

        while (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === ",") {
            this.tokens.skip();
            expressions.push(this.parseAssignment());
        }

        if (expressions.length === 1) {
            return first;
        }

        return this.attachNodeBounds({
            kind: "CommaExpression",
            expressions
        } as CommaExpression, first.firstToken, expressions[expressions.length - 1]?.lastToken ?? this.getLastReadToken());
    }

    private parseAssignment(allowChain: boolean = true): Expr {
        const arrowFunction = this.tryParseArrowFunctionExpression();
        if (arrowFunction) {
            return arrowFunction;
        }

        const left = this.parseConditional();
        const token = this.tokens.peek();

        if (allowChain && token?.type === "symbol" && token.value === "..") {
            return this.parseChainExpression(left);
        }

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

    private parseChainExpression(receiver: Expr): ChainExpression {
        const operations: Expr[] = [];
        while (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === "..") {
            const chainToken = this.tokens.read()!;
            const property = this.tryParsePrivateIdentifierToken() ?? this.tokens.read();
            if (property?.type !== "identifier") {
                this.fail("Expected identifier after '..'", this.tokenAt(property ?? chainToken));
            }
            const member = this.attachNodeBounds({
                kind: "MemberExpression",
                object: receiver,
                property: this.buildIdentifierFromToken(property),
                computed: false
            } as MemberExpression, chainToken, property);
            let operation = this.parsePostfixFrom(member);
            const assignmentToken = this.tokens.peek();
            if (
                assignmentToken?.type === "symbol" &&
                ASSIGNMENT_OPERATORS.includes(assignmentToken.value as AssignmentOperator)
            ) {
                this.tokens.skip();
                const right = this.parseAssignment(false);
                operation = this.attachNodeBounds({
                    kind: "AssignmentExpression",
                    operator: assignmentToken.value as AssignmentOperator,
                    left: operation,
                    right
                } as AssignmentExpression, chainToken, right.lastToken ?? this.getLastReadToken());
            }
            operations.push(operation);
        }
        return this.attachNodeBounds({
            kind: "ChainExpression",
            receiver,
            operations
        } as ChainExpression, receiver.firstToken, operations[operations.length - 1]?.lastToken ?? receiver.lastToken);
    }

    /**
     * Attempts to parse the head of an extension property declaration:
     * `<Receiver>[<TypeArgs>].<name>[: Type]`. Returns `null` (restoring the
     * token position) when the upcoming tokens are a regular variable
     * declaration. Any leading type parameters (`val <T> ...`) must be consumed
     * by the caller before invoking this method.
     */
    private tryParseExtensionPropertyHead(): {
        receiverType: Identifier;
        receiverTypeArguments?: Identifier[];
        name: Identifier;
        typeAnnotation?: Identifier;
    } | null {
        const checkpoint = this.beginTokenCheckpoint();
        const restore = (): null => {
            this.restoreTokenCheckpoint(checkpoint);
            return null;
        };

        const receiverToken = this.tokens.peek();
        if (receiverToken?.type !== "identifier") {
            this.commitTokenCheckpoint(checkpoint);
            return null;
        }
        this.tokens.skip();

        let receiverTypeArguments: Identifier[] | undefined;
        if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === "<") {
            const parsed = this.tryParseReceiverTypeArguments();
            if (!parsed) {
                return restore();
            }
            receiverTypeArguments = parsed;
        }

        const dot = this.tokens.peek();
        if (!(dot?.type === "symbol" && dot.value === ".")) {
            return restore();
        }
        this.tokens.skip();

        const nameToken = this.tokens.read();
        if (nameToken?.type !== "identifier") {
            return restore();
        }

        let typeAnnotation: Identifier | undefined;
        if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === ":") {
            this.tokens.skip();
            try {
                typeAnnotation = this.parseTypeAnnotationNode();
            } catch (error) {
                if (error instanceof ParseError) {
                    return restore();
                }
                throw error;
            }
        }

        this.commitTokenCheckpoint(checkpoint);
        return {
            receiverType: this.buildIdentifierFromToken(receiverToken),
            ...(receiverTypeArguments ? { receiverTypeArguments } : {}),
            name: this.buildIdentifierFromToken(nameToken),
            ...(typeAnnotation ? { typeAnnotation } : {})
        };
    }

    private parseExtensionPropertyAccessorBlock(
        propertyName: Identifier,
        typeAnnotation: Identifier | undefined
    ): ClassMethodMember[] {
        const openBrace = this.tokens.read();
        if (openBrace?.type !== "symbol" || openBrace.value !== "{") {
            this.fail("Expected '{' to start extension property accessor block", this.tokenAt(openBrace));
        }

        const accessors: ClassMethodMember[] = [];
        while (this.tokens.hasMore) {
            const peekToken = this.tokens.peek();
            if (peekToken?.type === "symbol" && peekToken.value === "}") {
                break;
            }
            if (peekToken?.type === "symbol" && peekToken.value === ";") {
                this.tokens.skip();
                continue;
            }

            const accessorKeyword = this.tokens.read();
            if (
                accessorKeyword?.type !== "identifier" ||
                (accessorKeyword.value !== "get" && accessorKeyword.value !== "set")
            ) {
                this.fail("Expected 'get' or 'set' inside extension property accessor block", this.tokenAt(accessorKeyword));
            }

            if (accessorKeyword.value === "get") {
                const getterBody = this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === "=>"
                    ? this.parseExpressionBodyAsBlock()
                    : this.parseBlockStatement();
                const getter: ClassMethodMember = {
                    kind: "ClassMethodMember",
                    name: propertyName,
                    parameters: [],
                    body: getterBody,
                    accessorKind: "get"
                };
                if (typeAnnotation) {
                    getter.returnType = typeAnnotation;
                }
                this.attachNonEnumerableToken(getter, "accessorToken", accessorKeyword);
                accessors.push(this.attachNodeBounds(getter, accessorKeyword, this.getLastReadToken() ?? accessorKeyword));
            } else {
                let setterParameter: FunctionParameter;
                if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === "(") {
                    this.tokens.skip();
                    const parameterToken = this.tokens.read();
                    if (parameterToken?.type !== "identifier") {
                        this.fail("Expected setter parameter name", this.tokenAt(parameterToken));
                    }
                    let parameterType: Identifier | undefined = typeAnnotation;
                    if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === ":") {
                        this.tokens.skip();
                        parameterType = this.parseTypeAnnotationNode();
                    }
                    const closeParen = this.tokens.read();
                    if (closeParen?.type !== "symbol" || closeParen.value !== ")") {
                        this.fail("Expected ')' after setter parameter", this.tokenAt(closeParen));
                    }
                    const parameterName = this.buildIdentifierFromToken(parameterToken);
                    setterParameter = this.attachNodeBounds(
                        { kind: "FunctionParameter", name: parameterName } as FunctionParameter,
                        parameterToken,
                        this.getLastReadToken() ?? parameterToken
                    );
                    if (parameterType) {
                        setterParameter.typeAnnotation = parameterType;
                    }
                } else {
                    const newValueIdentifier = this.attachNodeBounds(
                        { kind: "Identifier", name: "newValue" } as Identifier,
                        accessorKeyword,
                        accessorKeyword
                    );
                    setterParameter = this.attachNodeBounds(
                        { kind: "FunctionParameter", name: newValueIdentifier } as FunctionParameter,
                        accessorKeyword,
                        accessorKeyword
                    );
                    if (typeAnnotation) {
                        setterParameter.typeAnnotation = typeAnnotation;
                    }
                }

                const setterBody = this.parseBlockStatement();
                const setter: ClassMethodMember = {
                    kind: "ClassMethodMember",
                    name: propertyName,
                    parameters: [setterParameter],
                    body: setterBody,
                    accessorKind: "set"
                };
                this.attachNonEnumerableToken(setter, "accessorToken", accessorKeyword);
                accessors.push(this.attachNodeBounds(setter, accessorKeyword, this.getLastReadToken() ?? accessorKeyword));
            }

            this.consumeStatementSeparator("block", this.getLastReadToken());
        }

        const closeBrace = this.tokens.read();
        if (closeBrace?.type !== "symbol" || closeBrace.value !== "}") {
            this.fail("Expected '}' to close extension property accessor block", this.tokenAt(this.tokens.peek()));
        }

        if (accessors.length === 0) {
            this.fail("Accessor block must contain at least one 'get' or 'set'", this.tokenAt(closeBrace));
        }

        return accessors;
    }

    private parseVarStatement(): VarStatement {
        const declarationKeyword = this.tokens.read();
        if (
            declarationKeyword?.type !== "identifier" ||
            !VARIABLE_DECLARATION_KEYWORDS.includes(declarationKeyword.value as VariableDeclarationKind)
        ) {
            this.fail("Expected variable declaration statement", this.tokenAt(declarationKeyword));
        }

        // Leading type parameters introduce a generic extension property, e.g.
        // `val <T> Array<T>.doubledLength => length * 2`. A regular variable
        // declaration can never begin with `<`, so their presence forces the
        // extension-property form.
        const leadingTypeParameters = this.parseTypeParameterList();
        const extensionHead = this.tryParseExtensionPropertyHead();
        if (extensionHead) {
            const statement: VarStatement = {
                kind: "VarStatement",
                declarationKind: declarationKeyword.value as VariableDeclarationKind,
                receiverType: extensionHead.receiverType,
                name: extensionHead.name
            };
            if (extensionHead.receiverTypeArguments && extensionHead.receiverTypeArguments.length > 0) {
                statement.receiverTypeArguments = extensionHead.receiverTypeArguments;
            }
            if (leadingTypeParameters.length > 0) {
                statement.typeParameters = leadingTypeParameters;
            }
            if (extensionHead.typeAnnotation) {
                statement.typeAnnotation = extensionHead.typeAnnotation;
            }

            const nextToken = this.tokens.peek();
            if (nextToken?.type === "symbol" && nextToken.value === "=>") {
                const initializer = this.parseExpressionBodyAsBlock().body[0] as ReturnStatement | undefined;
                if (initializer?.kind !== "ReturnStatement" || !initializer.expression) {
                    this.fail("Expected expression body after '=>'", this.tokenAt(nextToken));
                }
                statement.initializer = initializer.expression;
                return this.attachNodeBounds(
                    statement,
                    declarationKeyword,
                    statement.initializer?.lastToken ?? this.getLastReadToken() ?? declarationKeyword
                );
            }
            if (nextToken?.type === "symbol" && nextToken.value === "{") {
                statement.accessors = this.parseExtensionPropertyAccessorBlock(extensionHead.name, extensionHead.typeAnnotation);
                return this.attachNodeBounds(
                    statement,
                    declarationKeyword,
                    this.getLastReadToken() ?? declarationKeyword
                );
            }
            this.fail("Expected '=>' or '{' after extension property declaration", this.tokenAt(nextToken));
        }
        if (leadingTypeParameters.length > 0) {
            this.fail("Expected an extension property declaration after type parameters", this.tokenAt());
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
        if (firstDeclaration.delegate) {
            statement.delegate = firstDeclaration.delegate;
        }
        if (declarations.length > 1) {
            statement.declarations = declarations;
        }
        return this.attachNodeBounds(statement, declarationKeyword, this.getLastReadToken() ?? declarationKeyword);
    }

    private parseVarDeclarator(): VarDeclarator {
        const firstToken = this.tokens.peek();
        const name = this.parseBindingName();

        let typeAnnotation: Identifier | undefined;
        const maybeColon = this.tokens.peek();
        if (maybeColon?.type === "symbol" && maybeColon.value === ":") {
            this.tokens.skip();
            typeAnnotation = this.parseTypeAnnotationNode();
        }

        let initializer: Expr | undefined;
        let delegate: Expr | undefined;
        const maybeEqualsOrBy = this.tokens.peek();
        if (maybeEqualsOrBy?.type === "symbol" && maybeEqualsOrBy.value === "=") {
            this.tokens.skip();
            initializer = this.parseAssignment();
        } else if (maybeEqualsOrBy?.type === "identifier" && maybeEqualsOrBy.value === "by") {
            this.tokens.skip();
            delegate = this.parseAssignment();
        }

        const declarator: VarDeclarator = {
            kind: "VarDeclarator",
            name
        };
        if (typeAnnotation) {
            declarator.typeAnnotation = typeAnnotation;
        }
        if (initializer) {
            declarator.initializer = initializer;
        }
        if (delegate) {
            declarator.delegate = delegate;
        }

        return this.attachNodeBounds(declarator, firstToken, this.getLastReadToken() ?? firstToken);
    }

    private parseBindingName(): BindingName {
        const token = this.tokens.peek();
        if (token?.type === "identifier") {
            this.tokens.skip();
            return this.buildIdentifierFromToken(token);
        }
        if (token?.type === "symbol" && token.value === "{") {
            return this.parseObjectBindingPattern();
        }
        if (token?.type === "symbol" && token.value === "[") {
            return this.parseArrayBindingPattern();
        }
        this.fail("Expected identifier in variable declaration", this.tokenAt(token));
    }

    private parseBindingElement(allowPropertyName: boolean): BindingElement {
        const firstToken = this.tokens.peek();
        let rest = false;
        let shorthand = false;
        if (firstToken?.type === "symbol" && firstToken.value === "...") {
            this.tokens.skip();
            rest = true;
        }
        let propertyName: BindingElement["propertyName"];
        let name: BindingName;
        const propertyLiteralToken = this.tokens.peek();
        if (
            allowPropertyName
            && this.language === "typescript"
            && propertyLiteralToken?.type === "string"
        ) {
            this.tokens.skip();
            const separatorToken = this.tokens.peek();
            if (!(separatorToken?.type === "symbol" && separatorToken.value === ":")) {
                this.fail("Expected ':' after string literal property name in binding pattern", this.tokenAt(separatorToken));
            }
            this.tokens.skip();
            propertyName = this.attachNodeBounds(
                { kind: "StringLiteral", value: propertyLiteralToken.value } as StringLiteral,
                propertyLiteralToken,
                propertyLiteralToken
            );
            name = this.parseBindingName();
        } else {
            const firstName = this.parseBindingName();
            name = firstName;
            const nextToken = this.tokens.peek();
            if (allowPropertyName && firstName.kind === "Identifier" && nextToken?.type === "symbol" && nextToken.value === "::") {
                this.tokens.skip();
                propertyName = firstName;
                name = this.parseBindingName();
            } else if (allowPropertyName && firstName.kind === "Identifier" && nextToken?.type === "symbol" && nextToken.value === ":" && this.language === "typescript") {
                this.tokens.skip();
                propertyName = firstName;
                name = this.parseBindingName();
            } else if (allowPropertyName && firstName.kind === "Identifier") {
                shorthand = true;
            }
        }
        let typeAnnotation: Identifier | undefined;
        if (!rest && this.language === "vexa" && this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === ":") {
            this.tokens.skip();
            typeAnnotation = this.parseTypeAnnotationNode();
        }
        let initializer: Expr | undefined;
        if (!rest && this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === "=") {
            this.tokens.skip();
            initializer = this.parseAssignment();
        }
        const element: BindingElement = { kind: "BindingElement", name };
        if (propertyName) element.propertyName = propertyName;
        if (typeAnnotation) element.typeAnnotation = typeAnnotation;
        if (shorthand) element.shorthand = true;
        if (rest) element.rest = true;
        if (initializer) element.initializer = initializer;
        return this.attachNodeBounds(element, firstToken, this.getLastReadToken() ?? firstToken);
    }

    private parseObjectBindingPattern(): ObjectBindingPattern {
        const open = this.tokens.read();
        const elements: BindingElement[] = [];
        while (this.tokens.hasMore && !(this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === "}")) {
            elements.push(this.parseBindingElement(true));
            if (!(this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === ",")) break;
            this.tokens.skip();
        }
        const close = this.tokens.read();
        if (!(close?.type === "symbol" && close.value === "}")) this.fail("Expected '}' after object binding pattern", this.tokenAt(close));
        return this.attachNodeBounds({ kind: "ObjectBindingPattern", elements }, open, close);
    }

    private parseArrayBindingPattern(): ArrayBindingPattern {
        const open = this.tokens.read();
        const elements: ArrayBindingPattern["elements"] = [];
        while (this.tokens.hasMore && !(this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === "]")) {
            if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === ",") {
                const comma = this.tokens.read();
                elements.push(this.attachNodeBounds({ kind: "BindingHole" }, comma, comma));
                continue;
            }
            elements.push(this.parseBindingElement(false));
            if (!(this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === ",")) break;
            this.tokens.skip();
        }
        const close = this.tokens.read();
        if (!(close?.type === "symbol" && close.value === "]")) this.fail("Expected ']' after array binding pattern", this.tokenAt(close));
        return this.attachNodeBounds({ kind: "ArrayBindingPattern", elements }, open, close);
    }


    private hasNamedDefaultFunctionDeclaration(): boolean {
        let offset = 0;
        const first = this.peekToken(offset);
        if (first?.type === "identifier" && (first.value === "async" || first.value === "sync")) {
            offset += 1;
        }
        const functionKeyword = this.peekToken(offset);
        if (!(functionKeyword?.type === "identifier" && functionKeyword.value === "function")) {
            return false;
        }
        offset += 1;
        if (this.peekToken(offset)?.type === "symbol" && this.peekToken(offset)?.value === "*") {
            offset += 1;
        }
        return this.peekToken(offset)?.type === "identifier";
    }

    private hasNamedDefaultClassDeclaration(): boolean {
        let offset = 0;
        const first = this.peekToken(offset);
        if (first?.type === "identifier" && first.value === "abstract") {
            offset += 1;
        }
        const classKeyword = this.peekToken(offset);
        if (!(classKeyword?.type === "identifier" && classKeyword.value === "class")) {
            return false;
        }
        const nameToken = this.peekToken(offset + 1);
        return nameToken?.type === "identifier"
            && nameToken.value !== "extends"
            && nameToken.value !== "implements";
    }

    private parseExportStatement(): ExportStatement {
        const exportKeyword = this.tokens.read();
        if (exportKeyword?.type !== "identifier" || exportKeyword.value !== "export") {
            this.fail("Expected 'export' statement", this.tokenAt(exportKeyword));
        }

        let typeOnly = false;
        if (this.tokens.peek()?.type === "identifier" && this.tokens.peek()?.value === "type") {
            const afterType = this.tokens.items[this.tokens.offset + 1];
            if (afterType?.type === "symbol" && (afterType.value === "{" || afterType.value === "*")) {
                this.tokens.skip();
                typeOnly = true;
            }
        }

        if (!typeOnly && this.tokens.peek()?.type === "identifier" && this.tokens.peek()?.value === "as") {
            const asKeyword = this.tokens.read();
            const namespaceKeyword = this.tokens.read();
            if (namespaceKeyword?.type !== "identifier" || namespaceKeyword.value !== "namespace") {
                this.fail("Expected 'namespace' after 'export as'", this.tokenAt(namespaceKeyword));
            }
            const nameToken = this.tokens.read();
            if (nameToken?.type !== "identifier") {
                this.fail("Expected namespace name after 'export as namespace'", this.tokenAt(nameToken));
            }
            const namespaceExport = this.buildIdentifierFromToken(nameToken);
            return this.attachNodeBounds(
                { kind: "ExportStatement", namespaceExport } as ExportStatement,
                exportKeyword,
                namespaceExport.lastToken ?? asKeyword ?? exportKeyword
            );
        }

        if (!typeOnly && this.tokens.peek()?.type === "identifier" && this.tokens.peek()?.value === "default") {
            this.tokens.skip();
            const next = this.tokens.peek();
            let declaration: Statement | undefined;
            if (
                next?.type === "identifier" &&
                (this.isFunctionDeclarationKeyword(next.value) || this.isAsyncFunctionDeclarationStart() || this.isSyncFunctionDeclarationStart()) &&
                this.hasNamedDefaultFunctionDeclaration()
            ) {
                declaration = this.parseFunctionStatement();
            } else if (
                next?.type === "identifier" &&
                (next.value === "class" || this.isAbstractClassStart()) &&
                this.hasNamedDefaultClassDeclaration()
            ) {
                declaration = this.parseClassStatement();
            } else {
                const expression = this.parseExpressionOrThrow();
                declaration = this.attachNodeBounds({ kind: "ExprStatement", expression } as ExprStatement, expression.firstToken, expression.lastToken);
            }
            return this.attachNodeBounds({ kind: "ExportStatement", declaration, default: true } as ExportStatement, exportKeyword, declaration.lastToken ?? this.getLastReadToken() ?? exportKeyword);
        }

        const next = this.tokens.peek();
        if (next?.type === "symbol" && next.value === "*") {
            this.tokens.skip();
            let namespaceExport: Identifier | undefined;
            if (!typeOnly && this.tokens.peek()?.type === "identifier" && this.tokens.peek()?.value === "as") {
                this.tokens.skip();
                const nameToken = this.tokens.read();
                if (nameToken?.type !== "identifier") {
                    this.fail("Expected namespace export name after 'export * as'", this.tokenAt(nameToken));
                }
                namespaceExport = this.buildIdentifierFromToken(nameToken);
            }
            const fromKeyword = this.tokens.read();
            if (fromKeyword?.type !== "identifier" || fromKeyword.value !== "from") {
                this.fail("Expected 'from' after export '*'", this.tokenAt(fromKeyword));
            }
            const sourceToken = this.tokens.read();
            if (sourceToken?.type !== "string") {
                this.fail("Expected string literal module path in export statement", this.tokenAt(sourceToken));
            }
            const from = this.attachNodeBounds({ kind: "StringLiteral", value: sourceToken.value } as StringLiteral, sourceToken, sourceToken);
            const statement: ExportStatement = { kind: "ExportStatement", exportAll: true, from };
            if (namespaceExport) {
                statement.namespaceExport = namespaceExport;
            }
            if (typeOnly) {
                statement.typeOnly = true;
            }
            return this.attachNodeBounds(statement, exportKeyword, sourceToken);
        }

        if (next?.type === "symbol" && next.value === "{") {
            const specifiers = this.parseExportSpecifierList();
            let from: StringLiteral | undefined;
            if (this.tokens.peek()?.type === "identifier" && this.tokens.peek()?.value === "from") {
                this.tokens.skip();
                const sourceToken = this.tokens.read();
                if (sourceToken?.type !== "string") {
                    this.fail("Expected string literal module path in export statement", this.tokenAt(sourceToken));
                }
                from = this.attachNodeBounds({ kind: "StringLiteral", value: sourceToken.value } as StringLiteral, sourceToken, sourceToken);
            }
            const statement: ExportStatement = { kind: "ExportStatement", specifiers };
            if (from) {
                statement.from = from;
            }
            if (typeOnly) {
                statement.typeOnly = true;
            }
            return this.attachNodeBounds(statement, exportKeyword, from?.lastToken ?? this.getLastReadToken() ?? exportKeyword);
        }

        let declaration: Statement;
        if (!typeOnly && next?.type === "identifier" && next.value === "declare") {
            declaration = this.parseStatementOrThrow();
            if (!("declared" in declaration) || declaration.declared !== true) {
                this.fail("Expected ambient declaration after 'export declare'", this.tokenAt(next));
            }
        } else if (typeOnly) {
            if (next?.type === "identifier" && next.value === "type") {
                declaration = this.parseTypeAliasStatement();
            } else if (next?.type === "identifier" && next.value === "interface") {
                declaration = this.parseInterfaceStatement();
            } else {
                this.fail("Expected type alias, interface, or named type export after 'export type'", this.tokenAt(next));
            }
        } else if (next?.type === "identifier" && this.isVariableDeclarationKeyword(next.value)) {
            declaration = this.parseVarStatement();
        } else if (next?.type === "identifier" && (this.isFunctionDeclarationKeyword(next.value) || this.isAsyncFunctionDeclarationStart() || this.isSyncFunctionDeclarationStart())) {
            declaration = this.parseFunctionStatement();
        } else if (next?.type === "identifier" && next.value === "type") {
            declaration = this.parseTypeAliasStatement();
        } else if (next?.type === "identifier" && (next.value === "class" || this.isAbstractClassStart())) {
            declaration = this.parseClassStatement();
        } else if (next?.type === "identifier" && next.value === "interface") {
            declaration = this.parseInterfaceStatement();
        } else if (next?.type === "identifier" && (next.value === "namespace" || next.value === "module")) {
            declaration = this.parseNamespaceStatement(false);
        } else if (next?.type === "identifier" && (next.value === "enum" || this.isConstEnumStart())) {
            declaration = this.parseEnumStatement();
        } else {
            this.fail("Expected declaration or export list after 'export'", this.tokenAt(next));
        }

        const statement: ExportStatement = { kind: "ExportStatement", declaration };
        if (typeOnly) {
            statement.typeOnly = true;
        }
        return this.attachNodeBounds(statement, exportKeyword, declaration.lastToken ?? this.getLastReadToken() ?? exportKeyword);
    }

    private parseExportSpecifierList(): ExportSpecifier[] {
        const openBrace = this.tokens.read();
        if (openBrace?.type !== "symbol" || openBrace.value !== "{") {
            this.fail("Expected '{' after 'export'", this.tokenAt(openBrace));
        }

        const specifiers: ExportSpecifier[] = [];
        while (this.tokens.hasMore) {
            const maybeCloseBrace = this.tokens.peek();
            if (maybeCloseBrace?.type === "symbol" && maybeCloseBrace.value === "}") {
                this.tokens.skip();
                break;
            }

            let typeOnly = false;
            if (this.tokens.peek()?.type === "identifier" && this.tokens.peek()?.value === "type") {
                this.tokens.skip();
                typeOnly = true;
            }

            const localToken = this.tokens.read();
            if (localToken?.type !== "identifier") {
                this.fail("Expected exported symbol name", this.tokenAt(localToken));
            }
            const local = this.buildIdentifierFromToken(localToken);
            let exported = local;
            if (this.tokens.peek()?.type === "identifier" && this.tokens.peek()?.value === "as") {
                this.tokens.skip();
                const exportedToken = this.tokens.read();
                if (exportedToken?.type !== "identifier") {
                    this.fail("Expected exported name after 'as'", this.tokenAt(exportedToken));
                }
                exported = this.buildIdentifierFromToken(exportedToken);
            }
            const specifier: ExportSpecifier = { kind: "ExportSpecifier", exported };
            if (exported !== local) {
                specifier.local = local;
            }
            if (typeOnly) {
                specifier.typeOnly = true;
            }
            specifiers.push(this.attachNodeBounds(specifier, localToken, exported.lastToken ?? localToken));

            const separator = this.tokens.peek();
            if (separator?.type === "symbol" && separator.value === ",") {
                this.tokens.skip();
                continue;
            }
            if (separator?.type === "symbol" && separator.value === "}") {
                continue;
            }
            this.fail("Expected ',' or '}' in export specifier list", this.tokenAt(separator));
        }
        return specifiers;
    }

    private parseImportStatement(): ImportStatement {
        const importKeyword = this.tokens.read();
        if (importKeyword?.type !== "identifier" || importKeyword.value !== "import") {
            this.fail("Expected 'import' statement", this.tokenAt(importKeyword));
        }

        let typeOnly = false;
        if (this.tokens.peek()?.type === "identifier" && this.tokens.peek()?.value === "type") {
            this.tokens.skip();
            typeOnly = true;
        }

        const firstImportToken = this.tokens.peek();
        if (firstImportToken?.type === "string") {
            if (typeOnly) {
                this.fail("Expected imported bindings after 'import type'", this.tokenAt(firstImportToken));
            }
            const sourceToken = this.tokens.read()!;
            const statement: ImportStatement = {
                kind: "ImportStatement",
                specifiers: [],
                from: this.attachNodeBounds(
                    {
                        kind: "StringLiteral",
                        value: sourceToken.value
                    } as StringLiteral,
                    sourceToken,
                    sourceToken
                ),
                sideEffectOnly: true
            };
            return this.attachNodeBounds(statement, importKeyword, sourceToken);
        }

        let defaultImport: Identifier | undefined;
        let namespaceImport: Identifier | undefined;
        let specifiers: ImportSpecifier[] = [];

        let hasMoreBindingsAfterDefault = false;
        if (firstImportToken?.type === "identifier") {
            const defaultToken = this.tokens.read()!;
            defaultImport = this.buildIdentifierFromToken(defaultToken);
            if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === ",") {
                this.tokens.skip();
                hasMoreBindingsAfterDefault = true;
            }
        } else {
            hasMoreBindingsAfterDefault = true;
        }

        const nextToken = this.tokens.peek();
        if (hasMoreBindingsAfterDefault && nextToken?.type === "symbol" && nextToken.value === "{") {
            specifiers = this.parseImportSpecifierList();
        } else if (hasMoreBindingsAfterDefault && nextToken?.type === "symbol" && nextToken.value === "*") {
            this.tokens.skip();
            const asToken = this.tokens.read();
            if (asToken?.type !== "identifier" || asToken.value !== "as") {
                this.fail("Expected 'as' after '*' in namespace import", this.tokenAt(asToken));
            }
            const namespaceToken = this.tokens.read();
            if (namespaceToken?.type !== "identifier") {
                this.fail("Expected namespace import name", this.tokenAt(namespaceToken));
            }
            namespaceImport = this.buildIdentifierFromToken(namespaceToken);
        } else if (hasMoreBindingsAfterDefault) {
            this.fail("Expected import bindings or module string after 'import'", this.tokenAt(nextToken));
        }

        const fromKeyword = this.tokens.read();
        if (fromKeyword?.type !== "identifier" || fromKeyword.value !== "from") {
            this.fail("Expected 'from' after import bindings", this.tokenAt(fromKeyword));
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
        if (defaultImport) {
            statement.defaultImport = defaultImport;
        }
        if (namespaceImport) {
            statement.namespaceImport = namespaceImport;
        }
        if (typeOnly) {
            statement.typeOnly = true;
        }
        return this.attachNodeBounds(statement, importKeyword, sourceToken);
    }

    private parseImportSpecifierList(): ImportSpecifier[] {
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

            let typeOnly = false;
            if (this.tokens.peek()?.type === "identifier" && this.tokens.peek()?.value === "type") {
                this.tokens.skip();
                typeOnly = true;
            }

            let nameToken = this.tokens.read();
            if (nameToken?.type !== "identifier") {
                this.fail("Expected imported symbol name", this.tokenAt(nameToken));
            }
            if (nameToken.value === "operator") {
                const parsedOperator = this.parseOperatorOverload();
                if (parsedOperator) {
                    nameToken = {
                        ...nameToken,
                        value: `operator${parsedOperator.operator}`,
                        range: { start: nameToken.range.start, end: parsedOperator.endToken.range.end }
                    };
                }
            }
            const imported = this.buildIdentifierFromToken(nameToken);
            let local: Identifier | undefined;
            if (this.tokens.peek()?.type === "identifier" && this.tokens.peek()?.value === "as") {
                this.tokens.skip();
                const localToken = this.tokens.read();
                if (localToken?.type !== "identifier") {
                    this.fail("Expected local import name after 'as'", this.tokenAt(localToken));
                }
                local = this.buildIdentifierFromToken(localToken);
            }
            const specifier: ImportSpecifier = {
                kind: "ImportSpecifier",
                imported
            };
            if (local) {
                specifier.local = local;
            }
            if (typeOnly) {
                specifier.typeOnly = true;
            }
            specifiers.push(
                this.attachNodeBounds(
                    specifier,
                    nameToken,
                    local?.lastToken ?? nameToken
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

        return specifiers;
    }

    private parseEnumStatement(declared: boolean = false): EnumStatement {
        const startToken = this.tokens.peek();
        let isConstEnum = false;
        if (this.tokens.peek()?.type === "identifier" && this.tokens.peek()?.value === "const") {
            isConstEnum = true;
            this.tokens.skip();
        }

        const enumKeyword = this.tokens.read();
        if (enumKeyword?.type !== "identifier" || enumKeyword.value !== "enum") {
            this.fail("Expected enum declaration statement", this.tokenAt(enumKeyword));
        }

        const enumNameToken = this.tokens.read();
        if (enumNameToken?.type !== "identifier") {
            this.fail("Expected enum name after 'enum'", this.tokenAt(enumNameToken));
        }

        const openBrace = this.tokens.read();
        if (openBrace?.type !== "symbol" || openBrace.value !== "{") {
            this.fail("Expected '{' to start enum body", this.tokenAt(openBrace));
        }

        const members: EnumMember[] = [];
        while (this.tokens.hasMore) {
            const token = this.tokens.peek();
            if (isEofToken(token)) {
                this.fail("Expected '}' to close enum body", this.tokenAt(openBrace), "block");
            }
            if (token?.type === "symbol" && token.value === "}") {
                this.tokens.skip();
                const statement: EnumStatement = {
                    kind: "EnumStatement",
                    name: this.buildIdentifierFromToken(enumNameToken),
                    members
                };
                if (declared) {
                    statement.declared = true;
                }
                if (isConstEnum) {
                    statement.const = true;
                }
                return this.attachNodeBounds(statement, startToken ?? enumKeyword, this.getLastReadToken() ?? enumNameToken);
            }

            if (token?.type === "symbol" && (token.value === "," || token.value === ";")) {
                this.tokens.skip();
                continue;
            }

            const nameToken = this.tokens.read();
            if (nameToken?.type !== "identifier") {
                this.fail("Expected enum member name", this.tokenAt(nameToken));
            }
            let initializer: Expr | undefined;
            if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === "=") {
                this.tokens.skip();
                initializer = this.parseAssignment();
            }
            const member: EnumMember = {
                kind: "EnumMember",
                name: this.buildIdentifierFromToken(nameToken)
            };
            if (initializer) {
                member.initializer = initializer;
            }
            members.push(this.attachNodeBounds(member, nameToken, this.getLastReadToken() ?? nameToken));

            const separator = this.tokens.peek();
            if (separator?.type === "symbol" && (separator.value === "," || separator.value === ";")) {
                this.tokens.skip();
                continue;
            }
            if (separator?.type === "symbol" && separator.value === "}") {
                continue;
            }
            this.fail("Expected ',' or '}' after enum member", this.tokenAt(separator));
        }

        this.fail("Expected '}' to close enum body", this.tokenAt(openBrace), "block");
    }

    private parseDeclareEnumStatement(): EnumStatement {
        const declareKeyword = this.tokens.read();
        if (declareKeyword?.type !== "identifier" || declareKeyword.value !== "declare") {
            this.fail("Expected 'declare' before enum declaration", this.tokenAt(declareKeyword));
        }
        const statement = this.parseEnumStatement(true);
        statement.declared = true;
        return this.attachNodeBounds(statement, declareKeyword, statement.lastToken ?? this.getLastReadToken() ?? declareKeyword);
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
        const firstKeyword = this.tokens.read();
        let declarationKeyword = firstKeyword;
        let isAsyncFunction = false;
        let isSyncFunction = false;
        if (firstKeyword?.type === "identifier" && firstKeyword.value === "async") {
            isAsyncFunction = true;
            declarationKeyword = this.tokens.read();
        } else if (firstKeyword?.type === "identifier" && firstKeyword.value === "sync") {
            isSyncFunction = true;
            declarationKeyword = this.tokens.read();
        }
        if (
            declarationKeyword?.type !== "identifier" ||
            !FUNCTION_DECLARATION_KEYWORDS.includes(declarationKeyword.value as FunctionDeclarationKind)
        ) {
            this.fail("Expected function declaration statement", this.tokenAt(declarationKeyword));
        }

        let isGeneratorFunction = false;
        if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === "*") {
            this.tokens.skip();
            isGeneratorFunction = true;
        }

        // Leading type parameters introduce a generic extension declaration, e.g.
        // `fun <T> Array<T>.demo()`. They are merged with any type parameters that
        // appear after the method name.
        const leadingTypeParameters = this.parseTypeParameterList();

        const firstNameToken = this.tokens.read();
        if (firstNameToken?.type !== "identifier") {
            this.fail("Expected function name after declaration keyword", this.tokenAt(firstNameToken));
        }

        let receiverType: Identifier | undefined;
        let receiverTypeArguments: Identifier[] | undefined;
        let overloadedOperator: OverloadableOperator | undefined;
        let nameToken = firstNameToken;
        if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === "<") {
            const parsedReceiverTypeArguments = this.tryParseReceiverTypeArguments();
            if (parsedReceiverTypeArguments) {
                receiverTypeArguments = parsedReceiverTypeArguments;
            }
        }
        if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === ".") {
            this.tokens.skip();
            receiverType = this.buildIdentifierFromToken(firstNameToken);
            nameToken = this.tokens.read()!;
            if (nameToken.type !== "identifier") {
                this.fail("Expected extension method name after receiver type", this.tokenAt(nameToken));
            }
            if (nameToken.value === "operator") {
                const parsedOperator = this.parseOperatorOverload();
                if (!parsedOperator) {
                    this.fail("Expected overloadable operator after 'operator'", this.tokenAt(this.tokens.peek()));
                }
                overloadedOperator = parsedOperator.operator;
                nameToken = {
                    ...nameToken,
                    value: `operator${overloadedOperator}`,
                    range: { start: nameToken.range.start, end: parsedOperator.endToken.range.end }
                };
            }
        }

        const typeParameters = [...leadingTypeParameters, ...this.parseTypeParameterList()];

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

        let missingBody = false;
        let body: BlockStatement;
        if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === "{") {
            body = this.parseBlockStatement();
        } else if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === "=>") {
            body = this.parseExpressionBodyAsBlock();
        } else {
            missingBody = true;
            body = this.attachNodeBounds(
                { kind: "BlockStatement", body: [] } as BlockStatement,
                nameToken,
                this.getLastReadToken() ?? nameToken
            );
            const maybeSemicolon = this.tokens.peek();
            if (maybeSemicolon?.type === "symbol" && maybeSemicolon.value === ";") {
                this.tokens.skip();
            }
        }

        const statement: FunctionStatement = {
            kind: "FunctionStatement",
            declarationKind: declarationKeyword.value as FunctionDeclarationKind,
            name: this.buildIdentifierFromToken(nameToken),
            parameters,
            body
        };
        if (receiverType) {
            statement.receiverType = receiverType;
        }
        if (receiverTypeArguments && receiverTypeArguments.length > 0) {
            statement.receiverTypeArguments = receiverTypeArguments;
        }
        if (overloadedOperator) {
            statement.operator = overloadedOperator;
        }
        if (isAsyncFunction) {
            statement.async = true;
        }
        if (isSyncFunction) {
            statement.sync = true;
        }
        if (isGeneratorFunction) {
            statement.generator = true;
        }
        if (missingBody) {
            statement.missingBody = true;
        }
        if (typeParameters.length > 0) {
            statement.typeParameters = typeParameters;
        }
        this.attachNonEnumerableToken(statement, "parametersCloseParen", closeParen);
        if (returnType) {
            statement.returnType = returnType;
        }

        return this.attachNodeBounds(statement, declarationKeyword, this.getLastReadToken() ?? declarationKeyword);
    }

    private parseExpressionBodyAsBlock(): BlockStatement {
        const arrowToken = this.tokens.read();
        if (arrowToken?.type !== "symbol" || arrowToken.value !== "=>") {
            this.fail("Expected '=>' before shorthand function body", this.tokenAt(arrowToken));
        }

        const expression = this.parseAssignment();
        const returnStatement = this.attachNodeBounds(
            {
                kind: "ReturnStatement",
                expression
            } as ReturnStatement,
            expression.firstToken ?? arrowToken,
            expression.lastToken ?? this.getLastReadToken() ?? arrowToken
        );
        const block = this.attachNodeBounds(
            {
                kind: "BlockStatement",
                body: [returnStatement]
            } as BlockStatement,
            arrowToken,
            expression.lastToken ?? this.getLastReadToken() ?? arrowToken
        );

        if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === ";") {
            this.tokens.skip();
        }

        return block;
    }

    private parseDeclareFunctionStatement(): FunctionStatement {
        const declareKeyword = this.tokens.read();
        if (declareKeyword?.type !== "identifier" || declareKeyword.value !== "declare") {
            this.fail("Expected 'declare' before function declaration", this.tokenAt(declareKeyword));
        }

        const statement = this.parseFunctionStatement();
        statement.declared = true;
        return this.attachNodeBounds(statement, declareKeyword, statement.lastToken ?? this.getLastReadToken() ?? declareKeyword);
    }

    private parseDeclareTypeAliasStatement(): TypeAliasStatement {
        const declareKeyword = this.tokens.read();
        if (declareKeyword?.type !== "identifier" || declareKeyword.value !== "declare") {
            this.fail("Expected 'declare' before type alias declaration", this.tokenAt(declareKeyword));
        }

        const statement = this.parseTypeAliasStatement(true);
        statement.declared = true;
        return this.attachNodeBounds(statement, declareKeyword, statement.lastToken ?? this.getLastReadToken() ?? declareKeyword);
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
        if (classKeyword?.type !== "identifier" || (classKeyword.value !== "class" && !this.isAbstractClassStart())) {
            this.fail("Expected 'class' or 'abstract class' after 'declare'", this.tokenAt(classKeyword));
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

    private parseNamespaceStatement(declared: boolean): NamespaceStatement {
        const declareKeyword = declared ? this.tokens.read() : undefined;
        if (declared && (declareKeyword?.type !== "identifier" || declareKeyword.value !== "declare")) {
            this.fail("Expected 'declare' before namespace declaration", this.tokenAt(declareKeyword));
        }

        if (declared && this.tokens.peek()?.type === "identifier" && this.tokens.peek()?.value === "global") {
            return this.parseDeclareGlobalStatement(declareKeyword);
        }

        const namespaceKeyword = this.tokens.read();
        if (
            namespaceKeyword?.type !== "identifier" ||
            (namespaceKeyword.value !== "namespace" && namespaceKeyword.value !== "module")
        ) {
            this.fail("Expected 'namespace' or 'module' after 'declare'", this.tokenAt(namespaceKeyword));
        }

        const namespaceNameToken = this.tokens.read();
        const isExternalModuleName = declared && namespaceKeyword.value === "module" && namespaceNameToken?.type === "string";
        if (namespaceNameToken?.type !== "identifier" && !isExternalModuleName) {
            this.fail("Expected namespace or module name after declaration keyword", this.tokenAt(namespaceNameToken));
        }

        const names: Identifier[] = [];
        let externalModuleName: StringLiteral | undefined;
        if (namespaceNameToken?.type === "identifier") {
            names.push(this.buildIdentifierFromToken(namespaceNameToken));
            while (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === ".") {
                this.tokens.skip();
                const segmentToken = this.tokens.read();
                if (segmentToken?.type !== "identifier") {
                    this.fail("Expected identifier after '.' in namespace name", this.tokenAt(segmentToken));
                }
                names.push(this.buildIdentifierFromToken(segmentToken));
            }
        } else if (namespaceNameToken?.type === "string") {
            externalModuleName = this.attachNodeBounds(
                { kind: "StringLiteral", value: namespaceNameToken.value } as StringLiteral,
                namespaceNameToken,
                namespaceNameToken
            );
        }

        const body = declared ? this.parseAmbientNamespaceBody() : this.parseBlockStatement();
        if (declared) {
            this.markAmbientDeclarations(body.body);
        }

        if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === ";") {
            this.tokens.skip();
        }

        const statement: NamespaceStatement = {
            kind: "NamespaceStatement",
            ...(declared ? { declared: true } : {}),
            declarationKind: namespaceKeyword.value,
            ...(names.length > 0 ? { names } : {}),
            ...(externalModuleName ? { externalModuleName } : {}),
            body
        };
        const firstToken = declareKeyword ?? namespaceKeyword;
        return this.attachNodeBounds(statement, firstToken, this.getLastReadToken() ?? firstToken);
    }

    private parseDeclareGlobalStatement(declareKeyword: Token | undefined): NamespaceStatement {
        const globalKeyword = this.tokens.read();
        if (globalKeyword?.type !== "identifier" || globalKeyword.value !== "global") {
            this.fail("Expected 'global' after 'declare'", this.tokenAt(globalKeyword));
        }

        const body = this.parseAmbientNamespaceBody();
        this.markAmbientDeclarations(body.body);

        if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === ";") {
            this.tokens.skip();
        }

        const statement: NamespaceStatement = {
            kind: "NamespaceStatement",
            declared: true,
            globalAugmentation: true,
            declarationKind: "namespace",
            body
        };
        return this.attachNodeBounds(statement, declareKeyword ?? globalKeyword, this.getLastReadToken() ?? globalKeyword);
    }

    private parseAmbientNamespaceBody(): BlockStatement {
        const bodyStartOffset = this.tokens.offset;
        const openBrace = this.tokens.read();
        if (openBrace?.type !== "symbol" || openBrace.value !== "{") {
            this.fail("Expected '{' to start namespace body", this.tokenAt(openBrace));
        }

        let depth = 1;
        let closeBrace: Token | undefined;
        while (this.tokens.hasMore) {
            const token = this.tokens.read();
            if (token?.type !== "symbol") continue;
            if (token.value === "{") depth += 1;
            if (token.value === "}") {
                depth -= 1;
                if (depth === 0) {
                    closeBrace = token;
                    break;
                }
            }
        }
        if (!closeBrace) {
            this.fail("Expected '}' to close namespace body", this.tokenAt(openBrace), "block");
        }

        // Parse a detached token slice so unsupported declaration-file members can be
        // recovered without moving the surrounding file parser out of the namespace.
        const bodyTokens = this.tokens.items.slice(bodyStartOffset, this.tokens.offset);
        const nestedParser = new Parser(new ListReader(bodyTokens), { language: this.language });
        const parsed = nestedParser.parseStatement();
        if (parsed?.kind === "BlockStatement") {
            return parsed as BlockStatement;
        }
        return this.attachNodeBounds({ kind: "BlockStatement", body: [] } as BlockStatement, openBrace, closeBrace);
    }

    private markAmbientDeclarations(statements: Statement[]): void {
        for (const statement of statements) {
            const declaration = statement.kind === "ExportStatement"
                ? (statement as ExportStatement).declaration
                : statement;
            if (!declaration) continue;
            if (declaration.kind === "VarStatement" || declaration.kind === "FunctionStatement" ||
                declaration.kind === "ClassStatement" || declaration.kind === "InterfaceStatement" ||
                declaration.kind === "TypeAliasStatement" || declaration.kind === "EnumStatement" ||
                declaration.kind === "AnnotationStatement" ||
                declaration.kind === "NamespaceStatement") {
                (declaration as { declared?: boolean }).declared = true;
            }
        }
    }

    private parseAnnotationParameters(): FunctionParameter[] {
        const parameters = this.parseClassPrimaryConstructorParameters();
        return parameters.map((parameter) => {
            const functionParameter: FunctionParameter = {
                kind: "FunctionParameter",
                name: parameter.name
            };
            if (parameter.declarationKind === "val" || parameter.declarationKind === "const") {
                functionParameter.accessModifier = "public";
                functionParameter.readonly = true;
            } else if (parameter.declarationKind === "var" || parameter.declarationKind === "let") {
                functionParameter.accessModifier = "public";
            }
            if (parameter.typeAnnotation) {
                functionParameter.typeAnnotation = parameter.typeAnnotation;
            }
            if (parameter.defaultValue) {
                functionParameter.defaultValue = parameter.defaultValue;
            }
            return this.attachNodeBounds(functionParameter, parameter.firstToken, parameter.lastToken);
        });
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

    private parseFunctionParameters(allowParameterProperties: boolean = false): FunctionParameter[] {
        const parameters: FunctionParameter[] = [];
        if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === ")") {
            return parameters;
        }

        while (this.tokens.hasMore) {
            if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === ")") {
                break;
            }
            let parameterAccessModifier: FunctionParameter["accessModifier"] | undefined;
            let parameterReadonly = false;
            let propertyModifierToken: Token | undefined;
            while (this.tokens.peek()?.type === "identifier") {
                const modifier = this.tokens.peek()!.value;
                if (modifier === "public" || modifier === "private" || modifier === "protected") {
                    propertyModifierToken ??= this.tokens.peek();
                    parameterAccessModifier = this.tokens.read()!.value as FunctionParameter["accessModifier"];
                    continue;
                }
                if (modifier === "readonly") {
                    propertyModifierToken ??= this.tokens.peek();
                    parameterReadonly = true;
                    this.tokens.skip();
                    continue;
                }
                break;
            }
            if (propertyModifierToken && !allowParameterProperties) {
                this.fail("Parameter properties are only allowed in constructors", this.tokenAt(propertyModifierToken));
            }

            let parameterRest = false;
            const maybeRestToken = this.tokens.peek();
            if (maybeRestToken?.type === "symbol" && maybeRestToken.value === "...") {
                this.tokens.skip();
                parameterRest = true;
            }

            const parameterNameToken = this.tokens.peek();
            const parameterName = this.parseBindingName();
            if (propertyModifierToken && parameterName.kind !== "Identifier") {
                this.fail("A parameter property must use an identifier name", this.tokenAt(parameterNameToken));
            }

            let parameterOptional = false;
            if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === "?") {
                if (parameterRest) {
                    this.fail("Rest parameter cannot be optional", this.tokenAt(this.tokens.peek()));
                }
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
                parameterDefaultValue = this.parseAssignment();
            }

            const parameter: FunctionParameter = {
                kind: "FunctionParameter",
                name: parameterName
            };
            if (parameterAccessModifier) {
                parameter.accessModifier = parameterAccessModifier;
            }
            if (parameterReadonly) {
                parameter.readonly = true;
            }
            if (parameterName.kind === "Identifier" && parameterName.name === "this") {
                if (propertyModifierToken) {
                    this.fail("A this parameter cannot be a parameter property", this.tokenAt(propertyModifierToken));
                }
                if (parameters.length !== 0 || parameterRest || parameterOptional || parameterDefaultValue) {
                    this.fail("A this parameter must be the first non-rest parameter without optional/default syntax", this.tokenAt(parameterNameToken));
                }
                parameter.thisParameter = true;
            }
            if (parameterRest) {
                if (propertyModifierToken) {
                    this.fail("A parameter property cannot be a rest parameter", this.tokenAt(propertyModifierToken));
                }
                parameter.rest = true;
            }
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
                if (parameterRest) {
                    this.fail("Rest parameter must be last", this.tokenAt(separator));
                }
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

    private operatorOverloadFromToken(token: Token | undefined): BinaryExpression["operator"] | undefined {
        if (token?.type !== "symbol") {
            return undefined;
        }
        const candidate = token.value as BinaryExpression["operator"];
        return candidate in BINARY_OPERATOR_INFO && candidate !== "in" && candidate !== "instanceof" ? candidate : undefined;
    }

    private parseOperatorOverload(): { operator: OverloadableOperator; endToken: Token } | undefined {
        const token = this.tokens.peek();
        if (token?.type !== "symbol") {
            return undefined;
        }
        if (token.value === "[") {
            this.tokens.skip();
            const closeBracket = this.tokens.read();
            if (closeBracket?.type !== "symbol" || closeBracket.value !== "]") {
                this.fail("Expected ']' after 'operator['", this.tokenAt(closeBracket));
            }
            if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === "=") {
                const equalsToken = this.tokens.read()!;
                return { operator: "[]=", endToken: equalsToken };
            }
            return { operator: "[]", endToken: closeBracket };
        }
        const operator = this.operatorOverloadFromToken(token);
        if (!operator) {
            return undefined;
        }
        this.tokens.skip();
        return { operator, endToken: token };
    }

    private parseClassMember(allowSignatureOnly: boolean = false): ClassMember[] {
        const annotations: AnnotationApplication[] = [];
        while (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === "@") {
            annotations.push(this.parseAnnotationApplication());
        }
        const members = this.parseClassMemberDeclaration(allowSignatureOnly);
        if (annotations.length > 0) {
            for (const member of members) {
                member.annotations = [...(member.annotations ?? []), ...annotations];
            }
            const firstMember = members[0];
            if (firstMember) {
                this.attachNodeBounds(firstMember, annotations[0]?.firstToken, firstMember.lastToken);
            }
        }
        return members;
    }

    private parseClassMemberDeclaration(allowSignatureOnly: boolean = false): ClassMember[] {
        const firstToken = this.tokens.peek();
        let memberStartToken = firstToken;
        let isOverrideMember = false;
        let accessModifier: ClassMember["accessModifier"] | undefined;
        let isReadonlyMember = false;
        let readonlyToken: Token | undefined;
        let isStaticMember = false;
        let isAbstractMember = false;
        let isAsyncMember = false;
        let isSyncMember = false;

        while (this.tokens.peek()?.type === "identifier" && isClassMemberModifier(this.tokens.peek()!.value)) {
            const peekValue = this.tokens.peek()!.value;
            // 'async'/'sync' followed by ':' or '?' means it is the member name, not a modifier
            if ((peekValue === "async" || peekValue === "sync") &&
                (this.peekToken(1)?.value === ":" || this.peekToken(1)?.value === "?")) {
                break;
            }
            if (this.classMemberModifierLooksLikeName(peekValue)) {
                break;
            }
            const modifierToken = this.tokens.read()!;
            memberStartToken ??= modifierToken;
            if (modifierToken.value === "override") {
                isOverrideMember = true;
            } else if (modifierToken.value === "public" || modifierToken.value === "private" || modifierToken.value === "protected") {
                accessModifier = modifierToken.value;
            } else if (modifierToken.value === "readonly") {
                isReadonlyMember = true;
                readonlyToken = modifierToken;
            } else if (modifierToken.value === "static") {
                isStaticMember = true;
            } else if (modifierToken.value === "abstract") {
                isAbstractMember = true;
            } else if (modifierToken.value === "async") {
                isAsyncMember = true;
            } else if (modifierToken.value === "sync") {
                isSyncMember = true;
            }
        }

        let fieldDeclarationKind: VariableDeclarationKind | undefined;
        let functionDeclarationKeyword: Token | undefined;
        if (this.language === "vexa" && this.tokens.peek()?.type === "identifier") {
            const keywordValue = this.tokens.peek()!.value;
            if (this.isVariableDeclarationKeyword(keywordValue)) {
                const declarationKeyword = this.tokens.read()!;
                memberStartToken ??= declarationKeyword;
                fieldDeclarationKind = declarationKeyword.value as VariableDeclarationKind;
                if (fieldDeclarationKind === "val" || fieldDeclarationKind === "const") {
                    isReadonlyMember = true;
                    readonlyToken = declarationKeyword;
                }
            } else if (this.isFunctionDeclarationKeyword(keywordValue)) {
                functionDeclarationKeyword = this.tokens.read()!;
                memberStartToken ??= functionDeclarationKeyword;
            }
        }

        let accessorKind: ClassMethodMember["accessorKind"] | undefined;
        let accessorKeywordToken: Token | undefined;
        if (
            this.tokens.peek()?.type === "identifier" &&
            (this.tokens.peek()?.value === "get" || this.tokens.peek()?.value === "set") &&
            this.tokens.items[this.tokens.offset + 1]?.type === "identifier"
        ) {
            accessorKeywordToken = this.tokens.read()!;
            accessorKind = accessorKeywordToken.value as ClassMethodMember["accessorKind"];
        }

        let isGeneratorMember = false;
        if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === "*") {
            this.tokens.skip();
            isGeneratorMember = true;
        }

        let computedMemberKey: Expr | undefined;
        let computedMemberCloseBracket: Token | undefined;
        let memberNameToken = this.tokens.read();
        if (memberNameToken?.type === "symbol" && memberNameToken.value === "[") {
            computedMemberKey = this.parseExpressionOrThrow();
            computedMemberCloseBracket = this.tokens.read();
            if (computedMemberCloseBracket?.type !== "symbol" || computedMemberCloseBracket.value !== "]") {
                this.fail("Expected ']' after computed class member name", this.tokenAt(computedMemberCloseBracket));
            }
            memberNameToken = undefined;
        }
        const privateMemberNameToken = memberNameToken?.type === "symbol" && memberNameToken.value === "#"
            ? this.tokens.read()
            : null;
        const effectiveMemberNameToken =
            memberNameToken?.type === "symbol" && memberNameToken.value === "#" && privateMemberNameToken?.type === "identifier"
                ? {
                    ...privateMemberNameToken,
                    value: `#${privateMemberNameToken.value}`,
                    range: {
                        start: memberNameToken.range.start,
                        end: privateMemberNameToken.range.end
                    }
                }
                : memberNameToken;
        if (!computedMemberKey && effectiveMemberNameToken?.type !== "identifier") {
            this.fail("Expected class member name", this.tokenAt(memberNameToken));
        }

        let overloadedOperator: OverloadableOperator | undefined;
        let resolvedMemberNameToken = effectiveMemberNameToken;
        if (!computedMemberKey && effectiveMemberNameToken?.value === "operator") {
            const parsedOperator = this.parseOperatorOverload();
            if (!parsedOperator) {
                this.fail("Expected overloadable operator after 'operator'", this.tokenAt(this.tokens.peek()));
            }
            overloadedOperator = parsedOperator.operator;
            resolvedMemberNameToken = {
                ...effectiveMemberNameToken,
                type: effectiveMemberNameToken.type,
                value: `operator${overloadedOperator}`,
                range: {
                    start: effectiveMemberNameToken.range.start,
                    end: parsedOperator.endToken.range.end
                }
            };
        }

        const resolvedMemberName = computedMemberKey
            ? this.buildComputedMemberIdentifier(computedMemberKey, memberStartToken ?? firstToken, computedMemberCloseBracket!)
            : this.buildIdentifierFromToken(resolvedMemberNameToken!);

        let optional = false;
        let definiteAssignment = false;
        if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === "?") {
            this.tokens.skip();
            optional = true;
        } else if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === "!") {
            this.tokens.skip();
            definiteAssignment = true;
        }

        const methodTypeParameters = this.parseTypeParameterList();
        if ((methodTypeParameters.length > 0) || (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === "(")) {
            if (definiteAssignment) {
                this.fail("Definite assignment assertions are only allowed on class fields", this.tokenAt(this.getLastReadToken()));
            }
            if (!(this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === "(")) {
                this.fail("Expected '(' after method type parameters", this.tokenAt(this.tokens.peek()));
            }
            this.tokens.skip();
            const parameters = this.parseFunctionParameters(resolvedMemberName.name === "constructor");

            const closeParen = this.tokens.read();
            if (closeParen?.type !== "symbol" || closeParen.value !== ")") {
                this.fail("Expected ')' after method parameters", this.tokenAt(closeParen));
            }

            let returnType: Identifier | undefined;
            if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === ":") {
                this.tokens.skip();
                returnType = this.parseTypeAnnotationNode();
            }

            if (
                this.tokens.peek()?.type !== "symbol" ||
                (this.tokens.peek()?.value !== "{" && this.tokens.peek()?.value !== "=>")
            ) {
                const signatureOnlyBody = this.attachNodeBounds(
                    { kind: "BlockStatement", body: [] } as BlockStatement,
                    memberNameToken,
                    this.getLastReadToken() ?? memberNameToken
                );

                const signatureOnlyMethod: ClassMethodMember = {
                    kind: "ClassMethodMember",
                    name: resolvedMemberName,
                    parameters,
                    body: signatureOnlyBody
                };
                if (computedMemberKey) {
                    signatureOnlyMethod.computed = true;
                    signatureOnlyMethod.computedKey = computedMemberKey;
                }
                if (overloadedOperator) {
                    signatureOnlyMethod.operator = overloadedOperator;
                }
                if (functionDeclarationKeyword) {
                    signatureOnlyMethod.declarationKind = functionDeclarationKeyword.value as FunctionDeclarationKind;
                    this.attachNonEnumerableToken(signatureOnlyMethod, "declarationKeywordToken", functionDeclarationKeyword);
                }
                if (accessorKind) {
                    this.attachNonEnumerableToken(signatureOnlyMethod, "accessorToken", accessorKeywordToken!);
                    signatureOnlyMethod.accessorKind = accessorKind;
                }
                if (isAsyncMember) {
                    signatureOnlyMethod.async = true;
                }
                if (isSyncMember) {
                    signatureOnlyMethod.sync = true;
                }
                if (isGeneratorMember) {
                    signatureOnlyMethod.generator = true;
                }
                this.applyClassMemberModifiers(signatureOnlyMethod, {
                    override: isOverrideMember,
                    accessModifier,
                    readonly: isReadonlyMember,
                    static: isStaticMember,
                    abstract: isAbstractMember
                });
                if (readonlyToken) {
                    this.attachNonEnumerableToken(signatureOnlyMethod, "readonlyToken", readonlyToken);
                }
                if (optional) {
                    signatureOnlyMethod.optional = true;
                }
                if (!allowSignatureOnly && !isAbstractMember) {
                    signatureOnlyMethod.missingBody = true;
                }
                if (methodTypeParameters.length > 0) {
                    signatureOnlyMethod.typeParameters = methodTypeParameters;
                }
                this.attachNonEnumerableToken(signatureOnlyMethod, "parametersCloseParen", closeParen);
                if (returnType) {
                    signatureOnlyMethod.returnType = returnType;
                }

                return [this.attachNodeBounds(signatureOnlyMethod, memberStartToken, this.getLastReadToken() ?? memberNameToken)];
            }

            const methodMember: ClassMethodMember = {
                kind: "ClassMethodMember",
                name: resolvedMemberName,
                parameters,
                body: this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === "=>"
                    ? this.parseExpressionBodyAsBlock()
                    : this.parseBlockStatement()
            };
            if (computedMemberKey) {
                methodMember.computed = true;
                methodMember.computedKey = computedMemberKey;
            }
            if (overloadedOperator) {
                methodMember.operator = overloadedOperator;
            }
            if (functionDeclarationKeyword) {
                methodMember.declarationKind = functionDeclarationKeyword.value as FunctionDeclarationKind;
                this.attachNonEnumerableToken(methodMember, "declarationKeywordToken", functionDeclarationKeyword);
            }
            if (accessorKind) {
                this.attachNonEnumerableToken(methodMember, "accessorToken", accessorKeywordToken!);
                methodMember.accessorKind = accessorKind;
            }
            if (isAsyncMember) {
                methodMember.async = true;
            }
            if (isSyncMember) {
                methodMember.sync = true;
            }
            if (isGeneratorMember) {
                methodMember.generator = true;
            }
            this.applyClassMemberModifiers(methodMember, {
                override: isOverrideMember,
                accessModifier,
                readonly: isReadonlyMember,
                static: isStaticMember,
                abstract: isAbstractMember
            });
            if (readonlyToken) {
                this.attachNonEnumerableToken(methodMember, "readonlyToken", readonlyToken);
            }
            if (optional) {
                methodMember.optional = true;
            }
            if (methodTypeParameters.length > 0) {
                methodMember.typeParameters = methodTypeParameters;
            }
            this.attachNonEnumerableToken(methodMember, "parametersCloseParen", closeParen);
            if (returnType) {
                methodMember.returnType = returnType;
            }

            return [this.attachNodeBounds(methodMember, memberStartToken, this.getLastReadToken() ?? memberNameToken)];
        }

        if (accessorKind) {
            this.fail("Expected '(' after accessor name", this.tokenAt(this.tokens.peek()));
        }

        let typeAnnotation: Identifier | undefined;
        if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === ":") {
            this.tokens.skip();
            typeAnnotation = this.parseTypeAnnotationNode();
        }

        if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === "=>") {
            const getterMember: ClassMethodMember = {
                kind: "ClassMethodMember",
                name: resolvedMemberName,
                parameters: [],
                body: this.parseExpressionBodyAsBlock(),
                accessorKind: "get"
            };
            this.applyClassMemberModifiers(getterMember, {
                override: isOverrideMember,
                accessModifier,
                readonly: isReadonlyMember,
                static: isStaticMember,
                abstract: isAbstractMember
            });
            if (typeAnnotation) {
                getterMember.returnType = typeAnnotation;
            }
            Object.defineProperty(getterMember, "getterShorthand", {
                value: true,
                enumerable: false,
                configurable: true,
                writable: true
            });

            return [this.attachNodeBounds(getterMember, memberStartToken, this.getLastReadToken() ?? memberNameToken)];
        }

        if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === "{") {
            this.tokens.skip(); // consume `{`
            const compoundGetters: ClassMethodMember[] = [];
            const compoundSetters: ClassMethodMember[] = [];

            while (this.tokens.hasMore) {
                const peekToken = this.tokens.peek();
                if (peekToken?.type === "symbol" && peekToken.value === "}") break;
                if (peekToken?.type === "symbol" && peekToken.value === ";") {
                    this.tokens.skip();
                    continue;
                }

                const subKeyword = this.tokens.read();
                if (subKeyword?.type !== "identifier" || (subKeyword.value !== "get" && subKeyword.value !== "set")) {
                    this.fail("Expected 'get' or 'set' inside accessor block", this.tokenAt(subKeyword));
                }

                if (subKeyword.value === "get") {
                    const getterBody = this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === "=>"
                        ? this.parseExpressionBodyAsBlock()
                        : this.parseBlockStatement();
                    const getterMember: ClassMethodMember = {
                        kind: "ClassMethodMember",
                        name: resolvedMemberName,
                        parameters: [],
                        body: getterBody,
                        accessorKind: "get"
                    };
                    if (typeAnnotation) {
                        getterMember.returnType = typeAnnotation;
                    }
                    this.applyClassMemberModifiers(getterMember, {
                        override: isOverrideMember, accessModifier,
                        readonly: isReadonlyMember, static: isStaticMember, abstract: isAbstractMember
                    });
                    this.attachNonEnumerableToken(getterMember, "accessorToken", subKeyword);
                    compoundGetters.push(this.attachNodeBounds(getterMember, subKeyword, this.getLastReadToken() ?? subKeyword));
                } else {
                    let setterParam: FunctionParameter;
                    if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === "(") {
                        this.tokens.skip();
                        const paramNameToken = this.tokens.read();
                        if (paramNameToken?.type !== "identifier") {
                            this.fail("Expected setter parameter name", this.tokenAt(paramNameToken));
                        }
                        let paramType: Identifier | undefined = typeAnnotation;
                        if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === ":") {
                            this.tokens.skip();
                            paramType = this.parseTypeAnnotationNode();
                        }
                        const closeParen = this.tokens.read();
                        if (closeParen?.type !== "symbol" || closeParen.value !== ")") {
                            this.fail("Expected ')' after setter parameter", this.tokenAt(closeParen));
                        }
                        const paramName = this.buildIdentifierFromToken(paramNameToken);
                        setterParam = this.attachNodeBounds(
                            { kind: "FunctionParameter", name: paramName } as FunctionParameter,
                            paramNameToken, this.getLastReadToken() ?? paramNameToken
                        );
                        if (paramType) {
                            setterParam.typeAnnotation = paramType;
                        }
                    } else {
                        const newValueIdent = this.attachNodeBounds(
                            { kind: "Identifier", name: "newValue" } as Identifier,
                            subKeyword, subKeyword
                        );
                        setterParam = this.attachNodeBounds(
                            { kind: "FunctionParameter", name: newValueIdent } as FunctionParameter,
                            subKeyword, subKeyword
                        );
                        if (typeAnnotation) {
                            setterParam.typeAnnotation = typeAnnotation;
                        }
                    }
                    const setterBody = this.parseBlockStatement();
                    const setterMember: ClassMethodMember = {
                        kind: "ClassMethodMember",
                        name: resolvedMemberName,
                        parameters: [setterParam],
                        body: setterBody,
                        accessorKind: "set"
                    };
                    this.applyClassMemberModifiers(setterMember, {
                        override: isOverrideMember, accessModifier,
                        readonly: isReadonlyMember, static: isStaticMember, abstract: isAbstractMember
                    });
                    this.attachNonEnumerableToken(setterMember, "accessorToken", subKeyword);
                    compoundSetters.push(this.attachNodeBounds(setterMember, subKeyword, this.getLastReadToken() ?? subKeyword));
                }

                this.consumeStatementSeparator("block", this.getLastReadToken());
            }

            const closeBrace = this.tokens.read();
            if (closeBrace?.type !== "symbol" || closeBrace.value !== "}") {
                this.fail("Expected '}' to close accessor block", this.tokenAt(this.tokens.peek()));
            }
            const compoundMembers = [...compoundGetters, ...compoundSetters];
            if (compoundMembers.length === 0) {
                this.fail("Accessor block must contain at least one 'get' or 'set'", this.tokenAt(closeBrace));
            }

            return compoundMembers;
        }

        let initializer: Expr | undefined;
        if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === "=") {
            this.tokens.skip();
            initializer = this.parseAssignment();
        }

        const fieldMember: ClassFieldMember = {
            kind: "ClassFieldMember",
            name: resolvedMemberName
        };
        this.applyClassMemberModifiers(fieldMember, {
            override: isOverrideMember,
            accessModifier,
            readonly: isReadonlyMember,
            static: isStaticMember,
            abstract: isAbstractMember
        });
        if (readonlyToken) {
            this.attachNonEnumerableToken(fieldMember, "readonlyToken", readonlyToken);
        }
        if (computedMemberKey) {
            fieldMember.computed = true;
            fieldMember.computedKey = computedMemberKey;
        }
        if (optional) {
            fieldMember.optional = true;
        }
        if (definiteAssignment) {
            fieldMember.definiteAssignment = true;
        }
        if (fieldDeclarationKind) {
            fieldMember.declarationKind = fieldDeclarationKind;
        }
        if (typeAnnotation) {
            fieldMember.typeAnnotation = typeAnnotation;
        }
        if (initializer) {
            fieldMember.initializer = initializer;
        }
        return [this.attachNodeBounds(fieldMember, memberStartToken, this.getLastReadToken() ?? memberNameToken)];
    }

    private classMemberModifierLooksLikeName(modifier: string): boolean {
        const nextValue = this.peekToken(1)?.value;
        if (!nextValue) {
            return false;
        }

        if (modifier === "async" || modifier === "sync") {
            return nextValue === ":" || nextValue === "?";
        }

        return nextValue === "(" ||
            nextValue === "<" ||
            nextValue === ":" ||
            nextValue === "?" ||
            nextValue === "!" ||
            nextValue === ";";
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

    private parseClassDelegateExpression(): Expr {
        if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === "{") {
            this.tokens.skip();
            return this.parseObjectLiteral();
        }
        return this.parseAssignment();
    }

    private parseClassStatement(declared: boolean = false): ClassStatement {
        return this.parseClassLike({ declared }) as ClassStatement;
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
            if (isEofToken(token)) {
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

            const anonymousCallTypeParameters = this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === "<"
                ? this.parseTypeParameterList()
                : [];
            if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === "(") {
                const openParen = this.tokens.read()!;
                const parameters = this.parseFunctionParameters();
                const closeParen = this.tokens.read();
                if (closeParen?.type !== "symbol" || closeParen.value !== ")") {
                    this.fail("Expected ')' after interface call signature parameters", this.tokenAt(closeParen));
                }

                let returnType: Identifier | undefined;
                if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === ":") {
                    this.tokens.skip();
                    returnType = this.parseTypeAnnotationNode();
                }

                const memberName = this.attachNodeBounds(
                    { kind: "Identifier", name: "call" } as Identifier,
                    openParen,
                    openParen
                );
                const member: InterfaceMethodMember = {
                    kind: "InterfaceMethodMember",
                    name: memberName,
                    parameters
                };
                if (anonymousCallTypeParameters.length > 0) {
                    member.typeParameters = anonymousCallTypeParameters;
                }
                if (returnType) {
                    member.returnType = returnType;
                }
                members.push(this.attachNodeBounds(member, openParen, this.getLastReadToken() ?? openParen));
                this.consumeStatementSeparator("block", this.getLastReadToken());
                continue;
            }
            if (anonymousCallTypeParameters.length > 0) {
                this.fail("Expected '(' after interface call signature type parameters", this.tokenAt(this.tokens.peek()));
            }

            if (this.isUnsupportedInterfaceMemberStart()) {
                this.skipUnsupportedInterfaceMember();
                this.consumeOptionalTypeMemberSeparator();
                continue;
            }

            if (
                this.tokens.peek()?.type === "identifier" &&
                this.tokens.peek()?.value === "readonly" &&
                this.peekToken(1) &&
                (
                    ["identifier", "string", "number"].includes(this.peekToken(1)!.type)
                    || (this.peekToken(1)!.type === "symbol" && this.peekToken(1)!.value === "[")
                )
            ) {
                this.tokens.skip();
            }

            let propertyDeclarationKind: VariableDeclarationKind | undefined;
            let functionDeclarationKeyword: Token | undefined;
            if (this.language === "vexa" && this.tokens.peek()?.type === "identifier") {
                const keywordValue = this.tokens.peek()!.value;
                if (this.isVariableDeclarationKeyword(keywordValue)) {
                    propertyDeclarationKind = this.tokens.read()!.value as VariableDeclarationKind;
                } else if (this.isFunctionDeclarationKeyword(keywordValue)) {
                    functionDeclarationKeyword = this.tokens.read()!;
                }
            }

            let accessorKind: "get" | "set" | undefined;
            let memberNameToken = this.tokens.read();
            let computedMemberKey: Expr | undefined;
            let computedMemberCloseBracket: Token | undefined;
            let interfaceIndexSignatureType: Identifier | undefined;
            const interfaceMemberStartToken = memberNameToken;
            if (memberNameToken?.type === "symbol" && memberNameToken.value === "[") {
                const indexParameterToken = this.tokens.peek();
                const indexColonToken = this.peekToken(1);
                if (
                    indexParameterToken?.type === "identifier" &&
                    indexColonToken?.type === "symbol" &&
                    indexColonToken.value === ":"
                ) {
                    this.tokens.skip();
                    this.tokens.skip();
                    interfaceIndexSignatureType = this.parseTypeAnnotationNode();
                    computedMemberCloseBracket = this.tokens.read();
                    if (computedMemberCloseBracket?.type !== "symbol" || computedMemberCloseBracket.value !== "]") {
                        this.fail("Expected ']' after interface index signature", this.tokenAt(computedMemberCloseBracket));
                    }
                } else {
                    computedMemberKey = this.parseExpressionOrThrow();
                    computedMemberCloseBracket = this.tokens.read();
                    if (computedMemberCloseBracket?.type !== "symbol" || computedMemberCloseBracket.value !== "]") {
                        this.fail("Expected ']' after computed interface member name", this.tokenAt(computedMemberCloseBracket));
                    }
                }
                memberNameToken = undefined;
            }
            if (
                memberNameToken?.type === "identifier" &&
                (memberNameToken.value === "get" || memberNameToken.value === "set") &&
                this.tokens.peek() &&
                ["identifier", "string", "number"].includes(this.tokens.peek()!.type)
            ) {
                accessorKind = memberNameToken.value as "get" | "set";
                memberNameToken = this.tokens.read();
            }
            if (
                !computedMemberKey &&
                !interfaceIndexSignatureType &&
                (!memberNameToken || !["identifier", "string", "number"].includes(memberNameToken.type))
            ) {
                this.fail("Expected interface member name", this.tokenAt(memberNameToken));
            }
            let memberName = interfaceIndexSignatureType
                ? `[${interfaceIndexSignatureType.name}]`
                : computedMemberKey
                    ? `[${this.computedMemberKeyText(computedMemberKey)}]`
                    : typeTokenText(memberNameToken!);
            if (
                !computedMemberKey &&
                !interfaceIndexSignatureType &&
                memberNameToken?.type === "identifier" &&
                memberNameToken.value === "abstract" &&
                this.tokens.peek()?.type === "identifier" &&
                this.tokens.peek()?.value === "new"
            ) {
                memberNameToken = this.tokens.read()!;
                memberName = "constructor";
            } else if (!computedMemberKey && !interfaceIndexSignatureType && memberNameToken?.type === "identifier" && memberNameToken.value === "new") {
                memberName = "constructor";
            }
            let optionalMember = false;
            if (this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === "?") {
                this.tokens.skip();
                optionalMember = true;
            }

            const methodTypeParameters = this.parseTypeParameterList();
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
                    name: computedMemberKey
                        ? this.buildComputedMemberIdentifier(computedMemberKey, computedMemberKey.firstToken, computedMemberCloseBracket!)
                        : this.attachNodeBounds({ kind: "Identifier", name: memberName } as Identifier, memberNameToken, memberNameToken),
                    parameters
                };
                if (computedMemberKey) {
                    member.computed = true;
                    member.computedKey = computedMemberKey;
                }
                if (functionDeclarationKeyword) {
                    member.declarationKind = functionDeclarationKeyword.value as FunctionDeclarationKind;
                    this.attachNonEnumerableToken(member, "declarationKeywordToken", functionDeclarationKeyword);
                }
                if (accessorKind) {
                    member.accessorKind = accessorKind;
                }
                if (optionalMember) {
                    member.optional = true;
                }
                if (methodTypeParameters.length > 0) {
                    member.typeParameters = methodTypeParameters;
                }
                if (returnType) {
                    member.returnType = returnType;
                }
                members.push(this.attachNodeBounds(member, memberNameToken, this.getLastReadToken() ?? memberNameToken));
                this.consumeStatementSeparator("block", this.getLastReadToken());
                continue;
            }

            if (computedMemberKey) {
                this.fail("Computed interface properties are not supported; computed interface members must be methods", this.tokenAt(computedMemberKey.firstToken));
            }

            if (methodTypeParameters.length > 0) {
                this.fail("Expected '(' after interface method type parameters", this.tokenAt(this.tokens.peek()));
            }

            if (!(this.tokens.peek()?.type === "symbol" && this.tokens.peek()?.value === ":")) {
                this.fail("Expected ':' after interface property name", this.tokenAt(this.tokens.peek()));
            }
            this.tokens.skip();
            const propertyType = this.parseTypeAnnotationNode();
            const propertyMember: InterfacePropertyMember = {
                kind: "InterfacePropertyMember",
                name: this.attachNodeBounds(
                    { kind: "Identifier", name: memberName } as Identifier,
                    interfaceIndexSignatureType?.firstToken ?? memberNameToken,
                    interfaceIndexSignatureType?.lastToken ?? memberNameToken
                ),
                typeAnnotation: propertyType
            };
            if (propertyDeclarationKind) {
                propertyMember.declarationKind = propertyDeclarationKind;
            }
            if (optionalMember) {
                propertyMember.optional = true;
            }
            members.push(
                this.attachNodeBounds(
                    propertyMember,
                    interfaceMemberStartToken ?? interfaceIndexSignatureType?.firstToken ?? memberNameToken,
                    this.getLastReadToken() ?? interfaceMemberStartToken ?? interfaceIndexSignatureType?.lastToken ?? memberNameToken
                )
            );
            this.consumeStatementSeparator("block", this.getLastReadToken());
        }

        this.fail("Expected '}' to close interface body", this.tokenAt(openBrace), "block");
    }

    private isUnsupportedInterfaceMemberStart(): boolean {
        const token = this.tokens.peek();
        const next = this.peekToken(1);
        if (!token) {
            return false;
        }
        if (token.type === "symbol" && token.value === "<") {
            return true;
        }
        if (token.type === "symbol" && token.value === "[") {
            return !(this.isComputedInterfaceMethodStart() || this.isInterfaceIndexSignatureStart(0));
        }
        if (token.type === "identifier" && token.value === "readonly" && next?.type === "symbol" && next.value === "[") {
            return !this.isInterfaceIndexSignatureStart(1);
        }
        return false;
    }

    private isInterfaceIndexSignatureStart(bracketOffset: number): boolean {
        const identifierToken = this.peekToken(bracketOffset + 1);
        const colonToken = this.peekToken(bracketOffset + 2);
        return identifierToken?.type === "identifier" && colonToken?.type === "symbol" && colonToken.value === ":";
    }

    private isComputedInterfaceMethodStart(): boolean {
        let bracketDepth = 0;
        for (let offset = 0; this.peekToken(offset); offset += 1) {
            const token = this.peekToken(offset);
            if (!token) {
                return false;
            }
            if (token.type === "symbol" && token.value === "[") {
                bracketDepth += 1;
            } else if (token.type === "symbol" && token.value === "]") {
                bracketDepth -= 1;
                if (bracketDepth === 0) {
                    const after = this.peekToken(offset + 1);
                    return after?.type === "symbol" && after.value === "(";
                }
            }
        }
        return false;
    }

    private skipUnsupportedInterfaceMember(): void {
        let parenDepth = 0;
        let bracketDepth = 0;
        let braceDepth = 0;
        let angleDepth = 0;
        while (this.tokens.hasMore) {
            const token = this.tokens.peek();
            if (!token) {
                return;
            }
            if (token.type === "symbol") {
                if (token.value === "(") parenDepth += 1;
                else if (token.value === ")") parenDepth -= 1;
                else if (token.value === "[") bracketDepth += 1;
                else if (token.value === "]") bracketDepth -= 1;
                else if (token.value === "{") braceDepth += 1;
                else if (token.value === "}") {
                    if (parenDepth === 0 && bracketDepth === 0 && braceDepth === 0 && angleDepth === 0) {
                        return;
                    }
                    braceDepth -= 1;
                } else if (token.value === "<") angleDepth += 1;
                else if (token.value === ">") angleDepth = Math.max(0, angleDepth - 1);
                else if ((token.value === ";" || token.value === ",") && parenDepth === 0 && bracketDepth === 0 && braceDepth === 0 && angleDepth === 0) {
                    return;
                }
            }
            this.tokens.skip();
        }
    }

    private consumeOptionalTypeMemberSeparator(): void {
        if (this.tokens.peek()?.type === "symbol" && (this.tokens.peek()?.value === ";" || this.tokens.peek()?.value === ",")) {
            this.tokens.skip();
        }
    }

    private parseBlockStatement(): BlockStatement {
        const openBrace = this.tokens.read();
        if (openBrace?.type !== "symbol" || openBrace.value !== "{") {
            this.fail("Expected '{' to start block statement", this.tokenAt(openBrace));
        }

        const body: Statement[] = [];

        while (this.tokens.hasMore) {
            const token = this.tokens.peek();
            if (isEofToken(token)) {
                this.fail("Expected '}' to close block statement", this.tokenAt(openBrace), "block");
            }

            if (token?.type === "symbol" && token.value === "}") {
                this.tokens.skip();
                return this.attachNodeBounds({
                    kind: "BlockStatement",
                    body
                } as BlockStatement, openBrace, this.getLastReadToken() ?? openBrace);
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

    private parseWithStatement(): WithStatement {
        const withKeyword = this.tokens.read();
        if (withKeyword?.type !== "identifier" || withKeyword.value !== "with") {
            this.fail("Expected 'with' statement", this.tokenAt(withKeyword));
        }

        const openParen = this.tokens.read();
        if (openParen?.type !== "symbol" || openParen.value !== "(") {
            this.fail("Expected '(' after 'with'", this.tokenAt(openParen));
        }

        const object = this.parseExpressionOrThrow();

        const closeParen = this.tokens.read();
        if (closeParen?.type !== "symbol" || closeParen.value !== ")") {
            this.fail("Expected ')' after with object expression", this.tokenAt(closeParen));
        }

        const body = this.parseStatementOrThrow();
        return this.attachNodeBounds({
            kind: "WithStatement",
            object,
            body
        } as WithStatement, withKeyword, this.getLastReadToken() ?? withKeyword);
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

        let awaitModifier = false;
        if (this.tokens.peek()?.type === "identifier" && this.tokens.peek()?.value === "await") {
            awaitModifier = true;
            this.tokens.skip();
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
                initialToken?.type === "identifier" &&
                secondToken?.type === "identifier" &&
                (secondToken.value === "in" || secondToken.value === "of")
            ) {
                const identifierToken = this.tokens.read();
                if (identifierToken?.type !== "identifier") {
                    this.fail("Expected identifier iterator in VexaScript for-in/of statement", this.tokenAt(identifierToken));
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
                if (this.language === "vexa" && initializer.kind !== "Identifier") {
                    this.fail("Expected identifier iterator in VexaScript for-in/of statement", initializer.firstToken);
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
                ...(awaitModifier ? { await: true } : {}),
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
            ...(awaitModifier ? { await: true } : {}),
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
        if (
            this.tokens.peek()?.type === "symbol" &&
            this.tokens.peek()?.value === ";" &&
            this.peekToken(1)?.type === "identifier" &&
            this.peekToken(1)?.value === "else"
        ) {
            this.tokens.skip();
        }
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
            if (isEofToken(token)) {
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

    private parseLabeledStatement(): LabeledStatement {
        const labelToken = this.tokens.read();
        if (labelToken?.type !== "identifier") {
            this.fail("Expected label identifier", this.tokenAt(labelToken));
        }

        const colon = this.tokens.read();
        if (colon?.type !== "symbol" || colon.value !== ":") {
            this.fail("Expected ':' after statement label", this.tokenAt(colon));
        }

        const body = this.parseStatementOrThrow();
        return this.attachNodeBounds({
            kind: "LabeledStatement",
            label: this.buildIdentifierFromToken(labelToken),
            body
        } as LabeledStatement, labelToken, this.getLastReadToken() ?? labelToken);
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
        if (isEofToken(next)) {
            return this.attachNodeBounds({ kind: "ReturnStatement" } as ReturnStatement, returnKeyword, returnKeyword);
        }
        if (next.type === "symbol" && (next.value === ";" || next.value === "}")) {
            return this.attachNodeBounds({ kind: "ReturnStatement" } as ReturnStatement, returnKeyword, returnKeyword);
        }
        if (hasLineBreakBetween(returnKeyword, next)) {
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
        const next = this.tokens.peek();
        if (next?.type === "identifier" && !hasLineBreakBetween(continueKeyword, next)) {
            const labelToken = this.tokens.read()!;
            return this.attachNodeBounds({
                kind: "ContinueStatement",
                label: this.buildIdentifierFromToken(labelToken)
            } as ContinueStatement, continueKeyword, labelToken);
        }
        return this.attachNodeBounds({ kind: "ContinueStatement" } as ContinueStatement, continueKeyword, continueKeyword);
    }

    private parseBreakStatement(): BreakStatement {
        const breakKeyword = this.tokens.read();
        if (breakKeyword?.type !== "identifier" || breakKeyword.value !== "break") {
            this.fail("Expected 'break' statement", this.tokenAt(breakKeyword));
        }
        const next = this.tokens.peek();
        if (next?.type === "identifier" && !hasLineBreakBetween(breakKeyword, next)) {
            const labelToken = this.tokens.read()!;
            return this.attachNodeBounds({
                kind: "BreakStatement",
                label: this.buildIdentifierFromToken(labelToken)
            } as BreakStatement, breakKeyword, labelToken);
        }
        return this.attachNodeBounds({ kind: "BreakStatement" } as BreakStatement, breakKeyword, breakKeyword);
    }

    private parseThrowStatement(): ThrowStatement {
        const throwKeyword = this.tokens.read();
        if (throwKeyword?.type !== "identifier" || throwKeyword.value !== "throw") {
            this.fail("Expected 'throw' statement", this.tokenAt(throwKeyword));
        }

        const next = this.tokens.peek();
        if (!next || isEofToken(next) || hasLineBreakBetween(throwKeyword, next)) {
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

    private parseDeferStatement(): DeferStatement {
        const deferKeyword = this.tokens.read();
        if (deferKeyword?.type !== "identifier" || deferKeyword.value !== "defer") {
            this.fail("Expected 'defer' statement", this.tokenAt(deferKeyword));
        }

        const next = this.tokens.peek();
        if (!next || isEofToken(next) || hasLineBreakBetween(deferKeyword, next)) {
            this.fail("Expected expression after 'defer'", this.tokenAt(next));
        }
        if (next.type === "symbol" && (next.value === ";" || next.value === "}")) {
            this.fail("Expected expression after 'defer'", this.tokenAt(next));
        }

        const expression = this.parseExpressionOrThrow();
        return this.attachNodeBounds({
            kind: "DeferStatement",
            expression
        } as DeferStatement, deferKeyword, this.getLastReadToken() ?? deferKeyword);
    }


    private parseDebuggerStatement(): DebuggerStatement {
        const debuggerKeyword = this.tokens.read();
        if (debuggerKeyword?.type !== "identifier" || debuggerKeyword.value !== "debugger") {
            this.fail("Expected 'debugger' statement", this.tokenAt(debuggerKeyword));
        }
        return this.attachNodeBounds({
            kind: "DebuggerStatement"
        } as DebuggerStatement, debuggerKeyword, debuggerKeyword);
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
