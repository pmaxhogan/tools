<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, shallowRef } from "vue";
import QRCode from "qrcode";
import { Check, Download, FileIcon, Send, X } from "lucide-vue-next";
import type { ToolMeta } from "@/tools/types";
import { ToolError } from "@/tools/types";
import {
  BUFFER_HIGH_WATER,
  BUFFER_LOW_WATER,
  ROOM_FRAGMENT_KEY,
  SIGNAL_PATH_PREFIX,
  TOOL_PATH,
  batchBytes,
  chunkSize,
  decodeControl,
  encodeControl,
  generateRoomCode,
  joinFragment,
  parseRoomCode,
  parseSignal,
  roomFromFragment,
  securityCode,
  transferProgress,
  type ControlMessage,
  type FileEntry,
  type Progress,
} from "@/tools/p2p-file-transfer/index";
import { formatBytes } from "@/lib/format";
import { downloadBlob } from "@/lib/download";
import { readFragment, writeFragment } from "@/lib/fragment";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import CopyButton from "../CopyButton.vue";

/**
 * Local File Drop: the live surface.
 *
 * The panel owns what only a browser can hold: the signaling WebSocket to the
 * worker's room, the RTCPeerConnection, the data channel, the File objects
 * and the received bytes. Everything both ends must agree on (room codes,
 * the signaling allow-list, control frame shapes, chunking, progress, the
 * security code) comes from the pure logic module, so the two browsers and
 * the relay can never disagree about the protocol.
 *
 * Roles are decided by the room, not by who clicked what: the first socket
 * into a room is the host and makes the WebRTC offer, the second is the
 * guest and answers. That keeps a page reload on either side harmless.
 */
defineProps<{ meta: ToolMeta }>();

/* ---------------------------------------------------------------- */
/* state                                                            */
/* ---------------------------------------------------------------- */

type Phase = "idle" | "waiting" | "connecting" | "connected" | "ended";

interface UiError {
  message: string;
  fix?: string;
}

interface OutgoingBatch {
  id: string;
  files: File[];
  entries: FileEntry[];
  status: "offered" | "sending" | "done" | "declined" | "cancelled" | "failed";
  bytesDone: number;
  total: number;
  startedAt: number;
  currentIndex: number;
}

interface ReceivedFile {
  /** Per receipt, so the same file sent twice never collides in the list. */
  key: number;
  entry: FileEntry;
  blob: Blob;
  saved: boolean;
}

interface IncomingBatch {
  id: string;
  entries: FileEntry[];
  status: "offered" | "receiving" | "done" | "declined" | "cancelled" | "failed";
  bytesDone: number;
  total: number;
  startedAt: number;
  currentIndex: number;
  /** Chunks of the file currently arriving. */
  chunks: ArrayBuffer[];
  chunkBytes: number;
}

const STUN_SERVER = "stun:stun.cloudflare.com:3478";
const CHANNEL_LABEL = "files";

const phase = ref<Phase>("idle");
const role = ref<"host" | "guest" | null>(null);
const code = ref<string>("");
const joinInput = ref("");
const useStun = ref(true);
const qrSvg = ref<string | null>(null);
const security = ref<string>("");
const peerName = ref<string>("");
const error = ref<UiError | null>(null);
const notice = ref<string>("");
const dragging = ref(false);
const fileInput = ref<HTMLInputElement>();

const outgoing = ref<OutgoingBatch | null>(null);
const incoming = ref<IncomingBatch | null>(null);
const received = ref<ReceivedFile[]>([]);
let receiptCounter = 0;
const sentLog = ref<FileEntry[]>([]);

/** Timer tick so progress rates and ETAs update while a transfer runs. */
const now = ref(Date.now());
let ticker: ReturnType<typeof setInterval> | undefined;

let ws: WebSocket | null = null;
const pc = shallowRef<RTCPeerConnection | null>(null);
let channel: RTCDataChannel | null = null;
/** Set once the guest has applied the offer, so early ICE is not lost. */
let pendingIce: Parameters<RTCPeerConnection["addIceCandidate"]>[0][] = [];
let remoteReady = false;
let cancelOutgoing = false;

const joinLink = computed(() =>
  code.value && typeof window !== "undefined"
    ? `${window.location.origin}${TOOL_PATH}${joinFragment(code.value)}`
    : "",
);
const spacedCode = computed(() =>
  code.value ? `${code.value.slice(0, 3)} ${code.value.slice(3)}` : "",
);
const connected = computed(() => phase.value === "connected");
const busySending = computed(
  () => outgoing.value?.status === "offered" || outgoing.value?.status === "sending",
);
const busyReceiving = computed(
  () => incoming.value?.status === "offered" || incoming.value?.status === "receiving",
);

