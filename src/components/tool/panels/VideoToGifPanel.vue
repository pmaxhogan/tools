<script setup lang="ts">
import { computed, onUnmounted, reactive, ref } from "vue";
import type { ToolMeta } from "@/tools/types";
import type { MediaBuildContext, MediaBuildResult } from "@/lib/ffmpeg";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import MediaShell from "../MediaShell.vue";
import {
  FRAME_WARNING_THRESHOLD,
  buildGifArgs,
  estimateFrames,
  parseTimeSpec,
  type GifDither,
  type GifPaletteMode,
} from "@/tools/video-to-gif/index";

/**
 * Bespoke panel for Video to GIF.
 *
 * MediaShell owns the file input, the ffmpeg engine download, the run, the
 * progress bar, the log, and the GIF preview with its size and download button.
 * This panel owns the options and turns them into an ffmpeg command, which the
 * pure logic layer in `src/tools/video-to-gif` actually builds and validates.
 *
 * `buildArgs` reads only its context argument, never the reactive state above
 * it, so the command MediaShell runs is exactly the command the tests cover.
 */
defineProps<{ meta: ToolMeta }>();

const opts = reactive({
  start: "",
  end: "",
  fps: 12,
  width: 480,
  palette: "global" as GifPaletteMode,
  dither: "sierra2_4a" as GifDither,
  loop: true,
});

const TIME_FIX = 'Use seconds ("12.5"), mm:ss ("1:20"), or hh:mm:ss ("0:01:20.500").';

/* ---------------------------------------------------------------- */
/* preview: object URL + probed duration for the selected file       */
/* ---------------------------------------------------------------- */

const previewUrl = ref<string | null>(null);
const videoEl = ref<HTMLVideoElement>();
const duration = ref<number | null>(null);

function revokePreview() {
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value);
  previewUrl.value = null;
  duration.value = null;
}

/** MediaShell reports selection changes here; an empty list means removed. */
function onFilesChanged(files: { name: string; size: number; file: File }[]) {
  revokePreview();
  const file = files[0]?.file;
  if (file) previewUrl.value = URL.createObjectURL(file);
}

function onPreviewLoadedMetadata() {
  const d = videoEl.value?.duration;
  duration.value = Number.isFinite(d) && (d as number) > 0 ? (d as number) : null;
}

function useCurrentTime(target: "start" | "end") {
  const el = videoEl.value;
  if (!el) return;
  const t = el.currentTime.toFixed(1);
  if (target === "start") opts.start = t;
  else opts.end = t;
}

onUnmounted(revokePreview);

/* ---------------------------------------------------------------- */
/* live readouts                                                     */
/* ---------------------------------------------------------------- */

const startSec = computed(() => (opts.start.trim() ? parseTimeSpec(opts.start) : null));
const endSec = computed(() => (opts.end.trim() ? parseTimeSpec(opts.end) : null));

const startInvalid = computed(() => opts.start.trim() !== "" && startSec.value === null);
const endInvalid = computed(() => opts.end.trim() !== "" && endSec.value === null);

const windowBackwards = computed(
  () =>
    endSec.value !== null &&
    !startInvalid.value &&
    !endInvalid.value &&
    endSec.value <= (startSec.value ?? 0),
);

/**
 * Frames the run will produce. Null whenever the window cannot be known: the
 * panel never sees the source duration, so an open ended range stays a mystery
 * until ffmpeg reads the file.
 */
const frames = computed(() =>
  startInvalid.value || endInvalid.value
    ? null
    : estimateFrames({
        fps: Number(opts.fps),
        startSec: startSec.value,
        endSec: endSec.value,
        durationSec: duration.value,
      }),
);

const frameWarning = computed(
  () => frames.value !== null && frames.value > FRAME_WARNING_THRESHOLD,
);

/** Emptying the number box leaves NaN, which must not reach the readout. */
const fpsLabel = computed(() => (Number.isFinite(opts.fps) ? String(opts.fps) : "?"));

