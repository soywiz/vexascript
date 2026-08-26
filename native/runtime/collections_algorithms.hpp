#pragma once

// Internal runtime category header. Include runtime.hpp instead.

template <typename T, typename Callback>
T& nullishAssign(T& target, Callback&& fallback) {
  if constexpr (std::is_same_v<T, Value>) {
    if (target.isNull() || target.isUndefined()) target = std::forward<Callback>(fallback)();
  } else if constexpr (std::is_pointer_v<T>) {
    if (!target) target = std::forward<Callback>(fallback)();
  } else if constexpr (requires(T& persistent) { persistent.Get(); }) {
    if (!target.Get()) target = std::forward<Callback>(fallback)();
  }
  return target;
}

template <typename K, typename V, typename Key>
inline V mapGet(const MapObject<K, V>* map, Key&& key) {
  const auto found = map->get(convertValue<K>(std::forward<Key>(key)));
  if (found) return *found;
  if constexpr (std::is_same_v<V, Value>) return Value::undefined();
  return V{};
}

template <typename K, typename V, typename Key>
inline Value mapGetValue(const MapObject<K, V>* map, Key&& key) {
  const auto found = map->get(convertValue<K>(std::forward<Key>(key)));
  return found ? convertValue<Value>(*found) : Value::undefined();
}

template <typename K, typename V, typename Key, typename Input>
inline MapObject<K, V>* mapSet(MapObject<K, V>* map, Key&& key, Input&& value) {
  return map->set(
      convertValue<K>(std::forward<Key>(key)),
      convertValue<V>(std::forward<Input>(value)));
}

template <typename K, typename V, typename Key>
inline bool mapHas(MapObject<K, V>* map, Key&& key) {
  return map->has(convertValue<K>(std::forward<Key>(key)));
}

template <typename K, typename V, typename Key>
inline bool mapDelete(MapObject<K, V>* map, Key&& key) {
  return map->erase(convertValue<K>(std::forward<Key>(key)));
}

template <typename K, typename V>
inline void mapClear(MapObject<K, V>* map) { map->clear(); }

template <typename K, typename V, typename Callback>
inline void mapForEach(MapObject<K, V>* map, Callback callback) { map->forEach(std::move(callback)); }

template <typename K, typename V>
inline ArrayObject<K>* mapKeys(MapObject<K, V>* map) {
  auto* result = Runtime::array<K>();
  map->forEach([&](V, K key) { result->append(key); });
  return result;
}

template <typename K, typename V>
inline ArrayObject<V>* mapValues(MapObject<K, V>* map) {
  auto* result = Runtime::array<V>();
  map->forEach([&](V value) { result->append(value); });
  return result;
}

template <typename K, typename V>
inline ArrayObject<ArrayObject<Value>*>* mapEntries(MapObject<K, V>* map) {
  auto* result = Runtime::array<ArrayObject<Value>*>();
  map->forEach([&](V value, K key) {
    result->append(Runtime::array<Value>({
        convertValue<Value>(key),
        convertValue<Value>(value)}));
  });
  return result;
}

template <typename K, typename V>
inline ArrayObject<ArrayObject<Value>*>* mapEntries(
    const cppgc::Member<MapObject<K, V>>& map) {
  return mapEntries(map.Get());
}

template <typename K, typename V>
inline ArrayObject<ArrayObject<Value>*>* mapEntries(
    const cppgc::Persistent<MapObject<K, V>>& map) {
  return mapEntries(map.Get());
}

template <typename K, typename V, typename Entry>
inline MapObject<K, V>* mapFromEntries(
    const ArrayObject<ArrayObject<Entry>*>* entries) {
  auto* result = Runtime::make<MapObject<K, V>>();
  if (!entries) return result;
  for (auto* entry : *entries) {
    if (!entry || entry->size() < 2) {
      throw runtimeError(u"VexaScript Map entry must contain a key and value");
    }
    result->set(
        convertValue<K>(entry->get(0)),
        convertValue<V>(entry->get(1)));
  }
  return result;
}

template <typename K, typename V, typename Entry>
inline MapObject<K, V>* mapFromIterable(
    const ArrayObject<ArrayObject<Entry>*>* entries) {
  return mapFromEntries<K, V>(entries);
}

