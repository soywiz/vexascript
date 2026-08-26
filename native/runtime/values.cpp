#include "runtime.hpp"

namespace vexa {

Value::operator std::u16string() const {
  return requireString(*this);
}

std::strong_ordering operator<=>(const std::u16string& left, const Value& right) {
  return left <=> requireString(right);
}

std::strong_ordering operator<=>(const Value& left, const std::u16string& right) {
  return requireString(left) <=> right;
}

BaseObject::Kind BaseObject::objectKind() const { return kind_; }

std::u16string BaseObject::dynamicInspect() const { return dynamicToString(); }

std::optional<std::u16string> BaseObject::dynamicJsonStringify(std::unordered_set<const void*>&) const {
    return std::nullopt;
  }

bool BaseObject::dynamicIsArray() const { return false; }

std::size_t BaseObject::dynamicArraySize() const { return 0; }

BaseObject* BaseObject::dynamicPrototype() const { return prototype_.Get(); }

void BaseObject::dynamicSetPrototype(BaseObject* prototype) {
    if (!extensible_ && prototype_.Get() != prototype) throw runtimeError(u"Object is not extensible");
    prototype_ = prototype;
  }

bool BaseObject::dynamicIsExtensible() const { return extensible_; }

bool BaseObject::dynamicIsSealed() const { return sealed_; }

bool BaseObject::dynamicIsFrozen() const { return frozen_; }

void BaseObject::dynamicPreventExtensions() { extensible_ = false; }

void BaseObject::dynamicSeal() { extensible_ = false; sealed_ = true; }

void BaseObject::dynamicFreeze() { extensible_ = false; sealed_ = true; frozen_ = true; }

const void* StringObject::dynamicTypeToken() const { return nativeTypeToken<StringObject>(); }

void* StringObject::dynamicCast(const void* type) {
    if (type == nativeTypeToken<StringObject>()) return this;
    return type == nativeTypeToken<BaseObject>() ? static_cast<BaseObject*>(this) : nullptr;
  }

std::u16string StringObject::dynamicToString() const { return value(); }

void StringObject::Trace(cppgc::Visitor* visitor) const {
    BaseObject::Trace(visitor);
    visitor->Trace(left_);
    visitor->Trace(right_);
  }

std::size_t StringObject::size() const { return size_; }

const std::u16string& StringObject::value() const {
    if (value_) return *value_;

    std::u16string flattened;
    flattened.reserve(size_);
    std::vector<const StringObject*> pending;
    pending.push_back(this);
    while (!pending.empty()) {
      const StringObject* current = pending.back();
      pending.pop_back();
      if (current->value_) {
        flattened.append(*current->value_);
        continue;
      }
      if (current->right_) pending.push_back(current->right_.Get());
      if (current->left_) pending.push_back(current->left_.Get());
    }
    value_ = std::move(flattened);
    return *value_;
  }

Value Value::undefined() { return Value(); }

Value Value::null() { return Value(Null{}); }

bool Value::isUndefined() const { return std::holds_alternative<Undefined>(storage_); }

bool Value::isNull() const { return std::holds_alternative<Null>(storage_); }

bool Value::isBoolean() const { return std::holds_alternative<bool>(storage_); }

bool Value::isNumber() const { return std::holds_alternative<double>(storage_); }

bool Value::isBigInt() const { return std::holds_alternative<BigInt>(storage_); }

bool Value::isObject() const { return std::holds_alternative<cppgc::Persistent<BaseObject>>(storage_); }

bool Value::isString() const { return isObject() && object()->objectKind() == BaseObject::Kind::String; }

bool Value::isRecord() const { return isObject() && object()->objectKind() == BaseObject::Kind::Record; }

bool Value::isRuntimeObject() const {
    return isObject() && object()->objectKind() == BaseObject::Kind::Object;
  }

bool Value::boolean() const { return std::get<bool>(storage_); }

double Value::number() const { return std::get<double>(storage_); }

const BigInt& Value::bigint() const { return std::get<BigInt>(storage_); }

const std::u16string& Value::string() const {
    return stringObject()->value();
  }

const std::u16string& Value::utf16() const {
    return stringObject()->value();
  }

StringObject* Value::stringObject() const {
    return static_cast<StringObject*>(object());
  }

BaseObject* Value::object() const {
    return std::get<cppgc::Persistent<BaseObject>>(storage_).Get();
  }

const std::u16string& requireString(const Value& value) {
  if (!value.isString()) {
    throw errorAtCurrentSource(u"VexaScript value is not a string");
  }
  return value.utf16();
}

std::u16string& operator+=(std::u16string& left, const Value& right) {
  left += requireString(right);
  return left;
}

std::u16string operator+(std::u16string left, const Value& right) {
  left += right;
  return left;
}

std::u16string operator+(const Value& left, std::u16string right) {
  right.insert(0, requireString(left));
  return right;
}

bool operator==(const std::u16string& left, const Value& right) {
  return left == requireString(right);
}

bool operator==(const Value& left, const std::u16string& right) {
  return requireString(left) == right;
}

StoredValue& StoredValue::operator=(const Value& value) {
    store(value);
    return *this;
  }

std::size_t stringCodeUnitLength(const Value& value) {
  return value.isString() ? value.utf16().size() : std::numeric_limits<std::size_t>::max();
}

std::size_t stringCodeUnitLength(const std::u16string& value) {
  return value.size();
}

std::int32_t stringFirstCodeUnit(const Value& value) {
  return value.isString() && !value.utf16().empty()
    ? static_cast<std::uint16_t>(value.utf16()[0])
    : -1;
}

std::int32_t stringFirstCodeUnit(const std::u16string& value) {
  return value.empty() ? -1 : static_cast<std::uint16_t>(value[0]);
}

const void* RecordObject::dynamicTypeToken() const { return nativeTypeToken<RecordObject>(); }

void* RecordObject::dynamicCast(const void* type) {
    if (type == nativeTypeToken<RecordObject>()) return this;
    return type == nativeTypeToken<BaseObject>() ? static_cast<BaseObject*>(this) : nullptr;
  }

std::u16string RecordObject::dynamicToString() const { return u"[object Object]"; }

Value RecordObject::dynamicGet(const std::u16string& key) { return get(key); }

Value RecordObject::dynamicSet(const std::u16string& key, const Value& value) {
    set(key, value);
    return value;
  }

std::vector<std::u16string> RecordObject::dynamicKeys() const { return keys(); }

bool RecordObject::dynamicDelete(const std::u16string& key) { return erase(key); }

void RecordObject::setHidden(std::u16string key, const Value& value) { define(std::move(key), value, false); }

BaseObject* RecordObject::prototype() const { return prototype_.Get(); }

void RecordObject::setPrototype(BaseObject* prototype) {
    if (!extensible_ && prototype_.Get() != prototype) throw runtimeError(u"Object is not extensible");
    prototype_ = prototype;
  }

bool RecordObject::isExtensible() const { return extensible_; }

bool RecordObject::isSealed() const { return sealed_; }

bool RecordObject::isFrozen() const { return frozen_; }

void RecordObject::preventExtensions() { extensible_ = false; }

void* EnumerableObject::nativeInterfaceCast(const void* type) {
    return type == nativeTypeToken<EnumerableObject>() ? this : nullptr;
  }

std::vector<std::u16string> EnumerableObject::enumerableKeys() const { return {}; }

Value EnumerableObject::enumerableGet(const std::u16string&) { return Value::undefined(); }

RecordObject* EnumerableObject::enumerableBackingRecord() { return nullptr; }

void EnumerableObject::defineProperty(const std::u16string&, const Value&, bool) {
    throw runtimeError(u"Native object does not support dynamic property definitions");
  }

std::vector<std::u16string> objectKeys(RecordObject* object) {
  return object ? object->keys() : std::vector<std::u16string>{};
}

std::vector<std::u16string> objectKeys(EnumerableObject* object) {
  return object ? object->enumerableKeys() : std::vector<std::u16string>{};
}

std::vector<std::u16string> objectKeys(BaseObject* object) {
  return object
    ? object->dynamicEnumerableKeys(object->dynamicKeys())
    : std::vector<std::u16string>{};
}

std::vector<std::u16string> objectKeys(const Value& value) {
  if (value.isRecord()) return value.record()->keys();
  if (value.isRuntimeObject()) return objectKeys(value.object());
  return {};
}

Value enumerableGet(RecordObject* object, const std::u16string& key) {
  return object ? object->get(key) : Value::undefined();
}

Value enumerableGet(EnumerableObject* object, const std::u16string& key) {
  return object ? object->enumerableGet(key) : Value::undefined();
}

RecordObject* Value::record() const {
  return static_cast<RecordObject*>(object());
}

bool Value::operator==(const Value& other) const {
  if (storage_.index() != other.storage_.index()) return false;
  if (isUndefined() || isNull()) return true;
  if (isBoolean()) return boolean() == other.boolean();
  if (isNumber()) return number() == other.number();
  if (isBigInt()) return bigint() == other.bigint();
  if (isString()) return utf16() == other.utf16();
  return object() == other.object();
}

Value BaseObject::dynamicCall(const std::vector<Value>&) {
  throw runtimeError(u"VexaScript dynamic value is not callable");
}

Value BaseObject::dynamicGet(const std::u16string& key) {
  if (dynamic_properties_ && dynamic_properties_->has(key)) return dynamic_properties_->get(key);
  return prototype_ ? prototype_->dynamicGet(key) : Value::undefined();
}

Value BaseObject::dynamicSet(const std::u16string& key, const Value& value) {
  if (frozen_) throw runtimeError(u"Cannot modify a frozen object");
  if (!dynamic_properties_) {
    if (!extensible_) throw runtimeError(u"Object is not extensible");
    dynamic_properties_ = makeDynamicPropertyRecord();
  } else if (!dynamic_properties_->has(key) && !extensible_) {
    throw runtimeError(u"Object is not extensible");
  }
  dynamic_properties_->set(key, value);
  return value;
}

std::vector<std::u16string> BaseObject::dynamicKeys() const {
  return dynamic_properties_ ? dynamic_properties_->keys() : std::vector<std::u16string>{};
}

void BaseObject::dynamicDefineProperty(
    const std::u16string& key,
    const Value& value,
    bool enumerable) {
  dynamicSet(key, value);
  if (enumerable) non_enumerable_properties_.erase(key);
  else non_enumerable_properties_.insert(key);
}

bool BaseObject::dynamicHasOwn(const std::u16string& key) const {
  return dynamic_properties_ && dynamic_properties_->has(key);
}

bool BaseObject::dynamicPropertyIsEnumerable(const std::u16string& key) const {
  return dynamicHasOwn(key) && !non_enumerable_properties_.contains(key);
}

std::vector<std::u16string> BaseObject::dynamicEnumerableKeys(
    std::vector<std::u16string> keys) const {
  std::erase_if(keys, [&](const std::u16string& key) {
    return non_enumerable_properties_.contains(key);
  });
  return keys;
}

bool BaseObject::dynamicDelete(const std::u16string& key) {
  if (sealed_) return false;
  non_enumerable_properties_.erase(key);
  return dynamic_properties_ && dynamic_properties_->erase(key);
}

void BaseObject::Trace(cppgc::Visitor* visitor) const {
  visitor->Trace(dynamic_properties_);
  visitor->Trace(prototype_);
}

Value RecordObject::get(const std::u16string& key) const {
  if (dynamic_backing_) return dynamic_backing_->dynamicGet(key);
  const auto property = properties_.find(key);
  if (property != properties_.end()) return property->second.load();
  const auto hidden = hidden_properties_.find(key);
  if (hidden != hidden_properties_.end()) return hidden->second.load();
  return prototype_ ? prototype_->dynamicGet(key) : Value::undefined();
}

void RecordObject::set(std::u16string key, const Value& value) {
  if (dynamic_backing_) {
    dynamic_backing_->dynamicSet(key, value);
    return;
  }
  if (frozen_) throw runtimeError(u"Cannot modify a frozen object");
  const bool exists = has(key);
  if (!exists && !extensible_) throw runtimeError(u"Object is not extensible");
  if (exists && writable_properties_.contains(key) && !writable_properties_.at(key)) {
    throw runtimeError(u"Cannot assign to a read-only property");
  }
  if (hidden_properties_.erase(key) > 0) {
    hidden_property_order_.erase(std::remove(hidden_property_order_.begin(), hidden_property_order_.end(), key), hidden_property_order_.end());
  }
  if (!properties_.contains(key)) property_order_.push_back(key);
  properties_.insert_or_assign(std::move(key), StoredValue(value));
}

void RecordObject::define(
    std::u16string key,
    const Value& value,
    bool enumerable,
    bool writable,
    bool configurable) {
  if (dynamic_backing_) {
    dynamic_backing_->dynamicDefineProperty(key, value, enumerable);
    return;
  }
  const bool exists = has(key);
  if (!exists && !extensible_) throw runtimeError(u"Object is not extensible");
  if (exists && configurable_properties_.contains(key) && !configurable_properties_.at(key)) {
    const bool oldEnumerable = properties_.contains(key);
    if (oldEnumerable != enumerable || configurable) throw runtimeError(u"Cannot redefine a non-configurable property");
    if (!writable_properties_.at(key) && writable) throw runtimeError(u"Cannot make a non-writable property writable");
    if (!writable_properties_.at(key) && get(key) != value) throw runtimeError(u"Cannot modify a read-only property");
  }
  if (properties_.erase(key) > 0) {
    property_order_.erase(std::remove(property_order_.begin(), property_order_.end(), key), property_order_.end());
  }
  if (hidden_properties_.erase(key) > 0) {
    hidden_property_order_.erase(std::remove(hidden_property_order_.begin(), hidden_property_order_.end(), key), hidden_property_order_.end());
  }
  if (enumerable) {
    property_order_.push_back(key);
    properties_.insert_or_assign(key, StoredValue(value));
  } else {
    hidden_property_order_.push_back(key);
    hidden_properties_.insert_or_assign(key, StoredValue(value));
  }
  writable_properties_.insert_or_assign(key, writable);
  configurable_properties_.insert_or_assign(std::move(key), configurable);
}

bool RecordObject::has(const std::u16string& key) const {
  if (dynamic_backing_) {
    const auto keys = dynamic_backing_->dynamicKeys();
    return std::find(keys.begin(), keys.end(), key) != keys.end();
  }
  return properties_.contains(key) || hidden_properties_.contains(key);
}

bool RecordObject::propertyIsEnumerable(const std::u16string& key) const {
  if (dynamic_backing_) return dynamic_backing_->dynamicPropertyIsEnumerable(key);
  return properties_.contains(key);
}

bool RecordObject::erase(const std::u16string& key) {
  if (dynamic_backing_) return dynamic_backing_->dynamicDelete(key);
  if (configurable_properties_.contains(key) && !configurable_properties_.at(key)) return false;
  if (sealed_) return false;
  const bool visible = properties_.erase(key) > 0;
  const bool hidden = hidden_properties_.erase(key) > 0;
  if (visible) property_order_.erase(std::remove(property_order_.begin(), property_order_.end(), key), property_order_.end());
  if (hidden) hidden_property_order_.erase(std::remove(hidden_property_order_.begin(), hidden_property_order_.end(), key), hidden_property_order_.end());
  writable_properties_.erase(key);
  configurable_properties_.erase(key);
  return visible || hidden;
}

void RecordObject::copyTo(RecordObject* target) const {
  if (dynamic_backing_) {
    for (const auto& key : keys()) target->set(key, get(key));
    return;
  }
  for (const auto& key : property_order_) target->set(key, get(key));
}

std::vector<std::u16string> RecordObject::keys() const {
  if (dynamic_backing_) {
    return dynamic_backing_->dynamicEnumerableKeys(dynamic_backing_->dynamicKeys());
  }
  return property_order_;
}

std::vector<std::u16string> RecordObject::ownPropertyNames() const {
  if (dynamic_backing_) return dynamic_backing_->dynamicKeys();
  auto result = property_order_;
  result.insert(result.end(), hidden_property_order_.begin(), hidden_property_order_.end());
  return result;
}

void RecordObject::seal() {
  extensible_ = false;
  sealed_ = true;
  for (const auto& key : ownPropertyNames()) configurable_properties_.insert_or_assign(key, false);
}

void RecordObject::freeze() {
  seal();
  frozen_ = true;
  for (const auto& key : ownPropertyNames()) writable_properties_.insert_or_assign(key, false);
}

std::vector<Value> RecordObject::values() const {
  std::vector<Value> result;
  if (dynamic_backing_) {
    const auto visibleKeys = keys();
    result.reserve(visibleKeys.size());
    for (const auto& key : visibleKeys) result.push_back(get(key));
    return result;
  }
  result.reserve(property_order_.size());
  for (const auto& key : property_order_) result.push_back(get(key));
  return result;
}

void RecordObject::Trace(cppgc::Visitor* visitor) const {
  BaseObject::Trace(visitor);
  visitor->Trace(dynamic_backing_);
  visitor->Trace(prototype_);
  for (const auto& [key, value] : properties_) value.Trace(visitor);
  for (const auto& [key, value] : hidden_properties_) value.Trace(visitor);
}

Value BaseObject::dynamicArrayGet(std::size_t) {
  throw runtimeError(u"Dynamic native object is not an array");
}

bool BaseObject::dynamicIsIterable() const {
  return dynamicIsArray();
}

std::size_t BaseObject::dynamicIterableSize() const {
  return dynamicArraySize();
}

Value BaseObject::dynamicIterableGet(std::size_t index) {
  return dynamicArrayGet(index);
}

Value StoredValue::load() const {
  if (std::holds_alternative<Undefined>(storage_)) return Value::undefined();
  if (std::holds_alternative<Null>(storage_)) return Value::null();
  if (const auto* value = std::get_if<bool>(&storage_)) return Value(*value);
  if (const auto* value = std::get_if<double>(&storage_)) return Value(*value);
  if (const auto* value = std::get_if<BigInt>(&storage_)) return Value(*value);
  return Value(std::get<BaseObject*>(storage_));
}

void StoredValue::store(const Value& value) {
  if (value.isUndefined()) storage_ = Undefined{};
  else if (value.isNull()) storage_ = Null{};
  else if (value.isBoolean()) storage_ = value.boolean();
  else if (value.isNumber()) storage_ = value.number();
  else if (value.isBigInt()) storage_ = value.bigint();
  else storage_ = value.object();
}

void StoredValue::Trace(cppgc::Visitor* visitor) const {
  if (const auto* value = std::get_if<BaseObject*>(&storage_)) {
    const cppgc::Member<BaseObject> member(*value);
    visitor->Trace(member);
  }
}


BaseObject::BaseObject(Kind kind) : kind_(kind) {}

BaseObject::~BaseObject() = default;

EnumerableObject::~EnumerableObject() = default;

StringObject::StringObject(std::u16string value)
      : BaseObject(Kind::String), value_(std::move(value)), size_(value_->size()) {}

StringObject::StringObject(StringObject* left, StringObject* right)
      : BaseObject(Kind::String), left_(left), right_(right), size_(left->size() + right->size()) {}

Value::Value() : storage_(Undefined{}) {}

Value::Value(bool value) : storage_(value) {}

Value::Value(double value) : storage_(value) {}

Value::Value(int value) : storage_(static_cast<double>(value)) {}

Value::Value(BigInt value) : storage_(std::move(value)) {}

Value::Value(StringObject* value) : storage_(cppgc::Persistent<BaseObject>(value)) {}

Value::Value(BaseObject* value)
      : storage_(cppgc::Persistent<BaseObject>(value)) {}

Value::operator bool() const {
    if (isUndefined() || isNull()) return false;
    if (isBoolean()) return boolean();
    if (isNumber()) return number() != 0 && !std::isnan(number());
    if (isBigInt()) return !bigint().isZero();
    return !isString() || !utf16().empty();
  }

Value::Value(Null value) : storage_(value) {}

StoredValue::StoredValue() : storage_(Undefined{}) {}

StoredValue::StoredValue(const Value& value) { store(value); }

RecordObject::RecordObject() : BaseObject(Kind::Record) {}

Value::Value(RecordObject* value)
    : storage_(cppgc::Persistent<BaseObject>(value)) {}

RecordObject::RecordObject(BaseObject* dynamicBacking)
    : BaseObject(Kind::Record), dynamic_backing_(dynamicBacking) {}

StoredValue::operator Value() const { return load(); }
}  // namespace vexa
