<script setup lang="ts">
/**
 * Bespoke panel for the A/V Converter. Everything ffmpeg related lives in
 * MediaShell (engine download, run, progress, log, preview, download), so this
 * file only owns three controls and the function that turns them into a
 * command. The command itself comes from the pure logic layer, which is where
 * the format table and the quality tiers are defined and tested.
 */
import { computed, reactive, ref } from "vue";
import { ToolError, type SelectOptionSpec, type ToolMeta } from "@/tools/types";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { SearchableSelect } from "@/components/ui/searchable-select";
import MediaShell from "../MediaShell.vue";
import ErrorBanner from "../ErrorBanner.vue";
import type { MediaBuildContext, MediaBuildResult } from "@/lib/ffmpeg";
import {
  FORMATS,
  QUALITY_IDS,
  TARGET_IDS,
  buildConvertArgs,
  describeQuality,
  formatCommand,
  looksLikeAudio,
  type QualityId,
  type TargetId,
} from "@/tools/video-converter/index";

defineProps<{ meta: ToolMeta }>();

/* ---------------------------------------------------------------- */
/* options                                                           */
/* ---------------------------------------------------------------- */

const opts = reactive<{ target: TargetId; quality: QualityId; stripAudio: boolean }>({
  target: "mp4",
  quality: "balanced",
  stripAudio: false,
});

const QUALITY_LABELS: Record<QualityId, string> = {
  high: "High: closest to the source, slowest",
  balanced: "Balanced: good quality, sensible size",
  small: "Small: smallest file, softest picture",
};

const videoTargets = TARGET_IDS.filter((id) => FORMATS[id].kind === "video");
const audioTargets = TARGET_IDS.filter((id) => FORMATS[id].kind === "audio");

/* ---------------------------------------------------------------- */
/* searchable-select specs                                           */
/* ---------------------------------------------------------------- */

const TARGET_SYNONYMS: Record<TargetId, string[]> = {
  mp4: ["h264", "h.264", "mpeg-4", "mpeg4", "aac"],
  webm: ["vp8", "vp9", "vorbis", "web video"],
  mkv: ["matroska", "remux", "rewrap", "no re-encode", "container"],
  gif: ["animated gif", "animation", "graphics interchange"],
  mp3: ["mpeg audio", "lame", "mp3 audio"],
  m4a: ["aac", "mp4 audio", "apple audio"],
  wav: ["wave", "pcm", "uncompressed"],
  ogg: ["vorbis", "ogg vorbis"],
  flac: ["lossless", "free lossless audio codec"],
};

/** Built from the static FORMATS table, so the Video and Audio groups match the
 *  old grouped picker exactly. */
const targetSpec: SelectOptionSpec = {
  kind: "select",
  id: "av-target",
  label: "Convert to",
  default: "mp4",
  groups: [
    {
      label: "Video",
      synonyms: ["movie", "video formats", "picture"],
      options: videoTargets.map((id) => ({
        value: id,
        label: FORMATS[id].label,
        synonyms: TARGET_SYNONYMS[id],
      })),
    },
    {
      label: "Audio",
      synonyms: ["sound", "music", "audio formats", "soundtrack"],
      options: audioTargets.map((id) => ({
        value: id,
        label: FORMATS[id].label,
        synonyms: TARGET_SYNONYMS[id],
      })),
    },
  ],
};

const QUALITY_SYNONYMS: Record<QualityId, string[]> = {
  high: ["best", "maximum", "top quality", "high quality"],
  balanced: ["default", "medium", "standard", "recommended"],
  small: ["smallest", "compact", "low", "tiny", "smallest file"],
};

const qualitySpec: SelectOptionSpec = {
  kind: "select",
  id: "av-quality",
  label: "Quality",
  default: "balanced",
  options: QUALITY_IDS.map((id) => ({
    value: id,
    label: QUALITY_LABELS[id],
    synonyms: QUALITY_SYNONYMS[id],
  })),
};

const spec = computed(() => FORMATS[opts.target]);
/** GIF has no audio track to begin with, and audio targets are all audio. */
const canStripAudio = computed(() => spec.value.kind === "video" && opts.target !== "gif");

function setTarget(value: unknown) {
  const next = String(value) as TargetId;
  if (!FORMATS[next]) return;
  opts.target = next;
  if (!canStripAudio.value) opts.stripAudio = false;
}

function setQuality(value: unknown) {
  const next = String(value) as QualityId;
  if (QUALITY_IDS.includes(next)) opts.quality = next;
}

/* ---------------------------------------------------------------- */
/* the selected file                                                 */
/* ---------------------------------------------------------------- */

const selected = ref<{ name: string; size: number }[]>([]);
const sourceName = computed(() => selected.value[0]?.name ?? "");

