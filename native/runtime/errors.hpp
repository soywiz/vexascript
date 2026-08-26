#pragma once

// Internal runtime category header. Include runtime.hpp instead.

class Error {
 public:
  explicit Error(
      const Value& value,
      std::u16string name = u"Error",
      Value cause = Value::undefined(),
      Value errors = Value::undefined());
  explicit Error(std::u16string value);

  const std::u16string& messageText() const;
  const std::u16string& nameText() const;
  std::u16string stackText() const;
  const Value& cause() const;
  const Value& errors() const;

 private:
  std::u16string message_;
  std::u16string name_;
  Value cause_;
  Value errors_;
};
