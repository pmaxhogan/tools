/**
 * Jinja Template Tester (Home Assistant) — the pure logic layer.
 *
 * The actual rendering runs real Python jinja2 inside Pyodide, which only
 * exists in the browser. This file therefore owns everything AROUND the engine
 * that can be pure and tested in Node:
 *
 *  - parseStatesInput: read the user's sample entity state (YAML or JSON) into
 *    a normalized { entity_id: { state, attributes } } map.
 *  - buildHaGlobals: generate the Python prelude that stubs the Home Assistant
 *    template functions (states(), is_state(), state_attr(), now(), ...) over
 *    that sample data. Pure code generation, no execution.
 *  - buildRenderProgram: compose the prelude with a jinja2 render harness and
 *    the user's template into one self-contained Python program.
 *  - extractResult / formatError: turn Pyodide's result or its Python traceback
 *    into a display string or a readable, line-numbered template error.
 *  - run: the headless entry point. Without Pyodide it cannot render, so it
 *    returns a preview of the parsed state and the stubbed functions, which
 *    still exercises the parsing and code-generation paths.
 *
 * Honesty note on the stubs (surfaced to users in the panel's reference):
 * every function here reads from the SAMPLE state you provide, not a live Home
 * Assistant instance. State-reading functions (states, is_state, state_attr,
 * has_value, states.<domain>) are faithful over your sample. Functions that
 * depend on a running instance or the network are NOT stubbed: service calls,
 * expand() over live groups, distance() to real coordinates, device_id/area
 * lookups, and history. now()/utcnow() use the real current time.
 */
import { parse as parseYaml } from "yaml";
import { ToolError, type ToolLogic } from "../types";

/** One entity, normalized: a string state plus an attributes map. */
export interface NormalizedState {
  state: string;
  attributes: Record<string, unknown>;
}

export type StatesMap = Record<string, NormalizedState>;

export interface JinjaOptions {
  /** The sample entity state, as YAML or JSON. The template is the main input. */
  state?: string;
  [key: string]: unknown;
}

/** A parsed, readable template failure. */
export interface TemplateError {
  /** The Python exception class, e.g. "TemplateSyntaxError" or "UndefinedError". */
  errorType: string;
  /** The exception message, stripped of its module prefix. */
  message: string;
  /** The 1-based template line, when the traceback names one. */
  line: number | null;
}

/* ------------------------------------------------------------------ */
/* sample-state parsing                                                */
/* ------------------------------------------------------------------ */

/** Coerce one entity's value into { state, attributes }, allowing shorthands. */
function normalizeEntity(value: unknown): NormalizedState {
  // Scalar shorthand: `light.kitchen: "on"` means the value is the state.
  if (value === null || value === undefined || typeof value !== "object" || Array.isArray(value)) {
    return { state: value === null || value === undefined ? "" : String(value), attributes: {} };
  }
  const obj = value as Record<string, unknown>;
  if ("state" in obj) {
    // Either an explicit `attributes:` map, or inline keys beside `state:`.
    const explicit =
      obj.attributes && typeof obj.attributes === "object" && !Array.isArray(obj.attributes)
        ? (obj.attributes as Record<string, unknown>)
        : null;
    const attributes =
      explicit ??
      Object.fromEntries(Object.entries(obj).filter(([k]) => k !== "state" && k !== "attributes"));
    const raw = obj.state;
    return { state: raw === null || raw === undefined ? "" : String(raw), attributes };
  }
  // An object with no `state`: treat the whole thing as attributes.
  return { state: "", attributes: obj };
}

/**
 * Parse the sample entity state. Accepts JSON and simple YAML (YAML is a
 * superset of JSON, so one parser covers both). Returns a normalized map;
 * an empty input is a valid empty map, not an error.
 */
