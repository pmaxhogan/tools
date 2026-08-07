import { ToolError, type ToolLogic } from '../types';

export interface CompressOpts {
  /** Include a hex preview of the first 64 gzip-compressed bytes. Default true. */
  preview?: boolean;
  [key: string]: unknown;
}

export type CompressResult = Record<string, string>;

/** The three algorithms CompressionStream / DecompressionStream support without wasm. */
type Algo = 'gzip' | 'deflate' | 'deflate-raw';
const ALGOS: Algo[] = ['gzip', 'deflate', 'deflate-raw'];

function toBytes(input: Uint8Array | string): Uint8Array {
  if (typeof input === 'string') return new TextEncoder().encode(input);
  return input;
}

async function collect(readable: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = readable.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      chunks.push(value);
      total += value.length;
    }
  }

  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Runs bytes through a Compression/DecompressionStream and collects the output. */
async function pump(
  bytes: Uint8Array,
  transform: CompressionStream | DecompressionStream,
): Promise<Uint8Array> {
  const writer = transform.writable.getWriter();
  const [out] = await Promise.all([
    collect(transform.readable),
    writer.write(bytes as BufferSource).then(() => writer.close()),
  ]);
  return out;
}

export async function compressBytes(bytes: Uint8Array, algo: Algo): Promise<Uint8Array> {
  return pump(bytes, new CompressionStream(algo));
}

export async function decompressBytes(bytes: Uint8Array, algo: Algo): Promise<Uint8Array> {
  return pump(bytes, new DecompressionStream(algo));
}

type DetectedFormat = 'gzip' | 'zlib';

/** Sniffs a gzip magic number or a zlib (RFC 1950) header. */
export function detectFormat(bytes: Uint8Array): DetectedFormat | null {
  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) return 'gzip';
  if (bytes.length >= 2 && bytes[0] === 0x78 && [0x01, 0x9c, 0xda].includes(bytes[1]!)) {
    return 'zlib';
  }
  return null;
}

/** Shannon entropy in bits per byte, computed over the byte-value histogram. */
export function shannonEntropy(bytes: Uint8Array): number {
  if (bytes.length === 0) return 0;
  const freq = new Array<number>(256).fill(0);
  for (const b of bytes) freq[b]!++;
  let entropy = 0;
  for (const count of freq) {
    if (count === 0) continue;
    const p = count / bytes.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function toHex(bytes: Uint8Array, limit: number): string {
  return [...bytes.slice(0, limit)].map((b) => b.toString(16).padStart(2, '0')).join(' ');
}

/** "1,204 bytes" or "1,204 bytes (1.18 KB)" / "(1.14 MB)" above 1024 bytes. */
function formatBytes(n: number): string {
  const commas = n.toLocaleString('en-US');
  const plain = `${commas} byte${n === 1 ? '' : 's'}`;
  const suffix = unitSuffix(n);
  return suffix ? `${plain} (${suffix})` : plain;
}

function unitSuffix(n: number): string | null {
  if (n < 1024) return null;
  const kb = n / 1024;
  if (kb < 1024) return `${kb.toFixed(2)} KB`;
  return `${(kb / 1024).toFixed(2)} MB`;
}

/** "1,204 bytes (1.18 KB, 63.2% smaller)" style row for one algorithm's result. */
function algoRow(compressedLen: number, inputLen: number): string {
  const commas = compressedLen.toLocaleString('en-US');
  const plain = `${commas} byte${compressedLen === 1 ? '' : 's'}`;
  const suffix = unitSuffix(compressedLen);
  const pct = inputLen > 0 ? (1 - compressedLen / inputLen) * 100 : 0;
  const direction = pct >= 0 ? 'smaller' : 'larger';
  const pctPart = `${Math.abs(pct).toFixed(1)}% ${direction}`;
  return suffix ? `${plain} (${suffix}, ${pctPart})` : `${plain} (${pctPart})`;
}

async function decompressReport(bytes: Uint8Array, format: DetectedFormat): Promise<CompressResult> {
  // zlib (RFC 1950) is exactly what CompressionStream/DecompressionStream call 'deflate'.
  const algo: Algo = format === 'gzip' ? 'gzip' : 'deflate';

  let decompressed: Uint8Array;
  try {
    decompressed = await decompressBytes(bytes, algo);
  } catch {
    throw new ToolError(
      'decompress-failed',
      `Could not decompress this ${format === 'gzip' ? 'gzip' : 'zlib'} data.`,
      'The file may be truncated or corrupted. Try re-downloading or re-compressing the source.',
    );
  }

  const result: CompressResult = {
    'Original (compressed) size': formatBytes(bytes.length),
    'Decompressed size': formatBytes(decompressed.length),
    'Expansion ratio': bytes.length > 0 ? `${(decompressed.length / bytes.length).toFixed(2)}x` : 'n/a',
    'Detected format': format === 'gzip' ? 'gzip' : 'zlib (deflate)',
  };

  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(decompressed);
    result['Content preview'] = text.length > 500 ? `${text.slice(0, 500)}...` : text;
  } catch {
    result['Content preview'] =
      `Binary content, first 64 bytes (hex): ${toHex(decompressed, 64)}`;
  }

  return result;
}

async function compressReport(bytes: Uint8Array, opts: CompressOpts): Promise<CompressResult> {
  const compressed = await Promise.all(ALGOS.map((algo) => compressBytes(bytes, algo)));
  const sizeByAlgo = new Map<Algo, Uint8Array>(ALGOS.map((algo, i) => [algo, compressed[i]!]));

  const result: CompressResult = {
    'Input size': formatBytes(bytes.length),
  };

  let winner: Algo = ALGOS[0]!;
  for (const algo of ALGOS) {
    const data = sizeByAlgo.get(algo)!;
    result[algo] = algoRow(data.length, bytes.length);
    if (data.length < sizeByAlgo.get(winner)!.length) winner = algo;
  }
  result['Best algorithm'] = `${winner}, ${formatBytes(sizeByAlgo.get(winner)!.length)}`;

  const entropy = shannonEntropy(bytes);
  const note =
    entropy >= 7.5
      ? 'near 8 means the data is already compressed or random'
      : entropy <= 4
        ? 'low means the data is very compressible'
        : 'moderate compressibility';
  result['Entropy estimate'] = `${entropy.toFixed(2)} bits/byte (${note})`;

  if (opts.preview !== false) {
    const gzip = sizeByAlgo.get('gzip')!;
    result['Gzip hex preview (first 64 bytes)'] = toHex(gzip, 64);
  }

  return result;
}

export async function run(
  input: Uint8Array | string,
  opts: CompressOpts,
): Promise<CompressResult> {
  const bytes = toBytes(input);
  if (bytes.length === 0) {
    throw new ToolError(
      'empty-input',
      'Provide text or a file to run through compression.',
      'Paste some text or drop a file into the input.',
    );
  }

  const format = detectFormat(bytes);
  if (format) return decompressReport(bytes, format);
  return compressReport(bytes, opts);
}

export default { run } satisfies ToolLogic<Uint8Array | string, CompressResult, CompressOpts>;
