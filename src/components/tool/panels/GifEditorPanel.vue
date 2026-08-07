<script setup lang="ts">
/**
 * Bespoke panel for the GIF Toolbox.
 *
 * All the shared machinery (drop zone, the one time media engine download,
 * progress, cancel, log tail, output previews and downloads) belongs to
 * MediaShell. This panel only does two things: show the controls for the
 * chosen operation, and turn those controls into an ffmpeg command through the
 * pure planners in `src/tools/gif-editor`.
 *
 * `buildArgs` is a pure function of the build context, so the option values it
 * reads come from `ctx.opts` rather than from this component's closure. That
 * keeps the panel honest about the MediaShell contract.
 *
 * Two limitations worth knowing, both deliberate:
 *
 *  - There is no preview of the source GIF. MediaShell owns the file picker and
 *    its `files` event carries names and sizes only, never the File itself, so
 *    a panel cannot build an object URL for the input.
 *  - Captioning is off. drawtext needs a TrueType or OpenType font inside the
 *    ffmpeg filesystem, this site ships only woff2 fonts, and MediaShell writes
 *    the selected files and nothing else. The planner refuses with that reason
 *    rather than sending a command that would fail in the worker.
 */
import { computed, reactive, ref } from 'vue';
import type { ToolMeta } from '@/tools/types';
import { getLogTail, type MediaBuildContext, type MediaBuildResult } from '@/lib/ffmpeg';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import MediaShell from '../MediaShell.vue';
import {
  buildCaption,
  buildCrop,
  buildOptimize,
  buildResize,
  buildReverse,
  buildSpeed,
  buildSplit,
  parseGifInfo,
  type GifOperation,
  type GifOptions,
} from '@/tools/gif-editor/index';

defineProps<{ meta: ToolMeta }>();

/* ---------------------------------------------------------------- */
/* options                                                           */
/* ---------------------------------------------------------------- */

const opts = reactive<GifOptions>({
  operation: 'resize',
  width: 480,
  cropX: 0,
  cropY: 0,
  cropW: 320,
  cropH: 240,
  fps: 15,
  colors: 128,
  factor: 2,
  speedFps: 0,
  text: '',
  position: 'bottom',
  fontSize: 32,
  everyNth: 1,
  frames: 8,
});

/** What the last successful run reported about the file it read. */
const sourceInfo = ref<string | null>(null);

const OPERATIONS: { value: GifOperation; label: string }[] = [
  { value: 'resize', label: 'Resize' },
  { value: 'crop', label: 'Crop' },
  { value: 'optimize', label: 'Optimize' },
  { value: 'reverse', label: 'Reverse' },
  { value: 'speed', label: 'Change speed' },
  { value: 'caption', label: 'Caption' },
  { value: 'split', label: 'Split into frames' },
];

const RUN_LABELS: Record<GifOperation, string> = {
  resize: 'Resize GIF',
  crop: 'Crop GIF',
  optimize: 'Optimize GIF',
  reverse: 'Reverse GIF',
  speed: 'Change speed',
  caption: 'Add caption',
  split: 'Export frames',
};

const operation = computed<GifOperation>(() => opts.operation ?? 'resize');
const runLabel = computed(() => RUN_LABELS[operation.value] ?? 'Run');
/**
 * Captioning is off pending a font (see the module doc). The run button is the
 * single source of truth for that: it goes disabled the moment caption mode is
 * picked, so buildArgs (and buildCaption's own refusal) never runs and never
 * gets a chance to complain about the disabled text field instead.
 */
const captionUnavailable = computed(() => operation.value === 'caption');

/** Number inputs hand back strings, and an empty field should not become NaN. */
function setNumber(key: keyof GifOptions, value: unknown, fallback: number) {
  const n = Number(typeof value === 'string' ? value.trim() : value);
  const fields = opts as Record<string, unknown>;
  fields[key] = Number.isFinite(n) ? n : fallback;
}

