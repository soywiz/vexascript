#pragma once

// Internal runtime category header. Include runtime.hpp instead.

inline RecordObject* recordSpread(RecordObject* target, RecordObject* source) {
  if (!target || !source) throw runtimeError(u"Cannot spread a null object");
  source->copyTo(target);
  return target;
}

inline RecordObject* recordSpread(RecordObject* target, EnumerableObject* source) {
  if (!source) return target;
    for (const auto& key : source->enumerableKeys()) target->set(key, source->enumerableGet(key));
  return target;
}

inline RecordObject* recordSpread(RecordObject* target, BaseObject* source) {
  if (!source) return target;
    for (const auto& key : objectKeys(source)) target->set(key, source->dynamicGet(key));
  return target;
}

template <typename T>
  requires std::is_base_of_v<BaseObject, T>
inline RecordObject* recordSpread(RecordObject* target, T* source) {
  return recordSpread(target, static_cast<BaseObject*>(source));
}

template <typename T>
inline RecordObject* recordSpread(RecordObject* target, const cppgc::Member<T>& source) {
  return recordSpread(target, source.Get());
}

inline RecordObject* recordSpread(RecordObject* target, const Value& source) {
  if (source.isNull() || source.isUndefined()) return target;
  if (source.isRecord()) return recordSpread(target, source.record());
  if (source.isRuntimeObject()) return recordSpread(target, source.object());
  throw runtimeError(u"Object spread requires an enumerable object");
}

inline RecordObject* recordRest(
    RecordObject* source,
    std::initializer_list<std::u16string> excluded) {
  if (!source) throw runtimeError(u"Cannot destructure a null object");
  std::unordered_set<std::u16string> excludedKeys(excluded);
  auto* result = Runtime::record();
  for (const auto& key : source->keys()) {
    if (!excludedKeys.contains(key)) result->set(key, source->get(key));
  }
  return result;
}

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

inline bool recordHas(RecordObject* record, const std::u16string& key) {
  return record && record->has(key);
}

inline bool hasProperty(const Value& value, const std::u16string& key) {
  if (value.isRecord()) return value.record()->has(key);
  if (value.isRuntimeObject()) return !value.object()->dynamicGet(key).isUndefined();
  return false;
}

inline bool hasProperty(RecordObject* record, const std::u16string& key) {
  return recordHas(record, key);
}

template <typename T>
inline bool hasProperty(T* value, const std::u16string& key) {
  if constexpr (std::is_base_of_v<RecordObject, T>) return recordHas(value, key);
  if constexpr (std::is_base_of_v<BaseObject, T>) return value && !value->dynamicGet(key).isUndefined();
  return false;
}

inline bool recordDelete(RecordObject* record, const std::u16string& key) {
  return record && record->erase(key);
}

inline Value dynamicObjectGet(BaseObject* target, const std::u16string& key) {
  if (!target) throw runtimeError(u"Cannot read a property of null");
  Value value = target->dynamicGet(key);
  if (!value.isUndefined()) return value;
  if (key == u"message") {
    if (void* error = target->dynamicCast(nativeTypeToken<Error>())) {
      return Runtime::string(static_cast<Error*>(error)->messageText());
    }
  }
  return value;
}

inline Value dynamicGet(const std::u16string& target, const std::u16string& key) {
  if (key == u"length") return Value(static_cast<double>(target.size()));
  if (const auto index = propertyIndex(key); index && *index < target.size()) {
    return Runtime::string(target.substr(*index, 1));
  }
  return Value::undefined();
}

