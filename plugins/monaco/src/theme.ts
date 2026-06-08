export const MYLANG_MONACO_THEME_NAME = "mylang-dark";

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

export function createMyLangMonacoTheme(): MonacoStandaloneThemeData {
  return {
    base: "vs-dark",
    inherit: true,
    rules: [
      { token: "comment", foreground: "6A9955" },
      { token: "comment.doc", foreground: "9CDC8C", fontStyle: "italic" },
      { token: "keyword.declaration", foreground: "569CD6" },
      { token: "keyword.control", foreground: "C586C0" },
      { token: "tag", foreground: "4EC9B0" },
      { token: "attribute.name", foreground: "9CDCFE" },
    ],
    colors: {
      "editorGutter.background": "#1e1e1e",
    },
  };
}
