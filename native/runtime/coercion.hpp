#pragma once

// Internal runtime category header. Include runtime.hpp instead.

double Number(double value);
double Number(bool value);
double Number(int value);
double Number(std::int64_t value);
double Number(const BigInt& value);
double Number(const std::u16string& value);
double numberFromString(const std::u16string& value);

double Number(const Value& value);

bool strictEquals(const Value& left, const Value& right);

bool looseEqualsString(const std::u16string& text, const Value& value);

bool looseEquals(const Value& left, const Value& right);

template <typename Left, typename Right>
  requires (std::is_arithmetic_v<Left> && std::is_arithmetic_v<Right>)
inline auto remainder(Left left, Right right) {
  if constexpr (std::is_integral_v<Left> && std::is_integral_v<Right>) {
    return left % right;
  } else {
    return std::fmod(static_cast<double>(left), static_cast<double>(right));
  }
}

Value remainder(const Value& left, const Value& right);

template <typename Right>
  requires std::is_arithmetic_v<Right>
inline double remainder(const Value& left, Right right) {
  return std::fmod(Number(left), static_cast<double>(right));
}

template <typename Left>
  requires std::is_arithmetic_v<Left>
inline double remainder(Left left, const Value& right) {
  return std::fmod(static_cast<double>(left), Number(right));
}

template <typename T>
inline std::u16string String(const T& value) {
  return std::u16string(toString(value));
}

bool Boolean(bool value);
bool Boolean(Undefined);
template <typename T>
  requires (std::is_integral_v<T> && !std::is_same_v<std::remove_cv_t<T>, bool>)
inline bool Boolean(T value) { return value != 0; }
bool Boolean(double value);
bool Boolean(const std::u16string& value);
template <typename Result, typename... Arguments>
inline bool Boolean(const std::function<Result(Arguments...)>& value) {
  return static_cast<bool>(value);
}
bool Boolean(const Value& value);
