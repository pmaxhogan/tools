import { ToolError, type ToolLogic } from "../types";

export interface SpeculationRulesOpts {
  /** "generate" (default) or "validate". */
  mode?: string;
  /** "prefetch" (default) or "prerender". Generate mode only. */
  action?: string;
  /** "conservative" | "moderate" (default) | "eager" | "immediate". Generate mode only. */
  eagerness?: string;
  /** Emit document (pattern) rules when patterns are present. Generate mode only. */
  documentRules?: boolean;
  /** Wrap the JSON in a <script type="speculationrules"> tag. Generate mode only. */
  scriptTag?: boolean;
  [key: string]: unknown;
}

type SpeculationRulesResult = string | Record<string, string>;

const EAGERNESS_VALUES = ["conservative", "moderate", "eager", "immediate"];
const EAGERNESS_ADVERB: Record<string, string> = {
  conservative: "conservatively",
  moderate: "moderately eagerly",
  eager: "eagerly",
  immediate: "immediately",
};

const TOP_KEYS = ["prefetch", "prerender", "prefetch_with_subresources"];
const RULE_KEYS = [
  "source",
  "urls",
  "where",
  "eagerness",
  "expects_no_vary_search",
  "referrer_policy",
  "requires",
  "relative_to",
  "target_hint",
  "tags",
];
const WHERE_KEYS = ["href_matches", "selector_matches", "and", "or", "not"];
const REFERRER_POLICIES = [
  "",
  "no-referrer",
  "no-referrer-when-downgrade",
  "origin",
  "origin-when-cross-origin",
  "same-origin",
  "strict-origin",
  "strict-origin-when-cross-origin",
  "unsafe-url",
];
const KNOWN_REQUIREMENTS = ["anonymous-client-ip-when-cross-origin"];

/* ------------------------------- generate -------------------------------- */

interface Classified {
  includes: string[];
  excludes: string[];
  plainUrls: string[];
}

function isPattern(s: string): boolean {
  return s.includes("*") || /:[A-Za-z_]\w*/.test(s);
}

function classifyLines(raw: string): Classified {
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const includes: string[] = [];
  const excludes: string[] = [];
  const plainUrls: string[] = [];

  for (const line of lines) {
    const notMatch = /^not(?:\s+(.*))?$/i.exec(line);
    if (notMatch) {
      const text = (notMatch[1] ?? "").trim();
      if (text) excludes.push(text);
      continue;
    }
    if (isPattern(line)) includes.push(line);
    else plainUrls.push(line);
  }

  return { includes, excludes, plainUrls };
}

function toHrefMatches(patterns: string[]): string | string[] {
  return patterns.length === 1 ? patterns[0] : patterns;
}

function buildRuleSet(
  classified: Classified,
  action: "prefetch" | "prerender",
  eagerness: string,
  documentRules: boolean,
): Record<string, unknown> {
  const rules: Record<string, unknown>[] = [];
  const hasPatterns = classified.includes.length > 0 || classified.excludes.length > 0;

  if (documentRules && hasPatterns) {
    let where: Record<string, unknown>;
    if (classified.excludes.length === 0) {
      where = { href_matches: toHrefMatches(classified.includes) };
    } else {
      const includePatterns = classified.includes.length > 0 ? classified.includes : ["/*"];
      where = {
        and: [
          { href_matches: toHrefMatches(includePatterns) },
          { not: { href_matches: toHrefMatches(classified.excludes) } },
        ],
      };
    }
    rules.push({ source: "document", where, eagerness });
    if (classified.plainUrls.length > 0) {
      rules.push({ source: "list", urls: classified.plainUrls, eagerness });
    }
  } else {
    const allUrls = [...classified.includes, ...classified.excludes, ...classified.plainUrls];
    rules.push({ source: "list", urls: allUrls, eagerness });
  }

  return { [action]: rules };
}

function crossOriginAdvisory(classified: Classified, action: string): string | null {
  if (action !== "prerender") return null;
  const all = [...classified.includes, ...classified.excludes, ...classified.plainUrls];
  const origins = new Set<string>();
  for (const u of all) {
    const m = /^https?:\/\/[^/]+/i.exec(u);
    if (m) origins.add(m[0].toLowerCase());
  }
  if (origins.size === 0) return null;
  const subject = origins.size > 1 ? "these absolute URLs" : "this absolute URL";
  return (
    `Note: prerendering ${subject} (${[...origins].join(", ")}) crosses an origin boundary. ` +
    "The target page must opt in with a Supports-Loading-Mode: credentialed-prerender response header; same-origin prerendering needs no opt-in."
  );
}

