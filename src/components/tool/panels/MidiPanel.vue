<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef } from "vue";
import { CircleAlert, FileMusic, Music4, Radio, Trash2, X } from "lucide-vue-next";
import type { ToolMeta } from "@/tools/types";
import { ToolError } from "@/tools/types";
import { formatBytes } from "@/lib/format";
import { useStickToBottom } from "@/lib/stick-to-bottom";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import CopyButton from "@/components/tool/CopyButton.vue";
import {
  controllerName,
  decodeLiveMessage,
  durationSeconds,
  formatDivision,
  formatDuration,
  middleCOctave,
  noteCount,
  noteName,
  parseMidi,
  tempoMap,
  type LiveMessage,
  type MidiEvent,
  type MidiFile,
} from "@/tools/midi-inspector/index";

/**
 * Bespoke panel for the MIDI inspector. Two surfaces on the same pure core:
 *
 *  - FILE: reads a dropped .mid with `parseMidi` and renders the header, the
 *    per-track event list, the note count and the duration. This half works in
 *    every browser.
 *  - LIVE: reads connected input devices with the Web MIDI API and hands every
 *    incoming `MIDIMessageEvent.data` to `decodeLiveMessage`, so the status,
 *    channel and note decoding is never reimplemented here (rule 27). Optional
 *    playback synthesises each note with Web Audio.
 *
 * Web MIDI is capability-detected, not sniffed: when the browser does not expose
 * it the monitor shows an honest note and the file inspector stays fully usable.
 * Nothing is persisted; the log lives in memory and the tab forgets it on close.
 */
defineProps<{ meta: ToolMeta }>();

/* ---------------------------------------------------------------- */
/* narrow Web MIDI shapes (not in every lib.dom)                     */
/* ---------------------------------------------------------------- */

interface MidiMessageEventLike extends Event {
  data: Uint8Array;
}
interface MidiPortLike {
  id: string;
  name?: string | null;
  manufacturer?: string | null;
  state: string;
  onmidimessage: ((event: MidiMessageEventLike) => void) | null;
}
interface MidiAccessLike {
  inputs: Map<string, MidiPortLike>;
  onstatechange: ((event: Event) => void) | null;
}
interface MidiNavigator {
  requestMIDIAccess?: (options?: { sysex?: boolean }) => Promise<MidiAccessLike>;
}

// Starts false so the server render and the first client render agree (no
// hydration mismatch); the real capability is read after mount, client only.
const midiSupported = ref(false);
onMounted(() => {
  midiSupported.value = typeof navigator !== "undefined" && "requestMIDIAccess" in navigator;
});

/* ---------------------------------------------------------------- */
/* mode                                                              */
/* ---------------------------------------------------------------- */

const mode = ref<"file" | "live">("file");

/* ================================================================ */
/* FILE mode                                                        */
/* ================================================================ */

const fileName = ref("");
const fileSize = ref(0);
const file = shallowRef<MidiFile | null>(null);
const fileError = ref<{ message: string; fix?: string } | null>(null);
const dragging = ref(false);
const fileInput = ref<HTMLInputElement>();
const middleC = ref("4");
const selectedTrack = ref(0);

/** How many event rows to render before the list is cut off, to keep it snappy. */
const MAX_EVENT_ROWS = 800;

function toToolError(e: unknown): { message: string; fix?: string } {
  return e instanceof ToolError
    ? { message: e.message, fix: e.fix }
    : { message: e instanceof Error ? e.message : String(e) };
}

async function readFile(picked: File) {
  try {
    const buffer = await picked.arrayBuffer();
    const parsed = parseMidi(new Uint8Array(buffer));
    file.value = parsed;
    fileName.value = picked.name;
    fileSize.value = picked.size;
    fileError.value = null;
    selectedTrack.value = parsed.tracks.findIndex((t) => t.events.length > 0);
    if (selectedTrack.value < 0) selectedTrack.value = 0;
  } catch (e) {
    file.value = null;
    fileName.value = "";
    fileSize.value = 0;
    fileError.value = toToolError(e);
  }
}

