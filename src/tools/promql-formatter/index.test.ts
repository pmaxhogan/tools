import { describe, expect, it } from "vitest";
import { formatQuery, run } from "./index";
import { ToolError } from "../types";

const fmt = (q: string, lang = "auto"): string => run(q, { mode: "format", lang }) as string;
const rows = (q: string, lang = "auto"): Record<string, string> =>
  run(q, { mode: "explain", lang }) as Record<string, string>;
const steps = (q: string, lang = "auto"): string[] => {
  const out = rows(q, lang);
  return Object.keys(out)
    .filter((k) => k.startsWith("Step "))
    .map((k) => out[k] as string);
};

/** Every query the formatter is expected to survive and stabilise on. */
const CORPUS = [
  `sum by (job) (rate(http_requests_total{job="api",status!~"5.."}[5m]))`,
  `histogram_quantile(0.95, sum by (le, route) (rate(http_request_duration_seconds_bucket{job="api"}[5m])))`,
  `sum(rate(http_requests_total{status=~"5.."}[5m])) / sum(rate(http_requests_total[5m]))`,
  `{app="payments"} |= "error" != "timeout" | json | duration > 500ms | line_format "{{.msg}}"`,
  `quantile_over_time(0.99, {app="api"} | json | unwrap duration [5m]) by (route)`,
  `max_over_time(rate(x[5m])[1h:1m])`,
  `sum(rate(http_requests_total[5m] offset 1h @ end()))`,
  `node_cpu_seconds_total{mode="idle",instance="server-01.homelab.example.com:9100",job="node-exporter",cpu="0"}`,
  `sum(rate(a_total[5m])) / on (job) group_left sum(rate(b_total[5m]))`,
  `# alert on errors\nsum(rate(errors_total[5m])) > 0.05`,
  `up{job="api"} +`,
  `topk(5, sum by (pod) (container_memory_usage_bytes))`,
  `up offset 5m`,
  `{app="payments"}`,
];