inline Value dynamicGet(const Value& target, const std::u16string& key) {
  if (target.isRecord()) return target.record()->get(key);
  if (target.isRuntimeObject()) return dynamicObjectGet(target.object(), key);
  if (target.isString()) {
    if (key == u"message") return target;
    if (key == u"length") return Value(static_cast<double>(target.utf16().size()));
    if (const auto index = propertyIndex(key); index && *index < target.utf16().size()) {
      return Runtime::string(target.utf16().substr(*index, 1));
    }
    return Value::undefined();
  }
  if (target.isNull() || target.isUndefined()) {
    throw errorAtCurrentSource(
        std::u16string(u"Cannot read property '") + key + u"' of null or undefined");
  }
  throw errorAtCurrentSource(u"Dynamic native object properties require a declared interface or cast");
}

inline Value dynamicGet(RecordObject* target, const std::u16string& key) {
  if (!target) throw runtimeError(u"Cannot read a property of null");
  return target->get(key);
}

template <typename T>
  requires std::is_base_of_v<BaseObject, T>
inline Value dynamicGet(T* target, const std::u16string& key) {
  return dynamicObjectGet(target, key);
}

template <typename T>
inline Value dynamicGet(const cppgc::Member<T>& target, const std::u16string& key) {
  return dynamicGet(target.Get(), key);
}

inline Value dynamicGetOptional(const Value& target, const std::u16string& key) {
  return target.isNull() || target.isUndefined() ? Value::undefined() : dynamicGet(target, key);
}

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

inline Value dynamicSet(const Value& target, const std::u16string& key, const Value& value) {
  if (target.isRecord()) {
    target.record()->set(key, value);
    return value;
  }
  if (target.isRuntimeObject()) return target.object()->dynamicSet(key, value);
  throw runtimeError(u"Cannot set a property on this dynamic value");
}

inline Value dynamicSet(RecordObject* target, const std::u16string& key, const Value& value) {
  if (!target) throw runtimeError(u"Cannot set a property on null");
  target->set(key, value);
  return value;
}

template <typename T>
  requires std::is_base_of_v<BaseObject, T>
inline Value dynamicSet(T* target, const std::u16string& key, const Value& value) {
  if (!target) throw runtimeError(u"Cannot set a property on null");
  return target->dynamicSet(key, value);
}

inline Value dynamicIndexArgument(const std::u16string& key) {
  if (const auto index = propertyIndex(key)) return Value(static_cast<double>(*index));
  return Runtime::string(key);
}

template <typename Target>
inline Value dynamicIndexGet(Target&& target, const std::u16string& key) {
  const Value receiver = convertValue<Value>(std::forward<Target>(target));
  if (const auto result = callDynamicOperator(
        receiver,
        u"__vexa_operator:[]",
        dynamicIndexArgument(key))) {
    return *result;
  }
  return dynamicGet(receiver, key);
}

template <typename Target>
inline Value dynamicIndexSet(Target&& target, const std::u16string& key, const Value& value) {
  const Value receiver = convertValue<Value>(std::forward<Target>(target));
  if (const auto result = callDynamicOperator(
        receiver,
        u"__vexa_operator:[]=",
        dynamicIndexArgument(key), value)) {
    return *result;
  }
  return dynamicSet(receiver, key, value);
}

inline bool dynamicDelete(const Value& target, const std::u16string& key) {
  if (target.isRecord()) return target.record()->erase(key);
  return target.isRuntimeObject() && target.object()->dynamicDelete(key);
}

inline Value recordGetOptional(RecordObject* record, const std::u16string& key) {
  return record ? record->get(key) : Value::undefined();
}

inline ArrayObject<std::u16string>* recordKeys(RecordObject* record) {
  auto* result = Runtime::array<std::u16string>();
  if (record) for (const auto& key : record->keys()) result->append(std::u16string(key));
  return result;
}

inline ArrayObject<std::u16string>* recordKeys(EnumerableObject* object) {
  auto* result = Runtime::array<std::u16string>();
  if (object) for (const auto& key : objectKeys(object)) result->append(std::u16string(key));
  return result;
}

inline ArrayObject<std::u16string>* recordKeys(BaseObject* object) {
  auto* result = Runtime::array<std::u16string>();
  if (object) for (const auto& key : objectKeys(object)) result->append(std::u16string(key));
  return result;
}

