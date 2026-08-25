#include "Arduino.h"
#include "EEPROM.h"

#include <cstdio>
#include <cstring>

extern void setup();
extern void loop();
namespace {
constexpr uint32_t kPinCount = 48;
constexpr uint32_t kAdcBits = 12;
constexpr uint32_t kAdcMaximum = (1u << kAdcBits) - 1u;
// One slot remains empty to distinguish full from empty, leaving 65,536 bytes
// of payload capacity at the ABI boundary.
constexpr uint32_t kSerialCapacity = 64 * 1024 + 1;
constexpr uint32_t kEepromCapacity = 64 * 1024;
constexpr uint64_t kNoEvent = UINT64_MAX;
constexpr uint64_t kLoopQuantumUs = 1000;
constexpr int32_t kStatusResetRequested = 1;
constexpr int32_t kStatusSerialTxOverflow = 2;

uint64_t nowUs = 0;
uint64_t elapsedSinceTakeUs = 0;
uint8_t pinModes[kPinCount]{};
uint8_t pinLevels[kPinCount]{};
uint16_t analogInputs[kPinCount]{};
uint64_t activeMicros[kPinCount]{};

uint8_t serialRx[kSerialCapacity]{};
uint32_t serialRxRead = 0;
uint32_t serialRxWrite = 0;
uint8_t serialTx[kSerialCapacity]{};
uint32_t serialTxRead = 0;
uint32_t serialTxWrite = 0;
bool serialTxOverflow = false;
uint32_t serialInstanceCount = 0;
uint32_t commandSerialRxPin = UINT32_MAX;
uint32_t commandSerialTxPin = UINT32_MAX;

uint8_t eeprom[kEepromCapacity]{};
uint32_t activeEepromCapacity = kEepromCapacity;
bool eepromInitialized = false;
bool booted = false;
bool resetRequested = false;
uint32_t resetCount = 0;

struct TimerState {
  bool running = false;
  uint64_t periodUs = 10000;
  uint64_t cycleStartUs = 0;
  uint64_t nextUpdateUs = kNoEvent;
  uint64_t nextCompareUs = kNoEvent;
  uint32_t compare8 = 0;
  TimerCallback updateCallback = nullptr;
  TimerCallback compareCallback = nullptr;
} timer;

bool validPin(uint32_t pin) { return pin < kPinCount; }

uint32_t ringSize(uint32_t read, uint32_t write) {
  return write >= read ? write - read : kSerialCapacity - read + write;
}

bool ringPush(uint8_t* buffer, uint32_t& read, uint32_t& write, uint8_t value) {
  const uint32_t next = (write + 1) % kSerialCapacity;
  if (next == read) return false;
  buffer[write] = value;
  write = next;
  return true;
}

bool ringPop(const uint8_t* buffer, uint32_t& read, uint32_t write, uint8_t& value) {
  if (read == write) return false;
  value = buffer[read];
  read = (read + 1) % kSerialCapacity;
  return true;
}

void advanceClock(uint64_t targetUs) {
  const uint64_t delta = targetUs - nowUs;
  for (uint32_t pin = 0; pin < kPinCount; ++pin) {
    if (pinLevels[pin] == HIGH) activeMicros[pin] += delta;
  }
  nowUs = targetUs;
  elapsedSinceTakeUs += delta;
}

void scheduleCompare() {
  if (!timer.running || timer.compare8 >= 255) {
    timer.nextCompareUs = kNoEvent;
    return;
  }
  const uint64_t offset = (timer.periodUs * timer.compare8) / 255;
  const uint64_t candidate = timer.cycleStartUs + offset;
  timer.nextCompareUs = candidate > nowUs ? candidate : kNoEvent;
}

void loopBurst() {
  loop();
  if (resetRequested || serialTxOverflow) return;
  for (uint32_t iteration = 0; iteration < 1024 && serialRxRead != serialRxWrite; ++iteration) {
    loop();
    if (resetRequested || serialTxOverflow) break;
  }
}

void resetVolatileRuntime() {
  nowUs = 0;
  elapsedSinceTakeUs = 0;
  std::memset(pinModes, 0, sizeof(pinModes));
  std::memset(activeMicros, 0, sizeof(activeMicros));
  serialTxRead = serialTxWrite = 0;
  serialTxOverflow = false;
  timer = TimerState{};
  resetRequested = false;
}
}  // namespace

TIM_TypeDef fil_tim2;
EEPROMClass EEPROM;

uint32_t millis() { return static_cast<uint32_t>(nowUs / 1000); }
uint32_t micros() { return static_cast<uint32_t>(nowUs); }

void delay(uint32_t) {
  // ABI v1 deliberately rejects blocking delay() at source capture. Trap if a
  // fixed dependency reaches it so timer callbacks/budgets are never bypassed.
  __builtin_trap();
}

void analogReadResolution(int bits) {
  // ABI v1 deliberately supports the exact STM32F1 sketch, which requests the
  // native 12-bit output consumed by its hard-coded 4095 NTC full scale.
  if (bits != static_cast<int>(kAdcBits)) __builtin_trap();
}

