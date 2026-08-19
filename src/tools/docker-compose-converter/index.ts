import YAML, { Scalar } from "yaml";
import { ToolError, type ToolLogic } from "../types";

export type Direction = "auto" | "run-to-compose" | "compose-to-run";

export interface ComposeConvertOpts {
  direction?: Direction;
  [key: string]: unknown;
}

/* ------------------------------------------------------------------ *
 * Shared helpers
 * ------------------------------------------------------------------ */

/** A double-quoted YAML scalar. Compose convention for ports and "no". */
function quoted(value: string): Scalar {
  const s = new Scalar(value);
  s.type = Scalar.QUOTE_DOUBLE;
  return s;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function scalarText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return YAML.stringify(value, { lineWidth: 0 }).trim();
}

/**
 * Read a compose value that may be a scalar, a list, or a mapping, and return
 * a flat list of strings. Mappings become "key=value", or a bare "key" when the
 * value is null (the compose way of saying "pass this through from my shell").
 */
function asStringList(value: unknown, joiner = "="): string[] {
  if (value === null || value === undefined) return [];
  if (Array.isArray(value)) return value.map(scalarText);
  if (isPlainObject(value)) {
    return Object.entries(value).map(([k, v]) =>
      v === null || v === undefined ? k : `${k}${joiner}${scalarText(v)}`,
    );
  }
  return [scalarText(value)];
}

/* ------------------------------------------------------------------ *
 * Shell tokenizer
 * ------------------------------------------------------------------ */

/**
 * Split pasted shell text into commands, then into tokens.
 *
 * Backslash-newline continuations are joined first (they are just token
 * separators), so a multi-line `docker run \` block stays one command. An
 * unquoted `&&`, `;`, `|`, or newline starts a new command, which is how one
 * paste can hold several `docker run` invocations.
 */
export function tokenizeCommands(text: string): string[][] {
  const commands: string[][] = [];
  let tokens: string[] = [];
  let cur = "";
  let has = false;

  const flushToken = () => {
    if (has) {
      tokens.push(cur);
      cur = "";
      has = false;
    }
  };
  const flushCommand = () => {
    flushToken();
    if (tokens.length > 0) {
      commands.push(tokens);
      tokens = [];
    }
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (ch === "\\") {
      const next = text[i + 1];
      if (next === "\n") {
        i += 1;
        flushToken();
        continue;
      }
      if (next === "\r" && text[i + 2] === "\n") {
        i += 2;
        flushToken();
        continue;
      }
      if (next === undefined) {
        cur += ch;
        has = true;
        continue;
      }
      cur += next;
      has = true;
      i += 1;
      continue;
    }

    if (ch === "'") {
      has = true;
      i += 1;
      while (i < text.length && text[i] !== "'") {
        cur += text[i];
        i += 1;
      }
      continue;
    }

    if (ch === '"') {
      has = true;
      i += 1;
      while (i < text.length && text[i] !== '"') {
        if (text[i] === "\\" && i + 1 < text.length && '"\\$`\n'.includes(text[i + 1])) {
          if (text[i + 1] !== "\n") cur += text[i + 1];
          i += 2;
          continue;
        }
        cur += text[i];
        i += 1;
      }
      continue;
    }

    if (ch === "\n" || ch === "\r" || ch === ";") {
      flushCommand();
      continue;
    }
    if (ch === "&" || ch === "|") {
      flushCommand();
      if (text[i + 1] === ch) i += 1;
      continue;
    }
    if (ch === " " || ch === "\t") {
      flushToken();
      continue;
    }

    cur += ch;
    has = true;
  }

  flushCommand();
  return commands.filter((c) => !c[0].startsWith("#"));
}

/* ------------------------------------------------------------------ *
 * docker run flag table
 * ------------------------------------------------------------------ */

const LONG_ALIAS: Record<string, string> = {
  "--net": "--network",
  "--net-alias": "--network-alias",
  "--publish-all": "--publish-all",
  "--detach": "--detach",
};

/** Long flags that consume a value. */
const VALUE_LONG = new Set([
  "--name",
  "--publish",
  "--volume",
  "--mount",
  "--env",
  "--env-file",
  "--network",
  "--network-alias",
  "--restart",
  "--hostname",
  "--workdir",
  "--user",
  "--entrypoint",
  "--label",
  "--cap-add",
  "--cap-drop",
  "--device",
  "--tmpfs",
  "--shm-size",
  "--dns",
  "--add-host",
  "--health-cmd",
  "--health-interval",
  "--health-timeout",
  "--health-retries",
  "--health-start-period",
  "--memory",
  "--cpus",
  "--gpus",
  "--log-driver",
  "--log-opt",
  "--security-opt",
  "--sysctl",
  "--pid",
  "--ipc",
  "--ulimit",
]);

