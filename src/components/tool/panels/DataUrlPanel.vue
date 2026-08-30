<script setup lang="ts">
/**
 * Bespoke panel for Image to Data URL.
 *
 * The generic shell can already print a data URL, but it cannot show you the
 * picture, it cannot re-encode a 4 MB PNG down to a 40 KB WebP before inlining
 * it, and it cannot hand a decoded data URL back as a file. All three are the
 * reason people open this page, so they live here.
 *
 * Rule 27 holds: every byte level decision comes from the pure layer in
 * `src/tools/image-to-data-url/`. `buildDataUrl` encodes and measures,
 * `parseDataUrl` decodes, `sniffFormat` names the format from the magic bytes,
 * `estimateDataUrlLength` predicts the size before the string is built, and the
 * snippet builders write the CSS rule and the img tag. This file owns only the
 * browser parts: reading the file, the optional canvas re-encode, the preview,
 * and the download.
 *
 * The canvas is also why re-encoding is opt in. Redrawing a picture through a
 * canvas discards its metadata and re-compresses it, which is right when you
 * asked for a smaller JPEG and wrong when you wanted the exact bytes inlined,
 * so "Keep the original file" is the default and it copies the bytes untouched.
 */
import { computed, onMounted, onUnmounted, ref, shallowRef } from "vue";
import { Download, FileImage, Sparkles } from "lucide-vue-next";
import { ToolError, type ToolMeta } from "@/tools/types";
import {
  INLINE_WARN_BYTES,
  buildDataUrl,
  cssSnippet,
  estimateDataUrlLength,
  extensionForMediaType,
  htmlSnippet,
  parseDataUrl,
  sniffFormat,
} from "@/tools/image-to-data-url/index";
import type { BuiltDataUrl, ParsedDataUrl } from "@/tools/image-to-data-url/index";
import { formatBytes } from "@/lib/format";
import { downloadBlob } from "@/lib/download";
import { readFragment, writeFragment } from "@/lib/fragment";
import { readText } from "@/lib/clipboard";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Segmented } from "@/components/ui/segmented";
import { Slider } from "@/components/ui/slider";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import CopyButton from "../CopyButton.vue";
import ErrorBanner from "../ErrorBanner.vue";
import FileDrop from "../FileDrop.vue";
import KeyValueGrid from "../KeyValueGrid.vue";

defineProps<{ meta: ToolMeta }>();

type PanelError = { message: string; fix?: string };

function toPanelError(err: unknown, fallback: string): PanelError {
  if (err instanceof ToolError) return { message: err.message, fix: err.fix };
  return { message: err instanceof Error ? err.message : fallback };
}

/* ------------------------------------------------------------------ *
 * shared state
 * ------------------------------------------------------------------ */

const tab = ref<"encode" | "decode">("encode");

/* ------------------------------------------------------------------ *
 * encode
 * ------------------------------------------------------------------ */

const REENCODE_OPTIONS = [
  { value: "original", label: "Keep original" },
  { value: "image/png", label: "PNG" },
  { value: "image/jpeg", label: "JPEG" },
  { value: "image/webp", label: "WebP" },
];

const SNIPPET_OPTIONS = [
  { value: "raw", label: "Raw" },
  { value: "css", label: "CSS" },
  { value: "html", label: "HTML" },
];

const fileName = ref("");
/** The picked file's bytes. Not reactive: Vue must never proxy a big array. */
let sourceBytes: Uint8Array | null = null;

const reencode = ref("original");
const quality = ref(80);
const maxWidth = ref(0);
const snippet = ref("raw");
const selector = ref(".hero");

const built = shallowRef<BuiltDataUrl | null>(null);
const encodeError = ref<PanelError | null>(null);
const working = ref(false);
/** Set when the canvas actually redrew the picture, for the on screen note. */
const reencodedFrom = ref<{ bytes: number; width: number; height: number } | null>(null);

