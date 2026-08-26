#pragma once

// Internal runtime category header. Include runtime.hpp instead.

inline ArrayBufferObject* makeArrayBuffer(double length) {
  const auto size = static_cast<std::size_t>(std::max(0.0, std::trunc(length)));
  return Runtime::make<ArrayBufferObject>(size);
}

inline ArrayBufferObject* makeArrayBuffer(double length, double maxByteLength) {
  const auto size = static_cast<std::size_t>(std::max(0.0, std::trunc(length)));
  const auto maximum = static_cast<std::size_t>(std::max(0.0, std::trunc(maxByteLength)));
  return Runtime::make<ArrayBufferObject>(size, maximum, false, true);
}

inline ArrayBufferObject* makeSharedArrayBuffer(double length) {
  const auto size = static_cast<std::size_t>(std::max(0.0, std::trunc(length)));
  return Runtime::make<ArrayBufferObject>(size, size, true, false);
}

inline ArrayBufferObject* makeSharedArrayBuffer(double length, double maxByteLength) {
  const auto size = static_cast<std::size_t>(std::max(0.0, std::trunc(length)));
  const auto maximum = static_cast<std::size_t>(std::max(0.0, std::trunc(maxByteLength)));
  return Runtime::make<ArrayBufferObject>(size, maximum, true, true);
}

template <TypedArrayKind ArrayKind>
inline TypedArrayObject<ArrayKind>* makeTypedArray(double length = 0) {
  using Array = TypedArrayObject<ArrayKind>;
  const auto size = static_cast<std::size_t>(std::max(0.0, std::trunc(length)));
  auto* buffer = Runtime::make<ArrayBufferObject>(size * Array::bytesPerElement);
  return Runtime::make<Array>(buffer, 0, size);
}

template <TypedArrayKind ArrayKind>
inline TypedArrayObject<ArrayKind>* makeTypedArray(
    ArrayBufferObject* buffer,
    double byteOffset = 0,
    double requestedLength = std::numeric_limits<double>::quiet_NaN()) {
  using Array = TypedArrayObject<ArrayKind>;
  if (!buffer || !std::isfinite(byteOffset) || byteOffset < 0) {
    throw runtimeError(u"Invalid typed-array buffer or byte offset");
  }
  const auto offset = static_cast<std::size_t>(std::trunc(byteOffset));
  if (offset > buffer->byteLength()) throw runtimeError(u"Typed-array byte offset is outside its buffer");
  const auto available = buffer->byteLength() - offset;
  const auto length = std::isnan(requestedLength)
    ? available / Array::bytesPerElement
    : static_cast<std::size_t>(std::max(0.0, std::trunc(requestedLength)));
  return Runtime::make<Array>(buffer, offset, length);
}

template <TypedArrayKind ArrayKind, typename Input>
inline typename TypedArrayTraits<ArrayKind>::Value typedArrayInputValue(const Input& value) {
  using Result = typename TypedArrayTraits<ArrayKind>::Value;
  if constexpr (std::is_same_v<Result, BigInt>) return makeBigInt(convertValue<Value>(value));
  else return Number(convertValue<Value>(value));
}

template <TypedArrayKind ArrayKind, typename Input>
inline TypedArrayObject<ArrayKind>* makeTypedArray(const ArrayObject<Input>* values) {
  auto* result = makeTypedArray<ArrayKind>(values ? static_cast<double>(values->size()) : 0);
  if (!values) return result;
  for (std::size_t index = 0; index < values->size(); ++index) {
    result->set(index, typedArrayInputValue<ArrayKind>(values->get(index)));
  }
  return result;
}

template <TypedArrayKind ArrayKind, TypedArrayKind SourceKind>
inline TypedArrayObject<ArrayKind>* makeTypedArray(const TypedArrayObject<SourceKind>* values) {
  auto* result = makeTypedArray<ArrayKind>(values ? static_cast<double>(values->size()) : 0);
  if (!values) return result;
  for (std::size_t index = 0; index < values->size(); ++index) {
    result->set(index, typedArrayInputValue<ArrayKind>(values->get(index)));
  }
  return result;
}

template <TypedArrayKind ArrayKind, typename... Values>
inline TypedArrayObject<ArrayKind>* typedArrayOf(Values... values) {
  auto* result = makeTypedArray<ArrayKind>(static_cast<double>(sizeof...(Values)));
  std::size_t index = 0;
  (result->set(index++, typedArrayInputValue<ArrayKind>(values)), ...);
  return result;
}

template <TypedArrayKind ArrayKind, typename Input>
inline TypedArrayObject<ArrayKind>* typedArrayFrom(const ArrayObject<Input>* values) {
  return makeTypedArray<ArrayKind>(values);
}

