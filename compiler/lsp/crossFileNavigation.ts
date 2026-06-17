export { resolveMemberHoverAcrossFiles } from "./crossFileMemberHover";

/**
 * Cross-file navigation operations: go-to-definition, hover, references, and
 * rename across local module imports. The shared plumbing lives in sibling
 * modules — resolve-context/session contracts and canonical symbol resolution
 * in crossFileContext.ts, member/type shape and declaration resolution in
 * crossFileTypeResolution.ts — so each operation here stays focused on
 * orchestrating those helpers into an LSP response.
 */
import type {
  Identifier,
} from "compiler/ast/ast";
import type { Hover, Location } from "vscode-languageserver/node.js";
import { pathToUri } from "./importFixes";
import { nodeRange } from "./ranges";
import {
  resolveCanonicalSymbol,
  type ResolveContext
} from "./crossFileContext";
import {
  findMemberExpressionAtPosition,
  findTypeIdentifierAtPosition,
  resolveTypeDefinitionAcrossFiles
} from "./crossFileTypeResolution";
import { resolveDeclaredMemberDefinitionAcrossFiles } from "./crossFileDeclaredMemberDefinition";
import {
  resolveExtensionMemberDefinitionAcrossFiles,
  resolveNodeModulesMemberDefinition
} from "./crossFileMemberDefinitionSources";
import {
  resolveImplicitReceiverMemberDefinition
} from "./crossFileImplicitReceiver";
import { resolveReferencesAcrossFiles as resolveReferencesAcrossFilesImpl } from "./crossFileReferences";
import {
  resolvePrepareRenameAcrossFiles as resolvePrepareRenameAcrossFilesImpl,
  resolveRenameAcrossFiles as resolveRenameAcrossFilesImpl
} from "./crossFileRename";
import {
  resolveMemberHoverAcrossFiles
} from "./crossFileMemberHover";
import {
  resolveAmbientImportedSymbolDefinition,
  resolveAmbientModuleObjectMemberDefinition,
  resolveAmbientReceiverDeclarationFilePath
} from "./crossFileAmbientNavigation";
import {
  resolveImportPathDefinition,
  resolveImportPathHover,
  resolveImportSpecifierDefinition
} from "./importPathNavigation";
import { candidateCharacters, createDefinitionLocation, createHover } from "./navigation";

async function resolveMemberDefinitionAcrossFiles(context: ResolveContext): Promise<Location | null> {
  if (!context.session.ast || !context.session.analysis) {
    return null;
  }
  const memberExpression = findMemberExpressionAtPosition(
    context.session.ast,
    context.line,
    context.character
  );
  if (!memberExpression || memberExpression.property.kind !== "Identifier") {
    return null;
  }

  const objectType = context.session.analysis.getExpressionTypes().get(memberExpression.object);
  if (!objectType) {
    return null;
  }

  const memberName = (memberExpression.property as Identifier).name;
  const ambientModuleObjectDefinition = await resolveAmbientModuleObjectMemberDefinition(
    context,
    memberExpression,
    memberName
  );
  if (ambientModuleObjectDefinition) {
    return ambientModuleObjectDefinition;
  }
  const receiverSymbol =
    memberExpression.object.kind === "Identifier"
      ? context.session.analysis.getSymbolAt(
        memberExpression.object.firstToken?.range.start.line ?? context.line,
        memberExpression.object.firstToken?.range.start.column ?? context.character
      )
      : null;
  const preferredAmbientReceiverFilePath = receiverSymbol
    ? resolveAmbientReceiverDeclarationFilePath(context, receiverSymbol.symbol.node, receiverSymbol.symbol.name)
    : null;
  const declaredMemberDefinition = await resolveDeclaredMemberDefinitionAcrossFiles(
    context,
    objectType,
    memberName,
    preferredAmbientReceiverFilePath
  );
  if (declaredMemberDefinition) {
    return declaredMemberDefinition;
  }

  const receiverTypeNames =
    objectType.kind === "array"
      ? ["Array"]
      : (objectType.kind === "named" || objectType.kind === "builtin") && objectType.name === "int"
        ? ["int", "number"]
        : objectType.kind === "named" || objectType.kind === "builtin"
          ? [objectType.name]
          : [];

  // Otherwise the member may be an extension property/method (e.g.
  // `val number.seconds` or `fun Point.foo()`) declared at the top level of this
  // or an imported file. These are not class members, so resolve them by
  // matching the receiver type.
  for (const receiverTypeName of receiverTypeNames) {
    const extension = await resolveExtensionMemberDefinitionAcrossFiles(context, receiverTypeName, memberName);
    if (extension) {
      return extension;
    }
  }

  // Fallback: look for the member in node_modules .d.ts declarations. This
  // handles types whose namespace/interface is declared in a package's type
  // definitions rather than a local .vx file.
  const nodeModulesDefinition = await resolveNodeModulesMemberDefinition(
    context,
    receiverTypeNames[0]!,
    memberName
  );
  if (nodeModulesDefinition) {
    return nodeModulesDefinition;
  }

  return null;
}

