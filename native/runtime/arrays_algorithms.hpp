#pragma once

// Internal runtime category header. Include runtime.hpp instead.

template <typename T, typename... Values>
inline double push(std::vector<T>& array, Values&&... values) {
  (array.push_back(std::forward<Values>(values)), ...);
  return static_cast<double>(array.size());
}

template <typename T, typename... Values>
inline double push(ArrayObject<T>* array, Values&&... values) {
  (array->push(convertValue<T>(std::forward<Values>(values))), ...);
  return static_cast<double>(array->size());
}

template <typename T>
inline void appendAll(std::vector<T>& target, const std::vector<T>& source) {
  target.insert(target.end(), source.begin(), source.end());
}

template <typename T>
inline void appendAll(ArrayObject<T>* target, const ArrayObject<T>* source) {
  target->reserve(target->size() + source->size());
  for (std::size_t index = 0; index < source->size(); ++index) {
    target->append(source->get(index));
  }
}

template <typename T, typename U>
  requires (!std::is_same_v<T, U>)
inline void appendAll(ArrayObject<T>* target, const ArrayObject<U>* source) {
  target->reserve(target->size() + source->size());
  for (std::size_t index = 0; index < source->size(); ++index) {
    target->append(convertValue<T>(source->get(index)));
  }
}

template <typename T>
inline void appendAll(ArrayObject<T>* target, SetObject* source) {
  source->forEach([&](Value value, Value, SetObject*) {
    target->append(convertValue<T>(value));
  });
}

void appendAll(ArrayObject<std::u16string>* target, const std::u16string& source);

template <typename T>
inline void appendAll(ArrayObject<T>* target, const Value& source) {
    for (const auto value : dynamicIterationRange(source)) {
    target->append(convertValue<T>(value));
  }
}

template <typename T>
inline double pushAll(ArrayObject<T>* target, const ArrayObject<T>* source) {
  appendAll(target, source);
  return static_cast<double>(target->size());
}

template <typename T>
inline void appendAllConverted(std::vector<Value>& target, const std::vector<T>& source) {
  target.reserve(target.size() + source.size());
  for (const auto& value : source) target.push_back(convertValue<Value>(value));
}

template <typename T>
inline void appendAllConverted(ArrayObject<Value>* target, const ArrayObject<T>* source) {
  target->reserve(target->size() + source->size());
  for (std::size_t index = 0; index < source->size(); ++index) {
    target->append(convertValue<Value>(source->get(index)));
  }
}

void appendAllConverted(ArrayObject<Value>* target, const std::u16string& source);

inline void appendAllConverted(ArrayObject<Value>* target, MapObject* source) {
  source->forEach([&](Value value, Value key, MapObject*) {
    target->append(toValue(Runtime::array<Value>({key, value})));
  });
}

inline void appendAllConverted(
    ArrayObject<Value>* target,
    const cppgc::Persistent<MapObject>& source) {
  appendAllConverted(target, source.Get());
}

inline void appendAllConverted(ArrayObject<Value>* target, SetObject* source) {
  source->forEach([&](Value value, Value, SetObject*) { target->append(value); });
}

inline void appendAllConverted(
    ArrayObject<Value>* target,
    const cppgc::Persistent<SetObject>& source) {
  appendAllConverted(target, source.Get());
}

void appendAllConverted(ArrayObject<Value>* target, const Value& source);

template <typename T, typename U>
inline bool includes(const std::vector<T>& array, const U& value) {
  return std::any_of(array.begin(), array.end(), [&](const T& element) {
    return sameValueZero(element, value);
  });
}

template <typename T>
template <typename U>
inline bool ArrayObject<T>::includes(const U& value) const {
  for (const auto element : *this) if (sameValueZero(element, value)) return true;
  return false;
}

template <typename T, typename U>
inline bool includes(const ArrayObject<T>* array, const U& value) {
  return array->includes(value);
}

