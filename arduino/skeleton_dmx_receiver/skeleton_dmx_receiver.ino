/*
  LightMeUp skeleton receiver - wired DMX version
  Board:   Arduino Uno / Nano (ATmega328P)
  Wiring:  DMX in -> MAX485 (or RS485 shield) -> RX pin 0. Tie the MAX485 DE and RE pins to GND (receive only).
           Servos on pins 9, 10, 11 with their OWN 5-6 V supply (share GND with the Arduino).
  Library: "DMXSerial" by Matthias Hertel (Library Manager). Servo is built in.

  The skeleton uses 3 DMX channels starting at START_ADDRESS (see Export > Channel map in LightMeUp):
    START_ADDRESS + 0 = arm   (X)  0 = down,   255 = up
    START_ADDRESS + 1 = mouth (Y)  0 = closed, 255 = open
    START_ADDRESS + 2 = body  (Z)  0 = left,   128 = centre, 255 = right

  Note: DMXSerial takes over the USB serial port, so unplug DMX while uploading and don't use Serial.print.
*/
#include <DMXSerial.h>
#include <Servo.h>

const int START_ADDRESS = 1;               // <-- set this per skeleton

struct Axis {
  uint8_t pin;
  int minDeg;      // servo angle for DMX value 0
  int maxDeg;      // servo angle for DMX value 255
  uint8_t rest;    // DMX value to hold when there's no signal
  Servo servo;
  float pos;
};

// Tune these to your mechanics so the servos never hit their end stops.
Axis axes[3] = {
  { 9,  20, 160,   0 },   // arm
  { 10, 70, 110,   0 },   // mouth: small range, jaws don't need much travel
  { 11, 30, 150, 128 },   // body turn
};

const float SMOOTHING = 0.45;                // 1 = instant, lower = smoother but laggier
const unsigned long NO_SIGNAL_MS = 1500;     // return to rest after this long without DMX
const unsigned long UPDATE_MS = 10;

float angleFor(const Axis &a, uint8_t v) {
  return a.minDeg + (a.maxDeg - a.minDeg) * (v / 255.0);
}

void setup() {
  DMXSerial.init(DMXReceiver);
  for (Axis &a : axes) {
    a.pos = angleFor(a, a.rest);
    a.servo.attach(a.pin);
    a.servo.write((int)a.pos);
  }
}

void loop() {
  static unsigned long last = 0;
  if (millis() - last < UPDATE_MS) return;
  last = millis();

  bool live = DMXSerial.noDataSince() < NO_SIGNAL_MS;
  for (int i = 0; i < 3; i++) {
    Axis &a = axes[i];
    uint8_t v = live ? DMXSerial.read(START_ADDRESS + i) : a.rest;
    a.pos += (angleFor(a, v) - a.pos) * SMOOTHING;
    a.servo.write((int)(a.pos + 0.5));
  }
}
