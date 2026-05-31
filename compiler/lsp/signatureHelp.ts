import type { Analysis } from "compiler/analysis/Analysis";
import { type AnalysisType, type FunctionType, typeToString } from "compiler/analysis/types";
import type {
  ArrayLiteral,
  AssignmentExpression,
  BinaryExpression,
  CallExpression,
  ClassStatement,
  Expr,
  ForStatement,
  FunctionStatement,
  IfStatement,
  MemberExpression,
  ObjectLiteral,
  RangeExpression,
  ReturnStatement,
  SwitchStatement,
  ThrowStatement,
  TryStatement,
  UnaryExpression,
  UpdateExpression,
  VarStatement,
  WhileStatement,
  DoWhileStatement,
  BlockStatement,
  ExprStatement,
  NewExpression,
  Node,
  Program,
  Statement
} from "compiler/ast/ast";
import type { SignatureHelp, SignatureInformation } from "vscode-languageserver/node.js";

interface Position {
  line: number;
  character: number;
}

interface Range {
  start: Position;
  end: Position;
}

interface InvocationContext {
  callee: Expr;
  arguments: Expr[];
  range: Range;
  activeParameter: number;
  isNewExpression: boolean;
}

function nodeToRange(node: Node): Range | null {
  if (!node.firstToken || !node.lastToken) {
    return null;
  }
  return {
    start: {
      line: node.firstToken.range.start.line,
      character: node.firstToken.range.start.column
    },
    end: {
      line: node.lastToken.range.end.line,
      character: node.lastToken.range.end.column
    }
  };
}

function comparePosition(a: Position, b: Position): number {
  if (a.line !== b.line) {
    return a.line - b.line;
  }
  return a.character - b.character;
}

function containsPosition(range: Range, position: Position): boolean {
  return comparePosition(position, range.start) >= 0 && comparePosition(position, range.end) <= 0;
}

function rangeSize(range: Range): number {
  const lineSpan = range.end.line - range.start.line;
  if (lineSpan > 0) {
    return lineSpan * 100_000 + (range.end.character - range.start.character);
  }
  return range.end.character - range.start.character;
}

function argumentIndexAtPosition(argumentsList: Expr[], position: Position): number {
  if (argumentsList.length === 0) {
    return 0;
  }

  let active = 0;
  for (let i = 0; i < argumentsList.length; i += 1) {
    const argument = argumentsList[i]!;
    const argStart = argument.firstToken
      ? {
          line: argument.firstToken.range.start.line,
          character: argument.firstToken.range.start.column
        }
      : undefined;
    const argEnd = argument.lastToken
      ? {
          line: argument.lastToken.range.end.line,
          character: argument.lastToken.range.end.column
        }
      : undefined;

    if (argStart && comparePosition(position, argStart) < 0) {
      return i;
    }

    if (argEnd && comparePosition(position, argEnd) <= 0) {
      return i;
    }

    active = i + 1;
  }

  return active;
}

function invocationContextForNode(
  position: Position,
  callee: Expr,
  argumentsList: Expr[],
  node: Node,
  isNewExpression: boolean
): InvocationContext | null {
  const range = nodeToRange(node);
  if (!range || !containsPosition(range, position)) {
    return null;
  }

  if (callee.lastToken) {
    const calleeEnd: Position = {
      line: callee.lastToken.range.end.line,
      character: callee.lastToken.range.end.column
    };
    if (comparePosition(position, calleeEnd) < 0) {
      return null;
    }
  }

  return {
    callee,
    arguments: argumentsList,
    range,
    activeParameter: argumentIndexAtPosition(argumentsList, position),
    isNewExpression
  };
}