template <typename T, typename U>
inline double indexOf(const std::vector<T>& array, const U& value) {
  const auto iterator = std::find(array.begin(), array.end(), value);
  return iterator == array.end()
      ? -1
      : static_cast<double>(std::distance(array.begin(), iterator));
}

template <typename T>
template <typename U>
inline double ArrayObject<T>::indexOf(const U& value) const {
  for (std::size_t index = 0; index < size(); ++index) {
    if (sameValueZero(get(index), value)) return static_cast<double>(index);
  }
  return -1;
}

template <typename T, typename U>
inline double indexOf(const ArrayObject<T>* array, const U& value) {
  return array->indexOf(value);
}

template <typename T>
template <typename U>
inline double ArrayObject<T>::lastIndexOf(const U& value) const {
  for (std::size_t index = size(); index > 0; --index) {
    if (sameValueZero(get(index - 1), value)) return static_cast<double>(index - 1);
  }
  return -1;
}

template <typename T, typename U>
inline double lastIndexOf(const ArrayObject<T>* array, const U& value) {
  return array->lastIndexOf(value);
}

template <typename T>
inline T ArrayObject<T>::at(double index) const {
  const auto integer = static_cast<std::int64_t>(index);
  const auto resolved = integer < 0 ? static_cast<std::int64_t>(size()) + integer : integer;
  return resolved < 0 || resolved >= static_cast<std::int64_t>(size())
      ? T{}
      : get(static_cast<std::size_t>(resolved));
}

template <typename T>
inline T at(const ArrayObject<T>* array, double index) {
  return array->at(index);
}

template <typename T>
inline std::vector<T>& reverse(std::vector<T>& array) {
  std::reverse(array.begin(), array.end());
  return array;
}

template <typename T>
inline ArrayObject<T>* reverse(ArrayObject<T>* array) {
  return array->reverse();
}

template <typename T>
inline T pop(std::vector<T>& array) {
  if (array.empty()) return T{};
  T value = std::move(array.back());
  array.pop_back();
  return value;
}

template <typename T>
inline T pop(ArrayObject<T>* array) {
  return array->pop();
}

template <typename T>
inline T shift(std::vector<T>& array) {
  if (array.empty()) return T{};
  T value = std::move(array.front());
  array.erase(array.begin());
  return value;
}

template <typename T>
inline T shift(ArrayObject<T>* array) {
  return array->shift();
}

template <typename T, typename... Values>
inline double unshift(std::vector<T>& array, Values&&... values) {
  std::vector<T> prefix{std::forward<Values>(values)...};
  array.insert(array.begin(), std::make_move_iterator(prefix.begin()), std::make_move_iterator(prefix.end()));
  return static_cast<double>(array.size());
}

template <typename T, typename... Values>
inline double unshift(ArrayObject<T>* array, Values&&... values) {
  std::vector<T> prefix{static_cast<T>(std::forward<Values>(values))...};
  for (auto iterator = prefix.rbegin(); iterator != prefix.rend(); ++iterator) array->unshift(*iterator);
  return static_cast<double>(array->size());
}

std::size_t normalizedSliceIndex(double index, std::size_t size);

template <typename T>
inline std::vector<T> slice(const std::vector<T>& array, double start = 0, double end = std::numeric_limits<double>::infinity()) {
  const std::size_t first = normalizedSliceIndex(start, array.size());
  const std::size_t last = std::isinf(end) ? array.size() : normalizedSliceIndex(end, array.size());
  if (last <= first) return {};
  return std::vector<T>(array.begin() + static_cast<std::ptrdiff_t>(first), array.begin() + static_cast<std::ptrdiff_t>(last));
}

template <typename T>
inline ArrayObject<T>* ArrayObject<T>::slice(double start, double end) const {
  auto* result = Runtime::array<T>();
  const std::size_t first = normalizedSliceIndex(start, size());
  const std::size_t last = std::isinf(end) ? size() : normalizedSliceIndex(end, size());
  result->reserve(last > first ? last - first : 0);
  for (std::size_t index = first; index < last; ++index) result->append(get(index));
  return result;
}

