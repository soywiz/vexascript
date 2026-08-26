#pragma once

// Internal runtime category header. Include runtime.hpp instead.

std::u16string jsonQuoted(const std::u16string& value);

template <typename T>
std::u16string jsonStringifyNative(const T& value, std::unordered_set<const void*>& seen) {
  using Native = std::remove_cvref_t<T>;
  if constexpr (std::is_same_v<Native, Value>) {
    if (value.isUndefined()) return u"null";
    if (value.isNull()) return u"null";
    if (value.isBoolean()) return value.boolean() ? u"true" : u"false";
    if (value.isNumber()) return numberToString(value.number());
    if (value.isBigInt()) throw runtimeError(u"Do not know how to serialize a BigInt");
    if (value.isString()) return jsonQuoted(value.string());
    if (value.isRecord()) {
      auto* record = value.record();
      if (!seen.insert(record).second) throw runtimeError(u"Converting circular structure to JSON");
      std::u16string output = u"{";
      bool first = true;
      for (const auto& key : record->keys()) {
        const Value property = record->get(key);
        if (property.isUndefined() || (property.isRuntimeObject() && property.object()->dynamicToString() == u"function")) {
          continue;
        }
        if (!first) output += u',';
        first = false;
        output += jsonQuoted(key);
        output += u':';
        output += jsonStringifyNative(property, seen);
      }
      output += u'}';
      seen.erase(record);
      return output;
    }
    auto serialized = value.object()->dynamicJsonStringify(seen);
    return serialized.value_or(u"{}");
  } else if constexpr (std::is_same_v<Native, std::u16string>) {
    return jsonQuoted(value);
  } else if constexpr (std::is_same_v<Native, BigInt>) {
    throw runtimeError(u"Do not know how to serialize a BigInt");
  } else if constexpr (std::is_same_v<Native, bool>) {
    return value ? u"true" : u"false";
  } else if constexpr (std::is_arithmetic_v<Native>) {
    return numberToString(static_cast<double>(value));
  } else if constexpr (std::is_pointer_v<Native>) {
    if (!value) return u"null";
    if constexpr (std::is_base_of_v<BaseObject, std::remove_pointer_t<Native>>) {
      return value->dynamicJsonStringify(seen).value_or(u"{}");
    } else {
      return u"{}";
    }
  } else {
    return u"{}";
  }
}

Value jsonStringify(const Value& value);

class JsonParser final {
 public:
  explicit JsonParser(std::u16string_view source);

  Value parse();

 private:
  [[noreturn]] void fail(const std::u16string& message) const;

  void skipWhitespace();

  bool consume(std::u16string_view text);

  std::uint32_t parseHexCodeUnit();

  void appendCodePoint(std::u16string& result, std::uint32_t codePoint);

  Value parseValue();

  std::u16string parseString();

  double parseNumber();

  ArrayObject<Value>* parseArray();

  RecordObject* parseObject();

  std::u16string_view source_;
  std::size_t position_ = 0;
};

Value jsonParse(const Value& source);
