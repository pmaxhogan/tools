<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import type { ToolMeta } from "@/tools/types";
import { run } from "@/tools/gpu-inspector/index";
import type { GpuSnapshot } from "@/tools/gpu-inspector/index";
import { Button } from "@/components/ui/button";
import { RefreshCw } from "lucide-vue-next";
import OutputView from "../OutputView.vue";

/**
 * Bespoke panel for GPU Inspector: the pure layer only knows how to describe
 * a snapshot, so this panel owns the live read, calling navigator.gpu once
 * on mount (and again on "Rescan") and feeding the result through the same
 * run() a pasted JSON snapshot would use. Every navigator access happens in
 * onMounted or a click handler, never at setup time, so the CapabilityGate
 * wrapping this panel (meta.requires: ["webgpu"]) stays the only thing that
 * runs during the server-rendered shell.
 */
defineProps<{ meta: ToolMeta }>();

/**
 * The WebGPU types below are absent from the standard DOM lib, so this panel
 * declares just the surface it reads, following DisplayInfoPanel's pattern
 * for browser APIs TypeScript does not know about yet.
 */
interface GpuAdapterInfoLike {
  vendor?: string;
  architecture?: string;
  device?: string;
  description?: string;
}
interface GpuSupportedLimitsLike {
  [key: string]: number | undefined;
}
interface GpuAdapterLike {
  requestAdapterInfo?: () => Promise<GpuAdapterInfoLike>;
  info?: GpuAdapterInfoLike;
  isFallbackAdapter?: boolean;
  features: Iterable<string>;
  limits: GpuSupportedLimitsLike;
}
interface GpuLike {
  requestAdapter: (options?: Record<string, unknown>) => Promise<GpuAdapterLike | null>;
  getPreferredCanvasFormat?: () => string;
  wgslLanguageFeatures?: Iterable<string>;
}
interface NavigatorWithGpu extends Navigator {
  gpu?: GpuLike;
}

/**
 * The standard GPUSupportedLimits members (WebGPU spec). adapter.limits
 * exposes these as non-enumerable getters, so a for-in/Object.keys walk
 * finds nothing: reading each name explicitly is the reliable way in.
 * Any name a future spec adds, or a browser omits, is skipped silently.
 */
const LIMIT_NAMES = [
  "maxTextureDimension1D",
  "maxTextureDimension2D",
  "maxTextureDimension3D",
  "maxTextureArrayLayers",
  "maxBindGroups",
  "maxBindGroupsPlusVertexBuffers",
  "maxBindingsPerBindGroup",
  "maxDynamicUniformBuffersPerPipelineLayout",
  "maxDynamicStorageBuffersPerPipelineLayout",
  "maxSampledTexturesPerShaderStage",
  "maxSamplersPerShaderStage",
  "maxStorageBuffersPerShaderStage",
  "maxStorageTexturesPerShaderStage",
  "maxUniformBuffersPerShaderStage",
  "maxUniformBufferBindingSize",
  "maxStorageBufferBindingSize",
  "minUniformBufferOffsetAlignment",
  "minStorageBufferOffsetAlignment",
  "maxVertexBuffers",
  "maxBufferSize",
  "maxVertexAttributes",
  "maxVertexBufferArrayStride",
  "maxInterStageShaderVariables",
  "maxColorAttachments",
  "maxColorAttachmentBytesPerSample",
  "maxComputeWorkgroupStorageSize",
  "maxComputeInvocationsPerWorkgroup",
  "maxComputeWorkgroupSizeX",
  "maxComputeWorkgroupSizeY",
  "maxComputeWorkgroupSizeZ",
  "maxComputeWorkgroupsPerDimension",
] as const;

/* ------------------------------------------------------------------ *
 * live state
 * ------------------------------------------------------------------ */

const loading = ref(true);
const errorMessage = ref<string | null>(null);
/** True once a read completed with navigator.gpu present but no adapter
 * granted, so the template can show a more specific note than the generic
 * "Not available" row the pure layer renders for every unavailable case. */
const noAdapterGranted = ref(false);
const snapshot = ref<GpuSnapshot | null>(null);
const detail = ref<"key" | "all">("key");

/* ------------------------------------------------------------------ *
 * reading the adapter
 * ------------------------------------------------------------------ */

