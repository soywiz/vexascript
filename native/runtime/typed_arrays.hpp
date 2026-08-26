#pragma once

// Internal runtime category header. Include runtime.hpp instead.

class TypedArrayLikeObject : public BaseObject {};

enum class TypedArrayKind {
  Int8,
  Uint8,
  Uint8Clamped,
  Int16,
  Uint16,
  Int32,
  Uint32,
  Float16,
  Float32,
  Float64,
  BigInt64,
  BigUint64,
};

template <TypedArrayKind Kind>
struct TypedArrayTraits;

#define VEXA_NUMERIC_TYPED_ARRAY(kindName, storageType, displayName) \
  template <> struct TypedArrayTraits<TypedArrayKind::kindName> final { \
    using Storage = storageType; \
    using Value = double; \
    static constexpr std::u16string_view name = u##displayName; \
  }

VEXA_NUMERIC_TYPED_ARRAY(Int8, std::int8_t, "Int8Array");
VEXA_NUMERIC_TYPED_ARRAY(Uint8, std::uint8_t, "Uint8Array");
VEXA_NUMERIC_TYPED_ARRAY(Uint8Clamped, std::uint8_t, "Uint8ClampedArray");
VEXA_NUMERIC_TYPED_ARRAY(Int16, std::int16_t, "Int16Array");
VEXA_NUMERIC_TYPED_ARRAY(Uint16, std::uint16_t, "Uint16Array");
VEXA_NUMERIC_TYPED_ARRAY(Int32, std::int32_t, "Int32Array");
VEXA_NUMERIC_TYPED_ARRAY(Uint32, std::uint32_t, "Uint32Array");
VEXA_NUMERIC_TYPED_ARRAY(Float16, std::uint16_t, "Float16Array");
VEXA_NUMERIC_TYPED_ARRAY(Float32, float, "Float32Array");
VEXA_NUMERIC_TYPED_ARRAY(Float64, double, "Float64Array");
#undef VEXA_NUMERIC_TYPED_ARRAY

template <> struct TypedArrayTraits<TypedArrayKind::BigInt64> final {
  using Storage = std::int64_t;
  using Value = BigInt;
  static constexpr std::u16string_view name = u"BigInt64Array";
};

template <> struct TypedArrayTraits<TypedArrayKind::BigUint64> final {
  using Storage = std::uint64_t;
  using Value = BigInt;
  static constexpr std::u16string_view name = u"BigUint64Array";
};

template <typename Storage>
inline Storage typedArrayIntegerStorage(double value) {
  if (!std::isfinite(value) || value == 0) return 0;
  constexpr int bits = static_cast<int>(sizeof(Storage) * 8);
  const double modulus = std::ldexp(1.0, bits);
  double converted = std::fmod(std::trunc(value), modulus);
  if (converted < 0) converted += modulus;
  using Unsigned = std::make_unsigned_t<Storage>;
  const auto unsignedValue = static_cast<Unsigned>(converted);
  if constexpr (std::is_signed_v<Storage>) return std::bit_cast<Storage>(unsignedValue);
  else return unsignedValue;
}

std::uint8_t typedArrayClampedStorage(double value);

std::uint16_t float16Storage(double value);

double float16Value(std::uint16_t half);

template <TypedArrayKind Kind>
inline typename TypedArrayTraits<Kind>::Storage typedArrayStorage(
    const typename TypedArrayTraits<Kind>::Value& value) {
  using Traits = TypedArrayTraits<Kind>;
  using Storage = typename Traits::Storage;
  if constexpr (Kind == TypedArrayKind::Uint8Clamped) {
    return typedArrayClampedStorage(value);
  } else if constexpr (Kind == TypedArrayKind::Float16) {
    return float16Storage(value);
  } else if constexpr (Kind == TypedArrayKind::Float32 || Kind == TypedArrayKind::Float64) {
    return static_cast<Storage>(value);
  } else if constexpr (Kind == TypedArrayKind::BigInt64 || Kind == TypedArrayKind::BigUint64) {
    const std::uint64_t bits = value.toUint64Modulo();
    if constexpr (Kind == TypedArrayKind::BigInt64) return std::bit_cast<std::int64_t>(bits);
    else return bits;
  } else {
    return typedArrayIntegerStorage<Storage>(value);
  }
}