const frameLine = computed(() => {
  if (frames.value === null) {
    return `Set an end time to see the frame count. At ${fpsLabel.value} frames per second, every second of video is ${fpsLabel.value} frames.`;
  }
  const count = frames.value.toLocaleString("en-US");
  if (frameWarning.value) {
    return `About ${count} frames. That is over ${FRAME_WARNING_THRESHOLD}, so this will be slow to encode and large to share. Shorten the range, lower the frame rate, or reduce the width.`;
  }
  return `About ${count} frames at ${fpsLabel.value} frames per second.`;
});

/* ---------------------------------------------------------------- */
/* command                                                           */
/* ---------------------------------------------------------------- */

function readText(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === "string" ? value.trim() : "";
}

function buildArgs(ctx: MediaBuildContext): MediaBuildResult {
  const startText = readText(ctx.opts, "start");
  const start = startText ? parseTimeSpec(startText) : null;
  if (startText && start === null) {
    return { error: `The start time "${startText}" is not a timestamp.`, fix: TIME_FIX };
  }

  const endText = readText(ctx.opts, "end");
  const end = endText ? parseTimeSpec(endText) : null;
  if (endText && end === null) {
    return { error: `The end time "${endText}" is not a timestamp.`, fix: TIME_FIX };
  }

  return buildGifArgs({
    inputName: ctx.inputName,
    startSec: start,
    endSec: end,
    fps: Number(ctx.opts.fps),
    width: Number(ctx.opts.width),
    paletteMode: ctx.opts.palette === "perframe" ? "perframe" : "global",
    dither:
      ctx.opts.dither === "bayer" ? "bayer" : ctx.opts.dither === "none" ? "none" : "sierra2_4a",
    loop: Boolean(ctx.opts.loop),
  });
}

/* ---------------------------------------------------------------- */
/* control binding                                                   */
/* ---------------------------------------------------------------- */

function setNumber(key: "fps" | "width", value: unknown) {
  const n = Number(value);
  // An emptied box stays NaN on purpose: buildGifArgs then explains the range
  // instead of the panel silently substituting a value nobody chose.
  opts[key] = Number.isFinite(n) ? n : Number.NaN;
}
</script>