const outputText = computed(() => {
  const current = built.value;
  if (!current) return "";
  if (snippet.value === "css") return cssSnippet(current.dataUrl, selector.value);
  if (snippet.value === "html") return htmlSnippet(current.dataUrl);
  return current.dataUrl;
});

const tooBig = computed(() => (built.value?.urlLength ?? 0) > INLINE_WARN_BYTES);

const encodeFacts = computed<Record<string, string>>(() => {
  const current = built.value;
  if (!current) return {};
  const rows: Record<string, string> = {
    Format: `${current.format.label} (${current.mediaType})`,
    "File size": formatBytes(current.sourceBytes),
    "Data URL size": formatBytes(current.urlLength),
    Overhead: `${Math.round((current.overhead - 1) * 100)}% larger`,
  };
  const from = reencodedFrom.value;
  if (from) {
    rows["Re-encoded from"] =
      `${formatBytes(from.bytes)} at ${from.width} by ${from.height} pixels`;
  }
  return rows;
});

/** Decode a file into an ImageBitmap-like element so the canvas can redraw it. */
async function decodeImage(bytes: Uint8Array, type: string): Promise<HTMLImageElement | null> {
  const blob = new Blob([bytes.slice().buffer as ArrayBuffer], { type });
  const url = URL.createObjectURL(blob);
  const img = new Image();
  const ok = await new Promise<boolean>((resolve) => {
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = url;
  });
  URL.revokeObjectURL(url);
  return ok && img.naturalWidth > 0 ? img : null;
}

function canvasToBytes(canvas: HTMLCanvasElement, type: string, q: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("This browser would not encode the canvas to that format."));
          return;
        }
        blob
          .arrayBuffer()
          .then((buffer) => resolve(new Uint8Array(buffer)))
          .catch(reject);
      },
      type,
      q,
    );
  });
}

async function encode(): Promise<void> {
  const bytes = sourceBytes;
  if (!bytes) return;
  working.value = true;
  encodeError.value = null;
  reencodedFrom.value = null;

  try {
    const wantsResize = maxWidth.value > 0;
    const wantsFormat = reencode.value !== "original";
    if (!wantsResize && !wantsFormat) {
      built.value = buildDataUrl(bytes);
      return;
    }

    const sniffed = sniffFormat(bytes);
    const img = await decodeImage(bytes, sniffed.mediaType);
    if (!img) {
      encodeError.value = {
        message: "That file could not be decoded, so it cannot be resized or re-encoded.",
        fix: 'Set the format back to "Keep original" to inline the bytes exactly as they are.',
      };
      return;
    }

    const scale = wantsResize ? Math.min(1, maxWidth.value / img.naturalWidth) : 1;
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    if (!ctx) {
      encodeError.value = {
        message: "This browser would not give the page a 2D canvas.",
        fix: "Try again in a recent Chrome, Firefox, Edge, or Safari.",
      };
      return;
    }
    ctx.drawImage(img, 0, 0, w, h);

    const type = wantsFormat ? reencode.value : sniffed.mediaType;
    const encoded = await canvasToBytes(canvas, type, quality.value / 100);
    built.value = buildDataUrl(encoded, type);
    reencodedFrom.value = {
      bytes: bytes.length,
      width: img.naturalWidth,
      height: img.naturalHeight,
    };
  } catch (err) {
    built.value = null;
    encodeError.value = toPanelError(err, "That image could not be converted.");
  } finally {
    working.value = false;
    syncFragment();
  }
}

async function acceptFile(file: File | undefined): Promise<void> {
  if (!file) return;
  encodeError.value = null;
  const bytes = new Uint8Array(await file.arrayBuffer());
  const estimate = estimateDataUrlLength(bytes.length, "image/png");
  sourceBytes = bytes;
  fileName.value = file.name || "image";
  if (estimate > 8 * 1024 * 1024) {
    // A data URL this long freezes the tab when it lands in the DOM, so the
    // panel says so instead of hanging.
    built.value = null;
    encodeError.value = {
      message: `That file would produce ${formatBytes(estimate)} of text, which is far too much to paste into a page.`,
      fix: "Set a max width, or re-encode it as a WebP first, then try again.",
    };
    return;
  }
  await encode();
}