function render(ruleSetObj: Record<string, unknown>, scriptTag: boolean, advisory: string | null): string {
  const json = JSON.stringify(ruleSetObj, null, 2);
  if (!scriptTag) return json;
  const prefix = advisory ? `<!-- ${advisory} -->\n` : "";
  return `${prefix}<script type="speculationrules">\n${json}\n</script>`;
}

function generate(input: string, opts: SpeculationRulesOpts): string {
  const raw = (input ?? "").trim();
  if (!raw) {
    throw new ToolError(
      "empty-input",
      "Enter at least one URL or URL pattern, one per line.",
      "Add a line like /products/* or https://example.com/page.",
    );
  }

  const classified = classifyLines(raw);
  if (classified.includes.length === 0 && classified.excludes.length === 0 && classified.plainUrls.length === 0) {
    throw new ToolError(
      "no-urls",
      "No usable URLs or patterns were found in the input.",
      "Add at least one URL, path, or pattern like /products/*, one per line.",
    );
  }

  const action = opts.action === "prerender" ? "prerender" : "prefetch";
  const eagerness =
    typeof opts.eagerness === "string" && EAGERNESS_VALUES.includes(opts.eagerness) ? opts.eagerness : "moderate";
  const documentRules = opts.documentRules !== false;
  const scriptTag = opts.scriptTag !== false;

  const ruleSetObj = buildRuleSet(classified, action, eagerness, documentRules);
  const advisory = crossOriginAdvisory(classified, action);
  return render(ruleSetObj, scriptTag, advisory);
}

/* ------------------------------- validate -------------------------------- */

interface Finding {
  severity: "error" | "warning";
  path: string;
  message: string;
}

