#pragma once

// Internal runtime category header. Include runtime.hpp instead.

Task<Value> readTextFile(std::u16string path);

Task<void> writeTextFile(std::u16string path, std::u16string contents);

Task<Value> nativeStatPath(std::u16string path);

Task<Value> nativeRealPath(std::u16string path);

Task<ArrayObject<Value>*> nativeReadDirectory(std::u16string path);

Task<void> nativeCreateDirectory(std::u16string path, bool recursive);

Task<void> nativeRemovePath(std::u16string path, bool recursive);

Task<void> nativeCopyFile(std::u16string source, std::u16string target);

std::u16string shellQuote(std::u16string_view value);

Task<Value> nativeRunCommandCapture(
    std::u16string command,
    ArrayObject<std::u16string>* arguments,
    std::u16string workingDirectory);

template <typename T>
inline void nativeRunTask(const Task<T>& task) {
  static_cast<void>(task.get());
}

void nativeRunTask(const Task<void>& task);

std::u16string nativeEnvironmentVariable(const std::u16string& name);

std::u16string nativeRuntimeRoot();

Task<Value> dynamicImportUnavailable(std::u16string specifier);

class Process final {
 public:
  Process(
      const std::vector<std::u16string>& arguments,
      const std::vector<std::pair<std::u16string, std::u16string>>& environment);

  std::u16string cwd() const;
  [[noreturn]] void exit(double code = 0) const;

  cppgc::Persistent<ArrayObject<std::u16string>> argv;
  cppgc::Persistent<RecordObject> env;
  Value platform;
  Value arch;
  double exitCode = 0;
};

extern Process* process;

ArrayObject<std::u16string>* commandLineArguments();

template <typename T>
inline std::u16string toString(const Task<T>&) {
  return u"[object Promise]";
}

template <typename T>
inline T defaultValue() {
  return T{};
}
