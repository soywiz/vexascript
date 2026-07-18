import { NodeKind } from "compiler/ast/ast";
import type {
  FunctionParameter,
  FunctionStatement,
  Identifier,
  Program,
  Statement,
  VarStatement
} from "compiler/ast/ast";
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
      if (variable.receiverType && variable.name.kind === NodeKind.Identifier) {
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
      if (statement.kind === NodeKind.NamespaceStatement) {
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
    if (statement.kind === NodeKind.FunctionStatement && !(statement as FunctionStatement).declared) {
      const fn = statement as FunctionStatement;
      overloadCounts.set(fn.name.name, (overloadCounts.get(fn.name.name) ?? 0) + 1);
    }
  }

  const esmSpecifiers = new Set<string>();
  const commonJsLines = new Set<string>();

  for (const statement of ast.body) {
    if (statement.kind === NodeKind.ExportStatement) {
      continue;
    }
    if (statement.kind === NodeKind.VarStatement) {
      const variable = statement as VarStatement;
      if (variable.declared) {
        continue;
      }
      if (variable.receiverType && variable.name.kind === NodeKind.Identifier) {
        const runtimeName = extensionPropertyRuntimeExportName(variable.receiverType.name, variable.name.name);
        esmSpecifiers.add(runtimeName);
        commonJsLines.add(`exports.${runtimeName} = ${runtimeName};`);
        if (variable.accessors?.some((accessor) => accessor.accessorKind === "set")) {
          const setterRuntimeName = extensionPropertySetterRuntimeExportName(variable.receiverType.name, variable.name.name);
          esmSpecifiers.add(setterRuntimeName);
          commonJsLines.add(`exports.${setterRuntimeName} = ${setterRuntimeName};`);
        }
        continue;
      }
      const declarations = variable.declarations && variable.declarations.length > 0
        ? variable.declarations
        : [{ name: variable.name, delegate: variable.delegate }];
      for (const declaration of declarations) {
        if (declaration.name.kind !== NodeKind.Identifier || declaration.delegate) {
          continue;
        }
        const sourceName = declaration.name.name;
        const runtimeName = declarations.length === 1 ? (variable.jsName ?? sourceName) : sourceName;
        esmSpecifiers.add(runtimeName === sourceName ? sourceName : `${runtimeName} as ${sourceName}`);
        commonJsLines.add(`exports.${sourceName} = ${runtimeName};`);
      }
      continue;
    }
    if (statement.kind === NodeKind.FunctionStatement) {
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
    if (statement.kind === NodeKind.ClassStatement || statement.kind === NodeKind.EnumStatement) {
      if ((statement as { declared?: boolean }).declared) {
        continue;
      }
      const sourceName = (statement as { name?: Identifier }).name?.name;
      if (!sourceName) {
        continue;
      }
      const runtimeName = (statement as { jsName?: string }).jsName ?? sourceName;
      esmSpecifiers.add(runtimeName === sourceName ? sourceName : `${runtimeName} as ${sourceName}`);
      commonJsLines.add(`exports.${sourceName} = ${runtimeName};`);
      continue;
    }
    if (statement.kind === NodeKind.NamespaceStatement) {
      if ((statement as { declared?: boolean }).declared) {
        continue;
      }
      const sourceName = (statement as { names?: Identifier[] }).names?.[0]?.name;
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
