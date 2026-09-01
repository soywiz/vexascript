import {
  AssignmentExpression,
  BinaryExpression,
  BlockStatement,
  ContinueStatement,
  ExprStatement,
  Identifier,
  IfStatement,
  MatcherBindingPattern,
  MemberExpression,
  NodeKind,
  ReturnStatement,
  type Expr,
  type MatchExpressionSyntax,
  type Node,
  type Program,
  type Statement
} from "compiler/ast/ast";
import { walkAst } from "compiler/ast/traversal";
import { formatSource } from "compiler/runtime/formatter";

import type { CodeAction, Range } from "vscode-languageserver/node.js";
import { CodeActionKind } from "./codeActionKinds";
import { findBestMatchAtPosition } from "./nodeSearch";
import { containsPosition, nodeRange, rangeSize, type Position } from "./ranges";

interface IfChainArm {
  condition: Expr;
  body: Statement;
}

interface IfChainTarget {
  kind: "if-chain";
  node: IfStatement;
  arms: IfChainArm[];
  fallback?: Statement;
}

interface TerminatingIfRunTarget {
  chain: IfChainTarget;
  range: Range;
}

interface MatchTarget {
  kind: "match";
  node: Node;
  syntax: MatchExpressionSyntax;
}

type ConversionTarget = IfChainTarget | MatchTarget;

interface MatchBranchExtraction {
  title: "Move return outside match" | "Move assignment outside match";
  newText: string;
}

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

function standaloneMatchTarget(node: Node): MatchTarget | null {
  if (!(node instanceof ExprStatement)) {
    return null;
  }
  const expression = node.expression;
  const syntax = expression.matchSyntax;
  return expression.firstToken?.value === "match" && syntax
    ? { kind: "match", node: expression, syntax }
    : null;
}

function findStandaloneMatchTarget(ast: Program, position: Position): MatchTarget | null {
  return findBestMatchAtPosition<MatchTarget>(ast, position, (node) => {
    const target = standaloneMatchTarget(node);
    const range = target ? nodeRange(target.node) : null;
    return target && range ? { range, build: () => target } : null;
  });
}

function isTerminatingBranch(statement: Statement): boolean {
  const terminal = statement instanceof BlockStatement
    ? statement.body.at(-1)
    : statement;
  return terminal instanceof ReturnStatement || terminal instanceof ContinueStatement;
}

function isStandaloneTerminatingIf(statement: Statement | undefined): statement is IfStatement {
  return statement instanceof IfStatement
    && statement.firstToken?.value === "if"
    && !statement.matchSyntax
    && !statement.elseBranch
    && isTerminatingBranch(statement.thenBranch);
}

function spanningRange(first: Node, last: Node): Range | null {
  const firstRange = nodeRange(first);
  const lastRange = nodeRange(last);
  return firstRange && lastRange
    ? { start: firstRange.start, end: lastRange.end }
    : null;
}

function hasSafeStatementGap(text: string, left: Statement, right: Statement): boolean {
  const start = left.lastToken?.range.end.offset;
  const end = right.firstToken?.range.start.offset;
  return start !== undefined && end !== undefined && /^[\s;]*$/u.test(text.slice(start, end));
}

