import { test, expect } from "@playwright/test";
import {
  getEditorPosition,
  getHoverText,
  getMarkerMessages,
  gotoMonaco,
  setEditorPosition,
  setEditorValue,
} from "./monacoHarness";

test.describe("monaco browser integration", () => {
  test("go to definition resolves instance members like radius", async ({ page }) => {
    await gotoMonaco(page);
    await setEditorValue(
      page,
      [
        "class Circle {",
        "  radius: number",
        "}",
        "const circle: Circle = new Circle()",
        "circle.radius = 4",
        "",
      ].join("\n")
    );

    await setEditorPosition(page, { lineNumber: 5, column: 8 });
    await page.keyboard.press("F12");

    await expect.poll(async () => getEditorPosition(page)).toEqual({
      lineNumber: 2,
      column: 3,
    });
  });

  test("hover returns member info for instance fields", async ({ page }) => {
    await gotoMonaco(page);
    await setEditorValue(
      page,
      [
        "class Circle {",
        "  radius: number",
        "}",
        "const circle: Circle = new Circle()",
        "circle.radius = 4",
        "",
      ].join("\n")
    );

    const hoverContents = await getHoverText(page, { lineNumber: 5, column: 8 });
    expect(hoverContents).toContain("member Circle.radius: number");
  });

  test("diagnostics surface unknown member errors", async ({ page }) => {
    await gotoMonaco(page);
    await setEditorValue(
      page,
      [
        "class Circle {",
        "  radius: number",
        "}",
        "const circle: Circle = new Circle()",
        "circle.radius2 = 4",
        "",
      ].join("\n")
    );

    await expect.poll(async () => getMarkerMessages(page)).toContain(
      "Property 'radius2' does not exist on type 'Circle'"
    );
  });
});
