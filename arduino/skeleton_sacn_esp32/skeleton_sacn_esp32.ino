/*
  LightMeUp skeleton receiver - WiFi E1.31/sACN version (no DMX cable needed)
  Board:     ESP32 dev board
  Wiring:    Servos on GPIO 13, 14, 27 with their OWN 5-6 V supply (share GND with the ESP32).
  Libraries: "ESPAsyncE131" (forkineye) and its dependency "AsyncUDP", plus "ESP32Servo" (Library Manager).

  Add this receiver in xLights / FPP as an E1.31 controller on UNIVERSE (multicast).
  The skeleton uses 3 channels in that universe starting at START_ADDRESS:
    START_ADDRESS + 0 = arm (X), + 1 = mouth (Y), + 2 = body turn (Z)
*/
#include <WiFi.h>
#include <ESPAsyncE131.h>
#include <ESP32Servo.h>

const char *WIFI_SSID = "your-wifi";
const char *WIFI_PASS = "your-password";
const uint16_t UNIVERSE = 1;
const int START_ADDRESS = 1;                 // <-- set this per skeleton

struct Axis {
  uint8_t pin;
  int minDeg;
  int maxDeg;
  uint8_t rest;
  Servo servo;
  float pos;
};

Axis axes[3] = {
  { 13, 20, 160,   0 },   // arm
  { 14, 70, 110,   0 },   // mouth
  { 27, 30, 150, 128 },   // body turn
};

const float SMOOTHING = 0.45;
const unsigned long NO_SIGNAL_MS = 1500;
const unsigned long UPDATE_MS = 10;

ESPAsyncE131 e131(4);
uint8_t target[3];
unsigned long lastPacket = 0;

float angleFor(const Axis &a, uint8_t v) {
  return a.minDeg + (a.maxDeg - a.minDeg) * (v / 255.0);
}

void setup() {
  Serial.begin(115200);
  for (int i = 0; i < 3; i++) {
    Axis &a = axes[i];
    target[i] = a.rest;
    a.pos = angleFor(a, a.rest);
    a.servo.setPeriodHertz(50);
    a.servo.attach(a.pin, 500, 2400);
    a.servo.write((int)a.pos);
  }

  WiFi.mode(WIFI_STA);
  WiFi.setSleep(false);  // keeps latency low for lip sync
  WiFi.begin(WIFI_SSID, WIFI_PASS);
  while (WiFi.status() != WL_CONNECTED) { delay(250); Serial.print('.'); }
  Serial.printf("\nConnected, IP %s\n", WiFi.localIP().toString().c_str());

  if (!e131.begin(E131_MULTICAST, UNIVERSE, 1)) Serial.println("E1.31 listener failed to start");
}

void loop() {
  while (!e131.isEmpty()) {
    e131_packet_t packet;
    e131.pull(&packet);
    if (htons(packet.universe) != UNIVERSE) continue;
    // property_values[0] is the DMX start code; channel N is property_values[N]
    for (int i = 0; i < 3; i++) target[i] = packet.property_values[START_ADDRESS + i];
    lastPacket = millis();
  }

  static unsigned long last = 0;
  if (millis() - last < UPDATE_MS) return;
  last = millis();

  bool live = millis() - lastPacket < NO_SIGNAL_MS;
  for (int i = 0; i < 3; i++) {
    Axis &a = axes[i];
    uint8_t v = live ? target[i] : a.rest;
    a.pos += (angleFor(a, v) - a.pos) * SMOOTHING;
    a.servo.write((int)(a.pos + 0.5));
  }
}
