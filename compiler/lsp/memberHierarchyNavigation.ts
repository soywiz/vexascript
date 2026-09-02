import {
  ClassMethodMember,
  ClassStatement,
  InterfaceMethodMember,
  InterfaceStatement
} from "compiler/ast/ast";
import type { Program } from "compiler/ast/ast";
import { unwrapExportedDeclaration } from "compiler/ast/traversal";
import { resolve } from "compiler/utils/path";
import type { Location } from "vscode-languageserver/node.js";
import {
  createClassResolverCache,
  resolveInheritedClassMemberDeclarations,
  resolveInheritedInterfaceMemberDeclarations,
  type ResolveClassMemberContext,
  type ResolvedTypeMemberDeclaration
} from "./classResolver";
import {
  effectiveSourceRoots,
  getSessionForFilePath,
  type ResolveContext,
  type SessionLike
} from "./crossFileContext";
import { pathToUri, uriToFilePath } from "./importFixes";
import { scanProjectMyFiles } from "./projectAnalysis";
import { containsPosition, nodeRange } from "./ranges";

type MethodOwner = {
  declaration: ClassStatement | InterfaceStatement;
  filePath: string;
  member: ClassMethodMember | InterfaceMethodMember;
};

function typeDeclarations(ast: Program): Array<ClassStatement | InterfaceStatement> {
  const declarations: Array<ClassStatement | InterfaceStatement> = [];
  for (const statement of ast.body) {
    const declaration = unwrapExportedDeclaration(statement);
    if (declaration instanceof ClassStatement || declaration instanceof InterfaceStatement) {
      declarations.push(declaration);
    }
  }
  return declarations;
}

function ownMethod(
  declaration: ClassStatement | InterfaceStatement,
  memberName: string
): ClassMethodMember | InterfaceMethodMember | null {
  for (const member of declaration.members) {
    if (
      member.name.name === memberName &&
      (member instanceof ClassMethodMember || member instanceof InterfaceMethodMember)
    ) {
      return member;
    }
  }
  return null;
}

function methodOwnerAtPosition(
  ast: Program,
  filePath: string,
  line: number,
  character: number
): MethodOwner | null {
  for (const declaration of typeDeclarations(ast)) {
    for (const member of declaration.members) {
      if (!(member instanceof ClassMethodMember || member instanceof InterfaceMethodMember)) {
        continue;
      }
      const range = nodeRange(member.name);
      if (range && containsPosition(range, { line, character })) {
        return { declaration, filePath, member };
      }
    }
  }
  return null;
}

function methodOwnerFromDeclaration(
  declaration: ResolvedTypeMemberDeclaration
): MethodOwner | null {
  const member = ownMethod(declaration.declaration, declaration.memberName);
  return member
    ? { declaration: declaration.declaration, filePath: declaration.filePath, member }
    : null;
}

function resolverContext(
  context: ResolveContext,
  owner: MethodOwner,
  session: SessionLike
): ResolveClassMemberContext | null {
  if (!session.ast) {
    return null;
  }
  return {
    ast: session.ast,
    options: {
      uri: pathToUri(owner.filePath),
      sourceRoots: context.sourceRoots,
      ...(context.vfs ? { vfs: context.vfs } : {}),
      ...(context.importMappings ? { importMappings: context.importMappings } : {}),
      ...(context.getSessionForFilePath
        ? { getSessionForFilePath: context.getSessionForFilePath }
        : {})
    },
    ...(session.analysis ? { analysis: session.analysis } : {}),
    cache: createClassResolverCache()
  };
}

async function inheritedMethods(
  context: ResolveContext,
  owner: MethodOwner,
  session: SessionLike
): Promise<MethodOwner[]> {
  const memberName = owner.member.name.name;
  const classContext = resolverContext(context, owner, session);
  if (!classContext) {
    return [];
  }
  const inherited = owner.declaration instanceof ClassStatement
    ? await resolveInheritedClassMemberDeclarations(
      { classStatement: owner.declaration, filePath: owner.filePath },
      memberName,
      owner.declaration.name.name,
      classContext
    )
    : await resolveInheritedInterfaceMemberDeclarations(
      { interfaceStatement: owner.declaration, filePath: owner.filePath },
      memberName,
      owner.declaration.name.name,
      classContext
    );
  return inherited
    .map(methodOwnerFromDeclaration)
    .filter((candidate): candidate is MethodOwner => candidate !== null);
}

function ownerLocation(owner: MethodOwner): Location | null {
  const range = nodeRange(owner.member.name);
  return range ? { uri: pathToUri(owner.filePath), range } : null;
}

function locationKey(location: Location): string {
  const { start, end } = location.range;
  return `${location.uri}:${start.line}:${start.character}:${end.line}:${end.character}`;
}

async function sessionForOwner(
  context: ResolveContext,
  owner: MethodOwner
): Promise<SessionLike | null> {
  const currentFilePath = uriToFilePath(context.uri);
  return currentFilePath && resolve(currentFilePath) === resolve(owner.filePath)
    ? context.session
    : getSessionForFilePath(owner.filePath, context);
}