const outProgress = computed<Progress | null>(() => {
  const b = outgoing.value;
  if (!b || b.status !== "sending") return null;
  return transferProgress(b.bytesDone, b.total, now.value - b.startedAt);
});
const inProgress = computed<Progress | null>(() => {
  const b = incoming.value;
  if (!b || b.status !== "receiving") return null;
  return transferProgress(b.bytesDone, b.total, now.value - b.startedAt);
});

const phaseLabel = computed(() => {
  switch (phase.value) {
    case "idle":
      return "Not connected";
    case "waiting":
      return "Waiting for the other device";
    case "connecting":
      return "Connecting";
    case "connected":
      return peerName.value ? `Connected to ${peerName.value}` : "Connected";
    case "ended":
      return "Disconnected";
  }
  return "";
});

/* ---------------------------------------------------------------- */
/* helpers                                                          */
/* ---------------------------------------------------------------- */

function fail(message: string, fix?: string) {
  error.value = { message, fix };
}

function clearError() {
  error.value = null;
}

function describe(e: unknown): UiError {
  if (e instanceof ToolError) return { message: e.message, fix: e.fix };
  if (e instanceof Error) return { message: e.message };
  return { message: String(e) };
}

/** A short, non-identifying label for the other side's screen. */
function deviceName(): string {
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const platform = nav.userAgentData?.platform || nav.platform || "";
  const ua = navigator.userAgent;
  const browser = /firefox/i.test(ua)
    ? "Firefox"
    : /edg\//i.test(ua)
      ? "Edge"
      : /chrome|crios/i.test(ua)
        ? "Chrome"
        : /safari/i.test(ua)
          ? "Safari"
          : "a browser";
  return platform ? `${browser} on ${platform}` : browser;
}

function updateFragment() {
  const opts: Record<string, string> = {};
  if (code.value) opts[ROOM_FRAGMENT_KEY] = code.value;
  if (!useStun.value) opts.stun = "0";
  writeFragment({ opts });
}

function startTicker() {
  if (ticker) return;
  ticker = setInterval(() => (now.value = Date.now()), 250);
}

function stopTicker() {
  if (!ticker) return;
  clearInterval(ticker);
  ticker = undefined;
}

/* ---------------------------------------------------------------- */
/* signaling                                                        */
/* ---------------------------------------------------------------- */

function signalUrl(room: string): string {
  const url = new URL(`${SIGNAL_PATH_PREFIX}${room}`, window.location.origin);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  return url.toString();
}

function sendSignal(msg: unknown) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

async function connect(room: string) {
  teardown(false);
  clearError();
  notice.value = "";
  code.value = room;
  updateFragment();
  phase.value = "waiting";
  security.value = "";
  peerName.value = "";

  try {
    qrSvg.value = await QRCode.toString(joinLink.value, {
      type: "svg",
      margin: 1,
      width: 192,
      errorCorrectionLevel: "M",
    });
  } catch {
    qrSvg.value = null;
  }

  let socket: WebSocket;
  try {
    socket = new WebSocket(signalUrl(room));
  } catch (e) {
    fail(describe(e).message, "The signaling server could not be reached.");
    phase.value = "idle";
    return;
  }
  ws = socket;

  socket.addEventListener("message", (event) => onSignal(socket, event.data));
  socket.addEventListener("close", (event) => {
    if (ws !== socket) return;
    ws = null;
    if (phase.value === "connected" || phase.value === "idle" || phase.value === "ended") return;
    // Lost signaling before the channel opened: the room refused us or went away.
    if (event.code === 1006 || event.code === 1008) {
      const reason =
        event.code === 1008
          ? "The room refused the connection."
          : "The signaling server closed the connection.";
      fail(
        reason,
        "If this page is running without its worker (astro dev), the relay is not available. Otherwise the room may be full or expired: create a new one.",
      );
      phase.value = "idle";
    }
  });
  socket.addEventListener("error", () => {
    if (ws !== socket) return;
    if (phase.value === "connected") return;
    fail(
      "Could not reach the signaling relay.",
      "Check your connection and try again. Rooms are hosted at this site's /api endpoint.",
    );
  });
}

