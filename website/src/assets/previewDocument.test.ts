import { describe, expect, it } from "../../../compiler/test/expect";
import { buildPreviewDocument } from "./previewDocument";

describe("website preview document", () => {
  it("loads user code through a blob-backed module after installing error handlers", () => {
    const html = buildPreviewDocument("const broken =", "preview-123");

    expect(html).toContain('const userCode = "const broken =";');
    expect(html).toContain('const blob = new Blob([userCode], { type: "text/javascript" });');
    expect(html).toContain("await import(blobUrl);");
    expect(html).toContain("window.onerror = (message, _source, _line, _column, error) => {");
    expect(html).toContain("window.onunhandledrejection = (event) => {");
  });
});