template <typename K, typename V>
inline MapObject<K, V>* mapFromIterable(MapObject<K, V>* source) {
  if (!source) return Runtime::make<MapObject<K, V>>();
  if (!source->usesDynamicBacking()) return Runtime::make<MapObject<K, V>>(source);
  auto* result = Runtime::make<MapObject<K, V>>();
  source->forEach([&](V value, K key) { result->set(std::move(key), std::move(value)); });
  return result;
}

template <typename K, typename V, typename InputK, typename InputV>
  requires (!std::is_same_v<K, InputK> || !std::is_same_v<V, InputV>)
inline MapObject<K, V>* mapFromIterable(MapObject<InputK, InputV>* source) {
  auto* result = Runtime::make<MapObject<K, V>>();
  if (!source) return result;
  source->forEach([&](InputV value, InputK key) {
    result->set(convertValue<K>(key), convertValue<V>(value));
  });
  return result;
}

template <typename K, typename V, typename InputK, typename InputV>
inline MapObject<K, V>* mapFromIterable(
    const cppgc::Persistent<MapObject<InputK, InputV>>& source) {
  return mapFromIterable<K, V>(source.Get());
}

template <typename K, typename V, typename InputK, typename InputV>
inline MapObject<K, V>* mapFromIterable(
    const cppgc::Member<MapObject<InputK, InputV>>& source) {
  return mapFromIterable<K, V>(source.Get());
}

template <typename K, typename V>
inline MapObject<K, V>* mapFromDynamicEntries(
    const ArrayObject<Value>* entries) {
  auto* result = Runtime::make<MapObject<K, V>>();
  std::size_t index = 0;
  for (const auto& entryValue : *entries) {
    if (!entryValue.isRuntimeObject()) {
      throw runtimeError(
          std::u16string(u"VexaScript Map entry at index ") + formatIntegerText(index) +
          u" is not an array: " + toString(entryValue));
    }
    auto* entry = static_cast<ArrayObject<Value>*>(
        entryValue.object()->dynamicCast(nativeTypeToken<ArrayObject<Value>>()));
    if (!entry) {
      throw runtimeError(
          std::u16string(u"VexaScript Map entry at index ") + formatIntegerText(index) +
          u" has an incompatible array element type");
    }
    if (entry->size() < 2) throw runtimeError(u"VexaScript Map entry must contain a key and value");
    result->set(convertValue<K>(entry->get(0)), convertValue<V>(entry->get(1)));
    ++index;
  }
  return result;
}

template <typename K, typename V>
inline MapObject<K, V>* mapFromIterable(
    const ArrayObject<Value>* entries) {
  return mapFromDynamicEntries<K, V>(entries);
}

template <typename K, typename V>
inline MapObject<K, V>* mapFromIterable(const Value& source) {
  auto* result = Runtime::make<MapObject<K, V>>();
  std::size_t index = 0;
  for (const auto& entryValue : dynamicIterationRange(source)) {
    if (!entryValue.isRuntimeObject() || !entryValue.object()->dynamicIsArray()) {
      throw runtimeError(
          std::u16string(u"VexaScript Map entry at index ") + formatIntegerText(index) +
          u" is not an array: " + toString(entryValue));
    }
    auto* entry = entryValue.object();
    if (entry->dynamicArraySize() < 2) {
      throw runtimeError(u"VexaScript Map entry must contain a key and value");
    }
    result->set(
        convertValue<K>(entry->dynamicArrayGet(0)),
        convertValue<V>(entry->dynamicArrayGet(1)));
    ++index;
  }
  return result;
}

template <typename K, typename V, typename Entry>
inline WeakMapObject<K, V>* weakMapFromEntries(
    const ArrayObject<ArrayObject<Entry>*>* entries) {
  auto* result = Runtime::make<WeakMapObject<K, V>>();
  if (!entries) return result;
  for (auto* entry : *entries) {
    if (!entry || entry->size() < 2) {
      throw runtimeError(u"VexaScript WeakMap entry must contain a key and value");
    }
    result->set(
        convertValue<K>(entry->get(0)),
        convertValue<V>(entry->get(1)));
  }
  return result;
}