async function readSnapshot(): Promise<GpuSnapshot> {
  const nav = navigator as NavigatorWithGpu;
  if (!("gpu" in nav) || !nav.gpu) {
    return { available: false };
  }

  const adapter = await nav.gpu.requestAdapter();
  if (!adapter) {
    noAdapterGranted.value = true;
    return { available: false };
  }

  let info: GpuAdapterInfoLike | undefined;
  if (adapter.info) {
    info = adapter.info;
  } else if (adapter.requestAdapterInfo) {
    try {
      info = await adapter.requestAdapterInfo();
    } catch {
      info = undefined;
    }
  }
  const adapterInfo = info
    ? {
        vendor: info.vendor || undefined,
        architecture: info.architecture || undefined,
        device: info.device || undefined,
        description: info.description || undefined,
      }
    : undefined;

  const limits: Record<string, number> = {};
  for (const name of LIMIT_NAMES) {
    const value = adapter.limits[name];
    if (typeof value === "number") limits[name] = value;
  }

  return {
    available: true,
    adapterInfo,
    isFallbackAdapter: adapter.isFallbackAdapter,
    features: [...adapter.features],
    limits,
    preferredCanvasFormat: nav.gpu.getPreferredCanvasFormat?.(),
    wgslLanguageFeatures: nav.gpu.wgslLanguageFeatures
      ? [...nav.gpu.wgslLanguageFeatures]
      : undefined,
  };
}

async function scan() {
  loading.value = true;
  errorMessage.value = null;
  noAdapterGranted.value = false;
  try {
    snapshot.value = await readSnapshot();
  } catch (err) {
    errorMessage.value =
      err instanceof Error ? err.message : "Could not read the GPU adapter from this browser.";
    snapshot.value = null;
  } finally {
    loading.value = false;
  }
}

onMounted(scan);

/* ------------------------------------------------------------------ *
 * feed the snapshot into the pure logic layer
 * ------------------------------------------------------------------ */

const output = computed<Record<string, string> | null>(() => {
  if (!snapshot.value) return null;
  try {
    return run(snapshot.value, { detail: detail.value });
  } catch {
    return null;
  }
});

function setDetail(value: "key" | "all") {
  detail.value = value;
}
</script>

<template>
  <div class="flex flex-col gap-5 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <div class="flex items-center justify-between gap-3">
      <p class="text-xs text-muted-foreground">
        Read directly from this browser's WebGPU adapter: your files and inputs never leave your
        device.
      </p>

      <Button variant="ghost" size="sm" :disabled="loading" @click="scan">
        <RefreshCw class="size-3.5" aria-hidden="true" />
        {{ loading ? "Scanning…" : "Rescan" }}
      </Button>
    </div>

    <div
      v-if="loading"
      class="flex min-h-[120px] items-center justify-center rounded-[10px] bg-secondary p-6 text-sm text-muted-foreground shadow-[var(--sh-inset)]"
      aria-live="polite"
    >
      Reading your GPU adapter
    </div>

    <div
      v-else-if="errorMessage"
      role="alert"
      class="flex flex-col gap-1 rounded-[10px] bg-secondary p-3 text-xs shadow-[var(--sh-inset)]"
    >
      <span class="font-semibold text-destructive">Could not read the GPU adapter</span>
      <span class="text-muted-foreground">{{ errorMessage }}</span>
    </div>

    <template v-else>
      <p v-if="noAdapterGranted" class="text-xs text-muted-foreground">
        This browser exposes navigator.gpu, but requesting an adapter returned nothing. That usually
        means hardware acceleration is off, or the driver on this machine is on WebGPU's block list.
      </p>

      <div v-if="snapshot?.available" class="flex items-center justify-between gap-3">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase"
          >Limits shown</span
        >
        <div class="inline-flex gap-1 rounded-[10px] bg-secondary p-1 shadow-[var(--sh-inset)]">
          <Button
            variant="ghost"
            size="sm"
            :aria-pressed="detail === 'key'"
            :class="detail === 'key' ? 'bg-card shadow-[var(--sh-sm)]' : ''"
            @click="setDetail('key')"
          >
            Key limits
          </Button>
          <Button
            variant="ghost"
            size="sm"
            :aria-pressed="detail === 'all'"
            :class="detail === 'all' ? 'bg-card shadow-[var(--sh-sm)]' : ''"
            @click="setDetail('all')"
          >
            All limits
          </Button>
        </div>
      </div>

      <OutputView v-if="output" :output="output" />
    </template>
  </div>
</template>
