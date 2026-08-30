<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref, shallowRef, watch } from "vue";
import { Download, Eye, EyeOff, ImageOff } from "lucide-vue-next";
import type { SelectOption, SelectOptionSpec, ToolMeta } from "@/tools/types";
import { ToolError } from "@/tools/types";
import {
  describeEmbed,
  describeExtract,
  embedWithReport,
  extract,
  formatWarning,
  isText,
  payloadCapacityBytes,
  payloadFromText,
  textFromPayload,
  visualizeLsb,
} from "@/tools/image-steganography/index";
import type {
  BitDepth,
  ChannelSet,
  EmbedResult,
  ExtractResult,
} from "@/tools/image-steganography/index";
import { formatBytes } from "@/lib/format";
import { downloadBlob } from "@/lib/download";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import CopyButton from "../CopyButton.vue";
import ErrorBanner from "../ErrorBanner.vue";
import FileDrop from "../FileDrop.vue";
import OutputView from "../OutputView.vue";
import ProgressBar from "../ProgressBar.vue";

/**
 * Bespoke panel for Image Steganography.
 *
 * The generic shell hands a tool one input, and this tool needs a carrier image
 * and a payload at the same time, so the two halves get their own tabs here.
 * Every bit of arithmetic still lives in the pure layer under
 * `src/tools/image-steganography/` (PROJECT.md rule 27): this file only decodes
 * a picture into RGBA on a canvas, hands those bytes to `embedWithReport` or
 * `extract`, and paints what comes back.
 *
 * Three details that are easy to get wrong and are deliberate here:
 *
 * 1. **Nothing is ever resized.** Other image panels scale a big picture down
 *    before reading pixels, which is fine when the pixels are only being looked
 *    at. Here the exact pixel values are the message, so a resample would
 *    destroy it. Oversized pictures are refused instead, at MAX_PIXELS.
 * 2. **Transparency is detected at load,** not from the `hasTransparency` field
 *    of an embed result, because the warning and the flatten button have to be
 *    offered before anything is hidden. Canvas premultiplies alpha, so the
 *    color under a partly transparent pixel can be rewritten on the round trip
 *    and take the hidden bits with it. Flattening onto white first is the fix.
 * 3. **No URL fragment state.** The message is the secret, and the carrier
 *    cannot go in a URL at all, so there is nothing here worth sharing and a
 *    great deal worth keeping out of browser history. The password lives in a
 *    component ref only: never in the fragment, never in storage.
 *
 * Pixel buffers are held in `shallowRef` so Vue never proxies a multi megabyte
 * typed array. Nothing here touches the network: your files and inputs never
 * leave your device.
 */
const props = defineProps<{ meta: ToolMeta }>();

/* ------------------------------------------------------------------ *
 * limits
 * ------------------------------------------------------------------ */

/**
 * Widest picture accepted, in total pixels. Every stage keeps a full RGBA copy
 * (source, stego result, bit plane view), so 16 megapixels is already about
 * 192 MB of live typed arrays. Refusing is honest; downscaling would silently
 * break the tool.
 */
const MAX_MEGAPIXELS = 16;
const MAX_PIXELS = MAX_MEGAPIXELS * 1_000_000;

/* ------------------------------------------------------------------ *
 * option specs, built from the meta
 * ------------------------------------------------------------------ */

const BITS_FALLBACK: SelectOption[] = [
  { value: "1", label: "1 bit, invisible", synonyms: ["one", "lsb", "single", "safest"] },
  { value: "2", label: "2 bits, twice the capacity", synonyms: ["two", "double", "more space"] },
];

const CHANNELS_FALLBACK: SelectOption[] = [
  { value: "rgb", label: "Red, green, and blue", synonyms: ["color", "colour", "default"] },
  { value: "rgba", label: "Red, green, blue, and alpha", synonyms: ["with alpha", "four"] },
  { value: "r", label: "Red only", synonyms: ["red channel", "r"] },
  { value: "g", label: "Green only", synonyms: ["green channel", "g"] },
  { value: "b", label: "Blue only", synonyms: ["blue channel", "b"] },
];