int analogRead(uint32_t pin) {
  if (!validPin(pin)) return 0;
  return static_cast<int>(analogInputs[pin]);
}

void pinMode(uint32_t pin, uint32_t mode) {
  if (validPin(pin)) pinModes[pin] = static_cast<uint8_t>(mode);
}

void digitalWrite(uint32_t pin, uint32_t level) {
  if (validPin(pin)) pinLevels[pin] = level == LOW ? LOW : HIGH;
}

int digitalRead(uint32_t pin) { return validPin(pin) ? pinLevels[pin] : LOW; }

void HAL_NVIC_SystemReset() {
  ++resetCount;
  resetRequested = true;
}

HardwareSerial::HardwareSerial(uint32_t rxPin, uint32_t txPin) : rxPin_(rxPin), txPin_(txPin) {
  ++serialInstanceCount;
  if (serialInstanceCount == 1) {
    commandSerialRxPin = rxPin;
    commandSerialTxPin = txPin;
  }
}
void HardwareSerial::begin(uint32_t baudRate) { baudRate_ = baudRate; }
HardwareSerial::operator bool() const { return baudRate_ > 0; }
int HardwareSerial::available() const { return static_cast<int>(ringSize(serialRxRead, serialRxWrite)); }
int HardwareSerial::read() {
  uint8_t value = 0;
  return ringPop(serialRx, serialRxRead, serialRxWrite, value) ? value : -1;
}
size_t HardwareSerial::write(uint8_t value) {
  if (ringPush(serialTx, serialTxRead, serialTxWrite, value)) return 1;
  serialTxOverflow = true;
  return 0;
}
size_t HardwareSerial::write(const uint8_t* data, size_t length) {
  size_t written = 0;
  while (written < length && write(data[written]) == 1) ++written;
  return written;
}
size_t HardwareSerial::print(const char* value) {
  return value == nullptr ? 0 : write(reinterpret_cast<const uint8_t*>(value), std::strlen(value));
}
size_t HardwareSerial::print(char value) { return write(static_cast<uint8_t>(value)); }
size_t HardwareSerial::print(int value) { return print(static_cast<long>(value)); }
size_t HardwareSerial::print(unsigned int value) { return print(static_cast<unsigned long>(value)); }
size_t HardwareSerial::print(long value) {
  char text[32];
  std::snprintf(text, sizeof(text), "%ld", value);
  return print(text);
}
size_t HardwareSerial::print(unsigned long value) {
  char text[32];
  std::snprintf(text, sizeof(text), "%lu", value);
  return print(text);
}
size_t HardwareSerial::print(float value, int digits) { return print(static_cast<double>(value), digits); }
size_t HardwareSerial::print(double value, int digits) {
  char format[8];
  char text[64];
  std::snprintf(format, sizeof(format), "%%.%df", constrain(digits, 0, 9));
  std::snprintf(text, sizeof(text), format, value);
  return print(text);
}
size_t HardwareSerial::println() { return print('\n'); }
size_t HardwareSerial::println(const char* value) { return print(value) + println(); }

HardwareTimer::HardwareTimer(TIM_TypeDef*) {}
void HardwareTimer::setOverflow(uint32_t overflow, int) { timer.periodUs = max<uint64_t>(1, overflow); }
void HardwareTimer::attachInterrupt(TimerCallback callback) { timer.updateCallback = callback; }
void HardwareTimer::setCaptureCompare(uint32_t, uint32_t value, int) {
  timer.compare8 = min<uint32_t>(value, 255);
  scheduleCompare();
}
void HardwareTimer::attachInterrupt(uint32_t, TimerCallback callback) { timer.compareCallback = callback; }
void HardwareTimer::resume() {
  if (!timer.running) {
    timer.running = true;
    timer.cycleStartUs = nowUs;
    timer.nextUpdateUs = nowUs + timer.periodUs;
  }
  scheduleCompare();
}

uint8_t EEPROMClass::read(int address) const {
  return address >= 0 && static_cast<uint32_t>(address) < activeEepromCapacity ? eeprom[address]
                                                                                : 0xff;
}
void EEPROMClass::write(int address, uint8_t value) {
  if (address >= 0 && static_cast<uint32_t>(address) < activeEepromCapacity) {
    eeprom[address] = value;
  }
}

#define FIL_EXPORT extern "C" __attribute__((used, visibility("default")))

FIL_EXPORT int32_t fil_abi_version() { return 1; }
FIL_EXPORT void* fil_alloc(uint32_t length) { return std::malloc(length); }
FIL_EXPORT void fil_free(void* pointer) { std::free(pointer); }

FIL_EXPORT int32_t fil_set_analog_input(uint32_t pin, uint32_t adc) {
  if (!validPin(pin) || adc > kAdcMaximum) return -1;
  analogInputs[pin] = static_cast<uint16_t>(adc);
  return 0;
}

