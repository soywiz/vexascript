#pragma once

// Internal runtime category header. Include runtime.hpp instead.

class LibraryOpen final {
 public:
  static void* open(std::initializer_list<std::string_view> paths);

  static void* symbol(std::initializer_list<std::string_view> paths, std::string_view name);
};

std::optional<std::size_t> propertyIndex(std::u16string_view key);

class OilpanPlatform final : public cppgc::Platform {
 public:
  cppgc::PageAllocator* GetPageAllocator() override;

  double MonotonicallyIncreasingTime() override;

 private:
  v8::base::PageAllocator allocator_;
};

double performanceNow();

std::u16string vexaRuntimeName();

std::u16string vexaPlatformName();
