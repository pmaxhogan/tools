import { ToolError, type ToolLogic } from '../types';

/**
 * The data processing core of the serial terminal.
 *
 * The panel owns the device (requestPort, open, read loop, write) because
 * only a real browser can hold a serial port. Everything that turns bytes
 * into something a human can read lives here and stays pure: incremental
 * line assembly, the hex dump, the send parser, the wrong baud heuristic
 * and the log timestamp. That way the live terminal and the paste path can
 * never disagree about what a byte stream means.
 */

/* ------------------------------------------------------------------ *
 * line assembly
 * ------------------------------------------------------------------ */

/**
 * The result of feeding one chunk of bytes to a {@link LineAssembler}.
 *
 * `lines` are finished lines, in order, ready to be appended to the log.
 * `replaceLast` is the current unfinished line: the row a terminal would
 * still be drawing on. It is present whenever the assembler is holding
 * text that has not been terminated yet, whether that text is a line still
 * being typed out or a progress line that a carriage return just restarted.
 *
 * The rendering rule for a consumer is one line long: append `lines` as
 * permanent rows, then set the single live row to `replaceLast`, removing
 * it when `replaceLast` is undefined.
 */
export interface AssembledChunk {
  lines: string[];
  replaceLast?: string;
}

/**
 * Incremental UTF-8 decoder and line splitter for a serial byte stream.
 *
 * Two things make this harder than `split('\n')`:
 *
 *  - A multi-byte UTF-8 character can be cut in half by a chunk boundary,
 *    so decoding uses `{ stream: true }` and the decoder instance is kept
 *    for the life of the connection.
 *  - A bare carriage return is not a line terminator. Bootloaders and
 *    flashing tools use it to redraw the same row ("Writing 10%\rWriting
 *    20%\r..."), so the text before it must be replaced rather than kept.
 *    A carriage return at the very end of a chunk is ambiguous: it may be
 *    the first half of a CRLF that got split. The assembler holds that
 *    decision until the next chunk arrives.
 */
export class LineAssembler {
  private decoder = new TextDecoder('utf-8');
  /** Text of the line currently being built, not yet terminated. */
  private partial = '';
  /** The previous chunk ended with a CR whose meaning is still unknown. */
  private pendingCR = false;

  /** Feeds one chunk of bytes and returns whatever became readable. */
  push(bytes: Uint8Array): AssembledChunk {
    let text = this.decoder.decode(bytes, { stream: true });
    const lines: string[] = [];

    // An empty decode (a chunk that was only the first half of a multi-byte
    // character) tells us nothing, so a pending CR stays pending.
    if (this.pendingCR && text.length > 0) {
      this.pendingCR = false;
      if (text.startsWith('\n')) {
        // The CR was the first half of a CRLF split across chunks.
        lines.push(this.partial);
        this.partial = '';
        text = text.slice(1);
      } else {
        // A bare CR: the line restarts and whatever was drawn is replaced.
        this.partial = '';
      }
    }

    for (let i = 0; i < text.length; i++) {
      const ch = text[i] as string;

      if (ch === '\n') {
        lines.push(this.partial);
        this.partial = '';
        continue;
      }

      if (ch === '\r') {
        if (i === text.length - 1) {
          // Ambiguous. Keep `partial` intact so a following LF can commit it.
          this.pendingCR = true;
          break;
        }
        if (text[i + 1] === '\n') {
          lines.push(this.partial);
          this.partial = '';
          i++;
          continue;
        }
        // Bare CR in the middle of a chunk: restart the line.
        this.partial = '';
        continue;
      }

      this.partial += ch;
    }

    return this.partial ? { lines, replaceLast: this.partial } : { lines };
  }

  /**
   * Ends the stream: flushes any half-decoded character and commits the
   * unfinished line so nothing is lost when a session closes.
   */
  flush(): AssembledChunk {
    const tail = this.decoder.decode();
    if (tail) this.partial += tail;
    const lines = this.partial ? [this.partial] : [];
    this.partial = '';
    this.pendingCR = false;
    return { lines };
  }

  /** Drops all buffered state. Used when a new connection starts. */
  reset(): void {
    this.decoder = new TextDecoder('utf-8');
    this.partial = '';
    this.pendingCR = false;
  }
}

/* ------------------------------------------------------------------ *
 * hex dump
 * ------------------------------------------------------------------ */

const HEX_ROW = 16;