function onEncodeFiles(files: File[]): void {
  void acceptFile(files[0]);
}

async function loadSample(): Promise<void> {
  try {
    const response = await fetch("/samples/sample.png");
    if (!response.ok) throw new Error(String(response.status));
    const blob = await response.blob();
    await acceptFile(new File([blob], "sample.png", { type: "image/png" }));
  } catch {
    encodeError.value = {
      message: "Could not load the sample image.",
      fix: "Try again, or drop an image of your own.",
    };
  }
}

function downloadEncoded(): void {
  const current = built.value;
  if (!current) return;
  const stem = fileName.value.replace(/\.[^./\\]+$/, "") || "image";
  downloadBlob(new Blob([outputText.value], { type: "text/plain;charset=utf-8" }), `${stem}.txt`);
}

/* ------------------------------------------------------------------ *
 * decode
 * ------------------------------------------------------------------ */

const pasted = ref("");
const parsed = shallowRef<ParsedDataUrl | null>(null);
const decodeError = ref<PanelError | null>(null);
/** Object URL for the decoded preview, released when it is replaced. */
const previewUrl = ref("");

function releasePreview(): void {
  if (previewUrl.value) {
    URL.revokeObjectURL(previewUrl.value);
    previewUrl.value = "";
  }
}

const decodeFacts = computed<Record<string, string>>(() => {
  const current = parsed.value;
  if (!current) return {};
  const rows: Record<string, string> = {
    "Media type": current.mediaType,
    Encoding: current.encoding === "base64" ? "base64" : "percent encoded",
    "Decoded size": formatBytes(current.bytes.length),
    "Data URL size": formatBytes(current.urlLength),
    Filename: decodeName.value,
  };
  if (current.parameters.length > 0) rows["Parameters"] = current.parameters.join("; ");
  const actual = sniffFormat(current.bytes);
  if (actual.mediaType !== current.mediaType && actual.label !== "Unrecognized") {
    rows["Actual bytes"] = `The payload looks like ${actual.label}.`;
  }
  return rows;
});

const decodeName = computed(() => {
  const current = parsed.value;
  if (!current) return "";
  return `decoded.${extensionForMediaType(current.mediaType)}`;
});

function decode(): void {
  const text = pasted.value.trim();
  releasePreview();
  if (!text) {
    parsed.value = null;
    decodeError.value = null;
    return;
  }
  try {
    const result = parseDataUrl(text);
    parsed.value = result;
    decodeError.value = null;
    previewUrl.value = URL.createObjectURL(
      new Blob([result.bytes.slice().buffer as ArrayBuffer], { type: result.mediaType }),
    );
  } catch (err) {
    parsed.value = null;
    decodeError.value = toPanelError(err, "That data URL could not be decoded.");
  }
}

async function pasteFromClipboard(): Promise<void> {
  const text = await readText();
  if (text !== null) {
    pasted.value = text;
    decode();
  }
}

function downloadDecoded(): void {
  const current = parsed.value;
  if (!current) return;
  downloadBlob(
    new Blob([current.bytes.slice().buffer as ArrayBuffer], { type: current.mediaType }),
    decodeName.value,
  );
}

/* ------------------------------------------------------------------ *
 * fragment
 * ------------------------------------------------------------------ */

function syncFragment(): void {
  writeFragment({
    opts: {
      direction: tab.value === "decode" ? "decode" : "encode",
      snippet: snippet.value,
      selector: selector.value,
      format: reencode.value,
      quality: String(quality.value),
      maxWidth: String(maxWidth.value),
    },
  });
}