/**
 * Reuses the labels and synonyms the meta already declares, under a panel local
 * id so the `<label for>` association is unique on the page. The meta's "mode"
 * select is deliberately ignored: the tabs are the mode.
 */
function specFrom(
  metaId: string,
  localId: string,
  fallbackLabel: string,
  fallback: SelectOption[],
): SelectOptionSpec {
  const found = props.meta.options?.find((o) => o.kind === "select" && o.id === metaId);
  const base = found && found.kind === "select" ? found : null;
  return {
    kind: "select",
    id: localId,
    label: base?.label ?? fallbackLabel,
    default: base?.default ?? fallback[0].value,
    ...(base?.groups ? { groups: base.groups } : {}),
    options: base?.options ?? fallback,
  };
}

const bitsSpec = computed(() => specFrom("bits", "stego-bits", "Bits per channel", BITS_FALLBACK));
const channelsSpec = computed(() =>
  specFrom("channels", "stego-channels", "Channels used", CHANNELS_FALLBACK),
);

type VizChannel = "parity" | "r" | "g" | "b" | "a";

const vizSpec: SelectOptionSpec = {
  kind: "select",
  id: "stego-viz-channel",
  label: "Bit plane",
  default: "parity",
  options: [
    {
      value: "parity",
      label: "All colors combined",
      synonyms: ["parity", "xor", "rgb", "any channel", "combined"],
    },
    { value: "r", label: "Red", synonyms: ["red channel", "r"] },
    { value: "g", label: "Green", synonyms: ["green channel", "g"] },
    { value: "b", label: "Blue", synonyms: ["blue channel", "b"] },
    { value: "a", label: "Alpha", synonyms: ["alpha channel", "transparency", "a"] },
  ],
};

/* ------------------------------------------------------------------ *
 * shared image decoding
 * ------------------------------------------------------------------ */

interface Carrier {
  /** Raw pixels, exactly as the canvas read them back. Never resampled. */
  rgba: Uint8ClampedArray;
  width: number;
  height: number;
  name: string;
  /** Warning for the source format, or null when the format is lossless. */
  warning: string | null;
  /** True when any pixel was less than fully opaque. */
  hasTransparency: boolean;
}

interface PanelError {
  message: string;
  fix?: string;
}

interface DecodedImage {
  source: ImageBitmap | HTMLImageElement;
  width: number;
  height: number;
  release: () => void;
}

function toPanelError(err: unknown, fallback: string): PanelError {
  if (err instanceof ToolError) return { message: err.message, fix: err.fix };
  return { message: err instanceof Error ? err.message : fallback };
}

function nextFrame(): Promise<void> {
  return new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(() => resolve());
    else setTimeout(resolve, 0);
  });
}

/**
 * Decodes a file to something a canvas can draw.
 *
 * `createImageBitmap` is tried first with color management turned off, because
 * a browser that converts an ICC tagged PNG into the display profile rewrites
 * pixel values, and rewritten pixels are erased pixels for this tool. Older
 * browsers fall back to an `<img>` element.
 */
async function decodeImage(file: File): Promise<DecodedImage | null> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file, { colorSpaceConversion: "none" });
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        release: () => bitmap.close(),
      };
    } catch {
      // Fall through to the <img> path.
    }
  }

  const url = URL.createObjectURL(file);
  const img = new Image();
  const ok = await new Promise<boolean>((resolve) => {
    img.onload = () => resolve(true);
    img.onerror = () => resolve(false);
    img.src = url;
  });
  if (!ok || !img.naturalWidth || !img.naturalHeight) {
    URL.revokeObjectURL(url);
    return null;
  }
  return {
    source: img,
    width: img.naturalWidth,
    height: img.naturalHeight,
    release: () => URL.revokeObjectURL(url),
  };
}

