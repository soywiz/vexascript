#pragma once

// Internal runtime category header. Include runtime.hpp instead.

class ArrayBufferObject final : public cppgc::GarbageCollected<ArrayBufferObject>, public BaseObject {
 public:
  explicit ArrayBufferObject(
      std::size_t byteLength,
      std::size_t maxByteLength = 0,
      bool shared = false,
      bool variableLength = false)
      : bytes_(std::make_shared<std::vector<std::uint8_t>>(byteLength, 0)),
        max_byte_length_(maxByteLength == 0 ? byteLength : maxByteLength),
        shared_(shared),
        variable_length_(variableLength) {
    if (byteLength > max_byte_length_) throw std::out_of_range("ArrayBuffer length exceeds maxByteLength");
  }
  std::size_t byteLength() const { return bytes_->size(); }
  std::size_t maxByteLength() const { return detached_ ? 0 : max_byte_length_; }
  bool detached() const { return detached_; }
  bool growable() const { return shared_ && variable_length_; }
  bool resizable() const { return !shared_ && variable_length_; }
  void grow(double newByteLength = 0) {
    const auto length = static_cast<std::size_t>(std::max(0.0, std::trunc(newByteLength)));
    if (!shared_ || length < bytes_->size() || length > max_byte_length_) {
      throw std::out_of_range("Invalid SharedArrayBuffer grow length");
    }
    bytes_->resize(length, 0);
  }
  void resize(double newByteLength = 0) {
    const auto length = static_cast<std::size_t>(std::max(0.0, std::trunc(newByteLength)));
    if (shared_ || !variable_length_ || detached_ || length > max_byte_length_) {
      throw std::out_of_range("Invalid ArrayBuffer resize length");
    }
    bytes_->resize(length, 0);
  }
  ArrayBufferObject* transfer(double requestedLength = std::numeric_limits<double>::quiet_NaN()) {
    return transferImpl(requestedLength, variable_length_);
  }
  ArrayBufferObject* transferToFixedLength(double requestedLength = std::numeric_limits<double>::quiet_NaN()) {
    return transferImpl(requestedLength, false);
  }
  ArrayBufferObject* slice(
      double begin = 0,
      double end = std::numeric_limits<double>::infinity()) const {
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
  std::u16string dynamicToString() const override {
    return shared_ ? u"[object SharedArrayBuffer]" : u"[object ArrayBuffer]";
  }
  void Trace(cppgc::Visitor* visitor) const override { BaseObject::Trace(visitor); }

 private:
  std::shared_ptr<std::vector<std::uint8_t>> bytes_;
  std::size_t max_byte_length_;
  bool shared_;
  bool variable_length_;
  bool detached_ = false;

  ArrayBufferObject* transferImpl(double requestedLength, bool variableLength) {
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
};

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
