<script setup lang="ts">
/**
 * Bespoke panel for the WebRTC debugger.
 *
 * The pure layer (`src/tools/webrtc-tester/index.ts`) parses candidate lines
 * and interprets a completed gathering (rule 27); this panel owns the one
 * thing it cannot: talking to STUN servers. Live gathering only ever starts
 * from the "Start gathering" click handler, never at setup time, so the
 * server rendered shell never touches `RTCPeerConnection`. Every connection
 * this panel opens is closed in that gathering's own finally step and, as a
 * safety net for a run still in flight, again on unmount.
 */
import { computed, onUnmounted, reactive, ref } from "vue";
import type { ToolMeta } from "@/tools/types";
import { ToolError } from "@/tools/types";
import {
  STUN_SERVERS,
  interpretGathering,
  parseCandidate,
  run,
  type IceCandidateType,
} from "@/tools/webrtc-tester/index";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import OutputView from "@/components/tool/OutputView.vue";
import { Play, Search } from "lucide-vue-next";

const props = defineProps<{ meta: ToolMeta }>();

type PanelTab = "live" | "paste";
const activeTab = ref<PanelTab>("live");

/* ------------------------------------------------------------------ *
 * live gathering
 * ------------------------------------------------------------------ */

const GATHER_TIMEOUT_MS = 5000;

const selectedServers = reactive<Record<string, boolean>>(
  Object.fromEntries(STUN_SERVERS.map((s) => [s.id, true])),
);

interface LiveCandidateRow {
  candidate: string;
  /** The STUN server URL this candidate came from, undefined for the baseline gathering. */
  url?: string;
  sourceLabel: string;
  type?: IceCandidateType;
  protocol?: string;
  address?: string;
  port?: number;
}

/**
 * A minimal structural stand-in for the DOM lib's RTCIceServer. That type has
 * no runtime global counterpart (unlike RTCPeerConnection itself), so naming
 * it directly trips eslint's no-undef; TypeScript still checks this object
 * against the real RTCConfiguration shape structurally when it is passed in.
 */
interface IceServerLike {
  urls: string;
}

interface GatherSource {
  label: string;
  url?: string;
  iceServers: IceServerLike[];
}

const gathering = ref(false);
const liveCandidates = ref<LiveCandidateRow[]>([]);
const liveResult = ref<Record<string, string> | null>(null);
const liveError = ref<{ message: string; fix?: string } | null>(null);

/** Guards against a superseded run still writing into a fresh one. */
let gatherSeq = 0;
/** Every RTCPeerConnection currently open, closed on unmount as a safety net. */
const activeConnections = new Set<RTCPeerConnection>();

function toRow(line: string, source: GatherSource): LiveCandidateRow {
  const base: LiveCandidateRow = { candidate: line, url: source.url, sourceLabel: source.label };
  try {
    const parsed = parseCandidate(line);
    return {
      ...base,
      type: parsed.type,
      protocol: parsed.protocol,
      address: parsed.address,
      port: parsed.port,
    };
  } catch {
    // A candidate straight from the browser should always parse; if it does
    // not, still show the raw line rather than dropping it.
    return base;
  }
}

function gatherOne(source: GatherSource, runId: number): Promise<void> {
  return new Promise((resolve) => {
    let pc: RTCPeerConnection;
    try {
      pc = new RTCPeerConnection({ iceServers: source.iceServers });
    } catch {
      resolve();
      return;
    }
    activeConnections.add(pc);

    let settled = false;
    function finish() {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        pc.close();
      } catch {
        // Already closed.
      }
      activeConnections.delete(pc);
      resolve();
    }
    const timer = setTimeout(finish, GATHER_TIMEOUT_MS);

    pc.onicecandidate = (event) => {
      if (runId !== gatherSeq) return;
      if (!event.candidate) {
        finish();
        return;
      }
      const line = event.candidate.candidate;
      if (line) liveCandidates.value.push(toRow(line, source));
    };

    try {
      pc.createDataChannel("probe");
    } catch {
      finish();
      return;
    }

    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .catch(() => finish());
  });
}

