#include "runtime.hpp"

namespace vexa {

std::shared_ptr<OilpanPlatform> Runtime::platform_;
std::unique_ptr<cppgc::Heap> Runtime::heap_;
std::u16string Runtime::sourceFile_;
std::size_t Runtime::sourceLine_ = 0;
std::size_t Runtime::sourceColumn_ = 0;
std::size_t Runtime::statementsUntilCollection_ = 0;
Runtime::TimerId Runtime::nextTimerId_ = 1;
std::deque<Runtime::TimerCallback> Runtime::microtasks_;
std::vector<Runtime::IoPoller> Runtime::ioPollers_;
std::vector<cppgc::Persistent<StringObject>> Runtime::literalStrings_;
std::unordered_map<Runtime::TimerId, Runtime::TimerState> Runtime::timers_;
std::priority_queue<Runtime::ScheduledTimer, std::vector<Runtime::ScheduledTimer>, Runtime::EarlierTimer>
    Runtime::scheduledTimers_;

void Runtime::initialize(std::size_t suggestedInitialHeapSizeBytes) {
    if (heap_) return;
    platform_ = std::make_shared<OilpanPlatform>();
    cppgc::InitializeProcess(platform_->GetPageAllocator());
    cppgc::Heap::HeapOptions options;
    options.marking_support = cppgc::Heap::MarkingType::kAtomic;
    options.sweeping_support = cppgc::Heap::SweepingType::kAtomic;
    options.stack_support = cppgc::Heap::StackSupport::kSupportsConservativeStackScan;
    options.stack_start_marker.emplace();
    if (const auto configuredInitialHeapSize = initialHeapSizeBytes()) {
      options.resource_constraints.initial_heap_size_bytes = *configuredInitialHeapSize;
    } else if (suggestedInitialHeapSizeBytes > 0) {
      options.resource_constraints.initial_heap_size_bytes = suggestedInitialHeapSizeBytes;
    }
    heap_ = cppgc::Heap::Create(platform_, std::move(options));
  }

void Runtime::shutdown() {
    timers_.clear();
    while (!scheduledTimers_.empty()) scheduledTimers_.pop();
    microtasks_.clear();
    ioPollers_.clear();
    literalStrings_.clear();
    heap_.reset();
    cppgc::ShutdownProcess();
    platform_.reset();
  }

Value Runtime::string(std::u16string value) {
    initialize();
    return Value(cppgc::MakeGarbageCollected<StringObject>(
        heap_->GetAllocationHandle(), std::move(value)));
  }

Value Runtime::concatStrings(StringObject* left, StringObject* right) {
    initialize();
    if (left->size() == 0) return Value(right);
    if (right->size() == 0) return Value(left);
    return Value(cppgc::MakeGarbageCollected<StringObject>(
        heap_->GetAllocationHandle(), left, right));
  }

StringObject* Runtime::retainLiteralString(std::u16string value) {
    initialize();
    auto* literal = cppgc::MakeGarbageCollected<StringObject>(
        heap_->GetAllocationHandle(), std::move(value));
    literalStrings_.emplace_back(literal);
    return literal;
  }

void Runtime::reserveLiterals(std::size_t count) { literalStrings_.reserve(count); }

RecordObject* Runtime::record(
      std::initializer_list<std::pair<std::u16string, Value>> properties) {
    auto* result = make<RecordObject>();
    for (const auto& [key, value] : properties) result->set(key, value);
    return result;
  }

cppgc::Heap& Runtime::heap() {
    initialize();
    return *heap_;
  }

void Runtime::setSourceLocation(std::u16string file, std::size_t line, std::size_t column) {
    sourceFile_ = std::move(file);
    sourceLine_ = line;
    sourceColumn_ = column;
  }

std::u16string Runtime::sourceLocation() {
    if (sourceFile_.empty()) return u"";
    return sourceFile_ + u":" + formatIntegerText(sourceLine_) +
        u":" + formatIntegerText(sourceColumn_);
  }

std::runtime_error Runtime::errorAtCurrentSource(std::u16string message) {
    const auto location = sourceLocation();
    if (!location.empty()) message += u" at " + location;
    return runtimeError(message);
  }

void Runtime::collectGarbageIfStressed() {
#if defined(VEXA_NATIVE_GC_STRESS)
    if (++statementsUntilCollection_ >= 8) {
      statementsUntilCollection_ = 0;
      heap_->ForceGarbageCollectionSlow(
          "VexaScript native statement", "VEXA_NATIVE_GC_STRESS",
          cppgc::Heap::StackState::kMayContainHeapPointers);
    }
#endif
  }

Runtime::TimerId Runtime::setTimeout(TimerCallback callback, double delay) {
    return scheduleTimer(std::move(callback), delay, false);
  }

Runtime::TimerId Runtime::setInterval(TimerCallback callback, double delay) {
    return scheduleTimer(std::move(callback), delay, true);
  }

void Runtime::clearTimeout(TimerId id) { timers_.erase(id); }

void Runtime::clearInterval(TimerId id) { timers_.erase(id); }

void Runtime::clearTimeout(const Value& id) { clearTimeout(static_cast<TimerId>(Number(id))); }

void Runtime::clearInterval(const Value& id) { clearInterval(static_cast<TimerId>(Number(id))); }

void Runtime::runEventLoop() {
    while (runOneEvent()) {}
  }

void Runtime::enqueueMicrotask(TimerCallback callback) {
    microtasks_.push_back(std::move(callback));
  }

void Runtime::enqueueIo(IoPoller poller) {
    ioPollers_.push_back(std::move(poller));
  }

bool Runtime::EarlierTimer::operator()(const ScheduledTimer& left, const ScheduledTimer& right) const {
      if (left.due != right.due) return left.due > right.due;
      return left.id > right.id;
    }

Runtime::Clock::time_point Runtime::deadline(double delay) {
    const auto milliseconds = std::chrono::duration<double, std::milli>(std::max(0.0, delay));
    return Clock::now() + std::chrono::duration_cast<Clock::duration>(milliseconds);
  }

Runtime::TimerId Runtime::scheduleTimer(TimerCallback callback, double delay, bool repeating) {
    const TimerId id = nextTimerId_++;
    timers_.emplace(id, TimerState{std::move(callback), delay, repeating});
    scheduledTimers_.push({deadline(delay), id});
    return id;
  }

bool Runtime::runOneEvent() {
    if (!microtasks_.empty()) {
      TimerCallback callback = std::move(microtasks_.front());
      microtasks_.pop_front();
      callback();
      return true;
    }

    for (auto poller = ioPollers_.begin(); poller != ioPollers_.end(); ++poller) {
      if (!(*poller)()) continue;
      ioPollers_.erase(poller);
      return true;
    }

    while (!scheduledTimers_.empty()) {
      const ScheduledTimer scheduled = scheduledTimers_.top();
      scheduledTimers_.pop();
      auto timer = timers_.find(scheduled.id);
      if (timer == timers_.end()) continue;

      const auto now = Clock::now();
      if (scheduled.due > now && !ioPollers_.empty()) {
        scheduledTimers_.push(scheduled);
        std::this_thread::sleep_for(std::min(
            std::chrono::milliseconds(1),
            std::chrono::duration_cast<std::chrono::milliseconds>(scheduled.due - now)));
        return true;
      }
      if (scheduled.due > now) std::this_thread::sleep_until(scheduled.due);

      TimerCallback callback = timer->second.callback;
      const bool repeating = timer->second.repeating;
      if (!repeating) timers_.erase(timer);
      callback();

      timer = timers_.find(scheduled.id);
      if (repeating && timer != timers_.end()) {
        scheduledTimers_.push({deadline(timer->second.delay), scheduled.id});
      }
      return true;
    }
    if (!ioPollers_.empty()) {
      std::this_thread::sleep_for(std::chrono::milliseconds(1));
      return true;
    }
    return false;
  }

}  // namespace vexa
