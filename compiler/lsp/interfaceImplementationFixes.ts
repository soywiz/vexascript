import type { Program, ClassMethodMember, ClassStatement } from "compiler/ast/ast";
import type { CodeAction, Diagnostic, Range } from "vscode-languageserver/node.js";
import { splitTopLevelTypeText } from "compiler/analysis/typeNames";
import { CodeActionKind } from "./codeActionKinds";
import { bodyEndInsertRange } from "./ranges";
import { pathToUri } from "./importFixes";
import {
  createClassResolverCache,
  resolveClassMember,
  resolveClassStatementAcrossFiles,
  type ClassResolverSessionLike
} from "./classResolver";
import {
  diagnosticHasCode,
  IMPLEMENTS_INCOMPATIBLE_MEMBER_PATTERN,
  IMPLEMENTS_MISSING_MEMBER_PATTERN,
  VEXA_DIAGNOSTIC_CODES
} from "./diagnosticCodes";

interface MissingImplementsDiagnostic {
  kind: "missing";
  className: string;
  interfaceName: string;
  memberName: string;
}

interface IncompatibleImplementsDiagnostic {
  kind: "incompatible";
  className: string;
  interfaceName: string;
  memberName: string;
  expectedType: string;
}

type ImplementsDiagnostic = MissingImplementsDiagnostic | IncompatibleImplementsDiagnostic;

interface ImplementsIssueDataBase {
  className?: unknown;
  interfaceName?: unknown;
  memberName?: unknown;
}

interface ImplementsIncompatibleIssueData extends ImplementsIssueDataBase {
  expectedType?: unknown;
}

