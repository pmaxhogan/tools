import { describe, expect, it } from "vitest";
import { run } from "./index";
import { ToolError } from "../types";

/** Build a Discord-formula snowflake from its component fields. */
function buildDiscordId(
  targetMs: number,
  workerId: number,
  processId: number,
  increment: number,
): bigint {
  return (
    ((BigInt(targetMs) - 1420070400000n) << 22n) |
    (BigInt(workerId) << 17n) |
    (BigInt(processId) << 12n) |
    BigInt(increment)
  );
}

describe("snowflake-decoder", () => {
  it("decodes a real Discord snowflake to its documented timestamp", () => {
    // Documented example from Discord's developer docs.
    const out = run("175928847299117063", { platform: "discord" });
    expect(out["Timestamp (UTC)"]).toBe("2016-04-30T11:18:25.796Z");
    expect(out["Unix milliseconds"]).toBe("1462015105796");
    expect(out["Worker ID"]).toBe("1");
    expect(out["Process ID"]).toBe("0");
    expect(out["Increment"]).toBe("7");
    expect(out["Warning"]).toBeUndefined();
  });

  it("decodes a Twitter/X snowflake", () => {
    // Synthetic ID built from a known timestamp, machine 42, sequence 7.
    const out = run("1272499091666018311", { platform: "twitter" });
    expect(out["Timestamp (UTC)"]).toBe("2020-06-15T12:00:00.000Z");
    expect(out["Machine ID"]).toBe("42");
    expect(out["Sequence"]).toBe("7");
    expect(out["Warning"]).toBeUndefined();
  });

  it("decodes an Instagram snowflake", () => {
    // Synthetic ID: timestamp << 23 | shard << 10 | sequence.
    const targetMs = Date.UTC(2021, 2, 1, 0, 0, 0);
    const id = (BigInt(targetMs) << 23n) | (99n << 10n) | 5n;
    const out = run(id.toString(), { platform: "instagram" });
    expect(out["Timestamp (UTC)"]).toBe(new Date(targetMs).toISOString());
    expect(out["Shard ID"]).toBe("99");
    expect(out["Sequence"]).toBe("5");
  });

  it("rejects input with no snowflake in it, suggesting the accepted formats", () => {
    expect(() => run("not-a-snowflake", { platform: "discord" })).toThrowError(ToolError);
    try {
      run("abc123", { platform: "discord" });
    } catch (e) {
      expect((e as ToolError).code).toBe("no-snowflake-found");
      expect((e as ToolError).fix).toMatch(/17-20 digit/);
      expect((e as ToolError).fix).toMatch(/Discord/);
    }
  });

  it("rejects empty input", () => {
    expect(() => run("", { platform: "discord" })).toThrowError(ToolError);
    try {
      run("   ", { platform: "discord" });
    } catch (e) {
      expect((e as ToolError).code).toBe("empty-input");
    }
  });

  it("warns when the decoded date is implausible for the selected platform", () => {
    // An absurdly large ID decodes to a date far past year 2100 under the
    // Discord formula, a strong signal the wrong platform was chosen.
    const out = run("99999999999999999999", { platform: "discord" });
    expect(out["Warning"]).toMatch(/double-check/i);
    expect(new Date(out["Timestamp (UTC)"]!).getUTCFullYear()).toBeGreaterThan(2100);
  });

  it("defaults to discord when an unknown platform is given", () => {
    const out = run("175928847299117063", { platform: "bogus" });
    expect(out["Worker ID"]).toBe("1");
  });

  it("extracts and decodes the message ID out of a Discord channels URL", () => {
    const targetMs = Date.UTC(2022, 0, 1, 0, 0, 0);
    const messageId = buildDiscordId(targetMs, 3, 1, 42);
    const guildId = 111111111111111111n;
    const channelId = 222222222222222222n;
    const url = `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;

    const out = run(url, { platform: "discord" });
    const block = out[url]!;
    expect(block).toContain(`Guild ID: ${guildId}`);
    expect(block).toContain(`Channel ID: ${channelId}`);
    expect(block).toContain(`Message ID: ${messageId}`);
    expect(block).toContain("Timestamp (UTC): 2022-01-01T00:00:00.000Z");
    expect(block).toContain("Worker ID: 3");
    expect(block).toContain("Process ID: 1");
    expect(block).toContain("Increment: 42");
  });

  it("extracts and decodes a Discord user ID out of a users URL, same as a bare ID", () => {
    const out = run("https://discord.com/users/175928847299117063", { platform: "discord" });
    expect(out["Timestamp (UTC)"]).toBe("2016-04-30T11:18:25.796Z");
    expect(out["Worker ID"]).toBe("1");
  });

  it("extracts a generic 17-20 digit ID from a non-Discord URL", () => {
    const url = "https://example.com/orders/175928847299117063/receipt";
    const out = run(url, { platform: "discord" });
    expect(out["Timestamp (UTC)"]).toBe("2016-04-30T11:18:25.796Z");
    expect(out["Worker ID"]).toBe("1");
  });

  it("decodes a multi-line batch mixing a bare snowflake with a URL", () => {
    const targetMs = Date.UTC(2023, 5, 10, 8, 30, 0);
    const userId = buildDiscordId(targetMs, 7, 2, 99);
    const url = `https://discord.com/users/${userId}`;

    const out = run(`175928847299117063\n${url}`, { platform: "discord" });

    const bareBlock = out["175928847299117063"]!;
    expect(bareBlock).toContain("Snowflake ID: 175928847299117063");
    expect(bareBlock).toContain("Timestamp (UTC): 2016-04-30T11:18:25.796Z");

    const urlBlock = out[url]!;
    expect(urlBlock).toContain(`User ID: ${userId}`);
    expect(urlBlock).toContain("Timestamp (UTC): 2023-06-10T08:30:00.000Z");
    expect(urlBlock).toContain("Worker ID: 7");
    expect(urlBlock).toContain("Process ID: 2");
    expect(urlBlock).toContain("Increment: 99");
  });

  it("notes lines with no snowflake instead of failing the whole batch", () => {
    const out = run("175928847299117063\nno id on this line", { platform: "discord" });
    expect(out["175928847299117063"]).toContain("Snowflake ID: 175928847299117063");
    expect(out["no id on this line"]).toBe("No snowflake ID found in this line.");
  });

  it("disambiguates duplicate lines instead of dropping one", () => {
    const out = run("175928847299117063\n175928847299117063", { platform: "discord" });
    expect(Object.keys(out)).toContain("175928847299117063");
    expect(Object.keys(out)).toContain("175928847299117063 (#2)");
  });
});
