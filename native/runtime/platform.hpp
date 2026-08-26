#pragma once

// Internal runtime category header. Include runtime.hpp instead.

class LibraryOpen final {
 public:
  static void* open(std::initializer_list<std::string_view> paths) {
    static std::mutex mutex;
    static std::unordered_map<std::string, void*> handles;
    std::lock_guard<std::mutex> lock(mutex);
    std::string failures;
    for (const auto pathView : paths) {
      std::string path(pathView);
      if (path.empty()) continue;
#if defined(__APPLE__)
      if (path.ends_with(".framework")) {
        const auto slash = path.find_last_of('/');
        const auto nameStart = slash == std::string::npos ? 0 : slash + 1;
        const auto nameLength = path.size() - nameStart - std::string_view(".framework").size();
        path += "/" + path.substr(nameStart, nameLength);
      }
#endif
      if (const auto cached = handles.find(path); cached != handles.end()) return cached->second;
#if defined(_WIN32)
      void* handle = reinterpret_cast<void*>(LoadLibraryA(path.c_str()));
      if (!handle) failures += path + "; ";
#else
      void* handle = dlopen(path.c_str(), RTLD_NOW | RTLD_LOCAL);
      if (!handle) {
        const char* error = dlerror();
        failures += path + ": " + std::string(error ? error : "unknown error") + "; ";
      }
#endif
      if (handle) {
        handles.emplace(path, handle);
        return handle;
      }
    }
    throw std::runtime_error("Unable to open native library: " + failures);
  }

  static void* symbol(std::initializer_list<std::string_view> paths, std::string_view name) {
    void* handle = open(paths);
#if defined(_WIN32)
    void* result = reinterpret_cast<void*>(GetProcAddress(
        static_cast<HMODULE>(handle), std::string(name).c_str()));
#else
    void* result = dlsym(handle, std::string(name).c_str());
#endif
    if (!result) throw std::runtime_error("Unable to load native symbol: " + std::string(name));
    return result;
  }
};

inline std::optional<std::size_t> propertyIndex(std::u16string_view key) {
  if (key.empty()) return std::nullopt;
  std::size_t result = 0;
  for (const char16_t codeUnit : key) {
    if (codeUnit < u'0' || codeUnit > u'9') return std::nullopt;
    const auto digit = static_cast<std::size_t>(codeUnit - u'0');
    if (result > (std::numeric_limits<std::size_t>::max() - digit) / 10) return std::nullopt;
    result = result * 10 + digit;
  }
  return result;
}

class OilpanPlatform final : public cppgc::Platform {
 public:
  cppgc::PageAllocator* GetPageAllocator() override { return &allocator_; }

  double MonotonicallyIncreasingTime() override {
    using Seconds = std::chrono::duration<double>;
    return Seconds(std::chrono::steady_clock::now().time_since_epoch()).count();
  }

 private:
  v8::base::PageAllocator allocator_;
};

inline double performanceNow() {
  static const auto origin = std::chrono::steady_clock::now();
  return std::chrono::duration<double, std::milli>(
      std::chrono::steady_clock::now() - origin).count();
}

inline std::u16string vexaRuntimeName() { return u"native"; }

inline std::u16string vexaPlatformName() {
#if defined(_WIN32)
  return u"windows";
#elif defined(__APPLE__)
  return u"macos";
#elif defined(__linux__)
  return u"linux";
#elif defined(__FreeBSD__)
  return u"freebsd";
#else
  return u"unknown";
#endif
}
