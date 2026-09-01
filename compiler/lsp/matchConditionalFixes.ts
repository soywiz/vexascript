import {
  BinaryExpression,
  Identifier,
  IfStatement,
  MatcherBindingPattern,
  MemberExpression,
  NodeKind,
  type Expr,
  type MatchExpressionSyntax,
  type Node,
  type Program,
  type Statement
} from "compiler/ast/ast";
import { walkAst } from "compiler/ast/traversal";
import { formatSource } from "compiler/runtime/formatter";

import type { CodeAction } from "vscode-languageserver/node.js";
import { CodeActionKind } from "./codeActionKinds";
import { findBestMatchAtPosition } from "./nodeSearch";
import { nodeRange, type Position } from "./ranges";

interface IfChainArm {
  condition: Expr;
  body: Statement;
}

interface IfChainTarget {
  kind: "if-chain";
  node: IfStatement;
  arms: IfChainArm[];
  fallback: Statement;
}

interface MatchTarget {
  kind: "match";
  node: Node;
  syntax: MatchExpressionSyntax;
}

type ConversionTarget = IfChainTarget | MatchTarget;

function sourceText(text: string, node: Node): string | null {
  const first = node.firstToken;
  const last = node.lastToken;
  if (!first || !last) {
    return null;
  }
  return text.slice(first.range.start.offset, last.range.end.offset).trim();
}

function rebasedSourceText(text: string, node: Node, targetIndent: string): string | null {
  const fragment = sourceText(text, node);
  const first = node.firstToken;
  if (!fragment || !first || !fragment.includes("\n")) {
    return fragment;
  }

  const originalIndent = lineIndent(text, first.range.start.offset);
  return fragment
    .split("\n")
    .map((line, index) => {
      if (index === 0) {
        return line;
      }
      return `${targetIndent}${line.startsWith(originalIndent) ? line.slice(originalIndent.length) : line.trimStart()}`;
    })
    .join("\n");
}

function lineIndent(text: string, offset: number): string {
  const lineStart = text.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
  let index = lineStart;
  while (index < text.length && (text[index] === " " || text[index] === "\t")) {
    index += 1;
  }
  return text.slice(lineStart, index);
}

function indentReplacement(text: string, node: Node, replacement: string): string {
  const offset = node.firstToken?.range.start.offset ?? 0;
  const indent = lineIndent(text, offset);
  return formatSource(replacement).replace(/\n/g, `\n${indent}`);
}

function collectElseIfChildren(ast: Program): Set<IfStatement> {
  const children = new Set<IfStatement>();
  walkAst(ast, (node) => {
    if (node instanceof IfStatement && node.elseBranch instanceof IfStatement) {
      const elseIf = node.elseBranch as IfStatement;
      if (elseIf.firstToken?.value === "if") {
        children.add(elseIf);
      }
    }
  });
  return children;
}

function collectIfChain(node: IfStatement): IfChainTarget | null {
  if (node.firstToken?.value !== "if" || node.matchSyntax) {
    return null;
  }

  const arms: IfChainArm[] = [];
  let current: IfStatement = node;
  let fallback: Statement | undefined;

  while (true) {
    arms.push({ condition: current.condition, body: current.thenBranch });
    const next = current.elseBranch;
    if (next instanceof IfStatement && next.firstToken?.value === "if" && !next.matchSyntax) {
      current = next as IfStatement;
      continue;
    }
    fallback = next;
    break;
  }

  return arms.length >= 2 && fallback
    ? { kind: "if-chain", node, arms, fallback }
    : null;
}

function containsMatcherBinding(node: Node): boolean {
  let found = false;
  walkAst(node, (candidate) => {
    if (candidate instanceof MatcherBindingPattern) {
      found = true;
      return false;
    }
    return true;
  });
  return found;
}

function matchTarget(node: Node): MatchTarget | null {
  const syntax = (node as Expr).matchSyntax;
  if (node.firstToken?.value !== "match" || !syntax) {
    return null;
  }
  if (!syntax.arms.some((arm) => arm.condition)) {
    return null;
  }
  if (syntax.subject && !stableSubject(syntax.subject)) {
    return null;
  }
  if (syntax.arms.some((arm) => arm.condition && containsMatcherBinding(arm.condition))) {
    return null;
  }
  return { kind: "match", node, syntax };
}

function findTarget(ast: Program, position: Position): ConversionTarget | null {
  const elseIfChildren = collectElseIfChildren(ast);
  return findBestMatchAtPosition<ConversionTarget>(ast, position, (node) => {
    const match = matchTarget(node);
    if (match) {
      const range = nodeRange(node);
      return range ? { range, build: () => match } : null;
    }

    if (!(node instanceof IfStatement) || elseIfChildren.has(node)) {
      return null;
    }
    const chain = collectIfChain(node as IfStatement);
    const range = chain ? nodeRange(node) : null;
    return chain && range ? { range, build: () => chain } : null;
  });
}

