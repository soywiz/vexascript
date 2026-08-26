#include "runtime.hpp"

namespace vexa {

void requireMatchingBigInts(const Value& left, const Value& right) {
  if ((left.isBigInt() || right.isBigInt()) && (!left.isBigInt() || !right.isBigInt())) {
    throw runtimeError(u"Cannot mix bigint and number arithmetic");
  }
}

Value subtract(const Value& left, const Value& right) {
  requireMatchingBigInts(left, right);
  return left.isBigInt()
      ? Value(left.bigint() - right.bigint())
      : Value(Number(left) - Number(right));
}

Value multiply(const Value& left, const Value& right) {
  requireMatchingBigInts(left, right);
  return left.isBigInt()
      ? Value(left.bigint() * right.bigint())
      : Value(Number(left) * Number(right));
}

Value divide(const Value& left, const Value& right) {
  requireMatchingBigInts(left, right);
  return left.isBigInt()
      ? Value(left.bigint() / right.bigint())
      : Value(Number(left) / Number(right));
}

Value power(const Value& left, const Value& right) {
  requireMatchingBigInts(left, right);
  return left.isBigInt()
      ? Value(vexa::pow(left.bigint(), right.bigint()))
      : Value(std::pow(Number(left), Number(right)));
}

Value negate(const Value& value) {
  return value.isBigInt() ? Value(-value.bigint()) : Value(-Number(value));
}

std::int32_t toInt32(const Value& value) {
  return static_cast<std::int32_t>(static_cast<std::uint32_t>(static_cast<std::int64_t>(Number(value))));
}

std::int32_t toInt32(double value) {
  return static_cast<std::int32_t>(static_cast<std::uint32_t>(static_cast<std::int64_t>(value)));
}

Value bitwiseNot(const Value& value) {
  return value.isBigInt() ? Value(~value.bigint()) : Value(~toInt32(value));
}

Value bitwiseAnd(const Value& left, const Value& right) {
  requireMatchingBigInts(left, right);
  return left.isBigInt() ? Value(left.bigint() & right.bigint()) : Value(toInt32(left) & toInt32(right));
}

Value bitwiseOr(const Value& left, const Value& right) {
  requireMatchingBigInts(left, right);
  return left.isBigInt() ? Value(left.bigint() | right.bigint()) : Value(toInt32(left) | toInt32(right));
}

Value bitwiseXor(const Value& left, const Value& right) {
  requireMatchingBigInts(left, right);
  return left.isBigInt() ? Value(left.bigint() ^ right.bigint()) : Value(toInt32(left) ^ toInt32(right));
}

Value shiftLeft(const Value& left, const Value& right) {
  requireMatchingBigInts(left, right);
  if (left.isBigInt()) return Value(left.bigint() << right.bigint());
  const auto amount = static_cast<std::uint32_t>(toInt32(right)) & 31U;
  return Value(static_cast<std::int32_t>(static_cast<std::uint32_t>(toInt32(left)) << amount));
}

Value shiftRight(const Value& left, const Value& right) {
  requireMatchingBigInts(left, right);
  if (left.isBigInt()) return Value(left.bigint() >> right.bigint());
  const auto amount = static_cast<std::uint32_t>(toInt32(right)) & 31U;
  return Value(static_cast<std::int32_t>(toInt32(left) >> amount));
}

Value unsignedShiftRight(const Value& left, const Value& right) {
  if (left.isBigInt() || right.isBigInt()) {
    throw runtimeError(u"Unsigned right shift is not defined for bigint values");
  }
  const auto amount = static_cast<std::uint32_t>(toInt32(right)) & 31U;
  return Value(static_cast<double>(static_cast<std::uint32_t>(toInt32(left)) >> amount));
}

double bitwiseNot(double value) {
  return static_cast<double>(~toInt32(value));
}

double bitwiseAnd(double left, double right) {
  return static_cast<double>(toInt32(left) & toInt32(right));
}

double bitwiseOr(double left, double right) {
  return static_cast<double>(toInt32(left) | toInt32(right));
}

double bitwiseXor(double left, double right) {
  return static_cast<double>(toInt32(left) ^ toInt32(right));
}

double shiftLeft(double left, double right) {
  const auto amount = static_cast<std::uint32_t>(toInt32(right)) & 31U;
  return static_cast<double>(static_cast<std::int32_t>(static_cast<std::uint32_t>(toInt32(left)) << amount));
}

double shiftRight(double left, double right) {
  const auto amount = static_cast<std::uint32_t>(toInt32(right)) & 31U;
  return static_cast<double>(toInt32(left) >> amount);
}

double unsignedShiftRight(double left, double right) {
  const auto amount = static_cast<std::uint32_t>(toInt32(right)) & 31U;
  return static_cast<double>(static_cast<std::uint32_t>(toInt32(left)) >> amount);
}

std::int32_t compare(const Value& left, const Value& right) {
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

double parseFloat(const std::u16string& value) {
  try {
    return std::stod(utf16ToUtf8(value));
  } catch (...) {
    return std::numeric_limits<double>::quiet_NaN();
  }
}

double parseFloat(const Value& value) { return parseFloat(toString(value)); }

double parseInt(const std::u16string& value, int radix) {
  try {
    return static_cast<double>(std::stoll(utf16ToUtf8(value), nullptr, radix));
  } catch (...) {
    return std::numeric_limits<double>::quiet_NaN();
  }
}

double parseInt(const Value& value, int radix) { return parseInt(toString(value), radix); }

bool isNaN(double value) { return std::isnan(value); }

bool isFinite(double value) { return std::isfinite(value); }

bool isErrorLike(const Error&) { return true; }

bool isErrorLike(const Value& value) {
  return value.isString() ||
    (value.isRuntimeObject() && value.object()->dynamicCast(nativeTypeToken<Error>()) != nullptr);
}

const std::u16string& errorMessageText(const Error& error) {
  return error.messageText();
}

const std::u16string& errorNameText(const Error& error) {
  return error.nameText();
}

std::u16string errorStackText(const Error& error) {
  return error.stackText();
}

Value errorCause(const Error& error) {
  return error.cause();
}

Value aggregateErrorErrors(const Error& error) {
  return error.errors();
}

Value errorOptionsCause(const Value& options) {
  if (options.isUndefined()) return Value::undefined();
  if (!options.isRecord() && !options.isRuntimeObject()) {
    throw runtimeError(u"Error options must be an object");
  }
  return dynamicGet(options, u"cause");
}

Error makeError(
    std::u16string name,
    Value message,
    Value options) {
  return Error(message, std::move(name), errorOptionsCause(options));
}

Error makeAggregateError(
    Value errors,
    Value message,
    Value options) {
  if (!errors.isRuntimeObject() || !errors.object()->dynamicIsIterable()) {
    throw runtimeError(u"AggregateError errors must be iterable");
  }
  return Error(message, u"AggregateError", errorOptionsCause(options), std::move(errors));
}

std::u16string errorMessageText(const Value& value) {
  if (value.isString()) return value.string();
  if (value.isRuntimeObject()) {
    const Value message = value.object()->dynamicGet(u"message");
    if (!message.isUndefined()) return toString(message);
  }
  return toString(value);
}

Value encodeURIComponent(const std::u16string& value) {
  return Runtime::string(encodeUriComponentText(value));
}

Value encodeURIComponent(const Value& value) {
  return encodeURIComponent(value.isString() ? value.utf16() : toString(value));
}

Value decodeURIComponent(const std::u16string& value) {
  return Runtime::string(decodeUriComponentText(value));
}

Value decodeURIComponent(const Value& value) {
  return decodeURIComponent(value.isString() ? value.utf16() : toString(value));
}

Value encodeURI(const std::u16string& value) { return encodeURIComponent(value); }

Value encodeURI(const Value& value) { return encodeURIComponent(value); }

Value decodeURI(const std::u16string& value) { return decodeURIComponent(value); }

Value decodeURI(const Value& value) { return decodeURIComponent(value); }

Value escape(const std::u16string& value) { return encodeURIComponent(value); }

Value escape(const Value& value) { return encodeURIComponent(value); }

Value unescape(const std::u16string& value) { return decodeURIComponent(value); }

Value unescape(const Value& value) { return decodeURIComponent(value); }

}  // namespace vexa