/** Long flags that stand alone. */
const BOOL_LONG = new Set([
  "--detach",
  "--publish-all",
  "--privileged",
  "--read-only",
  "--init",
  "--interactive",
  "--tty",
  "--rm",
]);

const SHORT_VALUE: Record<string, string> = {
  p: "--publish",
  v: "--volume",
  e: "--env",
  u: "--user",
  w: "--workdir",
  m: "--memory",
  l: "--label",
  h: "--hostname",
};

const SHORT_BOOL: Record<string, string> = {
  d: "--detach",
  P: "--publish-all",
  i: "--interactive",
  t: "--tty",
};

interface RunFlag {
  name: string;
  value?: string;
}

interface RunSpec {
  flags: RunFlag[];
  image?: string;
  args: string[];
  /** Flags this converter does not know. Never dropped silently. */
  unknown: string[];
}

/**
 * Where the actual `run` verb sits, or -1 when this command is not a container
 * run. Accepts `docker run`, `docker container run`, and `podman run`, with an
 * optional leading `sudo`.
 */
function runVerbIndex(tokens: string[]): number {
  let i = 0;
  if (tokens[i] === "sudo") i += 1;
  const engine = tokens[i];
  if (engine !== "docker" && engine !== "podman") return -1;
  i += 1;
  if (tokens[i] === "container") i += 1;
  if (tokens[i] !== "run") return -1;
  return i + 1;
}

function parseRunCommand(tokens: string[], start: number): RunSpec {
  const flags: RunFlag[] = [];
  const unknown: string[] = [];
  const args: string[] = [];
  let image: string | undefined;
  let positionalOnly = false;

  const needValue = (name: string, value: string | undefined): string => {
    if (value === undefined) {
      throw new ToolError(
        "missing-flag-value",
        `The flag ${name} is the last thing in the command, so it has no value.`,
        `Give ${name} a value, for example ${name} something.`,
      );
    }
    return value;
  };

  for (let i = start; i < tokens.length; i++) {
    const token = tokens[i];

    if (image !== undefined) {
      args.push(token);
      continue;
    }
    if (token === "--") {
      positionalOnly = true;
      continue;
    }

    if (!positionalOnly && token.startsWith("--") && token.length > 2) {
      const eq = token.indexOf("=");
      const rawName = eq >= 0 ? token.slice(0, eq) : token;
      const inline = eq >= 0 ? token.slice(eq + 1) : undefined;
      const name = LONG_ALIAS[rawName] ?? rawName;

      if (VALUE_LONG.has(name)) {
        let value = inline;
        if (value === undefined) {
          value = tokens[i + 1];
          i += 1;
        }
        flags.push({ name, value: needValue(name, value) });
        continue;
      }
      if (BOOL_LONG.has(name)) {
        if (inline !== undefined && /^(false|0)$/i.test(inline)) continue;
        flags.push({ name });
        continue;
      }
      unknown.push(token);
      continue;
    }

    if (!positionalOnly && token.startsWith("-") && token.length > 1) {
      const chars = token.slice(1);
      let consumedNext = false;
      let bad = false;

      for (let c = 0; c < chars.length; c++) {
        const ch = chars[c];
        if (SHORT_BOOL[ch]) {
          flags.push({ name: SHORT_BOOL[ch] });
          continue;
        }
        if (SHORT_VALUE[ch]) {
          const name = SHORT_VALUE[ch];
          let rest = chars.slice(c + 1);
          if (rest.startsWith("=")) rest = rest.slice(1);
          let value: string | undefined = rest;
          if (rest === "") {
            value = tokens[i + 1];
            consumedNext = true;
          }
          flags.push({ name, value: needValue(name, value) });
          break;
        }
        bad = true;
        break;
      }

      if (bad) unknown.push(token);
      if (consumedNext) i += 1;
      continue;
    }

    image = token;
  }

  return { flags, image, args, unknown };
}

/* ------------------------------------------------------------------ *
 * run -> compose
 * ------------------------------------------------------------------ */

function isBindSource(src: string): boolean {
  return (
    src.startsWith("/") ||
    src.startsWith("./") ||
    src.startsWith("../") ||
    src.startsWith("~") ||
    src === "." ||
    src === ".."
  );
}

