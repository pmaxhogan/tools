import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "firmware-flasher",
  icon: "Cpu",
  matrixSlug: "flash",
  name: "Firmware Flasher",
  description: "Flash ESP32 and ESP8266 boards from the browser, no toolchain to install.",
  category: "Hardware",
  keywords: [
    "esp32 web flasher",
    "flash esp32 from browser",
    "esptool online",
    "esp8266 firmware flasher",
    "web serial esp flash",
    "flash esp32 c3",
    "browser esp flasher",
  ],
  searchTerms: [
    "esptool js",
    "webserial flasher",
    "flash bin file",
    "nodemcu flasher",
    "wemos d1 flasher",
    "micropython flasher",
    "esphome flasher",
    "tasmota flasher",
    "chip identify",
    "flash microcontroller browser",
  ],
  input: "none",
  output: "application/json",
  requires: ["serial"],
  copy: {
    what: "Flashes ESP32, ESP32-S2, ESP32-S3, ESP32-C3 and ESP8266 boards over USB straight from the browser. It runs Espressif's own esptool-js to identify the chip, then writes one or more .bin files at the offsets you choose. Single file mode drops your build at the conventional application offset for the chip; advanced mode gives you a per file offset table for a full bootloader, partition table and app flash.",
    how: "Plug the board in, add your .bin files, and pick single file mode or the offset table. Click Connect and flash, choose the serial port in the browser prompt, and confirm the planned layout. A progress bar tracks each file and the whole write. If a board has no auto reset circuit, hold BOOT, tap EN, and release BOOT when prompted, then connect again.",
    why: "Flashing normally means installing Python and esptool or the whole ESP-IDF just to write one file. This runs Espressif's esptool-js in the browser with the flasher stubs bundled into the page, so nothing is downloaded at flash time and your firmware never leaves your device. There is no account, no upload, and no size cap.",
    faq: [
      {
        q: "Which chips does this flash?",
        a: "The ESP32 family, meaning the ESP32, ESP32-S2, ESP32-S3 and ESP32-C3, plus the ESP8266. The tool identifies the chip over the serial handshake and uses the right bootloader and partition offsets for that family.",
      },
      {
        q: "Why can I not flash my Raspberry Pi Pico here?",
        a: "The Pico and other RP2040 boards are not flashed over serial. They mount as a USB drive and take a UF2 file by drag and drop, so a serial flasher like this one cannot program them. This tool is for the ESP32 family and the ESP8266 only.",
      },
      {
        q: "Is my firmware uploaded anywhere?",
        a: "No. The flash runs entirely in this tab and talks to the board over the local USB serial port. Your files and inputs never leave your device, and the flasher stubs are bundled into the page so nothing is fetched while you flash.",
      },
    ],
  },
};