template <typename K, typename V, typename Entry>
inline WeakMapObject<K, V>* weakMapFromIterable(
    const ArrayObject<ArrayObject<Entry>*>* entries) {
  return weakMapFromEntries<K, V, Entry>(entries);
}

template <typename K, typename V>
inline WeakMapObject<K, V>* weakMapFromIterable(const Value& source) {
  auto* result = Runtime::make<WeakMapObject<K, V>>();
  std::size_t index = 0;
  for (const auto& entryValue : dynamicIterationRange(source)) {
    if (!entryValue.isRuntimeObject() || !entryValue.object()->dynamicIsArray()) {
      throw runtimeError(
          std::u16string(u"VexaScript WeakMap entry at index ") + formatIntegerText(index) +
          u" is not an array: " + toString(entryValue));
    }
    auto* entry = entryValue.object();
    if (entry->dynamicArraySize() < 2) {
      throw runtimeError(u"VexaScript WeakMap entry must contain a key and value");
    }
    result->set(
        convertValue<K>(entry->dynamicArrayGet(0)),
        convertValue<V>(entry->dynamicArrayGet(1)));
    ++index;
  }
  return result;
}

template <typename T, typename Input>
inline SetObject<T>* setAdd(SetObject<T>* set, Input&& value) {
  return set->add(convertValue<T>(std::forward<Input>(value)));
}

template <typename T, typename Input>
inline bool setHas(SetObject<T>* set, Input&& value) {
  return set->has(convertValue<T>(std::forward<Input>(value)));
}

template <typename T, typename Input>
inline bool setHas(const SetObject<T>* set, Input&& value) {
  return set->has(convertValue<T>(std::forward<Input>(value)));
}

template <typename T, typename Input>
inline bool setDelete(SetObject<T>* set, Input&& value) {
  return set->erase(convertValue<T>(std::forward<Input>(value)));
}

template <typename T>
inline void setClear(SetObject<T>* set) { set->clear(); }

template <typename T, typename Callback>
inline void setForEach(SetObject<T>* set, Callback callback) { set->forEach(std::move(callback)); }

template <typename T>
inline ArrayObject<T>* setValues(SetObject<T>* set) {
  auto* result = Runtime::array<T>();
  set->forEach([&](T value) { result->append(value); });
  return result;
}

template <typename T>
inline ArrayObject<ArrayObject<T>*>* setEntries(SetObject<T>* set) {
  auto* result = Runtime::array<ArrayObject<T>*>();
  set->forEach([&](T value) {
    auto* entry = Runtime::array<T>();
    entry->append(value);
    entry->append(value);
    result->append(entry);
  });
  return result;
}

template <typename T, typename U>
inline SetObject<T>* setUnion(SetObject<T>* left, SetObject<U>* right) {
  auto* result = Runtime::make<SetObject<T>>();
  if (left) left->forEach([&](T value) { result->add(value); });
  if (right) right->forEach([&](U value) { result->add(convertValue<T>(value)); });
  return result;
}

template <typename T, typename U>
inline SetObject<T>* setIntersection(SetObject<T>* left, SetObject<U>* right) {
  auto* result = Runtime::make<SetObject<T>>();
  if (!left || !right) return result;
  left->forEach([&](T value) {
    if (right->has(convertValue<U>(value))) result->add(value);
  });
  return result;
}

template <typename T, typename U>
inline SetObject<T>* setDifference(SetObject<T>* left, SetObject<U>* right) {
  auto* result = Runtime::make<SetObject<T>>();
  if (!left) return result;
  left->forEach([&](T value) {
    if (!right || !right->has(convertValue<U>(value))) result->add(value);
  });
  return result;
}

template <typename T, typename U>
inline SetObject<T>* setSymmetricDifference(SetObject<T>* left, SetObject<U>* right) {
  auto* result = setDifference(left, right);
  if (right) right->forEach([&](U value) {
    const T converted = convertValue<T>(value);
    if (!left || !left->has(converted)) result->add(converted);
  });
  return result;
}