function serviceNameFromImage(image: string): string {
  const noDigest = image.split("@")[0];
  const lastSegment = noDigest.split("/").pop() ?? noDigest;
  const noTag = lastSegment.split(":")[0];
  const cleaned = noTag.toLowerCase().replace(/[^a-z0-9_-]/g, "-");
  return cleaned || "service";
}

interface MountParts {
  entry: Record<string, unknown>;
  namedVolume?: string;
  leftovers: string[];
}

function parseMount(spec: string): MountParts {
  const entry: Record<string, unknown> = {};
  const leftovers: string[] = [];
  let type = "volume";
  let source: string | undefined;
  let target: string | undefined;
  let readOnly = false;

  for (const part of spec.split(",")) {
    if (!part) continue;
    const eq = part.indexOf("=");
    const key = (eq >= 0 ? part.slice(0, eq) : part).trim();
    const value = eq >= 0 ? part.slice(eq + 1) : "";
    switch (key) {
      case "type":
        type = value;
        break;
      case "source":
      case "src":
        source = value;
        break;
      case "destination":
      case "dst":
      case "target":
        target = value;
        break;
      case "readonly":
      case "ro":
        readOnly = value === "" || /^(true|1)$/i.test(value);
        break;
      default:
        leftovers.push(part);
    }
  }

  entry.type = type;
  if (source !== undefined) entry.source = source;
  if (target !== undefined) entry.target = target;
  if (readOnly) entry.read_only = true;

  return {
    entry,
    namedVolume: type === "volume" && source && !isBindSource(source) ? source : undefined,
    leftovers,
  };
}

function gpuReservation(value: string): Record<string, unknown> {
  const device: Record<string, unknown> = { driver: "nvidia" };
  const deviceAt = value.indexOf("device=");
  if (value === "all") {
    device.count = "all";
  } else if (/^\d+$/.test(value)) {
    device.count = Number(value);
  } else if (deviceAt >= 0) {
    device.device_ids = value
      .slice(deviceAt + "device=".length)
      .split(",")
      .filter(Boolean);
  } else {
    device.count = "all";
  }
  device.capabilities = ["gpu"];
  return { resources: { reservations: { devices: [device] } } };
}

interface ServiceBuild {
  name: string;
  service: Record<string, unknown>;
  volumes: string[];
  networks: string[];
  notes: string[];
  notTranslated: string[];
}

