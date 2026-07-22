import { NodeKind } from "compiler/ast/ast";
import { TokenType } from "compiler/parser/tokenizer";
import type { ClassFieldMember, ClassMethodMember, Program } from "compiler/ast/ast";
import type { CodeAction, Range } from "vscode-languageserver/node.js";
import { CodeActionKind } from "./codeActionKinds";
import { findBestMatchAtPosition } from "./nodeSearch";
import { nodeRange, tokenRange, type Position } from "./ranges";

const VARIABLE_MEMBER_KEYWORDS = new Set(["var", "val", "let", "const"]);

interface MemberKeywordFix {
  title: string;
  range: Range;
  newText: string;
}

function findClassMemberKeywordFix(ast: Program, position: Position): MemberKeywordFix | null {
  return findBestMatchAtPosition(ast, position, (node) => {
    if (node.kind !== NodeKind.ClassFieldMember && node.kind !== NodeKind.ClassMethodMember) {
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
        if (member.kind === NodeKind.ClassMethodMember) {
          return buildMethodKeywordFix(member);
        }
        return buildFieldKeywordFix(member);
      }
    };
  });
}

function buildMethodKeywordFix(member: ClassMethodMember): MemberKeywordFix | null {
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
    title: "Add 'fun' keyword",
    range: targetRange,
    newText: `fun ${member.name.name}`
  };
}

function buildFieldKeywordFix(member: ClassFieldMember): MemberKeywordFix | null {
  if (member.declarationKind) {
    return null;
  }

  if (member.isReadonly === true && member.readonlyToken) {
    const readonlyRange = tokenRange(member.readonlyToken);
    if (!readonlyRange) {
      return null;
    }

    return {
      title: "Replace 'readonly' with 'val'",
      range: readonlyRange,
      newText: "val"
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
}): CodeAction[] {
  if (!params.ast) {
    return [];
  }

  const fix = findClassMemberKeywordFix(params.ast, params.position);
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
