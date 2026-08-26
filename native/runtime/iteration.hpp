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

double arrayLength(const Value& value);

ArrayObject<Value>* arrayPointer(const Value& value);

class DynamicArrayRange final {
 public:
  explicit DynamicArrayRange(BaseObject* array);

  class Iterator final {
   public:
    Iterator(BaseObject* array, std::size_t index);
    Value operator*() const;
    Iterator& operator++();
    bool operator!=(const Iterator& other) const;

   private:
    BaseObject* array_;
    std::size_t index_;
  };

  Iterator begin() const;
  Iterator end() const;

 private:
  cppgc::Persistent<BaseObject> array_;
};

DynamicArrayRange dynamicArrayRange(const Value& value);

class DynamicIterationRange final {
 public:
  explicit DynamicIterationRange(BaseObject* iterable);

  class Iterator final {
   public:
    Iterator(BaseObject* iterable, std::size_t index);
    Value operator*() const;
    Iterator& operator++();
    bool operator!=(const Iterator& other) const;

   private:
    BaseObject* iterable_;
    std::size_t index_;
  };

  Iterator begin() const;
  Iterator end() const;

 private:
  cppgc::Persistent<BaseObject> iterable_;
};

DynamicIterationRange dynamicIterationRange(const Value& value);

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

bool arrayIsArray(const Value& value);

template <typename T>
  requires requires(const T& value) { value.Get(); }
inline bool arrayIsArray(const T& value) {
  return arrayIsArray(value.Get());
}

template <typename T>
inline bool arrayIsArray(const T&) {
  return false;
}

std::vector<std::u16string> stringCharacters(const std::u16string& value);

std::vector<std::u16string> stringCharacters(const Value& value);
