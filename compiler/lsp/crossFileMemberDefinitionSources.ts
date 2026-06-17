import type { FunctionStatement, ImportStatement, VarStatement } from "compiler/ast/ast";
import type { Location } from "vscode-languageserver/node.js";
import type { ResolveContext } from "./crossFileContext";
import { effectiveSourceRoots } from "./crossFileContext";
import { resolveTopLevelDeclarationAcrossFiles } from "./declarationResolver";
import { pathToUri, uriToFilePath } from "./importFixes";
import { findNodeModuleMemberLocation } from "./nodeModulesTypings";
import { nodeRange } from "./ranges";

export async function resolveNodeModulesMemberDefinition(
  context: ResolveContext,
  typeName: string,
  memberName: string
): Promise<Location | null> {
  const currentFilePath = uriToFilePath(context.uri);
  if (!currentFilePath || !context.session.ast) return null;

  for (const stmt of context.session.ast.body) {
    if (stmt.kind !== "ImportStatement") continue;
    const importStmt = stmt as ImportStatement;
    const from = importStmt.from.value;
    if (from.startsWith(".") || from.startsWith("/")) continue;

    const location = await findNodeModuleMemberLocation(currentFilePath, from, typeName, memberName, { vfs: context.vfs });
    if (location) {
      return {
        uri: pathToUri(location.typingsPath),
        range: location.range
      };
    }
  }
  return null;
}

export async function resolveExtensionMemberDefinitionAcrossFiles(
  context: ResolveContext,
  receiverTypeName: string,
  memberName: string
): Promise<Location | null> {
  const currentFilePath = uriToFilePath(context.uri);
  if (!currentFilePath || !context.session.ast) {
    return null;
  }

  const roots = effectiveSourceRoots(context.sourceRoots, currentFilePath);
  const resolved = await resolveTopLevelDeclarationAcrossFiles({
    ast: context.session.ast,
    name: memberName,
    currentFilePath,
    predicate: (statement): statement is VarStatement | FunctionStatement => {
      if (statement.kind !== "VarStatement" && statement.kind !== "FunctionStatement") {
        return false;
      }
      return (statement as VarStatement | FunctionStatement).receiverType?.name === receiverTypeName;
    },
    sourceRoots: roots,
    ...(context.getSessionForFilePath
      ? { getSessionForFilePath: context.getSessionForFilePath }
      : {})
  });

  if (!resolved) {
    return null;
  }

  const range = nodeRange(resolved.declaration.name);
  if (!range) {
    return null;
  }

  return {
    uri: pathToUri(resolved.filePath === "" ? currentFilePath : resolved.filePath),
    range
  };
}