function onDrop(e: DragEvent) {
  dragging.value = false;
  const picked = e.dataTransfer?.files[0];
  if (picked) void readFile(picked);
}

function onPickFile(e: Event) {
  const picker = e.target as HTMLInputElement;
  const picked = picker.files?.[0];
  if (!picked) return;
  void readFile(picked).then(() => {
    picker.value = "";
  });
}

function clearFile() {
  file.value = null;
  fileName.value = "";
  fileSize.value = 0;
  fileError.value = null;
  if (fileInput.value) fileInput.value.value = "";
}

/* derived summary ------------------------------------------------- */

const octave = computed(() => middleCOctave({ middleC: middleC.value }));

const FORMAT_LABELS: Record<number, string> = {
  0: "single track",
  1: "multi track, one timeline",
  2: "multi track, independent patterns",
};

const summary = computed(() => {
  const f = file.value;
  if (!f) return null;
  const firstTempo = tempoMap(f)[0];
  let timeSig = "";
  let keySig = "";
  for (const track of f.tracks) {
    for (const event of track.events) {
      if (!timeSig && event.kind === "timeSignature") {
        timeSig = `${event.numerator}/${event.denominator}`;
      }
      if (!keySig && event.kind === "keySignature") keySig = event.key;
    }
  }
  return {
    format: `${f.header.format}`,
    formatLabel: FORMAT_LABELS[f.header.format] ?? "unknown",
    trackCount: f.tracks.length,
    declared: f.header.trackCount,
    division: formatDivision(f.header.division),
    notes: noteCount(f),
    duration: formatDuration(durationSeconds(f)),
    tempo: firstTempo ? `${Math.round(firstTempo.bpm)} BPM` : "not set",
    tempoDetail: firstTempo
      ? `${firstTempo.microsecondsPerQuarter} usec/quarter`
      : "defaults to 120 BPM",
    timeSig: timeSig || "-",
    keySig: keySig || "-",
    isFormat2: f.header.format === 2,
  };
});

const tracks = computed(() => file.value?.tracks ?? []);
const activeTrack = computed(() => tracks.value[selectedTrack.value] ?? null);

/** Turn a decoded event into one readable line. Presentation only; decoding is in logic. */
function eventLine(event: MidiEvent): string {
  const ch = "channel" in event ? ` ch ${event.channel + 1}` : "";
  switch (event.kind) {
    case "noteOn":
      return `note on   ${noteName(event.note, octave.value)}  vel ${event.velocity}${ch}`;
    case "noteOff":
      return `note off  ${noteName(event.note, octave.value)}${ch}`;
    case "polyAftertouch":
      return `aftertouch ${noteName(event.note, octave.value)} ${event.pressure}${ch}`;
    case "controlChange":
      return `cc        ${controllerName(event.controller)} = ${event.value}${ch}`;
    case "programChange":
      return `program   ${event.program}${ch}`;
    case "channelAftertouch":
      return `pressure  ${event.pressure}${ch}`;
    case "pitchBend":
      return `pitchbend ${event.value}${ch}`;
    case "tempo":
      return `tempo     ${Math.round(event.bpm)} BPM`;
    case "timeSignature":
      return `timesig   ${event.numerator}/${event.denominator}`;
    case "keySignature":
      return `keysig    ${event.key}`;
    case "text":
      return `${event.label.toLowerCase()}: ${event.text}`;
    case "sequenceNumber":
      return `sequence  ${event.number}`;
    case "channelPrefix":
      return `channel prefix ${event.channel + 1}`;
    case "portPrefix":
      return `port prefix ${event.port}`;
    case "sysex":
      return `sysex     ${event.byteLength} bytes`;
    case "endOfTrack":
      return `end of track`;
    default:
      return `meta ${event.metaType} (${event.byteLength} bytes)`;
  }
}

interface EventRow {
  key: number;
  tick: number;
  text: string;
}

