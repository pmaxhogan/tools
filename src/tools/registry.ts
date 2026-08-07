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
import type { ToolMeta } from './types';
import { meta as audioSpectrogram } from './audio-spectrogram/meta';
import { meta as audioTranscriber } from './audio-transcriber/meta';
import { meta as audioTrimmer } from './audio-trimmer/meta';
import { meta as backgroundRemover } from './background-remover/meta';
import { meta as baseConverter } from './base-converter/meta';
import { meta as caseConverter } from './case-converter/meta';
import { meta as characterCounter } from './character-counter/meta';
import { meta as clipboardInspector } from './clipboard-inspector/meta';
import { meta as cronParser } from './cron-parser/meta';
import { meta as csvViewer } from './csv-viewer/meta';
import { meta as dataFormatConverter } from './data-format-converter/meta';
import { meta as decodeAnything } from './decode-anything/meta';
import { meta as diffChecker } from './diff-checker/meta';
import { meta as discordTimestamp } from './discord-timestamp/meta';
import { meta as dmarcReportViewer } from './dmarc-report-viewer/meta';
import { meta as discordVideoCompressor } from './discord-video-compressor/meta';
import { meta as duplicateFinder } from './duplicate-finder/meta';
import { meta as durationCalculator } from './duration-calculator/meta';
import { meta as emailHeaderAnalyzer } from './email-header-analyzer/meta';
import { meta as epochConverter } from './epoch-converter/meta';
import { meta as escapeUnescape } from './escape-unescape/meta';
import { meta as factorioBlueprintDecoder } from './factorio-blueprint-decoder/meta';
import { meta as fakeDataGenerator } from './fake-data-generator/meta';
import { meta as faviconGenerator } from './favicon-generator/meta';
import { meta as figlet } from './figlet/meta';
import { meta as fileTypeIdentifier } from './file-type-identifier/meta';
import { meta as folderDiff } from './folder-diff/meta';
import { meta as gamCommandBuilder } from './gam-command-builder/meta';
import { meta as gifEditor } from './gif-editor/meta';
import { meta as gzipCompressionTest } from './gzip-compression-test/meta';
import { meta as harViewer } from './har-viewer/meta';
import { meta as hashGenerator } from './hash-generator/meta';
import { meta as hidReportExplorer } from './hid-report-explorer/meta';
import { meta as htmlToMarkdown } from './html-to-markdown/meta';
import { meta as imageRedactor } from './image-redactor/meta';
import { meta as imageToText } from './image-to-text/meta';
import { meta as imageToolbox } from './image-toolbox/meta';
import { meta as invisibleCharacterDetector } from './invisible-character-detector/meta';
import { meta as jsonFormatter } from './json-formatter/meta';
import { meta as jsonSchemaValidator } from './json-schema-validator/meta';
import { meta as jsonToTypescript } from './json-to-typescript/meta';
import { meta as keycode } from './keycode/meta';
import { meta as lineSorter } from './line-sorter/meta';
import { meta as mojibakeFixer } from './mojibake-fixer/meta';
import { meta as oauthScopeDecoder } from './oauth-scope-decoder/meta';
import { meta as oryxLayoutDiff } from './oryx-layout-diff/meta';
import { meta as passwordGenerator } from './password-generator/meta';
import { meta as pdfToolbox } from './pdf-toolbox/meta';
import { meta as placeholderImage } from './placeholder-image/meta';
import { meta as qrCodeGenerator } from './qr-code-generator/meta';
import { meta as randomPicker } from './random-picker/meta';
import { meta as serialTerminal } from './serial-terminal/meta';
import { meta as smartctlAnalyzer } from './smartctl-analyzer/meta';
import { meta as snowflakeDecoder } from './snowflake-decoder/meta';
import { meta as sqlFormatter } from './sql-formatter/meta';
import { meta as sqliteViewer } from './sqlite-viewer/meta';
import { meta as subtitleEditor } from './subtitle-editor/meta';
import { meta as svgOptimizer } from './svg-optimizer/meta';
import { meta as unicodePicker } from './unicode-picker/meta';
import { meta as urlParser } from './url-parser/meta';
import { meta as userAgentParser } from './user-agent-parser/meta';
import { meta as uuid } from './uuid/meta';
import { meta as videoConverter } from './video-converter/meta';
import { meta as videoFrameExtractor } from './video-frame-extractor/meta';
import { meta as videoToGif } from './video-to-gif/meta';
import { meta as videoTrimmer } from './video-trimmer/meta';
import { meta as weekNumber } from './week-number/meta';
import { meta as wireguardConfigGenerator } from './wireguard-config-generator/meta';

