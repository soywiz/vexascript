import { FunctionStatement, Program, StringLiteral } from "compiler/ast/ast";
import { unwrapExportedDeclaration } from "compiler/ast/traversal";

export interface CppBindingMetadata {
  headers: string[];
  flags: string[];
}

function annotationStrings(statement: FunctionStatement, name: string): string[] {
  const values: string[] = [];
  for (const annotation of statement.annotations ?? []) {
    if (annotation.name.name !== name) continue;
    for (const argument of annotation.args) {
      if (argument instanceof StringLiteral) values.push(argument.value);
    }
  }
  return values;
}

export function cppBodyForFunction(statement: FunctionStatement): string | undefined {
  return annotationStrings(statement, "CppBody").at(-1);
}

/** Collects native build metadata from modules selected by the native graph. */
export function cppBindingMetadata(program: Program): CppBindingMetadata {
  const headers = new Set<string>();
  const flags = new Set<string>();
  for (const bodyStatement of program.body) {
    const statement = unwrapExportedDeclaration(bodyStatement);
    if (!(statement instanceof FunctionStatement)) continue;
    for (const header of annotationStrings(statement, "CppHeader")) headers.add(header);
    for (const flag of annotationStrings(statement, "CppFlags")) flags.add(flag);
  }
  return { headers: [...headers], flags: [...flags] };
}