/** Drops the run() candidate rows so the record shown here is the
 * interpretation only, since the live list above already shows every
 * candidate with its own badge. */
function interpretationOnly(record: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(record)) {
    if (/^Candidate \d+/.test(k)) continue;
    out[k] = v;
  }
  return out;
}

const liveInterpretation = computed(() => {
  if (!liveResult.value) return null;
  const filtered = interpretationOnly(liveResult.value);
  return Object.keys(filtered).length ? filtered : null;
});

async function startGathering() {
  const runId = ++gatherSeq;
  liveError.value = null;
  liveResult.value = null;
  liveCandidates.value = [];
  gathering.value = true;

  if (typeof RTCPeerConnection === "undefined") {
    liveResult.value = interpretGathering([]);
    gathering.value = false;
    return;
  }

  const sources: GatherSource[] = [
    { label: "No STUN (baseline host candidates)", iceServers: [] },
    ...STUN_SERVERS.filter((s) => selectedServers[s.id]).map((s) => ({
      label: s.label,
      url: s.urls,
      iceServers: [{ urls: s.urls }],
    })),
  ];

  await Promise.all(sources.map((s) => gatherOne(s, runId)));
  if (runId !== gatherSeq) return;

  gathering.value = false;

  if (liveCandidates.value.length === 0) {
    liveResult.value = interpretGathering([]);
    return;
  }

  try {
    const payload = liveCandidates.value.map((c) => ({ candidate: c.candidate, url: c.url }));
    liveResult.value = run(JSON.stringify(payload));
  } catch (e) {
    liveResult.value = null;
    liveError.value =
      e instanceof ToolError
        ? { message: e.message, fix: e.fix }
        : { message: e instanceof Error ? e.message : String(e) };
  }
}

function typeBadgeClass(type?: IceCandidateType): string {
  if (type === "relay") return "border-[var(--positive)]/40 text-[var(--positive)]";
  if (type === "srflx" || type === "prflx") return "border-primary/40 text-primary";
  return "border-border text-muted-foreground";
}

onUnmounted(() => {
  gatherSeq++;
  for (const pc of activeConnections) {
    try {
      pc.close();
    } catch {
      // Already closed.
    }
  }
  activeConnections.clear();
});

/* ------------------------------------------------------------------ *
 * paste and analyze
 * ------------------------------------------------------------------ */

const pasteInput = ref("");
const pasteResult = ref<Record<string, string> | null>(null);
const pasteError = ref<{ message: string; fix?: string } | null>(null);

function analyzePaste() {
  pasteError.value = null;
  try {
    pasteResult.value = run(pasteInput.value);
  } catch (e) {
    pasteResult.value = null;
    pasteError.value =
      e instanceof ToolError
        ? { message: e.message, fix: e.fix }
        : { message: e instanceof Error ? e.message : String(e) };
  }
}
</script>

