#pragma once

#include <cmath>
#include <cstddef>
#include <cstdint>
#include <cstdlib>

#define ARDUINO 10819
#define HIGH 1
#define LOW 0
#define INPUT 0
#define OUTPUT 1
#define INPUT_PULLUP 2
#define MICROSEC_FORMAT 1
#define RESOLUTION_8B_COMPARE_FORMAT 2
#define F(value) value

using byte = uint8_t;
using boolean = bool;

template <typename T>
constexpr T constrain(T value, T minimum, T maximum) {
  return value < minimum ? minimum : value > maximum ? maximum : value;
}

template <typename T>
constexpr T min(T left, T right) {
  return left < right ? left : right;
}

template <typename T>
constexpr T max(T left, T right) {
  return left > right ? left : right;
}

using std::abs;
using std::fabs;

enum : uint16_t {
  PA0 = 0, PA1, PA2, PA3, PA4, PA5, PA6, PA7, PA8, PA9, PA10, PA11, PA12, PA13, PA14, PA15,
  PB0 = 16, PB1, PB2, PB3, PB4, PB5, PB6, PB7, PB8, PB9, PB10, PB11, PB12, PB13, PB14, PB15,
  PC0 = 32, PC1, PC2, PC3, PC4, PC5, PC6, PC7, PC8, PC9, PC10, PC11, PC12, PC13, PC14, PC15,
};

using TimerCallback = void (*)();

struct TIM_TypeDef {};
extern TIM_TypeDef fil_tim2;
#define TIM2 (&fil_tim2)

uint32_t millis();
uint32_t micros();
void delay(uint32_t milliseconds);
void analogReadResolution(int bits);
int analogRead(uint32_t pin);
void pinMode(uint32_t pin, uint32_t mode);
void digitalWrite(uint32_t pin, uint32_t level);
int digitalRead(uint32_t pin);
void HAL_NVIC_SystemReset();

class HardwareSerial {
 public:
  HardwareSerial(uint32_t rxPin, uint32_t txPin);
  void begin(uint32_t baudRate);
  explicit operator bool() const;
  int available() const;
  int read();
  size_t write(uint8_t value);
  size_t write(const uint8_t* data, size_t length);
  size_t print(const char* value);
  size_t print(char value);
  size_t print(int value);
  size_t print(unsigned int value);
  size_t print(long value);
  size_t print(unsigned long value);
  size_t print(float value, int digits = 2);
  size_t print(double value, int digits = 2);
  size_t println();
  size_t println(const char* value);

 private:
  uint32_t rxPin_;
  uint32_t txPin_;
  uint32_t baudRate_ = 0;
};

class HardwareTimer {
 public:
  explicit HardwareTimer(TIM_TypeDef* timer);
  void setOverflow(uint32_t overflow, int format);
  void attachInterrupt(TimerCallback callback);
  void setCaptureCompare(uint32_t channel, uint32_t value, int format);
  void attachInterrupt(uint32_t channel, TimerCallback callback);
  void resume();
};