onMounted(() => {
  const { opts } = readFragment();
  if (opts["direction"] === "decode") tab.value = "decode";
  if (opts["snippet"]) snippet.value = opts["snippet"];
  if (opts["selector"]) selector.value = opts["selector"];
  if (opts["format"]) reencode.value = opts["format"];
  const q = Number(opts["quality"]);
  if (Number.isFinite(q) && q >= 1 && q <= 100) quality.value = Math.round(q);
  const w = Number(opts["maxWidth"]);
  if (Number.isFinite(w) && w >= 0) maxWidth.value = Math.round(w);
});

onUnmounted(releasePreview);
</script>

<template>
  <div class="flex flex-col gap-5 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <Tabs v-model="tab" class="w-full" @update:model-value="syncFragment">
      <TabsList class="flex w-full flex-wrap sm:w-fit">
        <TabsTrigger value="encode"> Image to data URL </TabsTrigger>
        <TabsTrigger value="decode"> Data URL to file </TabsTrigger>
      </TabsList>

      <!-- encode -->
      <TabsContent value="encode" class="flex flex-col gap-4 pt-4">
        <FileDrop
          accept="image/*"
          label="Image"
          hint="Drop a picture here, paste one, or click to choose. It is encoded in this tab: your files and inputs never leave your device."
          @files="onEncodeFiles"
        >
          <template #actions>
            <Button variant="ghost" size="sm" @click="loadSample">
              <Sparkles class="size-3.5" aria-hidden="true" />
              Load sample
            </Button>
          </template>
        </FileDrop>

        <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div class="flex flex-col gap-1.5">
            <Label id="dataurl-format-label" class="text-xs text-muted-foreground">
              Re-encode as
            </Label>
            <Segmented
              :model-value="reencode"
              :options="REENCODE_OPTIONS"
              label="Re-encode as"
              size="sm"
              @update:model-value="
                (v: string) => {
                  reencode = v;
                  void encode();
                }
              "
            />
          </div>

          <div class="flex flex-col gap-1.5">
            <Label for="dataurl-quality" class="text-xs text-muted-foreground">
              Quality
              <span class="font-mono tabular-nums">{{ quality }}</span>
            </Label>
            <Slider
              id="dataurl-quality"
              :model-value="[quality]"
              :min="10"
              :max="100"
              :step="1"
              :disabled="reencode === 'original' || reencode === 'image/png'"
              @update:model-value="(v: number[] | undefined) => (quality = v?.[0] ?? quality)"
              @value-commit="() => void encode()"
            />
          </div>

          <div class="flex flex-col gap-1.5">
            <Label for="dataurl-maxwidth" class="text-xs text-muted-foreground">
              Max width in pixels (0 keeps it)
            </Label>
            <Input
              id="dataurl-maxwidth"
              type="number"
              min="0"
              step="16"
              :model-value="maxWidth"
              class="h-9 bg-card tabular-nums"
              @update:model-value="(v: string | number) => (maxWidth = Math.max(0, Number(v) || 0))"
              @change="() => void encode()"
            />
          </div>
        </div>

        <ErrorBanner v-if="encodeError" :message="encodeError.message" :hint="encodeError.fix" />

        <ErrorBanner
          v-if="tooBig"
          variant="warning"
          title="This is large for an inline image"
          :message="`The data URL is ${formatBytes(built?.urlLength ?? 0)} of text.`"
          hint="Past roughly 100 KB an inline image usually costs more than it saves: the bytes cannot be cached separately from the page, and a data URL inside a stylesheet delays first paint. Set a max width or re-encode as WebP, or link to a real file instead."
        />

        <div v-if="built" class="flex flex-col gap-4">
          <div class="grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,14rem)_1fr]">
            <figure class="flex flex-col gap-1.5">
              <figcaption
                class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase"
              >
                Preview
              </figcaption>
              <img
                :src="built.dataUrl"
                :alt="`Preview of ${fileName}`"
                class="block h-auto w-full rounded-[10px] shadow-[var(--sh-inset)]"
              />
            </figure>
            <KeyValueGrid :record="encodeFacts" :columns="2" surface="secondary" />
          </div>

          <div class="flex flex-col gap-2">
            <div class="flex flex-wrap items-end justify-between gap-3">
              <div class="flex flex-col gap-1.5">
                <Label class="text-xs text-muted-foreground">Output form</Label>
                <Segmented
                  :model-value="snippet"
                  :options="SNIPPET_OPTIONS"
                  label="Output form"
                  size="sm"
                  @update:model-value="
                    (v: string) => {
                      snippet = v;
                      syncFragment();
                    }
                  "
                />
              </div>

              <div v-if="snippet === 'css'" class="flex w-44 flex-col gap-1.5">
                <Label for="dataurl-selector" class="text-xs text-muted-foreground">
                  CSS selector
                </Label>
                <Input
                  id="dataurl-selector"
                  :model-value="selector"
                  class="h-9 bg-card font-mono"
                  spellcheck="false"
                  @update:model-value="
                    (v: string | number) => {
                      selector = String(v);
                      syncFragment();
                    }
                  "
                />
              </div>

              <div class="flex items-center gap-1">
                <CopyButton :text="outputText" label="Copy" variant="outline" />
                <Button type="button" variant="outline" size="sm" @click="downloadEncoded">
                  <Download class="size-3.5" aria-hidden="true" />
                  Save as text
                </Button>
              </div>
            </div>

            <pre
              class="max-h-64 overflow-auto rounded-[10px] bg-secondary px-3 py-2 font-mono text-xs break-all whitespace-pre-wrap shadow-[var(--sh-inset)]"
              >{{ outputText }}</pre>
          </div>
        </div>

        <p v-else-if="!encodeError" class="flex items-center gap-2 text-xs text-muted-foreground">
          <FileImage class="size-3.5" aria-hidden="true" />
          {{
            working
              ? "Encoding…"
              : "No image loaded yet. The media type is read from the file's magic bytes, not its extension."
          }}
        </p>
      </TabsContent>

      <!-- decode -->
      <TabsContent value="decode" class="flex flex-col gap-4 pt-4">
        <div class="flex flex-col gap-1.5">
          <div class="flex items-center justify-between gap-2">
            <Label for="dataurl-paste" class="text-xs text-muted-foreground">Data URL</Label>
            <Button variant="ghost" size="sm" @click="pasteFromClipboard"> Paste </Button>
          </div>
          <Textarea
            id="dataurl-paste"
            v-model="pasted"
            class="min-h-32 bg-secondary font-mono text-xs shadow-[var(--sh-inset)]"
            spellcheck="false"
            autocapitalize="off"
            placeholder="data:image/png;base64,iVBORw0KGgoAAAANSUhEUg..."
            :aria-invalid="decodeError ? 'true' : undefined"
            @input="decode"
          />
          <p class="text-xs text-muted-foreground">
            Both payload forms work: base64, and the percent encoded form an inline SVG usually
            takes in CSS.
          </p>
        </div>

        <ErrorBanner v-if="decodeError" :message="decodeError.message" :hint="decodeError.fix" />

        <div v-if="parsed" class="flex flex-col gap-4">
          <div class="grid grid-cols-1 gap-4 md:grid-cols-[minmax(0,14rem)_1fr]">
            <figure class="flex flex-col gap-1.5">
              <figcaption
                class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase"
              >
                Preview
              </figcaption>
              <img
                :src="previewUrl"
                alt="Preview of the decoded data URL"
                class="block h-auto w-full rounded-[10px] shadow-[var(--sh-inset)]"
              />
            </figure>
            <KeyValueGrid :record="decodeFacts" :columns="2" surface="secondary" />
          </div>

          <div>
            <Button type="button" variant="outline" @click="downloadDecoded">
              <Download class="size-3.5" aria-hidden="true" />
              Download {{ decodeName }}
            </Button>
          </div>
        </div>
      </TabsContent>
    </Tabs>
  </div>
</template>