function stripScriptTag(raw: string): string {
  const typed = /<script[^>]*type=["']speculationrules["'][^>]*>([\s\S]*?)<\/script>/i.exec(raw);
  if (typed) return typed[1].trim();
  const anyScript = /<script[^>]*>([\s\S]*?)<\/script>/i.exec(raw);
  if (anyScript) return anyScript[1].trim();
  return raw;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch (e) {
    const err = e as SyntaxError;
    const m = /position (\d+)/.exec(err.message);
    let where = "";
    if (m) {
      const pos = Number(m[1]);
      const upto = text.slice(0, pos);
      const line = upto.split("\n").length;
      const col = pos - upto.lastIndexOf("\n");
      where = ` at line ${line}, column ${col}`;
    }
    throw new ToolError(
      "bad-json",
      `Could not parse the rules as JSON${where}: ${err.message}`,
      "Check for a trailing comma, a missing quote, or an unbalanced brace near that position.",
    );
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validateWhere(where: unknown, path: string, findings: Finding[]): void {
  if (!isPlainObject(where)) {
    findings.push({ severity: "error", path, message: "A where clause must be a JSON object." });
    return;
  }
  for (const k of Object.keys(where)) {
    if (!WHERE_KEYS.includes(k)) {
      findings.push({
        severity: "error",
        path: `${path}.${k}`,
        message: `Unknown key "${k}" in a where clause. Expected href_matches, selector_matches, and, or, or not.`,
      });
      continue;
    }
    const v = where[k];
    if (k === "href_matches" || k === "selector_matches") {
      const ok = typeof v === "string" || (Array.isArray(v) && v.every((x) => typeof x === "string"));
      if (!ok) {
        findings.push({
          severity: "error",
          path: `${path}.${k}`,
          message: `"${k}" must be a string or an array of strings.`,
        });
      }
    } else if (k === "and" || k === "or") {
      if (!Array.isArray(v)) {
        findings.push({
          severity: "error",
          path: `${path}.${k}`,
          message: `"${k}" must be an array of where clauses.`,
        });
      } else {
        v.forEach((sub, i) => validateWhere(sub, `${path}.${k}[${i}]`, findings));
      }
    } else if (k === "not") {
      validateWhere(v, `${path}.not`, findings);
    }
  }
}

function validateRule(rule: unknown, path: string, listKey: string, findings: Finding[]): void {
  if (!isPlainObject(rule)) {
    findings.push({ severity: "error", path, message: "A rule must be a JSON object." });
    return;
  }

  for (const k of Object.keys(rule)) {
    if (!RULE_KEYS.includes(k)) {
      findings.push({ severity: "error", path: `${path}.${k}`, message: `Unknown key "${k}" in a speculation rule.` });
    }
  }

  const hasUrls = "urls" in rule;
  const hasWhere = "where" in rule;
  let source: string | undefined;

  if ("source" in rule) {
    const s = rule.source;
    if (s !== "list" && s !== "document") {
      findings.push({
        severity: "error",
        path: `${path}.source`,
        message: `Unknown source "${String(s)}". Expected "list" or "document".`,
      });
    } else {
      source = s;
      if (source === "list" && !hasUrls) {
        findings.push({ severity: "error", path, message: `source is "list" but no "urls" array is present.` });
      } else if (source === "document" && hasUrls) {
        findings.push({
          severity: "error",
          path,
          message: `source is "document" but "urls" is a list-source field; use "where" instead.`,
        });
      }
    }
  } else if (hasUrls) {
    source = "list";
  } else if (hasWhere) {
    source = "document";
  } else {
    findings.push({ severity: "error", path, message: `Rule has no "source", "urls", or "where": nothing to match.` });
  }

  if (source === "list" && hasUrls) {
    const urls = rule.urls;
    if (!Array.isArray(urls) || !urls.every((u) => typeof u === "string")) {
      findings.push({ severity: "error", path: `${path}.urls`, message: `"urls" must be an array of strings.` });
    }
  }

  if (source === "document" && !hasWhere) {
    findings.push({
      severity: "warning",
      path,
      message: `No "where" clause: this document rule matches every same-origin navigation.`,
    });
  }

  if (hasWhere) validateWhere(rule.where, `${path}.where`, findings);

  if ("eagerness" in rule) {
    const e = rule.eagerness;
    if (typeof e !== "string" || !EAGERNESS_VALUES.includes(e)) {
      findings.push({
        severity: "error",
        path: `${path}.eagerness`,
        message: `Unknown eagerness "${String(e)}". Expected conservative, moderate, eager, or immediate.`,
      });
    }
  }

  if ("expects_no_vary_search" in rule && typeof rule.expects_no_vary_search !== "string") {
    findings.push({
      severity: "error",
      path: `${path}.expects_no_vary_search`,
      message: `"expects_no_vary_search" must be a string.`,
    });
  }

  if ("referrer_policy" in rule) {
    const rp = rule.referrer_policy;
    if (typeof rp !== "string" || !REFERRER_POLICIES.includes(rp)) {
      findings.push({
        severity: "error",
        path: `${path}.referrer_policy`,
        message: `Unknown referrer_policy "${String(rp)}".`,
      });
    }
  }

  if ("requires" in rule) {
    const req = rule.requires;
    if (!Array.isArray(req)) {
      findings.push({ severity: "error", path: `${path}.requires`, message: `"requires" must be an array of strings.` });
    } else {
      for (const reqVal of req) {
        if (typeof reqVal !== "string" || !KNOWN_REQUIREMENTS.includes(reqVal)) {
          findings.push({
            severity: "error",
            path: `${path}.requires`,
            message: `Unknown requirement "${String(reqVal)}".`,
          });
          continue;
        }
        if (reqVal === "anonymous-client-ip-when-cross-origin" && listKey !== "prefetch") {
          findings.push({
            severity: "error",
            path: `${path}.requires`,
            message: `"anonymous-client-ip-when-cross-origin" is only valid on prefetch rules, not ${listKey}.`,
          });
        }
      }
    }
  }
}

function validateRuleSet(root: unknown): Finding[] {
  const findings: Finding[] = [];

  if (!isPlainObject(root)) {
    findings.push({
      severity: "error",
      path: "$",
      message: "The top level must be a JSON object with prefetch, prerender, or prefetch_with_subresources keys.",
    });
    return findings;
  }

  for (const key of Object.keys(root)) {
    if (!TOP_KEYS.includes(key)) {
      findings.push({
        severity: "error",
        path: key,
        message: `Unknown top-level key "${key}". Expected prefetch, prerender, or prefetch_with_subresources.`,
      });
      continue;
    }
    if (key === "prefetch_with_subresources") {
      findings.push({
        severity: "warning",
        path: key,
        message: `"prefetch_with_subresources" is a deprecated, Chromium-only extension, not part of the standard Speculation Rules API.`,
      });
    }
    const list = root[key];
    if (!Array.isArray(list)) {
      findings.push({ severity: "error", path: key, message: `"${key}" must be an array of rule objects.` });
      continue;
    }
    list.forEach((rule, i) => validateRule(rule, `${key}[${i}]`, key, findings));
  }

  return findings;
}

function fmtPatterns(v: unknown): string {
  return Array.isArray(v) ? v.join(", ") : String(v);
}

function describeWhere(where: Record<string, unknown>): string {
  if ("href_matches" in where) {
    return `matching ${fmtPatterns(where.href_matches)}`;
  }
  if ("and" in where && Array.isArray(where.and)) {
    let includePart = "";
    let excludePart = "";
    for (const p of where.and) {
      if (isPlainObject(p) && "href_matches" in p) {
        includePart = fmtPatterns(p.href_matches);
      } else if (isPlainObject(p) && "not" in p && isPlainObject(p.not) && "href_matches" in p.not) {
        excludePart = fmtPatterns(p.not.href_matches);
      }
    }
    if (includePart && excludePart) return `matching ${includePart} except ${excludePart}`;
    if (includePart) return `matching ${includePart}`;
  }
  if ("selector_matches" in where) {
    return `for elements matching selector ${fmtPatterns(where.selector_matches)}`;
  }
  if ("or" in where && Array.isArray(where.or)) {
    return where.or.filter(isPlainObject).map((w) => describeWhere(w)).join(" or ");
  }
  if ("not" in where && isPlainObject(where.not)) {
    return `not ${describeWhere(where.not)}`;
  }
  return "matching a custom rule";
}

function describeRule(rule: Record<string, unknown>, key: string): string {
  const verb =
    key === "prerender" ? "Prerenders" : key === "prefetch_with_subresources" ? "Prefetches (with subresources)" : "Prefetches";

  let sourceDesc: string;
  if (Array.isArray(rule.urls)) {
    const urls = rule.urls as unknown[];
    sourceDesc =
      urls.length <= 3
        ? `${urls.length} listed URL${urls.length === 1 ? "" : "s"} (${urls.join(", ")})`
        : `${urls.length} listed URLs`;
  } else if (isPlainObject(rule.where)) {
    sourceDesc = `same-origin links ${describeWhere(rule.where)}`;
  } else {
    sourceDesc = "every same-origin navigation";
  }

  const eagernessAdverb = typeof rule.eagerness === "string" ? EAGERNESS_ADVERB[rule.eagerness] : undefined;
  return eagernessAdverb ? `${verb} ${sourceDesc}, ${eagernessAdverb}.` : `${verb} ${sourceDesc}.`;
}

function summarize(root: unknown): string {
  if (!isPlainObject(root)) return "Could not summarize: the top level is not a rules object.";

  const sentences: string[] = [];
  for (const key of TOP_KEYS) {
    const list = root[key];
    if (!Array.isArray(list)) continue;
    for (const rule of list) {
      if (!isPlainObject(rule)) continue;
      sentences.push(describeRule(rule, key));
    }
  }

  return sentences.length === 0 ? "This ruleset defines no active prefetch or prerender rules." : sentences.join(" ");
}

function validate(input: string, _opts: SpeculationRulesOpts): Record<string, string> {
  const raw = (input ?? "").trim();
  if (!raw) {
    throw new ToolError(
      "empty-input",
      'Paste the speculation rules JSON (or the full <script type="speculationrules"> tag) to validate.',
      'Paste a ruleset like {"prefetch":[{"source":"list","urls":["/a"]}]}.',
    );
  }

  const jsonText = stripScriptTag(raw);
  const parsed = parseJson(jsonText);
  const findings = validateRuleSet(parsed);

  const errorCount = findings.filter((f) => f.severity === "error").length;
  const warnCount = findings.filter((f) => f.severity === "warning").length;
  const verdict = errorCount > 0 ? "Invalid" : warnCount > 0 ? "Valid with warnings" : "Valid";

  const out: Record<string, string> = { Verdict: verdict };
  findings.forEach((f, i) => {
    out[`Finding ${i + 1}`] = `[${f.severity.toUpperCase()}] ${f.path}: ${f.message}`;
  });
  out["Summary"] = errorCount > 0 ? "Could not summarize: fix the errors above first." : summarize(parsed);

  return out;
}

/* --------------------------------- run ------------------------------------ */

export function run(input: string, opts: SpeculationRulesOpts): SpeculationRulesResult {
  const mode = opts?.mode === "validate" ? "validate" : "generate";
  return mode === "validate" ? validate(input, opts) : generate(input, opts);
}

export default { run } satisfies ToolLogic<string, SpeculationRulesResult, SpeculationRulesOpts>;
