<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import {
  CircleAlert,
  Compass as CompassIcon,
  Gauge,
  RadioTower,
  SunMedium,
  TabletSmartphone,
  Waves,
} from 'lucide-vue-next';
import type { ToolMeta } from '@/tools/types';
import { Button } from '@/components/ui/button';
import {
  bubbleLevelOffset,
  compassDirection,
  compassHeading,
  lowPassFilter,
  lowPassFilterVector,
  run,
  vectorMagnitude,
  type Vector3,
} from '@/tools/mobile-sensors/index';
import OutputView from '../OutputView.vue';

/**
 * Bespoke panel for the Mobile Sensors Explorer. The pure layer in
 * `src/tools/mobile-sensors` only knows the math (heading, tilt, vector
 * magnitude, low-pass smoothing), because DeviceMotionEvent,
 * DeviceOrientationEvent, the iOS permission gesture, and the Generic
 * Sensor API constructors only exist in a real browser session. This panel
 * owns all of that: it starts listening only after a real click (iOS
 * requires the permission request to originate from a user gesture), feeds
 * every raw reading through the pure formulas, and renders a compass,
 * a bubble level and the raw values live. Nothing is ever sent anywhere;
 * readings live in this component's memory only.
 */
defineProps<{ meta: ToolMeta }>();

/* ------------------------------------------------------------------ *
 * browser shapes not in lib.dom
 * ------------------------------------------------------------------ */

interface IosPermissionEventCtor {
  requestPermission?: () => Promise<'granted' | 'denied'>;
}

interface IosOrientationEvent {
  webkitCompassHeading?: number;
}

interface GenericSensorLike extends EventTarget {
  x?: number;
  y?: number;
  z?: number;
  illuminance?: number;
  quaternion?: number[];
  start(): void;
  stop(): void;
}

interface GenericSensorCtor {
  new (options?: { frequency?: number }): GenericSensorLike;
}

function sensorCtor(name: string): GenericSensorCtor | undefined {
  return (window as unknown as Record<string, unknown>)[name] as GenericSensorCtor | undefined;
}

function screenAngle(): number {
  const withOrientation = screen as Screen & { orientation?: { angle: number } };
  if (withOrientation.orientation && typeof withOrientation.orientation.angle === 'number') {
    return withOrientation.orientation.angle;
  }
  const legacy = (window as Window & { orientation?: number }).orientation;
  return typeof legacy === 'number' ? legacy : 0;
}

/* ------------------------------------------------------------------ *
 * constants
 * ------------------------------------------------------------------ */

/** How long to wait after enabling before deciding no sensor data is coming. */
const WATCHDOG_MS = 2500;
/** Weight given to each new pitch/roll/acceleration sample (see lowPassFilter). */
const SMOOTHING = 0.25;

/* ------------------------------------------------------------------ *
 * state
 * ------------------------------------------------------------------ */

type Phase = 'idle' | 'waiting' | 'live' | 'unsupported' | 'denied' | 'error';

const phase = ref<Phase>('idle');
const errorDetail = ref<string | null>(null);

const hasOrientationApi = typeof window !== 'undefined' && 'DeviceOrientationEvent' in window;
const hasMotionApi = typeof window !== 'undefined' && 'DeviceMotionEvent' in window;

const needsIosPermission = computed(() => {
  if (typeof window === 'undefined') return false;
  const ctor = window.DeviceMotionEvent as unknown as IosPermissionEventCtor;
  return typeof ctor?.requestPermission === 'function';
});

// device orientation
const heading = ref<number | null>(null);
const usingTrueHeading = ref(false);
const smoothPitch = ref<number | null>(null);
const smoothRoll = ref<number | null>(null);
const tiltMagnitude = ref<number | null>(null);

// device motion
const acceleration = ref<Vector3 | null>(null);
const accelerationGravity = ref<Vector3 | null>(null);
const rotationRate = ref<{ alpha: number; beta: number; gamma: number } | null>(null);

// generic sensor api
interface GenericReading {
  supported: boolean;
  live: boolean;
  error: string | null;
  value: string | null;
}