FIL_EXPORT int32_t fil_set_digital_input(uint32_t pin, uint32_t level) {
  if (!validPin(pin)) return -1;
  pinLevels[pin] = level == 0 ? LOW : HIGH;
  return 0;
}

FIL_EXPORT int32_t fil_load_eeprom(const uint8_t* data, uint32_t length) {
  if (data == nullptr || length == 0 || length > kEepromCapacity) return -1;
  std::memset(eeprom, 0xff, sizeof(eeprom));
  std::memcpy(eeprom, data, length);
  activeEepromCapacity = length;
  eepromInitialized = true;
  return static_cast<int32_t>(length);
}

FIL_EXPORT int32_t fil_boot() {
  if (booted) return -1;
  resetVolatileRuntime();
  if (!eepromInitialized) {
    std::memset(eeprom, 0xff, sizeof(eeprom));
    activeEepromCapacity = kEepromCapacity;
    eepromInitialized = true;
  }
  setup();
  booted = true;
  if (serialTxOverflow) return kStatusSerialTxOverflow;
  return resetRequested ? kStatusResetRequested : 0;
}

FIL_EXPORT int32_t fil_advance(uint32_t deltaUs) {
  if (!booted) return -1;
  if (serialTxOverflow) return kStatusSerialTxOverflow;
  const uint64_t endUs = nowUs + deltaUs;
  while (nowUs < endUs && !resetRequested && !serialTxOverflow) {
    uint64_t nextUs = min<uint64_t>(endUs, nowUs + kLoopQuantumUs);
    nextUs = min(nextUs, timer.nextUpdateUs);
    nextUs = min(nextUs, timer.nextCompareUs);
    advanceClock(nextUs);

    if (timer.nextUpdateUs == nowUs) {
      timer.cycleStartUs = nowUs;
      timer.nextUpdateUs = nowUs + timer.periodUs;
      if (timer.updateCallback != nullptr) timer.updateCallback();
      if (timer.compare8 == 0) {
        timer.nextCompareUs = kNoEvent;
        if (timer.compareCallback != nullptr) timer.compareCallback();
      } else {
        scheduleCompare();
      }
    }
    if (serialTxOverflow) break;
    if (timer.nextCompareUs == nowUs) {
      timer.nextCompareUs = kNoEvent;
      if (timer.compareCallback != nullptr) timer.compareCallback();
    }
    if (serialTxOverflow) break;
    loopBurst();
  }
  if (serialTxOverflow) return kStatusSerialTxOverflow;
  return resetRequested ? kStatusResetRequested : 0;
}

FIL_EXPORT int32_t fil_enqueue_serial(const uint8_t* data, uint32_t length) {
  if (data == nullptr) return -1;
  uint32_t written = 0;
  while (written < length && ringPush(serialRx, serialRxRead, serialRxWrite, data[written])) ++written;
  return static_cast<int32_t>(written);
}

FIL_EXPORT int32_t fil_drain_serial(uint8_t* output, uint32_t capacity) {
  if (output == nullptr) return -1;
  uint32_t count = 0;
  while (count < capacity && ringPop(serialTx, serialTxRead, serialTxWrite, output[count])) ++count;
  return static_cast<int32_t>(count);
}

FIL_EXPORT int32_t fil_get_pin_level(uint32_t pin) {
  if (!validPin(pin)) return -1;
  if (pinModes[pin] != OUTPUT) return -2;
  return pinLevels[pin];
}

// ABI v1 supports one command UART. -1 means absent; -2 means ambiguous/multiple.
FIL_EXPORT int32_t fil_get_serial_rx_pin() {
  if (serialInstanceCount == 0) return -1;
  if (serialInstanceCount != 1) return -2;
  return validPin(commandSerialRxPin) ? static_cast<int32_t>(commandSerialRxPin) : -3;
}

FIL_EXPORT int32_t fil_get_serial_tx_pin() {
  if (serialInstanceCount == 0) return -1;
  if (serialInstanceCount != 1) return -2;
  return validPin(commandSerialTxPin) ? static_cast<int32_t>(commandSerialTxPin) : -3;
}

FIL_EXPORT uint32_t fil_take_active_micros(uint32_t pin) {
  if (!validPin(pin)) return 0;
  const uint32_t value = static_cast<uint32_t>(min<uint64_t>(activeMicros[pin], UINT32_MAX));
  activeMicros[pin] = 0;
  return value;
}

FIL_EXPORT uint32_t fil_take_elapsed_micros() {
  const uint32_t value = static_cast<uint32_t>(min<uint64_t>(elapsedSinceTakeUs, UINT32_MAX));
  elapsedSinceTakeUs = 0;
  return value;
}

FIL_EXPORT uint32_t fil_get_reset_count() { return resetCount; }

FIL_EXPORT int32_t fil_dump_eeprom(uint8_t* output, uint32_t capacity) {
  if (output == nullptr) return -1;
  const uint32_t count = min<uint32_t>(capacity, activeEepromCapacity);
  std::memcpy(output, eeprom, count);
  return static_cast<int32_t>(count);
}
