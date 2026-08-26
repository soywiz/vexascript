#pragma once

// Internal runtime category header. Include runtime.hpp instead.

template <typename Left, typename Right>
inline Value add(Left&& leftInput, Right&& rightInput) {
  const Value left = convertValue<Value>(std::forward<Left>(leftInput));
  const Value right = convertValue<Value>(std::forward<Right>(rightInput));
  if (const auto result = callDynamicOperator(left, u"__vexa_operator:+", right)) {
    return *result;
  }
  if (left.isString() || right.isString()) {
    const Value leftText = left.isString() ? left : Runtime::string(toString(left));
    const Value rightText = right.isString() ? right : Runtime::string(toString(right));
    return Runtime::concatStrings(leftText.stringObject(), rightText.stringObject());
  }
  if (left.isBigInt() || right.isBigInt()) {
    if (!left.isBigInt() || !right.isBigInt()) {
      throw runtimeError(u"Cannot mix bigint and number arithmetic");
    }
    return Value(left.bigint() + right.bigint());
  }
  return Value(Number(left) + Number(right));
}

template <typename Right>
inline Value& addAssign(Value& left, Right&& right) {
  left = add(left, std::forward<Right>(right));
  return left;
}

inline void requireMatchingBigInts(const Value& left, const Value& right) {
  if ((left.isBigInt() || right.isBigInt()) && (!left.isBigInt() || !right.isBigInt())) {
    throw runtimeError(u"Cannot mix bigint and number arithmetic");
  }
}

inline Value subtract(const Value& left, const Value& right) {
  if (const auto result = callDynamicOperator(left, u"__vexa_operator:-", right)) {
    return *result;
  }
  requireMatchingBigInts(left, right);
  return left.isBigInt()
      ? Value(left.bigint() - right.bigint())
      : Value(Number(left) - Number(right));
}

inline Value multiply(const Value& left, const Value& right) {
  if (const auto result = callDynamicOperator(left, u"__vexa_operator:*", right)) {
    return *result;
  }
  requireMatchingBigInts(left, right);
  return left.isBigInt()
      ? Value(left.bigint() * right.bigint())
      : Value(Number(left) * Number(right));
}

inline Value divide(const Value& left, const Value& right) {
  if (const auto result = callDynamicOperator(left, u"__vexa_operator:/", right)) {
    return *result;
  }
  requireMatchingBigInts(left, right);
  return left.isBigInt()
      ? Value(left.bigint() / right.bigint())
      : Value(Number(left) / Number(right));
}

inline Value power(const Value& left, const Value& right) {
  if (const auto result = callDynamicOperator(left, u"__vexa_operator:**", right)) {
    return *result;
  }
  requireMatchingBigInts(left, right);
  return left.isBigInt()
      ? Value(vexa::pow(left.bigint(), right.bigint()))
      : Value(std::pow(Number(left), Number(right)));
}

inline Value negate(const Value& value) {
  if (const auto result = callDynamicOperator(value, u"__vexa_operator:-")) {
    return *result;
  }
  return value.isBigInt() ? Value(-value.bigint()) : Value(-Number(value));
}

inline std::int32_t toInt32(const Value& value) {
  return static_cast<std::int32_t>(static_cast<std::uint32_t>(static_cast<std::int64_t>(Number(value))));
}

inline std::int32_t toInt32(double value) {
  return static_cast<std::int32_t>(static_cast<std::uint32_t>(static_cast<std::int64_t>(value)));
}

inline Value bitwiseNot(const Value& value) {
  return value.isBigInt() ? Value(~value.bigint()) : Value(~toInt32(value));
}

inline Value bitwiseAnd(const Value& left, const Value& right) {
  requireMatchingBigInts(left, right);
  return left.isBigInt() ? Value(left.bigint() & right.bigint()) : Value(toInt32(left) & toInt32(right));
}

inline Value bitwiseOr(const Value& left, const Value& right) {
  requireMatchingBigInts(left, right);
  return left.isBigInt() ? Value(left.bigint() | right.bigint()) : Value(toInt32(left) | toInt32(right));
}

