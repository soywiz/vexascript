#include "runtime.hpp"

namespace vexa {

const Console console;

void Console::log(std::initializer_list<Value> arguments) const {
    write(std::cout, arguments);
  }

void Console::info(std::initializer_list<Value> arguments) const {
    write(std::cout, arguments);
  }

void Console::warn(std::initializer_list<Value> arguments) const {
    write(std::cerr, arguments);
  }

void Console::error(std::initializer_list<Value> arguments) const {
    write(std::cerr, arguments);
  }

void Console::write(std::ostream& output, std::initializer_list<Value> arguments) {
    bool first = true;
    for (const auto& argument : arguments) {
      if (!first) output << ' ';
      first = false;
      print(output, argument);
    }
    output << '\n';
  }

void Console::print(std::ostream& output, const Value& value) { output << utf16ToUtf8(inspectValue(value)); }

void Console::print(std::ostream& output, const std::u16string& value) { output << utf16ToUtf8(value); }

void Console::print(std::ostream& output, bool value) { output << (value ? "true" : "false"); }

void Console::print(std::ostream& output, double value) { output << utf16ToUtf8(numberToString(value)); }

void Console::print(std::ostream& output, float value) { output << utf16ToUtf8(numberToString(value)); }

void Console::print(std::ostream& output, const BigInt& value) { output << utf16ToUtf8(inspectValue(value)); }

}  // namespace vexa