describe("promql-formatter: formatting", () => {
  it("breaks a long aggregation over lines and keeps by attached", () => {
    expect(fmt(`sum by (job) (rate(http_requests_total{job="api",status!~"5.."}[5m]))`)).toBe(
      ["sum by (job) (", `  rate(http_requests_total{job="api", status!~"5.."}[5m])`, ")"].join(
        "\n",
      ),
    );
  });

  it("indents a nested histogram_quantile two spaces per level", () => {
    expect(
      fmt(
        `histogram_quantile(0.95, sum by (le, route) (rate(http_request_duration_seconds_bucket{job="api"}[5m])))`,
      ),
    ).toBe(
      [
        "histogram_quantile(",
        "  0.95,",
        "  sum by (le, route) (",
        "    rate(",
        `      http_request_duration_seconds_bucket{job="api"}[5m]`,
        "    )",
        "  )",
        ")",
      ].join("\n"),
    );
  });

  it("breaks a binary operation between two vectors at the operator", () => {
    expect(
      fmt(`sum(rate(http_requests_total{status=~"5.."}[5m])) / sum(rate(http_requests_total[5m]))`),
    ).toBe(
      [
        `sum(rate(http_requests_total{status=~"5.."}[5m]))`,
        "  / sum(rate(http_requests_total[5m]))",
      ].join("\n"),
    );
  });

  it("keeps the vector matching modifiers on the operator", () => {
    expect(fmt(`sum(rate(a_total[5m])) / on(job) group_left sum(rate(b_total[5m]))`)).toBe(
      ["sum(rate(a_total[5m]))", "  / on (job) group_left sum(rate(b_total[5m]))"].join("\n"),
    );
  });

  it("puts every LogQL pipeline stage on its own line", () => {
    expect(
      fmt(
        `{app="payments"} |= "error" != "timeout" | json | duration > 500ms | line_format "{{.msg}}"`,
      ),
    ).toBe(
      [
        `{app="payments"}`,
        `  |= "error"`,
        `  != "timeout"`,
        "  | json",
        "  | duration > 500ms",
        `  | line_format "{{.msg}}"`,
      ].join("\n"),
    );
  });

  it("formats an unwrapped LogQL range aggregation with a trailing by clause", () => {
    expect(
      fmt(`quantile_over_time(0.99, {app="api"} | json | unwrap duration [5m]) by (route)`),
    ).toBe(
      [
        "quantile_over_time(",
        "  0.99,",
        `  {app="api"}`,
        "    | json",
        "    | unwrap duration",
        "  [5m]",
        ") by (route)",
      ].join("\n"),
    );
  });

  it("keeps a short subquery on one line", () => {
    expect(fmt(`max_over_time( rate( x [ 5m ] ) [ 1h : 1m ] )`)).toBe(
      "max_over_time(rate(x[5m])[1h:1m])",
    );
  });

  it("normalizes offset and @ modifier spacing", () => {
    expect(fmt(`sum(rate(http_requests_total[5m]offset 1h@end()))`)).toBe(
      "sum(rate(http_requests_total[5m] offset 1h @ end()))",
    );
    expect(fmt("up   offset   5m")).toBe("up offset 5m");
  });

  it("splits a label matcher block only once it passes 80 characters", () => {
    expect(fmt(`node_cpu_seconds_total{mode="idle",cpu="0"}`)).toBe(
      `node_cpu_seconds_total{mode="idle", cpu="0"}`,
    );
    expect(
      fmt(
        `node_cpu_seconds_total{mode="idle",instance="server-01.homelab.example.com:9100",job="node-exporter",cpu="0"}`,
      ),
    ).toBe(
      [
        "node_cpu_seconds_total{",
        `  mode="idle",`,
        `  instance="server-01.homelab.example.com:9100",`,
        `  job="node-exporter",`,
        `  cpu="0"`,
        "}",
      ].join("\n"),
    );
  });

  it("hoists comments above the formatted query", () => {
    expect(fmt(`# alert on errors\nsum(rate(errors_total[5m])) > 0.05`)).toBe(
      ["# alert on errors", "sum(rate(errors_total[5m])) > 0.05"].join("\n"),
    );
  });

  it("degrades to whitespace normalization instead of crashing on odd input", () => {
    // A stray trailing operator is not a parsable expression.
    expect(fmt(`up{job="api"}   +`)).toBe(`up{job="api"} +`);
    expect(steps(`up{job="api"} +`)[0]).toMatch(/could not be read as one complete expression/);
  });

  it("is idempotent for every query in the corpus", () => {
    for (const raw of CORPUS) {
      const q = raw.replace(/\\n/g, "\n");
      const once = fmt(q);
      expect(fmt(once), `not idempotent for: ${q}`).toBe(once);
    }
  });

  it("exposes formatQuery directly for the http endpoint", () => {
    expect(formatQuery(`up{job="api"}`)).toBe(`up{job="api"}`);
  });
});

describe("promql-formatter: language detection", () => {
  it("detects LogQL from a line filter or a pipeline stage", () => {
    expect(rows(`{app="api"} |= "boom"`)["Language"]).toBe("LogQL (detected)");
    expect(rows(`sum(count_over_time({app="api"} | logfmt [5m]))`)["Language"]).toBe(
      "LogQL (detected)",
    );
  });

  it("detects PromQL for a normal metric query", () => {
    expect(rows(`rate(http_requests_total[5m])`)["Language"]).toBe("PromQL (detected)");
  });

  it("does not mistake a regex alternation for a LogQL pipe", () => {
    expect(rows(`up{job=~"api|web"}`)["Language"]).toBe("PromQL (detected)");
  });

  it("honours an explicit language, including synonyms", () => {
    expect(rows(`up{job="api"}`, "loki")["Language"]).toBe("LogQL");
    // Forced to PromQL, != is a comparison rather than a line filter.
    expect(fmt(`{app="x"}!="timeout"`, "prometheus")).toBe(`{app="x"} != "timeout"`);
    // Left on auto, the same text is a LogQL line filter stage.
    expect(fmt(`{app="x"} |= "a" != "timeout"`)).toBe(
      [`{app="x"}`, `  |= "a"`, `  != "timeout"`].join("\n"),
    );
  });
});

