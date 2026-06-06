import type {
  ArrayLiteral,
  AsExpression,
  AssignmentExpression,
  BinaryExpression,
  BlockStatement,
  CallExpression,
  ClassStatement,
  CommaExpression,
  ConditionalExpression,
  DoWhileStatement,
  Expr,
  ExprStatement,
  ForStatement,
  FunctionStatement,
  IfStatement,
  LabeledStatement,
  MemberExpression,
  NewExpression,
  ObjectLiteral,
  Program,
  RangeExpression,
  ReturnStatement,
  Statement,
  StringLiteral,
  SwitchStatement,
  ThrowStatement,
  TryStatement,
  UnaryExpression,
  UpdateExpression,
  VarStatement,
  WhileStatement,
  WithStatement
} from "compiler/ast/ast";
import { CodeActionKind, type CodeAction, type Range } from "vscode-languageserver/node.js";
import { containsPosition, nodeRange, rangeSize, type Position } from "./ranges";

function editRange(node: Parameters<typeof nodeRange>[0]): Range | null {
  return nodeRange(node);
}

function escapeTemplateText(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`")
    .replace(/\$\{/g, "\\${");
}

function sourceText(text: string, node: Expr): string | null {
  if (!node.firstToken || !node.lastToken) {
    return null;
  }
  return text.slice(node.firstToken.range.start.offset, node.lastToken.range.end.offset);
}

function flattenConcatenation(expression: Expr): Expr[] | null {
  if (expression.kind !== "BinaryExpression") {
    return null;
  }
  const binary = expression as BinaryExpression;
  if (binary.operator !== "+") {
    return null;
  }

  const left = flattenConcatenation(binary.left);
  const right = flattenConcatenation(binary.right);
  return [...(left ?? [binary.left]), ...(right ?? [binary.right])];
}

function buildTemplateLiteral(text: string, expression: BinaryExpression): string | null {
  const segments = flattenConcatenation(expression);
  if (!segments || segments.length < 2) {
    return null;
  }

  let hasStringLiteral = false;
  let hasInterpolation = false;
  let result = "`";

  for (const segment of segments) {
    if (segment.kind === "StringLiteral") {
      hasStringLiteral = true;
      result += escapeTemplateText((segment as StringLiteral).value);
      continue;
    }

    const segmentText = sourceText(text, segment);
    if (!segmentText) {
      return null;
    }
    hasInterpolation = true;
    result += `\${${segmentText}}`;
  }

  if (!hasStringLiteral || !hasInterpolation) {
    return null;
  }

  result += "`";
  return result;
}

