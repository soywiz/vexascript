// Minimal VexaScript C++ Runtime:: This file is intentionally both a header and
// an implementation so generated translation units can include one runtime file.
#pragma once

#include <algorithm>
#include <bit>
#include <chrono>
#include <cctype>
#include <cmath>
#include <coroutine>
#include <cstring>
#include <cstdlib>
#include <cstdio>
#include <cstdint>
#include <ctime>
#include <deque>
#include <exception>
#include <functional>
#include <fstream>
#include <filesystem>
#include <future>
#include <iomanip>
#include <initializer_list>
#include <iostream>
#include <iterator>
#include <limits>
#include <memory>
#include <mutex>
#include <optional>
#include <queue>
#include <regex>
#include <sstream>
#include <string>
#include <string_view>
#include <thread>
#include <stdexcept>
#include <type_traits>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <variant>
#include <vector>

#if defined(_WIN32)
#include <windows.h>
#else
#include <dlfcn.h>
#include <sys/wait.h>
#endif

#include "bigint.h"
#include "utf.h"

#include <cppgc/allocation.h>
#include <cppgc/garbage-collected.h>
#include <cppgc/heap.h>
#include <cppgc/member.h>
#include <cppgc/persistent.h>
#include <cppgc/platform.h>
#include <cppgc/visitor.h>
#include <src/base/page-allocator.h>

namespace vexa {

class LibraryOpen final {
 public:
  static void* open(std::initializer_list<std::string_view> paths) {
    static std::mutex mutex;
    static std::unordered_map<std::string, void*> handles;
    std::lock_guard<std::mutex> lock(mutex);
    std::string failures;
    for (const auto pathView : paths) {
      std::string path(pathView);
      if (path.empty()) continue;
#if defined(__APPLE__)
      if (path.ends_with(".framework")) {
        const auto slash = path.find_last_of('/');
        const auto nameStart = slash == std::string::npos ? 0 : slash + 1;
        const auto nameLength = path.size() - nameStart - std::string_view(".framework").size();
        path += "/" + path.substr(nameStart, nameLength);
      }
#endif
      if (const auto cached = handles.find(path); cached != handles.end()) return cached->second;
#if defined(_WIN32)
      void* handle = reinterpret_cast<void*>(LoadLibraryA(path.c_str()));
      if (!handle) failures += path + "; ";
#else
      void* handle = dlopen(path.c_str(), RTLD_NOW | RTLD_LOCAL);
      if (!handle) {
        const char* error = dlerror();
        failures += path + ": " + std::string(error ? error : "unknown error") + "; ";
      }
#endif
      if (handle) {
        handles.emplace(path, handle);
        return handle;
      }
    }
    throw std::runtime_error("Unable to open native library: " + failures);
  }

  static void* symbol(std::initializer_list<std::string_view> paths, std::string_view name) {
    void* handle = open(paths);
#if defined(_WIN32)
    void* result = reinterpret_cast<void*>(GetProcAddress(
        static_cast<HMODULE>(handle), std::string(name).c_str()));
#else
    void* result = dlsym(handle, std::string(name).c_str());
#endif
    if (!result) throw std::runtime_error("Unable to load native symbol: " + std::string(name));
    return result;
  }
};

inline std::optional<std::size_t> propertyIndex(std::u16string_view key) {
  if (key.empty()) return std::nullopt;
  std::size_t result = 0;
  for (const char16_t codeUnit : key) {
    if (codeUnit < u'0' || codeUnit > u'9') return std::nullopt;
    const auto digit = static_cast<std::size_t>(codeUnit - u'0');
    if (result > (std::numeric_limits<std::size_t>::max() - digit) / 10) return std::nullopt;
    result = result * 10 + digit;
  }
  return result;
}

class OilpanPlatform final : public cppgc::Platform {
 public:
  cppgc::PageAllocator* GetPageAllocator() override { return &allocator_; }

  double MonotonicallyIncreasingTime() override {
    using Seconds = std::chrono::duration<double>;
    return Seconds(std::chrono::steady_clock::now().time_since_epoch()).count();
  }

 private:
  v8::base::PageAllocator allocator_;
};

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
class Float16ArrayObject;
std::runtime_error errorAtCurrentSource(std::u16string);
template <typename T>
class ArrayObject;
template <typename T>
struct ArrayPointerElement {
  using Type = T;
};
template <typename K, typename V>
class MapObject;
template <typename T>
class SetObject;
template <typename T>
class NativeIteratorObject;
ArrayObject<Value>* makeDynamicArrayValueView(BaseObject* backing);
std::u16string toString(const Value&);
std::u16string toString(Float16ArrayObject*);
std::u16string jsonQuoted(const std::u16string&);
std::u16string propertyKey(const Value&);
bool toBoolean(double);
bool toBoolean(const Value&);
double Number(const Value&);
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
struct PromiseResult final {
  using Type = std::remove_cvref_t<T>;
  static constexpr bool task = false;
};

template <typename T>
struct PromiseResult<Task<T>> final {
  using Type = typename PromiseResult<T>::Type;
  static constexpr bool task = true;
};

template <typename T, typename Callback>
Task<typename PromiseResult<std::invoke_result_t<Callback, T>>::Type> promiseThen(
    Task<T> source,
    Callback callback);

template <typename Callback>
Task<typename PromiseResult<std::invoke_result_t<Callback>>::Type> promiseThen(
    Task<void> source,
    Callback callback);

template <typename T, typename Callback>
Task<T> promiseCatch(Task<T> source, Callback callback);

template <typename T, typename Callback>
Task<T> promiseFinally(Task<T> source, Callback callback);

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
  virtual Value dynamicCall(const std::vector<Value>&);
  virtual bool dynamicIsArray() const { return false; }
  virtual std::size_t dynamicArraySize() const { return 0; }
  virtual Value dynamicArrayGet(std::size_t);
  virtual bool dynamicIsIterable() const;
  virtual std::size_t dynamicIterableSize() const;
  virtual Value dynamicIterableGet(std::size_t);
  void dynamicDefineProperty(const std::u16string&, const Value&, bool enumerable);
  std::vector<std::u16string> dynamicEnumerableKeys(std::vector<std::u16string>) const;
  void Trace(cppgc::Visitor*) const;

 private:
  Kind kind_;
  cppgc::Member<RecordObject> dynamic_properties_;
  std::unordered_set<std::u16string> non_enumerable_properties_;
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
  Value(std::u16string value);
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
  void setHidden(std::u16string key, const Value& value);
  bool has(const std::u16string& key) const;
  bool erase(const std::u16string& key);
  void copyTo(RecordObject* target) const;
  std::vector<std::u16string> keys() const;
  std::vector<Value> values() const;
  void Trace(cppgc::Visitor* visitor) const;

 private:
  cppgc::Member<BaseObject> dynamic_backing_;
  std::unordered_map<std::u16string, StoredValue> properties_;
  std::unordered_map<std::u16string, StoredValue> hidden_properties_;
  std::vector<std::u16string> property_order_;
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
  return dynamic_properties_ ? dynamic_properties_->get(key) : Value::undefined();
}