function scanTransparency(rgba: Uint8ClampedArray): boolean {
  for (let i = 3; i < rgba.length; i += 4) {
    if (rgba[i] < 255) return true;
  }
  return false;
}

/** Reads a picked file into a carrier, or throws a ToolError explaining why not. */
async function readCarrier(file: File): Promise<Carrier> {
  if (file.type && !file.type.startsWith("image/")) {
    throw new ToolError(
      "not-an-image",
      `${file.name || "That file"} is not an image, so it has no pixels to work with.`,
      "Drop a PNG here. Any lossless picture works, but PNG is what you want to save.",
    );
  }

  const decoded = await decodeImage(file);
  if (!decoded) {
    throw new ToolError(
      "decode-failed",
      "That image could not be decoded.",
      "Try a different file, or re-save it as a PNG first.",
    );
  }

  const { source, width, height, release } = decoded;
  try {
    if (width * height > MAX_PIXELS) {
      throw new ToolError(
        "too-many-pixels",
        `That image is ${width} by ${height} pixels, which is more than the ${MAX_MEGAPIXELS} megapixel limit.`,
        "Pixels are never resized here, because resizing would destroy the hidden bits. Crop the image, or start from a smaller one.",
      );
    }

    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) {
      throw new ToolError(
        "no-canvas",
        "This browser would not give the page a 2D canvas.",
        "Try again in a recent Chrome, Firefox, Edge, or Safari.",
      );
    }
    ctx.drawImage(source, 0, 0);
    const pixels = ctx.getImageData(0, 0, width, height).data;

    return {
      rgba: pixels,
      width,
      height,
      name: file.name || "image.png",
      warning: formatWarning(file.type),
      hasTransparency: scanTransparency(pixels),
    };
  } finally {
    release();
  }
}

/** Paints an RGBA buffer onto a canvas at its native size. */
function paintCanvas(
  canvas: HTMLCanvasElement | undefined,
  rgba: Uint8ClampedArray,
  width: number,
  height: number,
): void {
  if (!canvas) return;
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const image = ctx.createImageData(width, height);
  image.data.set(rgba);
  ctx.putImageData(image, 0, 0);
}

function baseName(name: string): string {
  return name.replace(/\.[^./\\]+$/, "") || "image";
}

/* ------------------------------------------------------------------ *
 * tabs
 * ------------------------------------------------------------------ */

const tab = ref<"hide" | "reveal">("hide");

/* ------------------------------------------------------------------ *
 * hide tab
 * ------------------------------------------------------------------ */

const carrier = shallowRef<Carrier | null>(null);
const hideError = ref<PanelError | null>(null);
const hideBusy = ref(false);
const carrierCanvas = ref<HTMLCanvasElement>();

const payloadKind = ref<"text" | "file">("text");
const messageText = ref("");
const payloadFile = shallowRef<{ name: string; bytes: Uint8Array } | null>(null);

const password = ref("");
const bits = ref("1");
const channels = ref("rgb");

const embedResult = shallowRef<EmbedResult | null>(null);
const resultCanvas = ref<HTMLCanvasElement>();

const showViz = ref(false);
const vizChannel = ref<VizChannel>("parity");
const vizCanvas = ref<HTMLCanvasElement>();

const bitDepth = computed<BitDepth>(() => (bits.value === "2" ? 2 : 1));
const channelSet = computed<ChannelSet>(() => channels.value as ChannelSet);

const payloadBytes = computed(() => {
  if (payloadKind.value === "file") return payloadFile.value?.bytes.length ?? 0;
  return payloadFromText(messageText.value).length;
});

const capacity = computed(() => {
  const c = carrier.value;
  if (!c) return 0;
  try {
    return payloadCapacityBytes(
      c.width,
      c.height,
      bitDepth.value,
      channelSet.value,
      password.value !== "",
    );
  } catch {
    return 0;
  }
});

const overCapacity = computed(() => carrier.value !== null && payloadBytes.value > capacity.value);

