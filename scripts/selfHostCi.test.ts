import { describe, expect, it } from "../compiler/test/expect";
import { renderSelfHostSummary } from "./selfHostCi";

describe("self-hosting CI summary", () => {
  it("renders the compiler timing table for the GitHub Actions summary", () => {
    const summary = renderSelfHostSummary([
      { name: "tsc", elapsedMilliseconds: 1200, status: "passed", detail: "TypeScript compiler check passed" },
      { name: "VexaScript JS", elapsedMilliseconds: 2300, status: "passed", detail: "two generations are byte-identical" },
      { name: "VexaScript C++", elapsedMilliseconds: 4500, status: "failed", detail: "C++ output differs" },
    ], "Linux", "/tmp/vexa-self-host-ci");

    expect(summary).toContain("| Stage | Time | Status | Result |");
    expect(summary).toContain("| tsc | 1200 ms | passed | TypeScript compiler check passed |");
    expect(summary).toContain("| VexaScript JS | 2300 ms | passed | two generations are byte-identical |");
    expect(summary).toContain("| VexaScript C++ | 4500 ms | failed | C++ output differs |");
    expect(summary).toContain("Status: **failed** on `Linux`.");
  });
});
