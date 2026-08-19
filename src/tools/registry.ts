/**
 * Hand-maintained tool registry.
 *
 * Imports each tool's cheap `meta.ts` eagerly (grid, palette, sitemap, SEO)
 * and maps slugs to a lazy import of the logic module (rule 14: heavy code
 * loads only on the page that needs it).
 *
 * Adding a tool: create src/tools/<slug>/{meta.ts,index.ts,index.test.ts},
 * then register meta + loader here, alphabetized by URL slug.
 * tool-matrix.csv stays the planning doc.
 */
import type { ToolMeta } from "./types";
import { meta as audioSpectrogram } from "./audio-spectrogram/meta";
import { meta as audioTranscriber } from "./audio-transcriber/meta";
import { meta as audioTrimmer } from "./audio-trimmer/meta";
import { meta as backgroundRemover } from "./background-remover/meta";
import { meta as baseConverter } from "./base-converter/meta";
import { meta as batchProcessor } from "./batch-processor/meta";
import { meta as batteryLifeEstimator } from "./battery-life-estimator/meta";
import { meta as bingoCardGenerator } from "./bingo-card-generator/meta";
import { meta as bleSensorDashboard } from "./ble-sensor-dashboard/meta";
import { meta as bookmarklets } from "./bookmarklets/meta";
import { meta as browserPrivacyCheck } from "./browser-privacy-check/meta";
import { meta as bulkRename } from "./bulk-rename/meta";
import { meta as calc } from "./calc/meta";
import { meta as caseConverter } from "./case-converter/meta";
import { meta as certificateDecoder } from "./certificate-decoder/meta";
import { meta as characterCounter } from "./character-counter/meta";
import { meta as clipboardInspector } from "./clipboard-inspector/meta";
import { meta as clipboardPipelines } from "./clipboard-pipelines/meta";
import { meta as colorBlindnessSimulator } from "./color-blindness-simulator/meta";
import { meta as cronParser } from "./cron-parser/meta";
import { meta as csvViewer } from "./csv-viewer/meta";
import { meta as dataFormatConverter } from "./data-format-converter/meta";
import { meta as decodeAnything } from "./decode-anything/meta";
import { meta as diffChecker } from "./diff-checker/meta";
import { meta as discordTimestamp } from "./discord-timestamp/meta";
import { meta as discordVideoCompressor } from "./discord-video-compressor/meta";
import { meta as displayInfo } from "./display-info/meta";
import { meta as dmarcReportViewer } from "./dmarc-report-viewer/meta";
import { meta as dnsLookup } from "./dns-lookup/meta";
import { meta as dnsPropagation } from "./dns-propagation/meta";
import { meta as dockerComposeConverter } from "./docker-compose-converter/meta";
import { meta as duplicateFinder } from "./duplicate-finder/meta";
import { meta as durationCalculator } from "./duration-calculator/meta";
import { meta as electromagneticSpectrum } from "./electromagnetic-spectrum/meta";
import { meta as emailHeaderAnalyzer } from "./email-header-analyzer/meta";
import { meta as epochConverter } from "./epoch-converter/meta";
import { meta as escapeUnescape } from "./escape-unescape/meta";
import { meta as exifTimeShifter } from "./exif-time-shifter/meta";
import { meta as factorioBlueprintDecoder } from "./factorio-blueprint-decoder/meta";
import { meta as fakeDataGenerator } from "./fake-data-generator/meta";
import { meta as faviconGenerator } from "./favicon-generator/meta";
import { meta as figlet } from "./figlet/meta";
import { meta as fileTypeIdentifier } from "./file-type-identifier/meta";
import { meta as firmwareFlasher } from "./firmware-flasher/meta";
import { meta as folderDiff } from "./folder-diff/meta";
import { meta as gamCommandBuilder } from "./gam-command-builder/meta";
import { meta as gifEditor } from "./gif-editor/meta";
import { meta as gpuInspector } from "./gpu-inspector/meta";
import { meta as gzipCompressionTest } from "./gzip-compression-test/meta";
import { meta as harViewer } from "./har-viewer/meta";
import { meta as hashGenerator } from "./hash-generator/meta";
import { meta as hashIdentifier } from "./hash-identifier/meta";
import { meta as hidReportExplorer } from "./hid-report-explorer/meta";
import { meta as htmlToMarkdown } from "./html-to-markdown/meta";
import { meta as icsInspector } from "./ics-inspector/meta";
import { meta as imageRedactor } from "./image-redactor/meta";
import { meta as imageToText } from "./image-to-text/meta";
import { meta as imageToolbox } from "./image-toolbox/meta";
import { meta as invisibleCharacterDetector } from "./invisible-character-detector/meta";
import { meta as jinjaTemplateTester } from "./jinja-template-tester/meta";
import { meta as jsonFormatter } from "./json-formatter/meta";
import { meta as jsonSchemaValidator } from "./json-schema-validator/meta";
import { meta as jsonToTypescript } from "./json-to-typescript/meta";
import { meta as jwtVulnerabilityCheck } from "./jwt-vulnerability-check/meta";
import { meta as keycode } from "./keycode/meta";
import { meta as lineSorter } from "./line-sorter/meta";
import { meta as mcpInspector } from "./mcp-inspector/meta";
import { meta as midiInspector } from "./midi-inspector/meta";
import { meta as minecraftAnvilCalculator } from "./minecraft-anvil-calculator/meta";
import { meta as minecraftCropGrowthCalculator } from "./minecraft-crop-growth-calculator/meta";
import { meta as minecraftDamageCalculator } from "./minecraft-damage-calculator/meta";
import { meta as minecraftElytraCalculator } from "./minecraft-elytra-calculator/meta";
import { meta as minecraftHungerCalculator } from "./minecraft-hunger-calculator/meta";
import { meta as minecraftLootTableCalculator } from "./minecraft-loot-table-calculator/meta";
import { meta as minecraftMobSpawningCalculator } from "./minecraft-mob-spawning-calculator/meta";
import { meta as minecraftProjectileCalculator } from "./minecraft-projectile-calculator/meta";
import { meta as minecraftRedstoneTimingCalculator } from "./minecraft-redstone-timing-calculator/meta";
import { meta as minecraftVillagerTradeCalculator } from "./minecraft-villager-trade-calculator/meta";
import { meta as minecraftXpCalculator } from "./minecraft-xp-calculator/meta";
import { meta as mobileSensors } from "./mobile-sensors/meta";
import { meta as mojibakeFixer } from "./mojibake-fixer/meta";
import { meta as oauthScopeDecoder } from "./oauth-scope-decoder/meta";
import { meta as ohmsLawCalculator } from "./ohms-law-calculator/meta";
import { meta as oryxLayoutDiff } from "./oryx-layout-diff/meta";
import { meta as p2pFileTransfer } from "./p2p-file-transfer/meta";
import { meta as passkeyTester } from "./passkey-tester/meta";
import { meta as passwordGenerator } from "./password-generator/meta";
import { meta as pdfToolbox } from "./pdf-toolbox/meta";
import { meta as pipelines } from "./pipelines/meta";
import { meta as placeholderImage } from "./placeholder-image/meta";
import { meta as promqlFormatter } from "./promql-formatter/meta";
import { meta as protobufDecoder } from "./protobuf-decoder/meta";
import { meta as qrCodeGenerator } from "./qr-code-generator/meta";
import { meta as qrCodeScanner } from "./qr-code-scanner/meta";
import { meta as raidzCalculator } from "./raidz-calculator/meta";
import { meta as randomPicker } from "./random-picker/meta";
import { meta as screenRecorder } from "./screen-recorder/meta";
import { meta as serialTerminal } from "./serial-terminal/meta";
import { meta as smartctlAnalyzer } from "./smartctl-analyzer/meta";
import { meta as snowflakeDecoder } from "./snowflake-decoder/meta";
import { meta as speculationRulesGenerator } from "./speculation-rules-generator/meta";
import { meta as sqlFormatter } from "./sql-formatter/meta";
import { meta as sqliteViewer } from "./sqlite-viewer/meta";
import { meta as subnetCalculator } from "./subnet-calculator/meta";
import { meta as subtitleEditor } from "./subtitle-editor/meta";
import { meta as svgOptimizer } from "./svg-optimizer/meta";
import { meta as systemdUnitBuilder } from "./systemd-unit-builder/meta";
import { meta as temporalPlayground } from "./temporal-playground/meta";
import { meta as terminalQrCode } from "./terminal-qr-code/meta";
import { meta as timezonePlanner } from "./timezone-planner/meta";
import { meta as totpGenerator } from "./totp-generator/meta";
import { meta as unicodePicker } from "./unicode-picker/meta";
import { meta as urlParser } from "./url-parser/meta";
import { meta as urlpatternTester } from "./urlpattern-tester/meta";
import { meta as userAgentParser } from "./user-agent-parser/meta";
import { meta as uuid } from "./uuid/meta";
import { meta as videoConverter } from "./video-converter/meta";
import { meta as videoFrameExtractor } from "./video-frame-extractor/meta";
import { meta as videoToGif } from "./video-to-gif/meta";
import { meta as videoTrimmer } from "./video-trimmer/meta";
import { meta as wasmInspector } from "./wasm-inspector/meta";
import { meta as webrtcTester } from "./webrtc-tester/meta";
import { meta as weekNumber } from "./week-number/meta";
import { meta as wireguardConfigGenerator } from "./wireguard-config-generator/meta";

