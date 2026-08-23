<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef } from "vue";
import { Download, Gamepad2, Play, RotateCcw, Square, Trash2, Vibrate } from "lucide-vue-next";
import type { SelectOptionSpec, ToolMeta } from "@/tools/types";
import {
  analyzeDrift,
  circularityTest,
  describeButtons,
  detectVendor,
  run,
  vibrationSupport,
  type ButtonState,
  type SessionEvent,
  type StickSample,
  type VendorId,
} from "@/tools/gamepad-tester/index";
import { downloadText } from "@/lib/download";
import OutputView from "../OutputView.vue";
import CopyButton from "../CopyButton.vue";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SearchableSelect } from "@/components/ui/searchable-select";

/**
 * Bespoke panel for the Gamepad Tester.
 *
 * The generic ToolShell can only describe a pasted JSON report. A controller
 * has to be watched while it moves, so this panel owns the Gamepad API polling
 * loop, the SVG stick and button diagram, and the rumble request, while every
 * number it reports still comes from the pure logic layer (PROJECT.md rule 27):
 * detectVendor, describeButtons, analyzeDrift, circularityTest,
 * vibrationSupport, and run() for the full copyable record.
 *
 * Two clocks run here on purpose. The diagram redraws from a per frame
 * snapshot; the copyable record is rebuilt a few times a second from the same
 * data, because run() reparses the whole report and 60 rebuilds a second would
 * be wasted work. Polling starts only after a click, pauses whenever the tab is
 * hidden, and stops on unmount. Nothing is stored: your files and inputs never
 * leave your device.
 */
const props = defineProps<{ meta: ToolMeta }>();

/* ------------------------------------------------------------------ *
 * narrow Gamepad shapes
 *
 * lib.dom types vibrationActuator and hapticActuators differently across
 * TypeScript releases, so the panel declares only what it reads and casts at
 * the single point where a real Gamepad enters.
 * ------------------------------------------------------------------ */

interface RumbleEffect {
  duration: number;
  startDelay?: number;
  strongMagnitude?: number;
  weakMagnitude?: number;
}

interface ActuatorLike {
  type?: string;
  playEffect?: (type: string, params: RumbleEffect) => Promise<string>;
  pulse?: (value: number, duration: number) => Promise<boolean>;
}

interface GamepadButtonLike {
  pressed: boolean;
  touched?: boolean;
  value: number;
}

interface GamepadLike {
  index: number;
  id: string;
  mapping: string;
  connected: boolean;
  timestamp: number;
  buttons: readonly GamepadButtonLike[];
  axes: readonly number[];
  vibrationActuator?: ActuatorLike | null;
  hapticActuators?: readonly ActuatorLike[] | null;
}

interface GamepadEventLike extends Event {
  gamepad?: { index: number; id: string };
}

/* ------------------------------------------------------------------ *
 * constants
 * ------------------------------------------------------------------ */

/** How many recent stick positions the trail keeps. */
const TRAIL_POINTS = 90;
/** Hard caps: circularityTest and triggerRange spread their arrays into Math.min. */
const MAX_CIRCULARITY_SAMPLES = 600;
const MAX_TRIGGER_SAMPLES = 300;
const MAX_EVENTS = 400;
const MAX_LOG_ROWS = 120;
/** The drift window is wall clock, not frame counted, so a stall cannot stretch it. */
const DRIFT_DURATION_MS = 3000;
/** How often the copyable record and the polling estimate are rebuilt. */
const SNAPSHOT_INTERVAL_MS = 400;
/** Standard layout trigger slots, the two buttons that report a real analog range. */
const TRIGGER_INDEXES = [6, 7];
/** A circularity run below this mean radius did not move far enough to judge. */
const MIN_CIRCULARITY_RADIUS = 0.2;

const STICK_SIZE = 132;
const STICK_CENTER = STICK_SIZE / 2;
const STICK_RADIUS = 56;

const SIDES = ["left", "right"] as const;

const VENDOR_VALUES = new Set<string>(["xbox", "playstation", "switch", "generic"]);

/* ------------------------------------------------------------------ *
 * options, read from the tool meta so the panel and the shell agree
 * ------------------------------------------------------------------ */

function numberDefault(id: string, fallback: number): number {
  const found = props.meta.options?.find((o) => o.id === id);
  return found && found.kind === "number" ? found.default : fallback;
}

const labelSpec = computed<SelectOptionSpec | null>(() => {
  const found = props.meta.options?.find((o) => o.id === "labels");
  return found && found.kind === "select" ? found : null;
});

const deadzone = ref(numberDefault("deadzone", 0.05));
const labelsValue = ref<"auto" | VendorId>("auto");

function setLabels(next: string) {
  labelsValue.value = VENDOR_VALUES.has(next) ? (next as VendorId) : "auto";
}

function setDeadzone(next: string | number) {
  const value = Number(next);
  if (!Number.isFinite(value)) return;
  deadzone.value = Math.min(0.3, Math.max(0, value));
}

/* ------------------------------------------------------------------ *
 * reactive state
 * ------------------------------------------------------------------ */

interface PadEntry {
  index: number;
  id: string;
}

/** The stable facts about the selected pad, reassigned only when they change. */
interface PadShape {
  index: number;
  id: string;
  mapping: string;
  buttons: number;
  axes: number;
  vibration: string;
  canRumble: boolean;
}

interface Point {
  x: number;
  y: number;
}

