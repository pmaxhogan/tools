<script setup lang="ts">
import { ref } from "vue";
import QRCode from "qrcode";
import { ToolError, type ToolMeta } from "@/tools/types";
import {
  buildPeerConfig,
  buildServerConfig,
  deriveAddresses,
  generateKeypair,
  generatePsk,
  listenPortFromEndpoint,
  resolveAllowedIps,
  subnetPrefix,
  type Keypair,
} from "@/tools/wireguard-config-generator/index";
import { downloadText } from "@/lib/download";
import { Button } from "@/components/ui/button";
import OptionControl from "../OptionControl.vue";
import CopyButton from "../CopyButton.vue";
import ErrorBanner from "../ErrorBanner.vue";

/**
 * Bespoke panel for the WireGuard config generator. Every private key,
 * preshared key, and config in this file is generated and rendered entirely
 * client-side: nothing here is ever written to the URL fragment or
 * localStorage, and there is no server endpoint that could see a key (the
 * tool's meta deliberately omits `http`). State lives only in this
 * component's memory for as long as the tab stays open.
 */
const props = defineProps<{ meta: ToolMeta }>();

interface PeerEntry {
  ip: string;
  keypair: Keypair;
  presharedKey?: string;
  configText: string;
  qrSvg: string;
}

const opts = ref<Record<string, unknown>>(
  Object.fromEntries((props.meta.options ?? []).map((o) => [o.id, o.default])),
);

const serverKeypair = ref<Keypair | null>(null);
const serverConfigText = ref("");
const peerEntries = ref<PeerEntry[]>([]);
const hasGenerated = ref(false);
const generating = ref(false);
const error = ref<{ message: string; fix?: string } | null>(null);

// Remembered from the last successful generate() so a per-peer regenerate
// does not have to re-run subnet math (and cannot accidentally reshuffle
// every other peer's address in the process).
let currentServerIp = "";
let currentPrefix = 0;

async function renderQr(text: string): Promise<string> {
  return QRCode.toString(text, { type: "svg", margin: 2, width: 220 });
}

function qrDataUrl(svg: string): string {
  return svg ? `data:image/svg+xml,${encodeURIComponent(svg)}` : "";
}

function makePeerEntry(ip: string): PeerEntry {
  const keypair = generateKeypair();
  const presharedKey = opts.value.psk ? generatePsk() : undefined;
  return { ip, keypair, presharedKey, configText: "", qrSvg: "" };
}

/** Rebuilds every config text (and QR) from the current keys and options. */
async function rebuildConfigs() {
  const server = serverKeypair.value;
  if (!server) return;

  const subnet = String(opts.value.subnet ?? "");
  const endpoint = String(opts.value.endpoint ?? "").trim();
  const dns = String(opts.value.dns ?? "").trim();
  const clientAllowedIps = resolveAllowedIps(String(opts.value.allowedIps ?? "full"), subnet);
  const listenPort = listenPortFromEndpoint(endpoint);

  serverConfigText.value = buildServerConfig({
    privateKey: server.privateKey,
    address: `${currentServerIp}/${currentPrefix}`,
    listenPort,
    peers: peerEntries.value.map((p) => ({
      publicKey: p.keypair.publicKey,
      presharedKey: p.presharedKey,
      allowedIps: `${p.ip}/32`,
    })),
  });

  for (const peer of peerEntries.value) {
    peer.configText = buildPeerConfig({
      privateKey: peer.keypair.privateKey,
      address: `${peer.ip}/32`,
      dns: dns || undefined,
      serverPublicKey: server.publicKey,
      presharedKey: peer.presharedKey,
      allowedIps: clientAllowedIps,
      endpoint: endpoint || undefined,
      persistentKeepalive: endpoint ? 25 : undefined,
    });
    peer.qrSvg = await renderQr(peer.configText);
  }
}

function readError(e: unknown): { message: string; fix?: string } {
  return e instanceof ToolError
    ? { message: e.message, fix: e.fix }
    : { message: e instanceof Error ? e.message : String(e) };
}