export const tools: ToolMeta[] = [
  audioSpectrogram,
  audioTranscriber,
  audioTrimmer,
  backgroundRemover,
  baseConverter,
  caseConverter,
  characterCounter,
  clipboardInspector,
  cronParser,
  csvViewer,
  dataFormatConverter,
  decodeAnything,
  diffChecker,
  discordTimestamp,
  discordVideoCompressor,
  dmarcReportViewer,
  duplicateFinder,
  durationCalculator,
  emailHeaderAnalyzer,
  epochConverter,
  escapeUnescape,
  factorioBlueprintDecoder,
  fakeDataGenerator,
  faviconGenerator,
  figlet,
  fileTypeIdentifier,
  folderDiff,
  gamCommandBuilder,
  gifEditor,
  gzipCompressionTest,
  harViewer,
  hashGenerator,
  hidReportExplorer,
  htmlToMarkdown,
  imageRedactor,
  imageToText,
  imageToolbox,
  invisibleCharacterDetector,
  jsonFormatter,
  jsonSchemaValidator,
  jsonToTypescript,
  keycode,
  lineSorter,
  mojibakeFixer,
  oauthScopeDecoder,
  oryxLayoutDiff,
  passwordGenerator,
  pdfToolbox,
  placeholderImage,
  qrCodeGenerator,
  randomPicker,
  serialTerminal,
  smartctlAnalyzer,
  snowflakeDecoder,
  sqlFormatter,
  sqliteViewer,
  subtitleEditor,
  svgOptimizer,
  unicodePicker,
  urlParser,
  userAgentParser,
  uuid,
  videoConverter,
  videoFrameExtractor,
  videoToGif,
  videoTrimmer,
  weekNumber,
  wireguardConfigGenerator,
];

