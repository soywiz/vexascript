#pragma once

// Internal runtime category header. Include runtime.hpp instead.

template <typename T, typename Executor>
inline Task<T> createTask(Executor executor) {
  return Task<T>::create(std::move(executor));
}

Runtime::TimerId setTimeout(Runtime::TimerCallback callback, double delay = 0);

Runtime::TimerId setInterval(Runtime::TimerCallback callback, double delay = 0);

void clearTimeout(Runtime::TimerId id);
void clearInterval(Runtime::TimerId id);
void clearTimeout(const Value& id);
void clearInterval(const Value& id);

Value call(const Value& callable, std::initializer_list<Value> arguments);

Value callOptional(const Value& callable, std::initializer_list<Value> arguments);

std::u16string typeOf(const Value& value);
std::u16string typeOf(double);
std::u16string typeOf(const BigInt&);
std::u16string typeOf(bool);
std::u16string typeOf(const std::u16string&);
