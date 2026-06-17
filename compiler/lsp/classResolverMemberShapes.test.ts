import { describe, expect, it } from "../test/expect";
import dedent from "compiler/utils/dedent";
import type { ClassStatement, InterfaceStatement } from "compiler/ast/ast";
import { createAnalysisSession } from "./analysisSession";
import {
  classOwnMemberKind,
  resolveClassOwnMember,
  resolveInterfaceOwnSignatures
} from "./classResolverMemberShapes";
import { classPropertyParameters } from "./classResolver";

describe("classResolverMemberShapes", () => {
  it("resolves constructor parameter properties as fields", () => {
    const source = dedent`
      class Point(
        /// The x coordinate.
        val x: number,
        val y: number
      )
    `;
    const ast = createAnalysisSession(source).ast!;
    const classStatement = ast.body[0] as ClassStatement;

    const member = resolveClassOwnMember(
      classStatement,
      "x",
      new Map(),
      classPropertyParameters
    );

    expect(member).toEqual({
      className: "Point",
      memberName: "x",
      kind: "field",
      typeName: "number",
      documentation: "The x coordinate."
    });
    expect(classOwnMemberKind(classStatement, "x", classPropertyParameters)).toBe("field");
  });

  it("resolves class methods into signatures and callable type labels", () => {
    const source = dedent`
      class Point {
        /// Scales this point.
        fun scale(factor: number): Point => this
      }
    `;
    const ast = createAnalysisSession(source).ast!;
    const classStatement = ast.body[0] as ClassStatement;

    const member = resolveClassOwnMember(
      classStatement,
      "scale",
      new Map(),
      classPropertyParameters
    );

    expect(member).toEqual({
      className: "Point",
      memberName: "scale",
      kind: "method",
      typeName: "(factor: number) => Point",
      signature: {
        name: "scale",
        parameters: [
          {
            name: "factor",
            typeName: "number",
            optional: false,
            rest: false
          }
        ],
        returnTypeName: "Point",
        documentation: "Scales this point."
      },
      documentation: "Scales this point."
    });
    expect(classOwnMemberKind(classStatement, "scale", classPropertyParameters)).toBe("method");
  });

  it("resolves interface properties and methods into member/signature shapes", () => {
    const source = dedent`
      interface Service {
        /// Base URL.
        baseUrl: string
        /// Fetches data.
        request(path: string): number
      }
    `;
    const ast = createAnalysisSession(source).ast!;
    const interfaceStatement = ast.body[0] as InterfaceStatement;

    const property = resolveInterfaceOwnSignatures(interfaceStatement, "baseUrl", new Map());
    const method = resolveInterfaceOwnSignatures(interfaceStatement, "request", new Map());

    expect(property).toEqual([
      {
        member: {
          className: "Service",
          memberName: "baseUrl",
          kind: "field",
          typeName: "string",
          documentation: "Base URL."
        },
        signature: {
          name: "baseUrl",
          parameters: [],
          returnTypeName: "string"
        }
      }
    ]);
    expect(method).toEqual([
      {
        member: {
          className: "Service",
          memberName: "request",
          kind: "method",
          typeName: "(path: string) => number",
          signature: {
            name: "request",
            parameters: [
              {
                name: "path",
                typeName: "string",
                optional: false,
                rest: false
              }
            ],
            returnTypeName: "number",
            documentation: "Fetches data."
          },
          documentation: "Fetches data."
        },
        signature: {
          name: "request",
          parameters: [
            {
              name: "path",
              typeName: "string",
              optional: false,
              rest: false
            }
          ],
          returnTypeName: "number",
          documentation: "Fetches data."
        }
      }
    ]);
  });
});
