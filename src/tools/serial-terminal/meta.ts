import type { ToolMeta } from '../types';

export const meta: ToolMeta = {
  slug: 'serial-terminal',
  matrixSlug: 'serial',
  name: 'Serial Terminal',
  description: 'Talk to ESP32, Pico and other serial devices straight from the browser.',
  category: 'Hardware',
  keywords: [
    'web serial terminal',
    'browser serial monitor',
    'esp32 serial monitor online',
    'arduino serial without ide',
    'web serial console',
    'pico serial terminal',
    'usb serial monitor browser',
  ],
  input: 'none',
  output: 'application/json',
  requires: ['serial'],
  copy: {
    what: 'A full serial terminal that runs in the browser tab. Pick a port, set the baud rate along with data bits, stop bits and parity if the defaults are wrong, and watch the device talk. The log decodes UTF-8 incrementally, so multi byte characters split across USB packets still come out whole, and it honors bare carriage returns the way a real terminal does, which means flashing progress bars redraw one row instead of scrolling off the screen. You can switch the same stream to a hex dump, stamp every line with the time it arrived, raise or drop DTR and RTS, send text or raw hex bytes with any line ending, and download the whole session as a text file.',
    how: 'Click Connect a device and pick your board from the browser chooser, then choose the baud rate (115200 is the default, and an ESP32 prints its first boot lines at 74880). Type in the send box and press Enter, or switch it to hex mode to push raw bytes like 0x7E 0x00. Arrow up walks back through the last 20 things you sent. Use the timestamps and hex toggles to change how the log reads, Clear to start fresh, and Download log to save what you have. Disconnect releases the port so your IDE can have it back.',
    why: 'Reaching for the Arduino IDE, PuTTY or a Python install just to watch a boot log is a lot of setup for a read only job, and the web based alternatives usually want an account first. This connects in one click on any machine with a Chromium browser, including a locked down work laptop where you cannot install a terminal program. Firefox has recent partial support and Safari has none, so the page checks for the Web Serial API itself instead of assuming a browser name. It reads the port directly from the page: your files and inputs never leave your device, and there is no API endpoint behind this tool that could see your traffic.',
    faq: [
      {
        q: 'Why can I not see my device in the chooser?',
        a: 'Three usual causes. First the cable: plenty of USB cables carry power only, so try a different one. Second the driver: boards with a CH340, CP2102 or FTDI bridge need that vendor driver installed before the operating system exposes a port at all, and on Linux your user usually needs to be in the dialout group. Third, a serial port can only be open in one place at a time, so if the Arduino IDE, PlatformIO, screen or another tab already holds it, close that first and click Connect again.',
      },
      {
        q: 'What baud rate should I pick?',
        a: 'Start with 115200, which is the default here and what most ESP32, ESP8266 and Pico firmware uses. Older Arduino sketches often print at 9600, and the ESP32 first stage bootloader prints its very first lines at 74880 before switching. If the log fills with question marks, boxes or long runs of the same byte, the speed is wrong rather than the board being broken, and this tool says so with a hint above the log as soon as it sees a garbled first sample.',
      },
      {
        q: 'Does my serial data leave the browser?',
        a: 'No. The page opens the port with the Web Serial API and reads it in the tab you already have open: your files and inputs never leave your device. Nothing is written to the URL, nothing is stored between sessions, and the downloaded log is built locally from what is already on screen.',
      },
    ],
  },
};
