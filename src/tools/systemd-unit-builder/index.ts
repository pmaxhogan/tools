import { ToolError, type ToolLogic } from "../types";

export interface SystemdUnitOpts {
  description: string;
  exec: string;
  execStop: string;
  workingDir: string;
  user: string;
  group: string;
  type: string;
  restart: string;
  restartSec: number;
  wantedBy: string;
  after: string;
  environment: string;
  hardening: boolean;
  timer: boolean;
  onCalendar: string;
  [key: string]: unknown;
}

/**
 * Sane security hardening block for a service that does not need broad
 * system access. ProtectSystem=strict makes almost the whole filesystem
 * read-only, which is why the generator adds a comment pointing at
 * ReadWritePaths= for apps that write outside /var/lib/<service>.
 */
const HARDENING_LINES = [
  "NoNewPrivileges=true",
  "ProtectSystem=strict",
  "ProtectHome=true",
  "PrivateTmp=true",
  "ProtectKernelTunables=true",
  "ProtectControlGroups=true",
  "RestrictSUIDSGID=true",
  "LockPersonality=true",
];

/** Splits "KEY=val" lines, trims each, and drops blank lines. */
function parseEnvironment(raw: string): string[] {
  return (raw ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function section(lines: string[]): string {
  return lines.join("\n");
}

/** Builds the .service unit text from the resolved options. */
export function buildUnit(opts: SystemdUnitOpts): string {
  const exec = (opts.exec ?? "").trim();
  if (!exec)
    throw new ToolError(
      "empty-input",
      "Enter the command to run (ExecStart).",
      "For example /usr/bin/myapp.",
    );

  const description = (opts.description ?? "").trim() || "My service";
  const execStop = (opts.execStop ?? "").trim();
  const workingDir = (opts.workingDir ?? "").trim();
  const user = (opts.user ?? "").trim();
  const group = (opts.group ?? "").trim();
  const type = (opts.type ?? "simple").trim() || "simple";
  const restart = (opts.restart ?? "on-failure").trim() || "on-failure";
  const restartSec = Number.isFinite(opts.restartSec) ? opts.restartSec : 5;
  const wantedBy = (opts.wantedBy ?? "multi-user.target").trim() || "multi-user.target";
  const after = (opts.after ?? "network-online.target").trim() || "network-online.target";
  const envLines = parseEnvironment(opts.environment);

  const unitLines = ["[Unit]", `Description=${description}`];
  if (after !== "none") {
    unitLines.push(`After=${after}`);
    if (after === "network-online.target") unitLines.push(`Wants=${after}`);
  }

  const serviceLines = ["[Service]", `Type=${type}`];
  if (user) serviceLines.push(`User=${user}`);
  if (group) serviceLines.push(`Group=${group}`);
  if (workingDir) serviceLines.push(`WorkingDirectory=${workingDir}`);
  for (const line of envLines) serviceLines.push(`Environment=${line}`);
  serviceLines.push(`ExecStart=${exec}`);
  if (execStop) serviceLines.push(`ExecStop=${execStop}`);
  serviceLines.push(`Restart=${restart}`);
  serviceLines.push(`RestartSec=${restartSec}`);
  if (opts.hardening) {
    serviceLines.push(
      "# Hardening: ProtectSystem=strict may need ReadWritePaths= for apps that write outside /var.",
    );
    serviceLines.push(...HARDENING_LINES);
  }

  const installLines = ["[Install]", `WantedBy=${wantedBy}`];

  return `${[section(unitLines), section(serviceLines), section(installLines)].join("\n\n")}\n`;
}

/** Builds a matching .timer unit skeleton for the same service. */
export function buildTimer(opts: SystemdUnitOpts): string {
  const description = (opts.description ?? "").trim() || "My service";
  const onCalendar = (opts.onCalendar ?? "daily").trim() || "daily";

  const unitLines = ["[Unit]", `Description=Timer for ${description}`];
  const timerLines = ["[Timer]", `OnCalendar=${onCalendar}`, "Persistent=true"];
  const installLines = ["[Install]", "WantedBy=timers.target"];

  return `${[section(unitLines), section(timerLines), section(installLines)].join("\n\n")}\n`;
}

/**
 * input is the ExecStart command as a convenience: if opts.exec is empty
 * and input is not, input fills in for it. Otherwise input is ignored, and
 * the whole unit is option driven, matching the uuid-generator pattern.
 */
export function run(input: string, opts: SystemdUnitOpts): string {
  const exec = (opts.exec ?? "").trim() || (input ?? "").trim();
  const resolved: SystemdUnitOpts = { ...opts, exec };

  let out = buildUnit(resolved);

  if (opts.timer) {
    out += `\n# ---- systemd timer unit (save alongside as a .timer file) ----\n\n${buildTimer(resolved)}`;
  }

  return out;
}

export default { run } satisfies ToolLogic<string, string, SystemdUnitOpts>;