inline Value bitwiseXor(const Value& left, const Value& right) {
  requireMatchingBigInts(left, right);
  return left.isBigInt() ? Value(left.bigint() ^ right.bigint()) : Value(toInt32(left) ^ toInt32(right));
}

inline Value shiftLeft(const Value& left, const Value& right) {
  requireMatchingBigInts(left, right);
  if (left.isBigInt()) return Value(left.bigint() << right.bigint());
  const auto amount = static_cast<std::uint32_t>(toInt32(right)) & 31U;
  return Value(static_cast<std::int32_t>(static_cast<std::uint32_t>(toInt32(left)) << amount));
}

inline Value shiftRight(const Value& left, const Value& right) {
  requireMatchingBigInts(left, right);
  if (left.isBigInt()) return Value(left.bigint() >> right.bigint());
  const auto amount = static_cast<std::uint32_t>(toInt32(right)) & 31U;
  return Value(static_cast<std::int32_t>(toInt32(left) >> amount));
}

inline Value unsignedShiftRight(const Value& left, const Value& right) {
  if (left.isBigInt() || right.isBigInt()) {
    throw runtimeError(u"Unsigned right shift is not defined for bigint values");
  }
  const auto amount = static_cast<std::uint32_t>(toInt32(right)) & 31U;
  return Value(static_cast<double>(static_cast<std::uint32_t>(toInt32(left)) >> amount));
}

inline double bitwiseNot(double value) {
  return static_cast<double>(~toInt32(value));
}

inline double bitwiseAnd(double left, double right) {
  return static_cast<double>(toInt32(left) & toInt32(right));
}

inline double bitwiseOr(double left, double right) {
  return static_cast<double>(toInt32(left) | toInt32(right));
}

inline double bitwiseXor(double left, double right) {
  return static_cast<double>(toInt32(left) ^ toInt32(right));
}

inline double shiftLeft(double left, double right) {
  const auto amount = static_cast<std::uint32_t>(toInt32(right)) & 31U;
  return static_cast<double>(static_cast<std::int32_t>(static_cast<std::uint32_t>(toInt32(left)) << amount));
}

inline double shiftRight(double left, double right) {
  const auto amount = static_cast<std::uint32_t>(toInt32(right)) & 31U;
  return static_cast<double>(toInt32(left) >> amount);
}

inline double unsignedShiftRight(double left, double right) {
  const auto amount = static_cast<std::uint32_t>(toInt32(right)) & 31U;
  return static_cast<double>(static_cast<std::uint32_t>(toInt32(left)) >> amount);
}

template <typename Target, typename Callback>
inline Target& assignWith(Target& target, Callback&& callback) {
  auto result = std::forward<Callback>(callback)(target);
  if constexpr (std::is_arithmetic_v<Target> && std::is_same_v<std::remove_cvref_t<decltype(result)>, Value>) {
    target = static_cast<Target>(Number(result));
  } else {
    target = std::move(result);
  }
  return target;
}

