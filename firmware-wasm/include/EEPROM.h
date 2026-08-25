#pragma once

#include <cstdint>

class EEPROMClass {
 public:
  uint8_t read(int address) const;
  void write(int address, uint8_t value);
};

extern EEPROMClass EEPROM;

