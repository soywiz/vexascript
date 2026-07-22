import {
  describe,
  expect,
  it,
  join,
  mkdtemp,
  rm,
  tmpdir,
  writeFile,
} from "../compiler/test/expect";
import { compileNativeExecutable } from "./nativeBuild";
import { runCommandCapture } from "./io";

const GC_CYCLE_PROGRAM = `#include "runtime.cpp"

class FinalizationProbe final
    : public cppgc::GarbageCollected<FinalizationProbe>,
      public vexa::BaseObject {
 public:
  ~FinalizationProbe() { ++finalized; }
  const void* dynamicTypeToken() const override { return vexa::nativeTypeToken<FinalizationProbe>(); }
  void* dynamicCast(const void* type) override {
    return type == vexa::nativeTypeToken<FinalizationProbe>() ? this : nullptr;
  }
  std::u16string dynamicToString() const override { return u"probe"; }
  void Trace(cppgc::Visitor* visitor) const override { vexa::BaseObject::Trace(visitor); }
  static inline int finalized = 0;
};

#if defined(_MSC_VER)
#define VEXA_NOINLINE __declspec(noinline)
#else
#define VEXA_NOINLINE __attribute__((noinline))
#endif

VEXA_NOINLINE void createCycle(vexa::Runtime& runtime) {
  auto* record = runtime.record();
  cppgc::Persistent<vexa::RecordObject> root(record);
  auto* array = runtime.array<vexa::Value>();
  auto* probe = runtime.make<FinalizationProbe>();
  record->set(u"array", vexa::Value(array));
  record->set(u"probe", vexa::Value(probe));
  array->append(vexa::Value(record));
  auto* closure = vexa::makeFunction<vexa::Value>(
      runtime,
      [record]() { return vexa::Value(record); },
      {vexa::Value(record)});
  record->set(u"closure", vexa::Value(closure));
}

int main() {
  vexa::Runtime runtime;
  createCycle(runtime);
  runtime.heap().ForceGarbageCollectionSlow(
      "native GC cycle test", "verify traced closure captures",
      cppgc::Heap::StackState::kNoHeapPointers);
  std::cout << "finalized " << FinalizationProbe::finalized << std::endl;
  return FinalizationProbe::finalized == 1 ? 0 : 1;
}
`;

describe("native Oilpan cycles", () => {
  it("collects record, array, object, and closure cycles after their last root", async () => {
    const outputRoot = await mkdtemp(join(tmpdir(), "vexa-native-gc-cycle-"));
    const cppPath = join(outputRoot, "cycle.cpp");
    const executablePath = join(outputRoot, "cycle");
    try {
      await writeFile(cppPath, GC_CYCLE_PROGRAM, "utf8");
      await compileNativeExecutable(cppPath, executablePath);
      const result = await runCommandCapture(executablePath, []);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout).toBe("finalized 1\n");
    } finally {
      await rm(outputRoot, { recursive: true, force: true });
    }
  });
});
