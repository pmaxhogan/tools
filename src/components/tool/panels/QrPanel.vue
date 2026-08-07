<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { ToolError, type ToolMeta } from '@/tools/types';
import {
  LOGO_MAX,
  LOGO_MIN,
  buildPayload,
  effectiveEcc,
  embedLogoInSvg,
  renderSvg,
  scannabilityWarnings,
} from '@/tools/qr-code-generator/index';
import { readFragment, writeFragment } from '@/lib/fragment';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import OptionControl from '../OptionControl.vue';
import CopyButton from '../CopyButton.vue';

/**
 * Bespoke panel for the QR code generator. The generic ToolShell only knows
 * how to render one textarea plus schema-driven options; this tool needs
 * per-type input forms (Wi-Fi, contact cards, calendar events and the rest
 * split into labeled fields), a logo file target, and a live rendered preview
 * instead of a text output block, so it gets its own island. The payload
 * building, encoding, logo geometry and scannability thresholds all stay in
 * the pure logic layer: this file only collects input and paints pixels.
 */
const props = defineProps<{ meta: ToolMeta }>();

const presetSpec = computed(() => props.meta.options?.find((o) => o.id === 'preset'));
const eccSpec = computed(() => props.meta.options!.find((o) => o.id === 'ecc')!);
const marginSpec = computed(() => props.meta.options!.find((o) => o.id === 'margin')!);

const preset = ref<string>((presetSpec.value?.default as string) ?? 'text');
const ecc = ref<string>((eccSpec.value.default as string) ?? 'M');
const margin = ref<number>((marginSpec.value.default as number) ?? 4);
const color = ref('#000000');
const background = ref('#ffffff');

/** Rendered pixel width baked into the SVG, and the PNG export size. */
const RENDER_SIZE = 1024;

// Single-field types (plain text and URL share one control).
const textInput = ref('');

// Wi-Fi fields, kept separate from textInput so the password never touches
// the URL fragment (see persistFragment below).
const wifiSsid = ref('');
const wifiPassword = ref('');
const wifiSecurity = ref('WPA');
const wifiHidden = ref(false);

// Contact card fields. The first four keep their historic order so links
// shared from the previous version still decode into the right boxes.
const vcardName = ref('');
const vcardPhone = ref('');
const vcardEmail = ref('');
const vcardOrg = ref('');
const vcardTitle = ref('');
const vcardUrl = ref('');
const vcardAddress = ref('');
const vcardNote = ref('');

const emailTo = ref('');
const emailSubject = ref('');
const emailBody = ref('');

const smsNumber = ref('');
const smsMessage = ref('');

const phoneNumber = ref('');

const geoLat = ref('');
const geoLng = ref('');

// datetime-local inputs are in the visitor's own timezone; the payload is
// always UTC, so these two convert on the way in and out.
const eventSummary = ref('');
const eventStart = ref('');
const eventEnd = ref('');
const eventLocation = ref('');
const eventDescription = ref('');

