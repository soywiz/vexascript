#pragma once

// Internal runtime category header. Include runtime.hpp instead.

inline Task<Value> readTextFile(std::u16string path) {
  auto operation = std::async(std::launch::async, [path = std::move(path)] {
    return readUtf8File(path);
  }).share();
  return Task<Value>::create([operation = std::move(operation)](auto resolve, auto reject) mutable {
    Runtime::enqueueIo([operation = std::move(operation), resolve, reject]() mutable {
      if (operation.wait_for(std::chrono::seconds(0)) != std::future_status::ready) return false;
      try {
        resolve(Runtime::string(operation.get()));
      } catch (const std::exception& error) {
        reject(Error(exceptionText(error)));
      }
      return true;
    });
  });
}

inline Task<void> writeTextFile(std::u16string path, std::u16string contents) {
  auto operation = std::async(std::launch::async, [path = std::move(path), contents = std::move(contents)] {
    writeUtf8File(path, contents);
  }).share();
  return Task<void>::create([operation = std::move(operation)](auto resolve, auto reject) mutable {
    Runtime::enqueueIo([operation = std::move(operation), resolve, reject]() mutable {
      if (operation.wait_for(std::chrono::seconds(0)) != std::future_status::ready) return false;
      try {
        operation.get();
        resolve();
      } catch (const std::exception& error) {
        reject(Error(exceptionText(error)));
      }
      return true;
    });
  });
}

inline Task<Value> nativeStatPath(std::u16string path) {
  return Task<Value>::create([path = std::move(path)](auto resolve, auto reject) mutable {
    const std::filesystem::path filePath(path);
    std::error_code error;
    const auto status = std::filesystem::status(filePath, error);
    if (error || !std::filesystem::exists(status)) {
      reject(Error(u"File does not exist: " + path));
      return;
    }
    const auto modified = std::filesystem::last_write_time(filePath, error);
    if (error) {
      reject(Error(u"Cannot read file modification time: " + path));
      return;
    }
    auto* value = Runtime::record();
    value->set(u"mtimeMs", Value(static_cast<double>(modified.time_since_epoch().count()) / 1'000'000.0));
    value->set(u"isFile", Value(std::filesystem::is_regular_file(status)));
    value->set(u"isDirectory", Value(std::filesystem::is_directory(status)));
    resolve(Value(value));
  });
}

inline Task<Value> nativeRealPath(std::u16string path) {
  return Task<Value>::create([path = std::move(path)](auto resolve, auto reject) mutable {
    std::error_code error;
    const auto resolvedPath = std::filesystem::canonical(std::filesystem::path(path), error);
    if (error) {
      reject(Error(u"Cannot resolve real path: " + path));
      return;
    }
    resolve(Runtime::string(resolvedPath.u16string()));
  });
}

inline Task<ArrayObject<Value>*> nativeReadDirectory(std::u16string path) {
  return Task<ArrayObject<Value>*>::create([path = std::move(path)](auto resolve, auto reject) mutable {
    try {
      auto* result = Runtime::array<Value>();
      for (const auto& entry : std::filesystem::directory_iterator(path)) {
        auto* value = Runtime::record();
        value->set(u"name", Value(Runtime::string(entry.path().filename().u16string())));
        value->set(u"isFile", Value(entry.is_regular_file()));
        value->set(u"isDirectory", Value(entry.is_directory()));
        result->append(Value(value));
      }
      resolve(result);
    } catch (const std::exception& error) {
      reject(Error(exceptionText(error)));
    }
  });
}

inline Task<void> nativeCreateDirectory(std::u16string path, bool recursive) {
  return Task<void>::create([path = std::move(path), recursive](auto resolve, auto reject) mutable {
    try {
      if (recursive) std::filesystem::create_directories(path);
      else std::filesystem::create_directory(path);
      resolve();
    } catch (const std::exception& error) {
      reject(Error(exceptionText(error)));
    }
  });
}

inline Task<void> nativeRemovePath(std::u16string path, bool recursive) {
  return Task<void>::create([path = std::move(path), recursive](auto resolve, auto reject) mutable {
    try {
      if (recursive) std::filesystem::remove_all(path);
      else std::filesystem::remove(path);
      resolve();
    } catch (const std::exception& error) {
      reject(Error(exceptionText(error)));
    }
  });
}

inline Task<void> nativeCopyFile(std::u16string source, std::u16string target) {
  return Task<void>::create([source = std::move(source), target = std::move(target)](auto resolve, auto reject) mutable {
    try {
      std::filesystem::copy_file(source, target, std::filesystem::copy_options::overwrite_existing);
      resolve();
    } catch (const std::exception& error) {
      reject(Error(exceptionText(error)));
    }
  });
}

