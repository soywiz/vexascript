#include "runtime.hpp"

namespace vexa {

const std::u16string& toText(const std::u16string& value) { return value; }

std::u16string toText(std::u16string&& value) { return std::move(value); }

std::u16string toText(const Value& value) {
  if (value.isString()) return value.utf16();
  throw errorAtCurrentSource(u"VexaScript value is not a string");
}

bool toBoolean(bool value) { return value; }

bool toBoolean(Undefined) { return false; }

bool toBoolean(double value) { return value != 0 && !std::isnan(value); }

bool toBoolean(std::int32_t value) { return value != 0; }

bool toBoolean(const Value& value) {
  if (value.isBoolean()) return value.boolean();
  if (value.isNumber()) return toBoolean(value.number());
  if (value.isBigInt()) return !value.bigint().isZero();
  return !value.isUndefined() && !value.isNull();
}

double toDouble(double value) { return value; }

double toDouble(std::int32_t value) { return static_cast<double>(value); }

double toDouble(bool value) { return static_cast<double>(value); }

double toDouble(const Value& value) {
  if (value.isNumber()) return value.number();
  if (value.isBoolean()) return static_cast<double>(value.boolean());
  if (value.isBigInt()) return value.bigint().toDouble();
  throw errorAtCurrentSource(u"VexaScript value is not numeric");
}

std::int32_t toNativeInt32(std::int32_t value) { return value; }

std::int32_t toNativeInt32(double value) { return static_cast<std::int32_t>(value); }

std::int32_t toNativeInt32(bool value) { return static_cast<std::int32_t>(value); }

std::int32_t toNativeInt32(const Value& value) { return static_cast<std::int32_t>(toDouble(value)); }

BigInt toBigInt(const BigInt& value) { return value; }

BigInt toBigInt(BigInt&& value) { return std::move(value); }

BigInt toBigInt(const Value& value) {
  if (value.isBigInt()) return value.bigint();
  if (value.isBoolean()) return BigInt(value.boolean() ? 1 : 0);
  if (value.isNumber() && std::isfinite(value.number()) && std::trunc(value.number()) == value.number()) {
    return BigInt(formatFixedText(value.number(), 0));
  }
  if (value.isString()) return BigInt(value.string());
  throw runtimeError(u"VexaScript value cannot be converted to bigint");
}

Undefined toUndefined(Undefined value) { return value; }

Undefined toUndefined(const Value& value) {
  if (!value.isUndefined()) throw runtimeError(u"VexaScript value is not undefined");
  return {};
}

Null toNull(Null value) { return value; }

Null toNull(const Value& value) {
  if (!value.isNull()) throw errorAtCurrentSource(u"VexaScript value is not null");
  return {};
}

Error toError(Error value) { return value; }

Value toValue(Value value) { return value; }

Value toValue(const StoredValue& value) { return value.load(); }

Value toValue(Undefined) { return Value::undefined(); }

Value toValue(Null) { return Value::null(); }

Value toValue(std::nullptr_t) { return Value::null(); }

Value toValue(bool value) { return Value(value); }

Value toValue(double value) { return Value(value); }

Value toValue(float value) { return Value(static_cast<double>(value)); }

Value toValue(std::int32_t value) { return Value(static_cast<double>(value)); }

Value toValue(std::uint32_t value) { return Value(static_cast<double>(value)); }

Value toValue(std::int64_t value) { return Value(static_cast<double>(value)); }

Value toValue(std::uint64_t value) { return Value(static_cast<double>(value)); }

Value toValue(BigInt value) { return Value(std::move(value)); }

Value toValue(const std::u16string& value) { return Runtime::string(value); }

Value toValue(std::u16string&& value) { return Runtime::string(std::move(value)); }

}  // namespace vexa
