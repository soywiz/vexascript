export const mylangPortableLanguage = {
  "defaultToken": "",
  "keywords": [
    "import",
    "export",
    "from",
    "let",
    "var",
    "val",
    "const",
    "by",
    "function",
    "fun",
    "declare",
    "class",
    "interface",
    "enum",
    "extends",
    "implements",
    "override",
    "readonly",
    "keyof",
    "infer",
    "async",
    "sync",
    "type",
    "fn",
    "if",
    "else",
    "return",
    "throw",
    "while",
    "for",
    "switch",
    "case",
    "default",
    "break",
    "continue",
    "do",
    "try",
    "catch",
    "finally",
    "new",
    "in",
    "is",
    "instanceof",
    "typeof",
    "void",
    "delete",
    "await",
    "yield",
    "true",
    "false",
    "null",
    "undefined"
  ],
  "declarationKeywords": [
    "import",
    "export",
    "from",
    "let",
    "var",
    "val",
    "const",
    "by",
    "function",
    "fun",
    "declare",
    "class",
    "interface",
    "enum",
    "extends",
    "implements",
    "override",
    "readonly",
    "keyof",
    "infer",
    "async",
    "sync",
    "type",
    "fn"
  ],
  "controlKeywords": [
    "if",
    "else",
    "return",
    "throw",
    "while",
    "for",
    "switch",
    "case",
    "default",
    "break",
    "continue",
    "do",
    "try",
    "catch",
    "finally",
    "new",
    "in",
    "is",
    "instanceof",
    "typeof",
    "void",
    "delete",
    "await",
    "yield",
    "true",
    "false",
    "null",
    "undefined"
  ],
  "tokenizer": {
    "root": [
      {
        "match": "\\/\\/\\/.*$",
        "token": "comment.doc"
      },
      {
        "match": "\\/\\/.*$",
        "token": "comment"
      },
      {
        "match": "\\/\\*",
        "token": "comment",
        "next": "@block_comment"
      },
      {
        "match": "<>",
        "token": "tag",
        "next": "@jsx_children"
      },
      {
        "match": "<\\/?[A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*",
        "token": "tag",
        "next": "@jsx_tag"
      },
      {
        "match": "\"([^\"\\\\]|\\\\.)*\"",
        "token": "string"
      },
      {
        "match": "'([^'\\\\]|\\\\.)*'",
        "token": "string"
      },
      {
        "match": "\\b\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?(?:[nNL])?\\b",
        "token": "number.float"
      },
      {
        "match": "[A-Za-z_$][\\w$]*",
        "token": "@cases",
        "cases": {
          "@declarationKeywords": "keyword.declaration",
          "@controlKeywords": "keyword.control",
          "@default": "identifier"
        }
      },
      {
        "match": "[{}()\\[\\]]",
        "token": "delimiter"
      },
      {
        "match": "[;,.]",
        "token": "delimiter"
      },
      {
        "match": "[+\\-*/%&|^~<>!=?:]+",
        "token": "operator"
      }
    ],
    "block_comment": [
      {
        "match": "[^/*]+",
        "token": "comment"
      },
      {
        "match": "\\*\\/",
        "token": "comment",
        "next": "@pop"
      },
      {
        "match": "[/*]",
        "token": "comment"
      }
    ],
    "jsx_tag": [
      {
        "match": "\\s+",
        "token": ""
      },
      {
        "match": "\\/>",
        "token": "tag",
        "next": "@pop"
      },
      {
        "match": ">",
        "token": "tag",
        "switchTo": "@jsx_children"
      },
      {
        "match": "[A-Za-z_$][\\w$:-]*(?=\\s*=)",
        "token": "attribute.name"
      },
      {
        "match": "=",
        "token": "operator"
      },
      {
        "match": "\"([^\"\\\\]|\\\\.)*\"",
        "token": "string"
      },
      {
        "match": "'([^'\\\\]|\\\\.)*'",
        "token": "string"
      },
      {
        "match": "\\{",
        "token": "delimiter.bracket",
        "next": "@jsx_expression"
      }
    ],
    "jsx_children": [
      {
        "match": "<\\/>",
        "token": "tag",
        "next": "@pop"
      },
      {
        "match": "</[A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*\\s*>",
        "token": "tag",
        "next": "@pop"
      },
      {
        "match": "<>",
        "token": "tag",
        "next": "@jsx_children"
      },
      {
        "match": "<\\/?[A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*",
        "token": "tag",
        "next": "@jsx_tag"
      },
      {
        "match": "\\{",
        "token": "delimiter.bracket",
        "next": "@jsx_expression"
      },
      {
        "match": "[^<{]+",
        "token": ""
      }
    ],
    "jsx_expression": [
      {
        "match": "\\{",
        "token": "delimiter.bracket",
        "next": "@jsx_expression"
      },
      {
        "match": "\\}",
        "token": "delimiter.bracket",
        "next": "@pop"
      },
      {
        "match": "<>",
        "token": "tag",
        "next": "@jsx_children"
      },
      {
        "match": "<\\/?[A-Za-z_$][\\w$]*(?:\\.[A-Za-z_$][\\w$]*)*",
        "token": "tag",
        "next": "@jsx_tag"
      },
      {
        "match": "\\/\\/.*$",
        "token": "comment"
      },
      {
        "match": "\\/\\*",
        "token": "comment",
        "next": "@block_comment"
      },
      {
        "match": "\"([^\"\\\\]|\\\\.)*\"",
        "token": "string"
      },
      {
        "match": "'([^'\\\\]|\\\\.)*'",
        "token": "string"
      },
      {
        "match": "\\b\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?(?:[nNL])?\\b",
        "token": "number.float"
      },
      {
        "match": "[A-Za-z_$][\\w$]*",
        "token": "@cases",
        "cases": {
          "@declarationKeywords": "keyword.declaration",
          "@controlKeywords": "keyword.control",
          "@default": "identifier"
        }
      },
      {
        "match": "[{}()\\[\\]]",
        "token": "delimiter"
      },
      {
        "match": "[;,.]",
        "token": "delimiter"
      },
      {
        "match": "[+\\-*/%&|^~<>!=?:]+",
        "token": "operator"
      }
    ]
  }
};

export const mylangPrimitiveTypes = [
  "string",
  "number",
  "boolean",
  "int",
  "long",
  "bigint",
  "numeric",
  "unknown",
  "any",
  "void",
  "never",
  "object"
];

export default mylangPortableLanguage;