template <typename Left, typename Right>
inline std::int32_t compare(const Left& left, const Right& right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

inline std::int32_t compare(const Value& left, const Value& right) {
  if (const auto result = callDynamicOperator(
        left, u"__vexa_operator:<=>", right)) {
    return convertValue<std::int32_t>(*result);
  }
  if (left.isRuntimeObject() && right.isRuntimeObject()) {
    auto* leftDate = static_cast<DateObject*>(
      left.object()->dynamicCast(nativeTypeToken<DateObject>()));
    auto* rightDate = static_cast<DateObject*>(
      right.object()->dynamicCast(nativeTypeToken<DateObject>()));
    if (leftDate && rightDate) return compare(leftDate->getTime(), rightDate->getTime());
  }
  if (left.isString() && right.isString()) {
    return compare(left.utf16(), right.utf16());
  }
  if (left.isBigInt() && right.isBigInt()) {
    return compare(left.bigint(), right.bigint());
  }
  return compare(Number(left), Number(right));
}

inline double parseFloat(const std::u16string& value) {
  try {
    return std::stod(utf16ToUtf8(value));
  } catch (...) {
    return std::numeric_limits<double>::quiet_NaN();
  }
}

inline double parseFloat(const Value& value) { return parseFloat(toString(value)); }
inline double parseInt(const std::u16string& value, int radix = 10) {
  try {
    return static_cast<double>(std::stoll(utf16ToUtf8(value), nullptr, radix));
  } catch (...) {
    return std::numeric_limits<double>::quiet_NaN();
  }
}
inline double parseInt(const Value& value, int radix = 10) { return parseInt(toString(value), radix); }
inline bool isNaN(double value) { return std::isnan(value); }
inline bool isFinite(double value) { return std::isfinite(value); }
inline bool isErrorLike(const Error&) { return true; }
inline bool isErrorLike(const Value& value) {
  return value.isString() ||
    (value.isRuntimeObject() && value.object()->dynamicCast(nativeTypeToken<Error>()) != nullptr);
}
inline const std::u16string& errorMessageText(const Error& error) {
  return error.messageText();
}
inline const std::u16string& errorNameText(const Error& error) {
  return error.nameText();
}
inline std::u16string errorStackText(const Error& error) {
  return error.stackText();
}
inline Value errorCause(const Error& error) {
  return error.cause();
}
inline Value aggregateErrorErrors(const Error& error) {
  return error.errors();
}
inline Value errorOptionsCause(const Value& options) {
  if (options.isUndefined()) return Value::undefined();
  if (!options.isRecord() && !options.isRuntimeObject()) {
    throw runtimeError(u"Error options must be an object");
  }
  return dynamicGet(options, u"cause");
}
inline Error makeError(
    std::u16string name,
    Value message = Value::undefined(),
    Value options = Value::undefined()) {
  return Error(message, std::move(name), errorOptionsCause(options));
}
inline Error makeAggregateError(
    Value errors,
    Value message = Value::undefined(),
    Value options = Value::undefined()) {
  if (!errors.isRuntimeObject() || !errors.object()->dynamicIsIterable()) {
    throw runtimeError(u"AggregateError errors must be iterable");
  }
  return Error(message, u"AggregateError", errorOptionsCause(options), std::move(errors));
}
inline std::u16string errorMessageText(const Value& value) {
  if (value.isString()) return value.string();
  if (value.isRuntimeObject()) {
    const Value message = value.object()->dynamicGet(u"message");
    if (!message.isUndefined()) return toString(message);
  }
  return toString(value);
}
template <typename T>
inline bool isErrorLike(T* value) {
  if constexpr (std::is_base_of_v<Error, T>) return value != nullptr;
  return value && value->dynamicCast(nativeTypeToken<Error>()) != nullptr;
}
inline Value encodeURIComponent(const std::u16string& value) {
  return Runtime::string(encodeUriComponentText(value));
}
inline Value encodeURIComponent(const Value& value) {
  return encodeURIComponent(value.isString() ? value.utf16() : toString(value));
}
inline Value decodeURIComponent(const std::u16string& value) {
  return Runtime::string(decodeUriComponentText(value));
}
inline Value decodeURIComponent(const Value& value) {
  return decodeURIComponent(value.isString() ? value.utf16() : toString(value));
}
inline Value encodeURI(const std::u16string& value) { return encodeURIComponent(value); }
inline Value encodeURI(const Value& value) { return encodeURIComponent(value); }
inline Value decodeURI(const std::u16string& value) { return decodeURIComponent(value); }
inline Value decodeURI(const Value& value) { return decodeURIComponent(value); }
inline Value escape(const std::u16string& value) { return encodeURIComponent(value); }
inline Value escape(const Value& value) { return encodeURIComponent(value); }
inline Value unescape(const std::u16string& value) { return decodeURIComponent(value); }
inline Value unescape(const Value& value) { return decodeURIComponent(value); }