function buildService(spec: RunSpec, tokens: string[]): ServiceBuild {
  if (!spec.image) {
    throw new ToolError(
      "no-image",
      `No image name found in: ${tokens.join(" ")}`,
      "A docker run command needs an image, for example: docker run nginx:alpine",
    );
  }

  const notes: string[] = [];
  const notTranslated: string[] = spec.unknown.map((f) => f);
  const topVolumes: string[] = [];
  const topNetworks: string[] = [];

  let containerName: string | undefined;
  let hostname: string | undefined;
  let restart: string | undefined;
  let entrypoint: string | undefined;
  let workingDir: string | undefined;
  let user: string | undefined;
  let networkMode: string | undefined;
  let shmSize: string | undefined;
  let memLimit: string | undefined;
  let cpus: string | undefined;
  let pid: string | undefined;
  let ipc: string | undefined;
  let logDriver: string | undefined;
  let deploy: Record<string, unknown> | undefined;
  let privileged = false;
  let readOnly = false;
  let init = false;
  let tty = false;
  let stdinOpen = false;

  const ports: Scalar[] = [];
  const volumes: unknown[] = [];
  const tmpfs: string[] = [];
  const environment: string[] = [];
  const envFile: string[] = [];
  const networkNames: string[] = [];
  const networkAliases: string[] = [];
  const labels: string[] = [];
  const capAdd: string[] = [];
  const capDrop: string[] = [];
  const devices: string[] = [];
  const dns: string[] = [];
  const extraHosts: string[] = [];
  const securityOpt: string[] = [];
  const sysctls: string[] = [];
  const ulimits: string[] = [];
  const logOpts: string[] = [];
  const health: Record<string, unknown> = {};
  let healthCmd: string | undefined;

  for (const flag of spec.flags) {
    const value = flag.value ?? "";
    switch (flag.name) {
      case "--name":
        containerName = value;
        break;
      case "--publish":
        ports.push(quoted(value));
        break;
      case "--publish-all":
        notes.push(
          "-P publishes every exposed port on a random host port. Compose has no equivalent, so list the ports you need under ports:.",
        );
        break;
      case "--detach":
        notes.push("-d is a runtime choice, not a compose key. Run: docker compose up -d");
        break;
      case "--rm":
        notes.push(
          "--rm has no compose key. Compose keeps the container after it exits; remove it with docker compose down.",
        );
        break;
      case "--volume": {
        volumes.push(value);
        const source = value.split(":")[0];
        if (value.includes(":") && !isBindSource(source)) topVolumes.push(source);
        break;
      }
      case "--mount": {
        const parsed = parseMount(value);
        volumes.push(parsed.entry);
        if (parsed.namedVolume) topVolumes.push(parsed.namedVolume);
        for (const leftover of parsed.leftovers) notTranslated.push(`--mount option ${leftover}`);
        break;
      }
      case "--tmpfs":
        tmpfs.push(value);
        break;
      case "--env":
        environment.push(value);
        break;
      case "--env-file":
        envFile.push(value);
        break;
      case "--network":
        if (value === "host" || value === "none" || value === "bridge" || value.includes(":")) {
          networkMode = value;
        } else {
          networkNames.push(value);
          topNetworks.push(value);
        }
        break;
      case "--network-alias":
        networkAliases.push(value);
        break;
      case "--restart":
        restart = value;
        break;
      case "--hostname":
        hostname = value;
        break;
      case "--workdir":
        workingDir = value;
        break;
      case "--user":
        user = value;
        break;
      case "--entrypoint":
        entrypoint = value;
        break;
      case "--label":
        labels.push(value);
        break;
      case "--cap-add":
        capAdd.push(value);
        break;
      case "--cap-drop":
        capDrop.push(value);
        break;
      case "--device":
        devices.push(value);
        break;
      case "--dns":
        dns.push(value);
        break;
      case "--add-host":
        extraHosts.push(value);
        break;
      case "--security-opt":
        securityOpt.push(value);
        break;
      case "--sysctl":
        sysctls.push(value);
        break;
      case "--ulimit":
        ulimits.push(value);
        break;
      case "--privileged":
        privileged = true;
        break;
      case "--read-only":
        readOnly = true;
        break;
      case "--init":
        init = true;
        break;
      case "--interactive":
        stdinOpen = true;
        break;
      case "--tty":
        tty = true;
        break;
      case "--shm-size":
        shmSize = value;
        break;
      case "--memory":
        memLimit = value;
        break;
      case "--cpus":
        cpus = value;
        break;
      case "--pid":
        pid = value;
        break;
      case "--ipc":
        ipc = value;
        break;
      case "--log-driver":
        logDriver = value;
        break;
      case "--log-opt":
        logOpts.push(value);
        break;
      case "--gpus":
        deploy = gpuReservation(value);
        notes.push(
          "--gpus became a deploy.resources.reservations.devices block, which only docker compose v2 and swarm read.",
        );
        break;
      case "--health-cmd":
        healthCmd = value;
        break;
      case "--health-interval":
        health.interval = value;
        break;
      case "--health-timeout":
        health.timeout = value;
        break;
      case "--health-retries":
        health.retries = /^\d+$/.test(value) ? Number(value) : value;
        break;
      case "--health-start-period":
        health.start_period = value;
        break;
      default:
        notTranslated.push(flag.value === undefined ? flag.name : `${flag.name} ${flag.value}`);
    }
  }

  const service: Record<string, unknown> = {};
  service.image = spec.image;
  if (containerName) service.container_name = containerName;
  if (hostname) service.hostname = hostname;
  if (restart) service.restart = restart === "no" ? quoted(restart) : restart;
  if (entrypoint) service.entrypoint = entrypoint;
  if (spec.args.length > 0) {
    service.command = spec.args.some((a) => /\s/.test(a)) ? spec.args : spec.args.join(" ");
  }
  if (ports.length > 0) service.ports = ports;
  if (volumes.length > 0) service.volumes = volumes;
  if (tmpfs.length > 0) service.tmpfs = tmpfs;
  if (environment.length > 0) service.environment = environment;
  if (envFile.length > 0) service.env_file = envFile;
  if (networkNames.length > 0) {
    if (networkAliases.length > 0) {
      const map: Record<string, unknown> = {};
      networkNames.forEach((n, idx) => {
        map[n] = idx === 0 ? { aliases: networkAliases } : {};
      });
      service.networks = map;
    } else {
      service.networks = networkNames;
    }
  } else if (networkAliases.length > 0) {
    notTranslated.push(`--network-alias ${networkAliases.join(" ")} (no --network was given)`);
  }
  if (networkMode) service.network_mode = networkMode;
  if (workingDir) service.working_dir = workingDir;
  if (user) service.user = user;
  if (labels.length > 0) service.labels = labels;
  if (capAdd.length > 0) service.cap_add = capAdd;
  if (capDrop.length > 0) service.cap_drop = capDrop;
  if (devices.length > 0) service.devices = devices;
  if (dns.length > 0) service.dns = dns;
  if (extraHosts.length > 0) service.extra_hosts = extraHosts;
  if (securityOpt.length > 0) service.security_opt = securityOpt;
  if (sysctls.length > 0) service.sysctls = sysctls;
  if (ulimits.length > 0) {
    const map: Record<string, unknown> = {};
    for (const raw of ulimits) {
      const eq = raw.indexOf("=");
      if (eq < 0) {
        notTranslated.push(`--ulimit ${raw}`);
        continue;
      }
      const key = raw.slice(0, eq);
      const limits = raw.slice(eq + 1).split(":");
      map[key] =
        limits.length > 1
          ? { soft: Number(limits[0]), hard: Number(limits[1]) }
          : Number(limits[0]);
    }
    if (Object.keys(map).length > 0) service.ulimits = map;
  }
  if (privileged) service.privileged = true;
  if (readOnly) service.read_only = true;
  if (init) service.init = true;
  if (stdinOpen) service.stdin_open = true;
  if (tty) service.tty = true;
  if (shmSize) service.shm_size = shmSize;
  if (memLimit) service.mem_limit = memLimit;
  if (cpus) service.cpus = cpus;
  if (pid) service.pid = pid;
  if (ipc) service.ipc = ipc;
  if (logDriver || logOpts.length > 0) {
    const logging: Record<string, unknown> = {};
    if (logDriver) logging.driver = logDriver;
    if (logOpts.length > 0) {
      const options: Record<string, string> = {};
      for (const opt of logOpts) {
        const eq = opt.indexOf("=");
        if (eq < 0) options[opt] = "";
        else options[opt.slice(0, eq)] = opt.slice(eq + 1);
      }
      logging.options = options;
    }
    service.logging = logging;
  }
  if (healthCmd !== undefined || Object.keys(health).length > 0) {
    const healthcheck: Record<string, unknown> = {};
    if (healthCmd !== undefined) healthcheck.test = ["CMD-SHELL", healthCmd];
    if (health.interval !== undefined) healthcheck.interval = health.interval;
    if (health.timeout !== undefined) healthcheck.timeout = health.timeout;
    if (health.retries !== undefined) healthcheck.retries = health.retries;
    if (health.start_period !== undefined) healthcheck.start_period = health.start_period;
    service.healthcheck = healthcheck;
  }
  if (deploy) service.deploy = deploy;

  return {
    name: containerName ? serviceNameFromImage(containerName) : serviceNameFromImage(spec.image),
    service,
    volumes: topVolumes,
    networks: topNetworks,
    notes,
    notTranslated,
  };
}

