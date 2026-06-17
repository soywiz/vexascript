/**
 * Shared textual parameter/signature rendering used by LSP surfaces that show
 * function-like shapes as labels rather than rich structured data.
 */
export interface DisplayParameterLike {
  name: string;
  typeName: string;
  optional?: boolean;
  rest?: boolean;
}

export function formatParameterLabel(parameter: DisplayParameterLike): string {
  const restPrefix = parameter.rest === true ? "..." : "";
  const optionalSuffix = parameter.optional === true && parameter.rest !== true ? "?" : "";
  return `${restPrefix}${parameter.name}${optionalSuffix}: ${parameter.typeName}`;
}

export function formatFunctionTypeLabel(
  parameters: ReadonlyArray<DisplayParameterLike>,
  returnTypeName: string,
  typeParameters?: readonly string[]
): string {
  const typeParameterPrefix = typeParameters && typeParameters.length > 0
    ? `<${typeParameters.join(", ")}>`
    : "";
  return `${typeParameterPrefix}(${parameters.map((parameter) => formatParameterLabel(parameter)).join(", ")}) => ${returnTypeName}`;
}
