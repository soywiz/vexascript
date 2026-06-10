export const LANGUAGE_NAME = "VexaScript";
export const LANGUAGE_SHORT_NAME = "Vexa";
export const LANGUAGE_ID = "vexa";
export const LANGUAGE_FILE_EXTENSION = ".vx";
export const LANGUAGE_SCOPE = "source.vexa";
export const LANGUAGE_MIME_TYPE = "text/x-vexa";
export const LANGUAGE_CLI_BIN = "vexa";
export const LANGUAGE_THEME_ID = "vexa-dark";
export const LANGUAGE_SHOW_REFERENCES_COMMAND = "vexa.showReferences";
export const LANGUAGE_AUTO_AWAIT_REQUEST = "vexa/autoAwaitDecorations";

export function replaceLanguageExtension(path: string, nextExtension: string): string {
  return path.replace(/\.[^.]+$/, nextExtension);
}
