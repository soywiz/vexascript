import { LANGUAGE_NAME, LANGUAGE_SCOPE } from "./language";
import type { SyntaxTarget } from "./syntaxTargets";
export { SYNTAX_TARGETS, type SyntaxTarget } from "./syntaxTargets";

export const VEXA_KEYWORD_DECLARATIONS = [
  "import", "export", "from", "let", "var", "val", "const", "by", "function", "fun", "fn", "func",
  "declare", "namespace", "class", "interface", "annotation", "enum", "extends", "implements",
  "override", "readonly", "public", "private", "protected", "static", "abstract", "get", "set", "init", "keyof", "infer", "async", "sync"
] as const;

export const VEXA_KEYWORD_CONTROLS = [
  "if", "else", "return", "throw", "while", "for", "switch", "case", "match", "when",
  "default", "break", "continue", "do", "try", "catch", "finally", "defer",
  "new", "in", "is", "and", "or", "instanceof", "typeof", "void", "delete",
  "await", "yield"
] as const;

export const VEXA_STORAGE_TYPES = ["type", "fn"] as const;
export const VEXA_CONSTANTS = ["true", "false", "null", "undefined"] as const;
export const VEXA_PRIMITIVE_TYPES = [
  "string", "number", "boolean", "int", "long", "bigint", "numeric",
  "unknown", "any", "void", "never", "object"
] as const;

