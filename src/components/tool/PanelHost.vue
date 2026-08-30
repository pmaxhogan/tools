<script setup lang="ts">
import {
  defineAsyncComponent,
  onBeforeUnmount,
  onMounted,
  provide,
  ref,
  type Component,
} from "vue";
import { KEYBOARD_FIRST_TOOLS, installToolShortcuts } from "@/lib/shortcuts";
import { RECENT_TOOLS_KEY, rememberRecent } from "@/lib/recent-tools";
import { readList, writeList } from "@/lib/prefs";
import type { ToolMeta } from "@/tools/types";
import ToolShell from "./ToolShell.vue";
import CapabilityGate from "./CapabilityGate.vue";
import PopoutButton from "./PopoutButton.vue";
import ShareLinkButton from "./ShareLinkButton.vue";
import FavoriteButton from "./FavoriteButton.vue";
import ShortcutSheet from "./ShortcutSheet.vue";

/**
 * Picks the tool's UI surface: a bespoke panel when one exists, else the
 * generic ToolShell. Panels are async components so each one stays in its
 * own chunk, loaded only on its page (rule 14). Tools that declare
 * `meta.requires` go through CapabilityGate first (rule 15). The wrapper
 * carries `data-popout-root` so PopoutButton can float the whole panel in a
 * Document Picture-in-Picture window.
 */
