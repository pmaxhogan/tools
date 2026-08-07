<script setup lang="ts">
import { computed, onUnmounted, ref, shallowRef } from "vue";
import { AlertTriangle, CheckCircle2, Eraser, Loader2, Usb, X, Zap } from "lucide-vue-next";
// Type-only import: esptool-js ships ESM with extensionless internal imports
// that Node cannot resolve during the SSR build, so the runtime values are
// pulled in with a dynamic import inside the connect handler instead.
import type { ESPLoader, Transport } from "esptool-js";
import type { SelectOptionSpec, ToolMeta } from "@/tools/types";
import { ToolError } from "@/tools/types";
import {
  CHIP_LABELS,
  chipKeyFromName,
  defaultOffsetsFor,
  humanFlashError,
  parseFlashLayout,
  validateFirmware,
  type ChipKey,
  type FlashRegion,
} from "@/tools/firmware-flasher/index";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { SearchableSelect } from "@/components/ui/searchable-select";

/**
 * Bespoke panel for the firmware flasher. The pure layer in
 * `src/tools/firmware-flasher` owns every decision that does not need a device:
 * the per chip offsets, parsing and overlap checking the offset table, the
 * firmware sanity check, and turning a raw esptool failure into plain English.
 *
 * This island owns the half that only a live browser can do. It requests the
 * serial port inside the click, wraps it in Espressif's Transport, runs
 * ESPLoader.main() to identify the chip, shows the planned layout for an
 * explicit confirmation, then streams the writeFlash blocks with a progress
 * bar. The flasher stubs are bundled inside esptool-js, so nothing is fetched
 * while flashing, and your firmware is never uploaded anywhere: it goes from
 * this tab straight down the USB cable.
 */
defineProps<{ meta: ToolMeta }>();

/* ---------------------------------------------------------------- */
/* Web Serial shapes (not in lib.dom, declared narrowly here)         */
/* ---------------------------------------------------------------- */

interface SerialApiLike extends EventTarget {
  requestPort(options?: { filters?: unknown[] }): Promise<unknown>;
}

function serialApi(): SerialApiLike | undefined {
  return (navigator as Navigator & { serial?: SerialApiLike }).serial;
}

/** The device type Espressif's Transport constructor expects. */
type TransportDevice = ConstructorParameters<typeof Transport>[0];

/* ---------------------------------------------------------------- */
/* baud rates                                                        */
/* ---------------------------------------------------------------- */

const HANDSHAKE_BAUD = 115200;

const baudSpec: SelectOptionSpec = {
  kind: "select",
  id: "ff-baud",
  label: "Flash baud",
  default: "460800",
  options: [
    {
      value: "115200",
      label: "115200",
      synonyms: ["baud", "bps", "slowest", "safest", "handshake speed"],
    },
    { value: "230400", label: "230400", synonyms: ["baud", "bps"] },
    { value: "460800", label: "460800", synonyms: ["baud", "bps", "default speed"] },
    { value: "921600", label: "921600", synonyms: ["baud", "bps", "fastest", "high speed"] },
  ],
};

const baud = ref("460800");
const eraseAll = ref(false);

/* ---------------------------------------------------------------- */
/* files                                                             */
/* ---------------------------------------------------------------- */

type Mode = "single" | "advanced";
const mode = ref<Mode>("single");

const modeSpec: SelectOptionSpec = {
  kind: "select",
  id: "ff-mode",
  label: "Mode",
  default: "single",
  options: [
    {
      value: "single",
      label: "Single file",
      synonyms: ["one file", "single binary", "app only", "one build"],
    },
    {
      value: "advanced",
      label: "Offset table",
      synonyms: [
        "advanced",
        "multiple files",
        "bootloader partition app",
        "layout",
        "custom offsets",
      ],
    },
  ],
};

/**
 * A chosen firmware file. `offset` is the hex text shown in the advanced
 * editor; single file mode ignores it and uses the chip's app offset. `written`
 * and `total` drive this file's progress bar during a flash.
 */
interface FileEntry {
  id: number;
  name: string;
  size: number;
  bytes: Uint8Array;
  offset: string;
  written: number;
  total: number;
}