template <typename T>
  requires std::is_base_of_v<BaseObject, T>
inline ArrayObject<std::u16string>* recordKeys(T* object) {
  return recordKeys(static_cast<BaseObject*>(object));
}

inline ArrayObject<Value>* recordValues(RecordObject* record) {
  auto* result = Runtime::array<Value>();
  if (record) for (const auto& value : record->values()) result->append(value);
  return result;
}

inline ArrayObject<Value>* recordValues(EnumerableObject* object) {
  auto* result = Runtime::array<Value>();
  if (object) {
    for (const auto& key : objectKeys(object)) result->append(object->enumerableGet(key));
  }
  return result;
}

inline ArrayObject<Value>* recordValues(BaseObject* object) {
  auto* result = Runtime::array<Value>();
  if (object) {
    for (const auto& key : objectKeys(object)) result->append(object->dynamicGet(key));
  }
  return result;
}

template <typename T>
  requires std::is_base_of_v<BaseObject, T>
inline ArrayObject<Value>* recordValues(T* object) {
  return recordValues(static_cast<BaseObject*>(object));
}

inline ArrayObject<ArrayObject<Value>*>* recordEntries(RecordObject* record) {
  auto* result = Runtime::array<ArrayObject<Value>*>();
  if (!record) return result;
  for (const auto& key : record->keys()) {
    result->append(Runtime::array<Value>({Runtime::string(key), record->get(key)}));
  }
  return result;
}

inline ArrayObject<ArrayObject<Value>*>* recordEntries(EnumerableObject* object) {
  auto* result = Runtime::array<ArrayObject<Value>*>();
  if (!object) return result;
  for (const auto& key : objectKeys(object)) {
    result->append(Runtime::array<Value>({Runtime::string(key), object->enumerableGet(key)}));
  }
  return result;
}

inline ArrayObject<ArrayObject<Value>*>* recordEntries(BaseObject* object) {
  auto* result = Runtime::array<ArrayObject<Value>*>();
  if (!object) return result;
  for (const auto& key : objectKeys(object)) {
    result->append(Runtime::array<Value>({Runtime::string(key), object->dynamicGet(key)}));
  }
  return result;
}

template <typename T>
  requires std::is_base_of_v<BaseObject, T>
inline ArrayObject<ArrayObject<Value>*>* recordEntries(T* object) {
  return recordEntries(static_cast<BaseObject*>(object));
}

inline ArrayObject<ArrayObject<Value>*>* recordEntries(const Value& value) {
  if (value.isRecord()) return recordEntries(value.record());
  if (value.isRuntimeObject()) return recordEntries(value.object());
  return Runtime::array<ArrayObject<Value>*>();
}

template <typename Entry>
inline RecordObject* recordFromEntries(const ArrayObject<ArrayObject<Entry>*>* entries) {
  auto* record = Runtime::record();
  for (auto* entry : *entries) {
    if (!entry || entry->size() < 2) continue;
    record->set(propertyKey(convertValue<Value>(entry->get(0))), convertValue<Value>(entry->get(1)));
  }
  return record;
}

inline RecordObject* recordFromEntries(const Value& entries) {
  auto* record = Runtime::record();
  for (const auto& entryValue : *arrayPointer(entries)) {
    auto* entry = arrayPointer(entryValue);
    if (entry->size() < 2) continue;
    record->set(propertyKey(entry->get(0)), entry->get(1));
  }
  return record;
}

inline ArrayObject<std::u16string>* recordKeys(const Value& value) {
  if (value.isRecord()) return recordKeys(value.record());
  if (value.isRuntimeObject()) return recordKeys(value.object());
  return Runtime::array<std::u16string>();
}

inline ArrayObject<Value>* recordValues(const Value& value) {
  if (value.isRecord()) return recordValues(value.record());
  if (value.isRuntimeObject()) return recordValues(value.object());
  return Runtime::array<Value>();
}