template <typename T>
inline ArrayObject<T>* slice(const ArrayObject<T>* array, double start = 0, double end = std::numeric_limits<double>::infinity()) {
  return array->slice(start, end);
}

template <typename T>
inline std::vector<T> concat(const std::vector<T>& array, const std::vector<T>& other) {
  std::vector<T> result = array;
  result.insert(result.end(), other.begin(), other.end());
  return result;
}

template <typename T>
inline void appendConcatItem(ArrayObject<T>* result, T value) {
  result->append(std::move(value));
}

template <typename T>
inline void appendConcatItem(ArrayObject<T>* result, const ArrayObject<T>* values) {
  appendAll(result, values);
}

template <typename T>
template <typename... Items>
inline ArrayObject<T>* ArrayObject<T>::concat(Items&&... items) const {
  auto* result = Runtime::array<T>();
  appendAll(result, this);
  (appendConcatItem(result, std::forward<Items>(items)), ...);
  return result;
}

template <typename T, typename... Items>
inline ArrayObject<T>* concat(const ArrayObject<T>* array, Items&&... items) {
  return array->concat(std::forward<Items>(items)...);
}

template <typename Callback, typename T>
inline decltype(auto) invokeArrayCallback(
    Callback& callback,
    T value,
    std::size_t index,
    const ArrayObject<T>* array) {
  auto* mutableArray = const_cast<ArrayObject<T>*>(array);
  if constexpr (std::is_invocable_v<Callback, T, double, ArrayObject<T>*>) {
    return callback(std::move(value), static_cast<double>(index), mutableArray);
  } else if constexpr (std::is_invocable_v<Callback, T, double>) {
    return callback(std::move(value), static_cast<double>(index));
  } else if constexpr (std::is_invocable_v<Callback, T>) {
    return callback(std::move(value));
  } else {
    return callback();
  }
}

template <typename Callback, typename Accumulator, typename T>
inline decltype(auto) invokeArrayReduceCallback(
    Callback& callback,
    Accumulator accumulator,
    T value,
    std::size_t index,
    const ArrayObject<T>* array) {
  auto* mutableArray = const_cast<ArrayObject<T>*>(array);
  if constexpr (std::is_invocable_v<Callback, Accumulator, T, double, ArrayObject<T>*>) {
    return callback(std::move(accumulator), std::move(value), static_cast<double>(index), mutableArray);
  } else if constexpr (std::is_invocable_v<Callback, Accumulator, T, double>) {
    return callback(std::move(accumulator), std::move(value), static_cast<double>(index));
  } else {
    return callback(std::move(accumulator), std::move(value));
  }
}

bool arrayCallbackBoolean(const Value& value);

bool arrayCallbackBoolean(const std::u16string& value);

template <typename T>
inline bool arrayCallbackBoolean(const T& value) {
  if constexpr (std::is_pointer_v<T>) return value != nullptr;
  else return static_cast<bool>(value);
}

template <typename T, typename Callback>
inline auto map(const std::vector<T>& array, Callback callback)
    -> std::vector<std::remove_cvref_t<std::invoke_result_t<Callback, T>>> {
  using Result = std::remove_cvref_t<std::invoke_result_t<Callback, T>>;
  std::vector<Result> result;
  result.reserve(array.size());
  for (const auto& value : array) result.push_back(callback(value));
  return result;
}

template <typename T>
template <typename Callback>
inline auto ArrayObject<T>::map(Callback callback) const {
  using Result = std::remove_cvref_t<decltype(
      invokeArrayCallback(callback, std::declval<T>(), std::size_t{}, this))>;
  auto* result = Runtime::array<Result>();
  result->reserve(size());
  for (std::size_t index = 0; index < size(); ++index) {
    result->append(invokeArrayCallback(callback, get(index), index, this));
  }
  return result;
}

template <typename T, typename Callback>
inline auto map(const ArrayObject<T>* array, Callback callback) {
  using Result = decltype(array->map(std::move(callback)));
  return array ? array->map(std::move(callback)) : static_cast<Result>(nullptr);
}