template <TypedArrayKind Kind>
inline typename TypedArrayTraits<Kind>::Value typedArrayValue(
    typename TypedArrayTraits<Kind>::Storage value) {
  if constexpr (Kind == TypedArrayKind::Float16) {
    return float16Value(value);
  } else if constexpr (Kind == TypedArrayKind::BigInt64) {
    return BigInt(static_cast<long long>(value));
  } else if constexpr (Kind == TypedArrayKind::BigUint64) {
    return BigInt(static_cast<unsigned long long>(value));
  } else {
    return static_cast<double>(value);
  }
}

bool typedArrayCallbackTruth(const Value& value);

bool typedArrayCallbackTruth(const std::u16string& value);

template <typename T>
inline bool typedArrayCallbackTruth(const T& value) {
  if constexpr (std::is_pointer_v<T>) return value != nullptr;
  else return static_cast<bool>(value);
}

template <TypedArrayKind ArrayKind>
class TypedArrayObject final
    : public cppgc::GarbageCollected<TypedArrayObject<ArrayKind>>, public TypedArrayLikeObject {
 public:
  using Traits = TypedArrayTraits<ArrayKind>;
  using Storage = typename Traits::Storage;
  using ValueType = typename Traits::Value;
  static constexpr std::size_t bytesPerElement = sizeof(Storage);

  TypedArrayObject(ArrayBufferObject* buffer, std::size_t byteOffset, std::size_t length)
      : buffer_(buffer), byte_offset_(byteOffset), length_(length) {
    const std::size_t available = buffer
      ? buffer->byteLength() - std::min(byteOffset, buffer->byteLength())
      : 0;
    if (!buffer || byteOffset % bytesPerElement != 0 || length > available / bytesPerElement) {
      throw std::out_of_range(utf16ToUtf8(std::u16string(Traits::name) + u" view is outside its ArrayBuffer"));
    }
  }

  std::size_t size() const { return length_; }
  std::size_t length() const { return length_; }
  std::size_t byteLength() const { return length_ * bytesPerElement; }
  std::size_t byteOffset() const { return byte_offset_; }
  ArrayBufferObject* buffer() const { return buffer_.Get(); }

  ValueType get(std::size_t index) const {
    if (index >= length_) throw std::out_of_range(utf16ToUtf8(std::u16string(Traits::name) + u" index is out of range"));
    Storage stored{};
    std::memcpy(&stored, buffer_->data() + byte_offset_ + index * bytesPerElement, bytesPerElement);
    return typedArrayValue<ArrayKind>(stored);
  }

  ValueType set(std::size_t index, ValueType value) {
    if (index >= length_) throw std::out_of_range(utf16ToUtf8(std::u16string(Traits::name) + u" index is out of range"));
    const Storage stored = typedArrayStorage<ArrayKind>(value);
    std::memcpy(buffer_->data() + byte_offset_ + index * bytesPerElement, &stored, bytesPerElement);
    return typedArrayValue<ArrayKind>(stored);
  }

  ValueType at(double index) const {
    const auto integer = static_cast<std::int64_t>(std::trunc(index));
    const auto resolved = integer < 0 ? static_cast<std::int64_t>(length_) + integer : integer;
    return resolved < 0 || resolved >= static_cast<std::int64_t>(length_)
      ? ValueType{}
      : get(static_cast<std::size_t>(resolved));
  }

  TypedArrayObject* copyWithin(
      double target,
      double start,
      double end = std::numeric_limits<double>::infinity()) {
    const std::size_t destination = normalizedIndex(target);
    const std::size_t first = normalizedIndex(start);
    const std::size_t last = std::isinf(end) ? length_ : normalizedIndex(end);
    std::vector<ValueType> copied;
    copied.reserve(last > first ? last - first : 0);
    for (std::size_t index = first; index < last; ++index) copied.push_back(get(index));
    for (std::size_t index = 0; index < copied.size() && destination + index < length_; ++index) {
      set(destination + index, copied[index]);
    }
    return this;
  }

  template <typename Callback>
  bool every(Callback callback) const {
    for (std::size_t index = 0; index < length_; ++index) {
      if (!typedArrayCallbackTruth(invokeCallback(callback, get(index), index))) return false;
    }
    return true;
  }

  TypedArrayObject* fill(
      ValueType value,
      double start = 0,
      double end = std::numeric_limits<double>::infinity()) {
    const std::size_t first = normalizedIndex(start);
    const std::size_t last = std::isinf(end) ? length_ : normalizedIndex(end);
    for (std::size_t index = first; index < last; ++index) set(index, value);
    return this;
  }

  template <typename Callback>
  TypedArrayObject* filter(Callback callback) const {
    std::vector<ValueType> selected;
    for (std::size_t index = 0; index < length_; ++index) {
      const auto value = get(index);
      if (typedArrayCallbackTruth(invokeCallback(callback, value, index))) selected.push_back(value);
    }
    auto* result = create(selected.size());
    for (std::size_t index = 0; index < selected.size(); ++index) result->set(index, selected[index]);
    return result;
  }

  template <typename Callback>
  ValueType find(Callback callback) const {
    for (std::size_t index = 0; index < length_; ++index) {
      const auto value = get(index);
      if (typedArrayCallbackTruth(invokeCallback(callback, value, index))) return value;
    }
    return ValueType{};
  }

  template <typename Callback>
  double findIndex(Callback callback) const {
    for (std::size_t index = 0; index < length_; ++index) {
      if (typedArrayCallbackTruth(invokeCallback(callback, get(index), index))) {
        return static_cast<double>(index);
      }
    }
    return -1;
  }

  template <typename Callback>
  ValueType findLast(Callback callback) const {
    for (std::size_t index = length_; index > 0; --index) {
      const auto value = get(index - 1);
      if (typedArrayCallbackTruth(invokeCallback(callback, value, index - 1))) return value;
    }
    return ValueType{};
  }

  template <typename Callback>
  double findLastIndex(Callback callback) const {
    for (std::size_t index = length_; index > 0; --index) {
      if (typedArrayCallbackTruth(invokeCallback(callback, get(index - 1), index - 1))) {
        return static_cast<double>(index - 1);
      }
    }
    return -1;
  }

  template <typename Callback>
  void forEach(Callback callback) const {
    for (std::size_t index = 0; index < length_; ++index) {
      invokeCallback(callback, get(index), index);
    }
  }

  template <typename U>
  bool includes(const U& value, double fromIndex = 0) const {
    for (std::size_t index = forwardIndex(fromIndex); index < length_; ++index) {
      if (sameValueZero(get(index), value)) return true;
    }
    return false;
  }

  template <typename U>
  double indexOf(const U& value, double fromIndex = 0) const {
    for (std::size_t index = forwardIndex(fromIndex); index < length_; ++index) {
      if (sameValueZero(get(index), value)) return static_cast<double>(index);
    }
    return -1;
  }

  template <typename U>
  double lastIndexOf(const U& value, double fromIndex = std::numeric_limits<double>::infinity()) const {
    std::size_t index = std::isinf(fromIndex) ? length_ : std::min(length_, forwardIndex(fromIndex) + 1);
    for (; index > 0; --index) if (sameValueZero(get(index - 1), value)) return static_cast<double>(index - 1);
    return -1;
  }

  std::u16string join(const std::u16string& separator = u",") const {
    std::u16string result;
    for (std::size_t index = 0; index < length_; ++index) {
      if (index > 0) result += separator;
      result += vexa::toString(convertValue<Value>(get(index)));
    }
    return result;
  }

  template <typename Callback>
  TypedArrayObject* map(Callback callback) const {
    auto* result = create(length_);
    for (std::size_t index = 0; index < length_; ++index) {
      result->set(index, invokeCallback(callback, get(index), index));
    }
    return result;
  }

  template <typename Callback, typename Accumulator>
  Accumulator reduce(Callback callback, Accumulator initial) const {
    for (std::size_t index = 0; index < length_; ++index) {
      initial = invokeReduceCallback(callback, std::move(initial), get(index), index);
    }
    return initial;
  }

  template <typename Callback>
  ValueType reduce(Callback callback) const {
    if (length_ == 0) throw runtimeError(u"Reduce of empty typed array with no initial value");
    ValueType result = get(0);
    for (std::size_t index = 1; index < length_; ++index) {
      result = invokeReduceCallback(callback, std::move(result), get(index), index);
    }
    return result;
  }

  template <typename Callback, typename Accumulator>
  Accumulator reduceRight(Callback callback, Accumulator initial) const {
    for (std::size_t index = length_; index > 0; --index) {
      resultAssign(initial, invokeReduceCallback(callback, std::move(initial), get(index - 1), index - 1));
    }
    return initial;
  }

  template <typename Callback>
  ValueType reduceRight(Callback callback) const {
    if (length_ == 0) throw runtimeError(u"Reduce of empty typed array with no initial value");
    ValueType result = get(length_ - 1);
    for (std::size_t index = length_ - 1; index > 0; --index) {
      result = invokeReduceCallback(callback, std::move(result), get(index - 1), index - 1);
    }
    return result;
  }

  TypedArrayObject* reverse() {
    for (std::size_t left = 0, right = length_; left < right && left < --right; ++left) {
      const auto value = get(left);
      set(left, get(right));
      set(right, value);
    }
    return this;
  }

  template <typename Source>
  void set(const Source* source, double offset = 0) {
    if (!source || !std::isfinite(offset) || offset < 0) throw runtimeError(u"Invalid typed-array set source or offset");
    const auto destination = static_cast<std::size_t>(std::trunc(offset));
    if (destination > length_ || source->size() > length_ - destination) {
      throw runtimeError(u"Typed-array set source is outside the destination");
    }
    std::vector<ValueType> copied;
    copied.reserve(source->size());
    for (std::size_t index = 0; index < source->size(); ++index) {
      copied.push_back(convertInput(source->get(index)));
    }
    for (std::size_t index = 0; index < copied.size(); ++index) set(destination + index, copied[index]);
  }

  TypedArrayObject* slice(
      double start = 0,
      double end = std::numeric_limits<double>::infinity()) const {
    const std::size_t first = normalizedIndex(start);
    const std::size_t last = std::isinf(end) ? length_ : normalizedIndex(end);
    auto* result = create(last > first ? last - first : 0);
    for (std::size_t index = first; index < last; ++index) result->set(index - first, get(index));
    return result;
  }

  template <typename Callback>
  bool some(Callback callback) const {
    for (std::size_t index = 0; index < length_; ++index) {
      if (typedArrayCallbackTruth(invokeCallback(callback, get(index), index))) return true;
    }
    return false;
  }

  TypedArrayObject* sort() {
    std::vector<ValueType> values;
    values.reserve(length_);
    for (std::size_t index = 0; index < length_; ++index) values.push_back(get(index));
    std::sort(values.begin(), values.end(), [](const auto& left, const auto& right) { return left < right; });
    for (std::size_t index = 0; index < length_; ++index) set(index, values[index]);
    return this;
  }

  template <typename Callback>
  TypedArrayObject* sort(Callback callback) {
    std::vector<ValueType> values;
    values.reserve(length_);
    for (std::size_t index = 0; index < length_; ++index) values.push_back(get(index));
    std::sort(values.begin(), values.end(), [&](const auto& left, const auto& right) {
      return callback(left, right) < 0;
    });
    for (std::size_t index = 0; index < length_; ++index) set(index, values[index]);
    return this;
  }

  TypedArrayObject* subarray(
      double begin = 0,
      double end = std::numeric_limits<double>::infinity()) const {
    const std::size_t first = normalizedIndex(begin);
    const std::size_t last = std::isinf(end) ? length_ : normalizedIndex(end);
    return makeManaged<TypedArrayObject>(
        buffer_.Get(), byte_offset_ + first * bytesPerElement, last > first ? last - first : 0);
  }

  std::u16string toLocaleString() const { return join(); }
  TypedArrayObject* toReversed() const { return slice()->reverse(); }
  TypedArrayObject* toSorted() const { return slice()->sort(); }
  template <typename Callback>
  TypedArrayObject* toSorted(Callback callback) const { return slice()->sort(std::move(callback)); }
  std::u16string toString() const { return join(); }
  TypedArrayObject* valueOf() { return this; }

  ArrayObject<ValueType>* values() const {
    auto* result = makeManaged<ArrayObject<ValueType>>();
    result->reserve(length_);
    for (std::size_t index = 0; index < length_; ++index) result->append(get(index));
    return result;
  }

  ArrayObject<double>* keys() const {
    auto* result = makeManaged<ArrayObject<double>>();
    result->reserve(length_);
    for (std::size_t index = 0; index < length_; ++index) result->append(static_cast<double>(index));
    return result;
  }

  ArrayObject<ArrayObject<Value>*>* entries() const {
    auto* result = makeManaged<ArrayObject<ArrayObject<Value>*>>();
    result->reserve(length_);
    for (std::size_t index = 0; index < length_; ++index) {
      auto* entry = makeManaged<ArrayObject<Value>>();
      entry->append(Value(static_cast<double>(index)));
      entry->append(convertValue<Value>(get(index)));
      result->append(entry);
    }
    return result;
  }

  TypedArrayObject* with(double index, ValueType value) const {
    const auto integer = static_cast<std::int64_t>(std::trunc(index));
    const auto resolved = integer < 0 ? static_cast<std::int64_t>(length_) + integer : integer;
    if (resolved < 0 || resolved >= static_cast<std::int64_t>(length_)) {
      throw runtimeError(u"TypedArray.with index is outside the array");
    }
    auto* result = slice();
    result->set(static_cast<std::size_t>(resolved), value);
    return result;
  }

  const void* dynamicTypeToken() const override { return nativeTypeToken<TypedArrayObject<ArrayKind>>(); }
  void* dynamicCast(const void* type) override {
    if (type == nativeTypeToken<TypedArrayObject<ArrayKind>>()) return this;
    if (type == nativeTypeToken<TypedArrayLikeObject>()) return static_cast<TypedArrayLikeObject*>(this);
    return nullptr;
  }
  std::u16string dynamicToString() const override {
    return u"[object " + std::u16string(Traits::name) + u"]";
  }
  bool dynamicIsIterable() const override { return true; }
  std::size_t dynamicIterableSize() const override { return length_; }
  Value dynamicIterableGet(std::size_t index) override {
    return index < length_ ? convertValue<Value>(get(index)) : Value::undefined();
  }
  Value dynamicGet(const std::u16string& key) override {
    if (key == u"length") return Value(static_cast<double>(length_));
    if (key == u"byteLength") return Value(static_cast<double>(byteLength()));
    if (key == u"byteOffset") return Value(static_cast<double>(byte_offset_));
    const auto index = propertyIndex(key);
    return index && *index < length_ ? convertValue<Value>(get(*index)) : Value::undefined();
  }
  Value dynamicSet(const std::u16string& key, const Value& value) override {
    const auto index = propertyIndex(key);
    if (!index) throw runtimeError(u"Invalid typed-array index");
    if constexpr (std::is_same_v<ValueType, BigInt>) return Value(set(*index, makeBigInt(value)));
    else return Value(set(*index, Number(value)));
  }

  class Iterator final {
   public:
    Iterator(const TypedArrayObject* array, std::size_t index) : array_(array), index_(index) {}
    ValueType operator*() const { return array_->get(index_); }
    Iterator& operator++() { ++index_; return *this; }
    bool operator!=(const Iterator& other) const { return index_ != other.index_; }
   private:
    const TypedArrayObject* array_;
    std::size_t index_;
  };
  Iterator begin() const { return Iterator(this, 0); }
  Iterator end() const { return Iterator(this, length_); }

  void Trace(cppgc::Visitor* visitor) const override {
    BaseObject::Trace(visitor);
    visitor->Trace(buffer_);
  }

 private:
  static TypedArrayObject* create(std::size_t length) {
    auto* buffer = makeManaged<ArrayBufferObject>(length * bytesPerElement);
    return makeManaged<TypedArrayObject>(buffer, 0, length);
  }

  std::size_t normalizedIndex(double index) const {
    if (std::isnan(index)) return 0;
    const auto integer = static_cast<std::int64_t>(std::trunc(index));
    if (integer < 0) {
      return static_cast<std::size_t>(std::max<std::int64_t>(0, static_cast<std::int64_t>(length_) + integer));
    }
    return std::min<std::size_t>(static_cast<std::size_t>(integer), length_);
  }

  std::size_t forwardIndex(double index) const {
    if (index >= static_cast<double>(length_)) return length_;
    if (index < 0) return normalizedIndex(index);
    return static_cast<std::size_t>(std::max(0.0, std::trunc(index)));
  }

  template <typename Input>
  static ValueType convertInput(const Input& value) {
    if constexpr (std::is_same_v<ValueType, BigInt>) return makeBigInt(convertValue<Value>(value));
    else return Number(convertValue<Value>(value));
  }

  template <typename Callback>
  decltype(auto) invokeCallback(Callback& callback, ValueType value, std::size_t index) const {
    auto* mutableArray = const_cast<TypedArrayObject*>(this);
    if constexpr (std::is_invocable_v<Callback, ValueType, double, TypedArrayObject*>) {
      return callback(std::move(value), static_cast<double>(index), mutableArray);
    } else if constexpr (std::is_invocable_v<Callback, ValueType, double>) {
      return callback(std::move(value), static_cast<double>(index));
    } else if constexpr (std::is_invocable_v<Callback, ValueType>) {
      return callback(std::move(value));
    } else {
      return callback();
    }
  }

  template <typename Callback, typename Accumulator>
  decltype(auto) invokeReduceCallback(
      Callback& callback,
      Accumulator accumulator,
      ValueType value,
      std::size_t index) const {
    auto* mutableArray = const_cast<TypedArrayObject*>(this);
    if constexpr (std::is_invocable_v<Callback, Accumulator, ValueType, double, TypedArrayObject*>) {
      return callback(std::move(accumulator), std::move(value), static_cast<double>(index), mutableArray);
    } else if constexpr (std::is_invocable_v<Callback, Accumulator, ValueType, double>) {
      return callback(std::move(accumulator), std::move(value), static_cast<double>(index));
    } else {
      return callback(std::move(accumulator), std::move(value));
    }
  }

  template <typename Accumulator, typename Result>
  static void resultAssign(Accumulator& target, Result&& value) {
    target = std::forward<Result>(value);
  }

  cppgc::Member<ArrayBufferObject> buffer_;
  std::size_t byte_offset_;
  std::size_t length_;
};