/** Local "YYYY-MM-DDTHH:MM" to a UTC instant the logic layer accepts. */
function localToUtc(local: string): string {
  if (!local) return '';
  const d = new Date(local);
  return Number.isNaN(d.getTime()) ? local : d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/** A UTC instant back to the value a datetime-local input wants. */
function utcToLocal(utc: string): string {
  if (!utc) return '';
  const d = new Date(utc);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The multi-line string the logic layer expects, composed per content type. */
const composedInput = computed(() => {
  switch (preset.value) {
    case 'wifi':
      return [
        wifiSsid.value,
        wifiPassword.value,
        wifiSecurity.value,
        wifiHidden.value ? 'hidden' : '',
      ].join('\n');
    case 'vcard':
      return [
        vcardName.value,
        vcardPhone.value,
        vcardEmail.value,
        vcardOrg.value,
        vcardTitle.value,
        vcardUrl.value,
        vcardAddress.value,
        vcardNote.value,
      ].join('\n');
    case 'email':
      return [emailTo.value, emailSubject.value, emailBody.value].join('\n');
    case 'sms':
      return [smsNumber.value, smsMessage.value].join('\n');
    case 'phone':
      return phoneNumber.value;
    case 'geo':
      return [geoLat.value, geoLng.value].join('\n');
    case 'event':
      return [
        eventSummary.value,
        localToUtc(eventStart.value),
        localToUtc(eventEnd.value),
        eventLocation.value,
        eventDescription.value,
      ].join('\n');
    default:
      return textInput.value;
  }
});

/** Fill the per-type fields from a stored line-based input. */
function applyInput(text: string) {
  const l = text.split('\n');
  const at = (i: number) => l[i] ?? '';
  const rest = (i: number) => l.slice(i).join('\n').trim();
  switch (preset.value) {
    case 'vcard':
      vcardName.value = at(0);
      vcardPhone.value = at(1);
      vcardEmail.value = at(2);
      vcardOrg.value = at(3);
      vcardTitle.value = at(4);
      vcardUrl.value = at(5);
      vcardAddress.value = at(6);
      vcardNote.value = rest(7);
      break;
    case 'email':
      emailTo.value = at(0);
      emailSubject.value = at(1);
      emailBody.value = rest(2);
      break;
    case 'sms':
      smsNumber.value = at(0);
      smsMessage.value = rest(1);
      break;
    case 'phone':
      phoneNumber.value = at(0);
      break;
    case 'geo':
      if (at(0).includes(',')) {
        const [lat = '', lng = ''] = at(0).split(',');
        geoLat.value = lat.trim();
        geoLng.value = lng.trim();
      } else {
        geoLat.value = at(0);
        geoLng.value = at(1);
      }
      break;
    case 'event':
      eventSummary.value = at(0);
      eventStart.value = utcToLocal(at(1));
      eventEnd.value = utcToLocal(at(2));
      eventLocation.value = at(3);
      eventDescription.value = rest(4);
      break;
    default:
      textInput.value = text;
  }
}

/* -------------------------------------------------------------------------- */
/* Logo                                                                       */
/* -------------------------------------------------------------------------- */

/** Bigger files are refused: a logo this size is being scaled down anyway. */
const MAX_LOGO_BYTES = 2 * 1024 * 1024;

const logoDataUrl = ref('');
const logoName = ref('');
const logoError = ref('');
const logoPercent = ref(20);
const dragging = ref(false);
const logoInput = ref<HTMLInputElement | null>(null);

const hasLogo = computed(() => logoDataUrl.value.length > 0);
const logoSize = computed(() => logoPercent.value / 100);

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error('That file could not be read.'));
    reader.readAsDataURL(file);
  });
}

async function loadLogo(file: File) {
  logoError.value = '';
  if (!file.type.startsWith('image/')) {
    logoError.value = 'That file is not an image. Pick a PNG, JPEG, WebP or SVG.';
    return;
  }
  if (file.size > MAX_LOGO_BYTES) {
    logoError.value = 'That image is over 2 MB. Export it smaller and try again.';
    return;
  }
  try {
    logoDataUrl.value = await readAsDataUrl(file);
    logoName.value = file.name;
  } catch (e) {
    logoError.value = e instanceof Error ? e.message : 'That file could not be read.';
  }
}

function onLogoDrop(e: DragEvent) {
  dragging.value = false;
  const file = e.dataTransfer?.files[0];
  if (file) loadLogo(file);
}

function onLogoPick(e: Event) {
  const picker = e.target as HTMLInputElement;
  const file = picker.files?.[0];
  if (!file) return;
  loadLogo(file).then(() => {
    // Reset so picking the same file again still fires a change event.
    picker.value = '';
  });
}

function clearLogo() {
  logoDataUrl.value = '';
  logoName.value = '';
  logoError.value = '';
}

/* -------------------------------------------------------------------------- */
/* Render                                                                     */
/* -------------------------------------------------------------------------- */

/** The code without the logo, used as the base layer for the PNG export. */
const plainSvg = ref<string | null>(null);
/** What the visitor sees and downloads: the code plus the logo, if any. */
const svgOutput = ref<string | null>(null);
const error = ref<{ message: string; fix?: string } | null>(null);

const previewSrc = computed(() =>
  svgOutput.value ? `data:image/svg+xml,${encodeURIComponent(svgOutput.value)}` : '',
);

const warnings = computed(() =>
  scannabilityWarnings({
    hasLogo: hasLogo.value,
    logoSize: logoSize.value,
    color: color.value,
    background: background.value,
  }),
);

