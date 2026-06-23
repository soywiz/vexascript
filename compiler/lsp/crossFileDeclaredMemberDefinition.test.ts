import { describe, expect, it, join, mkdir, mkdtemp, pathToFileURL, tmpdir, writeFile } from "../test/expect";
import dedent from "compiler/utils/dedent";
import type { Identifier } from "compiler/ast/ast";
import { createAnalysisSession } from "./analysisSession";
import { resolveDeclaredMemberDefinitionAcrossFiles } from "./crossFileDeclaredMemberDefinition";
import { findMemberExpressionAtPosition } from "./crossFileTypeResolution";
import { collectAllImportedDeclarations } from "./importedDeclarations";

async function resolveDeclaredMemberDefinitionFromSource(args: {
  root: string;
  filePath: string;
  source: string;
  line: number;
  character: number;
}) {
  const uri = pathToFileURL(args.filePath).toString();
  const baseSession = createAnalysisSession(args.source);
  const collected = await collectAllImportedDeclarations(baseSession.ast!, {
    uri,
    sourceRoots: [args.root]
  });
  const session = createAnalysisSession(args.source, { externalDeclarations: collected.externalDeclarations, importedSymbols: collected.importedSymbols });
  const memberExpression = findMemberExpressionAtPosition(session.ast!, args.line, args.character);
  expect(memberExpression?.property.kind).toBe("Identifier");

  const objectType = session.analysis!.getExpressionTypes().get(memberExpression!.object);
  expect(objectType).toBeTruthy();

  return resolveDeclaredMemberDefinitionAcrossFiles({
    uri,
    line: args.line,
    character: args.character,
    session,
    sourceRoots: [args.root]
  }, objectType!, (memberExpression!.property as Identifier).name);
}

describe("crossFileDeclaredMemberDefinition", () => {
  it("resolves class member declarations", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-member-core-"));
    const fileA = join(root, "world.vx");
    const fileB = join(root, "hello.vx");

    const sourceA = "class MyPoint(const x: number, const y: number) { }\n";
    const sourceB = "import { MyPoint } from \"./world\"\nfun demo() {\n  const point = new MyPoint()\n  point.x\n}\n";

    await writeFile(fileA, sourceA, "utf8");
    await writeFile(fileB, sourceB, "utf8");

    const location = await resolveDeclaredMemberDefinitionFromSource({
      root,
      filePath: fileB,
      source: sourceB,
      line: 3,
      character: 8
    });

    expect(location).toEqual({
      uri: pathToFileURL(fileA).toString(),
      range: {
        start: { line: 0, character: 20 },
        end: { line: 0, character: 21 }
      }
    });
  });

  it("resolves imported object type alias members", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-member-core-type-alias-"));
    const scenariosPath = join(root, "scenarios.vx");
    const mainPath = join(root, "main.vx");

    const scenariosSource = dedent`
      export type Scenario = {
        label: string,
        source: string,
        showTree?: boolean
      }
    `;
    const mainSource = dedent`
      import { Scenario } from "./scenarios.vx"
      function lex(source: string) {}
      function summarizeScenario(scenario: Scenario): string {
        const tokens = lex(scenario.source)
      }
    `;

    await writeFile(scenariosPath, scenariosSource, "utf8");
    await writeFile(mainPath, mainSource, "utf8");

    const location = await resolveDeclaredMemberDefinitionFromSource({
      root,
      filePath: mainPath,
      source: mainSource,
      line: 3,
      character: mainSource.split("\n")[3]!.indexOf(".source") + 2
    });

    expect(location).toEqual({
      uri: pathToFileURL(scenariosPath).toString(),
      range: {
        start: { line: 2, character: 2 },
        end: { line: 2, character: 8 }
      }
    });
  });

  it("resolves imported class members after an 'is' smart-cast", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-member-core-smart-cast-"));
    const astPath = join(root, "ast.vx");
    const mainPath = join(root, "optimizer.vx");
    const astSource = dedent`
      export class NumberExpr(val value: number) {
        readonly kind = "number"
      }
      export class UnaryExpr(val operator: string, val operand: NumberExpr | UnaryExpr) {
        readonly kind = "unary"
      }
    `;
    const mainSource = dedent`
      import { NumberExpr, UnaryExpr } from "./ast.vx"
      export function foldConstants(expression: NumberExpr | UnaryExpr): NumberExpr | UnaryExpr {
        if (expression is UnaryExpr) {
          expression.operator
        }
        return expression
      }
    `;

    await writeFile(astPath, astSource, "utf8");
    await writeFile(mainPath, mainSource, "utf8");

    const location = await resolveDeclaredMemberDefinitionFromSource({
      root,
      filePath: mainPath,
      source: mainSource,
      line: 3,
      character: mainSource.split("\n")[3]!.indexOf(".operator") + 2
    });

    expect(location).toEqual({
      uri: pathToFileURL(astPath).toString(),
      range: {
        start: { line: 3, character: 27 },
        end: { line: 3, character: 35 }
      }
    });
  });

  it("resolves a member declared behind an export-star barrel to its source file", async () => {
    const root = await mkdtemp(join(tmpdir(), "vexa-member-barrel-"));
    const pkgDir = join(root, "node_modules", "shapes-pkg");
    const shapesDir = join(pkgDir, "shapes");
    await mkdir(shapesDir, { recursive: true });
    await writeFile(
      join(pkgDir, "package.json"),
      JSON.stringify({ name: "shapes-pkg", types: "./index.d.ts", typings: "./index.d.ts" }),
      "utf8"
    );
    await writeFile(join(pkgDir, "index.d.ts"), `export * from "./shapes";\n`, "utf8");
    await writeFile(
      join(shapesDir, "index.d.ts"),
      `export declare class Box {\n  width: number;\n}\n`,
      "utf8"
    );

    const mainPath = join(root, "main.vx");
    const mainSource = dedent`
      import { Box } from "shapes-pkg"
      fun demo() {
        const box = new Box()
        box.width
      }
    `;
    await writeFile(mainPath, mainSource, "utf8");

    const location = await resolveDeclaredMemberDefinitionFromSource({
      root,
      filePath: mainPath,
      source: mainSource,
      line: 3,
      character: mainSource.split("\n")[3]!.indexOf(".width") + 2
    });

    // `width` is declared in shapes/index.d.ts, reached through the package's
    // `export *` barrel. Definition must land in that source file, not the
    // barrel index.d.ts.
    expect(location).toBeTruthy();
    expect(location!.uri).toContain("shapes/index.d.ts");
  });
});
