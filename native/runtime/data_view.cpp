#include "runtime.hpp"

namespace vexa {

std::size_t DataViewObject::byteLength() const { return byte_length_; }

std::size_t DataViewObject::byteOffset() const { return byte_offset_; }

ArrayBufferObject* DataViewObject::buffer() const { return buffer_.Get(); }

double DataViewObject::getUint8(double offset) const { return readValue<std::uint8_t>(offset, true); }

double DataViewObject::getInt8(double offset) const { return std::bit_cast<std::int8_t>(readValue<std::uint8_t>(offset, true)); }

double DataViewObject::getUint16(double offset, bool littleEndian) const { return readValue<std::uint16_t>(offset, littleEndian); }

double DataViewObject::getInt16(double offset, bool littleEndian) const {
    return std::bit_cast<std::int16_t>(readValue<std::uint16_t>(offset, littleEndian));
  }

double DataViewObject::getUint32(double offset, bool littleEndian) const { return readValue<std::uint32_t>(offset, littleEndian); }

double DataViewObject::getInt32(double offset, bool littleEndian) const {
    return std::bit_cast<std::int32_t>(readValue<std::uint32_t>(offset, littleEndian));
  }

double DataViewObject::getFloat32(double offset, bool littleEndian) const {
    return static_cast<double>(std::bit_cast<float>(readValue<std::uint32_t>(offset, littleEndian)));
  }

double DataViewObject::getFloat64(double offset, bool littleEndian) const {
    return std::bit_cast<double>(readValue<std::uint64_t>(offset, littleEndian));
  }

BigInt DataViewObject::getBigInt64(double offset, bool littleEndian) const {
    return BigInt(static_cast<long long>(std::bit_cast<std::int64_t>(
        readValue<std::uint64_t>(offset, littleEndian))));
  }

BigInt DataViewObject::getBigUint64(double offset, bool littleEndian) const {
    return BigInt(static_cast<unsigned long long>(readValue<std::uint64_t>(offset, littleEndian)));
  }

double DataViewObject::getFloat16(double offset, bool littleEndian) const {
    return float16Value(readValue<std::uint16_t>(offset, littleEndian));
  }

void DataViewObject::setUint8(double offset, double value) { writeValue(offset, static_cast<std::uint8_t>(value), true); }

void DataViewObject::setInt8(double offset, double value) { writeValue(offset, static_cast<std::uint8_t>(value), true); }

void DataViewObject::setUint16(double offset, double value, bool littleEndian) { writeValue(offset, static_cast<std::uint16_t>(value), littleEndian); }

void DataViewObject::setInt16(double offset, double value, bool littleEndian) { writeValue(offset, static_cast<std::uint16_t>(value), littleEndian); }

void DataViewObject::setUint32(double offset, double value, bool littleEndian) { writeValue(offset, static_cast<std::uint32_t>(value), littleEndian); }

void DataViewObject::setInt32(double offset, double value, bool littleEndian) { writeValue(offset, static_cast<std::uint32_t>(value), littleEndian); }

void DataViewObject::setFloat32(double offset, double value, bool littleEndian) {
    writeValue(offset, std::bit_cast<std::uint32_t>(static_cast<float>(value)), littleEndian);
  }

void DataViewObject::setFloat64(double offset, double value, bool littleEndian) {
    writeValue(offset, std::bit_cast<std::uint64_t>(value), littleEndian);
  }

void DataViewObject::setBigInt64(double offset, const BigInt& value, bool littleEndian) {
    writeValue(offset, value.toUint64Modulo(), littleEndian);
  }

void DataViewObject::setBigUint64(double offset, const BigInt& value, bool littleEndian) {
    writeValue(offset, value.toUint64Modulo(), littleEndian);
  }

void DataViewObject::setFloat16(double offset, double value, bool littleEndian) {
    writeValue(offset, float16Storage(value), littleEndian);
  }

const void* DataViewObject::dynamicTypeToken() const { return nativeTypeToken<DataViewObject>(); }

void* DataViewObject::dynamicCast(const void* type) {
    return type == nativeTypeToken<DataViewObject>() ? this : nullptr;
  }

std::u16string DataViewObject::dynamicToString() const { return u"[object DataView]"; }

void DataViewObject::Trace(cppgc::Visitor* visitor) const {
    BaseObject::Trace(visitor);
    visitor->Trace(buffer_);
  }

bool arrayBufferIsView(const ArrayBufferObject*) { return false; }

bool arrayBufferIsView(const TypedArrayLikeObject*) { return true; }

bool arrayBufferIsView(TypedArrayLikeObject*) { return true; }

bool arrayBufferIsView(const DataViewObject*) { return true; }

bool arrayBufferIsView(DataViewObject*) { return true; }

bool arrayBufferIsView(const Value& value) {
  if (!value.isRuntimeObject()) return false;
  BaseObject* object = value.object();
  return object->dynamicCast(nativeTypeToken<TypedArrayLikeObject>()) ||
    object->dynamicCast(nativeTypeToken<DataViewObject>());
}


DataViewObject::DataViewObject(ArrayBufferObject* buffer, std::size_t byteOffset, std::size_t byteLength)
      : buffer_(buffer), byte_offset_(byteOffset), byte_length_(byteLength) {
    if (!buffer || byteOffset + byteLength > buffer->byteLength()) {
      throw std::out_of_range("DataView is outside its ArrayBuffer");
    }
  }
}  // namespace vexa