async function onSignal(socket: WebSocket, data: unknown) {
  if (ws !== socket) return;
  let msg;
  try {
    msg = parseSignal(data);
  } catch {
    return; // Not something we understand; ignore rather than trust it.
  }
  try {
    switch (msg.type) {
      case "joined":
        role.value = msg.role;
        if (msg.peerPresent) {
          phase.value = "connecting";
          if (msg.role === "host") await startOffer();
        } else {
          phase.value = "waiting";
        }
        break;
      case "peer-joined":
        phase.value = "connecting";
        if (role.value === "host") await startOffer();
        break;
      case "peer-left":
        if (phase.value !== "connected") {
          phase.value = "waiting";
          resetPeerConnection();
        }
        break;
      case "error":
        fail(msg.message, "Create a new room and share the fresh code.");
        phase.value = "idle";
        break;
      case "offer": {
        const conn = ensurePeerConnection();
        await conn.setRemoteDescription({ type: "offer", sdp: msg.sdp });
        remoteReady = true;
        const answer = await conn.createAnswer();
        await conn.setLocalDescription(answer);
        sendSignal({ type: "answer", sdp: answer.sdp });
        await flushPendingIce();
        break;
      }
      case "answer": {
        const conn = pc.value;
        if (!conn) return;
        await conn.setRemoteDescription({ type: "answer", sdp: msg.sdp });
        remoteReady = true;
        await flushPendingIce();
        break;
      }
      case "ice": {
        const conn = ensurePeerConnection();
        if (!remoteReady) {
          pendingIce.push(msg.candidate);
        } else {
          await conn.addIceCandidate(msg.candidate).catch(() => {});
        }
        break;
      }
      case "bye":
        break;
    }
  } catch (e) {
    fail(`WebRTC negotiation failed: ${describe(e).message}`, "Leave the room and try again.");
  }
}

async function flushPendingIce() {
  const conn = pc.value;
  if (!conn) return;
  const queue = pendingIce;
  pendingIce = [];
  for (const c of queue) await conn.addIceCandidate(c).catch(() => {});
}

/* ---------------------------------------------------------------- */
/* WebRTC                                                           */
/* ---------------------------------------------------------------- */

function ensurePeerConnection(): RTCPeerConnection {
  if (pc.value) return pc.value;
  const conn = new RTCPeerConnection({
    iceServers: useStun.value ? [{ urls: STUN_SERVER }] : [],
  });
  conn.addEventListener("icecandidate", (event) => {
    if (event.candidate) sendSignal({ type: "ice", candidate: event.candidate.toJSON() });
  });
  conn.addEventListener("datachannel", (event) => attachChannel(event.channel));
  conn.addEventListener("connectionstatechange", () => {
    const state = conn.connectionState;
    if (state === "failed") {
      if (phase.value === "connected") {
        endSession("The connection to the other device was lost.");
      } else {
        fail(
          "The two devices could not connect to each other directly.",
          useStun.value
            ? "Both networks block direct connections (often two strict NATs or firewalls). This tool never relays your files through a server, so try the same Wi-Fi, a mobile hotspot, or a different network on one side."
            : "STUN is off, so only local network addresses were tried. Turn STUN on if the two devices are not on the same network.",
        );
        phase.value = "waiting";
        resetPeerConnection();
      }
    } else if ((state === "disconnected" || state === "closed") && phase.value === "connected") {
      endSession("The other device disconnected.");
    }
  });
  pc.value = conn;
  return conn;
}

async function startOffer() {
  const conn = ensurePeerConnection();
  if (channel) return; // An offer is already in flight.
  const dc = conn.createDataChannel(CHANNEL_LABEL, { ordered: true });
  attachChannel(dc);
  const offer = await conn.createOffer();
  await conn.setLocalDescription(offer);
  sendSignal({ type: "offer", sdp: offer.sdp });
}

function attachChannel(dc: RTCDataChannel) {
  channel = dc;
  dc.binaryType = "arraybuffer";
  dc.bufferedAmountLowThreshold = BUFFER_LOW_WATER;
  dc.addEventListener("open", onChannelOpen);
  dc.addEventListener("message", (event) => onChannelMessage(event.data));
  dc.addEventListener("close", () => {
    if (phase.value === "connected") endSession("The other device closed the connection.");
  });
  dc.addEventListener("error", () => {
    if (phase.value === "connected") endSession("The data channel failed.");
  });
}

async function onChannelOpen() {
  phase.value = "connected";
  clearError();
  const conn = pc.value;
  if (conn?.localDescription && conn.remoteDescription) {
    try {
      security.value = await securityCode(conn.localDescription.sdp, conn.remoteDescription.sdp);
    } catch {
      security.value = "";
    }
  }
  channel?.send(encodeControl({ type: "hello", name: deviceName() }));
  // The relay's job is done. Say goodbye and let the room forget us.
  sendSignal({ type: "bye" });
  ws?.close(1000, "connected");
  ws = null;
}

function resetPeerConnection() {
  channel?.close();
  channel = null;
  pc.value?.close();
  pc.value = null;
  pendingIce = [];
  remoteReady = false;
}

function endSession(message: string) {
  if (busySending.value && outgoing.value) {
    outgoing.value.status = "failed";
    cancelOutgoing = true;
  }
  if (busyReceiving.value && incoming.value) incoming.value.status = "failed";
  resetPeerConnection();
  ws?.close();
  ws = null;
  phase.value = "ended";
  notice.value = message;
  stopTicker();
}