const files = ref<FileEntry[]>([]);
let fileId = 0;

/**
 * The chip the offset presets are keyed to before a board is connected. Once a
 * board is identified the detected chip takes over, so this is only a best
 * guess for seeding the advanced editor and previewing the single file offset.
 */
const presetChip = ref<ChipKey>("esp32");

const fileError = ref<string | null>(null);
const dragOver = ref(false);

function seedOffset(index: number): string {
  const full = defaultOffsetsFor(presetChip.value).full;
  const region = full[index];
  const address = region ? region.address : defaultOffsetsFor(presetChip.value).app;
  return `0x${address.toString(16)}`;
}

async function addFiles(list: FileList | File[]) {
  fileError.value = null;
  for (const file of Array.from(list)) {
    try {
      const buffer = await file.arrayBuffer();
      files.value.push({
        id: fileId++,
        name: file.name,
        size: file.size,
        bytes: new Uint8Array(buffer),
        offset: seedOffset(files.value.length),
        written: 0,
        total: 0,
      });
    } catch {
      fileError.value = `Could not read ${file.name}.`;
    }
  }
  if (mode.value === "single" && files.value.length > 1) mode.value = "advanced";
}

function onPick(event: Event) {
  const input = event.target as HTMLInputElement;
  if (input.files) void addFiles(input.files);
  input.value = "";
}

function onDrop(event: DragEvent) {
  dragOver.value = false;
  if (event.dataTransfer?.files?.length) void addFiles(event.dataTransfer.files);
}

function removeFile(id: number) {
  files.value = files.value.filter((f) => f.id !== id);
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
}

/* ---------------------------------------------------------------- */
/* connection and flashing state                                     */
/* ---------------------------------------------------------------- */

type Stage = "idle" | "connecting" | "confirm" | "flashing" | "erasing" | "done";
const stage = ref<Stage>("idle");

const transport = shallowRef<Transport | null>(null);
const esploader = shallowRef<ESPLoader | null>(null);

const chipName = ref("");
const chipKey = ref<ChipKey | null>(null);
const chipMac = ref("");
const chipFeatures = ref("");

const errorTitle = ref<string | null>(null);
const errorDetail = ref<string | null>(null);
const showManualReset = ref(false);
const canFallback = ref(false);

const warnings = ref<string[]>([]);
const doneMessage = ref("");

/** The regions that will actually be written, computed from the detected chip. */
const plan = ref<{ region: FlashRegion; entry: FileEntry }[]>([]);

const busy = computed(
  () => stage.value === "connecting" || stage.value === "flashing" || stage.value === "erasing",
);

const overallProgress = computed(() => {
  const total = plan.value.reduce((sum, p) => sum + p.entry.total, 0);
  if (total === 0) return 0;
  const written = plan.value.reduce((sum, p) => sum + p.entry.written, 0);
  return Math.min(100, Math.round((written / total) * 100));
});

function setError(title: string, detail: string, manual = false) {
  errorTitle.value = title;
  errorDetail.value = detail;
  showManualReset.value = manual;
}

function clearError() {
  errorTitle.value = null;
  errorDetail.value = null;
  showManualReset.value = false;
  canFallback.value = false;
}

/* ---------------------------------------------------------------- */
/* esptool terminal                                                  */
/* ---------------------------------------------------------------- */

const log = ref<string[]>([]);

/** Espressif's loader writes its progress narration here. Memory only. */
const terminal = {
  clean() {
    log.value = [];
  },
  writeLine(data: string) {
    log.value.push(data);
    if (log.value.length > 400) log.value.splice(0, log.value.length - 400);
  },
  write(data: string) {
    if (log.value.length === 0) log.value.push("");
    log.value[log.value.length - 1] += data;
  },
};

/* ---------------------------------------------------------------- */
/* build the plan                                                    */
/* ---------------------------------------------------------------- */

/**
 * Turn the chosen files into the regions to write, using the detected chip.
 * Single file mode uses the chip's app offset. Advanced mode runs the offsets
 * through the pure parser, which validates them and refuses an overlap. Throws
 * ToolError on a bad offset or an overlap, so the confirm step never shows a
 * plan that would brick the board.
 */