const panels: Record<string, Component> = {
  "audio-data-codec": defineAsyncComponent(() => import("./panels/AudioDataPanel.vue")),
  "audio-spectrogram": defineAsyncComponent(() => import("./panels/SpectrogramPanel.vue")),
  "audio-transcriber": defineAsyncComponent(() => import("./panels/TranscriberPanel.vue")),
  "audio-trimmer": defineAsyncComponent(() => import("./panels/AudioTrimmerPanel.vue")),
  "background-remover": defineAsyncComponent(() => import("./panels/BackgroundRemoverPanel.vue")),
  "barcode-generator": defineAsyncComponent(() => import("./panels/BarcodePanel.vue")),
  "batch-processor": defineAsyncComponent(() => import("./panels/BatchProcessorPanel.vue")),
  "bed-mesh-visualizer": defineAsyncComponent(() => import("./panels/BedMeshPanel.vue")),
  "bingo-card-generator": defineAsyncComponent(() => import("./panels/BingoBoardPanel.vue")),
  "ble-sensor-dashboard": defineAsyncComponent(() => import("./panels/BleDashboardPanel.vue")),
  bookmarklets: defineAsyncComponent(() => import("./panels/BookmarkletsPanel.vue")),
  "bpm-key-detector": defineAsyncComponent(() => import("./panels/BpmKeyPanel.vue")),
  "browser-privacy-check": defineAsyncComponent(() => import("./panels/PrivacyCheckPanel.vue")),
  "bulk-rename": defineAsyncComponent(() => import("./panels/BulkRenamePanel.vue")),
  calc: defineAsyncComponent(() => import("./panels/CalcPanel.vue")),
  "chart-maker": defineAsyncComponent(() => import("./panels/ChartMakerPanel.vue")),
  "clipboard-inspector": defineAsyncComponent(() => import("./panels/ClipboardPanel.vue")),
  "clipboard-pipelines": defineAsyncComponent(() => import("./panels/ClipboardPipelinesPanel.vue")),
  "color-blindness-simulator": defineAsyncComponent(
    () => import("./panels/ColorBlindnessPanel.vue"),
  ),
  "color-picker": defineAsyncComponent(() => import("./panels/ColorPickerPanel.vue")),
  "countdown-timer": defineAsyncComponent(() => import("./panels/CountdownPanel.vue")),
  "css-anchor-positioning-builder": defineAsyncComponent(
    () => import("./panels/AnchorBuilderPanel.vue"),
  ),
  "discord-video-compressor": defineAsyncComponent(
    () => import("./panels/DiscordCompressorPanel.vue"),
  ),
  "display-info": defineAsyncComponent(() => import("./panels/DisplayInfoPanel.vue")),
  "dns-lookup": defineAsyncComponent(() => import("./panels/DnsLookupPanel.vue")),
  "dns-propagation": defineAsyncComponent(() => import("./panels/DnsPropagationPanel.vue")),
  "document-converter": defineAsyncComponent(() => import("./panels/DocumentConverterPanel.vue")),
  "duplicate-finder": defineAsyncComponent(() => import("./panels/DuplicateFinderPanel.vue")),
  echo: defineAsyncComponent(() => import("./panels/EchoPanel.vue")),
  "electromagnetic-spectrum": defineAsyncComponent(
    () => import("./panels/ElectromagneticSpectrumPanel.vue"),
  ),
  "element-recorder": defineAsyncComponent(() => import("./panels/ElementRecorderPanel.vue")),
  "exif-time-shifter": defineAsyncComponent(() => import("./panels/ExifShiftPanel.vue")),
  "favicon-generator": defineAsyncComponent(() => import("./panels/FaviconPanel.vue")),
  "firmware-flasher": defineAsyncComponent(() => import("./panels/FirmwareFlasherPanel.vue")),
  "folder-diff": defineAsyncComponent(() => import("./panels/FolderDiffPanel.vue")),
  "font-subsetter": defineAsyncComponent(() => import("./panels/FontSubsetterPanel.vue")),
  "gamepad-tester": defineAsyncComponent(() => import("./panels/GamepadPanel.vue")),
  "gcode-viewer": defineAsyncComponent(() => import("./panels/GcodePanel.vue")),
  "gif-editor": defineAsyncComponent(() => import("./panels/GifEditorPanel.vue")),
  "gpu-inspector": defineAsyncComponent(() => import("./panels/GpuInspectorPanel.vue")),
  "gpx-viewer": defineAsyncComponent(() => import("./panels/GpxViewerPanel.vue")),
  "handwriting-pad": defineAsyncComponent(() => import("./panels/HandwritingPanel.vue")),
  "har-viewer": defineAsyncComponent(() => import("./panels/HarViewerPanel.vue")),
  "hex-viewer": defineAsyncComponent(() => import("./panels/HexViewerPanel.vue")),
  "hid-report-explorer": defineAsyncComponent(() => import("./panels/HidExplorerPanel.vue")),
  "http-header-inspector": defineAsyncComponent(() => import("./panels/HeaderInspectorPanel.vue")),
  "image-diff": defineAsyncComponent(() => import("./panels/ImageDiffPanel.vue")),
  "image-dithering": defineAsyncComponent(() => import("./panels/DitheringPanel.vue")),
  "image-redactor": defineAsyncComponent(() => import("./panels/RedactorPanel.vue")),
  "image-steganography": defineAsyncComponent(() => import("./panels/SteganographyPanel.vue")),
  "image-to-ascii": defineAsyncComponent(() => import("./panels/AsciiArtPanel.vue")),
  "image-to-text": defineAsyncComponent(() => import("./panels/OcrPanel.vue")),
  "image-upscaler": defineAsyncComponent(() => import("./panels/UpscalerPanel.vue")),
  "image-toolbox": defineAsyncComponent(() => import("./panels/ImageToolboxPanel.vue")),
  "jinja-template-tester": defineAsyncComponent(() => import("./panels/JinjaTesterPanel.vue")),
  "key-rollover-tester": defineAsyncComponent(() => import("./panels/RolloverPanel.vue")),
  "keyboard-heatmap": defineAsyncComponent(() => import("./panels/KeyboardHeatmapPanel.vue")),
  keycode: defineAsyncComponent(() => import("./panels/KeycodePanel.vue")),
  "light-meter": defineAsyncComponent(() => import("./panels/LightMeterPanel.vue")),
  "markdown-table-editor": defineAsyncComponent(() => import("./panels/MarkdownTablePanel.vue")),
  "mcp-inspector": defineAsyncComponent(() => import("./panels/McpInspectorPanel.vue")),
  "media-key-tester": defineAsyncComponent(() => import("./panels/MediaKeyPanel.vue")),
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
  "monitor-test": defineAsyncComponent(() => import("./panels/MonitorTestPanel.vue")),
  "mouse-tester": defineAsyncComponent(() => import("./panels/MouseTesterPanel.vue")),
  "multitouch-tester": defineAsyncComponent(() => import("./panels/MultitouchPanel.vue")),
  "nfc-tag-tool": defineAsyncComponent(() => import("./panels/NfcPanel.vue")),
  "p2p-file-transfer": defineAsyncComponent(() => import("./panels/FileDropPanel.vue")),
  "parquet-viewer": defineAsyncComponent(() => import("./panels/ParquetViewerPanel.vue")),
  "passkey-tester": defineAsyncComponent(() => import("./panels/PasskeyPanel.vue")),
  "pdf-toolbox": defineAsyncComponent(() => import("./panels/PdfToolboxPanel.vue")),
  pipelines: defineAsyncComponent(() => import("./panels/PipelinesPanel.vue")),
  "pomodoro-timer": defineAsyncComponent(() => import("./panels/PomodoroPanel.vue")),
  "qr-code-generator": defineAsyncComponent(() => import("./panels/QrPanel.vue")),
  "qr-code-scanner": defineAsyncComponent(() => import("./panels/QrReaderPanel.vue")),
  "qr-file-transfer": defineAsyncComponent(() => import("./panels/QrTransferPanel.vue")),
  "screen-recorder": defineAsyncComponent(() => import("./panels/ScreenRecorderPanel.vue")),
  "screen-ruler": defineAsyncComponent(() => import("./panels/ScreenRulerPanel.vue")),
  "screenshot-annotator": defineAsyncComponent(() => import("./panels/AnnotatorPanel.vue")),
  "screenshot-beautifier": defineAsyncComponent(() => import("./panels/BeautifierPanel.vue")),
  "serial-terminal": defineAsyncComponent(() => import("./panels/SerialTerminalPanel.vue")),
  "sprite-sheet-packer": defineAsyncComponent(() => import("./panels/SpritePackerPanel.vue")),
  "sqlite-viewer": defineAsyncComponent(() => import("./panels/SqliteViewerPanel.vue")),
  "tone-generator": defineAsyncComponent(() => import("./panels/ToneGeneratorPanel.vue")),
  "totp-generator": defineAsyncComponent(() => import("./panels/TotpPanel.vue")),
  "tuner-metronome": defineAsyncComponent(() => import("./panels/TunerMetronomePanel.vue")),
  "unicode-picker": defineAsyncComponent(() => import("./panels/UnicodePanel.vue")),
  "video-converter": defineAsyncComponent(() => import("./panels/AvConverterPanel.vue")),
  "video-frame-extractor": defineAsyncComponent(() => import("./panels/FrameExtractorPanel.vue")),
  "video-to-gif": defineAsyncComponent(() => import("./panels/VideoToGifPanel.vue")),
  "video-trimmer": defineAsyncComponent(() => import("./panels/VideoTrimmerPanel.vue")),
  "wasm-feature-detector": defineAsyncComponent(() => import("./panels/WasmFeaturePanel.vue")),
  "webcam-mic-test": defineAsyncComponent(() => import("./panels/WebcamMicPanel.vue")),
  "webrtc-tester": defineAsyncComponent(() => import("./panels/WebrtcTesterPanel.vue")),
  "wikidata-cities-database": defineAsyncComponent(
    () => import("./panels/WikidataCitiesPanel.vue"),
  ),
  "wireguard-config-generator": defineAsyncComponent(() => import("./panels/WireguardPanel.vue")),
  "raidz-calculator": defineAsyncComponent(() => import("./panels/RaidzPanel.vue")),
  "resistor-color-code-calculator": defineAsyncComponent(
    () => import("./panels/ResistorPanel.vue"),
  ),
  "distance-bearing-calculator": defineAsyncComponent(
    () => import("./panels/DistanceBearingPanel.vue"),
  ),
  "sunrise-sunset-calculator": defineAsyncComponent(
    () => import("./panels/SunriseSunsetPanel.vue"),
  ),
  "photography-calculator": defineAsyncComponent(() => import("./panels/PhotographyPanel.vue")),
  "wire-gauge-calculator": defineAsyncComponent(() => import("./panels/WireGaugePanel.vue")),
  "nfpa-704-fire-diamond": defineAsyncComponent(() => import("./panels/NfpaDiamondPanel.vue")),
  "chemical-lookup": defineAsyncComponent(() => import("./panels/ChemicalLookupPanel.vue")),
  "ghs-pictogram-lookup": defineAsyncComponent(() => import("./panels/GhsLookupPanel.vue")),
  "periodic-table": defineAsyncComponent(() => import("./panels/PeriodicTablePanel.vue")),
  "document-scanner": defineAsyncComponent(() => import("./panels/DocumentScannerPanel.vue")),
  "coordinate-converter": defineAsyncComponent(
    () => import("./panels/CoordinateConverterPanel.vue"),
  ),
  "regex-tester": defineAsyncComponent(() => import("./panels/RegexTesterPanel.vue")),
  "xpath-css-selector-tester": defineAsyncComponent(() => import("./panels/XPathTesterPanel.vue")),
};