function findBestInvocationContext(
  statement: Statement,
  position: Position,
  currentBest: InvocationContext | null
): InvocationContext | null {
  const takeBest = (candidate: InvocationContext | null): void => {
    if (!candidate) {
      return;
    }
    if (!currentBest || rangeSize(candidate.range) <= rangeSize(currentBest.range)) {
      currentBest = candidate;
    }
  };

  const visitExpression = (expression: Expr): void => {
    switch (expression.kind) {
      case "CallExpression": {
        const call = expression as CallExpression;
        visitExpression(call.callee);
        for (const argument of call.arguments) {
          visitExpression(argument);
        }
        takeBest(invocationContextForNode(position, call.callee, call.arguments, call, false));
        return;
      }
      case "NewExpression": {
        const node = expression as NewExpression;
        visitExpression(node.callee);
        for (const argument of node.arguments ?? []) {
          visitExpression(argument);
        }
        takeBest(invocationContextForNode(position, node.callee, node.arguments ?? [], node, true));
        return;
      }
      case "BinaryExpression":
        visitExpression((expression as BinaryExpression).left);
        visitExpression((expression as BinaryExpression).right);
        return;
      case "RangeExpression":
        visitExpression((expression as RangeExpression).start);
        visitExpression((expression as RangeExpression).end);
        return;
      case "AssignmentExpression":
        visitExpression((expression as AssignmentExpression).left);
        visitExpression((expression as AssignmentExpression).right);
        return;
      case "MemberExpression":
        visitExpression((expression as MemberExpression).object);
        visitExpression((expression as MemberExpression).property);
        return;
      case "UnaryExpression":
      case "UpdateExpression":
        visitExpression((expression as UnaryExpression | UpdateExpression).argument);
        return;
      case "ArrayLiteral":
        for (const element of (expression as ArrayLiteral).elements) {
          visitExpression(element);
        }
        return;
      case "ObjectLiteral":
        for (const property of (expression as ObjectLiteral).properties) {
          visitExpression(property.value);
        }
        return;
      default:
        return;
    }
  };

  const visitStatement = (node: Statement): void => {
    switch (node.kind) {
      case "VarStatement":
        if ((node as VarStatement).declarations && (node as VarStatement).declarations!.length > 0) {
          for (const declaration of (node as VarStatement).declarations!) {
            if (declaration.initializer) {
              visitExpression(declaration.initializer);
            }
          }
        } else if ((node as VarStatement).initializer) {
          visitExpression((node as VarStatement).initializer!);
        }
        return;
      case "ExprStatement":
        visitExpression((node as ExprStatement).expression);
        return;
      case "ReturnStatement":
        if ((node as ReturnStatement).expression) {
          visitExpression((node as ReturnStatement).expression!);
        }
        return;
      case "ThrowStatement":
        visitExpression((node as ThrowStatement).expression);
        return;
      case "BlockStatement":
        for (const child of (node as BlockStatement).body) {
          visitStatement(child);
        }
        return;
      case "FunctionStatement":
        for (const bodyStatement of (node as FunctionStatement).body.body) {
          visitStatement(bodyStatement);
        }
        return;
      case "ClassStatement":
        for (const member of (node as ClassStatement).members) {
          if (member.kind !== "ClassMethodMember") {
            if (member.initializer) {
              visitExpression(member.initializer);
            }
            continue;
          }
          for (const bodyStatement of member.body.body) {
            visitStatement(bodyStatement);
          }
        }
        return;
      case "IfStatement":
        visitExpression((node as IfStatement).condition);
        visitStatement((node as IfStatement).thenBranch);
        if ((node as IfStatement).elseBranch) {
          visitStatement((node as IfStatement).elseBranch!);
        }
        return;
      case "WhileStatement":
        visitExpression((node as WhileStatement).condition);
        visitStatement((node as WhileStatement).body);
        return;
      case "DoWhileStatement":
        visitStatement((node as DoWhileStatement).body);
        visitExpression((node as DoWhileStatement).condition);
        return;
      case "ForStatement":
        if ((node as ForStatement).initializer && (node as ForStatement).initializer!.kind === "VarStatement") {
          visitStatement((node as ForStatement).initializer as Statement);
        } else if ((node as ForStatement).initializer) {
          visitExpression((node as ForStatement).initializer as Expr);
        }
        if ((node as ForStatement).iterator && (node as ForStatement).iterator!.kind === "VarStatement") {
          visitStatement((node as ForStatement).iterator as Statement);
        } else if ((node as ForStatement).iterator) {
          visitExpression((node as ForStatement).iterator as Expr);
        }
        if ((node as ForStatement).iterable) {
          visitExpression((node as ForStatement).iterable!);
        }
        if ((node as ForStatement).condition) {
          visitExpression((node as ForStatement).condition!);
        }
        if ((node as ForStatement).update) {
          visitExpression((node as ForStatement).update!);
        }
        visitStatement((node as ForStatement).body);
        return;
      case "SwitchStatement":
        visitExpression((node as SwitchStatement).discriminant);
        for (const switchCase of (node as SwitchStatement).cases) {
          if (switchCase.test) {
            visitExpression(switchCase.test);
          }
          for (const consequent of switchCase.consequent) {
            visitStatement(consequent);
          }
        }
        return;
      case "TryStatement":
        for (const child of (node as TryStatement).tryBlock.body) {
          visitStatement(child);
        }
        if ((node as TryStatement).catchClause) {
          for (const child of (node as TryStatement).catchClause!.body.body) {
            visitStatement(child);
          }
        }
        if ((node as TryStatement).finallyBlock) {
          for (const child of (node as TryStatement).finallyBlock!.body) {
            visitStatement(child);
          }
        }
        return;
      default:
        return;
    }
  };

  visitStatement(statement);
  return currentBest;
}

