#pragma once

// Internal runtime category header. Include runtime.hpp instead.

struct Undefined final {};
struct Null final {};
class RecordObject;
class Runtime;
template <typename T, typename... Arguments>
T* makeManaged(Arguments&&... arguments);
class BaseObject;
class StringObject;
class EnumerableObject;
class Value;
std::runtime_error errorAtCurrentSource(std::u16string);
template <typename T>
class ArrayObject;
template <typename K, typename V>
class MapObject;
template <typename T>
class SetObject;
ArrayObject<Value>* makeDynamicArrayValueView(BaseObject* backing);
std::u16string toString(const Value&);
std::u16string jsonQuoted(const std::u16string&);
double Number(const Value&);
BigInt makeBigInt(const Value&);
template <typename Result, typename Input>
Result convertValue(Input&&);
template <typename T>
T defaultValue();
template <typename T>
struct IsStdFunction : std::false_type {};
template <typename Result, typename... Arguments>
struct IsStdFunction<std::function<Result(Arguments...)>> : std::true_type {};
template <typename Result>
Result functionFromValue(const Value&);
template <typename T>
std::u16string jsonStringifyNative(const T&, std::unordered_set<const void*>&);
template <typename T>
class Task;
template <typename T>
struct TaskTraits final {
  static constexpr bool value = false;
};
template <typename T>
struct TaskTraits<Task<T>> final {
  static constexpr bool value = true;
  using Result = T;
};
template <typename T>
struct PromiseResult;
template <typename T>
std::u16string toString(const Task<T>&);
RecordObject* makeDynamicPropertyRecord();

template <typename T>
inline const void* nativeTypeToken() {
  static const int token = 0;
  return &token;
}

class BaseObject : public cppgc::GarbageCollectedMixin {
 public:
  enum class Kind : std::uint8_t {
    Object,
    String,
    Record,
  };

  explicit BaseObject(Kind kind = Kind::Object) : kind_(kind) {}
  virtual ~BaseObject() = default;
  Kind objectKind() const { return kind_; }
  virtual const void* dynamicTypeToken() const = 0;
  virtual void* dynamicCast(const void* type) = 0;
  virtual std::u16string dynamicToString() const = 0;
  virtual std::optional<std::u16string> dynamicJsonStringify(std::unordered_set<const void*>&) const {
    return std::nullopt;
  }
  virtual Value dynamicGet(const std::u16string&);
  virtual Value dynamicSet(const std::u16string&, const Value&);
  virtual std::vector<std::u16string> dynamicKeys() const;
  virtual bool dynamicDelete(const std::u16string&);
  bool dynamicHasOwn(const std::u16string&) const;
  bool dynamicPropertyIsEnumerable(const std::u16string&) const;
  virtual Value dynamicCall(const std::vector<Value>&);
  virtual bool dynamicIsArray() const { return false; }
  virtual std::size_t dynamicArraySize() const { return 0; }
  virtual Value dynamicArrayGet(std::size_t);
  virtual bool dynamicIsIterable() const;
  virtual std::size_t dynamicIterableSize() const;
  virtual Value dynamicIterableGet(std::size_t);
  void dynamicDefineProperty(const std::u16string&, const Value&, bool enumerable);
  std::vector<std::u16string> dynamicEnumerableKeys(std::vector<std::u16string>) const;
  BaseObject* dynamicPrototype() const { return prototype_.Get(); }
  void dynamicSetPrototype(BaseObject* prototype) {
    if (!extensible_ && prototype_.Get() != prototype) throw runtimeError(u"Object is not extensible");
    prototype_ = prototype;
  }
  bool dynamicIsExtensible() const { return extensible_; }
  bool dynamicIsSealed() const { return sealed_; }
  bool dynamicIsFrozen() const { return frozen_; }
  void dynamicPreventExtensions() { extensible_ = false; }
  void dynamicSeal() { extensible_ = false; sealed_ = true; }
  void dynamicFreeze() { extensible_ = false; sealed_ = true; frozen_ = true; }
  void Trace(cppgc::Visitor*) const;