describe("promql-formatter: explain", () => {
  it("explains a LogQL pipeline stage by stage", () => {
    expect(
      steps(
        `{app="payments"} |= "error" != "timeout" | json | duration > 500ms | line_format "{{.msg}}"`,
      ),
    ).toEqual([
      'Select the log streams where app equals "payments".',
      'Keep only log lines containing "error".',
      'Drop log lines containing "timeout".',
      "Parse each line as JSON and turn its fields into labels.",
      "Keep only entries where duration > 500ms.",
      'Rewrite each output line as "{{.msg}}".',
    ]);
  });

  it("explains a sum by rate query from the inside out", () => {
    expect(steps(`sum by (job) (rate(http_requests_total{job="api",status!~"5.."}[5m]))`)).toEqual([
      'Select the series named http_requests_total where job equals "api" and status does not match the regex "5..".',
      "Look at a range window covering the last 5 minutes.",
      "rate: per-second average rate of increase across the range window.",
      "sum: adds the values together, grouped by (job).",
    ]);
  });

  it("explains unwrap, subqueries, offsets and @ modifiers", () => {
    expect(steps(`{app="api"} | json | unwrap duration`)).toContain(
      "Use duration as the numeric sample value (unwrap).",
    );
    expect(steps(`max_over_time(rate(x[5m])[1h:1m])`)).toContain(
      "Subquery: evaluate everything above every 1 minute across the last 1 hour.",
    );
    const modifiers = steps(`rate(http_requests_total[5m] offset 1h30m @ end())`);
    expect(modifiers).toContain("Shift the lookup 1 hour 30 minutes into the past (offset).");
    expect(modifiers).toContain(
      "Pin the evaluation to end() instead of the query time (@ modifier).",
    );
  });

  it("explains binary operations and unknown functions honestly", () => {
    expect(steps(`sum(rate(errors_total[5m])) > 0.05`)).toContain(
      'Apply ">" (keep only values greater than) to the result above and 0.05.',
    );
    expect(steps(`rate(a[5m]) / rate(b[5m])`)).toContain(
      'Combine the two results above with "/" (divide).',
    );
    expect(steps(`totally_made_up_func(up)`)).toContain(
      "function totally_made_up_func (no description).",
    );
  });

  it("numbers the rows and puts the formatted query first in both mode", () => {
    const out = run(`sum by (job) (rate(http_requests_total[5m]))`, { mode: "both" }) as Record<
      string,
      string
    >;
    const keys = Object.keys(out);
    expect(keys[0]).toBe("Formatted");
    expect(keys[1]).toBe("Language");
    expect(keys[2]).toBe("Step 1");
    expect(out["Formatted"]).toBe("sum by (job) (rate(http_requests_total[5m]))");
  });
});

describe("promql-formatter: errors", () => {
  it("rejects empty input", () => {
    expect(() => run("   ", {})).toThrowError(ToolError);
    try {
      run("", {});
    } catch (e) {
      expect((e as ToolError).code).toBe("empty-input");
      expect((e as ToolError).fix).toMatch(/rate\(http_requests_total\[5m\]\)/);
    }
  });

  it("reports unbalanced brackets with a position", () => {
    try {
      run(`sum(rate(http_requests_total[5m])`, {});
      throw new Error("expected a ToolError");
    } catch (e) {
      expect((e as ToolError).code).toBe("unbalanced");
      expect((e as ToolError).message).toMatch(/Unbalanced parentheses or braces/);
      expect((e as ToolError).message).toMatch(/position 4/);
    }
    try {
      run(`sum(rate(x[5m])))`, {});
      throw new Error("expected a ToolError");
    } catch (e) {
      expect((e as ToolError).code).toBe("unbalanced");
      expect((e as ToolError).message).toMatch(/position 17/);
    }
  });

  it("rejects an unknown language", () => {
    try {
      run(`up`, { lang: "sql" });
      throw new Error("expected a ToolError");
    } catch (e) {
      expect((e as ToolError).code).toBe("bad-lang");
      expect((e as ToolError).fix).toMatch(/logql/);
    }
  });

  it("falls back to format for an unknown mode instead of failing", () => {
    expect(run(`up`, { mode: "nonsense" })).toBe("up");
  });
});