/** One frame of live state, rebuilt every animation frame. */
interface LiveFrame {
  index: number;
  id: string;
  mapping: string;
  timestamp: number;
  buttons: ButtonState[];
  axes: number[];
  left: Point;
  right: Point;
  leftTrail: string;
  rightTrail: string;
}

interface LogRow {
  key: number;
  time: string;
  text: string;
}

interface GamepadReport {
  gamepad: {
    id: string;
    mapping: string;
    buttons: number;
    axes: number;
    pressed: ButtonState[];
    axesValues: number[];
    vibrationActuator: { type?: string } | null;
    hapticActuators: unknown[] | null;
    triggerSamples: Record<string, number[]>;
  };
  driftSamples: StickSample[];
  circularity: StickSample[];
  buttonEvents: SessionEvent[];
}

// Both start false so the server render and the first client render agree; the
// real capability is read after mount, on the client only. Until `checked` is
// true the panel shows the neutral hint rather than an unsupported alert.
const checked = ref(false);
const supported = ref(false);
const running = ref(false);
const pads = ref<PadEntry[]>([]);
const selectedIndex = ref<number | null>(null);
const shape = ref<PadShape | null>(null);
const live = shallowRef<LiveFrame | null>(null);
const report = shallowRef<GamepadReport | null>(null);
const pollRate = ref("");
const events = ref<SessionEvent[]>([]);
const logRows = ref<LogRow[]>([]);
const showJson = ref(false);

type TestStick = "left" | "right";
const testStick = ref<TestStick>("left");
const driftPhase = ref<"idle" | "running" | "done">("idle");
const driftRemaining = ref(0);
const driftNote = ref("");
const driftStickUsed = ref<TestStick>("left");
const driftSamples = shallowRef<StickSample[]>([]);
const circActive = ref(false);
const circStickUsed = ref<TestStick>("left");
const circSamples = shallowRef<StickSample[]>([]);
const circCount = ref(0);
const rumbling = ref(false);
const rumbleNote = ref("");

/* ------------------------------------------------------------------ *
 * plain, non reactive stores: written every frame, read on redraw
 * ------------------------------------------------------------------ */

let frame: number | null = null;
let latestFrame: LiveFrame | null = null;
let lastPressed: boolean[] = [];
let lastTimestamp = -1;
let lastSnapshotAt = 0;
let padsKey = "";
let rowKey = 0;
let driftStartedAt = 0;
let driftBuffer: StickSample[] = [];
let circBuffer: StickSample[] = [];
let updateTimes: number[] = [];
const leftTrail: Point[] = [];
const rightTrail: Point[] = [];
const triggerStore = new Map<number, number[]>();

/* ------------------------------------------------------------------ *
 * reading the Gamepad API
 * ------------------------------------------------------------------ */

function readPads(): GamepadLike[] {
  if (typeof navigator === "undefined" || typeof navigator.getGamepads !== "function") return [];
  const list = navigator.getGamepads() as unknown as (GamepadLike | null)[];
  return list.filter((p): p is GamepadLike => p !== null && p.connected !== false);
}

/** Pads are resolved by index every frame: the array is sparse and shifts on disconnect. */
function readPad(index: number | null): GamepadLike | null {
  if (index === null) return null;
  return readPads().find((p) => p.index === index) ?? null;
}

function resetPadState() {
  leftTrail.length = 0;
  rightTrail.length = 0;
  triggerStore.clear();
  updateTimes = [];
  lastPressed = [];
  lastTimestamp = -1;
  latestFrame = null;
  live.value = null;
  shape.value = null;
  report.value = null;
  pollRate.value = "";
}

function refreshPads() {
  const list = readPads();
  const key = list.map((p) => `${p.index}:${p.id}`).join("|");
  if (key !== padsKey) {
    padsKey = key;
    pads.value = list.map((p) => ({ index: p.index, id: p.id }));
  }
  const stillThere = list.some((p) => p.index === selectedIndex.value);
  if (selectedIndex.value === null || !stillThere) {
    selectedIndex.value = list.length > 0 ? list[0].index : null;
    resetPadState();
  }
}

function selectPad(index: number) {
  if (selectedIndex.value === index) return;
  selectedIndex.value = index;
  resetPadState();
  refreshReport();
}

/* ------------------------------------------------------------------ *
 * labels, taken from the logic layer so nothing is renamed here
 * ------------------------------------------------------------------ */

const vendor = computed<VendorId>(() => {
  const chosen = labelsValue.value;
  return chosen === "auto" ? detectVendor(shape.value?.id ?? "") : chosen;
});

/**
 * describeButtons returns one labeled row per button in index order, so its
 * keys are the vendor correct names. The logic layer exports no direct label
 * lookup, so this probe is how the panel gets one without inventing names.
 */
const buttonLabels = computed<string[]>(() => {
  const count = shape.value?.buttons ?? 0;
  const fallback = Array.from({ length: count }, (_, i) => `Button ${i}`);
  if (count === 0) return fallback;
  const probe: ButtonState[] = Array.from({ length: count }, (_, index) => ({
    index,
    value: 0,
    pressed: false,
  }));
  const keys = Object.keys(describeButtons(probe, vendor.value));
  return keys.length === count ? keys : fallback;
});

