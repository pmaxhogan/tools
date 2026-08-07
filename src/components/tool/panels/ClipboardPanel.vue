<script setup lang="ts">
import { onUnmounted, ref } from 'vue';
import type { ToolMeta } from '@/tools/types';
import { run } from '@/tools/clipboard-inspector/index';
import type { ClipboardEntrySnapshot, ClipboardSnapshot } from '@/tools/clipboard-inspector/index';
import { Button } from '@/components/ui/button';
import { Clipboard } from 'lucide-vue-next';
import OutputView from '../OutputView.vue';

/**
 * Bespoke panel for the clipboard inspector: the pure layer only knows how
 * to describe a snapshot, so this panel owns the one thing it cannot do,
 * calling navigator.clipboard.read() from a real click handler and turning
 * the result into the ClipboardSnapshot JSON the logic expects. It also adds
 * the previews the logic layer has no business rendering: image thumbnails
 * and raw HTML markup.
 */
defineProps<{ meta: ToolMeta }>();

/** Kept locally only, never handed to run(): a full data URL for a thumbnail. */
interface ImagePreview {
  key: string;
  type: string;
  dataUrl: string;
}

/** Kept locally only: the raw markup for a text/html entry, mono and escaped. */
interface MarkupPreview {
  key: string;
  type: string;
  text: string;
}

const MAX_TEXT_CHARS = 2000;
/** How long a read runs before the panel explains that the browser's own
 *  permission prompt, not this page, is what it is waiting on. */
const SLOW_READ_MS = 1500;

const output = ref<Record<string, string> | null>(null);
const imagePreviews = ref<ImagePreview[]>([]);
const markupPreviews = ref<MarkupPreview[]>([]);
const reading = ref(false);
const readingSlow = ref(false);
const errorTitle = ref<string | null>(null);
const errorDetail = ref<string | null>(null);
let slowReadTimer: ReturnType<typeof setTimeout> | null = null;

function clearSlowReadTimer() {
  if (slowReadTimer !== null) {
    clearTimeout(slowReadTimer);
    slowReadTimer = null;
  }
  readingSlow.value = false;
}

function resetState() {
  output.value = null;
  imagePreviews.value = [];
  markupPreviews.value = [];
  errorTitle.value = null;
  errorDetail.value = null;
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error ?? new Error('Could not read the image data.'));
    reader.readAsDataURL(blob);
  });
}

function describeReadError(err: unknown): { title: string; detail: string } {
  const name = err instanceof DOMException ? err.name : '';
  const message = err instanceof Error ? err.message : String(err);

  if (name === 'NotAllowedError' && /focus/i.test(message)) {
    return {
      title: 'This page needs focus to read the clipboard.',
      detail: 'Click anywhere on this page, then click Read clipboard again.',
    };
  }

  if (name === 'NotAllowedError') {
    return {
      title: 'The browser blocked clipboard access.',
      detail:
        'Clipboard read permission was denied. Check the permission icon in the address bar, allow clipboard access for this site, and try again.',
    };
  }

  return {
    title: 'Could not read the clipboard.',
    detail: message || 'An unknown error stopped the clipboard read. Try again.',
  };
}

