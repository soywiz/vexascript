#include "runtime.hpp"

namespace vexa {

double arrayLength(const Value& value) {
  if (!value.isRuntimeObject() || !value.object()->dynamicIsArray()) {
    throw errorAtCurrentSource(u"Value is not an array");
  }
  return static_cast<double>(value.object()->dynamicArraySize());
}

ArrayObject<Value>* arrayPointer(const Value& value) {
  if (!value.isRuntimeObject()) throw errorAtCurrentSource(u"Value is not an array");
  auto* array = static_cast<ArrayObject<Value>*>(
      value.object()->dynamicCast(nativeTypeToken<ArrayObject<Value>>()));
  if (array) return array;
  if (!value.object()->dynamicIsArray()) {
    throw errorAtCurrentSource(u"Value is not a dynamically typed array");
  }
  return makeDynamicArrayValueView(value.object());
}

Value DynamicArrayRange::Iterator::operator*() const { return array_->dynamicArrayGet(index_); }

DynamicArrayRange::Iterator& DynamicArrayRange::Iterator::operator++() { ++index_; return *this; }

bool DynamicArrayRange::Iterator::operator!=(const Iterator& other) const { return index_ != other.index_; }

DynamicArrayRange::Iterator DynamicArrayRange::begin() const { return Iterator(array_.Get(), 0); }

DynamicArrayRange::Iterator DynamicArrayRange::end() const { return Iterator(array_.Get(), array_->dynamicArraySize()); }

DynamicArrayRange dynamicArrayRange(const Value& value) {
  if (!value.isRuntimeObject() || !value.object()->dynamicIsArray()) {
    throw errorAtCurrentSource(u"Value is not an array");
  }
  return DynamicArrayRange(value.object());
}

Value DynamicIterationRange::Iterator::operator*() const { return iterable_->dynamicIterableGet(index_); }

DynamicIterationRange::Iterator& DynamicIterationRange::Iterator::operator++() { ++index_; return *this; }

bool DynamicIterationRange::Iterator::operator!=(const Iterator& other) const { return index_ != other.index_; }

DynamicIterationRange::Iterator DynamicIterationRange::begin() const { return Iterator(iterable_.Get(), 0); }

DynamicIterationRange::Iterator DynamicIterationRange::end() const { return Iterator(iterable_.Get(), iterable_->dynamicIterableSize()); }

DynamicIterationRange dynamicIterationRange(const Value& value) {
  if (!value.isRuntimeObject() || !value.object()->dynamicIsIterable()) {
    throw errorAtCurrentSource(u"Value is not iterable");
  }
  return DynamicIterationRange(value.object());
}

bool arrayIsArray(const Value& value) {
  return value.isRuntimeObject() && value.object()->dynamicIsArray();
}

std::vector<std::u16string> stringCharacters(const std::u16string& value) {
  std::vector<std::u16string> result;
  result.reserve(value.size());
  for (char character : value) result.emplace_back(1, character);
  return result;
}

std::vector<std::u16string> stringCharacters(const Value& value) {
  return stringCharacters(toString(value));
}


DynamicArrayRange::DynamicArrayRange(BaseObject* array) : array_(array) {}

DynamicArrayRange::Iterator::Iterator(BaseObject* array, std::size_t index)
        : array_(array), index_(index) {}

DynamicIterationRange::DynamicIterationRange(BaseObject* iterable) : iterable_(iterable) {}

DynamicIterationRange::Iterator::Iterator(BaseObject* iterable, std::size_t index)
        : iterable_(iterable), index_(index) {}
}  // namespace vexa