export const tools: ToolMeta[] = [
  audioSpectrogram,
  audioTranscriber,
  audioTrimmer,
  backgroundRemover,
  baseConverter,
  batchProcessor,
  batteryLifeEstimator,
  bingoCardGenerator,
  bleSensorDashboard,
  bookmarklets,
  browserPrivacyCheck,
  bulkRename,
  calc,
  caseConverter,
  certificateDecoder,
  characterCounter,
  clipboardInspector,
  clipboardPipelines,
  colorBlindnessSimulator,
  cronParser,
  csvViewer,
  dataFormatConverter,
  decodeAnything,
  diffChecker,
  discordTimestamp,
  discordVideoCompressor,
  displayInfo,
  dmarcReportViewer,
  dnsLookup,
  dnsPropagation,
  dockerComposeConverter,
  duplicateFinder,
  durationCalculator,
  electromagneticSpectrum,
  emailHeaderAnalyzer,
  epochConverter,
  escapeUnescape,
  exifTimeShifter,
  factorioBlueprintDecoder,
  fakeDataGenerator,
  faviconGenerator,
  figlet,
  fileTypeIdentifier,
  firmwareFlasher,
  folderDiff,
  gamCommandBuilder,
  gifEditor,
  gpuInspector,
  gzipCompressionTest,
  harViewer,
  hashGenerator,
  hashIdentifier,
  hidReportExplorer,
  htmlToMarkdown,
  icsInspector,
  imageRedactor,
  imageToText,
  imageToolbox,
  invisibleCharacterDetector,
  jinjaTemplateTester,
  jsonFormatter,
  jsonSchemaValidator,
  jsonToTypescript,
  jwtVulnerabilityCheck,
  keycode,
  lineSorter,
  mcpInspector,
  midiInspector,
  minecraftAnvilCalculator,
  minecraftCropGrowthCalculator,
  minecraftDamageCalculator,
  minecraftElytraCalculator,
  minecraftHungerCalculator,
  minecraftLootTableCalculator,
  minecraftMobSpawningCalculator,
  minecraftProjectileCalculator,
  minecraftRedstoneTimingCalculator,
  minecraftVillagerTradeCalculator,
  minecraftXpCalculator,
  mobileSensors,
  mojibakeFixer,
  oauthScopeDecoder,
  ohmsLawCalculator,
  oryxLayoutDiff,
  p2pFileTransfer,
  passkeyTester,
  passwordGenerator,
  pdfToolbox,
  pipelines,
  placeholderImage,
  promqlFormatter,
  protobufDecoder,
  qrCodeGenerator,
  qrCodeScanner,
  raidzCalculator,
  randomPicker,
  screenRecorder,
  serialTerminal,
  smartctlAnalyzer,
  snowflakeDecoder,
  speculationRulesGenerator,
  sqlFormatter,
  sqliteViewer,
  subnetCalculator,
  subtitleEditor,
  svgOptimizer,
  systemdUnitBuilder,
  temporalPlayground,
  terminalQrCode,
  timezonePlanner,
  totpGenerator,
  unicodePicker,
  urlParser,
  urlpatternTester,
  userAgentParser,
  uuid,
  videoConverter,
  videoFrameExtractor,
  videoToGif,
  videoTrimmer,
  wasmInspector,
  webrtcTester,
  weekNumber,
  wireguardConfigGenerator,
];

