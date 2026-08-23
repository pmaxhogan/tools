/**
 * Browser loader for the self-hosted wawoff2 WOFF2 codec.
 *
 * wawoff2's emscripten glue never assigns `module.exports` outside Node, so
 * importing the package in a browser bundle yields a dead object whose
 * `onRuntimeInitialized` is never read (the subsetter hung forever). The two
 * binding files also collide on emscripten globals, so each codec direction
 * runs in its own Worker (see public/wawoff2/worker.js, staged by
 * scripts/prepare-wawoff2.mjs). This module owns the workers and exposes the
 * same { compress, decompress } shape the wawoff2 package documents, for
 * injection into the font-subsetter logic via setWoff2Codec().
 *
 * DOM/Worker code lives here, never in src/tools (rule 27).
 */

export interface Woff2WorkerCodec {
  compress(bytes: Uint8Array): Promise<Uint8Array>;
  decompress(bytes: Uint8Array): Promise<Uint8Array>;
}

const LOAD_TIMEOUT_MS = 20000;

interface Pending {
  resolve(bytes: Uint8Array): void;
  reject(error: Error): void;
}

class CodecWorker {
  private worker: Worker | null = null;
  private pending = new Map<number, Pending>();
  private nextId = 1;

  constructor(private direction: "compress" | "decompress") {}

  private ensure(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(`/wawoff2/worker.js?codec=${this.direction}`);
    worker.onmessage = (event: MessageEvent) => {
      const { id, ok, bytes, error } = event.data as {
        id: number;
        ok: boolean;
        bytes?: Uint8Array;
        error?: string;
      };
      const entry = this.pending.get(id);
      if (!entry) return;
      this.pending.delete(id);
      if (ok && bytes) entry.resolve(bytes);
      else entry.reject(new Error(error || `The WOFF2 ${this.direction} worker failed`));
    };
    worker.onerror = (event: ErrorEvent) => {
      const failure = new Error(event.message || `The WOFF2 ${this.direction} worker crashed`);
      for (const entry of this.pending.values()) entry.reject(failure);
      this.pending.clear();
      worker.terminate();
      this.worker = null;
    };
    this.worker = worker;
    return worker;
  }

  run(bytes: Uint8Array): Promise<Uint8Array> {
    const worker = this.ensure();
    const id = this.nextId++;
    // Copy so the caller keeps its view; the worker transfer detaches ours.
    const payload = bytes.slice();
    return new Promise<Uint8Array>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`The WOFF2 ${this.direction} worker timed out`));
      }, LOAD_TIMEOUT_MS);
      this.pending.set(id, {
        resolve: (out) => {
          clearTimeout(timer);
          resolve(out);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      worker.postMessage({ id, bytes: payload }, [payload.buffer]);
    });
  }
}

let codec: Woff2WorkerCodec | null = null;

/** Lazily builds the worker-backed codec. Safe to call repeatedly. */
export function getWoff2Codec(): Woff2WorkerCodec {
  if (!codec) {
    const compressor = new CodecWorker("compress");
    const decompressor = new CodecWorker("decompress");
    codec = {
      compress: (bytes) => compressor.run(bytes),
      decompress: (bytes) => decompressor.run(bytes),
    };
  }
  return codec;
}
