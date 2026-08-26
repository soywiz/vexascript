#include "runtime.hpp"

namespace vexa {

const std::u16string& propertyKey(const std::u16string& value) { return value; }

std::u16string propertyKey(double value) {
  return formatNumberText(value);
}

std::u16string propertyKey(std::int32_t value) { return formatIntegerText(value); }

std::u16string propertyKey(std::int64_t value) { return formatIntegerText(value); }

std::u16string propertyKey(const BigInt& value) { return value.toString(); }

std::u16string propertyKey(bool value) { return value ? u"true" : u"false"; }

std::u16string propertyKey(const Value& value) {
  if (value.isString()) return value.utf16();
  if (value.isNumber()) return propertyKey(value.number());
  if (value.isBigInt()) return propertyKey(value.bigint());
  if (value.isBoolean()) return propertyKey(value.boolean());
  if (value.isNull()) return u"null";
  if (value.isUndefined()) return u"undefined";
  if (value.isRuntimeObject()) return value.object()->dynamicToString();
  return u"[object Object]";
}

}  // namespace vexa