const meterPercent = computed(() => {
  if (capacity.value <= 0) return 0;
  return Math.min(100, Math.round((payloadBytes.value / capacity.value) * 100));
});

const canHide = computed(
  () => carrier.value !== null && payloadBytes.value > 0 && !overCapacity.value && !hideBusy.value,
);

const embedRows = computed(() => (embedResult.value ? describeEmbed(embedResult.value) : null));

const stegoName = computed(() =>
  carrier.value ? `${baseName(carrier.value.name)}-stego.png` : "image-stego.png",
);

async function acceptCarrier(file: File | null | undefined) {
  if (!file) return;
  hideBusy.value = true;
  hideError.value = null;
  await nextFrame();
  try {
    const next = await readCarrier(file);
    carrier.value = next;
    embedResult.value = null;
    await nextTick();
    paintCanvas(carrierCanvas.value, next.rgba, next.width, next.height);
  } catch (err) {
    carrier.value = null;
    embedResult.value = null;
    hideError.value = toPanelError(err, "That image could not be loaded.");
  } finally {
    hideBusy.value = false;
  }
}

async function acceptPayloadFile(file: File | null | undefined) {
  if (!file) return;
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    payloadFile.value = { name: file.name || "payload.bin", bytes };
    payloadKind.value = "file";
    hideError.value = null;
  } catch {
    hideError.value = {
      message: "That file could not be read.",
      fix: "Pick it again, or copy it somewhere local first.",
    };
  }
}

function onCarrierFiles(files: File[]) {
  void acceptCarrier(files[0]);
}

function onPayloadFiles(files: File[]) {
  void acceptPayloadFile(files[0]);
}

/**
 * Composites the carrier onto white and drops the alpha.
 *
 * Canvas stores partly transparent pixels premultiplied, so the color it hands
 * back under them is already approximate and can shift again on the way out.
 * Flattening first makes every pixel fully opaque, which makes the round trip
 * exact and the hidden bits survivable.
 */
async function flattenCarrier() {
  const c = carrier.value;
  if (!c) return;
  const out = new Uint8ClampedArray(c.rgba.length);
  for (let i = 0; i < c.rgba.length; i += 4) {
    const a = c.rgba[i + 3] / 255;
    out[i] = Math.round(c.rgba[i] * a + 255 * (1 - a));
    out[i + 1] = Math.round(c.rgba[i + 1] * a + 255 * (1 - a));
    out[i + 2] = Math.round(c.rgba[i + 2] * a + 255 * (1 - a));
    out[i + 3] = 255;
  }
  carrier.value = { ...c, rgba: out, hasTransparency: false };
  embedResult.value = null;
  await nextTick();
  paintCanvas(carrierCanvas.value, out, c.width, c.height);
}

function paintViz() {
  const result = embedResult.value;
  const c = carrier.value;
  if (!result || !c || !showViz.value) return;
  const planes = visualizeLsb(result.rgba, 0, vizChannel.value);
  paintCanvas(vizCanvas.value, planes, c.width, c.height);
}

async function runHide() {
  const c = carrier.value;
  if (!c) return;

  hideBusy.value = true;
  hideError.value = null;
  await nextFrame();

  try {
    const payload =
      payloadKind.value === "file"
        ? (payloadFile.value?.bytes ?? new Uint8Array(0))
        : payloadFromText(messageText.value);

    const result = embedWithReport(c.rgba, payload, {
      bitsPerChannel: bitDepth.value,
      channels: channelSet.value,
      password: password.value,
    });

    embedResult.value = result;
    await nextTick();
    paintCanvas(resultCanvas.value, result.rgba, c.width, c.height);
    paintViz();
  } catch (err) {
    embedResult.value = null;
    hideError.value = toPanelError(err, "That payload could not be hidden.");
  } finally {
    hideBusy.value = false;
  }
}

function downloadStego() {
  const canvas = resultCanvas.value;
  if (!canvas) return;
  canvas.toBlob((blob) => {
    if (!blob) {
      hideError.value = {
        message: "This browser would not turn the result into a PNG.",
        fix: "Try again in a recent Chrome, Firefox, Edge, or Safari.",
      };
      return;
    }
    downloadBlob(blob, stegoName.value);
  }, "image/png");
}