/* ---------------------------------------------------------------- */
/* planning                                                          */
/* ---------------------------------------------------------------- */

function buildArgs(ctx: MediaBuildContext): MediaBuildResult {
  const o = ctx.opts as GifOptions;
  const inputName = ctx.inputName;

  switch (o.operation ?? 'resize') {
    case 'resize':
      return buildResize({ inputName, width: Number(o.width) });
    case 'crop':
      return buildCrop({
        inputName,
        x: Number(o.cropX),
        y: Number(o.cropY),
        w: Number(o.cropW),
        h: Number(o.cropH),
      });
    case 'optimize':
      return buildOptimize({ inputName, fps: Number(o.fps), colors: Number(o.colors) });
    case 'reverse':
      return buildReverse({ inputName });
    case 'speed':
      return buildSpeed({
        inputName,
        factor: Number(o.factor),
        fps: Number(o.speedFps) > 0 ? Number(o.speedFps) : undefined,
      });
    case 'caption':
      // No font file is passed, so this always refuses with the reason.
      return buildCaption({
        inputName,
        text: String(o.text ?? ''),
        position: o.position ?? 'bottom',
        fontSize: Number(o.fontSize),
      });
    case 'split':
      return buildSplit({
        inputName,
        everyNth: Number(o.everyNth),
        frames: Number(o.frames),
      });
    default:
      return {
        error: 'Pick an operation first.',
        fix: 'Choose resize, crop, optimize, reverse, speed or split.',
      };
  }
}

/**
 * ffmpeg prints what it read in its log, so a finished run is the one moment
 * this panel can tell the visitor how big the GIF is and how many frames it
 * has. That frame count is exactly what the split control needs.
 */
function onComplete() {
  const info = parseGifInfo(getLogTail(200).join('\n'));
  if (!info) {
    sourceInfo.value = null;
    return;
  }
  const parts = [`${info.width} x ${info.height} px`];
  if (info.fps !== null) parts.push(`${info.fps} fps`);
  if (info.frames !== null) parts.push(`${info.frames} frames written`);
  sourceInfo.value = parts.join(', ');
}

function onFiles() {
  sourceInfo.value = null;
}
</script>