export async function resolveDefinitionAcrossFiles(context: ResolveContext): Promise<Location | null> {
  const importPathDefinition = await resolveImportPathDefinition(context);
  if (importPathDefinition) {
    return importPathDefinition;
  }

  const importSpecifierDefinition = await resolveImportSpecifierDefinition(context);
  if (importSpecifierDefinition) {
    return importSpecifierDefinition;
  }

  const memberDefinition = await resolveMemberDefinitionAcrossFiles(context);
  if (memberDefinition) {
    return memberDefinition;
  }

  const implicitReceiverDefinition = await resolveImplicitReceiverMemberDefinition(context);
  if (implicitReceiverDefinition) {
    return implicitReceiverDefinition;
  }

  const typeIdentifier = context.session.ast
    ? findTypeIdentifierAtPosition(context.session.ast, context.line, context.character)
    : null;
  if (typeIdentifier) {
    const typeDefinition = await resolveTypeDefinitionAcrossFiles(context, typeIdentifier.name);
    if (typeDefinition) {
      return {
        uri: pathToUri(typeDefinition.filePath),
        range: nodeRange(typeDefinition.declaration.name) ?? nodeRange(typeIdentifier)!
      };
    }
  }

  const ambientImportedSymbolDefinition = await resolveAmbientImportedSymbolDefinition(context);
  if (ambientImportedSymbolDefinition) {
    return ambientImportedSymbolDefinition;
  }

  const symbol = await resolveCanonicalSymbol(context);
  if (symbol) {
    return {
      uri: pathToUri(symbol.filePath),
      range: symbol.range
    };
  }
  return null;
}

/**
 * Resolves go-to-definition preferring cross-file navigation (imports, member
 * access across modules) and falling back to local navigation (doc comment
 * parameter refs, annotation refs, local symbol declarations).
 *
 * This is the canonical resolution order: cross-file first so that clicking an
 * imported name jumps to its declaration in the source file rather than to the
 * import specifier on the current file.
 */
export async function resolveDefinitionWithLocalFallback(
  context: ResolveContext
): Promise<Location | null> {
  const crossFile = await resolveDefinitionAcrossFiles(context);
  if (crossFile) {
    return crossFile;
  }
  return createDefinitionLocation(
    context.session.analysis!,
    context.uri,
    context.line,
    context.character,
    context.session.ast ?? undefined
  );
}

export async function resolveReferencesAcrossFiles(
  context: ResolveContext,
  includeDeclaration: boolean
): Promise<Location[]> {
  return resolveReferencesAcrossFilesImpl(context, includeDeclaration);
}

/**
 * Unified hover entrypoint. Runs the full cascade:
 * 1. Import path hover (cursor on a string literal import path)
 * 2. Member hover (cursor on a member access expression), with candidate
 *    character probing
 * 3. Local hover fallback (doc-comment params, annotations, analysis hover)
 */
export async function resolveHoverWithLocalFallback(context: ResolveContext): Promise<Hover | null> {
  const importHover = await resolveImportPathHover(context);
  if (importHover) {
    return importHover;
  }

  for (const character of candidateCharacters(context.character)) {
    const memberHover = await resolveMemberHoverAcrossFiles({ ...context, character });
    if (memberHover) {
      return memberHover;
    }
  }

  if (!context.session.analysis) {
    return null;
  }
  return createHover(context.session.analysis, context.line, context.character, context.session.ast ?? undefined, {
    ambientModuleDeclarations: context.session.ambientModuleDeclarations
  });
}

export async function resolvePrepareRenameAcrossFiles(
  context: ResolveContext
): Promise<import("vscode-languageserver/node.js").PrepareRenameResult | null> {
  return resolvePrepareRenameAcrossFilesImpl(context);
}

export async function resolveRenameAcrossFiles(
  context: ResolveContext,
  newName: string
): Promise<import("vscode-languageserver/node.js").WorkspaceEdit | null> {
  return resolveRenameAcrossFilesImpl(context, newName);
}
