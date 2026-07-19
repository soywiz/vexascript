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
