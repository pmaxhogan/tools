<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { Capability } from '@/tools/types';

/**
 * Progressive enhancement gate (PROJECT.md rule 15). Tools that declare
 * `meta.requires` render normally until a client-side check says the browser
 * cannot do the job, then swap to an honest message naming the missing API
 * and which browsers ship it.
 *
 * The check only runs in `onMounted`, so the static build and the first
 * client render always agree (hydration stays clean) and the gate appears
 * only after detection.
 */
const props = defineProps<{ requires: Capability[] }>();

interface CapabilityInfo {
  /** True when this browser can do the thing. */
  supported: () => boolean;
  /** Plain-language name of the capability. */
  label: string;
  /** Which API is missing and where it is available. */
  detail: string;
}

/** Chromium-derived engines expose a brand list; the UA string is the fallback. */
interface UserAgentData {
  brands?: { brand: string }[];
  mobile?: boolean;
}

function uaData(): UserAgentData | undefined {
  return (navigator as Navigator & { userAgentData?: UserAgentData }).userAgentData;
}

function isChromium(): boolean {
  const brands = uaData()?.brands;
  if (brands?.length) return brands.some((b) => /chromium/i.test(b.brand));
  return /Chrome\/|Chromium\/|Edg\//.test(navigator.userAgent);
}

function isDesktop(): boolean {
  const mobile = uaData()?.mobile;
  if (typeof mobile === 'boolean') return !mobile;
  return !/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

const CHECKS: Partial<Record<Capability, CapabilityInfo>> = {
  'clipboard-read': {
    supported: () => !!navigator.clipboard && 'read' in navigator.clipboard,
    label: 'clipboard inspection',
    detail:
      'Reading the clipboard needs the async clipboard read API. It is available in Chromium browsers such as Chrome, Edge, Brave and Opera, and in recent Safari. Firefox does not support it yet.',
  },
  'fs-access': {
    supported: () => 'showOpenFilePicker' in window,
    label: 'direct file access',
    detail:
      'Opening files in place needs the File System Access API. It is available in Chromium browsers such as Chrome, Edge, Brave and Opera on desktop. Firefox and Safari do not support it yet, so use drag and drop or the file picker instead.',
  },
  webgpu: {
    supported: () => 'gpu' in navigator,
    label: 'GPU acceleration',
    detail:
      'This tool needs WebGPU. It is available in recent Chrome, Edge and Safari, and in Firefox on Windows. If your browser is current, check that hardware acceleration is switched on.',
  },
  webcodecs: {
    supported: () => 'VideoDecoder' in globalThis && 'VideoEncoder' in globalThis,
    label: 'WebCodecs video access',
    detail:
      'This tool needs the WebCodecs API for frame-accurate video work. It is available in Chrome, Edge and recent Safari. Firefox ships partial support, so results there may vary.',
  },
  chromium: {
    supported: isChromium,
    label: 'a Chromium browser',
    detail:
      'This tool relies on APIs that only Chromium browsers ship today. Chrome, Edge, Brave, Arc and Opera all work. Firefox and Safari do not.',
  },
  desktop: {
    supported: isDesktop,
    label: 'a desktop browser',
    detail:
      'This tool relies on APIs that mobile browsers do not expose. Open it on a laptop or desktop.',
  },
  serial: {
    supported: () => 'serial' in navigator,
    label: 'serial port access',
    detail:
      'This tool needs the Web Serial API, available in Chromium browsers on desktop and in recent Firefox. Safari does not support it.',
  },
  hid: {
    supported: () => 'hid' in navigator,
    label: 'HID device access',
    detail:
      'This tool needs the WebHID API, available in Chromium browsers on desktop. Firefox and Safari do not support it.',
  },
  bluetooth: {
    supported: () => 'bluetooth' in navigator,
    label: 'Bluetooth access',
    detail:
      'This tool needs the Web Bluetooth API, available in Chromium browsers such as Chrome, Edge and Opera. Firefox and Safari do not support it.',
  },
  camera: {
    supported: () => !!navigator.mediaDevices?.getUserMedia,
    label: 'camera access',
    detail:
      'This tool needs the getUserMedia camera API. Every current browser ships it, but it is only offered over a secure connection.',
  },
};

/** Capabilities with no entry here fail open: assume the browser can cope. */
const missing = ref<Capability[]>([]);

const missingInfo = computed(() =>
  missing.value.map((cap) => CHECKS[cap]).filter((info): info is CapabilityInfo => !!info)
);

onMounted(() => {
  missing.value = props.requires.filter((cap) => {
    const check = CHECKS[cap];
    return check ? !check.supported() : false;
  });
});
</script>

<template>
  <div
    v-if="missingInfo.length"
    class="rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6"
  >
    <div
      role="alert"
      class="rounded-lg border border-destructive/50 bg-destructive/5 px-3 py-2 text-sm"
    >
      <template
        v-for="(info, i) in missingInfo"
        :key="info.label"
      >
        <p
          class="font-medium text-destructive"
          :class="i > 0 ? 'mt-3' : ''"
        >
          This tool needs {{ info.label }}, which this browser does not support.
        </p>
        <p class="mt-1 text-muted-foreground">
          {{ info.detail }}
        </p>
      </template>
    </div>
  </div>
  <slot v-else />
</template>
