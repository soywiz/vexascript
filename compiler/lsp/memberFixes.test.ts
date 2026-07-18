import { NodeKind } from "compiler/ast/ast";
import { describe, expect, it, join, mkdtemp, pathToFileURL, tmpdir, writeFile } from "../test/expect";
import { walkAst } from "compiler/ast/traversal";
import type { Identifier, MemberExpression } from "compiler/ast/ast";
import type { Diagnostic } from "vscode-languageserver/node.js";
import { createAnalysisSession } from "./analysisSession";
import { createCreateMemberCodeActions } from "./memberFixes";

function missingMemberDiagnostic(message: string): Diagnostic {
  return {
    severity: 1,
    source: "vexa-sema",
    message,
    range: {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 1 }
    }
  };
}

function missingMemberDiagnosticAtProperty(
  session: ReturnType<typeof createAnalysisSession>,
  memberName: string,
  typeName: string
): Diagnostic {
  let property: Identifier | null = null;
  if (session.ast) {
    walkAst(session.ast, (node) => {
      if (
        !property &&
        node.kind === NodeKind.MemberExpression &&
        !(node as MemberExpression).computed &&
        (node as MemberExpression).property.kind === NodeKind.Identifier &&
        ((node as MemberExpression).property as Identifier).name === memberName
      ) {
        property = (node as MemberExpression).property as Identifier;
      }
    });
  }

  const resolvedProperty = property as Identifier | null;
  const firstToken = resolvedProperty?.firstToken;
  const lastToken = resolvedProperty?.lastToken;
  if (!firstToken || !lastToken) {
    return missingMemberDiagnostic(`Property '${memberName}' does not exist on type '${typeName}'`);
  }

  return {
    severity: 1,
    source: "vexa-sema",
    message: `Property '${memberName}' does not exist on type '${typeName}'`,
    range: {
      start: {
        line: firstToken.range.start.line,
        character: firstToken.range.start.column
      },
      end: {
        line: lastToken.range.end.line,
        character: lastToken.range.end.column
      }
    }
  };
}

describe("member quick fixes", () => {
  it("creates missing member in imported class file", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-member-fix-"));
    const worldFile = join(root, "world.vx");
    const helloFile = join(root, "hello.vx");

    const worldSource = `class MyPoint(const x: number, const y: number) { }
`;
    const helloSource = `import { MyPoint } from "./world"
fun demo() {
  const point = new MyPoint()
  point.xx
}
`;

    await writeFile(worldFile, worldSource, "utf8");
    await writeFile(helloFile, helloSource, "utf8");

    const session = createAnalysisSession(helloSource);
    const actions = await createCreateMemberCodeActions({
      uri: pathToFileURL(helloFile).toString(),
      ast: session.ast,
      diagnostics: [
        missingMemberDiagnostic("Property 'xx' does not exist on type 'MyPoint'")
      ],
      sourceRoots: [root]
    });

    expect(actions).toHaveLength(1);
    expect(actions[0]?.title).toBe("Create member 'xx' in class 'MyPoint'");
    const worldUri = pathToFileURL(worldFile).toString();
    expect(actions[0]?.edit?.changes?.[worldUri]?.[0]?.newText).toContain("xx: unknown");
  });

  it("creates missing member in local class declaration", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-member-fix-"));
    const file = join(root, "demo.vx");
    const source = `class MyPoint { }
fun demo() {
  const point = new MyPoint()
  point.zz
}
`;
    await writeFile(file, source, "utf8");

    const session = createAnalysisSession(source);
    const actions = await createCreateMemberCodeActions({
      uri: pathToFileURL(file).toString(),
      ast: session.ast,
      diagnostics: [
        missingMemberDiagnostic("Property 'zz' does not exist on type 'MyPoint'")
      ],
      sourceRoots: [root]
    });

    expect(actions).toHaveLength(1);
    const uri = pathToFileURL(file).toString();
    expect(actions[0]?.edit?.changes?.[uri]?.[0]?.newText).toContain("zz: unknown");
  });

  it("infers missing member type from assignment usage", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-member-fix-"));
    const file = join(root, "demo.vx");
    const source = `class MyPoint { }
fun demo() {
  const point = new MyPoint()
  point.zz = 42
}
`;
    await writeFile(file, source, "utf8");

    const session = createAnalysisSession(source);
    const actions = await createCreateMemberCodeActions({
      uri: pathToFileURL(file).toString(),
      ast: session.ast,
      analysis: session.analysis,
      diagnostics: [
        missingMemberDiagnosticAtProperty(session, "zz", "MyPoint")
      ],
      sourceRoots: [root]
    });

    expect(actions).toHaveLength(1);
    const uri = pathToFileURL(file).toString();
    expect(actions[0]?.edit?.changes?.[uri]?.[0]?.newText).toContain("zz: int");
  });

  it("resolves class target from generic missing-member diagnostics", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-member-fix-"));
    const worldFile = join(root, "world.vx");
    const helloFile = join(root, "hello.vx");

    const worldSource = `class Map<K, V> {
}
`;
    const helloSource = `import { Map } from "./world"
fun demo() {
  const map = new Map<string, int>()
  map.extra = 1
}
`;

    await writeFile(worldFile, worldSource, "utf8");
    await writeFile(helloFile, helloSource, "utf8");

    const session = createAnalysisSession(helloSource);
    const actions = await createCreateMemberCodeActions({
      uri: pathToFileURL(helloFile).toString(),
      ast: session.ast,
      analysis: session.analysis,
      diagnostics: [
        missingMemberDiagnostic("Property 'extra' does not exist on type 'Map<string, int>'")
      ],
      sourceRoots: [root]
    });

    expect(actions).toHaveLength(1);
    const worldUri = pathToFileURL(worldFile).toString();
    expect(actions[0]?.edit?.changes?.[worldUri]?.[0]?.newText).toContain("extra: unknown");
  });
});