function emptyReading(): GenericReading {
  return { supported: false, live: false, error: null, value: null };
}

const genericAccelerometer = ref<GenericReading>(emptyReading());
const genericGyroscope = ref<GenericReading>(emptyReading());
const genericMagnetometer = ref<GenericReading>(emptyReading());
const genericAmbientLight = ref<GenericReading>(emptyReading());

let watchdogTimer: ReturnType<typeof setTimeout> | null = null;
const cleanupFns: (() => void)[] = [];

/* ------------------------------------------------------------------ *
 * display helpers
 * ------------------------------------------------------------------ */

function round(value: number, places = 1): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

const headingLabel = computed(() =>
  heading.value === null ? '--' : `${round(heading.value)}° ${compassDirection(heading.value)}`,
);
const pitchLabel = computed(() =>
  smoothPitch.value === null ? '--' : `${round(smoothPitch.value)}°`,
);
const rollLabel = computed(() =>
  smoothRoll.value === null ? '--' : `${round(smoothRoll.value)}°`,
);
const isLevel = computed(() => tiltMagnitude.value !== null && tiltMagnitude.value < 1.5);

const bubble = computed(() => {
  if (smoothPitch.value === null || smoothRoll.value === null) return { x: 0, y: 0 };
  return bubbleLevelOffset(smoothPitch.value, smoothRoll.value, 45);
});

function vectorLabel(v: Vector3 | null): string {
  if (!v) return '--';
  return `${round(vectorMagnitude(v.x, v.y, v.z), 2)} m/s²`;
}

function vectorDetail(v: Vector3 | null): string {
  if (!v) return '';
  return `x ${round(v.x, 2)}  y ${round(v.y, 2)}  z ${round(v.z, 2)}`;
}

const rotationRateLabel = computed(() => {
  const r = rotationRate.value;
  if (!r) return '--';
  return `${round(vectorMagnitude(r.alpha, r.beta, r.gamma), 1)} deg/s`;
});
const rotationRateDetail = computed(() => {
  const r = rotationRate.value;
  if (!r) return '';
  return `alpha ${round(r.alpha, 1)}  beta ${round(r.beta, 1)}  gamma ${round(r.gamma, 1)}`;
});

/** A JSON snapshot matching the pure tool's input shape, for the copy button. */
const snapshotOutput = computed<Record<string, string> | null>(() => {
  if (phase.value !== 'live') return null;
  const snapshot: Record<string, unknown> = {};
  if (heading.value !== null && smoothPitch.value !== null && smoothRoll.value !== null) {
    // Reconstruct an alpha that reproduces the displayed heading exactly, so
    // the copied snapshot round-trips through run() without depending on
    // whichever device supplied webkitCompassHeading or alpha originally.
    snapshot.orientation = {
      alpha: 360 - heading.value,
      beta: smoothPitch.value,
      gamma: smoothRoll.value,
    };
  }
  if (acceleration.value) snapshot.acceleration = acceleration.value;
  if (accelerationGravity.value) snapshot.accelerationIncludingGravity = accelerationGravity.value;
  if (rotationRate.value) snapshot.rotationRate = rotationRate.value;
  if (Object.keys(snapshot).length === 0) return null;
  try {
    return run(JSON.stringify(snapshot), {});
  } catch {
    return null;
  }
});

/* ------------------------------------------------------------------ *
 * device orientation / motion listeners
 * ------------------------------------------------------------------ */

function clearWatchdog() {
  if (watchdogTimer !== null) {
    clearTimeout(watchdogTimer);
    watchdogTimer = null;
  }
}

function markReceived() {
  clearWatchdog();
  if (phase.value === 'waiting') phase.value = 'live';
}

