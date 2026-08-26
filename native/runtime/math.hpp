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

  static double abs(double value);
  static double acos(double value);
  static double acosh(double value);
  static double asin(double value);
  static double asinh(double value);
  static double atan(double value);
  static double atan2(double y, double x);
  static double atanh(double value);
  static double cbrt(double value);
  static double ceil(double value);
  static double clz32(double value);
  static double cos(double value);
  static double cosh(double value);
  static double exp(double value);
  static double expm1(double value);
  static double floor(double value);
  static double fround(double value);
  static double log(double value);
  static double log2(double value);
  static double log10(double value);
  static double log1p(double value);
  static double round(double value);
  static double sign(double value);
  static double sin(double value);
  static double sinh(double value);
  static double sqrt(double value);
  static double tan(double value);
  static double tanh(double value);
  static double trunc(double value);
  static double pow(double base, double exponent);
  static double min();
  template <typename First, typename... Rest>
  static double min(const First& first, const Rest&... rest) {
    double result = Number(first);
    ((result = std::isnan(result) ? result : std::min(result, Number(rest))), ...);
    return result;
  }
  static double max();
  template <typename First, typename... Rest>
  static double max(const First& first, const Rest&... rest) {
    double result = Number(first);
    ((result = std::isnan(result) ? result : std::max(result, Number(rest))), ...);
    return result;
  }
  static double hypot();
  template <typename... Values>
  static double hypot(const Values&... values) {
    double result = 0;
    ((result = std::hypot(result, Number(values))), ...);
    return result;
  }
  static double imul(double left, double right);
  static double f16round(double value);
  static double random();
};