async function rootMethodKeys(
  context: ResolveContext,
  initialOwner: MethodOwner
): Promise<Set<string>> {
  const roots = new Set<string>();
  const visited = new Set<string>();
  const pending = [initialOwner];

  while (pending.length > 0) {
    const owner = pending.pop()!;
    const location = ownerLocation(owner);
    if (!location) {
      continue;
    }
    const key = locationKey(location);
    if (visited.has(key)) {
      continue;
    }
    visited.add(key);
    const session = await sessionForOwner(context, owner);
    const parents = session ? await inheritedMethods(context, owner, session) : [];
    if (parents.length === 0) {
      roots.add(key);
    } else {
      pending.push(...parents);
    }
  }

  return roots;
}

async function ownerForLocation(
  context: ResolveContext,
  location: Location
): Promise<MethodOwner | null> {
  const filePath = uriToFilePath(location.uri);
  if (!filePath) {
    return null;
  }
  const currentFilePath = uriToFilePath(context.uri);
  const session = currentFilePath && resolve(currentFilePath) === resolve(filePath)
    ? context.session
    : await getSessionForFilePath(filePath, context);
  return session?.ast
    ? methodOwnerAtPosition(
      session.ast,
      filePath,
      location.range.start.line,
      location.range.start.character
    )
    : null;
}

/** Go-to-definition behavior for a method declaration that overrides a base member. */
export async function resolveOverriddenMethodDefinition(
  context: ResolveContext
): Promise<Location | null> {
  const currentFilePath = uriToFilePath(context.uri);
  if (!currentFilePath || !context.session.ast) {
    return null;
  }
  const owner = methodOwnerAtPosition(
    context.session.ast,
    currentFilePath,
    context.line,
    context.character
  );
  if (!owner) {
    return null;
  }
  const inherited = await inheritedMethods(context, owner, context.session);
  return inherited.length > 0 ? ownerLocation(inherited[0]!) : null;
}

/**
 * Returns the overriding declarations for a hierarchy root selected at its
 * method name. An overriding declaration itself deliberately returns null so
 * ordinary definition lookup can continue upward to its nearest base method.
 */
export async function resolveBaseMethodOverrides(
  context: ResolveContext
): Promise<Location[] | null> {
  const currentFilePath = uriToFilePath(context.uri);
  if (!currentFilePath || !context.session.ast) {
    return null;
  }
  const owner = methodOwnerAtPosition(
    context.session.ast,
    currentFilePath,
    context.line,
    context.character
  );
  if (!owner) {
    return null;
  }
  const inherited = await inheritedMethods(context, owner, context.session);
  if (inherited.length > 0) {
    return null;
  }
  const definition = ownerLocation(owner);
  if (!definition) {
    return null;
  }
  const definitionKey = locationKey(definition);
  const overrides = (await resolveMethodImplementations(context, definition))
    .filter((location) => locationKey(location) !== definitionKey);
  return overrides.length > 0 ? overrides : null;
}

/**
 * Returns the hierarchy root declaration and every own method declaration
 * connected to it through class/interface inheritance.
 */
export async function resolveMethodImplementations(
  context: ResolveContext,
  definition: Location
): Promise<Location[]> {
  const selectedOwner = await ownerForLocation(context, definition);
  if (!selectedOwner) {
    return definition ? [definition] : [];
  }
  const selectedRoots = await rootMethodKeys(context, selectedOwner);
  const currentFilePath = uriToFilePath(context.uri);
  const roots = effectiveSourceRoots(context.sourceRoots, currentFilePath);
  const scannedFiles = await scanProjectMyFiles(roots, context.vfs, context.importMappings);
  const filePaths = new Set(scannedFiles.map((filePath) => resolve(filePath)));
  if (currentFilePath) {
    filePaths.add(resolve(currentFilePath));
  }
  filePaths.add(resolve(selectedOwner.filePath));

  const locations = new Map<string, Location>();
  const addLocation = (location: Location | null) => {
    if (location) {
      locations.set(locationKey(location), location);
    }
  };

  for (const filePath of filePaths) {
    const session = currentFilePath && resolve(currentFilePath) === filePath
      ? context.session
      : await getSessionForFilePath(filePath, context);
    if (!session?.ast) {
      continue;
    }
    for (const declaration of typeDeclarations(session.ast)) {
      const member = ownMethod(declaration, selectedOwner.member.name.name);
      if (!member) {
        continue;
      }
      const owner = { declaration, filePath, member };
      const candidateRoots = await rootMethodKeys(context, owner);
      if ([...candidateRoots].some((key) => selectedRoots.has(key))) {
        addLocation(ownerLocation(owner));
      }
    }
  }

  // Root declarations can live outside the scanned source roots (for example
  // in an imported declaration file), so preserve every selected root reached
  // through semantic inheritance even when it is not a workspace file.
  const pending = [selectedOwner];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const owner = pending.pop()!;
    const location = ownerLocation(owner);
    if (!location || visited.has(locationKey(location))) {
      continue;
    }
    visited.add(locationKey(location));
    addLocation(location);
    const session = await sessionForOwner(context, owner);
    if (session) {
      pending.push(...await inheritedMethods(context, owner, session));
    }
  }

  return [...locations.values()].sort((left, right) =>
    left.uri.localeCompare(right.uri) ||
    left.range.start.line - right.range.start.line ||
    left.range.start.character - right.range.start.character
  );
}
