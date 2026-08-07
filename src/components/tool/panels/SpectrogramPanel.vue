<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef, watch } from 'vue';
import { X } from 'lucide-vue-next';
import { ToolError, type ToolMeta } from '@/tools/types';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

/**
 * Bespoke panel for the Spectrogram Viewer.
 *
 * The generic ToolShell cannot render this tool: the output is a picture with
 * two axes, a hover readout, and a playhead, none of which fit a text or
 * record shape. The DSP still lives in the pure logic layer, so this file
 * only decodes audio, drives the analysis in chunks, and paints canvases.
 *
 * Nothing touches the DOM or the audio stack until a file arrives, so the
 * component renders inert on the server.
 */
defineProps<{ meta: ToolMeta }>();

type SpecLogic = typeof import('@/tools/audio-spectrogram/index');

/** The FFT module loads on the first file rather than on page load. */
let logicPromise: Promise<SpecLogic> | null = null;
function loadLogic(): Promise<SpecLogic> {
  logicPromise ??= import('@/tools/audio-spectrogram/index');
  return logicPromise;
}

/* ---------------------------------------------------------------- */
/* constants                                                         */
/* ---------------------------------------------------------------- */

/** Honest ceiling: past this the analysis stops and the panel says so. */
const MAX_ANALYSIS_SECONDS = 600;
/** Column budget handed to the logic layer. Two screens wide is plenty. */
const MAX_COLUMNS = 2000;
/** Bottom of the logarithmic frequency axis. Below this is mostly rumble. */
const LOG_MIN_HZ = 20;

const GUTTER_LEFT = 56;
const GUTTER_RIGHT = 12;
/** Top strip holding the decibel legend. */
const TOP_H = 22;
const WAVE_H = 64;
const GAP = 10;
const SPEC_H = 320;
/** Bottom strip holding the time ticks. */
const AXIS_H = 26;

/* ---------------------------------------------------------------- */
/* state                                                             */
/* ---------------------------------------------------------------- */

const logic = shallowRef<SpecLogic | null>(null);

const fileName = ref('');
const fileSize = ref(0);
const error = ref<{ message: string; fix?: string } | null>(null);
const dragging = ref(false);
const fileInput = ref<HTMLInputElement>();

const audioBuffer = shallowRef<AudioBuffer | null>(null);
const mono = shallowRef<Float32Array | null>(null);
const sampleRate = ref(48000);
const fullDuration = ref(0);
const analyzedDuration = ref(0);
const channelCount = ref(0);

const columns = shallowRef<Float32Array[]>([]);
const freqBins = ref(1024);
const peaks = shallowRef<{ min: Float32Array; max: Float32Array } | null>(null);

const stage = ref<'idle' | 'decoding' | 'analyzing' | 'ready'>('idle');
const progress = ref(0);

const fftSize = ref('2048');
const colors = ref('viridis');
const axisScale = ref('linear');
const showWaveform = ref(true);

/**
 * `x` and `y` are canvas coordinates (what the crosshair is drawn in);
 * `px` and `py` are the same point in laid-out CSS pixels, which is what the
 * absolutely positioned readout chip needs. The two differ whenever the
 * canvas is displayed at anything other than its logical width.
 */
const hover = ref<{
  x: number;
  y: number;
  px: number;
  py: number;
  time: number;
  freq: number;
  db: number;
} | null>(null);
const playing = ref(false);
const playhead = ref<number | null>(null);

const wrapper = ref<HTMLElement>();
const canvasEl = ref<HTMLCanvasElement>();
const cssWidth = ref(880);
const renderScale = ref(1);

const truncated = computed(() => fullDuration.value > analyzedDuration.value + 0.01);
const hasAudio = computed(() => mono.value !== null);
const ready = computed(() => stage.value === 'ready' && columns.value.length > 0);

const specTop = computed(() => TOP_H + (showWaveform.value ? WAVE_H + GAP : 0));
const canvasHeight = computed(() => specTop.value + SPEC_H + AXIS_H);
const plotWidth = computed(() => Math.max(160, Math.round(cssWidth.value - GUTTER_LEFT - GUTTER_RIGHT)));

/* ---------------------------------------------------------------- */
/* small helpers                                                     */
/* ---------------------------------------------------------------- */

function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function baseName(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name || 'audio';
}

function clamp(value: number, low: number, high: number): number {
  return value < low ? low : value > high ? high : value;
}

function toToolError(e: unknown): { message: string; fix?: string } {
  return e instanceof ToolError
    ? { message: e.message, fix: e.fix }
    : { message: e instanceof Error ? e.message : String(e) };
}

