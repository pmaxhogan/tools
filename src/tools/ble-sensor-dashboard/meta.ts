import type { ToolMeta } from "../types";

export const meta: ToolMeta = {
  slug: "ble-sensor-dashboard",
  icon: "Bluetooth",
  matrixSlug: "ble",
  name: "BLE Sensor Dashboard",
  description: "Connect Bluetooth sensors, chart their readings live, and export CSV.",
  category: "Hardware",
  keywords: [
    "web bluetooth dashboard",
    "ble sensor chart",
    "bluetooth sensor logger browser",
    "read ble characteristic online",
    "web bluetooth csv export",
    "heart rate monitor browser",
    "bluetooth thermometer dashboard",
  ],
  searchTerms: [
    "web bluetooth",
    "gatt characteristic reader",
    "fitness tracker reader",
    "iot sensor dashboard",
    "bluetooth temperature sensor",
    "air quality sensor reader",
    "co2 sensor dashboard",
    "bluetooth data logger",
    "sensor csv export",
    "ieee 11073 decoder",
  ],
  input: "none",
  output: "application/json",
  requires: ["bluetooth"],
  copy: {
    what: "A live dashboard for Bluetooth Low Energy sensors that runs in the browser tab. Connect a device with Web Bluetooth, and the panel discovers its services, subscribes to every characteristic that notifies, and charts each numeric field over time. It decodes the standard GATT characteristics into named readings: heart rate with RR intervals, battery level, environmental temperature, humidity, pressure and elevation, the Health Thermometer measurement with its IEEE-11073 float, and CO2 and particulate matter from an air quality sensor. Each reading gets a live value tile and an auto scaled line chart with a rolling window, and the whole session exports as a timestamped CSV. A characteristic the tool does not recognize is shown as raw hex rather than hidden.",
    how: "Click Connect a sensor and pick your device from the browser chooser. The panel connects over GATT, lists what it found, and starts charting the numeric fields as readings arrive. Pick a rolling window of 1, 5 or 15 minutes to trade detail against history, and leave auto reconnect on so a device that drops off comes back on its own. Read only characteristics such as a battery level are polled on an interval you set. Press Export CSV at any time to download every reading kept in memory, and Disconnect to release the device. Nothing is stored between sessions.",
    why: "Reading a BLE sensor usually means installing a vendor app that phones home, gates the export behind an account, or shows a number without ever letting you keep the data. This connects with Web Bluetooth, charts locally, and exports plain CSV, so your files and inputs never leave your device. It decodes the readings with the same standard GATT parsers a firmware engineer would use, including the two IEEE-11073 medical float formats that trip up most quick scripts, and it is honest when a characteristic is non-standard by showing the bytes instead of guessing. Web Bluetooth is a Chromium feature on desktop and Android, so the page checks for the API itself rather than assuming a browser.",
    faq: [
      {
        q: "Which sensors work with this?",
        a: "Any device that exposes standard GATT characteristics decodes into named readings. That covers heart rate straps and watches through the Heart Rate Measurement characteristic, environmental sensors that report temperature, humidity, pressure and elevation, clinical style thermometers using the Health Thermometer measurement, air quality sensors that report CO2 and particulate matter, and the battery level almost every device carries. Fitness and cycling sensors that follow the standard profiles work too. A device that uses its own private characteristics still connects, but those readings appear as raw hex because there is no public definition to decode them against.",
      },
      {
        q: "Why does my sensor show raw hex instead of a number?",
        a: "That characteristic is non-standard, so there is no public specification that says how to read its bytes. Many sensors use a vendor specific characteristic with a 128-bit UUID that is not in the Bluetooth base range, and only the maker knows the layout. Rather than guess and show a wrong number, the tool prints the exact bytes as hex so you can compare them against a datasheet or reverse engineer the format yourself. The standard characteristics on the same device still decode normally.",
      },
      {
        q: "Is my sensor data uploaded anywhere?",
        a: "No. The browser holds the Bluetooth connection, the readings are decoded in this tab, and the charts and CSV are built locally, so your files and inputs never leave your device. There is no account, no upload step, and nothing is written to a server. The session lives in the tab memory only and is gone when you close it, and the CSV export is produced in the page from what is already on screen.",
      },
    ],
  },
};