let debounceHandle: ReturnType<typeof setTimeout> | undefined;

async function performRun() {
  try {
    const payload = buildPayload(composedInput.value, preset.value);
    const plain = await renderSvg(payload, {
      ecc: effectiveEcc(ecc.value, hasLogo.value),
      margin: margin.value,
      color: color.value,
      background: background.value,
      width: RENDER_SIZE,
    });
    plainSvg.value = plain;
    svgOutput.value = hasLogo.value
      ? embedLogoInSvg(plain, {
          dataUrl: logoDataUrl.value,
          size: logoSize.value,
          background: background.value,
        })
      : plain;
    error.value = null;
  } catch (e) {
    plainSvg.value = null;
    svgOutput.value = null;
    error.value =
      e instanceof ToolError
        ? { message: e.message, fix: e.fix }
        : { message: e instanceof Error ? e.message : String(e) };
  }
}

function persistFragment() {
  writeFragment({
    // Wi-Fi input carries a plaintext password. It must never round-trip
    // through the URL fragment (it is visible in browser history, the
    // address bar, and any link the user shares), so wifi input is skipped
    // entirely here rather than filtered field by field. The logo is left
    // out for the same reason: it is a file from the visitor's device.
    input: preset.value === 'wifi' ? undefined : composedInput.value,
    opts: {
      preset: preset.value,
      ecc: ecc.value,
      margin: String(margin.value),
      fg: color.value,
      bg: background.value,
    },
  });
}

function scheduleRun() {
  clearTimeout(debounceHandle);
  debounceHandle = setTimeout(() => {
    performRun();
    persistFragment();
  }, 200);
}

watch(
  [composedInput, preset, ecc, margin, color, background, logoDataUrl, logoPercent],
  scheduleRun,
);

onMounted(() => {
  const frag = readFragment();
  if (frag.opts.preset) preset.value = frag.opts.preset;
  if (frag.opts.ecc) ecc.value = frag.opts.ecc;
  if (frag.opts.margin !== undefined) margin.value = Number(frag.opts.margin);
  if (frag.opts.fg) color.value = frag.opts.fg;
  if (frag.opts.bg) background.value = frag.opts.bg;

  // Wifi is intentionally excluded: its fragment input is never written, so
  // there is nothing sensitive to read back either.
  if (frag.input !== undefined && preset.value !== 'wifi') applyInput(frag.input);

  performRun();
});

/* -------------------------------------------------------------------------- */
/* Downloads                                                                  */
/* -------------------------------------------------------------------------- */

function triggerDownload(url: string, filename: string) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function downloadSvg() {
  if (!svgOutput.value) return;
  const blob = new Blob([svgOutput.value], { type: 'image/svg+xml' });
  const url = URL.createObjectURL(blob);
  triggerDownload(url, 'qr.svg');
  URL.revokeObjectURL(url);
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('That image could not be decoded.'));
    img.src = src;
  });
}

/** Rounded rectangle that also works where ctx.roundRect is missing. */
function fillRoundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') ctx.roundRect(x, y, w, h, r);
  else ctx.rect(x, y, w, h);
  ctx.fill();
}

async function downloadPng() {
  if (!plainSvg.value) return;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = RENDER_SIZE;
    canvas.height = RENDER_SIZE;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // QR readers need a solid quiet zone; a transparent PNG background can
    // fail to scan depending on what it is placed over.
    ctx.fillStyle = background.value;
    ctx.fillRect(0, 0, RENDER_SIZE, RENDER_SIZE);

    const qr = await loadImage(`data:image/svg+xml,${encodeURIComponent(plainSvg.value)}`);
    ctx.drawImage(qr, 0, 0, RENDER_SIZE, RENDER_SIZE);

    if (hasLogo.value) {
      const logo = await loadImage(logoDataUrl.value);
      const box = RENDER_SIZE * logoSize.value;
      const plate = box * 1.16;
      ctx.fillStyle = background.value;
      fillRoundedRect(
        ctx,
        (RENDER_SIZE - plate) / 2,
        (RENDER_SIZE - plate) / 2,
        plate,
        plate,
        plate * 0.15,
      );
      const scale = Math.min(box / (logo.width || box), box / (logo.height || box));
      const w = (logo.width || box) * scale;
      const h = (logo.height || box) * scale;
      ctx.drawImage(logo, (RENDER_SIZE - w) / 2, (RENDER_SIZE - h) / 2, w, h);
    }

    canvas.toBlob((blob) => {
      if (!blob) return;
      const pngUrl = URL.createObjectURL(blob);
      triggerDownload(pngUrl, 'qr.png');
      URL.revokeObjectURL(pngUrl);
    }, 'image/png');
  } catch (e) {
    error.value = {
      message: e instanceof Error ? e.message : 'The PNG could not be composed.',
      fix: 'Try a different logo file, or download the SVG instead.',
    };
  }
}
</script>