function stableSubject(expression: Expr): boolean {
  if (expression instanceof Identifier) {
    return true;
  }
  return expression instanceof MemberExpression
    && !expression.computed
    && expression.property instanceof Identifier
    && stableSubject(expression.object);
}

function subjectMatchParts(
  target: IfChainTarget,
  text: string
): { subject: string; patterns: string[] } | null {
  let subject: string | null = null;
  const patterns: string[] = [];

  for (const arm of target.arms) {
    if (!(arm.condition instanceof BinaryExpression) || arm.condition.operator !== "==") {
      return null;
    }
    const comparison = arm.condition as BinaryExpression;
    if (!stableSubject(comparison.left)) {
      return null;
    }
    const left = sourceText(text, comparison.left);
    const right = sourceText(text, comparison.right);
    if (!left || !right || (subject !== null && left !== subject)) {
      return null;
    }
    subject = left;
    patterns.push(right);
  }

  return subject ? { subject, patterns } : null;
}

function ifChainToMatch(target: IfChainTarget, text: string): { title: string; newText: string } | null {
  const subjectParts = subjectMatchParts(target, text);
  const armTexts: string[] = [];

  for (let index = 0; index < target.arms.length; index += 1) {
    const arm = target.arms[index]!;
    const condition = subjectParts?.patterns[index] ?? sourceText(text, arm.condition);
    const body = sourceText(text, arm.body);
    if (!condition || !body) {
      return null;
    }
    armTexts.push(`${condition} -> ${body}`);
  }

  const fallback = sourceText(text, target.fallback);
  if (!fallback) {
    return null;
  }
  armTexts.push(`else -> ${fallback}`);

  const subject = subjectParts ? ` (${subjectParts.subject})` : "";
  return {
    title: subjectParts
      ? "Convert if chain to subject match"
      : "Convert if chain to condition match",
    newText: indentReplacement(text, target.node, `match${subject} {\n${armTexts.join("\n")}\n}`)
  };
}

function isLiteralPattern(expression: Expr): boolean {
  return expression.kind === NodeKind.IntLiteral
    || expression.kind === NodeKind.FloatLiteral
    || expression.kind === NodeKind.BigIntLiteral
    || expression.kind === NodeKind.LongLiteral
    || expression.kind === NodeKind.StringLiteral
    || expression.kind === NodeKind.CharacterLiteral
    || expression.kind === NodeKind.BooleanLiteral
    || expression.kind === NodeKind.NullLiteral
    || expression.kind === NodeKind.UndefinedLiteral;
}

function matchToIfChain(target: MatchTarget, text: string): { title: string; newText: string } | null {
  const subject = target.syntax.subject ? sourceText(text, target.syntax.subject) : null;
  if (target.syntax.subject && !subject) {
    return null;
  }

  const branches: Array<{ condition: string; body: string }> = [];
  let fallback: string | null = null;
  const targetIndent = lineIndent(text, target.node.firstToken?.range.start.offset ?? 0);
  for (const arm of target.syntax.arms) {
    const body = rebasedSourceText(text, arm.body, targetIndent);
    if (!body) {
      return null;
    }
    if (!arm.condition) {
      fallback = body;
      continue;
    }
    const pattern = sourceText(text, arm.condition);
    if (!pattern) {
      return null;
    }
    const condition = subject
      ? isLiteralPattern(arm.condition)
        ? `${subject} == ${pattern}`
        : `${subject} is ${pattern}`
      : pattern;
    branches.push({ condition, body });
  }

  if (branches.length === 0) {
    return null;
  }

  let replacement = branches
    .map((branch, index) => `${index === 0 ? "" : "else "}if (${branch.condition}) ${branch.body}`)
    .join(" ");
  if (fallback) {
    replacement += ` else ${fallback}`;
  }

  return {
    title: subject
      ? "Convert subject match to if chain"
      : "Convert condition match to if chain",
    newText: replacement
  };
}

export function createMatchConditionalCodeActions(params: {
  uri: string;
  ast: Program | null;
  text: string;
  position: Position;
}): CodeAction[] {
  const { uri, ast, text, position } = params;
  if (!ast) {
    return [];
  }

  const target = findTarget(ast, position);
  if (!target) {
    return [];
  }
  const conversion = target.kind === "if-chain"
    ? ifChainToMatch(target, text)
    : matchToIfChain(target, text);
  if (!conversion) {
    return [];
  }

  const range = nodeRange(target.node);
  if (!range) {
    return [];
  }
  return [{
    title: conversion.title,
    kind: CodeActionKind.QuickFix,
    edit: {
      changes: {
        [uri]: [{ range, newText: conversion.newText }]
      }
    }
  }];
}
