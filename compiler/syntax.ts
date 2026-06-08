export const MYLANG_KEYWORD_DECLARATIONS = [
  "import", "from", "let", "var", "val", "const", "function", "fun",
  "declare", "class", "interface", "enum", "extends", "implements",
  "override", "readonly", "keyof", "infer", "async", "sync"
] as const;

export const MYLANG_KEYWORD_CONTROLS = [
  "if", "else", "return", "throw", "while", "for", "switch", "case",
  "default", "break", "continue", "do", "try", "catch", "finally",
  "new", "in", "is", "instanceof", "typeof", "void", "delete",
  "await", "yield"
] as const;

export const MYLANG_STORAGE_TYPES = ["type", "fn"] as const;
export const MYLANG_CONSTANTS = ["true", "false", "null", "undefined"] as const;

export const SYNTAX_TARGETS = [
  "monaco",
  "monaco-language",
  "monaco-configuration",
  "vscode-grammar",
  "vscode-configuration",
  "codemirror-legacy",
  "textmate",
] as const;

export type SyntaxTarget = (typeof SYNTAX_TARGETS)[number];

export interface PortableMonarchRule {
  match: string;
  token: string;
  next?: string;
  cases?: Record<string, string>;
}

export interface PortableMonarchLanguage {
  defaultToken: string;
  keywords: string[];
  tokenizer: Record<string, PortableMonarchRule[]>;
}

export interface PortableLanguageConfiguration {
  comments: {
    lineComment: string;
    blockComment: [string, string];
  };
  brackets: Array<[string, string]>;
  autoClosingPairs: Array<{ open: string; close: string; notIn?: string[] }>;
  surroundingPairs: Array<{ open: string; close: string }>;
  indentationRules: {
    increaseIndentPattern: string;
    decreaseIndentPattern: string;
  };
  onEnterRules: Array<{
    beforeText: string;
    afterText?: string;
    indentAction: "indent" | "indentOutdent";
  }>;
}

export function createPortableMonarchLanguage(): PortableMonarchLanguage {
  return {
    defaultToken: "",
    keywords: [
      "declare", "namespace", "enum", "import", "from", "as", "export",
      "class", "interface", "infer", "extends", "implements", "override",
      "async", "yield", "fun", "function", "keyof", "let", "var", "val",
      "const", "if", "else", "return", "throw", "while", "for", "in",
      "switch", "case", "default", "break", "continue", "do", "try",
      "catch", "finally", "new", "is", "instanceof", "typeof", "void",
      "delete", "await", "readonly", "type", "fn", "true", "false",
      "null", "undefined",
    ],
    tokenizer: {
      root: [
        { match: String.raw`\/\/\/.*$`, token: "comment.doc" },
        { match: String.raw`\/\/.*$`, token: "comment" },
        { match: String.raw`\/\*`, token: "comment", next: "@block_comment" },
        { match: String.raw`"([^"\\]|\\.)*"`, token: "string" },
        { match: String.raw`'([^'\\]|\\.)*'`, token: "string" },
        { match: String.raw`\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?(?:[nNL])?\b`, token: "number.float" },
        { match: String.raw`[A-Za-z_$][\w$]*`, token: "@cases", cases: { "@keywords": "keyword", "@default": "identifier" } },
        { match: String.raw`[{}()\[\]]`, token: "delimiter" },
        { match: String.raw`[;,.]`, token: "delimiter" },
        { match: String.raw`[+\-*/%&|^~<>!=?:]+`, token: "operator" },
      ],
      block_comment: [
        { match: String.raw`[^/*]+`, token: "comment" },
        { match: String.raw`\*\/`, token: "comment", next: "@pop" },
        { match: String.raw`[/*]`, token: "comment" },
      ],
    },
  };
}

export function createPortableLanguageConfiguration(): PortableLanguageConfiguration {
  return {
    comments: { lineComment: "//", blockComment: ["/*", "*/"] },
    brackets: [["{", "}"], ["[", "]"], ["(", ")"]],
    autoClosingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: "\"", close: "\"", notIn: ["string"] },
      { open: "'", close: "'", notIn: ["string"] },
    ],
    surroundingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: "\"", close: "\"" },
      { open: "'", close: "'" },
    ],
    indentationRules: {
      increaseIndentPattern: String.raw`^.*(\{[^}"']*|->)\s*$`,
      decreaseIndentPattern: String.raw`^\s*\}`,
    },
    onEnterRules: [
      { afterText: String.raw`^\s*[)\]}]`, beforeText: String.raw`->\s*$`, indentAction: "indentOutdent" },
      { beforeText: String.raw`->\s*$`, indentAction: "indent" },
    ],
  };
}

