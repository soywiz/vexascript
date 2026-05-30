import { Analysis } from "compiler/analysis/Analysis";
import type { Expr, ForStatement, Program, RangeExpression, Statement, VarStatement } from "compiler/ast/ast";
import { Parser } from "compiler/parser/parser";
import { TokenizeError, tokenize } from "compiler/parser/tokenizer";
import { ListReader } from "compiler/utils/ListReader";

export interface TranspileResult {
  code: string;
  warnings: string[];
  errors: string[];
}

function countOccurrences(text: string, ch: string): number {
  let count = 0;
  for (const current of text) {
    if (current === ch) {
      count += 1;
    }
  }
  return count;
}

function stripDeclareStatements(source: string): string {
  const lines = source.split(/\r?\n/);
  const kept: string[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const trimmed = line.trim();
    if (!trimmed.startsWith("declare ")) {
      kept.push(line);
      continue;
    }

    if (trimmed.startsWith("declare class ")) {
      let braceDepth = countOccurrences(line, "{") - countOccurrences(line, "}");
      while (braceDepth > 0 && i + 1 < lines.length) {
        i += 1;
        const nextLine = lines[i] ?? "";
        braceDepth += countOccurrences(nextLine, "{") - countOccurrences(nextLine, "}");
      }
      continue;
    }
  }

  return kept.join("\n");
}

function ensureTrailingSemicolon(code: string): string {
  const trimmed = code.trim();
  if (trimmed.length === 0) {
    return "";
  }
  return /[;{}]$/.test(trimmed) ? trimmed : `${trimmed};`;
}

interface Replacement {
  start: number;
  end: number;
  text: string;
}

function collectForStatements(program: Program): ForStatement[] {
  const collected: ForStatement[] = [];

  const visitStatement = (statement: Statement): void => {
    switch (statement.kind) {
      case "ForStatement": {
        const forStatement = statement as ForStatement;
        collected.push(forStatement);
        visitStatement(forStatement.body);
        return;
      }
      case "BlockStatement":
        for (const child of statement.body) {
          visitStatement(child);
        }
        return;
      case "IfStatement":
        visitStatement(statement.thenBranch);
        if (statement.elseBranch) {
          visitStatement(statement.elseBranch);
        }
        return;
      case "WhileStatement":
      case "DoWhileStatement":
        visitStatement(statement.body);
        return;
      case "SwitchStatement":
        for (const switchCase of statement.cases) {
          for (const consequent of switchCase.consequent) {
            visitStatement(consequent);
          }
        }
        return;
      default:
        return;
    }
  };

  for (const statement of program.body) {
    visitStatement(statement);
  }
  return collected;
}

function findMatchingCloseParen(source: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "(") {
      depth += 1;
      continue;
    }
    if (ch === ")") {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  return -1;
}

function exprText(source: string, expr: Expr): string {
  if (!expr.firstToken || !expr.lastToken) {
    return "";
  }
  return source.slice(expr.firstToken.range.start.offset, expr.lastToken.range.end.offset);
}

function nodeText(source: string, node: { firstToken?: { range: { start: { offset: number } } }; lastToken?: { range: { end: { offset: number } } } }): string {
  if (!node.firstToken || !node.lastToken) {
    return "";
  }
  return source.slice(node.firstToken.range.start.offset, node.lastToken.range.end.offset);
}

function applyReplacements(source: string, replacements: Replacement[]): string {
  if (replacements.length === 0) {
    return source;
  }

  replacements.sort((a, b) => b.start - a.start);
  let output = source;
  for (const replacement of replacements) {
    output = output.slice(0, replacement.start) + replacement.text + output.slice(replacement.end);
  }
  return output;
}