 private:
  Kind kind_;
  cppgc::Member<RecordObject> dynamic_properties_;
  cppgc::Member<BaseObject> prototype_;
  std::unordered_set<std::u16string> non_enumerable_properties_;
  bool extensible_ = true;
  bool sealed_ = false;
  bool frozen_ = false;
};

class StringObject final
    : public cppgc::GarbageCollected<StringObject>,
      public BaseObject {
 public:
  explicit StringObject(std::u16string value)
      : BaseObject(Kind::String), value_(std::move(value)), size_(value_->size()) {}
  StringObject(StringObject* left, StringObject* right)
      : BaseObject(Kind::String), left_(left), right_(right), size_(left->size() + right->size()) {}

  const void* dynamicTypeToken() const override { return nativeTypeToken<StringObject>(); }
  void* dynamicCast(const void* type) override {
    if (type == nativeTypeToken<StringObject>()) return this;
    return type == nativeTypeToken<BaseObject>() ? static_cast<BaseObject*>(this) : nullptr;
  }
  std::u16string dynamicToString() const override { return value(); }

  void Trace(cppgc::Visitor* visitor) const override {
    BaseObject::Trace(visitor);
    visitor->Trace(left_);
    visitor->Trace(right_);
  }

  std::size_t size() const { return size_; }

  const std::u16string& value() const {
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

 private:
  mutable std::optional<std::u16string> value_;
  cppgc::Member<StringObject> left_;
  cppgc::Member<StringObject> right_;
  std::size_t size_ = 0;
};

class Value final {
 public:
  using Storage = std::variant<
      Undefined,
      Null,
      bool,
      double,
      BigInt,
      cppgc::Persistent<BaseObject>>;

  Value() : storage_(Undefined{}) {}
  Value(bool value) : storage_(value) {}
  Value(double value) : storage_(value) {}
  Value(int value) : storage_(static_cast<double>(value)) {}
  Value(BigInt value) : storage_(std::move(value)) {}
  explicit Value(StringObject* value) : storage_(cppgc::Persistent<BaseObject>(value)) {}
  explicit Value(RecordObject* value);
  template <typename T>
    requires std::is_base_of_v<BaseObject, T>
  Value(T* value) : storage_(cppgc::Persistent<BaseObject>(value)) {}
  explicit Value(BaseObject* value)
      : storage_(cppgc::Persistent<BaseObject>(value)) {}

  static Value undefined() { return Value(); }
  static Value null() { return Value(Null{}); }

  bool isUndefined() const { return std::holds_alternative<Undefined>(storage_); }
  bool isNull() const { return std::holds_alternative<Null>(storage_); }
  bool isBoolean() const { return std::holds_alternative<bool>(storage_); }
  bool isNumber() const { return std::holds_alternative<double>(storage_); }
  bool isBigInt() const { return std::holds_alternative<BigInt>(storage_); }
  bool isObject() const { return std::holds_alternative<cppgc::Persistent<BaseObject>>(storage_); }
  bool isString() const { return isObject() && object()->objectKind() == BaseObject::Kind::String; }
  bool isRecord() const { return isObject() && object()->objectKind() == BaseObject::Kind::Record; }
  bool isRuntimeObject() const {
    return isObject() && object()->objectKind() == BaseObject::Kind::Object;
  }

  bool boolean() const { return std::get<bool>(storage_); }
  double number() const { return std::get<double>(storage_); }
  const BigInt& bigint() const { return std::get<BigInt>(storage_); }
  const std::u16string& string() const {
    return stringObject()->value();
  }
  const std::u16string& utf16() const {
    return stringObject()->value();
  }
  StringObject* stringObject() const {
    return static_cast<StringObject*>(object());
  }
  RecordObject* record() const;
  BaseObject* object() const {
    return std::get<cppgc::Persistent<BaseObject>>(storage_).Get();
  }
  template <typename Result>
  Result toInstance() const;

  explicit operator bool() const {
    if (isUndefined() || isNull()) return false;
    if (isBoolean()) return boolean();
    if (isNumber()) return number() != 0 && !std::isnan(number());
    if (isBigInt()) return !bigint().isZero();
    return !isString() || !utf16().empty();
  }

  operator std::u16string() const;

  bool operator==(const Value& other) const;

 private:
  friend class StoredValue;
  explicit Value(Null value) : storage_(value) {}
  Storage storage_;
};

inline const std::u16string& requireString(const Value& value) {
  if (!value.isString()) {
    throw errorAtCurrentSource(u"VexaScript value is not a string");
  }
  return value.utf16();
}

inline Value::operator std::u16string() const {
  return requireString(*this);
}

inline std::u16string& operator+=(std::u16string& left, const Value& right) {
  left += requireString(right);
  return left;
}

inline std::u16string operator+(std::u16string left, const Value& right) {
  left += right;
  return left;
}

inline std::u16string operator+(const Value& left, std::u16string right) {
  right.insert(0, requireString(left));
  return right;
}

inline bool operator==(const std::u16string& left, const Value& right) {
  return left == requireString(right);
}

inline bool operator==(const Value& left, const std::u16string& right) {
  return requireString(left) == right;
}

inline auto operator<=>(const std::u16string& left, const Value& right) {
  return left <=> requireString(right);
}

inline auto operator<=>(const Value& left, const std::u16string& right) {
  return requireString(left) <=> right;
}

class StoredValue final {
 public:
  using Storage = std::variant<
      Undefined,
      Null,
      bool,
      double,
      BigInt,
      BaseObject*>;

  StoredValue() : storage_(Undefined{}) {}
  explicit StoredValue(const Value& value) { store(value); }

  operator Value() const;
  StoredValue& operator=(const Value& value) {
    store(value);
    return *this;
  }

  Value load() const;
  void store(const Value& value);
  void Trace(cppgc::Visitor* visitor) const;

 private:
  Storage storage_;
};

inline std::size_t stringCodeUnitLength(const Value& value) {
  return value.isString() ? value.utf16().size() : std::numeric_limits<std::size_t>::max();
}

inline std::size_t stringCodeUnitLength(const std::u16string& value) {
  return value.size();
}

inline std::int32_t stringFirstCodeUnit(const Value& value) {
  return value.isString() && !value.utf16().empty()
    ? static_cast<std::uint16_t>(value.utf16()[0])
    : -1;
}

inline std::int32_t stringFirstCodeUnit(const std::u16string& value) {
  return value.empty() ? -1 : static_cast<std::uint16_t>(value[0]);
}

class RecordObject final
    : public cppgc::GarbageCollected<RecordObject>,
      public BaseObject {
 public:
  RecordObject() : BaseObject(Kind::Record) {}
  explicit RecordObject(BaseObject* dynamicBacking);

  const void* dynamicTypeToken() const override { return nativeTypeToken<RecordObject>(); }
  void* dynamicCast(const void* type) override {
    if (type == nativeTypeToken<RecordObject>()) return this;
    return type == nativeTypeToken<BaseObject>() ? static_cast<BaseObject*>(this) : nullptr;
  }
  std::u16string dynamicToString() const override { return u"[object Object]"; }
  Value dynamicGet(const std::u16string& key) override { return get(key); }
  Value dynamicSet(const std::u16string& key, const Value& value) override {
    set(key, value);
    return value;
  }
  std::vector<std::u16string> dynamicKeys() const override { return keys(); }
  bool dynamicDelete(const std::u16string& key) override { return erase(key); }

  Value get(const std::u16string& key) const;
  void set(std::u16string key, const Value& value);
  void define(std::u16string key, const Value& value, bool enumerable, bool writable = false, bool configurable = false);
  void setHidden(std::u16string key, const Value& value) { define(std::move(key), value, false); }
  bool has(const std::u16string& key) const;
  bool propertyIsEnumerable(const std::u16string& key) const;
  bool erase(const std::u16string& key);
  void copyTo(RecordObject* target) const;
  std::vector<std::u16string> keys() const;
  std::vector<std::u16string> ownPropertyNames() const;
  std::vector<Value> values() const;
  BaseObject* prototype() const { return prototype_.Get(); }
  void setPrototype(BaseObject* prototype) {
    if (!extensible_ && prototype_.Get() != prototype) throw runtimeError(u"Object is not extensible");
    prototype_ = prototype;
  }
  bool isExtensible() const { return extensible_; }
  bool isSealed() const { return sealed_; }
  bool isFrozen() const { return frozen_; }
  void preventExtensions() { extensible_ = false; }
  void seal();
  void freeze();
  RecordObject* descriptor(const std::u16string& key) const;
  void Trace(cppgc::Visitor* visitor) const;

 private:
  cppgc::Member<BaseObject> dynamic_backing_;
  std::unordered_map<std::u16string, StoredValue> properties_;
  std::unordered_map<std::u16string, StoredValue> hidden_properties_;
  std::vector<std::u16string> property_order_;
  std::vector<std::u16string> hidden_property_order_;
  std::unordered_map<std::u16string, bool> writable_properties_;
  std::unordered_map<std::u16string, bool> configurable_properties_;
  cppgc::Member<BaseObject> prototype_;
  bool extensible_ = true;
  bool sealed_ = false;
  bool frozen_ = false;
};

class EnumerableObject {
 public:
  virtual ~EnumerableObject() = default;
  virtual void* nativeInterfaceCast(const void* type) {
    return type == nativeTypeToken<EnumerableObject>() ? this : nullptr;
  }
  virtual std::vector<std::u16string> enumerableKeys() const { return {}; }
  virtual Value enumerableGet(const std::u16string&) { return Value::undefined(); }
  virtual RecordObject* enumerableBackingRecord() { return nullptr; }
  virtual void defineProperty(const std::u16string&, const Value&, bool) {
    throw runtimeError(u"Native object does not support dynamic property definitions");
  }
};

template <typename T>
struct OptionalTraits final {
  static constexpr bool value = false;
};

template <typename T>
struct OptionalTraits<std::optional<T>> final {
  static constexpr bool value = true;
  using Element = T;
};

inline std::vector<std::u16string> objectKeys(RecordObject* object) {
  return object ? object->keys() : std::vector<std::u16string>{};
}

inline std::vector<std::u16string> objectKeys(EnumerableObject* object) {
  return object ? object->enumerableKeys() : std::vector<std::u16string>{};
}

inline std::vector<std::u16string> objectKeys(BaseObject* object) {
  return object
    ? object->dynamicEnumerableKeys(object->dynamicKeys())
    : std::vector<std::u16string>{};
}

inline std::vector<std::u16string> objectKeys(const Value& value) {
  if (value.isRecord()) return value.record()->keys();
  if (value.isRuntimeObject()) return objectKeys(value.object());
  return {};
}

template <typename T>
  requires std::is_base_of_v<BaseObject, T>
inline std::vector<std::u16string> objectKeys(T* object) {
  return objectKeys(static_cast<BaseObject*>(object));
}

inline Value enumerableGet(RecordObject* object, const std::u16string& key) {
  return object ? object->get(key) : Value::undefined();
}

inline Value enumerableGet(EnumerableObject* object, const std::u16string& key) {
  return object ? object->enumerableGet(key) : Value::undefined();
}

inline Value::Value(RecordObject* value)
    : storage_(cppgc::Persistent<BaseObject>(value)) {}

inline RecordObject* Value::record() const {
  return static_cast<RecordObject*>(object());
}

inline bool Value::operator==(const Value& other) const {
  if (storage_.index() != other.storage_.index()) return false;
  if (isUndefined() || isNull()) return true;
  if (isBoolean()) return boolean() == other.boolean();
  if (isNumber()) return number() == other.number();
  if (isBigInt()) return bigint() == other.bigint();
  if (isString()) return utf16() == other.utf16();
  return object() == other.object();
}

template <typename T, typename Other>
  requires std::is_same_v<std::remove_cvref_t<Other>, Value>
inline bool operator==(const cppgc::Persistent<T>& value, Other&& other) {
  if (other.isUndefined() || other.isNull()) return value.Get() == nullptr;
  if (!other.isRuntimeObject()) return false;
  return other.object()->dynamicCast(nativeTypeToken<T>()) == value.Get();
}

template <typename Other, typename T>
  requires std::is_same_v<std::remove_cvref_t<Other>, Value>
inline bool operator==(Other&& other, const cppgc::Persistent<T>& value) {
  return value == std::forward<Other>(other);
}

template <typename T, typename Other>
  requires std::is_same_v<std::remove_cvref_t<Other>, Value>
inline bool operator==(const cppgc::Member<T>& value, Other&& other) {
  if (other.isUndefined() || other.isNull()) return value.Get() == nullptr;
  if (!other.isRuntimeObject()) return false;
  return other.object()->dynamicCast(nativeTypeToken<T>()) == value.Get();
}

template <typename Other, typename T>
  requires std::is_same_v<std::remove_cvref_t<Other>, Value>
inline bool operator==(Other&& other, const cppgc::Member<T>& value) {
  return value == std::forward<Other>(other);
}

inline Value BaseObject::dynamicCall(const std::vector<Value>&) {
  throw runtimeError(u"VexaScript dynamic value is not callable");
}

inline Value BaseObject::dynamicGet(const std::u16string& key) {
  if (dynamic_properties_ && dynamic_properties_->has(key)) return dynamic_properties_->get(key);
  return prototype_ ? prototype_->dynamicGet(key) : Value::undefined();
}

inline Value BaseObject::dynamicSet(const std::u16string& key, const Value& value) {
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

inline std::vector<std::u16string> BaseObject::dynamicKeys() const {
  return dynamic_properties_ ? dynamic_properties_->keys() : std::vector<std::u16string>{};
}

inline void BaseObject::dynamicDefineProperty(
    const std::u16string& key,
    const Value& value,
    bool enumerable) {
  dynamicSet(key, value);
  if (enumerable) non_enumerable_properties_.erase(key);
  else non_enumerable_properties_.insert(key);
}

inline bool BaseObject::dynamicHasOwn(const std::u16string& key) const {
  return dynamic_properties_ && dynamic_properties_->has(key);
}

inline bool BaseObject::dynamicPropertyIsEnumerable(const std::u16string& key) const {
  return dynamicHasOwn(key) && !non_enumerable_properties_.contains(key);
}

inline std::vector<std::u16string> BaseObject::dynamicEnumerableKeys(
    std::vector<std::u16string> keys) const {
  std::erase_if(keys, [&](const std::u16string& key) {
    return non_enumerable_properties_.contains(key);
  });
  return keys;
}

inline bool BaseObject::dynamicDelete(const std::u16string& key) {
  if (sealed_) return false;
  non_enumerable_properties_.erase(key);
  return dynamic_properties_ && dynamic_properties_->erase(key);
}

inline void BaseObject::Trace(cppgc::Visitor* visitor) const {
  visitor->Trace(dynamic_properties_);
  visitor->Trace(prototype_);
}

inline RecordObject::RecordObject(BaseObject* dynamicBacking)
    : BaseObject(Kind::Record), dynamic_backing_(dynamicBacking) {}

inline Value RecordObject::get(const std::u16string& key) const {
  if (dynamic_backing_) return dynamic_backing_->dynamicGet(key);
  const auto property = properties_.find(key);
  if (property != properties_.end()) return property->second.load();
  const auto hidden = hidden_properties_.find(key);
  if (hidden != hidden_properties_.end()) return hidden->second.load();
  return prototype_ ? prototype_->dynamicGet(key) : Value::undefined();
}

inline void RecordObject::set(std::u16string key, const Value& value) {
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

inline void RecordObject::define(
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

inline bool RecordObject::has(const std::u16string& key) const {
  if (dynamic_backing_) {
    const auto keys = dynamic_backing_->dynamicKeys();
    return std::find(keys.begin(), keys.end(), key) != keys.end();
  }
  return properties_.contains(key) || hidden_properties_.contains(key);
}

inline bool RecordObject::propertyIsEnumerable(const std::u16string& key) const {
  if (dynamic_backing_) return dynamic_backing_->dynamicPropertyIsEnumerable(key);
  return properties_.contains(key);
}

inline bool RecordObject::erase(const std::u16string& key) {
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

inline void RecordObject::copyTo(RecordObject* target) const {
  if (dynamic_backing_) {
    for (const auto& key : keys()) target->set(key, get(key));
    return;
  }
  for (const auto& key : property_order_) target->set(key, get(key));
}

inline std::vector<std::u16string> RecordObject::keys() const {
  if (dynamic_backing_) {
    return dynamic_backing_->dynamicEnumerableKeys(dynamic_backing_->dynamicKeys());
  }
  return property_order_;
}

inline std::vector<std::u16string> RecordObject::ownPropertyNames() const {
  if (dynamic_backing_) return dynamic_backing_->dynamicKeys();
  auto result = property_order_;
  result.insert(result.end(), hidden_property_order_.begin(), hidden_property_order_.end());
  return result;
}

inline void RecordObject::seal() {
  extensible_ = false;
  sealed_ = true;
  for (const auto& key : ownPropertyNames()) configurable_properties_.insert_or_assign(key, false);
}

inline void RecordObject::freeze() {
  seal();
  frozen_ = true;
  for (const auto& key : ownPropertyNames()) writable_properties_.insert_or_assign(key, false);
}

inline std::vector<Value> RecordObject::values() const {
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

inline void RecordObject::Trace(cppgc::Visitor* visitor) const {
  BaseObject::Trace(visitor);
  visitor->Trace(dynamic_backing_);
  visitor->Trace(prototype_);
  for (const auto& [key, value] : properties_) value.Trace(visitor);
  for (const auto& [key, value] : hidden_properties_) value.Trace(visitor);
}

inline Value BaseObject::dynamicArrayGet(std::size_t) {
  throw runtimeError(u"Dynamic native object is not an array");
}

inline bool BaseObject::dynamicIsIterable() const {
  return dynamicIsArray();
}

inline std::size_t BaseObject::dynamicIterableSize() const {
  return dynamicArraySize();
}

inline Value BaseObject::dynamicIterableGet(std::size_t index) {
  return dynamicArrayGet(index);
}

Value makeDynamicMapEntry(Value key, Value value);

inline Value StoredValue::load() const {
  if (std::holds_alternative<Undefined>(storage_)) return Value::undefined();
  if (std::holds_alternative<Null>(storage_)) return Value::null();
  if (const auto* value = std::get_if<bool>(&storage_)) return Value(*value);
  if (const auto* value = std::get_if<double>(&storage_)) return Value(*value);
  if (const auto* value = std::get_if<BigInt>(&storage_)) return Value(*value);
  return Value(std::get<BaseObject*>(storage_));
}

inline StoredValue::operator Value() const { return load(); }

inline void StoredValue::store(const Value& value) {
  if (value.isUndefined()) storage_ = Undefined{};
  else if (value.isNull()) storage_ = Null{};
  else if (value.isBoolean()) storage_ = value.boolean();
  else if (value.isNumber()) storage_ = value.number();
  else if (value.isBigInt()) storage_ = value.bigint();
  else storage_ = value.object();
}

inline void StoredValue::Trace(cppgc::Visitor* visitor) const {
  if (const auto* value = std::get_if<BaseObject*>(&storage_)) {
    const cppgc::Member<BaseObject> member(*value);
    visitor->Trace(member);
  }
}
