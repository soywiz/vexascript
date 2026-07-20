// Minimal VexaScript C++ runtime. This file is intentionally both a header and
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

#if !defined(_WIN32)
#include <sys/wait.h>
#endif

#include "bigint.h"

#include <cppgc/allocation.h>
#include <cppgc/garbage-collected.h>
#include <cppgc/heap.h>
#include <cppgc/member.h>
#include <cppgc/persistent.h>
#include <cppgc/platform.h>
#include <cppgc/visitor.h>
#include <src/base/page-allocator.h>

#if !defined(_WIN32)
extern char** environ;
#endif

namespace vexa {

inline std::u16string utf8ToUtf16(std::string_view input) {
  std::u16string output;
  output.reserve(input.size());
  for (std::size_t index = 0; index < input.size();) {
    const auto first = static_cast<unsigned char>(input[index]);
    std::uint32_t codePoint = 0xfffd;
    std::size_t length = 1;
    if (first <= 0x7f) {
      codePoint = first;
    } else if (first >= 0xc2 && first <= 0xdf && index + 1 < input.size()) {
      const auto second = static_cast<unsigned char>(input[index + 1]);
      if ((second & 0xc0) == 0x80) {
        codePoint = ((first & 0x1f) << 6) | (second & 0x3f);
        length = 2;
      }
    } else if (first >= 0xe0 && first <= 0xef && index + 2 < input.size()) {
      const auto second = static_cast<unsigned char>(input[index + 1]);
      const auto third = static_cast<unsigned char>(input[index + 2]);
      if ((second & 0xc0) == 0x80 && (third & 0xc0) == 0x80 &&
          !(first == 0xe0 && second < 0xa0)) {
        codePoint = ((first & 0x0f) << 12) | ((second & 0x3f) << 6) | (third & 0x3f);
        length = 3;
      }
    } else if (first >= 0xf0 && first <= 0xf4 && index + 3 < input.size()) {
      const auto second = static_cast<unsigned char>(input[index + 1]);
      const auto third = static_cast<unsigned char>(input[index + 2]);
      const auto fourth = static_cast<unsigned char>(input[index + 3]);
      if ((second & 0xc0) == 0x80 && (third & 0xc0) == 0x80 && (fourth & 0xc0) == 0x80 &&
          !(first == 0xf0 && second < 0x90) && !(first == 0xf4 && second >= 0x90)) {
        codePoint = ((first & 0x07) << 18) | ((second & 0x3f) << 12) |
            ((third & 0x3f) << 6) | (fourth & 0x3f);
        length = 4;
      }
    }
    index += length;
    if (codePoint <= 0xffff) {
      output.push_back(static_cast<char16_t>(codePoint));
    } else {
      codePoint -= 0x10000;
      output.push_back(static_cast<char16_t>(0xd800 + (codePoint >> 10)));
      output.push_back(static_cast<char16_t>(0xdc00 + (codePoint & 0x3ff)));
    }
  }
  return output;
}

inline std::string utf16ToUtf8(std::u16string_view input) {
  std::string output;
  output.reserve(input.size());
  for (std::size_t index = 0; index < input.size(); ++index) {
    std::uint32_t codePoint = input[index];
    if (codePoint >= 0xd800 && codePoint <= 0xdbff && index + 1 < input.size()) {
      const std::uint32_t low = input[index + 1];
      if (low >= 0xdc00 && low <= 0xdfff) {
        codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (low - 0xdc00);
        ++index;
      }
    }
    if (codePoint <= 0x7f) {
      output.push_back(static_cast<char>(codePoint));
    } else if (codePoint <= 0x7ff) {
      output.push_back(static_cast<char>(0xc0 | (codePoint >> 6)));
      output.push_back(static_cast<char>(0x80 | (codePoint & 0x3f)));
    } else if (codePoint <= 0xffff) {
      output.push_back(static_cast<char>(0xe0 | (codePoint >> 12)));
      output.push_back(static_cast<char>(0x80 | ((codePoint >> 6) & 0x3f)));
      output.push_back(static_cast<char>(0x80 | (codePoint & 0x3f)));
    } else {
      output.push_back(static_cast<char>(0xf0 | (codePoint >> 18)));
      output.push_back(static_cast<char>(0x80 | ((codePoint >> 12) & 0x3f)));
      output.push_back(static_cast<char>(0x80 | ((codePoint >> 6) & 0x3f)));
      output.push_back(static_cast<char>(0x80 | (codePoint & 0x3f)));
    }
  }
  return output;
}

using PropertyKey = std::u16string;

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

class Value;

class Text final {
 public:
  Text() = default;
  Text(const char* value) : value_(utf8ToUtf16(value)) {}
  Text(std::string value) : value_(utf8ToUtf16(value)) {}
  Text(std::string_view value) : value_(utf8ToUtf16(value)) {}
  Text(const char16_t* value) : value_(value) {}
  Text(std::u16string value) : value_(std::move(value)) {}
  Text(std::u16string_view value) : value_(value) {}
  Text(const Value& value);

  const std::u16string& utf16() const { return value_; }
  std::string utf8() const { return utf16ToUtf8(value_); }
  std::size_t size() const { return value_.size(); }
  bool empty() const { return value_.empty(); }
  char16_t operator[](std::size_t index) const { return value_[index]; }
  explicit operator bool() const { return !value_.empty(); }

  Text& operator+=(const Text& other) {
    value_ += other.value_;
    return *this;
  }

  operator std::string() const { return utf8(); }

  friend Text operator+(Text left, const Text& right) {
    left += right;
    return left;
  }
  friend bool operator==(const Text&, const Text&) = default;
  friend auto operator<=>(const Text&, const Text&) = default;
  friend std::ostream& operator<<(std::ostream& output, const Text& value) {
    return output << value.utf8();
  }

 private:
  std::u16string value_;
};

class StringObject final : public cppgc::GarbageCollected<StringObject> {
 public:
  explicit StringObject(std::string value)
      : value_(utf8ToUtf16(value)), size_(value_->size()) {}
  explicit StringObject(std::u16string value)
      : value_(std::move(value)), size_(value_->size()) {}
  StringObject(StringObject* left, StringObject* right)
      : left_(left), right_(right), size_(left->size() + right->size()) {}

  void Trace(cppgc::Visitor* visitor) const {
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

  std::string utf8() const { return utf16ToUtf8(value()); }

 private:
  mutable std::optional<std::u16string> value_;
  cppgc::Member<StringObject> left_;
  cppgc::Member<StringObject> right_;
  std::size_t size_ = 0;
};

struct Undefined final {};
struct Null final {};
class RecordObject;
class Runtime;
Runtime& currentRuntime();
template <typename T, typename... Arguments>
T* makeManaged(Arguments&&... arguments);
class DynamicValueObject;
class EnumerableObject;
class Value;
std::runtime_error errorAtCurrentSource(std::string);
template <typename T>
class ArrayObject;
template <typename K, typename V>
class MapObject;
template <typename T>
class SetObject;
ArrayObject<Value>* makeDynamicArrayValueView(DynamicValueObject* backing);
std::string toString(const Value&);
std::string jsonQuoted(const std::string&);
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
Result functionFromValue(Runtime&, const Value&);
template <typename T>
std::string jsonStringifyNative(const T&, std::unordered_set<const void*>&);
template <typename T>
class Task;
template <typename T>
struct PromiseResult;
template <typename T>
std::string toString(const Task<T>&);
RecordObject* makeDynamicPropertyRecord(Runtime&);

template <typename T>
inline const void* nativeTypeToken() {
  static const int token = 0;
  return &token;
}

class DynamicValueObject : public cppgc::GarbageCollectedMixin {
 public:
  virtual ~DynamicValueObject() = default;
  virtual const void* dynamicTypeToken() const = 0;
  virtual void* dynamicCast(const void* type) = 0;
  virtual std::string dynamicToString() const = 0;
  virtual std::optional<std::string> dynamicJsonStringify(std::unordered_set<const void*>&) const {
    return std::nullopt;
  }
  virtual Value dynamicGet(const PropertyKey&);
  virtual Value dynamicSet(const PropertyKey&, const Value&);
  virtual std::vector<std::string> dynamicKeys() const;
  virtual bool dynamicDelete(const PropertyKey&);
  virtual Value dynamicCall(Runtime&, const std::vector<Value>&);
  virtual bool dynamicIsArray() const { return false; }
  virtual std::size_t dynamicArraySize() const { return 0; }
  virtual Value dynamicArrayGet(Runtime&, std::size_t);
  virtual bool dynamicIsIterable() const;
  virtual std::size_t dynamicIterableSize() const;
  virtual Value dynamicIterableGet(Runtime&, std::size_t);
  void dynamicDefineProperty(const PropertyKey&, const Value&, bool enumerable);
  std::vector<std::string> dynamicEnumerableKeys(std::vector<std::string>) const;
  void Trace(cppgc::Visitor*) const;

 private:
  cppgc::Member<RecordObject> dynamic_properties_;
  std::unordered_set<PropertyKey> non_enumerable_properties_;
};

class Value final {
 public:
  using Storage = std::variant<
      Undefined,
      Null,
      bool,
      double,
      BigInt,
      cppgc::Persistent<StringObject>,
      cppgc::Persistent<RecordObject>,
      cppgc::Persistent<DynamicValueObject>>;

  Value() : storage_(Undefined{}) {}
  Value(bool value) : storage_(value) {}
  Value(double value) : storage_(value) {}
  Value(int value) : storage_(static_cast<double>(value)) {}
  Value(BigInt value) : storage_(std::move(value)) {}
  explicit Value(StringObject* value) : storage_(cppgc::Persistent<StringObject>(value)) {}
  explicit Value(RecordObject* value);
  template <typename T>
    requires std::is_base_of_v<DynamicValueObject, T>
  Value(T* value) : storage_(cppgc::Persistent<DynamicValueObject>(value)) {}
  explicit Value(DynamicValueObject* value)
      : storage_(cppgc::Persistent<DynamicValueObject>(value)) {}

  static Value undefined() { return Value(); }
  static Value null() { return Value(Null{}); }

  bool isUndefined() const { return std::holds_alternative<Undefined>(storage_); }
  bool isNull() const { return std::holds_alternative<Null>(storage_); }
  bool isBoolean() const { return std::holds_alternative<bool>(storage_); }
  bool isNumber() const { return std::holds_alternative<double>(storage_); }
  bool isBigInt() const { return std::holds_alternative<BigInt>(storage_); }
  bool isString() const { return std::holds_alternative<cppgc::Persistent<StringObject>>(storage_); }
  bool isRecord() const { return std::holds_alternative<cppgc::Persistent<RecordObject>>(storage_); }
  bool isDynamicObject() const {
    return std::holds_alternative<cppgc::Persistent<DynamicValueObject>>(storage_);
  }

  bool boolean() const { return std::get<bool>(storage_); }
  double number() const { return std::get<double>(storage_); }
  const BigInt& bigint() const { return std::get<BigInt>(storage_); }
  std::string string() const {
    return std::get<cppgc::Persistent<StringObject>>(storage_)->utf8();
  }
  const std::u16string& utf16() const {
    return std::get<cppgc::Persistent<StringObject>>(storage_)->value();
  }
  StringObject* stringObject() const {
    return std::get<cppgc::Persistent<StringObject>>(storage_).Get();
  }
  RecordObject* record() const;
  DynamicValueObject* dynamicObject() const {
    return std::get<cppgc::Persistent<DynamicValueObject>>(storage_).Get();
  }

  explicit operator bool() const {
    if (isUndefined() || isNull()) return false;
    if (isBoolean()) return boolean();
    if (isNumber()) return number() != 0 && !std::isnan(number());
    if (isBigInt()) return !bigint().isZero();
    return !isString() || !utf16().empty();
  }

  bool operator==(const Value& other) const;

 private:
  friend class StoredValue;
  explicit Value(Null value) : storage_(value) {}
  Storage storage_;
};

inline Text::Text(const Value& value) {
  if (!value.isString()) {
    throw errorAtCurrentSource("VexaScript value is not a string");
  }
  value_ = value.utf16();
}

class StoredValue final {
 public:
  using Storage = std::variant<
      Undefined,
      Null,
      bool,
      double,
      BigInt,
      StringObject*,
      RecordObject*,
      DynamicValueObject*>;

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

inline std::size_t stringCodeUnitLength(const std::string& value) {
  return utf8ToUtf16(value).size();
}

inline std::size_t stringCodeUnitLength(const Text& value) {
  return value.size();
}

inline std::int32_t stringFirstCodeUnit(const Value& value) {
  return value.isString() && !value.utf16().empty()
    ? static_cast<std::uint16_t>(value.utf16()[0])
    : -1;
}

inline std::int32_t stringFirstCodeUnit(const Text& value) {
  return value.empty() ? -1 : static_cast<std::uint16_t>(value[0]);
}

class RecordObject final : public cppgc::GarbageCollected<RecordObject>, public cppgc::GarbageCollectedMixin {
 public:
  RecordObject() = default;
  explicit RecordObject(DynamicValueObject* dynamicBacking);

  Value get(const char* key) const;
  Value get(const std::string& key) const;
  Value get(const Text& key) const;
  Value get(const PropertyKey& key) const;
  void set(const char* key, const Value& value);
  void set(std::string key, const Value& value);
  void set(Text key, const Value& value);
  void set(PropertyKey key, const Value& value);
  void setHidden(const char* key, const Value& value);
  void setHidden(std::string key, const Value& value);
  void setHidden(Text key, const Value& value);
  void setHidden(PropertyKey key, const Value& value);
  bool has(const char* key) const;
  bool has(const std::string& key) const;
  bool has(const PropertyKey& key) const;
  bool erase(const char* key);
  bool erase(const std::string& key);
  bool erase(const PropertyKey& key);
  void copyTo(RecordObject* target) const;
  std::vector<std::string> keys() const;
  std::vector<Value> values() const;
  void Trace(cppgc::Visitor* visitor) const;