template <typename T, typename Callback>
inline std::vector<T> filter(const std::vector<T>& array, Callback callback) {
  std::vector<T> result;
  for (const auto& value : array) if (callback(value)) result.push_back(value);
  return result;
}

template <typename T>
template <typename Callback>
inline ArrayObject<T>* ArrayObject<T>::filter(Callback callback) const {
  auto* result = Runtime::array<T>();
  result->reserve(size());
  for (std::size_t index = 0; index < size(); ++index) {
    const auto value = get(index);
    if (arrayCallbackBoolean(invokeArrayCallback(callback, value, index, this))) result->append(value);
  }
  return result;
}

template <typename T, typename Callback>
inline ArrayObject<T>* filter(const ArrayObject<T>* array, Callback callback) {
  return array->filter(std::move(callback));
}

template <typename T>
inline ArrayObject<T>* flat(
    const ArrayObject<ArrayObject<T>*>* array,
    double depth = 1) {
  if (depth != 1) {
    throw runtimeError(u"Native Array.flat currently supports the default depth of one");
  }
  auto* result = Runtime::array<T>();
  for (std::size_t index = 0; index < array->size(); ++index) {
    ArrayObject<T>* nested = array->get(index);
    if (nested) appendAll(result, nested);
  }
  return result;
}

template <typename T>
struct ArrayPointerElement;

template <typename T>
struct ArrayPointerElement<ArrayObject<T>*> final {
  using Type = T;
};

template <typename T, typename Callback>
inline auto flatMap(const ArrayObject<T>* array, Callback callback) {
  using NestedArray = std::remove_cvref_t<decltype(
      invokeArrayCallback(callback, std::declval<T>(), std::size_t{}, array))>;
  using Result = typename ArrayPointerElement<NestedArray>::Type;
  auto* result = Runtime::array<Result>();
  for (std::size_t index = 0; index < array->size(); ++index) {
    NestedArray nested = invokeArrayCallback(callback, array->get(index), index, array);
    if (nested) appendAll(result, nested);
  }
  return result;
}

template <typename T, typename Callback, typename Accumulator>
inline Accumulator reduce(const std::vector<T>& array, Callback callback, Accumulator initial) {
  for (const auto& value : array) initial = callback(std::move(initial), value);
  return initial;
}

template <typename T>
template <typename Callback, typename Accumulator>
inline Accumulator ArrayObject<T>::reduce(Callback callback, Accumulator initial) const {
  for (std::size_t index = 0; index < size(); ++index) {
    const auto value = get(index);
    initial = invokeArrayReduceCallback(callback, std::move(initial), value, index, this);
  }
  return initial;
}

template <typename T, typename Callback, typename Accumulator>
inline Accumulator reduce(const ArrayObject<T>* array, Callback callback, Accumulator initial) {
  return array->reduce(std::move(callback), std::move(initial));
}

template <typename T>
template <typename Callback, typename Accumulator>
inline Accumulator ArrayObject<T>::reduceRight(Callback callback, Accumulator initial) const {
  for (std::size_t index = size(); index > 0; --index) {
    const std::size_t candidate = index - 1;
    initial = invokeArrayReduceCallback(callback, std::move(initial), get(candidate), candidate, this);
  }
  return initial;
}

template <typename T, typename Callback, typename Accumulator>
inline Accumulator reduceRight(const ArrayObject<T>* array, Callback callback, Accumulator initial) {
  return array->reduceRight(std::move(callback), std::move(initial));
}

template <typename T>
template <typename Callback>
inline void ArrayObject<T>::forEach(Callback callback) const {
  for (std::size_t index = 0; index < size(); ++index) {
    invokeArrayCallback(callback, get(index), index, this);
  }
}

template <typename T, typename Callback>
inline void forEach(const ArrayObject<T>* array, Callback callback) {
  array->forEach(std::move(callback));
}

