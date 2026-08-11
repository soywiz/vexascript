import { ClassFieldMember, ClassMethodMember } from "compiler/ast/ast";
import type { Program } from "compiler/ast/ast";
import { TokenType } from "compiler/parser/tokenizer";

import type { CodeAction, Range } from "vscode-languageserver/node.js";
import { CodeActionKind } from "./codeActionKinds";
import { findBestMatchAtPosition } from "./nodeSearch";
import { nodeRange, tokenRange, type Position } from "./ranges";
import { DEFAULT_CANONICAL_SYNTAX, type CanonicalSyntax } from "compiler/canonicalSyntax";

const VARIABLE_MEMBER_KEYWORDS = new Set(["var", "val", "let", "const"]);

interface MemberKeywordFix {
  title: string;
  range: Range;
  newText: string;
}

function findClassMemberKeywordFix(
  ast: Program,
  position: Position,
  canonicalSyntax: CanonicalSyntax
): MemberKeywordFix | null {
  return findBestMatchAtPosition(ast, position, (node) => {
    if (!(node instanceof ClassFieldMember) && !(node instanceof ClassMethodMember)) {
      return null;
    }

    const member = node as ClassFieldMember | ClassMethodMember;
    const range = nodeRange(member);
    if (!range) {
      return null;
    }

    return {
      range,
      build: () => {
        if (member instanceof ClassMethodMember) {
          return buildMethodKeywordFix(member, canonicalSyntax);
        }
        return buildFieldKeywordFix(member, canonicalSyntax);
      }
    };
  });
}

function buildMethodKeywordFix(member: ClassMethodMember, canonicalSyntax: CanonicalSyntax): MemberKeywordFix | null {
  const firstTokenValue = member.firstToken?.type === TokenType.IDENTIFIER ? member.firstToken.value : null;

  if (firstTokenValue && VARIABLE_MEMBER_KEYWORDS.has(firstTokenValue)) {
    return null;
  }

  if (member.getterShorthand === true && !member.declarationKind) {
    const targetToken = member.name.firstToken ?? member.firstToken;
    const targetRange = tokenRange(targetToken);
    if (!targetRange) {
      return null;
    }

    return {
      title: "Add 'var' keyword",
      range: targetRange,
      newText: `var ${member.name.name}`
    };
  }

  if (member.declarationKind || member.accessorKind) {
    return null;
  }

  const targetToken = member.name.firstToken ?? member.firstToken;
  const targetRange = tokenRange(targetToken);
  if (!targetRange) {
    return null;
  }

  return {
    title: `Add '${canonicalSyntax.functionDeclaration}' keyword`,
    range: targetRange,
    newText: `${canonicalSyntax.functionDeclaration} ${member.name.name}`
  };
}

function buildFieldKeywordFix(member: ClassFieldMember, canonicalSyntax: CanonicalSyntax): MemberKeywordFix | null {
  if (member.declarationKind) {
    return null;
  }

  if (member.isReadonly === true && member.readonlyToken) {
    const readonlyRange = tokenRange(member.readonlyToken);
    if (!readonlyRange) {
      return null;
    }

    return {
      title: `Replace 'readonly' with '${canonicalSyntax.immutableDeclaration}'`,
      range: readonlyRange,
      newText: canonicalSyntax.immutableDeclaration
    };
  }

  const nameRange = tokenRange(member.name.firstToken ?? member.firstToken);
  if (!nameRange) {
    return null;
  }

  return {
    title: "Add 'var' keyword",
    range: nameRange,
    newText: `var ${member.name.name}`
  };
}

export function createMemberKeywordCodeActions(params: {
  uri: string;
  ast: Program | null;
  position: Position;
  canonicalSyntax?: CanonicalSyntax;
}): CodeAction[] {
  if (!params.ast) {
    return [];
  }

  const fix = findClassMemberKeywordFix(
    params.ast,
    params.position,
    params.canonicalSyntax ?? DEFAULT_CANONICAL_SYNTAX
  );
  if (!fix) {
    return [];
  }

  return [
    {
      title: fix.title,
      kind: CodeActionKind.QuickFix,
      edit: {
        changes: {
          [params.uri]: [
            {
              range: fix.range,
              newText: fix.newText
            }
          ]
        }
      }
    }
  ];
}
