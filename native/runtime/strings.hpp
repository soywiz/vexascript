#pragma once

// Internal runtime category header. Include runtime.hpp instead.

inline std::u16string toUpperCase(std::u16string value) {
  std::transform(value.begin(), value.end(), value.begin(), [](char16_t character) {
    return character <= 0x7f
      ? static_cast<char16_t>(std::toupper(static_cast<unsigned char>(character)))
      : character;
  });
  return value;
}
inline std::u16string toUpperCase(const Value& value) {
  return toUpperCase(requireString(value));
}

inline std::u16string toLowerCase(std::u16string value) {
  std::transform(value.begin(), value.end(), value.begin(), [](char16_t character) {
    return character <= 0x7f
      ? static_cast<char16_t>(std::tolower(static_cast<unsigned char>(character)))
      : character;
  });
  return value;
}
inline std::u16string toLowerCase(const Value& value) {
  return toLowerCase(requireString(value));
}

inline bool isStringWhitespace(char16_t character) {
  return character == u' ' || character == u'\t' || character == u'\n' ||
    character == u'\r' || character == u'\f' || character == u'\v';
}

inline std::u16string trim(std::u16string value) {
  value.erase(value.begin(), std::find_if_not(value.begin(), value.end(), isStringWhitespace));
  value.erase(std::find_if_not(value.rbegin(), value.rend(), isStringWhitespace).base(), value.end());
  return value;
}
inline std::u16string trim(const Value& value) {
  return trim(requireString(value));
}

inline std::u16string trimStart(std::u16string value) {
  value.erase(value.begin(), std::find_if_not(value.begin(), value.end(), isStringWhitespace));
  return value;
}
inline std::u16string trimStart(const Value& value) {
  return trimStart(requireString(value));
}

inline std::u16string trimEnd(std::u16string value) {
  value.erase(std::find_if_not(value.rbegin(), value.rend(), isStringWhitespace).base(), value.end());
  return value;
}
inline std::u16string trimEnd(const Value& value) {
  return trimEnd(requireString(value));
}

inline bool stringIncludes(
    const std::u16string& value,
    const std::u16string& search,
    double position = 0) {
  return value.find(search, normalizedSliceIndex(position, value.size())) != std::u16string::npos;
}
inline bool stringIncludes(const std::u16string& value, const Value& search, double position = 0) {
  return stringIncludes(value, toString(search), position);
}
inline bool stringIncludes(const Value& value, const std::u16string& search, double position = 0) {
  return stringIncludes(toString(value), search, position);
}
inline bool stringIncludes(const Value& value, const Value& search, double position = 0) {
  return stringIncludes(toString(value), toString(search), position);
}

template <typename ValueLike, typename SearchLike>
double stringIndexOf(const ValueLike& valueLike, const SearchLike& searchLike, double position = 0) {
  const std::u16string value = toString(valueLike);
  const std::u16string search = toString(searchLike);
  const auto found = value.find(search, normalizedSliceIndex(position, value.size()));
  return found == std::u16string::npos ? -1.0 : static_cast<double>(found);
}

template <typename ValueLike, typename SearchLike>
double stringLastIndexOf(
    const ValueLike& valueLike,
    const SearchLike& searchLike,
    double position = std::numeric_limits<double>::infinity()) {
  const std::u16string value = toString(valueLike);
  const std::u16string search = toString(searchLike);
  const std::size_t start = std::isfinite(position)
      ? std::min(value.size(), static_cast<std::size_t>(std::max(0.0, std::floor(position))))
      : value.size();
  const auto found = value.rfind(search, start);
  return found == std::u16string::npos ? -1.0 : static_cast<double>(found);
}

inline bool startsWith(
    const std::u16string& value,
    const std::u16string& search,
    double position = 0) {
  return value.compare(normalizedSliceIndex(position, value.size()), search.size(), search) == 0;
}
inline bool startsWith(const Value& value, const Value& search, double position = 0) {
  return startsWith(toString(value), toString(search), position);
}
inline bool startsWith(const std::u16string& value, const Value& search, double position = 0) {
  return startsWith(value, toString(search), position);
}
inline bool startsWith(const Value& value, const std::u16string& search, double position = 0) {
  return startsWith(toString(value), search, position);
}

inline bool endsWith(const std::u16string& value, const std::u16string& search) {
  return search.size() <= value.size() &&
    value.compare(value.size() - search.size(), search.size(), search) == 0;
}
inline bool endsWith(const Value& value, const Value& search) {
  return endsWith(toString(value), toString(search));
}
inline bool endsWith(const std::u16string& value, const Value& search) {
  return endsWith(value, toString(search));
}
inline bool endsWith(const Value& value, const std::u16string& search) {
  return endsWith(toString(value), search);
}

inline std::u16string charAt(const std::u16string& value, double index = 0) {
  const auto position = static_cast<std::int64_t>(std::trunc(index));
  return position >= 0 && static_cast<std::size_t>(position) < value.size()
    ? std::u16string(1, value[static_cast<std::size_t>(position)])
    : std::u16string();
}
inline std::u16string charAt(const Value& value, double index = 0) {
  return charAt(requireString(value), index);
}

inline std::u16string stringIndex(const std::u16string& value, double index) {
  return charAt(value, index);
}

