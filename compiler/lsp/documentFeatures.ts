import {
  type CallHierarchyIncomingCall,
  type CallHierarchyItem,
  type CallHierarchyOutgoingCall,
  type CodeLens,
  type DocumentHighlight,
  type FoldingRange,
  type Position,
  type Range,
  type SelectionRange,
  type TextEdit
} from "vscode-languageserver/node.js";
import type { Analysis } from "compiler/analysis/Analysis";
import type { Node, Program } from "compiler/ast/ast";
import { walkAst } from "compiler/ast/traversal";
import { containsPosition, nodeRange, rangeSize } from "./ranges";
import type { TokenComment } from "compiler/parser/tokenizer";

const SymbolKind = {
  File: 1,
  Module: 2,
  Namespace: 3,
  Package: 4,
  Class: 5,
  Method: 6,
  Property: 7,
  Field: 8,
  Constructor: 9,
  Enum: 10,
  Interface: 11,
  Function: 12,
  Variable: 13,
  Constant: 14,
} as const;

const DocumentHighlightKind = {
  Text: 1,
  Read: 2,
  Write: 3
} as const;

const FoldingRangeKind = {
  Comment: "comment",
  Imports: "imports",
  Region: "region"
} as const;

function position(line: number, character: number): Position {
  return { line, character };
}

export function createDocumentHighlights(
  analysis: Analysis,
  line: number,
  character: number
): DocumentHighlight[] {
  return analysis.getReferenceRangesAt(line, character, true).map((range) => ({
    range,
    kind: DocumentHighlightKind.Read
  }));
}

function commentFoldingRange(comment: TokenComment): FoldingRange | null {
  if (comment.range.start.line >= comment.range.end.line) {
    return null;
  }
  return {
    startLine: comment.range.start.line,
    startCharacter: comment.range.start.column,
    endLine: comment.range.end.line,
    endCharacter: comment.range.end.column,
    kind: FoldingRangeKind.Comment
  };
}

export function createFoldingRanges(ast: Program): FoldingRange[] {
  const ranges: FoldingRange[] = [];
  const seenComments = new Set<TokenComment>();
  walkAst(ast, (node) => {
    const range = nodeRange(node);
    if (range && range.start.line < range.end.line &&
      ["BlockStatement", "ClassStatement", "InterfaceStatement", "SwitchStatement", "ObjectLiteral", "ArrayLiteral"].includes(node.kind)) {
      ranges.push({
        startLine: range.start.line,
        startCharacter: range.start.character,
        endLine: range.end.line,
        endCharacter: range.end.character,
        kind: FoldingRangeKind.Region
      });
    }
    for (const comment of node.firstToken?.leadingComments ?? []) {
      if (seenComments.has(comment)) continue;
      seenComments.add(comment);
      const commentRange = commentFoldingRange(comment);
      if (commentRange) ranges.push(commentRange);
    }
  });
  return ranges;
}

export function createSelectionRanges(ast: Program, positions: Position[]): SelectionRange[] {
  return positions.map((point) => {
    const containing: Range[] = [];
    walkAst(ast, (node) => {
      const range = nodeRange(node);
      if (range && containsPosition(range, point)) containing.push(range);
    });
    containing.sort((left, right) => rangeSize(left) - rangeSize(right));
    const unique = containing.filter((range, index) => index === 0 || JSON.stringify(range) !== JSON.stringify(containing[index - 1]));
    let parent: SelectionRange | undefined;
    for (let index = unique.length - 1; index >= 0; index -= 1) {
      parent = parent ? { range: unique[index]!, parent } : { range: unique[index]! };
    }
    return parent ?? { range: { start: point, end: point } };
  });
}

function declarationName(node: Node): { name: string; range: Range; kind: number } | null {
  const candidate = node as Node & { name?: Node & { name?: string } };
  if (!candidate.name || candidate.name.kind !== "Identifier" || !candidate.name.name) return null;
  const range = nodeRange(candidate.name);
  if (!range) return null;
  const kind = node.kind === "ClassStatement" ? SymbolKind.Class :
    node.kind === "InterfaceStatement" ? SymbolKind.Interface :
    node.kind === "FunctionStatement" ? SymbolKind.Function : SymbolKind.Variable;
  return { name: candidate.name.name, range, kind };
}

