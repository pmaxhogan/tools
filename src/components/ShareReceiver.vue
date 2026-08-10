<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { formatBytes } from "@/lib/format";

/**
 * Receives content shared into the installed PWA. The service worker parks the
 * shared payload (files and/or text) in a one-shot Cache Storage slot and
 * redirects here; this island reads that slot exactly once, works out what was
 * shared, and offers the tools that can open it. Nothing is uploaded: the
 * payload is read from same-origin Cache Storage on the device.
 *
 * A plain GET share of text/url (the manifest can only declare one share
 * target, so the POST handler is primary) is also honored by reading
 * location.search, which is then stripped so shared content never lingers in
 * the address bar.
 */

interface CatalogEntry {
  slug: string;
  name: string;
  description: string;
}

const props = defineProps<{ catalog: CatalogEntry[] }>();

const SHARE_CACHE = "share-target-inbox";
const SHARE_META_KEY = "/__share/meta";
/** Matches fragment.ts MAX_FRAGMENT_INPUT: bigger text is linked, not carried. */
const MAX_HANDOFF = 2000;

interface SharedFile {
  name: string;
  type: string;
  size: number;
  previewUrl?: string;
}

interface Payload {
  title: string;
  text: string;
  url: string;
  files: SharedFile[];
}

const loading = ref(true);
const payload = ref<Payload | null>(null);
/** Text content eligible to be handed straight into a text tool, if small. */
const handoffText = ref("");

const bySlug = computed(() => new Map(props.catalog.map((t) => [t.slug, t])));

function entries(slugs: string[]): CatalogEntry[] {
  return slugs.map((s) => bySlug.value.get(s)).filter((t): t is CatalogEntry => Boolean(t));
}

/** What kind of thing was shared, and which tools match it. */
const detection = computed<{ label: string; slugs: string[] } | null>(() => {
  const p = payload.value;
  if (!p) return null;
  const file = p.files[0];
  if (file) {
    const t = file.type.toLowerCase();
    if (t.startsWith("image/"))
      return { label: "an image", slugs: ["image-redactor", "image-toolbox", "image-to-text"] };
    if (t.startsWith("audio/"))
      return { label: "audio", slugs: ["audio-spectrogram", "audio-trimmer"] };
    if (t.startsWith("video/"))
      return { label: "a video", slugs: ["video-converter", "video-to-gif"] };
    if (t.startsWith("text/") || t.includes("json"))
      return {
        label: "a text file",
        slugs: ["json-formatter", "data-format-converter", "case-converter"],
      };
    return { label: "a file", slugs: ["file-type-identifier"] };
  }
  const shared = p.text || p.url || p.title;
  if (shared) {
    const looksUrl = /^https?:\/\/\S+$/i.test((p.url || p.text || "").trim());
    const slugs = looksUrl
      ? ["url-parser", "json-formatter", "case-converter"]
      : ["json-formatter", "data-format-converter", "case-converter"];
    return { label: looksUrl ? "a link" : "text", slugs };
  }
  return null;
});

const matches = computed(() => (detection.value ? entries(detection.value.slugs) : []));

/** Build the tool link, carrying small shared text into the tool via the URL
 *  fragment (fragment.ts format: #i=<input>). Files cannot ride the fragment. */
function toolHref(slug: string): string {
  const text = handoffText.value;
  if (text && text.length <= MAX_HANDOFF) {
    const frag = new URLSearchParams({ i: text }).toString();
    return `/${slug}#${frag}`;
  }
  return `/${slug}`;
}

const previewText = computed(() => {
  const p = payload.value;
  if (!p) return "";
  return (p.text || p.url || p.title || "").slice(0, 600);
});

async function readShare(): Promise<Payload | null> {
  if (!("caches" in window)) return null;
  const cache = await caches.open(SHARE_CACHE);
  const metaRes = await cache.match(SHARE_META_KEY);
  if (!metaRes) return null;

  const meta = (await metaRes.json()) as {
    title: string;
    text: string;
    url: string;
    files: { key: string; name: string; type: string; size: number }[];
  };

  const files: SharedFile[] = [];
  for (const f of meta.files ?? []) {
    const res = await cache.match(f.key);
    const shared: SharedFile = { name: f.name, type: f.type, size: f.size };
    if (res) {
      const blob = await res.blob();
      if (f.type.startsWith("image/")) shared.previewUrl = URL.createObjectURL(blob);
      // A small text file can be handed straight into a text tool.
      if ((f.type.startsWith("text/") || f.type.includes("json")) && f.size <= MAX_HANDOFF) {
        handoffText.value = await blob.text();
      }
    }
    files.push(shared);
  }

  // One-shot: consume the slot so a reload shows the empty state, not stale data.
  for (const key of await cache.keys()) await cache.delete(key);

  return { title: meta.title || "", text: meta.text || "", url: meta.url || "", files };
}

