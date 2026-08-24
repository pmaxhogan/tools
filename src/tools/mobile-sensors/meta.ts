import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "mobile-sensors",
  icon: "Smartphone",
  matrixSlug: "sensors",
  name: "Mobile Sensors Explorer",
  description:
    "Live compass, tilt, accelerometer, gyroscope and light readings from your device sensors.",
  category: "Hardware",
  keywords: [
    "mobile sensor test",
    "phone sensor viewer",
    "accelerometer test online",
    "gyroscope test online",
    "device orientation test",
    "compass test browser",
    "bubble level phone browser",
  ],
  searchTerms: [
    "accelerometer",
    "gyroscope",
    "magnetometer",
    "compass",
    "device orientation",
    "motion sensor",
    "tilt",
    "gravity",
    "ambient light",
    "spirit level",
    "level tool",
    "phone tilt sensor",
    "bubble level app",
    "device orientation api test",
    "proximity sensor",
    "barometer",
    "iphone sensor test",
    "android sensor test",
  ],
  input: "application/json",
  output: "application/json",
  copy: {
    what: "Reads the motion and orientation sensors your phone or tablet already has and turns them into live readouts: a compass heading with direction, a pitch and roll tilt readout with a bubble level, raw accelerometer values with and without gravity, gyroscope rotation rate, and ambient light where the browser exposes it. Where the browser supports the newer Generic Sensor API, it is used alongside the older DeviceMotion and DeviceOrientation events so you can compare both.",
    how: "Open this page on a phone or tablet and tap Enable sensors. On iOS, Safari will show a one-time permission prompt for motion and orientation access; accept it and readings start updating live. On most other browsers, readings start immediately after the tap. Tilt the device to watch the bubble level and pitch and roll change, turn it to watch the compass heading update, and shine or block light on it to see the ambient light reading move.",
    why: "Testing a phone sensor otherwise means installing an app from a store, often with ads or an account wall, just to read one number off a chip that is already on the device. This runs the same browser APIs a native app would use, shows every axis instead of a single simplified gauge, and never sends a reading anywhere: your files and inputs never leave your device.",
    faq: [
      {
        q: "Why does this need a permission prompt on iPhone?",
        a: "iOS requires an explicit user gesture and a permission grant before a web page can read motion and orientation sensors, to stop a page from fingerprinting or tracking a device silently. The Enable sensors button exists specifically to trigger that prompt; without a tap first, iOS Safari refuses to deliver any readings.",
      },
      {
        q: "It says these sensors need a phone or tablet. Why?",
        a: "A laptop or desktop browser does not fire device orientation or motion events at all, since there is no accelerometer or gyroscope for it to report. Rather than show blank or frozen readouts, the panel checks whether any reading arrives after you enable sensors and shows an honest message if none does.",
      },
      {
        q: "Why is the compass off, or missing entirely?",
        a: "A compass heading needs the magnetometer, which not every browser exposes and which can be thrown off by nearby metal or magnets. Android Chrome and Firefox generally provide it; some browsers only provide tilt and acceleration and never a heading, in which case the compass readout stays hidden rather than guessing.",
      },
    ],
  },
};
