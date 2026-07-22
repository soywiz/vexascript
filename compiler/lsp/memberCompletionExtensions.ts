import { CallExpression, FunctionStatement, Identifier, NewExpression, VarStatement } from "compiler/ast/ast";
import type { Statement } from "compiler/ast/ast";
import { bindingIdentifiers } from "compiler/ast/bindingPatterns";
import { parseTypeNameShape } from "compiler/analysis/typeNames";
import { typeToString } from "compiler/analysis/types";
import type { Analysis } from "compiler/analysis/Analysis";


export function extensionReceiverMatches(receiverType: string, objectTypeName: string): boolean {
  // Array-shaped types (`int[]`, `Array<int>`) resolve their extension members
  // against the `Array` receiver, so `[].extensionMember` and `someArray.method()`
  // surface generic `Array<T>` extensions.
  const shape = parseTypeNameShape(objectTypeName);
  if (shape.arrayDepth > 0 && receiverType === "Array") {
    return true;
  }
  const normalized = shape.baseName;
  return receiverType === normalized || (normalized === "int" && receiverType === "number");
}

export function inferExtensionReturnTypeName(
  statement: Statement,
  analysis: Analysis | null
): string | null {
  if (statement instanceof VarStatement) {
    const variable = statement as VarStatement;
    if (variable.typeAnnotation?.name) {
      return variable.typeAnnotation.name;
    }
    if (variable.initializer && analysis) {
      const initializerType = analysis.getExpressionTypes().get(variable.initializer);
      const typeName = initializerType ? typeToString(initializerType) : null;
      if (typeName && typeName !== "unknown") {
        return typeName;
      }
    }
    const initializer = variable.initializer;
    if (initializer instanceof CallExpression) {
      const call = initializer as CallExpression;
      if (call.callee instanceof Identifier) {
        return (call.callee as Identifier).name;
      }
    }
    if (initializer instanceof NewExpression) {
      const newExpression = initializer as NewExpression;
      if (newExpression.callee instanceof Identifier) {
        return (newExpression.callee as Identifier).name;
      }
    }
    return null;
  }
  if (statement instanceof FunctionStatement) {
    return (statement as FunctionStatement).returnType?.name ?? null;
  }
  return null;
}

export function extensionBindingNames(statement: VarStatement): string[] {
  const bindings = statement.declarations?.flatMap((item) => bindingIdentifiers(item.name)) ?? bindingIdentifiers(statement.name);
  return bindings.map((binding) => binding.name);
}
