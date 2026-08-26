#pragma once

// Internal runtime category header. Include runtime.hpp instead.

class DataViewObject final : public cppgc::GarbageCollected<DataViewObject>, public BaseObject {
 public:
  DataViewObject(ArrayBufferObject* buffer, std::size_t byteOffset, std::size_t byteLength);
  std::size_t byteLength() const;
  std::size_t byteOffset() const;
  ArrayBufferObject* buffer() const;
  double getUint8(double offset) const;
  double getInt8(double offset) const;
  double getUint16(double offset, bool littleEndian = false) const;
  double getInt16(double offset, bool littleEndian = false) const;
  double getUint32(double offset, bool littleEndian = false) const;
  double getInt32(double offset, bool littleEndian = false) const;
  double getFloat32(double offset, bool littleEndian = false) const;
  double getFloat64(double offset, bool littleEndian = false) const;
  BigInt getBigInt64(double offset, bool littleEndian = false) const;
  BigInt getBigUint64(double offset, bool littleEndian = false) const;
  double getFloat16(double offset, bool littleEndian = false) const;
  void setUint8(double offset, double value);
  void setInt8(double offset, double value);
  void setUint16(double offset, double value, bool littleEndian = false);
  void setInt16(double offset, double value, bool littleEndian = false);
  void setUint32(double offset, double value, bool littleEndian = false);
  void setInt32(double offset, double value, bool littleEndian = false);
  void setFloat32(double offset, double value, bool littleEndian = false);
  void setFloat64(double offset, double value, bool littleEndian = false);
  void setBigInt64(double offset, const BigInt& value, bool littleEndian = false);
  void setBigUint64(double offset, const BigInt& value, bool littleEndian = false);
  void setFloat16(double offset, double value, bool littleEndian = false);
  const void* dynamicTypeToken() const override;
  void* dynamicCast(const void* type) override;
  std::u16string dynamicToString() const override;
  void Trace(cppgc::Visitor* visitor) const override;

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

bool arrayBufferIsView(const ArrayBufferObject*);
bool arrayBufferIsView(const TypedArrayLikeObject*);
bool arrayBufferIsView(TypedArrayLikeObject*);
template <TypedArrayKind ArrayKind>
inline bool arrayBufferIsView(const TypedArrayObject<ArrayKind>*) { return true; }
template <TypedArrayKind ArrayKind>
inline bool arrayBufferIsView(TypedArrayObject<ArrayKind>*) { return true; }
bool arrayBufferIsView(const DataViewObject*);
bool arrayBufferIsView(DataViewObject*);
bool arrayBufferIsView(const Value& value);

template <typename T>
  requires requires(const T& value) { value.Get(); }
inline bool arrayBufferIsView(const T& value) {
  return arrayBufferIsView(value.Get());
}

template <typename T>
inline bool arrayBufferIsView(const T&) { return false; }