// A result describes the exact settings and payload it was made from, so any
// edit to those makes it stale rather than merely out of date.
watch([bits, channels, password, payloadKind, messageText, payloadFile], () => {
  embedResult.value = null;
});

watch([showViz, vizChannel], async () => {
  if (!showViz.value) return;
  await nextTick();
  paintViz();
});

/* ------------------------------------------------------------------ *
 * reveal tab
 * ------------------------------------------------------------------ */

const stego = shallowRef<Carrier | null>(null);
const revealError = ref<PanelError | null>(null);
const revealBusy = ref(false);
const stegoCanvas = ref<HTMLCanvasElement>();
const revealPassword = ref("");
const revealResult = shallowRef<ExtractResult | null>(null);

const revealIsText = computed(() =>
  revealResult.value ? isText(revealResult.value.payload) : false,
);

const revealText = computed(() => {
  const result = revealResult.value;
  if (!result || !revealIsText.value) return "";
  try {
    return textFromPayload(result.payload);
  } catch {
    return "";
  }
});

/**
 * `describeExtract` already puts the decoded message in a "Message" row, and the
 * panel shows it in a copyable block of its own, so that one row is dropped to
 * avoid printing the secret twice.
 */
const revealRows = computed(() => {
  const result = revealResult.value;
  if (!result) return null;
  const rows = describeExtract(result);
  delete rows.Message;
  return rows;
});

async function acceptStego(file: File | null | undefined) {
  if (!file) return;
  revealBusy.value = true;
  revealError.value = null;
  await nextFrame();
  try {
    const next = await readCarrier(file);
    stego.value = next;
    revealResult.value = null;
    await nextTick();
    paintCanvas(stegoCanvas.value, next.rgba, next.width, next.height);
  } catch (err) {
    stego.value = null;
    revealResult.value = null;
    revealError.value = toPanelError(err, "That image could not be loaded.");
  } finally {
    revealBusy.value = false;
  }
}

async function runReveal() {
  const c = stego.value;
  if (!c) return;

  revealBusy.value = true;
  revealError.value = null;
  await nextFrame();

  try {
    revealResult.value = extract(c.rgba, { password: revealPassword.value });
  } catch (err) {
    revealResult.value = null;
    revealError.value = toPanelError(err, "Nothing could be read out of that image.");
  } finally {
    revealBusy.value = false;
  }
}

function downloadRecovered() {
  const result = revealResult.value;
  if (!result) return;
  downloadBlob(
    new Blob([result.payload.slice().buffer as ArrayBuffer], { type: "application/octet-stream" }),
    "recovered.bin",
  );
}

function onStegoFiles(files: File[]) {
  void acceptStego(files[0]);
}

watch(revealPassword, () => {
  revealResult.value = null;
});

/* ------------------------------------------------------------------ *
 * lifecycle
 * ------------------------------------------------------------------ */

onUnmounted(() => {
  carrier.value = null;
  stego.value = null;
  embedResult.value = null;
  revealResult.value = null;
  payloadFile.value = null;
});
</script>

