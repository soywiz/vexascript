import { describe, expect, it } from "../test/expect";
import { parseFile } from "compiler/parser/parser";
import { tokenizeReader } from "compiler/parser/tokenizer";
import type { ExportStatement, ImportStatement } from "compiler/ast/ast";
import {
  emitCommonJsExportStatement,
  emitCommonJsImportStatement,
  type CommonJsEmitterContext
} from "./commonJsEmitter";

function createContext(overrides: Partial<CommonJsEmitterContext> = {}): CommonJsEmitterContext {
  let counter = 0;
  return {
    rewriteImportPath: (path) => path,
    nextGeneratedSymbol: (prefix) => `${prefix}_${counter++}`,
    emitExpression: () => "value",
    emitStatement: () => "const local = value;",
    commonJsRuntimeExportBindings: () => [{ exportedName: "local", valueExpression: "local" }],
    resolveJsName: (name) => name === "local" ? "renamedLocal" : name,
    importedOverloadRuntimeNames: () => [],
    importedExtensionRuntimeNames: () => [],
    getExtensionPropertyReceiverType: () => undefined,
    getExtensionPropertySetterReceiverType: () => undefined,
    extensionPropertyRuntimeName: (receiverType, propertyName) => `${receiverType}$${propertyName}`,
    extensionPropertySetterRuntimeName: (receiverType, propertyName) => `${receiverType}$${propertyName}$set`,
    isOperatorImportName: () => false,
    defaultRequireBinding: (target) => `${target}.default`,
    esmImportBindingToCommonJs: (binding) => binding.replace(" as ", ": "),
    ...overrides
  };
}

describe("commonJsEmitter helpers", () => {
  it("marks default re-exports as __esModule when exporting specifiers", () => {
    const program = parseFile(tokenizeReader("export { local as default }"));
    const exportStatement = program.body[0] as ExportStatement;

    expect(emitCommonJsExportStatement(exportStatement, createContext())).toBe([
      "exports.default = renamedLocal;",
      "exports.__esModule = true;"
    ].join("\n"));
  });

  it("emits namespace re-exports for export * as name from", () => {
    const program = parseFile(tokenizeReader('export * as widgets from "./pkg"'));
    const exportStatement = program.body[0] as ExportStatement;

    expect(emitCommonJsExportStatement(exportStatement, createContext())).toBe([
      'const __vexa_export_0 = require("./pkg");',
      "exports.widgets = __vexa_export_0;"
    ].join("\n"));
  });

  it("emits CommonJS imports for default, named, and extension-property bindings", () => {
    const program = parseFile(tokenizeReader("import React, { useState as useLocalState, background } from \"react\""));
    const importStatement = program.body[0] as ImportStatement;

    expect(emitCommonJsImportStatement(importStatement, createContext({
      getExtensionPropertyReceiverType: (localName) => localName === "background" ? "Style" : undefined
    }))).toBe([
      'const __vexa_import_0 = require("react");',
      "const React = __vexa_import_0.default;",
      "const { useState: useLocalState, Style$background } = __vexa_import_0;"
    ].join("\n"));
  });

  it("emits CommonJS imports for extension-property setter bindings", () => {
    const program = parseFile(tokenizeReader('import { point } from "./position"'));
    const importStatement = program.body[0] as ImportStatement;

    expect(emitCommonJsImportStatement(importStatement, createContext({
      getExtensionPropertyReceiverType: (localName) => localName === "point" ? "View" : undefined,
      getExtensionPropertySetterReceiverType: (localName) => localName === "point" ? "View" : undefined
    }))).toBe('const { View$point, View$point$set } = require("./position");');
  });

  it("keeps operator-only imports as module loads so side effects still run", () => {
    const program = parseFile(tokenizeReader("import { operator+ } from \"./other\""));
    const importStatement = program.body[0] as ImportStatement;

    expect(emitCommonJsImportStatement(importStatement, createContext({
      isOperatorImportName: (name) => name === "operator+"
    }))).toBe('require("./other");');
  });
});