function buildPlan(chip: ChipKey): { region: FlashRegion; entry: FileEntry }[] {
  if (files.value.length === 0) {
    throw new ToolError("no-files", "No firmware files were added.", "Add at least one .bin file.");
  }

  if (mode.value === "single") {
    const entry = files.value[0] as FileEntry;
    return [{ region: { address: defaultOffsetsFor(chip).app, name: entry.name }, entry }];
  }

  const table = files.value.map((f) => `${f.offset.trim()} ${f.name}`).join("\n");
  const sizes = files.value.map((f) => f.size);
  const regions = parseFlashLayout(table, sizes);
  return regions.map((region, index) => ({ region, entry: files.value[index] as FileEntry }));
}

/* ---------------------------------------------------------------- */
/* connect and identify                                              */
/* ---------------------------------------------------------------- */

/**
 * Request a port and run the sync handshake to identify the chip. Returns true
 * when a loader is live and identified. Does NOT open the port itself: the
 * Transport and ESPLoader do that during main(), so opening it here would only
 * earn an InvalidStateError.
 */
async function identify(flashBaud: number): Promise<boolean> {
  const api = serialApi();
  if (!api) return false;

  let device: unknown;
  try {
    device = await api.requestPort();
  } catch (err) {
    // A dismissed chooser is not a fault.
    if (err instanceof DOMException && err.name === "NotFoundError") return false;
    setError("Could not open the port chooser.", err instanceof Error ? err.message : String(err));
    return false;
  }

  try {
    const esptool = await import("esptool-js");
    const t = new esptool.Transport(device as TransportDevice, false);
    const loader = new esptool.ESPLoader({ transport: t, baudrate: flashBaud, terminal });
    transport.value = t;
    esploader.value = loader;

    const description = await loader.main();
    chipName.value = description;
    const key = chipKeyFromName(loader.chip.CHIP_NAME || description);
    chipKey.value = key;
    presetChip.value = key ?? presetChip.value;

    try {
      chipMac.value = await loader.chip.readMac(loader);
    } catch {
      chipMac.value = "";
    }
    try {
      const feats = await loader.chip.getChipFeatures(loader);
      chipFeatures.value = feats.join(", ");
    } catch {
      chipFeatures.value = "";
    }
    return true;
  } catch (err) {
    await teardown();
    const human = humanFlashError(err);
    setError(human.title, human.detail, true);
    canFallback.value = flashBaud > HANDSHAKE_BAUD;
    return false;
  }
}

/** The main button: identify the board, then stop for an explicit confirmation. */
async function connectAndFlash() {
  clearError();
  doneMessage.value = "";
  warnings.value = [];
  fileError.value = null;
  if (files.value.length === 0) {
    fileError.value = "Add at least one .bin file before flashing.";
    return;
  }

  stage.value = "connecting";
  const ok = await identify(Number(baud.value));
  if (!ok) {
    stage.value = "idle";
    return;
  }

  // Build the plan from the detected chip and sanity check every file.
  try {
    const chip = chipKey.value;
    if (!chip) {
      throw new ToolError(
        "unknown-chip",
        `The connected board reports "${chipName.value}", which is not an ESP32 family or ESP8266 chip this tool can flash.`,
        "This tool flashes the ESP32, ESP32-S2, ESP32-S3, ESP32-C3 and ESP8266 only.",
      );
    }
    const built = buildPlan(chip);
    const collected: string[] = [];
    for (const item of built) {
      const check = validateFirmware(item.entry.bytes, chip);
      for (const w of check.warnings) collected.push(`${item.entry.name}: ${w}`);
    }
    plan.value = built;
    warnings.value = collected;
    stage.value = "confirm";
  } catch (err) {
    await teardown();
    if (err instanceof ToolError) {
      setError(err.message, err.fix ?? "");
    } else {
      const human = humanFlashError(err);
      setError(human.title, human.detail);
    }
    stage.value = "idle";
  }
}

/* ---------------------------------------------------------------- */
/* flash                                                             */
/* ---------------------------------------------------------------- */

