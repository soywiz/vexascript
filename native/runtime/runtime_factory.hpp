#pragma once

// Internal runtime category header. Include runtime.hpp instead.

template <typename T, typename... Arguments>
inline T* makeManaged(Arguments&&... arguments) {
  return Runtime::make<T>(std::forward<Arguments>(arguments)...);
}

template <typename T>
inline ArrayObject<T>* makeArray(std::initializer_list<T> values = {}) {
  return Runtime::array<T>(values);
}

template <typename First, typename... Values>
inline ArrayObject<std::remove_cvref_t<First>>* arrayOf(First&& first, Values&&... values) {
  using T = std::remove_cvref_t<First>;
  auto* result = Runtime::array<T>();
  result->append(std::forward<First>(first));
  (result->append(convertValue<T>(std::forward<Values>(values))), ...);
  return result;
}

template <typename T>
inline ArrayObject<T>* arrayFrom(const ArrayObject<T>* source) {
  return source ? source->slice() : Runtime::array<T>();
}

inline ArrayObject<RecordObject*>* arrayFrom(const IntlSegmentsObject* source) {
  return source ? source->items()->slice() : Runtime::array<RecordObject*>();
}

template <typename T, typename Callback>
inline auto arrayFrom(const ArrayObject<T>* source, Callback callback) {
  return source->map(std::move(callback));
}

inline RecordObject* makeRecord(
    std::initializer_list<std::pair<std::u16string, Value>> properties = {}) {
  return Runtime::record(properties);
}

inline RecordObject* RecordObject::descriptor(const std::u16string& key) const {
  if (!has(key)) return nullptr;
  auto* result = Runtime::record();
  result->set(u"value", get(key));
  result->set(u"writable", Value(!writable_properties_.contains(key) || writable_properties_.at(key)));
  result->set(u"enumerable", Value(propertyIsEnumerable(key)));
  result->set(u"configurable", Value(!configurable_properties_.contains(key) || configurable_properties_.at(key)));
  return result;
}

inline Value makeString(std::u16string value) {
  return Runtime::string(std::move(value));
}

inline ArrayObject<Value>* makeDynamicArrayValueView(BaseObject* backing) {
  return Runtime::make<ArrayObject<Value>>(backing);
}

inline RecordObject* makeDynamicPropertyRecord() {
  return Runtime::record();
}

inline std::runtime_error errorAtCurrentSource(std::u16string message) {
  return Runtime::errorAtCurrentSource(std::move(message));
}

inline Value makeDynamicMapEntry(Value key, Value value) {
  auto* pair = Runtime::array<Value>();
  pair->append(std::move(key));
  pair->append(std::move(value));
  return Value(pair);
}

template <typename T>
ArrayObject<T>* ArrayObject<T>::fromDynamicObject(BaseObject* backing) {
  if (!backing || !backing->dynamicIsArray()) {
    throw errorAtCurrentSource(u"VexaScript value is not a compatible array");
  }
  return Runtime::make<ArrayObject<T>>(backing);
}

template <typename K, typename V>
MapObject<K, V>* MapObject<K, V>::fromDynamicObject(BaseObject* backing) {
  if (!backing) throw errorAtCurrentSource(u"VexaScript value is not a compatible map");
  void* converted = backing->dynamicCast(nativeTypeToken<MapLikeObject>());
  if (!converted) throw errorAtCurrentSource(u"VexaScript value is not a compatible map");
  return Runtime::make<MapObject<K, V>>(static_cast<MapLikeObject*>(converted));
}

#if defined(VEXA_NATIVE_DEBUG) || defined(VEXA_NATIVE_GC_STRESS)
#define VEXA_NATIVE_SOURCE(file, line, column) \
  do {                                                    \
    vexa::Runtime::setSourceLocation((file), (line), (column)); \
    vexa::Runtime::collectGarbageIfStressed();           \
  } while (false)
#else
#define VEXA_NATIVE_SOURCE(file, line, column) ((void)0)
#endif