function collectRangeExpressions(program: Program): RangeExpression[] {
  const collected: RangeExpression[] = [];

  const visitExpression = (expression: Expr): void => {
    switch (expression.kind) {
      case "RangeExpression": {
        const range = expression as RangeExpression;
        collected.push(range);
        visitExpression(range.start);
        visitExpression(range.end);
        return;
      }
      case "BinaryExpression":
      case "AssignmentExpression":
        visitExpression((expression as { left: Expr }).left);
        visitExpression((expression as { right: Expr }).right);
        return;
      case "MemberExpression": {
        const member = expression as { object: Expr; property: Expr; computed: boolean };
        visitExpression(member.object);
        if (member.computed) {
          visitExpression(member.property);
        }
        return;
      }
      case "CallExpression":
        visitExpression((expression as { callee: Expr }).callee);
        for (const argument of (expression as { arguments: Expr[] }).arguments) {
          visitExpression(argument);
        }
        return;
      case "NewExpression":
        visitExpression((expression as { callee: Expr }).callee);
        for (const argument of (expression as { arguments?: Expr[] }).arguments ?? []) {
          visitExpression(argument);
        }
        return;
      case "UnaryExpression":
      case "UpdateExpression":
        visitExpression((expression as { argument: Expr }).argument);
        return;
      case "ArrayLiteral":
        for (const element of (expression as { elements: Expr[] }).elements) {
          visitExpression(element);
        }
        return;
      case "ObjectLiteral":
        for (const property of (expression as { properties: Array<{ value: Expr }> }).properties) {
          visitExpression(property.value);
        }
        return;
      default:
        return;
    }
  };

  const visitStatement = (statement: Statement): void => {
    switch (statement.kind) {
      case "VarStatement": {
        const varStatement = statement as VarStatement;
        if (varStatement.declarations && varStatement.declarations.length > 0) {
          for (const declaration of varStatement.declarations) {
            if (declaration.initializer) {
              visitExpression(declaration.initializer);
            }
          }
        } else if (varStatement.initializer) {
          visitExpression(varStatement.initializer);
        }
        return;
      }
      case "ExprStatement":
        visitExpression((statement as { expression: Expr }).expression);
        return;
      case "ReturnStatement":
        if ((statement as { expression?: Expr }).expression) {
          visitExpression((statement as { expression: Expr }).expression);
        }
        return;
      case "IfStatement":
        visitExpression((statement as { condition: Expr }).condition);
        visitStatement((statement as { thenBranch: Statement }).thenBranch);
        if ((statement as { elseBranch?: Statement }).elseBranch) {
          visitStatement((statement as { elseBranch: Statement }).elseBranch);
        }
        return;
      case "WhileStatement":
        visitExpression((statement as { condition: Expr }).condition);
        visitStatement((statement as { body: Statement }).body);
        return;
      case "DoWhileStatement":
        visitStatement((statement as { body: Statement }).body);
        visitExpression((statement as { condition: Expr }).condition);
        return;
      case "ForStatement": {
        const forStatement = statement as ForStatement;
        if (forStatement.iterationKind && forStatement.iterable) {
          if (forStatement.iterator && forStatement.iterator.kind !== "VarStatement") {
            visitExpression(forStatement.iterator as Expr);
          }
          visitExpression(forStatement.iterable);
          visitStatement(forStatement.body);
          return;
        }
        if (forStatement.initializer && forStatement.initializer.kind !== "VarStatement") {
          visitExpression(forStatement.initializer as Expr);
        } else if (forStatement.initializer && forStatement.initializer.kind === "VarStatement") {
          visitStatement(forStatement.initializer as VarStatement);
        }
        if (forStatement.condition) {
          visitExpression(forStatement.condition);
        }
        if (forStatement.update) {
          visitExpression(forStatement.update);
        }
        visitStatement(forStatement.body);
        return;
      }
      case "SwitchStatement":
        visitExpression((statement as { discriminant: Expr }).discriminant);
        for (const switchCase of (statement as { cases: Array<{ test?: Expr; consequent: Statement[] }> }).cases) {
          if (switchCase.test) {
            visitExpression(switchCase.test);
          }
          for (const consequent of switchCase.consequent) {
            visitStatement(consequent);
          }
        }
        return;
      case "BlockStatement":
        for (const child of (statement as { body: Statement[] }).body) {
          visitStatement(child);
        }
        return;
      case "FunctionStatement":
        for (const parameter of (statement as { parameters: Array<{ defaultValue?: Expr }> }).parameters) {
          if (parameter.defaultValue) {
            visitExpression(parameter.defaultValue);
          }
        }
        visitStatement((statement as { body: Statement }).body);
        return;
      case "ClassStatement":
        for (const member of (statement as { members: Array<{ kind: string; initializer?: Expr; parameters?: Array<{ defaultValue?: Expr }>; body?: Statement }> }).members) {
          if (member.initializer) {
            visitExpression(member.initializer);
          }
          if (member.parameters) {
            for (const parameter of member.parameters) {
              if (parameter.defaultValue) {
                visitExpression(parameter.defaultValue);
              }
            }
          }
          if (member.body) {
            visitStatement(member.body);
          }
        }
        return;
      default:
        return;
    }
  };

  for (const statement of program.body) {
    visitStatement(statement);
  }

  return collected;
}

