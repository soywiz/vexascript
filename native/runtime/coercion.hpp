#pragma once

// Internal runtime category header. Include runtime.hpp instead.

inline double Number(double value) { return value; }
inline double Number(bool value) { return value ? 1 : 0; }
inline double Number(int value) { return static_cast<double>(value); }
inline double Number(std::int64_t value) { return static_cast<double>(value); }
inline double Number(const BigInt& value) { return value.toDouble(); }
inline double Number(const std::u16string& value) {
  try { return std::stod(utf16ToUtf8(value)); } catch (...) { return std::numeric_limits<double>::quiet_NaN(); }
}
inline double numberFromString(const std::u16string& value) {
  const auto first = value.find_first_not_of(u" \t\n\r\f\v");
  if (first == std::u16string::npos) return 0;
  const auto last = value.find_last_not_of(u" \t\n\r\f\v");
  const std::u16string trimmed = value.substr(first, last - first + 1);
  try {
    std::size_t consumed = 0;
    const double result = std::stod(utf16ToUtf8(trimmed), &consumed);
    return consumed == trimmed.size() ? result : std::numeric_limits<double>::quiet_NaN();
  } catch (...) {
    return std::numeric_limits<double>::quiet_NaN();
  }
}

inline double Number(const Value& value) {
  if (value.isNumber()) return value.number();
  if (value.isBoolean()) return value.boolean() ? 1 : 0;
  if (value.isBigInt()) return value.bigint().toDouble();
  if (value.isNull()) return 0;
  if (value.isUndefined()) return std::numeric_limits<double>::quiet_NaN();
  if (!value.isString()) return std::numeric_limits<double>::quiet_NaN();
  return numberFromString(value.string());
}

inline bool strictEquals(const Value& left, const Value& right) {
  return left == right;
}

inline bool looseEqualsString(const std::u16string& text, const Value& value) {
  if (value.isString()) return text == value.string();
  if (value.isNumber()) return numberFromString(text) == value.number();
  if (value.isBigInt()) {
    try {
      return BigInt(text) == value.bigint();
    } catch (...) {
      return false;
    }
  }
  if (value.isBoolean()) return numberFromString(text) == (value.boolean() ? 1 : 0);
  return false;
}

inline bool looseEquals(const Value& left, const Value& right) {
  if (strictEquals(left, right)) return true;
  if ((left.isNull() || left.isUndefined()) && (right.isNull() || right.isUndefined())) return true;
  if (left.isString()) return looseEqualsString(left.string(), right);
  if (right.isString()) return looseEqualsString(right.string(), left);
  if (left.isBoolean()) {
    if (right.isBigInt()) return BigInt(left.boolean() ? 1 : 0) == right.bigint();
    return static_cast<double>(left.boolean() ? 1 : 0) == Number(right);
  }
  if (right.isBoolean()) return looseEquals(right, left);
  if (left.isNumber() && right.isBigInt()) {
    return std::isfinite(left.number()) && std::trunc(left.number()) == left.number() &&
        makeBigInt(left.number()) == right.bigint();
  }
  if (left.isBigInt() && right.isNumber()) return looseEquals(right, left);
  if (left.isNumber() && right.isNumber()) return left.number() == right.number();
  if (left.isBigInt() && right.isBigInt()) return left.bigint() == right.bigint();
  const bool leftObject = left.isRecord() || left.isRuntimeObject();
  const bool rightObject = right.isRecord() || right.isRuntimeObject();
  if (leftObject && !rightObject) return looseEqualsString(toString(left), right);
  if (rightObject && !leftObject) return looseEqualsString(toString(right), left);
  return false;
}

template <typename Left, typename Right>
  requires (std::is_arithmetic_v<Left> && std::is_arithmetic_v<Right>)
inline auto remainder(Left left, Right right) {
  if constexpr (std::is_integral_v<Left> && std::is_integral_v<Right>) {
    return left % right;
  } else {
    return std::fmod(static_cast<double>(left), static_cast<double>(right));
  }
}

inline Value remainder(const Value& left, const Value& right) {
  if (left.isBigInt() || right.isBigInt()) {
    if (!left.isBigInt() || !right.isBigInt()) {
      throw runtimeError(u"Cannot mix bigint and number arithmetic");
    }
    return Value(left.bigint() % right.bigint());
  }
  return Value(std::fmod(Number(left), Number(right)));
}

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

inline bool Boolean(bool value) { return value; }
inline bool Boolean(Undefined) { return false; }
template <typename T>
  requires (std::is_integral_v<T> && !std::is_same_v<std::remove_cv_t<T>, bool>)
inline bool Boolean(T value) { return value != 0; }
inline bool Boolean(double value) { return value != 0 && !std::isnan(value); }
inline bool Boolean(const std::u16string& value) { return !value.empty(); }
template <typename Result, typename... Arguments>
inline bool Boolean(const std::function<Result(Arguments...)>& value) {
  return static_cast<bool>(value);
}
inline bool Boolean(const Value& value) {
  if (value.isUndefined() || value.isNull()) return false;
  if (value.isBoolean()) return value.boolean();
  if (value.isNumber()) return Boolean(value.number());
  if (value.isBigInt()) return !value.bigint().isZero();
  return !value.isString() || !value.utf16().empty();
}
