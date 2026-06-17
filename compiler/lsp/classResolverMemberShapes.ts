import { bindingNameText } from "compiler/ast/bindingPatterns";
import type {
  ClassStatement,
  ClassPrimaryConstructorParameter,
  FunctionParameter,
  InterfaceStatement,
  ReturnStatement
} from "compiler/ast/ast";
import { substituteTypeNameText } from "compiler/analysis/typeNames";
import { readDocumentationFromNamedNode, readDocumentationFromParameterLike } from "./documentation";
import { formatFunctionTypeLabel } from "./functionTypeDisplay";
import { typeNameFromAnalysisType } from "./classResolverTypeNames";
import type {
  ResolveClassMemberContext,
  ResolvedClassMember,
  ResolvedFunctionSignature,
  ResolvedParameter
} from "./classResolver";

type ClassPropertyParameter = FunctionParameter | ClassPrimaryConstructorParameter;

export function resolveClassOwnMember(
  classStatement: ClassStatement,
  memberName: string,
  substitutions: Map<string, string>,
  classPropertyParameters: (classStatement: ClassStatement) => ClassPropertyParameter[],
  context?: ResolveClassMemberContext
): ResolvedClassMember | null {
  for (const parameter of classPropertyParameters(classStatement)) {
    if (bindingNameText(parameter.name) !== memberName) {
      continue;
    }
    const typeName = substituteTypeNameText(parameter.typeAnnotation?.name ?? "unknown", substitutions);
    const documentation = readDocumentationFromParameterLike(parameter);
    const result: ResolvedClassMember = {
      className: classStatement.name.name,
      memberName,
      kind: "field",
      typeName
    };
    if (documentation) {
      result.documentation = documentation;
    }
    return result;
  }

  for (const member of classStatement.members) {
    if (member.name.name !== memberName) {
      continue;
    }
    if (member.kind === "ClassFieldMember") {
      const documentation = readDocumentationFromNamedNode(member);
      const result: ResolvedClassMember = {
        className: classStatement.name.name,
        memberName,
        kind: "field",
        typeName: substituteTypeNameText(member.typeAnnotation?.name ?? "unknown", substitutions)
      };
      if (documentation) {
        result.documentation = documentation;
      }
      return result;
    }

    if (member.accessorKind === "get") {
      const getterStatement = member.body.body[0];
      const getterExpression = getterStatement?.kind === "ReturnStatement"
        ? (getterStatement as ReturnStatement).expression
        : null;
      const inferredTypeName = !member.returnType && getterExpression && context?.analysis
        ? typeNameFromAnalysisType(context.analysis.getExpressionTypes().get(getterExpression))
        : null;
      const documentation = readDocumentationFromNamedNode(member);
      const result: ResolvedClassMember = {
        className: classStatement.name.name,
        memberName,
        kind: "field",
        typeName: substituteTypeNameText(member.returnType?.name ?? inferredTypeName ?? "unknown", substitutions)
      };
      if (documentation) {
        result.documentation = documentation;
      }
      return result;
    }

    if (member.accessorKind === "set") {
      const documentation = readDocumentationFromNamedNode(member);
      const result: ResolvedClassMember = {
        className: classStatement.name.name,
        memberName,
        kind: "field",
        typeName: substituteTypeNameText(member.parameters[0]?.typeAnnotation?.name ?? "unknown", substitutions)
      };
      if (documentation) {
        result.documentation = documentation;
      }
      return result;
    }

    const parameters: ResolvedParameter[] = member.parameters.map((parameter) => ({
      name: bindingNameText(parameter.name),
      typeName: substituteTypeNameText(parameter.typeAnnotation?.name ?? "unknown", substitutions),
      optional: parameter.optional === true || parameter.defaultValue !== undefined || parameter.rest === true,
      rest: parameter.rest === true
    }));
    const returnTypeName = substituteTypeNameText(member.returnType?.name ?? "void", substitutions);
    const documentation = readDocumentationFromNamedNode(member);
    const signature: ResolvedFunctionSignature = {
      name: member.name.name,
      parameters,
      returnTypeName,
      ...(documentation ? { documentation } : {})
    };
    return {
      className: classStatement.name.name,
      memberName,
      kind: "method",
      typeName: formatFunctionTypeLabel(parameters, returnTypeName),
      signature,
      ...(documentation ? { documentation } : {})
    };
  }

  return null;
}

export function classOwnMemberKind(
  classStatement: ClassStatement,
  memberName: string,
  classPropertyParameters: (classStatement: ClassStatement) => ClassPropertyParameter[]
): "field" | "method" | null {
  for (const parameter of classPropertyParameters(classStatement)) {
    if (bindingNameText(parameter.name) === memberName) {
      return "field";
    }
  }
  for (const member of classStatement.members) {
    if (member.name.name !== memberName) {
      continue;
    }
    return member.kind === "ClassFieldMember" || member.accessorKind ? "field" : "method";
  }
  return null;
}

export function resolveInterfaceOwnMember(
  interfaceStatement: InterfaceStatement,
  memberName: string,
  substitutions: Map<string, string>
): ResolvedClassMember | null {
  return resolveInterfaceOwnSignatures(interfaceStatement, memberName, substitutions)[0]?.member ?? null;
}

export function resolveInterfaceOwnSignatures(
  interfaceStatement: InterfaceStatement,
  memberName: string,
  substitutions: Map<string, string>
): Array<{ member: ResolvedClassMember; signature: ResolvedFunctionSignature }> {
  const results: Array<{ member: ResolvedClassMember; signature: ResolvedFunctionSignature }> = [];
  for (const member of interfaceStatement.members) {
    if (member.name.name !== memberName) {
      continue;
    }

    if (member.kind === "InterfacePropertyMember") {
      const documentation = readDocumentationFromNamedNode(member);
      const resolved: ResolvedClassMember = {
        className: interfaceStatement.name.name,
        memberName,
        kind: "field",
        typeName: substituteTypeNameText(member.typeAnnotation?.name ?? "unknown", substitutions)
      };
      if (documentation) {
        resolved.documentation = documentation;
      }
      const sig: ResolvedFunctionSignature = {
        name: memberName,
        parameters: [],
        returnTypeName: resolved.typeName
      };
      results.push({ member: resolved, signature: sig });
      return results;
    }

    const parameters: ResolvedParameter[] = member.parameters.map((parameter) => ({
      name: bindingNameText(parameter.name),
      typeName: substituteTypeNameText(parameter.typeAnnotation?.name ?? "unknown", substitutions),
      optional: parameter.optional === true || parameter.defaultValue !== undefined || parameter.rest === true,
      rest: parameter.rest === true
    }));
    const returnTypeName = substituteTypeNameText(member.returnType?.name ?? "void", substitutions);
    const documentation = readDocumentationFromNamedNode(member);
    const signature: ResolvedFunctionSignature = {
      name: member.name.name,
      parameters,
      returnTypeName,
      ...(documentation ? { documentation } : {})
    };
    const resolved: ResolvedClassMember = {
      className: interfaceStatement.name.name,
      memberName,
      kind: "method",
      typeName: formatFunctionTypeLabel(parameters, returnTypeName),
      signature,
      ...(documentation ? { documentation } : {})
    };
    results.push({ member: resolved, signature });
  }

  return results;
}