export function parseStatesInput(input: string): StatesMap {
  const text = (input ?? "").trim();
  if (text === "") return {};

  let parsed: unknown;
  try {
    parsed = parseYaml(text);
  } catch {
    throw new ToolError(
      "invalid-state",
      "The sample state is not valid YAML or JSON.",
      'Use "entity.id:" keys with a "state:" value under each, or a JSON object of the same shape.',
    );
  }

  if (parsed === null || parsed === undefined) return {};
  if (typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ToolError(
      "invalid-state",
      "The sample state must be a mapping of entity ids to their state, not a list or a single value.",
      'Write each entity on its own line, like "sensor.temperature:" then an indented "state:".',
    );
  }

  const out: StatesMap = {};
  for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
    out[key] = normalizeEntity(value);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Python code generation                                              */
/* ------------------------------------------------------------------ */

/**
 * A Python expression that reconstructs `value` at runtime. Uses the
 * double-encode trick: JSON.stringify twice yields a string literal that is
 * valid Python AND whose decoded value is the JSON text, so json.loads gives
 * back the original. This never lets user data break out of a string literal.
 */
function pyJsonLoads(value: unknown): string {
  return `json.loads(${JSON.stringify(JSON.stringify(value))})`;
}

/** The static half of the prelude: the proxy classes and the stub factory. */
const HA_STUBS = String.raw`
_UNKNOWN = ("unknown", "unavailable", "none", "None", "")

def _to_data(value):
    if isinstance(value, dict):
        return value
    return {"state": value, "attributes": {}}

class _StateObj:
    def __init__(self, entity_id, data):
        data = _to_data(data)
        self.entity_id = entity_id
        parts = entity_id.split(".", 1)
        self.domain = parts[0]
        self.object_id = parts[1] if len(parts) > 1 else parts[0]
        raw = data.get("state")
        self.state = "" if raw is None else str(raw)
        self.attributes = data.get("attributes") or {}
        self.name = self.attributes.get("friendly_name") or self.object_id.replace("_", " ").title()
    def __str__(self):
        return self.state
    def __repr__(self):
        return "<state {}={}>".format(self.entity_id, self.state)
    def __eq__(self, other):
        return self.state == other
    def __hash__(self):
        return hash(self.entity_id)
    def __getitem__(self, key):
        return getattr(self, key)

class _DomainProxy:
    def __init__(self, states_map, domain):
        self._states = states_map
        self._domain = domain
    def __getattr__(self, object_id):
        if object_id.startswith("_"):
            raise AttributeError(object_id)
        eid = self._domain + "." + object_id
        if eid in self._states:
            return _StateObj(eid, self._states[eid])
        raise AttributeError("'" + eid + "' is not in the sample state")
    def __iter__(self):
        for eid in sorted(self._states):
            if eid.split(".", 1)[0] == self._domain:
                yield _StateObj(eid, self._states[eid])

class _StatesProxy:
    def __init__(self, states_map):
        self._states = states_map
    def __call__(self, entity_id=None, rounded=False, with_unit=False):
        if entity_id is None:
            return list(iter(self))
        data = self._states.get(entity_id)
        if data is None:
            return None
        return _StateObj(entity_id, data).state
    def __getattr__(self, domain):
        if domain.startswith("_"):
            raise AttributeError(domain)
        return _DomainProxy(self._states, domain)
    def __iter__(self):
        for eid in sorted(self._states):
            yield _StateObj(eid, self._states[eid])
    def get(self, entity_id):
        data = self._states.get(entity_id)
        return _StateObj(entity_id, data) if data is not None else None

def _make_ha_env(_STATES):
    states = _StatesProxy(_STATES)

    def _obj(entity_id):
        data = _STATES.get(entity_id)
        return _StateObj(entity_id, data) if data is not None else None

    def is_state(entity_id, value):
        obj = _obj(entity_id)
        if obj is None:
            return False
        if isinstance(value, (list, tuple)):
            return obj.state in [str(v) for v in value]
        return obj.state == str(value)

    def state_attr(entity_id, name):
        obj = _obj(entity_id)
        return obj.attributes.get(name) if obj is not None else None

    def is_state_attr(entity_id, name, value):
        return state_attr(entity_id, name) == value

    def has_value(entity_id):
        obj = _obj(entity_id)
        return obj is not None and obj.state not in _UNKNOWN

    def now():
        return datetime.now(timezone.utc).astimezone()

    def utcnow():
        return datetime.now(timezone.utc)

    def as_timestamp(value, default=None):
        try:
            if isinstance(value, datetime):
                return value.timestamp()
            if isinstance(value, (int, float)):
                return float(value)
            return datetime.fromisoformat(str(value)).timestamp()
        except (ValueError, TypeError):
            return default

    def as_datetime(value, default=None):
        try:
            if isinstance(value, datetime):
                return value
            return datetime.fromisoformat(str(value))
        except (ValueError, TypeError):
            return default

    def as_local(value):
        try:
            return value.astimezone()
        except (AttributeError, ValueError, OSError):
            return value

    def strptime(string, fmt, default=None):
        try:
            return datetime.strptime(str(string), fmt)
        except (ValueError, TypeError):
            return default

    def float_filter(value, default=0.0):
        try:
            return float(value)
        except (ValueError, TypeError):
            return default

    def int_filter(value, default=0, base=10):
        try:
            if isinstance(value, str):
                return int(value, base)
            return int(value)
        except (ValueError, TypeError):
            return default

    def timestamp_custom(value, fmt="%Y-%m-%dT%H:%M:%S%z", local=True, default=None):
        try:
            dt = datetime.fromtimestamp(float(value), timezone.utc)
            if local:
                dt = dt.astimezone()
            return dt.strftime(fmt)
        except (ValueError, TypeError, OSError):
            return default

    def timestamp_local(value, default=None):
        return timestamp_custom(value, "%Y-%m-%dT%H:%M:%S%z", True, default)

    def timestamp_utc(value, default=None):
        return timestamp_custom(value, "%Y-%m-%dT%H:%M:%S%z", False, default)

    HA_GLOBALS = {
        "states": states,
        "is_state": is_state,
        "state_attr": state_attr,
        "is_state_attr": is_state_attr,
        "has_value": has_value,
        "now": now,
        "utcnow": utcnow,
        "as_timestamp": as_timestamp,
        "as_datetime": as_datetime,
        "as_local": as_local,
        "strptime": strptime,
        "timedelta": timedelta,
    }
    HA_FILTERS = {
        "float": float_filter,
        "int": int_filter,
        "as_timestamp": as_timestamp,
        "as_datetime": as_datetime,
        "as_local": as_local,
        "timestamp_custom": timestamp_custom,
        "timestamp_local": timestamp_local,
        "timestamp_utc": timestamp_utc,
    }
    HA_TESTS = {
        "datetime": lambda v: isinstance(v, datetime),
    }
    return HA_GLOBALS, HA_FILTERS, HA_TESTS
`;

/**
 * Generate the Python prelude that defines the Home Assistant template stubs
 * over `states`. The result defines `HA_GLOBALS`, `HA_FILTERS` and `HA_TESTS`,
 * ready to hand to a jinja2 Environment. Pure: this only builds a string.
 */
export function buildHaGlobals(states: StatesMap): string {
  return [
    "import json",
    "from datetime import datetime, timedelta, timezone",
    `_STATES = ${pyJsonLoads(states)}`,
    HA_STUBS,
    "HA_GLOBALS, HA_FILTERS, HA_TESTS = _make_ha_env(_STATES)",
    "",
  ].join("\n");
}

/**
 * Compose a complete, self-contained Python program that renders `template`
 * with the Home Assistant stubs over `states`. The final expression is the
 * rendered string, which Pyodide returns to JavaScript; on a template error
 * the program raises, and Pyodide surfaces the traceback for formatError.
 */
export function buildRenderProgram(states: StatesMap, template: string): string {
  return [
    buildHaGlobals(states),
    "import jinja2",
    "_env = jinja2.Environment()",
    "_env.globals.update(HA_GLOBALS)",
    "_env.filters.update(HA_FILTERS)",
    "_env.tests.update(HA_TESTS)",
    `_TEMPLATE = ${pyJsonLoads(template)}`,
    "_env.from_string(_TEMPLATE).render()",
    "",
  ].join("\n");
}

/* ------------------------------------------------------------------ */
/* result and error extraction                                         */
/* ------------------------------------------------------------------ */

/** Normalize whatever Pyodide returns from a render into a display string. */
export function extractResult(value: unknown): string {
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value : String(value);
}

/**
 * Parse a Python traceback from Pyodide into a readable template error.
 *
 * Observed shapes from jinja2 under Pyodide:
 *  - Syntax errors end with `jinja2.exceptions.TemplateSyntaxError: ...` and
 *    carry the position as `File "<unknown>", line N, in template`.
 *  - Runtime errors (UndefinedError, ZeroDivisionError, ...) end with
 *    `ModuleOrNot.SomeError: ...` and carry `File "<template>", line N, in
 *    top-level template code`.
 * The module prefix is stripped from the error type, and the deepest template
 * line wins.
 */
export function formatError(pyErr: string): TemplateError {
  const raw = (pyErr ?? "").replace(/\r\n/g, "\n");
  const lines = raw.split("\n").map((l) => l.replace(/\s+$/, ""));

  let errorType = "Error";
  let message = "";
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const m = lines[i]!.match(/^[\w.]*?(\w+(?:Error|Exception|Warning)):\s(.*)$/);
    if (m) {
      errorType = m[1]!;
      message = m[2]!;
      break;
    }
  }
  if (message === "") {
    const last = [...lines].reverse().find((l) => l.trim() !== "");
    message = last ? last.trim() : "The template failed to render.";
  }

  let line: number | null = null;
  const fromTemplate = [...raw.matchAll(/File "<template>", line (\d+)/g)];
  if (fromTemplate.length) {
    line = Number(fromTemplate[fromTemplate.length - 1]![1]);
  } else {
    const fromUnknown = [...raw.matchAll(/File "<unknown>", line (\d+), in template/g)];
    if (fromUnknown.length) line = Number(fromUnknown[fromUnknown.length - 1]![1]);
  }
  if (line === null) {
    const inMsg = message.match(/line (\d+)/i);
    if (inMsg) line = Number(inMsg[1]);
  }

  return { errorType, message, line };
}

