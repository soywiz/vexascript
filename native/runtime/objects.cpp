#include "runtime.hpp"

namespace vexa {

RecordObject* recordSpread(RecordObject* target, RecordObject* source) {
  if (!target || !source) throw runtimeError(u"Cannot spread a null object");
  source->copyTo(target);
  return target;
}

RecordObject* recordSpread(RecordObject* target, EnumerableObject* source) {
  if (!source) return target;
    for (const auto& key : source->enumerableKeys()) target->set(key, source->enumerableGet(key));
  return target;
}

RecordObject* recordSpread(RecordObject* target, BaseObject* source) {
  if (!source) return target;
    for (const auto& key : objectKeys(source)) target->set(key, source->dynamicGet(key));
  return target;
}

RecordObject* recordSpread(RecordObject* target, const Value& source) {
  if (source.isNull() || source.isUndefined()) return target;
  if (source.isRecord()) return recordSpread(target, source.record());
  if (source.isRuntimeObject()) return recordSpread(target, source.object());
  throw runtimeError(u"Object spread requires an enumerable object");
}

RecordObject* recordRest(
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

bool recordHas(RecordObject* record, const std::u16string& key) {
  return record && record->has(key);
}

bool hasProperty(const Value& value, const std::u16string& key) {
  if (value.isRecord()) return value.record()->has(key);
  if (value.isRuntimeObject()) return !value.object()->dynamicGet(key).isUndefined();
  return false;
}

bool hasProperty(RecordObject* record, const std::u16string& key) {
  return recordHas(record, key);
}

bool recordDelete(RecordObject* record, const std::u16string& key) {
  return record && record->erase(key);
}

Value dynamicObjectGet(BaseObject* target, const std::u16string& key) {
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

Value dynamicGet(const std::u16string& target, const std::u16string& key) {
  if (key == u"length") return Value(static_cast<double>(target.size()));
  if (const auto index = propertyIndex(key); index && *index < target.size()) {
    return Runtime::string(target.substr(*index, 1));
  }
  return Value::undefined();
}

Value dynamicGet(const Value& target, const std::u16string& key) {
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

Value dynamicGet(RecordObject* target, const std::u16string& key) {
  if (!target) throw runtimeError(u"Cannot read a property of null");
  return target->get(key);
}

Value dynamicGetOptional(const Value& target, const std::u16string& key) {
  return target.isNull() || target.isUndefined() ? Value::undefined() : dynamicGet(target, key);
}

Value dynamicSet(const Value& target, const std::u16string& key, const Value& value) {
  if (target.isRecord()) {
    target.record()->set(key, value);
    return value;
  }
  if (target.isRuntimeObject()) return target.object()->dynamicSet(key, value);
  throw runtimeError(u"Cannot set a property on this dynamic value");
}

Value dynamicSet(RecordObject* target, const std::u16string& key, const Value& value) {
  if (!target) throw runtimeError(u"Cannot set a property on null");
  target->set(key, value);
  return value;
}

bool dynamicDelete(const Value& target, const std::u16string& key) {
  if (target.isRecord()) return target.record()->erase(key);
  return target.isRuntimeObject() && target.object()->dynamicDelete(key);
}

Value recordGetOptional(RecordObject* record, const std::u16string& key) {
  return record ? record->get(key) : Value::undefined();
}

ArrayObject<std::u16string>* recordKeys(RecordObject* record) {
  auto* result = Runtime::array<std::u16string>();
  if (record) for (const auto& key : record->keys()) result->append(std::u16string(key));
  return result;
}

ArrayObject<std::u16string>* recordKeys(EnumerableObject* object) {
  auto* result = Runtime::array<std::u16string>();
  if (object) for (const auto& key : objectKeys(object)) result->append(std::u16string(key));
  return result;
}

ArrayObject<std::u16string>* recordKeys(BaseObject* object) {
  auto* result = Runtime::array<std::u16string>();
  if (object) for (const auto& key : objectKeys(object)) result->append(std::u16string(key));
  return result;
}

ArrayObject<Value>* recordValues(RecordObject* record) {
  auto* result = Runtime::array<Value>();
  if (record) for (const auto& value : record->values()) result->append(value);
  return result;
}

ArrayObject<Value>* recordValues(EnumerableObject* object) {
  auto* result = Runtime::array<Value>();
  if (object) {
    for (const auto& key : objectKeys(object)) result->append(object->enumerableGet(key));
  }
  return result;
}

ArrayObject<Value>* recordValues(BaseObject* object) {
  auto* result = Runtime::array<Value>();
  if (object) {
    for (const auto& key : objectKeys(object)) result->append(object->dynamicGet(key));
  }
  return result;
}

ArrayObject<ArrayObject<Value>*>* recordEntries(RecordObject* record) {
  auto* result = Runtime::array<ArrayObject<Value>*>();
  if (!record) return result;
  for (const auto& key : record->keys()) {
    result->append(Runtime::array<Value>({Runtime::string(key), record->get(key)}));
  }
  return result;
}

ArrayObject<ArrayObject<Value>*>* recordEntries(EnumerableObject* object) {
  auto* result = Runtime::array<ArrayObject<Value>*>();
  if (!object) return result;
  for (const auto& key : objectKeys(object)) {
    result->append(Runtime::array<Value>({Runtime::string(key), object->enumerableGet(key)}));
  }
  return result;
}

ArrayObject<ArrayObject<Value>*>* recordEntries(BaseObject* object) {
  auto* result = Runtime::array<ArrayObject<Value>*>();
  if (!object) return result;
  for (const auto& key : objectKeys(object)) {
    result->append(Runtime::array<Value>({Runtime::string(key), object->dynamicGet(key)}));
  }
  return result;
}

ArrayObject<ArrayObject<Value>*>* recordEntries(const Value& value) {
  if (value.isRecord()) return recordEntries(value.record());
  if (value.isRuntimeObject()) return recordEntries(value.object());
  return Runtime::array<ArrayObject<Value>*>();
}

RecordObject* recordFromEntries(const Value& entries) {
  auto* record = Runtime::record();
  for (const auto& entryValue : *arrayPointer(entries)) {
    auto* entry = arrayPointer(entryValue);
    if (entry->size() < 2) continue;
    record->set(propertyKey(entry->get(0)), entry->get(1));
  }
  return record;
}

ArrayObject<std::u16string>* recordKeys(const Value& value) {
  if (value.isRecord()) return recordKeys(value.record());
  if (value.isRuntimeObject()) return recordKeys(value.object());
  return Runtime::array<std::u16string>();
}

ArrayObject<Value>* recordValues(const Value& value) {
  if (value.isRecord()) return recordValues(value.record());
  if (value.isRuntimeObject()) return recordValues(value.object());
  return Runtime::array<Value>();
}

BaseObject* requireObject(const Value& value) {
  if (!value.isObject() || value.isString()) throw runtimeError(u"Object operation requires an object");
  return value.object();
}

RecordObject* objectCreate(const Value& prototype) {
  auto* result = Runtime::record();
  if (prototype.isNull()) return result;
  result->setPrototype(requireObject(prototype));
  return result;
}

Value objectConstructor() {
  return Value(Runtime::record());
}

bool objectHasOwn(const Value& value, const std::u16string& key) {
  if (value.isRecord()) return value.record()->has(key);
  if (value.isRuntimeObject()) return value.object()->dynamicHasOwn(key);
  return false;
}

bool objectPropertyIsEnumerable(const Value& value, const std::u16string& key) {
  if (value.isRecord()) return value.record()->propertyIsEnumerable(key);
  if (value.isRuntimeObject()) return value.object()->dynamicPropertyIsEnumerable(key);
  return false;
}

bool objectIs(const Value& left, const Value& right) {
  if (left.isNumber() && right.isNumber()) {
    if (std::isnan(left.number()) && std::isnan(right.number())) return true;
    if (left.number() == 0 && right.number() == 0) return std::signbit(left.number()) == std::signbit(right.number());
  }
  return left == right;
}

RecordObject* objectGetOwnPropertyDescriptor(const Value& value, const std::u16string& key) {
  if (value.isRecord()) return value.record()->descriptor(key);
  if (!value.isRuntimeObject() || !value.object()->dynamicHasOwn(key)) return nullptr;
  auto* result = Runtime::record();
  result->set(u"value", value.object()->dynamicGet(key));
  result->set(u"writable", Value(!value.object()->dynamicIsFrozen()));
  result->set(u"enumerable", Value(value.object()->dynamicPropertyIsEnumerable(key)));
  result->set(u"configurable", Value(!value.object()->dynamicIsSealed()));
  return result;
}

ArrayObject<std::u16string>* objectGetOwnPropertyNames(const Value& value) {
  auto* result = Runtime::array<std::u16string>();
  if (value.isRecord()) {
    for (const auto& key : value.record()->ownPropertyNames()) result->append(key);
  } else if (value.isRuntimeObject()) {
    for (const auto& key : value.object()->dynamicKeys()) result->append(key);
  }
  return result;
}

RecordObject* objectGetOwnPropertyDescriptors(const Value& value) {
  auto* result = Runtime::record();
  for (const auto& key : *objectGetOwnPropertyNames(value)) {
    result->set(key, Value(objectGetOwnPropertyDescriptor(value, key)));
  }
  return result;
}

Value objectGetPrototypeOf(const Value& value) {
  BaseObject* prototype = value.isRecord()
      ? value.record()->prototype()
      : requireObject(value)->dynamicPrototype();
  return prototype ? Value(prototype) : Value::null();
}

bool objectSetPrototypeOf(const Value& value, const Value& prototype) {
  BaseObject* target = requireObject(value);
  BaseObject* next = prototype.isNull() ? nullptr : requireObject(prototype);
  if (value.isRecord()) value.record()->setPrototype(next);
  else target->dynamicSetPrototype(next);
  return true;
}

Value objectPreventExtensions(const Value& value) {
  if (value.isRecord()) value.record()->preventExtensions();
  else requireObject(value)->dynamicPreventExtensions();
  return value;
}

Value objectSeal(const Value& value) {
  if (value.isRecord()) value.record()->seal();
  else requireObject(value)->dynamicSeal();
  return value;
}

Value objectFreeze(const Value& value) {
  if (value.isRecord()) value.record()->freeze();
  else requireObject(value)->dynamicFreeze();
  return value;
}

bool objectIsExtensible(const Value& value) {
  return value.isRecord() ? value.record()->isExtensible() : requireObject(value)->dynamicIsExtensible();
}

bool objectIsSealed(const Value& value) {
  return value.isRecord() ? value.record()->isSealed() : requireObject(value)->dynamicIsSealed();
}

bool objectIsFrozen(const Value& value) {
  return value.isRecord() ? value.record()->isFrozen() : requireObject(value)->dynamicIsFrozen();
}

bool objectIsPrototypeOf(const Value& prototype, const Value& candidate) {
  if (!prototype.isObject() || !candidate.isObject()) return false;
  BaseObject* current = candidate.isRecord() ? candidate.record()->prototype() : candidate.object()->dynamicPrototype();
  while (current) {
    if (current == prototype.object()) return true;
    if (current->objectKind() == BaseObject::Kind::Record) current = static_cast<RecordObject*>(current)->prototype();
    else current = current->dynamicPrototype();
  }
  return false;
}

}  // namespace vexa
