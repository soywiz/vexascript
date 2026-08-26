#include "runtime.hpp"

namespace vexa {

double valueOf(double value) { return value; }

bool valueOf(bool value) { return value; }

const BigInt& valueOf(const BigInt& value) { return value; }

const std::u16string& valueOf(const std::u16string& value) { return value; }

const Value& valueOf(const Value& value) { return value; }

std::u16string toLocaleString(const BigInt& value) { return value.toString(); }

}  // namespace vexa