/** Full reset back to the landing state. */
function teardown(clearRoom = true) {
  cancelOutgoing = true;
  resetPeerConnection();
  if (ws) {
    sendSignal({ type: "bye" });
    ws.close(1000, "left");
    ws = null;
  }
  stopTicker();
  outgoing.value = null;
  incoming.value = null;
  security.value = "";
  peerName.value = "";
  role.value = null;
  if (clearRoom) {
    code.value = "";
    qrSvg.value = null;
    phase.value = "idle";
    updateFragment();
  }
}

/* ---------------------------------------------------------------- */
/* actions                                                          */
/* ---------------------------------------------------------------- */

function createRoom() {
  connect(generateRoomCode());
}

function joinRoom() {
  clearError();
  let room: string;
  try {
    room = parseRoomCode(joinInput.value);
  } catch (e) {
    error.value = describe(e);
    return;
  }
  connect(room);
}

function leaveRoom() {
  teardown(true);
  notice.value = "";
  clearError();
}

function newRoom() {
  teardown(true);
  notice.value = "";
  createRoom();
}

/* ---------------------------------------------------------------- */
/* sending                                                          */
/* ---------------------------------------------------------------- */

function onDrop(e: DragEvent) {
  dragging.value = false;
  const files = Array.from(e.dataTransfer?.files ?? []);
  if (files.length) offerFiles(files);
}

function onPickFiles(e: Event) {
  const input = e.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  input.value = "";
  if (files.length) offerFiles(files);
}

function offerFiles(files: File[]) {
  if (!connected.value || !channel) return;
  if (busySending.value) {
    fail("A transfer is already in progress.", "Wait for it to finish or cancel it first.");
    return;
  }
  clearError();
  const id = crypto.randomUUID();
  const entries: FileEntry[] = files.map((f, i) => ({
    id: `${i}`,
    name: f.name,
    size: f.size,
    type: f.type,
  }));
  outgoing.value = {
    id,
    files,
    entries,
    status: "offered",
    bytesDone: 0,
    total: batchBytes(entries),
    startedAt: Date.now(),
    currentIndex: 0,
  };
  channel.send(encodeControl({ type: "manifest", batch: id, files: entries }));
}

function waitForDrain(dc: RTCDataChannel): Promise<void> {
  if (dc.bufferedAmount <= BUFFER_HIGH_WATER) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      dc.removeEventListener("bufferedamountlow", done);
      dc.removeEventListener("close", done);
      resolve();
    };
    dc.addEventListener("bufferedamountlow", done);
    dc.addEventListener("close", done);
  });
}

/** Resolves once the channel's send buffer is empty, or the channel closes. */
function waitForEmpty(dc: RTCDataChannel): Promise<void> {
  return new Promise((resolve) => {
    const check = () => {
      if (dc.readyState !== "open" || dc.bufferedAmount === 0) {
        clearInterval(poll);
        resolve();
      }
    };
    const poll = setInterval(check, 50);
    check();
  });
}

async function runSend(batch: OutgoingBatch) {
  const dc = channel;
  if (!dc) return;
  cancelOutgoing = false;
  batch.status = "sending";
  batch.startedAt = Date.now();
  startTicker();
  const size = chunkSize(pc.value?.sctp?.maxMessageSize);
  try {
    for (let i = 0; i < batch.files.length; i++) {
      batch.currentIndex = i;
      const file = batch.files[i];
      const entry = batch.entries[i];
      dc.send(encodeControl({ type: "file-start", batch: batch.id, id: entry.id }));
      let offset = 0;
      while (offset < file.size) {
        if (cancelOutgoing || dc.readyState !== "open") throw new Error("cancelled");
        const slice = file.slice(offset, offset + size);
        const buf = await slice.arrayBuffer();
        dc.send(buf);
        offset += buf.byteLength;
        batch.bytesDone += buf.byteLength;
        await waitForDrain(dc);
      }
      dc.send(encodeControl({ type: "file-end", batch: batch.id, id: entry.id }));
      sentLog.value = [entry, ...sentLog.value].slice(0, 50);
    }
    // Everything is queued, but up to BUFFER_HIGH_WATER may still sit in the
    // channel's buffer. Only claim "done" once the last byte has actually left.
    await waitForEmpty(dc);
    dc.send(encodeControl({ type: "batch-done", batch: batch.id }));
    batch.status = "done";
  } catch {
    if (batch.status === "sending") batch.status = cancelOutgoing ? "cancelled" : "failed";
    if (dc.readyState === "open" && batch.status === "cancelled") {
      dc.send(encodeControl({ type: "cancel", batch: batch.id, reason: "sender cancelled" }));
    }
  } finally {
    if (!busyReceiving.value) stopTicker();
  }
}

