import { Identifier, ImportStatement, StringLiteral, VarStatement } from "../ast/ast";
import type { Program, Statement } from "../ast/ast";
import type { Vfs } from "../vfs";
import { dirname, extname, resolve } from "../utils/path";

export const TEXT_MODULE_SUFFIX = "?text";

export function textModuleSourceSpecifier(specifier: string): string | null {
  if (!specifier.endsWith(TEXT_MODULE_SUFFIX)) {
    return null;
  }
  const sourceSpecifier = specifier.slice(0, -TEXT_MODULE_SUFFIX.length);
  return sourceSpecifier.length > 0 ? sourceSpecifier : null;
}

export function isTextModulePath(filePath: string): boolean {
  return textModuleSourceSpecifier(filePath) !== null;
}

export function textModuleSourcePath(filePath: string): string {
  return textModuleSourceSpecifier(filePath) ?? filePath;
}

export function asTextModulePath(filePath: string): string {
  return isTextModulePath(filePath) ? filePath : `${filePath}${TEXT_MODULE_SUFFIX}`;
}

async function resolveTextModuleSourcePath(
  importerFilePath: string,
  sourceSpecifier: string,
  activeVfs: Vfs,
  importMappings: Readonly<Record<string, string>>,
  baseUrl?: string
): Promise<string | null> {
  let candidate = "";
  if (sourceSpecifier in importMappings) {
    const mapped = importMappings[sourceSpecifier];
    if (mapped) {
      candidate = resolve(mapped);
    }
  }
  if (candidate === "") {
    if (sourceSpecifier.startsWith("/")) {
      candidate = resolve(sourceSpecifier);
    } else if (sourceSpecifier.startsWith(".")) {
      candidate = resolve(dirname(importerFilePath), sourceSpecifier);
    } else if (baseUrl) {
      candidate = resolve(baseUrl, sourceSpecifier);
    }
  }
  if (candidate === "") {
    return null;
  }
  return await activeVfs.fileExists(candidate) ? candidate : null;
}

export async function resolveTextModuleImportPath(
  importerFilePath: string,
  specifier: string,
  activeVfs: Vfs,
  importMappings: Readonly<Record<string, string>> = {},
  baseUrl?: string
): Promise<string | null> {
  const explicitSourceSpecifier = textModuleSourceSpecifier(specifier);
  if (explicitSourceSpecifier !== null) {
    return await resolveTextModuleSourcePath(
      importerFilePath,
      explicitSourceSpecifier,
      activeVfs,
      importMappings,
      baseUrl
    );
  }
  if (extname(specifier).toLowerCase() === ".txt") {
    return await resolveTextModuleSourcePath(
      importerFilePath,
      specifier,
      activeVfs,
      importMappings,
      baseUrl
    );
  }
  return null;
}

export class InlineTextModuleImportsResult {
  constructor(
    public errors: string[],
    public watchedFiles: string[]
  ) {}
}

function textImportBinding(statement: ImportStatement, source: string): Statement | null {
  if (
    !statement.defaultImport
    || statement.namespaceImport
    || statement.specifiers.length > 0
    || statement.sideEffectOnly
    || statement.typeOnly
  ) {
    return null;
  }
  const name = new Identifier(statement.defaultImport.name);
  const initializer = new StringLiteral(source);
  const declaration = new VarStatement("const", name);
  declaration.initializer = initializer;
  if (statement.firstToken) {
    declaration.firstToken = statement.firstToken;
  }
  if (statement.lastToken) {
    declaration.lastToken = statement.lastToken;
  }
  if (statement.__vexaNativeSourcePath) {
    declaration.__vexaNativeSourcePath = statement.__vexaNativeSourcePath;
  }
  return declaration;
}

export async function inlineTextModuleImports(
  program: Program,
  importerFilePath: string,
  activeVfs: Vfs,
  importMappings: Readonly<Record<string, string>> = {},
  baseUrl?: string
): Promise<InlineTextModuleImportsResult> {
  const errors: string[] = [];
  const watchedFiles: string[] = [];
  const body: Statement[] = [];
  for (const statement of program.body) {
    if (!(statement instanceof ImportStatement)) {
      body.push(statement);
      continue;
    }
    const importStatement = statement as ImportStatement;
    if (textModuleSourceSpecifier(importStatement.from.value) === null && extname(importStatement.from.value).toLowerCase() !== ".txt") {
      body.push(statement);
      continue;
    }
    const targetPath = await resolveTextModuleImportPath(
      importerFilePath,
      importStatement.from.value,
      activeVfs,
      importMappings,
      baseUrl
    );
    if (!targetPath) {
      errors.push(`Text import '${importStatement.from.value}' from '${importerFilePath}' did not resolve to a file`);
      continue;
    }
    const source = await activeVfs.readFile(targetPath);
    if (source === null) {
      errors.push(`Unable to read text import '${targetPath}'`);
      continue;
    }
    const binding = textImportBinding(importStatement, source);
    if (!binding) {
      errors.push(`Text import '${importStatement.from.value}' must use exactly one default import`);
      continue;
    }
    watchedFiles.push(targetPath);
    body.push(binding);
  }
  program.body = body;
  return new InlineTextModuleImportsResult(errors, watchedFiles);
}
