<script setup lang="ts">
/**
 * Bespoke panel for the Audio Trimmer. Wraps the generic MediaShell (input
 * picker, engine loader, run/progress/output) and supplies the trim, fade,
 * normalize, and format controls plus an audio preview.
 *
 * MediaShell reports the selected file through its `files` event, which
 * includes the `File` object itself, so this panel builds the preview object
 * URL straight from that event instead of owning any file selection UI.
 */
import { computed, onUnmounted, ref } from "vue";
import type { ToolMeta } from "@/tools/types";
import type { MediaBuildArgs } from "@/lib/ffmpeg";
import { buildTrimArgs, parseTimeSpec, type AudioFormat } from "@/tools/audio-trimmer/index";
import MediaShell from "../MediaShell.vue";
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

defineProps<{ meta: ToolMeta }>();

/* ---------------------------------------------------------------- */
/* option state                                                      */
/* ---------------------------------------------------------------- */

const start = ref("");
const end = ref("");
const fadeIn = ref(0);
const fadeOut = ref(0);
const normalize = ref(false);
const format = ref<AudioFormat>("same");

const FORMAT_CHOICES: { value: AudioFormat; label: string }[] = [
  { value: "same", label: "Same as source" },
  { value: "mp3", label: "MP3" },
  { value: "m4a", label: "M4A (AAC)" },
  { value: "wav", label: "WAV" },
  { value: "ogg", label: "OGG (Vorbis)" },
];

/* ---------------------------------------------------------------- */
/* preview: object URL + probed duration for the selected file       */
/* ---------------------------------------------------------------- */

const previewUrl = ref<string | null>(null);
const previewName = ref("");
const duration = ref<number | null>(null);
const audioEl = ref<HTMLAudioElement>();

function revokePreview() {
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value);
  previewUrl.value = null;
  previewName.value = "";
  duration.value = null;
}

function loadPreview(file: File) {
  revokePreview();
  previewUrl.value = URL.createObjectURL(file);
  previewName.value = file.name;
}

/** MediaShell reports selection changes here; an empty list means removed. */
function onFilesChanged(files: { name: string; size: number; file: File }[]) {
  const file = files[0]?.file;
  if (file) loadPreview(file);
  else revokePreview();
}

function onPreviewLoadedMetadata() {
  const d = audioEl.value?.duration;
  duration.value = Number.isFinite(d) && (d as number) > 0 ? (d as number) : null;
}

