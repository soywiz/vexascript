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
import type { AnalysisType } from "compiler/analysis/types";
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
  resolveNodeModulesModuleObjectMemberDefinition,
  resolveExtensionMemberDeclarationAcrossFiles,
  resolveImportedExtensionMemberDeclarationAcrossFiles,
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
import { resolveContextualObjectLiteralPropertyDefinition } from "./objectLiteralCompletion";
import { resolveContextualObjectLiteralPropertyHover } from "./objectLiteralCompletion";
import {
  resolveImportPathDefinition,
  resolveImportPathHover,
  resolveImportSpecifierDefinition
} from "./importPathNavigation";
import { findAmbientNamespaceLocation } from "./crossFileContext";
import { candidateCharacters, createDefinitionLocation, createHover } from "./navigation";

function collectNodeModulesReceiverTypeNames(objectType: AnalysisType): string[] {
  const names: string[] = [];
  const seen = new Set<string>();
  const push = (name: string) => {
    if (seen.has(name)) {
      return;
    }
    seen.add(name);
    names.push(name);
  };
  const visit = (type: AnalysisType) => {
    if (type.kind === "array") {
      push("Array");
      return;
    }
    if ((type.kind === "named" || type.kind === "builtin") && type.name === "int") {
      push("int");
      push("number");
      return;
    }
    if (type.kind === "named" || type.kind === "builtin") {
      push(type.name);
      return;
    }
    if (type.kind === "union" || type.kind === "intersection") {
      for (const memberType of type.types) {
        visit(memberType);
      }
    }
  };

  visit(objectType);
  return names;
}

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
  const nodeModulesModuleObjectDefinition =
    memberExpression.object.kind === "Identifier"
      ? await resolveNodeModulesModuleObjectMemberDefinition(
        context,
        (memberExpression.object as Identifier).name,
        memberName
      )
      : null;
  if (nodeModulesModuleObjectDefinition) {
    return nodeModulesModuleObjectDefinition;
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

  // Otherwise the member may be an extension property/method (e.g.
  // `val number.seconds` or `fun Point.foo()`) declared at the top level of this
  // or an imported file. These are not class members, so resolve them by
  // matching the receiver type.
  const extensionDeclaration = await resolveExtensionMemberDeclarationAcrossFiles(
    context,
    objectType,
    memberName
  );
  if (extensionDeclaration) {
    const range = nodeRange(extensionDeclaration.declaration.name);
    if (range) {
      return {
        uri: pathToUri(extensionDeclaration.filePath),
        range
      };
    }
  }

  const importedExtensionDeclaration = await resolveImportedExtensionMemberDeclarationAcrossFiles(
    context,
    memberName
  );
  if (importedExtensionDeclaration) {
    const range = nodeRange(importedExtensionDeclaration.declaration.name);
    if (range) {
      return {
        uri: pathToUri(importedExtensionDeclaration.filePath),
        range
      };
    }
  }

  // Fallback: look for the member in node_modules .d.ts declarations. This
  // handles types whose namespace/interface is declared in a package's type
  // definitions rather than a local .vx file.
  for (const receiverTypeName of collectNodeModulesReceiverTypeNames(objectType)) {
    const nodeModulesDefinition = await resolveNodeModulesMemberDefinition(
      context,
      receiverTypeName,
      memberName
    );
    if (nodeModulesDefinition) {
      return nodeModulesDefinition;
    }
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

  for (const character of candidateCharacters(context.character)) {
    const objectLiteralPropertyDefinition = await resolveContextualObjectLiteralPropertyDefinition({ ...context, character });
    if (objectLiteralPropertyDefinition) {
      return objectLiteralPropertyDefinition;
    }
  }

  for (const character of candidateCharacters(context.character)) {
    const memberDefinition = await resolveMemberDefinitionAcrossFiles({ ...context, character });
    if (memberDefinition) {
      return memberDefinition;
    }
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

  for (const character of candidateCharacters(context.character)) {
    const ambientImportedSymbolDefinition = await resolveAmbientImportedSymbolDefinition({ ...context, character });
    if (ambientImportedSymbolDefinition) {
      return ambientImportedSymbolDefinition;
    }
  }

  for (const character of candidateCharacters(context.character)) {
    const symbol = await resolveCanonicalSymbol({ ...context, character });
    if (symbol) {
      return {
        uri: pathToUri(symbol.filePath),
        range: symbol.range
      };
    }
  }

  if (context.session.analysis) {
    for (const character of candidateCharacters(context.character)) {
      const symbolAt =
        context.session.analysis.getSymbolAt(context.line, character) ??
        context.session.analysis.getOperatorSymbolAt(context.line, character);
      const ambientNamespaceLocation = symbolAt
        ? findAmbientNamespaceLocation(context.session, symbolAt.symbol.name)
        : null;
      if (ambientNamespaceLocation) {
        return {
          uri: pathToUri(ambientNamespaceLocation.filePath),
          range: ambientNamespaceLocation.range
        };
      }
    }
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
    const objectLiteralPropertyHover = await resolveContextualObjectLiteralPropertyHover({ ...context, character });
    if (objectLiteralPropertyHover) {
      return objectLiteralPropertyHover;
    }
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