function readStringProperty(data: Record<string, unknown>, key: string): string | null {
  const value = data[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

interface ParsedFunctionParameter {
  name: string;
  typeName: string;
  optional: boolean;
}

interface ParsedFunctionType {
  parameters: ParsedFunctionParameter[];
  returnTypeName: string;
}

function parseImplementsDiagnostic(diagnostic: Diagnostic): ImplementsDiagnostic | null {
  if (diagnostic.source !== "vexa-sema") {
    return null;
  }

  if (diagnosticHasCode(diagnostic, VEXA_DIAGNOSTIC_CODES.IMPLEMENTS_MISSING_MEMBER)) {
    const data = diagnostic.data;
    if (data && typeof data === "object") {
      const record = data as ImplementsIssueDataBase & Record<string, unknown>;
      const className = readStringProperty(record, "className");
      const interfaceName = readStringProperty(record, "interfaceName");
      const memberName = readStringProperty(record, "memberName");
      if (className && interfaceName && memberName) {
        return {
          kind: "missing",
          className,
          interfaceName,
          memberName
        };
      }
    }
  }

  if (diagnosticHasCode(diagnostic, VEXA_DIAGNOSTIC_CODES.IMPLEMENTS_INCOMPATIBLE_MEMBER)) {
    const data = diagnostic.data;
    if (data && typeof data === "object") {
      const record = data as ImplementsIncompatibleIssueData & Record<string, unknown>;
      const className = readStringProperty(record, "className");
      const interfaceName = readStringProperty(record, "interfaceName");
      const memberName = readStringProperty(record, "memberName");
      const expectedType = readStringProperty(record, "expectedType");
      if (className && interfaceName && memberName && expectedType) {
        return {
          kind: "incompatible",
          className,
          interfaceName,
          memberName,
          expectedType
        };
      }
    }
  }

  const missingMatch = IMPLEMENTS_MISSING_MEMBER_PATTERN.exec(diagnostic.message);
  if (missingMatch) {
    const className = missingMatch[1];
    const interfaceName = missingMatch[2];
    const memberName = missingMatch[3];
    if (!className || !interfaceName || !memberName) {
      return null;
    }
    return {
      kind: "missing",
      className,
      interfaceName,
      memberName
    };
  }

  const incompatibleMatch = IMPLEMENTS_INCOMPATIBLE_MEMBER_PATTERN.exec(diagnostic.message);
  if (incompatibleMatch) {
    const className = incompatibleMatch[1];
    const interfaceName = incompatibleMatch[2];
    const memberName = incompatibleMatch[3];
    const expectedType = incompatibleMatch[5];
    if (!className || !interfaceName || !memberName || !expectedType) {
      return null;
    }
    return {
      kind: "incompatible",
      className,
      interfaceName,
      memberName,
      expectedType
    };
  }

  return null;
}

function classObjectTypeName(classStatement: ClassStatement): string {
  const typeParameters = classStatement.typeParameters?.map((parameter) => parameter.name.name) ?? [];
  if (typeParameters.length === 0) {
    return classStatement.name.name;
  }
  return `${classStatement.name.name}<${typeParameters.join(", ")}>`;
}

function parseFunctionTypeLabel(typeLabel: string): ParsedFunctionType | null {
  const trimmed = typeLabel.trim();
  const arrowIndex = trimmed.lastIndexOf("=>");
  if (!trimmed.startsWith("(") || arrowIndex <= 0) {
    return null;
  }
  const paramsPart = trimmed.slice(1, arrowIndex).replace(/\)\s*$/, "").trim();
  const returnTypeName = trimmed.slice(arrowIndex + 2).trim();
  if (returnTypeName.length === 0) {
    return null;
  }

  const parameters: ParsedFunctionParameter[] = [];
  if (paramsPart.length > 0) {
    for (const rawParameter of splitTopLevelTypeText(paramsPart, ",")) {
      const match = /^([A-Za-z_][A-Za-z0-9_]*)(\?)?:\s*(.+)$/.exec(rawParameter);
      if (!match) {
        return null;
      }
      const name = match[1];
      const optionalMarker = match[2];
      const typeName = match[3]?.trim() ?? "";
      if (!name || typeName.length === 0) {
        return null;
      }
      parameters.push({
        name,
        typeName,
        optional: optionalMarker === "?"
      });
    }
  }

  return {
    parameters,
    returnTypeName
  };
}

function signatureToMethodHead(signature: ParsedFunctionType, methodName: string): string {
  const parameters = signature.parameters
    .map((parameter) => `${parameter.name}${parameter.optional ? "?" : ""}: ${parameter.typeName}`)
    .join(", ");
  return `${methodName}(${parameters}): ${signature.returnTypeName}`;
}

function createMissingMemberText(classStatement: ClassStatement, memberName: string, typeName: string): string {
  const hasAnyMember =
    (classStatement.primaryConstructorParameters?.length ?? 0) > 0 || classStatement.members.length > 0;
  const prefix = hasAnyMember ? "" : "\n";
  return `${prefix}  ${memberName}: ${typeName}\n`;
}

function createMissingMethodText(classStatement: ClassStatement, methodHead: string): string {
  const hasAnyMember =
    (classStatement.primaryConstructorParameters?.length ?? 0) > 0 || classStatement.members.length > 0;
  const prefix = hasAnyMember ? "" : "\n";
  return `${prefix}  ${methodHead} {\n    throw new Error("Not implemented")\n  }\n`;
}

function findOwnMethod(classStatement: ClassStatement, memberName: string): ClassMethodMember | null {
  for (const member of classStatement.members) {
    if (member.kind !== "ClassMethodMember") {
      continue;
    }
    if (member.name.name === memberName) {
      return member;
    }
  }
  return null;
}

function methodSignatureRange(method: ClassMethodMember): Range | null {
  const methodNameToken = method.name.lastToken;
  const methodBodyToken = method.body.firstToken;
  if (!methodNameToken || !methodBodyToken) {
    return null;
  }
  return {
    start: {
      line: methodNameToken.range.end.line,
      character: methodNameToken.range.end.column
    },
    end: {
      line: methodBodyToken.range.start.line,
      character: methodBodyToken.range.start.column
    }
  };
}

export async function createInterfaceImplementationCodeActions(params: {
  uri: string;
  ast: Program | null;
  diagnostics: Diagnostic[];
  sourceRoots: string[];
  getSessionForFilePath?: (filePath: string) => ClassResolverSessionLike | null | Promise<ClassResolverSessionLike | null>;
}): Promise<CodeAction[]> {
  const { uri, ast, diagnostics, sourceRoots } = params;
  if (!ast || diagnostics.length === 0) {
    return [];
  }

  const actions: CodeAction[] = [];
  const seen = new Set<string>();
  const cache = createClassResolverCache();
  const options = {
    uri,
    sourceRoots,
    ...(params.getSessionForFilePath
      ? { getSessionForFilePath: params.getSessionForFilePath }
      : {})
  };

  for (const diagnostic of diagnostics) {
    const parsed = parseImplementsDiagnostic(diagnostic);
    if (!parsed) {
      continue;
    }

    const classResolution = await resolveClassStatementAcrossFiles(ast, parsed.className, options, cache);
    if (!classResolution) {
      continue;
    }

    if (parsed.kind === "missing") {
      const range = bodyEndInsertRange(classResolution.classStatement);
      if (!range) {
        continue;
      }

      const expectedMember = await resolveClassMember(
        classResolution.classStatement,
        parsed.memberName,
        classObjectTypeName(classResolution.classStatement),
        {
          ast,
          options,
          cache
        }
      );
      if (!expectedMember) {
        continue;
      }

      let newText = "";
      if (expectedMember.kind === "method" && expectedMember.signature) {
        const signature: ParsedFunctionType = {
          parameters: expectedMember.signature.parameters.map((parameter) => ({
            name: parameter.name,
            typeName: parameter.typeName,
            optional: parameter.optional
          })),
          returnTypeName: expectedMember.signature.returnTypeName
        };
        newText = createMissingMethodText(
          classResolution.classStatement,
          signatureToMethodHead(signature, parsed.memberName)
        );
      } else {
        newText = createMissingMemberText(
          classResolution.classStatement,
          parsed.memberName,
          expectedMember.typeName
        );
      }

      const targetUri = pathToUri(classResolution.filePath);
      const key = `${targetUri}:missing:${parsed.className}:${parsed.memberName}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);

      actions.push({
        title: `Implement missing member '${parsed.memberName}' in class '${parsed.className}'`,
        kind: CodeActionKind.QuickFix,
        edit: {
          changes: {
            [targetUri]: [
              {
                range,
                newText
              }
            ]
          }
        }
      });
      continue;
    }

    const method = findOwnMethod(classResolution.classStatement, parsed.memberName);
    if (!method) {
      continue;
    }

    const expectedSignature = parseFunctionTypeLabel(parsed.expectedType);
    if (!expectedSignature) {
      continue;
    }

    const range = methodSignatureRange(method);
    if (!range) {
      continue;
    }

    const targetUri = pathToUri(classResolution.filePath);
    const key = `${targetUri}:signature:${parsed.className}:${parsed.memberName}:${parsed.interfaceName}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);

    actions.push({
      title: `Fix signature of '${parsed.memberName}' to match interface '${parsed.interfaceName}'`,
      kind: CodeActionKind.QuickFix,
      edit: {
        changes: {
          [targetUri]: [
            {
              range,
              newText: `(${expectedSignature.parameters
                .map((parameter) => `${parameter.name}${parameter.optional ? "?" : ""}: ${parameter.typeName}`)
                .join(", ")}): ${expectedSignature.returnTypeName} `
            }
          ]
        }
      }
    });
  }

  return actions;
}