/** Same idea for axes: run() names them, so a zeroed probe report yields the names. */
const axisLabels = computed<string[]>(() => {
  const current = shape.value;
  const count = current?.axes ?? 0;
  const fallback = Array.from({ length: count }, (_, i) => `Axis ${i}`);
  if (!current || count === 0) return fallback;
  try {
    const rows = run(
      JSON.stringify({
        gamepad: {
          id: current.id || "gamepad",
          mapping: current.mapping,
          buttons: current.buttons,
          axes: count,
          axesValues: new Array(count).fill(0),
        },
      }),
      { labels: vendor.value },
    );
    const names = Object.keys(rows)
      .filter((key) => key.startsWith("Axis "))
      .map((key) => key.slice("Axis ".length));
    return names.length === count ? names : fallback;
  } catch {
    return fallback;
  }
});

function axisName(index: number): string {
  return axisLabels.value[index] ?? `Axis ${index}`;
}

function buttonName(index: number): string {
  return buttonLabels.value[index] ?? `Button ${index}`;
}

/* ------------------------------------------------------------------ *
 * the polling loop
 * ------------------------------------------------------------------ */

function clockLabel(): string {
  const now = new Date();
  const pad = (n: number, width = 2) => String(n).padStart(width, "0");
  return `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

function pushEvent(event: SessionEvent, text: string) {
  const next = events.value.slice(-(MAX_EVENTS - 1));
  next.push(event);
  events.value = next;

  const rows = logRows.value.slice(0, MAX_LOG_ROWS - 1);
  rowKey += 1;
  rows.unshift({ key: rowKey, time: clockLabel(), text });
  logRows.value = rows;
}

function pushTrail(trail: Point[], x: number, y: number) {
  trail.push({ x, y });
  if (trail.length > TRAIL_POINTS) trail.splice(0, trail.length - TRAIL_POINTS);
}

function clampAxis(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-1, Math.min(1, value));
}

function stickOf(pad: GamepadLike, which: TestStick): Point {
  const base = which === "left" ? 0 : 2;
  return { x: clampAxis(pad.axes[base] ?? 0), y: clampAxis(pad.axes[base + 1] ?? 0) };
}

function updateShape(pad: GamepadLike) {
  const current = shape.value;
  if (
    current &&
    current.index === pad.index &&
    current.id === pad.id &&
    current.buttons === pad.buttons.length &&
    current.axes === pad.axes.length
  ) {
    return;
  }
  const actuator = pad.vibrationActuator ?? pad.hapticActuators?.[0] ?? null;
  shape.value = {
    index: pad.index,
    id: pad.id,
    mapping: pad.mapping || "",
    buttons: pad.buttons.length,
    axes: pad.axes.length,
    vibration: vibrationSupport({
      vibrationActuator: pad.vibrationActuator ? { type: pad.vibrationActuator.type } : null,
      hapticActuators: pad.hapticActuators ? Array.from(pad.hapticActuators) : null,
    }),
    canRumble: typeof actuator?.playEffect === "function" || typeof actuator?.pulse === "function",
  };
}

function recordTriggers(buttons: ButtonState[]) {
  for (const index of TRIGGER_INDEXES) {
    const button = buttons[index];
    if (!button) continue;
    const bucket = triggerStore.get(index) ?? [];
    const previous = bucket[bucket.length - 1];
    // Only transitions are kept, so a long hold does not flush the extremes out.
    if (previous === undefined || Math.abs(previous - button.value) > 0.001) {
      bucket.push(button.value);
      if (bucket.length > MAX_TRIGGER_SAMPLES) bucket.shift();
      triggerStore.set(index, bucket);
    }
  }
}

function tracePoints(samples: Point[]): string {
  return samples.map((s) => `${toPx(s.x).toFixed(1)},${toPx(s.y).toFixed(1)}`).join(" ");
}

function toPx(value: number): number {
  return STICK_CENTER + clampAxis(value) * STICK_RADIUS;
}

/* Small readers so the stick markup stays free of nested ternaries. */

function stickPoint(side: TestStick): Point {
  const current = live.value;
  if (!current) return { x: 0, y: 0 };
  return side === "left" ? current.left : current.right;
}

function stickTrail(side: TestStick): string {
  const current = live.value;
  if (!current) return "";
  return side === "left" ? current.leftTrail : current.rightTrail;
}

function stickHeading(side: TestStick): string {
  return side === "left" ? "Left stick" : "Right stick";
}

function stickAria(side: TestStick): string {
  const point = stickPoint(side);
  return `${stickHeading(side)} position, x ${point.x.toFixed(2)}, y ${point.y.toFixed(2)}`;
}

function tick() {
  frame = requestAnimationFrame(tick);
  const now = performance.now();
  const pad = readPad(selectedIndex.value);

  if (!pad) {
    live.value = null;
    latestFrame = null;
    if (now - lastSnapshotAt >= SNAPSHOT_INTERVAL_MS) {
      lastSnapshotAt = now;
      refreshPads();
    }
    return;
  }

  updateShape(pad);

  const buttons: ButtonState[] = pad.buttons.map((button, index) => ({
    index,
    value: Number.isFinite(button.value) ? button.value : button.pressed ? 1 : 0,
    pressed: button.pressed === true,
    touched: button.touched === true,
  }));

  for (let i = 0; i < buttons.length; i += 1) {
    const wasPressed = lastPressed[i] === true;
    const isPressed = buttons[i].pressed;
    if (wasPressed === isPressed) continue;
    pushEvent(
      { type: isPressed ? "buttondown" : "buttonup", index: i, t: now },
      `${buttonName(i)} ${isPressed ? "pressed" : "released"}`,
    );
  }
  lastPressed = buttons.map((button) => button.pressed);

  recordTriggers(buttons);

  const leftStick = stickOf(pad, "left");
  const rightStick = stickOf(pad, "right");
  pushTrail(leftTrail, leftStick.x, leftStick.y);
  pushTrail(rightTrail, rightStick.x, rightStick.y);

  if (pad.timestamp !== lastTimestamp) {
    lastTimestamp = pad.timestamp;
    updateTimes.push(now);
    if (updateTimes.length > 90) updateTimes.shift();
  }

  const testPoint = testStick.value === "left" ? leftStick : rightStick;

  if (driftPhase.value === "running") {
    driftBuffer.push({ t: now, x: testPoint.x, y: testPoint.y });
    const elapsed = now - driftStartedAt;
    driftRemaining.value = Math.max(0, Math.ceil((DRIFT_DURATION_MS - elapsed) / 100) / 10);
    if (elapsed >= DRIFT_DURATION_MS) finishDriftTest();
  }

  if (circActive.value) {
    circBuffer.push({ t: now, x: testPoint.x, y: testPoint.y });
    if (circBuffer.length >= MAX_CIRCULARITY_SAMPLES) stopCircularityTest();
  }

  latestFrame = {
    index: pad.index,
    id: pad.id,
    mapping: pad.mapping || "",
    timestamp: pad.timestamp,
    buttons,
    axes: pad.axes.map((value) => (Number.isFinite(value) ? value : 0)),
    left: leftStick,
    right: rightStick,
    leftTrail: tracePoints(leftTrail),
    rightTrail: tracePoints(rightTrail),
  };
  live.value = latestFrame;

  if (now - lastSnapshotAt >= SNAPSHOT_INTERVAL_MS) {
    lastSnapshotAt = now;
    refreshPads();
    updatePollRate();
    if (circActive.value) circCount.value = circBuffer.length;
    refreshReport();
  }
}

function updatePollRate() {
  if (updateTimes.length < 8) {
    pollRate.value = "";
    return;
  }
  const span = updateTimes[updateTimes.length - 1] - updateTimes[0];
  pollRate.value =
    span > 0 ? `${Math.round(((updateTimes.length - 1) * 1000) / span)} updates per second` : "";
}

function startLoop() {
  if (frame !== null) return;
  lastSnapshotAt = 0;
  frame = requestAnimationFrame(tick);
}

function cancelLoop() {
  if (frame !== null) cancelAnimationFrame(frame);
  frame = null;
}

function start() {
  if (!supported.value || running.value) return;
  running.value = true;
  refreshPads();
  startLoop();
}

function stop() {
  if (!running.value) return;
  running.value = false;
  cancelLoop();
  abortDriftTest("The drift test stopped when polling stopped. Start it again for a clean run.");
  if (circActive.value) stopCircularityTest();
  refreshReport();
}

/* ------------------------------------------------------------------ *
 * the copyable record
 * ------------------------------------------------------------------ */

function buildReport(): GamepadReport | null {
  const current = latestFrame;
  if (!current) return null;
  const pad = readPad(current.index);
  const triggerSamples: Record<string, number[]> = {};
  for (const [index, values] of triggerStore) {
    if (values.length > 1) triggerSamples[String(index)] = values.slice();
  }
  return {
    gamepad: {
      id: current.id,
      mapping: current.mapping,
      buttons: current.buttons.length,
      axes: current.axes.length,
      pressed: current.buttons,
      axesValues: current.axes,
      vibrationActuator: pad?.vibrationActuator ? { type: pad.vibrationActuator.type } : null,
      hapticActuators: pad?.hapticActuators ? pad.hapticActuators.map(() => ({})) : null,
      triggerSamples,
    },
    driftSamples: driftSamples.value,
    circularity: circSamples.value,
    buttonEvents: events.value,
  };
}

function refreshReport() {
  report.value = buildReport();
}

const reportJson = computed(() => (report.value ? JSON.stringify(report.value) : ""));
const prettyJson = computed(() => (report.value ? JSON.stringify(report.value, null, 2) : ""));

/** The whole readout, formatted by the logic layer. Empty input yields its designed idle state. */
const snapshot = computed<Record<string, string>>(() => {
  try {
    return run(reportJson.value, { deadzone: deadzone.value, labels: labelsValue.value });
  } catch {
    return run("", {});
  }
});

function saveJson() {
  if (!prettyJson.value) return;
  downloadText(prettyJson.value, "gamepad-report.json", "application/json");
}

/* ------------------------------------------------------------------ *
 * drift and circularity tests
 * ------------------------------------------------------------------ */

const stickLabel = computed(() => (testStick.value === "left" ? "left stick" : "right stick"));

function stickWord(which: TestStick): string {
  return which === "left" ? "left stick" : "right stick";
}

function setTestStick(next: TestStick) {
  if (testStick.value === next) return;
  testStick.value = next;
  abortDriftTest("");
  if (circActive.value) stopCircularityTest();
}

function startDriftTest() {
  if (!running.value || !live.value) return;
  driftBuffer = [];
  driftSamples.value = [];
  driftNote.value = "";
  driftStickUsed.value = testStick.value;
  driftStartedAt = performance.now();
  driftRemaining.value = DRIFT_DURATION_MS / 1000;
  driftPhase.value = "running";
}

function finishDriftTest() {
  driftSamples.value = driftBuffer.slice();
  driftBuffer = [];
  driftPhase.value = "done";
  driftRemaining.value = 0;
  refreshReport();
}

/** A hidden tab freezes requestAnimationFrame, so an interrupted run is thrown away. */
function abortDriftTest(reason: string) {
  if (driftPhase.value !== "running") return;
  driftBuffer = [];
  driftPhase.value = "idle";
  driftRemaining.value = 0;
  driftNote.value = reason;
}

function startCircularityTest() {
  if (!running.value || !live.value) return;
  circBuffer = [];
  circSamples.value = [];
  circStickUsed.value = testStick.value;
  circCount.value = 0;
  circActive.value = true;
}

function stopCircularityTest() {
  if (!circActive.value) return;
  circActive.value = false;
  circSamples.value = circBuffer.slice();
  circBuffer = [];
  circCount.value = circSamples.value.length;
  refreshReport();
}

const driftResult = computed(() =>
  driftSamples.value.length > 0
    ? analyzeDrift(driftSamples.value, { deadzone: deadzone.value })
    : null,
);

const driftRows = computed<Record<string, string>>(() => {
  const result = driftResult.value;
  if (!result) return {} as Record<string, string>;
  return {
    Verdict: result.verdict,
    "Mean offset": `x=${result.meanX.toFixed(4)}, y=${result.meanY.toFixed(4)}`,
    Magnitude: result.magnitude.toFixed(4),
    "Max magnitude": result.maxMagnitude.toFixed(4),
    "Standard deviation": result.stdDev.toFixed(4),
    "Outside deadzone": `${result.percentOutsideDeadzone.toFixed(1)}%`,
    "Suggested deadzone": result.suggestedDeadzone.toFixed(2),
    Samples: String(driftSamples.value.length),
  };
});

const circResult = computed(() =>
  circSamples.value.length > 0 ? circularityTest(circSamples.value) : null,
);

/** An untouched stick traces a dot, and a dot has a perfect error of zero. Say so instead. */
const circJudgeable = computed(() => (circResult.value?.meanRadius ?? 0) >= MIN_CIRCULARITY_RADIUS);

const circRows = computed<Record<string, string>>(() => {
  const result = circResult.value;
  if (!result) return {} as Record<string, string>;
  return {
    "Min radius": result.minRadius.toFixed(3),
    "Max radius": result.maxRadius.toFixed(3),
    "Mean radius": result.meanRadius.toFixed(3),
    "Radius error": `${result.errorPercent.toFixed(1)}%`,
    Samples: String(circSamples.value.length),
  };
});

const circTrace = computed(() => tracePoints(circSamples.value));

function clearSession() {
  if (circActive.value) stopCircularityTest();
  driftBuffer = [];
  events.value = [];
  logRows.value = [];
  triggerStore.clear();
  leftTrail.length = 0;
  rightTrail.length = 0;
  updateTimes = [];
  pollRate.value = "";
  driftSamples.value = [];
  driftPhase.value = "idle";
  driftNote.value = "";
  circSamples.value = [];
  circCount.value = 0;
  rumbleNote.value = "";
  refreshReport();
}

/* ------------------------------------------------------------------ *
 * rumble
 * ------------------------------------------------------------------ */

async function testRumble() {
  const pad = readPad(selectedIndex.value);
  const actuator = pad?.vibrationActuator ?? pad?.hapticActuators?.[0] ?? null;
  if (!actuator) {
    rumbleNote.value =
      "This browser does not expose a rumble motor for this controller, so there is nothing to trigger. Chrome and Edge support it on most wired and Bluetooth pads; Safari and Firefox do not.";
    return;
  }
  rumbling.value = true;
  rumbleNote.value = "";
  try {
    if (typeof actuator.playEffect === "function") {
      await actuator.playEffect("dual-rumble", {
        duration: 600,
        strongMagnitude: 1,
        weakMagnitude: 0.6,
      });
      rumbleNote.value =
        "Rumble sent. If you felt nothing, the pad may be connected over a transport that carries input but not output, which is common for Bluetooth PlayStation pads on desktop.";
    } else if (typeof actuator.pulse === "function") {
      await actuator.pulse(1, 600);
      rumbleNote.value = "Pulse sent through the older haptic actuator interface.";
    } else {
      rumbleNote.value = "The actuator this controller reports offers no way to trigger it.";
    }
  } catch (error) {
    rumbleNote.value = `The browser refused the rumble request: ${
      error instanceof Error ? error.message : String(error)
    }.`;
  } finally {
    rumbling.value = false;
  }
}

/* ------------------------------------------------------------------ *
 * lifecycle
 * ------------------------------------------------------------------ */

function onConnected(event: Event) {
  const detail = event as GamepadEventLike;
  const index = detail.gamepad?.index;
  refreshPads();
  pushEvent(
    { type: "connect", index, t: performance.now() },
    `Controller ${index ?? "?"} connected`,
  );
}

function onDisconnected(event: Event) {
  const detail = event as GamepadEventLike;
  const index = detail.gamepad?.index;
  pushEvent(
    { type: "disconnect", index, t: performance.now() },
    `Controller ${index ?? "?"} disconnected`,
  );
  refreshPads();
}

function onVisibilityChange() {
  if (typeof document === "undefined") return;
  if (document.visibilityState === "hidden") {
    cancelLoop();
    abortDriftTest("The drift test was canceled because the tab went to the background.");
  } else if (running.value) {
    startLoop();
  }
}

onMounted(() => {
  supported.value = typeof navigator !== "undefined" && typeof navigator.getGamepads === "function";
  checked.value = true;
  window.addEventListener("gamepadconnected", onConnected);
  window.addEventListener("gamepaddisconnected", onDisconnected);
  document.addEventListener("visibilitychange", onVisibilityChange);
  if (supported.value) refreshPads();
});

onUnmounted(() => {
  cancelLoop();
  window.removeEventListener("gamepadconnected", onConnected);
  window.removeEventListener("gamepaddisconnected", onDisconnected);
  document.removeEventListener("visibilitychange", onVisibilityChange);
});
</script>

<template>
  <div class="flex flex-col gap-4">
    <!-- ============================================================ -->
    <!-- controls                                                     -->
    <!-- ============================================================ -->
    <div class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
      <div class="flex flex-wrap items-center justify-between gap-3">
        <p class="max-w-[52ch] text-xs text-muted-foreground">
          Everything here is read from the browser's Gamepad API on this machine: your files and
          inputs never leave your device.
        </p>
        <div class="flex items-center gap-2">
          <Button v-if="!running" :disabled="!supported" @click="start">
            <Play class="size-4" aria-hidden="true" />
            Start polling
          </Button>
          <Button v-else variant="secondary" @click="stop">
            <Square class="size-4" aria-hidden="true" />
            Stop polling
          </Button>
          <Button variant="ghost" size="sm" @click="clearSession">
            <Trash2 class="size-3.5" aria-hidden="true" />
            Clear
          </Button>
        </div>
      </div>

      <p
        v-if="checked && !supported"
        role="alert"
        class="rounded-[10px] bg-secondary p-3 text-xs text-muted-foreground shadow-[var(--sh-inset)]"
      >
        This browser does not expose the Gamepad API, so no controller can be read here. Chrome,
        Edge, Firefox, and Safari all support it in recent versions; a page served over plain HTTP
        or inside a restricted iframe may not get it.
      </p>

      <div v-else-if="pads.length === 0" class="flex items-start gap-3 text-sm">
        <Gamepad2 class="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden="true" />
        <p class="text-muted-foreground">
          No controller detected yet. Connect one, then press any button on it: browsers hide
          connected gamepads from a page until you interact with one.
        </p>
      </div>

      <div v-else class="flex flex-col gap-2">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase"
          >Controller</span
        >
        <div class="flex flex-wrap gap-1 rounded-[10px] bg-secondary p-1 shadow-[var(--sh-inset)]">
          <Button
            v-for="pad in pads"
            :key="pad.index"
            variant="ghost"
            size="sm"
            class="max-w-full"
            :aria-pressed="pad.index === selectedIndex"
            :class="pad.index === selectedIndex ? 'bg-card shadow-[var(--sh-sm)]' : ''"
            :title="pad.id"
            @click="selectPad(pad.index)"
          >
            <span class="truncate">{{ pad.index }}: {{ pad.id }}</span>
          </Button>
        </div>
      </div>
    </div>

    <!-- ============================================================ -->
    <!-- live view                                                    -->
    <!-- ============================================================ -->
    <div
      v-if="live"
      class="flex flex-col gap-5 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6"
    >
      <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div class="min-w-0">
          <div class="text-xs text-muted-foreground">Controller</div>
          <div class="truncate font-mono text-sm" :title="live.id">{{ live.id }}</div>
        </div>
        <div>
          <div class="text-xs text-muted-foreground">Mapping</div>
          <div class="font-mono text-sm">{{ live.mapping || "not reported" }}</div>
        </div>
        <div>
          <div class="text-xs text-muted-foreground">Timestamp</div>
          <div class="font-mono text-sm tabular-nums">{{ live.timestamp.toFixed(1) }}</div>
        </div>
        <div>
          <div class="text-xs text-muted-foreground">Polling rate estimate</div>
          <div class="font-mono text-sm tabular-nums">{{ pollRate || "measuring" }}</div>
        </div>
      </div>

      <!-- sticks -->
      <div class="flex flex-wrap gap-6">
        <div v-for="side in SIDES" :key="side" class="flex flex-col gap-2">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            {{ stickHeading(side) }}
          </span>
          <svg
            :width="STICK_SIZE"
            :height="STICK_SIZE"
            :viewBox="`0 0 ${STICK_SIZE} ${STICK_SIZE}`"
            class="text-primary"
            role="img"
            :aria-label="stickAria(side)"
          >
            <g class="text-border" stroke="currentColor" fill="none">
              <circle :cx="STICK_CENTER" :cy="STICK_CENTER" :r="STICK_RADIUS" />
              <line
                :x1="STICK_CENTER - STICK_RADIUS"
                :y1="STICK_CENTER"
                :x2="STICK_CENTER + STICK_RADIUS"
                :y2="STICK_CENTER"
                opacity="0.6"
              />
              <line
                :x1="STICK_CENTER"
                :y1="STICK_CENTER - STICK_RADIUS"
                :x2="STICK_CENTER"
                :y2="STICK_CENTER + STICK_RADIUS"
                opacity="0.6"
              />
            </g>
            <circle
              :cx="STICK_CENTER"
              :cy="STICK_CENTER"
              :r="Math.max(deadzone * STICK_RADIUS, 1)"
              fill="none"
              stroke="currentColor"
              stroke-dasharray="3 3"
              opacity="0.45"
            />
            <polyline
              v-if="circSamples.length > 0 && circStickUsed === side"
              :points="circTrace"
              fill="none"
              stroke="currentColor"
              stroke-width="1"
              opacity="0.35"
            />
            <polyline
              :points="stickTrail(side)"
              fill="none"
              stroke="currentColor"
              stroke-width="1.5"
              opacity="0.3"
            />
            <circle
              :cx="toPx(stickPoint(side).x)"
              :cy="toPx(stickPoint(side).y)"
              r="6"
              fill="currentColor"
            />
          </svg>
          <div class="font-mono text-xs text-muted-foreground tabular-nums">
            {{ axisName(side === "left" ? 0 : 2) }}: {{ stickPoint(side).x.toFixed(3) }}
          </div>
          <div class="font-mono text-xs text-muted-foreground tabular-nums">
            {{ axisName(side === "left" ? 1 : 3) }}: {{ stickPoint(side).y.toFixed(3) }}
          </div>
        </div>

        <!-- any axes beyond the standard four -->
        <div v-if="live.axes.length > 4" class="flex min-w-[180px] flex-col gap-2">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase"
            >Other axes</span
          >
          <div
            v-for="(value, index) in live.axes.slice(4)"
            :key="index"
            class="font-mono text-xs text-muted-foreground tabular-nums"
          >
            {{ axisName(index + 4) }}: {{ value.toFixed(3) }}
          </div>
        </div>
      </div>

      <!-- buttons -->
      <div class="flex flex-col gap-2">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase"
          >Buttons</span
        >
        <div class="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          <div
            v-for="button in live.buttons"
            :key="button.index"
            class="flex flex-col gap-1 rounded-[10px] px-3 py-2 transition-colors"
            :class="
              button.pressed
                ? 'bg-[image:var(--grad-brand-soft)] ring-1 ring-[color:var(--brand-hairline)]'
                : 'bg-secondary shadow-[var(--sh-inset)]'
            "
          >
            <div class="flex items-baseline justify-between gap-2">
              <span class="truncate text-sm" :title="buttonName(button.index)">
                {{ buttonName(button.index) }}
              </span>
              <span class="font-mono text-xs text-muted-foreground tabular-nums">
                {{ button.value.toFixed(2) }}
              </span>
            </div>
            <div class="h-1.5 overflow-hidden rounded-full bg-card">
              <div
                class="h-full rounded-full bg-primary transition-[width] duration-100"
                :style="{ width: `${Math.round(Math.min(1, Math.max(0, button.value)) * 100)}%` }"
              />
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ============================================================ -->
    <!-- tests                                                        -->
    <!-- ============================================================ -->
    <div class="flex flex-col gap-5 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
      <div class="flex flex-wrap items-end gap-4">
        <div class="flex flex-col gap-1.5">
          <span class="text-xs text-muted-foreground">Stick under test</span>
          <div class="inline-flex gap-1 rounded-[10px] bg-secondary p-1 shadow-[var(--sh-inset)]">
            <Button
              variant="ghost"
              size="sm"
              :aria-pressed="testStick === 'left'"
              :class="testStick === 'left' ? 'bg-card shadow-[var(--sh-sm)]' : ''"
              @click="setTestStick('left')"
            >
              Left stick
            </Button>
            <Button
              variant="ghost"
              size="sm"
              :aria-pressed="testStick === 'right'"
              :class="testStick === 'right' ? 'bg-card shadow-[var(--sh-sm)]' : ''"
              @click="setTestStick('right')"
            >
              Right stick
            </Button>
          </div>
        </div>

        <div class="flex flex-col gap-1.5">
          <Label for="gamepad-deadzone" class="text-xs text-muted-foreground">Deadzone</Label>
          <Input
            id="gamepad-deadzone"
            type="number"
            min="0"
            max="0.3"
            step="0.01"
            :model-value="deadzone"
            class="h-9 w-28 bg-card tabular-nums"
            @update:model-value="setDeadzone"
          />
        </div>

        <div v-if="labelSpec" class="flex min-w-[220px] flex-col gap-1.5">
          <Label for="gamepad-labels" class="text-xs text-muted-foreground">Button labels</Label>
          <SearchableSelect
            id="gamepad-labels"
            :spec="labelSpec"
            :model-value="labelsValue"
            @update:model-value="(v: string) => setLabels(v)"
          />
        </div>
      </div>

      <!-- drift -->
      <div class="flex flex-col gap-3 rounded-[10px] bg-secondary p-4 shadow-[var(--sh-inset)]">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div class="min-w-0">
            <h3 class="text-[17px] leading-[1.35] font-semibold">Stick drift test</h3>
            <p class="text-sm text-muted-foreground">
              Take your hands off the controller, then run a three second reading of the
              {{ stickLabel }} at rest.
            </p>
          </div>
          <Button :disabled="!running || !live || driftPhase === 'running'" @click="startDriftTest">
            <RotateCcw class="size-4" aria-hidden="true" />
            {{ driftPhase === "running" ? "Measuring" : "Run drift test" }}
          </Button>
        </div>

        <p v-if="driftPhase === 'running'" class="font-mono text-sm tabular-nums">
          Hold still: {{ driftRemaining.toFixed(1) }}s left
        </p>
        <p v-else-if="driftNote" class="text-sm text-muted-foreground">{{ driftNote }}</p>

        <div v-if="driftSamples.length > 0 && driftPhase !== 'running'" class="flex flex-col gap-2">
          <span class="text-xs text-muted-foreground">
            Measured on the {{ stickWord(driftStickUsed) }}
          </span>
          <div class="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <div v-for="(value, key) in driftRows" :key="key" class="min-w-0">
              <div class="text-xs text-muted-foreground">{{ key }}</div>
              <div class="font-mono text-sm break-words tabular-nums">{{ value }}</div>
            </div>
          </div>
        </div>
        <p v-else-if="driftPhase === 'idle' && !driftNote" class="text-xs text-muted-foreground">
          No reading yet. The result reports the resting offset, how noisy it is, and a deadzone
          that would cover it.
        </p>
      </div>

      <!-- circularity -->
      <div class="flex flex-col gap-3 rounded-[10px] bg-secondary p-4 shadow-[var(--sh-inset)]">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div class="min-w-0">
            <h3 class="text-[17px] leading-[1.35] font-semibold">Circularity test</h3>
            <p class="text-sm text-muted-foreground">
              Start the recording, then roll the {{ stickLabel }} slowly around its full outer edge
              two or three times.
            </p>
          </div>
          <Button
            v-if="!circActive"
            :disabled="!running || !live"
            variant="secondary"
            @click="startCircularityTest"
          >
            <Play class="size-4" aria-hidden="true" />
            Record a circle
          </Button>
          <Button v-else @click="stopCircularityTest">
            <Square class="size-4" aria-hidden="true" />
            Stop recording
          </Button>
        </div>

        <p v-if="circActive" class="font-mono text-sm tabular-nums">
          Recording: {{ circCount }} of {{ MAX_CIRCULARITY_SAMPLES }} samples
        </p>

        <template v-if="circSamples.length > 0 && !circActive">
          <span class="text-xs text-muted-foreground">
            Measured on the {{ stickWord(circStickUsed) }}
          </span>
          <p v-if="!circJudgeable" class="text-sm text-muted-foreground">
            Not enough movement to judge. The stick stayed near the center, so the radius numbers
            below describe a dot rather than a circle. Record again and push the stick all the way
            to its outer edge.
          </p>
          <div class="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
            <div v-for="(value, key) in circRows" :key="key" class="min-w-0">
              <div class="text-xs text-muted-foreground">{{ key }}</div>
              <div class="font-mono text-sm break-words tabular-nums">{{ value }}</div>
            </div>
          </div>
          <p v-if="circJudgeable" class="text-xs text-muted-foreground">
            Radius error is the spread between the smallest and largest radius, as a percent of the
            mean. A healthy stick traces a near constant radius; a worn one traces an oval.
          </p>
        </template>
        <p v-else-if="!circActive" class="text-xs text-muted-foreground">
          No recording yet. The trace is drawn over the matching stick above once you stop.
        </p>
      </div>

      <!-- rumble -->
      <div class="flex flex-col gap-3 rounded-[10px] bg-secondary p-4 shadow-[var(--sh-inset)]">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <div class="min-w-0">
            <h3 class="text-[17px] leading-[1.35] font-semibold">Vibration test</h3>
            <p class="text-sm text-muted-foreground">
              {{
                shape ? shape.vibration : "Connect a controller to see whether it reports a motor."
              }}
            </p>
          </div>
          <Button
            variant="secondary"
            :disabled="!shape || !shape.canRumble || rumbling"
            @click="testRumble"
          >
            <Vibrate class="size-4" aria-hidden="true" />
            {{ rumbling ? "Rumbling" : "Test rumble" }}
          </Button>
        </div>
        <p v-if="rumbleNote" class="text-sm text-muted-foreground" aria-live="polite">
          {{ rumbleNote }}
        </p>
        <p v-else-if="shape && !shape.canRumble" class="text-xs text-muted-foreground">
          Rumble is not available for this controller in this browser, so the button stays off. That
          is a browser and transport limit, not a fault in the pad.
        </p>
      </div>
    </div>

    <!-- ============================================================ -->
    <!-- output                                                       -->
    <!-- ============================================================ -->
    <div class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
      <OutputView :output="snapshot" />

      <div class="flex flex-wrap items-center justify-between gap-2">
        <Button variant="ghost" size="sm" :disabled="!report" @click="showJson = !showJson">
          {{ showJson ? "Hide raw JSON" : "Show raw JSON" }}
        </Button>
        <div class="flex items-center gap-1">
          <CopyButton v-if="showJson && prettyJson" :text="prettyJson" label="Copy JSON" />
          <Button variant="ghost" size="sm" :disabled="!report" @click="saveJson">
            <Download class="size-3.5" aria-hidden="true" />
            Download JSON
          </Button>
        </div>
      </div>

      <pre
        v-if="showJson && prettyJson"
        class="max-h-80 overflow-auto rounded-[10px] bg-secondary px-3 py-2 font-mono text-xs shadow-[var(--sh-inset)]"
        >{{ prettyJson }}</pre>

      <div v-if="logRows.length > 0" class="flex flex-col gap-2">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase"
          >Event log</span
        >
        <div
          class="max-h-56 overflow-y-auto rounded-[10px] bg-secondary shadow-[var(--sh-inset)]"
          role="log"
        >
          <div
            v-for="row in logRows"
            :key="row.key"
            class="flex gap-3 px-3 py-1 font-mono text-xs even:bg-card/40"
          >
            <span class="shrink-0 text-muted-foreground tabular-nums">{{ row.time }}</span>
            <span class="truncate">{{ row.text }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>
