import { ClassStatement, EnumStatement, ExportStatement, FunctionStatement, Identifier, NamespaceStatement, NodeKind, VarStatement } from "compiler/ast/ast";
import type { FunctionParameter, Program, Statement } from "compiler/ast/ast";

import { bindingIdentifiers } from "compiler/ast/bindingPatterns";
import { extname } from "compiler/utils/path";
import { operatorBaseRuntimeName, sanitizeManglePart } from "./operatorNames";

export interface ImplicitVexaExportPlan {
  esmSpecifiers: string[];
  commonJsLines: string[];
}

function parameterTypeNameForExport(parameter: FunctionParameter): string {
  return parameter.typeAnnotation?.name ?? "unknown";
}

function overloadSuffixForExport(parameters: FunctionParameter[]): string {
  const visibleParameters = parameters.filter((parameter) => parameter.thisParameter !== true);
  return visibleParameters
    .map((parameter) => sanitizeManglePart(`${parameter.rest ? "rest " : ""}${parameterTypeNameForExport(parameter)}`))
    .join("$$") || "void";
}

function overloadedRuntimeName(name: string, parameters: FunctionParameter[]): string {
  return `${name}$$${overloadSuffixForExport(parameters)}`;
}

function extensionMethodRuntimeExportName(receiverType: string, baseName: string, parameters: FunctionParameter[]): string {
  return `${sanitizeManglePart(receiverType)}$$${overloadedRuntimeName(baseName, parameters)}`;
}

function extensionPropertyRuntimeExportName(receiverType: string, propertyName: string): string {
  return `${sanitizeManglePart(receiverType)}$$${sanitizeManglePart(propertyName)}`;
}

function extensionPropertySetterRuntimeExportName(receiverType: string, propertyName: string): string {
  return `${extensionPropertyRuntimeExportName(receiverType, propertyName)}$set`;
}

function implicitRuntimeExportNames(statement: Statement): string[] {
  switch (statement.kind) {
    case NodeKind.VarStatement: {
      const variable = statement as VarStatement;
      if (variable.declared) {
        return [];
      }
      if (variable.receiverType && variable.name instanceof Identifier) {
        const names = [extensionPropertyRuntimeExportName(variable.receiverType.name, variable.name.name)];
        if (variable.accessors?.some((accessor) => accessor.accessorKind === "set")) {
          names.push(extensionPropertySetterRuntimeExportName(variable.receiverType.name, variable.name.name));
        }
        return names;
      }
      const names = new Set<string>();
      for (const identifier of bindingIdentifiers(variable.name)) {
        names.add(identifier.name);
      }
      for (const declarator of variable.declarations ?? []) {
        for (const identifier of bindingIdentifiers(declarator.name)) {
          names.add(identifier.name);
        }
      }
      return [...names];
    }
    case NodeKind.FunctionStatement: {
      const fn = statement as FunctionStatement;
      if (fn.declared || fn.missingBody) {
        return [];
      }
      if (fn.receiverType) {
        const baseName = fn.operator ? operatorBaseRuntimeName(fn.operator) : fn.name.name;
        return [extensionMethodRuntimeExportName(fn.receiverType.name, baseName, fn.parameters)];
      }
      return [fn.name.name];
    }
    case NodeKind.ClassStatement:
    case NodeKind.EnumStatement:
    case NodeKind.NamespaceStatement: {
      if ((statement as { declared?: boolean }).declared) {
        return [];
      }
      if (statement instanceof NamespaceStatement) {
        const names = (statement as { names?: Identifier[] }).names;
        return names && names.length > 0 ? [names[0]!.name] : [];
      }
      return [((statement as { name?: Identifier }).name?.name ?? "")].filter((name) => name.length > 0);
    }
    default:
      return [];
  }
}