function formatDuration(sec: number): string {
  const total = Math.max(0, Math.round(sec));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

const endPlaceholder = computed(() =>
  duration.value !== null ? `Full length (${formatDuration(duration.value)})` : "End of file",
);

function useCurrentTime(target: "start" | "end") {
  const el = audioEl.value;
  if (!el) return;
  const t = el.currentTime.toFixed(2);
  if (target === "start") start.value = t;
  else end.value = t;
}

/* ---------------------------------------------------------------- */
/* MediaShell wiring                                                 */
/* ---------------------------------------------------------------- */

const opts = computed(() => ({
  start: start.value,
  end: end.value,
  fadeIn: fadeIn.value,
  fadeOut: fadeOut.value,
  normalize: normalize.value,
  format: format.value,
  durationSec: duration.value,
}));

const TIME_HELP = "Use seconds like 12.5, mm:ss like 1:23, or hh:mm:ss.mmm like 01:23:45.678.";

const buildArgs: MediaBuildArgs = (ctx) => {
  const o = ctx.opts as {
    start: string;
    end: string;
    fadeIn: number;
    fadeOut: number;
    normalize: boolean;
    format: AudioFormat;
    durationSec: number | null;
  };

  const startText = o.start.trim();
  const startSec = startText ? parseTimeSpec(startText) : null;
  if (startText && startSec === null) {
    return { error: `"${o.start}" is not a valid start time.`, fix: TIME_HELP };
  }

  const endText = o.end.trim();
  const endSec = endText ? parseTimeSpec(endText) : null;
  if (endText && endSec === null) {
    return { error: `"${o.end}" is not a valid end time.`, fix: TIME_HELP };
  }

  const built = buildTrimArgs({
    inputName: ctx.inputName,
    startSec,
    endSec,
    durationSec: o.durationSec,
    fadeInSec: o.fadeIn,
    fadeOutSec: o.fadeOut,
    normalize: o.normalize,
    format: o.format,
  });

  if ("error" in built) return { error: built.error, fix: built.fix };
  return built;
};

onUnmounted(revokePreview);
</script>

<template>
  <MediaShell
    :meta="meta"
    accept="audio/*"
    :opts="opts"
    :build-args="buildArgs"
    run-label="Trim audio"
    input-label="Audio file"
    hint="Drop an audio file here or pick one. Everything runs in this tab: your files and inputs never leave your device."
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
          <audio
            ref="audioEl"
            :src="previewUrl"
            controls
            class="w-full"
            @loadedmetadata="onPreviewLoadedMetadata"
          />
          <p class="text-xs text-muted-foreground tabular-nums">
            {{ previewName
            }}<template v-if="duration !== null">
              &nbsp;&middot; {{ formatDuration(duration) }}
            </template>
          </p>
        </div>

        <!-- Trim range -->
        <div class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Trim range
          </span>
          <div class="flex flex-wrap items-end gap-3">
            <div class="flex w-36 flex-col gap-1.5">
              <Label for="trim-start" class="text-xs text-muted-foreground">Start</Label>
              <Input
                id="trim-start"
                :model-value="start"
                placeholder="0:00"
                class="h-9 bg-card"
                @update:model-value="(v) => (start = String(v))"
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
            <div class="flex w-36 flex-col gap-1.5">
              <Label for="trim-end" class="text-xs text-muted-foreground">End</Label>
              <Input
                id="trim-end"
                :model-value="end"
                :placeholder="endPlaceholder"
                class="h-9 bg-card"
                @update:model-value="(v) => (end = String(v))"
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
            Leave either field blank to keep the start or the end of the file as is. Times accept
            plain seconds, mm:ss, or hh:mm:ss.mmm.
          </p>
        </div>

        <!-- Fades -->
        <div class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Fades
          </span>
          <div class="flex flex-wrap items-end gap-3">
            <div class="flex w-28 flex-col gap-1.5">
              <Label for="fade-in" class="text-xs text-muted-foreground">Fade in (sec)</Label>
              <Input
                id="fade-in"
                type="number"
                min="0"
                max="10"
                step="0.1"
                :model-value="fadeIn"
                class="h-9 bg-card"
                @update:model-value="(v) => (fadeIn = Number(v) || 0)"
              />
            </div>
            <div class="flex w-28 flex-col gap-1.5">
              <Label for="fade-out" class="text-xs text-muted-foreground">Fade out (sec)</Label>
              <Input
                id="fade-out"
                type="number"
                min="0"
                max="10"
                step="0.1"
                :model-value="fadeOut"
                class="h-9 bg-card"
                @update:model-value="(v) => (fadeOut = Number(v) || 0)"
              />
            </div>
          </div>
        </div>

        <!-- Normalize and format -->
        <div class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Output
          </span>
          <div class="flex flex-wrap items-end gap-4">
            <div class="flex items-center gap-2">
              <Switch
                id="normalize"
                :model-value="normalize"
                @update:model-value="(v) => (normalize = Boolean(v))"
              />
              <Label for="normalize" class="text-xs text-muted-foreground"
                >Normalize loudness</Label
              >
            </div>
            <div class="flex w-44 flex-col gap-1.5">
              <Label for="output-format" class="text-xs text-muted-foreground">Format</Label>
              <Select
                :model-value="format"
                @update:model-value="(v) => (format = v as AudioFormat)"
              >
                <SelectTrigger id="output-format" size="sm" class="w-full bg-card">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem
                    v-for="choice in FORMAT_CHOICES"
                    :key="choice.value"
                    :value="choice.value"
                  >
                    {{ choice.label }}
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
      </div>
    </template>

    <template #notes>
      <p class="text-xs text-muted-foreground">
        Normalize targets minus 16 LUFS integrated loudness, the level streaming platforms use, so
        the trimmed clip is not noticeably quieter or louder than everything else. Fade in and fade
        out are both in seconds and are measured from the start and end of the trimmed clip, not the
        original file.
      </p>
    </template>
  </MediaShell>
</template>