const props = defineProps<{ meta: ToolMeta }>();
const panel = panels[props.meta.slug] ?? ToolShell;
// Shared components (FileDrop, ShareLinkButton, ...) read these instead of
// taking the whole meta as a prop.
provide("toolSlug", props.meta.slug);
provide("toolName", props.meta.name);

// Opening a tool page counts as using it: the Recent rows on the home page
// and in the sidebar read this list. A slug list is a preference (rule 7).
const isBespoke = panel !== ToolShell;

// The `?` shortcut sheet for bespoke panels. ToolShell installs its own
// listener (with run/copy/clear handlers), so this one only exists when a
// bespoke panel is mounted; installing both would open the sheet twice.
// KEYBOARD_FIRST_TOOLS get no sheet at all: on those the key you press is the
// reading, and a modal that traps focus would break the tool (see shortcuts.ts).
const showsShortcutSheet = isBespoke && !KEYBOARD_FIRST_TOOLS.has(props.meta.slug);
const shortcutSheetOpen = ref(false);
let uninstallShortcuts: (() => void) | undefined;

onMounted(() => {
  writeList(RECENT_TOOLS_KEY, rememberRecent(readList(RECENT_TOOLS_KEY), props.meta.slug));
  if (showsShortcutSheet) {
    uninstallShortcuts = installToolShortcuts({
      onShowHelp: () => {
        shortcutSheetOpen.value = true;
      },
      isDialogOpen: () => document.querySelector("[data-dismissable-layer]") !== null,
    });
  }
});

onBeforeUnmount(() => {
  uninstallShortcuts?.();
});
</script>

<template>
  <div class="mb-2 flex items-center justify-end gap-1">
    <FavoriteButton :slug="meta.slug" />
    <ShareLinkButton />
    <PopoutButton />
  </div>
  <div data-popout-root>
    <CapabilityGate v-if="meta.requires?.length" :requires="meta.requires">
      <component :is="panel" :meta="meta" />
    </CapabilityGate>
    <component :is="panel" v-else :meta="meta" />
  </div>
  <ShortcutSheet v-if="showsShortcutSheet" v-model:open="shortcutSheetOpen" />
</template>