<template>
  <MediaShell
    :meta="meta"
    accept="video/*"
    :opts="opts"
    :build-args="buildArgs"
    run-label="Convert to GIF"
    input-label="Video"
    hint="Drop a video here or pick one, then trim it and choose a palette. Everything runs in this tab: your files and inputs never leave your device."
    @files="onFilesChanged"
  >
    <template #options>
      <div class="flex flex-col gap-4">
        <!-- Preview -->
        <div
          v-if="previewUrl"
          class="flex flex-col gap-2 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]"
        >
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Preview
          </span>
          <video
            ref="videoEl"
            :src="previewUrl"
            controls
            playsinline
            class="max-h-[240px] w-full rounded-[8px] bg-background"
            @loadedmetadata="onPreviewLoadedMetadata"
          />
        </div>

        <!-- Trim -->
        <div class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Trim
          </span>
          <div class="flex flex-wrap items-end gap-3">
            <div class="flex w-32 flex-col gap-1.5">
              <Label for="gif-start" class="text-xs text-muted-foreground">Start</Label>
              <Input
                id="gif-start"
                v-model="opts.start"
                placeholder="0:00"
                inputmode="text"
                class="h-9 bg-card font-mono"
                :aria-invalid="startInvalid"
              />
            </div>
            <Button
              variant="outline"
              size="sm"
              :disabled="!previewUrl"
              @click="useCurrentTime('start')"
            >
              Use current time
            </Button>
          </div>
          <div class="flex flex-wrap items-end gap-3">
            <div class="flex w-32 flex-col gap-1.5">
              <Label for="gif-end" class="text-xs text-muted-foreground">End</Label>
              <Input
                id="gif-end"
                v-model="opts.end"
                placeholder="end of clip"
                inputmode="text"
                class="h-9 bg-card font-mono"
                :aria-invalid="endInvalid"
              />
            </div>
            <Button
              variant="outline"
              size="sm"
              :disabled="!previewUrl"
              @click="useCurrentTime('end')"
            >
              Use current time
            </Button>
          </div>
          <p class="text-xs text-muted-foreground">
            Seconds ("12.5"), mm:ss ("1:20"), or hh:mm:ss ("0:01:20.500"). Leave a box empty to
            start at the first frame or run to the end of the clip.
          </p>
          <p v-if="startInvalid || endInvalid" class="text-xs text-destructive">
            {{ startInvalid ? "The start time" : "The end time" }} is not a timestamp this tool can
            read.
          </p>
          <p v-else-if="windowBackwards" class="text-xs text-destructive">
            The end time has to come after the start time.
          </p>
        </div>

        <!-- Size and rate -->
        <div class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Size and rate
          </span>
          <div class="flex flex-wrap items-end gap-3">
            <div class="flex w-32 flex-col gap-1.5">
              <Label for="gif-fps" class="text-xs text-muted-foreground">Frames per second</Label>
              <Input
                id="gif-fps"
                type="number"
                min="1"
                max="30"
                :model-value="opts.fps"
                class="h-9 bg-card"
                @update:model-value="(v) => setNumber('fps', v)"
              />
            </div>
            <div class="flex w-32 flex-col gap-1.5">
              <Label for="gif-width" class="text-xs text-muted-foreground">Width in pixels</Label>
              <Input
                id="gif-width"
                type="number"
                min="64"
                max="1280"
                step="16"
                :model-value="opts.width"
                class="h-9 bg-card"
                @update:model-value="(v) => setNumber('width', v)"
              />
            </div>
            <div class="flex items-center gap-2 pb-2.5">
              <Switch
                id="gif-loop"
                :model-value="opts.loop"
                @update:model-value="(v) => (opts.loop = Boolean(v))"
              />
              <Label for="gif-loop" class="text-xs text-muted-foreground">Loop forever</Label>
            </div>
          </div>
          <p
            class="text-xs tabular-nums"
            :class="frameWarning ? 'font-medium text-destructive' : 'text-muted-foreground'"
          >
            {{ frameLine }}
          </p>
        </div>

        <!-- Colors -->
        <div class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Colors
          </span>
          <div class="flex flex-wrap items-end gap-3">
            <div class="flex w-56 flex-col gap-1.5">
              <Label for="gif-palette" class="text-xs text-muted-foreground">Palette</Label>
              <Select
                :model-value="opts.palette"
                @update:model-value="(v) => (opts.palette = String(v) as GifPaletteMode)"
              >
                <SelectTrigger id="gif-palette" size="sm" class="w-full bg-card">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="global"> One palette for the whole clip </SelectItem>
                  <SelectItem value="perframe"> A new palette on every frame </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div class="flex w-56 flex-col gap-1.5">
              <Label for="gif-dither" class="text-xs text-muted-foreground">Dithering</Label>
              <Select
                :model-value="opts.dither"
                @update:model-value="(v) => (opts.dither = String(v) as GifDither)"
              >
                <SelectTrigger id="gif-dither" size="sm" class="w-full bg-card">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="sierra2_4a"> Sierra2 4a (smooth gradients) </SelectItem>
                  <SelectItem value="bayer"> Bayer (patterned, smaller file) </SelectItem>
                  <SelectItem value="none"> None (flat bands, sharpest text) </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
      </div>
    </template>

    <template #notes>
      <p class="text-xs text-muted-foreground">
        A per frame palette gives every frame its own 256 colors, so it handles scene changes and
        color shifts that a single global palette smears. It also makes a noticeably bigger file, so
        reach for it only when the global palette visibly breaks down. GIF has no real interframe
        compression, which means the same clip is often ten times larger as a GIF than as MP4 or
        WebM: if the place you are posting to accepts video at all, send the video.
      </p>
    </template>
  </MediaShell>
</template>