function findInvocationContext(program: Program, line: number, character: number): InvocationContext | null {
  const position: Position = { line, character };
  let best: InvocationContext | null = null;

  for (const statement of program.body) {
    best = findBestInvocationContext(statement, position, best);
  }

  return best;
}

function symbolAtNode(analysis: Analysis, node: Node) {
  if (!node.firstToken) {
    return null;
  }
  return analysis.getSymbolAt(node.firstToken.range.start.line, node.firstToken.range.start.column);
}

function classDeclarationByName(program: Program, name: string): ClassStatement | null {
  for (const statement of program.body) {
    if (statement.kind === "ClassStatement") {
      const classStatement = statement as ClassStatement;
      if (classStatement.name.name === name) {
        return classStatement;
      }
    }
  }
  return null;
}

function toFunctionType(type: AnalysisType | undefined): FunctionType | null {
  if (!type || type.kind !== "function") {
    return null;
  }
  return type;
}

function buildSignatureFromSymbol(
  context: InvocationContext,
  analysis: Analysis,
  program: Program
): SignatureInformation | null {
  const symbolMatch = symbolAtNode(analysis, context.callee);
  if (!symbolMatch) {
    return null;
  }

  const functionType = toFunctionType(symbolMatch.symbol.type);
  if (functionType) {
    const parameters = functionType.parameters.map((parameter) => ({
      label: `${parameter.name}: ${typeToString(parameter.type)}`
    }));
    const label = `${symbolMatch.symbol.name}(${parameters.map((parameter) => parameter.label).join(", ")})`;
    return {
      label,
      parameters
    };
  }

  if (context.isNewExpression && symbolMatch.symbol.kind === "class") {
    const declaration = classDeclarationByName(program, symbolMatch.symbol.name);
    const constructorParameters = declaration?.primaryConstructorParameters ?? [];
    const parameters = constructorParameters.map((parameter) => ({
      label: `${parameter.name.name}: ${parameter.typeAnnotation?.name ?? "unknown"}`
    }));
    const label = `new ${symbolMatch.symbol.name}(${parameters.map((parameter) => parameter.label).join(", ")})`;
    return {
      label,
      parameters
    };
  }

  return null;
}

export function createSignatureHelp(
  program: Program,
  analysis: Analysis,
  line: number,
  character: number
): SignatureHelp | null {
  const context = findInvocationContext(program, line, character);
  if (!context) {
    return null;
  }

  const signature = buildSignatureFromSymbol(context, analysis, program);
  if (!signature) {
    return null;
  }

  return {
    signatures: [signature],
    activeSignature: 0,
    activeParameter: context.activeParameter
  };
}
