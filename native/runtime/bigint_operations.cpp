#include "runtime.hpp"

namespace vexa {

BigInt bigIntAsUintN(double rawBits, const BigInt& value) {
  const auto bits = static_cast<std::uint64_t>(std::max(0.0, std::trunc(rawBits)));
  if (bits == 0) return BigInt(0);
  const BigInt modulus = BigInt(1) << BigInt(static_cast<long long>(bits));
  BigInt result = value % modulus;
  if (result < BigInt(0)) result += modulus;
  return result;
}

BigInt bigIntAsIntN(double rawBits, const BigInt& value) {
  const auto bits = static_cast<std::uint64_t>(std::max(0.0, std::trunc(rawBits)));
  if (bits == 0) return BigInt(0);
  const BigInt unsignedValue = bigIntAsUintN(rawBits, value);
  const BigInt sign = BigInt(1) << BigInt(static_cast<long long>(bits - 1));
  const BigInt modulus = sign << BigInt(1);
  return unsignedValue >= sign ? unsignedValue - modulus : unsignedValue;
}

}  // namespace vexa
