/**
 * The signaling relay for Local File Drop (`/p2p-file-transfer`).
 *
 * This is the one named exception to the no-server rule (PROJECT.md server
 * policy, rule 4): a Durable Object may broker WebRTC signaling for the drop
 * tool. The constraints written there are enforced here, not just intended:
 *
 *  - In memory only. Nothing touches Durable Object storage. A room is two
 *    WebSockets and a timer; when both close, or the timer fires, the object
 *    forgets it ever existed.
 *  - SDP and ICE only. Every frame is run through the tool's own
 *    `parsePeerSignal` and anything that is not an offer, answer, ICE
 *    candidate or bye is dropped. Binary frames are dropped. There is no way
 *    to use a room as a general message channel.
 *  - Never file bytes. The data channel is negotiated here and then runs
 *    peer to peer; the room never sees it, and clients close their socket
 *    once the channel is open.
 *  - No payload logging. Nothing in this file logs.
 *  - Rooms expire in minutes (`ROOM_TTL_MS`), and a room holds exactly one
 *    host and one guest; a third socket is refused.
 *  - No TURN. Only the peers' own candidates are exchanged.
 */
import {
  MAX_SIGNALS_PER_PEER,
  ROOM_ALPHABET,
  ROOM_CODE_LENGTH,
  ROOM_TTL_MS,
  SIGNAL_PATH_PREFIX,
  parsePeerSignal,
  type RelaySignal,
} from "../src/tools/p2p-file-transfer/index";

/* ------------------------------------------------------------------ *
 * Workers runtime types, declared locally (no @cloudflare/workers-types)
 * ------------------------------------------------------------------ */

/** A server-side WebSocket in the Workers runtime; `accept()` is its extra. */
export interface CfWebSocket extends WebSocket {
  accept(): void;
}

declare const WebSocketPair: {
  new (): { 0: CfWebSocket; 1: CfWebSocket };
};

export interface DurableObjectId {
  toString(): string;
}

export interface DurableObjectStub {
  fetch(request: Request): Promise<Response>;
}

export interface DurableObjectNamespace {
  idFromName(name: string): DurableObjectId;
  get(id: DurableObjectId): DurableObjectStub;
}

/** Response init with the Workers-only `webSocket` field. */
type WebSocketResponseInit = ResponseInit & { webSocket: CfWebSocket };

/* ------------------------------------------------------------------ *
 * request side: what the worker's fetch handler calls
 * ------------------------------------------------------------------ */

const ROOM_CODE_RE = new RegExp(`^[${ROOM_ALPHABET}]{${ROOM_CODE_LENGTH}}$`);

/**
 * Origins allowed to open a signaling socket. The relay exists for this
 * site's own tool, so browsers on any other origin are turned away. Non
 * browser clients send no Origin header and are turned away too.
 */
const ALLOWED_ORIGINS = new Set([
  "https://tools.maxhogan.dev",
  // `wrangler dev` rewrites an Origin that matches its own host to the
  // configured route's hostname over plain http, so local testing arrives as
  // this. Harmless in production, where the site is only ever served on https.
  "http://tools.maxhogan.dev",
]);

function originAllowed(origin: string | null): boolean {
  if (!origin) return false;
  if (ALLOWED_ORIGINS.has(origin)) return true;
  // Wrangler preview and dev servers on other ports.
  return /^http:\/\/(localhost|127\.0\.0\.1):\d+$/.test(origin);
}

/**
 * Routes one `/api/p2p-file-transfer/room/<CODE>` request to its room.
 * Anything malformed is answered here without ever waking a Durable Object.
 */
export function handleSignalRequest(
  request: Request,
  path: string,
  rooms: DurableObjectNamespace,
): Promise<Response> | Response {
  const code = path.slice(SIGNAL_PATH_PREFIX.length).toUpperCase();
  if (!ROOM_CODE_RE.test(code)) return new Response("No such room.", { status: 404 });
  if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
    return new Response("This endpoint speaks WebSocket only.", { status: 426 });
  }
  if (!originAllowed(request.headers.get("Origin"))) {
    return new Response("Forbidden.", { status: 403 });
  }
  const id = rooms.idFromName(code);
  return rooms.get(id).fetch(request);
}

/* ------------------------------------------------------------------ *
 * the room
 * ------------------------------------------------------------------ */

type Role = "host" | "guest";

interface Peer {
  role: Role;
  socket: CfWebSocket;
  sent: number;
}

/**
 * One signaling room. Instantiated by the runtime per room code; state is
 * plain fields, never storage.
 */
export class DropRoom {
  private peers = new Map<Role, Peer>();
  private expiry: ReturnType<typeof setTimeout> | undefined;

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket.", { status: 426 });
    }
    const role: Role | null = !this.peers.has("host")
      ? "host"
      : !this.peers.has("guest")
        ? "guest"
        : null;
    if (!role) return new Response("Room is full.", { status: 409 });

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    const peer: Peer = { role, socket: server, sent: 0 };
    this.peers.set(role, peer);
    this.armExpiry();

    server.addEventListener("message", (event) => this.onMessage(peer, event.data));
    server.addEventListener("close", () => this.onLeave(peer));
    server.addEventListener("error", () => this.onLeave(peer));

    const other = this.peers.get(role === "host" ? "guest" : "host");
    this.send(server, { type: "joined", role, peerPresent: Boolean(other) });
    if (other) this.send(other.socket, { type: "peer-joined" });

    return new Response(null, { status: 101, webSocket: client } as WebSocketResponseInit);
  }

  private onMessage(from: Peer, data: unknown): void {
    if (from.sent >= MAX_SIGNALS_PER_PEER) {
      this.close(from.socket, 1008, "Too many signaling messages.");
      return;
    }
    from.sent++;
    let signal;
    try {
      signal = parsePeerSignal(data);
    } catch {
      // Not SDP, not ICE, not bye: dropped without a reply. A well behaved
      // client never sends one of these, so silence costs nothing.
      return;
    }
    const to = this.peers.get(from.role === "host" ? "guest" : "host");
    if (!to) return;
    try {
      to.socket.send(JSON.stringify(signal));
    } catch {
      this.onLeave(to);
    }
  }

  private onLeave(peer: Peer): void {
    if (this.peers.get(peer.role) !== peer) return;
    this.peers.delete(peer.role);
    try {
      peer.socket.close(1000, "left");
    } catch {
      // Already closed.
    }
    const other = this.peers.get(peer.role === "host" ? "guest" : "host");
    if (other) this.send(other.socket, { type: "peer-left" });
    if (this.peers.size === 0 && this.expiry) {
      clearTimeout(this.expiry);
      this.expiry = undefined;
    }
  }

  /** The whole room dies at ROOM_TTL_MS after it opened, connected or not. */
  private armExpiry(): void {
    if (this.expiry) return;
    this.expiry = setTimeout(() => {
      this.expiry = undefined;
      for (const peer of [...this.peers.values()]) {
        this.send(peer.socket, {
          type: "error",
          code: "room-expired",
          message: "The room expired. Create a new one to connect again.",
        });
        this.close(peer.socket, 1000, "room expired");
      }
      this.peers.clear();
    }, ROOM_TTL_MS);
  }

  private send(socket: CfWebSocket, signal: RelaySignal): void {
    try {
      socket.send(JSON.stringify(signal));
    } catch {
      // The socket is gone; the close event will tidy up.
    }
  }

  private close(socket: CfWebSocket, code: number, reason: string): void {
    try {
      socket.close(code, reason);
    } catch {
      // Already closed.
    }
  }
}