function commentBlock(title: string, lines: string[]): string {
  if (lines.length === 0) return "";
  const unique = lines.filter((line, idx) => lines.indexOf(line) === idx);
  return [`# ${title}`, ...unique.map((line) => `#   ${line}`)].join("\n");
}

export function runToCompose(input: string): string {
  const commands = tokenizeCommands(input);
  const builds: ServiceBuild[] = [];
  const strayCommands: string[] = [];

  for (const tokens of commands) {
    const start = runVerbIndex(tokens);
    if (start < 0) {
      strayCommands.push(tokens.join(" "));
      continue;
    }
    builds.push(buildService(parseRunCommand(tokens, start), tokens));
  }

  if (builds.length === 0) {
    throw new ToolError(
      "not-a-run-command",
      "No docker run command was found in the input.",
      "Paste a command that starts with docker run, docker container run, or podman run.",
    );
  }

  const services: Record<string, unknown> = {};
  const usedNames = new Set<string>();
  const topVolumes: string[] = [];
  const topNetworks: string[] = [];
  const notes: string[] = [];
  const notTranslated: string[] = strayCommands.map((c) => `${c} (not a container run command)`);

  for (const build of builds) {
    let name = build.name;
    let n = 2;
    while (usedNames.has(name)) {
      name = `${build.name}-${n}`;
      n += 1;
    }
    usedNames.add(name);
    services[name] = build.service;
    topVolumes.push(...build.volumes);
    topNetworks.push(...build.networks);
    notes.push(...build.notes);
    notTranslated.push(...build.notTranslated);
  }

  const doc: Record<string, unknown> = { services };
  if (topVolumes.length > 0) {
    const volumes: Record<string, unknown> = {};
    for (const name of topVolumes) volumes[name] = {};
    doc.volumes = volumes;
  }
  if (topNetworks.length > 0) {
    const networks: Record<string, unknown> = {};
    for (const name of topNetworks) networks[name] = { external: true };
    doc.networks = networks;
    notes.push(
      "docker run joins networks that already exist, so each one is declared external. Drop external: true if compose should create it.",
    );
  }

  const parts = [YAML.stringify(doc, { lineWidth: 0 }).trimEnd()];
  const noteBlock = commentBlock("notes:", notes);
  if (noteBlock) parts.push(noteBlock);
  const missedBlock = commentBlock("not translated:", notTranslated);
  if (missedBlock) parts.push(missedBlock);
  return parts.join("\n\n");
}