function triggerDownload(url: string, name: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function ascii(bytes: Uint8Array, at: number, length: number): string {
  let out = '';
  for (let i = at; i < at + length && i < bytes.length; i++) out += String.fromCharCode(bytes[i]!);
  return out;
}

/**
 * Name the container from its magic bytes so a decode failure can say what
 * the file actually is instead of blaming the user for a "bad file".
 */
function sniffAudioFormat(bytes: Uint8Array): string {
  if (bytes.length < 12) return '';
  if (ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WAVE') return 'WAV';
  if (ascii(bytes, 0, 4) === 'fLaC') return 'FLAC';
  if (ascii(bytes, 0, 4) === 'OggS') return 'Ogg';
  if (ascii(bytes, 0, 4) === 'FORM' && ascii(bytes, 8, 4).startsWith('AIF')) return 'AIFF';
  if (ascii(bytes, 4, 4) === 'ftyp') return 'MP4 or M4A';
  if (ascii(bytes, 0, 3) === 'ID3') return 'MP3';
  if (bytes[0] === 0xff && (bytes[1]! & 0xe0) === 0xe0) return 'MP3';
  if (ascii(bytes, 0, 4) === 'caff') return 'CAF';
  if (ascii(bytes, 0, 4) === 'MThd') return 'MIDI';
  if (bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
    return 'WebM or Matroska';
  }
  if (ascii(bytes, 0, 4) === 'wvpk') return 'WavPack';
  if (ascii(bytes, 0, 3) === 'MAC') return 'APE';
  return '';
}

/* ---------------------------------------------------------------- */
/* audio context and playback                                        */
/* ---------------------------------------------------------------- */

let audioCtx: AudioContext | null = null;
let source: AudioBufferSourceNode | null = null;
let rafId = 0;
let playFromCtxTime = 0;
let playFromOffset = 0;

function ensureAudioContext(): AudioContext {
  audioCtx ??= new AudioContext();
  return audioCtx;
}

function stopPlayback() {
  if (source) {
    source.onended = null;
    try {
      source.stop();
    } catch {
      // Already stopped: nothing to undo.
    }
    source.disconnect();
    source = null;
  }
  if (rafId) cancelAnimationFrame(rafId);
  rafId = 0;
  playing.value = false;
  playhead.value = null;
  draw();
}

function followPlayhead() {
  if (!playing.value || !audioCtx) return;
  const at = playFromOffset + (audioCtx.currentTime - playFromCtxTime);
  if (at >= analyzedDuration.value) {
    stopPlayback();
    return;
  }
  playhead.value = at;
  draw();
  rafId = requestAnimationFrame(followPlayhead);
}

async function playFrom(time: number) {
  const buffer = audioBuffer.value;
  if (!buffer) return;
  stopPlayback();
  try {
    const ac = ensureAudioContext();
    // A context created before any gesture starts suspended, which would play
    // silence, so it is resumed here inside the click handler.
    if (ac.state === 'suspended') await ac.resume();
    const node = ac.createBufferSource();
    node.buffer = buffer;
    node.connect(ac.destination);
    const start = clamp(time, 0, Math.max(0, analyzedDuration.value - 0.01));
    node.onended = () => {
      if (source === node) stopPlayback();
    };
    node.start(0, start, Math.max(0.01, analyzedDuration.value - start));
    source = node;
    playFromCtxTime = ac.currentTime;
    playFromOffset = start;
    playing.value = true;
    playhead.value = start;
    rafId = requestAnimationFrame(followPlayhead);
  } catch (e) {
    error.value = toToolError(e);
  }
}

/* ---------------------------------------------------------------- */
/* loading and analysis                                              */
/* ---------------------------------------------------------------- */

/** Bumped on every new file or setting change so stale chunks abandon quietly. */
let analysisToken = 0;

function resetAudio() {
  stopPlayback();
  specImage = null;
  audioBuffer.value = null;
  mono.value = null;
  columns.value = [];
  peaks.value = null;
  hover.value = null;
  fullDuration.value = 0;
  analyzedDuration.value = 0;
  channelCount.value = 0;
  progress.value = 0;
  stage.value = 'idle';
}

/** Average every channel into one track: a spectrogram has a single Y axis. */
function toMono(buffer: AudioBuffer, maxSamples: number): Float32Array {
  const length = Math.min(buffer.length, maxSamples);
  const out = new Float32Array(length);
  const channels = buffer.numberOfChannels;
  for (let c = 0; c < channels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < length; i++) out[i] = out[i]! + data[i]!;
  }
  if (channels > 1) {
    for (let i = 0; i < length; i++) out[i] = out[i]! / channels;
  }
  return out;
}

async function readFile(file: File) {
  analysisToken += 1;
  resetAudio();
  error.value = null;
  fileName.value = file.name;
  fileSize.value = file.size;
  stage.value = 'decoding';

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch (e) {
    stage.value = 'idle';
    error.value = toToolError(e);
    return;
  }

  try {
    logic.value ??= await loadLogic();
    const ac = ensureAudioContext();
    // decodeAudioData detaches the buffer it is handed, so it gets a copy and
    // the sniffed bytes stay readable for the error path below.
    const buffer = await ac.decodeAudioData(bytes.slice().buffer as ArrayBuffer);
    audioBuffer.value = buffer;
    sampleRate.value = buffer.sampleRate;
    fullDuration.value = buffer.duration;
    channelCount.value = buffer.numberOfChannels;
    const cap = Math.floor(MAX_ANALYSIS_SECONDS * buffer.sampleRate);
    const samples = toMono(buffer, cap);
    mono.value = samples;
    analyzedDuration.value = samples.length / buffer.sampleRate;
    await analyze();
  } catch (e) {
    stage.value = 'idle';
    const format = sniffAudioFormat(bytes);
    if (e instanceof ToolError) {
      error.value = toToolError(e);
    } else {
      error.value = {
        message: format
          ? `This browser could not decode this ${format} file as audio.`
          : 'This browser could not decode this file as audio, and its first bytes do not match any audio container this tool recognizes.',
        fix: format
          ? 'The container is recognized but the codec inside it is not supported here. Convert it to WAV or MP3 and try again.'
          : 'Try a WAV, MP3, FLAC, OGG, or M4A file. Video containers work only when the browser can decode their audio track.',
      };
    }
  }
}

async function analyze() {
  const samples = mono.value;
  const mod = logic.value;
  if (!samples || !mod) return;
  const token = ++analysisToken;
  stage.value = 'analyzing';
  progress.value = 0;
  columns.value = [];

  const size = Number(fftSize.value);
  const options = { fftSize: size as 1024 | 2048 | 4096, hop: size / 4, maxColumns: MAX_COLUMNS };

  try {
    const plan = mod.planSpectrogram(samples.length, options);
    // Chunk by frames, not columns: on a long file one column can fold in
    // dozens of frames, and a fixed column chunk would stall the main thread.
    const chunk = Math.max(1, Math.floor(256 / plan.group));
    const out: Float32Array[] = [];
    for (let c = 0; c < plan.columnCount; c += chunk) {
      if (token !== analysisToken) return;
      const slice = mod.computeSpectrogramColumns(samples, options, c, chunk);
      for (const column of slice) out.push(column);
      progress.value = Math.min(99, Math.round(((c + chunk) / plan.columnCount) * 100));
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (token !== analysisToken) return;
    columns.value = out;
    freqBins.value = plan.freqBins;
    progress.value = 100;
    stage.value = 'ready';
    rebuildPeaks();
    renderSpecImage();
    draw();
  } catch (e) {
    if (token !== analysisToken) return;
    stage.value = 'idle';
    error.value = toToolError(e);
  }
}

function rebuildPeaks() {
  const samples = mono.value;
  const mod = logic.value;
  if (!samples || !mod) return;
  peaks.value = mod.computeWaveformPeaks(samples, plotWidth.value);
}

function onDrop(e: DragEvent) {
  dragging.value = false;
  const file = e.dataTransfer?.files[0];
  if (file) readFile(file);
}

function onPickFile(e: Event) {
  const picker = e.target as HTMLInputElement;
  const file = picker.files?.[0];
  if (!file) return;
  readFile(file).then(() => {
    // Reset so picking the same file again still fires a change event.
    picker.value = '';
  });
}

function clearFile() {
  analysisToken += 1;
  resetAudio();
  fileName.value = '';
  fileSize.value = 0;
  error.value = null;
  if (fileInput.value) fileInput.value.value = '';
  draw();
}

/* ---------------------------------------------------------------- */
/* frequency mapping                                                 */
/* ---------------------------------------------------------------- */

const nyquist = computed(() => sampleRate.value / 2);
/** Log axis never starts below 20 Hz, and never above a quarter of Nyquist. */
const logBottom = computed(() => Math.min(LOG_MIN_HZ, nyquist.value / 4));

/** Frequency at a fraction of the spectrogram height, 0 at the top. */
function freqAtFraction(fraction: number): number {
  const f = clamp(fraction, 0, 1);
  if (axisScale.value === 'log') {
    const low = logBottom.value;
    return low * Math.pow(nyquist.value / low, 1 - f);
  }
  return nyquist.value * (1 - f);
}

/** Inverse of freqAtFraction: where a frequency sits down the plot. */
function fractionAtFreq(hz: number): number {
  if (axisScale.value === 'log') {
    const low = logBottom.value;
    const value = clamp(hz, low, nyquist.value);
    return 1 - Math.log(value / low) / Math.log(nyquist.value / low);
  }
  return 1 - clamp(hz, 0, nyquist.value) / nyquist.value;
}

/* ---------------------------------------------------------------- */
/* spectrogram image                                                 */
/* ---------------------------------------------------------------- */

let specImage: HTMLCanvasElement | null = null;

/** 256 entry color ramp so the pixel loop never calls into the colormap. */
function buildColorLut(mod: SpecLogic): Uint8Array {
  const lut = new Uint8Array(256 * 3);
  const scheme = colors.value as 'viridis' | 'magma' | 'gray';
  for (let i = 0; i < 256; i++) {
    const [r, g, b] = mod.dbToColor(mod.DB_FLOOR + (-mod.DB_FLOOR * i) / 255, scheme);
    lut[i * 3] = r;
    lut[i * 3 + 1] = g;
    lut[i * 3 + 2] = b;
  }
  return lut;
}

/**
 * Paint the columns into an offscreen bitmap once, so hover, playback, and
 * axis redraws are a single drawImage rather than a million pixel writes.
 *
 * The Y remap happens here: each output row covers a frequency band, and the
 * loudest bin inside that band wins so a thin loud line survives the squeeze
 * that the logarithmic axis puts on the top of the spectrum.
 */
function renderSpecImage() {
  const mod = logic.value;
  const cols = columns.value;
  if (!mod || cols.length === 0) {
    specImage = null;
    return;
  }
  const scale = renderScale.value;
  const w = Math.max(1, Math.round(plotWidth.value * scale));
  const h = Math.max(1, Math.round(SPEC_H * scale));

  specImage ??= document.createElement('canvas');
  specImage.width = w;
  specImage.height = h;
  const ctx = specImage.getContext('2d');
  if (!ctx) return;

  const bins = freqBins.value;
  const image = ctx.createImageData(w, h);
  const data = image.data;
  const lut = buildColorLut(mod);
  const floor = mod.DB_FLOOR;
  const span = -floor;

  // Bin range per output row, computed once and reused for every column.
  const rowLo = new Int32Array(h);
  const rowHi = new Int32Array(h);
  const perBin = nyquist.value / bins;
  for (let y = 0; y < h; y++) {
    const top = freqAtFraction(y / h);
    const bottom = freqAtFraction((y + 1) / h);
    let lo = Math.floor(bottom / perBin);
    let hi = Math.ceil(top / perBin);
    lo = clamp(lo, 0, bins - 1);
    hi = clamp(hi, lo + 1, bins);
    rowLo[y] = lo;
    rowHi[y] = hi;
  }

  const pooled = new Float32Array(bins);
  for (let x = 0; x < w; x++) {
    const from = Math.min(cols.length - 1, Math.floor((x * cols.length) / w));
    const to = Math.max(from + 1, Math.min(cols.length, Math.floor(((x + 1) * cols.length) / w)));
    pooled.set(cols[from]!);
    for (let c = from + 1; c < to; c++) {
      const column = cols[c]!;
      for (let k = 0; k < bins; k++) if (column[k]! > pooled[k]!) pooled[k] = column[k]!;
    }
    for (let y = 0; y < h; y++) {
      let db = floor;
      const hi = rowHi[y]!;
      for (let k = rowLo[y]!; k < hi; k++) if (pooled[k]! > db) db = pooled[k]!;
      const index = clamp(Math.round(((db - floor) / span) * 255), 0, 255) * 3;
      const at = (y * w + x) * 4;
      data[at] = lut[index]!;
      data[at + 1] = lut[index + 1]!;
      data[at + 2] = lut[index + 2]!;
      data[at + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
}

/* ---------------------------------------------------------------- */
/* drawing                                                           */
/* ---------------------------------------------------------------- */

interface Theme {
  surface: string;
  text: string;
  muted: string;
  border: string;
  accent: string;
  well: string;
}

function readTheme(el: HTMLElement): Theme {
  const style = getComputedStyle(el);
  const pick = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback;
  return {
    surface: pick('--card', '#ffffff'),
    text: pick('--foreground', '#1b1917'),
    muted: pick('--muted-foreground', '#79726b'),
    border: pick('--border', '#e7e2da'),
    accent: pick('--primary', '#5b4bd6'),
    well: pick('--secondary', '#f0ede8'),
  };
}

const TIME_STEPS = [0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
const LINEAR_FREQ_STEPS = [50, 100, 200, 500, 1000, 2000, 2500, 5000, 10000];
const LOG_FREQ_TICKS = [20, 30, 50, 100, 200, 300, 500, 1000, 2000, 3000, 5000, 10000, 20000];

function pickTimeStep(duration: number, maxTicks: number): number {
  for (const step of TIME_STEPS) if (duration / step <= maxTicks) return step;
  return TIME_STEPS[TIME_STEPS.length - 1]!;
}

function freqTicks(): number[] {
  const top = nyquist.value;
  if (axisScale.value === 'log') {
    const out: number[] = [];
    let lastY = Number.POSITIVE_INFINITY;
    for (let i = LOG_FREQ_TICKS.length - 1; i >= 0; i--) {
      const hz = LOG_FREQ_TICKS[i]!;
      if (hz > top || hz < logBottom.value) continue;
      const y = fractionAtFreq(hz) * SPEC_H;
      // Decades crowd together at the bottom of a log axis, so drop any tick
      // that would collide with the one already placed.
      if (Math.abs(y - lastY) < 22) continue;
      out.push(hz);
      lastY = y;
    }
    return out;
  }
  const maxTicks = Math.max(3, Math.floor(SPEC_H / 46));
  let step = LINEAR_FREQ_STEPS[LINEAR_FREQ_STEPS.length - 1]!;
  for (const candidate of LINEAR_FREQ_STEPS) {
    if (top / candidate <= maxTicks) {
      step = candidate;
      break;
    }
  }
  const out: number[] = [];
  for (let hz = 0; hz <= top + 1; hz += step) out.push(hz);
  return out;
}

/**
 * Paint the whole figure: legend, waveform strip, spectrogram, both axes, and
 * optionally the crosshair and playhead. The export path calls this with the
 * overlays turned off, so the PNG is the picture without the cursor in it.
 */
function drawAll(ctx: CanvasRenderingContext2D, theme: Theme, overlays: boolean) {
  const width = cssWidth.value;
  const height = canvasHeight.value;
  const plotW = plotWidth.value;
  const top = specTop.value;
  const duration = analyzedDuration.value;

  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = theme.surface;
  ctx.fillRect(0, 0, width, height);
  ctx.textBaseline = 'middle';
  ctx.font =
    '11px "Geist Mono", ui-monospace, "Cascadia Code", "Source Code Pro", monospace';

  const mod = logic.value;

  // Designed empty state: axes for a file that is not loaded would be a lie.
  if (!hasAudio.value) {
    ctx.fillStyle = theme.well;
    ctx.fillRect(GUTTER_LEFT, TOP_H, plotW, height - TOP_H - AXIS_H);
    ctx.fillStyle = theme.muted;
    ctx.textAlign = 'center';
    ctx.font = '13px "Geist", ui-sans-serif, system-ui, sans-serif';
    ctx.fillText(
      'Drop an audio file to see its waveform and spectrogram',
      GUTTER_LEFT + plotW / 2,
      TOP_H + (height - TOP_H - AXIS_H) / 2,
    );
    return;
  }

  // Decibel legend, right aligned above the plot.
  if (mod) {
    const rampW = 96;
    const rampX = GUTTER_LEFT + plotW - rampW;
    const rampY = 6;
    const rampH = 9;
    for (let i = 0; i < rampW; i++) {
      const [r, g, b] = mod.dbToColor(
        mod.DB_FLOOR + (-mod.DB_FLOOR * i) / (rampW - 1),
        colors.value as 'viridis' | 'magma' | 'gray',
      );
      ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
      ctx.fillRect(rampX + i, rampY, 1, rampH);
    }
    ctx.fillStyle = theme.muted;
    ctx.textAlign = 'right';
    ctx.fillText(`${mod.DB_FLOOR} dB`, rampX - 6, rampY + rampH / 2);
    ctx.textAlign = 'left';
    ctx.fillText('0 dB', GUTTER_LEFT + plotW + 2, rampY + rampH / 2);
  }

  // Waveform strip.
  const wave = peaks.value;
  if (showWaveform.value) {
    const waveTop = TOP_H;
    ctx.fillStyle = theme.well;
    ctx.fillRect(GUTTER_LEFT, waveTop, plotW, WAVE_H);
    const mid = waveTop + WAVE_H / 2;
    ctx.strokeStyle = theme.border;
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(GUTTER_LEFT, mid + 0.5);
    ctx.lineTo(GUTTER_LEFT + plotW, mid + 0.5);
    ctx.stroke();
    if (wave) {
      ctx.fillStyle = theme.accent;
      const half = WAVE_H / 2 - 2;
      for (let x = 0; x < plotW && x < wave.min.length; x++) {
        const hi = mid - clamp(wave.max[x]!, -1, 1) * half;
        const lo = mid - clamp(wave.min[x]!, -1, 1) * half;
        ctx.fillRect(GUTTER_LEFT + x, hi, 1, Math.max(1, lo - hi));
      }
    }
    ctx.fillStyle = theme.muted;
    ctx.textAlign = 'right';
    ctx.fillText('Wave', GUTTER_LEFT - 8, mid);
  }

  // Spectrogram bitmap.
  if (specImage) {
    ctx.drawImage(specImage, GUTTER_LEFT, top, plotW, SPEC_H);
  } else {
    ctx.fillStyle = theme.well;
    ctx.fillRect(GUTTER_LEFT, top, plotW, SPEC_H);
  }
  ctx.strokeStyle = theme.border;
  ctx.lineWidth = 1;
  ctx.strokeRect(GUTTER_LEFT + 0.5, top + 0.5, plotW - 1, SPEC_H - 1);

  // Frequency axis on the left.
  ctx.fillStyle = theme.muted;
  ctx.strokeStyle = theme.border;
  ctx.textAlign = 'right';
  for (const hz of freqTicks()) {
    const y = top + fractionAtFreq(hz) * SPEC_H;
    ctx.beginPath();
    ctx.moveTo(GUTTER_LEFT - 4, Math.round(y) + 0.5);
    ctx.lineTo(GUTTER_LEFT, Math.round(y) + 0.5);
    ctx.stroke();
    ctx.fillText(mod ? mod.freqToLabel(hz) : `${Math.round(hz)}`, GUTTER_LEFT - 8, clamp(y, top + 6, top + SPEC_H - 6));
  }

  // Time axis underneath.
  if (duration > 0 && mod) {
    const step = pickTimeStep(duration, Math.max(3, Math.floor(plotW / 84)));
    const places = step < 1 ? 1 : 0;
    ctx.textAlign = 'center';
    for (let t = 0; t <= duration + 1e-6; t += step) {
      const x = GUTTER_LEFT + (t / duration) * plotW;
      ctx.beginPath();
      ctx.moveTo(Math.round(x) + 0.5, top + SPEC_H);
      ctx.lineTo(Math.round(x) + 0.5, top + SPEC_H + 4);
      ctx.stroke();
      ctx.fillText(mod.secondsToLabel(t, places), clamp(x, GUTTER_LEFT + 16, GUTTER_LEFT + plotW - 16), top + SPEC_H + 14);
    }
  }

  if (!overlays) return;

  // Playhead across both strips.
  if (playhead.value !== null && duration > 0) {
    const x = GUTTER_LEFT + clamp(playhead.value / duration, 0, 1) * plotW;
    ctx.strokeStyle = theme.accent;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(x, TOP_H);
    ctx.lineTo(x, top + SPEC_H);
    ctx.stroke();
  }

  // Crosshair on the spectrogram.
  const point = hover.value;
  if (point) {
    ctx.save();
    ctx.strokeStyle = theme.text;
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 1;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(GUTTER_LEFT, Math.round(point.y) + 0.5);
    ctx.lineTo(GUTTER_LEFT + plotW, Math.round(point.y) + 0.5);
    ctx.moveTo(Math.round(point.x) + 0.5, top);
    ctx.lineTo(Math.round(point.x) + 0.5, top + SPEC_H);
    ctx.stroke();
    ctx.restore();
  }
}

function draw() {
  const canvas = canvasEl.value;
  if (!canvas) return;
  const scale = renderScale.value;
  const width = cssWidth.value;
  const height = canvasHeight.value;
  const backingW = Math.round(width * scale);
  const backingH = Math.round(height * scale);
  // Assigning width or height resets the whole canvas, so only do it when the
  // size really changed: hover redraws happen on every pointer move.
  if (canvas.width !== backingW || canvas.height !== backingH) {
    canvas.width = backingW;
    canvas.height = backingH;
  }
  canvas.style.aspectRatio = `${width} / ${height}`;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(scale, 0, 0, scale, 0, 0);
  drawAll(ctx, readTheme(canvas), true);
}

function exportPng() {
  const canvas = canvasEl.value;
  if (!canvas || !ready.value) return;
  const out = document.createElement('canvas');
  out.width = canvas.width;
  out.height = canvas.height;
  const ctx = out.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(renderScale.value, 0, 0, renderScale.value, 0, 0);
  drawAll(ctx, readTheme(canvas), false);
  out.toBlob((blob) => {
    if (!blob) {
      error.value = {
        message: 'This browser could not encode the spectrogram as a PNG.',
        fix: 'Take a screenshot of the panel instead, or try another browser.',
      };
      return;
    }
    const url = URL.createObjectURL(blob);
    triggerDownload(url, `${baseName(fileName.value)}-spectrogram.png`);
    URL.revokeObjectURL(url);
  }, 'image/png');
}

/* ---------------------------------------------------------------- */
/* pointer                                                           */
/* ---------------------------------------------------------------- */

interface PlotPoint {
  x: number;
  y: number;
  px: number;
  py: number;
}

/**
 * Convert a pointer event into canvas coordinates, or null when it landed
 * outside the spectrogram itself. The canvas is laid out at 100 percent width,
 * which is not always its logical width, so the ratio is applied explicitly.
 */
function pointerAt(e: PointerEvent | MouseEvent): PlotPoint | null {
  const canvas = canvasEl.value;
  if (!canvas) return null;
  const rect = canvas.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  const px = e.clientX - rect.left;
  const py = e.clientY - rect.top;
  const x = (px * cssWidth.value) / rect.width;
  const y = (py * canvasHeight.value) / rect.height;
  const top = specTop.value;
  if (x < GUTTER_LEFT || x > GUTTER_LEFT + plotWidth.value) return null;
  if (y < top || y > top + SPEC_H) return null;
  return { x, y, px, py };
}

function onPointerMove(e: PointerEvent) {
  if (!ready.value) return;
  const point = pointerAt(e);
  if (!point) {
    if (hover.value) {
      hover.value = null;
      draw();
    }
    return;
  }
  const cols = columns.value;
  const fraction = (point.x - GUTTER_LEFT) / plotWidth.value;
  const time = fraction * analyzedDuration.value;
  const freq = freqAtFraction((point.y - specTop.value) / SPEC_H);
  const columnIndex = clamp(Math.floor(fraction * cols.length), 0, cols.length - 1);
  const bin = clamp(Math.round((freq / nyquist.value) * freqBins.value), 0, freqBins.value - 1);
  hover.value = {
    x: point.x,
    y: point.y,
    px: point.px,
    py: point.py,
    time,
    freq,
    db: cols[columnIndex]![bin]!,
  };
  draw();
}

function onPointerLeave() {
  if (!hover.value) return;
  hover.value = null;
  draw();
}

function onCanvasClick(e: MouseEvent) {
  if (!ready.value) return;
  if (playing.value) {
    stopPlayback();
    return;
  }
  const point = pointerAt(e);
  if (!point) return;
  const time = ((point.x - GUTTER_LEFT) / plotWidth.value) * analyzedDuration.value;
  playFrom(time);
}

/* ---------------------------------------------------------------- */
/* lifecycle and reactions                                           */
/* ---------------------------------------------------------------- */

let observer: ResizeObserver | null = null;
let themeWatcher: MutationObserver | null = null;

onMounted(() => {
  renderScale.value = Math.min(2, Math.max(1, window.devicePixelRatio || 1));
  const el = wrapper.value;
  if (el) {
    cssWidth.value = Math.max(260, Math.round(el.clientWidth));
    observer = new ResizeObserver((entries) => {
      const next = Math.max(260, Math.round(entries[0]?.contentRect.width ?? cssWidth.value));
      if (next === cssWidth.value) return;
      cssWidth.value = next;
    });
    observer.observe(el);
  }
  // Axis text, gutters, and the surface behind the plot are painted from the
  // theme tokens, which are resolved at draw time. Flipping the header toggle
  // changes a class on <html> and nothing else, so the canvas has to be told.
  themeWatcher = new MutationObserver(() => draw());
  themeWatcher.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['class'],
  });
  draw();
});

onUnmounted(() => {
  analysisToken += 1;
  stopPlayback();
  observer?.disconnect();
  observer = null;
  themeWatcher?.disconnect();
  themeWatcher = null;
  specImage = null;
  if (audioCtx && audioCtx.state !== 'closed') {
    audioCtx.close().catch(() => {
      // Closing a context the browser already tore down is not an error worth showing.
    });
  }
  audioCtx = null;
});

/** Width changes need new waveform buckets and a fresh bitmap, not new FFTs. */
watch(cssWidth, () => {
  if (!hasAudio.value) {
    draw();
    return;
  }
  rebuildPeaks();
  renderSpecImage();
  draw();
});

/** Colors and axis only change the mapping from decibels and bins to pixels. */
watch([colors, axisScale], () => {
  if (!ready.value) return;
  renderSpecImage();
  draw();
});

watch(showWaveform, () => {
  hover.value = null;
  draw();
});

/** A new FFT size is a real re-analysis, so the whole chunked loop runs again. */
watch(fftSize, () => {
  if (!hasAudio.value) return;
  stopPlayback();
  analyze();
});

const summary = computed(() => {
  if (!hasAudio.value) return '';
  const channels = channelCount.value === 1 ? 'mono' : `${channelCount.value} channels`;
  const mod = logic.value;
  const length = mod ? mod.secondsToLabel(fullDuration.value) : '';
  return `${length}, ${sampleRate.value.toLocaleString()} Hz, ${channels}`;
});

const hoverChipStyle = computed(() => {
  const point = hover.value;
  if (!point) return {};
  const flip = point.x > GUTTER_LEFT + plotWidth.value - 190;
  return {
    left: `${flip ? point.px - 12 : point.px + 12}px`,
    top: `${point.py + 12}px`,
    transform: flip ? 'translateX(-100%)' : 'none',
  };
});
</script>

<template>
  <div class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <!-- Input -->
    <div
      class="rounded-[10px] bg-secondary shadow-[var(--sh-inset)]"
      :class="dragging ? 'ring-2 ring-ring' : ''"
      @dragover.prevent="dragging = true"
      @dragleave="dragging = false"
      @drop.prevent="onDrop"
    >
      <div class="flex items-center justify-between px-3 pt-2">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Audio
        </span>
        <Button
          variant="ghost"
          size="sm"
          @click="fileInput?.click()"
        >
          Open file…
        </Button>
        <input
          ref="fileInput"
          type="file"
          class="hidden"
          accept="audio/*"
          @change="onPickFile"
        >
      </div>

      <div
        v-if="fileName"
        class="px-3 pt-2 pb-3"
      >
        <span
          class="inline-flex max-w-full items-center gap-2 rounded-full border bg-card py-1 pr-1 pl-3 text-xs shadow-[var(--sh-sm)]"
        >
          <span class="truncate font-medium">{{ fileName }}</span>
          <span class="shrink-0 text-muted-foreground">{{ humanSize(fileSize) }}</span>
          <span
            v-if="summary"
            class="shrink-0 text-muted-foreground tabular-nums"
          >{{ summary }}</span>
          <button
            type="button"
            aria-label="Remove audio file"
            class="grid size-5 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
            @click="clearFile"
          >
            <X class="size-3.5" />
          </button>
        </span>
      </div>

      <p
        v-else
        class="px-3 pt-1 pb-4 text-sm text-muted-foreground"
      >
        Drop an audio file here to see its waveform and its frequency spectrogram. WAV, MP3, FLAC,
        OGG, and M4A all work. Everything runs in this tab:
        your files and inputs never leave your device.
      </p>
    </div>

    <!-- Errors -->
    <div
      v-if="error"
      role="alert"
      class="rounded-lg border border-destructive/50 bg-destructive/5 px-3 py-2 text-sm"
    >
      <p class="font-medium text-destructive">
        {{ error.message }}
      </p>
      <p
        v-if="error.fix"
        class="mt-1 text-muted-foreground"
      >
        {{ error.fix }}
      </p>
    </div>

    <!-- Options -->
    <div
      v-if="hasAudio"
      class="flex flex-wrap items-end gap-4 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]"
    >
      <div class="flex w-40 flex-col gap-1.5">
        <Label
          for="spec-fft"
          class="text-xs text-muted-foreground"
        >FFT size</Label>
        <Select
          :model-value="fftSize"
          @update:model-value="(v) => (fftSize = String(v))"
        >
          <SelectTrigger
            id="spec-fft"
            size="sm"
            class="w-full bg-card"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="1024">
              1024 (sharper in time)
            </SelectItem>
            <SelectItem value="2048">
              2048 (balanced)
            </SelectItem>
            <SelectItem value="4096">
              4096 (sharper in frequency)
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div class="flex w-32 flex-col gap-1.5">
        <Label
          for="spec-colors"
          class="text-xs text-muted-foreground"
        >Colors</Label>
        <Select
          :model-value="colors"
          @update:model-value="(v) => (colors = String(v))"
        >
          <SelectTrigger
            id="spec-colors"
            size="sm"
            class="w-full bg-card"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="viridis">
              Viridis
            </SelectItem>
            <SelectItem value="magma">
              Magma
            </SelectItem>
            <SelectItem value="gray">
              Grayscale
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div class="flex w-36 flex-col gap-1.5">
        <Label
          for="spec-scale"
          class="text-xs text-muted-foreground"
        >Frequency axis</Label>
        <Select
          :model-value="axisScale"
          @update:model-value="(v) => (axisScale = String(v))"
        >
          <SelectTrigger
            id="spec-scale"
            size="sm"
            class="w-full bg-card"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="linear">
              Linear
            </SelectItem>
            <SelectItem value="log">
              Logarithmic
            </SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div class="flex items-center gap-2 pb-2">
        <Switch
          id="spec-wave"
          :model-value="showWaveform"
          @update:model-value="(v) => (showWaveform = Boolean(v))"
        />
        <Label
          for="spec-wave"
          class="text-xs text-muted-foreground"
        >Show waveform</Label>
      </div>

      <div class="ml-auto flex items-center gap-2 pb-1">
        <Button
          variant="outline"
          size="sm"
          :disabled="!ready"
          @click="exportPng"
        >
          Download PNG
        </Button>
        <Button
          v-if="playing"
          size="sm"
          @click="stopPlayback"
        >
          Stop
        </Button>
      </div>
    </div>

    <!-- Progress -->
    <div
      v-if="stage === 'decoding' || stage === 'analyzing'"
      class="flex flex-col gap-2 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]"
    >
      <div class="flex items-center justify-between text-xs text-muted-foreground">
        <span>{{ stage === 'decoding' ? 'Decoding audio…' : 'Running the FFT…' }}</span>
        <span class="tabular-nums">{{ stage === 'analyzing' ? `${progress}%` : '' }}</span>
      </div>
      <div class="h-1.5 overflow-hidden rounded-full bg-card">
        <div
          class="h-full rounded-full bg-primary transition-[width] duration-150"
          :style="{ width: stage === 'analyzing' ? `${progress}%` : '15%' }"
        />
      </div>
    </div>

    <!-- Plot -->
    <div
      ref="wrapper"
      class="relative w-full"
    >
      <canvas
        ref="canvasEl"
        class="w-full rounded-[10px] shadow-[var(--sh-inset)]"
        :class="ready ? 'cursor-crosshair' : ''"
        @pointermove="onPointerMove"
        @pointerleave="onPointerLeave"
        @click="onCanvasClick"
      />
      <div
        v-if="hover && logic"
        class="pointer-events-none absolute z-10 rounded-[8px] border bg-popover px-2 py-1 font-mono text-[11px] whitespace-nowrap text-popover-foreground shadow-[var(--sh-md)] tabular-nums"
        :style="hoverChipStyle"
      >
        {{ logic.secondsToLabel(hover.time, 2) }} &middot; {{ logic.freqToLabel(hover.freq) }} &middot;
        {{ hover.db.toFixed(1) }} dB
      </div>
    </div>

    <!-- Notes -->
    <div class="flex flex-col gap-1.5 text-xs text-muted-foreground">
      <p v-if="!hasAudio">
        Time runs left to right, frequency runs bottom to top, and color is level in decibels
        against full scale.
      </p>
      <p v-if="ready">
        Hover the spectrogram for the exact time, frequency, and level under the pointer. Click to
        play from that moment, and click again to stop.
      </p>
      <p v-if="truncated && logic">
        This file is {{ logic.secondsToLabel(fullDuration) }} long. Only the first
        {{ logic.secondsToLabel(analyzedDuration) }} are analyzed and drawn, because a longer
        analysis would not fit in browser memory on most machines.
      </p>
      <p v-if="ready">
        {{ columns.length }} columns across {{ logic?.secondsToLabel(analyzedDuration) }}, with
        {{ freqBins }} frequency bins up to {{ logic?.freqToLabel(nyquist) }}. Levels are floored at
        -100 dB.
      </p>
    </div>
  </div>
</template>
