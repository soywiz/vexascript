#pragma once

// Internal runtime category header. Include runtime.hpp instead.

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
  BigInt getBigInt64(double offset, bool littleEndian = false) const {
    return BigInt(static_cast<long long>(std::bit_cast<std::int64_t>(
        readValue<std::uint64_t>(offset, littleEndian))));
  }
  BigInt getBigUint64(double offset, bool littleEndian = false) const {
    return BigInt(static_cast<unsigned long long>(readValue<std::uint64_t>(offset, littleEndian)));
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
  void setBigInt64(double offset, const BigInt& value, bool littleEndian = false) {
    writeValue(offset, value.toUint64Modulo(), littleEndian);
  }
  void setBigUint64(double offset, const BigInt& value, bool littleEndian = false) {
    writeValue(offset, value.toUint64Modulo(), littleEndian);
  }
  void setFloat16(double offset, double value, bool littleEndian = false) {
    writeValue(offset, float16Storage(value), littleEndian);
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

inline bool arrayBufferIsView(const ArrayBufferObject*) { return false; }
inline bool arrayBufferIsView(const TypedArrayLikeObject*) { return true; }
inline bool arrayBufferIsView(TypedArrayLikeObject*) { return true; }
template <TypedArrayKind ArrayKind>
inline bool arrayBufferIsView(const TypedArrayObject<ArrayKind>*) { return true; }
template <TypedArrayKind ArrayKind>
inline bool arrayBufferIsView(TypedArrayObject<ArrayKind>*) { return true; }
inline bool arrayBufferIsView(const DataViewObject*) { return true; }
inline bool arrayBufferIsView(DataViewObject*) { return true; }
inline bool arrayBufferIsView(const Value& value) {
  if (!value.isRuntimeObject()) return false;
  BaseObject* object = value.object();
  return object->dynamicCast(nativeTypeToken<TypedArrayLikeObject>()) ||
    object->dynamicCast(nativeTypeToken<DataViewObject>());
}

template <typename T>
  requires requires(const T& value) { value.Get(); }
inline bool arrayBufferIsView(const T& value) {
  return arrayBufferIsView(value.Get());
}

template <typename T>
inline bool arrayBufferIsView(const T&) { return false; }
