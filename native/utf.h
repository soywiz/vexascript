#pragma once

#include <algorithm>
#include <charconv>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <ctime>
#include <filesystem>
#include <fstream>
#include <iterator>
#include <iomanip>
#include <limits>
#include <optional>
#include <regex>
#include <sstream>
#include <string>
#include <string_view>
#include <stdexcept>
#include <type_traits>
#include <vector>
#include <utility>

#if !defined(_WIN32)
#include <sys/wait.h>
extern char** environ;
#endif

namespace vexa {

inline std::u16string utf8ToUtf16(std::string_view input) {
  std::u16string output;
  output.reserve(input.size());
  for (std::size_t index = 0; index < input.size();) {
    const auto first = static_cast<unsigned char>(input[index]);
    std::uint32_t codePoint = 0xfffd;
    std::size_t length = 1;
    if (first <= 0x7f) {
      codePoint = first;
    } else if (first >= 0xc2 && first <= 0xdf && index + 1 < input.size()) {
      const auto second = static_cast<unsigned char>(input[index + 1]);
      if ((second & 0xc0) == 0x80) {
        codePoint = ((first & 0x1f) << 6) | (second & 0x3f);
        length = 2;
      }
    } else if (first >= 0xe0 && first <= 0xef && index + 2 < input.size()) {
      const auto second = static_cast<unsigned char>(input[index + 1]);
      const auto third = static_cast<unsigned char>(input[index + 2]);
      if ((second & 0xc0) == 0x80 && (third & 0xc0) == 0x80 &&
          !(first == 0xe0 && second < 0xa0)) {
        codePoint = ((first & 0x0f) << 12) | ((second & 0x3f) << 6) | (third & 0x3f);
        length = 3;
      }
    } else if (first >= 0xf0 && first <= 0xf4 && index + 3 < input.size()) {
      const auto second = static_cast<unsigned char>(input[index + 1]);
      const auto third = static_cast<unsigned char>(input[index + 2]);
      const auto fourth = static_cast<unsigned char>(input[index + 3]);
      if ((second & 0xc0) == 0x80 && (third & 0xc0) == 0x80 && (fourth & 0xc0) == 0x80 &&
          !(first == 0xf0 && second < 0x90) && !(first == 0xf4 && second >= 0x90)) {
        codePoint = ((first & 0x07) << 18) | ((second & 0x3f) << 12) |
            ((third & 0x3f) << 6) | (fourth & 0x3f);
        length = 4;
      }
    }
    index += length;
    if (codePoint <= 0xffff) {
      output.push_back(static_cast<char16_t>(codePoint));
    } else {
      codePoint -= 0x10000;
      output.push_back(static_cast<char16_t>(0xd800 + (codePoint >> 10)));
      output.push_back(static_cast<char16_t>(0xdc00 + (codePoint & 0x3ff)));
    }
  }
  return output;
}

inline std::string utf16ToUtf8(std::u16string_view input) {
  std::string output;
  output.reserve(input.size());
  for (std::size_t index = 0; index < input.size(); ++index) {
    std::uint32_t codePoint = input[index];
    if (codePoint >= 0xd800 && codePoint <= 0xdbff && index + 1 < input.size()) {
      const std::uint32_t low = input[index + 1];
      if (low >= 0xdc00 && low <= 0xdfff) {
        codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (low - 0xdc00);
        ++index;
      }
    }
    if (codePoint <= 0x7f) {
      output.push_back(static_cast<char>(codePoint));
    } else if (codePoint <= 0x7ff) {
      output.push_back(static_cast<char>(0xc0 | (codePoint >> 6)));
      output.push_back(static_cast<char>(0x80 | (codePoint & 0x3f)));
    } else if (codePoint <= 0xffff) {
      output.push_back(static_cast<char>(0xe0 | (codePoint >> 12)));
      output.push_back(static_cast<char>(0x80 | ((codePoint >> 6) & 0x3f)));
      output.push_back(static_cast<char>(0x80 | (codePoint & 0x3f)));
    } else {
      output.push_back(static_cast<char>(0xf0 | (codePoint >> 18)));
      output.push_back(static_cast<char>(0x80 | ((codePoint >> 12) & 0x3f)));
      output.push_back(static_cast<char>(0x80 | ((codePoint >> 6) & 0x3f)));
      output.push_back(static_cast<char>(0x80 | (codePoint & 0x3f)));
    }
  }
  return output;
}

inline std::runtime_error runtimeError(std::u16string_view message) {
  return std::runtime_error(utf16ToUtf8(message));
}

inline std::u16string formatNumberText(double value, int precision = 15) {
  char buffer[64];
  const auto [end, error] = std::to_chars(
      buffer,
      buffer + sizeof(buffer),
      value,
      std::chars_format::general,
      precision);
  if (error != std::errc()) return {};
  return std::u16string(buffer, end);
}

inline std::u16string formatFixedText(double value, int digits) {
  char buffer[128];
  const auto [end, error] = std::to_chars(
      buffer,
      buffer + sizeof(buffer),
      value,
      std::chars_format::fixed,
      digits);
  if (error != std::errc()) return {};
  return std::u16string(buffer, end);
}

template <typename Integer>
  requires std::is_integral_v<Integer>
inline std::u16string formatIntegerText(Integer value) {
  char buffer[32];
  const auto [end, error] = std::to_chars(buffer, buffer + sizeof(buffer), value);
  if (error != std::errc()) return {};
  return std::u16string(buffer, end);
}

inline std::u16string formatIsoDateText(const std::tm& parts, int milliseconds) {
  std::ostringstream output;
  output << std::setfill('0')
         << std::setw(4) << parts.tm_year + 1900 << '-'
         << std::setw(2) << parts.tm_mon + 1 << '-'
         << std::setw(2) << parts.tm_mday << 'T'
         << std::setw(2) << parts.tm_hour << ':'
         << std::setw(2) << parts.tm_min << ':'
         << std::setw(2) << parts.tm_sec << '.'
         << std::setw(3) << milliseconds << 'Z';
  return utf8ToUtf16(output.str());
}

class Utf16Regex final {
 public:
  Utf16Regex(std::u16string_view pattern, bool caseInsensitive)
      : expression_(utf16ToUtf8(pattern), caseInsensitive
          ? std::regex_constants::ECMAScript | std::regex_constants::icase
          : std::regex_constants::ECMAScript) {}