export function createVscodeTmLanguageGrammar(): Record<string, unknown> {
  return {
    name: "MyLang",
    scopeName: "source.mylang",
    patterns: [
      { include: "#comments" },
      { include: "#strings" },
      { include: "#regexps" },
      { include: "#jsx" },
      { include: "#keywords" },
      { include: "#numbers" },
      { include: "#operators" },
      { include: "#identifiers" },
    ],
    repository: {
      comments: {
        patterns: [
          {
            name: "comment.line.documentation.mylang",
            begin: "///",
            beginCaptures: { "0": { name: "punctuation.definition.comment.mylang" } },
            end: "$\\n?",
          },
          {
            name: "comment.line.double-slash.mylang",
            begin: "//",
            beginCaptures: { "0": { name: "punctuation.definition.comment.mylang" } },
            end: "$\\n?",
          },
          {
            name: "comment.block.mylang",
            begin: "/\\*",
            beginCaptures: { "0": { name: "punctuation.definition.comment.begin.mylang" } },
            end: "\\*/",
            endCaptures: { "0": { name: "punctuation.definition.comment.end.mylang" } },
          },
        ],
      },
      strings: {
        patterns: [
          {
            name: "string.quoted.double.mylang",
            begin: "\"",
            beginCaptures: { "0": { name: "punctuation.definition.string.begin.mylang" } },
            end: "\"",
            endCaptures: { "0": { name: "punctuation.definition.string.end.mylang" } },
            patterns: [{ name: "constant.character.escape.mylang", match: "\\\\(?:[nrt'\"\\\\]|u[0-9A-Fa-f]{4})" }],
          },
          {
            name: "string.quoted.single.mylang",
            begin: "'",
            beginCaptures: { "0": { name: "punctuation.definition.string.begin.mylang" } },
            end: "'",
            endCaptures: { "0": { name: "punctuation.definition.string.end.mylang" } },
            patterns: [{ name: "constant.character.escape.mylang", match: "\\\\(?:[nrt'\"\\\\]|u[0-9A-Fa-f]{4})" }],
          },
        ],
      },
      keywords: {
        patterns: [
          { name: "keyword.declaration.mylang", match: `\\b(${MYLANG_KEYWORD_DECLARATIONS.join("|")})\\b` },
          { name: "keyword.control.mylang", match: `\\b(${MYLANG_KEYWORD_CONTROLS.join("|")})\\b` },
          { name: "storage.type.mylang", match: `\\b(${MYLANG_STORAGE_TYPES.join("|")})\\b` },
          { name: "constant.language.mylang", match: `\\b(${MYLANG_CONSTANTS.join("|")})\\b` },
        ],
      },
      numbers: {
        patterns: [{ name: "constant.numeric.integer.mylang", match: "\\b\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?(?:[nN]|L)?\\b" }],
      },
      operators: {
        patterns: [
          { name: "keyword.operator.assignment.compound.mylang", match: "(\\+=|-=|%=|\\*=|/=|&=|\\|=|&&=|\\|\\|=|\\?\\?=)" },
          { name: "keyword.operator.arithmetic.mylang", match: "(\\*\\*|\\+|-|\\*|/|%)" },
          { name: "keyword.operator.relational.mylang", match: "(<=|>=|<|>)" },
          { name: "keyword.operator.equality.mylang", match: "(===|!==|==|!=)" },
          { name: "keyword.operator.member.mylang", match: "(\\?\\.|!\\.)" },
          { name: "keyword.operator.logical.mylang", match: "(\\|\\||&&|\\?\\?)" },
          { name: "keyword.operator.bitwise.mylang", match: "(&|\\||\\^)" },
          { name: "keyword.operator.assignment.mylang", match: "=" },
        ],
      },
      identifiers: {
        patterns: [{ name: "variable.other.mylang", match: "\\b[_A-Za-z][_A-Za-z0-9]*\\b" }],
      },
      regexps: {
        patterns: [{ name: "string.regexp.mylang", match: "/(?:\\\\.|\\[(?:\\\\.|[^\\]\\\\])*\\]|[^/\\\\\\r\\n])+/[A-Za-z]*" }],
      },
      jsx: { patterns: [{ include: "#jsx-fragment" }, { include: "#jsx-self-closing-element" }, { include: "#jsx-paired-element" }] },
      "jsx-fragment": {
        name: "meta.jsx.fragment.mylang",
        begin: "(?<![\\w)\\]])(<)(>)",
        beginCaptures: { "1": { name: "punctuation.definition.tag.begin.mylang" }, "2": { name: "punctuation.definition.tag.end.mylang" } },
        end: "(</)(>)",
        endCaptures: { "1": { name: "punctuation.definition.tag.begin.mylang" }, "2": { name: "punctuation.definition.tag.end.mylang" } },
        patterns: [{ include: "#jsx-children" }],
      },
      "jsx-self-closing-element": {
        name: "meta.tag.self-closing.mylang",
        begin: "(?<![\\w)\\]])(<)([_$A-Za-z][-_$A-Za-z0-9.]*)(?=[^<>]*/>)",
        beginCaptures: { "1": { name: "punctuation.definition.tag.begin.mylang" }, "2": { name: "entity.name.tag.mylang" } },
        end: "(/>)",
        endCaptures: { "1": { name: "punctuation.definition.tag.end.mylang" } },
        patterns: [{ include: "#jsx-attributes" }],
      },
      "jsx-paired-element": {
        name: "meta.tag.mylang",
        begin: "(?<![\\w)\\]])(<)([_$A-Za-z][-_$A-Za-z0-9.]*)",
        beginCaptures: { "1": { name: "punctuation.definition.tag.begin.mylang" }, "2": { name: "entity.name.tag.mylang" } },
        end: "(</)([_$A-Za-z][-_$A-Za-z0-9.]*)?\\s*(>)",
        endCaptures: {
          "1": { name: "punctuation.definition.tag.begin.mylang" },
          "2": { name: "entity.name.tag.mylang" },
          "3": { name: "punctuation.definition.tag.end.mylang" },
        },
        patterns: [
          { include: "#jsx-attributes" },
          { name: "punctuation.definition.tag.end.mylang", match: ">" },
          { include: "#jsx-children" },
        ],
      },
      "jsx-children": {
        patterns: [
          { include: "#jsx-fragment" },
          { include: "#jsx-self-closing-element" },
          { include: "#jsx-paired-element" },
          { include: "#jsx-expression" },
        ],
      },
      "jsx-attributes": {
        patterns: [
          { match: "([_$A-Za-z][-_$A-Za-z0-9]*)(?=\\s*=)", name: "entity.other.attribute-name.mylang" },
          { match: "=", name: "keyword.operator.assignment.mylang" },
          { include: "#strings" },
          { include: "#jsx-expression" },
        ],
      },
      "jsx-expression": {
        name: "meta.embedded.expression.mylang",
        begin: "\\{",
        beginCaptures: { "0": { name: "punctuation.section.embedded.begin.mylang" } },
        end: "\\}",
        endCaptures: { "0": { name: "punctuation.section.embedded.end.mylang" } },
        patterns: [{ include: "#jsx-expression" }, { include: "$self" }],
      },
    },
  };
}