<template>
  <div class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <div class="grid grid-cols-1 gap-6 lg:grid-cols-2">
      <div class="flex flex-col gap-4">
        <div class="flex flex-col gap-1.5">
          <Label
            for="qr-preset"
            class="text-xs text-muted-foreground"
          >
            {{ presetSpec?.label ?? 'Content type' }}
          </Label>
          <Select
            :model-value="preset"
            @update:model-value="(v) => (preset = String(v))"
          >
            <SelectTrigger
              id="qr-preset"
              size="sm"
              class="w-full"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem
                v-for="c in presetSpec?.choices ?? []"
                :key="c.value"
                :value="c.value"
              >
                {{ c.label }}
              </SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Input
          </span>

          <div
            v-if="preset === 'url'"
            class="flex flex-col gap-1.5"
          >
            <Label
              for="qr-url"
              class="text-xs text-muted-foreground"
            >URL</Label>
            <Input
              id="qr-url"
              v-model="textInput"
              type="url"
              placeholder="https://example.com"
              class="h-9 bg-card"
            />
          </div>

          <div
            v-else-if="preset === 'wifi'"
            class="flex flex-col gap-3"
          >
            <div class="flex flex-col gap-1.5">
              <Label
                for="qr-wifi-ssid"
                class="text-xs text-muted-foreground"
              >Network name</Label>
              <Input
                id="qr-wifi-ssid"
                v-model="wifiSsid"
                placeholder="Home network"
                class="h-9 bg-card"
              />
            </div>
            <div class="flex flex-col gap-1.5">
              <Label
                for="qr-wifi-password"
                class="text-xs text-muted-foreground"
              >Password</Label>
              <Input
                id="qr-wifi-password"
                v-model="wifiPassword"
                type="password"
                placeholder="Leave blank for an open network"
                class="h-9 bg-card"
              />
            </div>
            <div class="flex flex-col gap-1.5">
              <Label
                for="qr-wifi-security"
                class="text-xs text-muted-foreground"
              >Security</Label>
              <Select
                :model-value="wifiSecurity"
                @update:model-value="(v) => (wifiSecurity = String(v))"
              >
                <SelectTrigger
                  id="qr-wifi-security"
                  size="sm"
                  class="w-full bg-card"
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="WPA">
                    WPA
                  </SelectItem>
                  <SelectItem value="WEP">
                    WEP
                  </SelectItem>
                  <SelectItem value="nopass">
                    None
                  </SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div class="flex items-center gap-2">
              <Switch
                id="qr-wifi-hidden"
                :model-value="wifiHidden"
                @update:model-value="(v) => (wifiHidden = Boolean(v))"
              />
              <Label
                for="qr-wifi-hidden"
                class="text-xs text-muted-foreground"
              >Hidden network (does not broadcast its name)</Label>
            </div>
            <p class="text-xs text-muted-foreground">
              This type is not saved to the page URL, so the password never ends up in your browser
              history or in a link you share.
            </p>
          </div>

          <div
            v-else-if="preset === 'vcard'"
            class="flex flex-col gap-3"
          >
            <div class="flex flex-col gap-1.5">
              <Label
                for="qr-vcard-name"
                class="text-xs text-muted-foreground"
              >Name</Label>
              <Input
                id="qr-vcard-name"
                v-model="vcardName"
                placeholder="Ada Lovelace"
                class="h-9 bg-card"
              />
            </div>
            <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div class="flex flex-col gap-1.5">
                <Label
                  for="qr-vcard-org"
                  class="text-xs text-muted-foreground"
                >Organization</Label>
                <Input
                  id="qr-vcard-org"
                  v-model="vcardOrg"
                  placeholder="Analytical Engines Co"
                  class="h-9 bg-card"
                />
              </div>
              <div class="flex flex-col gap-1.5">
                <Label
                  for="qr-vcard-title"
                  class="text-xs text-muted-foreground"
                >Job title</Label>
                <Input
                  id="qr-vcard-title"
                  v-model="vcardTitle"
                  placeholder="Chief Engineer"
                  class="h-9 bg-card"
                />
              </div>
              <div class="flex flex-col gap-1.5">
                <Label
                  for="qr-vcard-phone"
                  class="text-xs text-muted-foreground"
                >Phone</Label>
                <Input
                  id="qr-vcard-phone"
                  v-model="vcardPhone"
                  type="tel"
                  placeholder="+1 555 0100"
                  class="h-9 bg-card"
                />
              </div>
              <div class="flex flex-col gap-1.5">
                <Label
                  for="qr-vcard-email"
                  class="text-xs text-muted-foreground"
                >Email</Label>
                <Input
                  id="qr-vcard-email"
                  v-model="vcardEmail"
                  type="email"
                  placeholder="ada@example.com"
                  class="h-9 bg-card"
                />
              </div>
            </div>
            <div class="flex flex-col gap-1.5">
              <Label
                for="qr-vcard-url"
                class="text-xs text-muted-foreground"
              >Website</Label>
              <Input
                id="qr-vcard-url"
                v-model="vcardUrl"
                type="url"
                placeholder="https://example.com"
                class="h-9 bg-card"
              />
            </div>
            <div class="flex flex-col gap-1.5">
              <Label
                for="qr-vcard-address"
                class="text-xs text-muted-foreground"
              >Address</Label>
              <Input
                id="qr-vcard-address"
                v-model="vcardAddress"
                placeholder="12 Bleep Street, London"
                class="h-9 bg-card"
              />
            </div>
            <div class="flex flex-col gap-1.5">
              <Label
                for="qr-vcard-note"
                class="text-xs text-muted-foreground"
              >Note</Label>
              <Textarea
                id="qr-vcard-note"
                v-model="vcardNote"
                placeholder="Anything else worth carrying in the card"
                class="min-h-16 border-0 bg-card text-sm shadow-none focus-visible:ring-0"
              />
            </div>
          </div>

          <div
            v-else-if="preset === 'email'"
            class="flex flex-col gap-3"
          >
            <div class="flex flex-col gap-1.5">
              <Label
                for="qr-email-to"
                class="text-xs text-muted-foreground"
              >To</Label>
              <Input
                id="qr-email-to"
                v-model="emailTo"
                type="email"
                placeholder="hello@example.com"
                class="h-9 bg-card"
              />
            </div>
            <div class="flex flex-col gap-1.5">
              <Label
                for="qr-email-subject"
                class="text-xs text-muted-foreground"
              >Subject</Label>
              <Input
                id="qr-email-subject"
                v-model="emailSubject"
                placeholder="Optional"
                class="h-9 bg-card"
              />
            </div>
            <div class="flex flex-col gap-1.5">
              <Label
                for="qr-email-body"
                class="text-xs text-muted-foreground"
              >Message</Label>
              <Textarea
                id="qr-email-body"
                v-model="emailBody"
                placeholder="Optional prefilled body"
                class="min-h-20 border-0 bg-card text-sm shadow-none focus-visible:ring-0"
              />
            </div>
          </div>

          <div
            v-else-if="preset === 'sms'"
            class="flex flex-col gap-3"
          >
            <div class="flex flex-col gap-1.5">
              <Label
                for="qr-sms-number"
                class="text-xs text-muted-foreground"
              >Phone number</Label>
              <Input
                id="qr-sms-number"
                v-model="smsNumber"
                type="tel"
                placeholder="+1 555 0100"
                class="h-9 bg-card"
              />
            </div>
            <div class="flex flex-col gap-1.5">
              <Label
                for="qr-sms-message"
                class="text-xs text-muted-foreground"
              >Message</Label>
              <Textarea
                id="qr-sms-message"
                v-model="smsMessage"
                placeholder="Optional prefilled text"
                class="min-h-20 border-0 bg-card text-sm shadow-none focus-visible:ring-0"
              />
            </div>
          </div>

          <div
            v-else-if="preset === 'phone'"
            class="flex flex-col gap-1.5"
          >
            <Label
              for="qr-phone"
              class="text-xs text-muted-foreground"
            >Phone number</Label>
            <Input
              id="qr-phone"
              v-model="phoneNumber"
              type="tel"
              placeholder="+1 555 0100"
              class="h-9 bg-card"
            />
          </div>

          <div
            v-else-if="preset === 'geo'"
            class="flex flex-col gap-3"
          >
            <div class="grid grid-cols-2 gap-3">
              <div class="flex flex-col gap-1.5">
                <Label
                  for="qr-geo-lat"
                  class="text-xs text-muted-foreground"
                >Latitude</Label>
                <Input
                  id="qr-geo-lat"
                  v-model="geoLat"
                  inputmode="decimal"
                  placeholder="38.627"
                  class="h-9 bg-card font-mono"
                />
              </div>
              <div class="flex flex-col gap-1.5">
                <Label
                  for="qr-geo-lng"
                  class="text-xs text-muted-foreground"
                >Longitude</Label>
                <Input
                  id="qr-geo-lng"
                  v-model="geoLng"
                  inputmode="decimal"
                  placeholder="-90.199"
                  class="h-9 bg-card font-mono"
                />
              </div>
            </div>
            <p class="text-xs text-muted-foreground">
              Copy the pair straight from a map app. Scanning opens a pin at those coordinates.
            </p>
          </div>

          <div
            v-else-if="preset === 'event'"
            class="flex flex-col gap-3"
          >
            <div class="flex flex-col gap-1.5">
              <Label
                for="qr-event-summary"
                class="text-xs text-muted-foreground"
              >Title</Label>
              <Input
                id="qr-event-summary"
                v-model="eventSummary"
                placeholder="Team standup"
                class="h-9 bg-card"
              />
            </div>
            <div class="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div class="flex flex-col gap-1.5">
                <Label
                  for="qr-event-start"
                  class="text-xs text-muted-foreground"
                >Starts</Label>
                <Input
                  id="qr-event-start"
                  v-model="eventStart"
                  type="datetime-local"
                  class="h-9 bg-card"
                />
              </div>
              <div class="flex flex-col gap-1.5">
                <Label
                  for="qr-event-end"
                  class="text-xs text-muted-foreground"
                >Ends</Label>
                <Input
                  id="qr-event-end"
                  v-model="eventEnd"
                  type="datetime-local"
                  class="h-9 bg-card"
                />
              </div>
            </div>
            <div class="flex flex-col gap-1.5">
              <Label
                for="qr-event-location"
                class="text-xs text-muted-foreground"
              >Location</Label>
              <Input
                id="qr-event-location"
                v-model="eventLocation"
                placeholder="Room 3"
                class="h-9 bg-card"
              />
            </div>
            <div class="flex flex-col gap-1.5">
              <Label
                for="qr-event-description"
                class="text-xs text-muted-foreground"
              >Description</Label>
              <Textarea
                id="qr-event-description"
                v-model="eventDescription"
                placeholder="Optional details"
                class="min-h-16 border-0 bg-card text-sm shadow-none focus-visible:ring-0"
              />
            </div>
            <p class="text-xs text-muted-foreground">
              Times are entered in your timezone and written into the code as UTC, so the event
              lands correctly wherever it is scanned.
            </p>
          </div>

          <div
            v-else
            class="flex flex-col gap-1.5"
          >
            <Label
              for="qr-text"
              class="text-xs text-muted-foreground"
            >Text</Label>
            <Textarea
              id="qr-text"
              v-model="textInput"
              placeholder="Type the text to encode"
              class="min-h-28 border-0 bg-card font-mono text-sm shadow-none focus-visible:ring-0"
            />
          </div>
        </div>

        <div
          class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]"
          :class="dragging ? 'ring-2 ring-ring' : ''"
          @dragover.prevent="dragging = true"
          @dragleave="dragging = false"
          @drop.prevent="onLogoDrop"
        >
          <div class="flex items-center justify-between gap-2">
            <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
              Center logo
            </span>
            <div class="flex items-center gap-1">
              <Button
                v-if="hasLogo"
                variant="ghost"
                size="sm"
                @click="clearLogo"
              >
                Remove
              </Button>
              <Button
                variant="ghost"
                size="sm"
                @click="logoInput?.click()"
              >
                {{ hasLogo ? 'Replace' : 'Add logo' }}
              </Button>
              <input
                ref="logoInput"
                type="file"
                class="hidden"
                accept="image/*"
                @change="onLogoPick"
              >
            </div>
          </div>

          <p
            v-if="!hasLogo"
            class="text-xs text-muted-foreground"
          >
            Drop an image here, or pick one. It is read on your device and inlined into the code:
            your files and inputs never leave your device.
          </p>

          <div
            v-else
            class="flex flex-col gap-3"
          >
            <div class="flex items-center gap-3">
              <span
                class="grid size-10 shrink-0 place-items-center rounded-[6px] bg-card p-1 shadow-[var(--sh-inset)]"
              >
                <img
                  :src="logoDataUrl"
                  alt=""
                  class="max-h-full max-w-full object-contain"
                >
              </span>
              <span class="min-w-0 truncate text-xs text-muted-foreground">{{ logoName }}</span>
            </div>
            <div class="flex flex-col gap-1.5">
              <span class="text-xs text-muted-foreground tabular-nums">
                Logo size: {{ logoPercent }}% of the code
              </span>
              <Slider
                aria-label="Logo size"
                :model-value="[logoPercent]"
                :min="LOGO_MIN * 100"
                :max="LOGO_MAX * 100"
                :step="1"
                class="py-2"
                @update:model-value="(v) => (logoPercent = v?.[0] ?? logoPercent)"
              />
            </div>
            <p class="text-xs text-muted-foreground">
              Error correction is held at H (30% recovery) while a logo is in place, so the modules
              behind it can still be reconstructed.
            </p>
          </div>

          <p
            v-if="logoError"
            role="alert"
            class="text-xs text-destructive"
          >
            {{ logoError }}
          </p>
        </div>

        <div class="grid grid-cols-2 gap-3">
          <OptionControl
            v-model="ecc"
            :spec="eccSpec"
          />
          <OptionControl
            v-model="margin"
            :spec="marginSpec"
          />
          <div class="flex min-w-0 flex-col gap-1.5">
            <Label
              for="qr-fg"
              class="text-xs text-muted-foreground"
            >Foreground</Label>
            <input
              id="qr-fg"
              v-model="color"
              type="color"
              class="h-8 w-full cursor-pointer rounded-[10px] border bg-card p-1"
            >
          </div>
          <div class="flex min-w-0 flex-col gap-1.5">
            <Label
              for="qr-bg"
              class="text-xs text-muted-foreground"
            >Background</Label>
            <input
              id="qr-bg"
              v-model="background"
              type="color"
              class="h-8 w-full cursor-pointer rounded-[10px] border bg-card p-1"
            >
          </div>
        </div>
      </div>

      <div class="flex flex-col gap-3">
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

        <!-- The well stays white in both themes: QR readers need reliable
             light/dark module contrast, which a dark-mode surface would break. -->
        <div
          v-else
          class="qr-preview flex min-h-64 items-center justify-center rounded-[10px] bg-white p-4 shadow-[var(--sh-inset)]"
        >
          <img
            v-if="previewSrc"
            :src="previewSrc"
            alt="QR code preview"
          >
        </div>

        <p
          v-for="w in warnings"
          :key="w"
          class="text-xs text-muted-foreground"
        >
          {{ w }}
        </p>

        <div
          v-if="svgOutput && !error"
          class="flex flex-wrap items-center gap-2"
        >
          <CopyButton
            :text="svgOutput"
            label="Copy SVG"
          />
          <Button
            variant="outline"
            size="sm"
            @click="downloadSvg"
          >
            Download SVG
          </Button>
          <Button
            variant="outline"
            size="sm"
            @click="downloadPng"
          >
            Download PNG
          </Button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.qr-preview img {
  display: block;
  width: 100%;
  max-width: 320px;
  height: auto;
}
</style>
