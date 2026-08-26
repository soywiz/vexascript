#pragma once

// Internal runtime category header. Include runtime.hpp instead.

class ArrayBufferObject final : public cppgc::GarbageCollected<ArrayBufferObject>, public BaseObject {
 public:
  explicit ArrayBufferObject(
      std::size_t byteLength,
      std::size_t maxByteLength = 0,
      bool shared = false,
      bool variableLength = false);
  std::size_t byteLength() const;
  std::size_t maxByteLength() const;
  bool detached() const;
  bool growable() const;
  bool resizable() const;
  void grow(double newByteLength = 0);
  void resize(double newByteLength = 0);
  ArrayBufferObject* transfer(double requestedLength = std::numeric_limits<double>::quiet_NaN());
  ArrayBufferObject* transferToFixedLength(double requestedLength = std::numeric_limits<double>::quiet_NaN());
  ArrayBufferObject* slice(
      double begin = 0,
      double end = std::numeric_limits<double>::infinity()) const;
  std::uint8_t* data();
  const std::uint8_t* data() const;
  std::shared_ptr<std::vector<std::uint8_t>> sharedBytes() const;
  std::uint8_t get(std::size_t index) const;
  void set(std::size_t index, std::uint8_t value);
  const void* dynamicTypeToken() const override;
  void* dynamicCast(const void* type) override;
  std::u16string dynamicToString() const override;
  void Trace(cppgc::Visitor* visitor) const override;

 private:
  std::shared_ptr<std::vector<std::uint8_t>> bytes_;
  std::size_t max_byte_length_;
  bool shared_;
  bool variable_length_;
  bool detached_ = false;

  ArrayBufferObject* transferImpl(double requestedLength, bool variableLength);
};

class FFIPointerObject final : public cppgc::GarbageCollected<FFIPointerObject>, public BaseObject {
 public:
  FFIPointerObject(void* address, std::size_t byteLength = std::numeric_limits<std::size_t>::max());
  FFIPointerObject(ArrayBufferObject* buffer, std::size_t byteOffset = 0, std::size_t byteLength = std::numeric_limits<std::size_t>::max());
  void* rawAddress() const;
  std::int64_t address;
  double getInt8(double offset) const;
  double getInt16(double offset) const;
  double getInt32(double offset) const;
  std::int64_t getInt64(double offset) const;
  double getFloat32(double offset) const;
  double getFloat64(double offset) const;
  void setInt8(double offset, double value);
  void setInt16(double offset, double value);
  void setInt32(double offset, double value);
  void setInt64(double offset, std::int64_t value);
  void setFloat32(double offset, double value);
  void setFloat64(double offset, double value);
  const void* dynamicTypeToken() const override;
  void* dynamicCast(const void* type) override;
  std::u16string dynamicToString() const override;
  void Trace(cppgc::Visitor* visitor) const override;

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