<template>
  <MediaShell
    :meta="meta"
    accept="image/gif"
    :opts="opts"
    :build-args="buildArgs"
    :run-label="runLabel"
    :run-disabled="captionUnavailable"
    input-label="GIF"
    hint="Drop a .gif here or pick one to get started. Everything runs in this tab: your files and inputs never leave your device."
    @complete="onComplete"
    @files="onFiles"
  >
    <template #options>
      <div class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
        <div class="flex w-56 max-w-full flex-col gap-1.5">
          <Label
            for="gif-operation"
            class="text-xs text-muted-foreground"
          >Operation</Label>
          <Select
            :model-value="operation"
            @update:model-value="(v) => (opts.operation = String(v) as GifOperation)"
          >
            <SelectTrigger
              id="gif-operation"
              size="sm"
              class="w-full bg-card"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem
                v-for="item in OPERATIONS"
                :key="item.value"
                :value="item.value"
              >
                {{ item.label }}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        <!-- Resize -->
        <div
          v-if="operation === 'resize'"
          class="flex w-32 flex-col gap-1.5"
        >
          <Label
            for="gif-width"
            class="text-xs text-muted-foreground"
          >Width in pixels</Label>
          <Input
            id="gif-width"
            type="number"
            min="16"
            max="4000"
            :model-value="opts.width"
            class="h-9 bg-card"
            @update:model-value="(v) => setNumber('width', v, 480)"
          />
        </div>

        <!-- Crop -->
        <div
          v-else-if="operation === 'crop'"
          class="flex flex-wrap items-end gap-3"
        >
          <div class="flex w-24 flex-col gap-1.5">
            <Label
              for="gif-crop-x"
              class="text-xs text-muted-foreground"
            >Left</Label>
            <Input
              id="gif-crop-x"
              type="number"
              min="0"
              :model-value="opts.cropX"
              class="h-9 bg-card"
              @update:model-value="(v) => setNumber('cropX', v, 0)"
            />
          </div>
          <div class="flex w-24 flex-col gap-1.5">
            <Label
              for="gif-crop-y"
              class="text-xs text-muted-foreground"
            >Top</Label>
            <Input
              id="gif-crop-y"
              type="number"
              min="0"
              :model-value="opts.cropY"
              class="h-9 bg-card"
              @update:model-value="(v) => setNumber('cropY', v, 0)"
            />
          </div>
          <div class="flex w-24 flex-col gap-1.5">
            <Label
              for="gif-crop-w"
              class="text-xs text-muted-foreground"
            >Width</Label>
            <Input
              id="gif-crop-w"
              type="number"
              min="1"
              :model-value="opts.cropW"
              class="h-9 bg-card"
              @update:model-value="(v) => setNumber('cropW', v, 320)"
            />
          </div>
          <div class="flex w-24 flex-col gap-1.5">
            <Label
              for="gif-crop-h"
              class="text-xs text-muted-foreground"
            >Height</Label>
            <Input
              id="gif-crop-h"
              type="number"
              min="1"
              :model-value="opts.cropH"
              class="h-9 bg-card"
              @update:model-value="(v) => setNumber('cropH', v, 240)"
            />
          </div>
        </div>

        <!-- Optimise -->
        <div
          v-else-if="operation === 'optimize'"
          class="flex flex-wrap items-end gap-3"
        >
          <div class="flex w-32 flex-col gap-1.5">
            <Label
              for="gif-fps"
              class="text-xs text-muted-foreground"
            >Frames per second</Label>
            <Input
              id="gif-fps"
              type="number"
              min="1"
              max="50"
              :model-value="opts.fps"
              class="h-9 bg-card"
              @update:model-value="(v) => setNumber('fps', v, 15)"
            />
          </div>
          <div class="flex w-32 flex-col gap-1.5">
            <Label
              for="gif-colors"
              class="text-xs text-muted-foreground"
            >Colors</Label>
            <Input
              id="gif-colors"
              type="number"
              min="4"
              max="256"
              :model-value="opts.colors"
              class="h-9 bg-card"
              @update:model-value="(v) => setNumber('colors', v, 128)"
            />
          </div>
        </div>

        <!-- Speed -->
        <div
          v-else-if="operation === 'speed'"
          class="flex flex-wrap items-end gap-3"
        >
          <div class="flex w-32 flex-col gap-1.5">
            <Label
              for="gif-factor"
              class="text-xs text-muted-foreground"
            >Speed multiplier</Label>
            <Input
              id="gif-factor"
              type="number"
              min="0.25"
              max="4"
              step="0.25"
              :model-value="opts.factor"
              class="h-9 bg-card"
              @update:model-value="(v) => setNumber('factor', v, 2)"
            />
          </div>
          <div class="flex w-44 flex-col gap-1.5">
            <Label
              for="gif-speed-fps"
              class="text-xs text-muted-foreground"
            >Resample to fps (0 keeps the original)</Label>
            <Input
              id="gif-speed-fps"
              type="number"
              min="0"
              max="50"
              :model-value="opts.speedFps"
              class="h-9 bg-card"
              @update:model-value="(v) => setNumber('speedFps', v, 0)"
            />
          </div>
        </div>

        <!-- Caption -->
        <div
          v-else-if="operation === 'caption'"
          class="flex flex-col gap-3"
        >
          <div class="flex flex-wrap items-end gap-3">
            <div class="flex min-w-56 flex-1 flex-col gap-1.5">
              <Label
                for="gif-text"
                class="text-xs text-muted-foreground"
              >Caption text</Label>
              <Input
                id="gif-text"
                type="text"
                disabled
                placeholder="Captioning is unavailable"
                :model-value="opts.text"
                class="h-9 bg-card"
                @update:model-value="(v) => (opts.text = String(v))"
              />
            </div>
            <div class="flex w-28 flex-col gap-1.5">
              <Label
                for="gif-font-size"
                class="text-xs text-muted-foreground"
              >Font size</Label>
              <Input
                id="gif-font-size"
                type="number"
                min="8"
                max="200"
                disabled
                :model-value="opts.fontSize"
                class="h-9 bg-card"
                @update:model-value="(v) => setNumber('fontSize', v, 32)"
              />
            </div>
          </div>
          <p class="text-xs text-muted-foreground">
            Captioning is turned off, and the Add caption button stays disabled while this
            operation is selected, rather than failing after you press it. Burning text into
            frames needs the drawtext filter, which wants a TrueType or OpenType font file loaded
            into the media engine and a build of ffmpeg compiled with FreeType. This site ships
            web fonts in woff2 only, which drawtext cannot read. Add the text in an image editor
            first, then resize or optimize the result here.
          </p>
        </div>

        <!-- Split -->
        <div
          v-else-if="operation === 'split'"
          class="flex flex-wrap items-end gap-3"
        >
          <div class="flex w-32 flex-col gap-1.5">
            <Label
              for="gif-frames"
              class="text-xs text-muted-foreground"
            >Frames to export</Label>
            <Input
              id="gif-frames"
              type="number"
              min="1"
              max="50"
              :model-value="opts.frames"
              class="h-9 bg-card"
              @update:model-value="(v) => setNumber('frames', v, 8)"
            />
          </div>
          <div class="flex w-32 flex-col gap-1.5">
            <Label
              for="gif-every"
              class="text-xs text-muted-foreground"
            >Keep every nth</Label>
            <Input
              id="gif-every"
              type="number"
              min="1"
              max="20"
              :model-value="opts.everyNth"
              class="h-9 bg-card"
              @update:model-value="(v) => setNumber('everyNth', v, 1)"
            />
          </div>
        </div>

        <p
          v-else-if="operation === 'reverse'"
          class="text-xs text-muted-foreground"
        >
          Reverse has nothing to set. Every frame is buffered so they can be written back to
          front, so a very long GIF can run the browser out of memory.
        </p>
      </div>
    </template>

    <template #notes>
      <p
        v-if="sourceInfo"
        class="font-mono text-xs text-muted-foreground tabular-nums"
      >
        Last run read: {{ sourceInfo }}
      </p>

      <p class="text-xs text-muted-foreground">
        <template v-if="operation === 'resize'">
          The height follows the width so the shape is kept. Frames are scaled with lanczos and
          given a new color palette, which is what stops a resized GIF from banding.
        </template>
        <template v-else-if="operation === 'crop'">
          The rectangle is measured in pixels from the top left corner of the frame. A rectangle
          that runs past the edge is rejected by ffmpeg, and the log says by how much.
        </template>
        <template v-else-if="operation === 'optimize'">
          Fewer frames per second and a smaller palette are the two levers ffmpeg has. There is no
          gifsicle style lossy mode here, so the honest way to a smaller file is 10 to 12 frames
          per second and 64 to 128 colors.
        </template>
        <template v-else-if="operation === 'speed'">
          Speed is a rewrite of the frame timings. GIF delays are stored in hundredths of a second
          and browsers treat anything under two of those as ten, so a very fast result stops
          getting faster. Resampling to a frame rate drops frames instead, which keeps the timing
          honest.
        </template>
        <template v-else-if="operation === 'split'">
          Frames come out as PNG files. The run has to declare its file names before it starts, so
          it asks for exactly this many. If the GIF has fewer frames than that, the run stops early
          and reports a missing frame file: lower the count and run again. The frame count from the
          last run is shown above.
        </template>
        <template v-else-if="operation === 'reverse'">
          The reversed GIF is re-palettized from its own frames, so the colors match the original.
        </template>
        <template v-else>
          Captioning is unavailable in this build. Every other operation runs entirely in this tab.
        </template>
      </p>
    </template>
  </MediaShell>
</template>
