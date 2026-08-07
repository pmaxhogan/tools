import type { ToolMeta } from '../types';

export const meta: ToolMeta = {
  slug: 'hid-report-explorer',
  matrixSlug: 'hid',
  name: 'HID Report Explorer',
  description: 'Inspect the raw HID reports coming off any USB device.',
  category: 'Hardware',
  keywords: [
    'webhid report viewer',
    'hid report descriptor parser',
    'usb hid debugger online',
    'inspect hid reports',
    'hid usage decoder',
    'hid report layout',
    'webhid input report log',
  ],
  searchTerms: [
    'webhid tester',
    'usb device debugger',
    'hid input report',
    'hid descriptor decoder',
    'gamepad hid debug',
    'macro pad debugger',
    'usage page lookup',
    'hid report descriptor viewer',
    'hid bytes decoder',
  ],
  input: 'none',
  output: 'application/json',
  options: [
    {
      kind: 'select',
      id: 'view',
      label: 'Sections',
      default: 'both',
      choices: [
        { value: 'both', label: 'Tree and layout' },
        { value: 'tree', label: 'Item tree only' },
        { value: 'layout', label: 'Report layout only' },
      ],
    },
    { kind: 'boolean', id: 'showBytes', label: 'Show raw item bytes', default: true },
  ],
  requires: ['hid'],
  copy: {
    what: 'Connects to a USB or Bluetooth HID device with WebHID and streams its input reports live, decoded field by field: every byte in hex, every bit position, and the usage name behind each value. It also parses a report descriptor you paste as a hex dump, turning the raw item stream into an indented tree and a computed report layout with bit offsets, sizes and logical ranges. Usage pages and usages are named from a curated table covering Generic Desktop, Keyboard, LED, Button, Consumer, Digitizer and the vendor ranges.',
    how: 'Click Connect a device and pick one from the browser prompt, then move it or press its buttons and watch the report log fill in. Pause the log to study a frame, filter by report ID when a device sends several, and read the changed bytes from the highlighting. With no device to hand, paste a descriptor hex dump into the box at the bottom: spaced bytes, a C array with 0x prefixes, a hexdump with offset columns and one unbroken hex string all parse.',
    why: 'Debugging HID normally means a USB capture in Wireshark or a vendor tool that only knows about that vendor. This shows the same reports decoded against the device layout in a browser tab, with no driver, no capture filter and no install. Your files and inputs never leave your device: the descriptor parsing and report decoding both run in this tab, and nothing about the device is uploaded or logged.',
    faq: [
      {
        q: 'Why does my keyboard not show up in the device list?',
        a: 'Browsers keep a protected list of usage pages, and keyboards, mice and other pointer devices on the Generic Desktop and Keyboard pages are blocked from WebHID so a web page cannot silently keylog you. Those devices are filtered out of the chooser by the browser itself, not by this tool. Gamepads, custom HID interfaces, macro pads on vendor pages and most DIY devices are all still available.',
      },
      {
        q: 'What is a report descriptor?',
        a: 'It is a byte stream a HID device hands the host at enumeration, describing every report it can send. It is a list of items: Global items set the usage page, report size, report count and logical range, Local items attach usages, and Main items (Input, Output, Feature, Collection) commit a run of bits into an actual field. The host walks that stream to work out which bits of an incoming report mean which control, which is exactly what the parser here does.',
      },
      {
        q: 'Does my device data leave my computer?',
        a: 'No. Your files and inputs never leave your device. Reports are read straight from the WebHID event in this tab, decoded in JavaScript and shown on screen; they are never sent anywhere and nothing is stored when you close the page.',
      },
    ],
  },
};