export function createVscodeLanguageConfiguration(): Record<string, unknown> {
  const config = createPortableLanguageConfiguration();
  return {
    comments: config.comments,
    brackets: config.brackets,
    autoClosingPairs: config.autoClosingPairs,
    surroundingPairs: config.surroundingPairs.map((pair) => [pair.open, pair.close]),
    indentationRules: config.indentationRules,
    onEnterRules: config.onEnterRules.map((rule) => ({
      beforeText: rule.beforeText,
      ...(rule.afterText ? { afterText: rule.afterText } : {}),
      action: { indent: rule.indentAction },
    })),
  };
}

export function createCodeMirrorLegacyModeSource(): string {
  return `export const mylangMode = {
  start: [
    { regex: /\\/\\/\\/.*/, token: "comment meta" },
    { regex: /\\/\\/.*/, token: "comment" },
    { regex: /\\/\\*/, token: "comment", next: "blockComment" },
    { regex: /"([^"\\\\]|\\\\.)*"/, token: "string" },
    { regex: /'([^'\\\\]|\\\\.)*'/, token: "string" },
    { regex: /\\b\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?(?:[nNL])?\\b/, token: "number" },
    { regex: /\\b(?:${[...MYLANG_KEYWORD_DECLARATIONS, ...MYLANG_KEYWORD_CONTROLS, ...MYLANG_STORAGE_TYPES, ...MYLANG_CONSTANTS].join("|")})\\b/, token: "keyword" },
    { regex: /[{}()\\[\\]]/, token: "bracket" },
    { regex: /[;,.]/, token: "punctuation" },
    { regex: /[+\\-*/%&|^~<>!=?:]+/, token: "operator" },
    { regex: /\\b[_A-Za-z][_A-Za-z0-9]*\\b/, token: "variableName" }
  ],
  blockComment: [
    { regex: /[^/*]+/, token: "comment" },
    { regex: /\\*\\//, token: "comment", next: "start" },
    { regex: /[/*]/, token: "comment" }
  ],
  lineComment: "//",
  blockCommentStart: "/*",
  blockCommentEnd: "*/"
};`;
}

export function createPortableMonacoBundleSource(): string {
  return `export const mylangMonacoSyntax = ${JSON.stringify({
    language: createPortableMonarchLanguage(),
    configuration: createPortableLanguageConfiguration(),
  }, null, 2)};`;
}

export function renderSyntaxTarget(target: SyntaxTarget): string {
  switch (target) {
    case "monaco":
      return createPortableMonacoBundleSource();
    case "monaco-language":
      return `${JSON.stringify(createPortableMonarchLanguage(), null, 2)}\n`;
    case "monaco-configuration":
      return `${JSON.stringify(createPortableLanguageConfiguration(), null, 2)}\n`;
    case "vscode-grammar":
    case "textmate":
      return `${JSON.stringify(createVscodeTmLanguageGrammar(), null, 2)}\n`;
    case "vscode-configuration":
      return `${JSON.stringify(createVscodeLanguageConfiguration(), null, 2)}\n`;
    case "codemirror-legacy":
      return createCodeMirrorLegacyModeSource();
  }
}