/* ------------------------------------------------------------------ *
 * compose -> run
 * ------------------------------------------------------------------ */

const SAFE_TOKEN = /^[A-Za-z0-9_@%+=:,./-]+$/;

function shellQuote(value: string): string {
  if (value === "") return '""';
  if (SAFE_TOKEN.test(value)) return value;
  if (!value.includes("'")) return `'${value}'`;
  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

/** Every service key this converter knows how to turn back into a flag. */
const MAPPED_SERVICE_KEYS = new Set([
  "image",
  "container_name",
  "hostname",
  "restart",
  "entrypoint",
  "command",
  "ports",
  "volumes",
  "tmpfs",
  "environment",
  "env_file",
  "networks",
  "network_mode",
  "working_dir",
  "user",
  "labels",
  "cap_add",
  "cap_drop",
  "devices",
  "dns",
  "extra_hosts",
  "security_opt",
  "sysctls",
  "ulimits",
  "privileged",
  "read_only",
  "init",
  "stdin_open",
  "tty",
  "shm_size",
  "mem_limit",
  "cpus",
  "pid",
  "ipc",
  "logging",
  "healthcheck",
  "depends_on",
  "deploy",
]);

function portToFlag(entry: unknown): string {
  if (isPlainObject(entry)) {
    const published = scalarText(entry.published);
    const target = scalarText(entry.target);
    const protocol = entry.protocol ? `/${scalarText(entry.protocol)}` : "";
    const pair = published ? `${published}:${target}` : target;
    return `${pair}${protocol}`;
  }
  return scalarText(entry);
}

function volumeToFlag(entry: unknown): { flag: string; value: string } {
  if (isPlainObject(entry)) {
    const bits = [`type=${scalarText(entry.type) || "volume"}`];
    if (entry.source !== undefined) bits.push(`src=${scalarText(entry.source)}`);
    if (entry.target !== undefined) bits.push(`dst=${scalarText(entry.target)}`);
    if (entry.read_only === true) bits.push("readonly");
    return { flag: "--mount", value: bits.join(",") };
  }
  return { flag: "--volume", value: scalarText(entry) };
}

function gpusFromDeploy(deploy: Record<string, unknown>): {
  gpus?: string;
  leftover: boolean;
} {
  const resources = deploy.resources;
  const otherTop = Object.keys(deploy).some((k) => k !== "resources");
  if (!isPlainObject(resources)) return { leftover: Object.keys(deploy).length > 0 };
  const reservations = resources.reservations;
  const otherResources = Object.keys(resources).some((k) => k !== "reservations");
  if (!isPlainObject(reservations)) return { leftover: true };
  const devices = reservations.devices;
  const otherReservations = Object.keys(reservations).some((k) => k !== "devices");
  if (!Array.isArray(devices) || devices.length === 0) return { leftover: true };

  const first = devices[0];
  let gpus = "all";
  if (isPlainObject(first)) {
    if (Array.isArray(first.device_ids) && first.device_ids.length > 0) {
      gpus = `device=${first.device_ids.map(scalarText).join(",")}`;
    } else if (first.count !== undefined && scalarText(first.count) !== "all") {
      gpus = scalarText(first.count);
    }
  }
  return { gpus, leftover: otherTop || otherResources || otherReservations || devices.length > 1 };
}

function healthcheckFlags(
  healthcheck: Record<string, unknown>,
  push: (flag: string, value?: string) => void,
): void {
  if (healthcheck.disable === true) {
    push("--no-healthcheck");
    return;
  }
  const test = healthcheck.test;
  let cmd: string | undefined;
  if (typeof test === "string") {
    cmd = test;
  } else if (Array.isArray(test) && test.length > 0) {
    const head = scalarText(test[0]);
    if (head === "NONE") {
      push("--no-healthcheck");
      return;
    }
    const rest = head === "CMD" || head === "CMD-SHELL" ? test.slice(1) : test;
    cmd = rest.map(scalarText).join(" ");
  }
  if (cmd) push("--health-cmd", cmd);
  if (healthcheck.interval !== undefined)
    push("--health-interval", scalarText(healthcheck.interval));
  if (healthcheck.timeout !== undefined) push("--health-timeout", scalarText(healthcheck.timeout));
  if (healthcheck.retries !== undefined) push("--health-retries", scalarText(healthcheck.retries));
  if (healthcheck.start_period !== undefined) {
    push("--health-start-period", scalarText(healthcheck.start_period));
  }
}

function serviceToRun(name: string, def: Record<string, unknown>): string {
  const flags: string[] = [];
  const notTranslated: string[] = [];
  const push = (flag: string, value?: string) => {
    flags.push(value === undefined ? flag : `${flag} ${shellQuote(value)}`);
  };

  if (def.container_name !== undefined) push("--name", scalarText(def.container_name));
  if (def.hostname !== undefined) push("--hostname", scalarText(def.hostname));
  if (def.restart !== undefined) push("--restart", scalarText(def.restart));

  if (def.network_mode !== undefined) {
    push("--network", scalarText(def.network_mode));
  } else if (def.networks !== undefined) {
    const networks = def.networks;
    if (isPlainObject(networks)) {
      const first = Object.keys(networks)[0];
      if (first) {
        push("--network", first);
        const cfg = networks[first];
        if (isPlainObject(cfg) && Array.isArray(cfg.aliases)) {
          for (const alias of cfg.aliases) push("--network-alias", scalarText(alias));
        }
      }
      for (const extra of Object.keys(networks).slice(1)) {
        notTranslated.push(`networks: ${extra} (docker run joins one network at a time)`);
      }
    } else if (Array.isArray(networks) && networks.length > 0) {
      push("--network", scalarText(networks[0]));
      for (const extra of networks.slice(1)) {
        notTranslated.push(
          `networks: ${scalarText(extra)} (docker run joins one network at a time)`,
        );
      }
    }
  }

  for (const port of Array.isArray(def.ports) ? def.ports : []) push("--publish", portToFlag(port));
  for (const volume of Array.isArray(def.volumes) ? def.volumes : []) {
    const { flag, value } = volumeToFlag(volume);
    push(flag, value);
  }
  for (const entry of asStringList(def.tmpfs)) push("--tmpfs", entry);
  for (const entry of asStringList(def.environment)) push("--env", entry);
  for (const entry of asStringList(def.env_file)) push("--env-file", entry);
  if (def.working_dir !== undefined) push("--workdir", scalarText(def.working_dir));
  if (def.user !== undefined) push("--user", scalarText(def.user));
  for (const entry of asStringList(def.labels)) push("--label", entry);
  for (const entry of asStringList(def.cap_add)) push("--cap-add", entry);
  for (const entry of asStringList(def.cap_drop)) push("--cap-drop", entry);
  for (const entry of asStringList(def.devices)) push("--device", entry);
  for (const entry of asStringList(def.dns)) push("--dns", entry);
  for (const entry of asStringList(def.extra_hosts, ":")) push("--add-host", entry);
  for (const entry of asStringList(def.security_opt)) push("--security-opt", entry);
  for (const entry of asStringList(def.sysctls)) push("--sysctl", entry);

  if (isPlainObject(def.ulimits)) {
    for (const [key, value] of Object.entries(def.ulimits)) {
      if (isPlainObject(value))
        push("--ulimit", `${key}=${scalarText(value.soft)}:${scalarText(value.hard)}`);
      else push("--ulimit", `${key}=${scalarText(value)}`);
    }
  }

  if (def.privileged === true) push("--privileged");
  if (def.read_only === true) push("--read-only");
  if (def.init === true) push("--init");
  if (def.stdin_open === true) push("--interactive");
  if (def.tty === true) push("--tty");
  if (def.shm_size !== undefined) push("--shm-size", scalarText(def.shm_size));
  if (def.mem_limit !== undefined) push("--memory", scalarText(def.mem_limit));
  if (def.cpus !== undefined) push("--cpus", scalarText(def.cpus));
  if (def.pid !== undefined) push("--pid", scalarText(def.pid));
  if (def.ipc !== undefined) push("--ipc", scalarText(def.ipc));

  if (isPlainObject(def.logging)) {
    if (def.logging.driver !== undefined) push("--log-driver", scalarText(def.logging.driver));
    for (const entry of asStringList(def.logging.options)) push("--log-opt", entry);
  }
  if (isPlainObject(def.healthcheck)) healthcheckFlags(def.healthcheck, push);

  const trailing: string[] = [];
  if (def.entrypoint !== undefined) {
    if (Array.isArray(def.entrypoint) && def.entrypoint.length > 0) {
      push("--entrypoint", scalarText(def.entrypoint[0]));
      trailing.push(...def.entrypoint.slice(1).map((a) => shellQuote(scalarText(a))));
    } else {
      push("--entrypoint", scalarText(def.entrypoint));
    }
  }
  if (isPlainObject(def.deploy)) {
    const { gpus, leftover } = gpusFromDeploy(def.deploy);
    if (gpus) push("--gpus", gpus);
    if (leftover) notTranslated.push("deploy (swarm and compose only, no docker run equivalent)");
  }

  if (Array.isArray(def.command)) {
    trailing.push(...def.command.map((a) => shellQuote(scalarText(a))));
  } else if (def.command !== undefined) {
    trailing.push(scalarText(def.command));
  }

  for (const key of Object.keys(def)) {
    if (MAPPED_SERVICE_KEYS.has(key)) continue;
    const rendered = YAML.stringify({ [key]: def[key] }, { lineWidth: 0 }).trimEnd();
    notTranslated.push(...rendered.split("\n"));
  }

  const image = def.image === undefined ? "IMAGE" : scalarText(def.image);
  if (def.image === undefined) {
    notTranslated.push(
      "image: missing, so IMAGE is a placeholder. Build the image and use its tag.",
    );
  }

  const head: string[] = [`# service: ${name}`];
  const dependsOn = asStringList(def.depends_on);
  if (dependsOn.length > 0) head.push(`# start these first: ${dependsOn.join(", ")}`);

  const lastLine = [image, ...trailing].join(" ");
  const body = ["docker run \\", ...flags.map((f) => `  ${f} \\`), `  ${lastLine}`];

  const tail = commentBlock("not translated:", notTranslated);
  return [...head, ...body, ...(tail ? [tail] : [])].join("\n");
}

export function composeToRun(input: string): string {
  let doc: unknown;
  try {
    doc = YAML.parse(input);
  } catch (err) {
    throw new ToolError(
      "bad-yaml",
      `The compose file is not valid YAML. ${err instanceof Error ? err.message : String(err)}`,
      "Check the indentation and quoting on the line named above.",
    );
  }

  if (
    !isPlainObject(doc) ||
    !isPlainObject(doc.services) ||
    Object.keys(doc.services).length === 0
  ) {
    throw new ToolError(
      "no-services",
      "No services were found in this compose file.",
      "The file needs a top-level services: mapping with at least one service under it.",
    );
  }

  const commands: string[] = [];
  for (const [name, def] of Object.entries(doc.services)) {
    commands.push(serviceToRun(name, isPlainObject(def) ? def : {}));
  }
  return commands.join("\n\n");
}

/* ------------------------------------------------------------------ *
 * Entry point
 * ------------------------------------------------------------------ */

function detect(input: string): "run-to-compose" | "compose-to-run" {
  const firstLine =
    input
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find((l) => l !== "" && !l.startsWith("#")) ?? "";
  if (/^(sudo\s+)?(docker|podman)\s/.test(firstLine)) return "run-to-compose";
  return "compose-to-run";
}

export function run(input: string, opts: ComposeConvertOpts = {}): string {
  const text = typeof input === "string" ? input : "";
  if (text.trim() === "") {
    throw new ToolError(
      "empty-input",
      "Paste a docker run command or a compose file to convert.",
      "For example: docker run -d -p 8080:80 nginx:alpine",
    );
  }

  const direction = opts.direction ?? "auto";
  const resolved = direction === "auto" ? detect(text) : direction;
  return resolved === "run-to-compose" ? runToCompose(text) : composeToRun(text);
}

export default { run } satisfies ToolLogic<string, string, ComposeConvertOpts>;
