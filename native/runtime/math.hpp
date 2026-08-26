#pragma once

// Internal runtime category header. Include runtime.hpp instead.

struct Math final {
  static constexpr double E = 2.71828182845904523536;
  static constexpr double LN2 = 0.69314718055994530942;
  static constexpr double LN10 = 2.30258509299404568402;
  static constexpr double LOG2E = 1.44269504088896340736;
  static constexpr double LOG10E = 0.43429448190325182765;
  static constexpr double PI = 3.14159265358979323846;
  static constexpr double SQRT1_2 = 0.70710678118654752440;
  static constexpr double SQRT2 = 1.41421356237309504880;

  static double abs(double value) { return std::abs(value); }
  static double acos(double value) { return std::acos(value); }
  static double acosh(double value) { return std::acosh(value); }
  static double asin(double value) { return std::asin(value); }
  static double asinh(double value) { return std::asinh(value); }
  static double atan(double value) { return std::atan(value); }
  static double atan2(double y, double x) { return std::atan2(y, x); }
  static double atanh(double value) { return std::atanh(value); }
  static double cbrt(double value) { return std::cbrt(value); }
  static double ceil(double value) { return std::ceil(value); }
  static double clz32(double value) {
    return static_cast<double>(std::countl_zero(static_cast<std::uint32_t>(toInt32(value))));
  }
  static double cos(double value) { return std::cos(value); }
  static double cosh(double value) { return std::cosh(value); }
  static double exp(double value) { return std::exp(value); }
  static double expm1(double value) { return std::expm1(value); }
  static double floor(double value) { return std::floor(value); }
  static double fround(double value) { return static_cast<double>(static_cast<float>(value)); }
  static double log(double value) { return std::log(value); }
  static double log2(double value) { return std::log2(value); }
  static double log10(double value) { return std::log10(value); }
  static double log1p(double value) { return std::log1p(value); }
  static double round(double value) { return std::round(value); }
  static double sign(double value) { return (0 < value) - (value < 0); }
  static double sin(double value) { return std::sin(value); }
  static double sinh(double value) { return std::sinh(value); }
  static double sqrt(double value) { return std::sqrt(value); }
  static double tan(double value) { return std::tan(value); }
  static double tanh(double value) { return std::tanh(value); }
  static double trunc(double value) { return std::trunc(value); }
  static double pow(double base, double exponent) { return std::pow(base, exponent); }
  static double min() { return std::numeric_limits<double>::infinity(); }
  template <typename First, typename... Rest>
  static double min(const First& first, const Rest&... rest) {
    double result = Number(first);
    ((result = std::isnan(result) ? result : std::min(result, Number(rest))), ...);
    return result;
  }
  static double max() { return -std::numeric_limits<double>::infinity(); }
  template <typename First, typename... Rest>
  static double max(const First& first, const Rest&... rest) {
    double result = Number(first);
    ((result = std::isnan(result) ? result : std::max(result, Number(rest))), ...);
    return result;
  }
  static double hypot() { return 0; }
  template <typename... Values>
  static double hypot(const Values&... values) {
    double result = 0;
    ((result = std::hypot(result, Number(values))), ...);
    return result;
  }
  static double imul(double left, double right) {
    const auto product = static_cast<std::uint32_t>(toInt32(left))
      * static_cast<std::uint32_t>(toInt32(right));
    return static_cast<double>(std::bit_cast<std::int32_t>(product));
  }
  static double f16round(double value) {
    return float16Value(float16Storage(value));
  }
  static double random() {
    return static_cast<double>(std::rand()) / static_cast<double>(RAND_MAX);
  }
};