async function generate() {
  generating.value = true;
  error.value = null;
  try {
    const peerCount = Math.max(1, Math.floor(Number(opts.value.peers) || 1));
    const subnet = String(opts.value.subnet ?? "");
    const addresses = deriveAddresses(subnet, peerCount + 1);
    currentServerIp = addresses[0] as string;
    currentPrefix = subnetPrefix(subnet);

    serverKeypair.value = generateKeypair();
    peerEntries.value = addresses.slice(1).map((ip) => makePeerEntry(ip));

    await rebuildConfigs();
    hasGenerated.value = true;
  } catch (e) {
    serverKeypair.value = null;
    peerEntries.value = [];
    serverConfigText.value = "";
    error.value = readError(e);
  } finally {
    generating.value = false;
  }
}

async function regeneratePeer(index: number) {
  const entry = peerEntries.value[index];
  if (!entry) return;
  generating.value = true;
  try {
    entry.keypair = generateKeypair();
    entry.presharedKey = opts.value.psk ? generatePsk() : undefined;
    await rebuildConfigs();
  } catch (e) {
    error.value = readError(e);
  } finally {
    generating.value = false;
  }
}
</script>

<template>
  <div class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <ErrorBanner
      title="These keys exist only in this browser tab."
      message="Every private key, preshared key, and config below was generated on your device just now. Nothing is sent anywhere: your files and inputs never leave your device. Copy or download what you need before you go. Refreshing or closing this page forgets everything, and there is no way to get it back afterward."
    />

    <div class="grid grid-cols-2 gap-3 sm:grid-cols-3">
      <OptionControl
        v-for="spec in meta.options"
        :key="spec.id"
        v-model="opts[spec.id]"
        :spec="spec"
      />
    </div>

    <Button class="self-start" :disabled="generating" @click="generate">
      {{ hasGenerated ? "Regenerate everything" : "Generate" }}
    </Button>

    <ErrorBanner v-if="error" :message="error.message" :hint="error.fix" />

    <p v-if="!hasGenerated && !error" class="text-sm text-muted-foreground">
      Set the options above, then Generate to build a server config and one config per peer, each
      with its own fresh key pair and QR code.
    </p>

    <template v-if="serverKeypair">
      <div class="flex flex-col gap-2 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]">
        <div class="flex items-center justify-between gap-2">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Server config (wg0.conf)
          </span>
          <div class="flex items-center gap-1">
            <CopyButton :text="serverConfigText" label="Copy" />
            <Button variant="outline" size="sm" @click="downloadText(serverConfigText, 'wg0.conf')">
              Download
            </Button>
          </div>
        </div>
        <pre
          class="max-h-72 overflow-auto rounded-[8px] bg-card p-3 font-mono text-xs whitespace-pre-wrap"
          >{{ serverConfigText }}</pre>
      </div>

      <div
        v-for="(peer, i) in peerEntries"
        :key="peer.ip"
        class="flex flex-col gap-3 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)] sm:flex-row"
      >
        <div class="flex min-w-0 flex-1 flex-col gap-2">
          <div class="flex items-center justify-between gap-2">
            <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
              Peer {{ i + 1 }} &middot; {{ peer.ip }}
            </span>
            <Button variant="ghost" size="sm" :disabled="generating" @click="regeneratePeer(i)">
              Regenerate
            </Button>
          </div>
          <pre
            class="max-h-72 overflow-auto rounded-[8px] bg-card p-3 font-mono text-xs whitespace-pre-wrap"
            >{{ peer.configText }}</pre>
          <div class="flex flex-wrap items-center gap-2">
            <CopyButton :text="peer.configText" label="Copy" />
            <Button
              variant="outline"
              size="sm"
              @click="downloadText(peer.configText, `wg0-peer${i + 1}.conf`)"
            >
              Download .conf
            </Button>
          </div>
        </div>

        <div
          class="qr-well flex shrink-0 items-center justify-center rounded-[10px] bg-white p-3 shadow-[var(--sh-inset)]"
        >
          <img
            v-if="peer.qrSvg"
            :src="qrDataUrl(peer.qrSvg)"
            :alt="`QR code for peer ${i + 1} config`"
            width="160"
            height="160"
          />
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
/* The QR well stays white in both themes: phone cameras need reliable
   light/dark module contrast, which a dark-mode surface would break. */
.qr-well img {
  display: block;
  width: 160px;
  height: 160px;
}
</style>
