#pragma once

#include <charconv>
#include <ctime>
#include <optional>
#include <regex>
#include <stdexcept>
#include <string>
#include <string_view>
#include <type_traits>
#include <utility>
#include <vector>

namespace vexa {

std::u16string utf8ToUtf16(std::string_view input);
std::string utf16ToUtf8(std::u16string_view input);
std::runtime_error runtimeError(std::u16string_view message);
std::u16string formatNumberText(double value, int precision = 15);
std::u16string formatFixedText(double value, int digits);

template <typename Integer>
  requires std::is_integral_v<Integer>
inline std::u16string formatIntegerText(Integer value) {
  char buffer[32];
  const auto [end, error] = std::to_chars(buffer, buffer + sizeof(buffer), value);
  if (error != std::errc()) return {};
  return std::u16string(buffer, end);
}

std::u16string formatIsoDateText(const std::tm& parts, int milliseconds);

class Utf16Regex final {
 public:
  Utf16Regex(std::u16string_view pattern, bool caseInsensitive);

  bool test(std::u16string_view value) const;
  std::optional<std::vector<std::u16string>> exec(std::u16string_view value) const;
  double search(std::u16string_view value) const;
  std::vector<std::vector<std::u16string>> execAll(std::u16string_view value) const;
  std::u16string replace(
      std::u16string_view value,
      std::u16string_view replacement) const;
  std::vector<std::u16string> split(std::u16string_view value) const;

 private:
  static std::regex compile(std::u16string_view pattern, bool caseInsensitive);

  std::regex expression_;
};

std::u16string exceptionText(const std::exception& error);
std::u16string readUtf8File(std::u16string_view path);
void writeUtf8File(std::u16string_view path, std::u16string_view contents);

struct Utf16CommandResult final {
  int code;
  std::u16string output;
};

Utf16CommandResult runShellCommand(std::u16string_view command);
std::optional<std::u16string> environmentVariable(std::u16string_view name);
std::optional<std::size_t> initialHeapSizeBytes();
std::vector<std::u16string> platformArguments(int argc, char** arguments);
std::vector<std::pair<std::u16string, std::u16string>> platformEnvironment();
std::u16string currentPathText();

}  // namespace vexa