/** Runs after the user confirms the layout. Streams the blocks, then resets. */
async function confirmFlash() {
  const loader = esploader.value;
  if (!loader) return;

  for (const item of plan.value) {
    item.entry.written = 0;
    item.entry.total = item.entry.bytes.length;
  }
  stage.value = "flashing";
  clearError();

  try {
    await loader.writeFlash({
      fileArray: plan.value.map((p) => ({ data: p.entry.bytes, address: p.region.address })),
      flashSize: "keep",
      flashMode: "keep",
      flashFreq: "keep",
      eraseAll: eraseAll.value,
      compress: true,
      reportProgress: (fileIndex: number, written: number, total: number) => {
        const item = plan.value[fileIndex];
        if (item) {
          item.entry.written = written;
          item.entry.total = total;
        }
      },
    });

    try {
      await loader.after("hard_reset");
    } catch {
      // A reset failure is not a flash failure: the bytes are already written.
    }

    doneMessage.value = `Flashed ${plan.value.length} file${plan.value.length === 1 ? "" : "s"} to the ${CHIP_LABELS[chipKey.value ?? "esp32"]}. The board has been reset and is running the new firmware.`;
    stage.value = "done";
  } catch (err) {
    const human = humanFlashError(err);
    setError(human.title, human.detail, true);
    canFallback.value = Number(baud.value) > HANDSHAKE_BAUD;
    stage.value = "idle";
  } finally {
    await teardown();
  }
}

async function cancelConfirm() {
  await teardown();
  stage.value = "idle";
  plan.value = [];
}

/* ---------------------------------------------------------------- */
/* just erase                                                        */
/* ---------------------------------------------------------------- */

async function eraseOnly() {
  clearError();
  doneMessage.value = "";
  warnings.value = [];
  stage.value = "erasing";

  const ok = await identify(Number(baud.value));
  if (!ok) {
    stage.value = "idle";
    return;
  }

  const loader = esploader.value;
  if (!loader) {
    stage.value = "idle";
    return;
  }

  try {
    await loader.eraseFlash();
    try {
      await loader.after("hard_reset");
    } catch {
      // See confirmFlash: a reset failure does not undo the erase.
    }
    doneMessage.value =
      "The whole flash was erased. The board is blank until you flash firmware to it.";
    stage.value = "done";
  } catch (err) {
    const human = humanFlashError(err);
    setError(human.title, human.detail, true);
    stage.value = "idle";
  } finally {
    await teardown();
  }
}

/* ---------------------------------------------------------------- */
/* retry at a lower baud                                             */
/* ---------------------------------------------------------------- */

function fallbackTo115200() {
  baud.value = String(HANDSHAKE_BAUD);
  clearError();
}

/* ---------------------------------------------------------------- */
/* teardown                                                          */
/* ---------------------------------------------------------------- */

/** Release the loader and close the port so other programs can use it again. */
async function teardown() {
  const t = transport.value;
  esploader.value = null;
  transport.value = null;
  if (t) {
    try {
      await t.disconnect();
    } catch {
      // Already closed or already unplugged: nothing useful to do.
    }
  }
}

function reset() {
  stage.value = "idle";
  doneMessage.value = "";
  clearError();
  plan.value = [];
  for (const f of files.value) {
    f.written = 0;
    f.total = 0;
  }
}

onUnmounted(() => {
  void teardown();
});
</script>