function cancelSend() {
  const b = outgoing.value;
  if (!b) return;
  if (b.status === "offered") {
    b.status = "cancelled";
    channel?.send(encodeControl({ type: "cancel", batch: b.id, reason: "sender cancelled" }));
    return;
  }
  cancelOutgoing = true;
}

/* ---------------------------------------------------------------- */
/* receiving                                                        */
/* ---------------------------------------------------------------- */

function onChannelMessage(data: unknown) {
  if (typeof data === "string") {
    let msg: ControlMessage;
    try {
      msg = decodeControl(data);
    } catch {
      return; // Malformed control frame from the peer: ignore it.
    }
    handleControl(msg);
    return;
  }
  const buf = data instanceof ArrayBuffer ? data : null;
  if (!buf) return;
  const b = incoming.value;
  if (!b || b.status !== "receiving") return;
  b.chunks.push(buf);
  b.chunkBytes += buf.byteLength;
  b.bytesDone += buf.byteLength;
}

function handleControl(msg: ControlMessage) {
  switch (msg.type) {
    case "hello":
      peerName.value = msg.name;
      break;
    case "manifest": {
      if (busyReceiving.value) {
        channel?.send(encodeControl({ type: "decline", batch: msg.batch }));
        return;
      }
      incoming.value = {
        id: msg.batch,
        entries: msg.files,
        status: "offered",
        bytesDone: 0,
        total: batchBytes(msg.files),
        startedAt: Date.now(),
        currentIndex: 0,
        chunks: [],
        chunkBytes: 0,
      };
      break;
    }
    case "accept": {
      const b = outgoing.value;
      if (b && b.id === msg.batch && b.status === "offered") void runSend(b);
      break;
    }
    case "decline": {
      const b = outgoing.value;
      if (b && b.id === msg.batch && b.status === "offered") b.status = "declined";
      break;
    }
    case "file-start": {
      const b = incoming.value;
      if (!b || b.id !== msg.batch || b.status !== "receiving") return;
      const idx = b.entries.findIndex((e) => e.id === msg.id);
      if (idx < 0) return;
      b.currentIndex = idx;
      b.chunks = [];
      b.chunkBytes = 0;
      break;
    }
    case "file-end": {
      const b = incoming.value;
      if (!b || b.id !== msg.batch || b.status !== "receiving") return;
      const entry = b.entries[b.currentIndex];
      if (!entry || entry.id !== msg.id) return;
      const blob = new Blob(b.chunks, { type: entry.type || "application/octet-stream" });
      b.chunks = [];
      b.chunkBytes = 0;
      received.value = [{ key: ++receiptCounter, entry, blob, saved: false }, ...received.value];
      break;
    }
    case "batch-done": {
      const b = incoming.value;
      if (b && b.id === msg.batch && b.status === "receiving") {
        b.status = "done";
        if (!busySending.value) stopTicker();
      }
      break;
    }
    case "cancel": {
      if (incoming.value?.id === msg.batch && busyReceiving.value) {
        incoming.value.status = "cancelled";
        incoming.value.chunks = [];
        if (!busySending.value) stopTicker();
      }
      if (outgoing.value?.id === msg.batch && busySending.value) {
        cancelOutgoing = true;
        if (outgoing.value.status === "offered") outgoing.value.status = "cancelled";
      }
      break;
    }
  }
}

function acceptIncoming() {
  const b = incoming.value;
  if (!b || b.status !== "offered") return;
  b.status = "receiving";
  b.startedAt = Date.now();
  startTicker();
  channel?.send(encodeControl({ type: "accept", batch: b.id }));
}

function declineIncoming() {
  const b = incoming.value;
  if (!b || b.status !== "offered") return;
  b.status = "declined";
  channel?.send(encodeControl({ type: "decline", batch: b.id }));
}

function cancelReceive() {
  const b = incoming.value;
  if (!b || b.status !== "receiving") return;
  b.status = "cancelled";
  b.chunks = [];
  channel?.send(encodeControl({ type: "cancel", batch: b.id, reason: "receiver cancelled" }));
  if (!busySending.value) stopTicker();
}

function saveFile(item: ReceivedFile) {
  downloadBlob(item.blob, item.entry.name);
  item.saved = true;
}

function saveAll() {
  const pending = received.value.filter((r) => !r.saved);
  pending.forEach((item, i) => setTimeout(() => saveFile(item), i * 300));
}

function discardReceived() {
  received.value = [];
}

/* ---------------------------------------------------------------- */
/* lifecycle                                                        */
/* ---------------------------------------------------------------- */

onMounted(() => {
  const frag = readFragment();
  if (frag.opts.stun === "0") useStun.value = false;
  const room = roomFromFragment(window.location.hash);
  if (room) {
    joinInput.value = room;
    void connect(room);
  }
});

