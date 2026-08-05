import { describe, expect, it } from "../compiler/test/expect";
import {
  renderSelfHostSummary,
  verifyCppSelfHostContents,
  type SelfHostCiTiming,
} from "./selfHostCi";

describe("self-hosting CI summary", () => {
  it("renders the compiler timing table for the GitHub Actions summary", () => {
    const timings: SelfHostCiTiming[] = [
      { host: "tsc", generationMilliseconds: 3000, repeatGenerationMilliseconds: null, result: "matches VexaScript JS" },
      { host: "VexaScript JS", generationMilliseconds: 2300, repeatGenerationMilliseconds: null, result: "matches tsc" },
      { host: "VexaScript C++", generationMilliseconds: 4500, repeatGenerationMilliseconds: 4600, result: "native fixed point" },
    ];
    const summary = renderSelfHostSummary([
      { name: "tsc", elapsedMilliseconds: 1200, status: "passed", detail: "TypeScript compiler check passed" },
      { name: "VexaScript JS", elapsedMilliseconds: 2300, status: "passed", detail: "two generations are byte-identical" },
      { name: "VexaScript C++", elapsedMilliseconds: 4500, status: "passed", detail: "two consecutive native generations are byte-identical" },
    ], "Linux", "/tmp/vexa-self-host-ci", timings);

    expect(summary).toContain("### C++ generation timing");
    expect(summary).toContain("| Host | Generation 1 | Generation 2 | Result |");
    expect(summary).toContain("| tsc | 3.00 s | — | matches VexaScript JS |");
    expect(summary).toContain("| VexaScript JS | 2.30 s | — | matches tsc |");
    expect(summary).toContain("| VexaScript C++ | 4.50 s | 4.60 s | native fixed point |");
    expect(summary).toContain("Only `vexa cpp build` is timed");
    expect(summary).toContain("| Stage | Wall time | Status | Result |");
    expect(summary).toContain("| tsc | 1.20 s | passed | TypeScript compiler check passed |");
    expect(summary).toContain("| VexaScript JS | 2.30 s | passed | two generations are byte-identical |");
    expect(summary).toContain("| VexaScript C++ | 4.50 s | passed | two consecutive native generations are byte-identical |");
    expect(summary).toContain("Status: **passed** on `Linux`.");
  });
});

describe("C++ self-hosting fixed point", () => {
  it("allows the bootstrap and native fixed-point outputs to differ", () => {
    const hashes = verifyCppSelfHostContents(
      "bootstrap output",
      "bootstrap output",
      "native output",
      "native output",
    );

    expect(hashes.bootstrapHash).not.toBe(hashes.nativeHash);
  });

  it("requires the TypeScript and JavaScript hosts to emit identical C++", () => {
    expect(() => verifyCppSelfHostContents(
      "tsc output",
      "JavaScript output",
      "native output",
      "native output",
    )).toThrow("TypeScript and JavaScript host C++ outputs are not byte-identical");
  });

  it("requires two consecutive native hosts to emit identical C++", () => {
    expect(() => verifyCppSelfHostContents(
      "bootstrap output",
      "bootstrap output",
      "native generation 1",
      "native generation 2",
    )).toThrow("consecutive native C++ outputs are not byte-identical");
  });
});
