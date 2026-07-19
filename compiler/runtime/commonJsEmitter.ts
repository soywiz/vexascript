import { NodeKind } from "compiler/ast/ast";
import type { ExportStatement, ExprStatement, ImportStatement, Statement } from "compiler/ast/ast";

export interface CommonJsRuntimeExportBinding {
  exportedName: string;
  valueExpression: string;
}

export interface CommonJsEmitterContext {
  rewriteImportPath(path: string): string;
  nextGeneratedSymbol(prefix: string): string;
  emitExpression(statement: ExprStatement["expression"]): string;
  emitStatement(statement: Statement): string;
  commonJsRuntimeExportBindings(statement: Statement): CommonJsRuntimeExportBinding[];
  resolveJsName(name: string): string;
  importedOverloadRuntimeNames(importedName: string, localName: string): string[];
  importedExtensionRuntimeNames(importedName: string): string[];
  getExtensionPropertyReceiverType(localName: string): string | undefined;
  getExtensionPropertySetterReceiverType(localName: string): string | undefined;
  extensionPropertyRuntimeName(receiverType: string, propertyName: string): string;
  extensionPropertySetterRuntimeName(receiverType: string, propertyName: string): string;
  isOperatorImportName(name: string): boolean;
  defaultRequireBinding(target: string): string;
  esmImportBindingToCommonJs(binding: string): string;
}

export function emitCommonJsExportStatement(exportStatement: ExportStatement, context: CommonJsEmitterContext): string {
  if (exportStatement.typeOnly) {
    return "";
  }
  if (exportStatement.namespaceExport) {
    if (!exportStatement.from) {
      return "";
    }
    const exportTemp = context.nextGeneratedSymbol("__vexa_export");
    return [
      `const ${exportTemp} = require(${JSON.stringify(context.rewriteImportPath(exportStatement.from.value))});`,
      `exports.${exportStatement.namespaceExport.name} = ${exportTemp};`
    ].join("\n");
  }
  if (exportStatement.exportAll) {
    if (!exportStatement.from) {
      return "";
    }
    const exportTemp = context.nextGeneratedSymbol("__vexa_export_all");
    return [
      `const ${exportTemp} = require(${JSON.stringify(context.rewriteImportPath(exportStatement.from.value))});`,
      `for (const __vexa_export_key in ${exportTemp}) {`,
      `  if (__vexa_export_key !== "default" && __vexa_export_key !== "__esModule") {`,
      `    exports[__vexa_export_key] = ${exportTemp}[__vexa_export_key];`,
      `  }`,
      `}`
    ].join("\n");
  }
  if (exportStatement.specifiers) {
    const lines: string[] = [];
    let usesDefaultExport = false;
    let exportSource: string | null = null;
    if (exportStatement.from) {
      exportSource = context.nextGeneratedSymbol("__vexa_export");
      lines.push(`const ${exportSource} = require(${JSON.stringify(context.rewriteImportPath(exportStatement.from.value))});`);
    }
    for (const specifier of exportStatement.specifiers) {
      if (specifier.typeOnly) {
        continue;
      }
      const exportedName = specifier.exported.name;
      if (exportedName === "default") {
        usesDefaultExport = true;
      }
      const localName = exportStatement.from
        ? (specifier.local ?? specifier.exported).name
        : context.resolveJsName((specifier.local ?? specifier.exported).name);
      lines.push(`exports.${exportedName} = ${exportSource ? `${exportSource}.${localName}` : localName};`);
    }
    if (usesDefaultExport) {
      lines.push("exports.__esModule = true;");
    }
    return lines.join("\n");
  }
  if (!exportStatement.declaration) {
    return "";
  }
  if (exportStatement.isDefault && exportStatement.declaration.kind === NodeKind.ExprStatement) {
    return `exports.default = ${context.emitExpression((exportStatement.declaration as ExprStatement).expression)};\nexports.__esModule = true;`;
  }
  const emitted = context.emitStatement(exportStatement.declaration);
  if (!emitted) {
    return "";
  }
  const runtimeBindings = context.commonJsRuntimeExportBindings(exportStatement.declaration);
  if (exportStatement.isDefault) {
    const defaultTarget = runtimeBindings[0]?.valueExpression;
    return defaultTarget ? `${emitted}\nexports.default = ${defaultTarget};\nexports.__esModule = true;` : emitted;
  }
  if (runtimeBindings.length === 0) {
    return emitted;
  }
  const runtimeExportLines: string[] = [];
  for (const binding of runtimeBindings) {
    runtimeExportLines.push(`exports.${binding.exportedName} = ${binding.valueExpression};`);
  }
  return [
    emitted,
    ...runtimeExportLines
  ].join("\n");
}

export function emitCommonJsImportStatement(importStatement: ImportStatement, context: CommonJsEmitterContext): string {
  if (importStatement.typeOnly) {
    return "";
  }
  const source = JSON.stringify(context.rewriteImportPath(importStatement.from.value));
  if (importStatement.sideEffectOnly) {
    return `require(${source});`;
  }
  const namedImports: string[] = [];
  for (const specifier of importStatement.specifiers) {
    const localName = specifier.local?.name ?? specifier.imported.name;
    const overloadRuntimeNames = context.importedOverloadRuntimeNames(specifier.imported.name, localName);
    if (overloadRuntimeNames.length > 0) {
      namedImports.push(...overloadRuntimeNames);
      continue;
    }

    const extensionRuntimeNames = context.importedExtensionRuntimeNames(specifier.imported.name);
    if (extensionRuntimeNames.length > 0) {
      namedImports.push(...extensionRuntimeNames);
      continue;
    }

    const extensionPropertyReceiverType = context.getExtensionPropertyReceiverType(localName);
    if (extensionPropertyReceiverType) {
      const importedName = context.extensionPropertyRuntimeName(extensionPropertyReceiverType, specifier.imported.name);
      namedImports.push(specifier.local ? `${importedName} as ${specifier.local.name}` : importedName);
      const setterReceiverType = context.getExtensionPropertySetterReceiverType(localName);
      if (setterReceiverType) {
        namedImports.push(context.extensionPropertySetterRuntimeName(setterReceiverType, specifier.imported.name));
      }
      continue;
    }

    if (!context.isOperatorImportName(specifier.imported.name)) {
      namedImports.push(specifier.local ? `${specifier.imported.name} as ${specifier.local.name}` : specifier.imported.name);
    }
  }
  const hadOperatorImport = importStatement.specifiers.some((specifier) => context.isOperatorImportName(specifier.imported.name));
  const lines: string[] = [];
  const requiresModuleObject = importStatement.defaultImport !== undefined || importStatement.namespaceImport !== undefined;
  let moduleObject = "";
  if (requiresModuleObject) {
    moduleObject = context.nextGeneratedSymbol("__vexa_import");
    lines.push(`const ${moduleObject} = require(${source});`);
  }
  if (importStatement.defaultImport) {
    lines.push(`const ${importStatement.defaultImport.name} = ${context.defaultRequireBinding(moduleObject)};`);
  }
  if (importStatement.namespaceImport) {
    lines.push(`const ${importStatement.namespaceImport.name} = ${moduleObject};`);
  }
  if (namedImports.length > 0) {
    const bindingTarget = moduleObject.length > 0 ? moduleObject : `require(${source})`;
    lines.push(`const { ${namedImports.map(context.esmImportBindingToCommonJs).join(", ")} } = ${bindingTarget};`);
  }
  if (lines.length === 0) {
    return hadOperatorImport ? `require(${source});` : "";
  }
  return lines.join("\n");
}
