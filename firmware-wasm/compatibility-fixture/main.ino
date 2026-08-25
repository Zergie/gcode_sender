#include <EEPROM.h>
#include <GCodeParser.h>
#include <NTC_Thermistor.h>
#include <QuickPID.h>

HardwareSerial Serial(PA10, PA9);
HardwareTimer timer(TIM2);
NTC_Thermistor thermistor(PA0, 4'700, 100'000, 25, 3'950);
GCodeParser parser;

float input = 25.0F;
float output = 0.0F;
float target = 30.0F;
QuickPID controller(&input, &output, &target, 2.0F, 0.5F, 0.1F, QuickPID::Action::direct);

void onTimerTick() {
  digitalWrite(PC13, !digitalRead(PC13));
}

void setup() {
  analogReadResolution(12);
  pinMode(PB9, OUTPUT);
  pinMode(PC13, OUTPUT);
  Serial.begin(115200);
  timer.setOverflow(1000, MICROSEC_FORMAT);
  timer.attachInterrupt(onTimerTick);
  timer.resume();

  EEPROM.write(0, 0x42);
  parser.Initialize();
  char command[] = "G1 X12.5";
  parser.ParseLine(command);
  input = static_cast<float>(thermistor.readCelsius());
  controller.SetMode(controller.Control::automatic);
}

void loop() {
  if (Serial.available() > 0) {
    parser.AddCharToLine(static_cast<char>(Serial.read()));
  }
  controller.Compute();
  digitalWrite(PB9, output > 0.0F ? HIGH : LOW);
  Serial.println(EEPROM.read(0) == 0x42 ? "fixture-ready" : "fixture-error");
  (void)millis();
  (void)micros();
}