template <typename T>
template <typename Callback>
inline bool ArrayObject<T>::some(Callback callback) const {
  for (std::size_t index = 0; index < size(); ++index) {
    if (arrayCallbackBoolean(invokeArrayCallback(callback, get(index), index, this))) return true;
  }
  return false;
}

template <typename T, typename Callback>
inline bool some(const ArrayObject<T>* array, Callback callback) {
  return array->some(std::move(callback));
}

template <typename T>
template <typename Callback>
inline bool ArrayObject<T>::every(Callback callback) const {
  for (std::size_t index = 0; index < size(); ++index) {
    if (!arrayCallbackBoolean(invokeArrayCallback(callback, get(index), index, this))) return false;
  }
  return true;
}

template <typename T, typename Callback>
inline bool every(const ArrayObject<T>* array, Callback callback) {
  return array->every(std::move(callback));
}

template <typename T>
template <typename Callback>
inline double ArrayObject<T>::findIndex(Callback callback) const {
  for (std::size_t index = 0; index < size(); ++index) {
    if (arrayCallbackBoolean(invokeArrayCallback(callback, get(index), index, this))) {
      return static_cast<double>(index);
    }
  }
  return -1;
}

template <typename T, typename Callback>
inline double findIndex(const ArrayObject<T>* array, Callback callback) {
  return array->findIndex(std::move(callback));
}

template <typename T>
template <typename Callback>
inline T ArrayObject<T>::find(Callback callback) const {
  for (std::size_t index = 0; index < size(); ++index) {
    const auto value = get(index);
    if (arrayCallbackBoolean(invokeArrayCallback(callback, value, index, this))) return value;
  }
  return T{};
}

template <typename T, typename Callback>
inline T find(const ArrayObject<T>* array, Callback callback) {
  return array->find(std::move(callback));
}

template <typename T>
template <typename Callback>
inline double ArrayObject<T>::findLastIndex(Callback callback) const {
  for (std::size_t index = size(); index > 0; --index) {
    const std::size_t candidate = index - 1;
    if (arrayCallbackBoolean(invokeArrayCallback(callback, get(candidate), candidate, this))) {
      return static_cast<double>(candidate);
    }
  }
  return -1;
}

template <typename T, typename Callback>
inline double findLastIndex(const ArrayObject<T>* array, Callback callback) {
  return array->findLastIndex(std::move(callback));
}

template <typename T>
template <typename Callback>
inline T ArrayObject<T>::findLast(Callback callback) const {
  for (std::size_t index = size(); index > 0; --index) {
    const std::size_t candidate = index - 1;
    const auto value = get(candidate);
    if (arrayCallbackBoolean(invokeArrayCallback(callback, value, candidate, this))) return value;
  }
  return T{};
}

template <typename T, typename Callback>
inline T findLast(const ArrayObject<T>* array, Callback callback) {
  return array->findLast(std::move(callback));
}

template <typename T>
inline ArrayObject<T>* ArrayObject<T>::toReversed() const {
  auto* result = Runtime::array<T>();
  result->reserve(size());
  for (std::size_t index = size(); index > 0; --index) result->append(get(index - 1));
  return result;
}

template <typename T>
inline ArrayObject<T>* toReversed(const ArrayObject<T>* array) {
  return array->toReversed();
}

template <typename T>
inline ArrayObject<T>* ArrayObject<T>::take(double limit) const {
  return slice(0, std::max(0.0, std::trunc(limit)));
}

template <typename T>
inline ArrayObject<T>* take(const ArrayObject<T>* array, double limit) {
  return array->take(limit);
}

template <typename T>
inline ArrayObject<T>* ArrayObject<T>::drop(double count) const {
  return slice(std::max(0.0, std::trunc(count)));
}

template <typename T>
inline ArrayObject<T>* drop(const ArrayObject<T>* array, double count) {
  return array->drop(count);
}

template <typename T>
inline ArrayObject<T>* ArrayObject<T>::toArray() const {
  return slice();
}

template <typename T>
inline ArrayObject<T>* ArrayObject<T>::values() const {
  return slice();
}