<template>
  <div class="flex flex-col gap-5 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <Tabs v-model="activeTab" class="gap-4">
      <TabsList class="w-fit">
        <TabsTrigger value="live">Live test</TabsTrigger>
        <TabsTrigger value="paste">Paste</TabsTrigger>
      </TabsList>

      <!-- Live test -->
      <TabsContent value="live" class="flex flex-col gap-4">
        <div class="flex flex-col gap-2">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            STUN servers
          </span>
          <div class="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:gap-x-5 sm:gap-y-2">
            <div v-for="s in STUN_SERVERS" :key="s.id" class="flex items-center gap-2">
              <Checkbox
                :id="`webrtc-stun-${s.id}`"
                :model-value="selectedServers[s.id]"
                :disabled="gathering"
                @update:model-value="(v) => (selectedServers[s.id] = Boolean(v))"
              />
              <Label :for="`webrtc-stun-${s.id}`" class="text-sm">
                {{ s.label }}
                <span class="font-mono text-[0.7rem] text-muted-foreground">{{ s.urls }}</span>
              </Label>
            </div>
          </div>
        </div>

        <div class="flex flex-wrap items-center gap-3">
          <Button :disabled="gathering" @click="startGathering">
            <Play class="size-3.5" aria-hidden="true" />
            {{ gathering ? "Gathering…" : "Start gathering" }}
          </Button>
          <p v-if="props.meta.privacyNote" class="max-w-md text-xs text-muted-foreground">
            {{ props.meta.privacyNote }}
          </p>
        </div>

        <!-- Live candidate stream -->
        <div v-if="gathering || liveCandidates.length" class="flex flex-col gap-1.5">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Candidates
          </span>
          <ul
            v-if="liveCandidates.length"
            class="flex max-h-72 flex-col gap-1.5 overflow-y-auto rounded-[10px] bg-secondary p-2 shadow-[var(--sh-inset)]"
          >
            <li
              v-for="(row, i) in liveCandidates"
              :key="i"
              class="flex flex-wrap items-center gap-2 rounded-[8px] bg-card px-2.5 py-1.5 text-xs shadow-[var(--sh-sm)]"
            >
              <span
                class="rounded-full border px-2 py-0.5 text-[0.65rem] font-medium uppercase"
                :class="typeBadgeClass(row.type)"
              >
                {{ row.type ?? "raw" }}
              </span>
              <span
                v-if="row.protocol"
                class="rounded-full border border-border px-2 py-0.5 text-[0.65rem] font-medium text-muted-foreground uppercase"
              >
                {{ row.protocol }}
              </span>
              <span class="font-mono text-xs">
                {{ row.address && row.port !== undefined ? `${row.address}:${row.port}` : row.candidate }}
              </span>
              <span class="ml-auto shrink-0 text-[0.65rem] text-muted-foreground">
                {{ row.sourceLabel }}
              </span>
            </li>
          </ul>
          <p v-else class="text-xs text-muted-foreground">Waiting for candidates…</p>
        </div>

        <div
          v-if="liveError"
          role="alert"
          class="flex flex-col gap-1 rounded-[10px] bg-secondary p-3 text-xs shadow-[var(--sh-inset)]"
        >
          <span class="font-semibold text-destructive">{{ liveError.message }}</span>
          <span v-if="liveError.fix" class="text-muted-foreground">{{ liveError.fix }}</span>
        </div>

        <div v-if="!gathering && liveInterpretation" class="flex flex-col gap-1.5">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Interpretation
          </span>
          <OutputView :output="liveInterpretation" />
        </div>

        <p v-else-if="!gathering && !liveCandidates.length && !liveError" class="text-xs text-muted-foreground">
          Pick the STUN servers to contact, then press Start gathering. A baseline gathering with
          no STUN server always runs too, so you can see the plain host candidates on their own.
        </p>
      </TabsContent>

      <!-- Paste -->
      <TabsContent value="paste" class="flex flex-col gap-4">
        <div class="flex flex-col gap-1.5">
          <Label for="webrtc-paste" class="text-xs text-muted-foreground">
            Candidate lines, full SDP, or a JSON array
          </Label>
          <Textarea
            id="webrtc-paste"
            v-model="pasteInput"
            rows="8"
            placeholder="candidate:842163049 1 udp 1677729535 192.168.1.5 54321 typ host"
            spellcheck="false"
            class="font-mono text-sm"
          />
        </div>

        <Button class="self-start" @click="analyzePaste">
          <Search class="size-3.5" aria-hidden="true" />
          Analyze
        </Button>

        <div
          v-if="pasteError"
          role="alert"
          class="flex flex-col gap-1 rounded-[10px] bg-secondary p-3 text-xs shadow-[var(--sh-inset)]"
        >
          <span class="font-semibold text-destructive">{{ pasteError.message }}</span>
          <span v-if="pasteError.fix" class="text-muted-foreground">{{ pasteError.fix }}</span>
        </div>

        <OutputView v-if="pasteResult" :output="pasteResult" />
      </TabsContent>
    </Tabs>
  </div>
</template>
