#pragma once

// Internal runtime category header. Include runtime.hpp instead.

std::u16string toFixed(double value, int digits = 0);

std::u16string toExponential(double value, int digits = -1);

std::u16string toPrecision(double value, int precision = -1);

bool numberIsSafeInteger(double value);

bool numberIsInteger(const Value& value);

template <typename T>
inline bool numberIsInteger(T value) {
  if constexpr (std::is_integral_v<T>) return true;
  else if constexpr (std::is_floating_point_v<T>) return std::isfinite(value) && std::trunc(value) == value;
  else return false;
}
