<script setup lang="ts">
/**
 * Bespoke panel for the A/V Converter. Everything ffmpeg related lives in
 * MediaShell (engine download, run, progress, log, preview, download), so this
 * file only owns three controls and the function that turns them into a
 * command. The command itself comes from the pure logic layer, which is where
 * the format table and the quality tiers are defined and tested.
 */
import { computed, reactive, ref } from 'vue';
import { ToolError, type ToolMeta } from '@/tools/types';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import MediaShell from '../MediaShell.vue';
import type { MediaBuildContext, MediaBuildResult } from '@/lib/ffmpeg';
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
} from '@/tools/video-converter/index';

defineProps<{ meta: ToolMeta }>();

/* ---------------------------------------------------------------- */
/* options                                                           */
/* ---------------------------------------------------------------- */

const opts = reactive<{ target: TargetId; quality: QualityId; stripAudio: boolean }>({
  target: 'mp4',
  quality: 'balanced',
  stripAudio: false,
});

const QUALITY_LABELS: Record<QualityId, string> = {
  high: 'High: closest to the source, slowest',
  balanced: 'Balanced: good quality, sensible size',
  small: 'Small: smallest file, softest picture',
};

const videoTargets = TARGET_IDS.filter((id) => FORMATS[id].kind === 'video');
const audioTargets = TARGET_IDS.filter((id) => FORMATS[id].kind === 'audio');

const spec = computed(() => FORMATS[opts.target]);
/** GIF has no audio track to begin with, and audio targets are all audio. */
const canStripAudio = computed(() => spec.value.kind === 'video' && opts.target !== 'gif');

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
const sourceName = computed(() => selected.value[0]?.name ?? '');

/** An audio file cannot become a video, so say it before the run, not after. */
const mismatch = computed(() => {
  if (!sourceName.value || spec.value.kind !== 'video') return null;
  if (!looksLikeAudio(sourceName.value)) return null;
  return {
    message: `${sourceName.value} is an audio file, and ${spec.value.label} is a video format.`,
    fix: 'Pick an audio format such as MP3, M4A, WAV, OGG or FLAC, or load a video file instead.',
  };
});

const extracting = computed(
  () => Boolean(sourceName.value) && spec.value.kind === 'audio' && !looksLikeAudio(sourceName.value)
);

/** The exact command the current choices would run, shown before running it. */
const preview = computed(() => {
  try {
    const plan = buildConvertArgs({
      inputName: sourceName.value || 'input.mov',
      target: opts.target,
      quality: opts.quality,
      stripAudio: opts.stripAudio,
    });
    return formatCommand(plan.args);
  } catch {
    return '';
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
      fix: 'Choose one of the formats in the list above.',
    };
  }

  const original = ctx.files[0]?.name ?? ctx.inputName;
  if (format.kind === 'video' && looksLikeAudio(original)) {
    return {
      error: `${original} is an audio file, and ${format.label} is a video format.`,
      fix: 'Pick an audio format such as MP3, M4A, WAV, OGG or FLAC, or load a video file instead.',
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
            <Label
              for="av-target"
              class="text-xs text-muted-foreground"
            >
              Convert to
            </Label>
            <Select
              :model-value="opts.target"
              @update:model-value="setTarget"
            >
              <SelectTrigger
                id="av-target"
                size="sm"
                class="w-full bg-card"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectLabel>Video</SelectLabel>
                  <SelectItem
                    v-for="id in videoTargets"
                    :key="id"
                    :value="id"
                  >
                    {{ FORMATS[id].label }}
                  </SelectItem>
                </SelectGroup>
                <SelectGroup>
                  <SelectLabel>Audio</SelectLabel>
                  <SelectItem
                    v-for="id in audioTargets"
                    :key="id"
                    :value="id"
                  >
                    {{ FORMATS[id].label }}
                  </SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </div>

          <div class="flex min-w-52 flex-1 flex-col gap-1.5">
            <Label
              for="av-quality"
              class="text-xs text-muted-foreground"
            >
              Quality
            </Label>
            <Select
              :model-value="opts.quality"
              @update:model-value="setQuality"
            >
              <SelectTrigger
                id="av-quality"
                size="sm"
                class="w-full bg-card"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem
                  v-for="id in QUALITY_IDS"
                  :key="id"
                  :value="id"
                >
                  {{ QUALITY_LABELS[id] }}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div
            v-if="canStripAudio"
            class="flex items-center gap-2 pb-2"
          >
            <Switch
              id="av-strip-audio"
              :model-value="opts.stripAudio"
              @update:model-value="(v) => (opts.stripAudio = Boolean(v))"
            />
            <Label
              for="av-strip-audio"
              class="text-xs text-muted-foreground"
            >
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

        <p
          v-if="extracting"
          class="text-xs text-muted-foreground"
        >
          {{ sourceName }} looks like a video, so the picture is dropped and only its soundtrack is
          written to {{ spec.label }}.
        </p>

        <div
          v-if="mismatch"
          role="status"
          class="rounded-lg border border-destructive/50 bg-destructive/5 px-3 py-2 text-sm"
        >
          <p class="font-medium text-destructive">
            {{ mismatch.message }}
          </p>
          <p class="mt-1 text-muted-foreground">
            {{ mismatch.fix }}
          </p>
        </div>

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
        open. WebM is encoded as VP8 with Vorbis audio rather than VP9: VP9 encoding in
        WebAssembly is several times slower for a modest size win. MKV copies the streams instead
        of re-encoding them, which is the fast path when you only need a different container.
      </p>
    </template>
  </MediaShell>
</template>
