#include "runtime.hpp"

namespace vexa {

bool includes(const std::vector<std::u16string>& array, const Value& value) {
  return includes(array, toString(value));
}

bool includes(const ArrayObject<std::u16string>* array, const Value& value) {
  return includes(array, toString(value));
}

double indexOf(const std::vector<std::u16string>& array, const Value& value) {
  return indexOf(array, toString(value));
}

double indexOf(const ArrayObject<std::u16string>* array, const Value& value) {
  return indexOf(array, toString(value));
}

}  // namespace vexa