inline BaseObject* requireObject(const Value& value) {
  if (!value.isObject() || value.isString()) throw runtimeError(u"Object operation requires an object");
  return value.object();
}

template <typename T>
inline BaseObject* requireObject(T* value) {
  static_assert(std::is_base_of_v<BaseObject, T>);
  if (!value) throw runtimeError(u"Object operation requires a non-null object");
  return static_cast<BaseObject*>(value);
}

inline RecordObject* objectCreate(const Value& prototype) {
  auto* result = Runtime::record();
  if (prototype.isNull()) return result;
  result->setPrototype(requireObject(prototype));
  return result;
}

inline Value objectConstructor() {
  return Value(Runtime::record());
}

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

inline bool objectHasOwn(const Value& value, const std::u16string& key) {
  if (value.isRecord()) return value.record()->has(key);
  if (value.isRuntimeObject()) return value.object()->dynamicHasOwn(key);
  return false;
}

template <typename T>
inline bool objectHasOwn(T* value, const std::u16string& key) {
  if (!value) return false;
  if constexpr (std::is_same_v<T, RecordObject>) return value->has(key);
  else if constexpr (std::is_base_of_v<BaseObject, T>) return value->dynamicHasOwn(key);
  else return false;
}

inline bool objectPropertyIsEnumerable(const Value& value, const std::u16string& key) {
  if (value.isRecord()) return value.record()->propertyIsEnumerable(key);
  if (value.isRuntimeObject()) return value.object()->dynamicPropertyIsEnumerable(key);
  return false;
}

template <typename T>
inline bool objectPropertyIsEnumerable(T* value, const std::u16string& key) {
  if (!value) return false;
  if constexpr (std::is_same_v<T, RecordObject>) return value->propertyIsEnumerable(key);
  else if constexpr (std::is_base_of_v<BaseObject, T>) return value->dynamicPropertyIsEnumerable(key);
  else return false;
}

inline bool objectIs(const Value& left, const Value& right) {
  if (left.isNumber() && right.isNumber()) {
    if (std::isnan(left.number()) && std::isnan(right.number())) return true;
    if (left.number() == 0 && right.number() == 0) return std::signbit(left.number()) == std::signbit(right.number());
  }
  return left == right;
}

template <typename Left, typename Right>
inline bool objectIs(Left&& left, Right&& right) {
  const Value leftValue = convertValue<Value>(std::forward<Left>(left));
  const Value rightValue = convertValue<Value>(std::forward<Right>(right));
  return objectIs(
      static_cast<const Value&>(leftValue),
      static_cast<const Value&>(rightValue));
}

inline RecordObject* objectGetOwnPropertyDescriptor(const Value& value, const std::u16string& key) {
  if (value.isRecord()) return value.record()->descriptor(key);
  if (!value.isRuntimeObject() || !value.object()->dynamicHasOwn(key)) return nullptr;
  auto* result = Runtime::record();
  result->set(u"value", value.object()->dynamicGet(key));
  result->set(u"writable", Value(!value.object()->dynamicIsFrozen()));
  result->set(u"enumerable", Value(value.object()->dynamicPropertyIsEnumerable(key)));
  result->set(u"configurable", Value(!value.object()->dynamicIsSealed()));
  return result;
}

template <typename T>
inline RecordObject* objectGetOwnPropertyDescriptor(T* value, const std::u16string& key) {
  return objectGetOwnPropertyDescriptor(convertValue<Value>(value), key);
}

inline ArrayObject<std::u16string>* objectGetOwnPropertyNames(const Value& value) {
  auto* result = Runtime::array<std::u16string>();
  if (value.isRecord()) {
    for (const auto& key : value.record()->ownPropertyNames()) result->append(key);
  } else if (value.isRuntimeObject()) {
    for (const auto& key : value.object()->dynamicKeys()) result->append(key);
  }
  return result;
}

