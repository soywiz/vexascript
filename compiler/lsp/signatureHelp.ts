import type { Analysis } from "compiler/analysis/Analysis";
import { type AnalysisType, type FunctionType, typeToString } from "compiler/analysis/types";
import type {
  ArrayLiteral,
  ArrowFunctionExpression,
  AsExpression,
  AssignmentExpression,
  BinaryExpression,
  CallExpression,
  FunctionExpression,
  ClassStatement,
  CommaExpression,
  Expr,
  ForStatement,
  FunctionStatement,
  Identifier,
  IfStatement,
  LabeledStatement,
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
  WithStatement,
  DoWhileStatement,
  BlockStatement,
  ExprStatement,
  NewExpression,
  NonNullExpression,
  Node,
  Program,
  Statement
} from "compiler/ast/ast";
import type { SignatureHelp, SignatureInformation } from "vscode-languageserver/node.js";
import {
  resolveCallableSignature,
  resolveConstructorSignature,
  type ClassResolverOptions
} from "./classResolver";
import { readDocumentationFromProgramDeclaration } from "./documentation";
import { comparePosition, containsPosition, nodeRange, rangeSize, type NodeRange, type Position } from "./ranges";

interface InvocationContext {
  callee: Expr;
  arguments: Expr[];
  range: NodeRange;
  activeParameter: number;
  isNewExpression: boolean;
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
  const range = nodeRange(node);
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
      case "CommaExpression":
        for (const child of (expression as CommaExpression).expressions) {
          visitExpression(child);
        }
        return;
      case "AsExpression":
        visitExpression((expression as AsExpression).expression);
        return;
      case "NonNullExpression":
        visitExpression((expression as NonNullExpression).expression);
        return;
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
          if (property.kind === "ObjectSpreadProperty") {
            visitExpression(property.argument);
          } else {
            visitExpression(property.value);
          }
        }
        return;
      case "ArrowFunctionExpression":
      case "FunctionExpression": {
        const body = (expression as ArrowFunctionExpression | FunctionExpression).body;
        if (body.kind === "BlockStatement") {
          visitStatement(body as BlockStatement);
        } else {
          visitExpression(body as Expr);
        }
        return;
      }
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
      case "WithStatement":
        visitExpression((node as WithStatement).object);
        visitStatement((node as WithStatement).body);
        return;
      case "LabeledStatement":
        visitStatement((node as LabeledStatement).body);
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

function toFunctionType(type: AnalysisType | undefined): FunctionType | null {
  if (!type || type.kind !== "function") {
    return null;
  }
  return type;
}

async function buildSignatureFromSymbol(
  context: InvocationContext,
  analysis: Analysis,
  program: Program,
  options: ClassResolverOptions
): Promise<SignatureInformation | null> {
  const callable = await resolveCallableSignature(context.callee, analysis, program, options);
  if (callable) {
    const parameters = callable.parameters.map((parameter) => ({
      label: `${parameter.name}: ${parameter.typeName}`
    }));
    const label = `${callable.name}(${parameters.map((parameter) => parameter.label).join(", ")})`;
    return {
      label,
      parameters,
      ...(callable.documentation ? { documentation: callable.documentation } : {})
    };
  }

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
    const documentation =
      symbolMatch.symbol.node.kind === "Identifier"
        ? readDocumentationFromProgramDeclaration(program, symbolMatch.symbol.node as Identifier)
        : undefined;
    return {
      label,
      parameters,
      ...(documentation ? { documentation } : {})
    };
  }

  if (context.isNewExpression) {
    const constructorSignature = await resolveConstructorSignature(context.callee, analysis, program, options);
    if (!constructorSignature) {
      return null;
    }
    const parameters = constructorSignature.parameters.map((parameter) => ({
      label: `${parameter.name}: ${parameter.typeName}`
    }));
    const label = `new ${constructorSignature.className}(${parameters.map((parameter) => parameter.label).join(", ")})`;
    return {
      label,
      parameters
    };
  }

  return null;
}

export async function createSignatureHelp(
  program: Program,
  analysis: Analysis,
  line: number,
  character: number,
  options: ClassResolverOptions = {}
): Promise<SignatureHelp | null> {
  const context = findInvocationContext(program, line, character);
  if (!context) {
    return null;
  }

  const signature = await buildSignatureFromSymbol(context, analysis, program, options);
  if (!signature) {
    return null;
  }

  return {
    signatures: [signature],
    activeSignature: 0,
    activeParameter: context.activeParameter
  };
}
