#pragma once

#include <compare>
#include <cstddef>
#include <cstdint>
#include <iosfwd>
#include <string>
#include <string_view>
#include <utility>
#include <vector>

namespace vexa {

// A deliberately small arbitrary-precision signed integer. Magnitudes use
// little-endian base-2^32 limbs. Division uses a linear single-limb path for
// common small divisors and a dependency-free bit-at-a-time general fallback.
class BigInt final {
 public:
  BigInt();
  BigInt(int value);
  BigInt(long long value);
  BigInt(unsigned long long value);
  explicit BigInt(std::string_view text);
  explicit BigInt(std::u16string_view text);

  bool isZero() const;
  bool isNegative() const;
  bool isOdd() const;
  std::u16string toString() const;
  double toDouble() const;
  std::uint64_t toUint64Modulo() const;

  BigInt operator-() const;
  BigInt& operator+=(const BigInt& other);
  BigInt& operator-=(const BigInt& other);
  BigInt& operator*=(const BigInt& other);
  BigInt& operator/=(const BigInt& other);
  BigInt& operator%=(const BigInt& other);
  BigInt& operator&=(const BigInt& other);
  BigInt& operator|=(const BigInt& other);
  BigInt& operator^=(const BigInt& other);
  BigInt& operator<<=(const BigInt& amount);
  BigInt& operator>>=(const BigInt& amount);
  BigInt operator~() const;
  BigInt& operator++();
  BigInt operator++(int);
  BigInt& operator--();
  BigInt operator--(int);

  friend BigInt operator+(BigInt left, const BigInt& right);
  friend BigInt operator-(BigInt left, const BigInt& right);
  friend BigInt operator*(BigInt left, const BigInt& right);
  friend BigInt operator/(BigInt left, const BigInt& right);
  friend BigInt operator%(BigInt left, const BigInt& right);
  friend BigInt operator&(BigInt left, const BigInt& right);
  friend BigInt operator|(BigInt left, const BigInt& right);
  friend BigInt operator^(BigInt left, const BigInt& right);
  friend BigInt operator<<(BigInt left, const BigInt& right);
  friend BigInt operator>>(BigInt left, const BigInt& right);
  friend bool operator==(const BigInt& left, const BigInt& right);
  friend std::strong_ordering operator<=>(const BigInt& left, const BigInt& right);
  friend std::ostream& operator<<(std::ostream& output, const BigInt& value);
  friend BigInt pow(BigInt base, BigInt exponent);

 private:
  std::vector<std::uint32_t> limbs_;
  bool negative_ = false;

  template <typename Signed>
  void assignSigned(Signed value);

  template <typename Unsigned>
  void assignUnsigned(Unsigned value);

  template <typename Character>
  void parse(std::basic_string_view<Character> text);

  BigInt absolute() const;
  void normalize();
  int compareMagnitude(const BigInt& other) const;
  void addMagnitude(const BigInt& other);
  void subtractMagnitude(const BigInt& other);
  void multiplySmall(std::uint32_t multiplier);
  void addSmall(std::uint32_t value);
  std::uint32_t divideSmall(std::uint32_t divisor);
  std::size_t bitLength() const;
  bool bit(std::size_t index) const;
  void setBit(std::size_t index);
  void shiftLeftOne();
  static std::pair<BigInt, BigInt> divideAndRemainder(
      const BigInt& dividend,
      const BigInt& divisor);
  std::size_t toShiftCount() const;
  void shiftLeft(std::size_t amount);
  void shiftRight(std::size_t amount);
  std::vector<std::uint32_t> twosComplement(std::size_t width) const;
  static BigInt fromTwosComplement(std::vector<std::uint32_t> bits);
  BigInt& applyBitwise(const BigInt& other, char operation);
};

BigInt pow(BigInt base, BigInt exponent);
BigInt remainder(BigInt left, const BigInt& right);
bool Boolean(const BigInt& value);

}  // namespace vexa
