#pragma once

// Internal runtime category header. Include runtime.hpp instead.

inline std::u16string toFixed(double value, int digits = 0) {
  return formatFixedText(value, std::clamp(digits, 0, 100));
}

inline std::u16string toExponential(double value, int digits = -1) {
  std::ostringstream stream;
  stream.imbue(std::locale::classic());
  stream << std::scientific;
  if (digits >= 0) stream << std::setprecision(std::clamp(digits, 0, 100));
  else stream << std::setprecision(std::numeric_limits<double>::max_digits10 - 1);
  stream << value;
  std::string result = stream.str();
  const auto exponent = result.find('e');
  if (digits < 0 && exponent != std::string::npos) {
    auto decimal = result.find('.');
    auto last = exponent;
    while (last > decimal + 1 && result[last - 1] == '0') --last;
    if (last > decimal && result[last - 1] == '.') --last;
    result.erase(last, exponent - last);
  }
  if (exponent != std::string::npos) {
    auto firstExponentDigit = exponent + 1;
    if (firstExponentDigit < result.size() &&
        (result[firstExponentDigit] == '+' || result[firstExponentDigit] == '-')) {
      ++firstExponentDigit;
    }
    while (firstExponentDigit + 1 < result.size() && result[firstExponentDigit] == '0') {
      result.erase(firstExponentDigit, 1);
    }
  }
  return utf8ToUtf16(result);
}

inline std::u16string toPrecision(double value, int precision = -1) {
  if (precision < 0) return numberToString(value);
  std::ostringstream stream;
  stream.imbue(std::locale::classic());
  stream << std::setprecision(std::clamp(precision, 1, 100)) << value;
  return utf8ToUtf16(stream.str());
}

inline bool numberIsSafeInteger(double value) {
  return std::isfinite(value) && std::trunc(value) == value &&
    std::abs(value) <= 9007199254740991.0;
}

inline bool numberIsInteger(const Value& value) {
  return value.isNumber() && std::isfinite(value.number()) && std::trunc(value.number()) == value.number();
}

template <typename T>
inline bool numberIsInteger(T value) {
  if constexpr (std::is_integral_v<T>) return true;
  else if constexpr (std::is_floating_point_v<T>) return std::isfinite(value) && std::trunc(value) == value;
  else return false;
}
