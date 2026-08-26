#pragma once

// Internal runtime category header. Include runtime.hpp instead.

RecordObject* recordSpread(RecordObject* target, RecordObject* source);

RecordObject* recordSpread(RecordObject* target, EnumerableObject* source);

RecordObject* recordSpread(RecordObject* target, BaseObject* source);

template <typename T>
  requires std::is_base_of_v<BaseObject, T>
inline RecordObject* recordSpread(RecordObject* target, T* source) {
  return recordSpread(target, static_cast<BaseObject*>(source));
}

template <typename T>
inline RecordObject* recordSpread(RecordObject* target, const cppgc::Member<T>& source) {
  return recordSpread(target, source.Get());
}

RecordObject* recordSpread(RecordObject* target, const Value& source);

RecordObject* recordRest(
    RecordObject* source,
    std::initializer_list<std::u16string> excluded);

template <typename Callback>
Value destructureDefault(Value value, Callback&& fallback) {
  return value.isUndefined()
      ? convertValue<Value>(std::forward<Callback>(fallback)())
      : value;
}

template <typename T, typename Callback>
T destructureDefault(T value, Callback&&) {
  return value;
}

bool recordHas(RecordObject* record, const std::u16string& key);

bool hasProperty(const Value& value, const std::u16string& key);

bool hasProperty(RecordObject* record, const std::u16string& key);

template <typename T>
inline bool hasProperty(T* value, const std::u16string& key) {
  if constexpr (std::is_base_of_v<RecordObject, T>) return recordHas(value, key);
  if constexpr (std::is_base_of_v<BaseObject, T>) return value && !value->dynamicGet(key).isUndefined();
  return false;
}

bool recordDelete(RecordObject* record, const std::u16string& key);

Value dynamicObjectGet(BaseObject* target, const std::u16string& key);

Value dynamicGet(const std::u16string& target, const std::u16string& key);

Value dynamicGet(const Value& target, const std::u16string& key);

Value dynamicGet(RecordObject* target, const std::u16string& key);

template <typename T>
  requires std::is_base_of_v<BaseObject, T>
inline Value dynamicGet(T* target, const std::u16string& key) {
  return dynamicObjectGet(target, key);
}

template <typename T>
inline Value dynamicGet(const cppgc::Member<T>& target, const std::u16string& key) {
  return dynamicGet(target.Get(), key);
}

Value dynamicGetOptional(const Value& target, const std::u16string& key);

template <typename T>
  requires std::is_base_of_v<BaseObject, T>
inline Value dynamicGetOptional(T* target, const std::u16string& key) {
  return target ? dynamicGet(target, key) : Value::undefined();
}

template <typename T>
  requires std::is_base_of_v<BaseObject, T>
inline Value dynamicGetOptional(const cppgc::Member<T>& target, const std::u16string& key) {
  return target ? dynamicGet(target.Get(), key) : Value::undefined();
}

Value dynamicSet(const Value& target, const std::u16string& key, const Value& value);

Value dynamicSet(RecordObject* target, const std::u16string& key, const Value& value);

template <typename T>
  requires std::is_base_of_v<BaseObject, T>
inline Value dynamicSet(T* target, const std::u16string& key, const Value& value) {
  if (!target) throw runtimeError(u"Cannot set a property on null");
  return target->dynamicSet(key, value);
}

template <typename Target>
inline Value dynamicIndexGet(Target&& target, const std::u16string& key) {
  const Value receiver = convertValue<Value>(std::forward<Target>(target));
  return dynamicGet(receiver, key);
}

template <typename Target>
inline Value dynamicIndexSet(Target&& target, const std::u16string& key, const Value& value) {
  const Value receiver = convertValue<Value>(std::forward<Target>(target));
  return dynamicSet(receiver, key, value);
}

bool dynamicDelete(const Value& target, const std::u16string& key);

Value recordGetOptional(RecordObject* record, const std::u16string& key);

ArrayObject<std::u16string>* recordKeys(RecordObject* record);

ArrayObject<std::u16string>* recordKeys(EnumerableObject* object);

ArrayObject<std::u16string>* recordKeys(BaseObject* object);

template <typename T>
  requires std::is_base_of_v<BaseObject, T>
inline ArrayObject<std::u16string>* recordKeys(T* object) {
  return recordKeys(static_cast<BaseObject*>(object));
}

ArrayObject<Value>* recordValues(RecordObject* record);

ArrayObject<Value>* recordValues(EnumerableObject* object);

ArrayObject<Value>* recordValues(BaseObject* object);

template <typename T>
  requires std::is_base_of_v<BaseObject, T>
inline ArrayObject<Value>* recordValues(T* object) {
  return recordValues(static_cast<BaseObject*>(object));
}