/** An audio file cannot become a video, so say it before the run, not after. */
const mismatch = computed(() => {
  if (!sourceName.value || spec.value.kind !== "video") return null;
  if (!looksLikeAudio(sourceName.value)) return null;
  return {
    message: `${sourceName.value} is an audio file, and ${spec.value.label} is a video format.`,
    fix: "Pick an audio format such as MP3, M4A, WAV, OGG or FLAC, or load a video file instead.",
  };
});

const extracting = computed(
  () =>
    Boolean(sourceName.value) && spec.value.kind === "audio" && !looksLikeAudio(sourceName.value),
);

/** The exact command the current choices would run, shown before running it. */
const preview = computed(() => {
  try {
    const plan = buildConvertArgs({
      inputName: sourceName.value || "input.mov",
      target: opts.target,
      quality: opts.quality,
      stripAudio: opts.stripAudio,
    });
    return formatCommand(plan.args);
  } catch {
    return "";
  }
});

/* ---------------------------------------------------------------- */
/* the contract with MediaShell                                      */
/* ---------------------------------------------------------------- */

function buildArgs(ctx: MediaBuildContext): MediaBuildResult {
  const target = (ctx.opts.target as TargetId) ?? opts.target;
  const format = FORMATS[target];
  if (!format) {
    return {
      error: `${String(target)} is not a format this converter can write.`,
      fix: "Choose one of the formats in the list above.",
    };
  }

  const original = ctx.files[0]?.name ?? ctx.inputName;
  if (format.kind === "video" && looksLikeAudio(original)) {
    return {
      error: `${original} is an audio file, and ${format.label} is a video format.`,
      fix: "Pick an audio format such as MP3, M4A, WAV, OGG or FLAC, or load a video file instead.",
    };
  }

  try {
    const plan = buildConvertArgs({
      inputName: ctx.inputName,
      target,
      quality: (ctx.opts.quality as QualityId) ?? opts.quality,
      stripAudio: ctx.opts.stripAudio === true,
    });
    return { args: plan.args, outputs: plan.outputs };
  } catch (error) {
    if (error instanceof ToolError) return { error: error.message, fix: error.fix };
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function onFiles(files: { name: string; size: number }[]) {
  selected.value = files;
}
</script>

<template>
  <MediaShell
    :meta="meta"
    accept="video/*,audio/*"
    :opts="opts"
    :build-args="buildArgs"
    run-label="Convert"
    input-label="Video or audio file"
    hint="Drop a video or audio file here, or pick one, then choose the format you want. Everything runs in this tab: your files and inputs never leave your device."
    @files="onFiles"
  >
    <template #options>
      <div class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Conversion
        </span>

        <div class="flex flex-wrap items-end gap-3">
          <div class="flex min-w-52 flex-1 flex-col gap-1.5">
            <Label for="av-target" class="text-xs text-muted-foreground"> Convert to </Label>
            <SearchableSelect
              id="av-target"
              :spec="targetSpec"
              :model-value="opts.target"
              @update:model-value="setTarget"
            />
          </div>

          <div class="flex min-w-52 flex-1 flex-col gap-1.5">
            <Label for="av-quality" class="text-xs text-muted-foreground"> Quality </Label>
            <SearchableSelect
              id="av-quality"
              :spec="qualitySpec"
              :model-value="opts.quality"
              @update:model-value="setQuality"
            />
          </div>

          <div v-if="canStripAudio" class="flex items-center gap-2 pb-2">
            <Switch
              id="av-strip-audio"
              :model-value="opts.stripAudio"
              @update:model-value="(v) => (opts.stripAudio = Boolean(v))"
            />
            <Label for="av-strip-audio" class="text-xs text-muted-foreground">
              Remove the audio track
            </Label>
          </div>
        </div>

        <p class="text-xs text-muted-foreground">
          {{ spec.note }}
          <template v-if="spec.qualityApplies">
            This tier means {{ describeQuality(opts.target, opts.quality) }}.
          </template>
        </p>

        <p v-if="extracting" class="text-xs text-muted-foreground">
          {{ sourceName }} looks like a video, so the picture is dropped and only its soundtrack is
          written to {{ spec.label }}.
        </p>

        <ErrorBanner v-if="mismatch" :message="mismatch.message" :hint="mismatch.fix" />

        <p
          v-if="preview"
          class="overflow-x-auto font-mono text-xs whitespace-pre text-muted-foreground"
        >
          {{ preview }}
        </p>
      </div>
    </template>

    <template #notes>
      <p class="text-xs text-muted-foreground">
        ffmpeg here is compiled to WebAssembly and runs on one thread, so it is slower than a
        desktop app that uses every core and the encoder built into your GPU. A short clip takes
        roughly as long as it would take to play, and a long file takes a while, so keep the tab
        open. WebM is encoded as VP8 with Vorbis audio rather than VP9: VP9 encoding in WebAssembly
        is several times slower for a modest size win. MKV copies the streams instead of re-encoding
        them, which is the fast path when you only need a different container.
      </p>
    </template>
  </MediaShell>
</template>