onUnmounted(() => {
  teardown(false);
});
</script>

<template>
  <div class="flex flex-col gap-4 rounded-[18px] border bg-card p-5 shadow-[var(--sh-sm)] sm:p-6">
    <!-- Status row -->
    <div class="flex flex-wrap items-center gap-2">
      <span
        class="inline-flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium"
        :class="
          connected
            ? 'border-[var(--positive)]/40 bg-[var(--positive-soft)] text-[var(--positive)]'
            : 'bg-secondary text-muted-foreground'
        "
        aria-live="polite"
      >
        <span
          class="size-2 rounded-full"
          :class="
            connected
              ? 'bg-[var(--positive)]'
              : phase === 'waiting' || phase === 'connecting'
                ? 'animate-pulse bg-primary'
                : 'bg-muted-foreground/50'
          "
          aria-hidden="true"
        />
        {{ phaseLabel }}
      </span>
      <span v-if="security" class="text-xs text-muted-foreground">
        Security code
        <span class="ml-1 font-mono font-semibold text-foreground">{{ security }}</span>
      </span>
      <span class="grow" />
      <Button v-if="phase !== 'idle'" variant="ghost" size="sm" @click="leaveRoom">
        Leave room
      </Button>
    </div>

    <!-- Errors -->
    <div
      v-if="error"
      role="alert"
      class="rounded-lg border border-destructive/50 bg-destructive/5 px-3 py-2 text-sm"
    >
      <p class="font-medium text-destructive">{{ error.message }}</p>
      <p v-if="error.fix" class="mt-1 text-muted-foreground">{{ error.fix }}</p>
    </div>

    <!-- Landing: create or join -->
    <div v-if="phase === 'idle'" class="grid gap-4 sm:grid-cols-2">
      <div class="flex flex-col gap-3 rounded-[10px] bg-secondary p-4 shadow-[var(--sh-inset)]">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          On this device
        </span>
        <p class="text-sm text-muted-foreground">
          Create a room, then show the code or QR code to the other device.
        </p>
        <Button class="w-fit" @click="createRoom">Create a room</Button>
        <div class="flex items-center gap-2 pt-1">
          <Switch
            id="drop-stun"
            :model-value="useStun"
            @update:model-value="
              (v) => {
                useStun = Boolean(v);
                updateFragment();
              }
            "
          />
          <Label for="drop-stun" class="text-xs text-muted-foreground">
            Use STUN (needed across different networks)
          </Label>
        </div>
      </div>
      <form
        class="flex flex-col gap-3 rounded-[10px] bg-secondary p-4 shadow-[var(--sh-inset)]"
        @submit.prevent="joinRoom"
      >
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          On the other device
        </span>
        <p class="text-sm text-muted-foreground">
          Type the six character code shown on the first device, or paste its link.
        </p>
        <div class="flex gap-2">
          <Input
            id="drop-join"
            :model-value="joinInput"
            placeholder="ABC DEF"
            autocomplete="off"
            autocapitalize="characters"
            spellcheck="false"
            class="h-9 bg-card font-mono uppercase"
            aria-label="Room code"
            @update:model-value="(v) => (joinInput = String(v))"
          />
          <Button type="submit" variant="outline">Join</Button>
        </div>
      </form>
    </div>

    <!-- Waiting / connecting: show the code -->
    <div
      v-else-if="phase === 'waiting' || phase === 'connecting'"
      class="flex flex-col gap-4 rounded-[10px] bg-secondary p-4 shadow-[var(--sh-inset)] sm:flex-row sm:items-start"
    >
      <div
        v-if="qrSvg"
        class="mx-auto w-48 shrink-0 overflow-hidden rounded-[8px] bg-white p-2 sm:mx-0"
      >
        <img
          :src="`data:image/svg+xml,${encodeURIComponent(qrSvg)}`"
          alt="QR code of the join link"
          class="block h-auto w-full"
          width="192"
          height="192"
        />
      </div>
      <div class="flex min-w-0 grow flex-col gap-3">
        <div>
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Room code
          </span>
          <p class="font-mono text-4xl font-semibold tracking-[0.12em] tabular-nums">
            {{ spacedCode }}
          </p>
        </div>
        <div class="flex flex-col gap-1">
          <span class="text-xs text-muted-foreground">Join link</span>
          <div class="flex items-center gap-1">
            <code class="min-w-0 truncate rounded-[6px] bg-card px-2 py-1 font-mono text-xs">
              {{ joinLink }}
            </code>
            <CopyButton :text="joinLink" label="Copy" />
          </div>
        </div>
        <p class="text-sm text-muted-foreground">
          <template v-if="phase === 'connecting'">
            The other device is here. Negotiating a direct connection…
          </template>
          <template v-else>
            Open this link on the other device, scan the QR code, or type the code into
            <span class="font-medium text-foreground">Join a room</span> on its copy of this page.
            The room stays open for ten minutes.
          </template>
        </p>
      </div>
    </div>

    <!-- Ended -->
    <div
      v-else-if="phase === 'ended'"
      class="flex flex-col gap-3 rounded-[10px] bg-secondary p-4 shadow-[var(--sh-inset)]"
    >
      <p class="text-sm">{{ notice }}</p>
      <div class="flex gap-2">
        <Button size="sm" @click="newRoom">Create a new room</Button>
        <Button size="sm" variant="ghost" @click="leaveRoom">Back</Button>
      </div>
    </div>

    <!-- Connected: send surface -->
    <template v-if="connected">
      <div
        class="rounded-[10px] bg-secondary shadow-[var(--sh-inset)]"
        :class="dragging ? 'ring-2 ring-ring' : ''"
        @dragover.prevent="dragging = true"
        @dragleave="dragging = false"
        @drop.prevent="onDrop"
      >
        <div class="flex items-center justify-between px-3 pt-2">
          <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Send files
          </span>
          <Button variant="ghost" size="sm" :disabled="busySending" @click="fileInput?.click()">
            Choose files…
          </Button>
          <input ref="fileInput" type="file" class="hidden" multiple @change="onPickFiles" />
        </div>
        <div class="px-3 pt-1 pb-4">
          <p class="text-sm text-muted-foreground">
            Drop files here or pick them. They stream straight to the other device over the
            encrypted WebRTC channel; nothing is uploaded anywhere.
          </p>
        </div>
      </div>

      <!-- Outgoing batch -->
      <div
        v-if="outgoing"
        class="flex flex-col gap-2 rounded-[10px] border bg-card p-3 text-sm"
        aria-live="polite"
      >
        <div class="flex flex-wrap items-center gap-2">
          <Send class="size-4 text-muted-foreground" aria-hidden="true" />
          <span class="font-medium">
            <template v-if="outgoing.status === 'offered'">
              Waiting for the other device to accept
              {{ outgoing.entries.length === 1 ? "1 file" : `${outgoing.entries.length} files` }}
              ({{ formatBytes(outgoing.total) }})
            </template>
            <template v-else-if="outgoing.status === 'sending'">
              Sending {{ outgoing.entries[outgoing.currentIndex]?.name }}
            </template>
            <template v-else-if="outgoing.status === 'done'">
              Sent
              {{ outgoing.entries.length === 1 ? "1 file" : `${outgoing.entries.length} files` }}
              ({{ formatBytes(outgoing.total) }})
            </template>
            <template v-else-if="outgoing.status === 'declined'">
              The other device declined the files.
            </template>
            <template v-else-if="outgoing.status === 'cancelled'">Transfer cancelled.</template>
            <template v-else>Transfer failed before it finished.</template>
          </span>
          <span class="grow" />
          <Button
            v-if="outgoing.status === 'offered' || outgoing.status === 'sending'"
            variant="ghost"
            size="sm"
            @click="cancelSend"
          >
            Cancel
          </Button>
        </div>
        <template v-if="outProgress">
          <div
            class="h-2 w-full overflow-hidden rounded-full bg-secondary"
            role="progressbar"
            :aria-valuenow="Math.round(outProgress.percent)"
            aria-valuemin="0"
            aria-valuemax="100"
          >
            <div
              class="h-full rounded-full bg-primary transition-[width] duration-200"
              :style="{ width: `${outProgress.percent}%` }"
            />
          </div>
          <p class="text-xs text-muted-foreground">
            {{ outProgress.label }}
            <template v-if="outProgress.rateLabel"> · {{ outProgress.rateLabel }}</template>
            <template v-if="outProgress.etaLabel"> · {{ outProgress.etaLabel }}</template>
          </p>
        </template>
      </div>

      <!-- Incoming batch -->
      <div
        v-if="incoming"
        class="flex flex-col gap-2 rounded-[10px] border bg-card p-3 text-sm"
        :class="incoming.status === 'offered' ? 'border-ring' : ''"
        aria-live="polite"
      >
        <div class="flex flex-wrap items-center gap-2">
          <Download class="size-4 text-muted-foreground" aria-hidden="true" />
          <span class="font-medium">
            <template v-if="incoming.status === 'offered'">
              The other device wants to send
              {{ incoming.entries.length === 1 ? "1 file" : `${incoming.entries.length} files` }}
              ({{ formatBytes(incoming.total) }})
            </template>
            <template v-else-if="incoming.status === 'receiving'">
              Receiving {{ incoming.entries[incoming.currentIndex]?.name }}
            </template>
            <template v-else-if="incoming.status === 'done'">
              Received
              {{ incoming.entries.length === 1 ? "1 file" : `${incoming.entries.length} files` }}
              ({{ formatBytes(incoming.total) }})
            </template>
            <template v-else-if="incoming.status === 'declined'">Declined.</template>
            <template v-else-if="incoming.status === 'cancelled'">Transfer cancelled.</template>
            <template v-else>Transfer failed before it finished.</template>
          </span>
          <span class="grow" />
          <template v-if="incoming.status === 'offered'">
            <Button size="sm" @click="acceptIncoming">Accept</Button>
            <Button size="sm" variant="ghost" @click="declineIncoming">Decline</Button>
          </template>
          <Button
            v-else-if="incoming.status === 'receiving'"
            variant="ghost"
            size="sm"
            @click="cancelReceive"
          >
            Cancel
          </Button>
        </div>
        <ul v-if="incoming.status === 'offered'" class="flex flex-col gap-1 pl-6">
          <li
            v-for="entry in incoming.entries.slice(0, 8)"
            :key="entry.id"
            class="flex items-center gap-2 text-xs text-muted-foreground"
          >
            <FileIcon class="size-3.5 shrink-0" aria-hidden="true" />
            <span class="truncate">{{ entry.name }}</span>
            <span class="shrink-0 tabular-nums">{{ formatBytes(entry.size) }}</span>
          </li>
          <li v-if="incoming.entries.length > 8" class="text-xs text-muted-foreground">
            and {{ incoming.entries.length - 8 }} more
          </li>
        </ul>
        <template v-if="inProgress">
          <div
            class="h-2 w-full overflow-hidden rounded-full bg-secondary"
            role="progressbar"
            :aria-valuenow="Math.round(inProgress.percent)"
            aria-valuemin="0"
            aria-valuemax="100"
          >
            <div
              class="h-full rounded-full bg-primary transition-[width] duration-200"
              :style="{ width: `${inProgress.percent}%` }"
            />
          </div>
          <p class="text-xs text-muted-foreground">
            {{ inProgress.label }}
            <template v-if="inProgress.rateLabel"> · {{ inProgress.rateLabel }}</template>
            <template v-if="inProgress.etaLabel"> · {{ inProgress.etaLabel }}</template>
          </p>
        </template>
      </div>
    </template>

    <!-- Received files: survive a disconnect so nothing is lost -->
    <div
      v-if="received.length"
      class="flex flex-col gap-2 rounded-[10px] bg-secondary p-3 shadow-[var(--sh-inset)]"
    >
      <div class="flex flex-wrap items-center gap-2">
        <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
          Received files
        </span>
        <span class="grow" />
        <Button v-if="received.some((r) => !r.saved)" variant="outline" size="sm" @click="saveAll">
          Save all
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-label="Discard received files"
          @click="discardReceived"
        >
          <X class="size-4" />
        </Button>
      </div>
      <ul class="flex flex-col gap-1">
        <li
          v-for="item in received"
          :key="item.key"
          class="flex items-center gap-2 rounded-[6px] bg-card px-2 py-1.5 text-sm"
        >
          <Check
            v-if="item.saved"
            class="size-4 shrink-0 text-[var(--positive)]"
            aria-hidden="true"
          />
          <FileIcon v-else class="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          <span class="min-w-0 grow truncate">{{ item.entry.name }}</span>
          <span class="shrink-0 text-xs text-muted-foreground tabular-nums">
            {{ formatBytes(item.blob.size) }}
          </span>
          <Button variant="ghost" size="sm" @click="saveFile(item)">
            {{ item.saved ? "Save again" : "Save" }}
          </Button>
        </li>
      </ul>
      <p class="text-xs text-muted-foreground">
        Received files are held in this tab's memory until you save them. Leaving the page discards
        anything unsaved.
      </p>
    </div>

    <!-- Sent log -->
    <div v-if="sentLog.length && connected" class="flex flex-col gap-1">
      <span class="text-xs font-semibold tracking-[0.04em] text-muted-foreground uppercase">
        Sent
      </span>
      <ul class="flex flex-col gap-0.5">
        <li
          v-for="(entry, i) in sentLog.slice(0, 5)"
          :key="i"
          class="flex items-center gap-2 text-xs text-muted-foreground"
        >
          <Check class="size-3.5 shrink-0 text-[var(--positive)]" aria-hidden="true" />
          <span class="truncate">{{ entry.name }}</span>
          <span class="shrink-0 tabular-nums">{{ formatBytes(entry.size) }}</span>
        </li>
      </ul>
    </div>

    <p class="text-xs text-muted-foreground">
      Files travel directly between the two browsers over an encrypted WebRTC data channel and are
      never uploaded. The only server involved relays the connection handshake for a few minutes and
      never sees file names or contents. Compare the security code on both screens to confirm nobody
      is in between.
    </p>
  </div>
</template>
