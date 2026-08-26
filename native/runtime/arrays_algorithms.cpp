#include "runtime.hpp"

namespace vexa {

void appendAll(ArrayObject<std::u16string>* target, const std::u16string& source) {
  target->reserve(target->size() + source.size());
  for (std::size_t index = 0; index < source.size(); ++index) {
    const char16_t first = source[index];
    const bool hasSurrogatePair = first >= 0xD800 && first <= 0xDBFF &&
      index + 1 < source.size() && source[index + 1] >= 0xDC00 && source[index + 1] <= 0xDFFF;
    target->append(source.substr(index, hasSurrogatePair ? 2 : 1));
    if (hasSurrogatePair) ++index;
  }
}

void appendAllConverted(ArrayObject<Value>* target, const std::u16string& source) {
  target->reserve(target->size() + source.size());
  for (std::size_t index = 0; index < source.size(); ++index) {
    const char16_t first = source[index];
    const bool hasSurrogatePair = first >= 0xD800 && first <= 0xDBFF &&
      index + 1 < source.size() && source[index + 1] >= 0xDC00 && source[index + 1] <= 0xDFFF;
    target->append(Runtime::string(source.substr(index, hasSurrogatePair ? 2 : 1)));
    if (hasSurrogatePair) ++index;
  }
}

void appendAllConverted(ArrayObject<Value>* target, const Value& source) {
  for (const auto value : dynamicIterationRange(source)) {
    target->append(value);
  }
}

std::size_t normalizedSliceIndex(double index, std::size_t size) {
  const auto integer = static_cast<std::int64_t>(index);
  if (integer < 0) return static_cast<std::size_t>(std::max<std::int64_t>(0, static_cast<std::int64_t>(size) + integer));
  return std::min<std::size_t>(static_cast<std::size_t>(integer), size);
}

bool arrayCallbackBoolean(const Value& value) {
  if (value.isUndefined() || value.isNull()) return false;
  if (value.isBoolean()) return value.boolean();
  if (value.isNumber()) return value.number() != 0 && !std::isnan(value.number());
  return !value.isString() || !value.utf16().empty();
}

bool arrayCallbackBoolean(const std::u16string& value) { return !value.empty(); }

}  // namespace vexa
