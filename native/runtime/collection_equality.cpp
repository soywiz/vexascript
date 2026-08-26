#include "runtime.hpp"

namespace vexa {

bool sameValueZero(double left, double right) {
  return left == right || (std::isnan(left) && std::isnan(right));
}

bool sameValueZero(const Value& left, const Value& right) {
  return left == right || (left.isNumber() && right.isNumber() &&
      std::isnan(left.number()) && std::isnan(right.number()));
}

std::size_t SameValueZeroHash<Value>::operator()(const Value& value) const {
    if (value.isUndefined()) return 0x11;
    if (value.isNull()) return 0x23;
    if (value.isBoolean()) return value.boolean() ? 0x37 : 0x41;
    if (value.isNumber()) {
      if (std::isnan(value.number())) return 0x53;
      const double normalized = value.number() == 0 ? 0 : value.number();
      return std::hash<double>{}(normalized) ^ 0x67;
    }
    if (value.isBigInt()) {
      return std::hash<std::u16string>{}(value.bigint().toString()) ^ 0x79;
    }
    if (value.isString()) return std::hash<std::u16string>{}(value.utf16()) ^ 0x83;
    if (value.isRecord()) return std::hash<const void*>{}(value.record()) ^ 0x97;
    return std::hash<const void*>{}(value.object()) ^ 0xa9;
  }

}  // namespace vexa
