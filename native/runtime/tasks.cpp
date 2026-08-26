#include "runtime.hpp"

namespace vexa {

void ReturnSignal<void>::value() const {}

const std::u16string& LabeledBreakSignal::label() const { return label_; }

const std::u16string& LabeledContinueSignal::label() const { return label_; }

const Value& RejectedValue::reason() const { return reason_; }

Task<void> Task<void>::promise_type::get_return_object() { return Task(state); }

std::suspend_never Task<void>::promise_type::initial_suspend() const noexcept { return {}; }

std::suspend_never Task<void>::promise_type::final_suspend() const noexcept { return {}; }

void Task<void>::promise_type::return_void() { resolve(state); }

void Task<void>::promise_type::unhandled_exception() { reject(state, std::current_exception()); }

Task<void>::Task() = default;

bool Task<void>::Awaiter::await_ready() const noexcept { return state_->settled; }

void Task<void>::Awaiter::await_suspend(std::coroutine_handle<> continuation) {
      onSettled(state_, [continuation]() mutable { continuation.resume(); });
    }

void Task<void>::Awaiter::await_resume() const {
      if (state_->error) std::rethrow_exception(state_->error);
    }

void Task<void>::get() const {
    Runtime::runUntil([this] { return state_->settled; });
    if (state_->error) std::rethrow_exception(state_->error);
  }

Task<void>::Awaiter Task<void>::operator co_await() const { return Awaiter(state_); }

void Task<void>::whenSettled(std::function<void()> continuation) const {
    onSettled(state_, std::move(continuation));
  }

void Task<void>::settledValue() const {
    if (!state_->settled) throw runtimeError(u"Promise is not settled");
    if (state_->error) std::rethrow_exception(state_->error);
  }

std::exception_ptr Task<void>::settledError() const { return state_->error; }

void Task<void>::Resolver::operator()() const { resolve(state_); }

void Task<void>::Rejecter::operator()() const {
      reject(state_, std::make_exception_ptr(runtimeError(u"Promise rejected")));
    }

void Task<void>::Rejecter::operator()(const Error& error) const {
      reject(state_, std::make_exception_ptr(RejectedValue(Runtime::string(error.messageText()))));
    }

TaskStateHandle<Task<void>::State> Task<void>::makeState() {
    return TaskStateHandle<State>();
  }

void Task<void>::resolve(const TaskStateHandle<State>& state) {
    if (state->settled) return;
    state->settled = true;
    notify(state);
  }

void Task<void>::reject(const TaskStateHandle<State>& state, std::exception_ptr error) {
    if (state->settled) return;
    state->error = std::move(error);
    state->settled = true;
    notify(state);
  }

void Task<void>::onSettled(const TaskStateHandle<State>& state, std::function<void()> continuation) {
    if (state->settled) Runtime::enqueueMicrotask(std::move(continuation));
    else state->continuations.push_back(std::move(continuation));
  }

void Task<void>::notify(const TaskStateHandle<State>& state) {
    for (auto& continuation : state->continuations) {
      Runtime::enqueueMicrotask(std::move(continuation));
    }
    state->continuations.clear();
  }


LabeledBreakSignal::LabeledBreakSignal(std::u16string label) : label_(std::move(label)) {}

LabeledContinueSignal::LabeledContinueSignal(std::u16string label) : label_(std::move(label)) {}

RejectedValue::RejectedValue(Value reason) : reason_(std::move(reason)) {}

Task<void>::promise_type::promise_type() : state(makeState()) {}

Task<void>::Awaiter::Awaiter(TaskStateHandle<State> state) : state_(std::move(state)) {}

Task<void>::Resolver::Resolver(TaskStateHandle<State> state) : state_(std::move(state)) {}

Task<void>::Rejecter::Rejecter(TaskStateHandle<State> state) : state_(std::move(state)) {}

Task<void>::Task(TaskStateHandle<State> state) : state_(std::move(state)) {}
}  // namespace vexa
