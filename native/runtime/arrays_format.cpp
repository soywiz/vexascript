#include "runtime.hpp"

namespace vexa {

std::u16string concatText(std::initializer_list<std::u16string_view> parts) {
  std::size_t size = 0;
  for (const auto part : parts) size += part.size();
  std::u16string result;
  result.reserve(size);
  for (const auto part : parts) result.append(part);
  return result;
}

std::u16string join(const std::vector<std::u16string>& array, const std::u16string& separator) {
  if (array.empty()) return std::u16string();
  std::size_t size = separator.size() * (array.size() - 1);
  for (const auto& value : array) size += value.size();
  std::u16string result;
  result.reserve(size);
  for (std::size_t index = 0; index < array.size(); ++index) {
    if (index > 0) result += separator;
    result += array[index];
  }
  return result;
}

std::u16string join(const ArrayObject<std::u16string>* array, const std::u16string& separator) {
  return array ? array->join(separator) : std::u16string();
}

std::u16string inspectValue(const BigInt& value) {
  return value.toString() + u"n";
}

std::u16string inspectValue(const Value& value) {
  if (value.isBigInt()) return inspectValue(value.bigint());
  if (value.isObject()) return value.object()->dynamicInspect();
  return toString(value);
}

}  // namespace vexa
