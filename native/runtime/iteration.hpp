#pragma once

// Internal runtime category header. Include runtime.hpp instead.

template <typename T>
inline ArrayObject<T>* arrayPointer(ArrayObject<T>* array) {
  return array;
}

template <typename T>
inline ArrayObject<T>* arrayPointer(const cppgc::Member<ArrayObject<T>>& array) {
  return array.Get();
}

template <typename T>
inline ArrayObject<T>* arrayPointer(const cppgc::Persistent<ArrayObject<T>>& array) {
  return array.Get();
}

template <typename T>
inline double arrayLength(const ArrayObject<T>* array) {
  if (!array) throw errorAtCurrentSource(u"Cannot read the length of null");
  return static_cast<double>(array->size());
}

template <typename T>
inline double arrayLength(const cppgc::Member<ArrayObject<T>>& array) {
  return arrayLength(array.Get());
}

template <typename T>
inline double arrayLength(const cppgc::Persistent<ArrayObject<T>>& array) {
  return arrayLength(array.Get());
}

inline double arrayLength(const Value& value) {
  if (!value.isRuntimeObject() || !value.object()->dynamicIsArray()) {
    throw errorAtCurrentSource(u"Value is not an array");
  }
  return static_cast<double>(value.object()->dynamicArraySize());
}

inline ArrayObject<Value>* arrayPointer(const Value& value) {
  if (!value.isRuntimeObject()) throw errorAtCurrentSource(u"Value is not an array");
  auto* array = static_cast<ArrayObject<Value>*>(
      value.object()->dynamicCast(nativeTypeToken<ArrayObject<Value>>()));
  if (array) return array;
  if (!value.object()->dynamicIsArray()) {
    throw errorAtCurrentSource(u"Value is not a dynamically typed array");
  }
  return makeDynamicArrayValueView(value.object());
}

class DynamicArrayRange final {
 public:
  explicit DynamicArrayRange(BaseObject* array) : array_(array) {}

  class Iterator final {
   public:
    Iterator(BaseObject* array, std::size_t index)
        : array_(array), index_(index) {}
    Value operator*() const { return array_->dynamicArrayGet(index_); }
    Iterator& operator++() { ++index_; return *this; }
    bool operator!=(const Iterator& other) const { return index_ != other.index_; }

   private:
    BaseObject* array_;
    std::size_t index_;
  };

  Iterator begin() const { return Iterator(array_.Get(), 0); }
  Iterator end() const { return Iterator(array_.Get(), array_->dynamicArraySize()); }

 private:
  cppgc::Persistent<BaseObject> array_;
};

inline DynamicArrayRange dynamicArrayRange(const Value& value) {
  if (!value.isRuntimeObject() || !value.object()->dynamicIsArray()) {
    throw errorAtCurrentSource(u"Value is not an array");
  }
  return DynamicArrayRange(value.object());
}

class DynamicIterationRange final {
 public:
  explicit DynamicIterationRange(BaseObject* iterable) : iterable_(iterable) {}

  class Iterator final {
   public:
    Iterator(BaseObject* iterable, std::size_t index)
        : iterable_(iterable), index_(index) {}
    Value operator*() const { return iterable_->dynamicIterableGet(index_); }
    Iterator& operator++() { ++index_; return *this; }
    bool operator!=(const Iterator& other) const { return index_ != other.index_; }

   private:
    BaseObject* iterable_;
    std::size_t index_;
  };

  Iterator begin() const { return Iterator(iterable_.Get(), 0); }
  Iterator end() const { return Iterator(iterable_.Get(), iterable_->dynamicIterableSize()); }

 private:
  cppgc::Persistent<BaseObject> iterable_;
};

inline DynamicIterationRange dynamicIterationRange(const Value& value) {
  if (!value.isRuntimeObject() || !value.object()->dynamicIsIterable()) {
    throw errorAtCurrentSource(u"Value is not iterable");
  }
  return DynamicIterationRange(value.object());
}

template <typename T>
inline DynamicIterationRange dynamicIterationRange(ArrayObject<T>* value) {
  if (!value) throw errorAtCurrentSource(u"Value is not iterable");
  return DynamicIterationRange(value);
}

template <typename T>
inline std::vector<T> dynamicIterationRange(std::vector<T> value) {
  return value;
}

template <typename T>
inline DynamicIterationRange dynamicIterationRange(const cppgc::Member<T>& value) {
  return dynamicIterationRange(Value(value.Get()));
}

template <typename T>
inline bool arrayIsArray(const ArrayObject<T>*) {
  return true;
}

template <typename T>
inline bool arrayIsArray(ArrayObject<T>*) {
  return true;
}

inline bool arrayIsArray(const Value& value) {
  return value.isRuntimeObject() && value.object()->dynamicIsArray();
}

template <typename T>
  requires requires(const T& value) { value.Get(); }
inline bool arrayIsArray(const T& value) {
  return arrayIsArray(value.Get());
}

template <typename T>
inline bool arrayIsArray(const T&) {
  return false;
}

inline std::vector<std::u16string> stringCharacters(const std::u16string& value) {
  std::vector<std::u16string> result;
  result.reserve(value.size());
  for (char character : value) result.emplace_back(1, character);
  return result;
}

inline std::vector<std::u16string> stringCharacters(const Value& value) {
  return stringCharacters(toString(value));
}
