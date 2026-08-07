<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { ToolError, type ToolMeta } from '@/tools/types';
import { run, type QrOpts } from '@/tools/qr-code-generator/index';
import { readFragment, writeFragment } from '@/lib/fragment';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
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
 * preset-shaped input (Wi-Fi and vCard split into labeled fields) and a live
 * rendered preview instead of a text output block, so it gets its own
 * island. ecc/margin still reuse OptionControl since they are plain
 * schema-driven controls.
 */
const props = defineProps<{ meta: ToolMeta }>();

const presetSpec = computed(() => props.meta.options?.find((o) => o.id === 'preset'));
const eccSpec = computed(() => props.meta.options!.find((o) => o.id === 'ecc')!);
const marginSpec = computed(() => props.meta.options!.find((o) => o.id === 'margin')!);

const preset = ref<string>((presetSpec.value?.default as string) ?? 'text');
const ecc = ref<string>((eccSpec.value.default as string) ?? 'M');
const margin = ref<number>((marginSpec.value.default as number) ?? 4);

// Single-field presets.
const textInput = ref('');

// Wi-Fi fields, kept separate from textInput so the password never touches
// the URL fragment (see persistFragment below).
const wifiSsid = ref('');
const wifiPassword = ref('');
const wifiSecurity = ref('WPA');

// vCard fields.
const vcardName = ref('');
const vcardPhone = ref('');
const vcardEmail = ref('');
const vcardOrg = ref('');

/** The multi-line string the logic layer expects, composed per preset. */
const composedInput = computed(() => {
  switch (preset.value) {
    case 'wifi':
      return [wifiSsid.value, wifiPassword.value, wifiSecurity.value].join('\n');
    case 'vcard':
      return [vcardName.value, vcardPhone.value, vcardEmail.value, vcardOrg.value].join('\n');
    default:
      return textInput.value;
  }
});

const svgOutput = ref<string | null>(null);
const error = ref<{ message: string; fix?: string } | null>(null);

let debounceHandle: ReturnType<typeof setTimeout> | undefined;

async function performRun() {
  try {
    svgOutput.value = await run(composedInput.value, {
      preset: preset.value,
      ecc: ecc.value,
      margin: margin.value,
    } as QrOpts);
    error.value = null;
  } catch (e) {
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
    // entirely here rather than filtered field by field.
    input: preset.value === 'wifi' ? undefined : composedInput.value,
    opts: {
      preset: preset.value,
      ecc: ecc.value,
      margin: String(margin.value),
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

watch([composedInput, preset, ecc, margin], scheduleRun);

onMounted(() => {
  const frag = readFragment();
  if (frag.opts.preset) preset.value = frag.opts.preset;
  if (frag.opts.ecc) ecc.value = frag.opts.ecc;
  if (frag.opts.margin !== undefined) margin.value = Number(frag.opts.margin);

  // Wifi is intentionally excluded: its fragment input is never written, so
  // there is nothing sensitive to read back either.
  if (frag.input !== undefined && preset.value !== 'wifi') {
    if (preset.value === 'vcard') {
      const [name = '', phone = '', email = '', org = ''] = frag.input.split('\n');
      vcardName.value = name;
      vcardPhone.value = phone;
      vcardEmail.value = email;
      vcardOrg.value = org;
    } else {
      textInput.value = frag.input;
    }
  }

  performRun();
});

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

function downloadPng() {
  if (!svgOutput.value) return;
  const svgUrl = URL.createObjectURL(new Blob([svgOutput.value], { type: 'image/svg+xml' }));
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(svgUrl);
    const canvas = document.createElement('canvas');
    canvas.width = 1024;
    canvas.height = 1024;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    // QR readers need a solid quiet zone; a transparent PNG background can
    // fail to scan depending on what it is placed over.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, 1024, 1024);
    ctx.drawImage(img, 0, 0, 1024, 1024);
    canvas.toBlob((blob) => {
      if (!blob) return;
      const pngUrl = URL.createObjectURL(blob);
      triggerDownload(pngUrl, 'qr.png');
      URL.revokeObjectURL(pngUrl);
    }, 'image/png');
  };
  img.onerror = () => URL.revokeObjectURL(svgUrl);
  img.src = svgUrl;
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
            {{ presetSpec?.label ?? 'Payload' }}
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
            <p class="text-xs text-muted-foreground">
              This preset is not saved to the page URL, so the password never ends up in your
              browser history or in a link you share.
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

        <div class="grid grid-cols-2 gap-3">
          <OptionControl
            v-model="ecc"
            :spec="eccSpec"
          />
          <OptionControl
            v-model="margin"
            :spec="marginSpec"
          />
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
          v-html="svgOutput ?? ''"
        />

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
.qr-preview :deep(svg) {
  display: block;
  width: 100%;
  max-width: 320px;
  height: auto;
}
</style>
