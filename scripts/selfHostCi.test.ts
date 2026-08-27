import { describe, expect, it } from "../compiler/test/expect";
import { renderSelfHostSummary } from "./selfHostCi";

describe("self-hosting CI summary", () => {
  it("reports the JavaScript fixed-point stage", () => {
    const summary = renderSelfHostSummary([
      {
        name: "VexaScript JavaScript",
        elapsedMilliseconds: 2300,
        status: "passed",
        detail: "two generations are byte-identical (abc123)",
      },
    ], "Linux", "/tmp/vexa-self-host-ci");

    expect(summary).toContain("## VexaScript JavaScript self-hosting");
    expect(summary).toContain("| VexaScript JavaScript | 2.30 s | passed | two generations are byte-identical (abc123) |");
    expect(summary).toContain("Status: **passed** on Linux.");
  });
});
