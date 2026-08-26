#include "runtime.hpp"

namespace vexa {

bool regexTest(const RegExp& expression, const Value& value) {
  return expression.test(value.isString() ? value.string() : u"");
}

std::u16string stringReplace(const std::u16string& value, const RegExp& expression, const Value& replacement) {
  return expression.replace(value, toString(replacement));
}

std::u16string stringReplace(const std::u16string& value, const RegExp& expression, const std::u16string& replacement) {
  return expression.replace(value, replacement);
}

std::u16string stringReplace(const std::u16string& value, const std::u16string& search, const std::u16string& replacement) {
  const auto offset = value.find(search);
  if (offset == std::u16string::npos) return value;
  auto result = value;
  result.replace(offset, search.size(), replacement);
  return result;
}

std::u16string stringReplace(const Value& value, const Value& search, const Value& replacement) {
  return stringReplace(requireString(value), requireString(search), requireString(replacement));
}

std::u16string stringReplace(const Value& value, const RegExp& expression, const Value& replacement) {
  return expression.replace(requireString(value), requireString(replacement));
}

std::u16string stringReplace(const Value& value, const RegExp& expression, const std::u16string& replacement) {
  return expression.replace(toString(value), replacement);
}

std::u16string stringReplace(const std::u16string& value, const std::u16string& search, const Value& replacement) {
  return stringReplace(value, search, requireString(replacement));
}

std::u16string stringReplace(const Value& value, const std::u16string& search, const std::u16string& replacement) {
  return stringReplace(requireString(value), search, replacement);
}

std::u16string stringReplaceAll(
    const std::u16string& value,
    const std::u16string& search,
    const std::u16string& replacement) {
  std::u16string result;
  if (search.empty()) {
    result.reserve(value.size() + (value.size() + 1) * replacement.size());
    result += replacement;
    for (const auto character : value) {
      result += character;
      result += replacement;
    }
    return result;
  }
  std::size_t start = 0;
  while (true) {
    const auto offset = value.find(search, start);
    if (offset == std::u16string::npos) {
      result.append(value, start, std::u16string::npos);
      return result;
    }
    result.append(value, start, offset - start);
    result += replacement;
    start = offset + search.size();
  }
}

std::u16string stringReplaceAll(
    const Value& value,
    const Value& search,
    const Value& replacement) {
  return stringReplaceAll(requireString(value), requireString(search), requireString(replacement));
}

std::u16string stringReplaceAll(
    const std::u16string& value,
    const std::u16string& search,
    const Value& replacement) {
  return stringReplaceAll(value, search, requireString(replacement));
}

bool stringIsWellFormed(const std::u16string& value) {
  for (std::size_t index = 0; index < value.size(); ++index) {
    const char16_t current = value[index];
    if (current >= 0xD800 && current <= 0xDBFF) {
      if (index + 1 >= value.size() || value[index + 1] < 0xDC00 || value[index + 1] > 0xDFFF) return false;
      ++index;
    } else if (current >= 0xDC00 && current <= 0xDFFF) {
      return false;
    }
  }
  return true;
}

bool stringIsWellFormed(const Value& value) {
  return stringIsWellFormed(requireString(value));
}

std::u16string stringToWellFormed(const std::u16string& value) {
  std::u16string result;
  result.reserve(value.size());
  for (std::size_t index = 0; index < value.size(); ++index) {
    const char16_t current = value[index];
    if (current >= 0xD800 && current <= 0xDBFF) {
      if (index + 1 < value.size() && value[index + 1] >= 0xDC00 && value[index + 1] <= 0xDFFF) {
        result += current;
        result += value[++index];
      } else {
        result += u'\uFFFD';
      }
    } else if (current >= 0xDC00 && current <= 0xDFFF) {
      result += u'\uFFFD';
    } else {
      result += current;
    }
  }
  return result;
}

std::u16string stringToWellFormed(const Value& value) {
  return stringToWellFormed(requireString(value));
}

std::u16string stringReplace(const Value& value, const std::u16string& search, const Value& replacement) {
  return stringReplace(requireString(value), search, requireString(replacement));
}

}  // namespace vexa
