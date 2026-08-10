// Minimal RCON client (Source RCON protocol, which Minecraft implements).
// Node builtins only: a packet is int32 length, int32 requestId, int32 type,
// payload string, two null bytes. Auth type 3, command type 2, response 0.
import { Socket } from "node:net";

const AUTH = 3;
const COMMAND = 2;

export class Rcon {
  #sock;
  #id = 0;
  #pending = new Map();
  #buf = Buffer.alloc(0);

  static async connect(host, port, password, timeoutMs = 15000) {
    const rcon = new Rcon();
    rcon.#sock = new Socket();
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("rcon connect timeout")), timeoutMs);
      rcon.#sock.connect(port, host, () => {
        clearTimeout(t);
        resolve();
      });
      rcon.#sock.on("error", (e) => {
        clearTimeout(t);
        reject(e);
      });
    });
    rcon.#sock.on("data", (chunk) => rcon.#onData(chunk));
    const res = await rcon.#send(AUTH, password);
    if (res.id === -1) throw new Error("rcon auth failed");
    return rcon;
  }

  #onData(chunk) {
    this.#buf = Buffer.concat([this.#buf, chunk]);
    while (this.#buf.length >= 4) {
      const len = this.#buf.readInt32LE(0);
      if (this.#buf.length < 4 + len) return;
      const id = this.#buf.readInt32LE(4);
      const body = this.#buf.toString("utf8", 12, 4 + len - 2);
      this.#buf = this.#buf.subarray(4 + len);
      // Auth failure responds with id -1; route it to the oldest pending.
      const key = this.#pending.has(id) ? id : this.#pending.keys().next().value;
      const resolve = this.#pending.get(key);
      if (resolve) {
        this.#pending.delete(key);
        resolve({ id, body });
      }
    }
  }

  #send(type, payload) {
    const id = ++this.#id;
    const body = Buffer.from(payload, "utf8");
    const pkt = Buffer.alloc(14 + body.length);
    pkt.writeInt32LE(10 + body.length, 0);
    pkt.writeInt32LE(id, 4);
    pkt.writeInt32LE(type, 8);
    body.copy(pkt, 12);
    return new Promise((resolve) => {
      this.#pending.set(id, resolve);
      this.#sock.write(pkt);
    });
  }

  /** Run a command, resolve with the server's textual response. */
  async cmd(command) {
    const res = await this.#send(COMMAND, command);
    return res.body;
  }

  close() {
    this.#sock.destroy();
  }
}