template <typename T>
inline ArrayObject<double>* ArrayObject<T>::keys() const {
  auto* result = Runtime::array<double>();
  result->reserve(size());
  for (std::size_t index = 0; index < size(); ++index) result->append(static_cast<double>(index));
  return result;
}

template <typename T>
inline ArrayObject<ArrayObject<Value>*>* ArrayObject<T>::entries() const {
  auto* result = Runtime::array<ArrayObject<Value>*>();
  result->reserve(size());
  for (std::size_t index = 0; index < size(); ++index) {
    auto* entry = Runtime::array<Value>();
    entry->append(Value(static_cast<double>(index)));
    entry->append(convertValue<Value>(get(index)));
    result->append(entry);
  }
  return result;
}

template <typename T>
inline ArrayObject<T>* toArray(const ArrayObject<T>* array) {
  return array->toArray();
}

template <typename T>
inline ArrayObject<T>* values(const ArrayObject<T>* array) {
  return array->values();
}

template <typename T>
inline ArrayObject<double>* keys(const ArrayObject<T>* array) {
  return array->keys();
}

template <typename T>
inline ArrayObject<ArrayObject<Value>*>* entries(const ArrayObject<T>* array) {
  return array->entries();
}

template <typename T>
inline ArrayObject<T>* ArrayObject<T>::toSorted() const {
  auto* result = slice();
  result->sort();
  return result;
}

template <typename T>
template <typename Callback>
inline ArrayObject<T>* ArrayObject<T>::toSorted(Callback callback) const {
  auto* result = slice();
  result->sort(std::move(callback));
  return result;
}

template <typename T>
inline ArrayObject<T>* toSorted(const ArrayObject<T>* array) {
  return array->toSorted();
}

template <typename T, typename Callback>
inline ArrayObject<T>* toSorted(const ArrayObject<T>* array, Callback callback) {
  return array->toSorted(std::move(callback));
}

template <typename T>
template <typename... Items>
inline ArrayObject<T>* ArrayObject<T>::toSpliced(
    double start,
    double deleteCount,
    Items&&... items) const {
  auto* result = slice();
  result->splice(start, deleteCount, std::forward<Items>(items)...);
  return result;
}

template <typename T, typename... Items>
inline ArrayObject<T>* toSpliced(
    const ArrayObject<T>* array,
    double start,
    double deleteCount,
    Items&&... items) {
  return array->toSpliced(start, deleteCount, std::forward<Items>(items)...);
}

template <typename T>
inline ArrayObject<T>* ArrayObject<T>::with(double index, T value) const {
  const auto integer = static_cast<std::int64_t>(std::trunc(index));
  const auto resolved = integer < 0 ? static_cast<std::int64_t>(size()) + integer : integer;
  if (resolved < 0 || resolved >= static_cast<std::int64_t>(size())) {
    throw runtimeError(u"Array.with index is outside the array");
  }
  auto* result = slice();
  result->set(static_cast<std::size_t>(resolved), std::move(value));
  return result;
}

template <typename T>
inline ArrayObject<T>* with(const ArrayObject<T>* array, double index, T value) {
  return array->with(index, std::move(value));
}

template <typename T>
template <typename... Items>
inline ArrayObject<T>* ArrayObject<T>::splice(
    double start,
    double deleteCount,
    Items&&... items) {
  const std::size_t first = normalizedSliceIndex(start, size());
  const std::size_t requested = std::isinf(deleteCount)
      ? size() - first
      : static_cast<std::size_t>(std::max(0.0, std::trunc(deleteCount)));
  const std::size_t count = std::min(requested, size() - first);
  auto* removed = Runtime::array<T>();
  for (std::size_t index = 0; index < count; ++index) removed->append(get(first + index));
  values_.erase(
      values_.begin() + static_cast<std::ptrdiff_t>(first),
      values_.begin() + static_cast<std::ptrdiff_t>(first + count));
  std::vector<typename ArrayObject<T>::Slot> inserted{
      ([&]() -> typename ArrayObject<T>::Slot {
        if constexpr (IsDynamicArrayElement<T>) {
          return StoredValue(convertValue<Value>(std::forward<Items>(items)));
        } else {
          return ArraySlot<T>(convertValue<T>(std::forward<Items>(items)));
        }
      }())...};
  values_.insert(
      values_.begin() + static_cast<std::ptrdiff_t>(first),
      std::make_move_iterator(inserted.begin()),
      std::make_move_iterator(inserted.end()));
  return removed;
}