function onOrientation(event: DeviceOrientationEvent) {
  const iosHeading = (event as DeviceOrientationEvent & IosOrientationEvent).webkitCompassHeading;
  const hasTrueHeading = typeof iosHeading === 'number' && Number.isFinite(iosHeading);

  if (hasTrueHeading) {
    heading.value = iosHeading as number;
    usingTrueHeading.value = true;
    markReceived();
  } else if (typeof event.alpha === 'number') {
    heading.value = compassHeading(event.alpha, screenAngle());
    usingTrueHeading.value = event.absolute === true;
    markReceived();
  }

  if (typeof event.beta === 'number' && typeof event.gamma === 'number') {
    smoothPitch.value = lowPassFilter(smoothPitch.value, event.beta, SMOOTHING);
    smoothRoll.value = lowPassFilter(smoothRoll.value, event.gamma, SMOOTHING);
    tiltMagnitude.value = Math.sqrt(
      (smoothPitch.value as number) ** 2 + (smoothRoll.value as number) ** 2,
    );
    markReceived();
  }
}

function vectorOf(v: DeviceMotionEventAcceleration | null): Vector3 | null {
  if (!v || typeof v.x !== 'number' || typeof v.y !== 'number' || typeof v.z !== 'number') {
    return null;
  }
  return { x: v.x, y: v.y, z: v.z };
}

function onMotion(event: DeviceMotionEvent) {
  const accel = vectorOf(event.acceleration);
  if (accel) {
    acceleration.value = lowPassFilterVector(acceleration.value, accel, SMOOTHING);
    markReceived();
  }
  const gravity = vectorOf(event.accelerationIncludingGravity);
  if (gravity) {
    accelerationGravity.value = lowPassFilterVector(accelerationGravity.value, gravity, SMOOTHING);
    markReceived();
  }
  const rate = event.rotationRate;
  if (
    rate &&
    typeof rate.alpha === 'number' &&
    typeof rate.beta === 'number' &&
    typeof rate.gamma === 'number'
  ) {
    rotationRate.value = { alpha: rate.alpha, beta: rate.beta, gamma: rate.gamma };
    markReceived();
  }
}

/* ------------------------------------------------------------------ *
 * Generic Sensor API
 * ------------------------------------------------------------------ */

function startGenericSensor(
  name: string,
  frequency: number,
  target: typeof genericAccelerometer,
  onReading: (sensor: GenericSensorLike) => string,
) {
  const Ctor = sensorCtor(name);
  if (!Ctor) return;
  target.value = { ...target.value, supported: true };
  try {
    const sensor = new Ctor({ frequency });
    const handleReading = () => {
      target.value = { supported: true, live: true, error: null, value: onReading(sensor) };
    };
    sensor.addEventListener('reading', handleReading);
    sensor.addEventListener('error', (ev: Event) => {
      const detail = (ev as Event & { error?: { name?: string; message?: string } }).error;
      target.value = {
        ...target.value,
        error: detail?.message || detail?.name || 'This sensor reported an error.',
      };
    });
    sensor.start();
    cleanupFns.push(() => {
      try {
        sensor.stop();
      } catch {
        // Already stopped or the device went away.
      }
    });
  } catch (err) {
    // SecurityError (blocked by permissions policy), NotSupportedError, or a
    // permission the user has not granted. Fails open: the DeviceMotion and
    // DeviceOrientation readouts above still work independently.
    target.value = {
      ...target.value,
      error: err instanceof Error ? err.message : 'Not available in this browser context.',
    };
  }
}

function startGenericSensors() {
  startGenericSensor('Accelerometer', 30, genericAccelerometer, (s) => {
    const v = { x: s.x ?? 0, y: s.y ?? 0, z: s.z ?? 0 };
    return `${round(vectorMagnitude(v.x, v.y, v.z), 2)} m/s² (x ${round(v.x, 2)}, y ${round(v.y, 2)}, z ${round(v.z, 2)})`;
  });
  startGenericSensor('Gyroscope', 30, genericGyroscope, (s) => {
    const v = { x: s.x ?? 0, y: s.y ?? 0, z: s.z ?? 0 };
    return `${round(vectorMagnitude(v.x, v.y, v.z), 2)} rad/s (x ${round(v.x, 2)}, y ${round(v.y, 2)}, z ${round(v.z, 2)})`;
  });
  startGenericSensor('Magnetometer', 30, genericMagnetometer, (s) => {
    const v = { x: s.x ?? 0, y: s.y ?? 0, z: s.z ?? 0 };
    return `${round(vectorMagnitude(v.x, v.y, v.z), 1)} µT (x ${round(v.x, 1)}, y ${round(v.y, 1)}, z ${round(v.z, 1)})`;
  });
  startGenericSensor('AmbientLightSensor', 5, genericAmbientLight, (s) =>
    typeof s.illuminance === 'number' ? `${round(s.illuminance, 1)} lux` : '--',
  );
}

