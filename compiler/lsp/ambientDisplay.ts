import type {
  FunctionStatement,
  InterfaceMember,
  InterfaceMethodMember
} from "compiler/ast/ast";
import { formatFunctionTypeLabel } from "./functionTypeDisplay";

type AmbientDisplayParameter = {
  name: string;
  typeName: string;
  optional: boolean;
  rest: boolean;
};

export function renderAmbientTypeAnnotationText(typeName: string | undefined): string {
  return typeName?.trim() || "unknown";
}

function ambientDisplayParameters(
  parameters: readonly (FunctionStatement["parameters"][number] | InterfaceMethodMember["parameters"][number])[]
): AmbientDisplayParameter[] {
  return parameters
    .filter((parameter) => parameter.thisParameter !== true)
    .map((parameter) => ({
      name: parameter.name.kind === "Identifier" ? parameter.name.name : "arg",
      typeName: renderAmbientTypeAnnotationText(parameter.typeAnnotation?.name),
      optional: parameter.optional === true || parameter.defaultValue !== undefined || parameter.rest === true,
      rest: parameter.rest === true
    }));
}

export function renderAmbientFunctionDisplayFromParts(
  parameters: AmbientDisplayParameter[],
  returnTypeName: string,
  typeParameters?: string[]
): string {
  return formatFunctionTypeLabel(parameters, returnTypeName, typeParameters);
}

export function renderAmbientFunctionDisplayFromStatement(fn: FunctionStatement): string {
  return renderAmbientFunctionDisplayFromParts(
    ambientDisplayParameters(fn.parameters),
    renderAmbientTypeAnnotationText(fn.returnType?.name),
    fn.typeParameters?.map((parameter) => parameter.name.name)
  );
}

export function renderAmbientFunctionDisplayFromInterfaceMember(member: InterfaceMethodMember): string {
  return renderAmbientFunctionDisplayFromParts(
    ambientDisplayParameters(member.parameters),
    renderAmbientTypeAnnotationText(member.returnType?.name)
  );
}

export function renderAmbientInterfaceMemberDisplay(member: InterfaceMember): string {
  if (member.kind === "InterfaceMethodMember") {
    return renderAmbientFunctionDisplayFromInterfaceMember(member as InterfaceMethodMember);
  }
  return renderAmbientTypeAnnotationText(member.typeAnnotation?.name);
}