export function createReferenceCodeLenses(ast: Program, analysis: Analysis, uri: string): CodeLens[] {
  const lenses: CodeLens[] = [];
  for (const statement of ast.body) {
    const declaration = declarationName(statement);
    if (!declaration) continue;
    const references = analysis.getReferenceRangesAt(declaration.range.start.line, declaration.range.start.character, false);
    lenses.push({
      range: declaration.range,
      command: {
        title: `${references.length} reference${references.length === 1 ? "" : "s"}`,
        command: "vexa.showReferences",
        arguments: [uri, declaration.range.start, references.map((range) => ({ uri, range }))]
      }
    });
  }
  return lenses;
}

export function createOnTypeFormattingEdits(text: string, point: Position, character: string): TextEdit[] {
  if (character !== "\n" && character !== "}") return [];
  const lines = text.split(/\r?\n/);
  const current = lines[point.line] ?? "";
  const previous = lines[point.line - 1] ?? "";
  const previousIndent = previous.match(/^\s*/)?.[0] ?? "";
  const desired = character === "}" ? previousIndent.replace(/ {2}$/, "") : previousIndent + (/\{\s*$/.test(previous) ? "  " : "");
  const currentIndent = current.match(/^\s*/)?.[0] ?? "";
  if (currentIndent === desired) return [];
  return [{ range: { start: position(point.line, 0), end: position(point.line, currentIndent.length) }, newText: desired }];
}


function hierarchyDeclarations(ast: Program, uri: string): CallHierarchyItem[] {
  const items: CallHierarchyItem[] = [];
  walkAst(ast, (node) => {
    if (node.kind !== "FunctionStatement" && node.kind !== "ClassMethodMember") return;
    const declaration = declarationName(node);
    const range = nodeRange(node);
    if (!declaration || !range) return;
    items.push({ name: declaration.name, kind: SymbolKind.Function, uri, range, selectionRange: declaration.range });
  });
  return items;
}

export function prepareCallHierarchy(ast: Program, uri: string, point: Position): CallHierarchyItem[] | null {
  const item = hierarchyDeclarations(ast, uri).find(({ range }) => containsPosition(range, point));
  return item ? [item] : null;
}

function callsInNode(node: Node): Array<{ name: string; range: Range }> {
  const calls: Array<{ name: string; range: Range }> = [];
  walkAst(node, (candidate) => {
    if (candidate.kind !== "CallExpression") return;
    const callee = (candidate as Node & { callee?: Node & { name?: string } }).callee;
    const range = callee ? nodeRange(callee) : null;
    if (callee?.kind === "Identifier" && callee.name && range) calls.push({ name: callee.name, range });
  });
  return calls;
}

function hierarchyNode(ast: Program, item: CallHierarchyItem): Node | null {
  let result: Node | null = null;
  walkAst(ast, (node) => {
    const declaration = declarationName(node);
    const range = nodeRange(node);
    if (declaration?.name === item.name && range && JSON.stringify(range) === JSON.stringify(item.range)) result = node;
  });
  return result;
}

export function createOutgoingCalls(ast: Program, uri: string, item: CallHierarchyItem): CallHierarchyOutgoingCall[] {
  const node = hierarchyNode(ast, item);
  if (!node) return [];
  const declarations = hierarchyDeclarations(ast, uri);
  return callsInNode(node).flatMap((call) => {
    const target = declarations.find((declaration) => declaration.name === call.name);
    return target ? [{ to: target, fromRanges: [call.range] }] : [];
  });
}

export function createIncomingCalls(ast: Program, uri: string, item: CallHierarchyItem): CallHierarchyIncomingCall[] {
  const declarations = hierarchyDeclarations(ast, uri);
  return declarations.flatMap((caller) => {
    const node = hierarchyNode(ast, caller);
    if (!node) return [];
    const ranges = callsInNode(node).filter((call) => call.name === item.name).map((call) => call.range);
    return ranges.length > 0 ? [{ from: caller, fromRanges: ranges }] : [];
  });
}