const eventRows = computed<EventRow[]>(() => {
  const track = activeTrack.value;
  if (!track) return [];
  return track.events.slice(0, MAX_EVENT_ROWS).map((event, i) => ({
    key: i,
    tick: event.tick,
    text: eventLine(event),
  }));
});

const hiddenEventCount = computed(() => {
  const track = activeTrack.value;
  if (!track) return 0;
  return Math.max(0, track.events.length - MAX_EVENT_ROWS);
});

/** The whole selected track as copyable text. */
const eventListText = computed(() => {
  const track = activeTrack.value;
  if (!track) return "";
  return track.events.map((event) => `t${event.tick}\t${eventLine(event)}`).join("\n");
});

/* ================================================================ */
/* LIVE mode                                                        */
/* ================================================================ */

interface DeviceInfo {
  id: string;
  name: string;
}

const access = shallowRef<MidiAccessLike | null>(null);
const liveError = ref<string | null>(null);
const requesting = ref(false);
const devices = ref<DeviceInfo[]>([]);
const playback = ref(false);

const MAX_LOG = 4000;
const MAX_RENDER = 600;

interface LogRow {
  key: number;
  time: string;
  device: string;
  text: string;
  kind: "note" | "other";
}

// Plain array, not reactive: a busy controller sends faster than the screen
// refreshes, so rows go straight into memory and one rAF per frame redraws.
const logStore: LogRow[] = [];
const revision = ref(0);
let rowKey = 0;
let frame: number | null = null;

function scheduleRender() {
  if (frame !== null) return;
  frame = requestAnimationFrame(() => {
    frame = null;
    revision.value++;
  });
}

const visibleRows = computed<LogRow[]>(() => {
  void revision.value;
  return logStore.slice(-MAX_RENDER);
});
const hiddenLogCount = computed(() => {
  void revision.value;
  return Math.max(0, logStore.length - MAX_RENDER);
});
const logEmpty = computed(() => visibleRows.value.length === 0);

// The monitor stays pinned to the newest message unless the reader scrolls up.
const { el: liveLogEl, onScroll: onLiveLogScroll } = useStickToBottom(revision);

