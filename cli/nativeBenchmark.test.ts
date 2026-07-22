import { describe, expect, it } from "../compiler/test/expect";
import { formatNativeBenchmarkMarkdown, median, NATIVE_BENCHMARK_SOURCE } from "./nativeBenchmark";

describe("native benchmark", () => {
  it("covers the runtime workloads tracked by production hardening", () => {
    expect(NATIVE_BENCHMARK_SOURCE).toContain("values.push");
    expect(NATIVE_BENCHMARK_SOURCE).toContain("bigintValue * 33n");
    expect(NATIVE_BENCHMARK_SOURCE).toContain("setTimeout");
    expect(NATIVE_BENCHMARK_SOURCE).toContain("performance.now()");
  });

  it("formats stable measurements without imposing machine-specific thresholds", () => {
    expect(median([9, 1, 5])).toBe(5);
    expect(median([8, 2])).toBe(5);
    const markdown = formatNativeBenchmarkMarkdown({
      platform: "test",
      architecture: "arch",
      compileMilliseconds: 10,
      binaryBytes: 20,
      startupMedianMilliseconds: 1,
      workloadMedianMilliseconds: 2,
      gcStressMilliseconds: 3,
      arrayMilliseconds: 4,
      bigintMilliseconds: 5,
      eventLoopMilliseconds: 6,
      nodeStartupMedianMilliseconds: 7,
      nodeWorkloadMedianMilliseconds: 8,
      nodeArrayMilliseconds: 9,
      nodeBigintMilliseconds: 10,
      nodeEventLoopMilliseconds: 11,
    });
    expect(markdown).toContain("Platform: test/arch");
    expect(markdown).toContain("| Binary size | 20.00 | bytes |");
    expect(markdown).toContain("| GC-stress workload | 3.00 | ms |");
    expect(markdown).toContain("| Node workload median | 8.00 | ms |");
    expect(markdown).toContain("| Native workload speedup | 4.00 | x |");
  });
});
