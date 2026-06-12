import { LANGUAGE_NAME, LANGUAGE_SCOPE } from "./language";

export const VEXA_KEYWORD_DECLARATIONS = [
  "import", "export", "from", "let", "var", "val", "const", "by", "function", "fun",
  "declare", "class", "interface", "annotation", "enum", "extends", "implements",
  "override", "readonly", "public", "private", "protected", "static", "abstract", "get", "set", "keyof", "infer", "async", "sync"
] as const;

export const VEXA_KEYWORD_CONTROLS = [
  "if", "else", "return", "throw", "while", "for", "switch", "case",
  "default", "break", "continue", "do", "try", "catch", "finally", "defer",
  "new", "in", "is", "instanceof", "typeof", "void", "delete",
  "await", "yield"
] as const;

export const VEXA_STORAGE_TYPES = ["type", "fn"] as const;
export const VEXA_CONSTANTS = ["true", "false", "null", "undefined"] as const;
export const VEXA_PRIMITIVE_TYPES = [
  "string", "number", "boolean", "int", "long", "bigint", "numeric",
  "unknown", "any", "void", "never", "object"
] as const;

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
  switchTo?: string;
  cases?: Record<string, string>;
}

export interface PortableMonarchLanguage {
  defaultToken: string;
  keywords: string[];
  declarationKeywords: string[];
  controlKeywords: string[];
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
  const declarationKeywords = [...VEXA_KEYWORD_DECLARATIONS, ...VEXA_STORAGE_TYPES] as string[];
  const controlKeywords = [...VEXA_KEYWORD_CONTROLS, ...VEXA_CONSTANTS] as string[];
  return {
    defaultToken: "",
    keywords: [...declarationKeywords, ...controlKeywords],
    declarationKeywords,
    controlKeywords,
    tokenizer: {
      root: [
        { match: String.raw`\/\/\/`, token: "comment.doc", next: "@doc_line_comment" },
        { match: String.raw`\/\/.*$`, token: "comment" },
        { match: String.raw`\/\*\*`, token: "comment.doc", next: "@doc_block_comment" },
        { match: String.raw`\/\*`, token: "comment", next: "@block_comment" },
        { match: String.raw`(?<![\w)\]])<>`, token: "tag", next: "@jsx_children" },
        { match: String.raw`(?<![\w)\]])<\/?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*`, token: "tag", next: "@jsx_tag" },
        { match: String.raw`"([^"\\]|\\.)*"`, token: "string" },
        { match: String.raw`'([^'\\]|\\.)*'`, token: "string" },
        { match: String.raw`\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?(?:[nNL])?\b`, token: "number.float" },
        { match: String.raw`[A-Za-z_$][\w$]*`, token: "@cases", cases: { "@declarationKeywords": "keyword.declaration", "@controlKeywords": "keyword.control", "@default": "identifier" } },
        { match: String.raw`[{}()\[\]]`, token: "delimiter" },
        { match: String.raw`[;,.]`, token: "delimiter" },
        { match: String.raw`[+\-*/%&|^~<>!=?:]+`, token: "operator" },
      ],
      block_comment: [
        { match: String.raw`[^/*]+`, token: "comment" },
        { match: String.raw`\*\/`, token: "comment", next: "@pop" },
        { match: String.raw`[/*]`, token: "comment" },
      ],
      doc_line_comment: [
        { match: String.raw`\[[A-Za-z_][A-Za-z0-9_]*\]`, token: "comment.doc.param" },
        { match: String.raw`[^\[]+$`, token: "comment.doc", next: "@pop" },
        { match: String.raw`[^\[]+`, token: "comment.doc" },
        { match: String.raw`\[`, token: "comment.doc" },
      ],
      doc_block_comment: [
        { match: String.raw`\[[A-Za-z_][A-Za-z0-9_]*\]`, token: "comment.doc.param" },
        { match: String.raw`[^/*\[]+`, token: "comment.doc" },
        { match: String.raw`\*\/`, token: "comment.doc", next: "@pop" },
        { match: String.raw`[/*]`, token: "comment.doc" },
        { match: String.raw`\[`, token: "comment.doc" },
      ],
      jsx_tag: [
        { match: String.raw`\s+`, token: "" },
        { match: String.raw`\/>`, token: "tag", next: "@pop" },
        { match: String.raw`>`, token: "tag", switchTo: "@jsx_children" },
        { match: String.raw`[A-Za-z_$][\w$:-]*(?=\s*=)`, token: "attribute.name" },
        { match: String.raw`=`, token: "operator" },
        { match: String.raw`"([^"\\]|\\.)*"`, token: "string" },
        { match: String.raw`'([^'\\]|\\.)*'`, token: "string" },
        { match: String.raw`\{`, token: "delimiter.bracket", next: "@jsx_expression" },
      ],
      jsx_children: [
        { match: String.raw`<\/>`, token: "tag", next: "@pop" },
        { match: String.raw`</[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*\s*>`, token: "tag", next: "@pop" },
        { match: String.raw`(?<![\w)\]])<>`, token: "tag", next: "@jsx_children" },
        { match: String.raw`(?<![\w)\]])<\/?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*`, token: "tag", next: "@jsx_tag" },
        { match: String.raw`\{`, token: "delimiter.bracket", next: "@jsx_expression" },
        { match: String.raw`[^<{]+`, token: "" },
      ],
      jsx_expression: [
        { match: String.raw`\{`, token: "delimiter.bracket", next: "@jsx_expression" },
        { match: String.raw`\}`, token: "delimiter.bracket", next: "@pop" },
        { match: String.raw`(?<![\w)\]])<>`, token: "tag", next: "@jsx_children" },
        { match: String.raw`(?<![\w)\]])<\/?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*`, token: "tag", next: "@jsx_tag" },
        { match: String.raw`\/\/.*$`, token: "comment" },
        { match: String.raw`\/\*`, token: "comment", next: "@block_comment" },
        { match: String.raw`"([^"\\]|\\.)*"`, token: "string" },
        { match: String.raw`'([^'\\]|\\.)*'`, token: "string" },
        { match: String.raw`\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?(?:[nNL])?\b`, token: "number.float" },
        { match: String.raw`[A-Za-z_$][\w$]*`, token: "@cases", cases: { "@declarationKeywords": "keyword.declaration", "@controlKeywords": "keyword.control", "@default": "identifier" } },
        { match: String.raw`[{}()\[\]]`, token: "delimiter" },
        { match: String.raw`[;,.]`, token: "delimiter" },
        { match: String.raw`[+\-*/%&|^~<>!=?:]+`, token: "operator" },
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
      { open: "<", close: ">", notIn: ["string", "comment"] },
      { open: "\"", close: "\"", notIn: ["string"] },
      { open: "'", close: "'", notIn: ["string"] },
    ],
    surroundingPairs: [
      { open: "{", close: "}" },
      { open: "[", close: "]" },
      { open: "(", close: ")" },
      { open: "<", close: ">" },
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
  const keywordAlternation = [
    ...VEXA_KEYWORD_DECLARATIONS,
    ...VEXA_KEYWORD_CONTROLS,
    ...VEXA_STORAGE_TYPES,
    ...VEXA_CONSTANTS,
    ...VEXA_PRIMITIVE_TYPES
  ].join("|");
  return {
    name: LANGUAGE_NAME,
    scopeName: LANGUAGE_SCOPE,
    patterns: [
      { include: "#comments" },
      { include: "#strings" },
      { include: "#regexps" },
      { include: "#jsx" },
      { include: "#declarations" },
      { include: "#types" },
      { include: "#keywords" },
      { include: "#numbers" },
      { include: "#operators" },
      { include: "#members" },
      { include: "#calls" },
      { include: "#identifiers" },
    ],
    repository: {
      comments: {
        patterns: [
          {
            name: "comment.line.documentation.vexa",
            begin: "///",
            beginCaptures: { "0": { name: "punctuation.definition.comment.vexa" } },
            end: "$\\n?",
            patterns: [{ include: "#doc-comment-params" }]
          },
          {
            name: "comment.block.documentation.vexa",
            begin: "/\\*\\*",
            beginCaptures: { "0": { name: "punctuation.definition.comment.begin.vexa" } },
            end: "\\*/",
            endCaptures: { "0": { name: "punctuation.definition.comment.end.vexa" } },
            patterns: [{ include: "#doc-comment-params" }]
          },
          {
            name: "comment.line.double-slash.vexa",
            begin: "//",
            beginCaptures: { "0": { name: "punctuation.definition.comment.vexa" } },
            end: "$\\n?",
          },
          {
            name: "comment.block.vexa",
            begin: "/\\*",
            beginCaptures: { "0": { name: "punctuation.definition.comment.begin.vexa" } },
            end: "\\*/",
            endCaptures: { "0": { name: "punctuation.definition.comment.end.vexa" } },
          },
        ],
      },
      "doc-comment-params": {
        patterns: [
          {
            name: "variable.parameter.documentation.vexa",
            match: "\\[[_$A-Za-z][_$A-Za-z0-9]*\\]"
          }
        ]
      },
      strings: {
        patterns: [
          {
            name: "string.quoted.double.vexa",
            begin: "\"",
            beginCaptures: { "0": { name: "punctuation.definition.string.begin.vexa" } },
            end: "\"",
            endCaptures: { "0": { name: "punctuation.definition.string.end.vexa" } },
            patterns: [{ name: "constant.character.escape.vexa", match: "\\\\(?:[nrt'\"\\\\]|u[0-9A-Fa-f]{4})" }],
          },
          {
            name: "string.quoted.single.vexa",
            begin: "'",
            beginCaptures: { "0": { name: "punctuation.definition.string.begin.vexa" } },
            end: "'",
            endCaptures: { "0": { name: "punctuation.definition.string.end.vexa" } },
            patterns: [{ name: "constant.character.escape.vexa", match: "\\\\(?:[nrt'\"\\\\]|u[0-9A-Fa-f]{4})" }],
          },
          {
            name: "string.quoted.template.vexa",
            begin: "`",
            beginCaptures: { "0": { name: "punctuation.definition.string.begin.vexa" } },
            end: "`",
            endCaptures: { "0": { name: "punctuation.definition.string.end.vexa" } },
            patterns: [
              { name: "constant.character.escape.vexa", match: "\\\\(?:[nrt'\"\\\\`$]|u[0-9A-Fa-f]{4})" },
              { include: "#template-interpolation" }
            ],
          },
        ],
      },
      "template-interpolation": {
        name: "meta.template.expression.vexa",
        begin: "\\$\\{",
        beginCaptures: { "0": { name: "punctuation.section.embedded.begin.vexa" } },
        end: "\\}",
        endCaptures: { "0": { name: "punctuation.section.embedded.end.vexa" } },
        patterns: [{ include: "$self" }],
      },
      declarations: {
        patterns: [
          {
            match: "\\b(function|fun)\\s+([_$A-Za-z][_$A-Za-z0-9]*)",
            captures: {
              "1": { name: "keyword.declaration.vexa" },
              "2": { name: "entity.name.function.vexa" }
            }
          },
          {
            match: "\\b(class|interface|annotation|enum|type)\\s+([_$A-Za-z][_$A-Za-z0-9]*)",
            captures: {
              "1": { name: "storage.type.vexa" },
              "2": { name: "entity.name.type.vexa" }
            }
          }
        ]
      },
      types: {
        patterns: [
          {
            name: "support.type.primitive.vexa",
            match: `\\b(${VEXA_PRIMITIVE_TYPES.join("|")})\\b`
          },
          {
            name: "entity.name.type.vexa",
            match: "\\b[A-Z][_$A-Za-z0-9]*\\b"
          }
        ]
      },
      keywords: {
        patterns: [
          { name: "keyword.declaration.vexa", match: `\\b(${VEXA_KEYWORD_DECLARATIONS.join("|")})\\b` },
          { name: "keyword.control.vexa", match: `\\b(${VEXA_KEYWORD_CONTROLS.join("|")})\\b` },
          { name: "storage.type.vexa", match: `\\b(${VEXA_STORAGE_TYPES.join("|")})\\b` },
          { name: "constant.language.vexa", match: `\\b(${VEXA_CONSTANTS.join("|")})\\b` },
        ],
      },
      numbers: {
        patterns: [{ name: "constant.numeric.integer.vexa", match: "\\b\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?(?:[nN]|L)?\\b" }],
      },
      operators: {
        patterns: [
          { name: "keyword.operator.assignment.compound.vexa", match: "(\\+=|-=|%=|\\*=|/=|&=|\\|=|&&=|\\|\\|=|\\?\\?=)" },
          { name: "keyword.operator.arithmetic.vexa", match: "(\\*\\*|\\+|-|\\*|/|%)" },
          { name: "keyword.operator.relational.vexa", match: "(<=|>=|<|>)" },
          { name: "keyword.operator.equality.vexa", match: "(===|!==|==|!=)" },
          { name: "keyword.operator.member.vexa", match: "(\\?\\.|!\\.)" },
          { name: "keyword.operator.rename.vexa", match: "::" },
          { name: "keyword.operator.logical.vexa", match: "(\\|\\||&&|\\?\\?)" },
          { name: "keyword.operator.bitwise.vexa", match: "(&|\\||\\^)" },
          { name: "keyword.operator.assignment.vexa", match: "=" },
        ],
      },
      members: {
        patterns: [
          { name: "variable.other.property.vexa", match: "\\b[_$A-Za-z][_$A-Za-z0-9]*\\b(?=\\s*:)" },
          { name: "variable.other.property.vexa", match: "(?<=\\.)[_$A-Za-z][_$A-Za-z0-9]*\\b" }
        ]
      },
      calls: {
        patterns: [
          {
            name: "entity.name.function.call.vexa",
            match: `(?<!\\.)\\b(?!(?:${keywordAlternation})\\b)[_$A-Za-z][_$A-Za-z0-9]*\\b(?=\\s*\\()`
          }
        ]
      },
      identifiers: {
        patterns: [{ name: "variable.other.vexa", match: "\\b[_A-Za-z][_A-Za-z0-9]*\\b" }],
      },
      regexps: {
        patterns: [{ name: "string.regexp.vexa", match: "/(?:\\\\.|\\[(?:\\\\.|[^\\]\\\\])*\\]|[^/\\\\\\r\\n])+/[A-Za-z]*" }],
      },
      jsx: { patterns: [{ include: "#jsx-fragment" }, { include: "#jsx-self-closing-element" }, { include: "#jsx-paired-element" }] },
      "jsx-fragment": {
        name: "meta.jsx.fragment.vexa",
        begin: "(?<![\\w)\\]])(<)(>)",
        beginCaptures: { "1": { name: "punctuation.definition.tag.begin.vexa" }, "2": { name: "punctuation.definition.tag.end.vexa" } },
        end: "(</)(>)",
        endCaptures: { "1": { name: "punctuation.definition.tag.begin.vexa" }, "2": { name: "punctuation.definition.tag.end.vexa" } },
        patterns: [{ include: "#jsx-children" }],
      },
      "jsx-self-closing-element": {
        name: "meta.tag.self-closing.vexa",
        begin: "(?<![\\w)\\]])(<)([_$A-Za-z][-_$A-Za-z0-9.]*)(?=[^<>]*/>)",
        beginCaptures: { "1": { name: "punctuation.definition.tag.begin.vexa" }, "2": { name: "entity.name.tag.vexa" } },
        end: "(/>)",
        endCaptures: { "1": { name: "punctuation.definition.tag.end.vexa" } },
        patterns: [{ include: "#jsx-attributes" }],
      },
      "jsx-paired-element": {
        name: "meta.tag.vexa",
        begin: "(?<![\\w)\\]])(<)([_$A-Za-z][-_$A-Za-z0-9.]*)",
        beginCaptures: { "1": { name: "punctuation.definition.tag.begin.vexa" }, "2": { name: "entity.name.tag.vexa" } },
        end: "(</)([_$A-Za-z][-_$A-Za-z0-9.]*)?\\s*(>)",
        endCaptures: {
          "1": { name: "punctuation.definition.tag.begin.vexa" },
          "2": { name: "entity.name.tag.vexa" },
          "3": { name: "punctuation.definition.tag.end.vexa" },
        },
        patterns: [
          { include: "#jsx-attributes" },
          { name: "punctuation.definition.tag.end.vexa", match: ">" },
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
          { match: "([_$A-Za-z][-_:$A-Za-z0-9]*)(?=\\s*=)", name: "entity.other.attribute-name.vexa" },
          { match: "=", name: "keyword.operator.assignment.vexa" },
          { include: "#strings" },
          { include: "#jsx-expression" },
        ],
      },
      "jsx-expression": {
        name: "meta.embedded.expression.vexa",
        begin: "\\{",
        beginCaptures: { "0": { name: "punctuation.section.embedded.begin.vexa" } },
        end: "\\}",
        endCaptures: { "0": { name: "punctuation.section.embedded.end.vexa" } },
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
  return `export const vexaMode = {
  start: [
    { regex: /\\/\\/\\/.*/, token: "comment meta" },
    { regex: /\\/\\/.*/, token: "comment" },
    { regex: /\\/\\*/, token: "comment", next: "blockComment" },
    { regex: /"([^"\\\\]|\\\\.)*"/, token: "string" },
    { regex: /'([^'\\\\]|\\\\.)*'/, token: "string" },
    { regex: /\\b\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?(?:[nNL])?\\b/, token: "number" },
    { regex: /\\b(?:${[...VEXA_KEYWORD_DECLARATIONS, ...VEXA_KEYWORD_CONTROLS, ...VEXA_STORAGE_TYPES, ...VEXA_CONSTANTS].join("|")})\\b/, token: "keyword" },
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
  return `export const vexaMonacoSyntax = ${JSON.stringify({
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
