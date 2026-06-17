import { describe, expect, it } from "../test/expect";
import type { FunctionStatement, InterfaceMethodMember, InterfaceStatement, Statement } from "compiler/ast/ast";
import { parseSource } from "compiler/pipeline/parse";
import {
  renderAmbientFunctionDisplayFromInterfaceMember,
  renderAmbientFunctionDisplayFromStatement,
  renderAmbientInterfaceMemberDisplay,
  renderAmbientTypeAnnotationText
} from "./ambientDisplay";

function parseAmbientModule(src: string, moduleName: string): Statement[] {
  const result = parseSource(src, { language: "typescript" });
  const ns = result.ast?.body?.find(
    (statement) =>
      statement.kind === "NamespaceStatement"
      && (statement as { externalModuleName?: { value: string } }).externalModuleName?.value === moduleName
  ) as { body?: { body?: Statement[] } } | undefined;
  return ns?.body?.body ?? [];
}

describe("ambientDisplay", () => {
  it("renders ambient function statements with generics, optional parameters, and rest parameters", () => {
    const declarations = parseAmbientModule(
      `declare module "pkg" {
        export function map<T>(value: T, fallback?: string, ...rest: number[]): Promise<T>;
      }`,
      "pkg"
    );
    const fn = declarations.find((statement) => statement.kind === "ExportStatement") as
      { declaration?: FunctionStatement };

    expect(renderAmbientFunctionDisplayFromStatement(fn.declaration!)).toBe(
      "<T>(value: T, fallback?: string, ...rest: number[]) => Promise<T>"
    );
  });

  it("renders interface methods and properties using the shared ambient display helpers", () => {
    const declarations = parseAmbientModule(
      `declare module "pkg" {
        export interface ThemeApi {
          setColor(name: string, value?: string): void;
          current: string;
        }
      }`,
      "pkg"
    );
    const iface = declarations.find((statement) => statement.kind === "ExportStatement") as
      { declaration?: InterfaceStatement };
    const members = iface.declaration!.members;

    expect(renderAmbientFunctionDisplayFromInterfaceMember(members[0] as InterfaceMethodMember)).toBe(
      "(name: string, value?: string) => void"
    );
    expect(renderAmbientInterfaceMemberDisplay(members[0]!)).toBe("(name: string, value?: string) => void");
    expect(renderAmbientInterfaceMemberDisplay(members[1]!)).toBe("string");
    expect(renderAmbientTypeAnnotationText(undefined)).toBe("unknown");
  });
});