/** Lazy loaders for tool logic, keyed by URL slug. */
export const loaders: Record<string, () => Promise<unknown>> = {
  'audio-spectrogram': () => import('./audio-spectrogram/index').then((m) => m.default),
  'audio-transcriber': () => import('./audio-transcriber/index').then((m) => m.default),
  'audio-trimmer': () => import('./audio-trimmer/index').then((m) => m.default),
  'background-remover': () => import('./background-remover/index').then((m) => m.default),
  'base-converter': () => import('./base-converter/index').then((m) => m.default),
  'case-converter': () => import('./case-converter/index').then((m) => m.default),
  'character-counter': () => import('./character-counter/index').then((m) => m.default),
  'clipboard-inspector': () => import('./clipboard-inspector/index').then((m) => m.default),
  'cron-parser': () => import('./cron-parser/index').then((m) => m.default),
  'csv-viewer': () => import('./csv-viewer/index').then((m) => m.default),
  'data-format-converter': () => import('./data-format-converter/index').then((m) => m.default),
  'decode-anything': () => import('./decode-anything/index').then((m) => m.default),
  'diff-checker': () => import('./diff-checker/index').then((m) => m.default),
  'discord-timestamp': () => import('./discord-timestamp/index').then((m) => m.default),
  'discord-video-compressor': () =>
    import('./discord-video-compressor/index').then((m) => m.default),
  'dmarc-report-viewer': () => import('./dmarc-report-viewer/index').then((m) => m.default),
  'duplicate-finder': () => import('./duplicate-finder/index').then((m) => m.default),
  'duration-calculator': () => import('./duration-calculator/index').then((m) => m.default),
  'email-header-analyzer': () => import('./email-header-analyzer/index').then((m) => m.default),
  'epoch-converter': () => import('./epoch-converter/index').then((m) => m.default),
  'escape-unescape': () => import('./escape-unescape/index').then((m) => m.default),
  'factorio-blueprint-decoder': () =>
    import('./factorio-blueprint-decoder/index').then((m) => m.default),
  'fake-data-generator': () => import('./fake-data-generator/index').then((m) => m.default),
  'favicon-generator': () => import('./favicon-generator/index').then((m) => m.default),
  figlet: () => import('./figlet/index').then((m) => m.default),
  'file-type-identifier': () => import('./file-type-identifier/index').then((m) => m.default),
  'folder-diff': () => import('./folder-diff/index').then((m) => m.default),
  'gam-command-builder': () => import('./gam-command-builder/index').then((m) => m.default),
  'gif-editor': () => import('./gif-editor/index').then((m) => m.default),
  'gzip-compression-test': () => import('./gzip-compression-test/index').then((m) => m.default),
  'har-viewer': () => import('./har-viewer/index').then((m) => m.default),
  'hash-generator': () => import('./hash-generator/index').then((m) => m.default),
  'hid-report-explorer': () => import('./hid-report-explorer/index').then((m) => m.default),
  'html-to-markdown': () => import('./html-to-markdown/index').then((m) => m.default),
  'image-redactor': () => import('./image-redactor/index').then((m) => m.default),
  'image-to-text': () => import('./image-to-text/index').then((m) => m.default),
  'image-toolbox': () => import('./image-toolbox/index').then((m) => m.default),
  'invisible-character-detector': () =>
    import('./invisible-character-detector/index').then((m) => m.default),
  'json-formatter': () => import('./json-formatter/index').then((m) => m.default),
  'json-schema-validator': () => import('./json-schema-validator/index').then((m) => m.default),
  'json-to-typescript': () => import('./json-to-typescript/index').then((m) => m.default),
  keycode: () => import('./keycode/index').then((m) => m.default),
  'line-sorter': () => import('./line-sorter/index').then((m) => m.default),
  'mojibake-fixer': () => import('./mojibake-fixer/index').then((m) => m.default),
  'oauth-scope-decoder': () => import('./oauth-scope-decoder/index').then((m) => m.default),
  'oryx-layout-diff': () => import('./oryx-layout-diff/index').then((m) => m.default),
  'password-generator': () => import('./password-generator/index').then((m) => m.default),
  'pdf-toolbox': () => import('./pdf-toolbox/index').then((m) => m.default),
  'placeholder-image': () => import('./placeholder-image/index').then((m) => m.default),
  'qr-code-generator': () => import('./qr-code-generator/index').then((m) => m.default),
  'random-picker': () => import('./random-picker/index').then((m) => m.default),
  'serial-terminal': () => import('./serial-terminal/index').then((m) => m.default),
  'smartctl-analyzer': () => import('./smartctl-analyzer/index').then((m) => m.default),
  'snowflake-decoder': () => import('./snowflake-decoder/index').then((m) => m.default),
  'sql-formatter': () => import('./sql-formatter/index').then((m) => m.default),
  'sqlite-viewer': () => import('./sqlite-viewer/index').then((m) => m.default),
  'subtitle-editor': () => import('./subtitle-editor/index').then((m) => m.default),
  'svg-optimizer': () => import('./svg-optimizer/index').then((m) => m.default),
  'unicode-picker': () => import('./unicode-picker/index').then((m) => m.default),
  'url-parser': () => import('./url-parser/index').then((m) => m.default),
  'user-agent-parser': () => import('./user-agent-parser/index').then((m) => m.default),
  'uuid-generator': () => import('./uuid/index').then((m) => m.default),
  'video-converter': () => import('./video-converter/index').then((m) => m.default),
  'video-frame-extractor': () =>
    import('./video-frame-extractor/index').then((m) => m.default),
  'video-to-gif': () => import('./video-to-gif/index').then((m) => m.default),
  'video-trimmer': () => import('./video-trimmer/index').then((m) => m.default),
  'week-number': () => import('./week-number/index').then((m) => m.default),
  'wireguard-config-generator': () =>
    import('./wireguard-config-generator/index').then((m) => m.default),
};

export function getTool(slug: string): ToolMeta | undefined {
  return tools.find((t) => t.slug === slug);
}

export const categories = (): string[] => [...new Set(tools.map((t) => t.category))];
