import { ClassFieldMember, InterfacePropertyMember, ReturnStatement } from "compiler/ast/ast";
import type { ClassPrimaryConstructorParameter, ClassStatement, FunctionParameter, InterfaceStatement } from "compiler/ast/ast";
import { bindingNameText } from "compiler/ast/bindingPatterns";

import { substituteTypeNameText } from "compiler/analysis/typeNames";
import { readDocumentationInfoFromNamedNode, readDocumentationInfoFromParameterLike } from "./documentation";
import { formatFunctionTypeLabel } from "./functionTypeDisplay";
import { typeNameFromAnalysisType } from "./classResolverTypeNames";
import type {
  ResolveClassMemberContext,
  ResolvedClassMember,
  ResolvedFunctionSignature,
  ResolvedParameter
} from "./classResolver";

type ClassPropertyParameter = FunctionParameter | ClassPrimaryConstructorParameter;

function documentationFields(documentation: { text: string; deprecated: boolean } | undefined): { documentation: string; deprecated?: true } | {} {
  if (!documentation) {
    return {};
  }
  return {
    documentation: documentation.text,
    ...(documentation.deprecated ? { deprecated: true as const } : {})
  };
}

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
    const documentation = readDocumentationInfoFromParameterLike(parameter);
    const result: ResolvedClassMember = {
      className: classStatement.name.name,
      memberName,
      kind: "field",
      typeName,
      ...documentationFields(documentation)
    };
    return result;
  }

  for (const member of classStatement.members) {
    if (member.name.name !== memberName) {
      continue;
    }
    if (member instanceof ClassFieldMember) {
      const inferredTypeName = !member.typeAnnotation && member.initializer && context?.analysis
        ? typeNameFromAnalysisType(context.analysis.getExpressionTypes().get(member.initializer))
        : null;
      const documentation = readDocumentationInfoFromNamedNode(member);
      const result: ResolvedClassMember = {
        className: classStatement.name.name,
        memberName,
        kind: "field",
        typeName: substituteTypeNameText(member.typeAnnotation?.name ?? inferredTypeName ?? "unknown", substitutions),
        ...documentationFields(documentation)
      };
      return result;
    }

    if (member.accessorKind === "get") {
      const getterStatement = member.body.body[0];
      const getterExpression = getterStatement instanceof ReturnStatement
        ? (getterStatement as ReturnStatement).expression
        : null;
      const inferredTypeName = !member.returnType && getterExpression && context?.analysis
        ? typeNameFromAnalysisType(context.analysis.getExpressionTypes().get(getterExpression))
        : null;
      const documentation = readDocumentationInfoFromNamedNode(member);
      const result: ResolvedClassMember = {
        className: classStatement.name.name,
        memberName,
        kind: "field",
        typeName: substituteTypeNameText(member.returnType?.name ?? inferredTypeName ?? "unknown", substitutions),
        ...documentationFields(documentation)
      };
      return result;
    }

    if (member.accessorKind === "set") {
      const documentation = readDocumentationInfoFromNamedNode(member);
      const result: ResolvedClassMember = {
        className: classStatement.name.name,
        memberName,
        kind: "field",
        typeName: substituteTypeNameText(member.parameters[0]?.typeAnnotation?.name ?? "unknown", substitutions),
        ...documentationFields(documentation)
      };
      return result;
    }

    const parameters: ResolvedParameter[] = member.parameters.map((parameter) => ({
      name: bindingNameText(parameter.name),
      typeName: substituteTypeNameText(parameter.typeAnnotation?.name ?? "unknown", substitutions),
      optional: parameter.optional === true || parameter.defaultValue !== undefined || parameter.rest === true,
      rest: parameter.rest === true
    }));
    const returnTypeName = substituteTypeNameText(member.returnType?.name ?? "void", substitutions);
    const documentation = readDocumentationInfoFromNamedNode(member);
    const signature: ResolvedFunctionSignature = {
      name: member.name.name,
      parameters,
      returnTypeName,
      ...documentationFields(documentation)
    };
    return {
      className: classStatement.name.name,
      memberName,
      kind: "method",
      typeName: formatFunctionTypeLabel(parameters, returnTypeName),
      signature,
      ...documentationFields(documentation)
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
    return member instanceof ClassFieldMember || member.accessorKind ? "field" : "method";
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

    if (member instanceof InterfacePropertyMember) {
      const documentation = readDocumentationInfoFromNamedNode(member);
      const resolved: ResolvedClassMember = {
        className: interfaceStatement.name.name,
        memberName,
        kind: "field",
        typeName: substituteTypeNameText(member.typeAnnotation?.name ?? "unknown", substitutions),
        ...documentationFields(documentation)
      };
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
    const documentation = readDocumentationInfoFromNamedNode(member);
    const signature: ResolvedFunctionSignature = {
      name: member.name.name,
      parameters,
      returnTypeName,
      ...documentationFields(documentation)
    };
    const resolved: ResolvedClassMember = {
      className: interfaceStatement.name.name,
      memberName,
      kind: "method",
      typeName: formatFunctionTypeLabel(parameters, returnTypeName),
      signature,
      ...documentationFields(documentation)
    };
    results.push({ member: resolved, signature });
  }

  return results;
}