export function collectImplicitVexaExportPlan(ast: Program | null, filePath: string): ImplicitVexaExportPlan {
  if (extname(filePath).toLowerCase() !== ".vx" || !ast) {
    return { esmSpecifiers: [], commonJsLines: [] };
  }

  const overloadCounts = new Map<string, number>();
  for (const statement of ast.body) {
    if (statement instanceof FunctionStatement && !(statement as FunctionStatement).declared) {
      const fn = statement as FunctionStatement;
      overloadCounts.set(fn.name.name, (overloadCounts.get(fn.name.name) ?? 0) + 1);
    }
  }

  const esmSpecifiers = new Set<string>();
  const commonJsLines = new Set<string>();

  for (const statement of ast.body) {
    if (statement instanceof ExportStatement) {
      continue;
    }
    if (statement instanceof VarStatement) {
      const variable = statement as VarStatement;
      if (variable.declared) {
        continue;
      }
      if (variable.receiverType && variable.name instanceof Identifier) {
        const variableName = variable.name as Identifier;
        const runtimeName = extensionPropertyRuntimeExportName(variable.receiverType.name, variableName.name);
        esmSpecifiers.add(runtimeName);
        commonJsLines.add(`exports.${runtimeName} = ${runtimeName};`);
        if (variable.accessors?.some((accessor) => accessor.accessorKind === "set")) {
          const setterRuntimeName = extensionPropertySetterRuntimeExportName(variable.receiverType.name, variableName.name);
          esmSpecifiers.add(setterRuntimeName);
          commonJsLines.add(`exports.${setterRuntimeName} = ${setterRuntimeName};`);
        }
        continue;
      }
      if (variable.declarations && variable.declarations.length > 0) {
        for (const declaration of variable.declarations) {
          const name = declaration.name;
          if (!(name instanceof Identifier) || declaration.delegate) {
            continue;
          }
          const sourceName: string = (name as Identifier).name;
          esmSpecifiers.add(sourceName);
          commonJsLines.add(`exports.${sourceName} = ${sourceName};`);
        }
      } else if (variable.name instanceof Identifier && !variable.delegate) {
        const sourceName: string = (variable.name as Identifier).name;
        const runtimeName = variable.jsName ?? sourceName;
        esmSpecifiers.add(runtimeName === sourceName ? sourceName : `${runtimeName} as ${sourceName}`);
        commonJsLines.add(`exports.${sourceName} = ${runtimeName};`);
      }
      continue;
    }
    if (statement instanceof FunctionStatement) {
      const fn = statement as FunctionStatement;
      if (fn.declared || fn.missingBody) {
        continue;
      }
      if (fn.receiverType) {
        const baseName = fn.operator ? operatorBaseRuntimeName(fn.operator) : fn.name.name;
        const runtimeName = extensionMethodRuntimeExportName(fn.receiverType.name, baseName, fn.parameters);
        esmSpecifiers.add(runtimeName);
        commonJsLines.add(`exports.${runtimeName} = ${runtimeName};`);
        continue;
      }
      const runtimeName = fn.jsName
        ?? ((overloadCounts.get(fn.name.name) ?? 0) > 1
          ? overloadedRuntimeName(fn.name.name, fn.parameters)
          : fn.name.name);
      const exportName = fn.jsName ? fn.name.name : runtimeName;
      esmSpecifiers.add(fn.jsName ? `${runtimeName} as ${fn.name.name}` : runtimeName);
      commonJsLines.add(`exports.${exportName} = ${runtimeName};`);
      continue;
    }
    if (statement instanceof ClassStatement) {
      if (statement.declared) {
        continue;
      }
      const sourceName = statement.name.name;
      const runtimeName = statement.jsName ?? sourceName;
      esmSpecifiers.add(runtimeName === sourceName ? sourceName : `${runtimeName} as ${sourceName}`);
      commonJsLines.add(`exports.${sourceName} = ${runtimeName};`);
      continue;
    }
    if (statement instanceof EnumStatement) {
      if (statement.declared) {
        continue;
      }
      const sourceName = statement.name.name;
      const runtimeName = statement.jsName ?? sourceName;
      esmSpecifiers.add(runtimeName === sourceName ? sourceName : `${runtimeName} as ${sourceName}`);
      commonJsLines.add(`exports.${sourceName} = ${runtimeName};`);
      continue;
    }
    if (statement instanceof NamespaceStatement) {
      if (statement.declared) {
        continue;
      }
      const sourceName = statement.names?.[0]?.name;
      if (sourceName) {
        esmSpecifiers.add(sourceName);
        commonJsLines.add(`exports.${sourceName} = ${sourceName};`);
      }
      continue;
    }
    for (const name of implicitRuntimeExportNames(statement)) {
      esmSpecifiers.add(name);
      commonJsLines.add(`exports.${name} = ${name};`);
    }
  }

  return {
    esmSpecifiers: [...esmSpecifiers],
    commonJsLines: [...commonJsLines]
  };
}
