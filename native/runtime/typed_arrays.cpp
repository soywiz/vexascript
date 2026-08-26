#include "runtime.hpp"

namespace vexa {

std::uint8_t typedArrayClampedStorage(double value) {
  if (std::isnan(value) || value <= 0) return 0;
  if (value >= 255) return 255;
  const double floorValue = std::floor(value);
  const double fraction = value - floorValue;
  if (fraction < 0.5) return static_cast<std::uint8_t>(floorValue);
  if (fraction > 0.5) return static_cast<std::uint8_t>(floorValue + 1);
  const auto integer = static_cast<std::uint8_t>(floorValue);
  return (integer & 1U) == 0 ? integer : static_cast<std::uint8_t>(integer + 1);
}

std::uint16_t float16Storage(double value) {
  const auto bits = std::bit_cast<std::uint32_t>(static_cast<float>(value));
  const std::uint32_t sign = (bits >> 16U) & 0x8000U;
  const std::uint32_t exponentBits = (bits >> 23U) & 0xffU;
  std::uint32_t mantissa = bits & 0x7fffffU;
  if (exponentBits == 0xffU) return static_cast<std::uint16_t>(sign | (mantissa == 0 ? 0x7c00U : 0x7e00U));

  std::int32_t exponent = static_cast<std::int32_t>(exponentBits) - 127 + 15;
  std::uint32_t half;
  if (exponent <= 0) {
    if (exponent < -10) {
      half = sign;
    } else {
      mantissa |= 0x800000U;
      const auto shift = static_cast<std::uint32_t>(14 - exponent);
      std::uint32_t rounded = mantissa >> shift;
      const std::uint32_t remainder = mantissa & ((1U << shift) - 1U);
      const std::uint32_t halfway = 1U << (shift - 1U);
      if (remainder > halfway || (remainder == halfway && (rounded & 1U) != 0)) ++rounded;
      half = sign | rounded;
    }
  } else if (exponent >= 31) {
    half = sign | 0x7c00U;
  } else {
    std::uint32_t rounded = mantissa >> 13U;
    const std::uint32_t remainder = mantissa & 0x1fffU;
    if (remainder > 0x1000U || (remainder == 0x1000U && (rounded & 1U) != 0)) {
      ++rounded;
      if (rounded == 0x400U) {
        rounded = 0;
        ++exponent;
      }
    }
    half = exponent >= 31
      ? sign | 0x7c00U
      : sign | (static_cast<std::uint32_t>(exponent) << 10U) | rounded;
  }
  return static_cast<std::uint16_t>(half);
}

double float16Value(std::uint16_t half) {
  const std::uint32_t exponent = (half >> 10U) & 0x1fU;
  const std::uint32_t mantissa = half & 0x3ffU;
  double result;
  if (exponent == 0x1fU) {
    result = mantissa == 0
      ? std::numeric_limits<double>::infinity()
      : std::numeric_limits<double>::quiet_NaN();
  } else {
    result = exponent == 0
      ? std::ldexp(static_cast<double>(mantissa), -24)
      : std::ldexp(static_cast<double>(0x400U + mantissa), static_cast<int>(exponent) - 25);
  }
  return (half & 0x8000U) != 0 ? -result : result;
}

bool typedArrayCallbackTruth(const Value& value) {
  return static_cast<bool>(value);
}

bool typedArrayCallbackTruth(const std::u16string& value) {
  return !value.empty();
}

}  // namespace vexa