function findConcatenationAtPosition(ast: Program, position: Position): BinaryExpression | null {
  let best: { expression: BinaryExpression; size: number } | null = null;

  const consider = (expression: BinaryExpression): void => {
    if (expression.operator !== "+") {
      return;
    }
    const range = nodeRange(expression);
    if (!range || !containsPosition(range, position)) {
      return;
    }
    const segments = flattenConcatenation(expression);
    if (!segments || segments.length < 2) {
      return;
    }
    const hasStringLiteral = segments.some((segment) => segment.kind === "StringLiteral");
    const hasInterpolation = segments.some((segment) => segment.kind !== "StringLiteral");
    if (!hasStringLiteral || !hasInterpolation) {
      return;
    }
    const size = rangeSize(range);
    if (!best || size >= best.size) {
      best = { expression, size };
    }
  };

  const visitExpression = (expression: Expr): void => {
    switch (expression.kind) {
      case "BinaryExpression": {
        const binary = expression as BinaryExpression;
        consider(binary);
        visitExpression(binary.left);
        visitExpression(binary.right);
        return;
      }
      case "CallExpression":
        visitExpression((expression as CallExpression).callee);
        for (const argument of (expression as CallExpression).arguments) {
          visitExpression(argument);
        }
        return;
      case "MemberExpression":
        visitExpression((expression as MemberExpression).object);
        if ((expression as MemberExpression).computed) {
          visitExpression((expression as MemberExpression).property);
        }
        return;
      case "NewExpression":
        visitExpression((expression as NewExpression).callee);
        for (const argument of (expression as NewExpression).arguments ?? []) {
          visitExpression(argument);
        }
        return;
      case "CommaExpression":
        for (const child of (expression as CommaExpression).expressions) {
          visitExpression(child);
        }
        return;
      case "AsExpression":
        visitExpression((expression as AsExpression).expression);
        return;
      case "RangeExpression":
        visitExpression((expression as RangeExpression).start);
        visitExpression((expression as RangeExpression).end);
        return;
      case "AssignmentExpression":
        visitExpression((expression as AssignmentExpression).left);
        visitExpression((expression as AssignmentExpression).right);
        return;
      case "ConditionalExpression":
        visitExpression((expression as ConditionalExpression).test);
        visitExpression((expression as ConditionalExpression).consequent);
        visitExpression((expression as ConditionalExpression).alternate);
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
      default:
        return;
    }
  };

  const visitStatement = (statement: Statement): void => {
    switch (statement.kind) {
      case "VarStatement":
        if ((statement as VarStatement).declarations?.length) {
          for (const declaration of (statement as VarStatement).declarations ?? []) {
            if (declaration.initializer) {
              visitExpression(declaration.initializer);
            }
          }
        } else if ((statement as VarStatement).initializer) {
          visitExpression((statement as VarStatement).initializer!);
        }
        return;
      case "ExprStatement":
        visitExpression((statement as ExprStatement).expression);
        return;
      case "ReturnStatement":
        if ((statement as ReturnStatement).expression) {
          visitExpression((statement as ReturnStatement).expression!);
        }
        return;
      case "ThrowStatement":
        visitExpression((statement as ThrowStatement).expression);
        return;
      case "BlockStatement":
        for (const child of (statement as BlockStatement).body) {
          visitStatement(child);
        }
        return;
      case "FunctionStatement":
        for (const child of (statement as FunctionStatement).body.body) {
          visitStatement(child);
        }
        return;
      case "ClassStatement":
        for (const member of (statement as ClassStatement).members) {
          if (member.kind === "ClassFieldMember" && member.initializer) {
            visitExpression(member.initializer);
          } else if (member.kind === "ClassMethodMember") {
            for (const child of member.body.body) {
              visitStatement(child);
            }
          }
        }
        return;
      case "IfStatement":
        visitExpression((statement as IfStatement).condition);
        visitStatement((statement as IfStatement).thenBranch);
        if ((statement as IfStatement).elseBranch) {
          visitStatement((statement as IfStatement).elseBranch!);
        }
        return;
      case "WhileStatement":
        visitExpression((statement as WhileStatement).condition);
        visitStatement((statement as WhileStatement).body);
        return;
      case "WithStatement":
        visitExpression((statement as WithStatement).object);
        visitStatement((statement as WithStatement).body);
        return;
      case "LabeledStatement":
        visitStatement((statement as LabeledStatement).body);
        return;
      case "DoWhileStatement":
        visitStatement((statement as DoWhileStatement).body);
        visitExpression((statement as DoWhileStatement).condition);
        return;
      case "ForStatement":
        if ((statement as ForStatement).initializer?.kind === "VarStatement") {
          visitStatement((statement as ForStatement).initializer as Statement);
        } else if ((statement as ForStatement).initializer) {
          visitExpression((statement as ForStatement).initializer as Expr);
        }
        if ((statement as ForStatement).iterator?.kind === "VarStatement") {
          visitStatement((statement as ForStatement).iterator as Statement);
        } else if ((statement as ForStatement).iterator?.kind !== "Identifier" && (statement as ForStatement).iterator) {
          visitExpression((statement as ForStatement).iterator as Expr);
        }
        if ((statement as ForStatement).iterable) {
          visitExpression((statement as ForStatement).iterable!);
        }
        visitStatement((statement as ForStatement).body);
        return;
      case "SwitchStatement":
        visitExpression((statement as SwitchStatement).discriminant);
        for (const switchCase of (statement as SwitchStatement).cases) {
          if (switchCase.test) {
            visitExpression(switchCase.test);
          }
          for (const child of switchCase.consequent) {
            visitStatement(child);
          }
        }
        return;
      case "TryStatement": {
        const tryStatement = statement as TryStatement;
        for (const child of tryStatement.tryBlock.body) {
          visitStatement(child);
        }
        if (tryStatement.catchClause) {
          for (const child of tryStatement.catchClause.body.body) {
            visitStatement(child);
          }
        }
        if (tryStatement.finallyBlock) {
          for (const child of tryStatement.finallyBlock.body) {
            visitStatement(child);
          }
        }
        return;
      }
      default:
        return;
    }
  };

  for (const statement of ast.body) {
    visitStatement(statement);
  }

  // `best` is only ever assigned inside the nested `consider` closure, which
  // defeats TypeScript's control-flow narrowing at this point (it collapses the
  // variable to `never`); read it back through an explicit cast to recover the
  // declared type.
  const selected = best as { expression: BinaryExpression; size: number } | null;
  return selected ? selected.expression : null;
}

export function createStringTemplateCodeActions(params: {
  uri: string;
  ast: Program | null;
  text: string;
  position: Position;
}): CodeAction[] {
  const { uri, ast, text, position } = params;
  if (!ast) {
    return [];
  }

  const expression = findConcatenationAtPosition(ast, position);
  if (!expression) {
    return [];
  }

  const newText = buildTemplateLiteral(text, expression);
  const range = editRange(expression);
  if (!newText || !range) {
    return [];
  }

  return [
    {
      title: "Convert string concatenation to template literal",
      kind: CodeActionKind.QuickFix,
      edit: {
        changes: {
          [uri]: [
            {
              range,
              newText
            }
          ]
        }
      }
    }
  ];
}
