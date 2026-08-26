#pragma once

// Internal runtime category header. Include runtime.hpp instead.

template <typename Left, typename Right>
inline Value add(Left&& leftInput, Right&& rightInput) {
  const Value left = convertValue<Value>(std::forward<Left>(leftInput));
  const Value right = convertValue<Value>(std::forward<Right>(rightInput));
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

void requireMatchingBigInts(const Value& left, const Value& right);

Value subtract(const Value& left, const Value& right);

Value multiply(const Value& left, const Value& right);

Value divide(const Value& left, const Value& right);

Value power(const Value& left, const Value& right);

Value negate(const Value& value);

std::int32_t toInt32(const Value& value);

std::int32_t toInt32(double value);

Value bitwiseNot(const Value& value);

Value bitwiseAnd(const Value& left, const Value& right);

Value bitwiseOr(const Value& left, const Value& right);

Value bitwiseXor(const Value& left, const Value& right);

Value shiftLeft(const Value& left, const Value& right);

Value shiftRight(const Value& left, const Value& right);

Value unsignedShiftRight(const Value& left, const Value& right);

double bitwiseNot(double value);

double bitwiseAnd(double left, double right);

double bitwiseOr(double left, double right);

double bitwiseXor(double left, double right);

double shiftLeft(double left, double right);

double shiftRight(double left, double right);

double unsignedShiftRight(double left, double right);

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

std::int32_t compare(const Value& left, const Value& right);

double parseFloat(const std::u16string& value);

double parseFloat(const Value& value);
double parseInt(const std::u16string& value, int radix = 10);
double parseInt(const Value& value, int radix = 10);
bool isNaN(double value);
bool isFinite(double value);
bool isErrorLike(const Error&);
bool isErrorLike(const Value& value);
const std::u16string& errorMessageText(const Error& error);
const std::u16string& errorNameText(const Error& error);
std::u16string errorStackText(const Error& error);
Value errorCause(const Error& error);
Value aggregateErrorErrors(const Error& error);
Value errorOptionsCause(const Value& options);
Error makeError(
    std::u16string name,
    Value message = Value::undefined(),
    Value options = Value::undefined());
Error makeAggregateError(
    Value errors,
    Value message = Value::undefined(),
    Value options = Value::undefined());
std::u16string errorMessageText(const Value& value);
template <typename T>
inline bool isErrorLike(T* value) {
  if constexpr (std::is_base_of_v<Error, T>) return value != nullptr;
  return value && value->dynamicCast(nativeTypeToken<Error>()) != nullptr;
}
Value encodeURIComponent(const std::u16string& value);
Value encodeURIComponent(const Value& value);
Value decodeURIComponent(const std::u16string& value);
Value decodeURIComponent(const Value& value);
Value encodeURI(const std::u16string& value);
Value encodeURI(const Value& value);
Value decodeURI(const std::u16string& value);
Value decodeURI(const Value& value);
Value escape(const std::u16string& value);
Value escape(const Value& value);
Value unescape(const std::u16string& value);
Value unescape(const Value& value);