/** Lazy loaders for tool logic, keyed by URL slug. */
export const loaders: Record<string, () => Promise<unknown>> = {
  "audio-spectrogram": () => import("./audio-spectrogram/index").then((m) => m.default),
  "audio-transcriber": () => import("./audio-transcriber/index").then((m) => m.default),
  "audio-trimmer": () => import("./audio-trimmer/index").then((m) => m.default),
  "background-remover": () => import("./background-remover/index").then((m) => m.default),
  "base-converter": () => import("./base-converter/index").then((m) => m.default),
  "batch-processor": () => import("./batch-processor/index").then((m) => m.default),
  "battery-life-estimator": () => import("./battery-life-estimator/index").then((m) => m.default),
  "bingo-card-generator": () => import("./bingo-card-generator/index").then((m) => m.default),
  "ble-sensor-dashboard": () => import("./ble-sensor-dashboard/index").then((m) => m.default),
  bookmarklets: () => import("./bookmarklets/index").then((m) => m.default),
  "browser-privacy-check": () => import("./browser-privacy-check/index").then((m) => m.default),
  "bulk-rename": () => import("./bulk-rename/index").then((m) => m.default),
  calc: () => import("./calc/index").then((m) => m.default),
  "case-converter": () => import("./case-converter/index").then((m) => m.default),
  "certificate-decoder": () => import("./certificate-decoder/index").then((m) => m.default),
  "character-counter": () => import("./character-counter/index").then((m) => m.default),
  "clipboard-inspector": () => import("./clipboard-inspector/index").then((m) => m.default),
  "clipboard-pipelines": () => import("./clipboard-pipelines/index").then((m) => m.default),
  "color-blindness-simulator": () =>
    import("./color-blindness-simulator/index").then((m) => m.default),
  "cron-parser": () => import("./cron-parser/index").then((m) => m.default),
  "csv-viewer": () => import("./csv-viewer/index").then((m) => m.default),
  "data-format-converter": () => import("./data-format-converter/index").then((m) => m.default),
  "decode-anything": () => import("./decode-anything/index").then((m) => m.default),
  "diff-checker": () => import("./diff-checker/index").then((m) => m.default),
  "discord-timestamp": () => import("./discord-timestamp/index").then((m) => m.default),
  "discord-video-compressor": () =>
    import("./discord-video-compressor/index").then((m) => m.default),
  "display-info": () => import("./display-info/index").then((m) => m.default),
  "dmarc-report-viewer": () => import("./dmarc-report-viewer/index").then((m) => m.default),
  "dns-lookup": () => import("./dns-lookup/index").then((m) => m.default),
  "dns-propagation": () => import("./dns-propagation/index").then((m) => m.default),
  "docker-compose-converter": () =>
    import("./docker-compose-converter/index").then((m) => m.default),
  "duplicate-finder": () => import("./duplicate-finder/index").then((m) => m.default),
  "duration-calculator": () => import("./duration-calculator/index").then((m) => m.default),
  "electromagnetic-spectrum": () =>
    import("./electromagnetic-spectrum/index").then((m) => m.default),
  "email-header-analyzer": () => import("./email-header-analyzer/index").then((m) => m.default),
  "epoch-converter": () => import("./epoch-converter/index").then((m) => m.default),
  "escape-unescape": () => import("./escape-unescape/index").then((m) => m.default),
  "exif-time-shifter": () => import("./exif-time-shifter/index").then((m) => m.default),
  "factorio-blueprint-decoder": () =>
    import("./factorio-blueprint-decoder/index").then((m) => m.default),
  "fake-data-generator": () => import("./fake-data-generator/index").then((m) => m.default),
  "favicon-generator": () => import("./favicon-generator/index").then((m) => m.default),
  figlet: () => import("./figlet/index").then((m) => m.default),
  "file-type-identifier": () => import("./file-type-identifier/index").then((m) => m.default),
  "firmware-flasher": () => import("./firmware-flasher/index").then((m) => m.default),
  "folder-diff": () => import("./folder-diff/index").then((m) => m.default),
  "gam-command-builder": () => import("./gam-command-builder/index").then((m) => m.default),
  "gif-editor": () => import("./gif-editor/index").then((m) => m.default),
  "gpu-inspector": () => import("./gpu-inspector/index").then((m) => m.default),
  "gzip-compression-test": () => import("./gzip-compression-test/index").then((m) => m.default),
  "har-viewer": () => import("./har-viewer/index").then((m) => m.default),
  "hash-generator": () => import("./hash-generator/index").then((m) => m.default),
  "hash-identifier": () => import("./hash-identifier/index").then((m) => m.default),
  "hid-report-explorer": () => import("./hid-report-explorer/index").then((m) => m.default),
  "html-to-markdown": () => import("./html-to-markdown/index").then((m) => m.default),
  "ics-inspector": () => import("./ics-inspector/index").then((m) => m.default),
  "image-redactor": () => import("./image-redactor/index").then((m) => m.default),
  "image-to-text": () => import("./image-to-text/index").then((m) => m.default),
  "image-toolbox": () => import("./image-toolbox/index").then((m) => m.default),
  "invisible-character-detector": () =>
    import("./invisible-character-detector/index").then((m) => m.default),
  "jinja-template-tester": () => import("./jinja-template-tester/index").then((m) => m.default),
  "json-formatter": () => import("./json-formatter/index").then((m) => m.default),
  "json-schema-validator": () => import("./json-schema-validator/index").then((m) => m.default),
  "json-to-typescript": () => import("./json-to-typescript/index").then((m) => m.default),
  "jwt-vulnerability-check": () => import("./jwt-vulnerability-check/index").then((m) => m.default),
  keycode: () => import("./keycode/index").then((m) => m.default),
  "line-sorter": () => import("./line-sorter/index").then((m) => m.default),
  "mcp-inspector": () => import("./mcp-inspector/index").then((m) => m.default),
  "midi-inspector": () => import("./midi-inspector/index").then((m) => m.default),
  "minecraft-anvil-calculator": () =>
    import("./minecraft-anvil-calculator/index").then((m) => m.default),
  "minecraft-crop-growth-calculator": () =>
    import("./minecraft-crop-growth-calculator/index").then((m) => m.default),
  "minecraft-damage-calculator": () =>
    import("./minecraft-damage-calculator/index").then((m) => m.default),
  "minecraft-elytra-calculator": () =>
    import("./minecraft-elytra-calculator/index").then((m) => m.default),
  "minecraft-hunger-calculator": () =>
    import("./minecraft-hunger-calculator/index").then((m) => m.default),
  "minecraft-loot-table-calculator": () =>
    import("./minecraft-loot-table-calculator/index").then((m) => m.default),
  "minecraft-mob-spawning-calculator": () =>
    import("./minecraft-mob-spawning-calculator/index").then((m) => m.default),
  "minecraft-projectile-calculator": () =>
    import("./minecraft-projectile-calculator/index").then((m) => m.default),
  "minecraft-redstone-timing-calculator": () =>
    import("./minecraft-redstone-timing-calculator/index").then((m) => m.default),
  "minecraft-villager-trade-calculator": () =>
    import("./minecraft-villager-trade-calculator/index").then((m) => m.default),
  "minecraft-xp-calculator": () => import("./minecraft-xp-calculator/index").then((m) => m.default),
  "mobile-sensors": () => import("./mobile-sensors/index").then((m) => m.default),
  "mojibake-fixer": () => import("./mojibake-fixer/index").then((m) => m.default),
  "oauth-scope-decoder": () => import("./oauth-scope-decoder/index").then((m) => m.default),
  "ohms-law-calculator": () => import("./ohms-law-calculator/index").then((m) => m.default),
  "oryx-layout-diff": () => import("./oryx-layout-diff/index").then((m) => m.default),
  "p2p-file-transfer": () => import("./p2p-file-transfer/index").then((m) => m.default),
  "passkey-tester": () => import("./passkey-tester/index").then((m) => m.default),
  "password-generator": () => import("./password-generator/index").then((m) => m.default),
  "pdf-toolbox": () => import("./pdf-toolbox/index").then((m) => m.default),
  pipelines: () => import("./pipelines/index").then((m) => m.default),
  "placeholder-image": () => import("./placeholder-image/index").then((m) => m.default),
  "promql-formatter": () => import("./promql-formatter/index").then((m) => m.default),
  "protobuf-decoder": () => import("./protobuf-decoder/index").then((m) => m.default),
  "qr-code-generator": () => import("./qr-code-generator/index").then((m) => m.default),
  "qr-code-scanner": () => import("./qr-code-scanner/index").then((m) => m.default),
  "raidz-calculator": () => import("./raidz-calculator/index").then((m) => m.default),
  "random-picker": () => import("./random-picker/index").then((m) => m.default),
  "screen-recorder": () => import("./screen-recorder/index").then((m) => m.default),
  "serial-terminal": () => import("./serial-terminal/index").then((m) => m.default),
  "smartctl-analyzer": () => import("./smartctl-analyzer/index").then((m) => m.default),
  "snowflake-decoder": () => import("./snowflake-decoder/index").then((m) => m.default),
  "speculation-rules-generator": () =>
    import("./speculation-rules-generator/index").then((m) => m.default),
  "sql-formatter": () => import("./sql-formatter/index").then((m) => m.default),
  "sqlite-viewer": () => import("./sqlite-viewer/index").then((m) => m.default),
  "subnet-calculator": () => import("./subnet-calculator/index").then((m) => m.default),
  "subtitle-editor": () => import("./subtitle-editor/index").then((m) => m.default),
  "svg-optimizer": () => import("./svg-optimizer/index").then((m) => m.default),
  "systemd-unit-builder": () => import("./systemd-unit-builder/index").then((m) => m.default),
  "temporal-playground": () => import("./temporal-playground/index").then((m) => m.default),
  "terminal-qr-code": () => import("./terminal-qr-code/index").then((m) => m.default),
  "timezone-planner": () => import("./timezone-planner/index").then((m) => m.default),
  "totp-generator": () => import("./totp-generator/index").then((m) => m.default),
  "unicode-picker": () => import("./unicode-picker/index").then((m) => m.default),
  "url-parser": () => import("./url-parser/index").then((m) => m.default),
  "urlpattern-tester": () => import("./urlpattern-tester/index").then((m) => m.default),
  "user-agent-parser": () => import("./user-agent-parser/index").then((m) => m.default),
  "uuid-generator": () => import("./uuid/index").then((m) => m.default),
  "video-converter": () => import("./video-converter/index").then((m) => m.default),
  "video-frame-extractor": () => import("./video-frame-extractor/index").then((m) => m.default),
  "video-to-gif": () => import("./video-to-gif/index").then((m) => m.default),
  "video-trimmer": () => import("./video-trimmer/index").then((m) => m.default),
  "wasm-inspector": () => import("./wasm-inspector/index").then((m) => m.default),
  "webrtc-tester": () => import("./webrtc-tester/index").then((m) => m.default),
  "week-number": () => import("./week-number/index").then((m) => m.default),
  "wireguard-config-generator": () =>
    import("./wireguard-config-generator/index").then((m) => m.default),
};

export function getTool(slug: string): ToolMeta | undefined {
  return tools.find((t) => t.slug === slug);
}

export const categories = (): string[] => [...new Set(tools.map((t) => t.category))];