template <typename T, typename... Items>
inline ArrayObject<T>* splice(
    ArrayObject<T>* array,
    double start,
    double deleteCount,
    Items&&... items) {
  return array->splice(start, deleteCount, std::forward<Items>(items)...);
}

template <typename T, typename Input>
inline ArrayObject<T>* spliceAll(
    ArrayObject<T>* array,
    double start,
    double deleteCount,
    const ArrayObject<Input>* items) {
  const std::size_t first = normalizedSliceIndex(start, array->size());
  auto* removed = array->splice(start, deleteCount);
  std::size_t offset = 0;
  for (const auto& item : *items) {
    array->insert(first + offset, convertValue<T>(item));
    ++offset;
  }
  return removed;
}

template <typename T>
inline ArrayObject<T>* ArrayObject<T>::fill(T value, double start, double end) {
  const std::size_t first = normalizedSliceIndex(start, size());
  const std::size_t last = std::isinf(end) ? size() : normalizedSliceIndex(end, size());
  for (std::size_t index = first; index < last; ++index) set(index, value);
  return this;
}

template <typename T>
inline ArrayObject<T>* fill(
    ArrayObject<T>* array,
    T value,
    double start = 0,
    double end = std::numeric_limits<double>::infinity()) {
  return array->fill(std::move(value), start, end);
}

template <typename T>
inline ArrayObject<T>* ArrayObject<T>::copyWithin(double target, double start, double end) {
  const std::size_t destination = normalizedSliceIndex(target, size());
  const std::size_t first = normalizedSliceIndex(start, size());
  const std::size_t last = std::isinf(end) ? size() : normalizedSliceIndex(end, size());
  std::vector<T> copied;
  for (std::size_t index = first; index < last; ++index) copied.push_back(get(index));
  for (std::size_t index = 0; index < copied.size() && destination + index < size(); ++index) {
    set(destination + index, copied[index]);
  }
  return this;
}

template <typename T>
inline ArrayObject<T>* copyWithin(
    ArrayObject<T>* array,
    double target,
    double start,
    double end = std::numeric_limits<double>::infinity()) {
  return array->copyWithin(target, start, end);
}

template <typename T>
template <typename Callback>
inline ArrayObject<T>* ArrayObject<T>::sort(Callback callback) {
  std::vector<T> sorted;
  sorted.reserve(size());
  for (const auto value : *this) sorted.push_back(value);
  std::stable_sort(sorted.begin(), sorted.end(), [&](const T& left, const T& right) {
    return callback(left, right) < 0;
  });
  for (std::size_t index = 0; index < sorted.size(); ++index) values_[index].store(sorted[index]);
  return this;
}

template <typename T, typename Callback>
inline ArrayObject<T>* sort(ArrayObject<T>* array, Callback callback) {
  return array->sort(std::move(callback));
}

template <typename Index>
inline std::size_t arrayIndex(Index&& index) {
  using Input = std::remove_cvref_t<Index>;
  if constexpr (std::is_same_v<Input, Value>) {
    return static_cast<std::size_t>(Number(index));
  } else {
    return static_cast<std::size_t>(index);
  }
}

template <typename T, typename Index>
inline T arrayGet(const ArrayObject<T>* array, Index&& index) {
  return array->get(arrayIndex(std::forward<Index>(index)));
}

template <typename T, typename Index, typename U>
inline T arraySet(ArrayObject<T>* array, Index index, U&& value) {
  return array->set(
      arrayIndex(std::forward<Index>(index)),
      convertValue<T>(std::forward<U>(value)));
}