inline Value stringAt(const std::u16string& value, double index) {
  const auto integer = static_cast<std::int64_t>(std::trunc(index));
  const auto position = integer < 0
    ? static_cast<std::int64_t>(value.size()) + integer
    : integer;
  return position >= 0 && static_cast<std::size_t>(position) < value.size()
    ? Runtime::string(std::u16string(1, value[static_cast<std::size_t>(position)]))
    : Value::undefined();
}
inline Value stringAt(const Value& value, double index) {
  return stringAt(requireString(value), index);
}

inline double charCodeAt(const std::u16string& value, double index = 0) {
  const auto position = static_cast<std::int64_t>(std::trunc(index));
  if (position < 0 || static_cast<std::size_t>(position) >= value.size()) {
    return std::numeric_limits<double>::quiet_NaN();
  }
  return static_cast<std::uint16_t>(value[static_cast<std::size_t>(position)]);
}
inline double charCodeAt(const Value& value, double index = 0) {
  return charCodeAt(requireString(value), index);
}

inline Value codePointAt(const std::u16string& value, double index = 0) {
  const auto position = static_cast<std::int64_t>(std::trunc(index));
  if (position < 0 || static_cast<std::size_t>(position) >= value.size()) {
    return Value::undefined();
  }
  const auto first = static_cast<std::uint16_t>(value[static_cast<std::size_t>(position)]);
  if (first >= 0xD800 && first <= 0xDBFF && static_cast<std::size_t>(position + 1) < value.size()) {
    const auto second = static_cast<std::uint16_t>(value[static_cast<std::size_t>(position + 1)]);
    if (second >= 0xDC00 && second <= 0xDFFF) {
      return Value(static_cast<double>(0x10000 + ((first - 0xD800) << 10) + (second - 0xDC00)));
    }
  }
  return Value(static_cast<double>(first));
}
inline Value codePointAt(const Value& value, double index = 0) {
  return codePointAt(requireString(value), index);
}

template <typename T>
inline bool numberIsNaN(const T& value) {
  return std::isnan(Number(value));
}

inline std::u16string stringFromCharCode(double value) {
  const auto codeUnit =
    static_cast<std::uint32_t>(static_cast<std::uint16_t>(static_cast<std::uint32_t>(value)));
  return std::u16string(1, static_cast<char16_t>(codeUnit));
}

inline std::u16string stringRepeat(const std::u16string& value, double count) {
  const auto repetitions = std::max<std::int64_t>(0, static_cast<std::int64_t>(count));
  std::u16string result;
  result.reserve(value.size() * static_cast<std::size_t>(repetitions));
  for (std::int64_t index = 0; index < repetitions; ++index) result += value;
  return result;
}
inline std::u16string stringRepeat(const Value& value, double count) {
  return stringRepeat(requireString(value), count);
}

inline std::u16string substring(
    const std::u16string& value,
    double start,
    double end = std::numeric_limits<double>::infinity()) {
  std::size_t first = normalizedSliceIndex(std::max(0.0, start), value.size());
  std::size_t last = std::isinf(end)
    ? value.size()
    : normalizedSliceIndex(std::max(0.0, end), value.size());
  if (first > last) std::swap(first, last);
  return value.substr(first, last - first);
}
inline std::u16string substring(
    const Value& value,
    double start,
    double end = std::numeric_limits<double>::infinity()) {
  return substring(requireString(value), start, end);
}

inline std::u16string stringSlice(
    const std::u16string& value,
    double start = 0,
    double end = std::numeric_limits<double>::infinity()) {
  const std::size_t first = normalizedSliceIndex(start, value.size());
  const std::size_t last = std::isinf(end)
    ? value.size()
    : normalizedSliceIndex(end, value.size());
  return last <= first ? std::u16string() : value.substr(first, last - first);
}
inline std::u16string stringSlice(
    const Value& value,
    double start = 0,
    double end = std::numeric_limits<double>::infinity()) {
  return stringSlice(requireString(value), start, end);
}

inline ArrayObject<std::u16string>* split(
    const std::u16string& value,
    const std::u16string& separator) {
  auto* result = Runtime::array<std::u16string>();
  if (separator.empty()) {
    for (char16_t character : value) result->append(std::u16string(1, character));
    return result;
  }
  std::size_t start = 0;
  while (true) {
    const std::size_t next = value.find(separator, start);
    if (next == std::u16string::npos) {
      result->append(value.substr(start));
      return result;
    }
    result->append(value.substr(start, next - start));
    start = next + separator.size();
  }
}
inline ArrayObject<std::u16string>* split(const Value& value, const Value& separator) {
  return split(toString(value), toString(separator));
}
inline ArrayObject<std::u16string>* split(
    const std::u16string& value,
    const Value& separator) {
  return split(value, toString(separator));
}
inline ArrayObject<std::u16string>* split(
    const Value& value,
    const std::u16string& separator) {
  return split(toString(value), separator);
}

inline ArrayObject<std::u16string>* split(
    const Value& value,
    const RegExp& separator) {
  auto* result = Runtime::array<std::u16string>();
  for (const auto& part : separator.split(toString(value))) result->append(part);
  return result;
}

inline ArrayObject<std::u16string>* split(
    const std::u16string& value,
    const RegExp& separator) {
  auto* result = Runtime::array<std::u16string>();
  for (const auto& part : separator.split(value)) result->append(part);
  return result;
}