template <typename T, typename U>
inline bool setIsSubsetOf(SetObject<T>* left, SetObject<U>* right) {
  if (!left || !right || left->size() > right->size()) return false;
  bool result = true;
  left->forEach([&](T value) { result = result && right->has(convertValue<U>(value)); });
  return result;
}

template <typename T, typename U>
inline bool setIsSupersetOf(SetObject<T>* left, SetObject<U>* right) {
  return setIsSubsetOf(right, left);
}

template <typename T, typename U>
inline bool setIsDisjointFrom(SetObject<T>* left, SetObject<U>* right) {
  if (!left || !right) return true;
  bool result = true;
  left->forEach([&](T value) { result = result && !right->has(convertValue<U>(value)); });
  return result;
}

template <typename T, typename Input>
inline SetObject<T>* setFromArray(const ArrayObject<Input>* values) {
  auto* result = Runtime::make<SetObject<T>>();
  if (!values) return result;
  for (const auto& value : *values) result->add(convertValue<T>(value));
  return result;
}

template <typename T, typename Input>
inline SetObject<T>* setFromIterable(const ArrayObject<Input>* values) {
  return setFromArray<T>(values);
}

template <typename T, typename Input>
inline SetObject<T>* setFromIterable(const cppgc::Persistent<ArrayObject<Input>>& values) {
  return setFromArray<T>(values.Get());
}

template <typename T>
inline SetObject<T>* setFromIterable(SetObject<T>* source) {
  return source ? Runtime::make<SetObject<T>>(source) : Runtime::make<SetObject<T>>();
}

template <typename T, typename Input>
  requires (!std::is_same_v<T, Input>)
inline SetObject<T>* setFromIterable(SetObject<Input>* source) {
  auto* result = Runtime::make<SetObject<T>>();
  if (!source) return result;
  source->forEach([&](Input value) { result->add(convertValue<T>(value)); });
  return result;
}

template <typename T, typename Input>
inline SetObject<T>* setFromIterable(
    const cppgc::Persistent<SetObject<Input>>& source) {
  return setFromIterable<T>(source.Get());
}

template <typename T>
inline SetObject<T>* setFromIterable(const Value& source) {
  return setFromArray<T>(arrayPointer(source));
}

template <typename T, typename Input>
inline WeakSetObject<T>* weakSetFromArray(const ArrayObject<Input>* values) {
  auto* result = Runtime::make<WeakSetObject<T>>();
  for (const auto& value : *values) result->add(convertValue<T>(value));
  return result;
}

template <typename K, typename V, typename Key>
inline V weakMapGet(WeakMapObject<K, V>* map, Key&& key) {
  const auto found = map->get(convertValue<K>(std::forward<Key>(key)));
  if (found) return *found;
  if constexpr (std::is_same_v<V, Value>) return Value::undefined();
  return V{};
}

template <typename K, typename V, typename Key, typename Input>
inline WeakMapObject<K, V>* weakMapSet(WeakMapObject<K, V>* map, Key&& key, Input&& value) {
  return map->set(
      convertValue<K>(std::forward<Key>(key)),
      convertValue<V>(std::forward<Input>(value)));
}

template <typename K, typename V, typename Key>
inline bool weakMapHas(WeakMapObject<K, V>* map, Key&& key) {
  return map->has(convertValue<K>(std::forward<Key>(key)));
}

template <typename K, typename V, typename Key>
inline bool weakMapDelete(WeakMapObject<K, V>* map, Key&& key) {
  return map->erase(convertValue<K>(std::forward<Key>(key)));
}

template <typename T, typename Input>
inline WeakSetObject<T>* weakSetAdd(WeakSetObject<T>* set, Input&& value) {
  return set->add(convertValue<T>(std::forward<Input>(value)));
}

template <typename T, typename Input>
inline bool weakSetHas(WeakSetObject<T>* set, Input&& value) {
  return set->has(convertValue<T>(std::forward<Input>(value)));
}

template <typename T, typename Input>
inline bool weakSetDelete(WeakSetObject<T>* set, Input&& value) {
  return set->erase(convertValue<T>(std::forward<Input>(value)));
}