/* ------------------------------------------------------------------ */
/* headless entry point                                                */
/* ------------------------------------------------------------------ */

/**
 * The headless run. Real rendering needs Pyodide, which is browser-only, so
 * this returns a preview of the parsed sample state and the functions the
 * engine will stub. It still exercises the parsing and code-generation logic.
 */
export function run(input: string, opts: JinjaOptions = {}): Record<string, string> {
  const template = typeof input === "string" ? input : "";
  const states = parseStatesInput(typeof opts.state === "string" ? opts.state : "");
  const ids = Object.keys(states);
  const summary = ids.length
    ? ids.map((id) => `${id} = ${states[id]!.state || "(empty)"}`).join("; ")
    : "no entities defined";

  return {
    engine:
      "This tool renders in your browser with real Python jinja2 (Pyodide). Load the engine on the tool page to render your template against the sample state.",
    template: template.trim() === "" ? "(empty template)" : template,
    entities: `${ids.length} parsed: ${summary}`,
    functions:
      "Stubbed over your sample state: states(), is_state(), state_attr(), is_state_attr(), has_value(), states.<domain>.<object>, now(), utcnow(), as_timestamp(), as_datetime(), timedelta, and the float, int, and timestamp_custom filters.",
  };
}

export default { run } satisfies ToolLogic<string, Record<string, string>, JinjaOptions>;
