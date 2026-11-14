import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * Dependencies that CI cannot vouch for, pinned to the version a person last
 * verified by hand.
 *
 * Dependabot PRs merge themselves when CI is green. For most packages a green
 * run means something. For these it means nothing: the code only runs in a
 * browser against real model inference, or against a chip on a USB cable, and
 * no test here can reach either. So a bot bump of one of them has to go red
 * and wait for a person, whatever kind of update Dependabot thinks it is.
 *
 * To move one: bump it, do the check listed beside it, then change the
 * version in this table in the same commit.
 */
const HELD: Record<string, { version: string; verify: string }> = {
  "@huggingface/transformers": {
    version: "4.2.0",
    verify:
      "Bump together with onnxruntime-web. In a browser, run the transcriber (Whisper tiny and base), the background remover, the upscaler and the QR scanner's deep scan.",
  },
  "onnxruntime-web": {
    version: "1.27.0",
    verify:
      "Pinned as a dependency and as an override because a newer transformers.js pin broke Whisper session creation. Bump together with @huggingface/transformers and run the same four tools in a browser.",
  },
  "esptool-js": {
    version: "0.6.1",
    verify:
      "Flash a real ESP board with the firmware flasher. 0.7 changed chip detection and added input validation to writeFlash, and only hardware shows whether a flash still completes.",
  },
};

const lock = JSON.parse(
  readFileSync(new URL("../../package-lock.json", import.meta.url), "utf8"),
) as { packages: Record<string, { version?: string }> };

describe("dependencies held for a manual check", () => {
  for (const [name, { version, verify }] of Object.entries(HELD)) {
    it(`${name} is still ${version}`, () => {
      const locked = lock.packages[`node_modules/${name}`]?.version;
      expect(locked, `${name} changed version. ${verify} Then update HELD in this file.`).toBe(
        version,
      );
    });
  }
});
