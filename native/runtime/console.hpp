#pragma once

// Internal runtime category header. Include runtime.hpp instead.

class Console final {
 public:
  void log(std::initializer_list<Value> arguments) const {
    write(std::cout, arguments);
  }

  void info(std::initializer_list<Value> arguments) const {
    write(std::cout, arguments);
  }

  void warn(std::initializer_list<Value> arguments) const {
    write(std::cerr, arguments);
  }

  void error(std::initializer_list<Value> arguments) const {
    write(std::cerr, arguments);
  }

  template <typename... Arguments>
  void log(const Arguments&... arguments) const {
    write(std::cout, arguments...);
  }

  template <typename... Arguments>
  void info(const Arguments&... arguments) const {
    write(std::cout, arguments...);
  }

  template <typename... Arguments>
  void warn(const Arguments&... arguments) const {
    write(std::cerr, arguments...);
  }

  template <typename... Arguments>
  void error(const Arguments&... arguments) const {
    write(std::cerr, arguments...);
  }

 private:
  static void write(std::ostream& output, std::initializer_list<Value> arguments) {
    bool first = true;
    for (const auto& argument : arguments) {
      if (!first) output << ' ';
      first = false;
      print(output, argument);
    }
    output << '\n';
  }

  static void print(std::ostream& output, const Value& value) { output << utf16ToUtf8(toString(value)); }
  static void print(std::ostream& output, const std::u16string& value) { output << utf16ToUtf8(value); }
  static void print(std::ostream& output, bool value) { output << (value ? "true" : "false"); }
  static void print(std::ostream& output, double value) { output << utf16ToUtf8(numberToString(value)); }
  static void print(std::ostream& output, float value) { output << utf16ToUtf8(numberToString(value)); }

  template <typename T>
  static void print(std::ostream& output, ArrayObject<T>* values) {
    output << utf16ToUtf8(toString(values));
  }

  template <typename T>
  static void print(std::ostream& output, const cppgc::Member<ArrayObject<T>>& values) {
    output << utf16ToUtf8(toString(values));
  }

  template <typename T>
  static void print(std::ostream& output, const cppgc::Persistent<ArrayObject<T>>& values) {
    output << utf16ToUtf8(toString(values));
  }

  template <typename T>
  static void print(std::ostream& output, const T& value) {
    output << value;
  }

  template <typename T>
  static void print(std::ostream& output, const std::vector<T>& values) {
    output << '[';
    for (std::size_t index = 0; index < values.size(); ++index) {
      if (index > 0) output << ", ";
      print(output, values[index]);
    }
    output << ']';
  }

  template <typename... Arguments>
  static void write(std::ostream& output, const Arguments&... arguments) {
    bool first = true;
    const auto printArgument = [&](const auto& argument) {
      if (!first) output << ' ';
      first = false;
      print(output, argument);
    };
    (printArgument(arguments), ...);
    output << '\n';
  }
};

inline const Console console;
