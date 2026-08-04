import { describe, expect, it } from "../compiler/test/expect";
import { renderSelfHostSummary, type SelfHostCiTiming } from "./selfHostCi";

describe("self-hosting CI summary", () => {
  it("renders the compiler timing table for the GitHub Actions summary", () => {
    const timings: SelfHostCiTiming[] = [
      { host: "tsc", generationMilliseconds: 3000, repeatGenerationMilliseconds: null, linkMilliseconds: 4000, repeatLinkMilliseconds: null, result: "byte-identical" },
      { host: "VexaScript JS", generationMilliseconds: 2300, repeatGenerationMilliseconds: null, linkMilliseconds: 5000, repeatLinkMilliseconds: null, result: "byte-identical" },
      { host: "VexaScript C++", generationMilliseconds: 4500, repeatGenerationMilliseconds: 4600, linkMilliseconds: 6000, repeatLinkMilliseconds: 6100, result: "byte-identical" },
    ];
    const summary = renderSelfHostSummary([
      { name: "tsc", elapsedMilliseconds: 1200, status: "passed", detail: "TypeScript compiler check passed" },
      { name: "VexaScript JS", elapsedMilliseconds: 2300, status: "passed", detail: "two generations are byte-identical" },
      { name: "VexaScript C++", elapsedMilliseconds: 4500, status: "passed", detail: "two consecutive native generations are byte-identical" },
    ], "Linux", "/tmp/vexa-self-host-ci", timings);

    expect(summary).toContain("### C++ generation and link timing");
    expect(summary).toContain("| Host | Generation 1 | Generation 2 | Link 1 | Link 2 | Result |");
    expect(summary).toContain("| tsc | 3000 ms | — | 4000 ms | — | byte-identical |");
    expect(summary).toContain("| VexaScript JS | 2300 ms | — | 5000 ms | — | byte-identical |");
    expect(summary).toContain("| VexaScript C++ | 4500 ms | 4600 ms | 6000 ms | 6100 ms | byte-identical |");
    expect(summary).toContain("| Stage | Time | Status | Result |");
    expect(summary).toContain("| tsc | 1200 ms | passed | TypeScript compiler check passed |");
    expect(summary).toContain("| VexaScript JS | 2300 ms | passed | two generations are byte-identical |");
    expect(summary).toContain("| VexaScript C++ | 4500 ms | passed | two consecutive native generations are byte-identical |");
    expect(summary).toContain("Status: **passed** on `Linux`.");
  });
});