function getIteratorName(iterator: ForStatement["iterator"]): string | null {
  if (!iterator) {
    return null;
  }
  if (iterator.kind === "Identifier") {
    return (iterator as { name: string }).name;
  }
  if (iterator.kind !== "VarStatement") {
    return null;
  }

  const declaration = (iterator as VarStatement).declarations?.[0];
  if (declaration) {
    return declaration.name.name;
  }
  return (iterator as VarStatement).name.name;
}

function rewriteIterationAndRangeExpressions(source: string, program: Program): string {
  const replacements: Replacement[] = [];
  const optimizedRanges = new Set<RangeExpression>();
  const forStatements = collectForStatements(program);

  for (const forStatement of forStatements) {
    if (!forStatement.iterationKind || !forStatement.iterator || !forStatement.iterable) {
      continue;
    }

    if (
      forStatement.iterable.kind === "RangeExpression" &&
      forStatement.firstToken &&
      forStatement.lastToken
    ) {
      const iteratorName = getIteratorName(forStatement.iterator);
      if (!iteratorName) {
        continue;
      }
      const range = forStatement.iterable as RangeExpression;
      const startText = exprText(source, range.start);
      const endText = exprText(source, range.end);
      const bodyText = nodeText(source, forStatement.body);
      if (startText.length === 0 || endText.length === 0 || bodyText.length === 0) {
        continue;
      }

      replacements.push({
        start: forStatement.firstToken.range.start.offset,
        end: forStatement.lastToken.range.end.offset,
        text: `for (let ${iteratorName} = ${startText}; ${iteratorName} < ${endText}; ${iteratorName}++) ${bodyText}`
      });
      optimizedRanges.add(range);
      continue;
    }

    if (forStatement.iterator.kind !== "Identifier") {
      continue;
    }
    if (!forStatement.firstToken || forStatement.firstToken.value !== "for") {
      continue;
    }

    const forToken = forStatement.firstToken;
    const openParen = source.indexOf("(", forToken.range.end.offset);
    if (openParen < 0) {
      continue;
    }
    const closeParen = findMatchingCloseParen(source, openParen);
    if (closeParen < 0) {
      continue;
    }

    const iteratorText = exprText(source, forStatement.iterator);
    const iterableText = exprText(source, forStatement.iterable);
    replacements.push({
      start: openParen + 1,
      end: closeParen,
      text: `const ${iteratorText} of ${iterableText}`
    });
  }

  for (const rangeExpression of collectRangeExpressions(program)) {
    if (optimizedRanges.has(rangeExpression)) {
      continue;
    }
    if (!rangeExpression.firstToken || !rangeExpression.lastToken) {
      continue;
    }
    const startText = exprText(source, rangeExpression.start);
    const endText = exprText(source, rangeExpression.end);
    replacements.push({
      start: rangeExpression.firstToken.range.start.offset,
      end: rangeExpression.lastToken.range.end.offset,
      text: `(function*(s, e) { for (let n = s; n < e; n++) yield n })(${startText}, ${endText})`
    });
  }

  return applyReplacements(source, replacements);
}

export function transpile(source: string): TranspileResult {
  const withoutDeclarations = stripDeclareStatements(source);
  let ast: Program;

  try {
    const tokens = tokenize(withoutDeclarations);
    const parser = new Parser(new ListReader(tokens));
    ast = parser.parseFile();

    const errors: string[] = [];
    for (const issue of parser.errors) {
      if (issue.token) {
        errors.push(
          `${issue.message} at ${issue.token.range.start.line + 1}:${issue.token.range.start.column + 1}`
        );
      } else {
        errors.push(issue.message);
      }
    }
    if (errors.length > 0) {
      return { code: "", warnings: [], errors };
    }

    const analysis = new Analysis(ast);
    for (const issue of analysis.getIssues()) {
      const token = issue.node.firstToken;
      if (token) {
        errors.push(`${issue.message} at ${token.range.start.line + 1}:${token.range.start.column + 1}`);
      } else {
        errors.push(issue.message);
      }
    }
    if (errors.length > 0) {
      return { code: "", warnings: [], errors };
    }
  } catch (error) {
    if (error instanceof TokenizeError) {
      return {
        code: "",
        warnings: [],
        errors: [`${error.message} at ${error.range.start.line + 1}:${error.range.start.column + 1}`]
      };
    }
    return {
      code: "",
      warnings: [],
      errors: [error instanceof Error ? error.message : String(error)]
    };
  }

  const rewrittenSource = rewriteIterationAndRangeExpressions(withoutDeclarations, ast);
  return {
    code: ensureTrailingSemicolon(rewrittenSource),
    warnings: [],
    errors: []
  };
}