/**
 * Classic `hexdump -C` style rows: an 8 digit offset, sixteen bytes in two
 * groups of eight, then the printable ASCII rendering between pipes.
 * `offsetStart` is the byte offset of `bytes[0]` within the whole session,
 * so a rolling capture keeps counting up instead of restarting at zero.
 */
export function formatHexDump(bytes: Uint8Array, offsetStart = 0): string {
  if (bytes.length === 0) return '';

  const rows: string[] = [];
  for (let i = 0; i < bytes.length; i += HEX_ROW) {
    const slice = bytes.subarray(i, i + HEX_ROW);
    const cells: string[] = [];
    for (let j = 0; j < HEX_ROW; j++) {
      const byte = slice[j];
      cells.push(byte === undefined ? '  ' : byte.toString(16).padStart(2, '0'));
    }

    let ascii = '';
    for (let j = 0; j < slice.length; j++) {
      const byte = slice[j] as number;
      ascii += byte >= 0x20 && byte <= 0x7e ? String.fromCharCode(byte) : '.';
    }

    const offset = (offsetStart + i).toString(16).padStart(8, '0');
    rows.push(
      `${offset}  ${cells.slice(0, 8).join(' ')}  ${cells.slice(8).join(' ')}  |${ascii}|`,
    );
  }
  return rows.join('\n');
}

/* ------------------------------------------------------------------ *
 * send parsing
 * ------------------------------------------------------------------ */

export type SendMode = 'text' | 'hex';
export type LineEnding = 'none' | 'lf' | 'crlf' | 'cr';

const ENDING_BYTES: Record<LineEnding, number[]> = {
  none: [],
  lf: [0x0a],
  crlf: [0x0d, 0x0a],
  cr: [0x0d],
};

const HEX_FIX =
  'Use pairs of hex digits. Spaces, commas, newlines and 0x prefixes are all fine, so "48 65 6C", "0x48,0x65,0x6C" and "48656C" are the same three bytes.';

/**
 * Turns what the user typed into the exact bytes to put on the wire.
 *
 * Text mode encodes as UTF-8. Hex mode is deliberately tolerant: it accepts
 * spaces, tabs, newlines and commas as separators and an optional 0x on each
 * token, because people paste bytes from datasheets, C arrays and logic
 * analyzers. The chosen line ending is appended in both modes, since a
 * device that wants a terminator wants it whichever way you typed the frame.
 */
export function parseSendInput(
  text: string,
  mode: SendMode,
  lineEnding: LineEnding = 'lf',
): Uint8Array {
  const ending = ENDING_BYTES[lineEnding] ?? [];
  let payload: Uint8Array;

  if (mode === 'hex') {
    let cleaned = '';
    for (const token of text.split(/[\s,]+/)) {
      if (!token) continue;
      cleaned += token.replace(/^0x/i, '');
    }

    if (!/^[0-9a-fA-F]*$/.test(cleaned)) {
      throw new ToolError(
        'invalid-hex',
        'That is not a hex byte string: it contains characters that are not hex digits.',
        HEX_FIX,
      );
    }
    if (cleaned.length % 2 !== 0) {
      throw new ToolError(
        'odd-nibbles',
        `Hex input has ${cleaned.length} digits, which is an odd number, so the last byte is incomplete.`,
        HEX_FIX,
      );
    }

    payload = new Uint8Array(cleaned.length / 2);
    for (let i = 0; i < payload.length; i++) {
      payload[i] = parseInt(cleaned.slice(i * 2, i * 2 + 2), 16);
    }
  } else {
    payload = new TextEncoder().encode(text);
  }

  if (payload.length === 0 && ending.length === 0) {
    throw new ToolError(
      'empty-input',
      'There is nothing to send.',
      'Type something to send, or pick a line ending so pressing send delivers a bare newline.',
    );
  }

  const out = new Uint8Array(payload.length + ending.length);
  out.set(payload, 0);
  out.set(ending, payload.length);
  return out;
}

/* ------------------------------------------------------------------ *
 * wrong baud heuristic
 * ------------------------------------------------------------------ */

/** Below this many bytes the ratios are too noisy to mean anything. */
export const BAUD_HINT_MIN_SAMPLE = 16;

const BAUD_ADVICE =
  'Try another baud rate: 115200 and 9600 cover most boards, and an ESP32 prints its first boot lines at 74880.';