const VEXA_OPERATOR_NAME_PATTERN = String.raw`\boperator(?:\[\]=?|[+\-*/\\%&|^~<>!=?:]+)`;
const VEXA_REGEXP_LITERAL_PATTERN = String.raw`/(?![/*])(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\r\n])+/[dgimsuvy]*`;
const JSX_OPENING_TAG_PATTERN = String.raw`<(?:>|(?!/)(?![^<>]*\/>)[A-Za-z_$][\w$:-]*(?:\.[A-Za-z_$][\w$:-]*)*(?:\s+[^<>]*)?>)`;
const JSX_CLOSING_TAG_PATTERN = String.raw`<\/(?:>|[A-Za-z_$][\w$:-]*(?:\.[A-Za-z_$][\w$:-]*)*\s*>)`;

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
  modifierKeywords: string[];
  functionKeywords: string[];
  typeKeywords: string[];
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
  const modifierKeywords = [
    "override", "readonly", "public", "private", "protected", "static", "abstract",
    "get", "set", "init", "async", "sync", "function", "fun", "func", ...VEXA_STORAGE_TYPES
  ] as string[];
  const functionKeywords: string[] = [];
  const typeKeywords = [
    "declare", "namespace", "class", "interface", "annotation", "enum", "extends",
    "implements", "import", "export", "from", "by", "keyof", "infer"
  ] as string[];
  const declarationKeywords = VEXA_KEYWORD_DECLARATIONS.filter(
    (keyword) => !modifierKeywords.includes(keyword) && !functionKeywords.includes(keyword) && !typeKeywords.includes(keyword)
  ) as string[];
  const controlKeywords = [...VEXA_KEYWORD_CONTROLS, ...VEXA_CONSTANTS] as string[];
  const identifierCases = {
    "@modifierKeywords": "keywordModifier",
    "@functionKeywords": "keywordFunction",
    "@typeKeywords": "keywordType",
    "@declarationKeywords": "keyword.declaration",
    "@controlKeywords": "keyword.control",
    "@default": "identifier",
  };
  const identifierRule: PortableMonarchRule = {
    match: String.raw`[A-Za-z_$][\w$]*`,
    token: "@cases",
    cases: identifierCases,
  };
  const uncheckedVarRule: PortableMonarchRule = {
    match: String.raw`\bvar!(?=\s|[_$A-Za-z])`,
    token: "keyword.declaration",
  };
  const operatorNameRule: PortableMonarchRule = {
    match: VEXA_OPERATOR_NAME_PATTERN,
    token: "identifier",
  };
  const genericDeclarationRule: PortableMonarchRule = {
    match: String.raw`(?:fun|fn|func|function|val|var|let|const)(?=\s*<)`,
    token: "@cases",
    cases: identifierCases,
    next: "@generic_declaration",
  };
  const characterLiteralRule: PortableMonarchRule = {
    match: String.raw`#(?:"([^"\\]|\\.)*"|'([^'\\]|\\.)*')`,
    token: "number",
  };
  const templateExpressionRules: PortableMonarchRule[] = [
    { match: String.raw`\}`, token: "delimiter", next: "@pop" },
    { match: String.raw`\{`, token: "delimiter", next: "@template_expression" },
    { match: "`", token: "string", next: "@template_string" },
    { match: String.raw`\/\/.*$`, token: "comment" },
    { match: String.raw`\/\*`, token: "comment", next: "@block_comment" },
    operatorNameRule,
    { match: VEXA_REGEXP_LITERAL_PATTERN, token: "regexp" },
    { match: String.raw`@[A-Za-z_$][\w$]*`, token: "annotation" },
    uncheckedVarRule,
    genericDeclarationRule,
    characterLiteralRule,
    { match: String.raw`"([^"\\]|\\.)*"`, token: "string" },
    { match: String.raw`'([^'\\]|\\.)*'`, token: "string" },
    { match: String.raw`\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?(?:[inNL])?\b`, token: "number.float" },
    identifierRule,
    { match: String.raw`[{}()\[\]]`, token: "delimiter" },
    { match: String.raw`(\.\.\.|\.\.<|\.\.)`, token: "operator" },
    { match: String.raw`[;,.]`, token: "delimiter" },
    { match: String.raw`[+\-*/\\%&|^~<>!=?:]+`, token: "operator" },
  ];
  return {
    defaultToken: "",
    keywords: [...declarationKeywords, ...modifierKeywords, ...functionKeywords, ...typeKeywords, ...controlKeywords],
    declarationKeywords,
    modifierKeywords,
    functionKeywords,
    typeKeywords,
    controlKeywords,
    tokenizer: {
      root: [
        { match: String.raw`^#!.*$`, token: "comment" },
        { match: String.raw`\/\/\/`, token: "comment.doc", next: "@doc_line_comment" },
        { match: String.raw`\/\/.*$`, token: "comment" },
        { match: String.raw`\/\*\*`, token: "comment.doc", next: "@doc_block_comment" },
        { match: String.raw`\/\*`, token: "comment", next: "@block_comment" },
        operatorNameRule,
        { match: VEXA_REGEXP_LITERAL_PATTERN, token: "regexp" },
        { match: String.raw`@[A-Za-z_$][\w$]*`, token: "annotation" },
        uncheckedVarRule,
        genericDeclarationRule,
        { match: String.raw`(?<![\w)\]])<>`, token: "tag", next: "@jsx_children" },
        { match: String.raw`(?<![\w)\]])<\/?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*`, token: "tag", next: "@jsx_tag" },
        { match: "`", token: "string", next: "@template_string" },
        characterLiteralRule,
        { match: String.raw`"([^"\\]|\\.)*"`, token: "string" },
        { match: String.raw`'([^'\\]|\\.)*'`, token: "string" },
        { match: String.raw`\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?(?:[inNL])?\b`, token: "number.float" },
        identifierRule,
        { match: String.raw`[{}()\[\]]`, token: "delimiter" },
        { match: String.raw`(\.\.\.|\.\.<|\.\.)`, token: "operator" },
        { match: String.raw`[;,.]`, token: "delimiter" },
        { match: String.raw`[+\-*/\\%&|^~<>!=?:]+`, token: "operator" },
      ],
      generic_declaration: [
        { match: String.raw`\s+`, token: "" },
        { match: String.raw`<`, token: "operator", switchTo: "@type_parameters" },
      ],
      template_string: [
        { match: "`", token: "string", next: "@pop" },
        { match: String.raw`\\.`, token: "string" },
        { match: String.raw`\$\{`, token: "delimiter", next: "@template_expression" },
        { match: String.raw`\$(?=[A-Za-z_$])`, token: "operator", next: "@template_shorthand" },
        { match: "[^`\\\\$]+", token: "string" },
        { match: String.raw`\$`, token: "string" },
      ],
      template_shorthand: [
        { match: String.raw`[A-Za-z_$][\w$]*`, token: "identifier", next: "@pop" },
      ],
      template_expression: templateExpressionRules,
      type_parameters: [
        { match: String.raw`\s+`, token: "" },
        { match: String.raw`<`, token: "operator", next: "@type_parameters" },
        { match: String.raw`>`, token: "operator", next: "@pop" },
        identifierRule,
        { match: String.raw`[{}()\[\]]`, token: "delimiter" },
        { match: String.raw`[;,.]`, token: "delimiter" },
        { match: String.raw`[+\-*/\\%&|^~!=?:]+`, token: "operator" },
      ],
      block_comment: [
        { match: String.raw`[^/*]+`, token: "comment" },
        { match: String.raw`\*\/`, token: "comment", next: "@pop" },
        { match: String.raw`[/*]`, token: "comment" },
      ],
      doc_line_comment: [
        { match: String.raw`\[[A-Za-z_][A-Za-z0-9_]*\]`, token: "comment.doc.param" },
        { match: String.raw`[^\[\r\n]+`, token: "comment.doc" },
        { match: String.raw`(?:\r\n|\r|\n)`, token: "", next: "@pop" },
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
        operatorNameRule,
        { match: VEXA_REGEXP_LITERAL_PATTERN, token: "regexp" },
        characterLiteralRule,
        { match: String.raw`"([^"\\]|\\.)*"`, token: "string" },
        { match: String.raw`'([^'\\]|\\.)*'`, token: "string" },
        { match: String.raw`\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?(?:[inNL])?\b`, token: "number.float" },
        uncheckedVarRule,
        genericDeclarationRule,
        identifierRule,
        { match: String.raw`[{}()\[\]]`, token: "delimiter" },
        { match: String.raw`(\.\.\.|\.\.<|\.\.)`, token: "operator" },
        { match: String.raw`[;,.]`, token: "delimiter" },
        { match: String.raw`[+\-*/\\%&|^~<>!=?:]+`, token: "operator" },
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
      // `<` is intentionally not auto-closed: it is far more commonly the
      // comparison operator than the start of a generic/JSX tag, and
      // auto-inserting `>` is disruptive when typing `a < b`. Selections can
      // still be wrapped with `<…>` via surroundingPairs below.
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
      increaseIndentPattern: `^.*(?:\\{[^}"']*|->|${JSX_OPENING_TAG_PATTERN})\\s*$`,
      decreaseIndentPattern: `^\\s*(?:\\}|${JSX_CLOSING_TAG_PATTERN})`,
    },
    onEnterRules: [
      {
        afterText: `^\\s*${JSX_CLOSING_TAG_PATTERN}`,
        beforeText: `${JSX_OPENING_TAG_PATTERN}\\s*$`,
        indentAction: "indentOutdent"
      },
      { beforeText: `${JSX_OPENING_TAG_PATTERN}\\s*$`, indentAction: "indent" },
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
      { include: "#operator-names" },
      { include: "#regexps" },
      { include: "#jsx" },
      { include: "#annotations" },
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
            name: "comment.line.shebang.vexa",
            match: "^#!.*$\\n?",
          },
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
            name: "constant.numeric.character.vexa",
            begin: "#\"",
            beginCaptures: { "0": { name: "punctuation.definition.character.begin.vexa" } },
            end: "\"",
            endCaptures: { "0": { name: "punctuation.definition.character.end.vexa" } },
            patterns: [{ name: "constant.character.escape.vexa", match: "\\\\(?:[nrt'\"\\\\]|u[0-9A-Fa-f]{4})" }],
          },
          {
            name: "constant.numeric.character.vexa",
            begin: "#'",
            beginCaptures: { "0": { name: "punctuation.definition.character.begin.vexa" } },
            end: "'",
            endCaptures: { "0": { name: "punctuation.definition.character.end.vexa" } },
            patterns: [{ name: "constant.character.escape.vexa", match: "\\\\(?:[nrt'\"\\\\]|u[0-9A-Fa-f]{4})" }],
          },
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
              { include: "#template-shorthand-interpolation" },
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
      "template-shorthand-interpolation": {
        name: "meta.template.expression.vexa",
        match: "(\\$)([_$A-Za-z][_$A-Za-z0-9]*)",
        captures: {
          "1": { name: "punctuation.section.embedded.begin.vexa" },
          "2": { name: "variable.other.readwrite.vexa" }
        },
      },
      annotations: {
        patterns: [
          {
            match: "(@)([_$A-Za-z][_$A-Za-z0-9]*)",
            captures: {
              "1": { name: "punctuation.definition.annotation.vexa" },
              "2": { name: "entity.name.annotation.vexa" }
            }
          }
        ]
      },
      declarations: {
        patterns: [
          {
            match: "\\b(function|fun|fn|func)\\s+([_$A-Za-z][_$A-Za-z0-9]*)",
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
          { name: "keyword.declaration.vexa", match: String.raw`\bvar!(?=\s|[_$A-Za-z])` },
          { name: "keyword.declaration.vexa", match: `\\b(${VEXA_KEYWORD_DECLARATIONS.join("|")})\\b` },
          { name: "keyword.control.vexa", match: `\\b(${VEXA_KEYWORD_CONTROLS.join("|")})\\b` },
          { name: "storage.type.vexa", match: `\\b(${VEXA_STORAGE_TYPES.join("|")})\\b` },
          { name: "constant.language.vexa", match: `\\b(${VEXA_CONSTANTS.join("|")})\\b` },
        ],
      },
      numbers: {
        patterns: [{ name: "constant.numeric.integer.vexa", match: "\\b\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?(?:[inN]|L)?\\b" }],
      },
      operators: {
        patterns: [
          { name: "keyword.operator.assignment.compound.vexa", match: "(\\+=|-=|%=|\\*=|/=|&=|\\|=|&&=|\\|\\|=|\\?\\?=)" },
          { name: "keyword.operator.range.vexa", match: "(\\.\\.\\.|\\.\\.<)" },
          { name: "keyword.operator.chain.vexa", match: "\\.\\." },
          { name: "keyword.operator.arithmetic.vexa", match: "(\\*\\*|\\+|-|\\*|/|\\\\|%)" },
          { name: "keyword.operator.relational.vexa", match: "(<=>|<=|>=|<|>)" },
          { name: "keyword.operator.equality.vexa", match: "(===|!==|==|!=)" },
          { name: "keyword.operator.member.vexa", match: "(\\?\\.|!\\.)" },
          { name: "keyword.operator.rename.vexa", match: "::" },
          { name: "keyword.operator.logical.vexa", match: "(\\|\\||&&|\\?\\?)" },
          { name: "keyword.operator.bitwise.vexa", match: "(&|\\||\\^)" },
          { name: "keyword.operator.assignment.vexa", match: "=" },
        ],
      },
      "operator-names": {
        patterns: [{ name: "entity.name.function.operator.vexa", match: VEXA_OPERATOR_NAME_PATTERN }],
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
        patterns: [{ name: "string.regexp.vexa", match: VEXA_REGEXP_LITERAL_PATTERN }],
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
        end: "(/>)|(</)(\\2)\\s*(>)",
        endCaptures: {
          "1": { name: "punctuation.definition.tag.end.vexa" },
          "2": { name: "punctuation.definition.tag.begin.vexa" },
          "3": { name: "entity.name.tag.vexa" },
          "4": { name: "punctuation.definition.tag.end.vexa" },
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
  const operatorNamePattern = VEXA_OPERATOR_NAME_PATTERN.replace(/\//g, String.raw`\/`);
  const regexpLiteralPattern = VEXA_REGEXP_LITERAL_PATTERN.replace(/\//g, String.raw`\/`);
  return `export const vexaMode = {
  start: [
    { regex: /^#!.*/, token: "comment" },
    { regex: /\\/\\/\\/.*/, token: "comment meta" },
    { regex: /\\/\\/.*/, token: "comment" },
    { regex: /\\/\\*/, token: "comment", next: "blockComment" },
    { regex: /${operatorNamePattern}/, token: "variableName" },
    { regex: /${regexpLiteralPattern}/, token: "regexp" },
    { regex: /#(?:"([^"\\\\]|\\\\.)*"|'([^'\\\\]|\\\\.)*')/, token: "number" },
    { regex: /"([^"\\\\]|\\\\.)*"/, token: "string" },
    { regex: /'([^'\\\\]|\\\\.)*'/, token: "string" },
    { regex: /\\b\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?(?:[inNL])?\\b/, token: "number" },
    { regex: /\\bvar!(?=\\s|[_$A-Za-z])/, token: "keyword" },
    { regex: /\\b(?:${[...VEXA_KEYWORD_DECLARATIONS, ...VEXA_KEYWORD_CONTROLS, ...VEXA_STORAGE_TYPES, ...VEXA_CONSTANTS].join("|")})\\b/, token: "keyword" },
    { regex: /[{}()\\[\\]]/, token: "bracket" },
    { regex: /(\.\.\.|\.\.<|\.\.)/, token: "operator" },
    { regex: /[;,.]/, token: "punctuation" },
    { regex: /[+\\-*/\\%&|^~<>!=?:]+/, token: "operator" },
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