 private:
  cppgc::Member<DynamicValueObject> dynamic_backing_;
  std::unordered_map<PropertyKey, StoredValue> properties_;
  std::unordered_map<PropertyKey, StoredValue> hidden_properties_;
  std::vector<PropertyKey> property_order_;
};

class EnumerableObject {
 public:
  virtual ~EnumerableObject() = default;
  virtual void* nativeInterfaceCast(const void* type) {
    return type == nativeTypeToken<EnumerableObject>() ? this : nullptr;
  }
  virtual std::vector<std::string> enumerableKeys() const { return {}; }
  virtual Value enumerableGet(const std::string&) { return Value::undefined(); }
  virtual RecordObject* enumerableBackingRecord() { return nullptr; }
  virtual void defineProperty(const PropertyKey&, const Value&, bool) {
    throw std::runtime_error("Native object does not support dynamic property definitions");
  }
};

template <typename T>
struct ArrayObjectPointerTraits final {
  static constexpr bool value = false;
};

template <typename T>
struct ArrayObjectPointerTraits<ArrayObject<T>*> final {
  static constexpr bool value = true;
  using Element = T;
};

template <typename T>
struct MapObjectPointerTraits final {
  static constexpr bool value = false;
};

template <typename K, typename V>
struct MapObjectPointerTraits<MapObject<K, V>*> final {
  static constexpr bool value = true;
  using Key = K;
  using Mapped = V;
};

template <typename T>
struct SetObjectPointerTraits final {
  static constexpr bool value = false;
};

template <typename V>
struct SetObjectPointerTraits<SetObject<V>*> final {
  static constexpr bool value = true;
  using Element = V;
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

inline std::vector<std::string> objectKeys(RecordObject* object) {
  return object ? object->keys() : std::vector<std::string>{};
}

inline std::vector<std::string> objectKeys(EnumerableObject* object) {
  return object ? object->enumerableKeys() : std::vector<std::string>{};
}

inline std::vector<std::string> objectKeys(DynamicValueObject* object) {
  return object
    ? object->dynamicEnumerableKeys(object->dynamicKeys())
    : std::vector<std::string>{};
}

inline std::vector<std::string> objectKeys(const Value& value) {
  if (value.isRecord()) return value.record()->keys();
  if (value.isDynamicObject()) return objectKeys(value.dynamicObject());
  return {};
}

template <typename T>
  requires std::is_base_of_v<DynamicValueObject, T>
inline std::vector<std::string> objectKeys(T* object) {
  return objectKeys(static_cast<DynamicValueObject*>(object));
}

inline Value enumerableGet(Runtime&, RecordObject* object, const std::string& key) {
  return object ? object->get(key) : Value::undefined();
}

inline Value enumerableGet(Runtime&, EnumerableObject* object, const std::string& key) {
  return object ? object->enumerableGet(key) : Value::undefined();
}

inline Value::Value(RecordObject* value)
    : storage_(cppgc::Persistent<RecordObject>(value)) {}

inline RecordObject* Value::record() const {
  return std::get<cppgc::Persistent<RecordObject>>(storage_).Get();
}

inline bool Value::operator==(const Value& other) const {
  if (storage_.index() != other.storage_.index()) return false;
  if (isUndefined() || isNull()) return true;
  if (isBoolean()) return boolean() == other.boolean();
  if (isNumber()) return number() == other.number();
  if (isBigInt()) return bigint() == other.bigint();
  if (isString()) return utf16() == other.utf16();
  if (isRecord()) return record() == other.record();
  return dynamicObject() == other.dynamicObject();
}

template <typename T, typename Other>
  requires std::is_same_v<std::remove_cvref_t<Other>, Value>
inline bool operator==(const cppgc::Persistent<T>& value, Other&& other) {
  if (other.isUndefined() || other.isNull()) return value.Get() == nullptr;
  if (!other.isDynamicObject()) return false;
  return other.dynamicObject()->dynamicCast(nativeTypeToken<T>()) == value.Get();
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
  if (!other.isDynamicObject()) return false;
  return other.dynamicObject()->dynamicCast(nativeTypeToken<T>()) == value.Get();
}

template <typename Other, typename T>
  requires std::is_same_v<std::remove_cvref_t<Other>, Value>
inline bool operator==(Other&& other, const cppgc::Member<T>& value) {
  return value == std::forward<Other>(other);
}

inline Value DynamicValueObject::dynamicCall(Runtime&, const std::vector<Value>&) {
  throw std::runtime_error("VexaScript dynamic value is not callable");
}

inline Value DynamicValueObject::dynamicGet(const PropertyKey& key) {
  return dynamic_properties_ ? dynamic_properties_->get(key) : Value::undefined();
}

inline Value DynamicValueObject::dynamicSet(const PropertyKey& key, const Value& value) {
  auto& runtime = currentRuntime();
  if (!dynamic_properties_) dynamic_properties_ = makeDynamicPropertyRecord(runtime);
  dynamic_properties_->set(key, value);
  return value;
}

inline std::vector<std::string> DynamicValueObject::dynamicKeys() const {
  return dynamic_properties_ ? dynamic_properties_->keys() : std::vector<std::string>{};
}

inline void DynamicValueObject::dynamicDefineProperty(
    const PropertyKey& key,
    const Value& value,
    bool enumerable) {
  dynamicSet(key, value);
  if (enumerable) non_enumerable_properties_.erase(key);
  else non_enumerable_properties_.insert(key);
}

inline std::vector<std::string> DynamicValueObject::dynamicEnumerableKeys(
    std::vector<std::string> keys) const {
  std::erase_if(keys, [&](const std::string& key) {
    return non_enumerable_properties_.contains(utf8ToUtf16(key));
  });
  return keys;
}

inline bool DynamicValueObject::dynamicDelete(const PropertyKey& key) {
  non_enumerable_properties_.erase(key);
  return dynamic_properties_ && dynamic_properties_->erase(key);
}

inline void DynamicValueObject::Trace(cppgc::Visitor* visitor) const {
  visitor->Trace(dynamic_properties_);
}

inline RecordObject::RecordObject(DynamicValueObject* dynamicBacking)
    : dynamic_backing_(dynamicBacking) {}

inline Value RecordObject::get(const char* key) const {
  return get(utf8ToUtf16(key));
}

inline Value RecordObject::get(const std::string& key) const {
  return get(utf8ToUtf16(key));
}

inline Value RecordObject::get(const Text& key) const {
  return get(key.utf16());
}

inline Value RecordObject::get(const PropertyKey& key) const {
  if (dynamic_backing_) return dynamic_backing_->dynamicGet(key);
  const auto property = properties_.find(key);
  if (property != properties_.end()) return property->second.load();
  const auto hidden = hidden_properties_.find(key);
  return hidden == hidden_properties_.end() ? Value::undefined() : hidden->second.load();
}

inline void RecordObject::set(const char* key, const Value& value) {
  set(utf8ToUtf16(key), value);
}

inline void RecordObject::set(std::string key, const Value& value) {
  set(utf8ToUtf16(key), value);
}

inline void RecordObject::set(Text key, const Value& value) {
  set(PropertyKey(key.utf16()), value);
}

inline void RecordObject::set(PropertyKey key, const Value& value) {
  if (dynamic_backing_) {
    dynamic_backing_->dynamicSet(key, value);
    return;
  }
  hidden_properties_.erase(key);
  if (!properties_.contains(key)) property_order_.push_back(key);
  properties_.insert_or_assign(std::move(key), StoredValue(value));
}

inline void RecordObject::setHidden(const char* key, const Value& value) {
  setHidden(utf8ToUtf16(key), value);
}

inline void RecordObject::setHidden(std::string key, const Value& value) {
  setHidden(utf8ToUtf16(key), value);
}

inline void RecordObject::setHidden(Text key, const Value& value) {
  setHidden(PropertyKey(key.utf16()), value);
}

inline void RecordObject::setHidden(PropertyKey key, const Value& value) {
  if (dynamic_backing_) {
    dynamic_backing_->dynamicDefineProperty(key, value, false);
    return;
  }
  if (properties_.erase(key) > 0) {
    property_order_.erase(std::remove(property_order_.begin(), property_order_.end(), key), property_order_.end());
  }
  hidden_properties_.insert_or_assign(std::move(key), StoredValue(value));
}

inline bool RecordObject::has(const char* key) const {
  return has(utf8ToUtf16(key));
}

inline bool RecordObject::has(const std::string& key) const {
  return has(utf8ToUtf16(key));
}

inline bool RecordObject::has(const PropertyKey& key) const {
  if (dynamic_backing_) {
    const auto keys = dynamic_backing_->dynamicKeys();
    return std::find(keys.begin(), keys.end(), utf16ToUtf8(key)) != keys.end();
  }
  return properties_.contains(key) || hidden_properties_.contains(key);
}

inline bool RecordObject::erase(const char* key) {
  return erase(utf8ToUtf16(key));
}

inline bool RecordObject::erase(const std::string& key) {
  return erase(utf8ToUtf16(key));
}

inline bool RecordObject::erase(const PropertyKey& key) {
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

inline std::vector<std::string> RecordObject::keys() const {
  if (dynamic_backing_) {
    return dynamic_backing_->dynamicEnumerableKeys(dynamic_backing_->dynamicKeys());
  }
  std::vector<std::string> result;
  result.reserve(property_order_.size());
  for (const auto& key : property_order_) result.push_back(utf16ToUtf8(key));
  return result;
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
  visitor->Trace(dynamic_backing_);
  for (const auto& [key, value] : properties_) value.Trace(visitor);
  for (const auto& [key, value] : hidden_properties_) value.Trace(visitor);
}

inline Value DynamicValueObject::dynamicArrayGet(Runtime&, std::size_t) {
  throw std::runtime_error("Dynamic native object is not an array");
}

inline bool DynamicValueObject::dynamicIsIterable() const {
  return dynamicIsArray();
}

inline std::size_t DynamicValueObject::dynamicIterableSize() const {
  return dynamicArraySize();
}

inline Value DynamicValueObject::dynamicIterableGet(Runtime& runtime, std::size_t index) {
  return dynamicArrayGet(runtime, index);
}

Value makeDynamicMapEntry(Runtime& runtime, Value key, Value value);

inline Value StoredValue::load() const {
  if (std::holds_alternative<Undefined>(storage_)) return Value::undefined();
  if (std::holds_alternative<Null>(storage_)) return Value::null();
  if (const auto* value = std::get_if<bool>(&storage_)) return Value(*value);
  if (const auto* value = std::get_if<double>(&storage_)) return Value(*value);
  if (const auto* value = std::get_if<BigInt>(&storage_)) return Value(*value);
  if (const auto* value = std::get_if<StringObject*>(&storage_)) {
    return Value(*value);
  }
  if (const auto* value = std::get_if<RecordObject*>(&storage_)) {
    return Value(*value);
  }
  return Value(std::get<DynamicValueObject*>(storage_));
}

inline StoredValue::operator Value() const { return load(); }

inline void StoredValue::store(const Value& value) {
  if (value.isUndefined()) storage_ = Undefined{};
  else if (value.isNull()) storage_ = Null{};
  else if (value.isBoolean()) storage_ = value.boolean();
  else if (value.isNumber()) storage_ = value.number();
  else if (value.isBigInt()) storage_ = value.bigint();
  else if (value.isString()) {
    storage_ = std::get<cppgc::Persistent<StringObject>>(value.storage_).Get();
  } else {
    if (value.isRecord()) storage_ = value.record();
    else storage_ = value.dynamicObject();
  }
}

inline void StoredValue::Trace(cppgc::Visitor* visitor) const {
  if (const auto* value = std::get_if<StringObject*>(&storage_)) {
    const cppgc::Member<StringObject> member(*value);
    visitor->Trace(member);
  } else if (const auto* value = std::get_if<RecordObject*>(&storage_)) {
    const cppgc::Member<RecordObject> member(*value);
    visitor->Trace(member);
  } else if (const auto* value = std::get_if<DynamicValueObject*>(&storage_)) {
    const cppgc::Member<DynamicValueObject> member(*value);
    visitor->Trace(member);
  }
}

template <typename T>
class ArraySlot final {
 public:
  ArraySlot() = default;
  explicit ArraySlot(T value) : value_(std::move(value)) {}

  T load() const { return value_; }
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
    std::is_same_v<T, Value> || std::is_same_v<T, Text> ||
    std::is_same_v<T, std::string> ||
    std::is_same_v<T, BigInt> || std::is_arithmetic_v<T> ||
    (std::is_pointer_v<T> &&
     (std::is_base_of_v<DynamicValueObject, std::remove_pointer_t<T>> ||
      std::is_base_of_v<EnumerableObject, std::remove_pointer_t<T>> ||
      std::is_same_v<std::remove_pointer_t<T>, RecordObject>));

// Language arrays have reference semantics. The backing storage is an Oilpan
// object, and every GC-managed element is represented by a traced Member edge.
template <typename T>
class ArrayObject final : public cppgc::GarbageCollected<ArrayObject<T>>, public DynamicValueObject {
 public:
  ArrayObject() = default;
  explicit ArrayObject(DynamicValueObject* dynamicBacking) : dynamic_backing_(dynamicBacking) {}
  explicit ArrayObject(std::initializer_list<T> values) {
    values_.reserve(values.size());
    for (const auto& value : values) values_.emplace_back(value);
  }

  std::size_t size() const {
    return dynamic_backing_ ? dynamic_backing_->dynamicArraySize() : values_.size();
  }
  bool empty() const { return size() == 0; }
  void resize(std::size_t size) {
    if (dynamic_backing_) {
      dynamic_backing_->dynamicSet(u"length", Value(static_cast<double>(size)));
      return;
    }
    values_.resize(size);
  }
  T get(std::size_t index) const {
    if (dynamic_backing_) {
      if constexpr (IsDynamicArrayElement<T>) {
        return convertValue<T>(dynamic_backing_->dynamicArrayGet(currentRuntime(), index));
      } else {
        throw std::runtime_error("This native array element type cannot flow through a dynamic array view");
      }
    }
    if (index >= values_.size()) return T{};
    return values_[index].load();
  }
  T set(std::size_t index, T value) {
    if (dynamic_backing_) {
      if constexpr (IsDynamicArrayElement<T>) {
        dynamic_backing_->dynamicSet(utf8ToUtf16(std::to_string(index)), convertValue<Value>(value));
        return value;
      } else {
        throw std::runtime_error("This native array element type cannot flow through a dynamic array view");
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
    values_.emplace_back(value);
  }
  void insert(std::size_t index, T value) {
    values_.insert(values_.begin() + static_cast<std::ptrdiff_t>(std::min(index, values_.size())), ArraySlot<T>(value));
  }
  void prepend(T value) { values_.insert(values_.begin(), ArraySlot<T>(value)); }
  double push(T value) {
    append(std::move(value));
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
  double unshift(T value) {
    prepend(std::move(value));
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
  T at(double index) const;
  ArrayObject* slice(
      Runtime& runtime,
      double start = 0,
      double end = std::numeric_limits<double>::infinity()) const;
  template <typename... Items>
  ArrayObject* concat(Runtime& runtime, Items&&... items) const;
  template <typename Callback>
  auto map(Runtime& runtime, Callback callback) const;
  template <typename Callback>
  ArrayObject* filter(Runtime& runtime, Callback callback) const;
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
  template <typename... Items>
  ArrayObject* splice(
      Runtime& runtime,
      double start,
      double deleteCount = std::numeric_limits<double>::infinity(),
      Items&&... items);
  ArrayObject* fill(T value, double start = 0, double end = std::numeric_limits<double>::infinity());
  ArrayObject* copyWithin(double target, double start, double end = std::numeric_limits<double>::infinity());
  ArrayObject* sort();
  template <typename Callback>
  ArrayObject* sort(Callback callback);
  std::string join(const std::string& separator = ",") const;
  std::string toString() const;
  const void* dynamicTypeToken() const override { return nativeTypeToken<ArrayObject<T>>(); }
  void* dynamicCast(const void* type) override {
    return type == nativeTypeToken<ArrayObject<T>>() ? this : nullptr;
  }
  std::string dynamicToString() const override { return toString(); }
  bool dynamicIsArray() const override { return true; }
  bool dynamicIsIterable() const override { return true; }
  std::size_t dynamicIterableSize() const override { return size(); }
  Value dynamicIterableGet(Runtime& runtime, std::size_t index) override {
    return dynamicArrayGet(runtime, index);
  }
  std::size_t dynamicArraySize() const override { return size(); }
  Value dynamicArrayGet(Runtime& runtime, std::size_t index) override {
    if constexpr (IsDynamicArrayElement<T>) {
      return index < size() ? convertValue<Value>(get(index)) : Value::undefined();
    } else {
      throw std::runtime_error("This native array element type cannot flow through dynamic iteration");
    }
  }
  std::optional<std::string> dynamicJsonStringify(std::unordered_set<const void*>& seen) const override {
    if (!seen.insert(this).second) throw std::runtime_error("Converting circular structure to JSON");
    std::ostringstream output;
    output << '[';
    for (std::size_t index = 0; index < size(); ++index) {
      if (index > 0) output << ',';
      output << jsonStringifyNative(get(index), seen);
    }
    output << ']';
    seen.erase(this);
    return output.str();
  }
  Value dynamicGet(const PropertyKey& key) override;
  Value dynamicSet(const PropertyKey& key, const Value& value) override {
    auto& runtime = currentRuntime();
    if constexpr (IsDynamicArrayElement<T>) {
      if (key == u"length") {
        resize(static_cast<std::size_t>(convertValue<double>(value)));
        return value;
      }
      const auto index = propertyIndex(key);
      if (!index) throw std::runtime_error("Invalid dynamic array index");
      set(*index, convertValue<T>(value));
      return value;
    } else {
      throw std::runtime_error("This native array element type cannot flow through dynamic access");
    }
  }
  bool dynamicDelete(const PropertyKey&) override { return false; }

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
    visitor->Trace(dynamic_backing_);
    for (const auto& value : values_) value.Trace(visitor);
  }

 private:
  cppgc::Member<DynamicValueObject> dynamic_backing_;
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

template <typename T>
struct SameValueZeroHash final {
  std::size_t operator()(const T& value) const {
    if constexpr (std::is_same_v<T, BigInt>) {
      return std::hash<std::string>{}(value.toString());
    } else if constexpr (std::is_same_v<T, Text>) {
      return std::hash<std::u16string>{}(value.utf16());
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
      return std::hash<std::string>{}(value.bigint().toString()) ^ 0x79;
    }
    if (value.isString()) return std::hash<std::u16string>{}(value.utf16()) ^ 0x83;
    if (value.isRecord()) return std::hash<const void*>{}(value.record()) ^ 0x97;
    return std::hash<const void*>{}(value.dynamicObject()) ^ 0xa9;
  }
};

template <typename T>
struct SameValueZeroEqual final {
  bool operator()(const T& left, const T& right) const {
    return sameValueZero(left, right);
  }
};

class MapLikeObject : public DynamicValueObject {
 public:
  virtual std::size_t dynamicMapSize() const = 0;
  virtual Value dynamicMapKeyAt(Runtime&, std::size_t) = 0;
  virtual Value dynamicMapValueAt(Runtime&, std::size_t) = 0;
  virtual std::optional<Value> dynamicMapGet(Runtime&, const Value&) = 0;
  virtual void dynamicMapSet(Runtime&, const Value&, const Value&) = 0;
  virtual bool dynamicMapDelete(Runtime&, const Value&) = 0;
  virtual void dynamicMapClear() = 0;
};
class SetLikeObject : public DynamicValueObject {};
class WeakMapLikeObject : public DynamicValueObject {};
class WeakSetLikeObject : public DynamicValueObject {};

template <typename K, typename V>
class MapObject final : public cppgc::GarbageCollected<MapObject<K, V>>, public MapLikeObject {
 public:
  MapObject() = default;
  explicit MapObject(MapLikeObject* dynamicBacking) : dynamic_backing_(dynamicBacking) {}

  std::size_t size() const { return dynamic_backing_ ? dynamic_backing_->dynamicMapSize() : entries_.size(); }

  MapObject* set(K key, V value) {
    if (dynamic_backing_) {
      dynamic_backing_->dynamicMapSet(
          currentRuntime(),
          convertValue<Value>(key),
          convertValue<Value>(value));
      return this;
    }
    const auto existing = index_.find(key);
    if (existing != index_.end()) {
      entries_[existing->second].value.store(std::move(value));
      return this;
    }
    entries_.push_back(Entry{ArraySlot<K>(std::move(key)), ArraySlot<V>(std::move(value))});
    index_.emplace(entries_.back().key.load(), entries_.size() - 1);
    return this;
  }

  std::optional<V> get(const K& key) const {
    if (dynamic_backing_) {
      const auto found = dynamic_backing_->dynamicMapGet(currentRuntime(), convertValue<Value>(key));
      if (!found) return std::nullopt;
      try {
        return std::optional<V>(convertValue<V>(*found));
      } catch (const std::runtime_error& error) {
        throw std::runtime_error(
            std::string(error.what()) + " while reading Map key " +
            toString(convertValue<Value>(key)));
      }
    }
    const auto found = index_.find(key);
    return found == index_.end()
        ? std::nullopt
        : std::optional<V>(entries_[found->second].value.load());
  }

  bool has(const K& key) const { return get(key).has_value(); }

  bool erase(const K& key) {
    if (dynamic_backing_) {
      return dynamic_backing_->dynamicMapDelete(currentRuntime(), convertValue<Value>(key));
    }
    const auto found = index_.find(key);
    if (found == index_.end()) return false;
    const std::size_t erasedIndex = found->second;
    entries_.erase(entries_.begin() + static_cast<std::ptrdiff_t>(erasedIndex));
    rebuildIndex(erasedIndex);
    return true;
  }

  void clear() {
    if (dynamic_backing_) {
      dynamic_backing_->dynamicMapClear();
      return;
    }
    entries_.clear();
    index_.clear();
  }

  template <typename Callback>
  void forEach(Callback callback) {
    if (dynamic_backing_) {
      auto& runtime = currentRuntime();
      for (std::size_t index = 0; index < dynamic_backing_->dynamicMapSize(); ++index) {
        const K key = convertValue<K>(dynamic_backing_->dynamicMapKeyAt(runtime, index));
        const V value = convertValue<V>(dynamic_backing_->dynamicMapValueAt(runtime, index));
        if constexpr (std::is_invocable_v<Callback, V, K, MapObject*>) callback(value, key, this);
        else if constexpr (std::is_invocable_v<Callback, V, K>) callback(value, key);
        else callback(value);
      }
      return;
    }
    for (const auto& entry : entries_) {
      if constexpr (std::is_invocable_v<Callback, V, K, MapObject*>) {
        callback(entry.value.load(), entry.key.load(), this);
      } else if constexpr (std::is_invocable_v<Callback, V, K>) {
        callback(entry.value.load(), entry.key.load());
      } else {
        callback(entry.value.load());
      }
    }
  }

  const void* dynamicTypeToken() const override { return nativeTypeToken<MapObject<K, V>>(); }
  void* dynamicCast(const void* type) override {
    if (type == nativeTypeToken<MapObject<K, V>>()) return this;
    if (type == nativeTypeToken<MapLikeObject>()) return static_cast<MapLikeObject*>(this);
    return nullptr;
  }
  std::string dynamicToString() const override { return "[object Map]"; }
  bool dynamicIsIterable() const override { return true; }
  std::size_t dynamicIterableSize() const override { return size(); }
  Value dynamicIterableGet(Runtime& runtime, std::size_t index) override {
    if (index >= size()) return Value::undefined();
    return makeDynamicMapEntry(
        runtime,
        dynamicMapKeyAt(runtime, index),
        dynamicMapValueAt(runtime, index));
  }

  std::size_t dynamicMapSize() const override { return size(); }
  Value dynamicMapKeyAt(Runtime& runtime, std::size_t index) override {
    if (dynamic_backing_) return dynamic_backing_->dynamicMapKeyAt(runtime, index);
    return index < entries_.size() ? convertValue<Value>(entries_[index].key.load()) : Value::undefined();
  }
  Value dynamicMapValueAt(Runtime& runtime, std::size_t index) override {
    if (dynamic_backing_) return dynamic_backing_->dynamicMapValueAt(runtime, index);
    return index < entries_.size() ? convertValue<Value>(entries_[index].value.load()) : Value::undefined();
  }
  std::optional<Value> dynamicMapGet(Runtime& runtime, const Value& key) override {
    if (dynamic_backing_) return dynamic_backing_->dynamicMapGet(runtime, key);
    const auto found = get(convertValue<K>(key));
    return found ? std::optional<Value>(convertValue<Value>(*found)) : std::nullopt;
  }
  void dynamicMapSet(Runtime& runtime, const Value& key, const Value& value) override {
    if (dynamic_backing_) {
      dynamic_backing_->dynamicMapSet(runtime, key, value);
      return;
    }
    set(convertValue<K>(key), convertValue<V>(value));
  }
  bool dynamicMapDelete(Runtime& runtime, const Value& key) override {
    return dynamic_backing_
      ? dynamic_backing_->dynamicMapDelete(runtime, key)
      : erase(convertValue<K>(key));
  }
  void dynamicMapClear() override { clear(); }

  void Trace(cppgc::Visitor* visitor) const override {
    DynamicValueObject::Trace(visitor);
    visitor->Trace(dynamic_backing_);
    for (const auto& entry : entries_) {
      entry.key.Trace(visitor);
      entry.value.Trace(visitor);
    }
  }

 private:
  struct Entry final {
    ArraySlot<K> key;
    ArraySlot<V> value;
  };
  void rebuildIndex(std::size_t start) {
    index_.clear();
    for (std::size_t index = 0; index < entries_.size(); ++index) {
      index_.emplace(entries_[index].key.load(), index);
    }
  }
  cppgc::Member<MapLikeObject> dynamic_backing_;
  std::vector<Entry> entries_;
  std::unordered_map<K, std::size_t, SameValueZeroHash<K>, SameValueZeroEqual<K>> index_;
};

template <typename T>
class SetObject final : public cppgc::GarbageCollected<SetObject<T>>, public SetLikeObject {
 public:
  std::size_t size() const { return values_.size(); }

  SetObject* add(T value) {
    if (index_.insert(value).second) values_.emplace_back(std::move(value));
    return this;
  }

  bool has(const T& value) const {
    return index_.contains(value);
  }

  bool erase(const T& value) {
    if (index_.erase(value) == 0) return false;
    const auto found = std::find_if(values_.begin(), values_.end(), [&](const ArraySlot<T>& candidate) {
      return sameValueZero(candidate.load(), value);
    });
    if (found == values_.end()) return true;
    values_.erase(found);
    return true;
  }

  void clear() {
    values_.clear();
    index_.clear();
  }

  template <typename Callback>
  void forEach(Callback callback) {
    for (const auto& value : values_) {
      if constexpr (std::is_invocable_v<Callback, T, T, SetObject*>) {
        callback(value.load(), value.load(), this);
      } else if constexpr (std::is_invocable_v<Callback, T, T>) {
        callback(value.load(), value.load());
      } else {
        callback(value.load());
      }
    }
  }

  const void* dynamicTypeToken() const override { return nativeTypeToken<SetObject<T>>(); }
  void* dynamicCast(const void* type) override {
    return type == nativeTypeToken<SetObject<T>>() ? this : nullptr;
  }
  std::string dynamicToString() const override { return "[object Set]"; }
  bool dynamicIsIterable() const override { return true; }
  std::size_t dynamicIterableSize() const override { return values_.size(); }
  Value dynamicIterableGet(Runtime& runtime, std::size_t index) override {
    if (index >= values_.size()) return Value::undefined();
    return convertValue<Value>(values_[index].load());
  }

  void Trace(cppgc::Visitor* visitor) const override {
    for (const auto& value : values_) value.Trace(visitor);
  }

 private:
  std::vector<ArraySlot<T>> values_;
  std::unordered_set<T, SameValueZeroHash<T>, SameValueZeroEqual<T>> index_;
};

template <typename K, typename V>
class WeakMapObject final : public cppgc::GarbageCollected<WeakMapObject<K, V>>, public WeakMapLikeObject {
  static_assert(std::is_pointer_v<K>, "WeakMap keys must be managed object pointers");
  using KeyObject = std::remove_pointer_t<K>;

 public:
  WeakMapObject* set(K key, V value) {
    if (!key) throw std::runtime_error("Invalid WeakMap key");
    const auto existing = index_.find(key);
    if (existing != index_.end()) {
      entries_[existing->second]->value.store(std::move(value));
      return this;
    }
    index_.emplace(key, entries_.size());
    entries_.emplace_back(makeManaged<Entry>(key, std::move(value)));
    return this;
  }

  std::optional<V> get(K key) const {
    const auto found = index_.find(key);
    return found == index_.end()
        ? std::nullopt
        : std::optional<V>(entries_[found->second]->value.load());
  }

  bool has(K key) const { return get(key).has_value(); }
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
  std::string dynamicToString() const override { return "[object WeakMap]"; }
  void Trace(cppgc::Visitor* visitor) const override {
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
    if (!value) throw std::runtime_error("Invalid WeakSet value");
    if (index_.insert(value).second) values_.emplace_back(makeManaged<Entry>(value));
    return this;
  }
  bool has(T value) const {
    return index_.contains(value);
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
  std::string dynamicToString() const override { return "[object WeakSet]"; }
  void Trace(cppgc::Visitor* visitor) const override {
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
  return value.isDynamicObject() && value.dynamicObject()->dynamicCast(nativeTypeToken<Kind>()) != nullptr;
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

inline int uriHexValue(char value) {
  if (value >= '0' && value <= '9') return value - '0';
  if (value >= 'a' && value <= 'f') return value - 'a' + 10;
  if (value >= 'A' && value <= 'F') return value - 'A' + 10;
  return -1;
}

inline std::string decodeUriComponentText(const std::string& value) {
  std::string result;
  result.reserve(value.size());
  for (std::size_t index = 0; index < value.size(); ++index) {
    if (value[index] == '%' && index + 2 < value.size()) {
      const int high = uriHexValue(value[index + 1]);
      const int low = uriHexValue(value[index + 2]);
      if (high >= 0 && low >= 0) {
        result.push_back(static_cast<char>((high << 4) | low));
        index += 2;
        continue;
      }
    }
    result.push_back(value[index]);
  }
  return result;
}

inline std::string encodeUriComponentText(const std::string& value) {
  static constexpr char HEX[] = "0123456789ABCDEF";
  std::string result;
  for (const unsigned char byte : value) {
    if (std::isalnum(byte) || byte == '-' || byte == '_' || byte == '.' || byte == '!' ||
        byte == '~' || byte == '*' || byte == '\'' || byte == '(' || byte == ')') {
      result.push_back(static_cast<char>(byte));
    } else {
      result.push_back('%');
      result.push_back(HEX[byte >> 4]);
      result.push_back(HEX[byte & 0x0f]);
    }
  }
  return result;
}

class URLObject final : public cppgc::GarbageCollected<URLObject>, public DynamicValueObject {
 public:
  explicit URLObject(std::string value) : href(std::move(value)) {
    const auto separator = href.find(':');
    if (separator == std::string::npos) {
      pathname = href;
    } else {
      protocol = href.substr(0, separator + 1);
      const std::size_t pathStart = href.compare(separator + 1, 2, "//") == 0
          ? separator + 3
          : separator + 1;
      pathname = pathStart < href.size() ? href.substr(pathStart) : "";
      if (protocol == "file:" && (pathname.empty() || pathname.front() != '/')) pathname.insert(pathname.begin(), '/');
    }
  }

  const void* dynamicTypeToken() const override { return nativeTypeToken<URLObject>(); }
  void* dynamicCast(const void* type) override { return type == nativeTypeToken<URLObject>() ? this : nullptr; }
  std::string dynamicToString() const override { return href; }
  void Trace(cppgc::Visitor*) const override {}

  std::string href;
  std::string protocol;
  std::string pathname;
};

class DateObject final : public cppgc::GarbageCollected<DateObject>, public DynamicValueObject {
 public:
  DateObject()
      : milliseconds_(std::chrono::duration<double, std::milli>(
            std::chrono::system_clock::now().time_since_epoch()).count()) {}
  explicit DateObject(double milliseconds) : milliseconds_(milliseconds) {}
  explicit DateObject(const std::string& text) : milliseconds_(parse(text)) {}

  static double parse(const std::string& text) {
    std::tm parts{};
    char separator = 0;
    char zone = 0;
    int milliseconds = 0;
    const int fields = std::sscanf(
        text.c_str(), "%d-%d-%d%c%d:%d:%d.%d%c",
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

  std::string toISOString() const {
    if (!std::isfinite(milliseconds_)) throw std::runtime_error("Invalid time value");
    const std::tm parts = utcParts();
    std::ostringstream output;
    output << std::setfill('0')
           << std::setw(4) << parts.tm_year + 1900 << '-'
           << std::setw(2) << parts.tm_mon + 1 << '-'
           << std::setw(2) << parts.tm_mday << 'T'
           << std::setw(2) << parts.tm_hour << ':'
           << std::setw(2) << parts.tm_min << ':'
           << std::setw(2) << parts.tm_sec << '.'
           << std::setw(3) << static_cast<int>(getUTCMilliseconds()) << 'Z';
    return output.str();
  }

  std::string toString() const { return toISOString(); }
  std::string toJSON() const { return toISOString(); }

  const void* dynamicTypeToken() const override { return nativeTypeToken<DateObject>(); }
  void* dynamicCast(const void* type) override {
    return type == nativeTypeToken<DateObject>() ? this : nullptr;
  }
  std::string dynamicToString() const override { return toString(); }
  std::optional<std::string> dynamicJsonStringify(std::unordered_set<const void*>&) const override {
    return jsonQuoted(toISOString());
  }
  void Trace(cppgc::Visitor*) const override {}

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

inline double dateParse(const std::string& value) { return DateObject::parse(value); }

class ArrayBufferObject final : public cppgc::GarbageCollected<ArrayBufferObject>, public DynamicValueObject {
 public:
  explicit ArrayBufferObject(std::size_t byteLength) : bytes_(byteLength, 0) {}
  std::size_t byteLength() const { return bytes_.size(); }
  std::uint8_t get(std::size_t index) const {
    if (index >= bytes_.size()) throw std::out_of_range("ArrayBuffer access is out of range");
    return bytes_[index];
  }
  void set(std::size_t index, std::uint8_t value) {
    if (index >= bytes_.size()) throw std::out_of_range("ArrayBuffer access is out of range");
    bytes_[index] = value;
  }
  const void* dynamicTypeToken() const override { return nativeTypeToken<ArrayBufferObject>(); }
  void* dynamicCast(const void* type) override {
    return type == nativeTypeToken<ArrayBufferObject>() ? this : nullptr;
  }
  std::string dynamicToString() const override { return "[object ArrayBuffer]"; }
  void Trace(cppgc::Visitor*) const override {}

 private:
  std::vector<std::uint8_t> bytes_;
};

class Uint8ArrayObject final : public cppgc::GarbageCollected<Uint8ArrayObject>, public DynamicValueObject {
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
  std::string dynamicToString() const override { return "[object Uint8Array]"; }
  Value dynamicGet(const PropertyKey& key) override {
    if (key == u"length") return Value(static_cast<double>(length_));
    if (key == u"byteLength") return Value(static_cast<double>(length_));
    if (key == u"byteOffset") return Value(static_cast<double>(byte_offset_));
    const auto index = propertyIndex(key);
    return index && *index < length_ ? Value(static_cast<double>(get(*index))) : Value::undefined();
  }
  Value dynamicSet(const PropertyKey& key, const Value& value) override {
    const auto index = propertyIndex(key);
    if (!index) throw std::runtime_error("Invalid Uint8Array index");
    return Value(static_cast<double>(set(*index, Number(value))));
  }
  void Trace(cppgc::Visitor* visitor) const override { visitor->Trace(buffer_); }

 private:
  cppgc::Member<ArrayBufferObject> buffer_;
  std::size_t byte_offset_;
  std::size_t length_;
};

class DataViewObject final : public cppgc::GarbageCollected<DataViewObject>, public DynamicValueObject {
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
  double getUint8(double offset) const { return readUnsigned(offset, 1, true); }
  double getInt8(double offset) const { return static_cast<std::int8_t>(readUnsigned(offset, 1, true)); }
  double getUint16(double offset, bool littleEndian = false) const { return readUnsigned(offset, 2, littleEndian); }
  double getInt16(double offset, bool littleEndian = false) const {
    return static_cast<std::int16_t>(readUnsigned(offset, 2, littleEndian));
  }
  double getUint32(double offset, bool littleEndian = false) const { return readUnsigned(offset, 4, littleEndian); }
  double getInt32(double offset, bool littleEndian = false) const {
    return static_cast<std::int32_t>(readUnsigned(offset, 4, littleEndian));
  }
  double getFloat32(double offset, bool littleEndian = false) const {
    return static_cast<double>(std::bit_cast<float>(static_cast<std::uint32_t>(readBits(offset, 4, littleEndian))));
  }
  double getFloat64(double offset, bool littleEndian = false) const {
    return std::bit_cast<double>(readBits(offset, 8, littleEndian));
  }
  void setUint8(double offset, double value) { writeUnsigned(offset, value, 1, true); }
  void setInt8(double offset, double value) { writeUnsigned(offset, value, 1, true); }
  void setUint16(double offset, double value, bool littleEndian = false) { writeUnsigned(offset, value, 2, littleEndian); }
  void setInt16(double offset, double value, bool littleEndian = false) { writeUnsigned(offset, value, 2, littleEndian); }
  void setUint32(double offset, double value, bool littleEndian = false) { writeUnsigned(offset, value, 4, littleEndian); }
  void setInt32(double offset, double value, bool littleEndian = false) { writeUnsigned(offset, value, 4, littleEndian); }
  void setFloat32(double offset, double value, bool littleEndian = false) {
    writeBits(offset, std::bit_cast<std::uint32_t>(static_cast<float>(value)), 4, littleEndian);
  }
  void setFloat64(double offset, double value, bool littleEndian = false) {
    writeBits(offset, std::bit_cast<std::uint64_t>(value), 8, littleEndian);
  }
  const void* dynamicTypeToken() const override { return nativeTypeToken<DataViewObject>(); }
  void* dynamicCast(const void* type) override {
    return type == nativeTypeToken<DataViewObject>() ? this : nullptr;
  }
  std::string dynamicToString() const override { return "[object DataView]"; }
  void Trace(cppgc::Visitor* visitor) const override { visitor->Trace(buffer_); }

 private:
  std::uint32_t readUnsigned(double offsetValue, std::size_t width, bool littleEndian) const {
    return static_cast<std::uint32_t>(readBits(offsetValue, width, littleEndian));
  }
  std::uint64_t readBits(double offsetValue, std::size_t width, bool littleEndian) const {
    const auto offset = static_cast<std::size_t>(offsetValue);
    if (offset + width > byte_length_) throw std::out_of_range("DataView access is out of range");
    std::uint64_t result = 0;
    for (std::size_t index = 0; index < width; ++index) {
      const std::size_t source = littleEndian ? width - index - 1 : index;
      result = (result << 8U) | buffer_->get(byte_offset_ + offset + source);
    }
    return result;
  }
  void writeUnsigned(double offsetValue, double value, std::size_t width, bool littleEndian) {
    writeBits(offsetValue, static_cast<std::uint32_t>(value), width, littleEndian);
  }
  void writeBits(double offsetValue, std::uint64_t value, std::size_t width, bool littleEndian) {
    const auto offset = static_cast<std::size_t>(offsetValue);
    if (offset + width > byte_length_) throw std::out_of_range("DataView access is out of range");
    for (std::size_t index = 0; index < width; ++index) {
      const std::size_t target = littleEndian ? index : width - index - 1;
      buffer_->set(byte_offset_ + offset + target, static_cast<std::uint8_t>((value >> (index * 8U)) & 0xffU));
    }
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
  if (!array) throw errorAtCurrentSource("Cannot read the length of null");
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
  if (!value.isDynamicObject() || !value.dynamicObject()->dynamicIsArray()) {
    throw errorAtCurrentSource("Value is not an array");
  }
  return static_cast<double>(value.dynamicObject()->dynamicArraySize());
}

inline ArrayObject<Value>* arrayPointer(const Value& value) {
  if (!value.isDynamicObject()) throw errorAtCurrentSource("Value is not an array");
  auto* array = static_cast<ArrayObject<Value>*>(
      value.dynamicObject()->dynamicCast(nativeTypeToken<ArrayObject<Value>>()));
  if (array) return array;
  if (!value.dynamicObject()->dynamicIsArray()) {
    throw errorAtCurrentSource("Value is not a dynamically typed array");
  }
  return makeDynamicArrayValueView(value.dynamicObject());
}

class DynamicArrayRange final {
 public:
  DynamicArrayRange(Runtime& runtime, DynamicValueObject* array)
      : runtime_(&runtime), array_(array) {}

  class Iterator final {
   public:
    Iterator(Runtime& runtime, DynamicValueObject* array, std::size_t index)
        : runtime_(&runtime), array_(array), index_(index) {}
    Value operator*() const { return array_->dynamicArrayGet(*runtime_, index_); }
    Iterator& operator++() { ++index_; return *this; }
    bool operator!=(const Iterator& other) const { return index_ != other.index_; }

   private:
    Runtime* runtime_;
    DynamicValueObject* array_;
    std::size_t index_;
  };

  Iterator begin() const { return Iterator(*runtime_, array_.Get(), 0); }
  Iterator end() const { return Iterator(*runtime_, array_.Get(), array_->dynamicArraySize()); }

 private:
  Runtime* runtime_;
  cppgc::Persistent<DynamicValueObject> array_;
};

inline DynamicArrayRange dynamicArrayRange(Runtime& runtime, const Value& value) {
  if (!value.isDynamicObject() || !value.dynamicObject()->dynamicIsArray()) {
    throw errorAtCurrentSource("Value is not an array");
  }
  return DynamicArrayRange(runtime, value.dynamicObject());
}

class DynamicIterationRange final {
 public:
  DynamicIterationRange(Runtime& runtime, DynamicValueObject* iterable)
      : runtime_(&runtime), iterable_(iterable) {}

  class Iterator final {
   public:
    Iterator(Runtime& runtime, DynamicValueObject* iterable, std::size_t index)
        : runtime_(&runtime), iterable_(iterable), index_(index) {}
    Value operator*() const { return iterable_->dynamicIterableGet(*runtime_, index_); }
    Iterator& operator++() { ++index_; return *this; }
    bool operator!=(const Iterator& other) const { return index_ != other.index_; }

   private:
    Runtime* runtime_;
    DynamicValueObject* iterable_;
    std::size_t index_;
  };

  Iterator begin() const { return Iterator(*runtime_, iterable_.Get(), 0); }
  Iterator end() const { return Iterator(*runtime_, iterable_.Get(), iterable_->dynamicIterableSize()); }

 private:
  Runtime* runtime_;
  cppgc::Persistent<DynamicValueObject> iterable_;
};

inline DynamicIterationRange dynamicIterationRange(Runtime& runtime, const Value& value) {
  if (!value.isDynamicObject() || !value.dynamicObject()->dynamicIsIterable()) {
    throw errorAtCurrentSource("Value is not iterable");
  }
  return DynamicIterationRange(runtime, value.dynamicObject());
}

template <typename T>
inline DynamicIterationRange dynamicIterationRange(Runtime& runtime, ArrayObject<T>* value) {
  if (!value) throw errorAtCurrentSource("Value is not iterable");
  return DynamicIterationRange(runtime, value);
}

template <typename T>
inline std::vector<T> dynamicIterationRange(Runtime&, std::vector<T> value) {
  return value;
}

template <typename T>
inline DynamicIterationRange dynamicIterationRange(Runtime& runtime, const cppgc::Member<T>& value) {
  return dynamicIterationRange(runtime, Value(value.Get()));
}

template <typename T>
inline bool arrayIsArray(const ArrayObject<T>*) {
  return true;
}

inline bool arrayIsArray(const Value& value) {
  return value.isDynamicObject() && value.dynamicObject()->dynamicIsArray();
}

template <typename T>
inline bool arrayIsArray(const T&) {
  return false;
}

inline std::vector<std::string> stringCharacters(Runtime&, const std::string& value) {
  std::vector<std::string> result;
  result.reserve(value.size());
  for (char character : value) result.emplace_back(1, character);
  return result;
}

inline std::vector<std::string> stringCharacters(Runtime& runtime, const Value& value) {
  return stringCharacters(runtime, toString(value));
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

template <typename Target, typename Callback>
inline Value optionalCall(Runtime& runtime, Target* target, Callback&& callback) {
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
inline void defineProperty(Runtime& runtime, T&& object, PropertyKey key, const Value& value, bool enumerable) {
  using Input = std::remove_cvref_t<T>;
  if constexpr (std::is_same_v<Input, Value>) {
    if (object.isRecord()) {
      if (enumerable) object.record()->set(std::move(key), value);
      else object.record()->setHidden(std::move(key), value);
    } else if (object.isDynamicObject()) {
      object.dynamicObject()->dynamicDefineProperty(key, value, enumerable);
    } else {
      throw std::runtime_error("Native Object.defineProperty requires an object");
    }
  } else {
    auto* pointer = rawPointer(std::forward<T>(object));
    using Object = std::remove_pointer_t<decltype(pointer)>;
    if constexpr (std::is_base_of_v<DynamicValueObject, Object>) {
      if (!pointer) throw std::runtime_error("Cannot define a property on null");
      pointer->dynamicDefineProperty(key, value, enumerable);
    } else if constexpr (std::is_base_of_v<EnumerableObject, Object>) {
      if (!pointer) throw std::runtime_error("Cannot define a property on null");
      pointer->defineProperty(key, value, enumerable);
    } else if constexpr (std::is_same_v<Object, RecordObject>) {
      if (!pointer) throw std::runtime_error("Cannot define a property on null");
      if (enumerable) pointer->set(std::move(key), value);
      else pointer->setHidden(std::move(key), value);
    } else {
      throw std::runtime_error("Native Object.defineProperty requires an enumerable native object");
    }
  }
}

class Error {
 public:
  explicit Error(const Value& value)
      : message_(value.isString() ? value.string() : toString(value)) {}
  explicit Error(std::string value)
      : message_(std::move(value)) {}

  const std::string& messageText() const { return message_; }
  Value name;

 private:
  std::string message_;
};

class RegExp final {
 public:
  RegExp() : RegExp("", "") {}
  RegExp(std::string pattern, const std::string& flags)
      : expression_(std::move(pattern), flags.find('i') != std::string::npos
          ? std::regex_constants::ECMAScript | std::regex_constants::icase
          : std::regex_constants::ECMAScript) {}

  bool test(const std::string& value) const { return std::regex_search(value, expression_); }
  std::optional<std::vector<std::string>> exec(const std::string& value) const {
    std::smatch match;
    if (!std::regex_search(value, match, expression_)) return std::nullopt;
    std::vector<std::string> captures;
    captures.reserve(match.size());
    for (const auto& capture : match) captures.push_back(capture.str());
    return captures;
  }
  std::string replace(const std::string& value, const std::string& replacement) const {
    return std::regex_replace(value, expression_, replacement);
  }

  std::vector<std::string> split(const std::string& value) const {
    return {
      std::sregex_token_iterator(value.begin(), value.end(), expression_, -1),
      std::sregex_token_iterator()
    };
  }

 private:
  std::regex expression_;
};

inline bool regexTest(const RegExp& expression, const std::string& value) {
  return expression.test(value);
}

inline bool regexTest(const RegExp& expression, const Value& value) {
  return expression.test(value.isString() ? value.string() : "");
}

inline bool regexTest(const RegExp& expression, const Text& value) {
  return expression.test(value.utf8());
}

inline std::string stringReplace(const std::string& value, const RegExp& expression, const Value& replacement) {
  return expression.replace(value, toString(replacement));
}

inline std::string stringReplace(const std::string& value, const RegExp& expression, const std::string& replacement) {
  return expression.replace(value, replacement);
}

inline std::string stringReplace(const std::string& value, const std::string& search, const std::string& replacement) {
  const auto offset = value.find(search);
  if (offset == std::string::npos) return value;
  auto result = value;
  result.replace(offset, search.size(), replacement);
  return result;
}

inline Text stringReplace(const Value& value, const Value& search, const Value& replacement) {
  const Text source(value);
  const Text searchText(search);
  const auto offset = source.utf16().find(searchText.utf16());
  if (offset == std::u16string::npos) return source;
  auto result = source.utf16();
  result.replace(offset, searchText.size(), Text(replacement).utf16());
  return Text(std::move(result));
}

inline Text stringReplace(const Value& value, const RegExp& expression, const Value& replacement) {
  return Text(expression.replace(Text(value).utf8(), Text(replacement).utf8()));
}

inline Text stringReplace(const Text& value, const RegExp& expression, const Text& replacement) {
  return Text(expression.replace(value.utf8(), replacement.utf8()));
}

inline Text stringReplace(const Text& value, const RegExp& expression, const Value& replacement) {
  return Text(expression.replace(value.utf8(), toString(replacement)));
}

inline Text stringReplace(const std::string& value, const RegExp& expression, const Text& replacement) {
  return Text(expression.replace(value, replacement.utf8()));
}

inline Text stringReplace(const Value& value, const RegExp& expression, const Text& replacement) {
  return Text(expression.replace(toString(value), replacement.utf8()));
}

inline Text stringReplace(const Text& value, const Text& search, const Text& replacement) {
  const auto offset = value.utf16().find(search.utf16());
  if (offset == std::u16string::npos) return value;
  auto result = value.utf16();
  result.replace(offset, search.size(), replacement.utf16());
  return Text(std::move(result));
}

inline Text stringReplace(const Text& value, const Text& search, const Value& replacement) {
  return stringReplace(value, search, Text(replacement));
}

inline Text stringReplace(const Value& value, const Text& search, const Text& replacement) {
  return stringReplace(Text(value), search, replacement);
}

inline Text stringReplace(const Value& value, const Text& search, const Value& replacement) {
  return stringReplace(Text(value), search, Text(replacement));
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

  Runtime() : previousRuntime_(currentRuntime_), platform_(std::make_shared<OilpanPlatform>()) {
    currentRuntime_ = this;
    cppgc::InitializeProcess(platform_->GetPageAllocator());
    cppgc::Heap::HeapOptions options;
    options.marking_support = cppgc::Heap::MarkingType::kAtomic;
    options.sweeping_support = cppgc::Heap::SweepingType::kAtomic;
    options.stack_support = cppgc::Heap::StackSupport::kSupportsConservativeStackScan;
    options.stack_start_marker.emplace();
    if (const char* initialHeapMegabytes = std::getenv("VEXA_NATIVE_INITIAL_HEAP_MB")) {
      const auto parsed = std::strtoull(initialHeapMegabytes, nullptr, 10);
      if (parsed > 0 && parsed <= std::numeric_limits<std::size_t>::max() / (1024 * 1024)) {
        options.resource_constraints.initial_heap_size_bytes =
            static_cast<std::size_t>(parsed) * 1024 * 1024;
      }
    }
    heap_ = cppgc::Heap::Create(platform_, std::move(options));
  }

  Runtime(const Runtime&) = delete;
  Runtime& operator=(const Runtime&) = delete;

  ~Runtime() {
    timers_.clear();
    while (!scheduledTimers_.empty()) scheduledTimers_.pop();
    microtasks_.clear();
    ioPollers_.clear();
    literalValues_.clear();
    heap_.reset();
    cppgc::ShutdownProcess();
    currentRuntime_ = previousRuntime_;
  }

  static Runtime& current() {
    if (!currentRuntime_) throw std::runtime_error("No active VexaScript runtime");
    return *currentRuntime_;
  }

  Value string(std::string value) {
    return Value(cppgc::MakeGarbageCollected<StringObject>(
        heap_->GetAllocationHandle(), std::move(value)));
  }

  Value string(std::u16string value) {
    return Value(cppgc::MakeGarbageCollected<StringObject>(
        heap_->GetAllocationHandle(), std::move(value)));
  }

  Value concatStrings(StringObject* left, StringObject* right) {
    if (left->size() == 0) return Value(right);
    if (right->size() == 0) return Value(left);
    return Value(cppgc::MakeGarbageCollected<StringObject>(
        heap_->GetAllocationHandle(), left, right));
  }

  Value* retainLiteralValue(std::string value) {
    literalValues_.emplace_back(cppgc::MakeGarbageCollected<StringObject>(
        heap_->GetAllocationHandle(), std::move(value)));
    return &literalValues_.back();
  }

  void reserveLiterals(std::size_t) {}

  RecordObject* record(
      std::initializer_list<std::pair<PropertyKey, Value>> properties = {}) {
    auto* result = make<RecordObject>();
    for (const auto& [key, value] : properties) result->set(key, value);
    return result;
  }

  template <typename T>
  ArrayObject<T>* array(std::initializer_list<T> values = {}) {
    return make<ArrayObject<T>>(values);
  }

  template <typename T, typename... Arguments>
  T* make(Arguments&&... arguments) {
    return cppgc::MakeGarbageCollected<T>(
        heap_->GetAllocationHandle(), std::forward<Arguments>(arguments)...);
  }

  cppgc::Heap& heap() { return *heap_; }

  void setSourceLocation(std::string file, std::size_t line, std::size_t column) {
    sourceFile_ = std::move(file);
    sourceLine_ = line;
    sourceColumn_ = column;
  }

  std::string sourceLocation() const {
    if (sourceFile_.empty()) return "";
    return sourceFile_ + ":" + std::to_string(sourceLine_) + ":" + std::to_string(sourceColumn_);
  }

  std::runtime_error errorAtCurrentSource(std::string message) const {
    const auto location = sourceLocation();
    if (!location.empty()) message += " at " + location;
    return std::runtime_error(std::move(message));
  }

  void collectGarbageIfStressed() {
#if defined(VEXA_NATIVE_GC_STRESS)
    if (++statementsUntilCollection_ >= 8) {
      statementsUntilCollection_ = 0;
      heap_->ForceGarbageCollectionSlow(
          "VexaScript native statement", "VEXA_NATIVE_GC_STRESS",
          cppgc::Heap::StackState::kMayContainHeapPointers);
    }
#endif
  }

  TimerId setTimeout(TimerCallback callback, double delay = 0) {
    return scheduleTimer(std::move(callback), delay, false);
  }

  TimerId setInterval(TimerCallback callback, double delay = 0) {
    return scheduleTimer(std::move(callback), delay, true);
  }

  void clearTimeout(TimerId id) { timers_.erase(id); }
  void clearInterval(TimerId id) { timers_.erase(id); }
  void clearTimeout(const Value& id) { clearTimeout(static_cast<TimerId>(Number(id))); }
  void clearInterval(const Value& id) { clearInterval(static_cast<TimerId>(Number(id))); }

  void runEventLoop() {
    while (runOneEvent()) {}
  }

  void enqueueMicrotask(TimerCallback callback) {
    microtasks_.push_back(std::move(callback));
  }

  void enqueueIo(IoPoller poller) {
    ioPollers_.push_back(std::move(poller));
  }

  template <typename Predicate>
  void runUntil(Predicate settled) {
    while (!settled()) {
      if (!runOneEvent()) {
        throw std::runtime_error("VexaScript task cannot settle because the event loop is empty");
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

  TimerId scheduleTimer(TimerCallback callback, double delay, bool repeating) {
    const TimerId id = nextTimerId_++;
    timers_.emplace(id, TimerState{std::move(callback), delay, repeating});
    scheduledTimers_.push({deadline(delay), id});
    return id;
  }

  bool runOneEvent() {
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

  inline static thread_local Runtime* currentRuntime_ = nullptr;
  Runtime* previousRuntime_ = nullptr;
  std::shared_ptr<OilpanPlatform> platform_;
  std::unique_ptr<cppgc::Heap> heap_;
  std::string sourceFile_;
  std::size_t sourceLine_ = 0;
  std::size_t sourceColumn_ = 0;
  std::size_t statementsUntilCollection_ = 0;
  TimerId nextTimerId_ = 1;
  std::deque<TimerCallback> microtasks_;
  std::vector<IoPoller> ioPollers_;
  std::deque<Value> literalValues_;
  std::unordered_map<TimerId, TimerState> timers_;
  std::priority_queue<ScheduledTimer, std::vector<ScheduledTimer>, EarlierTimer> scheduledTimers_;
};

inline Runtime& currentRuntime() { return Runtime::current(); }

template <typename T, typename... Arguments>
inline T* makeManaged(Arguments&&... arguments) {
  return currentRuntime().make<T>(std::forward<Arguments>(arguments)...);
}

inline ArrayObject<Value>* makeDynamicArrayValueView(DynamicValueObject* backing) {
  return currentRuntime().make<ArrayObject<Value>>(backing);
}

inline RecordObject* makeDynamicPropertyRecord(Runtime& runtime) {
  return runtime.record();
}

inline std::runtime_error errorAtCurrentSource(std::string message) {
  return Runtime::current().errorAtCurrentSource(std::move(message));
}

inline Value makeDynamicMapEntry(Runtime& runtime, Value key, Value value) {
  auto* pair = runtime.array<Value>();
  pair->append(std::move(key));
  pair->append(std::move(value));
  return Value(pair);
}

#if defined(VEXA_NATIVE_DEBUG) || defined(VEXA_NATIVE_GC_STRESS)
#define VEXA_NATIVE_SOURCE(runtime, file, line, column) \
  do {                                                    \
    (runtime).setSourceLocation((file), (line), (column)); \
    (runtime).collectGarbageIfStressed();                 \
  } while (false)
#else
#define VEXA_NATIVE_SOURCE(runtime, file, line, column) ((void)0)
#endif

inline ArrayObject<Value>* regexExec(Runtime& runtime, const RegExp& expression, const std::string& value) {
  const auto captures = expression.exec(value);
  if (!captures) return nullptr;
  auto* result = runtime.array<Value>();
  for (const auto& capture : *captures) result->append(runtime.string(capture));
  return result;
}

inline ArrayObject<Value>* regexExec(Runtime& runtime, const RegExp& expression, const Value& value) {
  return regexExec(runtime, expression, value.isString() ? value.string() : std::string());
}

template <typename T>
concept RecordAdaptable = requires(RecordObject* record) {
  { T::fromRecord(record) } -> std::convertible_to<T*>;
};

template <typename Result, typename Input>
Result convertValue(Input&& input) {
  using Source = std::remove_cvref_t<Input>;
  if constexpr (std::is_same_v<Source, StoredValue>) {
    return convertValue<Result>(input.load());
  } else if constexpr (std::is_same_v<Result, Value> && std::is_same_v<Source, std::nullptr_t>) {
    return Value::null();
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
  } else if constexpr (
      ArrayObjectPointerTraits<Result>::value &&
      ArrayObjectPointerTraits<Source>::value) {
    using ResultElement = typename ArrayObjectPointerTraits<Result>::Element;
    auto& runtime = currentRuntime();
    auto* converted = runtime.array<ResultElement>();
    if (!input) return converted;
    for (std::size_t index = 0; index < input->size(); ++index) {
      converted->append(convertValue<ResultElement>(input->get(index)));
    }
    return converted;
  } else if constexpr (
      MapObjectPointerTraits<Result>::value &&
      MapObjectPointerTraits<Source>::value) {
    using ResultKey = typename MapObjectPointerTraits<Result>::Key;
    using ResultValue = typename MapObjectPointerTraits<Result>::Mapped;
    if (!input) return currentRuntime().make<MapObject<ResultKey, ResultValue>>();
    return currentRuntime().make<MapObject<ResultKey, ResultValue>>(
        static_cast<MapLikeObject*>(input));
  } else if constexpr (
      SetObjectPointerTraits<Result>::value &&
      SetObjectPointerTraits<Source>::value) {
    using ResultElement = typename SetObjectPointerTraits<Result>::Element;
    auto* converted = currentRuntime().make<SetObject<ResultElement>>();
    if (!input) return converted;
    input->forEach([&](auto value) {
      converted->add(convertValue<ResultElement>(value));
    });
    return converted;
  } else if constexpr (std::is_pointer_v<Result> && std::is_same_v<Source, Null>) {
    return nullptr;
  } else if constexpr (std::is_pointer_v<Result> && std::is_same_v<Source, Undefined>) {
    return nullptr;
  } else if constexpr (
      std::is_pointer_v<Result> &&
      std::is_same_v<Source, RecordObject*> &&
      RecordAdaptable<std::remove_pointer_t<Result>>) {
    return std::remove_pointer_t<Result>::fromRecord(input);
  } else if constexpr (std::is_pointer_v<Result> && std::is_pointer_v<Source>) {
    if (!input) return nullptr;
    if constexpr (std::is_convertible_v<Source, Result>) {
      return static_cast<Result>(input);
    } else if constexpr (
        std::is_base_of_v<DynamicValueObject, std::remove_pointer_t<Source>> &&
        std::is_base_of_v<DynamicValueObject, std::remove_pointer_t<Result>>) {
      void* converted = input->dynamicCast(nativeTypeToken<std::remove_pointer_t<Result>>());
      if (!converted) {
        throw errorAtCurrentSource(
            std::string("VexaScript object has an incompatible native pointer type (dynamic cast): ") +
            __PRETTY_FUNCTION__);
      }
      return static_cast<Result>(converted);
    } else if constexpr (
        std::is_base_of_v<EnumerableObject, std::remove_pointer_t<Source>> &&
        std::is_base_of_v<EnumerableObject, std::remove_pointer_t<Result>>) {
      void* converted = input->nativeInterfaceCast(nativeTypeToken<std::remove_pointer_t<Result>>());
      if (!converted) throw std::runtime_error("VexaScript object has an incompatible interface type");
      return static_cast<Result>(converted);
    } else if constexpr (
        std::is_same_v<Result, RecordObject*> &&
        std::is_base_of_v<EnumerableObject, std::remove_pointer_t<Source>>) {
      return input->enumerableBackingRecord();
    } else {
      throw errorAtCurrentSource("VexaScript object has an incompatible native pointer type (unsupported conversion)");
    }
  } else
  if constexpr (std::is_same_v<Result, Value>) {
    if constexpr (std::is_same_v<Source, Value>) {
      return std::forward<Input>(input);
    } else if constexpr (std::is_same_v<Source, Undefined>) {
      return Value::undefined();
    } else if constexpr (std::is_same_v<Source, Null>) {
      return Value::null();
    } else if constexpr (std::is_same_v<Source, std::string>) {
      return currentRuntime().string(std::forward<Input>(input));
    } else if constexpr (std::is_same_v<Source, Text>) {
      return currentRuntime().string(input.utf16());
    } else if constexpr (std::is_pointer_v<Source>) {
      if (!input) return Value::null();
      if constexpr (std::is_base_of_v<DynamicValueObject, std::remove_pointer_t<Source>>) {
        return Value(static_cast<DynamicValueObject*>(input));
      } else if constexpr (std::is_base_of_v<EnumerableObject, std::remove_pointer_t<Source>>) {
        auto* enumerable = static_cast<EnumerableObject*>(input);
        auto* record = enumerable->enumerableBackingRecord();
        if (!record) {
          auto& runtime = currentRuntime();
          record = runtime.record();
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
      if (!input.isUndefined()) throw std::runtime_error("VexaScript value is not undefined");
      return Undefined{};
    } else if constexpr (std::is_same_v<Result, Null>) {
      if (!input.isNull()) throw errorAtCurrentSource("VexaScript value is not null");
      return Null{};
    } else if constexpr (std::is_same_v<Result, bool>) {
      if (input.isBoolean()) return input.boolean();
      if (input.isNumber()) return input.number() != 0 && !std::isnan(input.number());
      if (input.isBigInt()) return !input.bigint().isZero();
      return !input.isUndefined() && !input.isNull();
    } else if constexpr (std::is_same_v<Result, BigInt>) {
      if (input.isBigInt()) return input.bigint();
      if (input.isBoolean()) return BigInt(input.boolean() ? 1 : 0);
      if (input.isNumber() && std::isfinite(input.number()) && std::trunc(input.number()) == input.number()) {
        std::ostringstream text;
        text << std::fixed << std::setprecision(0) << input.number();
        return BigInt(text.str());
      }
      if (input.isString()) return BigInt(input.string());
      throw std::runtime_error("VexaScript value cannot be converted to bigint");
    } else if constexpr (std::is_same_v<Result, std::string>) {
      if (input.isString()) return input.string();
      throw errorAtCurrentSource("VexaScript value is not a string");
    } else if constexpr (std::is_same_v<Result, Text>) {
      if (input.isString()) return Text(input.utf16());
      throw errorAtCurrentSource("VexaScript value is not a string");
    } else if constexpr (std::is_arithmetic_v<Result>) {
      if (input.isNumber()) return static_cast<Result>(input.number());
      if (input.isBoolean()) return static_cast<Result>(input.boolean());
      if (input.isBigInt()) return static_cast<Result>(input.bigint().toDouble());
      throw errorAtCurrentSource("VexaScript value is not numeric");
    } else if constexpr (IsStdFunction<Result>::value) {
      return functionFromValue<Result>(currentRuntime(), input);
    } else if constexpr (std::is_same_v<Result, RecordObject*>) {
      if (input.isNull() || input.isUndefined()) return nullptr;
      if (!input.isRecord()) throw std::runtime_error("VexaScript value is not an object");
      return input.record();
    } else if constexpr (std::is_same_v<Result, cppgc::GarbageCollectedMixin*>) {
      if (input.isNull() || input.isUndefined()) return nullptr;
      if (input.isRecord()) return input.record();
      if (input.isDynamicObject()) return input.dynamicObject();
      throw errorAtCurrentSource("VexaScript WeakMap/WeakSet key is not an object");
    } else if constexpr (ArrayObjectPointerTraits<Result>::value) {
      using ResultElement = typename ArrayObjectPointerTraits<Result>::Element;
      if (input.isNull() || input.isUndefined()) return nullptr;
      if (!input.isDynamicObject()) throw errorAtCurrentSource("VexaScript value is not an array");
      if (void* exact = input.dynamicObject()->dynamicCast(nativeTypeToken<std::remove_pointer_t<Result>>())) {
        return static_cast<Result>(exact);
      }
      if (!input.dynamicObject()->dynamicIsArray()) {
        throw errorAtCurrentSource("VexaScript value is not a compatible array");
      }
      auto& runtime = currentRuntime();
      return runtime.make<ArrayObject<ResultElement>>(input.dynamicObject());
    } else if constexpr (MapObjectPointerTraits<Result>::value) {
      using ResultKey = typename MapObjectPointerTraits<Result>::Key;
      using ResultValue = typename MapObjectPointerTraits<Result>::Mapped;
      if (input.isNull() || input.isUndefined()) return nullptr;
      if (!input.isDynamicObject()) throw errorAtCurrentSource("VexaScript value is not a map");
      if (void* exact = input.dynamicObject()->dynamicCast(nativeTypeToken<std::remove_pointer_t<Result>>())) {
        return static_cast<Result>(exact);
      }
      void* mapLike = input.dynamicObject()->dynamicCast(nativeTypeToken<MapLikeObject>());
      if (!mapLike) throw errorAtCurrentSource("VexaScript value is not a compatible map");
      return currentRuntime().make<MapObject<ResultKey, ResultValue>>(
          static_cast<MapLikeObject*>(mapLike));
    } else if constexpr (std::is_pointer_v<Result> && RecordAdaptable<std::remove_pointer_t<Result>>) {
      if (input.isDynamicObject()) {
        void* converted = input.dynamicObject()->dynamicCast(nativeTypeToken<std::remove_pointer_t<Result>>());
        if (converted) return static_cast<Result>(converted);
        return std::remove_pointer_t<Result>::fromRecord(
            currentRuntime().make<RecordObject>(input.dynamicObject()));
      }
      if (input.isRecord()) return std::remove_pointer_t<Result>::fromRecord(input.record());
      if (input.isNull() || input.isUndefined()) return nullptr;
      throw errorAtCurrentSource("VexaScript value is not a compatible structural object");
    } else if constexpr (std::is_pointer_v<Result>) {
      if (input.isNull() || input.isUndefined()) return nullptr;
      if (!input.isDynamicObject()) {
        throw errorAtCurrentSource(
            std::string("VexaScript dynamic value has an incompatible native object type: ") +
            __PRETTY_FUNCTION__ + "; actual value: " + toString(input));
      }
      void* converted = input.dynamicObject()->dynamicCast(nativeTypeToken<std::remove_pointer_t<Result>>());
      if (!converted) {
        const auto kind = input.dynamicObject()->dynamicGet(u"kind");
        throw errorAtCurrentSource(
            std::string("VexaScript dynamic value has an incompatible native object type: ") +
            __PRETTY_FUNCTION__ + "; actual value: " + toString(input) +
            (kind.isUndefined() ? "" : "; kind: " + toString(kind)));
      }
      return static_cast<Result>(converted);
    } else {
      return std::forward<Input>(input);
    }
  } else {
    return std::forward<Input>(input);
  }
}

template <typename Interface, typename Adapter, typename Input>
inline Interface* adaptInterface(Runtime& runtime, Input&& input) {
  using Source = std::remove_cvref_t<Input>;
  if constexpr (std::is_same_v<Source, Value>) {
    if (input.isRecord()) return runtime.make<Adapter>(input.record());
    if (input.isDynamicObject()) {
      void* converted = input.dynamicObject()->dynamicCast(nativeTypeToken<Interface>());
      if (converted) return static_cast<Interface*>(converted);
      return runtime.make<Adapter>(runtime.make<RecordObject>(input.dynamicObject()));
    }
    return convertValue<Interface*>(std::forward<Input>(input));
  } else if constexpr (std::is_same_v<Source, RecordObject*>) {
    return runtime.make<Adapter>(input);
  } else if constexpr (std::is_pointer_v<Source> && std::is_convertible_v<Source, Interface*>) {
    return static_cast<Interface*>(input);
  } else if constexpr (
      std::is_pointer_v<Source> &&
      std::is_base_of_v<DynamicValueObject, std::remove_pointer_t<Source>>) {
    if (!input) return nullptr;
    void* converted = input->dynamicCast(nativeTypeToken<Interface>());
    if (converted) return static_cast<Interface*>(converted);
    return runtime.make<Adapter>(runtime.make<RecordObject>(input));
  } else if constexpr (
      std::is_pointer_v<Source> &&
      std::is_base_of_v<EnumerableObject, std::remove_pointer_t<Source>>) {
    if (!input) return nullptr;
    auto* enumerable = static_cast<EnumerableObject*>(input);
    auto* record = enumerable->enumerableBackingRecord();
    if (!record) {
      record = runtime.record();
      for (const auto& key : enumerable->enumerableKeys()) {
        record->set(key, enumerable->enumerableGet(key));
      }
    }
    return runtime.make<Adapter>(record);
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
inline V mapGet(Runtime& runtime, const MapObject<K, V>* map, Key&& key) {
  const auto found = map->get(convertValue<K>(std::forward<Key>(key)));
  if (found) return *found;
  if constexpr (std::is_same_v<V, Value>) return Value::undefined();
  return V{};
}

template <typename K, typename V, typename Key>
inline Value mapGetValue(Runtime& runtime, const MapObject<K, V>* map, Key&& key) {
  const auto found = map->get(convertValue<K>(std::forward<Key>(key)));
  return found ? convertValue<Value>(*found) : Value::undefined();
}

template <typename K, typename V, typename Key, typename Input>
inline MapObject<K, V>* mapSet(Runtime& runtime, MapObject<K, V>* map, Key&& key, Input&& value) {
  return map->set(
      convertValue<K>(std::forward<Key>(key)),
      convertValue<V>(std::forward<Input>(value)));
}

template <typename K, typename V, typename Key>
inline bool mapHas(Runtime& runtime, MapObject<K, V>* map, Key&& key) {
  return map->has(convertValue<K>(std::forward<Key>(key)));
}

template <typename K, typename V, typename Key>
inline bool mapDelete(Runtime& runtime, MapObject<K, V>* map, Key&& key) {
  return map->erase(convertValue<K>(std::forward<Key>(key)));
}

template <typename K, typename V>
inline void mapClear(MapObject<K, V>* map) { map->clear(); }

template <typename K, typename V, typename Callback>
inline void mapForEach(MapObject<K, V>* map, Callback callback) { map->forEach(std::move(callback)); }

template <typename K, typename V>
inline ArrayObject<K>* mapKeys(Runtime& runtime, MapObject<K, V>* map) {
  auto* result = runtime.array<K>();
  map->forEach([&](V, K key) { result->append(key); });
  return result;
}

template <typename K, typename V>
inline ArrayObject<V>* mapValues(Runtime& runtime, MapObject<K, V>* map) {
  auto* result = runtime.array<V>();
  map->forEach([&](V value) { result->append(value); });
  return result;
}

template <typename K, typename V>
inline ArrayObject<ArrayObject<Value>*>* mapEntries(Runtime& runtime, MapObject<K, V>* map) {
  auto* result = runtime.array<ArrayObject<Value>*>();
  map->forEach([&](V value, K key) {
    result->append(runtime.array<Value>({
        convertValue<Value>(key),
        convertValue<Value>(value)}));
  });
  return result;
}

template <typename K, typename V>
inline ArrayObject<ArrayObject<Value>*>* mapEntries(
    Runtime& runtime,
    const cppgc::Member<MapObject<K, V>>& map) {
  return mapEntries(runtime, map.Get());
}

template <typename K, typename V>
inline ArrayObject<ArrayObject<Value>*>* mapEntries(
    Runtime& runtime,
    const cppgc::Persistent<MapObject<K, V>>& map) {
  return mapEntries(runtime, map.Get());
}

template <typename K, typename V, typename Entry>
inline MapObject<K, V>* mapFromEntries(
    Runtime& runtime,
    const ArrayObject<ArrayObject<Entry>*>* entries) {
  auto* result = runtime.make<MapObject<K, V>>();
  if (!entries) return result;
  for (auto* entry : *entries) {
    if (!entry || entry->size() < 2) {
      throw std::runtime_error("VexaScript Map entry must contain a key and value");
    }
    result->set(
        convertValue<K>(entry->get(0)),
        convertValue<V>(entry->get(1)));
  }
  return result;
}

template <typename K, typename V, typename Entry>
inline MapObject<K, V>* mapFromIterable(
    Runtime& runtime,
    const ArrayObject<ArrayObject<Entry>*>* entries) {
  return mapFromEntries<K, V>(runtime, entries);
}

template <typename K, typename V, typename InputK, typename InputV>
inline MapObject<K, V>* mapFromIterable(Runtime& runtime, MapObject<InputK, InputV>* source) {
  auto* result = runtime.make<MapObject<K, V>>();
  if (!source) return result;
  source->forEach([&](InputV value, InputK key) {
    result->set(convertValue<K>(key), convertValue<V>(value));
  });
  return result;
}

template <typename K, typename V, typename InputK, typename InputV>
inline MapObject<K, V>* mapFromIterable(
    Runtime& runtime,
    const cppgc::Persistent<MapObject<InputK, InputV>>& source) {
  return mapFromIterable<K, V>(runtime, source.Get());
}

template <typename K, typename V, typename InputK, typename InputV>
inline MapObject<K, V>* mapFromIterable(
    Runtime& runtime,
    const cppgc::Member<MapObject<InputK, InputV>>& source) {
  return mapFromIterable<K, V>(runtime, source.Get());
}

template <typename K, typename V>
inline MapObject<K, V>* mapFromDynamicEntries(
    Runtime& runtime,
    const ArrayObject<Value>* entries) {
  auto* result = runtime.make<MapObject<K, V>>();
  std::size_t index = 0;
  for (const auto& entryValue : *entries) {
    if (!entryValue.isDynamicObject()) {
      throw std::runtime_error(
          "VexaScript Map entry at index " + std::to_string(index) +
          " is not an array: " + toString(entryValue));
    }
    auto* entry = static_cast<ArrayObject<Value>*>(
        entryValue.dynamicObject()->dynamicCast(nativeTypeToken<ArrayObject<Value>>()));
    if (!entry) {
      throw std::runtime_error(
          "VexaScript Map entry at index " + std::to_string(index) +
          " has an incompatible array element type");
    }
    if (entry->size() < 2) throw std::runtime_error("VexaScript Map entry must contain a key and value");
    result->set(convertValue<K>(entry->get(0)), convertValue<V>(entry->get(1)));
    ++index;
  }
  return result;
}

template <typename K, typename V>
inline MapObject<K, V>* mapFromIterable(
    Runtime& runtime,
    const ArrayObject<Value>* entries) {
  return mapFromDynamicEntries<K, V>(runtime, entries);
}

template <typename K, typename V>
inline MapObject<K, V>* mapFromIterable(Runtime& runtime, const Value& source) {
  auto* result = runtime.make<MapObject<K, V>>();
  std::size_t index = 0;
  for (const auto& entryValue : dynamicIterationRange(runtime, source)) {
    if (!entryValue.isDynamicObject() || !entryValue.dynamicObject()->dynamicIsArray()) {
      throw std::runtime_error(
          "VexaScript Map entry at index " + std::to_string(index) +
          " is not an array: " + toString(entryValue));
    }
    auto* entry = entryValue.dynamicObject();
    if (entry->dynamicArraySize() < 2) {
      throw std::runtime_error("VexaScript Map entry must contain a key and value");
    }
    result->set(
        convertValue<K>(entry->dynamicArrayGet(runtime, 0)),
        convertValue<V>(entry->dynamicArrayGet(runtime, 1)));
    ++index;
  }
  return result;
}

template <typename T, typename Input>
inline SetObject<T>* setAdd(Runtime& runtime, SetObject<T>* set, Input&& value) {
  return set->add(convertValue<T>(std::forward<Input>(value)));
}

template <typename T, typename Input>
inline bool setHas(Runtime& runtime, SetObject<T>* set, Input&& value) {
  return set->has(convertValue<T>(std::forward<Input>(value)));
}

template <typename T, typename Input>
inline bool setHas(Runtime& runtime, const SetObject<T>* set, Input&& value) {
  return set->has(convertValue<T>(std::forward<Input>(value)));
}

template <typename T, typename Input>
inline bool setDelete(Runtime& runtime, SetObject<T>* set, Input&& value) {
  return set->erase(convertValue<T>(std::forward<Input>(value)));
}

template <typename T>
inline void setClear(SetObject<T>* set) { set->clear(); }

template <typename T, typename Callback>
inline void setForEach(SetObject<T>* set, Callback callback) { set->forEach(std::move(callback)); }

template <typename T>
inline ArrayObject<T>* setValues(Runtime& runtime, SetObject<T>* set) {
  auto* result = runtime.array<T>();
  set->forEach([&](T value) { result->append(value); });
  return result;
}

template <typename T, typename Input>
inline SetObject<T>* setFromArray(Runtime& runtime, const ArrayObject<Input>* values) {
  auto* result = runtime.make<SetObject<T>>();
  if (!values) return result;
  for (const auto& value : *values) result->add(convertValue<T>(value));
  return result;
}

template <typename T, typename Input>
inline SetObject<T>* setFromIterable(Runtime& runtime, const ArrayObject<Input>* values) {
  return setFromArray<T>(runtime, values);
}

template <typename T, typename Input>
inline SetObject<T>* setFromIterable(Runtime& runtime, const cppgc::Persistent<ArrayObject<Input>>& values) {
  return setFromArray<T>(runtime, values.Get());
}

template <typename T, typename Input>
inline SetObject<T>* setFromIterable(Runtime& runtime, SetObject<Input>* source) {
  auto* result = runtime.make<SetObject<T>>();
  if (!source) return result;
  source->forEach([&](Input value) { result->add(convertValue<T>(value)); });
  return result;
}

template <typename T, typename Input>
inline SetObject<T>* setFromIterable(
    Runtime& runtime,
    const cppgc::Persistent<SetObject<Input>>& source) {
  return setFromIterable<T>(runtime, source.Get());
}

template <typename T>
inline SetObject<T>* setFromIterable(Runtime& runtime, const Value& source) {
  return setFromArray<T>(runtime, arrayPointer(source));
}

template <typename T, typename Input>
inline WeakSetObject<T>* weakSetFromArray(Runtime& runtime, const ArrayObject<Input>* values) {
  auto* result = runtime.make<WeakSetObject<T>>();
  for (const auto& value : *values) result->add(convertValue<T>(value));
  return result;
}

template <typename K, typename V, typename Key>
inline V weakMapGet(Runtime& runtime, WeakMapObject<K, V>* map, Key&& key) {
  const auto found = map->get(convertValue<K>(std::forward<Key>(key)));
  if (found) return *found;
  if constexpr (std::is_same_v<V, Value>) return Value::undefined();
  return V{};
}

template <typename K, typename V, typename Key, typename Input>
inline WeakMapObject<K, V>* weakMapSet(Runtime& runtime, WeakMapObject<K, V>* map, Key&& key, Input&& value) {
  return map->set(
      convertValue<K>(std::forward<Key>(key)),
      convertValue<V>(std::forward<Input>(value)));
}

template <typename K, typename V, typename Key>
inline bool weakMapHas(Runtime& runtime, WeakMapObject<K, V>* map, Key&& key) {
  return map->has(convertValue<K>(std::forward<Key>(key)));
}

template <typename K, typename V, typename Key>
inline bool weakMapDelete(Runtime& runtime, WeakMapObject<K, V>* map, Key&& key) {
  return map->erase(convertValue<K>(std::forward<Key>(key)));
}

template <typename T, typename Input>
inline WeakSetObject<T>* weakSetAdd(Runtime& runtime, WeakSetObject<T>* set, Input&& value) {
  return set->add(convertValue<T>(std::forward<Input>(value)));
}

template <typename T, typename Input>
inline bool weakSetHas(Runtime& runtime, WeakSetObject<T>* set, Input&& value) {
  return set->has(convertValue<T>(std::forward<Input>(value)));
}

template <typename T, typename Input>
inline bool weakSetDelete(Runtime& runtime, WeakSetObject<T>* set, Input&& value) {
  return set->erase(convertValue<T>(std::forward<Input>(value)));
}

inline Uint8ArrayObject* makeUint8Array(Runtime& runtime, double length) {
  const auto size = static_cast<std::size_t>(std::max(0.0, length));
  auto* buffer = runtime.make<ArrayBufferObject>(size);
  return runtime.make<Uint8ArrayObject>(buffer, 0, size);
}

inline Uint8ArrayObject* makeUint8Array(Runtime& runtime, ArrayBufferObject* buffer) {
  return runtime.make<Uint8ArrayObject>(buffer, 0, buffer->byteLength());
}

template <typename T>
inline Uint8ArrayObject* makeUint8Array(Runtime& runtime, const ArrayObject<T>* values) {
  auto* result = makeUint8Array(runtime, static_cast<double>(values->size()));
  for (std::size_t index = 0; index < values->size(); ++index) result->set(index, Number(convertValue<Value>(values->get(index))));
  return result;
}

inline DataViewObject* makeDataView(
    Runtime& runtime,
    ArrayBufferObject* buffer,
    double byteOffset = 0,
    double byteLength = -1) {
  const auto offset = static_cast<std::size_t>(std::max(0.0, byteOffset));
  const auto length = byteLength < 0
    ? buffer->byteLength() - offset
    : static_cast<std::size_t>(byteLength);
  return runtime.make<DataViewObject>(buffer, offset, length);
}

template <typename Target>
bool isInstance(const Value& value) {
  return value.isDynamicObject() &&
      value.dynamicObject()->dynamicCast(nativeTypeToken<Target>()) != nullptr;
}

template <typename Target, typename Source>
bool isInstance(Source* value) {
  if (!value) return false;
  if constexpr (std::is_base_of_v<DynamicValueObject, Source>) {
    return value->dynamicCast(nativeTypeToken<Target>()) != nullptr;
  } else {
    return std::is_convertible_v<Source*, Target*>;
  }
}

template <typename Target, typename Source>
bool isInstance(const cppgc::Member<Source>& value) {
  return isInstance<Target>(value.Get());
}

template <typename Result, typename... Arguments>
class FunctionObject final
    : public cppgc::GarbageCollected<FunctionObject<Result, Arguments...>>,
      public DynamicValueObject {
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

  std::string dynamicToString() const override { return "function"; }

  Value dynamicCall(Runtime& runtime, const std::vector<Value>& arguments) override {
    if (arguments.size() >= sizeof...(Arguments)) {
      return dynamicCallWithIndices(arguments, std::index_sequence_for<Arguments...>{});
    }
    auto normalizedArguments = arguments;
    normalizedArguments.resize(sizeof...(Arguments), Value::undefined());
    return dynamicCallWithIndices(normalizedArguments, std::index_sequence_for<Arguments...>{});
  }

  void Trace(cppgc::Visitor* visitor) const override {
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
  static std::function<Result(Arguments...)> convert(Runtime& runtime, const Value& value) {
    if (value.isUndefined() || value.isNull()) return {};
    if (!value.isDynamicObject()) throw runtime.errorAtCurrentSource("VexaScript value is not callable");
    auto* function = static_cast<FunctionObject<Result, Arguments...>*>(
        value.dynamicObject()->dynamicCast(nativeTypeToken<FunctionObject<Result, Arguments...>>()));
    if (!function) throw runtime.errorAtCurrentSource("VexaScript callable has an incompatible native signature");
    cppgc::Persistent<FunctionObject<Result, Arguments...>> rooted(function);
    return [rooted = std::move(rooted)](Arguments... arguments) mutable -> Result {
      return rooted->invoke(std::forward<Arguments>(arguments)...);
    };
  }
};

template <typename Result>
Result functionFromValue(Runtime& runtime, const Value& value) {
  return FunctionFromValue<Result>::convert(runtime, value);
}

template <typename Result, typename... Arguments, typename Callback>
FunctionObject<Result, Arguments...>* makeFunction(
    Runtime& runtime,
    Callback callback,
    std::initializer_list<Value> roots = {}) {
  return runtime.make<FunctionObject<Result, Arguments...>>(std::move(callback), roots);
}

inline Value call(Runtime& runtime, const Value& callable, std::vector<Value> arguments) {
  if (!callable.isDynamicObject()) {
    throw runtime.errorAtCurrentSource("VexaScript value is not callable");
  }
  return callable.dynamicObject()->dynamicCall(runtime, arguments);
}

inline Value callOptional(Runtime& runtime, const Value& callable, std::vector<Value> arguments) {
  if (callable.isNull() || callable.isUndefined()) return Value::undefined();
  return call(runtime, callable, std::move(arguments));
}

template <typename... Arguments>
inline std::optional<Value> callDynamicOperator(
    Runtime& runtime,
    const Value& receiver,
    const PropertyKey& operatorKey,
    Arguments&&... arguments) {
  if (!receiver.isDynamicObject()) return std::nullopt;
  const Value callable = receiver.dynamicObject()->dynamicGet(operatorKey);
  if (callable.isUndefined()) return std::nullopt;
  return call(runtime, callable, {
    convertValue<Value>(std::forward<Arguments>(arguments))...
  });
}

template <typename Result>
Result recordGet(Runtime& runtime, RecordObject* record, const std::string& key) {
  if (!record) throw std::runtime_error("Cannot read a property of null");
  return convertValue<Result>(record->get(key));
}

template <typename Result>
Result recordGet(Runtime& runtime, const Value& value, const std::string& key) {
  if (!value.isRecord()) throw std::runtime_error("Cannot read a property of a non-record value");
  return recordGet<Result>(runtime, value.record(), key);
}

template <typename Result>
Result recordGet(Runtime& runtime, RecordObject* record, const PropertyKey& key) {
  if (!record) throw std::runtime_error("Cannot read a property of null");
  return convertValue<Result>(record->get(key));
}

template <typename Result>
Result recordGet(Runtime& runtime, const Value& value, const PropertyKey& key) {
  if (!value.isRecord()) throw std::runtime_error("Cannot read a property of a non-record value");
  return recordGet<Result>(runtime, value.record(), key);
}

template <typename Input>
std::remove_cvref_t<Input> recordSet(
    Runtime& runtime,
    RecordObject* record,
    const std::string& key,
    Input&& input) {
  if (!record) throw std::runtime_error("Cannot write a property of null");
  using Result = std::remove_cvref_t<Input>;
  Result result = std::forward<Input>(input);
  record->set(key, convertValue<Value>(result));
  return result;
}

template <typename Input>
std::remove_cvref_t<Input> recordSet(
    Runtime& runtime,
    RecordObject* record,
    const PropertyKey& key,
    Input&& input) {
  if (!record) throw std::runtime_error("Cannot write a property of null");
  using Result = std::remove_cvref_t<Input>;
  Result result = std::forward<Input>(input);
  record->set(key, convertValue<Value>(result));
  return result;
}

inline PropertyKey propertyKey(const std::string& value) { return utf8ToUtf16(value); }
inline PropertyKey propertyKey(const Text& value) { return value.utf16(); }
inline const PropertyKey& propertyKey(const PropertyKey& value) { return value; }
inline PropertyKey propertyKey(double value) {
  std::ostringstream output;
  output << std::setprecision(15) << value;
  return utf8ToUtf16(output.str());
}
inline PropertyKey propertyKey(std::int32_t value) { return utf8ToUtf16(std::to_string(value)); }
inline PropertyKey propertyKey(std::int64_t value) { return utf8ToUtf16(std::to_string(value)); }
inline PropertyKey propertyKey(const BigInt& value) { return utf8ToUtf16(value.toString()); }
inline PropertyKey propertyKey(bool value) { return value ? u"true" : u"false"; }
inline PropertyKey propertyKey(const Value& value) {
  if (value.isString()) return value.utf16();
  if (value.isNumber()) return propertyKey(value.number());
  if (value.isBigInt()) return propertyKey(value.bigint());
  if (value.isBoolean()) return propertyKey(value.boolean());
  if (value.isNull()) return u"null";
  if (value.isUndefined()) return u"undefined";
  if (value.isDynamicObject()) return utf8ToUtf16(value.dynamicObject()->dynamicToString());
  return u"[object Object]";
}

inline RecordObject* recordSpread(RecordObject* target, RecordObject* source) {
  if (!target || !source) throw std::runtime_error("Cannot spread a null object");
  source->copyTo(target);
  return target;
}

inline RecordObject* recordSpread(RecordObject* target, EnumerableObject* source) {
  if (!source) return target;
  auto& runtime = Runtime::current();
  for (const auto& key : source->enumerableKeys()) target->set(key, source->enumerableGet(key));
  return target;
}

inline RecordObject* recordSpread(RecordObject* target, DynamicValueObject* source) {
  if (!source) return target;
  auto& runtime = Runtime::current();
  for (const auto& key : objectKeys(source)) target->set(key, source->dynamicGet(utf8ToUtf16(key)));
  return target;
}

template <typename T>
  requires std::is_base_of_v<DynamicValueObject, T>
inline RecordObject* recordSpread(RecordObject* target, T* source) {
  return recordSpread(target, static_cast<DynamicValueObject*>(source));
}

template <typename T>
inline RecordObject* recordSpread(RecordObject* target, const cppgc::Member<T>& source) {
  return recordSpread(target, source.Get());
}

inline RecordObject* recordSpread(RecordObject* target, const Value& source) {
  if (source.isNull() || source.isUndefined()) return target;
  if (source.isRecord()) return recordSpread(target, source.record());
  if (source.isDynamicObject()) return recordSpread(target, source.dynamicObject());
  throw std::runtime_error("Object spread requires an enumerable object");
}

inline RecordObject* recordRest(
    Runtime& runtime,
    RecordObject* source,
    std::initializer_list<std::string> excluded) {
  if (!source) throw std::runtime_error("Cannot destructure a null object");
  std::unordered_set<std::string> excludedKeys(excluded);
  auto* result = runtime.record();
  for (const auto& key : source->keys()) {
    if (!excludedKeys.contains(key)) result->set(key, source->get(key));
  }
  return result;
}

template <typename Callback>
Value destructureDefault(Runtime& runtime, Value value, Callback&& fallback) {
  return value.isUndefined()
      ? convertValue<Value>(std::forward<Callback>(fallback)())
      : value;
}

template <typename T, typename Callback>
T destructureDefault(Runtime&, T value, Callback&&) {
  return value;
}

inline bool recordHas(RecordObject* record, const std::string& key) {
  return record && record->has(key);
}

inline bool recordHas(RecordObject* record, const PropertyKey& key) {
  return record && record->has(key);
}

inline bool hasProperty(Runtime& runtime, const Value& value, const PropertyKey& key) {
  if (value.isRecord()) return value.record()->has(key);
  if (value.isDynamicObject()) return !value.dynamicObject()->dynamicGet(key).isUndefined();
  return false;
}

inline bool hasProperty(Runtime&, RecordObject* record, const PropertyKey& key) {
  return recordHas(record, key);
}

template <typename T>
inline bool hasProperty(Runtime& runtime, T* value, const PropertyKey& key) {
  if constexpr (std::is_base_of_v<RecordObject, T>) return recordHas(value, key);
  if constexpr (std::is_base_of_v<DynamicValueObject, T>) return value && !value->dynamicGet(key).isUndefined();
  return false;
}

inline bool recordDelete(RecordObject* record, const std::string& key) {
  return record && record->erase(key);
}

inline bool recordDelete(RecordObject* record, const PropertyKey& key) {
  return record && record->erase(key);
}

inline Value dynamicObjectGet(DynamicValueObject* target, const PropertyKey& key) {
  if (!target) throw std::runtime_error("Cannot read a property of null");
  Value value = target->dynamicGet(key);
  if (!value.isUndefined()) return value;
  if (key == u"message") {
    if (void* error = target->dynamicCast(nativeTypeToken<Error>())) {
      return currentRuntime().string(static_cast<Error*>(error)->messageText());
    }
  }
  return value;
}

inline Value dynamicGet(const Text& target, const PropertyKey& key) {
  if (key == u"length") return Value(static_cast<double>(target.size()));
  if (const auto index = propertyIndex(key); index && *index < target.size()) {
    return currentRuntime().string(target.utf16().substr(*index, 1));
  }
  return Value::undefined();
}

inline Value dynamicGet(const Value& target, const PropertyKey& key) {
  if (target.isRecord()) return target.record()->get(key);
  if (target.isDynamicObject()) return dynamicObjectGet(target.dynamicObject(), key);
  if (target.isString()) {
    if (key == u"message") return target;
    if (key == u"length") return Value(static_cast<double>(target.utf16().size()));
    if (const auto index = propertyIndex(key); index && *index < target.utf16().size()) {
      return currentRuntime().string(target.utf16().substr(*index, 1));
    }
    return Value::undefined();
  }
  if (target.isNull() || target.isUndefined()) {
    throw errorAtCurrentSource(
        std::string("Cannot read property '") + utf16ToUtf8(key) + "' of null or undefined");
  }
  throw errorAtCurrentSource("Dynamic native object properties require a declared interface or cast");
}

inline Value dynamicGet(RecordObject* target, const PropertyKey& key) {
  if (!target) throw std::runtime_error("Cannot read a property of null");
  return target->get(key);
}

template <typename T>
  requires std::is_base_of_v<DynamicValueObject, T>
inline Value dynamicGet(T* target, const PropertyKey& key) {
  return dynamicObjectGet(target, key);
}

template <typename T>
inline Value dynamicGet(const cppgc::Member<T>& target, const PropertyKey& key) {
  return dynamicGet(target.Get(), key);
}

inline Value dynamicGetOptional(const Value& target, const PropertyKey& key) {
  return target.isNull() || target.isUndefined() ? Value::undefined() : dynamicGet(target, key);
}

template <typename T>
  requires std::is_base_of_v<DynamicValueObject, T>
inline Value dynamicGetOptional(T* target, const PropertyKey& key) {
  return target ? dynamicGet(target, key) : Value::undefined();
}

template <typename T>
  requires std::is_base_of_v<DynamicValueObject, T>
inline Value dynamicGetOptional(const cppgc::Member<T>& target, const PropertyKey& key) {
  return target ? dynamicGet(target.Get(), key) : Value::undefined();
}

inline Value dynamicSet(const Value& target, const PropertyKey& key, const Value& value) {
  if (target.isRecord()) {
    target.record()->set(key, value);
    return value;
  }
  if (target.isDynamicObject()) return target.dynamicObject()->dynamicSet(key, value);
  throw std::runtime_error("Cannot set a property on this dynamic value");
}

inline Value dynamicSet(RecordObject* target, const PropertyKey& key, const Value& value) {
  if (!target) throw std::runtime_error("Cannot set a property on null");
  target->set(key, value);
  return value;
}

template <typename T>
  requires std::is_base_of_v<DynamicValueObject, T>
inline Value dynamicSet(T* target, const PropertyKey& key, const Value& value) {
  if (!target) throw std::runtime_error("Cannot set a property on null");
  return target->dynamicSet(key, value);
}

inline Value dynamicIndexArgument(Runtime& runtime, const PropertyKey& key) {
  if (const auto index = propertyIndex(key)) return Value(static_cast<double>(*index));
  return runtime.string(key);
}

template <typename Target>
inline Value dynamicIndexGet(Target&& target, const PropertyKey& key) {
  auto& runtime = currentRuntime();
  const Value receiver = convertValue<Value>(std::forward<Target>(target));
  if (const auto result = callDynamicOperator(
        runtime,
        receiver,
        u"__vexa_operator:[]",
        dynamicIndexArgument(runtime, key))) {
    return *result;
  }
  return dynamicGet(receiver, key);
}

template <typename Target>
inline Value dynamicIndexSet(Target&& target, const PropertyKey& key, const Value& value) {
  auto& runtime = currentRuntime();
  const Value receiver = convertValue<Value>(std::forward<Target>(target));
  if (const auto result = callDynamicOperator(
        runtime,
        receiver,
        u"__vexa_operator:[]=",
        dynamicIndexArgument(runtime, key), value)) {
    return *result;
  }
  return dynamicSet(receiver, key, value);
}

inline bool dynamicDelete(const Value& target, const PropertyKey& key) {
  if (target.isRecord()) return target.record()->erase(key);
  return target.isDynamicObject() && target.dynamicObject()->dynamicDelete(key);
}

inline Value recordGetOptional(RecordObject* record, const std::string& key) {
  return record ? record->get(key) : Value::undefined();
}

inline Value recordGetOptional(RecordObject* record, const PropertyKey& key) {
  return record ? record->get(key) : Value::undefined();
}

inline ArrayObject<Text>* recordKeys(Runtime& runtime, RecordObject* record) {
  auto* result = runtime.array<Text>();
  if (record) for (const auto& key : record->keys()) result->append(Text(key));
  return result;
}

inline ArrayObject<Text>* recordKeys(Runtime& runtime, EnumerableObject* object) {
  auto* result = runtime.array<Text>();
  if (object) for (const auto& key : objectKeys(object)) result->append(Text(key));
  return result;
}

inline ArrayObject<Text>* recordKeys(Runtime& runtime, DynamicValueObject* object) {
  auto* result = runtime.array<Text>();
  if (object) for (const auto& key : objectKeys(object)) result->append(Text(key));
  return result;
}

template <typename T>
  requires std::is_base_of_v<DynamicValueObject, T>
inline ArrayObject<Text>* recordKeys(Runtime& runtime, T* object) {
  return recordKeys(runtime, static_cast<DynamicValueObject*>(object));
}

inline ArrayObject<Value>* recordValues(Runtime& runtime, RecordObject* record) {
  auto* result = runtime.array<Value>();
  if (record) for (const auto& value : record->values()) result->append(value);
  return result;
}

inline ArrayObject<Value>* recordValues(Runtime& runtime, EnumerableObject* object) {
  auto* result = runtime.array<Value>();
  if (object) {
    for (const auto& key : objectKeys(object)) result->append(object->enumerableGet(key));
  }
  return result;
}

inline ArrayObject<Value>* recordValues(Runtime& runtime, DynamicValueObject* object) {
  auto* result = runtime.array<Value>();
  if (object) {
    for (const auto& key : objectKeys(object)) result->append(object->dynamicGet(utf8ToUtf16(key)));
  }
  return result;
}

template <typename T>
  requires std::is_base_of_v<DynamicValueObject, T>
inline ArrayObject<Value>* recordValues(Runtime& runtime, T* object) {
  return recordValues(runtime, static_cast<DynamicValueObject*>(object));
}

inline ArrayObject<ArrayObject<Value>*>* recordEntries(Runtime& runtime, RecordObject* record) {
  auto* result = runtime.array<ArrayObject<Value>*>();
  if (!record) return result;
  for (const auto& key : record->keys()) {
    result->append(runtime.array<Value>({runtime.string(key), record->get(key)}));
  }
  return result;
}

inline ArrayObject<ArrayObject<Value>*>* recordEntries(Runtime& runtime, EnumerableObject* object) {
  auto* result = runtime.array<ArrayObject<Value>*>();
  if (!object) return result;
  for (const auto& key : objectKeys(object)) {
    result->append(runtime.array<Value>({runtime.string(key), object->enumerableGet(key)}));
  }
  return result;
}

inline ArrayObject<ArrayObject<Value>*>* recordEntries(Runtime& runtime, DynamicValueObject* object) {
  auto* result = runtime.array<ArrayObject<Value>*>();
  if (!object) return result;
  for (const auto& key : objectKeys(object)) {
    result->append(runtime.array<Value>({runtime.string(key), object->dynamicGet(utf8ToUtf16(key))}));
  }
  return result;
}

template <typename T>
  requires std::is_base_of_v<DynamicValueObject, T>
inline ArrayObject<ArrayObject<Value>*>* recordEntries(Runtime& runtime, T* object) {
  return recordEntries(runtime, static_cast<DynamicValueObject*>(object));
}

inline ArrayObject<ArrayObject<Value>*>* recordEntries(Runtime& runtime, const Value& value) {
  if (value.isRecord()) return recordEntries(runtime, value.record());
  if (value.isDynamicObject()) return recordEntries(runtime, value.dynamicObject());
  return runtime.array<ArrayObject<Value>*>();
}

template <typename Entry>
inline RecordObject* recordFromEntries(Runtime& runtime, const ArrayObject<ArrayObject<Entry>*>* entries) {
  auto* record = runtime.record();
  for (auto* entry : *entries) {
    if (!entry || entry->size() < 2) continue;
    record->set(propertyKey(convertValue<Value>(entry->get(0))), convertValue<Value>(entry->get(1)));
  }
  return record;
}

inline RecordObject* recordFromEntries(Runtime& runtime, const Value& entries) {
  auto* record = runtime.record();
  for (const auto& entryValue : *arrayPointer(entries)) {
    auto* entry = arrayPointer(entryValue);
    if (entry->size() < 2) continue;
    record->set(propertyKey(entry->get(0)), entry->get(1));
  }
  return record;
}

inline ArrayObject<Text>* recordKeys(Runtime& runtime, const Value& value) {
  if (value.isRecord()) return recordKeys(runtime, value.record());
  if (value.isDynamicObject()) return recordKeys(runtime, value.dynamicObject());
  return runtime.array<Text>();
}

inline ArrayObject<Value>* recordValues(Runtime& runtime, const Value& value) {
  if (value.isRecord()) return recordValues(runtime, value.record());
  if (value.isDynamicObject()) return recordValues(runtime, value.dynamicObject());
  return runtime.array<Value>();
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
      ? std::forward<Callback>(fallback)()
      : value;
}

template <typename Callback>
Text nullishCoalesce(Text value, Callback&&) {
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
[[noreturn]] inline void throwReturn(Runtime& runtime, Callback&& callback) {
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
  explicit LabeledBreakSignal(std::string label) : label_(std::move(label)) {}
  const std::string& label() const { return label_; }
 private:
  std::string label_;
};
class LabeledContinueSignal final {
 public:
  explicit LabeledContinueSignal(std::string label) : label_(std::move(label)) {}
  const std::string& label() const { return label_; }
 private:
  std::string label_;
};

class RejectedValue final : public std::exception {
 public:
  explicit RejectedValue(Value reason)
      : reason_(std::move(reason)), message_(toString(reason_)) {}
  const char* what() const noexcept override { return message_.c_str(); }
  const Value& reason() const { return reason_; }

 private:
  Value reason_;
  std::string message_;
};

template <typename T>
class Task final {
 public:
  struct State final {
    Runtime* runtime = nullptr;
    std::optional<typename TaskStorage<T>::Type> value;
    std::exception_ptr error;
    std::vector<std::function<void()>> continuations;
    bool settled = false;
  };

  struct promise_type final {
    promise_type() : state(makeState(Runtime::current())) {}

    template <typename... Arguments>
    explicit promise_type(Runtime& runtime, Arguments&&...) : state(makeState(runtime)) {}

    template <typename Owner, typename... Arguments>
    promise_type(Owner&, Runtime& runtime, Arguments&&...) : state(makeState(runtime)) {}

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
  static Task create(Runtime& runtime, Executor executor) {
    auto state = makeState(runtime);
    try {
      executor(Resolver(state), Rejecter(state));
    } catch (...) {
      reject(state, std::current_exception());
    }
    return Task(std::move(state));
  }

  template <typename Work>
  static Task schedule(Runtime& runtime, Work work) {
    auto state = makeState(runtime);
    runtime.enqueueMicrotask([state, work = std::move(work)]() mutable {
      try {
        resolve(state, work());
      } catch (...) {
        reject(state, std::current_exception());
      }
    });
    return Task(std::move(state));
  }

  T get() const {
    state_->runtime->runUntil([this] { return state_->settled; });
    if (state_->error) std::rethrow_exception(state_->error);
    return TaskStorage<T>::load(*state_->value);
  }

  Awaiter operator co_await() const { return Awaiter(state_); }

  void whenSettled(std::function<void()> continuation) const {
    onSettled(state_, std::move(continuation));
  }

  T settledValue() const {
    if (!state_->settled) throw std::runtime_error("Promise is not settled");
    if (state_->error) std::rethrow_exception(state_->error);
    return TaskStorage<T>::load(*state_->value);
  }

  std::exception_ptr settledError() const { return state_->error; }

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
      reject(state_, std::make_exception_ptr(std::runtime_error("Promise rejected")));
    }

    void operator()(const Error& error) const {
      reject(state_, std::make_exception_ptr(RejectedValue(state_->runtime->string(error.messageText()))));
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

  static std::shared_ptr<State> makeState(Runtime& runtime) {
    auto state = std::make_shared<State>();
    state->runtime = &runtime;
    return state;
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
    if (state->settled) state->runtime->enqueueMicrotask(std::move(continuation));
    else state->continuations.push_back(std::move(continuation));
  }

  static void notify(const std::shared_ptr<State>& state) {
    for (auto& continuation : state->continuations) {
      state->runtime->enqueueMicrotask(std::move(continuation));
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
    Runtime* runtime = nullptr;
    std::exception_ptr error;
    std::vector<std::function<void()>> continuations;
    bool settled = false;
  };

  struct promise_type final {
    promise_type() : state(makeState(Runtime::current())) {}

    template <typename... Arguments>
    explicit promise_type(Runtime& runtime, Arguments&&...) : state(makeState(runtime)) {}

    template <typename Owner, typename... Arguments>
    promise_type(Owner&, Runtime& runtime, Arguments&&...) : state(makeState(runtime)) {}

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
  static Task create(Runtime& runtime, Executor executor) {
    auto state = makeState(runtime);
    try {
      executor(Resolver(state), Rejecter(state));
    } catch (...) {
      reject(state, std::current_exception());
    }
    return Task(std::move(state));
  }

  template <typename Work>
  static Task schedule(Runtime& runtime, Work work) {
    auto state = makeState(runtime);
    runtime.enqueueMicrotask([state, work = std::move(work)]() mutable {
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
    state_->runtime->runUntil([this] { return state_->settled; });
    if (state_->error) std::rethrow_exception(state_->error);
  }

  Awaiter operator co_await() const { return Awaiter(state_); }

  void whenSettled(std::function<void()> continuation) const {
    onSettled(state_, std::move(continuation));
  }

  void settledValue() const {
    if (!state_->settled) throw std::runtime_error("Promise is not settled");
    if (state_->error) std::rethrow_exception(state_->error);
  }

  std::exception_ptr settledError() const { return state_->error; }

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
      reject(state_, std::make_exception_ptr(std::runtime_error("Promise rejected")));
    }

    void operator()(const Error& error) const {
      reject(state_, std::make_exception_ptr(RejectedValue(state_->runtime->string(error.messageText()))));
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

  static std::shared_ptr<State> makeState(Runtime& runtime) {
    auto state = std::make_shared<State>();
    state->runtime = &runtime;
    return state;
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
    if (state->settled) state->runtime->enqueueMicrotask(std::move(continuation));
    else state->continuations.push_back(std::move(continuation));
  }

  static void notify(const std::shared_ptr<State>& state) {
    for (auto& continuation : state->continuations) {
      state->runtime->enqueueMicrotask(std::move(continuation));
    }
    state->continuations.clear();
  }

  explicit Task(std::shared_ptr<State> state) : state_(std::move(state)) {}

  std::shared_ptr<State> state_;
};

inline Task<Value> readTextFile(Runtime& runtime, std::string path) {
  auto operation = std::async(std::launch::async, [path = std::move(path)] {
    std::ifstream input(path, std::ios::binary);
    if (!input) throw std::runtime_error("Cannot open file: " + path);
    std::ostringstream contents;
    contents << input.rdbuf();
    if (!input.good() && !input.eof()) throw std::runtime_error("Cannot read file: " + path);
    return contents.str();
  }).share();
  return Task<Value>::create(runtime, [&runtime, operation = std::move(operation)](auto resolve, auto reject) mutable {
    runtime.enqueueIo([&runtime, operation = std::move(operation), resolve, reject]() mutable {
      if (operation.wait_for(std::chrono::seconds(0)) != std::future_status::ready) return false;
      try {
        resolve(runtime.string(operation.get()));
      } catch (const std::exception& error) {
        reject(Error(std::string(error.what())));
      }
      return true;
    });
  });
}

inline Task<void> writeTextFile(Runtime& runtime, std::string path, std::string contents) {
  auto operation = std::async(std::launch::async, [path = std::move(path), contents = std::move(contents)] {
    std::ofstream output(path, std::ios::binary | std::ios::trunc);
    if (!output) throw std::runtime_error("Cannot open file for writing: " + path);
    output.write(contents.data(), static_cast<std::streamsize>(contents.size()));
    if (!output) throw std::runtime_error("Cannot write file: " + path);
  }).share();
  return Task<void>::create(runtime, [&runtime, operation = std::move(operation)](auto resolve, auto reject) mutable {
    runtime.enqueueIo([operation = std::move(operation), resolve, reject]() mutable {
      if (operation.wait_for(std::chrono::seconds(0)) != std::future_status::ready) return false;
      try {
        operation.get();
        resolve();
      } catch (const std::exception& error) {
        reject(Error(std::string(error.what())));
      }
      return true;
    });
  });
}

inline Task<Value> nativeStatPath(Runtime& runtime, std::string path) {
  return Task<Value>::create(runtime, [&runtime, path = std::move(path)](auto resolve, auto reject) mutable {
    const std::filesystem::path filePath(path);
    std::error_code error;
    const auto status = std::filesystem::status(filePath, error);
    if (error || !std::filesystem::exists(status)) {
      reject(Error("File does not exist: " + path));
      return;
    }
    const auto modified = std::filesystem::last_write_time(filePath, error);
    if (error) {
      reject(Error("Cannot read file modification time: " + path));
      return;
    }
    auto* value = runtime.record();
    value->set("mtimeMs", Value(static_cast<double>(modified.time_since_epoch().count()) / 1'000'000.0));
    value->set("isFile", Value(std::filesystem::is_regular_file(status)));
    value->set("isDirectory", Value(std::filesystem::is_directory(status)));
    resolve(Value(value));
  });
}

inline Task<ArrayObject<Value>*> nativeReadDirectory(Runtime& runtime, std::string path) {
  return Task<ArrayObject<Value>*>::create(runtime, [&runtime, path = std::move(path)](auto resolve, auto reject) mutable {
    try {
      auto* result = runtime.array<Value>();
      for (const auto& entry : std::filesystem::directory_iterator(path)) {
        auto* value = runtime.record();
        value->set("name", Value(runtime.string(entry.path().filename().string())));
        value->set("isFile", Value(entry.is_regular_file()));
        value->set("isDirectory", Value(entry.is_directory()));
        result->append(Value(value));
      }
      resolve(result);
    } catch (const std::exception& error) {
      reject(Error(std::string(error.what())));
    }
  });
}

inline Task<void> nativeCreateDirectory(Runtime& runtime, std::string path, bool recursive) {
  return Task<void>::create(runtime, [path = std::move(path), recursive](auto resolve, auto reject) mutable {
    try {
      if (recursive) std::filesystem::create_directories(path);
      else std::filesystem::create_directory(path);
      resolve();
    } catch (const std::exception& error) {
      reject(Error(std::string(error.what())));
    }
  });
}

inline Task<void> nativeRemovePath(Runtime& runtime, std::string path, bool recursive) {
  return Task<void>::create(runtime, [path = std::move(path), recursive](auto resolve, auto reject) mutable {
    try {
      if (recursive) std::filesystem::remove_all(path);
      else std::filesystem::remove(path);
      resolve();
    } catch (const std::exception& error) {
      reject(Error(std::string(error.what())));
    }
  });
}

inline Task<void> nativeCopyFile(Runtime& runtime, std::string source, std::string target) {
  return Task<void>::create(runtime, [source = std::move(source), target = std::move(target)](auto resolve, auto reject) mutable {
    try {
      std::filesystem::copy_file(source, target, std::filesystem::copy_options::overwrite_existing);
      resolve();
    } catch (const std::exception& error) {
      reject(Error(std::string(error.what())));
    }
  });
}

struct NativeCommandResult final {
  int code;
  std::string output;
};

inline std::string shellQuote(std::string_view value) {
  std::string quoted("'");
  for (const char character : value) {
    if (character == '\'') quoted += "'\\''";
    else quoted += character;
  }
  quoted += '\'';
  return quoted;
}

inline Task<Value> nativeRunCommandCapture(
    Runtime& runtime,
    std::string command,
    ArrayObject<Text>* arguments,
    std::string workingDirectory) {
  std::vector<std::string> copiedArguments;
  copiedArguments.reserve(arguments ? arguments->size() : 0);
  if (arguments) {
    for (std::size_t index = 0; index < arguments->size(); ++index) {
      copiedArguments.push_back(arguments->get(index).utf8());
    }
  }
  auto operation = std::async(std::launch::async, [
      command = std::move(command),
      arguments = std::move(copiedArguments),
      workingDirectory = std::move(workingDirectory)] {
    std::string shellCommand;
    if (!workingDirectory.empty()) shellCommand = "cd " + shellQuote(workingDirectory) + " && ";
    shellCommand += shellQuote(command);
    for (const auto& argument : arguments) shellCommand += " " + shellQuote(argument);
    shellCommand += " 2>&1";
#if defined(_WIN32)
    FILE* pipe = _popen(shellCommand.c_str(), "r");
#else
    FILE* pipe = popen(shellCommand.c_str(), "r");
#endif
    if (!pipe) throw std::runtime_error("Cannot start command: " + command);
    std::string output;
    char buffer[4096];
    while (std::fgets(buffer, sizeof(buffer), pipe)) output += buffer;
#if defined(_WIN32)
    const int status = _pclose(pipe);
    const int code = status;
#else
    const int status = pclose(pipe);
    const int code = WIFEXITED(status) ? WEXITSTATUS(status) : status;
#endif
    return NativeCommandResult{code, std::move(output)};
  }).share();
  return Task<Value>::create(runtime, [&runtime, operation = std::move(operation)](auto resolve, auto reject) mutable {
    runtime.enqueueIo([&runtime, operation = std::move(operation), resolve, reject]() mutable {
      if (operation.wait_for(std::chrono::seconds(0)) != std::future_status::ready) return false;
      try {
        auto result = operation.get();
        auto* value = runtime.record();
        value->set("code", Value(static_cast<double>(result.code)));
        value->set("stdout", runtime.string(result.output));
        value->set("stderr", runtime.string(""));
        resolve(Value(value));
      } catch (const std::exception& error) {
        reject(Error(std::string(error.what())));
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

inline Value nativeEnvironmentVariable(Runtime& runtime, const std::string& name) {
  const char* value = std::getenv(name.c_str());
  return value ? Value(runtime.string(value)) : Value::undefined();
}

inline Task<Value> dynamicImportUnavailable(Runtime& runtime, std::string specifier) {
  return Task<Value>::create(runtime, [specifier = std::move(specifier)](auto, auto reject) mutable {
    reject(Error("Dynamic import is not available in native C++: " + specifier));
  });
}

class Process final {
 public:
  Process(Runtime& runtime, int argc, char** arguments)
      : argv(runtime.array<Text>()), env(runtime.record()) {
    const std::string executable = argc > 0 && arguments[0] ? arguments[0] : "vexa";
    argv->append(Text(executable));
    argv->append(Text(executable));
    for (int index = 1; index < argc; ++index) argv->append(Text(arguments[index] ? arguments[index] : ""));
#if defined(_WIN32)
    char** environment = _environ;
#else
    char** environment = ::environ;
#endif
    if (environment) {
      for (char** entry = environment; *entry; ++entry) {
        const std::string item(*entry);
        const auto separator = item.find('=');
        if (separator == std::string::npos) continue;
        env->set(item.substr(0, separator), runtime.string(item.substr(separator + 1)));
      }
    }
  }

  std::string cwd() const { return std::filesystem::current_path().string(); }
  [[noreturn]] void exit(double code = 0) const { std::exit(static_cast<int>(code)); }

  cppgc::Persistent<ArrayObject<Text>> argv;
  cppgc::Persistent<RecordObject> env;
  double exitCode = 0;
};

inline Process* process = nullptr;

inline ArrayObject<Text>* commandLineArguments(Runtime& runtime) {
  auto* result = runtime.array<Text>();
  if (!process || !process->argv) return result;
  for (std::size_t index = 2; index < process->argv->size(); ++index) {
    result->append(process->argv->get(index));
  }
  return result;
}

template <typename T>
inline std::string toString(const Task<T>&) {
  return "[object Promise]";
}

template <typename T>
inline T defaultValue() {
  return T{};
}

template <typename T>
inline ArrayObject<T>* arrayWithLength(Runtime& runtime, double length) {
  auto* result = runtime.array<T>();
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
  for (const auto value : *source) target->append(value);
}

template <typename T, typename U>
  requires (!std::is_same_v<T, U>)
inline void appendAll(ArrayObject<T>* target, const ArrayObject<U>* source) {
  for (const auto value : *source) {
    target->append(convertValue<T>(value));
  }
}

template <typename T, typename U>
inline void appendAll(ArrayObject<T>* target, SetObject<U>* source) {
  source->forEach([&](U value) {
    target->append(convertValue<T>(value));
  });
}

template <typename T>
inline void appendAll(ArrayObject<T>* target, const Value& source) {
  auto& runtime = Runtime::current();
  for (const auto value : dynamicIterationRange(runtime, source)) {
    target->append(convertValue<T>(value));
  }
}

template <typename T>
inline double pushAll(ArrayObject<T>* target, const ArrayObject<T>* source) {
  appendAll(target, source);
  return static_cast<double>(target->size());
}

template <typename T>
inline void appendAllConverted(Runtime& runtime, std::vector<Value>& target, const std::vector<T>& source) {
  target.reserve(target.size() + source.size());
  for (const auto& value : source) target.push_back(convertValue<Value>(value));
}

template <typename T>
inline void appendAllConverted(Runtime& runtime, ArrayObject<Value>* target, const ArrayObject<T>* source) {
  for (const auto value : *source) target->append(convertValue<Value>(value));
}

template <typename K, typename V>
inline void appendAllConverted(Runtime& runtime, ArrayObject<Value>* target, MapObject<K, V>* source) {
  source->forEach([&](V value, K key) {
    target->append(convertValue<Value>(runtime.array<Value>({
        convertValue<Value>(key),
        convertValue<Value>(value)})));
  });
}

template <typename K, typename V>
inline void appendAllConverted(
    Runtime& runtime,
    ArrayObject<Value>* target,
    const cppgc::Persistent<MapObject<K, V>>& source) {
  appendAllConverted(runtime, target, source.Get());
}

template <typename T>
inline void appendAllConverted(Runtime& runtime, ArrayObject<Value>* target, SetObject<T>* source) {
  source->forEach([&](T value) { target->append(convertValue<Value>(value)); });
}

template <typename T>
inline void appendAllConverted(
    Runtime& runtime,
    ArrayObject<Value>* target,
    const cppgc::Persistent<SetObject<T>>& source) {
  appendAllConverted(runtime, target, source.Get());
}

inline void appendAllConverted(Runtime& runtime, ArrayObject<Value>* target, const Value& source) {
  for (const auto value : dynamicIterationRange(runtime, source)) {
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
inline ArrayObject<T>* ArrayObject<T>::slice(Runtime& runtime, double start, double end) const {
  auto* result = runtime.array<T>();
  const std::size_t first = normalizedSliceIndex(start, size());
  const std::size_t last = std::isinf(end) ? size() : normalizedSliceIndex(end, size());
  for (std::size_t index = first; index < last; ++index) result->append(get(index));
  return result;
}

template <typename T>
inline ArrayObject<T>* slice(Runtime& runtime, const ArrayObject<T>* array, double start = 0, double end = std::numeric_limits<double>::infinity()) {
  return array->slice(runtime, start, end);
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
inline ArrayObject<T>* ArrayObject<T>::concat(Runtime& runtime, Items&&... items) const {
  auto* result = runtime.array<T>();
  appendAll(result, this);
  (appendConcatItem(result, std::forward<Items>(items)), ...);
  return result;
}

template <typename T, typename... Items>
inline ArrayObject<T>* concat(Runtime& runtime, const ArrayObject<T>* array, Items&&... items) {
  return array->concat(runtime, std::forward<Items>(items)...);
}

template <typename Callback, typename T>
inline decltype(auto) invokeArrayCallback(
    Callback& callback,
    T value,
    std::size_t index,
    const ArrayObject<T>* array) {
  auto* mutableArray = const_cast<ArrayObject<T>*>(array);
  if constexpr (std::is_invocable_v<Callback, T, double, ArrayObject<T>*>) {
    return callback(value, static_cast<double>(index), mutableArray);
  } else if constexpr (std::is_invocable_v<Callback, T, double>) {
    return callback(value, static_cast<double>(index));
  } else if constexpr (std::is_invocable_v<Callback, T>) {
    return callback(value);
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
    return callback(std::move(accumulator), value, static_cast<double>(index), mutableArray);
  } else if constexpr (std::is_invocable_v<Callback, Accumulator, T, double>) {
    return callback(std::move(accumulator), value, static_cast<double>(index));
  } else {
    return callback(std::move(accumulator), value);
  }
}

inline bool arrayCallbackBoolean(const Value& value) {
  if (value.isUndefined() || value.isNull()) return false;
  if (value.isBoolean()) return value.boolean();
  if (value.isNumber()) return value.number() != 0 && !std::isnan(value.number());
  return !value.isString() || !value.utf16().empty();
}

inline bool arrayCallbackBoolean(const std::string& value) { return !value.empty(); }

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
inline auto ArrayObject<T>::map(Runtime& runtime, Callback callback) const {
  using Result = std::remove_cvref_t<decltype(
      invokeArrayCallback(callback, std::declval<T>(), std::size_t{}, this))>;
  auto* result = runtime.array<Result>();
  for (std::size_t index = 0; index < size(); ++index) {
    result->append(invokeArrayCallback(callback, get(index), index, this));
  }
  return result;
}

template <typename T, typename Callback>
inline auto map(Runtime& runtime, const ArrayObject<T>* array, Callback callback) {
  using Result = decltype(array->map(runtime, std::move(callback)));
  return array ? array->map(runtime, std::move(callback)) : static_cast<Result>(nullptr);
}

template <typename T, typename Callback>
inline std::vector<T> filter(const std::vector<T>& array, Callback callback) {
  std::vector<T> result;
  for (const auto& value : array) if (callback(value)) result.push_back(value);
  return result;
}

template <typename T>
template <typename Callback>
inline ArrayObject<T>* ArrayObject<T>::filter(Runtime& runtime, Callback callback) const {
  auto* result = runtime.array<T>();
  for (std::size_t index = 0; index < size(); ++index) {
    const auto value = get(index);
    if (arrayCallbackBoolean(invokeArrayCallback(callback, value, index, this))) result->append(value);
  }
  return result;
}

template <typename T, typename Callback>
inline ArrayObject<T>* filter(Runtime& runtime, const ArrayObject<T>* array, Callback callback) {
  return array->filter(runtime, std::move(callback));
}

template <typename T>
inline ArrayObject<T>* flat(
    Runtime& runtime,
    const ArrayObject<ArrayObject<T>*>* array,
    double depth = 1) {
  if (depth != 1) {
    throw std::runtime_error("Native Array.flat currently supports the default depth of one");
  }
  auto* result = runtime.array<T>();
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
inline auto flatMap(Runtime& runtime, const ArrayObject<T>* array, Callback callback) {
  using NestedArray = std::remove_cvref_t<decltype(
      invokeArrayCallback(callback, std::declval<T>(), std::size_t{}, array))>;
  using Result = typename ArrayPointerElement<NestedArray>::Type;
  auto* result = runtime.array<Result>();
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
template <typename... Items>
inline ArrayObject<T>* ArrayObject<T>::splice(
    Runtime& runtime,
    double start,
    double deleteCount,
    Items&&... items) {
  const std::size_t first = normalizedSliceIndex(start, size());
  const std::size_t requested = std::isinf(deleteCount)
      ? size() - first
      : static_cast<std::size_t>(std::max(0.0, std::trunc(deleteCount)));
  const std::size_t count = std::min(requested, size() - first);
  auto* removed = runtime.array<T>();
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
    Runtime& runtime,
    ArrayObject<T>* array,
    double start,
    double deleteCount,
    Items&&... items) {
  return array->splice(runtime, start, deleteCount, std::forward<Items>(items)...);
}

template <typename T, typename Input>
inline ArrayObject<T>* spliceAll(
    Runtime& runtime,
    ArrayObject<T>* array,
    double start,
    double deleteCount,
    const ArrayObject<Input>* items) {
  const std::size_t first = normalizedSliceIndex(start, array->size());
  auto* removed = array->splice(runtime, start, deleteCount);
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

inline std::string numberToString(double value) {
  if (std::isnan(value)) return "NaN";
  if (std::isinf(value)) return value < 0 ? "-Infinity" : "Infinity";
  if (value == 0) return "0";
  std::ostringstream output;
  output << std::setprecision(15) << value;
  return output.str();
}

inline std::string toString(const Value& value) {
  if (value.isUndefined()) return "undefined";
  if (value.isNull()) return "null";
  if (value.isBoolean()) return value.boolean() ? "true" : "false";
  if (value.isNumber()) return numberToString(value.number());
  if (value.isBigInt()) return value.bigint().toString();
  if (value.isString()) return value.string();
  if (value.isDynamicObject()) return value.dynamicObject()->dynamicToString();
  return "[object Object]";
}

inline std::string toString(const Text& value) { return value.utf8(); }

inline std::string toString(double value) { return numberToString(value); }
inline std::string toString(int value) { return std::to_string(value); }
inline std::string toString(std::int64_t value) { return std::to_string(value); }
inline std::string toString(bool value) { return value ? "true" : "false"; }
inline const std::string& toString(const std::string& value) { return value; }

inline BigInt makeBigInt(const BigInt& value) { return value; }
inline BigInt makeBigInt(bool value) { return BigInt(value ? 1 : 0); }
inline BigInt makeBigInt(std::int32_t value) { return BigInt(value); }
inline BigInt makeBigInt(std::int64_t value) { return BigInt(static_cast<long long>(value)); }
inline BigInt makeBigInt(double value) {
  if (!std::isfinite(value) || std::trunc(value) != value) {
    throw std::runtime_error("Cannot convert a non-integer number to BigInt");
  }
  std::ostringstream text;
  text << std::fixed << std::setprecision(0) << value;
  return BigInt(text.str());
}
inline BigInt makeBigInt(const std::string& value) { return BigInt(value); }
inline BigInt makeBigInt(const Value& value) {
  if (value.isBigInt()) return value.bigint();
  if (value.isBoolean()) return makeBigInt(value.boolean());
  if (value.isNumber()) return makeBigInt(value.number());
  if (value.isString()) return makeBigInt(value.string());
  throw std::runtime_error("Cannot convert value to BigInt");
}

template <typename T>
inline std::string toString(ArrayObject<T>* array);

[[noreturn]] inline void throwValue(const Error& error) {
  throw RejectedValue(Runtime::current().string(error.messageText()));
}

[[noreturn]] inline void throwValue(const Value& value) { throw RejectedValue(value); }

template <typename T>
  requires std::is_base_of_v<DynamicValueObject, T>
[[noreturn]] inline void throwValue(T* value) {
  throw RejectedValue(Value(value));
}

template <typename T>
[[noreturn]] inline void throwValue(const T& value) {
  throw std::runtime_error(toString(value));
}

template <typename Result>
struct PromiseResult final {
  using Type = std::remove_cvref_t<Result>;
  static constexpr bool task = false;
};

template <typename Result>
struct PromiseResult<Task<Result>> final {
  using Type = typename PromiseResult<Result>::Type;
  static constexpr bool task = true;
};

template <typename Result>
Task<typename PromiseResult<Result>::Type> assimilateTask(Runtime& runtime, Task<Result> task) {
  if constexpr (PromiseResult<Result>::task) {
    auto nested = co_await task;
    if constexpr (std::is_void_v<typename PromiseResult<Result>::Type>) {
      co_await assimilateTask(runtime, std::move(nested));
      co_return;
    } else {
      co_return co_await assimilateTask(runtime, std::move(nested));
    }
  } else if constexpr (std::is_void_v<Result>) {
    co_await task;
    co_return;
  } else {
    co_return co_await task;
  }
}

template <typename Input>
Task<std::remove_cvref_t<Input>> resolvedTask(Runtime& runtime, Input value) {
  co_return std::move(value);
}

template <typename Input>
Task<std::remove_cvref_t<Input>> promiseResolve(Runtime& runtime, Input value) {
  co_return std::move(value);
}

template <typename Result>
Task<typename PromiseResult<Result>::Type> promiseResolve(Runtime& runtime, Task<Result> task) {
  if constexpr (std::is_void_v<typename PromiseResult<Result>::Type>) {
    co_await assimilateTask(runtime, std::move(task));
    co_return;
  } else {
    co_return co_await assimilateTask(runtime, std::move(task));
  }
}

template <typename Result, typename Reason>
Task<Result> rejectedTask(Runtime& runtime, const Reason& reason) {
  throwValue(reason);
  co_return defaultValue<Result>();
}

template <typename T>
Task<ArrayObject<T>*> promiseAll(Runtime& runtime, ArrayObject<Task<T>>* tasks) {
  cppgc::Persistent<ArrayObject<Task<T>>> rootedTasks(tasks);
  auto* values = runtime.array<T>();
  cppgc::Persistent<ArrayObject<T>> rootedValues(values);
  for (auto task : *tasks) values->append(co_await task);
  co_return values;
}

template <typename T>
Task<T> promiseRace(Runtime& runtime, ArrayObject<Task<T>>* tasks) {
  cppgc::Persistent<ArrayObject<Task<T>>> rootedTasks(tasks);
  return Task<T>::create(runtime, [rootedTasks](auto resolve, auto reject) mutable {
    for (std::size_t index = 0; index < rootedTasks->size(); ++index) {
      Task<T> task = rootedTasks->get(index);
      task.whenSettled([task, resolve, reject]() mutable {
        try {
          resolve(task.settledValue());
        } catch (const RejectedValue& rejected) {
          reject(rejected.reason());
        } catch (const std::exception& error) {
          reject(Error(std::string(error.what())));
        }
      });
    }
  });
}

template <typename T>
Task<ArrayObject<RecordObject*>*> promiseAllSettled(
    Runtime& runtime,
    ArrayObject<Task<T>>* tasks) {
  cppgc::Persistent<ArrayObject<Task<T>>> rootedTasks(tasks);
  cppgc::Persistent<ArrayObject<RecordObject*>> rootedResults(runtime.array<RecordObject*>());
  return Task<ArrayObject<RecordObject*>*>::create(
      runtime,
      [&runtime, rootedTasks, rootedResults](auto resolve, auto) mutable {
        const std::size_t count = rootedTasks->size();
        if (count == 0) {
          resolve(rootedResults.Get());
          return;
        }
        auto completed = std::make_shared<std::size_t>(0);
        for (std::size_t index = 0; index < count; ++index) {
          Task<T> task = rootedTasks->get(index);
          task.whenSettled([&runtime, task, index, count, completed, rootedResults, resolve]() mutable {
            RecordObject* result = nullptr;
            try {
              result = runtime.record({
                  {u"status", runtime.string("fulfilled")},
                  {u"value", convertValue<Value>(task.settledValue())},
              });
            } catch (const RejectedValue& rejected) {
              result = runtime.record({
                  {u"status", runtime.string("rejected")},
                  {u"reason", rejected.reason()},
              });
            } catch (const std::exception& error) {
              result = runtime.record({
                  {u"status", runtime.string("rejected")},
                  {u"reason", runtime.string(error.what())},
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
Task<T> promiseAny(Runtime& runtime, ArrayObject<Task<T>>* tasks) {
  cppgc::Persistent<ArrayObject<Task<T>>> rootedTasks(tasks);
  return Task<T>::create(runtime, [rootedTasks](auto resolve, auto reject) mutable {
    const std::size_t count = rootedTasks->size();
    if (count == 0) {
      reject(Error(std::string("All promises were rejected")));
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
          if (*rejected == count) reject(Error(std::string("All promises were rejected")));
        }
      });
    }
  });
}

template <typename T, typename Callback>
Task<typename PromiseResult<std::invoke_result_t<Callback, T>>::Type> promiseThen(
    Runtime& runtime,
    Task<T> source,
    Callback callback) {
  using CallbackResult = std::invoke_result_t<Callback, T>;
  using Result = typename PromiseResult<CallbackResult>::Type;
  T value = co_await source;
  if constexpr (PromiseResult<CallbackResult>::task) {
    if constexpr (std::is_void_v<Result>) {
      co_await assimilateTask(runtime, callback(std::move(value)));
      co_return;
    } else {
      co_return co_await assimilateTask(runtime, callback(std::move(value)));
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
    Runtime& runtime,
    Task<void> source,
    Callback callback) {
  using CallbackResult = std::invoke_result_t<Callback>;
  using Result = typename PromiseResult<CallbackResult>::Type;
  co_await source;
  if constexpr (PromiseResult<CallbackResult>::task) {
    if constexpr (std::is_void_v<Result>) {
      co_await assimilateTask(runtime, callback());
      co_return;
    } else {
      co_return co_await assimilateTask(runtime, callback());
    }
  } else if constexpr (std::is_void_v<CallbackResult>) {
    callback();
    co_return;
  } else {
    co_return callback();
  }
}

template <typename T, typename Callback>
Task<T> promiseCatch(Runtime& runtime, Task<T> source, Callback callback) {
  Value reason = Value::undefined();
  try {
    co_return co_await source;
  } catch (const RejectedValue& rejected) {
    reason = rejected.reason();
  } catch (const std::exception& error) {
    reason = runtime.string(error.what());
  }
  using CallbackResult = std::invoke_result_t<Callback, Value>;
  if constexpr (PromiseResult<CallbackResult>::task) {
    co_return co_await assimilateTask(runtime, callback(reason));
  } else {
    co_return callback(reason);
  }
}

template <typename T, typename Callback>
Task<T> promiseFinally(Runtime& runtime, Task<T> source, Callback callback) {
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

template <typename T>
inline std::string joinWithSeparator(const std::vector<T>& array, const std::string& separator) {
  std::ostringstream output;
  for (std::size_t index = 0; index < array.size(); ++index) {
    if (index > 0) output << separator;
    output << toString(array[index]);
  }
  return output.str();
}

template <typename T>
inline std::string joinWithSeparator(const ArrayObject<T>* array, const std::string& separator) {
  std::ostringstream output;
  for (std::size_t index = 0; index < array->size(); ++index) {
    if (index > 0) output << separator;
    output << toString(array->get(index));
  }
  return output.str();
}

template <typename T>
inline std::string ArrayObject<T>::join(const std::string& separator) const {
  return joinWithSeparator(this, separator);
}

template <typename T>
inline std::string join(const std::vector<T>& array) {
  return joinWithSeparator(array, ",");
}

template <typename T>
inline std::string join(const ArrayObject<T>* array) {
  return array->join();
}

inline Text join(const std::vector<Text>& array, const Text& separator) {
  if (array.empty()) return Text();
  std::size_t size = separator.size() * (array.size() - 1);
  for (const auto& value : array) size += value.size();
  std::u16string result;
  result.reserve(size);
  for (std::size_t index = 0; index < array.size(); ++index) {
    if (index > 0) result += separator.utf16();
    result += array[index].utf16();
  }
  return Text(std::move(result));
}

inline Text join(const ArrayObject<Text>* array, const Text& separator) {
  if (!array || array->size() == 0) return Text();
  std::size_t size = separator.size() * (array->size() - 1);
  for (std::size_t index = 0; index < array->size(); ++index) {
    size += array->get(index).size();
  }
  std::u16string result;
  result.reserve(size);
  for (std::size_t index = 0; index < array->size(); ++index) {
    if (index > 0) result += separator.utf16();
    result += array->get(index).utf16();
  }
  return Text(std::move(result));
}

template <typename T, typename Separator>
inline std::string join(const std::vector<T>& array, const Separator& separator) {
  return joinWithSeparator(array, toString(separator));
}

template <typename T, typename Separator>
inline std::string join(const ArrayObject<T>* array, const Separator& separator) {
  return array->join(toString(separator));
}

template <typename T>
inline std::string ArrayObject<T>::toString() const {
  return "[" + join(", ") + "]";
}

template <typename T>
inline ArrayObject<T>* ArrayObject<T>::sort() {
  std::vector<T> sorted;
  sorted.reserve(size());
  for (const auto value : *this) sorted.push_back(value);
  std::stable_sort(sorted.begin(), sorted.end(), [](const T& left, const T& right) {
    return vexa::toString(left) < vexa::toString(right);
  });
  for (std::size_t index = 0; index < sorted.size(); ++index) values_[index].store(sorted[index]);
  return this;
}

template <typename T>
inline ArrayObject<T>* sort(ArrayObject<T>* array) {
  return array->sort();
}

template <typename T>
inline std::string toString(ArrayObject<T>* array) {
  return array ? array->toString() : "null";
}

template <typename T>
inline std::string toString(const cppgc::Member<ArrayObject<T>>& array) {
  return toString(array.Get());
}

template <typename T>
inline std::string toString(const cppgc::Persistent<ArrayObject<T>>& array) {
  return toString(array.Get());
}

inline std::string jsonQuoted(const std::string& value) {
  std::ostringstream output;
  output << '"';
  for (const unsigned char character : value) {
    switch (character) {
      case '"': output << "\\\""; break;
      case '\\': output << "\\\\"; break;
      case '\b': output << "\\b"; break;
      case '\f': output << "\\f"; break;
      case '\n': output << "\\n"; break;
      case '\r': output << "\\r"; break;
      case '\t': output << "\\t"; break;
      default:
        if (character < 0x20) {
          output << "\\u" << std::hex << std::setw(4) << std::setfill('0')
                 << static_cast<int>(character) << std::dec << std::setfill(' ');
        } else {
          output << static_cast<char>(character);
        }
    }
  }
  output << '"';
  return output.str();
}

template <typename T>
std::string jsonStringifyNative(const T& value, std::unordered_set<const void*>& seen) {
  using Native = std::remove_cvref_t<T>;
  if constexpr (std::is_same_v<Native, Value>) {
    if (value.isUndefined()) return "null";
    if (value.isNull()) return "null";
    if (value.isBoolean()) return value.boolean() ? "true" : "false";
    if (value.isNumber()) return numberToString(value.number());
    if (value.isBigInt()) throw std::runtime_error("Do not know how to serialize a BigInt");
    if (value.isString()) return jsonQuoted(value.string());
    if (value.isRecord()) {
      auto* record = value.record();
      if (!seen.insert(record).second) throw std::runtime_error("Converting circular structure to JSON");
      std::ostringstream output;
      output << '{';
      bool first = true;
      for (const auto& key : record->keys()) {
        const Value property = record->get(key);
        if (property.isUndefined() || (property.isDynamicObject() && property.dynamicObject()->dynamicToString() == "function")) {
          continue;
        }
        if (!first) output << ',';
        first = false;
        output << jsonQuoted(key) << ':' << jsonStringifyNative(property, seen);
      }
      output << '}';
      seen.erase(record);
      return output.str();
    }
    auto serialized = value.dynamicObject()->dynamicJsonStringify(seen);
    return serialized.value_or("{}");
  } else if constexpr (std::is_same_v<Native, std::string>) {
    return jsonQuoted(value);
  } else if constexpr (std::is_same_v<Native, BigInt>) {
    throw std::runtime_error("Do not know how to serialize a BigInt");
  } else if constexpr (std::is_same_v<Native, bool>) {
    return value ? "true" : "false";
  } else if constexpr (std::is_arithmetic_v<Native>) {
    return numberToString(static_cast<double>(value));
  } else if constexpr (std::is_pointer_v<Native>) {
    if (!value) return "null";
    if constexpr (std::is_base_of_v<DynamicValueObject, std::remove_pointer_t<Native>>) {
      return value->dynamicJsonStringify(seen).value_or("{}");
    } else {
      return "{}";
    }
  } else {
    return "{}";
  }
}

inline Value jsonStringify(Runtime& runtime, const Value& value) {
  if (value.isUndefined() || (value.isDynamicObject() && value.dynamicObject()->dynamicToString() == "function")) {
    return Value::undefined();
  }
  std::unordered_set<const void*> seen;
  return runtime.string(jsonStringifyNative(value, seen));
}

class JsonParser final {
 public:
  JsonParser(Runtime& runtime, std::string_view source) : runtime_(runtime), source_(source) {}

  Value parse() {
    Value result = parseValue();
    skipWhitespace();
    if (position_ != source_.size()) fail("unexpected trailing input");
    return result;
  }

 private:
  [[noreturn]] void fail(const std::string& message) const {
    throw std::runtime_error("Invalid JSON at offset " + std::to_string(position_) + ": " + message);
  }

  void skipWhitespace() {
    while (position_ < source_.size() && std::isspace(static_cast<unsigned char>(source_[position_]))) ++position_;
  }

  bool consume(std::string_view text) {
    if (source_.substr(position_, text.size()) != text) return false;
    position_ += text.size();
    return true;
  }

  std::uint32_t parseHexCodeUnit() {
    if (position_ + 4 > source_.size()) fail("incomplete unicode escape");
    std::uint32_t value = 0;
    for (int index = 0; index < 4; ++index) {
      const char character = source_[position_++];
      const int digit = character >= '0' && character <= '9' ? character - '0'
          : character >= 'a' && character <= 'f' ? character - 'a' + 10
          : character >= 'A' && character <= 'F' ? character - 'A' + 10
          : -1;
      if (digit < 0) fail("invalid unicode escape");
      value = (value << 4U) | static_cast<std::uint32_t>(digit);
    }
    return value;
  }

  void appendUtf8(std::string& result, std::uint32_t codePoint) {
    if (codePoint <= 0x7f) result.push_back(static_cast<char>(codePoint));
    else if (codePoint <= 0x7ff) {
      result.push_back(static_cast<char>(0xc0 | (codePoint >> 6U)));
      result.push_back(static_cast<char>(0x80 | (codePoint & 0x3f)));
    } else if (codePoint <= 0xffff) {
      result.push_back(static_cast<char>(0xe0 | (codePoint >> 12U)));
      result.push_back(static_cast<char>(0x80 | ((codePoint >> 6U) & 0x3f)));
      result.push_back(static_cast<char>(0x80 | (codePoint & 0x3f)));
    } else {
      result.push_back(static_cast<char>(0xf0 | (codePoint >> 18U)));
      result.push_back(static_cast<char>(0x80 | ((codePoint >> 12U) & 0x3f)));
      result.push_back(static_cast<char>(0x80 | ((codePoint >> 6U) & 0x3f)));
      result.push_back(static_cast<char>(0x80 | (codePoint & 0x3f)));
    }
  }

  Value parseValue() {
    skipWhitespace();
    if (position_ >= source_.size()) fail("expected a value");
    const char next = source_[position_];
    if (next == '"') return runtime_.string(parseString());
    if (next == '{') return Value(parseObject());
    if (next == '[') return Value(parseArray());
    if (consume("true")) return Value(true);
    if (consume("false")) return Value(false);
    if (consume("null")) return Value::null();
    return Value(parseNumber());
  }

  std::string parseString() {
    if (source_[position_++] != '"') fail("expected a string");
    std::string result;
    while (position_ < source_.size()) {
      const char character = source_[position_++];
      if (character == '"') return result;
      if (character != '\\') {
        if (static_cast<unsigned char>(character) < 0x20) fail("unescaped control character");
        result.push_back(character);
        continue;
      }
      if (position_ >= source_.size()) fail("unterminated escape");
      const char escaped = source_[position_++];
      switch (escaped) {
        case '"': result.push_back('"'); break;
        case '\\': result.push_back('\\'); break;
        case '/': result.push_back('/'); break;
        case 'b': result.push_back('\b'); break;
        case 'f': result.push_back('\f'); break;
        case 'n': result.push_back('\n'); break;
        case 'r': result.push_back('\r'); break;
        case 't': result.push_back('\t'); break;
        case 'u': {
          std::uint32_t codePoint = parseHexCodeUnit();
          if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
            if (position_ + 2 > source_.size() || source_[position_] != '\\' || source_[position_ + 1] != 'u') {
              fail("missing low surrogate");
            }
            position_ += 2;
            const std::uint32_t low = parseHexCodeUnit();
            if (low < 0xdc00 || low > 0xdfff) fail("invalid low surrogate");
            codePoint = 0x10000 + ((codePoint - 0xd800) << 10U) + (low - 0xdc00);
          } else if (codePoint >= 0xdc00 && codePoint <= 0xdfff) {
            fail("unexpected low surrogate");
          }
          appendUtf8(result, codePoint);
          break;
        }
        default: fail("unsupported escape sequence");
      }
    }
    fail("unterminated string");
  }

  double parseNumber() {
    const std::size_t start = position_;
    if (source_[position_] == '-') ++position_;
    if (position_ >= source_.size()) fail("invalid number");
    if (source_[position_] == '0') {
      ++position_;
    } else {
      if (!std::isdigit(static_cast<unsigned char>(source_[position_]))) fail("invalid number");
      while (position_ < source_.size() && std::isdigit(static_cast<unsigned char>(source_[position_]))) ++position_;
    }
    if (position_ < source_.size() && source_[position_] == '.') {
      ++position_;
      if (position_ >= source_.size() || !std::isdigit(static_cast<unsigned char>(source_[position_]))) fail("invalid fraction");
      while (position_ < source_.size() && std::isdigit(static_cast<unsigned char>(source_[position_]))) ++position_;
    }
    if (position_ < source_.size() && (source_[position_] == 'e' || source_[position_] == 'E')) {
      ++position_;
      if (position_ < source_.size() && (source_[position_] == '+' || source_[position_] == '-')) ++position_;
      if (position_ >= source_.size() || !std::isdigit(static_cast<unsigned char>(source_[position_]))) fail("invalid exponent");
      while (position_ < source_.size() && std::isdigit(static_cast<unsigned char>(source_[position_]))) ++position_;
    }
    return std::stod(std::string(source_.substr(start, position_ - start)));
  }

  ArrayObject<Value>* parseArray() {
    ++position_;
    auto* result = runtime_.array<Value>();
    skipWhitespace();
    if (position_ < source_.size() && source_[position_] == ']') { ++position_; return result; }
    while (true) {
      result->append(parseValue());
      skipWhitespace();
      if (position_ >= source_.size()) fail("unterminated array");
      if (source_[position_] == ']') { ++position_; return result; }
      if (source_[position_++] != ',') fail("expected ',' in array");
    }
  }

  RecordObject* parseObject() {
    ++position_;
    auto* result = runtime_.record();
    skipWhitespace();
    if (position_ < source_.size() && source_[position_] == '}') { ++position_; return result; }
    while (true) {
      skipWhitespace();
      if (position_ >= source_.size() || source_[position_] != '"') fail("expected an object key");
      const std::string key = parseString();
      skipWhitespace();
      if (position_ >= source_.size() || source_[position_++] != ':') fail("expected ':' after object key");
      result->set(key, parseValue());
      skipWhitespace();
      if (position_ >= source_.size()) fail("unterminated object");
      if (source_[position_] == '}') { ++position_; return result; }
      if (source_[position_++] != ',') fail("expected ',' in object");
    }
  }

  Runtime& runtime_;
  std::string_view source_;
  std::size_t position_ = 0;
};

inline Value jsonParse(Runtime& runtime, const Value& source) {
  if (!source.isString()) throw std::runtime_error("JSON.parse expects a string");
  return JsonParser(runtime, source.string()).parse();
}

inline bool includes(const std::vector<std::string>& array, const Value& value) {
  return includes(array, toString(value));
}

inline bool includes(const ArrayObject<std::string>* array, const Value& value) {
  return includes(array, toString(value));
}

inline double indexOf(const std::vector<std::string>& array, const Value& value) {
  return indexOf(array, toString(value));
}

inline double indexOf(const ArrayObject<std::string>* array, const Value& value) {
  return indexOf(array, toString(value));
}

template <typename... Values>
inline double push(std::vector<std::string>& array, Values&&... values) {
  (array.push_back(toString(std::forward<Values>(values))), ...);
  return static_cast<double>(array.size());
}

template <typename... Values>
inline double push(ArrayObject<std::string>* array, Values&&... values) {
  (array->append(toString(std::forward<Values>(values))), ...);
  return static_cast<double>(array->size());
}

inline double valueOf(double value) { return value; }
inline bool valueOf(bool value) { return value; }
inline const Value& valueOf(const Value& value) { return value; }

inline std::string toFixed(double value, int digits = 0) {
  std::ostringstream output;
  output << std::fixed << std::setprecision(std::clamp(digits, 0, 100)) << value;
  return output.str();
}

inline std::string toUpperCase(std::string value) {
  std::transform(value.begin(), value.end(), value.begin(), [](unsigned char character) {
    return static_cast<char>(std::toupper(character));
  });
  return value;
}
inline Text toUpperCase(Text value) {
  auto codeUnits = value.utf16();
  std::transform(codeUnits.begin(), codeUnits.end(), codeUnits.begin(), [](char16_t character) {
    return character <= 0x7f
      ? static_cast<char16_t>(std::toupper(static_cast<unsigned char>(character)))
      : character;
  });
  return Text(std::move(codeUnits));
}
inline Text toUpperCase(const Value& value) { return toUpperCase(Text(value)); }

inline std::string toLowerCase(std::string value) {
  std::transform(value.begin(), value.end(), value.begin(), [](unsigned char character) {
    return static_cast<char>(std::tolower(character));
  });
  return value;
}
inline Text toLowerCase(Text value) {
  auto codeUnits = value.utf16();
  std::transform(codeUnits.begin(), codeUnits.end(), codeUnits.begin(), [](char16_t character) {
    return character <= 0x7f
      ? static_cast<char16_t>(std::tolower(static_cast<unsigned char>(character)))
      : character;
  });
  return Text(std::move(codeUnits));
}
inline Text toLowerCase(const Value& value) { return toLowerCase(Text(value)); }

inline std::string trim(std::string value) {
  const auto isSpace = [](unsigned char character) { return std::isspace(character) != 0; };
  value.erase(value.begin(), std::find_if_not(value.begin(), value.end(), isSpace));
  value.erase(std::find_if_not(value.rbegin(), value.rend(), isSpace).base(), value.end());
  return value;
}
inline Text trim(Text value) {
  auto codeUnits = value.utf16();
  const auto isSpace = [](char16_t character) {
    return character == u' ' || character == u'\t' || character == u'\n' ||
      character == u'\r' || character == u'\f' || character == u'\v';
  };
  codeUnits.erase(codeUnits.begin(), std::find_if_not(codeUnits.begin(), codeUnits.end(), isSpace));
  codeUnits.erase(std::find_if_not(codeUnits.rbegin(), codeUnits.rend(), isSpace).base(), codeUnits.end());
  return Text(std::move(codeUnits));
}
inline Text trim(const Value& value) { return trim(Text(value)); }

inline std::string trimStart(std::string value) {
  const auto isSpace = [](unsigned char character) { return std::isspace(character) != 0; };
  value.erase(value.begin(), std::find_if_not(value.begin(), value.end(), isSpace));
  return value;
}
inline Text trimStart(Text value) {
  auto codeUnits = value.utf16();
  const auto isSpace = [](char16_t character) {
    return character == u' ' || character == u'\t' || character == u'\n' ||
      character == u'\r' || character == u'\f' || character == u'\v';
  };
  codeUnits.erase(codeUnits.begin(), std::find_if_not(codeUnits.begin(), codeUnits.end(), isSpace));
  return Text(std::move(codeUnits));
}
inline Text trimStart(const Value& value) { return trimStart(Text(value)); }

inline std::string trimEnd(std::string value) {
  const auto isSpace = [](unsigned char character) { return std::isspace(character) != 0; };
  value.erase(std::find_if_not(value.rbegin(), value.rend(), isSpace).base(), value.end());
  return value;
}
inline Text trimEnd(Text value) {
  auto codeUnits = value.utf16();
  const auto isSpace = [](char16_t character) {
    return character == u' ' || character == u'\t' || character == u'\n' ||
      character == u'\r' || character == u'\f' || character == u'\v';
  };
  codeUnits.erase(std::find_if_not(codeUnits.rbegin(), codeUnits.rend(), isSpace).base(), codeUnits.end());
  return Text(std::move(codeUnits));
}
inline Text trimEnd(const Value& value) { return trimEnd(Text(value)); }

inline bool stringIncludes(const std::string& value, const std::string& search, double position = 0) {
  const auto valueCodeUnits = utf8ToUtf16(value);
  const auto searchCodeUnits = utf8ToUtf16(search);
  return valueCodeUnits.find(searchCodeUnits, normalizedSliceIndex(position, valueCodeUnits.size())) != std::u16string::npos;
}
inline bool stringIncludes(const Text& value, const Text& search, double position = 0) {
  return value.utf16().find(search.utf16(), normalizedSliceIndex(position, value.size())) != std::u16string::npos;
}
inline bool stringIncludes(const std::string& value, const Value& search, double position = 0) {
  return stringIncludes(value, toString(search), position);
}
inline bool stringIncludes(const Value& value, const std::string& search, double position = 0) {
  return stringIncludes(toString(value), search, position);
}
inline bool stringIncludes(const Value& value, const Value& search, double position = 0) {
  return stringIncludes(toString(value), toString(search), position);
}

template <typename ValueLike, typename SearchLike>
double stringIndexOf(const ValueLike& valueLike, const SearchLike& searchLike, double position = 0) {
  const std::u16string value = utf8ToUtf16(toString(valueLike));
  const std::u16string search = utf8ToUtf16(toString(searchLike));
  const auto found = value.find(search, normalizedSliceIndex(position, value.size()));
  return found == std::u16string::npos ? -1.0 : static_cast<double>(found);
}
inline double stringIndexOf(const Text& value, const Text& search, double position = 0) {
  const auto found = value.utf16().find(search.utf16(), normalizedSliceIndex(position, value.size()));
  return found == std::u16string::npos ? -1.0 : static_cast<double>(found);
}

template <typename ValueLike, typename SearchLike>
double stringLastIndexOf(const ValueLike& valueLike, const SearchLike& searchLike,
                         double position = std::numeric_limits<double>::infinity()) {
  const std::u16string value = utf8ToUtf16(toString(valueLike));
  const std::u16string search = utf8ToUtf16(toString(searchLike));
  const std::size_t start = std::isfinite(position)
      ? std::min(value.size(), static_cast<std::size_t>(std::max(0.0, std::floor(position))))
      : value.size();
  const auto found = value.rfind(search, start);
  return found == std::u16string::npos ? -1.0 : static_cast<double>(found);
}
inline double stringLastIndexOf(const Text& value, const Text& search,
                                double position = std::numeric_limits<double>::infinity()) {
  const std::size_t start = std::isfinite(position)
      ? std::min(value.size(), static_cast<std::size_t>(std::max(0.0, std::floor(position))))
      : value.size();
  const auto found = value.utf16().rfind(search.utf16(), start);
  return found == std::u16string::npos ? -1.0 : static_cast<double>(found);
}

inline bool startsWith(const std::string& value, const std::string& search, double position = 0) {
  const auto valueCodeUnits = utf8ToUtf16(value);
  const auto searchCodeUnits = utf8ToUtf16(search);
  return valueCodeUnits.compare(normalizedSliceIndex(position, valueCodeUnits.size()), searchCodeUnits.size(), searchCodeUnits) == 0;
}
inline bool startsWith(const Text& value, const Text& search, double position = 0) {
  return value.utf16().compare(normalizedSliceIndex(position, value.size()), search.size(), search.utf16()) == 0;
}
inline bool startsWith(const std::string& value, const Text& search, double position = 0) {
  return startsWith(Text(value), search, position);
}
inline bool startsWith(const Value& value, const Text& search, double position = 0) {
  return value.isString()
    ? startsWith(Text(value), search, position)
    : startsWith(Text(toString(value)), search, position);
}
inline bool startsWith(const Text& value, const Value& search, double position = 0) {
  return search.isString()
    ? startsWith(value, Text(search), position)
    : startsWith(value, Text(toString(search)), position);
}
inline bool startsWith(const Value& value, const Value& search, double position = 0) {
  return startsWith(toString(value), toString(search), position);
}
inline bool startsWith(const std::string& value, const Value& search, double position = 0) {
  return startsWith(value, toString(search), position);
}
inline bool startsWith(const Value& value, const std::string& search, double position = 0) {
  return startsWith(toString(value), search, position);
}

inline bool endsWith(const std::string& value, const std::string& search) {
  const auto valueCodeUnits = utf8ToUtf16(value);
  const auto searchCodeUnits = utf8ToUtf16(search);
  return searchCodeUnits.size() <= valueCodeUnits.size() &&
    valueCodeUnits.compare(valueCodeUnits.size() - searchCodeUnits.size(), searchCodeUnits.size(), searchCodeUnits) == 0;
}
inline bool endsWith(const Text& value, const Text& search) {
  return search.size() <= value.size() &&
    value.utf16().compare(value.size() - search.size(), search.size(), search.utf16()) == 0;
}
inline bool endsWith(const std::string& value, const Text& search) {
  return endsWith(Text(value), search);
}
inline bool endsWith(const Value& value, const Text& search) {
  return value.isString()
    ? endsWith(Text(value), search)
    : endsWith(Text(toString(value)), search);
}
inline bool endsWith(const Text& value, const Value& search) {
  return search.isString()
    ? endsWith(value, Text(search))
    : endsWith(value, Text(toString(search)));
}
inline bool endsWith(const Value& value, const Value& search) {
  return endsWith(toString(value), toString(search));
}
inline bool endsWith(const std::string& value, const Value& search) {
  return endsWith(value, toString(search));
}
inline bool endsWith(const Value& value, const std::string& search) {
  return endsWith(toString(value), search);
}

inline std::string charAt(const std::string& value, double index = 0) {
  const auto codeUnits = utf8ToUtf16(value);
  const auto position = static_cast<std::int64_t>(index);
  return position >= 0 && static_cast<std::size_t>(position) < codeUnits.size()
      ? utf16ToUtf8(codeUnits.substr(static_cast<std::size_t>(position), 1))
      : "";
}
inline Text charAt(const Value& value, double index = 0) {
  if (!value.isString()) return charAt(Text(value), index);
  const auto position = static_cast<std::int64_t>(index);
  return position >= 0 && static_cast<std::size_t>(position) < value.utf16().size()
    ? Text(value.utf16().substr(static_cast<std::size_t>(position), 1))
    : Text();
}

inline Text charAt(const Text& value, double index = 0) {
  const auto position = static_cast<std::int64_t>(std::trunc(index));
  return position >= 0 && static_cast<std::size_t>(position) < value.size()
    ? Text(std::u16string(1, value[static_cast<std::size_t>(position)]))
    : Text();
}

inline Text stringIndex(const Text& value, double index) {
  const auto position = static_cast<std::int64_t>(std::trunc(index));
  return position >= 0 && static_cast<std::size_t>(position) < value.size()
    ? Text(std::u16string(1, value[static_cast<std::size_t>(position)]))
    : Text();
}

inline double charCodeAt(const std::string& value, double index = 0) {
  const auto codeUnits = utf8ToUtf16(value);
  const auto position = static_cast<std::int64_t>(std::trunc(index));
  if (position < 0 || static_cast<std::size_t>(position) >= codeUnits.size()) {
    return std::numeric_limits<double>::quiet_NaN();
  }
  return static_cast<std::uint16_t>(codeUnits[static_cast<std::size_t>(position)]);
}

inline double charCodeAt(const Value& value, double index = 0) {
  if (!value.isString()) return charCodeAt(toString(value), index);
  const auto position = static_cast<std::int64_t>(std::trunc(index));
  if (position < 0 || static_cast<std::size_t>(position) >= value.utf16().size()) {
    return std::numeric_limits<double>::quiet_NaN();
  }
  return static_cast<std::uint16_t>(value.utf16()[static_cast<std::size_t>(position)]);
}

inline double charCodeAt(const Text& value, double index = 0) {
  const auto position = static_cast<std::int64_t>(std::trunc(index));
  if (position < 0 || static_cast<std::size_t>(position) >= value.size()) {
    return std::numeric_limits<double>::quiet_NaN();
  }
  return static_cast<std::uint16_t>(value[static_cast<std::size_t>(position)]);
}

template <typename T>
inline bool numberIsNaN(const T& value) {
  return std::isnan(Number(value));
}

inline Text stringFromCharCode(double value) {
  const auto codeUnit = static_cast<std::uint32_t>(static_cast<std::uint16_t>(static_cast<std::uint32_t>(value)));
  return Text(std::u16string(1, static_cast<char16_t>(codeUnit)));
}

inline std::string stringRepeat(const std::string& value, double count) {
  const auto repetitions = std::max<std::int64_t>(0, static_cast<std::int64_t>(count));
  std::string result;
  result.reserve(value.size() * static_cast<std::size_t>(repetitions));
  for (std::int64_t index = 0; index < repetitions; ++index) result += value;
  return result;
}

inline Text stringRepeat(const Text& value, double count) {
  const auto repetitions = std::max<std::int64_t>(0, static_cast<std::int64_t>(count));
  std::u16string result;
  result.reserve(value.size() * static_cast<std::size_t>(repetitions));
  for (std::int64_t index = 0; index < repetitions; ++index) result += value.utf16();
  return Text(std::move(result));
}
inline Text stringRepeat(const Value& value, double count) {
  return stringRepeat(Text(value), count);
}

inline std::string substring(const std::string& value, double start, double end = std::numeric_limits<double>::infinity()) {
  const auto codeUnits = utf8ToUtf16(value);
  std::size_t first = normalizedSliceIndex(std::max(0.0, start), codeUnits.size());
  std::size_t last = std::isinf(end) ? codeUnits.size() : normalizedSliceIndex(std::max(0.0, end), codeUnits.size());
  if (first > last) std::swap(first, last);
  return utf16ToUtf8(codeUnits.substr(first, last - first));
}
inline Text substring(const Value& value, double start, double end = std::numeric_limits<double>::infinity()) {
  if (!value.isString()) return substring(Text(value), start, end);
  std::size_t first = normalizedSliceIndex(std::max(0.0, start), value.utf16().size());
  std::size_t last = std::isinf(end) ? value.utf16().size() : normalizedSliceIndex(std::max(0.0, end), value.utf16().size());
  if (first > last) std::swap(first, last);
  return Text(value.utf16().substr(first, last - first));
}
inline Text substring(const Text& value, double start, double end = std::numeric_limits<double>::infinity()) {
  std::size_t first = normalizedSliceIndex(std::max(0.0, start), value.size());
  std::size_t last = std::isinf(end) ? value.size() : normalizedSliceIndex(std::max(0.0, end), value.size());
  if (first > last) std::swap(first, last);
  return Text(value.utf16().substr(first, last - first));
}

inline std::string stringSlice(const std::string& value, double start, double end = std::numeric_limits<double>::infinity()) {
  const auto codeUnits = utf8ToUtf16(value);
  const std::size_t first = normalizedSliceIndex(start, codeUnits.size());
  const std::size_t last = std::isinf(end) ? codeUnits.size() : normalizedSliceIndex(end, codeUnits.size());
  return last <= first ? "" : utf16ToUtf8(codeUnits.substr(first, last - first));
}
inline Text stringSlice(const Value& value, double start, double end = std::numeric_limits<double>::infinity()) {
  if (!value.isString()) return stringSlice(Text(value), start, end);
  const std::size_t first = normalizedSliceIndex(start, value.utf16().size());
  const std::size_t last = std::isinf(end) ? value.utf16().size() : normalizedSliceIndex(end, value.utf16().size());
  return last <= first ? Text() : Text(value.utf16().substr(first, last - first));
}
inline Text stringSlice(const Text& value, double start, double end = std::numeric_limits<double>::infinity()) {
  const std::size_t first = normalizedSliceIndex(start, value.size());
  const std::size_t last = std::isinf(end) ? value.size() : normalizedSliceIndex(end, value.size());
  return last <= first ? Text() : Text(value.utf16().substr(first, last - first));
}

inline ArrayObject<Text>* split(Runtime& runtime, const Text& value, const Text& separator) {
  auto* result = runtime.array<Text>();
  if (separator.empty()) {
    for (char16_t character : value.utf16()) result->append(Text(std::u16string(1, character)));
    return result;
  }
  std::size_t start = 0;
  while (true) {
    const std::size_t next = value.utf16().find(separator.utf16(), start);
    if (next == std::u16string::npos) {
      result->append(Text(value.utf16().substr(start)));
      return result;
    }
    result->append(Text(value.utf16().substr(start, next - start)));
    start = next + separator.size();
  }
}

inline ArrayObject<std::string>* split(Runtime& runtime, const std::string& value, const std::string& separator) {
  auto* result = runtime.array<std::string>();
  if (separator.empty()) {
    for (char character : value) result->append(std::string(1, character));
    return result;
  }
  std::size_t start = 0;
  while (true) {
    const std::size_t next = value.find(separator, start);
    if (next == std::string::npos) {
      result->append(value.substr(start));
      return result;
    }
    result->append(value.substr(start, next - start));
    start = next + separator.size();
  }
}
inline ArrayObject<std::string>* split(Runtime& runtime, const Value& value, const Value& separator) {
  return split(runtime, toString(value), toString(separator));
}
inline ArrayObject<std::string>* split(Runtime& runtime, const std::string& value, const Value& separator) {
  return split(runtime, value, toString(separator));
}
inline ArrayObject<std::string>* split(Runtime& runtime, const Value& value, const std::string& separator) {
  return split(runtime, toString(value), separator);
}

inline ArrayObject<std::string>* split(Runtime& runtime, const Value& value, const RegExp& separator) {
  auto* result = runtime.array<std::string>();
  for (const auto& part : separator.split(toString(value))) result->append(part);
  return result;
}

inline ArrayObject<std::string>* split(Runtime& runtime, const std::string& value, const RegExp& separator) {
  auto* result = runtime.array<std::string>();
  for (const auto& part : separator.split(value)) result->append(part);
  return result;
}

inline double Number(double value) { return value; }
inline double Number(bool value) { return value ? 1 : 0; }
inline double Number(int value) { return static_cast<double>(value); }
inline double Number(std::int64_t value) { return static_cast<double>(value); }
inline double Number(const BigInt& value) { return value.toDouble(); }
inline double Number(const std::string& value) {
  try { return std::stod(value); } catch (...) { return std::numeric_limits<double>::quiet_NaN(); }
}
inline double numberFromString(const std::string& value) {
  const auto first = value.find_first_not_of(" \t\n\r\f\v");
  if (first == std::string::npos) return 0;
  const auto last = value.find_last_not_of(" \t\n\r\f\v");
  const std::string trimmed = value.substr(first, last - first + 1);
  try {
    std::size_t consumed = 0;
    const double result = std::stod(trimmed, &consumed);
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

inline bool looseEqualsString(const std::string& text, const Value& value) {
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
  const bool leftObject = left.isRecord() || left.isDynamicObject();
  const bool rightObject = right.isRecord() || right.isDynamicObject();
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
      throw std::runtime_error("Cannot mix bigint and number arithmetic");
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
inline Text String(const T& value) {
  return Text(toString(value));
}

inline bool Boolean(bool value) { return value; }
inline bool Boolean(double value) { return value != 0 && !std::isnan(value); }
inline bool Boolean(const std::string& value) { return !value.empty(); }
inline bool Boolean(const Text& value) { return !value.empty(); }
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
      public DynamicValueObject {
 public:
  DynamicArrayMethodObject(ArrayObject<T>* array, PropertyKey method)
      : array_(array), method_(std::move(method)) {}

  const void* dynamicTypeToken() const override {
    return nativeTypeToken<DynamicArrayMethodObject<T>>();
  }
  void* dynamicCast(const void* type) override {
    return type == nativeTypeToken<DynamicArrayMethodObject<T>>() ? this : nullptr;
  }
  std::string dynamicToString() const override { return "function"; }
  void Trace(cppgc::Visitor* visitor) const final {
    DynamicValueObject::Trace(visitor);
    visitor->Trace(array_);
  }

  Value dynamicCall(Runtime& runtime, const std::vector<Value>& arguments) override {
    if (!array_) throw runtime.errorAtCurrentSource("Cannot call an array method on null");
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
        return Value(static_cast<DynamicValueObject*>(array_.Get()));
      }
      if (method_ == u"at") {
        const double index = arguments.empty() ? 0 : Number(arguments[0]);
        return convertValue<Value>(array_->at(index));
      }
      if (method_ == u"includes" || method_ == u"indexOf" || method_ == u"lastIndexOf") {
        const Value searched = arguments.empty() ? Value::undefined() : arguments[0];
        double found = -1;
        for (std::size_t index = 0; index < array_->size(); ++index) {
          if (!strictEquals(array_->dynamicArrayGet(runtime, index), searched)) continue;
          found = static_cast<double>(index);
          if (method_ != u"lastIndexOf") break;
        }
        return method_ == u"includes" ? Value(found >= 0) : Value(found);
      }
      if (method_ == u"join") {
        const std::string separator = arguments.empty() ? "," : toString(arguments[0]);
        return Value(runtime.string(array_->join(separator)));
      }
      if (method_ == u"slice") {
        const double start = arguments.empty() ? 0 : Number(arguments[0]);
        const double end = arguments.size() < 2
          ? std::numeric_limits<double>::infinity()
          : Number(arguments[1]);
        return Value(static_cast<DynamicValueObject*>(array_->slice(runtime, start, end)));
      }
    }
    if (arguments.empty()) {
      throw runtime.errorAtCurrentSource("Dynamic array callback method requires a callback");
    }
    const Value callback = arguments[0];
    const auto invoke = [&](std::size_t index, const Value* accumulator = nullptr) {
      const Value element = array_->dynamicArrayGet(runtime, index);
      std::vector<Value> callbackArguments;
      if (accumulator) callbackArguments.push_back(*accumulator);
      callbackArguments.push_back(element);
      callbackArguments.push_back(Value(static_cast<double>(index)));
      callbackArguments.push_back(Value(static_cast<DynamicValueObject*>(array_.Get())));
      return call(runtime, callback, std::move(callbackArguments));
    };

    if (method_ == u"map") {
      auto* result = runtime.array<Value>();
      for (std::size_t index = 0; index < array_->size(); ++index) result->append(invoke(index));
      return Value(static_cast<DynamicValueObject*>(result));
    }
    if (method_ == u"filter") {
      auto* result = runtime.array<Value>();
      for (std::size_t index = 0; index < array_->size(); ++index) {
        if (Boolean(invoke(index))) result->append(array_->dynamicArrayGet(runtime, index));
      }
      return Value(static_cast<DynamicValueObject*>(result));
    }
    if (method_ == u"flatMap") {
      auto* result = runtime.array<Value>();
      for (std::size_t index = 0; index < array_->size(); ++index) {
        const Value mapped = invoke(index);
        if (mapped.isDynamicObject() && mapped.dynamicObject()->dynamicIsArray()) {
          auto* nested = mapped.dynamicObject();
          for (std::size_t nestedIndex = 0; nestedIndex < nested->dynamicArraySize(); ++nestedIndex) {
            result->append(nested->dynamicArrayGet(runtime, nestedIndex));
          }
        } else {
          result->append(mapped);
        }
      }
      return Value(static_cast<DynamicValueObject*>(result));
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
        if (Boolean(invoke(index))) return array_->dynamicArrayGet(runtime, index);
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
          throw runtime.errorAtCurrentSource("Reduce of empty array with no initial value");
        }
        accumulator = array_->dynamicArrayGet(runtime, index++);
      }
      for (; index < array_->size(); ++index) accumulator = invoke(index, &accumulator);
      return accumulator;
    }
    throw runtime.errorAtCurrentSource("Unsupported dynamic array method");
  }

 private:
  cppgc::Member<ArrayObject<T>> array_;
  PropertyKey method_;
};

template <typename T>
inline Value ArrayObject<T>::dynamicGet(const PropertyKey& key) {
  auto& runtime = currentRuntime();
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
    return Value(static_cast<DynamicValueObject*>(
      runtime.make<DynamicArrayMethodObject<T>>(this, key)
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
    return DynamicValueObject::dynamicGet(key);
  } else {
    throw runtime.errorAtCurrentSource(
      std::string("This native array element type cannot flow through dynamic access: ") +
      __PRETTY_FUNCTION__
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
inline Value add(Runtime& runtime, Left&& leftInput, Right&& rightInput) {
  const Value left = convertValue<Value>(std::forward<Left>(leftInput));
  const Value right = convertValue<Value>(std::forward<Right>(rightInput));
  if (const auto result = callDynamicOperator(runtime, left, u"__vexa_operator:+", right)) {
    return *result;
  }
  if (left.isString() || right.isString()) {
    const Value leftText = left.isString() ? left : runtime.string(toString(left));
    const Value rightText = right.isString() ? right : runtime.string(toString(right));
    return runtime.concatStrings(leftText.stringObject(), rightText.stringObject());
  }
  if (left.isBigInt() || right.isBigInt()) {
    if (!left.isBigInt() || !right.isBigInt()) {
      throw std::runtime_error("Cannot mix bigint and number arithmetic");
    }
    return Value(left.bigint() + right.bigint());
  }
  return Value(Number(left) + Number(right));
}

template <typename Right>
inline Value& addAssign(Runtime& runtime, Value& left, Right&& right) {
  left = add(runtime, left, std::forward<Right>(right));
  return left;
}

inline void requireMatchingBigInts(const Value& left, const Value& right) {
  if ((left.isBigInt() || right.isBigInt()) && (!left.isBigInt() || !right.isBigInt())) {
    throw std::runtime_error("Cannot mix bigint and number arithmetic");
  }
}

inline Value subtract(const Value& left, const Value& right) {
  if (const auto result = callDynamicOperator(currentRuntime(), left, u"__vexa_operator:-", right)) {
    return *result;
  }
  requireMatchingBigInts(left, right);
  return left.isBigInt()
      ? Value(left.bigint() - right.bigint())
      : Value(Number(left) - Number(right));
}

inline Value multiply(const Value& left, const Value& right) {
  if (const auto result = callDynamicOperator(currentRuntime(), left, u"__vexa_operator:*", right)) {
    return *result;
  }
  requireMatchingBigInts(left, right);
  return left.isBigInt()
      ? Value(left.bigint() * right.bigint())
      : Value(Number(left) * Number(right));
}

inline Value divide(const Value& left, const Value& right) {
  if (const auto result = callDynamicOperator(currentRuntime(), left, u"__vexa_operator:/", right)) {
    return *result;
  }
  requireMatchingBigInts(left, right);
  return left.isBigInt()
      ? Value(left.bigint() / right.bigint())
      : Value(Number(left) / Number(right));
}

inline Value power(const Value& left, const Value& right) {
  if (const auto result = callDynamicOperator(currentRuntime(), left, u"__vexa_operator:**", right)) {
    return *result;
  }
  requireMatchingBigInts(left, right);
  return left.isBigInt()
      ? Value(vexa::pow(left.bigint(), right.bigint()))
      : Value(std::pow(Number(left), Number(right)));
}

inline Value negate(const Value& value) {
  if (const auto result = callDynamicOperator(currentRuntime(), value, u"__vexa_operator:-")) {
    return *result;
  }
  return value.isBigInt() ? Value(-value.bigint()) : Value(-Number(value));
}

inline std::int32_t toInt32(const Value& value) {
  return static_cast<std::int32_t>(static_cast<std::uint32_t>(static_cast<std::int64_t>(Number(value))));
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
    throw std::runtime_error("Unsigned right shift is not defined for bigint values");
  }
  const auto amount = static_cast<std::uint32_t>(toInt32(right)) & 31U;
  return Value(static_cast<double>(static_cast<std::uint32_t>(toInt32(left)) >> amount));
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
        currentRuntime(), left, u"__vexa_operator:<=>", right)) {
    return convertValue<std::int32_t>(*result);
  }
  if (left.isDynamicObject() && right.isDynamicObject()) {
    auto* leftDate = static_cast<DateObject*>(
      left.dynamicObject()->dynamicCast(nativeTypeToken<DateObject>()));
    auto* rightDate = static_cast<DateObject*>(
      right.dynamicObject()->dynamicCast(nativeTypeToken<DateObject>()));
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

inline double parseFloat(const std::string& value) {
  try {
    return std::stod(value);
  } catch (...) {
    return std::numeric_limits<double>::quiet_NaN();
  }
}

inline double parseFloat(const Value& value) { return parseFloat(toString(value)); }
inline double parseInt(const std::string& value, int radix = 10) {
  try {
    return static_cast<double>(std::stoll(value, nullptr, radix));
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
    (value.isDynamicObject() && value.dynamicObject()->dynamicCast(nativeTypeToken<Error>()) != nullptr);
}
template <typename T>
inline bool isErrorLike(T* value) {
  if constexpr (std::is_base_of_v<Error, T>) return value != nullptr;
  return value && value->dynamicCast(nativeTypeToken<Error>()) != nullptr;
}
inline Value encodeURIComponent(const std::string& value) {
  return Runtime::current().string(encodeUriComponentText(value));
}
inline Value encodeURIComponent(const Value& value) { return encodeURIComponent(toString(value)); }
inline Value decodeURIComponent(const std::string& value) {
  return Runtime::current().string(decodeUriComponentText(value));
}
inline Value decodeURIComponent(const Value& value) { return decodeURIComponent(toString(value)); }

inline std::string typeOf(const Value& value) {
  if (value.isUndefined()) return "undefined";
  if (value.isBoolean()) return "boolean";
  if (value.isNumber()) return "number";
  if (value.isBigInt()) return "bigint";
  if (value.isString()) return "string";
  if (value.isDynamicObject() && value.dynamicObject()->dynamicToString() == "function") return "function";
  return "object";
}
inline std::string typeOf(double) { return "number"; }
inline std::string typeOf(const BigInt&) { return "bigint"; }
inline std::string typeOf(bool) { return "boolean"; }
inline std::string typeOf(const std::string&) { return "string"; }

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
  static void print(std::ostream& output, const Value& value) { output << toString(value); }
  static void print(std::ostream& output, const std::string& value) { output << value; }
  static void print(std::ostream& output, const char* value) { output << value; }
  static void print(std::ostream& output, bool value) { output << (value ? "true" : "false"); }
  static void print(std::ostream& output, double value) { output << numberToString(value); }
  static void print(std::ostream& output, float value) { output << numberToString(value); }

  template <typename T>
  static void print(std::ostream& output, ArrayObject<T>* values) {
    output << toString(values);
  }

  template <typename T>
  static void print(std::ostream& output, const cppgc::Member<ArrayObject<T>>& values) {
    output << toString(values);
  }

  template <typename T>
  static void print(std::ostream& output, const cppgc::Persistent<ArrayObject<T>>& values) {
    output << toString(values);
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

inline const Console console;

}  // namespace vexa