function findTerminatingIfRun(
  ast: Program,
  text: string,
  position: Position
): TerminatingIfRunTarget | null {
  let best: TerminatingIfRunTarget | null = null;
  let bestSize = Number.POSITIVE_INFINITY;

  const inspectStatements = (statements: Statement[]): void => {
    for (let start = 0; start < statements.length; start += 1) {
      if (!isStandaloneTerminatingIf(statements[start])) {
        continue;
      }
      if (
        start > 0
        && isStandaloneTerminatingIf(statements[start - 1])
        && hasSafeStatementGap(text, statements[start - 1]!, statements[start]!)
      ) {
        continue;
      }

      const arms: IfChainArm[] = [];
      let cursor = start;
      let previous: Statement | null = null;
      while (isStandaloneTerminatingIf(statements[cursor])) {
        const current = statements[cursor]! as IfStatement;
        if (previous && !hasSafeStatementGap(text, previous, current)) {
          break;
        }
        arms.push({ condition: current.condition, body: current.thenBranch });
        previous = current;
        cursor += 1;
      }
      if (arms.length < 2 || !previous) {
        continue;
      }

      const fallbackCandidate = statements[cursor];
      const fallback = fallbackCandidate instanceof ReturnStatement
        && hasSafeStatementGap(text, previous, fallbackCandidate)
        ? fallbackCandidate
        : undefined;
      const endNode = fallback ?? previous;
      const range = spanningRange(statements[start]!, endNode);
      if (!range || !containsPosition(range, position)) {
        continue;
      }
      const size = rangeSize(range);
      if (size < bestSize) {
        bestSize = size;
        best = {
          chain: {
            kind: "if-chain",
            node: statements[start]! as IfStatement,
            arms,
            ...(fallback ? { fallback } : {})
          },
          range
        };
      }
    }
  };

  inspectStatements(ast.body);
  walkAst(ast, (node) => {
    if (node instanceof BlockStatement) {
      inspectStatements(node.body);
    }
  });
  return best;
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
    if (
      !(arm.condition instanceof BinaryExpression)
      || (arm.condition.operator !== "==" && arm.condition.operator !== "===")
    ) {
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

  if (target.fallback) {
    const fallback = sourceText(text, target.fallback);
    if (!fallback) {
      return null;
    }
    armTexts.push(`else -> ${fallback}`);
  }

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

function singleArmStatement(statement: Statement, text: string): Statement | null {
  if (!(statement instanceof BlockStatement)) {
    return statement;
  }
  if (statement.body.length !== 1) {
    return null;
  }
  const child = statement.body[0]!;
  const contentStart = statement.firstToken?.range.end.offset;
  const childStart = child.firstToken?.range.start.offset;
  const childEnd = child.lastToken?.range.end.offset;
  const contentEnd = statement.lastToken?.range.start.offset;
  if (
    contentStart === undefined ||
    childStart === undefined ||
    childEnd === undefined ||
    contentEnd === undefined
  ) {
    return null;
  }
  const surroundingText = `${text.slice(contentStart, childStart)}${text.slice(childEnd, contentEnd)}`;
  return /^[\s;]*$/u.test(surroundingText) ? child : null;
}

function replaceMatchArmBodies(
  target: MatchTarget,
  text: string,
  values: Expr[]
): string | null {
  const matchStart = target.node.firstToken?.range.start.offset;
  const matchEnd = target.node.lastToken?.range.end.offset;
  if (matchStart === undefined || matchEnd === undefined || values.length !== target.syntax.arms.length) {
    return null;
  }

  let matchText = text.slice(matchStart, matchEnd);
  const replacements: Array<{ start: number; end: number; newText: string }> = [];
  for (let index = 0; index < target.syntax.arms.length; index += 1) {
    const body = target.syntax.arms[index]!.body;
    const bodyStart = body.firstToken?.range.start.offset;
    const bodyEnd = body.lastToken?.range.end.offset;
    const valueText = sourceText(text, values[index]!);
    if (bodyStart === undefined || bodyEnd === undefined || !valueText) {
      return null;
    }
    replacements.push({
      start: bodyStart - matchStart,
      end: bodyEnd - matchStart,
      newText: valueText
    });
  }

  for (const replacement of replacements.sort((left, right) => right.start - left.start)) {
    matchText = `${matchText.slice(0, replacement.start)}${replacement.newText}${matchText.slice(replacement.end)}`;
  }
  return matchText;
}

function extractCommonMatchBranchOperation(target: MatchTarget, text: string): MatchBranchExtraction | null {
  if (!target.syntax.arms.some((arm) => arm.condition === undefined)) {
    return null;
  }

  const statements = target.syntax.arms.map((arm) => singleArmStatement(arm.body, text));
  if (statements.some((statement) => statement === null)) {
    return null;
  }

  const returns = statements.map((statement) => statement instanceof ReturnStatement ? statement : null);
  if (returns.every((statement) => statement?.expression)) {
    const matchText = replaceMatchArmBodies(
      target,
      text,
      returns.map((statement) => statement!.expression!)
    );
    return matchText
      ? {
        title: "Move return outside match",
        newText: indentReplacement(text, target.node, `return ${matchText}`)
      }
      : null;
  }

  const assignments = statements.map((statement) => {
    if (!(statement instanceof ExprStatement)) {
      return null;
    }
    const expression = statement.expression;
    return expression instanceof AssignmentExpression && expression.operator === "="
      ? expression
      : null;
  });
  if (!assignments.every((assignment) => assignment !== null)) {
    return null;
  }

  const firstTarget = assignments[0]!.left;
  const firstTargetText = sourceText(text, firstTarget);
  if (!firstTargetText || !stableSubject(firstTarget)) {
    return null;
  }
  const sameTarget = assignments.every((assignment) => sourceText(text, assignment!.left) === firstTargetText);
  if (!sameTarget) {
    return null;
  }

  const matchText = replaceMatchArmBodies(
    target,
    text,
    assignments.map((assignment) => assignment!.right)
  );
  return matchText
    ? {
      title: "Move assignment outside match",
      newText: indentReplacement(text, target.node, `${firstTargetText} = ${matchText}`)
    }
    : null;
}

function codeAction(uri: string, target: Node, conversion: { title: string; newText: string }): CodeAction | null {
  const range = nodeRange(target);
  return codeActionForRange(uri, range, conversion);
}

function codeActionForRange(
  uri: string,
  range: Range | null,
  conversion: { title: string; newText: string }
): CodeAction | null {
  if (!range) {
    return null;
  }
  return {
    title: conversion.title,
    kind: CodeActionKind.QuickFix,
    edit: {
      changes: {
        [uri]: [{ range, newText: conversion.newText }]
      }
    }
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

  const actions: CodeAction[] = [];
  const standaloneMatch = findStandaloneMatchTarget(ast, position);
  const extraction = standaloneMatch
    ? extractCommonMatchBranchOperation(standaloneMatch, text)
    : null;
  if (standaloneMatch && extraction) {
    const action = codeAction(uri, standaloneMatch.node, extraction);
    if (action) actions.push(action);
  }

  const terminatingRun = findTerminatingIfRun(ast, text, position);
  if (terminatingRun) {
    const conversion = ifChainToMatch(terminatingRun.chain, text);
    const action = conversion
      ? codeActionForRange(uri, terminatingRun.range, conversion)
      : null;
    if (action) actions.push(action);
  }

  const target = findTarget(ast, position);
  if (!target) {
    return actions;
  }
  const conversion = target.kind === "if-chain"
    ? ifChainToMatch(target, text)
    : matchToIfChain(target, text);
  if (!conversion) {
    return actions;
  }
  const action = codeAction(uri, target.node, conversion);
  if (action) actions.push(action);
  return actions;
}
