#include "runtime.hpp"

namespace vexa {




std::u16string toFixed(double value, int digits) {
  return formatFixedText(value, std::clamp(digits, 0, 100));
}

std::u16string toExponential(double value, int digits) {
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

std::u16string toPrecision(double value, int precision) {
  if (precision < 0) return numberToString(value);
  std::ostringstream stream;
  stream.imbue(std::locale::classic());
  stream << std::setprecision(std::clamp(precision, 1, 100)) << value;
  return utf8ToUtf16(stream.str());
}

bool numberIsSafeInteger(double value) {
  return std::isfinite(value) && std::trunc(value) == value &&
    std::abs(value) <= 9007199254740991.0;
}

bool numberIsInteger(const Value& value) {
  return value.isNumber() && std::isfinite(value.number()) && std::trunc(value.number()) == value.number();
}
}  // namespace vexa
