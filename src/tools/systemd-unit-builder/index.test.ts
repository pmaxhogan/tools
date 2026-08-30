import { describe, expect, it } from "vitest";
import { buildTimer, buildUnit, run, type SystemdUnitOpts } from "./index";
import { ToolError } from "../types";

const DEFAULT_OPTS: SystemdUnitOpts = {
  description: "My service",
  exec: "/usr/bin/myapp",
  execStop: "",
  workingDir: "",
  user: "",
  group: "",
  type: "simple",
  restart: "on-failure",
  restartSec: 5,
  wantedBy: "multi-user.target",
  after: "network-online.target",
  environment: "",
  hardening: true,
  timer: false,
  onCalendar: "daily",
};

describe("buildUnit", () => {
  it("renders a default unit with sane defaults", () => {
    const out = buildUnit(DEFAULT_OPTS);
    expect(out).toContain("[Unit]");
    expect(out).toContain("Description=My service");
    expect(out).toContain("ExecStart=/usr/bin/myapp");
    expect(out).toContain("Restart=on-failure");
    expect(out).toContain("WantedBy=multi-user.target");
    expect(out).toContain("NoNewPrivileges=true");
  });

  it("emits both After= and Wants= for network-online.target", () => {
    const out = buildUnit(DEFAULT_OPTS);
    expect(out).toContain("After=network-online.target");
    expect(out).toContain("Wants=network-online.target");
  });

  it("omits Wants= for a plain After target, and omits After= entirely for none", () => {
    const plain = buildUnit({ ...DEFAULT_OPTS, after: "network.target" });
    expect(plain).toContain("After=network.target");
    expect(plain).not.toContain("Wants=");

    const none = buildUnit({ ...DEFAULT_OPTS, after: "none" });
    expect(none).not.toContain("After=");
    expect(none).not.toContain("Wants=");
  });

  it("splits Environment lines correctly, skipping blanks", () => {
    const out = buildUnit({
      ...DEFAULT_OPTS,
      environment: "NODE_ENV=production\n\nPORT=3000\n  \n",
    });
    expect(out).toContain("Environment=NODE_ENV=production");
    expect(out).toContain("Environment=PORT=3000");
    // No stray blank-line environment directive.
    expect(out).not.toContain("Environment=\n");
  });

  it("omits hardening lines when hardening is false", () => {
    const out = buildUnit({ ...DEFAULT_OPTS, hardening: false });
    expect(out).not.toContain("NoNewPrivileges=true");
    expect(out).not.toContain("ProtectSystem=strict");
    expect(out).not.toContain("ProtectHome=true");
  });

  it("includes optional directives only when set", () => {
    const bare = buildUnit(DEFAULT_OPTS);
    expect(bare).not.toContain("ExecStop=");
    expect(bare).not.toContain("WorkingDirectory=");
    expect(bare).not.toContain("User=");
    expect(bare).not.toContain("Group=");

    const full = buildUnit({
      ...DEFAULT_OPTS,
      execStop: "/usr/bin/myapp --stop",
      workingDir: "/opt/myapp",
      user: "myapp",
      group: "myapp",
    });
    expect(full).toContain("ExecStop=/usr/bin/myapp --stop");
    expect(full).toContain("WorkingDirectory=/opt/myapp");
    expect(full).toContain("User=myapp");
    expect(full).toContain("Group=myapp");
  });

  it("throws empty-input when ExecStart is blank", () => {
    expect(() => buildUnit({ ...DEFAULT_OPTS, exec: "" })).toThrowError(ToolError);
    expect(() => buildUnit({ ...DEFAULT_OPTS, exec: "  " })).toThrowError(ToolError);
    try {
      buildUnit({ ...DEFAULT_OPTS, exec: "" });
      throw new Error("expected ToolError");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as InstanceType<typeof ToolError>).code).toBe("empty-input");
    }
  });
});

describe("buildTimer", () => {
  it("renders a [Timer] section with OnCalendar and Persistent=true", () => {
    const out = buildTimer(DEFAULT_OPTS);
    expect(out).toContain("[Timer]");
    expect(out).toContain("OnCalendar=daily");
    expect(out).toContain("Persistent=true");
    expect(out).toContain("WantedBy=timers.target");
  });

  it("uses the given onCalendar value", () => {
    const out = buildTimer({ ...DEFAULT_OPTS, onCalendar: "*-*-* 03:00:00" });
    expect(out).toContain("OnCalendar=*-*-* 03:00:00");
  });
});

describe("run", () => {
  it("uses opts.exec when set, ignoring input", () => {
    const out = run("/should/not/be/used", DEFAULT_OPTS);
    expect(out).toContain("ExecStart=/usr/bin/myapp");
  });

  it("falls back to input as ExecStart when opts.exec is empty", () => {
    const out = run("/usr/local/bin/thing --serve", { ...DEFAULT_OPTS, exec: "" });
    expect(out).toContain("ExecStart=/usr/local/bin/thing --serve");
  });

  it("throws empty-input when both opts.exec and input are empty", () => {
    expect(() => run("", { ...DEFAULT_OPTS, exec: "" })).toThrowError(ToolError);
    try {
      run("   ", { ...DEFAULT_OPTS, exec: "" });
      throw new Error("expected ToolError");
    } catch (e) {
      expect(e).toBeInstanceOf(ToolError);
      expect((e as InstanceType<typeof ToolError>).code).toBe("empty-input");
    }
  });

  it("appends a [Timer] section with OnCalendar when timer is true", () => {
    const out = run("", { ...DEFAULT_OPTS, timer: true });
    expect(out).toContain("[Timer]");
    expect(out).toContain("OnCalendar=daily");
  });

  it("does not append a [Timer] section when timer is false", () => {
    const out = run("", { ...DEFAULT_OPTS, timer: false });
    expect(out).not.toContain("[Timer]");
  });
});

describe("run: the meta.ts examples", () => {
  it("fills ExecStart from the quick entry command when exec is empty", () => {
    const out = run("/usr/bin/node /srv/app/server.js", {
      ...DEFAULT_OPTS,
      exec: "",
      description: "My Node app",
    });
    expect(out).toContain("ExecStart=/usr/bin/node /srv/app/server.js");
    expect(out).toContain("Description=My Node app");
  });

  it("builds a oneshot backup service with a 3am timer", () => {
    const out = run("", {
      ...DEFAULT_OPTS,
      description: "Nightly backup",
      exec: "/usr/local/bin/backup.sh",
      type: "oneshot",
      timer: true,
      onCalendar: "*-*-* 03:00:00",
    });
    expect(out).toContain("ExecStart=/usr/local/bin/backup.sh");
    expect(out).toContain("Type=oneshot");
    expect(out).toContain("OnCalendar=*-*-* 03:00:00");
  });
});