template <TypedArrayKind ArrayKind, typename Input, typename Callback>
inline TypedArrayObject<ArrayKind>* typedArrayFrom(const ArrayObject<Input>* values, Callback callback) {
  auto* result = makeTypedArray<ArrayKind>(values ? static_cast<double>(values->size()) : 0);
  if (!values) return result;
  for (std::size_t index = 0; index < values->size(); ++index) {
    const auto value = typedArrayInputValue<ArrayKind>(values->get(index));
    if constexpr (std::is_invocable_v<Callback, decltype(value), double>) {
      result->set(index, callback(value, static_cast<double>(index)));
    } else {
      result->set(index, callback(value));
    }
  }
  return result;
}

inline Uint8ArrayObject* makeUint8Array(const std::u16string& value) {
  const auto encoded = utf16ToUtf8(value);
  auto* result = makeTypedArray<TypedArrayKind::Uint8>(static_cast<double>(encoded.size()));
  for (std::size_t index = 0; index < encoded.size(); ++index) {
    result->set(index, static_cast<double>(static_cast<unsigned char>(encoded[index])));
  }
  return result;
}

inline double atomicsLoad(Int32ArrayObject* array, double index) {
  return static_cast<double>(array->get(static_cast<std::size_t>(index)));
}

inline double atomicsStore(Int32ArrayObject* array, double index, double value) {
  return static_cast<double>(array->set(static_cast<std::size_t>(index), value));
}

template <typename Operation>
inline double atomicsUpdate(Int32ArrayObject* array, double index, double value, Operation operation) {
  const auto position = static_cast<std::size_t>(index);
  const std::int32_t previous = array->get(position);
  double modulo = std::isfinite(value) ? std::fmod(std::trunc(value), 4294967296.0) : 0.0;
  if (modulo < 0) modulo += 4294967296.0;
  const auto right = static_cast<std::uint32_t>(modulo);
  const auto next = operation(std::bit_cast<std::uint32_t>(previous), right);
  array->set(position, static_cast<double>(std::bit_cast<std::int32_t>(next)));
  return static_cast<double>(previous);
}

inline double atomicsAdd(Int32ArrayObject* array, double index, double value) {
  return atomicsUpdate(array, index, value, [](auto left, auto right) { return left + right; });
}
inline double atomicsSub(Int32ArrayObject* array, double index, double value) {
  return atomicsUpdate(array, index, value, [](auto left, auto right) { return left - right; });
}
inline double atomicsAnd(Int32ArrayObject* array, double index, double value) {
  return atomicsUpdate(array, index, value, [](auto left, auto right) { return left & right; });
}
inline double atomicsOr(Int32ArrayObject* array, double index, double value) {
  return atomicsUpdate(array, index, value, [](auto left, auto right) { return left | right; });
}
inline double atomicsXor(Int32ArrayObject* array, double index, double value) {
  return atomicsUpdate(array, index, value, [](auto left, auto right) { return left ^ right; });
}
inline double atomicsExchange(Int32ArrayObject* array, double index, double value) {
  return atomicsUpdate(array, index, value, [](auto, auto right) { return right; });
}
inline double atomicsCompareExchange(
    Int32ArrayObject* array,
    double index,
    double expected,
    double replacement) {
  const auto position = static_cast<std::size_t>(index);
  const std::int32_t previous = array->get(position);
  double modulo = std::isfinite(expected) ? std::fmod(std::trunc(expected), 4294967296.0) : 0.0;
  if (modulo < 0) modulo += 4294967296.0;
  if (previous == std::bit_cast<std::int32_t>(static_cast<std::uint32_t>(modulo))) {
    array->set(position, replacement);
  }
  return static_cast<double>(previous);
}
inline bool atomicsIsLockFree(double size) {
  return size == 1 || size == 2 || size == 4 || size == 8;
}
inline double atomicsNotify(Int32ArrayObject*, double, double = std::numeric_limits<double>::infinity()) {
  return 0;
}
inline std::u16string atomicsWait(Int32ArrayObject* array, double index, double value, double = std::numeric_limits<double>::infinity()) {
  return array->get(static_cast<std::size_t>(index)) == static_cast<std::int32_t>(value)
      ? u"timed-out"
      : u"not-equal";
}
inline RecordObject* atomicsWaitAsync(Int32ArrayObject* array, double index, double value, double timeout = std::numeric_limits<double>::infinity()) {
  return Runtime::record({
    {u"async", Value(false)},
    {u"value", Runtime::string(atomicsWait(array, index, value, timeout))},
  });
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