/* ------------------------------------------------------------------ *
 * enable / disable
 * ------------------------------------------------------------------ */

function describePermissionError(err: unknown): string {
  if (err instanceof DOMException && err.name === 'NotAllowedError') {
    return 'Motion and orientation access was blocked. On iOS, open Settings > Safari > Motion & Orientation Access, turn it on, then reload this page.';
  }
  return err instanceof Error ? err.message : 'Could not get permission to read the sensors.';
}

async function enableSensors() {
  errorDetail.value = null;

  if (!hasOrientationApi && !hasMotionApi) {
    phase.value = 'unsupported';
    return;
  }

  if (needsIosPermission.value) {
    try {
      const motionCtor = window.DeviceMotionEvent as unknown as Required<IosPermissionEventCtor>;
      const orientationCtor = window.DeviceOrientationEvent as unknown as IosPermissionEventCtor;
      const motionResult = await motionCtor.requestPermission();
      const orientationResult =
        typeof orientationCtor.requestPermission === 'function'
          ? await orientationCtor.requestPermission()
          : 'granted';
      if (motionResult !== 'granted' || orientationResult !== 'granted') {
        phase.value = 'denied';
        return;
      }
    } catch (err) {
      phase.value = 'denied';
      errorDetail.value = describePermissionError(err);
      return;
    }
  }

  phase.value = 'waiting';
  window.addEventListener('deviceorientation', onOrientation);
  window.addEventListener('devicemotion', onMotion);
  cleanupFns.push(() => window.removeEventListener('deviceorientation', onOrientation));
  cleanupFns.push(() => window.removeEventListener('devicemotion', onMotion));

  startGenericSensors();

  clearWatchdog();
  watchdogTimer = setTimeout(() => {
    if (phase.value === 'waiting') phase.value = 'unsupported';
  }, WATCHDOG_MS);
}

function teardown() {
  clearWatchdog();
  for (const cleanup of cleanupFns.splice(0)) cleanup();
}

function disableSensors() {
  teardown();
  phase.value = 'idle';
  heading.value = null;
  smoothPitch.value = null;
  smoothRoll.value = null;
  tiltMagnitude.value = null;
  acceleration.value = null;
  accelerationGravity.value = null;
  rotationRate.value = null;
  genericAccelerometer.value = emptyReading();
  genericGyroscope.value = emptyReading();
  genericMagnetometer.value = emptyReading();
  genericAmbientLight.value = emptyReading();
}

onMounted(() => {
  if (!hasOrientationApi && !hasMotionApi) {
    phase.value = 'unsupported';
  }
});

onBeforeUnmount(() => {
  teardown();
});
</script>

