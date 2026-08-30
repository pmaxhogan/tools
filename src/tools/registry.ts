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
import { meta as airportCodeLookup } from "./airport-code-lookup/meta";
import { meta as audioDataCodec } from "./audio-data-codec/meta";
import { meta as audioSpectrogram } from "./audio-spectrogram/meta";
import { meta as audioTranscriber } from "./audio-transcriber/meta";
import { meta as audioTrimmer } from "./audio-trimmer/meta";
import { meta as backgroundRemover } from "./background-remover/meta";
import { meta as barcodeGenerator } from "./barcode-generator/meta";
import { meta as baseConverter } from "./base-converter/meta";
import { meta as batchProcessor } from "./batch-processor/meta";
import { meta as batteryLifeEstimator } from "./battery-life-estimator/meta";
import { meta as bcryptGenerator } from "./bcrypt-generator/meta";
import { meta as bedMeshVisualizer } from "./bed-mesh-visualizer/meta";
import { meta as bingoCardGenerator } from "./bingo-card-generator/meta";
import { meta as bleSensorDashboard } from "./ble-sensor-dashboard/meta";
import { meta as bookmarklets } from "./bookmarklets/meta";
import { meta as bpmKeyDetector } from "./bpm-key-detector/meta";
import { meta as browserPrivacyCheck } from "./browser-privacy-check/meta";
import { meta as bulkRename } from "./bulk-rename/meta";
import { meta as calc } from "./calc/meta";
import { meta as caseConverter } from "./case-converter/meta";
import { meta as certificateDecoder } from "./certificate-decoder/meta";
import { meta as characterCounter } from "./character-counter/meta";
import { meta as chartMaker } from "./chart-maker/meta";
import { meta as chemicalLookup } from "./chemical-lookup/meta";
import { meta as clipboardInspector } from "./clipboard-inspector/meta";
import { meta as clipboardPipelines } from "./clipboard-pipelines/meta";
import { meta as colorBlindnessSimulator } from "./color-blindness-simulator/meta";
import { meta as colorPicker } from "./color-picker/meta";
import { meta as coordinateConverter } from "./coordinate-converter/meta";
import { meta as countdownTimer } from "./countdown-timer/meta";
import { meta as countryCodeLookup } from "./country-code-lookup/meta";
import { meta as cronParser } from "./cron-parser/meta";
import { meta as cssAnchorPositioningBuilder } from "./css-anchor-positioning-builder/meta";
import { meta as csvViewer } from "./csv-viewer/meta";
import { meta as dataFormatConverter } from "./data-format-converter/meta";
import { meta as decodeAnything } from "./decode-anything/meta";
import { meta as diffChecker } from "./diff-checker/meta";
import { meta as discordTimestamp } from "./discord-timestamp/meta";
import { meta as discordVideoCompressor } from "./discord-video-compressor/meta";
import { meta as displayInfo } from "./display-info/meta";
import { meta as distanceBearingCalculator } from "./distance-bearing-calculator/meta";
import { meta as dmarcReportViewer } from "./dmarc-report-viewer/meta";
import { meta as dnsLookup } from "./dns-lookup/meta";
import { meta as dnsPropagation } from "./dns-propagation/meta";
import { meta as dockerComposeConverter } from "./docker-compose-converter/meta";
import { meta as documentConverter } from "./document-converter/meta";
import { meta as documentScanner } from "./document-scanner/meta";
import { meta as duplicateFinder } from "./duplicate-finder/meta";
import { meta as durationCalculator } from "./duration-calculator/meta";
import { meta as echo } from "./echo/meta";
import { meta as electromagneticSpectrum } from "./electromagnetic-spectrum/meta";
import { meta as elementRecorder } from "./element-recorder/meta";
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
import { meta as fontSubsetter } from "./font-subsetter/meta";
import { meta as gamCommandBuilder } from "./gam-command-builder/meta";
import { meta as gamepadTester } from "./gamepad-tester/meta";
import { meta as gcodeViewer } from "./gcode-viewer/meta";
import { meta as ghsPictogramLookup } from "./ghs-pictogram-lookup/meta";
import { meta as gifEditor } from "./gif-editor/meta";
import { meta as gpuInspector } from "./gpu-inspector/meta";
import { meta as gpxViewer } from "./gpx-viewer/meta";
import { meta as gzipCompressionTest } from "./gzip-compression-test/meta";
import { meta as handwritingPad } from "./handwriting-pad/meta";
import { meta as harViewer } from "./har-viewer/meta";
import { meta as hashGenerator } from "./hash-generator/meta";
import { meta as hashIdentifier } from "./hash-identifier/meta";
import { meta as hexViewer } from "./hex-viewer/meta";
import { meta as hidReportExplorer } from "./hid-report-explorer/meta";
import { meta as htmlToMarkdown } from "./html-to-markdown/meta";
import { meta as httpHeaderInspector } from "./http-header-inspector/meta";
import { meta as icsInspector } from "./ics-inspector/meta";
import { meta as imageDiff } from "./image-diff/meta";
import { meta as imageDithering } from "./image-dithering/meta";
import { meta as imageRedactor } from "./image-redactor/meta";
import { meta as imageSteganography } from "./image-steganography/meta";
import { meta as imageToAscii } from "./image-to-ascii/meta";
import { meta as imageToText } from "./image-to-text/meta";
import { meta as imageToolbox } from "./image-toolbox/meta";
import { meta as imageUpscaler } from "./image-upscaler/meta";
import { meta as invisibleCharacterDetector } from "./invisible-character-detector/meta";
import { meta as jinjaTemplateTester } from "./jinja-template-tester/meta";
import { meta as jsonFormatter } from "./json-formatter/meta";
import { meta as jsonSchemaValidator } from "./json-schema-validator/meta";
import { meta as jsonToTypescript } from "./json-to-typescript/meta";
import { meta as jwtVulnerabilityCheck } from "./jwt-vulnerability-check/meta";
import { meta as keyRolloverTester } from "./key-rollover-tester/meta";
import { meta as keyboardHeatmap } from "./keyboard-heatmap/meta";
import { meta as keycode } from "./keycode/meta";
import { meta as languageCodeLookup } from "./language-code-lookup/meta";
import { meta as lightMeter } from "./light-meter/meta";
import { meta as lineSorter } from "./line-sorter/meta";
import { meta as markdownTableEditor } from "./markdown-table-editor/meta";
import { meta as mcpInspector } from "./mcp-inspector/meta";
import { meta as mediaKeyTester } from "./media-key-tester/meta";
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
import { meta as molarMassCalculator } from "./molar-mass-calculator/meta";
import { meta as monitorTest } from "./monitor-test/meta";
import { meta as mouseTester } from "./mouse-tester/meta";
import { meta as multitouchTester } from "./multitouch-tester/meta";
import { meta as nfcTagTool } from "./nfc-tag-tool/meta";
import { meta as nfpa704FireDiamond } from "./nfpa-704-fire-diamond/meta";
import { meta as oauthScopeDecoder } from "./oauth-scope-decoder/meta";
import { meta as ohmsLawCalculator } from "./ohms-law-calculator/meta";
import { meta as oryxLayoutDiff } from "./oryx-layout-diff/meta";
import { meta as p2pFileTransfer } from "./p2p-file-transfer/meta";
import { meta as parquetViewer } from "./parquet-viewer/meta";
import { meta as passkeyTester } from "./passkey-tester/meta";
import { meta as passwordGenerator } from "./password-generator/meta";
import { meta as pdfToolbox } from "./pdf-toolbox/meta";
import { meta as periodicTable } from "./periodic-table/meta";
import { meta as photographyCalculator } from "./photography-calculator/meta";
import { meta as pipelines } from "./pipelines/meta";
import { meta as placeholderImage } from "./placeholder-image/meta";
import { meta as pomodoroTimer } from "./pomodoro-timer/meta";
import { meta as printCostCalculator } from "./print-cost-calculator/meta";
import { meta as promqlFormatter } from "./promql-formatter/meta";
import { meta as protobufDecoder } from "./protobuf-decoder/meta";
import { meta as qrCodeGenerator } from "./qr-code-generator/meta";
import { meta as qrCodeScanner } from "./qr-code-scanner/meta";
import { meta as qrFileTransfer } from "./qr-file-transfer/meta";
import { meta as raidzCalculator } from "./raidz-calculator/meta";
import { meta as randomPicker } from "./random-picker/meta";
import { meta as resistorColorCodeCalculator } from "./resistor-color-code-calculator/meta";
import { meta as reverseProxyConfigGenerator } from "./reverse-proxy-config-generator/meta";
import { meta as screenRecorder } from "./screen-recorder/meta";
import { meta as screenRuler } from "./screen-ruler/meta";
import { meta as screenshotAnnotator } from "./screenshot-annotator/meta";
import { meta as screenshotBeautifier } from "./screenshot-beautifier/meta";
import { meta as serialTerminal } from "./serial-terminal/meta";
import { meta as smartctlAnalyzer } from "./smartctl-analyzer/meta";
import { meta as snowflakeDecoder } from "./snowflake-decoder/meta";
import { meta as speculationRulesGenerator } from "./speculation-rules-generator/meta";
import { meta as spriteSheetPacker } from "./sprite-sheet-packer/meta";
import { meta as sqlFormatter } from "./sql-formatter/meta";
import { meta as sqliteViewer } from "./sqlite-viewer/meta";
import { meta as subnetCalculator } from "./subnet-calculator/meta";
import { meta as subtitleEditor } from "./subtitle-editor/meta";
import { meta as sunriseSunsetCalculator } from "./sunrise-sunset-calculator/meta";
import { meta as svgOptimizer } from "./svg-optimizer/meta";
import { meta as systemdUnitBuilder } from "./systemd-unit-builder/meta";
import { meta as temporalPlayground } from "./temporal-playground/meta";
import { meta as terminalQrCode } from "./terminal-qr-code/meta";
import { meta as timezonePlanner } from "./timezone-planner/meta";
import { meta as toneGenerator } from "./tone-generator/meta";
import { meta as totpGenerator } from "./totp-generator/meta";
import { meta as tunerMetronome } from "./tuner-metronome/meta";
import { meta as uf2Inspector } from "./uf2-inspector/meta";
import { meta as unicodePicker } from "./unicode-picker/meta";
import { meta as urlParser } from "./url-parser/meta";
import { meta as urlpatternTester } from "./urlpattern-tester/meta";
import { meta as userAgentParser } from "./user-agent-parser/meta";
import { meta as uuid } from "./uuid/meta";
import { meta as videoConverter } from "./video-converter/meta";
import { meta as videoFrameExtractor } from "./video-frame-extractor/meta";
import { meta as videoToGif } from "./video-to-gif/meta";
import { meta as videoTrimmer } from "./video-trimmer/meta";
import { meta as wasmFeatureDetector } from "./wasm-feature-detector/meta";
import { meta as wasmInspector } from "./wasm-inspector/meta";
import { meta as webcamMicTest } from "./webcam-mic-test/meta";
import { meta as webrtcTester } from "./webrtc-tester/meta";
import { meta as weekNumber } from "./week-number/meta";
import { meta as wikidataCitiesDatabase } from "./wikidata-cities-database/meta";
import { meta as wireGaugeCalculator } from "./wire-gauge-calculator/meta";
import { meta as wireguardConfigGenerator } from "./wireguard-config-generator/meta";
import { meta as cipherTool } from "./cipher-tool/meta";
import { meta as fancyTextGenerator } from "./fancy-text-generator/meta";
import { meta as loremIpsumGenerator } from "./lorem-ipsum-generator/meta";
import { meta as morseCodeTranslator } from "./morse-code-translator/meta";
import { meta as natoPhoneticAlphabet } from "./nato-phonetic-alphabet/meta";
import { meta as numberToWords } from "./number-to-words/meta";
import { meta as romanNumeralConverter } from "./roman-numeral-converter/meta";
import { meta as globPatternTester } from "./glob-pattern-tester/meta";
import { meta as jsonpathQuery } from "./jsonpath-query/meta";
import { meta as regexTester } from "./regex-tester/meta";
import { meta as semverRangeTester } from "./semver-range-tester/meta";
import { meta as unifiedDiffPatchApplier } from "./unified-diff-patch-applier/meta";
import { meta as xpathCssSelectorTester } from "./xpath-css-selector-tester/meta";
import { meta as hmacGenerator } from "./hmac-generator/meta";
import { meta as jwtGenerator } from "./jwt-generator/meta";
import { meta as passwordStrengthChecker } from "./password-strength-checker/meta";
import { meta as selfSignedCertificateGenerator } from "./self-signed-certificate-generator/meta";
import { meta as sshKeyGenerator } from "./ssh-key-generator/meta";
import { meta as textEncrypter } from "./text-encrypter/meta";
import { meta as archiveViewer } from "./archive-viewer/meta";
import { meta as logFileAnalyzer } from "./log-file-analyzer/meta";
import { meta as mp3TagEditor } from "./mp3-tag-editor/meta";
import { meta as torrentFileInspector } from "./torrent-file-inspector/meta";
import { meta as xlsxViewer } from "./xlsx-viewer/meta";
import { meta as antennaLengthCalculator } from "./antenna-length-calculator/meta";
import { meta as coaxCableLoss } from "./coax-cable-loss/meta";
import { meta as dbmWattsVolts } from "./dbm-watts-volts/meta";
import { meta as fresnelZone } from "./fresnel-zone/meta";
import { meta as lcResonance } from "./lc-resonance/meta";
import { meta as pathLossLinkBudget } from "./path-loss-link-budget/meta";
import { meta as vswrReturnLoss } from "./vswr-return-loss/meta";
import { meta as wavelengthFrequency } from "./wavelength-frequency/meta";
import { meta as tool555TimerCalculator } from "./555-timer-calculator/meta";
import { meta as capacitorCodeDecoder } from "./capacitor-code-decoder/meta";
import { meta as ledResistorCalculator } from "./led-resistor-calculator/meta";
import { meta as pcbTraceWidth } from "./pcb-trace-width/meta";
import { meta as voltageDivider } from "./voltage-divider/meta";
import { meta as boxShadowGenerator } from "./box-shadow-generator/meta";
import { meta as clipPathGenerator } from "./clip-path-generator/meta";
import { meta as cssGradientGenerator } from "./css-gradient-generator/meta";
import { meta as cssKeyframesBuilder } from "./css-keyframes-builder/meta";
import { meta as cubicBezierEasingEditor } from "./cubic-bezier-easing-editor/meta";
import { meta as fluidClampCalculator } from "./fluid-clamp-calculator/meta";
import { meta as colorContrastChecker } from "./color-contrast-checker/meta";
import { meta as exifViewerAndStripper } from "./exif-viewer-and-stripper/meta";
import { meta as imageColorPaletteExtractor } from "./image-color-palette-extractor/meta";
import { meta as imageToDataUrl } from "./image-to-data-url/meta";
import { meta as imageWatermark } from "./image-watermark/meta";
import { meta as memeGenerator } from "./meme-generator/meta";
import { meta as bufferCalculator } from "./buffer-calculator/meta";
import { meta as chemicalEquationBalancer } from "./chemical-equation-balancer/meta";
import { meta as dilutionCalculator } from "./dilution-calculator/meta";
import { meta as electronConfiguration } from "./electron-configuration/meta";
import { meta as empiricalFormulaCalculator } from "./empirical-formula-calculator/meta";
import { meta as halfLifeDecay } from "./half-life-decay/meta";
import { meta as molaritySolutionPrep } from "./molarity-solution-prep/meta";
import { meta as phPohCalculator } from "./ph-poh-calculator/meta";
import { meta as stoichiometryCalculator } from "./stoichiometry-calculator/meta";
import { meta as julianDateConverter } from "./julian-date-converter/meta";
import { meta as magnitudeCalculator } from "./magnitude-calculator/meta";