<template>
  <div class="flex flex-col gap-4">
    <!-- honesty card -->
    <div class="rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
      <h3 class="text-[17px] font-semibold leading-[1.35]">Before you flash</h3>
      <ul class="mt-3 flex flex-col gap-2 text-sm text-muted-foreground">
        <li>
          This flashes ESP32, ESP32-S2, ESP32-S3, ESP32-C3 and ESP8266 boards only. A Raspberry Pi
          Pico is not serial flashable: it mounts as a USB drive and takes a UF2 file by drag and
          drop, so it cannot be flashed here.
        </li>
        <li>
          Flashing the wrong file to the wrong offset can leave a board unable to boot. A bad flash
          can usually be recovered by erasing and flashing a known good build, sometimes with the
          manual BOOT and EN reset.
        </li>
        <li>
          Everything runs in this tab: your files and inputs never leave your device. Your firmware
          is never uploaded anywhere. It goes from here straight down the USB cable.
        </li>
      </ul>
    </div>

    <!-- files -->
    <div class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
      <div class="flex flex-wrap items-center gap-3">
        <Label class="text-sm font-medium">Firmware files</Label>
        <div class="ml-auto flex items-center gap-2">
          <Label for="ff-mode" class="text-xs text-muted-foreground">Mode</Label>
          <fieldset :disabled="busy" class="m-0 w-40 min-w-0 border-0 p-0">
            <SearchableSelect
              id="ff-mode"
              :spec="modeSpec"
              :model-value="mode"
              @update:model-value="(v) => (mode = v as Mode)"
            />
          </fieldset>
        </div>
      </div>

      <label
        class="flex cursor-pointer flex-col items-center justify-center gap-2 rounded-[10px] border border-dashed px-4 py-8 text-center text-sm transition-colors"
        :class="dragOver ? 'border-primary bg-accent' : 'border-input text-muted-foreground'"
        @dragover.prevent="dragOver = true"
        @dragleave.prevent="dragOver = false"
        @drop.prevent="onDrop"
      >
        <input
          type="file"
          accept=".bin,application/octet-stream"
          multiple
          class="sr-only"
          :disabled="busy"
          @change="onPick"
        />
        <span class="font-medium text-foreground">Drop .bin files here, or click to choose</span>
        <span
          >Single file mode flashes one build at the chip's app offset. Switch to the offset table
          to flash a bootloader, partition table and app together.</span
        >
      </label>

      <p v-if="fileError" role="alert" class="text-sm text-destructive">
        {{ fileError }}
      </p>

      <div v-if="files.length" class="flex flex-col gap-2">
        <div
          v-for="entry in files"
          :key="entry.id"
          class="flex flex-wrap items-center gap-3 rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]"
        >
          <span class="min-w-0 flex-1 truncate font-mono text-xs">{{ entry.name }}</span>
          <span class="text-xs text-muted-foreground tabular-nums">{{
            formatSize(entry.size)
          }}</span>
          <div v-if="mode === 'advanced'" class="flex items-center gap-1.5">
            <Label :for="`ff-offset-${entry.id}`" class="text-xs text-muted-foreground"
              >Offset</Label
            >
            <Input
              :id="`ff-offset-${entry.id}`"
              v-model="entry.offset"
              class="h-8 w-24 font-mono"
              spellcheck="false"
              autocomplete="off"
              :disabled="busy"
              placeholder="0x10000"
            />
          </div>
          <Button
            variant="ghost"
            size="sm"
            :disabled="busy"
            aria-label="Remove file"
            @click="removeFile(entry.id)"
          >
            <X class="size-3.5" aria-hidden="true" />
          </Button>
        </div>
        <p v-if="mode === 'single' && files.length === 1" class="text-xs text-muted-foreground">
          This file will be written at the application offset for the chip once the board is
          identified, 0x10000 on the ESP32 line and 0x0 on the ESP8266.
        </p>
      </div>
    </div>

    <!-- options and actions -->
    <div class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
      <div class="flex flex-wrap items-end gap-4">
        <div class="flex min-w-0 flex-col gap-1.5">
          <Label for="ff-baud" class="text-xs text-muted-foreground">Flash baud</Label>
          <fieldset :disabled="busy" class="m-0 w-32 min-w-0 border-0 p-0">
            <SearchableSelect id="ff-baud" v-model="baud" :spec="baudSpec" />
          </fieldset>
        </div>

        <div class="flex items-center gap-2 pb-1.5">
          <Switch id="ff-erase" v-model="eraseAll" :disabled="busy" />
          <Label for="ff-erase" class="cursor-pointer text-xs text-muted-foreground"
            >Erase whole flash first</Label
          >
        </div>
      </div>

      <p class="text-xs text-muted-foreground">
        The handshake always runs at {{ HANDSHAKE_BAUD }} baud, then the flash switches to the speed
        above. 921600 is fast but flaky on some USB serial bridges: if a flash times out, drop to
        460800 or 115200. Erasing the whole flash also wipes stored settings and calibration, so
        leave it off unless you mean to start clean.
      </p>

      <div class="flex flex-wrap items-center gap-3">
        <Button
          size="lg"
          :disabled="busy || files.length === 0 || stage === 'confirm'"
          @click="connectAndFlash"
        >
          <Loader2 v-if="stage === 'connecting'" class="size-4 animate-spin" aria-hidden="true" />
          <Usb v-else class="size-4" aria-hidden="true" />
          {{ stage === "connecting" ? "Connecting…" : "Connect and flash" }}
        </Button>

        <Button variant="outline" :disabled="busy || stage === 'confirm'" @click="eraseOnly">
          <Eraser class="size-4" aria-hidden="true" />
          Just erase flash
        </Button>
      </div>
    </div>

    <!-- error -->
    <div
      v-if="errorTitle"
      role="alert"
      class="rounded-[18px] border border-destructive/50 bg-destructive/5 p-5 shadow-[var(--sh-sm)] sm:p-6"
    >
      <div class="flex items-start gap-2">
        <AlertTriangle class="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
        <div class="min-w-0">
          <p class="font-medium text-destructive">
            {{ errorTitle }}
          </p>
          <p v-if="errorDetail" class="mt-1 text-sm text-muted-foreground">
            {{ errorDetail }}
          </p>
          <div
            v-if="showManualReset"
            class="mt-3 rounded-[10px] bg-secondary px-3 py-2 text-sm text-muted-foreground shadow-[var(--sh-inset)]"
          >
            <p class="font-medium text-foreground">Manual download mode</p>
            <p class="mt-1">
              Hold the BOOT button down, tap and release EN or RST, then release BOOT. The board is
              now waiting for a flash. Click Connect and flash again.
            </p>
          </div>
          <Button
            v-if="canFallback"
            variant="outline"
            size="sm"
            class="mt-3"
            @click="fallbackTo115200"
          >
            Drop to 115200 and retry
          </Button>
        </div>
      </div>
    </div>

    <!-- confirm -->
    <div
      v-if="stage === 'confirm'"
      role="alertdialog"
      aria-labelledby="ff-confirm-title"
      class="rounded-[18px] border border-primary/40 bg-card p-5 shadow-[var(--sh-md)] sm:p-6"
    >
      <div class="flex items-start gap-2">
        <Zap class="mt-0.5 size-5 shrink-0 text-primary" aria-hidden="true" />
        <div class="min-w-0 flex-1">
          <h3 id="ff-confirm-title" class="text-[17px] font-semibold leading-[1.35]">
            Confirm the flash
          </h3>
          <p class="mt-1 text-sm text-muted-foreground">
            Detected {{ chipName }}<span v-if="chipMac">, MAC {{ chipMac }}</span
            >. Check the layout below before writing. Flashing the wrong offsets can stop the board
            from booting.
          </p>

          <dl class="mt-3 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
            <dt class="text-muted-foreground">Chip</dt>
            <dd class="font-mono">
              {{ chipKey ? CHIP_LABELS[chipKey] : chipName }}
            </dd>
            <template v-if="chipFeatures">
              <dt class="text-muted-foreground">Features</dt>
              <dd class="font-mono text-xs">
                {{ chipFeatures }}
              </dd>
            </template>
          </dl>

          <div class="mt-3 flex flex-col gap-1.5">
            <p class="text-xs font-medium uppercase tracking-[0.04em] text-muted-foreground">
              Planned layout
            </p>
            <div
              v-for="item in plan"
              :key="item.entry.id"
              class="flex flex-wrap items-center gap-x-3 rounded-[10px] bg-secondary px-3 py-2 font-mono text-xs shadow-[var(--sh-inset)]"
            >
              <span class="text-primary"
                >0x{{ item.region.address.toString(16).padStart(4, "0") }}</span
              >
              <span class="min-w-0 flex-1 truncate">{{ item.entry.name }}</span>
              <span class="text-muted-foreground tabular-nums">{{
                formatSize(item.entry.size)
              }}</span>
            </div>
          </div>

          <div
            v-if="eraseAll"
            class="mt-3 rounded-[10px] border border-destructive/50 bg-destructive/5 px-3 py-2 text-sm text-destructive"
          >
            Erase whole flash is on. Every byte on the chip, including stored settings and Wi-Fi
            calibration, will be wiped before writing.
          </div>

          <ul v-if="warnings.length" class="mt-3 flex flex-col gap-1.5">
            <li
              v-for="(w, i) in warnings"
              :key="i"
              class="flex items-start gap-2 rounded-[10px] bg-secondary px-3 py-2 text-sm text-muted-foreground shadow-[var(--sh-inset)]"
            >
              <AlertTriangle class="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
              <span>{{ w }}</span>
            </li>
          </ul>

          <div class="mt-4 flex flex-wrap gap-3">
            <Button @click="confirmFlash">
              <Zap class="size-4" aria-hidden="true" />
              Flash now
            </Button>
            <Button variant="ghost" @click="cancelConfirm"> Cancel </Button>
          </div>
        </div>
      </div>
    </div>

    <!-- flashing progress -->
    <div
      v-if="stage === 'flashing'"
      class="flex flex-col gap-3 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6"
    >
      <div class="flex items-center gap-2">
        <Loader2 class="size-4 animate-spin text-primary" aria-hidden="true" />
        <span class="text-sm font-medium">Writing to the board. Do not unplug it.</span>
        <span class="ml-auto text-sm text-muted-foreground tabular-nums"
          >{{ overallProgress }}%</span
        >
      </div>

      <div
        class="h-2 overflow-hidden rounded-full bg-secondary shadow-[var(--sh-inset)]"
        role="progressbar"
        :aria-valuenow="overallProgress"
        aria-valuemin="0"
        aria-valuemax="100"
      >
        <div
          class="h-full rounded-full bg-primary transition-[width] duration-150"
          :style="{ width: `${overallProgress}%` }"
        />
      </div>

      <div v-for="item in plan" :key="item.entry.id" class="flex flex-col gap-1">
        <div class="flex items-center gap-2 text-xs text-muted-foreground">
          <span class="font-mono text-primary">0x{{ item.region.address.toString(16) }}</span>
          <span class="min-w-0 flex-1 truncate font-mono">{{ item.entry.name }}</span>
          <span class="tabular-nums">
            {{ item.entry.total ? Math.round((item.entry.written / item.entry.total) * 100) : 0 }}%
          </span>
        </div>
        <div class="h-1.5 overflow-hidden rounded-full bg-secondary">
          <div
            class="h-full rounded-full bg-primary/70 transition-[width] duration-150"
            :style="{
              width: `${item.entry.total ? (item.entry.written / item.entry.total) * 100 : 0}%`,
            }"
          />
        </div>
      </div>
    </div>

    <!-- erasing -->
    <div
      v-if="stage === 'erasing'"
      class="flex items-center gap-2 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6"
    >
      <Loader2 class="size-4 animate-spin text-primary" aria-hidden="true" />
      <span class="text-sm font-medium"
        >Erasing the flash. This can take a while on a large chip.</span
      >
    </div>

    <!-- done -->
    <div
      v-if="stage === 'done'"
      class="rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6"
    >
      <div class="flex items-start gap-2">
        <CheckCircle2 class="mt-0.5 size-5 shrink-0 text-[var(--positive)]" aria-hidden="true" />
        <div class="min-w-0">
          <p class="font-medium">Done.</p>
          <p class="mt-1 text-sm text-muted-foreground">
            {{ doneMessage }}
          </p>
          <Button variant="outline" size="sm" class="mt-3" @click="reset"> Flash another </Button>
        </div>
      </div>
    </div>

    <!-- esptool log -->
    <details
      v-if="log.length"
      class="rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6"
    >
      <summary class="cursor-pointer text-sm text-muted-foreground">esptool output</summary>
      <pre
        class="mt-3 max-h-64 overflow-auto whitespace-pre-wrap break-all rounded-[10px] bg-secondary px-3 py-2 font-mono text-xs shadow-[var(--sh-inset)]"
        >{{ log.join("\n") }}</pre>
    </details>
  </div>
</template>