<template>
  <div class="flex flex-col gap-4">
    <!-- controls -->
    <div class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
      <div class="flex flex-wrap items-center gap-3">
        <Button
          v-if="phase === 'idle' || phase === 'denied' || phase === 'unsupported'"
          size="lg"
          @click="enableSensors"
        >
          <TabletSmartphone
            class="size-4"
            aria-hidden="true"
          />
          Enable sensors
        </Button>
        <Button
          v-else-if="phase === 'waiting'"
          size="lg"
          disabled
        >
          Waiting for readings…
        </Button>
        <Button
          v-else
          size="lg"
          variant="secondary"
          @click="disableSensors"
        >
          Disable sensors
        </Button>

        <span
          v-if="phase === 'live'"
          class="inline-flex items-center gap-1.5 text-sm text-positive"
        >
          <span
            class="size-2 rounded-full bg-positive"
            aria-hidden="true"
          />
          Reading live
        </span>
      </div>

      <p class="text-xs text-muted-foreground">
        Readings update in this tab only: your files and inputs never leave your device. On iOS, the
        button above triggers the one time motion and orientation permission prompt, which only
        works from a direct tap. Nothing is stored between visits.
      </p>

      <div
        v-if="phase === 'unsupported'"
        role="alert"
        class="rounded-lg border border-destructive/50 bg-destructive/5 px-3 py-2 text-sm"
      >
        <p class="flex items-center gap-1.5 font-medium text-destructive">
          <CircleAlert
            class="size-4"
            aria-hidden="true"
          />
          These sensors need a phone or tablet.
        </p>
        <p class="mt-1 text-muted-foreground">
          No motion or orientation reading arrived from this browser, which is expected on a laptop
          or desktop with no accelerometer or gyroscope. Open this page on a phone or tablet and tap
          Enable sensors again.
        </p>
      </div>

      <div
        v-else-if="phase === 'denied'"
        role="alert"
        class="rounded-lg border border-destructive/50 bg-destructive/5 px-3 py-2 text-sm"
      >
        <p class="font-medium text-destructive">
          Sensor permission was not granted.
        </p>
        <p class="mt-1 text-muted-foreground">
          {{
            errorDetail ||
              'On iOS, open Settings > Safari > Motion & Orientation Access, turn it on, then reload this page and tap Enable sensors again.'
          }}
        </p>
      </div>
    </div>

    <template v-if="phase === 'live'">
      <!-- compass + bubble level -->
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div
          class="flex flex-col items-center gap-3 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6"
        >
          <span
            class="flex items-center gap-1.5 self-start text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase"
          >
            <CompassIcon
              class="size-3.5"
              aria-hidden="true"
            />
            Compass
          </span>
          <div
            v-if="heading !== null"
            class="relative size-36"
          >
            <div class="absolute inset-0 rounded-full bg-secondary shadow-[var(--sh-inset)]" />
            <span
              class="absolute top-1.5 left-1/2 -translate-x-1/2 text-[10px] text-muted-foreground"
            >N</span>
            <span
              class="absolute right-1.5 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground"
            >E</span>
            <span
              class="absolute bottom-1.5 left-1/2 -translate-x-1/2 text-[10px] text-muted-foreground"
            >S</span>
            <span
              class="absolute left-1.5 top-1/2 -translate-y-1/2 text-[10px] text-muted-foreground"
            >W</span>
            <div
              class="absolute top-1/2 left-1/2 h-[46%] w-0.5 origin-bottom -translate-x-1/2 -translate-y-full rounded-full bg-primary transition-transform duration-[160ms] ease-out"
              :style="{ transform: `translateX(-50%) translateY(-100%) rotate(${heading}deg)` }"
            />
            <div
              class="absolute top-1/2 left-1/2 size-2 -translate-x-1/2 -translate-y-1/2 rounded-full bg-primary"
            />
          </div>
          <p class="font-mono text-2xl font-semibold tabular-nums">
            {{ headingLabel }}
          </p>
          <p class="text-xs text-muted-foreground">
            {{
              usingTrueHeading
                ? 'True heading from the magnetometer.'
                : 'Relative heading: turn the device once to calibrate against north.'
            }}
          </p>
        </div>

        <div
          class="flex flex-col items-center gap-3 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6"
        >
          <span
            class="flex items-center gap-1.5 self-start text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase"
          >
            <Gauge
              class="size-3.5"
              aria-hidden="true"
            />
            Bubble level
          </span>
          <div class="relative size-36 rounded-full bg-secondary shadow-[var(--sh-inset)]">
            <div
              class="absolute top-1/2 left-1/2 size-px rounded-full border border-dashed border-border"
            />
            <div
              class="absolute top-1/2 left-1/2 size-5 -translate-x-1/2 -translate-y-1/2 rounded-full shadow-[var(--sh-sm)] transition-transform duration-[160ms] ease-out"
              :class="isLevel ? 'bg-positive' : 'bg-primary'"
              :style="{
                transform: `translate(calc(-50% + ${bubble.x * 56}px), calc(-50% + ${bubble.y * 56}px))`,
              }"
            />
          </div>
          <p class="font-mono text-2xl font-semibold tabular-nums">
            {{ isLevel ? 'Level' : `${pitchLabel} / ${rollLabel}` }}
          </p>
          <p class="text-xs text-muted-foreground">
            Pitch (front-back) and roll (left-right), smoothed to damp jitter.
          </p>
        </div>
      </div>

      <!-- raw motion readouts -->
      <div class="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div class="flex flex-col gap-1 rounded-[14px] border bg-card p-4 shadow-[var(--sh-sm)]">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Acceleration (gravity removed)
          </span>
          <span class="font-mono text-xl font-semibold tabular-nums">{{
            vectorLabel(acceleration)
          }}</span>
          <span class="font-mono text-xs text-muted-foreground">{{
            vectorDetail(acceleration)
          }}</span>
        </div>
        <div class="flex flex-col gap-1 rounded-[14px] border bg-card p-4 shadow-[var(--sh-sm)]">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Acceleration (with gravity)
          </span>
          <span class="font-mono text-xl font-semibold tabular-nums">{{
            vectorLabel(accelerationGravity)
          }}</span>
          <span class="font-mono text-xs text-muted-foreground">{{
            vectorDetail(accelerationGravity)
          }}</span>
        </div>
        <div class="flex flex-col gap-1 rounded-[14px] border bg-card p-4 shadow-[var(--sh-sm)]">
          <span
            class="flex items-center gap-1.5 text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase"
          >
            <RadioTower
              class="size-3.5"
              aria-hidden="true"
            />
            Rotation rate
          </span>
          <span class="font-mono text-xl font-semibold tabular-nums">{{ rotationRateLabel }}</span>
          <span class="font-mono text-xs text-muted-foreground">{{ rotationRateDetail }}</span>
        </div>
      </div>

      <!-- generic sensor api -->
      <div
        v-if="
          genericAccelerometer.supported ||
            genericGyroscope.supported ||
            genericMagnetometer.supported ||
            genericAmbientLight.supported
        "
        class="flex flex-col gap-3 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6"
      >
        <span
          class="flex items-center gap-1.5 text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase"
        >
          <Waves
            class="size-3.5"
            aria-hidden="true"
          />
          Generic Sensor API
        </span>
        <p class="text-xs text-muted-foreground">
          Some browsers additionally expose these sensors through separate constructors, shown here
          for comparison against the readouts above.
        </p>
        <div class="flex flex-col gap-2">
          <div
            v-for="row in [
              { label: 'Accelerometer', reading: genericAccelerometer },
              { label: 'Gyroscope', reading: genericGyroscope },
              { label: 'Magnetometer', reading: genericMagnetometer },
              { label: 'Ambient light', reading: genericAmbientLight },
            ]"
            v-show="row.reading.supported"
            :key="row.label"
            class="flex flex-wrap items-baseline justify-between gap-2 border-b border-border pb-2 last:border-0 last:pb-0"
          >
            <span class="flex items-center gap-1.5 text-sm">
              <SunMedium
                v-if="row.label === 'Ambient light'"
                class="size-3.5 text-muted-foreground"
                aria-hidden="true"
              />
              {{ row.label }}
            </span>
            <span
              v-if="row.reading.error"
              class="text-xs text-muted-foreground"
            >{{
              row.reading.error
            }}</span>
            <span
              v-else
              class="font-mono text-sm break-all"
            >{{
              row.reading.value ?? 'waiting…'
            }}</span>
          </div>
        </div>
      </div>

      <!-- copyable snapshot -->
      <OutputView
        v-if="snapshotOutput"
        :output="snapshotOutput"
      />
    </template>
  </div>
</template>