#if defined(_WIN32)
inline std::u16string shellQuote(std::u16string_view value) {
  std::u16string quoted(u"\"");
  std::size_t backslashes = 0;
  for (const char16_t character : value) {
    if (character == u'\\') {
      ++backslashes;
      continue;
    }
    if (character == u'"') {
      quoted.append(backslashes * 2 + 1, u'\\');
      quoted += character;
      backslashes = 0;
      continue;
    }
    quoted.append(backslashes, u'\\');
    backslashes = 0;
    quoted += character;
  }
  quoted.append(backslashes * 2, u'\\');
  quoted += u'"';
  return quoted;
}
#else
inline std::u16string shellQuote(std::u16string_view value) {
  std::u16string quoted(u"'");
  for (const char16_t character : value) {
    if (character == u'\'') quoted += u"'\\''";
    else quoted += character;
  }
  quoted += u'\'';
  return quoted;
}
#endif

inline Task<Value> nativeRunCommandCapture(
    std::u16string command,
    ArrayObject<std::u16string>* arguments,
    std::u16string workingDirectory) {
  std::vector<std::u16string> copiedArguments;
  copiedArguments.reserve(arguments ? arguments->size() : 0);
  if (arguments) {
    for (std::size_t index = 0; index < arguments->size(); ++index) {
      copiedArguments.push_back(arguments->get(index));
    }
  }
  auto operation = std::async(std::launch::async, [
      command = std::move(command),
      arguments = std::move(copiedArguments),
      workingDirectory = std::move(workingDirectory)] {
    std::u16string shellCommand;
#if defined(_WIN32)
    if (!workingDirectory.empty()) shellCommand = u"cd /d " + shellQuote(workingDirectory) + u" && ";
#else
    if (!workingDirectory.empty()) shellCommand = u"cd " + shellQuote(workingDirectory) + u" && ";
#endif
    shellCommand += shellQuote(command);
    for (const auto& argument : arguments) shellCommand += u" " + shellQuote(argument);
    shellCommand += u" 2>&1";
    return runShellCommand(shellCommand);
  }).share();
  return Task<Value>::create([operation = std::move(operation)](auto resolve, auto reject) mutable {
    Runtime::enqueueIo([operation = std::move(operation), resolve, reject]() mutable {
      if (operation.wait_for(std::chrono::seconds(0)) != std::future_status::ready) return false;
      try {
        auto result = operation.get();
        auto* value = Runtime::record();
        value->set(u"code", Value(static_cast<double>(result.code)));
        value->set(u"stdout", Runtime::string(result.output));
        value->set(u"stderr", Runtime::string(u""));
        resolve(Value(value));
      } catch (const std::exception& error) {
        reject(Error(exceptionText(error)));
      }
      return true;
    });
  });
}

template <typename T>
inline void nativeRunTask(const Task<T>& task) {
  static_cast<void>(task.get());
}

inline void nativeRunTask(const Task<void>& task) {
  task.get();
}

inline std::u16string nativeEnvironmentVariable(const std::u16string& name) {
  const auto value = environmentVariable(name);
  return value.value_or(u"");
}

inline std::u16string nativeRuntimeRoot() {
  std::error_code error;
  auto path = std::filesystem::path(__FILE__).parent_path().parent_path();
  if (path.is_relative()) path = std::filesystem::absolute(path, error);
  return path.u16string();
}

inline Task<Value> dynamicImportUnavailable(std::u16string specifier) {
  return Task<Value>::create([specifier = std::move(specifier)](auto, auto reject) mutable {
    reject(Error(u"Dynamic import is not available in native C++: " + specifier));
  });
}

class Process final {
 public:
  Process(
      const std::vector<std::u16string>& arguments,
      const std::vector<std::pair<std::u16string, std::u16string>>& environment)
      : argv(Runtime::array<std::u16string>()), env(Runtime::record()), platform(Runtime::string(
#if defined(_WIN32)
          u"win32"
#elif defined(__APPLE__)
          u"darwin"
#else
          u"linux"
#endif
      ).stringObject()), arch(Runtime::string(
#if defined(__aarch64__) || defined(_M_ARM64)
          u"aarch64"
#elif defined(__x86_64__) || defined(_M_X64)
          u"x86_64"
#elif defined(__i386__) || defined(_M_IX86)
          u"x86"
#else
          u"unknown"
#endif
      ).stringObject()) {
    const std::u16string executable = arguments.empty() ? u"vexa" : arguments.front();
    argv->append(executable);
    argv->append(executable);
    for (std::size_t index = 1; index < arguments.size(); ++index) {
      argv->append(arguments[index]);
    }
    for (const auto& [name, value] : environment) {
      env->set(name, Runtime::string(value));
    }
  }

  std::u16string cwd() const { return currentPathText(); }
  [[noreturn]] void exit(double code = 0) const {
    std::cout.flush();
    std::cerr.flush();
    std::_Exit(static_cast<int>(code));
  }

  cppgc::Persistent<ArrayObject<std::u16string>> argv;
  cppgc::Persistent<RecordObject> env;
  Value platform;
  Value arch;
  double exitCode = 0;
};

inline Process* process = nullptr;

inline ArrayObject<std::u16string>* commandLineArguments() {
  auto* result = Runtime::array<std::u16string>();
  if (!process || !process->argv) return result;
  for (std::size_t index = 2; index < process->argv->size(); ++index) {
    result->append(process->argv->get(index));
  }
  return result;
}

template <typename T>
inline std::u16string toString(const Task<T>&) {
  return u"[object Promise]";
}

template <typename T>
inline T defaultValue() {
  return T{};
}
