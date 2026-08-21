import { describe, expect, it } from "./test/expect";
import { createCodeMirrorLegacyModeSource, createPortableMonarchLanguage, createVscodeTmLanguageGrammar } from "./syntax";

describe("portable monarch syntax", () => {
  it("classifies type declaration keywords separately from identifiers", () => {
    const language = createPortableMonarchLanguage();
    const identifierRule = language.tokenizer["root"]?.find(
      (rule) => rule.match === String.raw`[A-Za-z_$][\w$]*`
    );

    expect(identifierRule?.cases?.["@typeKeywords"]).toBe("keywordType");
    expect(identifierRule?.cases?.["@functionKeywords"]).toBe("keywordFunction");
    expect(identifierRule?.cases?.["@modifierKeywords"]).toBe("keywordModifier");
    expect(language.declarationKeywords).toContain("val");
    expect(language.modifierKeywords).toContain("readonly");
    expect(language.modifierKeywords).toContain("fun");
    expect(language.modifierKeywords).toContain("fn");
    expect(language.modifierKeywords).toContain("func");
    expect(language.modifierKeywords).toContain("init");
    expect(language.functionKeywords).toEqual([]);
    expect(language.controlKeywords).toEqual(expect.arrayContaining(["match", "when", "is", "and", "or"]));
    expect(language.typeKeywords).toEqual(expect.arrayContaining([
      "class",
      "interface",
      "annotation",
      "enum",
      "extends",
      "implements"
    ]));
  });

  it("classifies match and when as keywords in every generated highlighter", () => {
    const language = createPortableMonarchLanguage();
    const vscodeGrammar = createVscodeTmLanguageGrammar();
    const repository = vscodeGrammar["repository"] as Record<string, unknown>;
    const keywords = repository["keywords"] as { patterns: Array<{ name: string; match: string }> };
    const controlPattern = keywords.patterns.find((pattern) => pattern.name === "keyword.control.vexa");
    const codeMirror = createCodeMirrorLegacyModeSource();

    expect(language.controlKeywords).toEqual(expect.arrayContaining(["match", "when"]));
    expect(controlPattern?.match).toContain("match|when");
    expect(codeMirror).toContain("case|match|when|default");
  });

  it("classifies var! as one keyword in every generated highlighter", () => {
    const language = createPortableMonarchLanguage();
    const uncheckedVarRule = language.tokenizer["root"]?.find(
      (rule) => rule.match === String.raw`\bvar!(?=\s|[_$A-Za-z])`
    );
    const vscodeGrammar = createVscodeTmLanguageGrammar();
    const repository = vscodeGrammar["repository"] as Record<string, unknown>;
    const keywords = repository["keywords"] as { patterns: Array<{ name: string; match: string }> };
    const codeMirror = createCodeMirrorLegacyModeSource();

    expect(uncheckedVarRule?.token).toBe("keyword.declaration");
    expect(keywords.patterns).toContainEqual({
      name: "keyword.declaration.vexa",
      match: String.raw`\bvar!(?=\s|[_$A-Za-z])`,
    });
    expect(codeMirror).toContain(String.raw`/\bvar!(?=\s|[_$A-Za-z])/`);
  });

  it("classifies regular-expression literals distinctly in every generated highlighter", () => {
    const language = createPortableMonarchLanguage();
    const vscodeGrammar = createVscodeTmLanguageGrammar();
    const repository = vscodeGrammar["repository"] as Record<string, unknown>;
    const regexps = repository["regexps"] as { patterns: Array<{ name: string; match: string }> };
    const monacoRule = language.tokenizer["root"]?.find((rule) => rule.token === "regexp");
    const jsxRule = language.tokenizer["jsx_expression"]?.find((rule) => rule.token === "regexp");
    const codeMirror = createCodeMirrorLegacyModeSource();
    const literalPattern = new RegExp(monacoRule!.match);

    expect(monacoRule?.match).toBe(String.raw`/(?![/*])(?:\\.|\[(?:\\.|[^\]\\])*\]|[^/\\\r\n])+/[dgimsuvy]*`);
    expect(jsxRule?.match).toBe(monacoRule?.match);
    expect(literalPattern.test("/^hell[ao]+$/")).toBe(true);
    expect(literalPattern.test("/hello\\/world/i")).toBe(true);
    expect(literalPattern.test("// comment")).toBe(false);
    expect(literalPattern.test("/* comment */")).toBe(false);
    expect(regexps.patterns[0]).toEqual({
      name: "string.regexp.vexa",
      match: monacoRule?.match,
    });
    expect(codeMirror).toContain('token: "regexp"');
    expect(codeMirror).toContain(String.raw`\/(?![\/*])`);
  });

  it("classifies hash-prefixed single- and double-quoted characters as numbers", () => {
    const language = createPortableMonarchLanguage();
    const characterRule = language.tokenizer["root"]?.find(
      (rule) => rule.match === String.raw`#(?:"([^"\\]|\\.)*"|'([^'\\]|\\.)*')`
    );
    const vscodeGrammar = createVscodeTmLanguageGrammar();
    const repository = vscodeGrammar["repository"] as Record<string, unknown>;
    const strings = repository["strings"] as { patterns: Array<{ name: string; begin?: string }> };
    const characterPatterns = strings.patterns.filter(
      (pattern) => pattern.name === "constant.numeric.character.vexa"
    );
    const codeMirror = createCodeMirrorLegacyModeSource();

    expect(characterRule?.token).toBe("number");
    expect(characterPatterns.map((pattern) => pattern.begin)).toEqual(['#"', "#'"]);
    expect(codeMirror).toContain("token: \"number\"");
    expect(codeMirror).toContain("/#(?:");
  });

  it("does not classify an imported operator/ name and its closing brace as a regexp", () => {
    const sourceAtOperator = 'operator/ } from "./time.vx"';
    const firstMatch = createPortableMonarchLanguage().tokenizer["root"]
      ?.map((rule) => ({ rule, result: new RegExp(`^(?:${rule.match})`).exec(sourceAtOperator) }))
      .find(({ result }) => result !== null);

    expect(firstMatch?.result?.[0]).toBe("operator/");
    expect(firstMatch?.rule.token).toBe("identifier");
  });

  it("classifies annotation applications without swallowing their arguments", () => {
    const language = createPortableMonarchLanguage();
    const annotationRule = language.tokenizer["root"]?.find(
      (rule) => rule.match === String.raw`@[A-Za-z_$][\w$]*`
    );
    const stringRule = language.tokenizer["root"]?.find(
      (rule) => rule.match === String.raw`"([^"\\]|\\.)*"`
    );
    const numberRule = language.tokenizer["root"]?.find((rule) => rule.token === "number.float");

    expect(annotationRule?.token).toBe("annotation");
    expect(stringRule?.match).toBe(String.raw`"([^"\\]|\\.)*"`);
    expect(numberRule?.match).toBe(String.raw`\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?(?:[nNL])?\b`);
  });

  it("classifies an initial shebang line as a comment", () => {
    const language = createPortableMonarchLanguage();
    const vscodeGrammar = createVscodeTmLanguageGrammar();
    const repository = vscodeGrammar["repository"] as Record<string, unknown>;
    const comments = repository["comments"] as { patterns: Array<Record<string, unknown>> };

    expect(language.tokenizer["root"]?.[0]).toEqual({
      match: String.raw`^#!.*$`,
      token: "comment",
    });
    expect(comments.patterns[0]).toEqual({
      name: "comment.line.shebang.vexa",
      match: "^#!.*$\\n?",
    });
  });

  it("enters type-parameter state before JSX for generic declarations", () => {
    const language = createPortableMonarchLanguage();
    const rootRules = language.tokenizer["root"] ?? [];
    const genericDeclarationIndex = rootRules.findIndex(
      (rule) => rule.match === String.raw`(?:fun|fn|func|function|val|var|let|const)(?=\s*<)`
    );
    const jsxTagIndex = rootRules.findIndex(
      (rule) => rule.match === String.raw`(?<![\w)\]])<\/?[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*`
    );

    expect(genericDeclarationIndex).toBeGreaterThan(-1);
    expect(genericDeclarationIndex).toBeLessThan(jsxTagIndex);
    expect(language.tokenizer["generic_declaration"]).toEqual([
      { match: String.raw`\s+`, token: "" },
      { match: String.raw`<`, token: "operator", switchTo: "@type_parameters" },
    ]);
    expect(language.tokenizer["type_parameters"]?.some(
      (rule) => rule.match === String.raw`>` && rule.next === "@pop"
    )).toBe(true);
  });

  it("closes multiline self-closing JSX elements without consuming a parent closing tag", () => {
    const vscodeGrammar = createVscodeTmLanguageGrammar();
    const repository = vscodeGrammar["repository"] as Record<string, unknown>;
    const pairedElement = repository["jsx-paired-element"] as {
      end: string;
      endCaptures: Record<string, { name: string }>;
    };

    expect(pairedElement.end).toBe("(/>)|(</)(\\2)\\s*(>)");
    expect(pairedElement.endCaptures["1"]?.name).toBe("punctuation.definition.tag.end.vexa");
    expect(pairedElement.endCaptures["3"]?.name).toBe("entity.name.tag.vexa");
  });
});
