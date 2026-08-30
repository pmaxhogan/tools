import { ToolError, type ToolLogic } from "../types";

export interface UuidOpts {
  version: string; // 'v4' | 'v7'
  count: number;
  uppercase: boolean;
  [key: string]: unknown;
}

/**
 * UUID generation. v4 is fully random; v7 is time-ordered (unix-ms prefix,
 * random tail) per RFC 9562. Uses crypto.getRandomValues — available in
 * browsers and Node 20+, no DOM involved.
 */
function bytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

function hex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

function format(b: Uint8Array): string {
  const h = hex(b);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function v4(): string {
  const b = bytes(16);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  return format(b);
}

export function v7(now = Date.now()): string {
  const b = bytes(16);
  // 48-bit big-endian unix millis.
  for (let i = 5; i >= 0; i--) {
    b[i] = now & 0xff;
    now = Math.floor(now / 256);
  }
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  return format(b);
}

export function run(_input: undefined, opts: UuidOpts): string {
  const count = Math.floor(opts.count);
  if (!Number.isFinite(count) || count < 1 || count > 1000)
    throw new ToolError(
      "bad-count",
      "Count must be between 1 and 1000.",
      "Set Count to a whole number in that range, then generate again.",
    );

  const gen = opts.version === "v7" ? v7 : v4;
  const out = Array.from({ length: count }, () => gen());
  return (opts.uppercase ? out.map((u) => u.toUpperCase()) : out).join("\n");
}

export default { run } satisfies ToolLogic<undefined, string, UuidOpts>;
