import { LANGUAGE_THEME_ID } from "compiler/language";

export const VEXA_MONACO_THEME_NAME = LANGUAGE_THEME_ID;

export interface MonacoThemeRule {
  token: string;
  foreground: string;
  fontStyle?: string;
}

export interface MonacoStandaloneThemeData {
  base: "vs" | "vs-dark" | "hc-black";
  inherit: boolean;
  rules: MonacoThemeRule[];
  colors: Record<string, string>;
}

export function createVexaScriptMonacoTheme(): MonacoStandaloneThemeData {
  return {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: "6A9955" },
      { token: "comment.doc", foreground: "9CDC8C", fontStyle: "italic" },
      { token: "comment.doc.param", foreground: "D7BA7D", fontStyle: "bold" },
      { token: "keyword.declaration", foreground: "569CD6" },
      { token: "keyword.control", foreground: "C586C0" },
      { token: "keywordModifier", foreground: "569CD6" },
      { token: "keywordFunction", foreground: "DCDCAA" },
      { token: "keywordType", foreground: "4EC9B0" },
      { token: "keywordControl", foreground: "C586C0" },
      { token: "keyword", foreground: "569CD6" },
      { token: "variable", foreground: "D4D4D4" },
      { token: "parameter", foreground: "9CDCFE" },
      { token: "function", foreground: "DCDCAA" },
      { token: "method", foreground: "DCDCAA" },
      { token: "class", foreground: "4EC9B0" },
      { token: "enumMember", foreground: "4FC1FF" },
      { token: "property", foreground: "9CDCFE" },
      { token: "namespace", foreground: "4EC9B0" },
      { token: "type", foreground: "4EC9B0" },
      { token: "number", foreground: "B5CEA8" },
      { token: "string", foreground: "CE9178" },
      { token: "operator", foreground: "D4D4D4" },
      { token: "tag", foreground: "D4D4D4" },
      { token: "attribute.name", foreground: "9CDCFE" },
    ],
    colors: {
      "editorGutter.background": "#1e1e1e",
    },
  };
}
