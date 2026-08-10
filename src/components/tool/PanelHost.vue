<script setup lang="ts">
import { defineAsyncComponent, type Component } from "vue";
import type { ToolMeta } from "@/tools/types";
import ToolShell from "./ToolShell.vue";
import CapabilityGate from "./CapabilityGate.vue";
import PopoutButton from "./PopoutButton.vue";

/**
 * Picks the tool's UI surface: a bespoke panel when one exists, else the
 * generic ToolShell. Panels are async components so each one stays in its
 * own chunk, loaded only on its page (rule 14). Tools that declare
 * `meta.requires` go through CapabilityGate first (rule 15). The wrapper
 * carries `data-popout-root` so PopoutButton can float the whole panel in a
 * Document Picture-in-Picture window.
 */
const panels: Record<string, Component> = {
  "audio-spectrogram": defineAsyncComponent(() => import("./panels/SpectrogramPanel.vue")),
  "audio-transcriber": defineAsyncComponent(() => import("./panels/TranscriberPanel.vue")),
  "audio-trimmer": defineAsyncComponent(() => import("./panels/AudioTrimmerPanel.vue")),
  "background-remover": defineAsyncComponent(() => import("./panels/BackgroundRemoverPanel.vue")),
  "batch-processor": defineAsyncComponent(() => import("./panels/BatchProcessorPanel.vue")),
  "bingo-card-generator": defineAsyncComponent(() => import("./panels/BingoBoardPanel.vue")),
  "ble-sensor-dashboard": defineAsyncComponent(() => import("./panels/BleDashboardPanel.vue")),
  "bulk-rename": defineAsyncComponent(() => import("./panels/BulkRenamePanel.vue")),
  "clipboard-inspector": defineAsyncComponent(() => import("./panels/ClipboardPanel.vue")),
  "discord-video-compressor": defineAsyncComponent(
    () => import("./panels/DiscordCompressorPanel.vue"),
  ),
  "display-info": defineAsyncComponent(() => import("./panels/DisplayInfoPanel.vue")),
  "duplicate-finder": defineAsyncComponent(() => import("./panels/DuplicateFinderPanel.vue")),
  "electromagnetic-spectrum": defineAsyncComponent(
    () => import("./panels/ElectromagneticSpectrumPanel.vue"),
  ),
  "favicon-generator": defineAsyncComponent(() => import("./panels/FaviconPanel.vue")),
  "firmware-flasher": defineAsyncComponent(() => import("./panels/FirmwareFlasherPanel.vue")),
  "folder-diff": defineAsyncComponent(() => import("./panels/FolderDiffPanel.vue")),
  "gif-editor": defineAsyncComponent(() => import("./panels/GifEditorPanel.vue")),
  "har-viewer": defineAsyncComponent(() => import("./panels/HarViewerPanel.vue")),
  "hid-report-explorer": defineAsyncComponent(() => import("./panels/HidExplorerPanel.vue")),
  "image-redactor": defineAsyncComponent(() => import("./panels/RedactorPanel.vue")),
  "image-to-text": defineAsyncComponent(() => import("./panels/OcrPanel.vue")),
  "image-toolbox": defineAsyncComponent(() => import("./panels/ImageToolboxPanel.vue")),
  "jinja-template-tester": defineAsyncComponent(() => import("./panels/JinjaTesterPanel.vue")),
  keycode: defineAsyncComponent(() => import("./panels/KeycodePanel.vue")),
  "midi-inspector": defineAsyncComponent(() => import("./panels/MidiPanel.vue")),
  "minecraft-anvil-calculator": defineAsyncComponent(
    () => import("./panels/MinecraftAnvilPanel.vue"),
  ),
  "minecraft-crop-growth-calculator": defineAsyncComponent(
    () => import("./panels/MinecraftGrowthPanel.vue"),
  ),
  "minecraft-damage-calculator": defineAsyncComponent(
    () => import("./panels/MinecraftDamagePanel.vue"),
  ),
  "minecraft-elytra-calculator": defineAsyncComponent(
    () => import("./panels/MinecraftElytraPanel.vue"),
  ),
  "minecraft-hunger-calculator": defineAsyncComponent(
    () => import("./panels/MinecraftHungerPanel.vue"),
  ),
  "minecraft-loot-table-calculator": defineAsyncComponent(
    () => import("./panels/MinecraftLootPanel.vue"),
  ),
  "minecraft-mob-spawning-calculator": defineAsyncComponent(
    () => import("./panels/MinecraftSpawningPanel.vue"),
  ),
  "minecraft-projectile-calculator": defineAsyncComponent(
    () => import("./panels/MinecraftProjectilePanel.vue"),
  ),
  "minecraft-redstone-timing-calculator": defineAsyncComponent(
    () => import("./panels/MinecraftRedstonePanel.vue"),
  ),
  "minecraft-villager-trade-calculator": defineAsyncComponent(
    () => import("./panels/MinecraftVillagerPanel.vue"),
  ),
  "minecraft-xp-calculator": defineAsyncComponent(() => import("./panels/MinecraftXpPanel.vue")),
  "mobile-sensors": defineAsyncComponent(() => import("./panels/MobileSensorsPanel.vue")),
  "pdf-toolbox": defineAsyncComponent(() => import("./panels/PdfToolboxPanel.vue")),
  pipelines: defineAsyncComponent(() => import("./panels/PipelinesPanel.vue")),
  "qr-code-generator": defineAsyncComponent(() => import("./panels/QrPanel.vue")),
  "qr-code-scanner": defineAsyncComponent(() => import("./panels/QrReaderPanel.vue")),
  "serial-terminal": defineAsyncComponent(() => import("./panels/SerialTerminalPanel.vue")),
  "sqlite-viewer": defineAsyncComponent(() => import("./panels/SqliteViewerPanel.vue")),
  "unicode-picker": defineAsyncComponent(() => import("./panels/UnicodePanel.vue")),
  "video-converter": defineAsyncComponent(() => import("./panels/AvConverterPanel.vue")),
  "video-frame-extractor": defineAsyncComponent(() => import("./panels/FrameExtractorPanel.vue")),
  "video-to-gif": defineAsyncComponent(() => import("./panels/VideoToGifPanel.vue")),
  "video-trimmer": defineAsyncComponent(() => import("./panels/VideoTrimmerPanel.vue")),
  "wireguard-config-generator": defineAsyncComponent(() => import("./panels/WireguardPanel.vue")),
};

const props = defineProps<{ meta: ToolMeta }>();
const panel = panels[props.meta.slug] ?? ToolShell;
</script>

<template>
  <div class="mb-2 flex justify-end">
    <PopoutButton />
  </div>
  <div data-popout-root>
    <CapabilityGate v-if="meta.requires?.length" :requires="meta.requires">
      <component :is="panel" :meta="meta" />
    </CapabilityGate>
    <component :is="panel" v-else :meta="meta" />
  </div>
</template>