ArrayObject<ArrayObject<Value>*>* recordEntries(RecordObject* record);

ArrayObject<ArrayObject<Value>*>* recordEntries(EnumerableObject* object);

ArrayObject<ArrayObject<Value>*>* recordEntries(BaseObject* object);

template <typename T>
  requires std::is_base_of_v<BaseObject, T>
inline ArrayObject<ArrayObject<Value>*>* recordEntries(T* object) {
  return recordEntries(static_cast<BaseObject*>(object));
}

ArrayObject<ArrayObject<Value>*>* recordEntries(const Value& value);

template <typename Entry>
inline RecordObject* recordFromEntries(const ArrayObject<ArrayObject<Entry>*>* entries) {
  auto* record = Runtime::record();
  for (auto* entry : *entries) {
    if (!entry || entry->size() < 2) continue;
    record->set(propertyKey(convertValue<Value>(entry->get(0))), convertValue<Value>(entry->get(1)));
  }
  return record;
}

RecordObject* recordFromEntries(const Value& entries);

ArrayObject<std::u16string>* recordKeys(const Value& value);

ArrayObject<Value>* recordValues(const Value& value);

BaseObject* requireObject(const Value& value);

template <typename T>
inline BaseObject* requireObject(T* value) {
  static_assert(std::is_base_of_v<BaseObject, T>);
  if (!value) throw runtimeError(u"Object operation requires a non-null object");
  return static_cast<BaseObject*>(value);
}

RecordObject* objectCreate(const Value& prototype);

Value objectConstructor();

template <typename T>
inline Value objectConstructor(T&& input) {
  const Value value = convertValue<Value>(std::forward<T>(input));
  return value.isNull() || value.isUndefined() ? objectConstructor() : value;
}

template <typename Prototype>
inline RecordObject* objectCreate(Prototype* prototype) {
  auto* result = Runtime::record();
  result->setPrototype(requireObject(prototype));
  return result;
}

template <typename Target, typename Source>
inline void objectAssignSource(Target* target, Source* source) {
  if (!target || !source) return;
  for (const auto& key : objectKeys(source)) {
    dynamicSet(target, key, dynamicGet(source, key));
  }
}

template <typename Target, typename Source>
inline void objectAssignSource(Target* target, const Source& source) {
  if constexpr (std::is_same_v<std::remove_cvref_t<Source>, Value>) {
    if (source.isNull() || source.isUndefined()) return;
    for (const auto& key : objectKeys(source)) dynamicSet(target, key, dynamicGet(source, key));
  } else {
    objectAssignSource(target, rawPointer(source));
  }
}

template <typename Target, typename... Sources>
inline Target* objectAssign(Target* target, Sources&&... sources) {
  if (!target) throw runtimeError(u"Object.assign target cannot be null");
  (objectAssignSource(target, std::forward<Sources>(sources)), ...);
  return target;
}

bool objectHasOwn(const Value& value, const std::u16string& key);

template <typename T>
inline bool objectHasOwn(T* value, const std::u16string& key) {
  if (!value) return false;
  if constexpr (std::is_same_v<T, RecordObject>) return value->has(key);
  else if constexpr (std::is_base_of_v<BaseObject, T>) return value->dynamicHasOwn(key);
  else return false;
}

bool objectPropertyIsEnumerable(const Value& value, const std::u16string& key);

template <typename T>
inline bool objectPropertyIsEnumerable(T* value, const std::u16string& key) {
  if (!value) return false;
  if constexpr (std::is_same_v<T, RecordObject>) return value->propertyIsEnumerable(key);
  else if constexpr (std::is_base_of_v<BaseObject, T>) return value->dynamicPropertyIsEnumerable(key);
  else return false;
}

bool objectIs(const Value& left, const Value& right);

template <typename Left, typename Right>
inline bool objectIs(Left&& left, Right&& right) {
  const Value leftValue = convertValue<Value>(std::forward<Left>(left));
  const Value rightValue = convertValue<Value>(std::forward<Right>(right));
  return objectIs(
      static_cast<const Value&>(leftValue),
      static_cast<const Value&>(rightValue));
}

RecordObject* objectGetOwnPropertyDescriptor(const Value& value, const std::u16string& key);

template <typename T>
inline RecordObject* objectGetOwnPropertyDescriptor(T* value, const std::u16string& key) {
  return objectGetOwnPropertyDescriptor(convertValue<Value>(value), key);
}

ArrayObject<std::u16string>* objectGetOwnPropertyNames(const Value& value);

template <typename T>
inline ArrayObject<std::u16string>* objectGetOwnPropertyNames(T* value) {
  return objectGetOwnPropertyNames(convertValue<Value>(value));
}

RecordObject* objectGetOwnPropertyDescriptors(const Value& value);