<template>
  <div class="flex flex-col gap-5 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <Tabs v-model="tab" class="w-full">
      <TabsList class="flex w-full flex-wrap sm:w-fit">
        <TabsTrigger value="hide"> Hide </TabsTrigger>
        <TabsTrigger value="reveal"> Reveal </TabsTrigger>
      </TabsList>

      <!-- ---------------------------------------------------------- -->
      <!-- hide                                                        -->
      <!-- ---------------------------------------------------------- -->
      <TabsContent value="hide" class="flex flex-col gap-4 pt-4">
        <div class="flex flex-col gap-2">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Carrier image
          </span>
          <FileDrop
            accept="image/*"
            label="Drop the picture that will carry the data, or click to choose"
            hint="It is decoded on a canvas in this tab: your files and inputs never leave your device."
            @files="onCarrierFiles"
          />
        </div>

        <div v-if="carrier" class="flex flex-wrap items-start gap-3">
          <canvas
            ref="carrierCanvas"
            class="block h-auto max-h-40 w-auto max-w-full rounded-[10px] shadow-[var(--sh-inset)]"
          />
          <div class="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
            <span class="truncate font-mono text-foreground">{{ carrier.name }}</span>
            <span>{{ carrier.width }} by {{ carrier.height }} pixels</span>
            <span>Capacity {{ formatBytes(capacity) }} at the settings below</span>
          </div>
        </div>

        <ErrorBanner v-if="carrier?.warning" variant="warning" :message="carrier.warning" />

        <div
          v-if="carrier?.hasTransparency"
          class="flex flex-col gap-2 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]"
        >
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Transparency
          </span>
          <p class="text-sm text-muted-foreground">
            Some pixels in this image are not fully opaque. Canvas stores those premultiplied, which
            can rewrite the color underneath them and erase the hidden bits on the way back out.
            Flatten the image first, or expect the reveal step to come up empty.
          </p>
          <div>
            <Button type="button" variant="outline" size="sm" @click="flattenCarrier">
              Flatten onto white
            </Button>
          </div>
        </div>

        <!-- payload -->
        <fieldset class="flex flex-col gap-2">
          <legend class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            What to hide
          </legend>
          <div class="flex flex-wrap items-center gap-4">
            <label class="flex items-center gap-2 text-sm">
              <input
                v-model="payloadKind"
                type="radio"
                name="stego-payload-kind"
                value="text"
                class="size-4 accent-[var(--primary)]"
              />
              A message
            </label>
            <label class="flex items-center gap-2 text-sm">
              <input
                v-model="payloadKind"
                type="radio"
                name="stego-payload-kind"
                value="file"
                class="size-4 accent-[var(--primary)]"
              />
              A file
            </label>
          </div>
        </fieldset>

        <div v-if="payloadKind === 'text'" class="flex flex-col gap-1.5">
          <Label for="stego-message" class="text-xs text-muted-foreground">Message</Label>
          <Textarea
            id="stego-message"
            v-model="messageText"
            class="min-h-28 bg-secondary font-mono shadow-[var(--sh-inset)]"
            spellcheck="false"
            autocapitalize="off"
            placeholder="Type the message you want to hide in the picture."
          />
        </div>

        <div v-else class="flex flex-col gap-2">
          <FileDrop
            compact
            :paste="false"
            :label="
              payloadFile ? payloadFile.name : 'Drop the file to hide here or click to choose'
            "
            :hint="payloadFile ? formatBytes(payloadFile.bytes.length) : undefined"
            @files="onPayloadFiles"
          />
          <p class="text-xs text-muted-foreground">
            The file is hidden byte for byte. Its name is not stored, so the reveal step hands it
            back as recovered.bin for you to rename.
          </p>
        </div>

        <!-- settings -->
        <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <div class="flex flex-col gap-1.5">
            <Label for="stego-password" class="text-xs text-muted-foreground">
              Password, optional
            </Label>
            <Input
              id="stego-password"
              v-model="password"
              type="password"
              autocomplete="new-password"
              placeholder="Leave empty for none"
              class="bg-secondary shadow-[var(--sh-inset)]"
            />
          </div>
          <div class="flex flex-col gap-1.5">
            <Label for="stego-bits" class="text-xs text-muted-foreground">Bits per channel</Label>
            <SearchableSelect
              id="stego-bits"
              :spec="bitsSpec"
              :model-value="bits"
              class="w-full bg-card"
              @update:model-value="(v: string) => (bits = v)"
            />
          </div>
          <div class="flex flex-col gap-1.5">
            <Label for="stego-channels" class="text-xs text-muted-foreground">Channels used</Label>
            <SearchableSelect
              id="stego-channels"
              :spec="channelsSpec"
              :model-value="channels"
              class="w-full bg-card"
              @update:model-value="(v: string) => (channels = v)"
            />
          </div>
        </div>

        <p class="text-xs text-muted-foreground">
          A password runs the payload through a SHA-256 keystream. It is never put in the URL or
          saved anywhere, so it has to be typed again to read the message back.
        </p>

        <ErrorBanner
          v-if="channels === 'rgba'"
          variant="warning"
          message="Writing into the alpha channel leaves pixels that are not fully opaque. Canvas stores those premultiplied, so the colors underneath can shift by one step when the PNG is written and take the hidden bits with them. Red, green, and blue is the reliable choice unless you have checked that the extra capacity survives."
        />

        <!-- capacity meter -->
        <div class="flex flex-col gap-1.5">
          <div class="flex flex-wrap items-baseline justify-between gap-2 text-xs">
            <span class="font-semibold tracking-[0.04em] text-muted-foreground uppercase">
              Capacity
            </span>
            <span class="font-mono tabular-nums" :class="overCapacity ? 'text-destructive' : ''">
              {{ formatBytes(payloadBytes) }} of {{ formatBytes(capacity) }}
              <template v-if="capacity > 0">({{ meterPercent }} percent)</template>
            </span>
          </div>
          <ProgressBar
            :value="meterPercent"
            :tone="overCapacity ? 'destructive' : 'brand'"
            aria-label="Payload size against image capacity"
          />
          <p v-if="overCapacity" class="text-xs text-destructive">
            This payload is
            {{ formatBytes(payloadBytes - capacity) }} too big for the image at these settings. Use
            a bigger picture, 2 bits per channel, more channels, or a shorter message.
          </p>
        </div>

        <div class="flex flex-wrap items-center gap-2">
          <Button type="button" :disabled="!canHide" @click="runHide">
            <EyeOff class="size-3.5" aria-hidden="true" />
            {{ hideBusy ? "Working…" : "Hide" }}
          </Button>
          <Button
            v-if="embedResult"
            type="button"
            variant="outline"
            :disabled="hideBusy"
            @click="downloadStego"
          >
            <Download class="size-3.5" aria-hidden="true" />
            Download PNG
          </Button>
          <Button v-if="embedResult" type="button" variant="ghost" @click="showViz = !showViz">
            <Eye class="size-3.5" aria-hidden="true" />
            {{ showViz ? "Hide bit plane" : "Show bit plane" }}
          </Button>
        </div>

        <ErrorBanner v-if="hideError" :message="hideError.message" :hint="hideError.fix" />

        <div v-if="embedResult" class="flex flex-col gap-3">
          <div class="grid grid-cols-1 gap-3" :class="showViz ? 'md:grid-cols-2' : ''">
            <figure class="flex flex-col gap-1.5">
              <figcaption
                class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase"
              >
                Result
              </figcaption>
              <canvas
                ref="resultCanvas"
                class="block h-auto w-full rounded-[10px] shadow-[var(--sh-inset)]"
              />
            </figure>

            <figure v-show="showViz" class="flex flex-col gap-1.5">
              <figcaption
                class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase"
              >
                Least significant bit plane
              </figcaption>
              <canvas
                ref="vizCanvas"
                class="block h-auto w-full rounded-[10px] shadow-[var(--sh-inset)]"
              />
              <div class="flex flex-col gap-1.5">
                <Label for="stego-viz-channel" class="text-xs text-muted-foreground">
                  Bit plane channel
                </Label>
                <SearchableSelect
                  id="stego-viz-channel"
                  :spec="vizSpec"
                  :model-value="vizChannel"
                  class="w-full bg-card"
                  @update:model-value="(v: string) => (vizChannel = v as VizChannel)"
                />
                <p class="text-xs text-muted-foreground">
                  White means the lowest bit of that channel is set. A photo looks like static
                  either way, which is what makes the hiding place hard to spot. A flat gradient or
                  a screenshot shows obvious structure instead.
                </p>
              </div>
            </figure>
          </div>

          <OutputView v-if="embedRows" :output="embedRows" />
        </div>

        <p
          v-else-if="!carrier && !hideError"
          class="flex items-center gap-2 text-xs text-muted-foreground"
        >
          <ImageOff class="size-3.5" aria-hidden="true" />
          No carrier loaded yet. Pictures are never resized here, so anything over
          {{ MAX_MEGAPIXELS }} megapixels is refused rather than scaled down.
        </p>
      </TabsContent>

      <!-- ---------------------------------------------------------- -->
      <!-- reveal                                                      -->
      <!-- ---------------------------------------------------------- -->
      <TabsContent value="reveal" class="flex flex-col gap-4 pt-4">
        <div class="flex flex-col gap-2">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Stego image
          </span>
          <FileDrop
            accept="image/*"
            label="Drop the PNG that came out of the hide step, or click to choose"
            hint="The settings are read from the header, so there is nothing to remember except the password if one was used."
            @files="onStegoFiles"
          />
        </div>

        <div v-if="stego" class="flex flex-wrap items-start gap-3">
          <canvas
            ref="stegoCanvas"
            class="block h-auto max-h-40 w-auto max-w-full rounded-[10px] shadow-[var(--sh-inset)]"
          />
          <div class="flex min-w-0 flex-col gap-1 text-xs text-muted-foreground">
            <span class="truncate font-mono text-foreground">{{ stego.name }}</span>
            <span>{{ stego.width }} by {{ stego.height }} pixels</span>
          </div>
        </div>

        <ErrorBanner v-if="stego?.warning" variant="warning" :message="stego.warning" />

        <div class="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div class="flex w-full flex-col gap-1.5 sm:w-72">
            <Label for="stego-reveal-password" class="text-xs text-muted-foreground">
              Password, optional
            </Label>
            <Input
              id="stego-reveal-password"
              v-model="revealPassword"
              type="password"
              autocomplete="new-password"
              placeholder="Leave empty for none"
              class="bg-secondary shadow-[var(--sh-inset)]"
            />
          </div>
          <Button type="button" :disabled="!stego || revealBusy" @click="runReveal">
            <Eye class="size-3.5" aria-hidden="true" />
            {{ revealBusy ? "Working…" : "Reveal" }}
          </Button>
        </div>

        <ErrorBanner v-if="revealError" :message="revealError.message" :hint="revealError.fix" />

        <div v-if="revealResult" class="flex flex-col gap-3">
          <div v-if="revealIsText" class="rounded-[10px] bg-secondary shadow-[var(--sh-inset)]">
            <div class="flex items-center justify-between gap-2 px-3 pt-2">
              <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
                Hidden message
              </span>
              <CopyButton :text="revealText" label="Copy" />
            </div>
            <pre
              class="max-h-96 overflow-auto px-3 pt-1 pb-3 font-mono text-sm break-words whitespace-pre-wrap"
              >{{ revealText }}</pre>
          </div>

          <div
            v-else
            class="flex flex-wrap items-center gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]"
          >
            <div class="flex min-w-0 flex-col gap-0.5">
              <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
                Hidden file
              </span>
              <span class="font-mono text-sm">
                {{ formatBytes(revealResult.payload.length) }} of binary data
              </span>
            </div>
            <Button type="button" variant="outline" size="sm" @click="downloadRecovered">
              <Download class="size-3.5" aria-hidden="true" />
              Download recovered file
            </Button>
          </div>

          <OutputView v-if="revealRows" :output="revealRows" />
        </div>

        <p v-else-if="!revealError" class="flex items-center gap-2 text-xs text-muted-foreground">
          <ImageOff class="size-3.5" aria-hidden="true" />
          Nothing read yet. Load an image and press Reveal.
        </p>
      </TabsContent>
    </Tabs>

    <p v-if="props.meta.privacyNote" class="text-xs text-muted-foreground">
      {{ props.meta.privacyNote }}
    </p>
  </div>
</template>