function clock(): string {
  const now = new Date();
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.${pad(now.getMilliseconds(), 3)}`;
}

function liveLine(message: LiveMessage): { text: string; kind: LogRow["kind"] } {
  const ch = "channel" in message ? ` ch ${message.channel + 1}` : "";
  switch (message.kind) {
    case "noteOn":
      return {
        text: `note on   ${noteName(message.note)}  vel ${message.velocity}${ch}`,
        kind: "note",
      };
    case "noteOff":
      return { text: `note off  ${noteName(message.note)}${ch}`, kind: "note" };
    case "polyAftertouch":
      return {
        text: `aftertouch ${noteName(message.note)} ${message.pressure}${ch}`,
        kind: "other",
      };
    case "controlChange":
      return {
        text: `cc        ${controllerName(message.controller)} = ${message.value}${ch}`,
        kind: "other",
      };
    case "programChange":
      return { text: `program   ${message.program}${ch}`, kind: "other" };
    case "channelAftertouch":
      return { text: `pressure  ${message.pressure}${ch}`, kind: "other" };
    case "pitchBend":
      return { text: `pitchbend ${message.value}${ch}`, kind: "other" };
    case "sysex":
      return { text: `sysex     ${message.byteLength} bytes`, kind: "other" };
    case "songPosition":
      return { text: `song position ${message.position}`, kind: "other" };
    case "songSelect":
      return { text: `song select ${message.song}`, kind: "other" };
    case "clock":
      return { text: `clock`, kind: "other" };
    case "start":
      return { text: `start`, kind: "other" };
    case "continue":
      return { text: `continue`, kind: "other" };
    case "stop":
      return { text: `stop`, kind: "other" };
    case "activeSensing":
      return { text: `active sensing`, kind: "other" };
    case "systemReset":
      return { text: `system reset`, kind: "other" };
    case "tuneRequest":
      return { text: `tune request`, kind: "other" };
    default:
      return { text: `unknown status ${message.status}`, kind: "other" };
  }
}

/** Clock and active-sensing arrive dozens of times a second; hide them by default. */
const showClock = ref(false);

function handleMessage(deviceName: string, event: MidiMessageEventLike) {
  const data = event.data instanceof Uint8Array ? event.data : Uint8Array.from(event.data ?? []);
  const message = decodeLiveMessage(data);
  if (!showClock.value && (message.kind === "clock" || message.kind === "activeSensing")) return;

  const line = liveLine(message);
  rowKey += 1;
  logStore.push({
    key: rowKey,
    time: clock(),
    device: deviceName,
    text: line.text,
    kind: line.kind,
  });
  if (logStore.length > MAX_LOG) logStore.splice(0, logStore.length - MAX_LOG);
  scheduleRender();

  if (playback.value && message.kind === "noteOn")
    startTone(message.channel, message.note, message.velocity);
  if (playback.value && message.kind === "noteOff") stopTone(message.channel, message.note);
}

function refreshDevices() {
  const current = access.value;
  if (!current) return;
  const list: DeviceInfo[] = [];
  for (const input of current.inputs.values()) {
    list.push({ id: input.id, name: input.name || input.manufacturer || "MIDI input" });
    input.onmidimessage = (event) => handleMessage(input.name || "MIDI input", event);
  }
  devices.value = list;
}

async function grantAccess() {
  const nav = navigator as unknown as MidiNavigator;
  if (!nav.requestMIDIAccess) return;
  requesting.value = true;
  liveError.value = null;
  try {
    const granted = await nav.requestMIDIAccess({ sysex: false });
    access.value = granted;
    granted.onstatechange = () => refreshDevices();
    refreshDevices();
  } catch (e) {
    liveError.value =
      e instanceof Error && e.name === "SecurityError"
        ? "MIDI access was denied. Allow it in the browser prompt, or check the site permissions and try again."
        : `Could not start Web MIDI: ${e instanceof Error ? e.message : String(e)}.`;
  } finally {
    requesting.value = false;
  }
}

function clearLog() {
  logStore.length = 0;
  revision.value++;
}

/** The live log as copyable text, newest last. */
const logText = computed(() => {
  void revision.value;
  return logStore.map((row) => `${row.time}\t${row.device}\t${row.text}`).join("\n");
});

/* Web Audio playback --------------------------------------------- */

let audioCtx: AudioContext | null = null;
const activeTones = new Map<string, { osc: OscillatorNode; gain: GainNode }>();

function toneKey(channel: number, note: number): string {
  return `${channel}:${note}`;
}

function startTone(channel: number, note: number, velocity: number) {
  if (!audioCtx) return;
  stopTone(channel, note);
  const freq = 440 * 2 ** ((note - 69) / 12);
  const osc = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.type = "triangle";
  osc.frequency.value = freq;
  const level = Math.min(0.3, (velocity / 127) * 0.3);
  const now = audioCtx.currentTime;
  gain.gain.setValueAtTime(0.0001, now);
  gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, level), now + 0.01);
  osc.connect(gain).connect(audioCtx.destination);
  osc.start();
  activeTones.set(toneKey(channel, note), { osc, gain });
}

function stopTone(channel: number, note: number) {
  const tone = activeTones.get(toneKey(channel, note));
  if (!tone || !audioCtx) return;
  const now = audioCtx.currentTime;
  try {
    tone.gain.gain.cancelScheduledValues(now);
    tone.gain.gain.setValueAtTime(Math.max(0.0002, tone.gain.gain.value), now);
    tone.gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.08);
    tone.osc.stop(now + 0.1);
  } catch {
    // An oscillator already stopped throws; nothing to do.
  }
  activeTones.delete(toneKey(channel, note));
}

function stopAllTones() {
  for (const [, tone] of activeTones) {
    try {
      tone.osc.stop();
    } catch {
      // already stopped
    }
  }
  activeTones.clear();
}

async function onTogglePlayback(next: boolean) {
  playback.value = next;
  if (next) {
    // Created inside the user gesture so the autoplay policy does not suspend it.
    audioCtx ??= new AudioContext();
    if (audioCtx.state === "suspended") await audioCtx.resume();
  } else {
    stopAllTones();
  }
}

/* cleanup --------------------------------------------------------- */

onUnmounted(() => {
  if (frame !== null) cancelAnimationFrame(frame);
  const current = access.value;
  if (current) {
    for (const input of current.inputs.values()) input.onmidimessage = null;
    current.onstatechange = null;
  }
  stopAllTones();
  if (audioCtx) void audioCtx.close();
});
</script>

<template>
  <div class="flex flex-col gap-4">
    <!-- mode toggle -->
    <div
      class="inline-flex w-fit gap-1 rounded-[10px] bg-secondary p-1 shadow-[var(--sh-inset)]"
      role="tablist"
      aria-label="MIDI inspector mode"
    >
      <Button
        role="tab"
        :aria-selected="mode === 'file'"
        size="sm"
        :variant="mode === 'file' ? 'default' : 'ghost'"
        @click="mode = 'file'"
      >
        <FileMusic class="size-4" aria-hidden="true" />
        MIDI file
      </Button>
      <Button
        role="tab"
        :aria-selected="mode === 'live'"
        size="sm"
        :variant="mode === 'live' ? 'default' : 'ghost'"
        @click="mode = 'live'"
      >
        <Radio class="size-4" aria-hidden="true" />
        Live monitor
      </Button>
    </div>

    <!-- ============================================================ -->
    <!-- FILE mode                                                    -->
    <!-- ============================================================ -->
    <div
      v-show="mode === 'file'"
      class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6"
    >
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
            MIDI file
          </span>
          <Button variant="ghost" size="sm" @click="fileInput?.click()"> Open a .mid file… </Button>
          <input
            ref="fileInput"
            type="file"
            accept=".mid,.midi,audio/midi,audio/x-midi"
            class="hidden"
            @change="onPickFile"
          />
        </div>

        <div v-if="file" class="px-3 pt-2 pb-3">
          <span
            class="inline-flex max-w-full items-center gap-2 rounded-full border bg-card py-1 pr-1 pl-3 text-xs shadow-[var(--sh-sm)]"
          >
            <span class="truncate font-medium">{{ fileName }}</span>
            <span class="shrink-0 text-muted-foreground">{{ formatBytes(fileSize) }}</span>
            <button
              type="button"
              aria-label="Close this file"
              class="grid size-5 shrink-0 place-items-center rounded-full text-muted-foreground transition-colors outline-none hover:bg-secondary hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
              @click="clearFile"
            >
              <X class="size-3.5" />
            </button>
          </span>
        </div>
        <div v-else class="px-3 pt-1 pb-3">
          <p class="text-sm text-muted-foreground">
            Drop a .mid or .midi file here, or use the button above. The file is parsed in this tab:
            your files and inputs never leave your device.
          </p>
        </div>
      </div>

      <!-- Error -->
      <div
        v-if="fileError"
        role="alert"
        class="rounded-lg border border-destructive/50 bg-destructive/5 px-3 py-2 text-sm"
      >
        <p class="font-medium text-destructive">
          {{ fileError.message }}
        </p>
        <p v-if="fileError.fix" class="mt-1 text-muted-foreground">
          {{ fileError.fix }}
        </p>
      </div>

      <!-- Empty helper -->
      <p v-if="!file && !fileError" class="text-sm text-muted-foreground">
        Load a Standard MIDI File to see its header, tracks, tempo and event list. Nothing plays or
        uploads: this reads the bytes and shows you what is inside.
      </p>

      <!-- Summary -->
      <template v-if="file && summary">
        <div class="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
          <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
            <div class="text-xs text-muted-foreground">Format</div>
            <div class="font-mono text-lg tabular-nums">
              {{ summary.format }}
            </div>
            <div class="text-xs text-muted-foreground">
              {{ summary.formatLabel }}
            </div>
          </div>
          <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
            <div class="text-xs text-muted-foreground">Tracks</div>
            <div class="font-mono text-lg tabular-nums">
              {{ summary.trackCount }}
            </div>
            <div
              v-if="summary.trackCount !== summary.declared"
              class="text-xs text-muted-foreground"
            >
              header says {{ summary.declared }}
            </div>
          </div>
          <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
            <div class="text-xs text-muted-foreground">Notes</div>
            <div class="font-mono text-lg tabular-nums">
              {{ summary.notes }}
            </div>
          </div>
          <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
            <div class="text-xs text-muted-foreground">Duration</div>
            <div class="font-mono text-lg tabular-nums">
              {{ summary.duration }}
            </div>
            <div v-if="summary.isFormat2" class="text-xs text-muted-foreground">
              approx (format 2)
            </div>
          </div>
          <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
            <div class="text-xs text-muted-foreground">Tempo</div>
            <div class="font-mono text-lg tabular-nums">
              {{ summary.tempo }}
            </div>
            <div class="text-xs text-muted-foreground">
              {{ summary.tempoDetail }}
            </div>
          </div>
          <div class="rounded-[10px] bg-secondary px-3 py-2 shadow-[var(--sh-inset)]">
            <div class="text-xs text-muted-foreground">Time / key</div>
            <div class="font-mono text-lg tabular-nums">
              {{ summary.timeSig }}
            </div>
            <div class="text-xs text-muted-foreground">
              {{ summary.keySig }}
            </div>
          </div>
        </div>

        <div class="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          <span>{{ summary.division }}</span>
          <span class="flex items-center gap-2">
            <Label for="midi-octave" class="text-xs text-muted-foreground">Middle C</Label>
            <select
              id="midi-octave"
              v-model="middleC"
              class="rounded-[8px] border bg-card px-2 py-1 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <option value="3">C3 = 60</option>
              <option value="4">C4 = 60</option>
              <option value="5">C5 = 60</option>
            </select>
          </span>
        </div>

        <!-- Tracks + events -->
        <div class="grid gap-4 md:grid-cols-[minmax(160px,220px)_minmax(0,1fr)]">
          <div class="flex flex-col gap-2 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
            <div class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
              Tracks
            </div>
            <button
              v-for="(track, i) in tracks"
              :key="i"
              type="button"
              class="flex w-full flex-col rounded-[8px] px-2 py-1.5 text-left outline-none hover:bg-card focus-visible:ring-3 focus-visible:ring-ring/50"
              :class="selectedTrack === i ? 'bg-card shadow-[var(--sh-sm)]' : ''"
              :aria-current="selectedTrack === i ? 'true' : undefined"
              @click="selectedTrack = i"
            >
              <span class="truncate font-mono text-xs">
                {{ track.name || `Track ${i + 1}` }}
              </span>
              <span class="text-xs text-muted-foreground tabular-nums">
                {{ track.events.length }} events
              </span>
            </button>
          </div>

          <div class="flex min-w-0 flex-col gap-2">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <span class="font-mono text-sm">
                {{ activeTrack?.name || `Track ${selectedTrack + 1}` }}
              </span>
              <CopyButton :text="eventListText" label="Copy events" />
            </div>
            <div
              class="max-h-[28rem] overflow-auto rounded-[10px] bg-secondary shadow-[var(--sh-inset)]"
            >
              <table class="w-full border-collapse text-xs">
                <tbody class="divide-y divide-border/60">
                  <tr v-for="row in eventRows" :key="row.key" class="align-top hover:bg-card/70">
                    <td class="px-3 py-1 text-right font-mono text-muted-foreground tabular-nums">
                      {{ row.tick }}
                    </td>
                    <td class="px-3 py-1 font-mono break-words whitespace-pre-wrap">
                      {{ row.text }}
                    </td>
                  </tr>
                  <tr v-if="eventRows.length === 0">
                    <td colspan="2" class="px-3 py-6 text-center text-sm text-muted-foreground">
                      This track has no events.
                    </td>
                  </tr>
                </tbody>
              </table>
            </div>
            <p v-if="hiddenEventCount > 0" class="text-xs text-muted-foreground">
              Showing the first {{ MAX_EVENT_ROWS }} events. {{ hiddenEventCount }} more are in the
              copied list.
            </p>
          </div>
        </div>
      </template>
    </div>

    <!-- ============================================================ -->
    <!-- LIVE mode                                                    -->
    <!-- ============================================================ -->
    <div
      v-show="mode === 'live'"
      class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6"
    >
      <!-- Unsupported -->
      <div
        v-if="!midiSupported"
        class="flex items-start gap-3 rounded-[10px] bg-secondary px-4 py-3 shadow-[var(--sh-inset)]"
      >
        <CircleAlert class="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div class="text-sm">
          <p class="font-medium">This browser does not expose the Web MIDI API.</p>
          <p class="mt-1 text-muted-foreground">
            The live monitor needs Web MIDI, which Chromium browsers like Chrome and Edge support,
            and Firefox behind a flag. The MIDI file inspector on the other tab works here without
            it.
          </p>
        </div>
      </div>

      <template v-else>
        <div class="flex flex-wrap items-center gap-3">
          <Button v-if="!access" :disabled="requesting" @click="grantAccess">
            <Music4 class="size-4" aria-hidden="true" />
            {{ requesting ? "Waiting for permission…" : "Connect MIDI devices" }}
          </Button>

          <template v-else>
            <span class="text-sm text-muted-foreground">
              {{ devices.length }}
              {{ devices.length === 1 ? "input connected" : "inputs connected" }}
            </span>
            <label class="flex cursor-pointer items-center gap-2 text-sm">
              <Switch :model-value="playback" @update:model-value="onTogglePlayback" />
              Play notes
            </label>
            <label class="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
              <Switch v-model="showClock" />
              Show clock
            </label>
            <CopyButton :text="logText" label="Copy log" />
            <Button variant="outline" size="sm" @click="clearLog">
              <Trash2 class="size-3.5" />
              Clear
            </Button>
          </template>
        </div>

        <div
          v-if="liveError"
          role="alert"
          class="rounded-lg border border-destructive/50 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          {{ liveError }}
        </div>

        <!-- Device chips -->
        <div v-if="access" class="flex flex-wrap gap-2">
          <span
            v-for="device in devices"
            :key="device.id"
            class="inline-flex items-center gap-2 rounded-full border bg-secondary px-3 py-1 text-xs shadow-[var(--sh-inset)]"
          >
            <Radio class="size-3" />
            {{ device.name }}
          </span>
          <span v-if="devices.length === 0" class="text-sm text-muted-foreground">
            No input devices found. Plug in a MIDI keyboard or interface, and it will appear here.
          </span>
        </div>

        <!-- Live log -->
        <div
          v-if="access"
          ref="liveLogEl"
          class="max-h-[26rem] overflow-auto rounded-[10px] bg-secondary p-3 font-mono text-xs shadow-[var(--sh-inset)]"
          @scroll.passive="onLiveLogScroll"
        >
          <p v-if="logEmpty" class="text-muted-foreground">
            Play a note on a connected device to see messages here.
          </p>
          <template v-else>
            <p v-if="hiddenLogCount > 0" class="mb-1 text-muted-foreground">
              {{ hiddenLogCount }} earlier messages scrolled off.
            </p>
            <div
              v-for="row in visibleRows"
              :key="row.key"
              class="flex gap-3 py-0.5"
              :class="row.kind === 'note' ? 'text-foreground' : 'text-muted-foreground'"
            >
              <span class="shrink-0 tabular-nums text-muted-foreground">{{ row.time }}</span>
              <span class="shrink-0 truncate text-muted-foreground max-w-[8rem]">{{
                row.device
              }}</span>
              <span class="break-words whitespace-pre-wrap">{{ row.text }}</span>
            </div>
          </template>
        </div>

        <p class="text-xs text-muted-foreground">
          Messages are decoded and shown here only. Nothing is recorded or uploaded: your files and
          inputs never leave your device.
        </p>
      </template>
    </div>
  </div>
</template>