/**
 * Looks at the first bytes of a session and guesses whether the baud rate is
 * wrong. This is a hint, never a decision: binary protocols legitimately look
 * like this, so the panel shows the note and lets the user judge. Returns the
 * note, or null when the sample looks like ordinary text.
 */
export function autoDetectBaudHint(sample: Uint8Array): string | null {
  if (sample.length < BAUD_HINT_MIN_SAMPLE) return null;

  let extreme = 0;
  let control = 0;
  for (let i = 0; i < sample.length; i++) {
    const byte = sample[i] as number;
    if (byte === 0x00 || byte === 0xff) extreme++;
    else if (byte < 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d) control++;
  }

  const decoded = new TextDecoder('utf-8').decode(sample);
  let replacement = 0;
  const REPLACEMENT_CHAR = '�';
  for (const ch of decoded) {
    if (ch === REPLACEMENT_CHAR) replacement++;
  }

  const total = sample.length;
  const percent = (n: number) => Math.round((n / total) * 100);

  if (extreme / total >= 0.2) {
    return `${percent(extreme)} percent of the first bytes are 0x00 or 0xFF, which is what a baud rate mismatch usually looks like. ${BAUD_ADVICE}`;
  }
  if (replacement / total >= 0.15) {
    return `${percent(replacement)} percent of the first bytes are not valid UTF-8, so this may be garbled rather than text. ${BAUD_ADVICE}`;
  }
  if (control / total >= 0.3) {
    return `${percent(control)} percent of the first bytes are control characters, which often means the port is running at the wrong speed. ${BAUD_ADVICE}`;
  }
  return null;
}

/* ------------------------------------------------------------------ *
 * timestamps
 * ------------------------------------------------------------------ */

/**
 * Log timestamp in the shape terminals use: `[12:34:56.789]`.
 * Rendered in the reader's local time, since the point is to line a log line
 * up against something that happened on the bench a moment ago.
 */
export function timestamp(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return `[${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}]`;
}

/* ------------------------------------------------------------------ *
 * run
 * ------------------------------------------------------------------ */

export interface SerialTerminalOpts {
  /** Byte offset printed on the first hex dump row. */
  offset?: number;
}

const USAGE_ROWS: Record<string, string> = {
  'How this works':
    'This tool is a live serial terminal. Click Connect a device, pick the port your board is on, and the log fills as the device talks. Baud rate, data bits, stop bits, parity and the DTR and RTS lines are all set in the panel.',
  Browsers:
    'Talking to a port needs the Web Serial API, which Chromium browsers such as Chrome, Edge, Brave, Arc and Opera ship on desktop. Firefox has recent partial support and Safari has none, so the page checks for the API rather than for a browser name.',
  'One port, one holder':
    'A serial port can only be open in one place at a time. If the Arduino IDE, PlatformIO, screen or another tab already holds it, close that first.',
  'Paste path':
    'Paste a hex capture into the input to get a hex dump, the decoded text and a wrong baud check, without a device attached.',
  Privacy: 'Everything happens in this tab: your files and inputs never leave your device.',
};

/**
 * With no input, returns the usage rows: this tool is panel first, because
 * a serial port only exists in a real browser session. With a hex capture,
 * it runs the same analysis the live panel runs on incoming chunks, which
 * makes the pure surface useful for a saved dump.
 */
export function run(
  input: string | Uint8Array = '',
  opts: SerialTerminalOpts = {},
): Record<string, string> {
  const hasInput = input instanceof Uint8Array ? input.length > 0 : input.trim().length > 0;
  if (!hasInput) return { ...USAGE_ROWS };

  const bytes = input instanceof Uint8Array ? input : parseSendInput(input, 'hex', 'none');

  const assembler = new LineAssembler();
  const first = assembler.push(bytes);
  const rest = assembler.flush();
  const text = [...first.lines, ...rest.lines].join('\n');

  const hint = autoDetectBaudHint(bytes);

  return {
    Summary: `${bytes.length} byte${bytes.length === 1 ? '' : 's'}, ${first.lines.length + rest.lines.length} line${first.lines.length + rest.lines.length === 1 ? '' : 's'} of text.`,
    'Hex dump': formatHexDump(bytes, opts.offset ?? 0),
    'Decoded text': text,
    'Baud check': hint ?? 'Nothing in this sample looks like a baud rate mismatch.',
  };
}

export default { run } satisfies ToolLogic<
  string | Uint8Array,
  Record<string, string>,
  SerialTerminalOpts
>;