async function readClipboard() {
  resetState();

  if (!document.hasFocus()) {
    errorTitle.value = 'This page needs focus to read the clipboard.';
    errorDetail.value = 'Click anywhere on this page, then click Read clipboard again.';
    return;
  }

  reading.value = true;
  clearSlowReadTimer();
  slowReadTimer = setTimeout(() => {
    readingSlow.value = true;
  }, SLOW_READ_MS);
  try {
    const items = await navigator.clipboard.read();

    const entries: ClipboardEntrySnapshot[] = [];
    const nextImagePreviews: ImagePreview[] = [];
    const nextMarkupPreviews: MarkupPreview[] = [];

    for (const item of items) {
      for (const type of item.types) {
        let blob: Blob;
        try {
          blob = await item.getType(type);
        } catch {
          // This type was advertised but the browser would not hand it over.
          continue;
        }

        const entry: ClipboardEntrySnapshot = { type, bytes: blob.size };
        const key = `${type}-${entries.length}`;

        if (type.startsWith('text/')) {
          const text = await blob.text();
          entry.text = text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text;
          if (type === 'text/html') {
            nextMarkupPreviews.push({ key, type, text: entry.text });
          }
        } else if (type.startsWith('image/')) {
          const dataUrl = await blobToDataUrl(blob);
          const commaIndex = dataUrl.indexOf(',');
          entry.dataUrlPrefix = commaIndex === -1 ? dataUrl : dataUrl.slice(0, commaIndex + 1);
          nextImagePreviews.push({ key, type, dataUrl });
        }

        entries.push(entry);
      }
    }

    const snapshot: ClipboardSnapshot = { entries };
    output.value = run(JSON.stringify(snapshot), {});
    imagePreviews.value = nextImagePreviews;
    markupPreviews.value = nextMarkupPreviews;
  } catch (err) {
    const described = describeReadError(err);
    errorTitle.value = described.title;
    errorDetail.value = described.detail;
  } finally {
    reading.value = false;
    clearSlowReadTimer();
  }
}

function clear() {
  resetState();
}

onUnmounted(() => {
  clearSlowReadTimer();
});
</script>

<template>
  <div class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <div class="flex flex-wrap items-center gap-3">
      <Button
        size="lg"
        :disabled="reading"
        @click="readClipboard"
      >
        <Clipboard
          class="size-4"
          aria-hidden="true"
        />
        {{ reading ? 'Reading clipboard…' : 'Read clipboard' }}
      </Button>
      <Button
        v-if="output !== null || errorTitle !== null"
        variant="ghost"
        :disabled="reading"
        @click="clear"
      >
        Clear
      </Button>
    </div>

    <p
      v-if="reading && readingSlow"
      class="text-xs text-muted-foreground"
      aria-live="polite"
    >
      Still waiting on the browser. Check for a permission prompt near the address bar and allow
      clipboard access. This page cannot read the clipboard without it.
    </p>

    <p class="text-xs text-muted-foreground">
      Everything runs locally: your files and inputs never leave your device. The clipboard is only
      read after you click the button above, and nothing is stored or sent anywhere.
    </p>

    <div
      v-if="errorTitle"
      role="alert"
      class="rounded-lg border border-destructive/50 bg-destructive/5 px-3 py-2 text-sm"
    >
      <p class="font-medium text-destructive">
        {{ errorTitle }}
      </p>
      <p
        v-if="errorDetail"
        class="mt-1 text-muted-foreground"
      >
        {{ errorDetail }}
      </p>
    </div>

    <OutputView
      v-if="output !== null"
      :output="output"
    />

    <div
      v-if="imagePreviews.length"
      class="flex flex-col gap-2"
    >
      <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">Image preview</span>
      <div class="flex flex-wrap gap-3">
        <div
          v-for="preview in imagePreviews"
          :key="preview.key"
          class="flex flex-col items-start gap-1 rounded-[10px] bg-secondary p-2 shadow-[var(--sh-inset)]"
        >
          <img
            :src="preview.dataUrl"
            :alt="`Clipboard image preview, ${preview.type}`"
            class="max-h-[200px] max-w-[200px] rounded-[6px] object-contain"
          >
          <span class="font-mono text-xs text-muted-foreground">{{ preview.type }}</span>
        </div>
      </div>
    </div>

    <div
      v-for="preview in markupPreviews"
      :key="preview.key"
      class="flex flex-col gap-2"
    >
      <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">Raw {{ preview.type }} markup</span>
      <pre
        class="max-h-96 overflow-auto rounded-[10px] bg-secondary px-3 py-2 font-mono text-sm whitespace-pre-wrap break-all shadow-[var(--sh-inset)]"
      >{{ preview.text }}</pre>
    </div>
  </div>
</template>
