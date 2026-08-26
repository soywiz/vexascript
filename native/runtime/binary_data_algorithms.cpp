#include "runtime.hpp"

namespace vexa {

ArrayBufferObject* makeArrayBuffer(double length) {
  const auto size = static_cast<std::size_t>(std::max(0.0, std::trunc(length)));
  return Runtime::make<ArrayBufferObject>(size);
}

ArrayBufferObject* makeArrayBuffer(double length, double maxByteLength) {
  const auto size = static_cast<std::size_t>(std::max(0.0, std::trunc(length)));
  const auto maximum = static_cast<std::size_t>(std::max(0.0, std::trunc(maxByteLength)));
  return Runtime::make<ArrayBufferObject>(size, maximum, false, true);
}

ArrayBufferObject* makeSharedArrayBuffer(double length) {
  const auto size = static_cast<std::size_t>(std::max(0.0, std::trunc(length)));
  return Runtime::make<ArrayBufferObject>(size, size, true, false);
}

ArrayBufferObject* makeSharedArrayBuffer(double length, double maxByteLength) {
  const auto size = static_cast<std::size_t>(std::max(0.0, std::trunc(length)));
  const auto maximum = static_cast<std::size_t>(std::max(0.0, std::trunc(maxByteLength)));
  return Runtime::make<ArrayBufferObject>(size, maximum, true, true);
}

Uint8ArrayObject* makeUint8Array(const std::u16string& value) {
  const auto encoded = utf16ToUtf8(value);
  auto* result = makeTypedArray<TypedArrayKind::Uint8>(static_cast<double>(encoded.size()));
  for (std::size_t index = 0; index < encoded.size(); ++index) {
    result->set(index, static_cast<double>(static_cast<unsigned char>(encoded[index])));
  }
  return result;
}

double atomicsLoad(Int32ArrayObject* array, double index) {
  return static_cast<double>(array->get(static_cast<std::size_t>(index)));
}

double atomicsStore(Int32ArrayObject* array, double index, double value) {
  return static_cast<double>(array->set(static_cast<std::size_t>(index), value));
}

double atomicsAdd(Int32ArrayObject* array, double index, double value) {
  return atomicsUpdate(array, index, value, [](auto left, auto right) { return left + right; });
}

double atomicsSub(Int32ArrayObject* array, double index, double value) {
  return atomicsUpdate(array, index, value, [](auto left, auto right) { return left - right; });
}

double atomicsAnd(Int32ArrayObject* array, double index, double value) {
  return atomicsUpdate(array, index, value, [](auto left, auto right) { return left & right; });
}

double atomicsOr(Int32ArrayObject* array, double index, double value) {
  return atomicsUpdate(array, index, value, [](auto left, auto right) { return left | right; });
}

double atomicsXor(Int32ArrayObject* array, double index, double value) {
  return atomicsUpdate(array, index, value, [](auto left, auto right) { return left ^ right; });
}

double atomicsExchange(Int32ArrayObject* array, double index, double value) {
  return atomicsUpdate(array, index, value, [](auto, auto right) { return right; });
}

double atomicsCompareExchange(
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

bool atomicsIsLockFree(double size) {
  return size == 1 || size == 2 || size == 4 || size == 8;
}

double atomicsNotify(Int32ArrayObject*, double, double) {
  return 0;
}

std::u16string atomicsWait(Int32ArrayObject* array, double index, double value, double) {
  return array->get(static_cast<std::size_t>(index)) == static_cast<std::int32_t>(value)
      ? u"timed-out"
      : u"not-equal";
}

RecordObject* atomicsWaitAsync(Int32ArrayObject* array, double index, double value, double timeout) {
  return Runtime::record({
    {u"async", Value(false)},
    {u"value", Runtime::string(atomicsWait(array, index, value, timeout))},
  });
}

DataViewObject* makeDataView(
    ArrayBufferObject* buffer,
    double byteOffset,
    double byteLength) {
  const auto offset = static_cast<std::size_t>(std::max(0.0, byteOffset));
  const auto length = byteLength < 0
    ? buffer->byteLength() - offset
    : static_cast<std::size_t>(byteLength);
  return Runtime::make<DataViewObject>(buffer, offset, length);
}

}  // namespace vexa
