#include "runtime.hpp"

namespace vexa {

std::size_t ArrayBufferObject::byteLength() const { return bytes_->size(); }

std::size_t ArrayBufferObject::maxByteLength() const { return detached_ ? 0 : max_byte_length_; }

bool ArrayBufferObject::detached() const { return detached_; }

bool ArrayBufferObject::growable() const { return shared_ && variable_length_; }

bool ArrayBufferObject::resizable() const { return !shared_ && variable_length_; }

void ArrayBufferObject::grow(double newByteLength) {
    const auto length = static_cast<std::size_t>(std::max(0.0, std::trunc(newByteLength)));
    if (!shared_ || length < bytes_->size() || length > max_byte_length_) {
      throw std::out_of_range("Invalid SharedArrayBuffer grow length");
    }
    bytes_->resize(length, 0);
  }

void ArrayBufferObject::resize(double newByteLength) {
    const auto length = static_cast<std::size_t>(std::max(0.0, std::trunc(newByteLength)));
    if (shared_ || !variable_length_ || detached_ || length > max_byte_length_) {
      throw std::out_of_range("Invalid ArrayBuffer resize length");
    }
    bytes_->resize(length, 0);
  }

ArrayBufferObject* ArrayBufferObject::transfer(double requestedLength) {
    return transferImpl(requestedLength, variable_length_);
  }

ArrayBufferObject* ArrayBufferObject::transferToFixedLength(double requestedLength) {
    return transferImpl(requestedLength, false);
  }

ArrayBufferObject* ArrayBufferObject::slice(
      double begin,
      double end) const {
    const auto size = static_cast<std::int64_t>(bytes_->size());
    const auto normalize = [size](double value, std::int64_t fallback) {
      if (!std::isfinite(value)) return value < 0 ? std::int64_t{0} : fallback;
      const auto integer = static_cast<std::int64_t>(std::trunc(value));
      return std::clamp(integer < 0 ? size + integer : integer, std::int64_t{0}, size);
    };
    const auto first = normalize(begin, 0);
    const auto last = normalize(end, size);
    const auto length = static_cast<std::size_t>(std::max(std::int64_t{0}, last - first));
    auto* result = makeManaged<ArrayBufferObject>(length, length, shared_, false);
    if (length > 0) std::memcpy(result->data(), data() + first, length);
    return result;
  }

std::uint8_t* ArrayBufferObject::data() { return bytes_->data(); }

const std::uint8_t* ArrayBufferObject::data() const { return bytes_->data(); }

std::shared_ptr<std::vector<std::uint8_t>> ArrayBufferObject::sharedBytes() const { return bytes_; }

std::uint8_t ArrayBufferObject::get(std::size_t index) const {
    if (index >= bytes_->size()) throw std::out_of_range("ArrayBuffer access is out of range");
    return (*bytes_)[index];
  }

void ArrayBufferObject::set(std::size_t index, std::uint8_t value) {
    if (index >= bytes_->size()) throw std::out_of_range("ArrayBuffer access is out of range");
    (*bytes_)[index] = value;
  }

const void* ArrayBufferObject::dynamicTypeToken() const { return nativeTypeToken<ArrayBufferObject>(); }

void* ArrayBufferObject::dynamicCast(const void* type) {
    return type == nativeTypeToken<ArrayBufferObject>() ? this : nullptr;
  }

std::u16string ArrayBufferObject::dynamicToString() const {
    return shared_ ? u"[object SharedArrayBuffer]" : u"[object ArrayBuffer]";
  }

void ArrayBufferObject::Trace(cppgc::Visitor* visitor) const { BaseObject::Trace(visitor); }

ArrayBufferObject* ArrayBufferObject::transferImpl(double requestedLength, bool variableLength) {
    if (shared_ || detached_) throw std::out_of_range("Cannot transfer this ArrayBuffer");
    const std::size_t length = std::isnan(requestedLength)
      ? bytes_->size()
      : static_cast<std::size_t>(std::max(0.0, std::trunc(requestedLength)));
    const std::size_t maximum = variableLength ? std::max(max_byte_length_, length) : length;
    auto* result = makeManaged<ArrayBufferObject>(length, maximum, false, variableLength);
    if (length > 0 && !bytes_->empty()) {
      std::memcpy(result->data(), data(), std::min(length, bytes_->size()));
    }
    bytes_ = std::make_shared<std::vector<std::uint8_t>>();
    detached_ = true;
    return result;
  }

void* FFIPointerObject::rawAddress() const { return address_; }

double FFIPointerObject::getInt8(double offset) const { return read<std::int8_t>(offset); }

double FFIPointerObject::getInt16(double offset) const { return read<std::int16_t>(offset); }

double FFIPointerObject::getInt32(double offset) const { return read<std::int32_t>(offset); }

std::int64_t FFIPointerObject::getInt64(double offset) const { return read<std::int64_t>(offset); }

double FFIPointerObject::getFloat32(double offset) const { return read<float>(offset); }

double FFIPointerObject::getFloat64(double offset) const { return read<double>(offset); }

void FFIPointerObject::setInt8(double offset, double value) { write<std::int8_t>(offset, static_cast<std::int8_t>(value)); }

void FFIPointerObject::setInt16(double offset, double value) { write<std::int16_t>(offset, static_cast<std::int16_t>(value)); }

void FFIPointerObject::setInt32(double offset, double value) { write<std::int32_t>(offset, static_cast<std::int32_t>(value)); }

void FFIPointerObject::setInt64(double offset, std::int64_t value) { write<std::int64_t>(offset, value); }

void FFIPointerObject::setFloat32(double offset, double value) { write<float>(offset, static_cast<float>(value)); }

void FFIPointerObject::setFloat64(double offset, double value) { write<double>(offset, value); }

const void* FFIPointerObject::dynamicTypeToken() const { return nativeTypeToken<FFIPointerObject>(); }

void* FFIPointerObject::dynamicCast(const void* type) { return type == nativeTypeToken<FFIPointerObject>() ? this : nullptr; }

std::u16string FFIPointerObject::dynamicToString() const { return u"[object FFIPointer]"; }

void FFIPointerObject::Trace(cppgc::Visitor* visitor) const { BaseObject::Trace(visitor); visitor->Trace(backing_); }


ArrayBufferObject::ArrayBufferObject(
      std::size_t byteLength,
      std::size_t maxByteLength,
      bool shared,
      bool variableLength)
      : bytes_(std::make_shared<std::vector<std::uint8_t>>(byteLength, 0)),
        max_byte_length_(maxByteLength == 0 ? byteLength : maxByteLength),
        shared_(shared),
        variable_length_(variableLength) {
    if (byteLength > max_byte_length_) throw std::out_of_range("ArrayBuffer length exceeds maxByteLength");
  }

FFIPointerObject::FFIPointerObject(void* address, std::size_t byteLength)
      : address(static_cast<std::int64_t>(reinterpret_cast<std::uintptr_t>(address))),
        address_(static_cast<std::uint8_t*>(address)), byte_length_(byteLength) {}

FFIPointerObject::FFIPointerObject(ArrayBufferObject* buffer, std::size_t byteOffset, std::size_t byteLength)
      : address(static_cast<std::int64_t>(reinterpret_cast<std::uintptr_t>(buffer ? buffer->data() + byteOffset : nullptr))), backing_(buffer),
        address_(buffer ? buffer->data() + byteOffset : nullptr),
        byte_length_(buffer ? std::min(byteLength, buffer->byteLength() - std::min(byteOffset, buffer->byteLength())) : 0) {
    if (!buffer || byteOffset > buffer->byteLength()) throw std::out_of_range("FFIPointer view is outside its ArrayBuffer");
  }
}  // namespace vexa
