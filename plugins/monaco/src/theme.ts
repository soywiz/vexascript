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
    ],
    colors: {
      "editorGutter.background": "#1e1e1e",
    },
  };
}