export const tools: ToolMeta[] = [
  airportCodeLookup,
  audioDataCodec,
  audioSpectrogram,
  audioTranscriber,
  audioTrimmer,
  backgroundRemover,
  barcodeGenerator,
  baseConverter,
  batchProcessor,
  batteryLifeEstimator,
  bcryptGenerator,
  bedMeshVisualizer,
  bingoCardGenerator,
  bleSensorDashboard,
  bookmarklets,
  bpmKeyDetector,
  browserPrivacyCheck,
  bulkRename,
  calc,
  caseConverter,
  certificateDecoder,
  characterCounter,
  chartMaker,
  chemicalLookup,
  clipboardInspector,
  clipboardPipelines,
  colorBlindnessSimulator,
  colorPicker,
  coordinateConverter,
  countdownTimer,
  countryCodeLookup,
  cronParser,
  cssAnchorPositioningBuilder,
  csvViewer,
  dataFormatConverter,
  decodeAnything,
  diffChecker,
  discordTimestamp,
  discordVideoCompressor,
  displayInfo,
  distanceBearingCalculator,
  dmarcReportViewer,
  dnsLookup,
  dnsPropagation,
  dockerComposeConverter,
  documentConverter,
  documentScanner,
  duplicateFinder,
  durationCalculator,
  echo,
  electromagneticSpectrum,
  elementRecorder,
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
  fontSubsetter,
  gamCommandBuilder,
  gamepadTester,
  gcodeViewer,
  ghsPictogramLookup,
  gifEditor,
  gpuInspector,
  gpxViewer,
  gzipCompressionTest,
  handwritingPad,
  harViewer,
  hashGenerator,
  hashIdentifier,
  hexViewer,
  hidReportExplorer,
  htmlToMarkdown,
  httpHeaderInspector,
  icsInspector,
  imageDiff,
  imageDithering,
  imageRedactor,
  imageSteganography,
  imageToAscii,
  imageToText,
  imageToolbox,
  imageUpscaler,
  invisibleCharacterDetector,
  jinjaTemplateTester,
  jsonFormatter,
  jsonSchemaValidator,
  jsonToTypescript,
  jwtVulnerabilityCheck,
  keyRolloverTester,
  keyboardHeatmap,
  keycode,
  languageCodeLookup,
  lightMeter,
  lineSorter,
  markdownTableEditor,
  mcpInspector,
  mediaKeyTester,
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
  molarMassCalculator,
  monitorTest,
  mouseTester,
  multitouchTester,
  nfcTagTool,
  nfpa704FireDiamond,
  oauthScopeDecoder,
  ohmsLawCalculator,
  oryxLayoutDiff,
  p2pFileTransfer,
  parquetViewer,
  passkeyTester,
  passwordGenerator,
  pdfToolbox,
  periodicTable,
  photographyCalculator,
  pipelines,
  placeholderImage,
  pomodoroTimer,
  printCostCalculator,
  promqlFormatter,
  protobufDecoder,
  qrCodeGenerator,
  qrCodeScanner,
  qrFileTransfer,
  raidzCalculator,
  randomPicker,
  resistorColorCodeCalculator,
  reverseProxyConfigGenerator,
  screenRecorder,
  screenRuler,
  screenshotAnnotator,
  screenshotBeautifier,
  serialTerminal,
  smartctlAnalyzer,
  snowflakeDecoder,
  speculationRulesGenerator,
  spriteSheetPacker,
  sqlFormatter,
  sqliteViewer,
  subnetCalculator,
  subtitleEditor,
  sunriseSunsetCalculator,
  svgOptimizer,
  systemdUnitBuilder,
  temporalPlayground,
  terminalQrCode,
  timezonePlanner,
  toneGenerator,
  totpGenerator,
  tunerMetronome,
  uf2Inspector,
  unicodePicker,
  urlParser,
  urlpatternTester,
  userAgentParser,
  uuid,
  videoConverter,
  videoFrameExtractor,
  videoToGif,
  videoTrimmer,
  wasmFeatureDetector,
  wasmInspector,
  webcamMicTest,
  webrtcTester,
  weekNumber,
  wikidataCitiesDatabase,
  wireGaugeCalculator,
  wireguardConfigGenerator,
  cipherTool,
  fancyTextGenerator,
  loremIpsumGenerator,
  morseCodeTranslator,
  natoPhoneticAlphabet,
  numberToWords,
  romanNumeralConverter,
  globPatternTester,
  jsonpathQuery,
  regexTester,
  semverRangeTester,
  unifiedDiffPatchApplier,
  xpathCssSelectorTester,
  hmacGenerator,
  jwtGenerator,
  passwordStrengthChecker,
  selfSignedCertificateGenerator,
  sshKeyGenerator,
  textEncrypter,
  archiveViewer,
  logFileAnalyzer,
  mp3TagEditor,
  torrentFileInspector,
  xlsxViewer,
  antennaLengthCalculator,
  coaxCableLoss,
  dbmWattsVolts,
  fresnelZone,
  lcResonance,
  pathLossLinkBudget,
  vswrReturnLoss,
  wavelengthFrequency,
  tool555TimerCalculator,
  capacitorCodeDecoder,
  ledResistorCalculator,
  pcbTraceWidth,
  voltageDivider,
  boxShadowGenerator,
  clipPathGenerator,
  cssGradientGenerator,
  cssKeyframesBuilder,
  cubicBezierEasingEditor,
  fluidClampCalculator,
  colorContrastChecker,
  exifViewerAndStripper,
  imageColorPaletteExtractor,
  imageToDataUrl,
  imageWatermark,
  memeGenerator,
  bufferCalculator,
  chemicalEquationBalancer,
  dilutionCalculator,
  electronConfiguration,
  empiricalFormulaCalculator,
  halfLifeDecay,
  molaritySolutionPrep,
  phPohCalculator,
  stoichiometryCalculator,
  julianDateConverter,
  magnitudeCalculator,
];

