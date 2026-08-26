#pragma once

// Internal runtime category header. Include runtime.hpp instead.

ArrayObject<Value>* regexExec(const RegExp& expression, const std::u16string& value);

ArrayObject<Value>* regexExec(const RegExp& expression, const Value& value);

ArrayObject<Value>* stringMatch(const std::u16string& value, const RegExp& expression);

ArrayObject<ArrayObject<Value>*>* stringMatchAll(
    const std::u16string& value,
    const RegExp& expression);

double stringSearch(const std::u16string& value, const RegExp& expression);