using NativeInt8ArrayObject = TypedArrayObject<TypedArrayKind::Int8>;
using NativeUint8ArrayObject = TypedArrayObject<TypedArrayKind::Uint8>;
using NativeUint8ClampedArrayObject = TypedArrayObject<TypedArrayKind::Uint8Clamped>;
using NativeInt16ArrayObject = TypedArrayObject<TypedArrayKind::Int16>;
using NativeUint16ArrayObject = TypedArrayObject<TypedArrayKind::Uint16>;
using NativeInt32ArrayObject = TypedArrayObject<TypedArrayKind::Int32>;
using NativeUint32ArrayObject = TypedArrayObject<TypedArrayKind::Uint32>;
using NativeFloat16ArrayObject = TypedArrayObject<TypedArrayKind::Float16>;
using NativeFloat32ArrayObject = TypedArrayObject<TypedArrayKind::Float32>;
using NativeFloat64ArrayObject = TypedArrayObject<TypedArrayKind::Float64>;
using NativeBigInt64ArrayObject = TypedArrayObject<TypedArrayKind::BigInt64>;
using NativeBigUint64ArrayObject = TypedArrayObject<TypedArrayKind::BigUint64>;
using Uint8ArrayObject = NativeUint8ArrayObject;
using Int32ArrayObject = NativeInt32ArrayObject;
using Uint32ArrayObject = NativeUint32ArrayObject;