/** Lazy loaders for tool logic, keyed by URL slug. */
export const loaders: Record<string, () => Promise<unknown>> = {
  "airport-code-lookup": () => import("./airport-code-lookup/index").then((m) => m.default),
  "audio-data-codec": () => import("./audio-data-codec/index").then((m) => m.default),
  "audio-spectrogram": () => import("./audio-spectrogram/index").then((m) => m.default),
  "audio-transcriber": () => import("./audio-transcriber/index").then((m) => m.default),
  "audio-trimmer": () => import("./audio-trimmer/index").then((m) => m.default),
  "background-remover": () => import("./background-remover/index").then((m) => m.default),
  "barcode-generator": () => import("./barcode-generator/index").then((m) => m.default),
  "base-converter": () => import("./base-converter/index").then((m) => m.default),
  "batch-processor": () => import("./batch-processor/index").then((m) => m.default),
  "battery-life-estimator": () => import("./battery-life-estimator/index").then((m) => m.default),
  "bcrypt-generator": () => import("./bcrypt-generator/index").then((m) => m.default),
  "bed-mesh-visualizer": () => import("./bed-mesh-visualizer/index").then((m) => m.default),
  "bingo-card-generator": () => import("./bingo-card-generator/index").then((m) => m.default),
  "ble-sensor-dashboard": () => import("./ble-sensor-dashboard/index").then((m) => m.default),
  bookmarklets: () => import("./bookmarklets/index").then((m) => m.default),
  "bpm-key-detector": () => import("./bpm-key-detector/index").then((m) => m.default),
  "browser-privacy-check": () => import("./browser-privacy-check/index").then((m) => m.default),
  "bulk-rename": () => import("./bulk-rename/index").then((m) => m.default),
  calc: () => import("./calc/index").then((m) => m.default),
  "case-converter": () => import("./case-converter/index").then((m) => m.default),
  "certificate-decoder": () => import("./certificate-decoder/index").then((m) => m.default),
  "character-counter": () => import("./character-counter/index").then((m) => m.default),
  "chart-maker": () => import("./chart-maker/index").then((m) => m.default),
  "chemical-lookup": () => import("./chemical-lookup/index").then((m) => m.default),
  "clipboard-inspector": () => import("./clipboard-inspector/index").then((m) => m.default),
  "clipboard-pipelines": () => import("./clipboard-pipelines/index").then((m) => m.default),
  "color-blindness-simulator": () =>
    import("./color-blindness-simulator/index").then((m) => m.default),
  "color-picker": () => import("./color-picker/index").then((m) => m.default),
  "coordinate-converter": () => import("./coordinate-converter/index").then((m) => m.default),
  "countdown-timer": () => import("./countdown-timer/index").then((m) => m.default),
  "country-code-lookup": () => import("./country-code-lookup/index").then((m) => m.default),
  "cron-parser": () => import("./cron-parser/index").then((m) => m.default),
  "css-anchor-positioning-builder": () =>
    import("./css-anchor-positioning-builder/index").then((m) => m.default),
  "csv-viewer": () => import("./csv-viewer/index").then((m) => m.default),
  "data-format-converter": () => import("./data-format-converter/index").then((m) => m.default),
  "decode-anything": () => import("./decode-anything/index").then((m) => m.default),
  "diff-checker": () => import("./diff-checker/index").then((m) => m.default),
  "discord-timestamp": () => import("./discord-timestamp/index").then((m) => m.default),
  "discord-video-compressor": () =>
    import("./discord-video-compressor/index").then((m) => m.default),
  "display-info": () => import("./display-info/index").then((m) => m.default),
  "distance-bearing-calculator": () =>
    import("./distance-bearing-calculator/index").then((m) => m.default),
  "dmarc-report-viewer": () => import("./dmarc-report-viewer/index").then((m) => m.default),
  "dns-lookup": () => import("./dns-lookup/index").then((m) => m.default),
  "dns-propagation": () => import("./dns-propagation/index").then((m) => m.default),
  "docker-compose-converter": () =>
    import("./docker-compose-converter/index").then((m) => m.default),
  "document-converter": () => import("./document-converter/index").then((m) => m.default),
  "document-scanner": () => import("./document-scanner/index").then((m) => m.default),
  "duplicate-finder": () => import("./duplicate-finder/index").then((m) => m.default),
  "duration-calculator": () => import("./duration-calculator/index").then((m) => m.default),
  echo: () => import("./echo/index").then((m) => m.default),
  "electromagnetic-spectrum": () =>
    import("./electromagnetic-spectrum/index").then((m) => m.default),
  "element-recorder": () => import("./element-recorder/index").then((m) => m.default),
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
  "font-subsetter": () => import("./font-subsetter/index").then((m) => m.default),
  "gam-command-builder": () => import("./gam-command-builder/index").then((m) => m.default),
  "gamepad-tester": () => import("./gamepad-tester/index").then((m) => m.default),
  "gcode-viewer": () => import("./gcode-viewer/index").then((m) => m.default),
  "ghs-pictogram-lookup": () => import("./ghs-pictogram-lookup/index").then((m) => m.default),
  "gif-editor": () => import("./gif-editor/index").then((m) => m.default),
  "gpu-inspector": () => import("./gpu-inspector/index").then((m) => m.default),
  "gpx-viewer": () => import("./gpx-viewer/index").then((m) => m.default),
  "gzip-compression-test": () => import("./gzip-compression-test/index").then((m) => m.default),
  "handwriting-pad": () => import("./handwriting-pad/index").then((m) => m.default),
  "har-viewer": () => import("./har-viewer/index").then((m) => m.default),
  "hash-generator": () => import("./hash-generator/index").then((m) => m.default),
  "hash-identifier": () => import("./hash-identifier/index").then((m) => m.default),
  "hex-viewer": () => import("./hex-viewer/index").then((m) => m.default),
  "hid-report-explorer": () => import("./hid-report-explorer/index").then((m) => m.default),
  "html-to-markdown": () => import("./html-to-markdown/index").then((m) => m.default),
  "http-header-inspector": () => import("./http-header-inspector/index").then((m) => m.default),
  "ics-inspector": () => import("./ics-inspector/index").then((m) => m.default),
  "image-diff": () => import("./image-diff/index").then((m) => m.default),
  "image-dithering": () => import("./image-dithering/index").then((m) => m.default),
  "image-redactor": () => import("./image-redactor/index").then((m) => m.default),
  "image-steganography": () => import("./image-steganography/index").then((m) => m.default),
  "image-to-ascii": () => import("./image-to-ascii/index").then((m) => m.default),
  "image-to-text": () => import("./image-to-text/index").then((m) => m.default),
  "image-toolbox": () => import("./image-toolbox/index").then((m) => m.default),
  "image-upscaler": () => import("./image-upscaler/index").then((m) => m.default),
  "invisible-character-detector": () =>
    import("./invisible-character-detector/index").then((m) => m.default),
  "jinja-template-tester": () => import("./jinja-template-tester/index").then((m) => m.default),
  "json-formatter": () => import("./json-formatter/index").then((m) => m.default),
  "json-schema-validator": () => import("./json-schema-validator/index").then((m) => m.default),
  "json-to-typescript": () => import("./json-to-typescript/index").then((m) => m.default),
  "jwt-vulnerability-check": () => import("./jwt-vulnerability-check/index").then((m) => m.default),
  "key-rollover-tester": () => import("./key-rollover-tester/index").then((m) => m.default),
  "keyboard-heatmap": () => import("./keyboard-heatmap/index").then((m) => m.default),
  "language-code-lookup": () => import("./language-code-lookup/index").then((m) => m.default),
  keycode: () => import("./keycode/index").then((m) => m.default),
  "light-meter": () => import("./light-meter/index").then((m) => m.default),
  "line-sorter": () => import("./line-sorter/index").then((m) => m.default),
  "markdown-table-editor": () => import("./markdown-table-editor/index").then((m) => m.default),
  "mcp-inspector": () => import("./mcp-inspector/index").then((m) => m.default),
  "media-key-tester": () => import("./media-key-tester/index").then((m) => m.default),
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
  "molar-mass-calculator": () => import("./molar-mass-calculator/index").then((m) => m.default),
  "monitor-test": () => import("./monitor-test/index").then((m) => m.default),
  "mouse-tester": () => import("./mouse-tester/index").then((m) => m.default),
  "multitouch-tester": () => import("./multitouch-tester/index").then((m) => m.default),
  "nfc-tag-tool": () => import("./nfc-tag-tool/index").then((m) => m.default),
  "nfpa-704-fire-diamond": () => import("./nfpa-704-fire-diamond/index").then((m) => m.default),
  "oauth-scope-decoder": () => import("./oauth-scope-decoder/index").then((m) => m.default),
  "ohms-law-calculator": () => import("./ohms-law-calculator/index").then((m) => m.default),
  "oryx-layout-diff": () => import("./oryx-layout-diff/index").then((m) => m.default),
  "p2p-file-transfer": () => import("./p2p-file-transfer/index").then((m) => m.default),
  "parquet-viewer": () => import("./parquet-viewer/index").then((m) => m.default),
  "passkey-tester": () => import("./passkey-tester/index").then((m) => m.default),
  "password-generator": () => import("./password-generator/index").then((m) => m.default),
  "pdf-toolbox": () => import("./pdf-toolbox/index").then((m) => m.default),
  "periodic-table": () => import("./periodic-table/index").then((m) => m.default),
  "photography-calculator": () => import("./photography-calculator/index").then((m) => m.default),
  pipelines: () => import("./pipelines/index").then((m) => m.default),
  "placeholder-image": () => import("./placeholder-image/index").then((m) => m.default),
  "pomodoro-timer": () => import("./pomodoro-timer/index").then((m) => m.default),
  "print-cost-calculator": () => import("./print-cost-calculator/index").then((m) => m.default),
  "promql-formatter": () => import("./promql-formatter/index").then((m) => m.default),
  "protobuf-decoder": () => import("./protobuf-decoder/index").then((m) => m.default),
  "qr-code-generator": () => import("./qr-code-generator/index").then((m) => m.default),
  "qr-code-scanner": () => import("./qr-code-scanner/index").then((m) => m.default),
  "qr-file-transfer": () => import("./qr-file-transfer/index").then((m) => m.default),
  "raidz-calculator": () => import("./raidz-calculator/index").then((m) => m.default),
  "random-picker": () => import("./random-picker/index").then((m) => m.default),
  "resistor-color-code-calculator": () =>
    import("./resistor-color-code-calculator/index").then((m) => m.default),
  "reverse-proxy-config-generator": () =>
    import("./reverse-proxy-config-generator/index").then((m) => m.default),
  "screen-recorder": () => import("./screen-recorder/index").then((m) => m.default),
  "screen-ruler": () => import("./screen-ruler/index").then((m) => m.default),
  "screenshot-annotator": () => import("./screenshot-annotator/index").then((m) => m.default),
  "screenshot-beautifier": () => import("./screenshot-beautifier/index").then((m) => m.default),
  "serial-terminal": () => import("./serial-terminal/index").then((m) => m.default),
  "smartctl-analyzer": () => import("./smartctl-analyzer/index").then((m) => m.default),
  "snowflake-decoder": () => import("./snowflake-decoder/index").then((m) => m.default),
  "speculation-rules-generator": () =>
    import("./speculation-rules-generator/index").then((m) => m.default),
  "sprite-sheet-packer": () => import("./sprite-sheet-packer/index").then((m) => m.default),
  "sql-formatter": () => import("./sql-formatter/index").then((m) => m.default),
  "sqlite-viewer": () => import("./sqlite-viewer/index").then((m) => m.default),
  "subnet-calculator": () => import("./subnet-calculator/index").then((m) => m.default),
  "subtitle-editor": () => import("./subtitle-editor/index").then((m) => m.default),
  "sunrise-sunset-calculator": () =>
    import("./sunrise-sunset-calculator/index").then((m) => m.default),
  "svg-optimizer": () => import("./svg-optimizer/index").then((m) => m.default),
  "systemd-unit-builder": () => import("./systemd-unit-builder/index").then((m) => m.default),
  "temporal-playground": () => import("./temporal-playground/index").then((m) => m.default),
  "terminal-qr-code": () => import("./terminal-qr-code/index").then((m) => m.default),
  "timezone-planner": () => import("./timezone-planner/index").then((m) => m.default),
  "tone-generator": () => import("./tone-generator/index").then((m) => m.default),
  "totp-generator": () => import("./totp-generator/index").then((m) => m.default),
  "tuner-metronome": () => import("./tuner-metronome/index").then((m) => m.default),
  "uf2-inspector": () => import("./uf2-inspector/index").then((m) => m.default),
  "unicode-picker": () => import("./unicode-picker/index").then((m) => m.default),
  "url-parser": () => import("./url-parser/index").then((m) => m.default),
  "urlpattern-tester": () => import("./urlpattern-tester/index").then((m) => m.default),
  "user-agent-parser": () => import("./user-agent-parser/index").then((m) => m.default),
  "uuid-generator": () => import("./uuid/index").then((m) => m.default),
  "video-converter": () => import("./video-converter/index").then((m) => m.default),
  "video-frame-extractor": () => import("./video-frame-extractor/index").then((m) => m.default),
  "video-to-gif": () => import("./video-to-gif/index").then((m) => m.default),
  "video-trimmer": () => import("./video-trimmer/index").then((m) => m.default),
  "wasm-feature-detector": () => import("./wasm-feature-detector/index").then((m) => m.default),
  "wasm-inspector": () => import("./wasm-inspector/index").then((m) => m.default),
  "webcam-mic-test": () => import("./webcam-mic-test/index").then((m) => m.default),
  "webrtc-tester": () => import("./webrtc-tester/index").then((m) => m.default),
  "week-number": () => import("./week-number/index").then((m) => m.default),
  "wikidata-cities-database": () =>
    import("./wikidata-cities-database/index").then((m) => m.default),
  "wire-gauge-calculator": () => import("./wire-gauge-calculator/index").then((m) => m.default),
  "wireguard-config-generator": () =>
    import("./wireguard-config-generator/index").then((m) => m.default),
  "cipher-tool": () => import("./cipher-tool/index").then((m) => m.default),
  "fancy-text-generator": () => import("./fancy-text-generator/index").then((m) => m.default),
  "lorem-ipsum-generator": () => import("./lorem-ipsum-generator/index").then((m) => m.default),
  "morse-code-translator": () => import("./morse-code-translator/index").then((m) => m.default),
  "nato-phonetic-alphabet": () => import("./nato-phonetic-alphabet/index").then((m) => m.default),
  "number-to-words": () => import("./number-to-words/index").then((m) => m.default),
  "roman-numeral-converter": () => import("./roman-numeral-converter/index").then((m) => m.default),
  "glob-pattern-tester": () => import("./glob-pattern-tester/index").then((m) => m.default),
  "jsonpath-query": () => import("./jsonpath-query/index").then((m) => m.default),
  "regex-tester": () => import("./regex-tester/index").then((m) => m.default),
  "semver-range-tester": () => import("./semver-range-tester/index").then((m) => m.default),
  "unified-diff-patch-applier": () =>
    import("./unified-diff-patch-applier/index").then((m) => m.default),
  "xpath-css-selector-tester": () =>
    import("./xpath-css-selector-tester/index").then((m) => m.default),
  "hmac-generator": () => import("./hmac-generator/index").then((m) => m.default),
  "jwt-generator": () => import("./jwt-generator/index").then((m) => m.default),
  "password-strength-checker": () =>
    import("./password-strength-checker/index").then((m) => m.default),
  "self-signed-certificate-generator": () =>
    import("./self-signed-certificate-generator/index").then((m) => m.default),
  "ssh-key-generator": () => import("./ssh-key-generator/index").then((m) => m.default),
  "text-encrypter": () => import("./text-encrypter/index").then((m) => m.default),
  "archive-viewer": () => import("./archive-viewer/index").then((m) => m.default),
  "log-file-analyzer": () => import("./log-file-analyzer/index").then((m) => m.default),
  "mp3-tag-editor": () => import("./mp3-tag-editor/index").then((m) => m.default),
  "torrent-file-inspector": () => import("./torrent-file-inspector/index").then((m) => m.default),
  "xlsx-viewer": () => import("./xlsx-viewer/index").then((m) => m.default),
  "antenna-length-calculator": () =>
    import("./antenna-length-calculator/index").then((m) => m.default),
  "coax-cable-loss": () => import("./coax-cable-loss/index").then((m) => m.default),
  "dbm-watts-volts": () => import("./dbm-watts-volts/index").then((m) => m.default),
  "fresnel-zone": () => import("./fresnel-zone/index").then((m) => m.default),
  "lc-resonance": () => import("./lc-resonance/index").then((m) => m.default),
  "path-loss-link-budget": () => import("./path-loss-link-budget/index").then((m) => m.default),
  "vswr-return-loss": () => import("./vswr-return-loss/index").then((m) => m.default),
  "wavelength-frequency": () => import("./wavelength-frequency/index").then((m) => m.default),
  "555-timer-calculator": () => import("./555-timer-calculator/index").then((m) => m.default),
  "capacitor-code-decoder": () => import("./capacitor-code-decoder/index").then((m) => m.default),
  "led-resistor-calculator": () => import("./led-resistor-calculator/index").then((m) => m.default),
  "pcb-trace-width": () => import("./pcb-trace-width/index").then((m) => m.default),
  "voltage-divider": () => import("./voltage-divider/index").then((m) => m.default),
  "box-shadow-generator": () => import("./box-shadow-generator/index").then((m) => m.default),
  "clip-path-generator": () => import("./clip-path-generator/index").then((m) => m.default),
  "css-gradient-generator": () => import("./css-gradient-generator/index").then((m) => m.default),
  "css-keyframes-builder": () => import("./css-keyframes-builder/index").then((m) => m.default),
  "cubic-bezier-easing-editor": () =>
    import("./cubic-bezier-easing-editor/index").then((m) => m.default),
  "fluid-clamp-calculator": () => import("./fluid-clamp-calculator/index").then((m) => m.default),
  "color-contrast-checker": () => import("./color-contrast-checker/index").then((m) => m.default),
  "exif-viewer-and-stripper": () =>
    import("./exif-viewer-and-stripper/index").then((m) => m.default),
  "image-color-palette-extractor": () =>
    import("./image-color-palette-extractor/index").then((m) => m.default),
  "image-to-data-url": () => import("./image-to-data-url/index").then((m) => m.default),
  "image-watermark": () => import("./image-watermark/index").then((m) => m.default),
  "meme-generator": () => import("./meme-generator/index").then((m) => m.default),
  "buffer-calculator": () => import("./buffer-calculator/index").then((m) => m.default),
  "chemical-equation-balancer": () =>
    import("./chemical-equation-balancer/index").then((m) => m.default),
  "dilution-calculator": () => import("./dilution-calculator/index").then((m) => m.default),
  "electron-configuration": () => import("./electron-configuration/index").then((m) => m.default),
  "empirical-formula-calculator": () =>
    import("./empirical-formula-calculator/index").then((m) => m.default),
  "half-life-decay": () => import("./half-life-decay/index").then((m) => m.default),
  "molarity-solution-prep": () => import("./molarity-solution-prep/index").then((m) => m.default),
  "ph-poh-calculator": () => import("./ph-poh-calculator/index").then((m) => m.default),
  "stoichiometry-calculator": () =>
    import("./stoichiometry-calculator/index").then((m) => m.default),
  "julian-date-converter": () => import("./julian-date-converter/index").then((m) => m.default),
  "magnitude-calculator": () => import("./magnitude-calculator/index").then((m) => m.default),
};

export function getTool(slug: string): ToolMeta | undefined {
  return tools.find((t) => t.slug === slug);
}

export const categories = (): string[] => [...new Set(tools.map((t) => t.category))];
