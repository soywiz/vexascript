#include "runtime.hpp"

namespace vexa {




double Math::abs(double value) { return std::abs(value); }

double Math::acos(double value) { return std::acos(value); }

double Math::acosh(double value) { return std::acosh(value); }

double Math::asin(double value) { return std::asin(value); }

double Math::asinh(double value) { return std::asinh(value); }

double Math::atan(double value) { return std::atan(value); }

double Math::atan2(double y, double x) { return std::atan2(y, x); }

double Math::atanh(double value) { return std::atanh(value); }

double Math::cbrt(double value) { return std::cbrt(value); }

double Math::ceil(double value) { return std::ceil(value); }

double Math::clz32(double value) {
    return static_cast<double>(std::countl_zero(static_cast<std::uint32_t>(toInt32(value))));
  }

double Math::cos(double value) { return std::cos(value); }

double Math::cosh(double value) { return std::cosh(value); }

double Math::exp(double value) { return std::exp(value); }

double Math::expm1(double value) { return std::expm1(value); }

double Math::floor(double value) { return std::floor(value); }

double Math::fround(double value) { return static_cast<double>(static_cast<float>(value)); }

double Math::log(double value) { return std::log(value); }

double Math::log2(double value) { return std::log2(value); }

double Math::log10(double value) { return std::log10(value); }

double Math::log1p(double value) { return std::log1p(value); }

double Math::round(double value) { return std::round(value); }

double Math::sign(double value) { return (0 < value) - (value < 0); }

double Math::sin(double value) { return std::sin(value); }

double Math::sinh(double value) { return std::sinh(value); }

double Math::sqrt(double value) { return std::sqrt(value); }

double Math::tan(double value) { return std::tan(value); }

double Math::tanh(double value) { return std::tanh(value); }

double Math::trunc(double value) { return std::trunc(value); }

double Math::pow(double base, double exponent) { return std::pow(base, exponent); }

double Math::min() { return std::numeric_limits<double>::infinity(); }

double Math::max() { return -std::numeric_limits<double>::infinity(); }

double Math::hypot() { return 0; }

double Math::imul(double left, double right) {
    const auto product = static_cast<std::uint32_t>(toInt32(left))
      * static_cast<std::uint32_t>(toInt32(right));
    return static_cast<double>(std::bit_cast<std::int32_t>(product));
  }

double Math::f16round(double value) {
    return float16Value(float16Storage(value));
  }

double Math::random() {
    return static_cast<double>(std::rand()) / static_cast<double>(RAND_MAX);
  }
}  // namespace vexa
