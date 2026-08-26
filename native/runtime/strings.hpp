#pragma once

// Internal runtime category header. Include runtime.hpp instead.

std::u16string toUpperCase(std::u16string value);
std::u16string toUpperCase(const Value& value);

std::u16string toLowerCase(std::u16string value);
std::u16string toLowerCase(const Value& value);

bool isStringWhitespace(char16_t character);

std::u16string trim(std::u16string value);
std::u16string trim(const Value& value);

std::u16string trimStart(std::u16string value);
std::u16string trimStart(const Value& value);

std::u16string trimEnd(std::u16string value);
std::u16string trimEnd(const Value& value);

bool stringIncludes(
    const std::u16string& value,
    const std::u16string& search,
    double position = 0);
bool stringIncludes(const std::u16string& value, const Value& search, double position = 0);
bool stringIncludes(const Value& value, const std::u16string& search, double position = 0);
bool stringIncludes(const Value& value, const Value& search, double position = 0);

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

bool startsWith(
    const std::u16string& value,
    const std::u16string& search,
    double position = 0);
bool startsWith(const Value& value, const Value& search, double position = 0);
bool startsWith(const std::u16string& value, const Value& search, double position = 0);
bool startsWith(const Value& value, const std::u16string& search, double position = 0);

bool endsWith(const std::u16string& value, const std::u16string& search);
bool endsWith(const Value& value, const Value& search);
bool endsWith(const std::u16string& value, const Value& search);
bool endsWith(const Value& value, const std::u16string& search);

std::u16string charAt(const std::u16string& value, double index = 0);
std::u16string charAt(const Value& value, double index = 0);

std::u16string stringIndex(const std::u16string& value, double index);

Value stringAt(const std::u16string& value, double index);
Value stringAt(const Value& value, double index);

double charCodeAt(const std::u16string& value, double index = 0);
double charCodeAt(const Value& value, double index = 0);

Value codePointAt(const std::u16string& value, double index = 0);
Value codePointAt(const Value& value, double index = 0);

template <typename T>
inline bool numberIsNaN(const T& value) {
  return std::isnan(Number(value));
}

std::u16string stringFromCharCode(double value);

std::u16string stringRepeat(const std::u16string& value, double count);
std::u16string stringRepeat(const Value& value, double count);

std::u16string substring(
    const std::u16string& value,
    double start,
    double end = std::numeric_limits<double>::infinity());
std::u16string substring(
    const Value& value,
    double start,
    double end = std::numeric_limits<double>::infinity());

std::u16string stringSlice(
    const std::u16string& value,
    double start = 0,
    double end = std::numeric_limits<double>::infinity());
std::u16string stringSlice(
    const Value& value,
    double start = 0,
    double end = std::numeric_limits<double>::infinity());

ArrayObject<std::u16string>* split(
    const std::u16string& value,
    const std::u16string& separator);
ArrayObject<std::u16string>* split(const Value& value, const Value& separator);
ArrayObject<std::u16string>* split(
    const std::u16string& value,
    const Value& separator);
ArrayObject<std::u16string>* split(
    const Value& value,
    const std::u16string& separator);

ArrayObject<std::u16string>* split(
    const Value& value,
    const RegExp& separator);

ArrayObject<std::u16string>* split(
    const std::u16string& value,
    const RegExp& separator);