  bool test(std::u16string_view value) const {
    return std::regex_search(utf16ToUtf8(value), expression_);
  }

  std::optional<std::vector<std::u16string>> exec(std::u16string_view value) const {
    const auto input = utf16ToUtf8(value);
    std::smatch match;
    if (!std::regex_search(input, match, expression_)) return std::nullopt;
    std::vector<std::u16string> captures;
    captures.reserve(match.size());
    for (const auto& capture : match) captures.push_back(utf8ToUtf16(capture.str()));
    return captures;
  }

  std::u16string replace(std::u16string_view value, std::u16string_view replacement) const {
    return utf8ToUtf16(std::regex_replace(
        utf16ToUtf8(value), expression_, utf16ToUtf8(replacement)));
  }

  std::vector<std::u16string> split(std::u16string_view value) const {
    const auto input = utf16ToUtf8(value);
    std::vector<std::u16string> result;
    for (std::sregex_token_iterator iterator(input.begin(), input.end(), expression_, -1), end;
         iterator != end;
         ++iterator) {
      result.push_back(utf8ToUtf16(iterator->str()));
    }
    return result;
  }

 private:
  std::regex expression_;
};

inline std::u16string exceptionText(const std::exception& error) {
  return utf8ToUtf16(error.what());
}

inline std::u16string readUtf8File(std::u16string_view path) {
  std::ifstream input(std::filesystem::path(path), std::ios::binary);
  if (!input) throw runtimeError(u"Cannot open file: " + std::u16string(path));
  const std::string contents{
      std::istreambuf_iterator<char>(input), std::istreambuf_iterator<char>()};
  if (!input.good() && !input.eof()) {
    throw runtimeError(u"Cannot read file: " + std::u16string(path));
  }
  return utf8ToUtf16(contents);
}

inline void writeUtf8File(std::u16string_view path, std::u16string_view contents) {
  std::ofstream output(
      std::filesystem::path(path), std::ios::binary | std::ios::trunc);
  if (!output) throw runtimeError(u"Cannot open file for writing: " + std::u16string(path));
  const auto encoded = utf16ToUtf8(contents);
  output.write(encoded.data(), static_cast<std::streamsize>(encoded.size()));
  if (!output) throw runtimeError(u"Cannot write file: " + std::u16string(path));
}

struct Utf16CommandResult final {
  int code;
  std::u16string output;
};

inline Utf16CommandResult runShellCommand(std::u16string_view command) {
  const auto encoded = utf16ToUtf8(command);
#if defined(_WIN32)
  FILE* pipe = _popen(encoded.c_str(), "r");
#else
  FILE* pipe = popen(encoded.c_str(), "r");
#endif
  if (!pipe) throw runtimeError(u"Cannot start command: " + std::u16string(command));
  std::string output;
  char buffer[4096];
  while (std::fgets(buffer, sizeof(buffer), pipe)) output += buffer;
#if defined(_WIN32)
  const int status = _pclose(pipe);
  const int code = status;
#else
  const int status = pclose(pipe);
  const int code = WIFEXITED(status) ? WEXITSTATUS(status) : status;
#endif
  return Utf16CommandResult{code, utf8ToUtf16(output)};
}

inline std::optional<std::u16string> environmentVariable(std::u16string_view name) {
  const auto encodedName = utf16ToUtf8(name);
  const char* value = std::getenv(encodedName.c_str());
  return value ? std::optional<std::u16string>(utf8ToUtf16(value)) : std::nullopt;
}

inline std::optional<std::size_t> initialHeapSizeBytes() {
  const char* megabytes = std::getenv("VEXA_NATIVE_INITIAL_HEAP_MB");
  if (!megabytes) return std::nullopt;
  const auto parsed = std::strtoull(megabytes, nullptr, 10);
  if (parsed == 0 || parsed > std::numeric_limits<std::size_t>::max() / (1024 * 1024)) {
    return std::nullopt;
  }
  return static_cast<std::size_t>(parsed) * 1024 * 1024;
}

inline std::vector<std::u16string> platformArguments(int argc, char** arguments) {
  std::vector<std::u16string> result;
  result.reserve(static_cast<std::size_t>(std::max(argc, 0)));
  for (int index = 0; index < argc; ++index) {
    result.push_back(utf8ToUtf16(arguments[index] ? arguments[index] : ""));
  }
  return result;
}

inline std::vector<std::pair<std::u16string, std::u16string>> platformEnvironment() {
  std::vector<std::pair<std::u16string, std::u16string>> result;
#if defined(_WIN32)
  char** environment = _environ;
#else
  char** environment = ::environ;
#endif
  if (!environment) return result;
  for (char** entry = environment; *entry; ++entry) {
    const auto item = utf8ToUtf16(*entry);
    const auto separator = item.find(u'=');
    if (separator == std::u16string::npos) continue;
    result.emplace_back(item.substr(0, separator), item.substr(separator + 1));
  }
  return result;
}

inline std::u16string currentPathText() {
  return std::filesystem::current_path().u16string();
}

}  // namespace vexa