/** GET fallback: text/url arriving as query params (some share flows use GET). */
function readQueryFallback(): Payload | null {
  const q = new URLSearchParams(window.location.search);
  const title = q.get("title") || "";
  const text = q.get("text") || "";
  const url = q.get("url") || "";
  if (!title && !text && !url) return null;
  // Strip so shared content does not linger in the address bar.
  history.replaceState(null, "", window.location.pathname);
  return { title, text, url, files: [] };
}

onMounted(async () => {
  try {
    let result = await readShare();
    if (!result) result = readQueryFallback();
    if (result) {
      payload.value = result;
      if (!handoffText.value) handoffText.value = result.text || result.url || result.title || "";
    }
  } catch {
    payload.value = null;
  } finally {
    loading.value = false;
  }
});
</script>

<template>
  <div class="mx-auto max-w-[720px]">
    <div
      v-if="loading"
      class="rounded-[18px] border bg-card p-6 text-sm text-muted-foreground shadow-[var(--sh-sm)]"
    >
      Reading what you shared...
    </div>

    <template v-else-if="payload && detection">
      <div class="rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
        <p class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          You shared {{ detection.label }}
        </p>

        <div class="mt-3 flex flex-col gap-3">
          <div
            v-for="file in payload.files"
            :key="file.name"
            class="flex items-center gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]"
          >
            <img
              v-if="file.previewUrl"
              :src="file.previewUrl"
              alt=""
              class="size-12 shrink-0 rounded-md object-cover"
            />
            <div class="min-w-0">
              <p class="truncate text-sm font-medium">
                {{ file.name }}
              </p>
              <p class="text-xs text-muted-foreground">
                {{ file.type || "unknown type" }} &middot; {{ formatBytes(file.size) }}
              </p>
            </div>
          </div>

          <div
            v-if="!payload.files.length && previewText"
            class="rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]"
          >
            <p class="line-clamp-4 font-mono text-sm break-words whitespace-pre-wrap">
              {{ previewText }}
            </p>
          </div>
        </div>
      </div>

      <h2 class="mt-6 text-sm font-semibold text-muted-foreground">Open it in</h2>
      <div class="mt-3 grid gap-3 sm:grid-cols-2">
        <a
          v-for="tool in matches"
          :key="tool.slug"
          :href="toolHref(tool.slug)"
          class="group flex flex-col rounded-[14px] border bg-card p-4 shadow-[var(--sh-sm)] transition-[transform,box-shadow] duration-[160ms] outline-none hover:-translate-y-0.5 hover:shadow-[var(--sh-md)] focus-visible:ring-3 focus-visible:ring-ring/50 motion-reduce:transition-none motion-reduce:hover:translate-y-0"
        >
          <span class="font-medium group-hover:text-primary">{{ tool.name }}</span>
          <span class="mt-1 text-sm text-muted-foreground">{{ tool.description }}</span>
        </a>
      </div>

      <p class="mt-6 text-xs text-muted-foreground">
        Your files and inputs never leave your device.
      </p>
    </template>

    <div v-else class="rounded-[18px] border bg-card p-8 text-center shadow-[var(--sh-sm)]">
      <h2 class="text-lg font-semibold">Nothing was shared</h2>
      <p class="mx-auto mt-2 max-w-[46ch] text-sm text-muted-foreground">
        Install this site to your home screen, then use your phone's Share button on an image, file,
        link, or piece of text and pick tools.maxhogan.dev. It will open here with the right tools
        ready to go.
      </p>
      <a
        href="/"
        class="mt-5 inline-flex h-10 items-center rounded-[10px] bg-primary px-4 text-sm font-medium text-primary-foreground shadow-[var(--sh-sm)] transition-colors outline-none hover:opacity-90 focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        Browse all tools
      </a>
    </div>
  </div>
</template>
