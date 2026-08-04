#pragma once

#include <algorithm>
#include <bit>
#include <charconv>
#include <compare>
#include <cctype>
#include <cstddef>
#include <cstdint>
#include <limits>
#include <ostream>
#include <stdexcept>
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
  BigInt() = default;
  BigInt(int value) { assignSigned(value); }
  BigInt(long long value) { assignSigned(value); }
  explicit BigInt(std::string_view text) { parse(text); }
  explicit BigInt(std::u16string_view text) { parse(text); }

  bool isZero() const { return limbs_.empty(); }
  bool isNegative() const { return negative_; }
  bool isOdd() const { return !limbs_.empty() && (limbs_[0] & 1U) != 0; }

  std::u16string toString() const {
    if (isZero()) return u"0";
    BigInt remaining = absolute();
    std::vector<std::uint32_t> chunks;
    while (!remaining.isZero()) chunks.push_back(remaining.divideSmall(1'000'000'000U));
    std::u16string result;
    result.reserve(chunks.size() * 9 + (negative_ ? 1 : 0));
    if (negative_) result += u'-';
    const auto appendChunk = [&](std::uint32_t chunk, std::size_t minimumWidth) {
      char buffer[10];
      const auto [end, error] = std::to_chars(buffer, buffer + sizeof(buffer), chunk);
      if (error != std::errc()) throw std::runtime_error("Failed to format BigInt");
      const auto width = static_cast<std::size_t>(end - buffer);
      result.append(minimumWidth > width ? minimumWidth - width : 0, u'0');
      result.append(buffer, end);
    };
    appendChunk(chunks.back(), 0);
    for (auto iterator = chunks.rbegin() + 1; iterator != chunks.rend(); ++iterator) {
      appendChunk(*iterator, 9);
    }
    return result;
  }

  double toDouble() const {
    double result = 0;
    for (auto iterator = limbs_.rbegin(); iterator != limbs_.rend(); ++iterator) {
      result = result * 4'294'967'296.0 + static_cast<double>(*iterator);
    }
    return negative_ ? -result : result;
  }

  BigInt operator-() const {
    BigInt result = *this;
    if (!result.isZero()) result.negative_ = !result.negative_;
    return result;
  }

  BigInt& operator+=(const BigInt& other) {
    if (negative_ == other.negative_) {
      addMagnitude(other);
    } else if (compareMagnitude(other) >= 0) {
      subtractMagnitude(other);
    } else {
      BigInt result = other;
      result.subtractMagnitude(*this);
      *this = std::move(result);
    }
    normalize();
    return *this;
  }

  BigInt& operator-=(const BigInt& other) { return *this += -other; }

  BigInt& operator*=(const BigInt& other) {
    if (isZero() || other.isZero()) {
      limbs_.clear();
      negative_ = false;
      return *this;
    }
    std::vector<std::uint32_t> product(limbs_.size() + other.limbs_.size(), 0);
    for (std::size_t left = 0; left < limbs_.size(); ++left) {
      std::uint64_t carry = 0;
      for (std::size_t right = 0; right < other.limbs_.size(); ++right) {
        const std::size_t index = left + right;
        const std::uint64_t value = static_cast<std::uint64_t>(limbs_[left]) * other.limbs_[right] +
            product[index] + carry;
        product[index] = static_cast<std::uint32_t>(value);
        carry = value >> 32U;
      }
      product[left + other.limbs_.size()] = static_cast<std::uint32_t>(carry);
    }
    limbs_ = std::move(product);
    negative_ = negative_ != other.negative_;
    normalize();
    return *this;
  }

  BigInt& operator/=(const BigInt& other) {
    *this = divideAndRemainder(*this, other).first;
    return *this;
  }

  BigInt& operator%=(const BigInt& other) {
    *this = divideAndRemainder(*this, other).second;
    return *this;
  }

  BigInt& operator&=(const BigInt& other) { return applyBitwise(other, '&'); }
  BigInt& operator|=(const BigInt& other) { return applyBitwise(other, '|'); }
  BigInt& operator^=(const BigInt& other) { return applyBitwise(other, '^'); }

  BigInt& operator<<=(const BigInt& amount) {
    shiftLeft(amount.toShiftCount());
    return *this;
  }

  BigInt& operator>>=(const BigInt& amount) {
    shiftRight(amount.toShiftCount());
    return *this;
  }

  BigInt operator~() const {
    const std::size_t width = limbs_.size() + 1;
    auto bits = twosComplement(width);
    for (auto& limb : bits) limb = ~limb;
    return fromTwosComplement(std::move(bits));
  }

  BigInt& operator++() { return *this += BigInt(1); }
  BigInt operator++(int) { BigInt previous = *this; ++*this; return previous; }
  BigInt& operator--() { return *this -= BigInt(1); }
  BigInt operator--(int) { BigInt previous = *this; --*this; return previous; }

  friend BigInt operator+(BigInt left, const BigInt& right) { return left += right; }
  friend BigInt operator-(BigInt left, const BigInt& right) { return left -= right; }
  friend BigInt operator*(BigInt left, const BigInt& right) { return left *= right; }
  friend BigInt operator/(BigInt left, const BigInt& right) { return left /= right; }
  friend BigInt operator%(BigInt left, const BigInt& right) { return left %= right; }
  friend BigInt operator&(BigInt left, const BigInt& right) { return left &= right; }
  friend BigInt operator|(BigInt left, const BigInt& right) { return left |= right; }
  friend BigInt operator^(BigInt left, const BigInt& right) { return left ^= right; }
  friend BigInt operator<<(BigInt left, const BigInt& right) { return left <<= right; }
  friend BigInt operator>>(BigInt left, const BigInt& right) { return left >>= right; }

  friend bool operator==(const BigInt& left, const BigInt& right) {
    return left.negative_ == right.negative_ && left.limbs_ == right.limbs_;
  }

  friend std::strong_ordering operator<=>(const BigInt& left, const BigInt& right) {
    if (left.negative_ != right.negative_) {
      return left.negative_ ? std::strong_ordering::less : std::strong_ordering::greater;
    }
    const int comparison = left.compareMagnitude(right);
    if (comparison == 0) return std::strong_ordering::equal;
    const bool less = left.negative_ ? comparison > 0 : comparison < 0;
    return less ? std::strong_ordering::less : std::strong_ordering::greater;
  }

  friend std::ostream& operator<<(std::ostream& output, const BigInt& value) {
    for (const char16_t digit : value.toString()) output.put(static_cast<char>(digit));
    return output;
  }

  friend BigInt pow(BigInt base, BigInt exponent);

 private:
  std::vector<std::uint32_t> limbs_;
  bool negative_ = false;

  template <typename Signed>
  void assignSigned(Signed value) {
    using Unsigned = std::make_unsigned_t<Signed>;
    const bool negative = value < 0;
    Unsigned magnitude = negative
        ? Unsigned(0) - static_cast<Unsigned>(value)
        : static_cast<Unsigned>(value);
    while (magnitude != 0) {
      limbs_.push_back(static_cast<std::uint32_t>(magnitude));
      if constexpr (sizeof(Unsigned) > sizeof(std::uint32_t)) magnitude >>= 32U;
      else magnitude = 0;
    }
    negative_ = negative && !isZero();
  }

  template <typename Character>
  void parse(std::basic_string_view<Character> text) {
    const auto isSpace = [](Character character) {
      return character == static_cast<Character>(' ') || character == static_cast<Character>('\t') ||
        character == static_cast<Character>('\n') || character == static_cast<Character>('\r') ||
        character == static_cast<Character>('\f') || character == static_cast<Character>('\v');
    };
    while (!text.empty() && isSpace(text.front())) text.remove_prefix(1);
    while (!text.empty() && isSpace(text.back())) text.remove_suffix(1);
    if (text.empty()) throw std::runtime_error("Invalid BigInt value");
    std::size_t index = 0;
    if (text[index] == '+' || text[index] == '-') {
      negative_ = text[index] == '-';
      if (++index == text.size()) throw std::runtime_error("Invalid BigInt value");
    }
    std::uint32_t base = 10;
    if (index == 0 && text.size() >= 2 && text[0] == '0') {
      const Character prefix = text[1];
      if (prefix == 'x' || prefix == 'X') base = 16;
      else if (prefix == 'o' || prefix == 'O') base = 8;
      else if (prefix == 'b' || prefix == 'B') base = 2;
      if (base != 10) index = 2;
    }
    if (index == text.size()) throw std::runtime_error("Invalid BigInt value");
    for (; index < text.size(); ++index) {
      const Character character = text[index];
      const std::uint32_t digit = character >= '0' && character <= '9'
          ? static_cast<std::uint32_t>(character - '0')
          : character >= 'a' && character <= 'f'
            ? static_cast<std::uint32_t>(character - 'a' + 10)
            : character >= 'A' && character <= 'F'
              ? static_cast<std::uint32_t>(character - 'A' + 10)
              : base;
      if (digit >= base) throw std::runtime_error("Invalid BigInt value");
      multiplySmall(base);
      addSmall(digit);
    }
    normalize();
  }

  BigInt absolute() const {
    BigInt result = *this;
    result.negative_ = false;
    return result;
  }

  void normalize() {
    while (!limbs_.empty() && limbs_.back() == 0) limbs_.pop_back();
    if (limbs_.empty()) negative_ = false;
  }

  int compareMagnitude(const BigInt& other) const {
    if (limbs_.size() != other.limbs_.size()) return limbs_.size() < other.limbs_.size() ? -1 : 1;
    for (std::size_t index = limbs_.size(); index-- > 0;) {
      if (limbs_[index] != other.limbs_[index]) return limbs_[index] < other.limbs_[index] ? -1 : 1;
    }
    return 0;
  }

  void addMagnitude(const BigInt& other) {
    const std::size_t size = std::max(limbs_.size(), other.limbs_.size());
    limbs_.resize(size, 0);
    std::uint64_t carry = 0;
    for (std::size_t index = 0; index < size; ++index) {
      const std::uint64_t value = static_cast<std::uint64_t>(limbs_[index]) +
          (index < other.limbs_.size() ? other.limbs_[index] : 0) + carry;
      limbs_[index] = static_cast<std::uint32_t>(value);
      carry = value >> 32U;
    }
    if (carry != 0) limbs_.push_back(static_cast<std::uint32_t>(carry));
  }

  void subtractMagnitude(const BigInt& other) {
    std::uint64_t borrow = 0;
    for (std::size_t index = 0; index < limbs_.size(); ++index) {
      const std::uint64_t subtrahend =
          (index < other.limbs_.size() ? other.limbs_[index] : 0) + borrow;
      const std::uint64_t current = limbs_[index];
      limbs_[index] = static_cast<std::uint32_t>(current - subtrahend);
      borrow = current < subtrahend ? 1 : 0;
    }
    normalize();
  }

  void multiplySmall(std::uint32_t multiplier) {
    std::uint64_t carry = 0;
    for (auto& limb : limbs_) {
      const std::uint64_t value = static_cast<std::uint64_t>(limb) * multiplier + carry;
      limb = static_cast<std::uint32_t>(value);
      carry = value >> 32U;
    }
    if (carry != 0) limbs_.push_back(static_cast<std::uint32_t>(carry));
  }

  void addSmall(std::uint32_t value) {
    std::uint64_t carry = value;
    for (std::size_t index = 0; carry != 0; ++index) {
      if (index == limbs_.size()) limbs_.push_back(0);
      carry += limbs_[index];
      limbs_[index] = static_cast<std::uint32_t>(carry);
      carry >>= 32U;
    }
  }

  std::uint32_t divideSmall(std::uint32_t divisor) {
    std::uint64_t remainder = 0;
    for (std::size_t index = limbs_.size(); index-- > 0;) {
      const std::uint64_t value = (remainder << 32U) | limbs_[index];
      limbs_[index] = static_cast<std::uint32_t>(value / divisor);
      remainder = value % divisor;
    }
    normalize();
    return static_cast<std::uint32_t>(remainder);
  }

  std::size_t bitLength() const {
    return limbs_.empty() ? 0 : (limbs_.size() - 1) * 32 + (32 - std::countl_zero(limbs_.back()));
  }

  bool bit(std::size_t index) const {
    const std::size_t limb = index / 32;
    return limb < limbs_.size() && ((limbs_[limb] >> (index % 32)) & 1U) != 0;
  }

  void setBit(std::size_t index) {
    limbs_.resize(std::max(limbs_.size(), index / 32 + 1), 0);
    limbs_[index / 32] |= std::uint32_t(1) << (index % 32);
  }

  void shiftLeftOne() {
    std::uint32_t carry = 0;
    for (auto& limb : limbs_) {
      const std::uint32_t next = limb >> 31U;
      limb = (limb << 1U) | carry;
      carry = next;
    }
    if (carry != 0) limbs_.push_back(carry);
  }

  static std::pair<BigInt, BigInt> divideAndRemainder(const BigInt& dividend, const BigInt& divisor) {
    if (divisor.isZero()) throw std::runtime_error("BigInt division by zero");
    const BigInt magnitudeDivisor = divisor.absolute();
    if (magnitudeDivisor.limbs_.size() == 1) {
      BigInt quotient = dividend.absolute();
      const std::uint32_t remainderValue = quotient.divideSmall(magnitudeDivisor.limbs_[0]);
      BigInt remainder(static_cast<long long>(remainderValue));
      quotient.negative_ = dividend.negative_ != divisor.negative_ && !quotient.isZero();
      remainder.negative_ = dividend.negative_ && !remainder.isZero();
      return {std::move(quotient), std::move(remainder)};
    }
    BigInt quotient;
    BigInt remainder;
    for (std::size_t index = dividend.bitLength(); index-- > 0;) {
      remainder.shiftLeftOne();
      if (dividend.bit(index)) remainder.addSmall(1);
      if (remainder.compareMagnitude(magnitudeDivisor) >= 0) {
        remainder.subtractMagnitude(magnitudeDivisor);
        quotient.setBit(index);
      }
    }
    quotient.negative_ = dividend.negative_ != divisor.negative_ && !quotient.isZero();
    remainder.negative_ = dividend.negative_ && !remainder.isZero();
    return {std::move(quotient), std::move(remainder)};
  }

  std::size_t toShiftCount() const {
    if (negative_) throw std::runtime_error("BigInt shift count must be non-negative");
    if (limbs_.size() > 2 || (limbs_.size() == 2 && limbs_[1] > 0)) {
      throw std::runtime_error("BigInt shift count is too large");
    }
    return limbs_.empty() ? 0 : limbs_[0];
  }

  void shiftLeft(std::size_t amount) {
    if (isZero() || amount == 0) return;
    const std::size_t whole = amount / 32;
    const unsigned partial = amount % 32;
    limbs_.insert(limbs_.begin(), whole, 0);
    if (partial == 0) return;
    std::uint32_t carry = 0;
    for (std::size_t index = whole; index < limbs_.size(); ++index) {
      const std::uint32_t next = limbs_[index] >> (32U - partial);
      limbs_[index] = (limbs_[index] << partial) | carry;
      carry = next;
    }
    if (carry != 0) limbs_.push_back(carry);
  }

  void shiftRight(std::size_t amount) {
    if (isZero() || amount == 0) return;
    const bool wasNegative = negative_;
    bool discarded = false;
    const std::size_t whole = amount / 32;
    const unsigned partial = amount % 32;
    for (std::size_t index = 0; index < std::min(whole, limbs_.size()); ++index) discarded |= limbs_[index] != 0;
    if (whole >= limbs_.size()) {
      discarded |= !isZero();
      limbs_.clear();
    } else {
      limbs_.erase(limbs_.begin(), limbs_.begin() + static_cast<std::ptrdiff_t>(whole));
      if (partial != 0) {
        discarded |= (limbs_[0] & ((std::uint32_t(1) << partial) - 1U)) != 0;
        std::uint32_t carry = 0;
        for (std::size_t index = limbs_.size(); index-- > 0;) {
          const std::uint32_t next = limbs_[index] << (32U - partial);
          limbs_[index] = (limbs_[index] >> partial) | carry;
          carry = next;
        }
      }
    }
    normalize();
    if (wasNegative && discarded) addSmall(1);
    negative_ = wasNegative && !isZero();
  }

  std::vector<std::uint32_t> twosComplement(std::size_t width) const {
    std::vector<std::uint32_t> result(width, 0);
    std::copy(limbs_.begin(), limbs_.end(), result.begin());
    if (!negative_) return result;
    for (auto& limb : result) limb = ~limb;
    std::uint64_t carry = 1;
    for (auto& limb : result) {
      carry += limb;
      limb = static_cast<std::uint32_t>(carry);
      carry >>= 32U;
    }
    return result;
  }

  static BigInt fromTwosComplement(std::vector<std::uint32_t> bits) {
    BigInt result;
    const bool negative = !bits.empty() && (bits.back() >> 31U) != 0;
    if (negative) {
      std::uint64_t carry = 1;
      for (auto& limb : bits) {
        carry += ~limb;
        limb = static_cast<std::uint32_t>(carry);
        carry >>= 32U;
      }
    }
    result.limbs_ = std::move(bits);
    result.negative_ = negative;
    result.normalize();
    return result;
  }

  BigInt& applyBitwise(const BigInt& other, char operation) {
    const std::size_t width = std::max(limbs_.size(), other.limbs_.size()) + 1;
    auto left = twosComplement(width);
    const auto right = other.twosComplement(width);
    for (std::size_t index = 0; index < width; ++index) {
      if (operation == '&') left[index] &= right[index];
      else if (operation == '|') left[index] |= right[index];
      else left[index] ^= right[index];
    }
    *this = fromTwosComplement(std::move(left));
    return *this;
  }
};

inline BigInt pow(BigInt base, BigInt exponent) {
  if (exponent.isNegative()) throw std::runtime_error("BigInt exponent must be non-negative");
  BigInt result(1);
  while (!exponent.isZero()) {
    if (exponent.isOdd()) result *= base;
    exponent.divideSmall(2);
    if (!exponent.isZero()) base *= base;
  }
  return result;
}

inline BigInt remainder(BigInt left, const BigInt& right) { return left %= right; }
inline bool Boolean(const BigInt& value) { return !value.isZero(); }

}  // namespace vexa