template <typename T>
inline RecordObject* objectGetOwnPropertyDescriptors(T* value) {
  return objectGetOwnPropertyDescriptors(convertValue<Value>(value));
}

Value objectGetPrototypeOf(const Value& value);

template <typename T>
inline Value objectGetPrototypeOf(T* value) {
  return objectGetPrototypeOf(convertValue<Value>(value));
}

bool objectSetPrototypeOf(const Value& value, const Value& prototype);

template <typename Target, typename Prototype>
inline bool objectSetPrototypeOf(Target* target, Prototype* prototype) {
  return objectSetPrototypeOf(convertValue<Value>(target), convertValue<Value>(prototype));
}

template <typename T>
inline T* objectPreventExtensions(T* value) {
  if constexpr (std::is_same_v<T, RecordObject>) value->preventExtensions();
  else requireObject(value)->dynamicPreventExtensions();
  return value;
}

Value objectPreventExtensions(const Value& value);

template <typename T>
inline T* objectSeal(T* value) {
  if constexpr (std::is_same_v<T, RecordObject>) value->seal();
  else requireObject(value)->dynamicSeal();
  return value;
}

Value objectSeal(const Value& value);

template <typename T>
inline T* objectFreeze(T* value) {
  if constexpr (std::is_same_v<T, RecordObject>) value->freeze();
  else requireObject(value)->dynamicFreeze();
  return value;
}

Value objectFreeze(const Value& value);

template <typename T>
inline bool objectIsExtensible(T* value) {
  if constexpr (std::is_same_v<T, RecordObject>) return value && value->isExtensible();
  else return value && value->dynamicIsExtensible();
}

bool objectIsExtensible(const Value& value);

template <typename T>
inline bool objectIsSealed(T* value) {
  if constexpr (std::is_same_v<T, RecordObject>) return value && value->isSealed();
  else return value && value->dynamicIsSealed();
}

bool objectIsSealed(const Value& value);

template <typename T>
inline bool objectIsFrozen(T* value) {
  if constexpr (std::is_same_v<T, RecordObject>) return value && value->isFrozen();
  else return value && value->dynamicIsFrozen();
}

bool objectIsFrozen(const Value& value);

bool objectIsPrototypeOf(const Value& prototype, const Value& candidate);

template <typename Prototype, typename Candidate>
inline bool objectIsPrototypeOf(Prototype* prototype, Candidate* candidate) {
  return objectIsPrototypeOf(convertValue<Value>(prototype), convertValue<Value>(candidate));
}

template <typename T>
inline std::u16string objectToString(T&& value) {
  const Value object = convertValue<Value>(std::forward<T>(value));
  if (object.isNull()) return u"[object Null]";
  if (object.isUndefined()) return u"[object Undefined]";
  if (object.isString()) return u"[object String]";
  if (object.isBoolean()) return u"[object Boolean]";
  if (object.isNumber()) return u"[object Number]";
  if (object.isBigInt()) return u"[object BigInt]";
  return object.isRecord() ? u"[object Object]" : object.object()->dynamicToString();
}

template <typename Target>
inline Target objectDefineProperty(
    Target target,
    const std::u16string& key,
    const Value& descriptor) {
  if (!descriptor.isRecord() && !descriptor.isRuntimeObject()) {
    throw runtimeError(u"Object property descriptor must be an object");
  }
  const Value getter = dynamicGet(descriptor, u"get");
  const Value setter = dynamicGet(descriptor, u"set");
  if (!getter.isUndefined() || !setter.isUndefined()) {
    throw runtimeError(u"Native generated C++ does not support accessor property descriptors");
  }
  const Value value = dynamicGet(descriptor, u"value");
  const Value enumerable = dynamicGet(descriptor, u"enumerable");
  const Value writable = dynamicGet(descriptor, u"writable");
  const Value configurable = dynamicGet(descriptor, u"configurable");
  defineProperty(
      target,
      key,
      value,
      !enumerable.isUndefined() && static_cast<bool>(enumerable),
      !writable.isUndefined() && static_cast<bool>(writable),
      !configurable.isUndefined() && static_cast<bool>(configurable));
  return target;
}

template <typename Target, typename Descriptors>
inline Target objectDefineProperties(Target target, Descriptors descriptors) {
  for (const auto& key : objectKeys(descriptors)) {
    objectDefineProperty(target, key, convertValue<Value>(dynamicGet(descriptors, key)));
  }
  return target;
}

template <typename Prototype, typename Descriptors>
inline RecordObject* objectCreate(Prototype prototype, Descriptors descriptors) {
  auto* result = objectCreate(convertValue<Value>(prototype));
  objectDefineProperties(result, descriptors);
  return result;
}