inline Value BaseObject::dynamicSet(const std::u16string& key, const Value& value) {
    if (!dynamic_properties_) dynamic_properties_ = makeDynamicPropertyRecord();
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

inline std::vector<std::u16string> BaseObject::dynamicEnumerableKeys(
    std::vector<std::u16string> keys) const {
  std::erase_if(keys, [&](const std::u16string& key) {
    return non_enumerable_properties_.contains(key);
  });
  return keys;
}

inline bool BaseObject::dynamicDelete(const std::u16string& key) {
  non_enumerable_properties_.erase(key);
  return dynamic_properties_ && dynamic_properties_->erase(key);
}

inline void BaseObject::Trace(cppgc::Visitor* visitor) const {
  visitor->Trace(dynamic_properties_);
}

inline RecordObject::RecordObject(BaseObject* dynamicBacking)
    : BaseObject(Kind::Record), dynamic_backing_(dynamicBacking) {}

inline Value RecordObject::get(const std::u16string& key) const {
  if (dynamic_backing_) return dynamic_backing_->dynamicGet(key);
  const auto property = properties_.find(key);
  if (property != properties_.end()) return property->second.load();
  const auto hidden = hidden_properties_.find(key);
  return hidden == hidden_properties_.end() ? Value::undefined() : hidden->second.load();
}

inline void RecordObject::set(std::u16string key, const Value& value) {
  if (dynamic_backing_) {
    dynamic_backing_->dynamicSet(key, value);
    return;
  }
  hidden_properties_.erase(key);
  if (!properties_.contains(key)) property_order_.push_back(key);
  properties_.insert_or_assign(std::move(key), StoredValue(value));
}

inline void RecordObject::setHidden(std::u16string key, const Value& value) {
  if (dynamic_backing_) {
    dynamic_backing_->dynamicDefineProperty(key, value, false);
    return;
  }
  if (properties_.erase(key) > 0) {
    property_order_.erase(std::remove(property_order_.begin(), property_order_.end(), key), property_order_.end());
  }
  hidden_properties_.insert_or_assign(std::move(key), StoredValue(value));
}

inline bool RecordObject::has(const std::u16string& key) const {
  if (dynamic_backing_) {
    const auto keys = dynamic_backing_->dynamicKeys();
    return std::find(keys.begin(), keys.end(), key) != keys.end();
  }
  return properties_.contains(key) || hidden_properties_.contains(key);
}

inline bool RecordObject::erase(const std::u16string& key) {
  if (dynamic_backing_) return dynamic_backing_->dynamicDelete(key);
  const bool visible = properties_.erase(key) > 0;
  const bool hidden = hidden_properties_.erase(key) > 0;
  if (visible) property_order_.erase(std::remove(property_order_.begin(), property_order_.end(), key), property_order_.end());
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

template <typename T>
class ArraySlot final {
 public:
  ArraySlot() = default;
  explicit ArraySlot(T value) : value_(std::move(value)) {}

  T load() const { return value_; }
  const T& loadRef() const { return value_; }
  void store(T value) { value_ = std::move(value); }
  void Trace(cppgc::Visitor*) const {}

 private:
  T value_{};
};

// Generic native class fields are emitted as their template type so ordinary
// values retain value semantics. Pointer specializations still need to expose
// their Oilpan edge when the containing object is traced.
template <typename T>
inline void traceManagedValue(cppgc::Visitor*, const T&) {}

template <typename T>
inline void traceManagedValue(cppgc::Visitor* visitor, T* const& value) {
  if (!value) return;
  const cppgc::Member<T> member(value);
  visitor->Trace(member);
}

template <typename T>
class ArraySlot<T*> final {
 public:
  ArraySlot() = default;
  explicit ArraySlot(T* value) : value_(value) {}

  T* load() const { return value_; }
  T* const& loadRef() const { return value_; }
  void store(T* value) { value_ = value; }
  void Trace(cppgc::Visitor* visitor) const {
    const cppgc::Member<T> member(value_);
    visitor->Trace(member);
  }

 private:
  T* value_ = nullptr;
};

template <>
class ArraySlot<Value> final {
 public:
  ArraySlot() = default;
  explicit ArraySlot(Value value) : value_(value) {}

  Value load() const { return value_.load(); }
  void store(Value value) { value_.store(value); }
  void Trace(cppgc::Visitor* visitor) const { value_.Trace(visitor); }

 private:
  StoredValue value_;
};

template <typename T>
inline constexpr bool IsDynamicArrayElement =
    std::is_same_v<T, Value> || std::is_same_v<T, std::u16string> ||
    std::is_same_v<T, BigInt> || std::is_arithmetic_v<T> ||
    (std::is_pointer_v<T> &&
     (std::is_base_of_v<BaseObject, std::remove_pointer_t<T>> ||
      std::is_base_of_v<EnumerableObject, std::remove_pointer_t<T>> ||
      std::is_same_v<std::remove_pointer_t<T>, RecordObject>));

// Language arrays have reference semantics. The backing storage is an Oilpan
// object, and every GC-managed element is represented by a traced Member edge.
template <typename T>
class ArrayObject final : public cppgc::GarbageCollected<ArrayObject<T>>, public BaseObject {
 public:
  ArrayObject() = default;
  explicit ArrayObject(BaseObject* dynamicBacking) : dynamic_backing_(dynamicBacking) {}
  static ArrayObject* fromDynamicObject(BaseObject* backing);
  explicit ArrayObject(std::initializer_list<T> values) {
    values_.reserve(values.size());
    for (const auto& value : values) values_.emplace_back(value);
  }

  std::size_t size() const {
    return dynamic_backing_ ? dynamic_backing_->dynamicArraySize() : values_.size();
  }
  bool empty() const { return size() == 0; }
  void reserve(std::size_t capacity) {
    if (!dynamic_backing_) values_.reserve(capacity);
  }
  void resize(std::size_t size) {
    if (dynamic_backing_) {
      dynamic_backing_->dynamicSet(u"length", Value(static_cast<double>(size)));
      return;
    }
    values_.resize(size);
  }
  T get(std::size_t index) const {
    if (dynamic_backing_) {
      if (index >= size()) return T{};
      if constexpr (IsDynamicArrayElement<T>) {
        return convertValue<T>(dynamic_backing_->dynamicArrayGet(index));
      } else {
        throw runtimeError(u"This native array element type cannot flow through a dynamic array view");
      }
    }
    if (index >= values_.size()) return T{};
    return values_[index].load();
  }
  T set(std::size_t index, T value) {
    if (dynamic_backing_) {
      if constexpr (IsDynamicArrayElement<T>) {
        dynamic_backing_->dynamicSet(formatIntegerText(index), convertValue<Value>(value));
        return value;
      } else {
        throw runtimeError(u"This native array element type cannot flow through a dynamic array view");
      }
    }
    if (index >= values_.size()) values_.resize(index + 1);
    values_[index].store(value);
    return value;
  }
  void append(T value) {
    if (dynamic_backing_) {
      set(size(), value);
      return;
    }
    values_.emplace_back(std::move(value));
  }
  void insert(std::size_t index, T value) {
    values_.insert(
        values_.begin() + static_cast<std::ptrdiff_t>(std::min(index, values_.size())),
        ArraySlot<T>(std::move(value)));
  }
  void prepend(T value) { values_.insert(values_.begin(), ArraySlot<T>(std::move(value))); }
  template <typename... Items>
  double push(Items&&... items) {
    (append(convertValue<T>(std::forward<Items>(items))), ...);
    return static_cast<double>(size());
  }
  T removeLast() {
    if (values_.empty()) return T{};
    T value = values_.back().load();
    values_.pop_back();
    return value;
  }
  T removeFirst() {
    if (values_.empty()) return T{};
    T value = values_.front().load();
    values_.erase(values_.begin());
    return value;
  }
  T pop() { return removeLast(); }
  T shift() { return removeFirst(); }
  template <typename... Items>
  double unshift(Items&&... items) {
    (prepend(convertValue<T>(std::forward<Items>(items))), ...);
    return static_cast<double>(size());
  }
  ArrayObject* reverse() {
    std::reverse(values_.begin(), values_.end());
    return this;
  }

  template <typename U>
  bool includes(const U& value) const;
  template <typename U>
  double indexOf(const U& value) const;
  template <typename U>
  double lastIndexOf(const U& value) const;
  template <typename Index>
  T at(Index index) const;
  template <typename Start = double, typename End = double>
  ArrayObject* slice(
      Start start = 0,
      End end = std::numeric_limits<double>::infinity()) const;
  template <typename... Items>
  ArrayObject* concat(Items&&... items) const;
  template <typename Callback>
  auto map(Callback callback) const;
  template <typename Callback>
  ArrayObject* filter(Callback callback) const;
  template <typename Callback, typename Accumulator>
  Accumulator reduce(Callback callback, Accumulator initial) const;
  template <typename Callback>
  void forEach(Callback callback) const;
  template <typename Callback>
  bool some(Callback callback) const;
  template <typename Callback>
  bool every(Callback callback) const;
  template <typename Callback>
  double findIndex(Callback callback) const;
  template <typename Callback>
  T find(Callback callback) const;
  template <typename Callback>
  double findLastIndex(Callback callback) const;
  template <typename Callback>
  T findLast(Callback callback) const;
  template <typename Start = double, typename DeleteCount = double, typename... Items>
  ArrayObject* splice(
      Start start,
      DeleteCount deleteCount = std::numeric_limits<double>::infinity(),
      Items&&... items);
  template <typename Value, typename Start = double, typename End = double>
  ArrayObject* fill(Value&& value, Start start = 0, End end = std::numeric_limits<double>::infinity());
  template <typename Target, typename Start, typename End = double>
  ArrayObject* copyWithin(Target target, Start start, End end = std::numeric_limits<double>::infinity());
  ArrayObject* sort();
  template <typename Callback>
  ArrayObject* sort(Callback callback);
  ArrayObject* toReversed() const;
  ArrayObject* toSorted() const;
  template <typename Callback>
  ArrayObject* toSorted(Callback callback) const;
  template <typename Start = double, typename DeleteCount = double, typename... Items>
  ArrayObject* toSpliced(
      Start start,
      DeleteCount deleteCount = std::numeric_limits<double>::infinity(),
      Items&&... items) const;
  template <typename Index, typename Value>
  ArrayObject* with(Index index, Value&& value) const;
  template <typename Depth = double>
  auto flat(Depth depth = 1) const;
  template <typename Callback>
  auto flatMap(Callback callback) const;
  template <typename Separator = std::u16string>
  std::u16string join(Separator&& separator = std::u16string(u",")) const;
  std::u16string toString() const;
  const void* dynamicTypeToken() const override { return nativeTypeToken<ArrayObject<T>>(); }
  void* dynamicCast(const void* type) override {
    return type == nativeTypeToken<ArrayObject<T>>() ? this : nullptr;
  }
  std::u16string dynamicToString() const override { return toString(); }
  bool dynamicIsArray() const override { return true; }
  bool dynamicIsIterable() const override { return true; }
  std::size_t dynamicIterableSize() const override { return size(); }
  Value dynamicIterableGet(std::size_t index) override {
    return dynamicArrayGet(index);
  }
  std::size_t dynamicArraySize() const override { return size(); }
  Value dynamicArrayGet(std::size_t index) override {
    if constexpr (IsDynamicArrayElement<T>) {
      return index < size() ? convertValue<Value>(get(index)) : Value::undefined();
    } else {
      throw runtimeError(u"This native array element type cannot flow through dynamic iteration");
    }
  }
  std::optional<std::u16string> dynamicJsonStringify(std::unordered_set<const void*>& seen) const override {
    if (!seen.insert(this).second) throw runtimeError(u"Converting circular structure to JSON");
    std::u16string output = u"[";
    for (std::size_t index = 0; index < size(); ++index) {
      if (index > 0) output += u',';
      output += jsonStringifyNative(get(index), seen);
    }
    output += u']';
    seen.erase(this);
    return output;
  }
  Value dynamicGet(const std::u16string& key) override;
  Value dynamicSet(const std::u16string& key, const Value& value) override {
        if constexpr (IsDynamicArrayElement<T>) {
      if (key == u"length") {
        resize(static_cast<std::size_t>(convertValue<double>(value)));
        return value;
      }
      const auto index = propertyIndex(key);
      if (!index) throw runtimeError(u"Invalid dynamic array index");
      set(*index, convertValue<T>(value));
      return value;
    } else {
      throw runtimeError(u"This native array element type cannot flow through dynamic access");
    }
  }
  bool dynamicDelete(const std::u16string&) override { return false; }

  class Iterator final {
   public:
    Iterator(const ArrayObject* array, std::size_t index) : array_(array), index_(index) {}
    T operator*() const { return array_->get(index_); }
    Iterator& operator++() { ++index_; return *this; }
    bool operator!=(const Iterator& other) const { return index_ != other.index_; }

   private:
    const ArrayObject* array_;
    std::size_t index_;
  };

  Iterator begin() const { return Iterator(this, 0); }
  Iterator end() const { return Iterator(this, size()); }

  void Trace(cppgc::Visitor* visitor) const override {
    BaseObject::Trace(visitor);
    visitor->Trace(dynamic_backing_);
    for (const auto& value : values_) value.Trace(visitor);
  }

 private:
  cppgc::Member<BaseObject> dynamic_backing_;
  std::vector<ArraySlot<T>> values_;
};

template <typename Left, typename Right>
inline bool sameValueZero(const Left& left, const Right& right) {
  return left == right;
}

inline bool sameValueZero(double left, double right) {
  return left == right || (std::isnan(left) && std::isnan(right));
}

inline bool sameValueZero(const Value& left, const Value& right) {
  return left == right || (left.isNumber() && right.isNumber() &&
      std::isnan(left.number()) && std::isnan(right.number()));
}

template <typename Other>
  requires (!std::is_same_v<std::remove_cvref_t<Other>, Value>)
inline bool sameValueZero(const Value& left, const Other& right) {
  return sameValueZero(left, convertValue<Value>(right));
}

template <typename Other>
  requires (!std::is_same_v<std::remove_cvref_t<Other>, Value>)
inline bool sameValueZero(const Other& left, const Value& right) {
  return sameValueZero(convertValue<Value>(left), right);
}

template <typename T>
struct SameValueZeroHash final {
  std::size_t operator()(const T& value) const {
    if constexpr (std::is_same_v<T, BigInt>) {
      return std::hash<std::u16string>{}(value.toString());
    } else if constexpr (std::is_same_v<T, std::u16string>) {
      return std::hash<std::u16string>{}(value);
    } else if constexpr (std::is_pointer_v<T>) {
      return std::hash<const void*>{}(value);
    } else {
      return std::hash<T>{}(value);
    }
  }
};

template <>
struct SameValueZeroHash<Value> final {
  std::size_t operator()(const Value& value) const {
    if (value.isUndefined()) return 0x11;
    if (value.isNull()) return 0x23;
    if (value.isBoolean()) return value.boolean() ? 0x37 : 0x41;
    if (value.isNumber()) {
      if (std::isnan(value.number())) return 0x53;
      const double normalized = value.number() == 0 ? 0 : value.number();
      return std::hash<double>{}(normalized) ^ 0x67;
    }
    if (value.isBigInt()) {
      return std::hash<std::u16string>{}(value.bigint().toString()) ^ 0x79;
    }
    if (value.isString()) return std::hash<std::u16string>{}(value.utf16()) ^ 0x83;
    if (value.isRecord()) return std::hash<const void*>{}(value.record()) ^ 0x97;
    return std::hash<const void*>{}(value.object()) ^ 0xa9;
  }
};

template <typename T>
struct SameValueZeroEqual final {
  bool operator()(const T& left, const T& right) const {
    return sameValueZero(left, right);
  }
};

class MapLikeObject : public BaseObject {
 public:
  virtual std::size_t dynamicMapSize() const = 0;
  virtual Value dynamicMapKeyAt(std::size_t) = 0;
  virtual Value dynamicMapValueAt(std::size_t) = 0;
  virtual std::optional<Value> dynamicMapGet(const Value&) = 0;
  virtual void dynamicMapSet(const Value&, const Value&) = 0;
  virtual bool dynamicMapDelete(const Value&) = 0;
  virtual void dynamicMapClear() = 0;
};
class SetLikeObject : public BaseObject {};
class WeakMapLikeObject : public BaseObject {};
class WeakSetLikeObject : public BaseObject {};

template <typename K, typename V>
class MapObject final : public cppgc::GarbageCollected<MapObject<K, V>>, public MapLikeObject {
 private:
  struct Entry final {
    ArraySlot<K> key;
    ArraySlot<V> value;
  };
  struct Storage final {
    std::vector<Entry> entries;
    std::unordered_map<K, std::size_t, SameValueZeroHash<K>, SameValueZeroEqual<K>> index;
  };

 public:
  MapObject() : storage_(std::make_shared<Storage>()) {}
  explicit MapObject(MapLikeObject* dynamicBacking) : dynamic_backing_(dynamicBacking) {}
  explicit MapObject(const MapObject* source) : storage_(source->storage_) {}
  static MapObject* fromDynamicObject(BaseObject* backing);

  bool usesDynamicBacking() const { return dynamic_backing_ != nullptr; }
  std::size_t size() const { return dynamic_backing_ ? dynamic_backing_->dynamicMapSize() : storage_->entries.size(); }

  MapObject* set(K key, V value) {
    if (dynamic_backing_) {
      dynamic_backing_->dynamicMapSet(
          convertValue<Value>(key),
          convertValue<Value>(value));
      return this;
    }
    ensureUniqueStorage();
    const auto existing = storage_->index.find(key);
    if (existing != storage_->index.end()) {
      storage_->entries[existing->second].value.store(std::move(value));
      return this;
    }
    storage_->entries.push_back(Entry{ArraySlot<K>(std::move(key)), ArraySlot<V>(std::move(value))});
    storage_->index.emplace(storage_->entries.back().key.load(), storage_->entries.size() - 1);
    return this;
  }

  std::optional<V> find(const K& key) const {
    if (dynamic_backing_) {
      const auto found = dynamic_backing_->dynamicMapGet(convertValue<Value>(key));
      if (!found) return std::nullopt;
      try {
        return std::optional<V>(convertValue<V>(*found));
      } catch (const std::runtime_error& error) {
        throw runtimeError(
            utf8ToUtf16(error.what()) + u" while reading Map key " +
            toString(convertValue<Value>(key)));
      }
    }
    const auto found = storage_->index.find(key);
    return found == storage_->index.end()
        ? std::nullopt
        : std::optional<V>(storage_->entries[found->second].value.load());
  }

  template <typename Key>
  V get(Key&& key) const {
    const auto found = find(convertValue<K>(std::forward<Key>(key)));
    return found ? *found : defaultValue<V>();
  }

  template <typename Key>
  bool vexa_delete(Key&& key) {
    return erase(convertValue<K>(std::forward<Key>(key)));
  }

  bool has(const K& key) const {
    return dynamic_backing_
      ? dynamic_backing_->dynamicMapGet(convertValue<Value>(key)).has_value()
      : storage_->index.contains(key);
  }

  template <typename Key>
  bool has(Key&& key) const {
    return has(convertValue<K>(std::forward<Key>(key)));
  }

  template <typename Key, typename Input>
  MapObject* set(Key&& key, Input&& value) {
    return set(
        convertValue<K>(std::forward<Key>(key)),
        convertValue<V>(std::forward<Input>(value)));
  }

  bool erase(const K& key) {
    if (dynamic_backing_) {
      return dynamic_backing_->dynamicMapDelete(convertValue<Value>(key));
    }
    ensureUniqueStorage();
    const auto found = storage_->index.find(key);
    if (found == storage_->index.end()) return false;
    const std::size_t erasedIndex = found->second;
    storage_->entries.erase(storage_->entries.begin() + static_cast<std::ptrdiff_t>(erasedIndex));
    rebuildIndex(erasedIndex);
    return true;
  }

  void clear() {
    if (dynamic_backing_) {
      dynamic_backing_->dynamicMapClear();
      return;
    }
    storage_ = std::make_shared<Storage>();
  }

  template <typename Callback>
  void forEach(Callback callback) const {
    if (dynamic_backing_) {
            for (std::size_t index = 0; index < dynamic_backing_->dynamicMapSize(); ++index) {
        const K key = convertValue<K>(dynamic_backing_->dynamicMapKeyAt(index));
        const V value = convertValue<V>(dynamic_backing_->dynamicMapValueAt(index));
        if constexpr (std::is_invocable_v<Callback, V, K, MapObject*>) callback(value, key, this);
        else if constexpr (std::is_invocable_v<Callback, V, K>) callback(value, key);
        else callback(value);
      }
      return;
    }
    for (const auto& entry : storage_->entries) {
      if constexpr (std::is_invocable_v<Callback, V, K, MapObject*>) {
        callback(entry.value.load(), entry.key.load(), this);
      } else if constexpr (std::is_invocable_v<Callback, V, K>) {
        callback(entry.value.load(), entry.key.load());
      } else {
        callback(entry.value.load());
      }
    }
  }

  NativeIteratorObject<K>* keys() const;
  NativeIteratorObject<V>* values() const;
  NativeIteratorObject<ArrayObject<Value>*>* entries() const;

  const void* dynamicTypeToken() const override { return nativeTypeToken<MapObject<K, V>>(); }
  void* dynamicCast(const void* type) override {
    if (type == nativeTypeToken<MapObject<K, V>>()) return this;
    if (type == nativeTypeToken<MapLikeObject>()) return static_cast<MapLikeObject*>(this);
    return nullptr;
  }
  std::u16string dynamicToString() const override { return u"[object Map]"; }
  bool dynamicIsIterable() const override { return true; }
  std::size_t dynamicIterableSize() const override { return size(); }
  Value dynamicIterableGet(std::size_t index) override {
    if (index >= size()) return Value::undefined();
    return makeDynamicMapEntry(
        dynamicMapKeyAt(index),
        dynamicMapValueAt(index));
  }

  std::size_t dynamicMapSize() const override { return size(); }
  Value dynamicMapKeyAt(std::size_t index) override {
    if (dynamic_backing_) return dynamic_backing_->dynamicMapKeyAt(index);
    return index < storage_->entries.size() ? convertValue<Value>(storage_->entries[index].key.load()) : Value::undefined();
  }
  Value dynamicMapValueAt(std::size_t index) override {
    if (dynamic_backing_) return dynamic_backing_->dynamicMapValueAt(index);
    return index < storage_->entries.size() ? convertValue<Value>(storage_->entries[index].value.load()) : Value::undefined();
  }
  std::optional<Value> dynamicMapGet(const Value& key) override {
    if (dynamic_backing_) return dynamic_backing_->dynamicMapGet(key);
    const auto found = find(convertValue<K>(key));
    return found ? std::optional<Value>(convertValue<Value>(*found)) : std::nullopt;
  }
  void dynamicMapSet(const Value& key, const Value& value) override {
    if (dynamic_backing_) {
      dynamic_backing_->dynamicMapSet(key, value);
      return;
    }
    set(convertValue<K>(key), convertValue<V>(value));
  }
  bool dynamicMapDelete(const Value& key) override {
    return dynamic_backing_
      ? dynamic_backing_->dynamicMapDelete(key)
      : erase(convertValue<K>(key));
  }
  void dynamicMapClear() override { clear(); }

  void Trace(cppgc::Visitor* visitor) const override {
    BaseObject::Trace(visitor);
    visitor->Trace(dynamic_backing_);
    for (const auto& entry : storage_->entries) {
      entry.key.Trace(visitor);
      entry.value.Trace(visitor);
    }
  }

 private:
  void ensureUniqueStorage() {
    if (storage_.use_count() != 1) storage_ = std::make_shared<Storage>(*storage_);
  }
  void rebuildIndex(std::size_t) {
    storage_->index.clear();
    for (std::size_t index = 0; index < storage_->entries.size(); ++index) {
      storage_->index.emplace(storage_->entries[index].key.load(), index);
    }
  }
  cppgc::Member<MapLikeObject> dynamic_backing_;
  std::shared_ptr<Storage> storage_ = std::make_shared<Storage>();
};

template <typename T>
class SetObject final : public cppgc::GarbageCollected<SetObject<T>>, public SetLikeObject {
 private:
  struct Storage final {
    std::vector<ArraySlot<T>> values;
    std::unordered_set<T, SameValueZeroHash<T>, SameValueZeroEqual<T>> index;
  };

 public:
  SetObject() : storage_(std::make_shared<Storage>()) {}
  explicit SetObject(const SetObject* source) : storage_(source->storage_) {}

  std::size_t size() const { return storage_->values.size(); }

  SetObject* add(T value) {
    ensureUniqueStorage();
    if (storage_->index.insert(value).second) storage_->values.emplace_back(std::move(value));
    return this;
  }

  template <typename Input>
  SetObject* add(Input&& value) {
    return add(convertValue<T>(std::forward<Input>(value)));
  }

  bool has(const T& value) const {
    return storage_->index.contains(value);
  }

  template <typename Input>
  bool has(Input&& value) const {
    return has(convertValue<T>(std::forward<Input>(value)));
  }

  template <typename Input>
  bool vexa_delete(Input&& value) {
    return erase(convertValue<T>(std::forward<Input>(value)));
  }

  bool erase(const T& value) {
    ensureUniqueStorage();
    if (storage_->index.erase(value) == 0) return false;
    const auto found = std::find_if(storage_->values.begin(), storage_->values.end(), [&](const ArraySlot<T>& candidate) {
      return sameValueZero(candidate.load(), value);
    });
    if (found == storage_->values.end()) return true;
    storage_->values.erase(found);
    return true;
  }

  void clear() {
    storage_ = std::make_shared<Storage>();
  }

  template <typename Callback>
  void forEach(Callback callback) const {
    for (const auto& value : storage_->values) {
      if constexpr (std::is_invocable_v<Callback, T, T, SetObject*>) {
        callback(value.load(), value.load(), const_cast<SetObject*>(this));
      } else if constexpr (std::is_invocable_v<Callback, T, T>) {
        callback(value.load(), value.load());
      } else {
        callback(value.load());
      }
    }
  }

  NativeIteratorObject<T>* keys() const;
  NativeIteratorObject<T>* values() const;
  NativeIteratorObject<ArrayObject<Value>*>* entries() const;
  SetObject* vexa_union(const SetObject* other) const;
  SetObject* intersection(const SetObject* other) const;
  SetObject* difference(const SetObject* other) const;
  SetObject* symmetricDifference(const SetObject* other) const;
  bool isSubsetOf(const SetObject* other) const;
  bool isSupersetOf(const SetObject* other) const;
  bool isDisjointFrom(const SetObject* other) const;

  const void* dynamicTypeToken() const override { return nativeTypeToken<SetObject<T>>(); }
  void* dynamicCast(const void* type) override {
    return type == nativeTypeToken<SetObject<T>>() ? this : nullptr;
  }
  std::u16string dynamicToString() const override { return u"[object Set]"; }
  bool dynamicIsIterable() const override { return true; }
  std::size_t dynamicIterableSize() const override { return storage_->values.size(); }
  Value dynamicIterableGet(std::size_t index) override {
    if (index >= storage_->values.size()) return Value::undefined();
    return convertValue<Value>(storage_->values[index].load());
  }

  void Trace(cppgc::Visitor* visitor) const override {
    BaseObject::Trace(visitor);
    for (const auto& value : storage_->values) value.Trace(visitor);
  }

 private:
  void ensureUniqueStorage() {
    if (storage_.use_count() != 1) storage_ = std::make_shared<Storage>(*storage_);
  }
  std::shared_ptr<Storage> storage_ = std::make_shared<Storage>();
};

template <typename K, typename V>
class WeakMapObject final : public cppgc::GarbageCollected<WeakMapObject<K, V>>, public WeakMapLikeObject {
  static_assert(std::is_pointer_v<K>, "WeakMap keys must be managed object pointers");
  using KeyObject = std::remove_pointer_t<K>;

 public:
  WeakMapObject* set(K key, V value) {
    if (!key) throw runtimeError(u"Invalid WeakMap key");
    const auto existing = index_.find(key);
    if (existing != index_.end()) {
      entries_[existing->second]->value.store(std::move(value));
      return this;
    }
    index_.emplace(key, entries_.size());
    entries_.emplace_back(makeManaged<Entry>(key, std::move(value)));
    return this;
  }

  std::optional<V> find(K key) const {
    const auto found = index_.find(key);
    return found == index_.end()
        ? std::nullopt
        : std::optional<V>(entries_[found->second]->value.load());
  }

  template <typename Key>
  V get(Key&& key) const {
    const auto found = find(convertValue<K>(std::forward<Key>(key)));
    return found ? *found : defaultValue<V>();
  }

  template <typename Key>
  bool vexa_delete(Key&& key) {
    return erase(convertValue<K>(std::forward<Key>(key)));
  }

  bool has(K key) const { return find(key).has_value(); }

  template <typename Key>
  bool has(Key&& key) const { return find(convertValue<K>(std::forward<Key>(key))).has_value(); }

  template <typename Key, typename Input>
  WeakMapObject* set(Key&& key, Input&& value) {
    return set(convertValue<K>(std::forward<Key>(key)), convertValue<V>(std::forward<Input>(value)));
  }
  bool erase(K key) {
    const auto found = index_.find(key);
    if (found == index_.end()) return false;
    const std::size_t erasedIndex = found->second;
    index_.erase(found);
    if (erasedIndex + 1 != entries_.size()) {
      entries_[erasedIndex] = std::move(entries_.back());
      index_[entries_[erasedIndex]->key.Get()] = erasedIndex;
    }
    entries_.pop_back();
    return true;
  }

  const void* dynamicTypeToken() const override { return nativeTypeToken<WeakMapObject<K, V>>(); }
  void* dynamicCast(const void* type) override {
    return type == nativeTypeToken<WeakMapObject<K, V>>() ? this : nullptr;
  }
  std::u16string dynamicToString() const override { return u"[object WeakMap]"; }
  void Trace(cppgc::Visitor* visitor) const override {
    BaseObject::Trace(visitor);
    for (const auto& entry : entries_) visitor->Trace(entry);
    visitor->RegisterWeakCallbackMethod<
        WeakMapObject, &WeakMapObject::processWeakness>(this);
  }

 private:
  class Entry final : public cppgc::GarbageCollected<Entry> {
   public:
    Entry(K keyValue, V mappedValue) : key(keyValue), value(std::move(mappedValue)) {}
    void Trace(cppgc::Visitor* visitor) const {
      visitor->Trace(key);
      value.Trace(visitor);
    }
    cppgc::WeakMember<KeyObject> key;
    ArraySlot<V> value;
  };
  void processWeakness(const cppgc::LivenessBroker& broker) {
    entries_.erase(std::remove_if(entries_.begin(), entries_.end(), [](const auto& entry) {
      return entry->key.Get() == nullptr;
    }), entries_.end());
    entries_.erase(std::remove_if(entries_.begin(), entries_.end(), [&](const auto& entry) {
      return !broker.IsHeapObjectAlive(entry->key);
    }), entries_.end());
    index_.clear();
    for (std::size_t index = 0; index < entries_.size(); ++index) {
      index_.emplace(entries_[index]->key.Get(), index);
    }
  }
  std::vector<cppgc::Member<Entry>> entries_;
  std::unordered_map<K, std::size_t> index_;
};

template <typename T>
class WeakSetObject final : public cppgc::GarbageCollected<WeakSetObject<T>>, public WeakSetLikeObject {
  static_assert(std::is_pointer_v<T>, "WeakSet values must be managed object pointers");
  using ValueObject = std::remove_pointer_t<T>;

 public:
  WeakSetObject* add(T value) {
    if (!value) throw runtimeError(u"Invalid WeakSet value");
    if (index_.insert(value).second) values_.emplace_back(makeManaged<Entry>(value));
    return this;
  }

  template <typename Input>
  WeakSetObject* add(Input&& value) {
    return add(convertValue<T>(std::forward<Input>(value)));
  }
  bool has(T value) const {
    return index_.contains(value);
  }

  template <typename Input>
  bool has(Input&& value) const {
    return has(convertValue<T>(std::forward<Input>(value)));
  }

  template <typename Input>
  bool vexa_delete(Input&& value) {
    return erase(convertValue<T>(std::forward<Input>(value)));
  }
  bool erase(T value) {
    if (index_.erase(value) == 0) return false;
    const auto found = std::find_if(values_.begin(), values_.end(), [&](const auto& candidate) {
      return candidate->value.Get() == value;
    });
    if (found == values_.end()) return true;
    values_.erase(found);
    return true;
  }
  const void* dynamicTypeToken() const override { return nativeTypeToken<WeakSetObject<T>>(); }
  void* dynamicCast(const void* type) override {
    return type == nativeTypeToken<WeakSetObject<T>>() ? this : nullptr;
  }
  std::u16string dynamicToString() const override { return u"[object WeakSet]"; }
  void Trace(cppgc::Visitor* visitor) const override {
    BaseObject::Trace(visitor);
    for (const auto& value : values_) visitor->Trace(value);
    visitor->RegisterWeakCallbackMethod<
        WeakSetObject, &WeakSetObject::processWeakness>(this);
  }

 private:
  class Entry final : public cppgc::GarbageCollected<Entry> {
   public:
    explicit Entry(T entryValue) : value(entryValue) {}
    void Trace(cppgc::Visitor* visitor) const { visitor->Trace(value); }
    cppgc::WeakMember<ValueObject> value;
  };
  void processWeakness(const cppgc::LivenessBroker& broker) {
    values_.erase(std::remove_if(values_.begin(), values_.end(), [&](const auto& value) {
      return value->value.Get() == nullptr || !broker.IsHeapObjectAlive(value->value);
    }), values_.end());
    index_.clear();
    for (const auto& value : values_) index_.insert(value->value.Get());
  }
  std::vector<cppgc::Member<Entry>> values_;
  std::unordered_set<T> index_;
};

template <typename Kind>
inline bool isCollectionLikeValue(const Value& value) {
  return value.isRuntimeObject() && value.object()->dynamicCast(nativeTypeToken<Kind>()) != nullptr;
}

template <typename Kind, typename T>
inline bool isCollectionLikePointer(T* value) {
  return value && value->dynamicCast(nativeTypeToken<Kind>()) != nullptr;
}

inline bool isMapLike(const Value& value) { return isCollectionLikeValue<MapLikeObject>(value); }
inline bool isSetLike(const Value& value) { return isCollectionLikeValue<SetLikeObject>(value); }
inline bool isWeakMapLike(const Value& value) { return isCollectionLikeValue<WeakMapLikeObject>(value); }
inline bool isWeakSetLike(const Value& value) { return isCollectionLikeValue<WeakSetLikeObject>(value); }

template <typename T> inline bool isMapLike(T* value) { return isCollectionLikePointer<MapLikeObject>(value); }
template <typename T> inline bool isSetLike(T* value) { return isCollectionLikePointer<SetLikeObject>(value); }
template <typename T> inline bool isWeakMapLike(T* value) { return isCollectionLikePointer<WeakMapLikeObject>(value); }
template <typename T> inline bool isWeakSetLike(T* value) { return isCollectionLikePointer<WeakSetLikeObject>(value); }

inline int uriHexValue(char16_t value) {
  if (value >= u'0' && value <= u'9') return value - u'0';
  if (value >= u'a' && value <= u'f') return value - u'a' + 10;
  if (value >= u'A' && value <= u'F') return value - u'A' + 10;
  return -1;
}

inline std::u16string decodeUriComponentText(const std::u16string& value) {
  auto bytes = utf16ToUtf8(u"");
  bytes.reserve(value.size());
  for (std::size_t index = 0; index < value.size(); ++index) {
    if (value[index] == u'%' && index + 2 < value.size()) {
      const int high = uriHexValue(value[index + 1]);
      const int low = uriHexValue(value[index + 2]);
      if (high >= 0 && low >= 0) {
        bytes.push_back(static_cast<char>((high << 4) | low));
        index += 2;
        continue;
      }
    }
    const auto encoded = utf16ToUtf8(std::u16string_view(&value[index], 1));
    bytes.append(encoded);
  }
  return utf8ToUtf16(bytes);
}

inline std::u16string encodeUriComponentText(const std::u16string& value) {
  static constexpr char16_t HEX[] = u"0123456789ABCDEF";
  std::u16string result;
  for (const unsigned char byte : utf16ToUtf8(value)) {
    if (std::isalnum(byte) || byte == '-' || byte == '_' || byte == '.' || byte == '!' ||
        byte == '~' || byte == '*' || byte == '\'' || byte == '(' || byte == ')') {
      result.push_back(static_cast<char16_t>(byte));
    } else {
      result.push_back(u'%');
      result.push_back(HEX[byte >> 4]);
      result.push_back(HEX[byte & 0x0f]);
    }
  }
  return result;
}

class URLObject final : public cppgc::GarbageCollected<URLObject>, public BaseObject {
 public:
  explicit URLObject(std::u16string value) : href(std::move(value)) {
    const auto separator = href.find(u':');
    if (separator == std::u16string::npos) {
      pathname = href;
    } else {
      protocol = href.substr(0, separator + 1);
      const std::size_t pathStart = href.compare(separator + 1, 2, u"//") == 0
          ? separator + 3
          : separator + 1;
      pathname = pathStart < href.size() ? href.substr(pathStart) : u"";
      if (protocol == u"file:" && (pathname.empty() || pathname.front() != u'/')) pathname.insert(pathname.begin(), u'/');
    }
  }

  const void* dynamicTypeToken() const override { return nativeTypeToken<URLObject>(); }
  void* dynamicCast(const void* type) override { return type == nativeTypeToken<URLObject>() ? this : nullptr; }
  std::u16string dynamicToString() const override { return href; }
  void Trace(cppgc::Visitor* visitor) const override { BaseObject::Trace(visitor); }

  std::u16string href;
  std::u16string protocol;
  std::u16string pathname;
};

class DateObject final : public cppgc::GarbageCollected<DateObject>, public BaseObject {
 public:
  DateObject()
      : milliseconds_(std::chrono::duration<double, std::milli>(
            std::chrono::system_clock::now().time_since_epoch()).count()) {}
  explicit DateObject(double milliseconds) : milliseconds_(milliseconds) {}
  explicit DateObject(const std::u16string& text) : milliseconds_(parse(text)) {}

  static double parse(const std::u16string& text) {
    std::tm parts{};
    char separator = 0;
    char zone = 0;
    int milliseconds = 0;
    const auto encoded = utf16ToUtf8(text);
    const int fields = std::sscanf(
        encoded.c_str(), "%d-%d-%d%c%d:%d:%d.%d%c",
        &parts.tm_year, &parts.tm_mon, &parts.tm_mday, &separator,
        &parts.tm_hour, &parts.tm_min, &parts.tm_sec, &milliseconds, &zone);
    if (fields != 3 && !(fields >= 8 && separator == 'T' && (fields == 8 || zone == 'Z'))) {
      return std::numeric_limits<double>::quiet_NaN();
    }
    parts.tm_year -= 1900;
    parts.tm_mon -= 1;
#if defined(_WIN32)
    const std::time_t seconds = _mkgmtime(&parts);
#else
    const std::time_t seconds = timegm(&parts);
#endif
    return seconds == static_cast<std::time_t>(-1)
        ? std::numeric_limits<double>::quiet_NaN()
        : static_cast<double>(seconds) * 1000.0 + milliseconds;
  }

  double getTime() const { return milliseconds_; }
  double valueOf() const { return milliseconds_; }
  double getUTCFullYear() const { return utcParts().tm_year + 1900; }
  double getUTCMonth() const { return utcParts().tm_mon; }
  double getUTCDate() const { return utcParts().tm_mday; }
  double getUTCDay() const { return utcParts().tm_wday; }
  double getUTCHours() const { return utcParts().tm_hour; }
  double getUTCMinutes() const { return utcParts().tm_min; }
  double getUTCSeconds() const { return utcParts().tm_sec; }
  double getUTCMilliseconds() const {
    const double remainder = std::fmod(milliseconds_, 1000.0);
    return remainder < 0 ? remainder + 1000.0 : remainder;
  }

  std::u16string toISOString() const {
    if (!std::isfinite(milliseconds_)) throw runtimeError(u"Invalid time value");
    const std::tm parts = utcParts();
    return formatIsoDateText(parts, static_cast<int>(getUTCMilliseconds()));
  }

  std::u16string toString() const { return toISOString(); }
  std::u16string toJSON() const { return toISOString(); }

  const void* dynamicTypeToken() const override { return nativeTypeToken<DateObject>(); }
  void* dynamicCast(const void* type) override {
    return type == nativeTypeToken<DateObject>() ? this : nullptr;
  }
  std::u16string dynamicToString() const override { return toString(); }
  std::optional<std::u16string> dynamicJsonStringify(std::unordered_set<const void*>&) const override {
    return jsonQuoted(toISOString());
  }
  void Trace(cppgc::Visitor* visitor) const override { BaseObject::Trace(visitor); }

 private:
  std::tm utcParts() const {
    const auto seconds = static_cast<std::time_t>(std::floor(milliseconds_ / 1000.0));
    std::tm result{};
#if defined(_WIN32)
    gmtime_s(&result, &seconds);
#else
    gmtime_r(&seconds, &result);
#endif
    return result;
  }

  double milliseconds_;
};

inline double dateNow() {
  return std::chrono::duration<double, std::milli>(
      std::chrono::system_clock::now().time_since_epoch()).count();
}

inline double performanceNow() {
  static const auto origin = std::chrono::steady_clock::now();
  return std::chrono::duration<double, std::milli>(
      std::chrono::steady_clock::now() - origin).count();
}

inline std::u16string vexaRuntimeName() { return u"native"; }

inline std::u16string vexaPlatformName() {
#if defined(_WIN32)
  return u"windows";
#elif defined(__APPLE__)
  return u"macos";
#elif defined(__linux__)
  return u"linux";
#elif defined(__FreeBSD__)
  return u"freebsd";
#else
  return u"unknown";
#endif
}

inline double dateParse(const std::u16string& value) { return DateObject::parse(value); }

class ArrayBufferObject final : public cppgc::GarbageCollected<ArrayBufferObject>, public BaseObject {
 public:
  explicit ArrayBufferObject(std::size_t byteLength)
      : ArrayBufferObject(byteLength, byteLength) {}
  ArrayBufferObject(std::size_t byteLength, std::size_t maxByteLength)
      : bytes_(std::make_shared<std::vector<std::uint8_t>>(byteLength, 0)),
        max_byte_length_(std::max(byteLength, maxByteLength)),
        resizable_(max_byte_length_ > byteLength) {}
  std::size_t byteLength() const { return detached_ ? 0 : bytes_->size(); }
  std::size_t maxByteLength() const { return detached_ ? 0 : max_byte_length_; }
  bool resizable() const { return !detached_ && resizable_; }
  bool growable() const { return resizable(); }
  bool detached() const { return detached_; }
  void resizeBytes(std::size_t byteLength) {
    if (detached_ || !resizable_) throw runtimeError(u"ArrayBuffer is not resizable");
    if (byteLength > max_byte_length_) throw runtimeError(u"ArrayBuffer resize exceeds maxByteLength");
    bytes_->resize(byteLength, 0);
  }
  void growBytes(std::size_t targetByteLength) {
    if (targetByteLength < this->byteLength()) throw runtimeError(u"SharedArrayBuffer cannot shrink");
    resizeBytes(targetByteLength);
  }
  void resize(double byteLength);
  void grow(double targetByteLength);
  ArrayBufferObject* transfer(double newByteLength = std::numeric_limits<double>::quiet_NaN());
  ArrayBufferObject* transferToFixedLength(double newByteLength = std::numeric_limits<double>::quiet_NaN());
  ArrayBufferObject* transferBytes(std::size_t byteLength, bool fixedLength);
  std::uint8_t* data() { return bytes_->data(); }
  const std::uint8_t* data() const { return bytes_->data(); }
  std::shared_ptr<std::vector<std::uint8_t>> sharedBytes() const { return bytes_; }
  std::uint8_t get(std::size_t index) const {
    if (index >= bytes_->size()) throw std::out_of_range("ArrayBuffer access is out of range");
    return (*bytes_)[index];
  }
  void set(std::size_t index, std::uint8_t value) {
    if (index >= bytes_->size()) throw std::out_of_range("ArrayBuffer access is out of range");
    (*bytes_)[index] = value;
  }
  const void* dynamicTypeToken() const override { return nativeTypeToken<ArrayBufferObject>(); }
  void* dynamicCast(const void* type) override {
    return type == nativeTypeToken<ArrayBufferObject>() ? this : nullptr;
  }
  std::u16string dynamicToString() const override { return u"[object ArrayBuffer]"; }
  void Trace(cppgc::Visitor* visitor) const override { BaseObject::Trace(visitor); }

 private:
  std::shared_ptr<std::vector<std::uint8_t>> bytes_;
  std::size_t max_byte_length_;
  bool resizable_ = false;
  bool detached_ = false;
};

inline ArrayBufferObject* arrayBufferTransfer(
    ArrayBufferObject* buffer,
    double newByteLength = std::numeric_limits<double>::quiet_NaN(),
    bool fixedLength = false) {
  if (!buffer) throw runtimeError(u"ArrayBuffer transfer requires a buffer");
  const auto length = std::isnan(newByteLength)
    ? std::numeric_limits<std::size_t>::max()
    : static_cast<std::size_t>(std::max(0.0, std::trunc(newByteLength)));
  return buffer->transferBytes(length, fixedLength);
}

class FFIPointerObject final : public cppgc::GarbageCollected<FFIPointerObject>, public BaseObject {
 public:
  FFIPointerObject(void* address, std::size_t byteLength = std::numeric_limits<std::size_t>::max())
      : address(static_cast<std::int64_t>(reinterpret_cast<std::uintptr_t>(address))),
        address_(static_cast<std::uint8_t*>(address)), byte_length_(byteLength) {}
  FFIPointerObject(ArrayBufferObject* buffer, std::size_t byteOffset = 0, std::size_t byteLength = std::numeric_limits<std::size_t>::max())
      : address(static_cast<std::int64_t>(reinterpret_cast<std::uintptr_t>(buffer ? buffer->data() + byteOffset : nullptr))), backing_(buffer),
        address_(buffer ? buffer->data() + byteOffset : nullptr),
        byte_length_(buffer ? std::min(byteLength, buffer->byteLength() - std::min(byteOffset, buffer->byteLength())) : 0) {
    if (!buffer || byteOffset > buffer->byteLength()) throw std::out_of_range("FFIPointer view is outside its ArrayBuffer");
  }
  void* rawAddress() const { return address_; }
  std::int64_t address;
  double getInt8(double offset) const { return read<std::int8_t>(offset); }
  double getInt16(double offset) const { return read<std::int16_t>(offset); }
  double getInt32(double offset) const { return read<std::int32_t>(offset); }
  std::int64_t getInt64(double offset) const { return read<std::int64_t>(offset); }
  double getFloat32(double offset) const { return read<float>(offset); }
  double getFloat64(double offset) const { return read<double>(offset); }
  void setInt8(double offset, double value) { write<std::int8_t>(offset, static_cast<std::int8_t>(value)); }
  void setInt16(double offset, double value) { write<std::int16_t>(offset, static_cast<std::int16_t>(value)); }
  void setInt32(double offset, double value) { write<std::int32_t>(offset, static_cast<std::int32_t>(value)); }
  void setInt64(double offset, std::int64_t value) { write<std::int64_t>(offset, value); }
  void setFloat32(double offset, double value) { write<float>(offset, static_cast<float>(value)); }
  void setFloat64(double offset, double value) { write<double>(offset, value); }
  const void* dynamicTypeToken() const override { return nativeTypeToken<FFIPointerObject>(); }
  void* dynamicCast(const void* type) override { return type == nativeTypeToken<FFIPointerObject>() ? this : nullptr; }
  std::u16string dynamicToString() const override { return u"[object FFIPointer]"; }
  void Trace(cppgc::Visitor* visitor) const override { BaseObject::Trace(visitor); visitor->Trace(backing_); }

 private:
  template <typename T> T read(double offsetValue) const {
    const auto offset = checkedOffset<T>(offsetValue);
    T value;
    std::memcpy(&value, address_ + offset, sizeof(T));
    return value;
  }
  template <typename T> void write(double offsetValue, T value) {
    const auto offset = checkedOffset<T>(offsetValue);
    std::memcpy(address_ + offset, &value, sizeof(T));
  }
  template <typename T> std::size_t checkedOffset(double offsetValue) const {
    if (!address_ || offsetValue < 0 || !std::isfinite(offsetValue)) throw std::out_of_range("Invalid FFIPointer access");
    const auto offset = static_cast<std::size_t>(offsetValue);
    if (byte_length_ != std::numeric_limits<std::size_t>::max() && (offset > byte_length_ || sizeof(T) > byte_length_ - offset)) {
      throw std::out_of_range("FFIPointer access is out of range");
    }
    return offset;
  }
  cppgc::Member<ArrayBufferObject> backing_;
  std::uint8_t* address_ = nullptr;
  std::size_t byte_length_ = 0;
};

class Uint8ArrayObject final : public cppgc::GarbageCollected<Uint8ArrayObject>, public BaseObject {
 public:
  Uint8ArrayObject(ArrayBufferObject* buffer, std::size_t byteOffset, std::size_t length)
      : buffer_(buffer), byte_offset_(byteOffset), length_(length) {
    if (!buffer || byteOffset + length > buffer->byteLength()) {
      throw std::out_of_range("Uint8Array view is outside its ArrayBuffer");
    }
  }
  std::size_t size() const { return length_; }
  std::size_t length() const { return length_; }
  std::size_t byteLength() const { return length_; }
  std::size_t byteOffset() const { return byte_offset_; }
  ArrayBufferObject* buffer() const { return buffer_.Get(); }
  std::uint8_t get(std::size_t index) const {
    if (index >= length_) throw std::out_of_range("Uint8Array index is out of range");
    return buffer_->get(byte_offset_ + index);
  }
  std::uint8_t set(std::size_t index, double value) {
    if (index >= length_) throw std::out_of_range("Uint8Array index is out of range");
    double modulo = std::isfinite(value) ? std::fmod(std::trunc(value), 256.0) : 0.0;
    if (modulo < 0) modulo += 256.0;
    const auto converted = static_cast<std::uint8_t>(modulo);
    buffer_->set(byte_offset_ + index, converted);
    return converted;
  }
  const void* dynamicTypeToken() const override { return nativeTypeToken<Uint8ArrayObject>(); }
  void* dynamicCast(const void* type) override {
    return type == nativeTypeToken<Uint8ArrayObject>() ? this : nullptr;
  }
  std::u16string dynamicToString() const override { return u"[object Uint8Array]"; }
  Value dynamicGet(const std::u16string& key) override {
    if (key == u"length") return Value(static_cast<double>(length_));
    if (key == u"byteLength") return Value(static_cast<double>(length_));
    if (key == u"byteOffset") return Value(static_cast<double>(byte_offset_));
    const auto index = propertyIndex(key);
    return index && *index < length_ ? Value(static_cast<double>(get(*index))) : Value::undefined();
  }
  Value dynamicSet(const std::u16string& key, const Value& value) override {
    const auto index = propertyIndex(key);
    if (!index) throw runtimeError(u"Invalid Uint8Array index");
    return Value(static_cast<double>(set(*index, Number(value))));
  }
  void Trace(cppgc::Visitor* visitor) const override {
    BaseObject::Trace(visitor);
    visitor->Trace(buffer_);
  }

 private:
  cppgc::Member<ArrayBufferObject> buffer_;
  std::size_t byte_offset_;
  std::size_t length_;
};

class TextEncoderObject final
    : public cppgc::GarbageCollected<TextEncoderObject>,
      public BaseObject {
 public:
  TextEncoderObject() : BaseObject(Kind::Record) {}

  Uint8ArrayObject* encode(const std::u16string& source) const;
  RecordObject* encodeInto(const std::u16string& source, Uint8ArrayObject* destination) const;
  std::u16string encoding = u"utf-8";

  const void* dynamicTypeToken() const override { return nativeTypeToken<TextEncoderObject>(); }
  void* dynamicCast(const void* type) override {
    if (type == nativeTypeToken<TextEncoderObject>()) return this;
    return type == nativeTypeToken<BaseObject>() ? static_cast<BaseObject*>(this) : nullptr;
  }
  std::u16string dynamicToString() const override { return u"[object TextEncoder]"; }
  void Trace(cppgc::Visitor* visitor) const override { BaseObject::Trace(visitor); }
};

class Uint32ArrayObject final : public cppgc::GarbageCollected<Uint32ArrayObject>, public BaseObject {
 public:
  Uint32ArrayObject(ArrayBufferObject* buffer, std::size_t byteOffset, std::size_t length)
      : buffer_(buffer), byte_offset_(byteOffset), length_(length) {
    if (!buffer || length > (buffer->byteLength() - std::min(byteOffset, buffer->byteLength())) / sizeof(std::uint32_t)) {
      throw std::out_of_range("Uint32Array view is outside its ArrayBuffer");
    }
  }
  std::size_t size() const { return length_; }
  std::size_t length() const { return length_; }
  std::size_t byteLength() const { return length_ * sizeof(std::uint32_t); }
  std::size_t byteOffset() const { return byte_offset_; }
  ArrayBufferObject* buffer() const { return buffer_.Get(); }
  std::uint32_t get(std::size_t index) const {
    if (index >= length_) throw std::out_of_range("Uint32Array index is out of range");
    std::uint32_t value = 0;
    std::memcpy(&value, buffer_->data() + byte_offset_ + index * sizeof(std::uint32_t), sizeof(value));
    return value;
  }
  std::uint32_t set(std::size_t index, double value) {
    if (index >= length_) throw std::out_of_range("Uint32Array index is out of range");
    double modulo = std::isfinite(value) ? std::fmod(std::trunc(value), 4294967296.0) : 0.0;
    if (modulo < 0) modulo += 4294967296.0;
    const auto converted = static_cast<std::uint32_t>(modulo);
    std::memcpy(buffer_->data() + byte_offset_ + index * sizeof(converted), &converted, sizeof(converted));
    return converted;
  }
  const void* dynamicTypeToken() const override { return nativeTypeToken<Uint32ArrayObject>(); }
  void* dynamicCast(const void* type) override {
    return type == nativeTypeToken<Uint32ArrayObject>() ? this : nullptr;
  }
  std::u16string dynamicToString() const override { return u"[object Uint32Array]"; }
  Value dynamicGet(const std::u16string& key) override {
    if (key == u"length") return Value(static_cast<double>(length_));
    if (key == u"byteLength") return Value(static_cast<double>(byteLength()));
    if (key == u"byteOffset") return Value(static_cast<double>(byte_offset_));
    const auto index = propertyIndex(key);
    return index && *index < length_ ? Value(static_cast<double>(get(*index))) : Value::undefined();
  }
  Value dynamicSet(const std::u16string& key, const Value& value) override {
    const auto index = propertyIndex(key);
    if (!index) throw runtimeError(u"Invalid Uint32Array index");
    return Value(static_cast<double>(set(*index, Number(value))));
  }
  void Trace(cppgc::Visitor* visitor) const override {
    BaseObject::Trace(visitor);
    visitor->Trace(buffer_);
  }

 private:
  cppgc::Member<ArrayBufferObject> buffer_;
  std::size_t byte_offset_;
  std::size_t length_;
};

class BigInt64ArrayObject final : public cppgc::GarbageCollected<BigInt64ArrayObject>, public BaseObject {
 public:
  BigInt64ArrayObject(ArrayBufferObject* buffer, std::size_t byteOffset, std::size_t length)
      : buffer_(buffer), byte_offset_(byteOffset), length_(length) {
    if (!buffer || byteOffset > buffer->byteLength() ||
        length > (buffer->byteLength() - byteOffset) / sizeof(std::int64_t)) {
      throw std::out_of_range("BigInt64Array view is outside its ArrayBuffer");
    }
  }
  std::size_t size() const { return length_; }
  std::size_t length() const { return length_; }
  std::size_t byteLength() const { return length_ * sizeof(std::int64_t); }
  std::size_t byteOffset() const { return byte_offset_; }
  ArrayBufferObject* buffer() const { return buffer_.Get(); }
  BigInt get(std::size_t index) const {
    if (index >= length_) throw std::out_of_range("BigInt64Array index is out of range");
    std::int64_t value = 0;
    std::memcpy(&value, buffer_->data() + byte_offset_ + index * sizeof(value), sizeof(value));
    return BigInt(value);
  }
  void set(std::size_t index, const BigInt& value) {
    if (index >= length_) throw std::out_of_range("BigInt64Array index is out of range");
    const auto converted = static_cast<std::int64_t>(value.toDouble());
    std::memcpy(buffer_->data() + byte_offset_ + index * sizeof(converted), &converted, sizeof(converted));
  }
  Value dynamicGet(const std::u16string& key) override {
    if (key == u"length") return Value(static_cast<double>(length_));
    if (key == u"byteLength") return Value(static_cast<double>(byteLength()));
    if (key == u"byteOffset") return Value(static_cast<double>(byte_offset_));
    const auto index = propertyIndex(key);
    return index && *index < length_ ? Value(get(*index)) : Value::undefined();
  }
  Value dynamicSet(const std::u16string& key, const Value& value) override {
    const auto index = propertyIndex(key);
    if (!index) throw runtimeError(u"Invalid BigInt64Array index");
    set(*index, value.isBigInt() ? value.bigint() : BigInt(static_cast<std::int64_t>(Number(value))));
    return Value(get(*index));
  }
  const void* dynamicTypeToken() const override { return nativeTypeToken<BigInt64ArrayObject>(); }
  void* dynamicCast(const void* type) override {
    return type == nativeTypeToken<BigInt64ArrayObject>() ? this : nullptr;
  }
  std::u16string dynamicToString() const override { return u"[object BigInt64Array]"; }
  void Trace(cppgc::Visitor* visitor) const override {
    BaseObject::Trace(visitor);
    visitor->Trace(buffer_);
  }

 private:
  cppgc::Member<ArrayBufferObject> buffer_;
  std::size_t byte_offset_;
  std::size_t length_;
};

inline std::uint16_t float16Bits(double value) {
  const auto bits = std::bit_cast<std::uint32_t>(static_cast<float>(value));
  const auto sign = (bits >> 16U) & 0x8000U;
  const auto exponent = static_cast<int>((bits >> 23U) & 0xffU);
  const auto mantissa = bits & 0x7fffffU;
  if (exponent == 0xff) {
    return static_cast<std::uint16_t>(sign | 0x7c00U | (mantissa ? 0x0200U : 0));
  }
  const auto halfExponent = exponent - 127 + 15;
  if (halfExponent >= 31) return static_cast<std::uint16_t>(sign | 0x7c00U);
  if (halfExponent <= 0) {
    if (halfExponent < -10) return static_cast<std::uint16_t>(sign);
    const auto shifted = (mantissa | 0x800000U) >> static_cast<unsigned>(1 - halfExponent);
    const auto rounded = shifted + ((shifted >> 13U) & 1U);
    return static_cast<std::uint16_t>(sign | (rounded >> 13U));
  }
  const auto roundedMantissa = mantissa + 0x1000U;
  if (roundedMantissa & 0x800000U) {
    if (halfExponent == 30) return static_cast<std::uint16_t>(sign | 0x7c00U);
    return static_cast<std::uint16_t>(sign | static_cast<std::uint32_t>(halfExponent + 1) << 10U);
  }
  return static_cast<std::uint16_t>(sign |
    (static_cast<std::uint32_t>(halfExponent) << 10U) |
    (roundedMantissa >> 13U));
}

inline double float16Value(std::uint16_t bits) {
  const auto sign = static_cast<std::uint32_t>(bits & 0x8000U) << 16U;
  const auto exponent = (bits >> 10U) & 0x1fU;
  const auto mantissa = bits & 0x03ffU;
  std::uint32_t result;
  if (exponent == 0) {
    if (mantissa == 0) {
      result = sign;
    } else {
      auto normalized = mantissa;
      int exponentValue = -14;
      while ((normalized & 0x0400U) == 0) {
        normalized <<= 1U;
        --exponentValue;
      }
      normalized &= 0x03ffU;
      result = sign |
        (static_cast<std::uint32_t>(exponentValue + 127) << 23U) |
        (normalized << 13U);
    }
  } else if (exponent == 0x1f) {
    result = sign | 0x7f800000U | (static_cast<std::uint32_t>(mantissa) << 13U);
  } else {
    result = sign |
      (static_cast<std::uint32_t>(exponent - 15 + 127) << 23U) |
      (static_cast<std::uint32_t>(mantissa) << 13U);
  }
  return static_cast<double>(std::bit_cast<float>(result));
}

class Float16ArrayObject final : public cppgc::GarbageCollected<Float16ArrayObject>, public BaseObject {
 public:
  Float16ArrayObject(ArrayBufferObject* buffer, std::size_t byteOffset, std::size_t length)
      : buffer_(buffer), byte_offset_(byteOffset), length_(length) {
    if (!buffer || byteOffset > buffer->byteLength() ||
        length > (buffer->byteLength() - byteOffset) / sizeof(std::uint16_t)) {
      throw std::out_of_range("Float16Array view is outside its ArrayBuffer");
    }
  }
  std::size_t size() const { return length_; }
  std::size_t length() const { return length_; }
  std::size_t byteLength() const { return length_ * sizeof(std::uint16_t); }
  std::size_t byteOffset() const { return byte_offset_; }
  ArrayBufferObject* buffer() const { return buffer_.Get(); }
  double get(std::size_t index) const {
    if (index >= length_) throw std::out_of_range("Float16Array index is out of range");
    std::uint16_t bits;
    std::memcpy(&bits, buffer_->data() + byte_offset_ + index * sizeof(bits), sizeof(bits));
    return float16Value(bits);
  }
  double set(std::size_t index, double value) {
    if (index >= length_) throw std::out_of_range("Float16Array index is out of range");
    const auto bits = float16Bits(value);
    std::memcpy(buffer_->data() + byte_offset_ + index * sizeof(bits), &bits, sizeof(bits));
    return float16Value(bits);
  }
  Value at(double index) const {
    const auto position = static_cast<std::int64_t>(std::trunc(index));
    const auto resolved = position < 0 ? static_cast<std::int64_t>(length_) + position : position;
    return resolved >= 0 && resolved < static_cast<std::int64_t>(length_)
      ? Value(get(static_cast<std::size_t>(resolved)))
      : Value::undefined();
  }
  Float16ArrayObject* copyWithin(double target, double start, double end = std::numeric_limits<double>::infinity());
  template <typename Callback>
  bool every(Callback callback) const;
  Float16ArrayObject* fill(double value, double start = 0, double end = std::numeric_limits<double>::infinity());
  template <typename Callback>
  Float16ArrayObject* filter(Callback callback) const;
  template <typename Callback>
  Value find(Callback callback) const;
  template <typename Callback>
  double findIndex(Callback callback) const;
  template <typename Callback>
  Value findLast(Callback callback) const;
  template <typename Callback>
  double findLastIndex(Callback callback) const;
  template <typename Callback>
  void forEach(Callback callback) const;
  bool includes(double value, double fromIndex = 0) const;
  double indexOf(double value, double fromIndex = 0) const;
  double lastIndexOf(double value, double fromIndex = std::numeric_limits<double>::infinity()) const;
  template <typename Callback>
  Float16ArrayObject* map(Callback callback) const;
  template <typename Callback>
  double reduce(Callback callback) const;
  template <typename Callback>
  double reduce(Callback callback, double initial) const;
  template <typename Callback>
  double reduceRight(Callback callback) const;
  template <typename Callback>
  double reduceRight(Callback callback, double initial) const;
  Float16ArrayObject* reverse();
  template <typename T>
  void set(const ArrayObject<T>* values, double offset = 0);
  void set(const Float16ArrayObject* values, double offset = 0);
  Float16ArrayObject* slice(double start = 0, double end = std::numeric_limits<double>::infinity()) const;
  template <typename Callback>
  bool some(Callback callback) const;
  Float16ArrayObject* sort();
  template <typename Callback>
  Float16ArrayObject* sort(Callback callback);
  Float16ArrayObject* subarray(double begin = 0, double end = std::numeric_limits<double>::infinity()) const;
  NativeIteratorObject<double>* values() const;
  NativeIteratorObject<double>* keys() const;
  NativeIteratorObject<ArrayObject<double>*>* entries() const;
  std::u16string join(const std::u16string& separator = u",") const;
  std::u16string toString() const;
  std::u16string toLocaleString() const;
  template <typename Callback>
  Float16ArrayObject* toSorted(Callback callback) const;
  Float16ArrayObject* toReversed() const;
  Float16ArrayObject* toSorted() const;
  Float16ArrayObject* with(double index, double value) const;
  Value dynamicGet(const std::u16string& key) override {
    if (key == u"length") return Value(static_cast<double>(length_));
    if (key == u"byteLength") return Value(static_cast<double>(byteLength()));
    if (key == u"byteOffset") return Value(static_cast<double>(byte_offset_));
    const auto index = propertyIndex(key);
    return index && *index < length_ ? Value(get(*index)) : Value::undefined();
  }
  Value dynamicSet(const std::u16string& key, const Value& value) override {
    const auto index = propertyIndex(key);
    if (!index) throw runtimeError(u"Invalid Float16Array index");
    return Value(set(*index, Number(value)));
  }
  const void* dynamicTypeToken() const override { return nativeTypeToken<Float16ArrayObject>(); }
  void* dynamicCast(const void* type) override {
    return type == nativeTypeToken<Float16ArrayObject>() ? this : nullptr;
  }
  std::u16string dynamicToString() const override { return toString(); }
  void Trace(cppgc::Visitor* visitor) const override {
    BaseObject::Trace(visitor);
    visitor->Trace(buffer_);
  }

 private:
  Float16ArrayObject* copy() const;
  cppgc::Member<ArrayBufferObject> buffer_;
  std::size_t byte_offset_;
  std::size_t length_;
};

template <typename T>
class NativeIteratorObject final
    : public cppgc::GarbageCollected<NativeIteratorObject<T>>,
      public BaseObject {
 public:
  explicit NativeIteratorObject(std::vector<T> values)
      : values_(std::move(values)) {}

  std::vector<T> takeRemaining() {
    std::vector<T> result(
        values_.begin() + static_cast<std::ptrdiff_t>(position_),
        values_.end());
    position_ = values_.size();
    return result;
  }
  template <typename Callback>
  auto map(Callback callback);
  template <typename Callback>
  NativeIteratorObject* filter(Callback callback);
  NativeIteratorObject* take(double limit);
  NativeIteratorObject* drop(double count);
  template <typename Callback, typename Accumulator>
  Accumulator reduce(Callback callback, Accumulator accumulator);
  template <typename Callback>
  T reduce(Callback callback);
  template <typename Callback>
  auto flatMap(Callback callback);
  template <typename Callback>
  void forEach(Callback callback);
  template <typename Callback>
  bool some(Callback callback);
  template <typename Callback>
  bool every(Callback callback);
  template <typename Callback>
  T find(Callback callback);
  ArrayObject<T>* toArray();
  const std::vector<T>& values() const { return values_; }
  std::size_t position() const { return position_; }
  const void* dynamicTypeToken() const override { return nativeTypeToken<NativeIteratorObject<T>>(); }
  void* dynamicCast(const void* type) override {
    return type == nativeTypeToken<NativeIteratorObject<T>>() ? this : nullptr;
  }
  std::u16string dynamicToString() const override { return u"[object Iterator]"; }
  void Trace(cppgc::Visitor* visitor) const override {
    BaseObject::Trace(visitor);
    for (const auto& value : values_) {
      if constexpr (requires { value.Trace(visitor); }) value.Trace(visitor);
    }
  }

 private:
  std::vector<T> values_;
  std::size_t position_ = 0;
};

class DataViewObject final : public cppgc::GarbageCollected<DataViewObject>, public BaseObject {
 public:
  DataViewObject(ArrayBufferObject* buffer, std::size_t byteOffset, std::size_t byteLength)
      : buffer_(buffer), byte_offset_(byteOffset), byte_length_(byteLength) {
    if (!buffer || byteOffset + byteLength > buffer->byteLength()) {
      throw std::out_of_range("DataView is outside its ArrayBuffer");
    }
  }
  std::size_t byteLength() const { return byte_length_; }
  std::size_t byteOffset() const { return byte_offset_; }
  ArrayBufferObject* buffer() const { return buffer_.Get(); }
  double getUint8(double offset) const { return readValue<std::uint8_t>(offset, true); }
  double getInt8(double offset) const { return std::bit_cast<std::int8_t>(readValue<std::uint8_t>(offset, true)); }
  double getUint16(double offset, bool littleEndian = false) const { return readValue<std::uint16_t>(offset, littleEndian); }
  double getInt16(double offset, bool littleEndian = false) const {
    return std::bit_cast<std::int16_t>(readValue<std::uint16_t>(offset, littleEndian));
  }
  double getUint32(double offset, bool littleEndian = false) const { return readValue<std::uint32_t>(offset, littleEndian); }
  double getInt32(double offset, bool littleEndian = false) const {
    return std::bit_cast<std::int32_t>(readValue<std::uint32_t>(offset, littleEndian));
  }
  double getFloat32(double offset, bool littleEndian = false) const {
    return static_cast<double>(std::bit_cast<float>(readValue<std::uint32_t>(offset, littleEndian)));
  }
  double getFloat64(double offset, bool littleEndian = false) const {
    return std::bit_cast<double>(readValue<std::uint64_t>(offset, littleEndian));
  }
  double getFloat16(double offset, bool littleEndian = false) const {
    return float16Value(readValue<std::uint16_t>(offset, littleEndian));
  }
  void setUint8(double offset, double value) { writeValue(offset, static_cast<std::uint8_t>(value), true); }
  void setInt8(double offset, double value) { writeValue(offset, static_cast<std::uint8_t>(value), true); }
  void setUint16(double offset, double value, bool littleEndian = false) { writeValue(offset, static_cast<std::uint16_t>(value), littleEndian); }
  void setInt16(double offset, double value, bool littleEndian = false) { writeValue(offset, static_cast<std::uint16_t>(value), littleEndian); }
  void setUint32(double offset, double value, bool littleEndian = false) { writeValue(offset, static_cast<std::uint32_t>(value), littleEndian); }
  void setInt32(double offset, double value, bool littleEndian = false) { writeValue(offset, static_cast<std::uint32_t>(value), littleEndian); }
  void setFloat32(double offset, double value, bool littleEndian = false) {
    writeValue(offset, std::bit_cast<std::uint32_t>(static_cast<float>(value)), littleEndian);
  }
  void setFloat64(double offset, double value, bool littleEndian = false) {
    writeValue(offset, std::bit_cast<std::uint64_t>(value), littleEndian);
  }
  void setFloat16(double offset, double value, bool littleEndian = false) {
    writeValue(offset, float16Bits(value), littleEndian);
  }
  const void* dynamicTypeToken() const override { return nativeTypeToken<DataViewObject>(); }
  void* dynamicCast(const void* type) override {
    return type == nativeTypeToken<DataViewObject>() ? this : nullptr;
  }
  std::u16string dynamicToString() const override { return u"[object DataView]"; }
  void Trace(cppgc::Visitor* visitor) const override {
    BaseObject::Trace(visitor);
    visitor->Trace(buffer_);
  }

 private:
  static_assert(
      std::endian::native == std::endian::little || std::endian::native == std::endian::big,
      "DataView requires a consistently little- or big-endian native target");

  template <typename UInt>
  static UInt byteSwap(UInt value) {
    static_assert(std::is_unsigned_v<UInt>);
    if constexpr (sizeof(UInt) == 1) {
      return value;
    } else if constexpr (sizeof(UInt) == 2) {
      return static_cast<UInt>((value << 8U) | (value >> 8U));
    } else if constexpr (sizeof(UInt) == 4) {
      return static_cast<UInt>(
          ((value & 0x000000ffU) << 24U) |
          ((value & 0x0000ff00U) << 8U) |
          ((value & 0x00ff0000U) >> 8U) |
          ((value & 0xff000000U) >> 24U));
    } else {
      static_assert(sizeof(UInt) == 8);
      return static_cast<UInt>(
          ((value & 0x00000000000000ffULL) << 56U) |
          ((value & 0x000000000000ff00ULL) << 40U) |
          ((value & 0x0000000000ff0000ULL) << 24U) |
          ((value & 0x00000000ff000000ULL) << 8U) |
          ((value & 0x000000ff00000000ULL) >> 8U) |
          ((value & 0x0000ff0000000000ULL) >> 24U) |
          ((value & 0x00ff000000000000ULL) >> 40U) |
          ((value & 0xff00000000000000ULL) >> 56U));
    }
  }

  template <typename UInt>
  UInt readValue(double offsetValue, bool littleEndian) const {
    static_assert(std::is_unsigned_v<UInt>);
    if (!std::isfinite(offsetValue) || offsetValue < 0) {
      throw std::out_of_range("DataView access is out of range");
    }
    const auto offset = static_cast<std::size_t>(offsetValue);
    if (offset > byte_length_ || sizeof(UInt) > byte_length_ - offset) {
      throw std::out_of_range("DataView access is out of range");
    }
    UInt value;
    std::memcpy(&value, buffer_->data() + byte_offset_ + offset, sizeof(value));
    constexpr bool nativeLittleEndian = std::endian::native == std::endian::little;
    return littleEndian == nativeLittleEndian ? value : byteSwap(value);
  }

  template <typename UInt>
  void writeValue(double offsetValue, UInt value, bool littleEndian) {
    static_assert(std::is_unsigned_v<UInt>);
    if (!std::isfinite(offsetValue) || offsetValue < 0) {
      throw std::out_of_range("DataView access is out of range");
    }
    const auto offset = static_cast<std::size_t>(offsetValue);
    if (offset > byte_length_ || sizeof(UInt) > byte_length_ - offset) {
      throw std::out_of_range("DataView access is out of range");
    }
    constexpr bool nativeLittleEndian = std::endian::native == std::endian::little;
    const UInt stored = littleEndian == nativeLittleEndian ? value : byteSwap(value);
    std::memcpy(buffer_->data() + byte_offset_ + offset, &stored, sizeof(stored));
  }
  cppgc::Member<ArrayBufferObject> buffer_;
  std::size_t byte_offset_;
  std::size_t byte_length_;
};

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

inline double arrayLength(const Value& value) {
  if (!value.isRuntimeObject() || !value.object()->dynamicIsArray()) {
    throw errorAtCurrentSource(u"Value is not an array");
  }
  return static_cast<double>(value.object()->dynamicArraySize());
}

inline ArrayObject<Value>* arrayPointer(const Value& value) {
  if (!value.isRuntimeObject()) throw errorAtCurrentSource(u"Value is not an array");
  auto* array = static_cast<ArrayObject<Value>*>(
      value.object()->dynamicCast(nativeTypeToken<ArrayObject<Value>>()));
  if (array) return array;
  if (!value.object()->dynamicIsArray()) {
    throw errorAtCurrentSource(u"Value is not a dynamically typed array");
  }
  return makeDynamicArrayValueView(value.object());
}

class DynamicArrayRange final {
 public:
  explicit DynamicArrayRange(BaseObject* array) : array_(array) {}

  class Iterator final {
   public:
    Iterator(BaseObject* array, std::size_t index)
        : array_(array), index_(index) {}
    Value operator*() const { return array_->dynamicArrayGet(index_); }
    Iterator& operator++() { ++index_; return *this; }
    bool operator!=(const Iterator& other) const { return index_ != other.index_; }

   private:
    BaseObject* array_;
    std::size_t index_;
  };

  Iterator begin() const { return Iterator(array_.Get(), 0); }
  Iterator end() const { return Iterator(array_.Get(), array_->dynamicArraySize()); }

 private:
  cppgc::Persistent<BaseObject> array_;
};

inline DynamicArrayRange dynamicArrayRange(const Value& value) {
  if (!value.isRuntimeObject() || !value.object()->dynamicIsArray()) {
    throw errorAtCurrentSource(u"Value is not an array");
  }
  return DynamicArrayRange(value.object());
}

class DynamicIterationRange final {
 public:
  explicit DynamicIterationRange(BaseObject* iterable) : iterable_(iterable) {}

  class Iterator final {
   public:
    Iterator(BaseObject* iterable, std::size_t index)
        : iterable_(iterable), index_(index) {}
    Value operator*() const { return iterable_->dynamicIterableGet(index_); }
    Iterator& operator++() { ++index_; return *this; }
    bool operator!=(const Iterator& other) const { return index_ != other.index_; }

   private:
    BaseObject* iterable_;
    std::size_t index_;
  };

  Iterator begin() const { return Iterator(iterable_.Get(), 0); }
  Iterator end() const { return Iterator(iterable_.Get(), iterable_->dynamicIterableSize()); }

 private:
  cppgc::Persistent<BaseObject> iterable_;
};

inline DynamicIterationRange dynamicIterationRange(const Value& value) {
  if (!value.isRuntimeObject() || !value.object()->dynamicIsIterable()) {
    throw errorAtCurrentSource(u"Value is not iterable");
  }
  return DynamicIterationRange(value.object());
}

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

inline bool arrayIsArray(const Value& value) {
  return value.isRuntimeObject() && value.object()->dynamicIsArray();
}

template <typename T>
inline bool arrayIsArray(const T&) {
  return false;
}

inline std::vector<std::u16string> stringCharacters(const std::u16string& value) {
  std::vector<std::u16string> result;
  result.reserve(value.size());
  for (char character : value) result.emplace_back(1, character);
  return result;
}

inline std::vector<std::u16string> stringCharacters(const Value& value) {
  return stringCharacters(toString(value));
}

template <typename T>
inline T* rawPointer(T* value) {
  return value;
}

template <typename T>
inline T* rawPointer(const cppgc::Member<T>& value) {
  return value.Get();
}

template <typename T>
inline T* rawPointer(const cppgc::Persistent<T>& value) {
  return value.Get();
}

inline BaseObject* rawPointer(const Value& value) {
  return value.isRuntimeObject() ? value.object() : nullptr;
}

template <typename Target, typename Callback>
inline Value optionalCall(Target* target, Callback&& callback) {
  if (!target) return Value::undefined();
  using Result = std::invoke_result_t<Callback, Target*>;
  if constexpr (std::is_void_v<Result>) {
    std::forward<Callback>(callback)(target);
    return Value::undefined();
  } else {
    return convertValue<Value>(std::forward<Callback>(callback)(target));
  }
}

template <typename T>
inline void defineProperty(T&& object, std::u16string key, const Value& value, bool enumerable) {
  using Input = std::remove_cvref_t<T>;
  if constexpr (std::is_same_v<Input, Value>) {
    if (object.isRecord()) {
      if (enumerable) object.record()->set(std::move(key), value);
      else object.record()->setHidden(std::move(key), value);
    } else if (object.isRuntimeObject()) {
      object.object()->dynamicDefineProperty(key, value, enumerable);
    } else {
      throw runtimeError(u"Native Object.defineProperty requires an object");
    }
  } else {
    auto* pointer = rawPointer(std::forward<T>(object));
    using Object = std::remove_pointer_t<decltype(pointer)>;
    if constexpr (std::is_base_of_v<BaseObject, Object>) {
      if (!pointer) throw runtimeError(u"Cannot define a property on null");
      pointer->dynamicDefineProperty(key, value, enumerable);
    } else if constexpr (std::is_base_of_v<EnumerableObject, Object>) {
      if (!pointer) throw runtimeError(u"Cannot define a property on null");
      pointer->defineProperty(key, value, enumerable);
    } else if constexpr (std::is_same_v<Object, RecordObject>) {
      if (!pointer) throw runtimeError(u"Cannot define a property on null");
      if (enumerable) pointer->set(std::move(key), value);
      else pointer->setHidden(std::move(key), value);
    } else {
      throw runtimeError(u"Native Object.defineProperty requires an enumerable native object");
    }
  }
}

class Error {
 public:
  explicit Error(const Value& value)
      : message_(value.isString() ? value.string() : toString(value)) {}
  explicit Error(std::u16string value)
      : message_(std::move(value)) {}

  const std::u16string& messageText() const { return message_; }
  Value name;

 private:
  std::u16string message_;
};

class RegExp final {
 public:
  RegExp() : RegExp(u"", u"") {}
  RegExp(std::u16string pattern, const std::u16string& flags)
      : pattern_(std::move(pattern)),
        global_(flags.find(u'g') != std::u16string::npos),
        ignore_case_(flags.find(u'i') != std::u16string::npos),
        multiline_(flags.find(u'm') != std::u16string::npos),
        dot_all_(flags.find(u's') != std::u16string::npos),
        has_indices_(flags.find(u'd') != std::u16string::npos),
        unicode_(flags.find(u'u') != std::u16string::npos),
        unicode_sets_(flags.find(u'v') != std::u16string::npos),
        expression_(cachedExpression(pattern_, ignore_case_)) {}

  bool test(const std::u16string& value) const { return expression_->test(value); }
  std::optional<std::vector<std::u16string>> exec(const std::u16string& value) const {
    return expression_->exec(value);
  }
  const std::u16string& source() const { return pattern_; }
  bool global() const { return global_; }
  bool ignoreCase() const { return ignore_case_; }
  bool multiline() const { return multiline_; }
  bool dotAll() const { return dot_all_; }
  bool hasIndices() const { return has_indices_; }
  bool unicode() const { return unicode_; }
  bool unicodeSets() const { return unicode_sets_; }
  std::u16string flags() const {
    std::u16string result;
    if (has_indices_) result += u"d";
    if (global_) result += u"g";
    if (ignore_case_) result += u"i";
    if (multiline_) result += u"m";
    if (dot_all_) result += u"s";
    if (unicode_) result += u"u";
    if (unicode_sets_) result += u"v";
    return result;
  }
  std::u16string replace(const std::u16string& value, const std::u16string& replacement) const {
    return expression_->replace(value, replacement);
  }

  std::vector<std::u16string> split(const std::u16string& value) const {
    return expression_->split(value);
  }

 private:
  static std::shared_ptr<const Utf16Regex> cachedExpression(
      std::u16string pattern,
      bool caseInsensitive) {
    static std::unordered_map<std::u16string, std::shared_ptr<const Utf16Regex>> cache;
    std::u16string key;
    key.reserve(pattern.size() + 1);
    key.push_back(caseInsensitive ? u'i' : u'-');
    key += pattern;
    const auto found = cache.find(key);
    if (found != cache.end()) return found->second;
    auto expression = std::make_shared<const Utf16Regex>(std::move(pattern), caseInsensitive);
    cache.emplace(std::move(key), expression);
    return expression;
  }

  std::u16string pattern_;
  bool global_ = false;
  bool ignore_case_ = false;
  bool multiline_ = false;
  bool dot_all_ = false;
  bool has_indices_ = false;
  bool unicode_ = false;
  bool unicode_sets_ = false;
  std::shared_ptr<const Utf16Regex> expression_;
};

class DurationFormatObject final
    : public cppgc::GarbageCollected<DurationFormatObject>,
      public BaseObject {
 public:
  DurationFormatObject(std::u16string locale, RecordObject* options)
      : locale_(std::move(locale)) {
    if (locale_.empty()) locale_ = u"en";
    if (!options) return;
    if (options->has(u"style")) style_ = toString(options->get(u"style"));
    if (options->has(u"numberingSystem")) numbering_system_ = toString(options->get(u"numberingSystem"));
    if (options->has(u"fractionalDigits")) fractional_digits_ = static_cast<int>(Number(options->get(u"fractionalDigits")));
  }

  std::u16string format(RecordObject* duration) const;
  ArrayObject<RecordObject*>* formatToParts(RecordObject* duration) const;
  RecordObject* resolvedOptions() const;
  const void* dynamicTypeToken() const override { return nativeTypeToken<DurationFormatObject>(); }
  void* dynamicCast(const void* type) override {
    return type == nativeTypeToken<DurationFormatObject>() ? this : nullptr;
  }
  std::u16string dynamicToString() const override { return u"[object Intl.DurationFormat]"; }
  void Trace(cppgc::Visitor* visitor) const override { BaseObject::Trace(visitor); }

 private:
  bool spanish() const { return locale_.size() >= 2 && locale_[0] == u'e' && locale_[1] == u's'; }
  std::u16string locale_;
  std::u16string numbering_system_ = u"latn";
  std::u16string style_ = u"short";
  int fractional_digits_ = -1;
};

inline bool regexTest(const RegExp& expression, const std::u16string& value) {
  return expression.test(value);
}

inline bool regexTest(const RegExp& expression, const Value& value) {
  return expression.test(value.isString() ? value.string() : u"");
}

// Primitive ambient members use their declaration names at the C++ call
// boundary.  The string-prefixed helpers below are implementation details;
// these overloads keep the native ABI aligned with String and RegExp without
// making the emitter maintain a second method-name table.
inline bool test(const RegExp& expression, const std::u16string& value) {
  return regexTest(expression, value);
}

inline bool test(const RegExp& expression, const Value& value) {
  return regexTest(expression, value);
}

inline std::u16string stringReplace(const std::u16string& value, const RegExp& expression, const Value& replacement) {
  return expression.replace(value, toString(replacement));
}

inline std::u16string stringReplace(const std::u16string& value, const RegExp& expression, const std::u16string& replacement) {
  return expression.replace(value, replacement);
}

inline std::u16string stringReplace(const std::u16string& value, const std::u16string& search, const std::u16string& replacement) {
  const auto offset = value.find(search);
  if (offset == std::u16string::npos) return value;
  auto result = value;
  result.replace(offset, search.size(), replacement);
  return result;
}

inline std::u16string stringReplace(const Value& value, const Value& search, const Value& replacement) {
  return stringReplace(requireString(value), requireString(search), requireString(replacement));
}

inline std::u16string stringReplace(const Value& value, const RegExp& expression, const Value& replacement) {
  return expression.replace(requireString(value), requireString(replacement));
}

inline std::u16string stringReplace(const Value& value, const RegExp& expression, const std::u16string& replacement) {
  return expression.replace(toString(value), replacement);
}

inline std::u16string stringReplace(const std::u16string& value, const std::u16string& search, const Value& replacement) {
  return stringReplace(value, search, requireString(replacement));
}

inline std::u16string stringReplace(const Value& value, const std::u16string& search, const std::u16string& replacement) {
  return stringReplace(requireString(value), search, replacement);
}

inline std::u16string stringReplace(const Value& value, const std::u16string& search, const Value& replacement) {
  return stringReplace(requireString(value), search, requireString(replacement));
}

template <typename... Arguments>
inline auto replace(const std::u16string& value, Arguments&&... arguments)
    -> decltype(stringReplace(value, std::forward<Arguments>(arguments)...)) {
  return stringReplace(value, std::forward<Arguments>(arguments)...);
}

template <typename... Arguments>
inline auto replace(const Value& value, Arguments&&... arguments)
    -> decltype(stringReplace(value, std::forward<Arguments>(arguments)...)) {
  return stringReplace(value, std::forward<Arguments>(arguments)...);
}

inline std::u16string stringReplaceAll(
    const std::u16string& value,
    const std::u16string& search,
    const std::u16string& replacement) {
  if (search.empty()) {
    std::u16string result = replacement;
    for (const char16_t character : value) {
      result.push_back(character);
      result += replacement;
    }
    return result;
  }
  std::u16string result;
  std::size_t start = 0;
  while (start <= value.size()) {
    const auto found = value.find(search, start);
    if (found == std::u16string::npos) {
      result += value.substr(start);
      break;
    }
    result += value.substr(start, found - start);
    result += replacement;
    start = found + search.size();
  }
  return result;
}

inline std::u16string stringReplaceAll(
    const Value& value,
    const std::u16string& search,
    const std::u16string& replacement) {
  return stringReplaceAll(requireString(value), search, replacement);
}

inline std::u16string stringReplaceAll(
    const std::u16string& value,
    const RegExp& expression,
    const std::u16string& replacement) {
  return expression.replace(value, replacement);
}

template <typename... Arguments>
inline auto replaceAll(const std::u16string& value, Arguments&&... arguments)
    -> decltype(stringReplaceAll(value, std::forward<Arguments>(arguments)...)) {
  return stringReplaceAll(value, std::forward<Arguments>(arguments)...);
}

template <typename... Arguments>
inline auto replaceAll(const Value& value, Arguments&&... arguments)
    -> decltype(stringReplaceAll(value, std::forward<Arguments>(arguments)...)) {
  return stringReplaceAll(value, std::forward<Arguments>(arguments)...);
}

inline std::u16string regexEscape(const std::u16string& value) {
  std::u16string result;
  result.reserve(value.size() * 2);
  auto appendHex = [&](std::uint32_t code, std::size_t width) {
    static constexpr char16_t digits[] = u"0123456789abcdef";
    for (std::size_t shift = width * 4; shift > 0; shift -= 4) {
      result.push_back(digits[(code >> (shift - 4)) & 0xf]);
    }
  };
  for (std::size_t index = 0; index < value.size(); ++index) {
    const char16_t character = value[index];
    const bool firstAsciiAlphaNumeric = index == 0 &&
      ((character >= u'a' && character <= u'z') ||
       (character >= u'A' && character <= u'Z') ||
       (character >= u'0' && character <= u'9'));
    if (firstAsciiAlphaNumeric) {
      result += u"\\x";
      appendHex(character, 2);
      continue;
    }
    switch (character) {
      case u'^': case u'$': case u'\\': case u'.': case u'*': case u'+':
      case u'?': case u'(': case u')': case u'[': case u']': case u'{':
      case u'}': case u'|': case u'/':
        result.push_back(u'\\');
        result.push_back(character);
        break;
      case u',': case u'-': case u'=': case u'<': case u'>': case u'#':
      case u'&': case u'!': case u'%': case u':': case u';': case u'@':
      case u'~': case u'\'': case u'`': case u'"': case u' ':
        result += u"\\x";
        appendHex(character, 2);
        break;
      case u'\f': result += u"\\f"; break;
      case u'\n': result += u"\\n"; break;
      case u'\r': result += u"\\r"; break;
      case u'\t': result += u"\\t"; break;
      case u'\v': result += u"\\v"; break;
      default:
        if (character >= 0xd800 && character <= 0xdfff) {
          result += u"\\u";
          appendHex(static_cast<std::uint16_t>(character), 4);
        } else {
          result.push_back(character);
        }
        break;
    }
  }
  return result;
}

template <typename Callback>
class Finally final {
 public:
  explicit Finally(Callback callback) : callback_(std::move(callback)) {}
  Finally(const Finally&) = delete;
  Finally& operator=(const Finally&) = delete;

  Finally(Finally&& other) noexcept
      : callback_(std::move(other.callback_)), active_(std::exchange(other.active_, false)) {}

  ~Finally() noexcept(false) {
    if (active_) callback_();
  }

 private:
  Callback callback_;
  bool active_ = true;
};

template <typename Callback>
Finally<std::decay_t<Callback>> finally(Callback&& callback) {
  return Finally<std::decay_t<Callback>>(std::forward<Callback>(callback));
}

class Runtime final {
 public:
  using TimerId = std::int32_t;
  using TimerCallback = std::function<void()>;
  using IoPoller = std::function<bool()>;

  static void initialize(std::size_t suggestedInitialHeapSizeBytes = 0) {
    if (heap_) return;
    platform_ = std::make_shared<OilpanPlatform>();
    cppgc::InitializeProcess(platform_->GetPageAllocator());
    cppgc::Heap::HeapOptions options;
    options.marking_support = cppgc::Heap::MarkingType::kAtomic;
    options.sweeping_support = cppgc::Heap::SweepingType::kAtomic;
    options.stack_support = cppgc::Heap::StackSupport::kSupportsConservativeStackScan;
    options.stack_start_marker.emplace();
    if (const auto configuredInitialHeapSize = initialHeapSizeBytes()) {
      options.resource_constraints.initial_heap_size_bytes = *configuredInitialHeapSize;
    } else if (suggestedInitialHeapSizeBytes > 0) {
      options.resource_constraints.initial_heap_size_bytes = suggestedInitialHeapSizeBytes;
    }
    heap_ = cppgc::Heap::Create(platform_, std::move(options));
  }

  static void shutdown() {
    timers_.clear();
    while (!scheduledTimers_.empty()) scheduledTimers_.pop();
    microtasks_.clear();
    ioPollers_.clear();
    literalStrings_.clear();
    heap_.reset();
    cppgc::ShutdownProcess();
    platform_.reset();
  }

  static Value string(std::u16string value) {
    initialize();
    return Value(cppgc::MakeGarbageCollected<StringObject>(
        heap_->GetAllocationHandle(), std::move(value)));
  }

  static Value concatStrings(StringObject* left, StringObject* right) {
    initialize();
    if (left->size() == 0) return Value(right);
    if (right->size() == 0) return Value(left);
    return Value(cppgc::MakeGarbageCollected<StringObject>(
        heap_->GetAllocationHandle(), left, right));
  }

  static StringObject* retainLiteralString(std::u16string value) {
    initialize();
    auto* literal = cppgc::MakeGarbageCollected<StringObject>(
        heap_->GetAllocationHandle(), std::move(value));
    literalStrings_.emplace_back(literal);
    return literal;
  }

  static void reserveLiterals(std::size_t count) { literalStrings_.reserve(count); }

  static RecordObject* record(
      std::initializer_list<std::pair<std::u16string, Value>> properties = {}) {
    auto* result = make<RecordObject>();
    for (const auto& [key, value] : properties) result->set(key, value);
    return result;
  }

  template <typename T>
  static ArrayObject<T>* array(std::initializer_list<T> values = {}) {
    return make<ArrayObject<T>>(values);
  }

  template <typename T, typename... Arguments>
  static T* make(Arguments&&... arguments) {
    initialize();
    return cppgc::MakeGarbageCollected<T>(
        heap_->GetAllocationHandle(), std::forward<Arguments>(arguments)...);
  }

  static cppgc::Heap& heap() {
    initialize();
    return *heap_;
  }

  static void setSourceLocation(std::u16string file, std::size_t line, std::size_t column) {
    sourceFile_ = std::move(file);
    sourceLine_ = line;
    sourceColumn_ = column;
  }

  static std::u16string sourceLocation() {
    if (sourceFile_.empty()) return u"";
    return sourceFile_ + u":" + formatIntegerText(sourceLine_) +
        u":" + formatIntegerText(sourceColumn_);
  }

  static std::runtime_error errorAtCurrentSource(std::u16string message) {
    const auto location = sourceLocation();
    if (!location.empty()) message += u" at " + location;
    return runtimeError(message);
  }

  static void collectGarbageIfStressed() {
#if defined(VEXA_NATIVE_GC_STRESS)
    if (++statementsUntilCollection_ >= 8) {
      statementsUntilCollection_ = 0;
      heap_->ForceGarbageCollectionSlow(
          "VexaScript native statement", "VEXA_NATIVE_GC_STRESS",
          cppgc::Heap::StackState::kMayContainHeapPointers);
    }
#endif
  }

  static TimerId setTimeout(TimerCallback callback, double delay = 0) {
    return scheduleTimer(std::move(callback), delay, false);
  }

  static TimerId setInterval(TimerCallback callback, double delay = 0) {
    return scheduleTimer(std::move(callback), delay, true);
  }

  static void clearTimeout(TimerId id) { timers_.erase(id); }
  static void clearInterval(TimerId id) { timers_.erase(id); }
  static void clearTimeout(const Value& id) { clearTimeout(static_cast<TimerId>(Number(id))); }
  static void clearInterval(const Value& id) { clearInterval(static_cast<TimerId>(Number(id))); }

  static void runEventLoop() {
    while (runOneEvent()) {}
  }

  static void enqueueMicrotask(TimerCallback callback) {
    microtasks_.push_back(std::move(callback));
  }

  static void enqueueIo(IoPoller poller) {
    ioPollers_.push_back(std::move(poller));
  }

  template <typename Predicate>
  static void runUntil(Predicate settled) {
    while (!settled()) {
      if (!runOneEvent()) {
        throw runtimeError(u"VexaScript task cannot settle because the event loop is empty");
      }
    }
  }

 private:
  using Clock = std::chrono::steady_clock;

  struct TimerState final {
    TimerCallback callback;
    double delay;
    bool repeating;
  };

  struct ScheduledTimer final {
    Clock::time_point due;
    TimerId id;
  };

  struct EarlierTimer final {
    bool operator()(const ScheduledTimer& left, const ScheduledTimer& right) const {
      if (left.due != right.due) return left.due > right.due;
      return left.id > right.id;
    }
  };

  static Clock::time_point deadline(double delay) {
    const auto milliseconds = std::chrono::duration<double, std::milli>(std::max(0.0, delay));
    return Clock::now() + std::chrono::duration_cast<Clock::duration>(milliseconds);
  }

  static TimerId scheduleTimer(TimerCallback callback, double delay, bool repeating) {
    const TimerId id = nextTimerId_++;
    timers_.emplace(id, TimerState{std::move(callback), delay, repeating});
    scheduledTimers_.push({deadline(delay), id});
    return id;
  }

  static bool runOneEvent() {
    if (!microtasks_.empty()) {
      TimerCallback callback = std::move(microtasks_.front());
      microtasks_.pop_front();
      callback();
      return true;
    }

    for (auto poller = ioPollers_.begin(); poller != ioPollers_.end(); ++poller) {
      if (!(*poller)()) continue;
      ioPollers_.erase(poller);
      return true;
    }

    while (!scheduledTimers_.empty()) {
      const ScheduledTimer scheduled = scheduledTimers_.top();
      scheduledTimers_.pop();
      auto timer = timers_.find(scheduled.id);
      if (timer == timers_.end()) continue;

      const auto now = Clock::now();
      if (scheduled.due > now && !ioPollers_.empty()) {
        scheduledTimers_.push(scheduled);
        std::this_thread::sleep_for(std::min(
            std::chrono::milliseconds(1),
            std::chrono::duration_cast<std::chrono::milliseconds>(scheduled.due - now)));
        return true;
      }
      if (scheduled.due > now) std::this_thread::sleep_until(scheduled.due);

      TimerCallback callback = timer->second.callback;
      const bool repeating = timer->second.repeating;
      if (!repeating) timers_.erase(timer);
      callback();

      timer = timers_.find(scheduled.id);
      if (repeating && timer != timers_.end()) {
        scheduledTimers_.push({deadline(timer->second.delay), scheduled.id});
      }
      return true;
    }
    if (!ioPollers_.empty()) {
      std::this_thread::sleep_for(std::chrono::milliseconds(1));
      return true;
    }
    return false;
  }

  inline static std::shared_ptr<OilpanPlatform> platform_;
  inline static std::unique_ptr<cppgc::Heap> heap_;
  inline static std::u16string sourceFile_;
  inline static std::size_t sourceLine_ = 0;
  inline static std::size_t sourceColumn_ = 0;
  inline static std::size_t statementsUntilCollection_ = 0;
  inline static TimerId nextTimerId_ = 1;
  inline static std::deque<TimerCallback> microtasks_;
  inline static std::vector<IoPoller> ioPollers_;
  inline static std::vector<cppgc::Persistent<StringObject>> literalStrings_;
  inline static std::unordered_map<TimerId, TimerState> timers_;
  inline static std::priority_queue<ScheduledTimer, std::vector<ScheduledTimer>, EarlierTimer> scheduledTimers_;
};

inline Value::Value(std::u16string value)
    : storage_(cppgc::Persistent<BaseObject>(Runtime::string(std::move(value)).object())) {}

template <typename T, typename... Arguments>
inline T* makeManaged(Arguments&&... arguments) {
  return Runtime::make<T>(std::forward<Arguments>(arguments)...);
}

inline std::u16string DurationFormatObject::format(RecordObject* duration) const {
  struct Unit {
    const char16_t* key;
    const char16_t* longEnglish;
    const char16_t* shortEnglish;
    const char16_t* narrowEnglish;
    const char16_t* longSpanish;
    double value;
  };
  const auto value = [duration](const char16_t* key) {
    if (!duration || !duration->has(key)) return 0.0;
    return Number(duration->get(key));
  };
  std::vector<Unit> units = {
    {u"years", u"year", u"yr", u"y", u"año", value(u"years")},
    {u"months", u"month", u"mo", u"mo", u"mes", value(u"months")},
    {u"weeks", u"week", u"wk", u"w", u"semana", value(u"weeks")},
    {u"days", u"day", u"day", u"d", u"día", value(u"days")},
    {u"hours", u"hour", u"hr", u"h", u"hora", value(u"hours")},
    {u"minutes", u"minute", u"min", u"m", u"minuto", value(u"minutes")},
    {u"seconds", u"second", u"sec", u"s", u"segundo", value(u"seconds")},
    {u"milliseconds", u"millisecond", u"ms", u"ms", u"milisegundo", value(u"milliseconds")},
    {u"microseconds", u"microsecond", u"μs", u"μs", u"microsegundo", value(u"microseconds")},
    {u"nanoseconds", u"nanosecond", u"ns", u"ns", u"nanosegundo", value(u"nanoseconds")},
  };
  if (style_ == u"digital") {
    const auto pad = [](double number) {
      auto text = formatIntegerText(static_cast<std::int64_t>(std::trunc(number)));
      if (text.size() == 1) text.insert(text.begin(), u'0');
      return text;
    };
    const auto hours = value(u"hours") + value(u"days") * 24;
    std::u16string result = pad(hours) + u":" + pad(value(u"minutes")) + u":" + pad(value(u"seconds"));
    if (fractional_digits_ > 0) {
      const auto fraction = value(u"milliseconds") / 1000.0 + value(u"microseconds") / 1000000.0 + value(u"nanoseconds") / 1000000000.0;
      if (fraction > 0) {
        auto fractionText = formatNumberText(fraction).substr(2);
        if (fractionText.size() > static_cast<std::size_t>(fractional_digits_)) fractionText.resize(fractional_digits_);
        while (fractionText.size() < static_cast<std::size_t>(fractional_digits_)) fractionText.push_back(u'0');
        result += u"." + fractionText;
      }
    }
    return result;
  }
  std::vector<std::u16string> pieces;
  for (const auto& unit : units) {
    if (unit.value == 0) continue;
    auto number = formatNumberText(unit.value);
    std::u16string label;
    if (spanish()) {
      label = unit.longSpanish;
      if (std::abs(unit.value) != 1) {
        if (label == u"mes") label = u"meses";
        else if (label == u"luz") label = u"luces";
        else label += u"s";
      }
    } else if (style_ == u"long") {
      label = unit.longEnglish;
      if (std::abs(unit.value) != 1) label += u"s";
    } else if (style_ == u"narrow") {
      label = unit.narrowEnglish;
    } else {
      label = unit.shortEnglish;
    }
    pieces.push_back(number + u" " + label);
  }
  if (pieces.empty()) return style_ == u"long" ? u"0 seconds" : u"0 sec";
  std::u16string result;
  for (std::size_t index = 0; index < pieces.size(); ++index) {
    if (index > 0) result += u", ";
    result += pieces[index];
  }
  return result;
}

inline ArrayObject<RecordObject*>* DurationFormatObject::formatToParts(RecordObject* duration) const {
  auto* result = Runtime::array<RecordObject*>();
  if (!duration) return result;
  const std::pair<const char16_t*, const char16_t*> units[] = {
    {u"years", u"year"}, {u"months", u"month"}, {u"weeks", u"week"}, {u"days", u"day"},
    {u"hours", u"hour"}, {u"minutes", u"minute"}, {u"seconds", u"second"},
    {u"milliseconds", u"millisecond"}, {u"microseconds", u"microsecond"}, {u"nanoseconds", u"nanosecond"},
  };
  for (const auto& [key, unit] : units) {
    if (!duration->has(key)) continue;
    const auto number = Number(duration->get(key));
    if (number == 0) continue;
    const auto valueText = formatNumberText(number);
    result->append(Runtime::record({
      {u"type", Runtime::string(valueText.find(u'.') == std::u16string::npos ? u"integer" : u"decimal")},
      {u"value", Runtime::string(valueText)},
      {u"unit", Runtime::string(unit)},
    }));
  }
  return result;
}

inline RecordObject* DurationFormatObject::resolvedOptions() const {
  return Runtime::record({
    {u"locale", Runtime::string(locale_)},
    {u"numberingSystem", Runtime::string(numbering_system_)},
    {u"style", Runtime::string(style_)},
    {u"years", Runtime::string(u"long")},
    {u"months", Runtime::string(u"long")},
    {u"weeks", Runtime::string(u"long")},
    {u"days", Runtime::string(u"long")},
    {u"hours", Runtime::string(style_ == u"digital" ? u"numeric" : u"short")},
    {u"minutes", Runtime::string(style_ == u"digital" ? u"numeric" : u"short")},
    {u"seconds", Runtime::string(style_ == u"digital" ? u"numeric" : u"short")},
    {u"milliseconds", Runtime::string(u"numeric")},
    {u"microseconds", Runtime::string(u"numeric")},
    {u"nanoseconds", Runtime::string(u"numeric")},
  });
}

inline std::u16string durationFormatLocale(const Value& value) {
  if (value.isString()) return value.utf16();
  if (value.isObject() && value.object()->dynamicIsArray()) {
    for (const auto item : dynamicIterationRange(value)) {
      if (item.isString()) return item.utf16();
    }
  }
  return u"en";
}

inline RecordObject* durationFormatOptions(const Value& value) {
  return value.isRecord() ? value.record() : nullptr;
}

inline RecordObject* durationFormatDuration(const Value& value) {
  return value.isRecord() ? value.record() : nullptr;
}

inline ArrayObject<std::u16string>* durationFormatSupportedLocales(const Value& value) {
  auto* result = Runtime::array<std::u16string>();
  if (value.isString()) {
    result->append(value.utf16());
  } else if (value.isObject() && value.object()->dynamicIsArray()) {
    for (const auto item : dynamicIterationRange(value)) {
      if (item.isString()) result->append(item.utf16());
    }
  }
  return result;
}

inline void ArrayBufferObject::resize(double byteLength) {
  resizeBytes(static_cast<std::size_t>(std::max(0.0, std::trunc(byteLength))));
}

inline void ArrayBufferObject::grow(double targetByteLength) {
  growBytes(static_cast<std::size_t>(std::max(0.0, std::trunc(targetByteLength))));
}

inline ArrayBufferObject* ArrayBufferObject::transfer(double newByteLength) {
  return arrayBufferTransfer(this, newByteLength, false);
}

inline ArrayBufferObject* ArrayBufferObject::transferToFixedLength(double newByteLength) {
  return arrayBufferTransfer(this, newByteLength, true);
}

inline ArrayBufferObject* ArrayBufferObject::transferBytes(
    std::size_t byteLength,
    bool fixedLength) {
  const std::size_t targetLength = byteLength == std::numeric_limits<std::size_t>::max()
    ? this->byteLength()
    : byteLength;
  if (targetLength > max_byte_length_) throw runtimeError(u"ArrayBuffer transfer exceeds maxByteLength");
  auto* result = Runtime::make<ArrayBufferObject>(
      targetLength,
      fixedLength ? targetLength : max_byte_length_);
  const std::size_t copied = std::min(targetLength, this->byteLength());
  std::copy_n(bytes_->begin(), copied, result->bytes_->begin());
  bytes_->clear();
  detached_ = true;
  return result;
}

inline std::size_t float16SliceIndex(double raw, std::size_t size) {
  if (std::isnan(raw)) return 0;
  const auto integer = static_cast<std::int64_t>(std::trunc(raw));
  if (integer < 0) return static_cast<std::size_t>(std::max<std::int64_t>(0, static_cast<std::int64_t>(size) + integer));
  return std::min<std::size_t>(static_cast<std::size_t>(integer), size);
}

template <typename T>
inline bool float16CallbackBoolean(const T& value) {
  if constexpr (std::is_same_v<std::remove_cvref_t<T>, Value>) return toBoolean(value);
  else if constexpr (std::is_same_v<std::remove_cvref_t<T>, std::u16string>) return !value.empty();
  else if constexpr (std::is_pointer_v<std::remove_cvref_t<T>>) return value != nullptr;
  else return static_cast<bool>(value);
}

template <typename Callback>
inline decltype(auto) invokeFloat16Callback(Callback& callback, double value, std::size_t index, const Float16ArrayObject* array) {
  auto* mutableArray = const_cast<Float16ArrayObject*>(array);
  if constexpr (std::is_invocable_v<Callback, double, double, Float16ArrayObject*>) return callback(value, static_cast<double>(index), mutableArray);
  else if constexpr (std::is_invocable_v<Callback, double, double>) return callback(value, static_cast<double>(index));
  else return callback(value);
}

template <typename Callback>
inline decltype(auto) invokeFloat16ReduceCallback(Callback& callback, double accumulator, double value, std::size_t index) {
  if constexpr (std::is_invocable_v<Callback, double, double, double>) return callback(accumulator, value, static_cast<double>(index));
  else return callback(accumulator, value);
}

inline Float16ArrayObject* Float16ArrayObject::copyWithin(double target, double start, double end) {
  const auto targetIndex = float16SliceIndex(target, length_);
  const auto startIndex = float16SliceIndex(start, length_);
  const auto endIndex = std::isinf(end) ? length_ : float16SliceIndex(end, length_);
  if (startIndex >= endIndex || targetIndex >= length_) return this;
  const auto count = std::min(endIndex - startIndex, length_ - targetIndex);
  std::vector<double> copied;
  copied.reserve(count);
  for (std::size_t index = 0; index < count; ++index) copied.push_back(get(startIndex + index));
  for (std::size_t index = 0; index < copied.size(); ++index) set(targetIndex + index, copied[index]);
  return this;
}

template <typename Callback>
inline bool Float16ArrayObject::every(Callback callback) const {
  for (std::size_t index = 0; index < length_; ++index) if (!float16CallbackBoolean(invokeFloat16Callback(callback, get(index), index, this))) return false;
  return true;
}

inline Float16ArrayObject* Float16ArrayObject::fill(double value, double start, double end) {
  const auto first = float16SliceIndex(start, length_);
  const auto last = std::isinf(end) ? length_ : float16SliceIndex(end, length_);
  for (std::size_t index = first; index < last; ++index) set(index, value);
  return this;
}

template <typename Callback>
inline Float16ArrayObject* Float16ArrayObject::filter(Callback callback) const {
  std::vector<double> values;
  for (std::size_t index = 0; index < length_; ++index) {
    const auto value = get(index);
    if (float16CallbackBoolean(invokeFloat16Callback(callback, value, index, this))) values.push_back(value);
  }
  auto* result = Runtime::make<Float16ArrayObject>(Runtime::make<ArrayBufferObject>(values.size() * sizeof(std::uint16_t)), 0, values.size());
  for (std::size_t index = 0; index < values.size(); ++index) result->set(index, values[index]);
  return result;
}

template <typename Callback>
inline Value Float16ArrayObject::find(Callback callback) const {
  for (std::size_t index = 0; index < length_; ++index) {
    const auto value = get(index);
    if (float16CallbackBoolean(invokeFloat16Callback(callback, value, index, this))) return Value(value);
  }
  return Value::undefined();
}

template <typename Callback>
inline double Float16ArrayObject::findIndex(Callback callback) const {
  for (std::size_t index = 0; index < length_; ++index) if (float16CallbackBoolean(invokeFloat16Callback(callback, get(index), index, this))) return static_cast<double>(index);
  return -1;
}

template <typename Callback>
inline Value Float16ArrayObject::findLast(Callback callback) const {
  for (std::size_t index = length_; index > 0; --index) {
    const auto current = index - 1;
    const auto value = get(current);
    if (float16CallbackBoolean(invokeFloat16Callback(callback, value, current, this))) return Value(value);
  }
  return Value::undefined();
}

template <typename Callback>
inline double Float16ArrayObject::findLastIndex(Callback callback) const {
  for (std::size_t index = length_; index > 0; --index) {
    const auto current = index - 1;
    if (float16CallbackBoolean(invokeFloat16Callback(callback, get(current), current, this))) return static_cast<double>(current);
  }
  return -1;
}

template <typename Callback>
inline void Float16ArrayObject::forEach(Callback callback) const {
  for (std::size_t index = 0; index < length_; ++index) invokeFloat16Callback(callback, get(index), index, this);
}

inline bool Float16ArrayObject::includes(double value, double fromIndex) const {
  auto first = static_cast<std::int64_t>(std::trunc(fromIndex));
  if (first < 0) first += static_cast<std::int64_t>(length_);
  for (auto index = std::max<std::int64_t>(0, first); index < static_cast<std::int64_t>(length_); ++index) if (get(static_cast<std::size_t>(index)) == value) return true;
  return false;
}

inline double Float16ArrayObject::indexOf(double value, double fromIndex) const {
  const auto first = std::max<std::int64_t>(0, static_cast<std::int64_t>(std::trunc(fromIndex)));
  for (auto index = first; index < static_cast<std::int64_t>(length_); ++index) if (get(static_cast<std::size_t>(index)) == value) return static_cast<double>(index);
  return -1;
}

inline double Float16ArrayObject::lastIndexOf(double value, double fromIndex) const {
  if (length_ == 0) return -1;
  auto first = std::isinf(fromIndex) ? static_cast<std::int64_t>(length_) - 1 : static_cast<std::int64_t>(std::trunc(fromIndex));
  if (first < 0) first += static_cast<std::int64_t>(length_);
  first = std::min<std::int64_t>(first, static_cast<std::int64_t>(length_) - 1);
  for (auto index = first; index >= 0; --index) if (get(static_cast<std::size_t>(index)) == value) return static_cast<double>(index);
  return -1;
}

template <typename Callback>
inline Float16ArrayObject* Float16ArrayObject::map(Callback callback) const {
  auto* result = Runtime::make<Float16ArrayObject>(Runtime::make<ArrayBufferObject>(byteLength()), 0, length_);
  for (std::size_t index = 0; index < length_; ++index) result->set(index, convertValue<double>(invokeFloat16Callback(callback, get(index), index, this)));
  return result;
}

template <typename Callback>
inline double Float16ArrayObject::reduce(Callback callback) const {
  if (length_ == 0) throw runtimeError(u"Reduce of empty Float16Array with no initial value");
  double result = get(0);
  for (std::size_t index = 1; index < length_; ++index) result = convertValue<double>(invokeFloat16ReduceCallback(callback, result, get(index), index));
  return result;
}

template <typename Callback>
inline double Float16ArrayObject::reduce(Callback callback, double initial) const {
  double result = initial;
  for (std::size_t index = 0; index < length_; ++index) result = convertValue<double>(invokeFloat16ReduceCallback(callback, result, get(index), index));
  return result;
}

template <typename Callback>
inline double Float16ArrayObject::reduceRight(Callback callback) const {
  if (length_ == 0) throw runtimeError(u"Reduce of empty Float16Array with no initial value");
  double result = get(length_ - 1);
  for (std::size_t index = length_ - 1; index > 0; --index) result = convertValue<double>(invokeFloat16ReduceCallback(callback, result, get(index - 1), index - 1));
  return result;
}

template <typename Callback>
inline double Float16ArrayObject::reduceRight(Callback callback, double initial) const {
  double result = initial;
  for (std::size_t index = length_; index > 0; --index) result = convertValue<double>(invokeFloat16ReduceCallback(callback, result, get(index - 1), index - 1));
  return result;
}

inline Float16ArrayObject* Float16ArrayObject::reverse() {
  for (std::size_t index = 0; index < length_ / 2; ++index) {
    const auto other = length_ - index - 1;
    const auto value = get(index);
    set(index, get(other));
    set(other, value);
  }
  return this;
}

template <typename T>
inline void Float16ArrayObject::set(const ArrayObject<T>* values, double offset) {
  if (!values) return;
  const auto start = static_cast<std::size_t>(std::max(0.0, std::trunc(offset)));
  if (start + values->size() > length_) throw std::out_of_range("Float16Array.set source is out of range");
  for (std::size_t index = 0; index < values->size(); ++index) set(start + index, convertValue<double>(values->get(index)));
}

inline void Float16ArrayObject::set(const Float16ArrayObject* values, double offset) {
  if (!values) return;
  const auto start = static_cast<std::size_t>(std::max(0.0, std::trunc(offset)));
  if (start + values->length() > length_) throw std::out_of_range("Float16Array.set source is out of range");
  for (std::size_t index = 0; index < values->length(); ++index) set(start + index, values->get(index));
}

inline Float16ArrayObject* Float16ArrayObject::slice(double start, double end) const {
  const auto first = float16SliceIndex(start, length_);
  const auto last = std::isinf(end) ? length_ : float16SliceIndex(end, length_);
  const auto count = last > first ? last - first : 0;
  auto* result = Runtime::make<Float16ArrayObject>(Runtime::make<ArrayBufferObject>(count * sizeof(std::uint16_t)), 0, count);
  for (std::size_t index = 0; index < count; ++index) result->set(index, get(first + index));
  return result;
}

template <typename Callback>
inline bool Float16ArrayObject::some(Callback callback) const {
  for (std::size_t index = 0; index < length_; ++index) if (float16CallbackBoolean(invokeFloat16Callback(callback, get(index), index, this))) return true;
  return false;
}

inline Float16ArrayObject* Float16ArrayObject::sort() {
  std::vector<double> values;
  for (std::size_t index = 0; index < length_; ++index) values.push_back(get(index));
  std::stable_sort(values.begin(), values.end());
  for (std::size_t index = 0; index < length_; ++index) set(index, values[index]);
  return this;
}

template <typename Callback>
inline Float16ArrayObject* Float16ArrayObject::sort(Callback callback) {
  std::vector<double> values;
  for (std::size_t index = 0; index < length_; ++index) values.push_back(get(index));
  std::stable_sort(values.begin(), values.end(), [&](double left, double right) { return convertValue<double>(callback(left, right)) < 0; });
  for (std::size_t index = 0; index < length_; ++index) set(index, values[index]);
  return this;
}

inline Float16ArrayObject* Float16ArrayObject::subarray(double begin, double end) const {
  const auto first = float16SliceIndex(begin, length_);
  const auto last = std::isinf(end) ? length_ : float16SliceIndex(end, length_);
  return Runtime::make<Float16ArrayObject>(buffer(), byte_offset_ + first * sizeof(std::uint16_t), last > first ? last - first : 0);
}

inline NativeIteratorObject<double>* Float16ArrayObject::values() const {
  std::vector<double> result;
  for (std::size_t index = 0; index < length_; ++index) result.push_back(get(index));
  return Runtime::make<NativeIteratorObject<double>>(std::move(result));
}

inline NativeIteratorObject<double>* Float16ArrayObject::keys() const {
  std::vector<double> result;
  for (std::size_t index = 0; index < length_; ++index) result.push_back(static_cast<double>(index));
  return Runtime::make<NativeIteratorObject<double>>(std::move(result));
}

inline NativeIteratorObject<ArrayObject<double>*>* Float16ArrayObject::entries() const {
  std::vector<ArrayObject<double>*> result;
  for (std::size_t index = 0; index < length_; ++index) result.push_back(Runtime::array<double>({static_cast<double>(index), get(index)}));
  return Runtime::make<NativeIteratorObject<ArrayObject<double>*>>(std::move(result));
}

inline std::u16string Float16ArrayObject::join(const std::u16string& separator) const {
  std::u16string result;
  for (std::size_t index = 0; index < length_; ++index) {
    if (index > 0) result += separator;
    result += formatNumberText(get(index));
  }
  return result;
}

inline std::u16string Float16ArrayObject::toString() const { return join(); }
inline std::u16string Float16ArrayObject::toLocaleString() const { return join(); }
inline std::u16string toString(Float16ArrayObject* array) {
  return array ? array->toString() : u"null";
}

inline Float16ArrayObject* Float16ArrayObject::copy() const {
  auto* result = Runtime::make<Float16ArrayObject>(Runtime::make<ArrayBufferObject>(byteLength()), 0, length_);
  for (std::size_t index = 0; index < length_; ++index) result->set(index, get(index));
  return result;
}

inline Float16ArrayObject* Float16ArrayObject::toReversed() const {
  auto* result = Runtime::make<Float16ArrayObject>(Runtime::make<ArrayBufferObject>(byteLength()), 0, length_);
  for (std::size_t index = 0; index < length_; ++index) result->set(length_ - index - 1, get(index));
  return result;
}

inline Float16ArrayObject* Float16ArrayObject::toSorted() const {
  auto* result = copy();
  std::vector<double> values;
  values.reserve(length_);
  for (std::size_t index = 0; index < length_; ++index) values.push_back(get(index));
  std::stable_sort(values.begin(), values.end());
  for (std::size_t index = 0; index < values.size(); ++index) result->set(index, values[index]);
  return result;
}

template <typename Callback>
inline Float16ArrayObject* Float16ArrayObject::toSorted(Callback callback) const {
  auto* result = copy();
  std::vector<double> values;
  values.reserve(length_);
  for (std::size_t index = 0; index < length_; ++index) values.push_back(get(index));
  std::stable_sort(values.begin(), values.end(), [&](double left, double right) {
    return convertValue<double>(callback(left, right)) < 0;
  });
  for (std::size_t index = 0; index < values.size(); ++index) result->set(index, values[index]);
  return result;
}

inline Float16ArrayObject* Float16ArrayObject::with(double index, double value) const {
  const auto integer = static_cast<std::int64_t>(std::trunc(index));
  const auto resolved = integer < 0 ? static_cast<std::int64_t>(length_) + integer : integer;
  if (resolved < 0 || resolved >= static_cast<std::int64_t>(length_)) {
    throw runtimeError(u"Float16Array.prototype.with index is out of range");
  }
  auto* result = copy();
  result->set(static_cast<std::size_t>(resolved), value);
  return result;
}

template <typename Signature>
struct CallableFirstArgument;

template <typename Result, typename Owner, typename First, typename... Arguments>
struct CallableFirstArgument<Result (Owner::*)(First, Arguments...) const> {
  using type = First;
};

template <typename Result, typename Owner, typename First, typename... Arguments>
struct CallableFirstArgument<Result (Owner::*)(First, Arguments...)> {
  using type = First;
};

template <typename Callable, typename = void>
struct CallableFirstArgumentForObject {};

template <typename Callable>
struct CallableFirstArgumentForObject<
    Callable,
    std::void_t<decltype(&Callable::operator())>>
    : CallableFirstArgument<decltype(&Callable::operator())> {};

template <typename Result, typename First, typename... Arguments>
struct CallableFirstArgumentForObject<std::function<Result(First, Arguments...)>> {
  using type = First;
};

template <typename Callback, typename T>
inline decltype(auto) invokeNativeIteratorCallback(Callback& callback, T value, std::size_t index) {
  if constexpr (std::is_invocable_v<Callback, T, double>) {
    return callback(std::move(value), static_cast<double>(index));
  } else if constexpr (std::is_invocable_v<Callback, T>) {
    return callback(std::move(value));
  } else if constexpr (requires { typename CallableFirstArgumentForObject<Callback>::type; }) {
    using First = typename CallableFirstArgumentForObject<Callback>::type;
    using Converted = std::remove_cvref_t<First>;
    auto converted = convertValue<Converted>(std::move(value));
    if constexpr (requires { callback(converted, static_cast<double>(index)); }) {
      return callback(std::move(converted), static_cast<double>(index));
    } else {
      return callback(std::move(converted));
    }
  } else {
    return callback(std::move(value));
  }
}

template <typename T>
inline NativeIteratorObject<T>* iteratorFrom(const ArrayObject<T>* values) {
  std::vector<T> result;
  if (values) {
    result.reserve(values->size());
    for (const auto& value : *values) result.push_back(value);
  }
  return Runtime::make<NativeIteratorObject<T>>(std::move(result));
}

inline NativeIteratorObject<Value>* iteratorFrom(const Value& value) {
  std::vector<Value> result;
  for (const auto item : dynamicIterationRange(value)) result.push_back(item);
  return Runtime::make<NativeIteratorObject<Value>>(std::move(result));
}

template <typename T>
inline ArrayObject<T>* iteratorToArray(NativeIteratorObject<T>* iterator) {
  auto* result = Runtime::array<T>();
  if (!iterator) return result;
  for (auto& value : iterator->takeRemaining()) result->append(std::move(value));
  return result;
}

template <typename T>
inline ArrayObject<T>* NativeIteratorObject<T>::toArray() {
  auto* result = Runtime::array<T>();
  for (auto& value : takeRemaining()) result->append(std::move(value));
  return result;
}

template <typename K, typename V>
inline NativeIteratorObject<K>* MapObject<K, V>::keys() const {
  std::vector<K> result;
  result.reserve(size());
  forEach([&](V, K key) { result.push_back(std::move(key)); });
  return Runtime::make<NativeIteratorObject<K>>(std::move(result));
}

template <typename K, typename V>
inline NativeIteratorObject<V>* MapObject<K, V>::values() const {
  std::vector<V> result;
  result.reserve(size());
  forEach([&](V value) { result.push_back(std::move(value)); });
  return Runtime::make<NativeIteratorObject<V>>(std::move(result));
}

template <typename K, typename V>
inline NativeIteratorObject<ArrayObject<Value>*>* MapObject<K, V>::entries() const {
  std::vector<ArrayObject<Value>*> result;
  result.reserve(size());
  forEach([&](V value, K key) {
    result.push_back(Runtime::array<Value>({convertValue<Value>(key), convertValue<Value>(value)}));
  });
  return Runtime::make<NativeIteratorObject<ArrayObject<Value>*>>(std::move(result));
}

template <typename T>
inline NativeIteratorObject<T>* SetObject<T>::keys() const {
  std::vector<T> result;
  result.reserve(size());
  forEach([&](T value) { result.push_back(std::move(value)); });
  return Runtime::make<NativeIteratorObject<T>>(std::move(result));
}

template <typename T>
inline NativeIteratorObject<T>* SetObject<T>::values() const {
  return keys();
}

template <typename T>
inline NativeIteratorObject<ArrayObject<Value>*>* SetObject<T>::entries() const {
  std::vector<ArrayObject<Value>*> result;
  result.reserve(size());
  forEach([&](T value) {
    const auto converted = convertValue<Value>(value);
    result.push_back(Runtime::array<Value>({converted, converted}));
  });
  return Runtime::make<NativeIteratorObject<ArrayObject<Value>*>>(std::move(result));
}

template <typename Result, typename Input>
inline ArrayObject<Result>* iteratorToArrayConverted(NativeIteratorObject<Input>* iterator) {
  auto* result = Runtime::array<Result>();
  if (!iterator) return result;
  for (auto& value : iterator->takeRemaining()) result->append(convertValue<Result>(std::move(value)));
  return result;
}

template <typename T, typename Callback>
inline auto iteratorMap(NativeIteratorObject<T>* iterator, Callback callback) {
  using Result = std::remove_cvref_t<decltype(
      invokeNativeIteratorCallback(callback, std::declval<T>(), std::size_t{}))>;
  std::vector<Result> result;
  if (iterator) {
    const auto values = iterator->takeRemaining();
    result.reserve(values.size());
    for (std::size_t index = 0; index < values.size(); ++index) {
      result.push_back(invokeNativeIteratorCallback(callback, values[index], index));
    }
  }
  return Runtime::make<NativeIteratorObject<Result>>(std::move(result));
}

template <typename T, typename Callback>
inline NativeIteratorObject<T>* iteratorFilter(NativeIteratorObject<T>* iterator, Callback callback) {
  std::vector<T> result;
  if (iterator) {
    const auto values = iterator->takeRemaining();
    for (std::size_t index = 0; index < values.size(); ++index) {
      if (toBoolean(invokeNativeIteratorCallback(callback, values[index], index))) {
        result.push_back(values[index]);
      }
    }
  }
  return Runtime::make<NativeIteratorObject<T>>(std::move(result));
}

template <typename T>
inline NativeIteratorObject<T>* iteratorTake(NativeIteratorObject<T>* iterator, double limit) {
  std::vector<T> result;
  if (iterator) {
    const auto values = iterator->takeRemaining();
    const auto count = static_cast<std::size_t>(std::max(0.0, std::trunc(limit)));
    result.insert(result.end(), values.begin(), values.begin() + static_cast<std::ptrdiff_t>(std::min(count, values.size())));
  }
  return Runtime::make<NativeIteratorObject<T>>(std::move(result));
}

template <typename T>
inline NativeIteratorObject<T>* iteratorDrop(NativeIteratorObject<T>* iterator, double count) {
  std::vector<T> result;
  if (iterator) {
    const auto values = iterator->takeRemaining();
    const auto offset = static_cast<std::size_t>(std::max(0.0, std::trunc(count)));
    if (offset < values.size()) result.insert(result.end(), values.begin() + static_cast<std::ptrdiff_t>(offset), values.end());
  }
  return Runtime::make<NativeIteratorObject<T>>(std::move(result));
}

template <typename T, typename Callback, typename Accumulator>
inline Accumulator iteratorReduce(
    NativeIteratorObject<T>* iterator,
    Callback callback,
    Accumulator accumulator) {
  if (!iterator) return accumulator;
  std::size_t index = 0;
  for (const auto& value : iterator->takeRemaining()) {
    accumulator = callback(accumulator, value, static_cast<double>(index++));
  }
  return accumulator;
}

template <typename T, typename Callback>
inline T iteratorReduce(NativeIteratorObject<T>* iterator, Callback callback) {
  if (!iterator) throw runtimeError(u"Iterator.reduce called on an empty iterator");
  const auto values = iterator->takeRemaining();
  if (values.empty()) throw runtimeError(u"Iterator.reduce called on an empty iterator");
  T accumulator = values.front();
  for (std::size_t index = 1; index < values.size(); ++index) {
    accumulator = callback(accumulator, values[index], static_cast<double>(index));
  }
  return accumulator;
}

template <typename Result>
struct NativeIteratorElement;

template <typename T>
struct NativeIteratorElement<NativeIteratorObject<T>*> { using type = T; };

template <typename T>
struct NativeIteratorElement<ArrayObject<T>*> { using type = T; };

template <>
struct NativeIteratorElement<Value> { using type = Value; };

template <typename T>
inline void appendNativeIteratorResult(std::vector<T>& target, NativeIteratorObject<T>* result) {
  if (!result) return;
  const auto values = result->takeRemaining();
  target.insert(target.end(), values.begin(), values.end());
}

template <typename T>
inline void appendNativeIteratorResult(std::vector<T>& target, ArrayObject<T>* result) {
  if (!result) return;
  for (const auto& value : *result) target.push_back(value);
}

inline void appendNativeIteratorResult(std::vector<Value>& target, const Value& result) {
  for (const auto& value : dynamicIterationRange(result)) target.push_back(value);
}

template <typename T, typename Callback>
inline auto iteratorFlatMap(NativeIteratorObject<T>* iterator, Callback callback) {
  using CallbackResult = std::remove_cvref_t<decltype(
      invokeNativeIteratorCallback(callback, std::declval<T>(), std::size_t{}))>;
  using Result = typename NativeIteratorElement<CallbackResult>::type;
  std::vector<Result> result;
  if (iterator) {
    const auto values = iterator->takeRemaining();
    for (std::size_t index = 0; index < values.size(); ++index) {
      appendNativeIteratorResult(result, invokeNativeIteratorCallback(callback, values[index], index));
    }
  }
  return Runtime::make<NativeIteratorObject<Result>>(std::move(result));
}

template <typename T, typename Callback>
inline void iteratorForEach(NativeIteratorObject<T>* iterator, Callback callback) {
  if (!iterator) return;
  std::size_t index = 0;
  for (const auto& value : iterator->takeRemaining()) {
    invokeNativeIteratorCallback(callback, value, index++);
  }
}

template <typename T, typename Callback>
inline bool iteratorSome(NativeIteratorObject<T>* iterator, Callback callback) {
  if (!iterator) return false;
  std::size_t index = 0;
  for (const auto& value : iterator->takeRemaining()) {
    if (toBoolean(invokeNativeIteratorCallback(callback, value, index++))) return true;
  }
  return false;
}

template <typename T, typename Callback>
inline bool iteratorEvery(NativeIteratorObject<T>* iterator, Callback callback) {
  if (!iterator) return true;
  std::size_t index = 0;
  for (const auto& value : iterator->takeRemaining()) {
    if (!toBoolean(invokeNativeIteratorCallback(callback, value, index++))) return false;
  }
  return true;
}

template <typename T, typename Callback>
inline T iteratorFind(NativeIteratorObject<T>* iterator, Callback callback) {
  if (!iterator) return T{};
  std::size_t index = 0;
  for (const auto& value : iterator->takeRemaining()) {
    if (toBoolean(invokeNativeIteratorCallback(callback, value, index++))) return value;
  }
  return T{};
}

template <typename T>
template <typename Callback>
inline auto NativeIteratorObject<T>::map(Callback callback) {
  return iteratorMap(this, std::move(callback));
}

template <typename T>
template <typename Callback>
inline NativeIteratorObject<T>* NativeIteratorObject<T>::filter(Callback callback) {
  return iteratorFilter(this, std::move(callback));
}

template <typename T>
inline NativeIteratorObject<T>* NativeIteratorObject<T>::take(double limit) {
  return iteratorTake(this, limit);
}

template <typename T>
inline NativeIteratorObject<T>* NativeIteratorObject<T>::drop(double count) {
  return iteratorDrop(this, count);
}

template <typename T>
template <typename Callback, typename Accumulator>
inline Accumulator NativeIteratorObject<T>::reduce(Callback callback, Accumulator accumulator) {
  return iteratorReduce(this, std::move(callback), std::move(accumulator));
}

template <typename T>
template <typename Callback>
inline T NativeIteratorObject<T>::reduce(Callback callback) {
  return iteratorReduce(this, std::move(callback));
}

template <typename T>
template <typename Callback>
inline auto NativeIteratorObject<T>::flatMap(Callback callback) {
  return iteratorFlatMap(this, std::move(callback));
}

template <typename T>
template <typename Callback>
inline void NativeIteratorObject<T>::forEach(Callback callback) {
  iteratorForEach(this, std::move(callback));
}

template <typename T>
template <typename Callback>
inline bool NativeIteratorObject<T>::some(Callback callback) {
  return iteratorSome(this, std::move(callback));
}

template <typename T>
template <typename Callback>
inline bool NativeIteratorObject<T>::every(Callback callback) {
  return iteratorEvery(this, std::move(callback));
}

template <typename T>
template <typename Callback>
inline T NativeIteratorObject<T>::find(Callback callback) {
  return iteratorFind(this, std::move(callback));
}

template <typename T>
inline ArrayObject<T>* makeArray(std::initializer_list<T> values = {}) {
  return Runtime::array<T>(values);
}

inline RecordObject* makeRecord(
    std::initializer_list<std::pair<std::u16string, Value>> properties = {}) {
  return Runtime::record(properties);
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

inline ArrayObject<Value>* regexExec(const RegExp& expression, const std::u16string& value) {
  const auto captures = expression.exec(value);
  if (!captures) return nullptr;
  auto* result = Runtime::array<Value>();
  for (const auto& capture : *captures) result->append(Runtime::string(capture));
  return result;
}

inline ArrayObject<Value>* regexExec(const RegExp& expression, const Value& value) {
  return regexExec(expression, value.isString() ? value.string() : std::u16string());
}

inline ArrayObject<Value>* exec(const RegExp& expression, const std::u16string& value) {
  return regexExec(expression, value);
}

inline ArrayObject<Value>* exec(const RegExp& expression, const Value& value) {
  return regexExec(expression, value);
}

template <typename T>
concept RecordAdaptable = requires(RecordObject* record) {
  { T::fromRecord(record) } -> std::convertible_to<T*>;
};

template <typename T>
concept DynamicObjectView = requires(BaseObject* object) {
  { T::fromDynamicObject(object) } -> std::convertible_to<T*>;
};

inline const std::u16string& toText(const std::u16string& value) { return value; }
inline std::u16string toText(std::u16string&& value) { return std::move(value); }
inline std::u16string toText(const Value& value) {
  if (value.isString()) return value.utf16();
  throw errorAtCurrentSource(u"VexaScript value is not a string");
}

inline bool toBoolean(bool value) { return value; }
inline bool toBoolean(Undefined) { return false; }
inline bool toBoolean(double value) { return value != 0 && !std::isnan(value); }
inline bool toBoolean(std::int32_t value) { return value != 0; }
inline bool toBoolean(const Value& value) {
  if (value.isBoolean()) return value.boolean();
  if (value.isNumber()) return toBoolean(value.number());
  if (value.isBigInt()) return !value.bigint().isZero();
  return !value.isUndefined() && !value.isNull();
}

inline double toDouble(double value) { return value; }
inline double toDouble(std::int32_t value) { return static_cast<double>(value); }
inline double toDouble(bool value) { return static_cast<double>(value); }
inline double toDouble(const Value& value) {
  if (value.isNumber()) return value.number();
  if (value.isBoolean()) return static_cast<double>(value.boolean());
  if (value.isBigInt()) return value.bigint().toDouble();
  throw errorAtCurrentSource(u"VexaScript value is not numeric");
}

inline std::int32_t toNativeInt32(std::int32_t value) { return value; }
inline std::int32_t toNativeInt32(double value) { return static_cast<std::int32_t>(value); }
inline std::int32_t toNativeInt32(bool value) { return static_cast<std::int32_t>(value); }
inline std::int32_t toNativeInt32(const Value& value) { return static_cast<std::int32_t>(toDouble(value)); }

inline BigInt toBigInt(const BigInt& value) { return value; }
inline BigInt toBigInt(BigInt&& value) { return std::move(value); }
inline BigInt toBigInt(const Value& value) {
  if (value.isBigInt()) return value.bigint();
  if (value.isBoolean()) return BigInt(value.boolean() ? 1 : 0);
  if (value.isNumber() && std::isfinite(value.number()) && std::trunc(value.number()) == value.number()) {
    return BigInt(formatFixedText(value.number(), 0));
  }
  if (value.isString()) return BigInt(value.string());
  throw runtimeError(u"VexaScript value cannot be converted to bigint");
}

inline Undefined toUndefined(Undefined value) { return value; }
inline Undefined toUndefined(const Value& value) {
  if (!value.isUndefined()) throw runtimeError(u"VexaScript value is not undefined");
  return {};
}

inline Null toNull(Null value) { return value; }
inline Null toNull(const Value& value) {
  if (!value.isNull()) throw errorAtCurrentSource(u"VexaScript value is not null");
  return {};
}

inline Error toError(Error value) { return value; }

template <typename Function>
struct CallableArity;

template <typename Result, typename Owner>
struct CallableArity<Result (Owner::*)() const> {
  static constexpr std::size_t value = 0;
};

template <typename Result, typename Owner, typename First, typename... Arguments>
struct CallableArity<Result (Owner::*)(First, Arguments...) const> {
  static constexpr std::size_t value = sizeof...(Arguments) + 1;
};

template <typename Result, typename Owner>
struct CallableArity<Result (Owner::*)()> {
  static constexpr std::size_t value = 0;
};

template <typename Result, typename Owner, typename First, typename... Arguments>
struct CallableArity<Result (Owner::*)(First, Arguments...)> {
  static constexpr std::size_t value = sizeof...(Arguments) + 1;
};

template <typename Callable, typename = void>
struct CallableArityForObject {};

template <typename Callable>
struct CallableArityForObject<
    Callable,
    std::void_t<decltype(&Callable::operator())>>
    : CallableArity<decltype(&Callable::operator())> {};

template <typename Result, typename... Arguments>
struct CallableArityForObject<std::function<Result(Arguments...)>> {
  static constexpr std::size_t value = sizeof...(Arguments);
};

template <typename Callable, typename Tuple, std::size_t... Indices>
decltype(auto) invokeFunctionPrefix(
    Callable& callable,
    Tuple&& arguments,
    std::index_sequence<Indices...>) {
  return callable(std::get<Indices>(std::forward<Tuple>(arguments))...);
}

template <typename Result, typename Input, typename TargetResult, typename... Arguments>
Result adaptStdFunction(
    Input&& input,
    std::type_identity<std::function<TargetResult(Arguments...)>>) {
  using Source = std::remove_cvref_t<Input>;
  return Result([
      source = std::forward<Input>(input)](Arguments... arguments) mutable -> TargetResult {
    auto values = std::forward_as_tuple(std::move(arguments)...);
    constexpr std::size_t count = std::min(
        CallableArityForObject<Source>::value,
        sizeof...(Arguments));
    if constexpr (std::is_same_v<TargetResult, void>) {
      invokeFunctionPrefix(source, std::move(values), std::make_index_sequence<count>{});
    } else {
      return convertValue<TargetResult>(invokeFunctionPrefix(
          source,
          std::move(values),
          std::make_index_sequence<count>{}));
    }
  });
}


template <typename Result, typename Input>
  requires IsStdFunction<Result>::value
Result toFunction(Input&& input) {
  using Source = std::remove_cvref_t<Input>;
  if constexpr (std::is_same_v<Result, Source>) {
    return std::forward<Input>(input);
  } else if constexpr (std::is_same_v<Source, Value>) {
    return functionFromValue<Result>(input);
  } else if constexpr (requires { CallableArityForObject<Source>::value; }) {
    return adaptStdFunction<Result>(
        std::forward<Input>(input),
        std::type_identity<Result>{});
  } else {
    return Result(std::forward<Input>(input));
  }
}

template <typename Result>
Result Value::toInstance() const {
  static_assert(std::is_pointer_v<Result>);
  if (isNull() || isUndefined()) return nullptr;
  if constexpr (std::is_same_v<Result, cppgc::GarbageCollectedMixin*>) {
    if (isRecord()) return record();
    if (isRuntimeObject()) return object();
    throw errorAtCurrentSource(u"VexaScript WeakMap/WeakSet key is not an object");
  } else if constexpr (RecordAdaptable<std::remove_pointer_t<Result>>) {
    if (isRuntimeObject()) {
      void* converted = object()->dynamicCast(nativeTypeToken<std::remove_pointer_t<Result>>());
      if (converted) return static_cast<Result>(converted);
      return std::remove_pointer_t<Result>::fromRecord(
          Runtime::make<RecordObject>(object()));
    }
    if (isRecord()) return std::remove_pointer_t<Result>::fromRecord(record());
    throw errorAtCurrentSource(u"VexaScript value is not a compatible structural object");
  } else {
    if (!isObject()) {
      throw errorAtCurrentSource(
          std::u16string(u"VexaScript dynamic value has an incompatible native object type: ") +
          utf8ToUtf16(__PRETTY_FUNCTION__) + u"; actual value: " + toString(*this));
    }
    void* converted = object()->dynamicCast(nativeTypeToken<std::remove_pointer_t<Result>>());
    if (!converted) {
      if constexpr (DynamicObjectView<std::remove_pointer_t<Result>>) {
        return std::remove_pointer_t<Result>::fromDynamicObject(object());
      }
    }
    if (!converted) {
      const auto kind = object()->dynamicGet(u"kind");
      throw errorAtCurrentSource(
          std::u16string(u"VexaScript dynamic value has an incompatible native object type: ") +
          utf8ToUtf16(__PRETTY_FUNCTION__) + u"; actual value: " + toString(*this) +
          (kind.isUndefined() ? u"" : u"; kind: " + toString(kind)));
    }
    return static_cast<Result>(converted);
  }
}

template <typename Result, typename Input>
  requires std::is_pointer_v<Result>
Result toInstance(Input&& input) {
  using Source = std::remove_cvref_t<Input>;
  if constexpr (std::is_same_v<Source, StoredValue>) {
    return toInstance<Result>(input.load());
  } else if constexpr (std::is_same_v<Result, Source>) {
    return std::forward<Input>(input);
  } else if constexpr (requires(Source value) { value.Get(); }) {
    return toInstance<Result>(input.Get());
  } else if constexpr (OptionalTraits<Source>::value) {
    return input ? toInstance<Result>(*input) : nullptr;
  } else if constexpr (
      std::is_same_v<Source, Null> ||
      std::is_same_v<Source, Undefined> ||
      std::is_same_v<Source, std::nullptr_t>) {
    return nullptr;
  } else if constexpr (std::is_same_v<Source, Value>) {
    return input.template toInstance<Result>();
  } else if constexpr (
      std::is_same_v<Source, RecordObject*> &&
      RecordAdaptable<std::remove_pointer_t<Result>>) {
    return std::remove_pointer_t<Result>::fromRecord(input);
  } else if constexpr (std::is_pointer_v<Source>) {
    if (!input) return nullptr;
    if constexpr (std::is_convertible_v<Source, Result>) {
      return static_cast<Result>(input);
    } else if constexpr (
        std::is_base_of_v<BaseObject, std::remove_pointer_t<Source>> &&
        std::is_base_of_v<BaseObject, std::remove_pointer_t<Result>>) {
      void* converted = input->dynamicCast(nativeTypeToken<std::remove_pointer_t<Result>>());
      if (!converted) {
        if constexpr (DynamicObjectView<std::remove_pointer_t<Result>>) {
          return std::remove_pointer_t<Result>::fromDynamicObject(static_cast<BaseObject*>(input));
        }
        throw errorAtCurrentSource(
            std::u16string(u"VexaScript object has an incompatible native pointer type (dynamic cast): ") +
            utf8ToUtf16(__PRETTY_FUNCTION__));
      }
      return static_cast<Result>(converted);
    } else if constexpr (
        std::is_base_of_v<EnumerableObject, std::remove_pointer_t<Source>> &&
        std::is_base_of_v<EnumerableObject, std::remove_pointer_t<Result>>) {
      void* converted = input->nativeInterfaceCast(nativeTypeToken<std::remove_pointer_t<Result>>());
      if (!converted) throw runtimeError(u"VexaScript object has an incompatible interface type");
      return static_cast<Result>(converted);
    } else if constexpr (
        std::is_same_v<Result, RecordObject*> &&
        std::is_base_of_v<EnumerableObject, std::remove_pointer_t<Source>>) {
      return input->enumerableBackingRecord();
    } else {
      throw errorAtCurrentSource(u"VexaScript object has an incompatible native pointer type (unsupported conversion)");
    }
  } else {
    throw errorAtCurrentSource(u"VexaScript value cannot be converted to a native object");
  }
}

template <typename Result>
  requires std::is_pointer_v<Result>
Result toInstanceOrNull(const Value& input) {
  if (!input.isRuntimeObject()) return nullptr;
  void* converted = input.object()->dynamicCast(nativeTypeToken<std::remove_pointer_t<Result>>());
  return converted ? static_cast<Result>(converted) : nullptr;
}

template <typename Result, typename Source>
  requires std::is_pointer_v<Result>
Result toInstanceOrNull(Source* input) {
  if (!input) return nullptr;
  if constexpr (std::is_convertible_v<Source*, Result>) {
    return static_cast<Result>(input);
  } else if constexpr (
      std::is_base_of_v<BaseObject, Source> &&
      std::is_base_of_v<BaseObject, std::remove_pointer_t<Result>>) {
    void* converted = input->dynamicCast(nativeTypeToken<std::remove_pointer_t<Result>>());
    return converted ? static_cast<Result>(converted) : nullptr;
  } else if constexpr (
      std::is_base_of_v<EnumerableObject, Source> &&
      std::is_base_of_v<EnumerableObject, std::remove_pointer_t<Result>>) {
    void* converted = input->nativeInterfaceCast(nativeTypeToken<std::remove_pointer_t<Result>>());
    return converted ? static_cast<Result>(converted) : nullptr;
  } else if constexpr (
      std::is_same_v<Result, RecordObject*> &&
      std::is_base_of_v<EnumerableObject, Source>) {
    return input->enumerableBackingRecord();
  } else {
    return nullptr;
  }
}

template <typename Result, typename T>
  requires std::is_pointer_v<Result>
Result toInstanceOrNull(const cppgc::Member<T>& input) {
  return toInstanceOrNull<Result>(input.Get());
}

template <typename Result, typename T>
  requires std::is_pointer_v<Result>
Result toInstanceOrNull(const cppgc::Persistent<T>& input) {
  return toInstanceOrNull<Result>(input.Get());
}

template <typename Result, typename Input>
Result convertValue(Input&& input) {
  using Source = std::remove_cvref_t<Input>;
  if constexpr (std::is_same_v<Source, StoredValue>) {
    return convertValue<Result>(input.load());
  } else if constexpr (std::is_same_v<Result, Source>) {
    return std::forward<Input>(input);
  } else if constexpr (requires(Source value) { value.Get(); }) {
    return convertValue<Result>(input.Get());
  } else if constexpr (OptionalTraits<Source>::value) {
    if (!input.has_value()) {
      if constexpr (std::is_same_v<Result, Value>) return Value::undefined();
      else return defaultValue<Result>();
    }
    return convertValue<Result>(*input);
  } else if constexpr (std::is_pointer_v<Result>) {
    return toInstance<Result>(std::forward<Input>(input));
  } else if constexpr (std::is_same_v<Result, Value>) {
    if constexpr (std::is_same_v<Source, Undefined>) {
      return Value::undefined();
    } else if constexpr (
        std::is_same_v<Source, Null> ||
        std::is_same_v<Source, std::nullptr_t>) {
      return Value::null();
    } else if constexpr (std::is_same_v<Source, std::u16string>) {
      return Runtime::string(std::forward<Input>(input));
    } else if constexpr (std::is_pointer_v<Source>) {
      if (!input) return Value::null();
      if constexpr (std::is_base_of_v<BaseObject, std::remove_pointer_t<Source>>) {
        return Value(static_cast<BaseObject*>(input));
      } else if constexpr (std::is_base_of_v<EnumerableObject, std::remove_pointer_t<Source>>) {
        auto* enumerable = static_cast<EnumerableObject*>(input);
        auto* record = enumerable->enumerableBackingRecord();
        if (!record) {
                    record = Runtime::record();
          for (const auto& key : enumerable->enumerableKeys()) {
            record->set(key, enumerable->enumerableGet(key));
          }
        }
        return Value(record);
      } else {
        return Value(std::forward<Input>(input));
      }
    } else {
      return Value(std::forward<Input>(input));
    }
  } else if constexpr (std::is_same_v<Source, Value>) {
    if constexpr (std::is_same_v<Result, Undefined>) {
      if (!input.isUndefined()) throw runtimeError(u"VexaScript value is not undefined");
      return Undefined{};
    } else if constexpr (std::is_same_v<Result, Null>) {
      if (!input.isNull()) throw errorAtCurrentSource(u"VexaScript value is not null");
      return Null{};
    } else if constexpr (std::is_same_v<Result, bool>) {
      return toBoolean(input);
    } else if constexpr (std::is_same_v<Result, BigInt>) {
      return toBigInt(input);
    } else if constexpr (std::is_same_v<Result, std::u16string>) {
      return toText(input);
    } else if constexpr (std::is_same_v<Result, double>) {
      return toDouble(input);
    } else if constexpr (std::is_same_v<Result, std::int32_t>) {
      return toNativeInt32(input);
    } else if constexpr (std::is_arithmetic_v<Result>) {
      return static_cast<Result>(toDouble(input));
    } else if constexpr (IsStdFunction<Result>::value) {
      return functionFromValue<Result>(input);
    } else {
      return std::forward<Input>(input);
    }
  } else {
    return std::forward<Input>(input);
  }
}

inline Value toValue(Value value) { return value; }
inline Value toValue(const StoredValue& value) { return value.load(); }
inline Value toValue(Undefined) { return Value::undefined(); }
inline Value toValue(Null) { return Value::null(); }
inline Value toValue(std::nullptr_t) { return Value::null(); }
inline Value toValue(bool value) { return Value(value); }
inline Value toValue(double value) { return Value(value); }
inline Value toValue(float value) { return Value(static_cast<double>(value)); }
inline Value toValue(std::int32_t value) { return Value(static_cast<double>(value)); }
inline Value toValue(std::uint32_t value) { return Value(static_cast<double>(value)); }
inline Value toValue(std::int64_t value) { return Value(static_cast<double>(value)); }
inline Value toValue(std::uint64_t value) { return Value(static_cast<double>(value)); }
inline Value toValue(BigInt value) { return Value(std::move(value)); }
inline Value toValue(const std::u16string& value) { return Runtime::string(value); }
inline Value toValue(std::u16string&& value) { return Runtime::string(std::move(value)); }

template <typename T>
  requires std::is_enum_v<T>
inline Value toValue(T value) {
  return Value(static_cast<double>(value));
}

template <typename T>
  requires std::is_base_of_v<BaseObject, T>
inline Value toValue(T* value) {
  return value ? Value(static_cast<BaseObject*>(value)) : Value::null();
}

template <typename T>
inline Value toValue(T* value) {
  return convertValue<Value>(value);
}

template <typename T>
  requires requires(const T& value) { value.Get(); }
inline Value toValue(const T& value) {
  return toValue(value.Get());
}

template <typename T>
inline Value toValue(const std::optional<T>& value) {
  return value ? toValue(*value) : Value::undefined();
}

template <typename Interface, typename Adapter, typename Input>
inline Interface* adaptInterface(Input&& input) {
    using Source = std::remove_cvref_t<Input>;
  if constexpr (std::is_same_v<Source, Value>) {
    if (input.isRecord()) return Runtime::make<Adapter>(input.record());
    if (input.isRuntimeObject()) {
      void* converted = input.object()->dynamicCast(nativeTypeToken<Interface>());
      if (converted) return static_cast<Interface*>(converted);
      return Runtime::make<Adapter>(Runtime::make<RecordObject>(input.object()));
    }
    return convertValue<Interface*>(std::forward<Input>(input));
  } else if constexpr (std::is_same_v<Source, RecordObject*>) {
    return Runtime::make<Adapter>(input);
  } else if constexpr (std::is_pointer_v<Source> && std::is_convertible_v<Source, Interface*>) {
    return static_cast<Interface*>(input);
  } else if constexpr (
      std::is_pointer_v<Source> &&
      std::is_base_of_v<BaseObject, std::remove_pointer_t<Source>>) {
    if (!input) return nullptr;
    void* converted = input->dynamicCast(nativeTypeToken<Interface>());
    if (converted) return static_cast<Interface*>(converted);
    return Runtime::make<Adapter>(Runtime::make<RecordObject>(input));
  } else if constexpr (
      std::is_pointer_v<Source> &&
      std::is_base_of_v<EnumerableObject, std::remove_pointer_t<Source>>) {
    if (!input) return nullptr;
    auto* enumerable = static_cast<EnumerableObject*>(input);
    auto* record = enumerable->enumerableBackingRecord();
    if (!record) {
      record = Runtime::record();
      for (const auto& key : enumerable->enumerableKeys()) {
        record->set(key, enumerable->enumerableGet(key));
      }
    }
    return Runtime::make<Adapter>(record);
  } else {
    return convertValue<Interface*>(std::forward<Input>(input));
  }
}

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
  const auto found = map->find(convertValue<K>(std::forward<Key>(key)));
  if (found) return *found;
  if constexpr (std::is_same_v<V, Value>) return Value::undefined();
  return V{};
}

template <typename K, typename V, typename Key>
inline Value mapGetValue(const MapObject<K, V>* map, Key&& key) {
  const auto found = map->find(convertValue<K>(std::forward<Key>(key)));
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
inline SetObject<T>* setUnion(SetObject<T>* left, const SetObject<T>* right) {
  auto* result = Runtime::make<SetObject<T>>(left);
  if (right) right->forEach([&](T value) { result->add(value); });
  return result;
}

template <typename T>
inline SetObject<T>* setIntersection(SetObject<T>* left, const SetObject<T>* right) {
  auto* result = Runtime::make<SetObject<T>>();
  if (!left || !right) return result;
  left->forEach([&](T value) {
    if (right->has(value)) result->add(value);
  });
  return result;
}

template <typename T>
inline SetObject<T>* setDifference(SetObject<T>* left, const SetObject<T>* right) {
  auto* result = Runtime::make<SetObject<T>>();
  if (!left) return result;
  left->forEach([&](T value) {
    if (!right || !right->has(value)) result->add(value);
  });
  return result;
}

template <typename T>
inline SetObject<T>* setSymmetricDifference(SetObject<T>* left, const SetObject<T>* right) {
  auto* result = Runtime::make<SetObject<T>>();
  if (left) left->forEach([&](T value) {
    if (!right || !right->has(value)) result->add(value);
  });
  if (right) right->forEach([&](T value) {
    if (!left || !left->has(value)) result->add(value);
  });
  return result;
}

template <typename T>
inline bool setIsSubsetOf(const SetObject<T>* left, const SetObject<T>* right) {
  if (!left) return true;
  bool result = true;
  left->forEach([&](T value) {
    if (!right || !right->has(value)) result = false;
  });
  return result;
}

template <typename T>
inline bool setIsSupersetOf(const SetObject<T>* left, const SetObject<T>* right) {
  return setIsSubsetOf(right, left);
}

template <typename T>
inline bool setIsDisjointFrom(const SetObject<T>* left, const SetObject<T>* right) {
  if (!left || !right) return true;
  bool result = true;
  left->forEach([&](T value) {
    if (right->has(value)) result = false;
  });
  return result;
}

template <typename T>
inline SetObject<T>* SetObject<T>::vexa_union(const SetObject* other) const {
  return setUnion(const_cast<SetObject*>(this), other);
}

template <typename T>
inline SetObject<T>* SetObject<T>::intersection(const SetObject* other) const {
  return setIntersection(const_cast<SetObject*>(this), other);
}

template <typename T>
inline SetObject<T>* SetObject<T>::difference(const SetObject* other) const {
  return setDifference(const_cast<SetObject*>(this), other);
}

template <typename T>
inline SetObject<T>* SetObject<T>::symmetricDifference(const SetObject* other) const {
  return setSymmetricDifference(const_cast<SetObject*>(this), other);
}

template <typename T>
inline bool SetObject<T>::isSubsetOf(const SetObject* other) const {
  return setIsSubsetOf(this, other);
}

template <typename T>
inline bool SetObject<T>::isSupersetOf(const SetObject* other) const {
  return setIsSupersetOf(this, other);
}

template <typename T>
inline bool SetObject<T>::isDisjointFrom(const SetObject* other) const {
  return setIsDisjointFrom(this, other);
}

template <typename Callback, typename T>
inline decltype(auto) invokeGroupingCallback(
    Callback& callback,
    T value,
    std::size_t index,
    const ArrayObject<T>* array) {
  if constexpr (std::is_invocable_v<Callback, T, double, ArrayObject<T>*>) {
    return callback(std::move(value), static_cast<double>(index), const_cast<ArrayObject<T>*>(array));
  } else if constexpr (std::is_invocable_v<Callback, T, double>) {
    return callback(std::move(value), static_cast<double>(index));
  } else {
    return callback(std::move(value));
  }
}

template <typename T, typename Callback>
inline auto mapGroupBy(const ArrayObject<T>* items, Callback callback) {
  using Key = std::remove_cvref_t<decltype(
      invokeGroupingCallback(callback, std::declval<T>(), std::size_t{}, items))>;
  auto* result = Runtime::make<MapObject<Key, ArrayObject<T>*>>();
  if (!items) return result;
  for (std::size_t index = 0; index < items->size(); ++index) {
    const auto key = invokeGroupingCallback(callback, items->get(index), index, items);
    const auto existing = result->get(key);
    auto* group = existing ? existing : Runtime::array<T>();
    group->append(items->get(index));
    result->set(key, group);
  }
  return result;
}

inline MapObject<Value, ArrayObject<Value>*>* mapGroupBy(
    const Value& items,
    std::function<Value(Value, double)> callback) {
  auto* result = Runtime::make<MapObject<Value, ArrayObject<Value>*>>();
  std::size_t index = 0;
  for (const auto value : dynamicIterationRange(items)) {
    const Value key = callback(value, static_cast<double>(index++));
    const auto existing = result->get(key);
    auto* group = existing ? existing : Runtime::array<Value>();
    group->append(value);
    result->set(key, group);
  }
  return result;
}

template <typename T, typename Callback>
inline RecordObject* objectGroupBy(const ArrayObject<T>* items, Callback callback) {
  auto* result = Runtime::record();
  if (!items) return result;
  for (std::size_t index = 0; index < items->size(); ++index) {
    const auto key = invokeGroupingCallback(callback, items->get(index), index, items);
    const auto property = propertyKey(convertValue<Value>(key));
    const auto current = result->get(property);
    ArrayObject<T>* group = current.isUndefined()
      ? Runtime::array<T>()
      : convertValue<ArrayObject<T>*>(current);
    group->append(items->get(index));
    result->set(property, Value(group));
  }
  return result;
}

inline RecordObject* objectGroupBy(
    const Value& items,
    std::function<Value(Value, double)> callback) {
  auto* result = Runtime::record();
  std::size_t index = 0;
  for (const auto value : dynamicIterationRange(items)) {
    const auto property = propertyKey(callback(value, static_cast<double>(index++)));
    const auto current = result->get(property);
    ArrayObject<Value>* group = current.isUndefined()
      ? Runtime::array<Value>()
      : convertValue<ArrayObject<Value>*>(current);
    group->append(value);
    result->set(property, Value(group));
  }
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
  const auto found = map->find(convertValue<K>(std::forward<Key>(key)));
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

inline Uint8ArrayObject* makeUint8Array(double length) {
  const auto size = static_cast<std::size_t>(std::max(0.0, length));
  auto* buffer = Runtime::make<ArrayBufferObject>(size);
  return Runtime::make<Uint8ArrayObject>(buffer, 0, size);
}

inline Uint8ArrayObject* makeUint8Array(ArrayBufferObject* buffer) {
  return Runtime::make<Uint8ArrayObject>(buffer, 0, buffer->byteLength());
}

template <typename T>
inline Uint8ArrayObject* makeUint8Array(const ArrayObject<T>* values) {
  auto* result = makeUint8Array(static_cast<double>(values->size()));
  for (std::size_t index = 0; index < values->size(); ++index) result->set(index, Number(convertValue<Value>(values->get(index))));
  return result;
}

inline Uint8ArrayObject* makeUint8Array(const std::u16string& value) {
  const auto encoded = utf16ToUtf8(value);
  auto* result = makeUint8Array(static_cast<double>(encoded.size()));
  for (std::size_t index = 0; index < encoded.size(); ++index) {
    result->set(index, static_cast<double>(static_cast<unsigned char>(encoded[index])));
  }
  return result;
}

inline Uint8ArrayObject* TextEncoderObject::encode(const std::u16string& source) const {
  return makeUint8Array(source);
}

inline RecordObject* TextEncoderObject::encodeInto(
    const std::u16string& source,
    Uint8ArrayObject* destination) const {
  if (!destination) throw runtimeError(u"TextEncoder.encodeInto requires a destination");
  const auto encoded = utf16ToUtf8(source);
  const auto written = std::min(encoded.size(), destination->length());
  for (std::size_t index = 0; index < written; ++index) {
    destination->set(index, static_cast<double>(static_cast<unsigned char>(encoded[index])));
  }
  auto* result = Runtime::record();
  result->set(u"read", Value(static_cast<double>(source.size())));
  result->set(u"written", Value(static_cast<double>(written)));
  return result;
}

inline Uint32ArrayObject* makeUint32Array(double length) {
  const auto size = static_cast<std::size_t>(std::max(0.0, length));
  auto* buffer = Runtime::make<ArrayBufferObject>(size * sizeof(std::uint32_t));
  return Runtime::make<Uint32ArrayObject>(buffer, 0, size);
}

template <typename T>
inline Uint32ArrayObject* makeUint32Array(const ArrayObject<T>* values) {
  auto* result = makeUint32Array(static_cast<double>(values->size()));
  for (std::size_t index = 0; index < values->size(); ++index) {
    result->set(index, Number(convertValue<Value>(values->get(index))));
  }
  return result;
}

inline BigInt64ArrayObject* makeBigInt64Array(double length) {
  const auto size = static_cast<std::size_t>(std::max(0.0, length));
  auto* buffer = Runtime::make<ArrayBufferObject>(size * sizeof(std::int64_t));
  return Runtime::make<BigInt64ArrayObject>(buffer, 0, size);
}

inline BigInt64ArrayObject* makeBigInt64Array(ArrayBufferObject* buffer, double byteOffset = 0, double length = -1) {
  const auto offset = static_cast<std::size_t>(std::max(0.0, byteOffset));
  const auto available = buffer->byteLength() - offset;
  const auto elements = length < 0
    ? available / sizeof(std::int64_t)
    : static_cast<std::size_t>(std::max(0.0, length));
  return Runtime::make<BigInt64ArrayObject>(buffer, offset, elements);
}

template <typename T>
inline BigInt64ArrayObject* makeBigInt64Array(const ArrayObject<T>* values) {
  auto* result = makeBigInt64Array(static_cast<double>(values ? values->size() : 0));
  if (values) {
    for (std::size_t index = 0; index < values->size(); ++index) {
      result->set(index, convertValue<BigInt>(values->get(index)));
    }
  }
  return result;
}

inline RecordObject* atomicsWaitAsync(
    Uint32ArrayObject* typedArray,
    double index,
    double expected,
    double timeout = std::numeric_limits<double>::infinity()) {
  const auto position = static_cast<std::size_t>(std::max(0.0, std::trunc(index)));
  const bool matches = typedArray && position < typedArray->length() &&
    typedArray->get(position) == static_cast<std::uint32_t>(expected);
  return Runtime::record({
    {u"async", Value(false)},
    {u"value", Runtime::string(matches && timeout > 0 ? u"timed-out" : matches ? u"timed-out" : u"not-equal")},
  });
}

inline RecordObject* atomicsWaitAsync(
    BigInt64ArrayObject* typedArray,
    double index,
    const BigInt& expected,
    double timeout = std::numeric_limits<double>::infinity()) {
  const auto position = static_cast<std::size_t>(std::max(0.0, std::trunc(index)));
  const bool matches = typedArray && position < typedArray->length() && typedArray->get(position) == expected;
  return Runtime::record({
    {u"async", Value(false)},
    {u"value", Runtime::string(matches ? u"timed-out" : u"not-equal")},
  });
}

inline Float16ArrayObject* makeFloat16Array(double length) {
  const auto size = static_cast<std::size_t>(std::max(0.0, length));
  auto* buffer = Runtime::make<ArrayBufferObject>(size * sizeof(std::uint16_t));
  return Runtime::make<Float16ArrayObject>(buffer, 0, size);
}

inline Float16ArrayObject* makeFloat16Array(ArrayBufferObject* buffer, double byteOffset = 0, double length = -1) {
  const auto offset = static_cast<std::size_t>(std::max(0.0, byteOffset));
  const auto available = buffer->byteLength() - offset;
  const auto elements = length < 0
    ? available / sizeof(std::uint16_t)
    : static_cast<std::size_t>(std::max(0.0, length));
  return Runtime::make<Float16ArrayObject>(buffer, offset, elements);
}

template <typename T>
inline Float16ArrayObject* makeFloat16Array(const ArrayObject<T>* values) {
  auto* result = makeFloat16Array(static_cast<double>(values ? values->size() : 0));
  if (values) {
    for (std::size_t index = 0; index < values->size(); ++index) {
      result->set(index, Number(convertValue<Value>(values->get(index))));
    }
  }
  return result;
}

inline Float16ArrayObject* float16ArrayOf(std::initializer_list<double> values) {
  auto* result = makeFloat16Array(static_cast<double>(values.size()));
  std::size_t index = 0;
  for (const auto value : values) result->set(index++, value);
  return result;
}

template <typename Callback>
inline decltype(auto) invokeFloat16FromCallback(Callback& callback, double value, std::size_t index) {
  if constexpr (std::is_invocable_v<Callback, double, double>) {
    return callback(value, static_cast<double>(index));
  } else {
    return callback(value);
  }
}

template <typename T>
inline Float16ArrayObject* float16ArrayFrom(const ArrayObject<T>* values) {
  auto* result = makeFloat16Array(static_cast<double>(values ? values->size() : 0));
  if (values) {
    for (std::size_t index = 0; index < values->size(); ++index) {
      result->set(index, Number(convertValue<Value>(values->get(index))));
    }
  }
  return result;
}

template <typename T, typename Callback>
inline Float16ArrayObject* float16ArrayFrom(const ArrayObject<T>* values, Callback callback) {
  auto* result = makeFloat16Array(static_cast<double>(values ? values->size() : 0));
  if (values) {
    for (std::size_t index = 0; index < values->size(); ++index) {
      const auto value = Number(convertValue<Value>(values->get(index)));
      result->set(index, Number(convertValue<Value>(invokeFloat16FromCallback(callback, value, index))));
    }
  }
  return result;
}

inline Float16ArrayObject* float16ArrayFrom(const Float16ArrayObject* values) {
  auto* result = makeFloat16Array(static_cast<double>(values ? values->length() : 0));
  if (values) {
    for (std::size_t index = 0; index < values->length(); ++index) result->set(index, values->get(index));
  }
  return result;
}

template <typename Callback>
inline Float16ArrayObject* float16ArrayFrom(const Float16ArrayObject* values, Callback callback) {
  auto* result = makeFloat16Array(static_cast<double>(values ? values->length() : 0));
  if (values) {
    for (std::size_t index = 0; index < values->length(); ++index) {
      result->set(index, Number(convertValue<Value>(invokeFloat16FromCallback(callback, values->get(index), index))));
    }
  }
  return result;
}

template <typename T>
inline Float16ArrayObject* float16ArrayFrom(NativeIteratorObject<T>* values) {
  const auto remaining = values ? values->takeRemaining() : std::vector<T>{};
  auto* result = makeFloat16Array(static_cast<double>(remaining.size()));
  for (std::size_t index = 0; index < remaining.size(); ++index) {
    result->set(index, Number(convertValue<Value>(remaining[index])));
  }
  return result;
}

template <typename T, typename Callback>
inline Float16ArrayObject* float16ArrayFrom(NativeIteratorObject<T>* values, Callback callback) {
  const auto remaining = values ? values->takeRemaining() : std::vector<T>{};
  auto* result = makeFloat16Array(static_cast<double>(remaining.size()));
  for (std::size_t index = 0; index < remaining.size(); ++index) {
    const auto value = Number(convertValue<Value>(remaining[index]));
    result->set(index, Number(convertValue<Value>(invokeFloat16FromCallback(callback, value, index))));
  }
  return result;
}

inline ArrayObject<double>* float16ArrayValues(const Float16ArrayObject* values) {
  auto* result = Runtime::array<double>();
  if (!values) return result;
  for (std::size_t index = 0; index < values->length(); ++index) result->append(values->get(index));
  return result;
}

inline ArrayObject<std::uint8_t>* uint8ArrayValues(const Uint8ArrayObject* values) {
  auto* result = Runtime::array<std::uint8_t>();
  if (!values) return result;
  for (std::size_t index = 0; index < values->length(); ++index) result->append(values->get(index));
  return result;
}

inline DataViewObject* makeDataView(
    ArrayBufferObject* buffer,
    double byteOffset = 0,
    double byteLength = -1) {
  const auto offset = static_cast<std::size_t>(std::max(0.0, byteOffset));
  const auto length = byteLength < 0
    ? buffer->byteLength() - offset
    : static_cast<std::size_t>(byteLength);
  return Runtime::make<DataViewObject>(buffer, offset, length);
}

template <typename Target>
bool isInstance(const Value& value) {
  return value.isRuntimeObject() &&
      value.object()->dynamicCast(nativeTypeToken<Target>()) != nullptr;
}

template <typename Target, typename Source>
bool isInstance(Source* value) {
  if (!value) return false;
  if constexpr (std::is_base_of_v<BaseObject, Source>) {
    return value->dynamicCast(nativeTypeToken<Target>()) != nullptr;
  } else {
    return std::is_convertible_v<Source*, Target*>;
  }
}

template <typename Target, typename Source>
bool isInstance(const cppgc::Member<Source>& value) {
  return isInstance<Target>(value.Get());
}

template <typename Target, typename Source>
bool isInstance(const cppgc::Persistent<Source>& value) {
  return isInstance<Target>(value.Get());
}

template <typename Result, typename... Arguments>
class FunctionObject final
    : public cppgc::GarbageCollected<FunctionObject<Result, Arguments...>>,
      public BaseObject {
 public:
  template <typename Callback>
  explicit FunctionObject(Callback callback, std::initializer_list<Value> roots = {})
      : callback_(std::move(callback)) {
    roots_.reserve(roots.size());
    for (const auto& root : roots) roots_.emplace_back(root);
  }

  Result invoke(Arguments... arguments) {
    return callback_(std::forward<Arguments>(arguments)...);
  }

  const void* dynamicTypeToken() const override {
    return nativeTypeToken<FunctionObject<Result, Arguments...>>();
  }

  void* dynamicCast(const void* type) override {
    return type == nativeTypeToken<FunctionObject<Result, Arguments...>>() ? this : nullptr;
  }

  std::u16string dynamicToString() const override { return u"function"; }

  Value dynamicCall(const std::vector<Value>& arguments) override {
    if (arguments.size() >= sizeof...(Arguments)) {
      return dynamicCallWithIndices(arguments, std::index_sequence_for<Arguments...>{});
    }
    auto normalizedArguments = arguments;
    normalizedArguments.resize(sizeof...(Arguments), Value::undefined());
    return dynamicCallWithIndices(normalizedArguments, std::index_sequence_for<Arguments...>{});
  }

  void Trace(cppgc::Visitor* visitor) const override {
    BaseObject::Trace(visitor);
    for (const auto& root : roots_) root.Trace(visitor);
  }

 private:
  template <std::size_t... Indices>
  Value dynamicCallWithIndices(
      const std::vector<Value>& arguments,
      std::index_sequence<Indices...>) {
    if constexpr (std::is_void_v<Result>) {
      callback_(convertValue<Arguments>(arguments[Indices])...);
      return Value::undefined();
    } else if constexpr (TaskTraits<Result>::value) {
      auto task = callback_(convertValue<Arguments>(arguments[Indices])...);
      if constexpr (std::is_void_v<typename TaskTraits<Result>::Result>) {
        task.get();
        return Value::undefined();
      } else {
        return convertValue<Value>(task.get());
      }
    } else {
      return convertValue<Value>(
          callback_(convertValue<Arguments>(arguments[Indices])...));
    }
  }

  std::function<Result(Arguments...)> callback_;
  std::vector<StoredValue> roots_;
};

template <typename Function>
struct FunctionFromValue;

template <typename Result, typename... Arguments>
struct FunctionFromValue<std::function<Result(Arguments...)>> {
  static std::function<Result(Arguments...)> convert(const Value& value) {
    if (value.isUndefined() || value.isNull()) return {};
    if (!value.isRuntimeObject()) throw errorAtCurrentSource(u"VexaScript value is not callable");
    auto* function = static_cast<FunctionObject<Result, Arguments...>*>(
        value.object()->dynamicCast(nativeTypeToken<FunctionObject<Result, Arguments...>>()));
    if (!function) throw errorAtCurrentSource(u"VexaScript callable has an incompatible native signature");
    cppgc::Persistent<FunctionObject<Result, Arguments...>> rooted(function);
    return [rooted = std::move(rooted)](Arguments... arguments) mutable -> Result {
      return rooted->invoke(std::forward<Arguments>(arguments)...);
    };
  }
};

template <typename Result>
Result functionFromValue(const Value& value) {
  return FunctionFromValue<Result>::convert(value);
}

template <typename Result, typename... Arguments, typename Callback>
FunctionObject<Result, Arguments...>* makeFunction(
    Callback callback,
    std::initializer_list<Value> roots = {}) {
  return Runtime::make<FunctionObject<Result, Arguments...>>(std::move(callback), roots);
}

template <typename Result, typename... Arguments>
inline Value toValue(const std::function<Result(Arguments...)>& callback) {
  return Value(makeFunction<Result, Arguments...>(callback));
}

inline Value call(const Value& callable, std::vector<Value> arguments) {
  if (!callable.isRuntimeObject()) {
    throw errorAtCurrentSource(u"VexaScript value is not callable");
  }
  return callable.object()->dynamicCall(arguments);
}

inline Value callOptional(const Value& callable, std::vector<Value> arguments) {
  if (callable.isNull() || callable.isUndefined()) return Value::undefined();
  return call(callable, std::move(arguments));
}

template <typename... Arguments>
inline std::optional<Value> callDynamicOperator(
    const Value& receiver,
    const std::u16string& operatorKey,
    Arguments&&... arguments) {
  if (!receiver.isRuntimeObject()) return std::nullopt;
  const Value callable = receiver.object()->dynamicGet(operatorKey);
  if (callable.isUndefined()) return std::nullopt;
  return call(callable, {
    convertValue<Value>(std::forward<Arguments>(arguments))...
  });
}

template <typename Result>
Result recordGet(RecordObject* record, const std::u16string& key) {
  if (!record) throw runtimeError(u"Cannot read a property of null");
  return convertValue<Result>(record->get(key));
}

template <typename Result>
Result recordGet(const Value& value, const std::u16string& key) {
  if (!value.isRecord()) throw runtimeError(u"Cannot read a property of a non-record value");
  return recordGet<Result>(value.record(), key);
}

template <typename Input>
std::remove_cvref_t<Input> recordSet(
    RecordObject* record,
    const std::u16string& key,
    Input&& input) {
  if (!record) throw runtimeError(u"Cannot write a property of null");
  using Result = std::remove_cvref_t<Input>;
  Result result = std::forward<Input>(input);
  record->set(key, convertValue<Value>(result));
  return result;
}

inline const std::u16string& propertyKey(const std::u16string& value) { return value; }
inline std::u16string propertyKey(double value) {
  return formatNumberText(value);
}
inline std::u16string propertyKey(std::int32_t value) { return formatIntegerText(value); }
inline std::u16string propertyKey(std::int64_t value) { return formatIntegerText(value); }
inline std::u16string propertyKey(const BigInt& value) { return value.toString(); }
inline std::u16string propertyKey(bool value) { return value ? u"true" : u"false"; }
inline std::u16string propertyKey(const Value& value) {
  if (value.isString()) return value.utf16();
  if (value.isNumber()) return propertyKey(value.number());
  if (value.isBigInt()) return propertyKey(value.bigint());
  if (value.isBoolean()) return propertyKey(value.boolean());
  if (value.isNull()) return u"null";
  if (value.isUndefined()) return u"undefined";
  if (value.isRuntimeObject()) return value.object()->dynamicToString();
  return u"[object Object]";
}

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

inline bool numberIsInteger(const Value& value) {
  return value.isNumber() && std::isfinite(value.number()) && std::trunc(value.number()) == value.number();
}

template <typename T>
inline bool numberIsInteger(T value) {
  if constexpr (std::is_integral_v<T>) return true;
  else if constexpr (std::is_floating_point_v<T>) return std::isfinite(value) && std::trunc(value) == value;
  else return false;
}

template <typename Callback>
Value nullishCoalesce(Value value, Callback&& fallback) {
  return value.isNull() || value.isUndefined()
      ? toValue(std::forward<Callback>(fallback)())
      : value;
}

template <typename Callback>
std::u16string nullishCoalesce(std::u16string value, Callback&&) {
  return value;
}

template <typename T, typename Callback>
T* nullishCoalesce(T* value, Callback&& fallback) {
  if (value) return value;
  return convertValue<T*>(std::forward<Callback>(fallback)());
}

template <typename T, typename Callback>
T* nullishCoalesce(const cppgc::Member<T>& value, Callback&& fallback) {
  if (value) return value.Get();
  return convertValue<T*>(std::forward<Callback>(fallback)());
}

template <typename T, typename Callback>
T nullishCoalesce(std::optional<T> value, Callback&& fallback) {
  return value.has_value() ? std::move(*value) : std::forward<Callback>(fallback)();
}

template <typename T>
std::vector<T> range(T start, T end, bool exclusive) {
  std::vector<T> values;
  for (T current = start; exclusive ? current < end : current <= end; ++current) {
    values.push_back(current);
  }
  return values;
}

template <typename T>
struct TaskStorage final {
  using Type = T;

  static Type store(T value) { return std::move(value); }
  static T load(const Type& value) { return value; }
};

template <typename T>
struct TaskStorage<T*> final {
  using Type = cppgc::Persistent<T>;

  static Type store(T* value) { return Type(value); }
  static T* load(const Type& value) { return value.Get(); }
};

template <typename T>
class ReturnSignal final {
 public:
  explicit ReturnSignal(T value) : value_(TaskStorage<T>::store(std::move(value))) {}
  T value() const { return TaskStorage<T>::load(value_); }

 private:
  typename TaskStorage<T>::Type value_;
};

template <>
class ReturnSignal<void> final {
 public:
  void value() const {}
};

template <typename T, typename Callback>
[[noreturn]] inline void throwReturn(Callback&& callback) {
  if constexpr (std::is_void_v<T>) {
    std::forward<Callback>(callback)();
    throw ReturnSignal<void>();
  } else {
    throw ReturnSignal<T>(convertValue<T>(std::forward<Callback>(callback)()));
  }
}

class BreakSignal final {};
class ContinueSignal final {};
class LabeledBreakSignal final {
 public:
  explicit LabeledBreakSignal(std::u16string label) : label_(std::move(label)) {}
  const std::u16string& label() const { return label_; }
 private:
  std::u16string label_;
};
class LabeledContinueSignal final {
 public:
  explicit LabeledContinueSignal(std::u16string label) : label_(std::move(label)) {}
  const std::u16string& label() const { return label_; }
 private:
  std::u16string label_;
};

class RejectedValue final {
 public:
  explicit RejectedValue(Value reason) : reason_(std::move(reason)) {}
  const Value& reason() const { return reason_; }

 private:
  Value reason_;
};

template <typename T>
class Task final {
 public:
  struct State final {
    std::optional<typename TaskStorage<T>::Type> value;
    std::exception_ptr error;
    std::vector<std::function<void()>> continuations;
    bool settled = false;
  };

  struct promise_type final {
    promise_type() : state(makeState()) {}

    template <typename... Arguments>
    explicit promise_type(Arguments&&...) : state(makeState()) {}

    template <typename Owner, typename... Arguments>
    promise_type(Owner&, Arguments&&...) : state(makeState()) {}

    Task get_return_object() { return Task(state); }
    std::suspend_never initial_suspend() const noexcept { return {}; }
    std::suspend_never final_suspend() const noexcept { return {}; }
    void return_value(T value) { resolve(state, std::move(value)); }
    void unhandled_exception() { reject(state, std::current_exception()); }

    std::shared_ptr<State> state;
  };

  Task() : state_(std::make_shared<State>()) {}

  class Awaiter final {
   public:
    explicit Awaiter(std::shared_ptr<State> state) : state_(std::move(state)) {}
    bool await_ready() const noexcept { return state_->settled; }
    void await_suspend(std::coroutine_handle<> continuation) {
      onSettled(state_, [continuation]() mutable { continuation.resume(); });
    }
    T await_resume() const {
      if (state_->error) std::rethrow_exception(state_->error);
      return TaskStorage<T>::load(*state_->value);
    }

   private:
    std::shared_ptr<State> state_;
  };

  template <typename Executor>
  static Task create(Executor executor) {
    auto state = makeState();
    try {
      executor(Resolver(state), Rejecter(state));
    } catch (...) {
      reject(state, std::current_exception());
    }
    return Task(std::move(state));
  }

  template <typename Work>
  static Task schedule(Work work) {
    auto state = makeState();
    Runtime::enqueueMicrotask([state, work = std::move(work)]() mutable {
      try {
        resolve(state, work());
      } catch (...) {
        reject(state, std::current_exception());
      }
    });
    return Task(std::move(state));
  }

  T get() const {
    Runtime::runUntil([this] { return state_->settled; });
    if (state_->error) std::rethrow_exception(state_->error);
    return TaskStorage<T>::load(*state_->value);
  }

  Awaiter operator co_await() const { return Awaiter(state_); }

  void whenSettled(std::function<void()> continuation) const {
    onSettled(state_, std::move(continuation));
  }

  T settledValue() const {
    if (!state_->settled) throw runtimeError(u"Promise is not settled");
    if (state_->error) std::rethrow_exception(state_->error);
    return TaskStorage<T>::load(*state_->value);
  }

  std::exception_ptr settledError() const { return state_->error; }

  template <typename Callback>
  auto then(Callback callback) {
    return promiseThen(*this, std::move(callback));
  }

  template <typename Callback>
  auto vexa_catch(Callback callback) {
    return promiseCatch(*this, std::move(callback));
  }

  template <typename Callback>
  auto finally(Callback callback) {
    return promiseFinally(*this, std::move(callback));
  }

 private:
  class Resolver final {
   public:
    explicit Resolver(std::shared_ptr<State> state) : state_(std::move(state)) {}

    void operator()() const {
      if constexpr (std::is_same_v<T, Value>) {
        resolve(state_, Value::undefined());
      } else {
        resolve(state_, T{});
      }
    }

    void operator()(T value) const { resolve(state_, std::move(value)); }

   private:
    std::shared_ptr<State> state_;
  };

  class Rejecter final {
   public:
    explicit Rejecter(std::shared_ptr<State> state) : state_(std::move(state)) {}

    void operator()() const {
      reject(state_, std::make_exception_ptr(runtimeError(u"Promise rejected")));
    }

    void operator()(const Error& error) const {
      reject(state_, std::make_exception_ptr(RejectedValue(Runtime::string(error.messageText()))));
    }

    template <typename Reason>
      requires (!std::is_same_v<std::remove_cvref_t<Reason>, Error>)
    void operator()(Reason&& reason) const {
      reject(state_, std::make_exception_ptr(RejectedValue(
          convertValue<Value>(std::forward<Reason>(reason)))));
    }

   private:
    std::shared_ptr<State> state_;
  };

  static std::shared_ptr<State> makeState() {
    return std::make_shared<State>();
  }

  static void resolve(const std::shared_ptr<State>& state, T value) {
    if (state->settled) return;
    state->value.emplace(TaskStorage<T>::store(std::move(value)));
    state->settled = true;
    notify(state);
  }

  static void reject(const std::shared_ptr<State>& state, std::exception_ptr error) {
    if (state->settled) return;
    state->error = std::move(error);
    state->settled = true;
    notify(state);
  }

  static void onSettled(const std::shared_ptr<State>& state, std::function<void()> continuation) {
    if (state->settled) Runtime::enqueueMicrotask(std::move(continuation));
    else state->continuations.push_back(std::move(continuation));
  }

  static void notify(const std::shared_ptr<State>& state) {
    for (auto& continuation : state->continuations) {
      Runtime::enqueueMicrotask(std::move(continuation));
    }
    state->continuations.clear();
  }

  explicit Task(std::shared_ptr<State> state) : state_(std::move(state)) {}

  std::shared_ptr<State> state_;
};

template <>
class Task<void> final {
 public:
  struct State final {
    std::exception_ptr error;
    std::vector<std::function<void()>> continuations;
    bool settled = false;
  };

  struct promise_type final {
    promise_type() : state(makeState()) {}

    template <typename... Arguments>
    explicit promise_type(Arguments&&...) : state(makeState()) {}

    template <typename Owner, typename... Arguments>
    promise_type(Owner&, Arguments&&...) : state(makeState()) {}

    Task get_return_object() { return Task(state); }
    std::suspend_never initial_suspend() const noexcept { return {}; }
    std::suspend_never final_suspend() const noexcept { return {}; }
    void return_void() { resolve(state); }
    void unhandled_exception() { reject(state, std::current_exception()); }

    std::shared_ptr<State> state;
  };

  Task() : state_(std::make_shared<State>()) {}

  class Awaiter final {
   public:
    explicit Awaiter(std::shared_ptr<State> state) : state_(std::move(state)) {}
    bool await_ready() const noexcept { return state_->settled; }
    void await_suspend(std::coroutine_handle<> continuation) {
      onSettled(state_, [continuation]() mutable { continuation.resume(); });
    }
    void await_resume() const {
      if (state_->error) std::rethrow_exception(state_->error);
    }

   private:
    std::shared_ptr<State> state_;
  };

  template <typename Executor>
  static Task create(Executor executor) {
    auto state = makeState();
    try {
      executor(Resolver(state), Rejecter(state));
    } catch (...) {
      reject(state, std::current_exception());
    }
    return Task(std::move(state));
  }

  template <typename Work>
  static Task schedule(Work work) {
    auto state = makeState();
    Runtime::enqueueMicrotask([state, work = std::move(work)]() mutable {
      try {
        work();
        resolve(state);
      } catch (...) {
        reject(state, std::current_exception());
      }
    });
    return Task(std::move(state));
  }

  void get() const {
    Runtime::runUntil([this] { return state_->settled; });
    if (state_->error) std::rethrow_exception(state_->error);
  }

  Awaiter operator co_await() const { return Awaiter(state_); }

  void whenSettled(std::function<void()> continuation) const {
    onSettled(state_, std::move(continuation));
  }

  void settledValue() const {
    if (!state_->settled) throw runtimeError(u"Promise is not settled");
    if (state_->error) std::rethrow_exception(state_->error);
  }

  std::exception_ptr settledError() const { return state_->error; }

  template <typename Callback>
  auto then(Callback callback) {
    return promiseThen(*this, std::move(callback));
  }

  template <typename Callback>
  auto vexa_catch(Callback callback) {
    return promiseCatch(*this, std::move(callback));
  }

  template <typename Callback>
  auto finally(Callback callback) {
    return promiseFinally(*this, std::move(callback));
  }

 private:
  class Resolver final {
   public:
    explicit Resolver(std::shared_ptr<State> state) : state_(std::move(state)) {}
    void operator()() const { resolve(state_); }

   private:
    std::shared_ptr<State> state_;
  };

  class Rejecter final {
   public:
    explicit Rejecter(std::shared_ptr<State> state) : state_(std::move(state)) {}

    void operator()() const {
      reject(state_, std::make_exception_ptr(runtimeError(u"Promise rejected")));
    }

    void operator()(const Error& error) const {
      reject(state_, std::make_exception_ptr(RejectedValue(Runtime::string(error.messageText()))));
    }

    template <typename Reason>
      requires (!std::is_same_v<std::remove_cvref_t<Reason>, Error>)
    void operator()(Reason&& reason) const {
      reject(state_, std::make_exception_ptr(RejectedValue(
          convertValue<Value>(std::forward<Reason>(reason)))));
    }

   private:
    std::shared_ptr<State> state_;
  };

  static std::shared_ptr<State> makeState() {
    return std::make_shared<State>();
  }

  static void resolve(const std::shared_ptr<State>& state) {
    if (state->settled) return;
    state->settled = true;
    notify(state);
  }

  static void reject(const std::shared_ptr<State>& state, std::exception_ptr error) {
    if (state->settled) return;
    state->error = std::move(error);
    state->settled = true;
    notify(state);
  }

  static void onSettled(const std::shared_ptr<State>& state, std::function<void()> continuation) {
    if (state->settled) Runtime::enqueueMicrotask(std::move(continuation));
    else state->continuations.push_back(std::move(continuation));
  }

  static void notify(const std::shared_ptr<State>& state) {
    for (auto& continuation : state->continuations) {
      Runtime::enqueueMicrotask(std::move(continuation));
    }
    state->continuations.clear();
  }

  explicit Task(std::shared_ptr<State> state) : state_(std::move(state)) {}

  std::shared_ptr<State> state_;
};

template <typename T>
class PromiseResolvers final
    : public cppgc::GarbageCollected<PromiseResolvers<T>>,
      public BaseObject {
 public:
  PromiseResolvers() {
    auto resolve = std::make_shared<std::function<void(T)>>();
    auto reject = std::make_shared<std::function<void(Value)>>();
    promise = Task<T>::create([resolve, reject](auto complete, auto fail) mutable {
      *resolve = std::move(complete);
      *reject = [fail](Value reason) mutable { fail(std::move(reason)); };
    });
    resolve_ = std::move(resolve);
    reject_ = std::move(reject);
  }

  void resolve(T value) const { (*resolve_)(std::move(value)); }
  void reject(Value reason) const { (*reject_)(std::move(reason)); }

  const void* dynamicTypeToken() const override { return nativeTypeToken<PromiseResolvers<T>>(); }
  void* dynamicCast(const void* type) override {
    return type == nativeTypeToken<PromiseResolvers<T>>() ? this : nullptr;
  }
  std::u16string dynamicToString() const override { return u"[object PromiseWithResolvers]"; }
  Value dynamicGet(const std::u16string& key) override {
    if (key == u"resolve") {
      return Value(static_cast<BaseObject*>(makeFunction<void, T>(
          [this](T value) { resolve(std::move(value)); }, {Value(this)})));
    }
    if (key == u"reject") {
      return Value(static_cast<BaseObject*>(makeFunction<void, Value>(
          [this](Value reason) { reject(std::move(reason)); }, {Value(this)})));
    }
    return BaseObject::dynamicGet(key);
  }
  void Trace(cppgc::Visitor* visitor) const override {
    BaseObject::Trace(visitor);
  }

  Task<T> promise;

 private:
  std::shared_ptr<std::function<void(T)>> resolve_;
  std::shared_ptr<std::function<void(Value)>> reject_;
};

template <typename Work, typename Map>
auto runAsyncMapped(Work work, Map map)
    -> Task<std::invoke_result_t<Map, std::invoke_result_t<Work>>> {
  using Result = std::invoke_result_t<Map, std::invoke_result_t<Work>>;
  auto operation = std::async(std::launch::async, std::move(work)).share();
  return Task<Result>::create([operation = std::move(operation), map = std::move(map)](auto resolve, auto reject) mutable {
    Runtime::enqueueIo([operation = std::move(operation), map = std::move(map), resolve, reject]() mutable {
      if (operation.wait_for(std::chrono::seconds(0)) != std::future_status::ready) return false;
      try {
        if constexpr (std::is_void_v<Result>) {
          operation.get();
          map();
          resolve();
        } else {
          resolve(map(operation.get()));
        }
      } catch (const std::exception& error) {
        reject(Error(exceptionText(error)));
      }
      return true;
    });
  });
}

template <typename Work>
auto runAsync(Work work) -> Task<std::invoke_result_t<Work>> {
  using Result = std::invoke_result_t<Work>;
  if constexpr (std::is_void_v<Result>) {
    auto operation = std::async(std::launch::async, std::move(work)).share();
    return Task<void>::create([operation = std::move(operation)](auto resolve, auto reject) mutable {
      Runtime::enqueueIo([operation = std::move(operation), resolve, reject]() mutable {
        if (operation.wait_for(std::chrono::seconds(0)) != std::future_status::ready) return false;
        try {
          operation.get();
          resolve();
        } catch (const std::exception& error) {
          reject(Error(exceptionText(error)));
        }
        return true;
      });
    });
  } else {
    return runAsyncMapped(std::move(work), [](Result value) { return value; });
  }
}

inline Task<Value> readTextFile(std::u16string path) {
  auto operation = std::async(std::launch::async, [path = std::move(path)] {
    return readUtf8File(path);
  }).share();
  return Task<Value>::create([operation = std::move(operation)](auto resolve, auto reject) mutable {
    Runtime::enqueueIo([operation = std::move(operation), resolve, reject]() mutable {
      if (operation.wait_for(std::chrono::seconds(0)) != std::future_status::ready) return false;
      try {
        resolve(Runtime::string(operation.get()));
      } catch (const std::exception& error) {
        reject(Error(exceptionText(error)));
      }
      return true;
    });
  });
}

inline Task<void> writeTextFile(std::u16string path, std::u16string contents) {
  auto operation = std::async(std::launch::async, [path = std::move(path), contents = std::move(contents)] {
    writeUtf8File(path, contents);
  }).share();
  return Task<void>::create([operation = std::move(operation)](auto resolve, auto reject) mutable {
    Runtime::enqueueIo([operation = std::move(operation), resolve, reject]() mutable {
      if (operation.wait_for(std::chrono::seconds(0)) != std::future_status::ready) return false;
      try {
        operation.get();
        resolve();
      } catch (const std::exception& error) {
        reject(Error(exceptionText(error)));
      }
      return true;
    });
  });
}

inline Task<Value> nativeStatPath(std::u16string path) {
  return Task<Value>::create([path = std::move(path)](auto resolve, auto reject) mutable {
    const std::filesystem::path filePath(path);
    std::error_code error;
    const auto status = std::filesystem::status(filePath, error);
    if (error || !std::filesystem::exists(status)) {
      reject(Error(u"File does not exist: " + path));
      return;
    }
    const auto modified = std::filesystem::last_write_time(filePath, error);
    if (error) {
      reject(Error(u"Cannot read file modification time: " + path));
      return;
    }
    auto* value = Runtime::record();
    value->set(u"mtimeMs", Value(static_cast<double>(modified.time_since_epoch().count()) / 1'000'000.0));
    value->set(u"isFile", Value(std::filesystem::is_regular_file(status)));
    value->set(u"isDirectory", Value(std::filesystem::is_directory(status)));
    resolve(Value(value));
  });
}

inline Task<ArrayObject<Value>*> nativeReadDirectory(std::u16string path) {
  return Task<ArrayObject<Value>*>::create([path = std::move(path)](auto resolve, auto reject) mutable {
    try {
      auto* result = Runtime::array<Value>();
      for (const auto& entry : std::filesystem::directory_iterator(path)) {
        auto* value = Runtime::record();
        value->set(u"name", Value(Runtime::string(entry.path().filename().u16string())));
        value->set(u"isFile", Value(entry.is_regular_file()));
        value->set(u"isDirectory", Value(entry.is_directory()));
        result->append(Value(value));
      }
      resolve(result);
    } catch (const std::exception& error) {
      reject(Error(exceptionText(error)));
    }
  });
}

inline Task<void> nativeCreateDirectory(std::u16string path, bool recursive) {
  return Task<void>::create([path = std::move(path), recursive](auto resolve, auto reject) mutable {
    try {
      if (recursive) std::filesystem::create_directories(path);
      else std::filesystem::create_directory(path);
      resolve();
    } catch (const std::exception& error) {
      reject(Error(exceptionText(error)));
    }
  });
}

inline Task<void> nativeRemovePath(std::u16string path, bool recursive) {
  return Task<void>::create([path = std::move(path), recursive](auto resolve, auto reject) mutable {
    try {
      if (recursive) std::filesystem::remove_all(path);
      else std::filesystem::remove(path);
      resolve();
    } catch (const std::exception& error) {
      reject(Error(exceptionText(error)));
    }
  });
}

inline Task<void> nativeCopyFile(std::u16string source, std::u16string target) {
  return Task<void>::create([source = std::move(source), target = std::move(target)](auto resolve, auto reject) mutable {
    try {
      std::filesystem::copy_file(source, target, std::filesystem::copy_options::overwrite_existing);
      resolve();
    } catch (const std::exception& error) {
      reject(Error(exceptionText(error)));
    }
  });
}

#if defined(_WIN32)
inline std::u16string shellQuote(std::u16string_view value) {
  std::u16string quoted(u"\"");
  std::size_t backslashes = 0;
  for (const char16_t character : value) {
    if (character == u'\\') {
      ++backslashes;
      continue;
    }
    if (character == u'"') {
      quoted.append(backslashes * 2 + 1, u'\\');
      quoted += character;
      backslashes = 0;
      continue;
    }
    quoted.append(backslashes, u'\\');
    backslashes = 0;
    quoted += character;
  }
  quoted.append(backslashes * 2, u'\\');
  quoted += u'"';
  return quoted;
}
#else
inline std::u16string shellQuote(std::u16string_view value) {
  std::u16string quoted(u"'");
  for (const char16_t character : value) {
    if (character == u'\'') quoted += u"'\\''";
    else quoted += character;
  }
  quoted += u'\'';
  return quoted;
}
#endif

inline Task<Value> nativeRunCommandCapture(
    std::u16string command,
    ArrayObject<std::u16string>* arguments,
    std::u16string workingDirectory) {
  std::vector<std::u16string> copiedArguments;
  copiedArguments.reserve(arguments ? arguments->size() : 0);
  if (arguments) {
    for (std::size_t index = 0; index < arguments->size(); ++index) {
      copiedArguments.push_back(arguments->get(index));
    }
  }
  auto operation = std::async(std::launch::async, [
      command = std::move(command),
      arguments = std::move(copiedArguments),
      workingDirectory = std::move(workingDirectory)] {
    std::u16string shellCommand;
#if defined(_WIN32)
    if (!workingDirectory.empty()) shellCommand = u"cd /d " + shellQuote(workingDirectory) + u" && ";
#else
    if (!workingDirectory.empty()) shellCommand = u"cd " + shellQuote(workingDirectory) + u" && ";
#endif
    shellCommand += shellQuote(command);
    for (const auto& argument : arguments) shellCommand += u" " + shellQuote(argument);
    shellCommand += u" 2>&1";
    return runShellCommand(shellCommand);
  }).share();
  return Task<Value>::create([operation = std::move(operation)](auto resolve, auto reject) mutable {
    Runtime::enqueueIo([operation = std::move(operation), resolve, reject]() mutable {
      if (operation.wait_for(std::chrono::seconds(0)) != std::future_status::ready) return false;
      try {
        auto result = operation.get();
        auto* value = Runtime::record();
        value->set(u"code", Value(static_cast<double>(result.code)));
        value->set(u"stdout", Runtime::string(result.output));
        value->set(u"stderr", Runtime::string(u""));
        resolve(Value(value));
      } catch (const std::exception& error) {
        reject(Error(exceptionText(error)));
      }
      return true;
    });
  });
}

template <typename T>
inline void nativeRunTask(const Task<T>& task) {
  static_cast<void>(task.get());
}

inline void nativeRunTask(const Task<void>& task) {
  task.get();
}

inline std::u16string nativeEnvironmentVariable(const std::u16string& name) {
  const auto value = environmentVariable(name);
  return value.value_or(u"");
}

inline std::u16string nativeRuntimeRoot() {
  std::error_code error;
  auto path = std::filesystem::path(__FILE__).parent_path();
  if (path.is_relative()) path = std::filesystem::absolute(path, error);
  return path.u16string();
}

inline Task<Value> dynamicImportUnavailable(std::u16string specifier) {
  return Task<Value>::create([specifier = std::move(specifier)](auto, auto reject) mutable {
    reject(Error(u"Dynamic import is not available in native C++: " + specifier));
  });
}

class Process final {
 public:
  Process(
      const std::vector<std::u16string>& arguments,
      const std::vector<std::pair<std::u16string, std::u16string>>& environment)
      : argv(Runtime::array<std::u16string>()), env(Runtime::record()), platform(Runtime::string(
#if defined(_WIN32)
          u"win32"
#elif defined(__APPLE__)
          u"darwin"
#else
          u"linux"
#endif
      ).stringObject()), arch(Runtime::string(
#if defined(__aarch64__) || defined(_M_ARM64)
          u"aarch64"
#elif defined(__x86_64__) || defined(_M_X64)
          u"x86_64"
#elif defined(__i386__) || defined(_M_IX86)
          u"x86"
#else
          u"unknown"
#endif
      ).stringObject()) {
    const std::u16string executable = arguments.empty() ? u"vexa" : arguments.front();
    argv->append(executable);
    argv->append(executable);
    for (std::size_t index = 1; index < arguments.size(); ++index) {
      argv->append(arguments[index]);
    }
    for (const auto& [name, value] : environment) {
      env->set(name, Runtime::string(value));
    }
  }

  std::u16string cwd() const { return currentPathText(); }
  [[noreturn]] void exit(double code = 0) const {
    std::cout.flush();
    std::cerr.flush();
    std::_Exit(static_cast<int>(code));
  }

  cppgc::Persistent<ArrayObject<std::u16string>> argv;
  cppgc::Persistent<RecordObject> env;
  Value platform;
  Value arch;
  double exitCode = 0;
};

inline Process* process = nullptr;

inline ArrayObject<std::u16string>* commandLineArguments() {
  auto* result = Runtime::array<std::u16string>();
  if (!process || !process->argv) return result;
  for (std::size_t index = 2; index < process->argv->size(); ++index) {
    result->append(process->argv->get(index));
  }
  return result;
}

template <typename T>
inline std::u16string toString(const Task<T>&) {
  return u"[object Promise]";
}

template <typename T>
inline T defaultValue() {
  return T{};
}

template <typename T>
inline ArrayObject<T>* arrayWithLength(double length) {
  auto* result = Runtime::array<T>();
  const auto size = static_cast<std::size_t>(std::max(0.0, std::floor(length)));
  for (std::size_t index = 0; index < size; ++index) result->append(defaultValue<T>());
  return result;
}

template <>
inline Value defaultValue<Value>() {
  return Value::undefined();
}

template <typename T>
class Ready final {
 public:
  explicit Ready(T value) : value_(std::move(value)) {}
  T get() const { return value_; }

 private:
  T value_;
};

template <typename T>
struct GeneratorResult final {
  bool done;
  T value;
};

template <typename T, bool Async>
class BasicGenerator final {
 public:
  struct promise_type final {
    class YieldAwaiter final {
     public:
      explicit YieldAwaiter(promise_type& promise) : promise_(&promise) {}

      bool await_ready() const noexcept { return false; }
      void await_suspend(std::coroutine_handle<>) const noexcept {}
      T await_resume() { return promise_->takeInput(); }

     private:
      promise_type* promise_;
    };

    BasicGenerator get_return_object() {
      return BasicGenerator(std::coroutine_handle<promise_type>::from_promise(*this));
    }

    std::suspend_always initial_suspend() const noexcept { return {}; }
    std::suspend_always final_suspend() const noexcept { return {}; }

    YieldAwaiter yield_value(T value) {
      current_.emplace(TaskStorage<T>::store(std::move(value)));
      return YieldAwaiter(*this);
    }

    void return_value(T value) {
      if constexpr (std::is_pointer_v<T>) {
        if (value == nullptr) return;
      }
      returned_.emplace(TaskStorage<T>::store(std::move(value)));
    }

    void unhandled_exception() { error_ = std::current_exception(); }

    T current() const { return TaskStorage<T>::load(*current_); }
    T returned() const {
      return returned_ ? TaskStorage<T>::load(*returned_) : defaultValue<T>();
    }

    void setInput(T value) {
      input_.emplace(TaskStorage<T>::store(std::move(value)));
    }

    T takeInput() const {
      return input_ ? TaskStorage<T>::load(*input_) : defaultValue<T>();
    }

    std::optional<typename TaskStorage<T>::Type> current_;
    std::optional<typename TaskStorage<T>::Type> returned_;
    std::optional<typename TaskStorage<T>::Type> input_;
    std::exception_ptr error_;
  };

  using Handle = std::coroutine_handle<promise_type>;
  using NextResult = std::conditional_t<Async, Ready<GeneratorResult<T>>, GeneratorResult<T>>;

  BasicGenerator() = default;
  explicit BasicGenerator(Handle handle) : handle_(handle) {}
  BasicGenerator(const BasicGenerator&) = delete;
  BasicGenerator& operator=(const BasicGenerator&) = delete;

  BasicGenerator(BasicGenerator&& other) noexcept
      : handle_(std::exchange(other.handle_, {})),
        started_(std::exchange(other.started_, false)) {}

  BasicGenerator& operator=(BasicGenerator&& other) noexcept {
    if (this == &other) return *this;
    if (handle_) handle_.destroy();
    handle_ = std::exchange(other.handle_, {});
    started_ = std::exchange(other.started_, false);
    return *this;
  }

  ~BasicGenerator() {
    if (handle_) handle_.destroy();
  }

  NextResult next() {
    if (started_ && handle_ && !handle_.done()) {
      handle_.promise().setInput(defaultValue<T>());
    }
    return wrapNext(nextImmediate());
  }

  NextResult next(T value) {
    if (started_ && handle_ && !handle_.done()) {
      handle_.promise().setInput(std::move(value));
    }
    return wrapNext(nextImmediate());
  }

  NextResult finish() {
    return finish(defaultValue<T>());
  }

  NextResult finish(T value) {
    if (handle_) {
      handle_.destroy();
      handle_ = {};
    }
    started_ = false;
    return wrapNext({true, std::move(value)});
  }

  NextResult vexa_return() {
    return finish();
  }

  NextResult vexa_return(T value) {
    return finish(std::move(value));
  }

  class Iterator final {
   public:
    explicit Iterator(BasicGenerator* generator) : generator_(generator) { advance(); }

    Iterator& operator++() {
      advance();
      return *this;
    }

    T operator*() const { return result_.value; }
    bool operator!=(std::default_sentinel_t) const { return !result_.done; }

   private:
    void advance() { result_ = generator_->nextImmediate(); }

    BasicGenerator* generator_;
    GeneratorResult<T> result_{true, defaultValue<T>()};
  };

  Iterator begin() { return Iterator(this); }
  std::default_sentinel_t end() const { return {}; }

 private:
  GeneratorResult<T> nextImmediate() {
    if (!handle_ || handle_.done()) {
      return {true, handle_ ? handle_.promise().returned() : defaultValue<T>()};
    }
    started_ = true;
    handle_.resume();
    if (handle_.done()) {
      if (handle_.promise().error_) std::rethrow_exception(handle_.promise().error_);
      return {true, handle_.promise().returned()};
    }
    return {false, handle_.promise().current()};
  }

  NextResult wrapNext(GeneratorResult<T> result) {
    if constexpr (Async) {
      return Ready<GeneratorResult<T>>(std::move(result));
    } else {
      return result;
    }
  }

  Handle handle_;
  bool started_ = false;
};

template <typename T>
using Generator = BasicGenerator<T, false>;

template <typename T>
using AsyncGenerator = BasicGenerator<T, true>;

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

template <typename T, typename U>
inline void appendAll(ArrayObject<T>* target, NativeIteratorObject<U>* source) {
  if (!source) return;
  auto* values = source->toArray();
  appendAll(target, values);
}

template <typename T, typename U>
inline void appendAll(ArrayObject<T>* target, SetObject<U>* source) {
  source->forEach([&](U value) {
    target->append(convertValue<T>(value));
  });
}

inline void appendAll(ArrayObject<std::u16string>* target, const std::u16string& source) {
  target->reserve(target->size() + source.size());
  for (std::size_t index = 0; index < source.size(); ++index) {
    const char16_t first = source[index];
    const bool hasSurrogatePair = first >= 0xD800 && first <= 0xDBFF &&
      index + 1 < source.size() && source[index + 1] >= 0xDC00 && source[index + 1] <= 0xDFFF;
    target->append(source.substr(index, hasSurrogatePair ? 2 : 1));
    if (hasSurrogatePair) ++index;
  }
}

template <typename T>
inline void appendAll(ArrayObject<T>* target, const Value& source) {
    for (const auto value : dynamicIterationRange(source)) {
    target->append(convertValue<T>(value));
  }
}

template <typename T, typename U>
inline double pushAll(ArrayObject<T>* target, const ArrayObject<U>* source) {
  if (source) {
    for (std::size_t index = 0; index < source->size(); ++index) {
      target->append(convertValue<T>(source->get(index)));
    }
  }
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

template <typename T>
inline void appendAllConverted(ArrayObject<Value>* target, NativeIteratorObject<T>* source) {
  if (!source) return;
  auto* values = source->toArray();
  appendAllConverted(target, values);
}

inline void appendAllConverted(ArrayObject<Value>* target, const std::u16string& source) {
  target->reserve(target->size() + source.size());
  for (std::size_t index = 0; index < source.size(); ++index) {
    const char16_t first = source[index];
    const bool hasSurrogatePair = first >= 0xD800 && first <= 0xDBFF &&
      index + 1 < source.size() && source[index + 1] >= 0xDC00 && source[index + 1] <= 0xDFFF;
    target->append(Runtime::string(source.substr(index, hasSurrogatePair ? 2 : 1)));
    if (hasSurrogatePair) ++index;
  }
}

template <typename K, typename V>
inline void appendAllConverted(ArrayObject<Value>* target, MapObject<K, V>* source) {
  source->forEach([&](V value, K key) {
    target->append(convertValue<Value>(Runtime::array<Value>({
        convertValue<Value>(key),
        convertValue<Value>(value)})));
  });
}

template <typename K, typename V>
inline void appendAllConverted(
    ArrayObject<Value>* target,
    const cppgc::Persistent<MapObject<K, V>>& source) {
  appendAllConverted(target, source.Get());
}

template <typename T>
inline void appendAllConverted(ArrayObject<Value>* target, SetObject<T>* source) {
  source->forEach([&](T value) { target->append(convertValue<Value>(value)); });
}

template <typename T>
inline void appendAllConverted(
    ArrayObject<Value>* target,
    const cppgc::Persistent<SetObject<T>>& source) {
  appendAllConverted(target, source.Get());
}

inline void appendAllConverted(ArrayObject<Value>* target, const Value& source) {
  for (const auto value : dynamicIterationRange(source)) {
    target->append(value);
  }
}

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
template <typename Index>
inline T ArrayObject<T>::at(Index index) const {
  const double numericIndex = convertValue<double>(std::forward<Index>(index));
  const auto integer = static_cast<std::int64_t>(numericIndex);
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

inline std::size_t normalizedSliceIndex(double index, std::size_t size) {
  const auto integer = static_cast<std::int64_t>(index);
  if (integer < 0) return static_cast<std::size_t>(std::max<std::int64_t>(0, static_cast<std::int64_t>(size) + integer));
  return std::min<std::size_t>(static_cast<std::size_t>(integer), size);
}

template <typename T>
inline std::vector<T> slice(const std::vector<T>& array, double start = 0, double end = std::numeric_limits<double>::infinity()) {
  const std::size_t first = normalizedSliceIndex(start, array.size());
  const std::size_t last = std::isinf(end) ? array.size() : normalizedSliceIndex(end, array.size());
  if (last <= first) return {};
  return std::vector<T>(array.begin() + static_cast<std::ptrdiff_t>(first), array.begin() + static_cast<std::ptrdiff_t>(last));
}

template <typename T>
template <typename Start, typename End>
inline ArrayObject<T>* ArrayObject<T>::slice(Start start, End end) const {
  const double numericStart = convertValue<double>(std::forward<Start>(start));
  const double numericEnd = convertValue<double>(std::forward<End>(end));
  auto* result = Runtime::array<T>();
  const std::size_t first = normalizedSliceIndex(numericStart, size());
  const std::size_t last = std::isinf(numericEnd) ? size() : normalizedSliceIndex(numericEnd, size());
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

template <typename T, typename Value>
inline void appendConcatItem(ArrayObject<T>* result, Value&& value) {
  result->append(convertValue<T>(std::forward<Value>(value)));
}

template <typename T, typename U>
inline void appendConcatItem(ArrayObject<T>* result, const ArrayObject<U>* values) {
  if (!values) return;
  for (const auto& value : *values) result->append(convertValue<T>(value));
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

template <typename MemberFunction>
struct CallableFirstArgumentFromMemberFunction {};

template <typename Result, typename Owner>
struct CallableFirstArgumentFromMemberFunction<Result (Owner::*)() const> {};

template <typename Result, typename Owner, typename First, typename... Arguments>
struct CallableFirstArgumentFromMemberFunction<Result (Owner::*)(First, Arguments...) const> {
  using type = std::remove_cvref_t<First>;
};

template <typename Result, typename Owner>
struct CallableFirstArgumentFromMemberFunction<Result (Owner::*)()> {};

template <typename Result, typename Owner, typename First, typename... Arguments>
struct CallableFirstArgumentFromMemberFunction<Result (Owner::*)(First, Arguments...)> {
  using type = std::remove_cvref_t<First>;
};

template <typename Callable, typename = void>
struct CallableFirstArgumentFromObject {};

template <typename Callable>
struct CallableFirstArgumentFromObject<
    Callable,
    std::void_t<decltype(&Callable::operator())>>
    : CallableFirstArgumentFromMemberFunction<decltype(&Callable::operator())> {};

template <typename Callable>
struct CallableArgumentTypes {};

template <typename Result, typename First, typename... Arguments>
struct CallableArgumentTypes<std::function<Result(First, Arguments...)>> {
  using FirstArgument = std::remove_cvref_t<First>;
};

template <typename Target, typename Source>
cppgc::Persistent<ArrayObject<Target>> convertedCallbackArray(
    const ArrayObject<Source>* source) {
  cppgc::Persistent<ArrayObject<Target>> result(Runtime::array<Target>());
  if (!source) return result;
  for (std::size_t index = 0; index < source->size(); ++index) {
    result->append(convertValue<Target>(source->get(index)));
  }
  return result;
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
    using CallableTypes = CallableArgumentTypes<std::remove_cvref_t<Callback>>;
    if constexpr (requires { typename CallableTypes::FirstArgument; }) {
      using FirstArgument = typename CallableTypes::FirstArgument;
      if constexpr (std::is_invocable_v<Callback, FirstArgument, double, ArrayObject<FirstArgument>*>) {
        auto convertedArray = convertedCallbackArray<FirstArgument>(array);
        return callback(
            convertValue<FirstArgument>(value),
            static_cast<double>(index),
            convertedArray.Get());
      } else if constexpr (std::is_invocable_v<Callback, FirstArgument, double>) {
        return callback(convertValue<FirstArgument>(value), static_cast<double>(index));
      } else if constexpr (std::is_invocable_v<Callback, FirstArgument>) {
        return callback(convertValue<FirstArgument>(value));
      } else {
        return callback();
      }
    } else if constexpr (requires { typename CallableFirstArgumentFromObject<Callback>::type; }) {
      using FirstArgument = typename CallableFirstArgumentFromObject<Callback>::type;
      if constexpr (std::is_invocable_v<Callback, FirstArgument>) {
        if constexpr (std::is_pointer_v<FirstArgument> && std::is_same_v<T, Value>) {
          return callback(toInstanceOrNull<FirstArgument>(value));
        } else {
          return callback(convertValue<FirstArgument>(value));
        }
      } else {
        return callback();
      }
    } else {
      return callback();
    }
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

inline bool arrayCallbackBoolean(const Value& value) {
  if (value.isUndefined() || value.isNull()) return false;
  if (value.isBoolean()) return value.boolean();
  if (value.isNumber()) return value.number() != 0 && !std::isnan(value.number());
  return !value.isString() || !value.utf16().empty();
}

inline bool arrayCallbackBoolean(const std::u16string& value) { return !value.empty(); }

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

template <typename Target, typename Source>
inline ArrayObject<Target>* convertArray(const ArrayObject<Source>* source) {
  if (!source) return nullptr;
  if constexpr (std::is_same_v<Target, Source>) return const_cast<ArrayObject<Target>*>(source);
  auto* result = Runtime::array<Target>();
  result->reserve(source->size());
  for (const auto& value : *source) result->append(convertValue<Target>(value));
  return result;
}

template <typename Target, typename Source>
inline ArrayObject<Target>* convertArray(NativeIteratorObject<Source>* source) {
  if (!source) return nullptr;
  auto* result = Runtime::array<Target>();
  for (auto& value : source->takeRemaining()) result->append(convertValue<Target>(value));
  return result;
}

template <typename Target, typename Source>
inline ArrayObject<Target>* convertArray(const cppgc::Member<ArrayObject<Source>>& source) {
  return convertArray<Target>(source.Get());
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
struct ArrayPointerElement<ArrayObject<T>*> final {
  using Type = T;
};

template <typename T>
struct IsArrayPointer : std::false_type {};

template <typename T>
struct IsArrayPointer<ArrayObject<T>*> : std::true_type {};

template <>
struct ArrayPointerElement<Value> final {
  using Type = Value;
};

template <typename T, typename Callback>
inline auto flatMap(const ArrayObject<T>* array, Callback callback) {
  using NestedArray = std::remove_cvref_t<decltype(
      invokeArrayCallback(callback, std::declval<T>(), std::size_t{}, array))>;
  using Result = typename ArrayPointerElement<NestedArray>::Type;
  auto* result = Runtime::array<Result>();
  for (std::size_t index = 0; index < array->size(); ++index) {
    NestedArray nested = invokeArrayCallback(callback, array->get(index), index, array);
    if constexpr (std::is_same_v<NestedArray, Value>) {
      if (nested.isRuntimeObject() && nested.object()->dynamicIsArray()) {
        for (std::size_t nestedIndex = 0; nestedIndex < nested.object()->dynamicArraySize(); ++nestedIndex) {
          result->append(convertValue<Result>(nested.object()->dynamicArrayGet(nestedIndex)));
        }
      } else {
        result->append(convertValue<Result>(nested));
      }
    } else if constexpr (IsArrayPointer<NestedArray>::value) {
      if (nested) appendAll(result, nested);
    } else {
      result->append(convertValue<Result>(nested));
    }
  }
  return result;
}

template <typename T>
template <typename Depth>
inline auto ArrayObject<T>::flat(Depth depth) const {
  return vexa::flat(this, convertValue<double>(std::forward<Depth>(depth)));
}

template <typename T>
template <typename Callback>
inline auto ArrayObject<T>::flatMap(Callback callback) const {
  return vexa::flatMap(this, std::move(callback));
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
    const std::size_t current = index - 1;
    if (arrayCallbackBoolean(invokeArrayCallback(callback, get(current), current, this))) {
      return static_cast<double>(current);
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
    const std::size_t current = index - 1;
    const auto value = get(current);
    if (arrayCallbackBoolean(invokeArrayCallback(callback, value, current, this))) return value;
  }
  return T{};
}

template <typename T, typename Callback>
inline T findLast(const ArrayObject<T>* array, Callback callback) {
  return array->findLast(std::move(callback));
}

template <typename T>
template <typename Start, typename DeleteCount, typename... Items>
inline ArrayObject<T>* ArrayObject<T>::splice(
    Start start,
    DeleteCount deleteCount,
    Items&&... items) {
  const double numericStart = convertValue<double>(std::forward<Start>(start));
  const double numericDeleteCount = convertValue<double>(std::forward<DeleteCount>(deleteCount));
  const std::size_t first = normalizedSliceIndex(numericStart, size());
  const std::size_t requested = std::isinf(numericDeleteCount)
      ? size() - first
      : static_cast<std::size_t>(std::max(0.0, std::trunc(numericDeleteCount)));
  const std::size_t count = std::min(requested, size() - first);
  auto* removed = Runtime::array<T>();
  for (std::size_t index = 0; index < count; ++index) removed->append(get(first + index));
  values_.erase(
      values_.begin() + static_cast<std::ptrdiff_t>(first),
      values_.begin() + static_cast<std::ptrdiff_t>(first + count));
  std::vector<ArraySlot<T>> inserted{
      ArraySlot<T>(convertValue<T>(std::forward<Items>(items)))...};
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
template <typename Value, typename Start, typename End>
inline ArrayObject<T>* ArrayObject<T>::fill(Value&& value, Start start, End end) {
  const T convertedValue = convertValue<T>(std::forward<Value>(value));
  const double numericStart = convertValue<double>(std::forward<Start>(start));
  const double numericEnd = convertValue<double>(std::forward<End>(end));
  const std::size_t first = normalizedSliceIndex(numericStart, size());
  const std::size_t last = std::isinf(numericEnd) ? size() : normalizedSliceIndex(numericEnd, size());
  for (std::size_t index = first; index < last; ++index) set(index, convertedValue);
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
template <typename Target, typename Start, typename End>
inline ArrayObject<T>* ArrayObject<T>::copyWithin(Target target, Start start, End end) {
  const double numericTarget = convertValue<double>(std::forward<Target>(target));
  const double numericStart = convertValue<double>(std::forward<Start>(start));
  const double numericEnd = convertValue<double>(std::forward<End>(end));
  const std::size_t destination = normalizedSliceIndex(numericTarget, size());
  const std::size_t first = normalizedSliceIndex(numericStart, size());
  const std::size_t last = std::isinf(numericEnd) ? size() : normalizedSliceIndex(numericEnd, size());
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
inline ArrayObject<T>* ArrayObject<T>::toReversed() const {
  auto* result = slice();
  result->reverse();
  return result;
}

template <typename T>
inline ArrayObject<T>* toReversed(const ArrayObject<T>* array) {
  return array->toReversed();
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

inline std::u16string numberToString(double value) {
  if (std::isnan(value)) return u"NaN";
  if (std::isinf(value)) return value < 0 ? u"-Infinity" : u"Infinity";
  if (value == 0) return u"0";
  return formatNumberText(value);
}

inline std::u16string numberToString(double value, double radix) {
  if (!std::isfinite(radix) || std::trunc(radix) != radix || radix < 2 || radix > 36) {
    throw runtimeError(u"Number.toString radix must be an integer between 2 and 36");
  }
  if (!std::isfinite(value) || value == 0 || std::trunc(value) != value) {
    return numberToString(value);
  }

  const auto base = static_cast<std::uint32_t>(radix);
  const bool negative = value < 0;
  const long double magnitude = std::abs(static_cast<long double>(value));
  if (magnitude > static_cast<long double>(std::numeric_limits<std::uint64_t>::max())) {
    return numberToString(value);
  }
  auto remaining = static_cast<std::uint64_t>(magnitude);
  static constexpr char16_t digits[] = u"0123456789abcdefghijklmnopqrstuvwxyz";
  std::u16string result;
  do {
    result.insert(result.begin(), digits[remaining % base]);
    remaining /= base;
  } while (remaining != 0);
  if (negative) result.insert(result.begin(), u'-');
  return result;
}

inline std::u16string toString(const Value& value) {
  if (value.isUndefined()) return u"undefined";
  if (value.isNull()) return u"null";
  if (value.isBoolean()) return value.boolean() ? u"true" : u"false";
  if (value.isNumber()) return numberToString(value.number());
  if (value.isBigInt()) return value.bigint().toString();
  if (value.isString()) return value.string();
  if (value.isRuntimeObject()) return value.object()->dynamicToString();
  return u"[object Object]";
}

inline std::u16string toString(const Value& value, double radix) {
  return value.isNumber() ? numberToString(value.number(), radix) : toString(value);
}

inline std::u16string toString(const BigInt& value) { return value.toString(); }

inline std::u16string toString(double value) { return numberToString(value); }
inline std::u16string toString(double value, double radix) { return numberToString(value, radix); }
inline std::u16string toString(int value) { return formatIntegerText(value); }
inline std::u16string toString(int value, double radix) { return numberToString(static_cast<double>(value), radix); }
inline std::u16string toString(std::int64_t value) { return formatIntegerText(value); }
inline std::u16string toString(std::int64_t value, double radix) { return numberToString(static_cast<double>(value), radix); }
inline std::u16string toString(bool value) { return value ? u"true" : u"false"; }
inline const std::u16string& toString(const std::u16string& value) { return value; }

inline BigInt makeBigInt(const BigInt& value) { return value; }
inline BigInt makeBigInt(bool value) { return BigInt(value ? 1 : 0); }
inline BigInt makeBigInt(std::int32_t value) { return BigInt(value); }
inline BigInt makeBigInt(std::int64_t value) { return BigInt(static_cast<long long>(value)); }
inline BigInt makeBigInt(double value) {
  if (!std::isfinite(value) || std::trunc(value) != value) {
    throw runtimeError(u"Cannot convert a non-integer number to BigInt");
  }
  return BigInt(formatFixedText(value, 0));
}
inline BigInt makeBigInt(const std::u16string& value) { return BigInt(value); }
inline BigInt makeBigInt(const Value& value) {
  if (value.isBigInt()) return value.bigint();
  if (value.isBoolean()) return makeBigInt(value.boolean());
  if (value.isNumber()) return makeBigInt(value.number());
  if (value.isString()) return makeBigInt(value.string());
  throw runtimeError(u"Cannot convert value to BigInt");
}

template <typename T>
inline std::u16string toString(ArrayObject<T>* array);

[[noreturn]] inline void throwValue(const Error& error) {
  throw RejectedValue(Runtime::string(error.messageText()));
}

[[noreturn]] inline void throwValue(const Value& value) { throw RejectedValue(value); }

template <typename T>
  requires std::is_base_of_v<BaseObject, T>
[[noreturn]] inline void throwValue(T* value) {
  throw RejectedValue(Value(value));
}

template <typename T>
[[noreturn]] inline void throwValue(const T& value) {
  throw runtimeError(toString(value));
}

template <typename Result>
Task<typename PromiseResult<Result>::Type> assimilateTask(Task<Result> task) {
  if constexpr (PromiseResult<Result>::task) {
    auto nested = co_await task;
    if constexpr (std::is_void_v<typename PromiseResult<Result>::Type>) {
      co_await assimilateTask(std::move(nested));
      co_return;
    } else {
      co_return co_await assimilateTask(std::move(nested));
    }
  } else if constexpr (std::is_void_v<Result>) {
    co_await task;
    co_return;
  } else {
    co_return co_await task;
  }
}

template <typename Input>
Task<std::remove_cvref_t<Input>> resolvedTask(Input value) {
  co_return std::move(value);
}

template <typename Input>
Task<std::remove_cvref_t<Input>> promiseResolve(Input value) {
  co_return std::move(value);
}

template <typename Result>
Task<typename PromiseResult<Result>::Type> promiseResolve(Task<Result> task) {
  if constexpr (std::is_void_v<typename PromiseResult<Result>::Type>) {
    co_await assimilateTask(std::move(task));
    co_return;
  } else {
    co_return co_await assimilateTask(std::move(task));
  }
}

template <typename Callback, typename... Arguments>
Task<typename PromiseResult<std::invoke_result_t<Callback, Arguments...>>::Type> promiseTry(
    Callback callback,
    Arguments... arguments) {
  using CallbackResult = std::invoke_result_t<Callback, Arguments...>;
  using Result = typename PromiseResult<CallbackResult>::Type;
  if constexpr (PromiseResult<CallbackResult>::task) {
    if constexpr (std::is_void_v<Result>) {
      co_await assimilateTask(callback(std::move(arguments)...));
      co_return;
    } else {
      co_return co_await assimilateTask(callback(std::move(arguments)...));
    }
  } else if constexpr (std::is_void_v<CallbackResult>) {
    callback(std::move(arguments)...);
    co_return;
  } else {
    co_return callback(std::move(arguments)...);
  }
}

template <typename Result, typename Reason>
Task<Result> rejectedTask(const Reason& reason) {
  throwValue(reason);
  co_return defaultValue<Result>();
}

template <typename T>
Task<ArrayObject<T>*> promiseAll(ArrayObject<Task<T>>* tasks) {
  cppgc::Persistent<ArrayObject<Task<T>>> rootedTasks(tasks);
  auto* values = Runtime::array<T>();
  cppgc::Persistent<ArrayObject<T>> rootedValues(values);
  for (auto task : *tasks) values->append(co_await task);
  co_return values;
}

template <typename T>
Task<T> promiseRace(ArrayObject<Task<T>>* tasks) {
  cppgc::Persistent<ArrayObject<Task<T>>> rootedTasks(tasks);
  return Task<T>::create([rootedTasks](auto resolve, auto reject) mutable {
    for (std::size_t index = 0; index < rootedTasks->size(); ++index) {
      Task<T> task = rootedTasks->get(index);
      task.whenSettled([task, resolve, reject]() mutable {
        try {
          resolve(task.settledValue());
        } catch (const RejectedValue& rejected) {
          reject(rejected.reason());
        } catch (const std::exception& error) {
          reject(Error(exceptionText(error)));
        }
      });
    }
  });
}

template <typename T>
Task<ArrayObject<RecordObject*>*> promiseAllSettled(
    ArrayObject<Task<T>>* tasks) {
  cppgc::Persistent<ArrayObject<Task<T>>> rootedTasks(tasks);
  cppgc::Persistent<ArrayObject<RecordObject*>> rootedResults(Runtime::array<RecordObject*>());
  return Task<ArrayObject<RecordObject*>*>::create(
      [rootedTasks, rootedResults](auto resolve, auto) mutable {
        const std::size_t count = rootedTasks->size();
        if (count == 0) {
          resolve(rootedResults.Get());
          return;
        }
        auto completed = std::make_shared<std::size_t>(0);
        for (std::size_t index = 0; index < count; ++index) {
          Task<T> task = rootedTasks->get(index);
          task.whenSettled([task, index, count, completed, rootedResults, resolve]() mutable {
            RecordObject* result = nullptr;
            try {
              result = Runtime::record({
                  {u"status", Runtime::string(u"fulfilled")},
                  {u"value", convertValue<Value>(task.settledValue())},
              });
            } catch (const RejectedValue& rejected) {
              result = Runtime::record({
                  {u"status", Runtime::string(u"rejected")},
                  {u"reason", rejected.reason()},
              });
            } catch (const std::exception& error) {
              result = Runtime::record({
                  {u"status", Runtime::string(u"rejected")},
                  {u"reason", Runtime::string(exceptionText(error))},
              });
            }
            rootedResults->set(index, result);
            *completed += 1;
            if (*completed == count) resolve(rootedResults.Get());
          });
        }
      });
}

template <typename T>
Task<T> promiseAny(ArrayObject<Task<T>>* tasks) {
  cppgc::Persistent<ArrayObject<Task<T>>> rootedTasks(tasks);
  return Task<T>::create([rootedTasks](auto resolve, auto reject) mutable {
    const std::size_t count = rootedTasks->size();
    if (count == 0) {
      reject(Error(std::u16string(u"All promises were rejected")));
      return;
    }
    auto rejected = std::make_shared<std::size_t>(0);
    for (std::size_t index = 0; index < count; ++index) {
      Task<T> task = rootedTasks->get(index);
      task.whenSettled([task, count, rejected, resolve, reject]() mutable {
        try {
          resolve(task.settledValue());
        } catch (...) {
          *rejected += 1;
          if (*rejected == count) reject(Error(std::u16string(u"All promises were rejected")));
        }
      });
    }
  });
}

template <typename T, typename Callback>
Task<typename PromiseResult<std::invoke_result_t<Callback, T>>::Type> promiseThen(
    Task<T> source,
    Callback callback) {
  using CallbackResult = std::invoke_result_t<Callback, T>;
  using Result = typename PromiseResult<CallbackResult>::Type;
  T value = co_await source;
  if constexpr (PromiseResult<CallbackResult>::task) {
    if constexpr (std::is_void_v<Result>) {
      co_await assimilateTask(callback(std::move(value)));
      co_return;
    } else {
      co_return co_await assimilateTask(callback(std::move(value)));
    }
  } else if constexpr (std::is_void_v<CallbackResult>) {
    callback(std::move(value));
    co_return;
  } else {
    co_return callback(std::move(value));
  }
}

template <typename Callback>
Task<typename PromiseResult<std::invoke_result_t<Callback>>::Type> promiseThen(
    Task<void> source,
    Callback callback) {
  using CallbackResult = std::invoke_result_t<Callback>;
  using Result = typename PromiseResult<CallbackResult>::Type;
  co_await source;
  if constexpr (PromiseResult<CallbackResult>::task) {
    if constexpr (std::is_void_v<Result>) {
      co_await assimilateTask(callback());
      co_return;
    } else {
      co_return co_await assimilateTask(callback());
    }
  } else if constexpr (std::is_void_v<CallbackResult>) {
    callback();
    co_return;
  } else {
    co_return callback();
  }
}

template <typename T, typename Callback>
Task<T> promiseCatch(Task<T> source, Callback callback) {
  Value reason = Value::undefined();
  try {
    co_return co_await source;
  } catch (const RejectedValue& rejected) {
    reason = rejected.reason();
  } catch (const std::exception& error) {
    reason = Runtime::string(exceptionText(error));
  }
  using CallbackResult = std::invoke_result_t<Callback, Value>;
  if constexpr (PromiseResult<CallbackResult>::task) {
    co_return co_await assimilateTask(callback(reason));
  } else {
    co_return callback(reason);
  }
}

template <typename T, typename Callback>
Task<T> promiseFinally(Task<T> source, Callback callback) {
  std::optional<typename TaskStorage<T>::Type> value;
  std::exception_ptr error;
  try {
    value.emplace(TaskStorage<T>::store(co_await source));
  } catch (...) {
    error = std::current_exception();
  }
  using CallbackResult = std::invoke_result_t<Callback>;
  if constexpr (PromiseResult<CallbackResult>::task) co_await callback();
  else callback();
  if (error) std::rethrow_exception(error);
  co_return TaskStorage<T>::load(*value);
}

inline std::u16string concatText(std::initializer_list<std::u16string_view> parts) {
  std::size_t size = 0;
  for (const auto part : parts) size += part.size();
  std::u16string result;
  result.reserve(size);
  for (const auto part : parts) result.append(part);
  return result;
}

template <typename T, typename Callback, typename Separator>
inline std::u16string mapJoin(
    const ArrayObject<T>* array,
    Callback callback,
    Separator&& rawSeparator) {
  const std::u16string separator = toString(std::forward<Separator>(rawSeparator));
  std::vector<std::u16string> parts;
  parts.reserve(array->size());
  std::size_t resultSize = array->size() > 0 ? separator.size() * (array->size() - 1) : 0;
  for (std::size_t index = 0; index < array->size(); ++index) {
    parts.push_back(toString(invokeArrayCallback(callback, array->get(index), index, array)));
    resultSize += parts.back().size();
  }
  std::u16string result;
  result.reserve(resultSize);
  for (std::size_t index = 0; index < parts.size(); ++index) {
    if (index > 0) result += separator;
    result += parts[index];
  }
  return result;
}

template <typename T>
inline std::u16string joinWithSeparator(const std::vector<T>& array, const std::u16string& separator) {
  std::u16string output;
  for (std::size_t index = 0; index < array.size(); ++index) {
    if (index > 0) output += separator;
    output += toString(array[index]);
  }
  return output;
}

template <typename T>
inline std::u16string joinWithSeparator(const ArrayObject<T>* array, const std::u16string& separator) {
  std::u16string output;
  for (std::size_t index = 0; index < array->size(); ++index) {
    if (index > 0) output += separator;
    output += toString(array->get(index));
  }
  return output;
}

template <typename T>
template <typename Separator>
inline std::u16string ArrayObject<T>::join(Separator&& separator) const {
  const std::u16string text = convertValue<std::u16string>(std::forward<Separator>(separator));
  if constexpr (std::is_same_v<T, std::u16string>) {
    if (!dynamic_backing_) {
      if (values_.empty()) return {};
      std::size_t outputSize = text.size() * (values_.size() - 1);
      for (const auto& value : values_) outputSize += value.loadRef().size();
      std::u16string output;
      output.reserve(outputSize);
      for (std::size_t index = 0; index < values_.size(); ++index) {
        if (index > 0) output += text;
        output += values_[index].loadRef();
      }
      return output;
    }
  }
  return joinWithSeparator(this, text);
}

template <typename T>
inline std::u16string join(const std::vector<T>& array) {
  return joinWithSeparator(array, u",");
}

template <typename T>
inline std::u16string join(const ArrayObject<T>* array) {
  return array->join();
}

inline std::u16string join(const std::vector<std::u16string>& array, const std::u16string& separator) {
  if (array.empty()) return std::u16string();
  std::size_t size = separator.size() * (array.size() - 1);
  for (const auto& value : array) size += value.size();
  std::u16string result;
  result.reserve(size);
  for (std::size_t index = 0; index < array.size(); ++index) {
    if (index > 0) result += separator;
    result += array[index];
  }
  return result;
}

inline std::u16string join(const ArrayObject<std::u16string>* array, const std::u16string& separator) {
  return array ? array->join(separator) : std::u16string();
}

template <typename T, typename Separator>
inline std::u16string join(const std::vector<T>& array, const Separator& separator) {
  return joinWithSeparator(array, toString(separator));
}

template <typename T, typename Separator>
inline std::u16string join(const ArrayObject<T>* array, const Separator& separator) {
  return array->join(toString(separator));
}

template <typename T>
inline std::u16string ArrayObject<T>::toString() const {
  return std::u16string(u"[") + join(u", ") + u"]";
}

template <typename T>
inline ArrayObject<T>* ArrayObject<T>::sort() {
  std::vector<T> sorted;
  sorted.reserve(size());
  for (std::size_t index = 0; index < size(); ++index) sorted.push_back(get(index));
  std::stable_sort(sorted.begin(), sorted.end(), [](const T& left, const T& right) {
    return vexa::toString(left) < vexa::toString(right);
  });
  for (std::size_t index = 0; index < sorted.size(); ++index) {
    values_[index].store(std::move(sorted[index]));
  }
  return this;
}

template <typename T>
inline ArrayObject<T>* sort(ArrayObject<T>* array) {
  return array->sort();
}

template <typename T>
inline ArrayObject<T>* ArrayObject<T>::toSorted() const {
  auto* result = slice();
  result->sort();
  return result;
}

template <typename T, typename Callback>
inline ArrayObject<T>* toSorted(const ArrayObject<T>* array, Callback callback) {
  auto* result = array->slice();
  result->sort(std::move(callback));
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

template <typename T>
template <typename Start, typename DeleteCount, typename... Items>
inline ArrayObject<T>* ArrayObject<T>::toSpliced(
    Start start,
    DeleteCount deleteCount,
    Items&&... items) const {
  auto* result = slice();
  result->splice(start, deleteCount, std::forward<Items>(items)...);
  return result;
}

template <typename T, typename... Items>
inline ArrayObject<T>* toSpliced(
    const ArrayObject<T>* array,
    double start,
    double deleteCount = std::numeric_limits<double>::infinity(),
    Items&&... items) {
  return array->toSpliced(start, deleteCount, std::forward<Items>(items)...);
}

template <typename T>
template <typename Index, typename Value>
inline ArrayObject<T>* ArrayObject<T>::with(Index index, Value&& value) const {
  const double numericIndex = convertValue<double>(std::forward<Index>(index));
  const T convertedValue = convertValue<T>(std::forward<Value>(value));
  const auto integer = static_cast<std::int64_t>(std::trunc(numericIndex));
  const auto resolved = integer < 0 ? static_cast<std::int64_t>(size()) + integer : integer;
  if (resolved < 0 || resolved >= static_cast<std::int64_t>(size())) {
    throw runtimeError(u"Array.prototype.with index is out of range");
  }
  auto* result = slice();
  result->set(static_cast<std::size_t>(resolved), convertedValue);
  return result;
}

template <typename T>
inline ArrayObject<T>* with(const ArrayObject<T>* array, double index, T value) {
  return array->with(index, std::move(value));
}

template <typename T>
inline std::u16string toString(ArrayObject<T>* array) {
  return array ? array->toString() : u"null";
}

template <typename T>
inline std::u16string toString(const cppgc::Member<ArrayObject<T>>& array) {
  return toString(array.Get());
}

template <typename T>
inline std::u16string toString(const cppgc::Persistent<ArrayObject<T>>& array) {
  return toString(array.Get());
}

inline std::u16string jsonQuoted(const std::u16string& value) {
  static constexpr char16_t hex[] = u"0123456789abcdef";
  std::u16string output = u"\"";
  for (const char16_t character : value) {
    switch (character) {
      case u'"': output += u"\\\""; break;
      case u'\\': output += u"\\\\"; break;
      case u'\b': output += u"\\b"; break;
      case u'\f': output += u"\\f"; break;
      case u'\n': output += u"\\n"; break;
      case u'\r': output += u"\\r"; break;
      case u'\t': output += u"\\t"; break;
      default:
        if (character < 0x20) {
          output += u"\\u";
          output += hex[(character >> 12) & 0x0f];
          output += hex[(character >> 8) & 0x0f];
          output += hex[(character >> 4) & 0x0f];
          output += hex[character & 0x0f];
        } else {
          output += character;
        }
    }
  }
  output += u'"';
  return output;
}

template <typename T>
std::u16string jsonStringifyNative(const T& value, std::unordered_set<const void*>& seen) {
  using Native = std::remove_cvref_t<T>;
  if constexpr (std::is_same_v<Native, Value>) {
    if (value.isUndefined()) return u"null";
    if (value.isNull()) return u"null";
    if (value.isBoolean()) return value.boolean() ? u"true" : u"false";
    if (value.isNumber()) return numberToString(value.number());
    if (value.isBigInt()) throw runtimeError(u"Do not know how to serialize a BigInt");
    if (value.isString()) return jsonQuoted(value.string());
    if (value.isRecord()) {
      auto* record = value.record();
      if (!seen.insert(record).second) throw runtimeError(u"Converting circular structure to JSON");
      std::u16string output = u"{";
      bool first = true;
      for (const auto& key : record->keys()) {
        const Value property = record->get(key);
        if (property.isUndefined() || (property.isRuntimeObject() && property.object()->dynamicToString() == u"function")) {
          continue;
        }
        if (!first) output += u',';
        first = false;
        output += jsonQuoted(key);
        output += u':';
        output += jsonStringifyNative(property, seen);
      }
      output += u'}';
      seen.erase(record);
      return output;
    }
    auto serialized = value.object()->dynamicJsonStringify(seen);
    return serialized.value_or(u"{}");
  } else if constexpr (std::is_same_v<Native, std::u16string>) {
    return jsonQuoted(value);
  } else if constexpr (std::is_same_v<Native, BigInt>) {
    throw runtimeError(u"Do not know how to serialize a BigInt");
  } else if constexpr (std::is_same_v<Native, bool>) {
    return value ? u"true" : u"false";
  } else if constexpr (std::is_arithmetic_v<Native>) {
    return numberToString(static_cast<double>(value));
  } else if constexpr (std::is_pointer_v<Native>) {
    if (!value) return u"null";
    if constexpr (std::is_base_of_v<BaseObject, std::remove_pointer_t<Native>>) {
      return value->dynamicJsonStringify(seen).value_or(u"{}");
    } else {
      return u"{}";
    }
  } else {
    return u"{}";
  }
}

inline Value jsonStringify(const Value& value) {
  if (value.isUndefined() || (value.isRuntimeObject() && value.object()->dynamicToString() == u"function")) {
    return Value::undefined();
  }
  std::unordered_set<const void*> seen;
  return Runtime::string(jsonStringifyNative(value, seen));
}

class JsonParser final {
 public:
  explicit JsonParser(std::u16string_view source) : source_(source) {}

  Value parse() {
    Value result = parseValue();
    skipWhitespace();
    if (position_ != source_.size()) fail(u"unexpected trailing input");
    return result;
  }

 private:
  [[noreturn]] void fail(const std::u16string& message) const {
    throw runtimeError(
        std::u16string(u"Invalid JSON at offset ") + formatIntegerText(position_) +
        u": " + message);
  }

  void skipWhitespace() {
    while (position_ < source_.size() &&
           (source_[position_] == u' ' || source_[position_] == u'\n' ||
            source_[position_] == u'\r' || source_[position_] == u'\t')) ++position_;
  }

  bool consume(std::u16string_view text) {
    if (source_.substr(position_, text.size()) != text) return false;
    position_ += text.size();
    return true;
  }

  std::uint32_t parseHexCodeUnit() {
    if (position_ + 4 > source_.size()) fail(u"incomplete unicode escape");
    std::uint32_t value = 0;
    for (int index = 0; index < 4; ++index) {
      const char16_t character = source_[position_++];
      const int digit = character >= u'0' && character <= u'9' ? character - u'0'
          : character >= u'a' && character <= u'f' ? character - u'a' + 10
          : character >= u'A' && character <= u'F' ? character - u'A' + 10
          : -1;
      if (digit < 0) fail(u"invalid unicode escape");
      value = (value << 4U) | static_cast<std::uint32_t>(digit);
    }
    return value;
  }

  void appendCodePoint(std::u16string& result, std::uint32_t codePoint) {
    if (codePoint <= 0xffff) {
      result.push_back(static_cast<char16_t>(codePoint));
    } else {
      codePoint -= 0x10000;
      result.push_back(static_cast<char16_t>(0xd800 + (codePoint >> 10U)));
      result.push_back(static_cast<char16_t>(0xdc00 + (codePoint & 0x3ff)));
    }
  }

  Value parseValue() {
    skipWhitespace();
    if (position_ >= source_.size()) fail(u"expected a value");
    const char16_t next = source_[position_];
    if (next == u'"') return Runtime::string(parseString());
    if (next == u'{') return Value(parseObject());
    if (next == u'[') return Value(parseArray());
    if (consume(u"true")) return Value(true);
    if (consume(u"false")) return Value(false);
    if (consume(u"null")) return Value::null();
    return Value(parseNumber());
  }

  std::u16string parseString() {
    if (source_[position_++] != u'"') fail(u"expected a string");
    std::u16string result;
    while (position_ < source_.size()) {
      const char16_t character = source_[position_++];
      if (character == u'"') return result;
      if (character != u'\\') {
        if (character < 0x20) fail(u"unescaped control character");
        result.push_back(character);
        continue;
      }
      if (position_ >= source_.size()) fail(u"unterminated escape");
      const char16_t escaped = source_[position_++];
      switch (escaped) {
        case u'"': result.push_back(u'"'); break;
        case u'\\': result.push_back(u'\\'); break;
        case u'/': result.push_back(u'/'); break;
        case u'b': result.push_back(u'\b'); break;
        case u'f': result.push_back(u'\f'); break;
        case u'n': result.push_back(u'\n'); break;
        case u'r': result.push_back(u'\r'); break;
        case u't': result.push_back(u'\t'); break;
        case u'u': {
          std::uint32_t codePoint = parseHexCodeUnit();
          if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
            if (position_ + 2 > source_.size() || source_[position_] != u'\\' || source_[position_ + 1] != u'u') {
              fail(u"missing low surrogate");
            }
            position_ += 2;
            const std::uint32_t low = parseHexCodeUnit();
            if (low < 0xdc00 || low > 0xdfff) fail(u"invalid low surrogate");
            codePoint = 0x10000 + ((codePoint - 0xd800) << 10U) + (low - 0xdc00);
          } else if (codePoint >= 0xdc00 && codePoint <= 0xdfff) {
            fail(u"unexpected low surrogate");
          }
          appendCodePoint(result, codePoint);
          break;
        }
        default: fail(u"unsupported escape sequence");
      }
    }
    fail(u"unterminated string");
  }

  double parseNumber() {
    const std::size_t start = position_;
    if (source_[position_] == u'-') ++position_;
    if (position_ >= source_.size()) fail(u"invalid number");
    if (source_[position_] == u'0') {
      ++position_;
    } else {
      if (source_[position_] < u'0' || source_[position_] > u'9') fail(u"invalid number");
      while (position_ < source_.size() && source_[position_] >= u'0' && source_[position_] <= u'9') ++position_;
    }
    if (position_ < source_.size() && source_[position_] == u'.') {
      ++position_;
      if (position_ >= source_.size() || source_[position_] < u'0' || source_[position_] > u'9') fail(u"invalid fraction");
      while (position_ < source_.size() && source_[position_] >= u'0' && source_[position_] <= u'9') ++position_;
    }
    if (position_ < source_.size() && (source_[position_] == u'e' || source_[position_] == u'E')) {
      ++position_;
      if (position_ < source_.size() && (source_[position_] == u'+' || source_[position_] == u'-')) ++position_;
      if (position_ >= source_.size() || source_[position_] < u'0' || source_[position_] > u'9') fail(u"invalid exponent");
      while (position_ < source_.size() && source_[position_] >= u'0' && source_[position_] <= u'9') ++position_;
    }
    return std::stod(utf16ToUtf8(source_.substr(start, position_ - start)));
  }

  ArrayObject<Value>* parseArray() {
    ++position_;
    auto* result = Runtime::array<Value>();
    skipWhitespace();
    if (position_ < source_.size() && source_[position_] == u']') { ++position_; return result; }
    while (true) {
      result->append(parseValue());
      skipWhitespace();
      if (position_ >= source_.size()) fail(u"unterminated array");
      if (source_[position_] == u']') { ++position_; return result; }
      if (source_[position_++] != u',') fail(u"expected ',' in array");
    }
  }

  RecordObject* parseObject() {
    ++position_;
    auto* result = Runtime::record();
    skipWhitespace();
    if (position_ < source_.size() && source_[position_] == u'}') { ++position_; return result; }
    while (true) {
      skipWhitespace();
      if (position_ >= source_.size() || source_[position_] != u'"') fail(u"expected an object key");
      const std::u16string key = parseString();
      skipWhitespace();
      if (position_ >= source_.size() || source_[position_++] != u':') fail(u"expected ':' after object key");
      result->set(key, parseValue());
      skipWhitespace();
      if (position_ >= source_.size()) fail(u"unterminated object");
      if (source_[position_] == u'}') { ++position_; return result; }
      if (source_[position_++] != u',') fail(u"expected ',' in object");
    }
  }

  std::u16string_view source_;
  std::size_t position_ = 0;
};

inline Value jsonParse(const Value& source) {
  if (!source.isString()) throw runtimeError(u"JSON.parse expects a string");
  return JsonParser(source.string()).parse();
}

inline bool includes(const std::vector<std::u16string>& array, const Value& value) {
  return includes(array, toString(value));
}

inline bool includes(const ArrayObject<std::u16string>* array, const Value& value) {
  return includes(array, toString(value));
}

inline double indexOf(const std::vector<std::u16string>& array, const Value& value) {
  return indexOf(array, toString(value));
}

inline double indexOf(const ArrayObject<std::u16string>* array, const Value& value) {
  return indexOf(array, toString(value));
}

template <typename... Values>
inline double push(std::vector<std::u16string>& array, Values&&... values) {
  (array.push_back(toString(std::forward<Values>(values))), ...);
  return static_cast<double>(array.size());
}

template <typename... Values>
inline double push(ArrayObject<std::u16string>* array, Values&&... values) {
  (array->append(toString(std::forward<Values>(values))), ...);
  return static_cast<double>(array->size());
}

inline double valueOf(double value) { return value; }
inline bool valueOf(bool value) { return value; }
inline const Value& valueOf(const Value& value) { return value; }

inline std::u16string toFixed(double value, int digits = 0) {
  return formatFixedText(value, std::clamp(digits, 0, 100));
}

inline std::u16string toUpperCase(std::u16string value) {
  std::transform(value.begin(), value.end(), value.begin(), [](char16_t character) {
    return character <= 0x7f
      ? static_cast<char16_t>(std::toupper(static_cast<unsigned char>(character)))
      : character;
  });
  return value;
}
inline std::u16string toLowerCase(std::u16string value) {
  std::transform(value.begin(), value.end(), value.begin(), [](char16_t character) {
    return character <= 0x7f
      ? static_cast<char16_t>(std::tolower(static_cast<unsigned char>(character)))
      : character;
  });
  return value;
}
inline bool isStringWhitespace(char16_t character) {
  return character == u' ' || character == u'\t' || character == u'\n' ||
    character == u'\r' || character == u'\f' || character == u'\v';
}

inline std::u16string trim(std::u16string value) {
  value.erase(value.begin(), std::find_if_not(value.begin(), value.end(), isStringWhitespace));
  value.erase(std::find_if_not(value.rbegin(), value.rend(), isStringWhitespace).base(), value.end());
  return value;
}
inline std::u16string trimStart(std::u16string value) {
  value.erase(value.begin(), std::find_if_not(value.begin(), value.end(), isStringWhitespace));
  return value;
}
inline std::u16string trimEnd(std::u16string value) {
  value.erase(std::find_if_not(value.rbegin(), value.rend(), isStringWhitespace).base(), value.end());
  return value;
}
inline bool stringIncludes(
    const std::u16string& value,
    const std::u16string& search,
    double position = 0) {
  return value.find(search, normalizedSliceIndex(position, value.size())) != std::u16string::npos;
}
inline bool stringIncludes(const std::u16string& value, const Value& search, double position = 0) {
  return stringIncludes(value, toString(search), position);
}
inline bool stringIncludes(const Value& value, const std::u16string& search, double position = 0) {
  return stringIncludes(toString(value), search, position);
}
inline bool stringIncludes(const Value& value, const Value& search, double position = 0) {
  return stringIncludes(toString(value), toString(search), position);
}

inline bool includes(const std::u16string& value, const std::u16string& search, double position = 0) {
  return stringIncludes(value, search, position);
}

inline bool includes(const std::u16string& value, const Value& search, double position = 0) {
  return stringIncludes(value, search, position);
}

inline bool includes(const Value& value, const std::u16string& search, double position = 0) {
  return stringIncludes(value, search, position);
}

inline bool includes(const Value& value, const Value& search, double position = 0) {
  return stringIncludes(value, search, position);
}

template <typename ValueLike, typename SearchLike>
double stringIndexOf(const ValueLike& valueLike, const SearchLike& searchLike, double position = 0) {
  const std::u16string value = toString(valueLike);
  const std::u16string search = toString(searchLike);
  const auto found = value.find(search, normalizedSliceIndex(position, value.size()));
  return found == std::u16string::npos ? -1.0 : static_cast<double>(found);
}

template <typename ValueLike, typename SearchLike>
double stringLastIndexOf(
    const ValueLike& valueLike,
    const SearchLike& searchLike,
    double position = std::numeric_limits<double>::infinity()) {
  const std::u16string value = toString(valueLike);
  const std::u16string search = toString(searchLike);
  const std::size_t start = std::isfinite(position)
      ? std::min(value.size(), static_cast<std::size_t>(std::max(0.0, std::floor(position))))
      : value.size();
  const auto found = value.rfind(search, start);
  return found == std::u16string::npos ? -1.0 : static_cast<double>(found);
}

template <typename ValueLike, typename SearchLike>
inline double indexOf(const ValueLike& value, const SearchLike& search, double position = 0) {
  return stringIndexOf(value, search, position);
}

template <typename ValueLike, typename SearchLike>
inline double lastIndexOf(
    const ValueLike& value,
    const SearchLike& search,
    double position = std::numeric_limits<double>::infinity()) {
  return stringLastIndexOf(value, search, position);
}

inline bool startsWith(
    const std::u16string& value,
    const std::u16string& search,
    double position = 0) {
  return value.compare(normalizedSliceIndex(position, value.size()), search.size(), search) == 0;
}
inline bool startsWith(const Value& value, const Value& search, double position = 0) {
  return startsWith(toString(value), toString(search), position);
}
inline bool startsWith(const std::u16string& value, const Value& search, double position = 0) {
  return startsWith(value, toString(search), position);
}
inline bool startsWith(const Value& value, const std::u16string& search, double position = 0) {
  return startsWith(toString(value), search, position);
}

inline bool endsWith(const std::u16string& value, const std::u16string& search) {
  return search.size() <= value.size() &&
    value.compare(value.size() - search.size(), search.size(), search) == 0;
}
inline bool endsWith(const Value& value, const Value& search) {
  return endsWith(toString(value), toString(search));
}
inline bool endsWith(const std::u16string& value, const Value& search) {
  return endsWith(value, toString(search));
}
inline bool endsWith(const Value& value, const std::u16string& search) {
  return endsWith(toString(value), search);
}

inline std::u16string charAt(const std::u16string& value, double index = 0) {
  const auto position = static_cast<std::int64_t>(std::trunc(index));
  return position >= 0 && static_cast<std::size_t>(position) < value.size()
    ? std::u16string(1, value[static_cast<std::size_t>(position)])
    : std::u16string();
}
inline std::u16string stringIndex(const std::u16string& value, double index) {
  const auto position = static_cast<std::int64_t>(std::trunc(index));
  const auto resolved = position < 0 ? static_cast<std::int64_t>(value.size()) + position : position;
  return resolved >= 0 && resolved < static_cast<std::int64_t>(value.size())
    ? std::u16string(1, value[static_cast<std::size_t>(resolved)])
    : std::u16string();
}

inline Value stringAt(const std::u16string& value, double index = 0) {
  const auto position = static_cast<std::int64_t>(std::trunc(index));
  const auto resolved = position < 0 ? static_cast<std::int64_t>(value.size()) + position : position;
  return resolved >= 0 && resolved < static_cast<std::int64_t>(value.size())
    ? Value(Runtime::string(std::u16string(1, value[static_cast<std::size_t>(resolved)])))
    : Value::undefined();
}
inline Value stringAt(const Value& value, double index = 0) {
  return stringAt(requireString(value), index);
}

inline Value at(const std::u16string& value, double index = 0) {
  return stringAt(value, index);
}

inline double charCodeAt(const std::u16string& value, double index = 0) {
  const auto position = static_cast<std::int64_t>(std::trunc(index));
  if (position < 0 || static_cast<std::size_t>(position) >= value.size()) {
    return std::numeric_limits<double>::quiet_NaN();
  }
  return static_cast<std::uint16_t>(value[static_cast<std::size_t>(position)]);
}
inline Value codePointAt(const std::u16string& value, double index = 0) {
  const auto position = static_cast<std::int64_t>(std::trunc(index));
  if (position < 0 || static_cast<std::size_t>(position) >= value.size()) {
    return Value::undefined();
  }
  const auto first = static_cast<std::uint16_t>(value[static_cast<std::size_t>(position)]);
  if (first >= 0xD800 && first <= 0xDBFF && static_cast<std::size_t>(position + 1) < value.size()) {
    const auto second = static_cast<std::uint16_t>(value[static_cast<std::size_t>(position + 1)]);
    if (second >= 0xDC00 && second <= 0xDFFF) {
      return Value(static_cast<double>(0x10000 + ((first - 0xD800) << 10) + (second - 0xDC00)));
    }
  }
  return Value(static_cast<double>(first));
}
template <typename T>
inline bool numberIsNaN(const T& value) {
  return std::isnan(Number(value));
}

inline std::u16string stringFromCharCode(double value) {
  const auto codeUnit =
    static_cast<std::uint32_t>(static_cast<std::uint16_t>(static_cast<std::uint32_t>(value)));
  return std::u16string(1, static_cast<char16_t>(codeUnit));
}

inline std::u16string stringRepeat(const std::u16string& value, double count) {
  const auto repetitions = std::max<std::int64_t>(0, static_cast<std::int64_t>(count));
  std::u16string result;
  result.reserve(value.size() * static_cast<std::size_t>(repetitions));
  for (std::int64_t index = 0; index < repetitions; ++index) result += value;
  return result;
}
inline std::u16string stringRepeat(const Value& value, double count) {
  return stringRepeat(requireString(value), count);
}

inline std::u16string repeat(const std::u16string& value, double count) {
  return stringRepeat(value, count);
}

inline bool stringIsWellFormed(const std::u16string& value) {
  for (std::size_t index = 0; index < value.size(); ++index) {
    const auto codeUnit = static_cast<std::uint16_t>(value[index]);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 >= value.size()) return false;
      const auto low = static_cast<std::uint16_t>(value[++index]);
      if (low < 0xdc00 || low > 0xdfff) return false;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}
inline bool stringIsWellFormed(const Value& value) {
  return stringIsWellFormed(requireString(value));
}

inline bool isWellFormed(const std::u16string& value) {
  return stringIsWellFormed(value);
}

inline bool isWellFormed(const Value& value) {
  return stringIsWellFormed(value);
}

inline std::u16string stringToWellFormed(const std::u16string& value) {
  std::u16string result;
  result.reserve(value.size());
  for (std::size_t index = 0; index < value.size(); ++index) {
    const auto codeUnit = static_cast<std::uint16_t>(value[index]);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      if (index + 1 < value.size()) {
        const auto low = static_cast<std::uint16_t>(value[index + 1]);
        if (low >= 0xdc00 && low <= 0xdfff) {
          result.push_back(value[index++]);
          result.push_back(value[index]);
          continue;
        }
      }
      result.push_back(u'\ufffd');
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      result.push_back(u'\ufffd');
    } else {
      result.push_back(value[index]);
    }
  }
  return result;
}
inline std::u16string stringToWellFormed(const Value& value) {
  return stringToWellFormed(requireString(value));
}

inline std::u16string toWellFormed(const std::u16string& value) {
  return stringToWellFormed(value);
}

inline std::u16string toWellFormed(const Value& value) {
  return stringToWellFormed(value);
}

inline std::u16string substring(
    const std::u16string& value,
    double start,
    double end = std::numeric_limits<double>::infinity()) {
  std::size_t first = normalizedSliceIndex(std::max(0.0, start), value.size());
  std::size_t last = std::isinf(end)
    ? value.size()
    : normalizedSliceIndex(std::max(0.0, end), value.size());
  if (first > last) std::swap(first, last);
  return value.substr(first, last - first);
}
inline std::u16string substring(
    const Value& value,
    double start,
    double end = std::numeric_limits<double>::infinity()) {
  return substring(requireString(value), start, end);
}

inline std::u16string stringSlice(
    const std::u16string& value,
    double start,
    double end = std::numeric_limits<double>::infinity()) {
  const std::size_t first = normalizedSliceIndex(start, value.size());
  const std::size_t last = std::isinf(end)
    ? value.size()
    : normalizedSliceIndex(end, value.size());
  return last <= first ? std::u16string() : value.substr(first, last - first);
}
inline std::u16string stringSlice(
    const Value& value,
    double start,
    double end = std::numeric_limits<double>::infinity()) {
  return stringSlice(requireString(value), start, end);
}

inline std::u16string slice(
    const std::u16string& value,
    double start,
    double end = std::numeric_limits<double>::infinity()) {
  return stringSlice(value, start, end);
}

inline std::u16string slice(
    const Value& value,
    double start,
    double end = std::numeric_limits<double>::infinity()) {
  return stringSlice(value, start, end);
}

inline ArrayObject<std::u16string>* split(
    const std::u16string& value,
    const std::u16string& separator) {
  auto* result = Runtime::array<std::u16string>();
  if (separator.empty()) {
    for (char16_t character : value) result->append(std::u16string(1, character));
    return result;
  }
  std::size_t start = 0;
  while (true) {
    const std::size_t next = value.find(separator, start);
    if (next == std::u16string::npos) {
      result->append(value.substr(start));
      return result;
    }
    result->append(value.substr(start, next - start));
    start = next + separator.size();
  }
}
inline ArrayObject<std::u16string>* split(const Value& value, const Value& separator) {
  return split(toString(value), toString(separator));
}
inline ArrayObject<std::u16string>* split(
    const std::u16string& value,
    const Value& separator) {
  return split(value, toString(separator));
}
inline ArrayObject<std::u16string>* split(
    const Value& value,
    const std::u16string& separator) {
  return split(toString(value), separator);
}

inline ArrayObject<std::u16string>* split(
    const Value& value,
    const RegExp& separator) {
  auto* result = Runtime::array<std::u16string>();
  for (const auto& part : separator.split(toString(value))) result->append(part);
  return result;
}

inline ArrayObject<std::u16string>* split(
    const std::u16string& value,
    const RegExp& separator) {
  auto* result = Runtime::array<std::u16string>();
  for (const auto& part : separator.split(value)) result->append(part);
  return result;
}
inline double Number(double value) { return value; }
inline double Number(bool value) { return value ? 1 : 0; }
inline double Number(int value) { return static_cast<double>(value); }
inline double Number(std::int64_t value) { return static_cast<double>(value); }
inline double Number(const BigInt& value) { return value.toDouble(); }
inline double Number(const std::u16string& value) {
  try { return std::stod(utf16ToUtf8(value)); } catch (...) { return std::numeric_limits<double>::quiet_NaN(); }
}
inline double numberFromString(const std::u16string& value) {
  const auto first = value.find_first_not_of(u" \t\n\r\f\v");
  if (first == std::u16string::npos) return 0;
  const auto last = value.find_last_not_of(u" \t\n\r\f\v");
  const std::u16string trimmed = value.substr(first, last - first + 1);
  try {
    std::size_t consumed = 0;
    const double result = std::stod(utf16ToUtf8(trimmed), &consumed);
    return consumed == trimmed.size() ? result : std::numeric_limits<double>::quiet_NaN();
  } catch (...) {
    return std::numeric_limits<double>::quiet_NaN();
  }
}

inline double Number(const Value& value) {
  if (value.isNumber()) return value.number();
  if (value.isBoolean()) return value.boolean() ? 1 : 0;
  if (value.isBigInt()) return value.bigint().toDouble();
  if (value.isNull()) return 0;
  if (value.isUndefined()) return std::numeric_limits<double>::quiet_NaN();
  if (!value.isString()) return std::numeric_limits<double>::quiet_NaN();
  return numberFromString(value.string());
}

inline bool strictEquals(const Value& left, const Value& right) {
  return left == right;
}

inline bool looseEqualsString(const std::u16string& text, const Value& value) {
  if (value.isString()) return text == value.string();
  if (value.isNumber()) return numberFromString(text) == value.number();
  if (value.isBigInt()) {
    try {
      return BigInt(text) == value.bigint();
    } catch (...) {
      return false;
    }
  }
  if (value.isBoolean()) return numberFromString(text) == (value.boolean() ? 1 : 0);
  return false;
}

inline bool looseEquals(const Value& left, const Value& right) {
  if (strictEquals(left, right)) return true;
  if ((left.isNull() || left.isUndefined()) && (right.isNull() || right.isUndefined())) return true;
  if (left.isString()) return looseEqualsString(left.string(), right);
  if (right.isString()) return looseEqualsString(right.string(), left);
  if (left.isBoolean()) {
    if (right.isBigInt()) return BigInt(left.boolean() ? 1 : 0) == right.bigint();
    return static_cast<double>(left.boolean() ? 1 : 0) == Number(right);
  }
  if (right.isBoolean()) return looseEquals(right, left);
  if (left.isNumber() && right.isBigInt()) {
    return std::isfinite(left.number()) && std::trunc(left.number()) == left.number() &&
        makeBigInt(left.number()) == right.bigint();
  }
  if (left.isBigInt() && right.isNumber()) return looseEquals(right, left);
  if (left.isNumber() && right.isNumber()) return left.number() == right.number();
  if (left.isBigInt() && right.isBigInt()) return left.bigint() == right.bigint();
  const bool leftObject = left.isRecord() || left.isRuntimeObject();
  const bool rightObject = right.isRecord() || right.isRuntimeObject();
  if (leftObject && !rightObject) return looseEqualsString(toString(left), right);
  if (rightObject && !leftObject) return looseEqualsString(toString(right), left);
  return false;
}

template <typename Left, typename Right>
  requires (std::is_arithmetic_v<Left> && std::is_arithmetic_v<Right>)
inline auto remainder(Left left, Right right) {
  if constexpr (std::is_integral_v<Left> && std::is_integral_v<Right>) {
    return left % right;
  } else {
    return std::fmod(static_cast<double>(left), static_cast<double>(right));
  }
}

inline Value remainder(const Value& left, const Value& right) {
  if (left.isBigInt() || right.isBigInt()) {
    if (!left.isBigInt() || !right.isBigInt()) {
      throw runtimeError(u"Cannot mix bigint and number arithmetic");
    }
    return Value(left.bigint() % right.bigint());
  }
  return Value(std::fmod(Number(left), Number(right)));
}

template <typename Right>
  requires std::is_arithmetic_v<Right>
inline double remainder(const Value& left, Right right) {
  return std::fmod(Number(left), static_cast<double>(right));
}

template <typename Left>
  requires std::is_arithmetic_v<Left>
inline double remainder(Left left, const Value& right) {
  return std::fmod(static_cast<double>(left), Number(right));
}

template <typename T>
inline std::u16string String(const T& value) {
  return std::u16string(toString(value));
}

inline bool Boolean(bool value) { return value; }
inline bool Boolean(Undefined) { return false; }
inline bool Boolean(double value) { return value != 0 && !std::isnan(value); }
inline bool Boolean(const std::u16string& value) { return !value.empty(); }
template <typename Result, typename... Arguments>
inline bool Boolean(const std::function<Result(Arguments...)>& value) {
  return static_cast<bool>(value);
}
inline bool Boolean(const Value& value) {
  if (value.isUndefined() || value.isNull()) return false;
  if (value.isBoolean()) return value.boolean();
  if (value.isNumber()) return Boolean(value.number());
  if (value.isBigInt()) return !value.bigint().isZero();
  return !value.isString() || !value.utf16().empty();
}

template <typename T>
class DynamicArrayMethodObject final
    : public cppgc::GarbageCollected<DynamicArrayMethodObject<T>>,
      public BaseObject {
 public:
  DynamicArrayMethodObject(ArrayObject<T>* array, std::u16string method)
      : array_(array), method_(std::move(method)) {}

  const void* dynamicTypeToken() const override {
    return nativeTypeToken<DynamicArrayMethodObject<T>>();
  }
  void* dynamicCast(const void* type) override {
    return type == nativeTypeToken<DynamicArrayMethodObject<T>>() ? this : nullptr;
  }
  std::u16string dynamicToString() const override { return u"function"; }
  void Trace(cppgc::Visitor* visitor) const final {
    BaseObject::Trace(visitor);
    visitor->Trace(array_);
  }

  Value dynamicCall(const std::vector<Value>& arguments) override {
    if (!array_) throw Runtime::errorAtCurrentSource(u"Cannot call an array method on null");
    if constexpr (IsDynamicArrayElement<T>) {
      if (method_ == u"push") {
        for (const auto& argument : arguments) array_->append(convertValue<T>(argument));
        return Value(static_cast<double>(array_->size()));
      }
      if (method_ == u"unshift") {
        for (auto iterator = arguments.rbegin(); iterator != arguments.rend(); ++iterator) {
          array_->prepend(convertValue<T>(*iterator));
        }
        return Value(static_cast<double>(array_->size()));
      }
      if (method_ == u"pop") return convertValue<Value>(array_->pop());
      if (method_ == u"shift") return convertValue<Value>(array_->shift());
      if (method_ == u"reverse") {
        array_->reverse();
        return Value(static_cast<BaseObject*>(array_.Get()));
      }
      if (method_ == u"at") {
        const double index = arguments.empty() ? 0 : Number(arguments[0]);
        return convertValue<Value>(array_->at(index));
      }
      if (method_ == u"includes" || method_ == u"indexOf" || method_ == u"lastIndexOf") {
        const Value searched = arguments.empty() ? Value::undefined() : arguments[0];
        double found = -1;
        for (std::size_t index = 0; index < array_->size(); ++index) {
          if (!strictEquals(array_->dynamicArrayGet(index), searched)) continue;
          found = static_cast<double>(index);
          if (method_ != u"lastIndexOf") break;
        }
        return method_ == u"includes" ? Value(found >= 0) : Value(found);
      }
      if (method_ == u"join") {
        const std::u16string separator = arguments.empty() ? u"," : toString(arguments[0]);
        return Value(Runtime::string(array_->join(separator)));
      }
      if (method_ == u"slice") {
        const double start = arguments.empty() ? 0 : Number(arguments[0]);
        const double end = arguments.size() < 2
          ? std::numeric_limits<double>::infinity()
          : Number(arguments[1]);
        return Value(static_cast<BaseObject*>(array_->slice(start, end)));
      }
    }
    if (arguments.empty()) {
      throw Runtime::errorAtCurrentSource(u"Dynamic array callback method requires a callback");
    }
    const Value callback = arguments[0];
    const auto invoke = [&](std::size_t index, const Value* accumulator = nullptr) {
      const Value element = array_->dynamicArrayGet(index);
      std::vector<Value> callbackArguments;
      if (accumulator) callbackArguments.push_back(*accumulator);
      callbackArguments.push_back(element);
      callbackArguments.push_back(Value(static_cast<double>(index)));
      callbackArguments.push_back(Value(static_cast<BaseObject*>(array_.Get())));
      return call(callback, std::move(callbackArguments));
    };

    if (method_ == u"map") {
      auto* result = Runtime::array<Value>();
      for (std::size_t index = 0; index < array_->size(); ++index) result->append(invoke(index));
      return Value(static_cast<BaseObject*>(result));
    }
    if (method_ == u"filter") {
      auto* result = Runtime::array<Value>();
      for (std::size_t index = 0; index < array_->size(); ++index) {
        if (Boolean(invoke(index))) result->append(array_->dynamicArrayGet(index));
      }
      return Value(static_cast<BaseObject*>(result));
    }
    if (method_ == u"flatMap") {
      auto* result = Runtime::array<Value>();
      for (std::size_t index = 0; index < array_->size(); ++index) {
        const Value mapped = invoke(index);
        if (mapped.isRuntimeObject() && mapped.object()->dynamicIsArray()) {
          auto* nested = mapped.object();
          for (std::size_t nestedIndex = 0; nestedIndex < nested->dynamicArraySize(); ++nestedIndex) {
            result->append(nested->dynamicArrayGet(nestedIndex));
          }
        } else {
          result->append(mapped);
        }
      }
      return Value(static_cast<BaseObject*>(result));
    }
    if (method_ == u"some") {
      for (std::size_t index = 0; index < array_->size(); ++index) {
        if (Boolean(invoke(index))) return Value(true);
      }
      return Value(false);
    }
    if (method_ == u"every") {
      for (std::size_t index = 0; index < array_->size(); ++index) {
        if (!Boolean(invoke(index))) return Value(false);
      }
      return Value(true);
    }
    if (method_ == u"find") {
      for (std::size_t index = 0; index < array_->size(); ++index) {
        if (Boolean(invoke(index))) return array_->dynamicArrayGet(index);
      }
      return Value::undefined();
    }
    if (method_ == u"findIndex") {
      for (std::size_t index = 0; index < array_->size(); ++index) {
        if (Boolean(invoke(index))) return Value(static_cast<double>(index));
      }
      return Value(-1.0);
    }
    if (method_ == u"forEach") {
      for (std::size_t index = 0; index < array_->size(); ++index) invoke(index);
      return Value::undefined();
    }
    if (method_ == u"reduce") {
      std::size_t index = 0;
      Value accumulator;
      if (arguments.size() > 1) {
        accumulator = arguments[1];
      } else {
        if (array_->empty()) {
          throw Runtime::errorAtCurrentSource(u"Reduce of empty array with no initial value");
        }
        accumulator = array_->dynamicArrayGet(index++);
      }
      for (; index < array_->size(); ++index) accumulator = invoke(index, &accumulator);
      return accumulator;
    }
    throw Runtime::errorAtCurrentSource(u"Unsupported dynamic array method");
  }

 private:
  cppgc::Member<ArrayObject<T>> array_;
  std::u16string method_;
};

template <typename T>
inline Value ArrayObject<T>::dynamicGet(const std::u16string& key) {
    if (key == u"length") return Value(static_cast<double>(size()));
  if (
    key == u"map" || key == u"filter" || key == u"flatMap" ||
    key == u"some" || key == u"every" || key == u"find" ||
    key == u"findIndex" || key == u"forEach" || key == u"reduce" ||
    key == u"push" || key == u"pop" || key == u"shift" ||
    key == u"unshift" || key == u"reverse" || key == u"at" ||
    key == u"includes" || key == u"indexOf" || key == u"lastIndexOf" ||
    key == u"join" || key == u"slice"
  ) {
    return Value(static_cast<BaseObject*>(
      Runtime::make<DynamicArrayMethodObject<T>>(this, key)
    ));
  }
  if constexpr (IsDynamicArrayElement<T>) {
    if (const auto index = propertyIndex(key); index && *index < size()) {
      if constexpr (std::is_pointer_v<T> && std::is_base_of_v<EnumerableObject, std::remove_pointer_t<T>>) {
        auto* value = get(*index);
        return value && value->enumerableBackingRecord()
          ? Value(value->enumerableBackingRecord())
          : Value::undefined();
      } else {
        return convertValue<Value>(get(*index));
      }
    }
    return BaseObject::dynamicGet(key);
  } else {
    throw Runtime::errorAtCurrentSource(
      std::u16string(u"This native array element type cannot flow through dynamic access: ") +
      utf8ToUtf16(__PRETTY_FUNCTION__)
    );
  }
}

template <typename T>
inline bool Boolean(T* value) {
  return value != nullptr;
}

template <typename T>
inline bool Boolean(const std::vector<T>&) {
  return true;
}

template <typename Left, typename Right>
inline Value add(Left&& leftInput, Right&& rightInput) {
  const Value left = convertValue<Value>(std::forward<Left>(leftInput));
  const Value right = convertValue<Value>(std::forward<Right>(rightInput));
  if (const auto result = callDynamicOperator(left, u"__vexa_operator:+", right)) {
    return *result;
  }
  if (left.isString() || right.isString()) {
    const Value leftText = left.isString() ? left : Runtime::string(toString(left));
    const Value rightText = right.isString() ? right : Runtime::string(toString(right));
    return Runtime::concatStrings(leftText.stringObject(), rightText.stringObject());
  }
  if (left.isBigInt() || right.isBigInt()) {
    if (!left.isBigInt() || !right.isBigInt()) {
      throw runtimeError(u"Cannot mix bigint and number arithmetic");
    }
    return Value(left.bigint() + right.bigint());
  }
  return Value(Number(left) + Number(right));
}

template <typename Right>
inline Value& addAssign(Value& left, Right&& right) {
  left = add(left, std::forward<Right>(right));
  return left;
}

inline void requireMatchingBigInts(const Value& left, const Value& right) {
  if ((left.isBigInt() || right.isBigInt()) && (!left.isBigInt() || !right.isBigInt())) {
    throw runtimeError(u"Cannot mix bigint and number arithmetic");
  }
}

inline Value subtract(const Value& left, const Value& right) {
  if (const auto result = callDynamicOperator(left, u"__vexa_operator:-", right)) {
    return *result;
  }
  requireMatchingBigInts(left, right);
  return left.isBigInt()
      ? Value(left.bigint() - right.bigint())
      : Value(Number(left) - Number(right));
}

inline Value multiply(const Value& left, const Value& right) {
  if (const auto result = callDynamicOperator(left, u"__vexa_operator:*", right)) {
    return *result;
  }
  requireMatchingBigInts(left, right);
  return left.isBigInt()
      ? Value(left.bigint() * right.bigint())
      : Value(Number(left) * Number(right));
}

inline Value divide(const Value& left, const Value& right) {
  if (const auto result = callDynamicOperator(left, u"__vexa_operator:/", right)) {
    return *result;
  }
  requireMatchingBigInts(left, right);
  return left.isBigInt()
      ? Value(left.bigint() / right.bigint())
      : Value(Number(left) / Number(right));
}

inline Value power(const Value& left, const Value& right) {
  if (const auto result = callDynamicOperator(left, u"__vexa_operator:**", right)) {
    return *result;
  }
  requireMatchingBigInts(left, right);
  return left.isBigInt()
      ? Value(vexa::pow(left.bigint(), right.bigint()))
      : Value(std::pow(Number(left), Number(right)));
}

inline Value negate(const Value& value) {
  if (const auto result = callDynamicOperator(value, u"__vexa_operator:-")) {
    return *result;
  }
  return value.isBigInt() ? Value(-value.bigint()) : Value(-Number(value));
}

inline std::int32_t toInt32(const Value& value) {
  return static_cast<std::int32_t>(static_cast<std::uint32_t>(static_cast<std::int64_t>(Number(value))));
}

inline std::int32_t toInt32(double value) {
  return static_cast<std::int32_t>(static_cast<std::uint32_t>(static_cast<std::int64_t>(value)));
}

inline Value bitwiseNot(const Value& value) {
  return value.isBigInt() ? Value(~value.bigint()) : Value(~toInt32(value));
}

inline Value bitwiseAnd(const Value& left, const Value& right) {
  requireMatchingBigInts(left, right);
  return left.isBigInt() ? Value(left.bigint() & right.bigint()) : Value(toInt32(left) & toInt32(right));
}

inline Value bitwiseOr(const Value& left, const Value& right) {
  requireMatchingBigInts(left, right);
  return left.isBigInt() ? Value(left.bigint() | right.bigint()) : Value(toInt32(left) | toInt32(right));
}

inline Value bitwiseXor(const Value& left, const Value& right) {
  requireMatchingBigInts(left, right);
  return left.isBigInt() ? Value(left.bigint() ^ right.bigint()) : Value(toInt32(left) ^ toInt32(right));
}

inline Value shiftLeft(const Value& left, const Value& right) {
  requireMatchingBigInts(left, right);
  if (left.isBigInt()) return Value(left.bigint() << right.bigint());
  const auto amount = static_cast<std::uint32_t>(toInt32(right)) & 31U;
  return Value(static_cast<std::int32_t>(static_cast<std::uint32_t>(toInt32(left)) << amount));
}

inline Value shiftRight(const Value& left, const Value& right) {
  requireMatchingBigInts(left, right);
  if (left.isBigInt()) return Value(left.bigint() >> right.bigint());
  const auto amount = static_cast<std::uint32_t>(toInt32(right)) & 31U;
  return Value(static_cast<std::int32_t>(toInt32(left) >> amount));
}

inline Value unsignedShiftRight(const Value& left, const Value& right) {
  if (left.isBigInt() || right.isBigInt()) {
    throw runtimeError(u"Unsigned right shift is not defined for bigint values");
  }
  const auto amount = static_cast<std::uint32_t>(toInt32(right)) & 31U;
  return Value(static_cast<double>(static_cast<std::uint32_t>(toInt32(left)) >> amount));
}

inline double bitwiseNot(double value) {
  return static_cast<double>(~toInt32(value));
}

inline double bitwiseAnd(double left, double right) {
  return static_cast<double>(toInt32(left) & toInt32(right));
}

inline double bitwiseOr(double left, double right) {
  return static_cast<double>(toInt32(left) | toInt32(right));
}

inline double bitwiseXor(double left, double right) {
  return static_cast<double>(toInt32(left) ^ toInt32(right));
}

inline double shiftLeft(double left, double right) {
  const auto amount = static_cast<std::uint32_t>(toInt32(right)) & 31U;
  return static_cast<double>(static_cast<std::int32_t>(static_cast<std::uint32_t>(toInt32(left)) << amount));
}

inline double shiftRight(double left, double right) {
  const auto amount = static_cast<std::uint32_t>(toInt32(right)) & 31U;
  return static_cast<double>(toInt32(left) >> amount);
}

inline double unsignedShiftRight(double left, double right) {
  const auto amount = static_cast<std::uint32_t>(toInt32(right)) & 31U;
  return static_cast<double>(static_cast<std::uint32_t>(toInt32(left)) >> amount);
}

template <typename Target, typename Callback>
inline Target& assignWith(Target& target, Callback&& callback) {
  auto result = std::forward<Callback>(callback)(target);
  if constexpr (std::is_arithmetic_v<Target> && std::is_same_v<std::remove_cvref_t<decltype(result)>, Value>) {
    target = static_cast<Target>(Number(result));
  } else {
    target = std::move(result);
  }
  return target;
}

template <typename Left, typename Right>
inline std::int32_t compare(const Left& left, const Right& right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

inline std::int32_t compare(const Value& left, const Value& right) {
  if (const auto result = callDynamicOperator(
        left, u"__vexa_operator:<=>", right)) {
    return convertValue<std::int32_t>(*result);
  }
  if (left.isRuntimeObject() && right.isRuntimeObject()) {
    auto* leftDate = static_cast<DateObject*>(
      left.object()->dynamicCast(nativeTypeToken<DateObject>()));
    auto* rightDate = static_cast<DateObject*>(
      right.object()->dynamicCast(nativeTypeToken<DateObject>()));
    if (leftDate && rightDate) return compare(leftDate->getTime(), rightDate->getTime());
  }
  if (left.isString() && right.isString()) {
    return compare(left.utf16(), right.utf16());
  }
  if (left.isBigInt() && right.isBigInt()) {
    return compare(left.bigint(), right.bigint());
  }
  return compare(Number(left), Number(right));
}

inline double parseFloat(const std::u16string& value) {
  try {
    return std::stod(utf16ToUtf8(value));
  } catch (...) {
    return std::numeric_limits<double>::quiet_NaN();
  }
}

inline double parseFloat(const Value& value) { return parseFloat(toString(value)); }
inline double parseInt(const std::u16string& value, int radix = 10) {
  try {
    return static_cast<double>(std::stoll(utf16ToUtf8(value), nullptr, radix));
  } catch (...) {
    return std::numeric_limits<double>::quiet_NaN();
  }
}
inline double parseInt(const Value& value, int radix = 10) { return parseInt(toString(value), radix); }
inline bool isNaN(double value) { return std::isnan(value); }
inline bool isFinite(double value) { return std::isfinite(value); }
inline bool isErrorLike(const Error&) { return true; }
inline bool isErrorLike(const Value& value) {
  return value.isString() ||
    (value.isRuntimeObject() && value.object()->dynamicCast(nativeTypeToken<Error>()) != nullptr);
}
inline const std::u16string& errorMessageText(const Error& error) {
  return error.messageText();
}
inline std::u16string errorMessageText(const Value& value) {
  if (value.isString()) return value.string();
  if (value.isRuntimeObject()) {
    const Value message = value.object()->dynamicGet(u"message");
    if (!message.isUndefined()) return toString(message);
  }
  return toString(value);
}
template <typename T>
inline bool isErrorLike(T* value) {
  if constexpr (std::is_base_of_v<Error, T>) return value != nullptr;
  return value && value->dynamicCast(nativeTypeToken<Error>()) != nullptr;
}
inline Value encodeURIComponent(const std::u16string& value) {
  return Runtime::string(encodeUriComponentText(value));
}
inline Value encodeURIComponent(const Value& value) {
  return encodeURIComponent(value.isString() ? value.utf16() : toString(value));
}
inline Value decodeURIComponent(const std::u16string& value) {
  return Runtime::string(decodeUriComponentText(value));
}
inline Value decodeURIComponent(const Value& value) {
  return decodeURIComponent(value.isString() ? value.utf16() : toString(value));
}

template <typename T, typename Executor>
inline Task<T> createTask(Executor executor) {
  return Task<T>::create(std::move(executor));
}

inline Runtime::TimerId setTimeout(Runtime::TimerCallback callback, double delay = 0) {
  return Runtime::setTimeout(std::move(callback), delay);
}

inline Runtime::TimerId setInterval(Runtime::TimerCallback callback, double delay = 0) {
  return Runtime::setInterval(std::move(callback), delay);
}

inline void clearTimeout(Runtime::TimerId id) { Runtime::clearTimeout(id); }
inline void clearInterval(Runtime::TimerId id) { Runtime::clearInterval(id); }
inline void clearTimeout(const Value& id) { Runtime::clearTimeout(id); }
inline void clearInterval(const Value& id) { Runtime::clearInterval(id); }

inline Value call(const Value& callable, std::initializer_list<Value> arguments) {
  return call(callable, std::vector<Value>(arguments));
}

inline Value callOptional(const Value& callable, std::initializer_list<Value> arguments) {
  return callOptional(callable, std::vector<Value>(arguments));
}

inline std::u16string typeOf(const Value& value) {
  if (value.isUndefined()) return u"undefined";
  if (value.isBoolean()) return u"boolean";
  if (value.isNumber()) return u"number";
  if (value.isBigInt()) return u"bigint";
  if (value.isString()) return u"string";
  if (value.isRuntimeObject() && value.object()->dynamicToString() == u"function") return u"function";
  return u"object";
}
inline std::u16string typeOf(double) { return u"number"; }
inline std::u16string typeOf(const BigInt&) { return u"bigint"; }
inline std::u16string typeOf(bool) { return u"boolean"; }
inline std::u16string typeOf(const std::u16string&) { return u"string"; }

struct Math final {
  static constexpr double E = 2.71828182845904523536;
  static constexpr double LN2 = 0.69314718055994530942;
  static constexpr double LN10 = 2.30258509299404568402;
  static constexpr double PI = 3.14159265358979323846;
  static constexpr double SQRT2 = 1.41421356237309504880;

  static double abs(double value) { return std::abs(value); }
  static double acos(double value) { return std::acos(value); }
  static double asin(double value) { return std::asin(value); }
  static double atan(double value) { return std::atan(value); }
  static double atan2(double y, double x) { return std::atan2(y, x); }
  static double ceil(double value) { return std::ceil(value); }
  static double cos(double value) { return std::cos(value); }
  static double exp(double value) { return std::exp(value); }
  static double floor(double value) { return std::floor(value); }
  static double log(double value) { return std::log(value); }
  static double log2(double value) { return std::log2(value); }
  static double log10(double value) { return std::log10(value); }
  static double round(double value) { return std::round(value); }
  static double sign(double value) { return (0 < value) - (value < 0); }
  static double sin(double value) { return std::sin(value); }
  static double sqrt(double value) { return std::sqrt(value); }
  static double tan(double value) { return std::tan(value); }
  static double trunc(double value) { return std::trunc(value); }
  static double f16round(double value) { return float16Value(float16Bits(value)); }
  static double pow(double base, double exponent) { return std::pow(base, exponent); }
  template <typename Left, typename Right>
  static double min(const Left& left, const Right& right) { return std::min(Number(left), Number(right)); }
  template <typename Left, typename Right>
  static double max(const Left& left, const Right& right) { return std::max(Number(left), Number(right)); }
  static double hypot(double left, double right) { return std::hypot(left, right); }
  static double random() {
    return static_cast<double>(std::rand()) / static_cast<double>(RAND_MAX);
  }
};

class Console final {
 public:
  void log(std::initializer_list<Value> arguments) const {
    write(std::cout, arguments);
  }

  void info(std::initializer_list<Value> arguments) const {
    write(std::cout, arguments);
  }

  void warn(std::initializer_list<Value> arguments) const {
    write(std::cerr, arguments);
  }

  void error(std::initializer_list<Value> arguments) const {
    write(std::cerr, arguments);
  }

  template <typename... Arguments>
  void log(const Arguments&... arguments) const {
    write(std::cout, arguments...);
  }

  template <typename... Arguments>
  void info(const Arguments&... arguments) const {
    write(std::cout, arguments...);
  }

  template <typename... Arguments>
  void warn(const Arguments&... arguments) const {
    write(std::cerr, arguments...);
  }

  template <typename... Arguments>
  void error(const Arguments&... arguments) const {
    write(std::cerr, arguments...);
  }

 private:
  static void write(std::ostream& output, std::initializer_list<Value> arguments) {
    bool first = true;
    for (const auto& argument : arguments) {
      if (!first) output << ' ';
      first = false;
      print(output, argument);
    }
    output << '\n';
  }

  static void print(std::ostream& output, const Value& value) { output << utf16ToUtf8(toString(value)); }
  static void print(std::ostream& output, const std::u16string& value) { output << utf16ToUtf8(value); }
  static void print(std::ostream& output, bool value) { output << (value ? "true" : "false"); }
  static void print(std::ostream& output, double value) { output << utf16ToUtf8(numberToString(value)); }
  static void print(std::ostream& output, float value) { output << utf16ToUtf8(numberToString(value)); }

  static void print(std::ostream& output, Float16ArrayObject* values) {
    output << utf16ToUtf8(toString(values));
  }

  template <typename T>
  static void print(std::ostream& output, ArrayObject<T>* values) {
    output << utf16ToUtf8(toString(values));
  }

  template <typename T>
  static void print(std::ostream& output, const cppgc::Member<ArrayObject<T>>& values) {
    output << utf16ToUtf8(toString(values));
  }

  template <typename T>
  static void print(std::ostream& output, const cppgc::Persistent<ArrayObject<T>>& values) {
    output << utf16ToUtf8(toString(values));
  }

  template <typename T>
  static void print(std::ostream& output, const T& value) {
    output << value;
  }

  template <typename T>
  static void print(std::ostream& output, const std::vector<T>& values) {
    output << '[';
    for (std::size_t index = 0; index < values.size(); ++index) {
      if (index > 0) output << ", ";
      print(output, values[index]);
    }
    output << ']';
  }

  template <typename... Arguments>
  static void write(std::ostream& output, const Arguments&... arguments) {
    bool first = true;
    const auto printArgument = [&](const auto& argument) {
      if (!first) output << ' ';
      first = false;
      print(output, argument);
    };
    (printArgument(arguments), ...);
    output << '\n';
  }
};

namespace ambient {

namespace Object {
template <typename... Arguments>
inline auto keys(Arguments&&... arguments) {
  return recordKeys(std::forward<Arguments>(arguments)...);
}

template <typename... Arguments>
inline auto values(Arguments&&... arguments) {
  return recordValues(std::forward<Arguments>(arguments)...);
}

template <typename... Arguments>
inline auto entries(Arguments&&... arguments) {
  return recordEntries(std::forward<Arguments>(arguments)...);
}

template <typename... Arguments>
inline auto fromEntries(Arguments&&... arguments) {
  return recordFromEntries(std::forward<Arguments>(arguments)...);
}

template <typename... Arguments>
inline auto groupBy(Arguments&&... arguments) {
  return objectGroupBy(std::forward<Arguments>(arguments)...);
}

template <typename Target, typename Key, typename Descriptor>
inline void defineProperty(Target&& target, Key&& key, Descriptor&& descriptor) {
  const auto descriptorValue = toValue(std::forward<Descriptor>(descriptor));
  if (!descriptorValue.isRecord()) {
    throw runtimeError(u"Native Object.defineProperty requires a record descriptor");
  }
  ::vexa::defineProperty(
    std::forward<Target>(target),
    propertyKey(toValue(std::forward<Key>(key))),
    descriptorValue.record()->get(u"value"),
    toBoolean(descriptorValue.record()->get(u"enumerable")));
}
}  // namespace Object

namespace Map {
template <typename... Arguments>
inline auto groupBy(Arguments&&... arguments) {
  return mapGroupBy(std::forward<Arguments>(arguments)...);
}
}  // namespace Map

namespace Math {
inline constexpr double E = ::vexa::Math::E;
inline constexpr double LN2 = ::vexa::Math::LN2;
inline constexpr double LN10 = ::vexa::Math::LN10;
inline constexpr double PI = ::vexa::Math::PI;
inline constexpr double SQRT2 = ::vexa::Math::SQRT2;

template <typename... Arguments>
inline auto abs(Arguments&&... arguments) { return ::vexa::Math::abs(std::forward<Arguments>(arguments)...); }
template <typename... Arguments>
inline auto acos(Arguments&&... arguments) { return ::vexa::Math::acos(std::forward<Arguments>(arguments)...); }
template <typename... Arguments>
inline auto asin(Arguments&&... arguments) { return ::vexa::Math::asin(std::forward<Arguments>(arguments)...); }
template <typename... Arguments>
inline auto atan(Arguments&&... arguments) { return ::vexa::Math::atan(std::forward<Arguments>(arguments)...); }
template <typename... Arguments>
inline auto atan2(Arguments&&... arguments) { return ::vexa::Math::atan2(std::forward<Arguments>(arguments)...); }
template <typename... Arguments>
inline auto ceil(Arguments&&... arguments) { return ::vexa::Math::ceil(std::forward<Arguments>(arguments)...); }
template <typename... Arguments>
inline auto cos(Arguments&&... arguments) { return ::vexa::Math::cos(std::forward<Arguments>(arguments)...); }
template <typename... Arguments>
inline auto exp(Arguments&&... arguments) { return ::vexa::Math::exp(std::forward<Arguments>(arguments)...); }
template <typename... Arguments>
inline auto floor(Arguments&&... arguments) { return ::vexa::Math::floor(std::forward<Arguments>(arguments)...); }
template <typename... Arguments>
inline auto f16round(Arguments&&... arguments) { return ::vexa::Math::f16round(std::forward<Arguments>(arguments)...); }
template <typename... Arguments>
inline auto hypot(Arguments&&... arguments) { return ::vexa::Math::hypot(std::forward<Arguments>(arguments)...); }
template <typename... Arguments>
inline auto log(Arguments&&... arguments) { return ::vexa::Math::log(std::forward<Arguments>(arguments)...); }
template <typename... Arguments>
inline auto log2(Arguments&&... arguments) { return ::vexa::Math::log2(std::forward<Arguments>(arguments)...); }
template <typename... Arguments>
inline auto log10(Arguments&&... arguments) { return ::vexa::Math::log10(std::forward<Arguments>(arguments)...); }
template <typename... Arguments>
inline auto max(Arguments&&... arguments) { return ::vexa::Math::max(std::forward<Arguments>(arguments)...); }
template <typename... Arguments>
inline auto min(Arguments&&... arguments) { return ::vexa::Math::min(std::forward<Arguments>(arguments)...); }
template <typename... Arguments>
inline auto pow(Arguments&&... arguments) { return ::vexa::Math::pow(std::forward<Arguments>(arguments)...); }
template <typename... Arguments>
inline auto random(Arguments&&... arguments) { return ::vexa::Math::random(std::forward<Arguments>(arguments)...); }
template <typename... Arguments>
inline auto round(Arguments&&... arguments) { return ::vexa::Math::round(std::forward<Arguments>(arguments)...); }
template <typename... Arguments>
inline auto sign(Arguments&&... arguments) { return ::vexa::Math::sign(std::forward<Arguments>(arguments)...); }
template <typename... Arguments>
inline auto sin(Arguments&&... arguments) { return ::vexa::Math::sin(std::forward<Arguments>(arguments)...); }
template <typename... Arguments>
inline auto sqrt(Arguments&&... arguments) { return ::vexa::Math::sqrt(std::forward<Arguments>(arguments)...); }
template <typename... Arguments>
inline auto tan(Arguments&&... arguments) { return ::vexa::Math::tan(std::forward<Arguments>(arguments)...); }
template <typename... Arguments>
inline auto trunc(Arguments&&... arguments) { return ::vexa::Math::trunc(std::forward<Arguments>(arguments)...); }
}  // namespace Math

namespace Number {
template <typename... Arguments>
inline auto isFinite(Arguments&&... arguments) {
  return ::vexa::isFinite(::vexa::Number(std::forward<Arguments>(arguments)...));
}

template <typename... Arguments>
inline auto isInteger(Arguments&&... arguments) {
  return ::vexa::numberIsInteger(std::forward<Arguments>(arguments)...);
}

template <typename... Arguments>
inline auto isNaN(Arguments&&... arguments) {
  return ::vexa::numberIsNaN(std::forward<Arguments>(arguments)...);
}
}  // namespace Number

namespace Array {
template <typename... Arguments>
inline auto isArray(Arguments&&... arguments) {
  return ::vexa::arrayIsArray(std::forward<Arguments>(arguments)...);
}

template <typename... Arguments>
inline auto of(Arguments&&... arguments) {
  return Runtime::array<Value>({toValue(std::forward<Arguments>(arguments))...});
}

template <typename Source>
inline auto from(Source&& source) {
  auto* result = Runtime::array<Value>();
  for (const auto value : dynamicIterationRange(toValue(std::forward<Source>(source)))) result->append(value);
  return result;
}

template <typename Source, typename Callback, typename... Ignored>
inline auto from(Source&& source, Callback callback, Ignored&&...) {
  auto* result = Runtime::array<Value>();
  std::size_t index = 0;
  for (const auto value : dynamicIterationRange(toValue(std::forward<Source>(source)))) {
    result->append(toValue(callback(value, static_cast<double>(index++))));
  }
  return result;
}
}  // namespace Array

namespace String {
template <typename... Arguments>
inline auto fromCharCode(Arguments&&... arguments) {
  std::u16string result;
  result.reserve(sizeof...(arguments));
  (result.push_back(static_cast<char16_t>(::vexa::Number(std::forward<Arguments>(arguments)))), ...);
  return result;
}
}  // namespace String

namespace Date {
template <typename... Arguments>
inline auto now(Arguments&&... arguments) {
  static_assert(sizeof...(arguments) == 0, "Date.now does not take arguments");
  return ::vexa::dateNow();
}

template <typename Argument>
inline auto parse(Argument&& argument) {
  return ::vexa::dateParse(toText(toValue(std::forward<Argument>(argument))));
}
}  // namespace Date

namespace JSON {
template <typename Source, typename... Ignored>
inline auto parse(Source&& source, Ignored&&...) {
  return ::vexa::jsonParse(toValue(std::forward<Source>(source)));
}

template <typename Source, typename... Ignored>
inline auto stringify(Source&& source, Ignored&&...) {
  return ::vexa::jsonStringify(toValue(std::forward<Source>(source)));
}
}  // namespace JSON

namespace RegExp {
template <typename Argument>
inline auto escape(Argument&& argument) {
  return ::vexa::regexEscape(toText(toValue(std::forward<Argument>(argument))));
}
}  // namespace RegExp

namespace Intl {
namespace DurationFormat {
inline auto supportedLocalesOf() {
  return ::vexa::durationFormatSupportedLocales(Value::undefined());
}

template <typename Locales, typename... Ignored>
inline auto supportedLocalesOf(Locales&& locales, Ignored&&...) {
  return ::vexa::durationFormatSupportedLocales(
      toValue(std::forward<Locales>(locales)));
}
}  // namespace DurationFormat
}  // namespace Intl

namespace Iterator {
template <typename Iterable>
inline auto from(Iterable&& iterable) {
  return ::vexa::iteratorFrom(std::forward<Iterable>(iterable));
}
}  // namespace Iterator

namespace Atomics {
template <typename... Arguments>
inline auto waitAsync(Arguments&&... arguments) {
  return ::vexa::atomicsWaitAsync(std::forward<Arguments>(arguments)...);
}
}  // namespace Atomics

namespace Float16Array {
template <typename... Arguments>
inline auto of(Arguments&&... arguments) {
  return ::vexa::float16ArrayOf({::vexa::Number(std::forward<Arguments>(arguments))...});
}

template <typename Source>
inline auto from(Source&& source) {
  return ::vexa::float16ArrayFrom(std::forward<Source>(source));
}

template <typename Source, typename Callback, typename... Ignored>
inline auto from(Source&& source, Callback callback, Ignored&&...) {
  return ::vexa::float16ArrayFrom(std::forward<Source>(source), std::move(callback));
}
}  // namespace Float16Array

namespace performance {
template <typename... Arguments>
inline auto now(Arguments&&... arguments) {
  static_assert(sizeof...(arguments) == 0, "performance.now does not take arguments");
  return ::vexa::performanceNow();
}
}  // namespace performance

namespace Promise {
template <typename Result = Value>
inline auto withResolvers() {
  return makeManaged<PromiseResolvers<Result>>();
}

template <typename Result = Value, typename Callback, typename... Arguments>
inline auto vexa_try(Callback callback, Arguments... arguments) {
  return promiseTry(std::move(callback), std::move(arguments)...);
}

template <typename Result = Value>
Task<Result> resolve() {
  co_return defaultValue<Result>();
}

template <typename Result = Value, typename Input>
inline auto resolve(Input&& input) {
  return promiseResolve(std::forward<Input>(input));
}

template <typename Result = Value, typename Reason>
inline auto reject(Reason&& reason) {
  return rejectedTask<Result>(reason);
}

template <typename Input>
inline auto promiseTasks(ArrayObject<Input>* values) {
  using Result = typename ::vexa::PromiseResult<Input>::Type;
  auto* tasks = Runtime::array<Task<Result>>();
  for (auto value : *values) tasks->append(promiseResolve(std::move(value)));
  return tasks;
}

template <typename Result = Value, typename Input>
inline auto all(ArrayObject<Input>* values) {
  using Element = typename ::vexa::PromiseResult<Input>::Type;
  return promiseAll<Element>(promiseTasks(values));
}

template <typename Result = Value, typename Input>
inline auto race(ArrayObject<Input>* values) {
  using Element = typename ::vexa::PromiseResult<Input>::Type;
  return promiseRace<Element>(promiseTasks(values));
}

template <typename Result = Value, typename Input>
inline auto allSettled(ArrayObject<Input>* values) {
  using Element = typename ::vexa::PromiseResult<Input>::Type;
  return promiseThen(
      promiseAllSettled<Element>(promiseTasks(values)),
      [](ArrayObject<RecordObject*>* records) {
        auto* result = Runtime::array<Value>();
        for (auto record : *records) result->append(Value(record));
        return result;
      });
}

template <typename Result = Value, typename Input>
inline auto any(ArrayObject<Input>* values) {
  using Element = typename ::vexa::PromiseResult<Input>::Type;
  return promiseAny<Element>(promiseTasks(values));
}
}  // namespace Promise

}  // namespace ambient

inline const Console console;

}  // namespace vexa