template <typename T>
inline ArrayObject<std::u16string>* objectGetOwnPropertyNames(T* value) {
  return objectGetOwnPropertyNames(convertValue<Value>(value));
}

inline RecordObject* objectGetOwnPropertyDescriptors(const Value& value) {
  auto* result = Runtime::record();
  for (const auto& key : *objectGetOwnPropertyNames(value)) {
    result->set(key, Value(objectGetOwnPropertyDescriptor(value, key)));
  }
  return result;
}

template <typename T>
inline RecordObject* objectGetOwnPropertyDescriptors(T* value) {
  return objectGetOwnPropertyDescriptors(convertValue<Value>(value));
}

inline Value objectGetPrototypeOf(const Value& value) {
  BaseObject* prototype = value.isRecord()
      ? value.record()->prototype()
      : requireObject(value)->dynamicPrototype();
  return prototype ? Value(prototype) : Value::null();
}

template <typename T>
inline Value objectGetPrototypeOf(T* value) {
  return objectGetPrototypeOf(convertValue<Value>(value));
}

inline bool objectSetPrototypeOf(const Value& value, const Value& prototype) {
  BaseObject* target = requireObject(value);
  BaseObject* next = prototype.isNull() ? nullptr : requireObject(prototype);
  if (value.isRecord()) value.record()->setPrototype(next);
  else target->dynamicSetPrototype(next);
  return true;
}

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

inline Value objectPreventExtensions(const Value& value) {
  if (value.isRecord()) value.record()->preventExtensions();
  else requireObject(value)->dynamicPreventExtensions();
  return value;
}

template <typename T>
inline T* objectSeal(T* value) {
  if constexpr (std::is_same_v<T, RecordObject>) value->seal();
  else requireObject(value)->dynamicSeal();
  return value;
}

inline Value objectSeal(const Value& value) {
  if (value.isRecord()) value.record()->seal();
  else requireObject(value)->dynamicSeal();
  return value;
}

template <typename T>
inline T* objectFreeze(T* value) {
  if constexpr (std::is_same_v<T, RecordObject>) value->freeze();
  else requireObject(value)->dynamicFreeze();
  return value;
}

inline Value objectFreeze(const Value& value) {
  if (value.isRecord()) value.record()->freeze();
  else requireObject(value)->dynamicFreeze();
  return value;
}

template <typename T>
inline bool objectIsExtensible(T* value) {
  if constexpr (std::is_same_v<T, RecordObject>) return value && value->isExtensible();
  else return value && value->dynamicIsExtensible();
}

inline bool objectIsExtensible(const Value& value) {
  return value.isRecord() ? value.record()->isExtensible() : requireObject(value)->dynamicIsExtensible();
}

template <typename T>
inline bool objectIsSealed(T* value) {
  if constexpr (std::is_same_v<T, RecordObject>) return value && value->isSealed();
  else return value && value->dynamicIsSealed();
}

inline bool objectIsSealed(const Value& value) {
  return value.isRecord() ? value.record()->isSealed() : requireObject(value)->dynamicIsSealed();
}

template <typename T>
inline bool objectIsFrozen(T* value) {
  if constexpr (std::is_same_v<T, RecordObject>) return value && value->isFrozen();
  else return value && value->dynamicIsFrozen();
}

inline bool objectIsFrozen(const Value& value) {
  return value.isRecord() ? value.record()->isFrozen() : requireObject(value)->dynamicIsFrozen();
}

inline bool objectIsPrototypeOf(const Value& prototype, const Value& candidate) {
  if (!prototype.isObject() || !candidate.isObject()) return false;
  BaseObject* current = candidate.isRecord() ? candidate.record()->prototype() : candidate.object()->dynamicPrototype();
  while (current) {
    if (current == prototype.object()) return true;
    if (current->objectKind() == BaseObject::Kind::Record) current = static_cast<RecordObject*>(current)->prototype();
    else current = current->dynamicPrototype();
  }
  return false;
}

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
