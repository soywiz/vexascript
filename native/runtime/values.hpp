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

  explicit BaseObject(Kind kind = Kind::Object);
  virtual ~BaseObject();
  Kind objectKind() const;
  virtual const void* dynamicTypeToken() const = 0;
  virtual void* dynamicCast(const void* type) = 0;
  virtual std::u16string dynamicToString() const = 0;
  virtual std::u16string dynamicInspect() const;
  virtual std::optional<std::u16string> dynamicJsonStringify(std::unordered_set<const void*>&) const;
  virtual Value dynamicGet(const std::u16string&);
  virtual Value dynamicSet(const std::u16string&, const Value&);
  virtual std::vector<std::u16string> dynamicKeys() const;
  virtual bool dynamicDelete(const std::u16string&);
  bool dynamicHasOwn(const std::u16string&) const;
  bool dynamicPropertyIsEnumerable(const std::u16string&) const;
  virtual Value dynamicCall(const std::vector<Value>&);
  virtual bool dynamicIsArray() const;
  virtual std::size_t dynamicArraySize() const;
  virtual Value dynamicArrayGet(std::size_t);
  virtual bool dynamicIsIterable() const;
  virtual std::size_t dynamicIterableSize() const;
  virtual Value dynamicIterableGet(std::size_t);
  void dynamicDefineProperty(const std::u16string&, const Value&, bool enumerable);
  std::vector<std::u16string> dynamicEnumerableKeys(std::vector<std::u16string>) const;
  BaseObject* dynamicPrototype() const;
  void dynamicSetPrototype(BaseObject* prototype);
  bool dynamicIsExtensible() const;
  bool dynamicIsSealed() const;
  bool dynamicIsFrozen() const;
  void dynamicPreventExtensions();
  void dynamicSeal();
  void dynamicFreeze();
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
  explicit StringObject(std::u16string value);
  StringObject(StringObject* left, StringObject* right);

  const void* dynamicTypeToken() const override;
  void* dynamicCast(const void* type) override;
  std::u16string dynamicToString() const override;

  void Trace(cppgc::Visitor* visitor) const override;

  std::size_t size() const;

  const std::u16string& value() const;

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

  Value();
  Value(bool value);
  Value(double value);
  Value(int value);
  Value(BigInt value);
  explicit Value(StringObject* value);
  explicit Value(RecordObject* value);
  template <typename T>
    requires std::is_base_of_v<BaseObject, T>
  Value(T* value) : storage_(cppgc::Persistent<BaseObject>(value)) {}
  explicit Value(BaseObject* value);

  static Value undefined();
  static Value null();

  bool isUndefined() const;
  bool isNull() const;
  bool isBoolean() const;
  bool isNumber() const;
  bool isBigInt() const;
  bool isObject() const;
  bool isString() const;
  bool isRecord() const;
  bool isRuntimeObject() const;

  bool boolean() const;
  double number() const;
  const BigInt& bigint() const;
  const std::u16string& string() const;
  const std::u16string& utf16() const;
  StringObject* stringObject() const;
  RecordObject* record() const;
  BaseObject* object() const;
  template <typename Result>
  Result toInstance() const;

  explicit operator bool() const;

  operator std::u16string() const;

  bool operator==(const Value& other) const;

 private:
  friend class StoredValue;
  explicit Value(Null value);
  Storage storage_;
};

const std::u16string& requireString(const Value& value);

std::u16string& operator+=(std::u16string& left, const Value& right);

std::u16string operator+(std::u16string left, const Value& right);

std::u16string operator+(const Value& left, std::u16string right);

bool operator==(const std::u16string& left, const Value& right);

bool operator==(const Value& left, const std::u16string& right);

std::strong_ordering operator<=>(const std::u16string& left, const Value& right);

std::strong_ordering operator<=>(const Value& left, const std::u16string& right);

class StoredValue final {
 public:
  using Storage = std::variant<
      Undefined,
      Null,
      bool,
      double,
      BigInt,
      BaseObject*>;

  StoredValue();
  explicit StoredValue(const Value& value);

  operator Value() const;
  StoredValue& operator=(const Value& value);

  Value load() const;
  void store(const Value& value);
  void Trace(cppgc::Visitor* visitor) const;

 private:
  Storage storage_;
};

std::size_t stringCodeUnitLength(const Value& value);

std::size_t stringCodeUnitLength(const std::u16string& value);

std::int32_t stringFirstCodeUnit(const Value& value);

std::int32_t stringFirstCodeUnit(const std::u16string& value);

class RecordObject final
    : public cppgc::GarbageCollected<RecordObject>,
      public BaseObject {
 public:
  RecordObject();
  explicit RecordObject(BaseObject* dynamicBacking);

  const void* dynamicTypeToken() const override;
  void* dynamicCast(const void* type) override;
  std::u16string dynamicToString() const override;
  Value dynamicGet(const std::u16string& key) override;
  Value dynamicSet(const std::u16string& key, const Value& value) override;
  std::vector<std::u16string> dynamicKeys() const override;
  bool dynamicDelete(const std::u16string& key) override;

  Value get(const std::u16string& key) const;
  void set(std::u16string key, const Value& value);
  void define(std::u16string key, const Value& value, bool enumerable, bool writable = false, bool configurable = false);
  void setHidden(std::u16string key, const Value& value);
  bool has(const std::u16string& key) const;
  bool propertyIsEnumerable(const std::u16string& key) const;
  bool erase(const std::u16string& key);
  void copyTo(RecordObject* target) const;
  std::vector<std::u16string> keys() const;
  std::vector<std::u16string> ownPropertyNames() const;
  std::vector<Value> values() const;
  BaseObject* prototype() const;
  void setPrototype(BaseObject* prototype);
  bool isExtensible() const;
  bool isSealed() const;
  bool isFrozen() const;
  void preventExtensions();
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
  virtual ~EnumerableObject();
  virtual void* nativeInterfaceCast(const void* type);
  virtual std::vector<std::u16string> enumerableKeys() const;
  virtual Value enumerableGet(const std::u16string&);
  virtual RecordObject* enumerableBackingRecord();
  virtual void defineProperty(const std::u16string&, const Value&, bool);
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

std::vector<std::u16string> objectKeys(RecordObject* object);

std::vector<std::u16string> objectKeys(EnumerableObject* object);

std::vector<std::u16string> objectKeys(BaseObject* object);

std::vector<std::u16string> objectKeys(const Value& value);

template <typename T>
  requires std::is_base_of_v<BaseObject, T>
inline std::vector<std::u16string> objectKeys(T* object) {
  return objectKeys(static_cast<BaseObject*>(object));
}

Value enumerableGet(RecordObject* object, const std::u16string& key);

Value enumerableGet(EnumerableObject* object, const std::u16string& key);







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

























































Value makeDynamicMapEntry(Value key, Value value);
