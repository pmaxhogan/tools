// Second golden-vector harness: simulation families that need tick control,
// statistical sampling, or block-state readback. Families:
//   projectile - exact per-tick Pos/Motion for every projectile type, driven
//                one tick at a time with "tick freeze" + "tick step 1".
//                Versions without the tick commands fall back to reading the
//                gravity/drag constants out of the decompiled source.
//   villager   - statistical trade pools: N villagers per profession and
//                level, aggregated per distinct (buy, sell) pair.
//   growth     - crop growth per random tick: a large controlled grid, a
//                known number of ticks, then an age histogram per case.
//   redstone   - exact component timings (hopper cadence, repeater and
//                comparator delays, observer pulse, piston, dropper) measured
//                one stepped tick at a time. Source-derived on old versions.
// Output: mc-pipeline/vectors/<family>/<version>.json (committed).
// Usage: node mc-pipeline/07-harness-sim.mjs <versionId> [--slot=N] [family...]
import { readFileSync, readdirSync, existsSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT, VECTORS, WORK, ensureDir, sha1 } from "./lib/common.mjs";
import { startServer } from "./lib/server.mjs";

const id = process.argv[2];
let slot = 0;
const families = process.argv.slice(3).filter((a) => {
  const m = a.match(/^--slot=(\d+)$/);
  if (m) {
    slot = Number(m[1]);
    return false;
  }
  return true;
});
if (!id)
  throw new Error("usage: node mc-pipeline/07-harness-sim.mjs <id> [--slot=N] [family...]");
const wanted = (f) => !families.length || families.includes(f);
const log = (...a) => console.log(`[${id}]`, ...a);

// --------------------------------------------------------------- SNBT ------
/**
 * Tolerant SNBT reader. Handles both era shapes of every structure we read
 * (legacy {Count:3b,id:"..."} and modern {count:3,id:"..."}), nested
 * components, typed arrays and quoted keys. A regex cannot do this: villager
 * offers nest item components three deep and item ids contain braces-free but
 * quote-bearing text, so the whole family parses through here.
 */
export function parseSnbt(text) {
  const s = text;
  let i = 0;
  const ws = () => {
    while (i < s.length && /\s/.test(s[i])) i++;
  };
  const fail = (msg) => {
    throw new Error(`SNBT ${msg} at ${i}: ...${s.slice(Math.max(0, i - 30), i + 30)}...`);
  };
  function parseString() {
    const q = s[i++];
    let out = "";
    while (i < s.length) {
      const c = s[i++];
      if (c === "\\") {
        out += s[i++];
        continue;
      }
      if (c === q) return out;
      out += c;
    }
    fail("unterminated string");
  }
  function parseKey() {
    ws();
    if (s[i] === '"' || s[i] === "'") return parseString();
    const start = i;
    // A colon is never part of a bare key: the printer quotes any key that is
    // not [A-Za-z0-9._+-], so namespaced keys always arrive quoted.
    while (i < s.length && /[A-Za-z0-9_\-.+]/.test(s[i])) i++;
    if (i === start) fail("empty key");
    return s.slice(start, i);
  }
  function parseScalar() {
    const start = i;
    while (i < s.length && !",}]".includes(s[i])) i++;
    const raw = s.slice(start, i).trim();
    if (raw === "true") return true;
    if (raw === "false") return false;
    const m = raw.match(/^(-?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)[bBsSlLfFdD]?$/);
    if (m) return Number(m[1]);
    return raw;
  }
  function parseCompound() {
    i++;
    const out = {};
    ws();
    if (s[i] === "}") {
      i++;
      return out;
    }
    for (;;) {
      const k = parseKey();
      ws();
      if (s[i] !== ":") fail("expected :");
      i++;
      out[k] = parseValue();
      ws();
      if (s[i] === ",") {
        i++;
        ws();
        if (s[i] === "}") {
          i++;
          return out;
        }
        continue;
      }
      if (s[i] === "}") {
        i++;
        return out;
      }
      fail("expected , or }");
    }
  }
  function parseList() {
    i++;
    const out = [];
    ws();
    if (/^[BIL];/.test(s.slice(i, i + 2))) i += 2;
    ws();
    if (s[i] === "]") {
      i++;
      return out;
    }
    for (;;) {
      out.push(parseValue());
      ws();
      if (s[i] === ",") {
        i++;
        ws();
        if (s[i] === "]") {
          i++;
          return out;
        }
        continue;
      }
      if (s[i] === "]") {
        i++;
        return out;
      }
      fail("expected , or ]");
    }
  }
  function parseValue() {
    ws();
    const c = s[i];
    if (c === "{") return parseCompound();
    if (c === "[") return parseList();
    if (c === '"' || c === "'") return parseString();
    return parseScalar();
  }
  return parseValue();
}

/** First present key out of a list of era-dependent aliases. */
function pick(obj, keys) {
  if (!obj || typeof obj !== "object") return undefined;
  for (const k of keys) if (obj[k] !== undefined) return obj[k];
  return undefined;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------- server ------
const { rcon, stop } = await startServer(id, { slot });
log("server up");

let commandCount = 0;
async function cmd(text) {
  commandCount++;
  return rcon.cmd(text);
}

/** data get on entity/block, parsed. null when the path does not exist. */
async function getData(kind, target, path) {
  const res = await cmd(`data get ${kind} ${target}${path ? " " + path : ""}`);
  const j = res.indexOf(" data: ");
  if (j < 0) return null;
  try {
    return parseSnbt(res.slice(j + 7));
  } catch {
    return null;
  }
}

/** "Successfully filled N blocks" -> N. Missing/zero replies are 0. */
function fillCount(res) {
  const m = res.match(/(\d+)\s+block/i);
  if (m) return Number(m[1]);
  if (/no blocks/i.test(res)) return 0;
  throw new Error(`unrecognised fill reply: ${res}`);
}

async function gametime() {
  const res = await cmd("time query gametime");
  // Wording moved around ("The time is 42" then "The game time is 42 tick(s)"),
  // so take the last integer in the reply rather than anchoring to the end.
  const m = res.match(/(-?\d+)(?![\s\S]*\d)/);
  if (!m) throw new Error(`unrecognised "time query gametime" reply: ${res}`);
  return Number(m[1]);
}

// Gamerules were renamed to namespaced snake_case ids in the newest versions,
// and the rename is not mechanical (doMobSpawning became spawn_mobs,
// doDaylightCycle became advance_time). Every rule is therefore given both
// spellings and probed once; a rule that neither spelling sets is a hard
// error, because a silently ignored gamerule is exactly the kind of quiet
// wrong answer that corrupted an earlier vector run.
const GAMERULES = {
  randomTickSpeed: ["randomTickSpeed", "minecraft:random_tick_speed"],
  doMobSpawning: ["doMobSpawning", "minecraft:spawn_mobs"],
  doWeatherCycle: ["doWeatherCycle", "minecraft:advance_weather"],
  doDaylightCycle: ["doDaylightCycle", "minecraft:advance_time"],
  mobGriefing: ["mobGriefing", "minecraft:mob_griefing"],
  maxEntityCramming: ["maxEntityCramming", "minecraft:max_entity_cramming"],
  sendCommandFeedback: ["sendCommandFeedback", "minecraft:send_command_feedback"],
  commandBlockOutput: ["commandBlockOutput", "minecraft:command_block_output"],
};
const _ruleId = new Map();

async function setGamerule(rule, value) {
  const aliases = GAMERULES[rule];
  if (!aliases) throw new Error(`no alias list for gamerule ${rule}`);
  const ok = (res) => new RegExp(`set to: ${value}\\b`, "i").test(res);
  const cached = _ruleId.get(rule);
  if (cached) {
    const res = await cmd(`gamerule ${cached} ${value}`);
    if (!ok(res)) throw new Error(`failed to set gamerule ${cached} to ${value}: ${res}`);
    return cached;
  }
  for (const name of aliases) {
    const res = await cmd(`gamerule ${name} ${value}`);
    if (ok(res)) {
      _ruleId.set(rule, name);
      log(`gamerule ${rule} -> ${name}`);
      return name;
    }
  }
  throw new Error(`no spelling of gamerule ${rule} was accepted: tried ${aliases.join(", ")}`);
}

const setRandomTick = (n) => setGamerule("randomTickSpeed", n);

// Tick control. "tick step"/"tick sprint" return immediately and run
// asynchronously, so every wait polls the game clock rather than sleeping a
// guessed interval; reading entity data straight after a step silently
// returns pre-step values.
let _tickCmds;
async function tickCommandsAvailable() {
  if (_tickCmds !== undefined) return _tickCmds;
  const res = await cmd("tick query");
  if (/Unknown or incomplete command/i.test(res)) {
    _tickCmds = false;
  } else if (/tick rate|frozen|running|sprinting/i.test(res)) {
    _tickCmds = true;
  } else {
    throw new Error(`"tick query" gave an unrecognised reply, cannot classify: ${res}`);
  }
  log(`tick commands: ${_tickCmds ? "available" : "absent"}`);
  return _tickCmds;
}

async function freeze() {
  const res = await cmd("tick freeze");
  if (!/frozen/i.test(res)) throw new Error(`tick freeze failed: ${res}`);
}
async function unfreeze() {
  await cmd("tick unfreeze");
}

/** Advance exactly n ticks and confirm it by the game clock. */
async function advance(n) {
  const before = await gametime();
  const res = await cmd(n > 20 ? `tick sprint ${n}` : `tick step ${n}`);
  if (/Unable to|must be frozen/i.test(res)) throw new Error(`tick advance failed: ${res}`);
  const deadline = Date.now() + 300000;
  for (;;) {
    const now = await gametime();
    if (now - before >= n) {
      // The clock is bumped early in a tick, so give the rest of that tick
      // room to land before anything reads entity or block state back.
      await sleep(15);
      return now - before;
    }
    if (Date.now() > deadline) throw new Error(`tick advance of ${n} never completed`);
    await sleep(25);
  }
}

/** execute-if readback: exact block state test, with a loud parse. */
async function blockIs(pos, predicate) {
  const res = await cmd(`execute if block ${pos} ${predicate}`);
  if (/passed/i.test(res)) return true;
  if (/failed/i.test(res)) return false;
  throw new Error(`unrecognised "execute if block" reply: ${res}`);
}

async function entityExists(selector) {
  const res = await cmd(`execute if entity ${selector}`);
  if (/passed/i.test(res)) return true;
  if (/failed/i.test(res)) return false;
  throw new Error(`unrecognised "execute if entity" reply: ${res}`);
}

// -------------------------------------------------------------- output -----
const meta = {
  version: id,
  generated: new Date().toISOString(),
  serverJarSha1: sha1(readFileSync(join(WORK, id, "server.jar"))),
  method: "rcon-e2e",
};

function save(family, data, method) {
  const dir = ensureDir(join(VECTORS, family));
  const file = join(dir, `${id}.json`);
  writeFileSync(file, JSON.stringify({ ...meta, method: method ?? meta.method, ...data }, null, 1));
  log(`wrote vectors/${family}/${id}.json (${(statSync(file).size / 1024).toFixed(1)} KB)`);
}

// -------------------------------------------------------- source reading ---
// Only the numeric constants and the class they came from are recorded; no
// Java is transcribed into the repository.
let _srcIndex;
function srcIndex() {
  if (_srcIndex) return _srcIndex;
  const root = join(WORK, id, "src", "net", "minecraft");
  const map = new Map();
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith(".java") && !map.has(e.name)) map.set(e.name, p);
    }
  };
  if (existsSync(root)) walk(root);
  _srcIndex = map;
  return map;
}

function readClass(className) {
  const p = srcIndex().get(`${className}.java`);
  if (!p) throw new Error(`decompiled source for ${className} not found under work/${id}/src`);
  return readFileSync(p, "utf8");
}

/**
 * Read a constant out of decompiled source.
 *
 * Every extractor here collects ALL matches and requires them to agree on one
 * value. A first-match regex over a Java file is only ever correct by luck:
 * HopperBlockEntity calls setCooldown(0) to reset before it ever calls
 * setCooldown(8) with the real transfer cooldown, so taking the first match
 * recorded a transfer cadence of 0 ticks in a committed vector file.
 *
 * `zeroIsNoise` drops zero-valued matches first, for the reset-then-set shape.
 * The class the value came from is always carried along, because a subclass
 * can shadow a base class constant: ThrownTrident overrides getWaterInertia,
 * so reading it off AbstractArrow records the wrong number for tridents.
 *
 * Returns the universal source-constant shape: { value, class, note }.
 */
function constantIn(className, patterns, { group = 1, zeroIsNoise = false, note = null } = {}) {
  const text = readClass(className);
  const values = [];
  for (const re of [patterns].flat())
    for (const m of text.matchAll(new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g")))
      values.push(Number(m[group]));
  const kept = zeroIsNoise ? values.filter((v) => v !== 0) : values;
  const distinct = [...new Set(kept)];
  if (!distinct.length)
    throw new Error(`no constant pattern matched ${className} in ${id}`);
  if (distinct.length > 1)
    throw new Error(
      `ambiguous constant in ${className} for ${id}: patterns matched ${distinct.join(", ")}; ` +
        "refuse to guess which one the game uses",
    );
  return { value: distinct[0], class: className, note };
}

/** Same, across a chain of classes; the first class that defines it wins. */
function constantInChain(chain, patterns, opts = {}) {
  for (const className of chain) {
    if (!srcIndex().has(`${className}.java`)) continue;
    try {
      return constantIn(className, patterns, opts);
    } catch (e) {
      if (/ambiguous/.test(e.message)) throw e;
    }
  }
  throw new Error(`no class in ${chain.join(" -> ")} defines the constant in ${id}`);
}

// ------------------------------------------------------------ projectile ---
const PROJ_POS = { x: 0.5, y: 110, z: 0.5 };
const PROJ_TAG = "proj";
const PROJ_SEL = `@e[tag=${PROJ_TAG},limit=1]`;
const PROJ_TICKS = 12;
const PROJ_MOTIONS = [
  { name: "flat-fast", motion: [3.0, 0.0, 0.0] },
  { name: "angled", motion: [1.2, 0.8, -0.4] },
];
// Each logical projectile is tried against a list of candidate summon forms:
// entity ids and item NBT shapes moved between versions, so the working form
// is discovered rather than assumed.
const PROJ_TYPES = [
  { name: "arrow", candidates: [{ entity: "minecraft:arrow" }] },
  { name: "spectral_arrow", candidates: [{ entity: "minecraft:spectral_arrow" }] },
  { name: "trident", candidates: [{ entity: "minecraft:trident" }] },
  { name: "snowball", candidates: [{ entity: "minecraft:snowball" }] },
  { name: "egg", candidates: [{ entity: "minecraft:egg" }] },
  { name: "ender_pearl", candidates: [{ entity: "minecraft:ender_pearl" }] },
  { name: "experience_bottle", candidates: [{ entity: "minecraft:experience_bottle" }] },
  {
    name: "splash_potion",
    candidates: [
      { entity: "minecraft:splash_potion" },
      { entity: "minecraft:potion", nbt: 'Item:{id:"minecraft:splash_potion",count:1}' },
      { entity: "minecraft:potion", nbt: 'Item:{id:"minecraft:splash_potion",Count:1b}' },
      { entity: "minecraft:potion" },
    ],
  },
  { name: "fireball", candidates: [{ entity: "minecraft:fireball" }] },
  { name: "small_fireball", candidates: [{ entity: "minecraft:small_fireball" }] },
  {
    name: "firework_rocket",
    candidates: [
      { entity: "minecraft:firework_rocket", nbt: "LifeTime:400,Life:0" },
      { entity: "minecraft:firework_rocket" },
    ],
  },
];

function motionNbt(m) {
  return `Motion:[${m.map((v) => `${v}d`).join(",")}]`;
}

async function summonProjectile(cand, motion) {
  await cmd(`kill @e[tag=${PROJ_TAG}]`);
  const parts = [motionNbt(motion), `Tags:["${PROJ_TAG}"]`];
  if (cand.nbt) parts.push(cand.nbt);
  const res = await cmd(
    `summon ${cand.entity} ${PROJ_POS.x} ${PROJ_POS.y} ${PROJ_POS.z} {${parts.join(",")}}`,
  );
  if (!/Summoned/i.test(res)) return null;
  const nbt = await getData("entity", PROJ_SEL, "");
  if (!nbt || !Array.isArray(nbt.Pos)) return null;
  return nbt;
}

async function runProjectile() {
  if (!(await tickCommandsAvailable())) return runProjectileFromSource();

  await cmd("kill @e[type=!minecraft:player]");
  await setRandomTick(0);
  await freeze();

  // Fail-fast: a stepped tick must actually move a test arrow. A step that
  // silently no-ops would produce a whole file of stationary projectiles.
  const probe = await summonProjectile({ entity: "minecraft:arrow" }, [3.0, 0.0, 0.0]);
  if (!probe) throw new Error("projectile probe: could not summon a test arrow");
  const before = probe.Pos[0];
  await advance(1);
  const after = (await getData("entity", PROJ_SEL, "Pos"))?.[0];
  if (!(Math.abs(after - before - 3.0) < 1e-9))
    throw new Error(
      `projectile probe: one stepped tick moved the test arrow from ${before} to ${after}, expected +3.0`,
    );
  await cmd(`kill @e[tag=${PROJ_TAG}]`);

  const cases = [];
  const unavailable = [];
  for (const type of PROJ_TYPES) {
    let used = null;
    for (const mo of PROJ_MOTIONS) {
      let nbt = null;
      for (const cand of used ? [used] : type.candidates) {
        nbt = await summonProjectile(cand, mo.motion);
        if (nbt) {
          used = cand;
          break;
        }
      }
      if (!nbt) {
        unavailable.push(type.name);
        break;
      }
      // Fields that feed the motion integration but are not Pos/Motion: the
      // fireball family carries its own acceleration power, and rockets a
      // lifetime, both of which a reimplementation has to know about.
      const initial = {};
      for (const k of [
        "power",
        "acceleration_power",
        "accelerationPower",
        "LifeTime",
        "Life",
        "life",
        "NoGravity",
        "inGround",
      ])
        if (nbt[k] !== undefined) initial[k] = nbt[k];
      const series = [
        { tick: 0, pos: nbt.Pos, motion: nbt.Motion ?? mo.motion.slice() },
      ];
      let expiredAt = null;
      for (let t = 1; t <= PROJ_TICKS; t++) {
        await advance(1);
        const cur = await getData("entity", PROJ_SEL, "");
        if (!cur || !Array.isArray(cur.Pos)) {
          expiredAt = t;
          break;
        }
        series.push({ tick: t, pos: cur.Pos, motion: cur.Motion });
      }
      cases.push({
        type: type.name,
        entity: used.entity,
        summonNbt: used.nbt ?? null,
        launch: mo.name,
        origin: [PROJ_POS.x, PROJ_POS.y, PROJ_POS.z],
        motion: mo.motion,
        initialFields: initial,
        expiredAtTick: expiredAt,
        series,
      });
      log(`  projectile ${type.name}/${mo.name}: ${series.length - 1} ticks`);
    }
    await cmd(`kill @e[tag=${PROJ_TAG}]`);
  }
  await unfreeze();
  save("projectile", {
    note:
      "Exact per-tick Pos and Motion after summoning at origin with the given Motion, " +
      "advanced one tick at a time with tick freeze + tick step 1. Doubles are recorded " +
      "verbatim; tests must reproduce them exactly.",
    measured: true,
    ticksPerCase: PROJ_TICKS,
    unavailable: [...new Set(unavailable)],
    cases,
  });
}

// Source-constant mode for versions with no tick commands.
const ARROW_PAIR = /float\s+\S+\s*=\s*(\d+\.\d+)F;\s*\n\s*float\s+\S+\s*=\s*(\d+\.\d+)F;/;
const WATER_INERTIA = /getWaterInertia\(\)\s*\{\s*return\s+(\d+\.\d+)F;/;
const THROWABLE_DRAG = /=\s*(\d+\.\d+)F;\s*\n\s*\}\s*else\s*\{\s*\n\s*\S+\s*=\s*(\d+\.\d+)F;/;
const GRAVITY_METHOD = /getGravity\(\)\s*\{\s*return\s+(\d+\.\d+)F;/;
const INERTIA_METHOD = /getInertia\(\)\s*\{\s*return\s+(\d+\.\d+)F;/;

const ARROW_CONSTANTS = {
  drag: { re: ARROW_PAIR, group: 1 },
  gravity: { re: ARROW_PAIR, group: 2 },
  waterDrag: { re: WATER_INERTIA },
};
const THROWABLE_CONSTANTS = {
  drag: { re: THROWABLE_DRAG, group: 2 },
  gravity: { re: GRAVITY_METHOD },
  waterDrag: { re: THROWABLE_DRAG, group: 1 },
};
const HURTING_CONSTANTS = {
  drag: { re: INERTIA_METHOD },
  gravity: { literal: 0, note: "hurting projectiles fly with no gravity" },
};
const THROWABLE_CHAIN = ["ThrowableItemProjectile", "ThrowableProjectile"];

// Class chains run most derived first, because a subclass may shadow a base
// class constant: ThrownTrident overrides getWaterInertia, so reading that
// value off AbstractArrow would record the wrong number for tridents.
const PROJ_SOURCE = [
  { type: "arrow", chain: ["Arrow", "AbstractArrow"], constants: ARROW_CONSTANTS },
  { type: "spectral_arrow", chain: ["SpectralArrow", "AbstractArrow"], constants: ARROW_CONSTANTS },
  { type: "trident", chain: ["ThrownTrident", "AbstractArrow"], constants: ARROW_CONSTANTS },
  { type: "snowball", chain: ["Snowball", ...THROWABLE_CHAIN], constants: THROWABLE_CONSTANTS },
  { type: "egg", chain: ["ThrownEgg", ...THROWABLE_CHAIN], constants: THROWABLE_CONSTANTS },
  {
    type: "ender_pearl",
    chain: ["ThrownEnderpearl", ...THROWABLE_CHAIN],
    constants: THROWABLE_CONSTANTS,
  },
  {
    type: "experience_bottle",
    chain: ["ThrownExperienceBottle", ...THROWABLE_CHAIN],
    constants: THROWABLE_CONSTANTS,
  },
  {
    type: "splash_potion",
    chain: ["ThrownPotion", ...THROWABLE_CHAIN],
    constants: THROWABLE_CONSTANTS,
  },
  {
    type: "fireball",
    chain: ["LargeFireball", "Fireball", "AbstractHurtingProjectile"],
    constants: HURTING_CONSTANTS,
  },
  {
    type: "small_fireball",
    chain: ["SmallFireball", "Fireball", "AbstractHurtingProjectile"],
    constants: HURTING_CONSTANTS,
  },
  {
    type: "firework_rocket",
    chain: ["FireworkRocketEntity"],
    constants: {
      speedMultiplier: { re: /horizontalCollision\s*\?\s*1\.0\s*:\s*(\d+\.\d+);/ },
    },
  },
];

/** Resolve one projectile constant against the class chain. */
function resolveConstant(chain, spec) {
  if (spec.literal !== undefined)
    return { value: spec.literal, class: chain[chain.length - 1], note: spec.note ?? null };
  return constantInChain(chain, spec.re, { group: spec.group ?? 1, note: spec.note ?? null });
}

/** Drag and gravity implied by an already-generated modern vector file. */
function modernProjectileConstants() {
  const dir = join(VECTORS, "projectile");
  if (!existsSync(dir)) return {};
  const out = {};
  for (const file of readdirSync(dir)) {
    let data;
    try {
      data = JSON.parse(readFileSync(join(dir, file), "utf8"));
    } catch {
      continue;
    }
    if (data.method !== "rcon-e2e" || !Array.isArray(data.cases)) continue;
    for (const c of data.cases) {
      if (c.launch !== "flat-fast" || c.series.length < 3) continue;
      const m0 = c.series[0].motion;
      const m1 = c.series[1].motion;
      if (!m0 || !m1 || !m0[0]) continue;
      const drag = m1[0] / m0[0];
      const gravity = m0[1] * drag - m1[1];
      (out[c.type] ??= []).push({ version: data.version, drag, gravity });
    }
  }
  return out;
}

function runProjectileFromSource() {
  const modern = modernProjectileConstants();
  const close = (a, b) => Number.isFinite(a) && Number.isFinite(b) && Math.abs(a - b) < 1e-9;
  const entries = [];
  for (const group of PROJ_SOURCE) {
    const constants = {};
    for (const [name, spec] of Object.entries(group.constants))
      constants[name] = resolveConstant(group.chain, spec);
    const ref = (modern[group.type] ?? [])[0] ?? null;
    let matches = null;
    // A source literal is either a Java float, which reaches the measured
    // value only after the float-to-double widening, or already a double.
    // The regexes capture the digits without the suffix that tells them
    // apart, so either reading counts as a match.
    const same = (v, measured) => close(v, measured) || close(Math.fround(v), measured);
    if (ref && !constants.drag && constants.speedMultiplier) {
      // A rocket has no drag: the measured per-tick ratio is its speed-up.
      matches = same(constants.speedMultiplier.value, ref.drag);
    } else if (ref && constants.drag) {
      matches =
        same(constants.drag.value, ref.drag) && same(constants.gravity?.value ?? 0, ref.gravity);
    }
    entries.push({
      type: group.type,
      classChain: group.chain,
      constants,
      modernReference: ref
        ? { fromVersion: ref.version, drag: ref.drag, gravity: ref.gravity }
        : null,
      matchesModern: matches,
    });
  }
  save(
    "projectile",
    {
      note:
        "This version has no tick freeze/step commands, so per-tick vectors cannot be " +
        "measured over RCON. Each constant below was read out of the decompiled source of " +
        "the first class in the projectile's class chain that defines it, and the class it " +
        "came from is recorded next to the value, so a subclass override such as the " +
        "trident's own water drag is not shadowed by the base class. The values are " +
        "compared against the constants implied by the measured modern vectors.",
      measured: false,
      sourceConstants: entries,
    },
    "source-derived",
  );
}

// -------------------------------------------------------------- villager ---
const VILLAGER_N = 200;
const VILLAGER_BATCH = 50;
const VILLAGER_PROBE = 5;
const VIL_POS = { x: 0.5, y: 110, z: 0.5 };

function villagerProfessions() {
  const file = join(ROOT, "extracted", id, "registries.json");
  const reg = JSON.parse(readFileSync(file, "utf8"));
  const list = reg.villager_profession;
  if (!Array.isArray(list) || !list.length)
    throw new Error(`no villager_profession registry in extracted/${id}/registries.json`);
  return list;
}

function villagerNbt(profession, level, tags, extra, { withAi = false } = {}) {
  const parts = [
    `VillagerData:{profession:"minecraft:${profession}",level:${level},type:"minecraft:plains"}`,
    ...(withAi ? [] : ["NoAI:1b", "NoGravity:1b"]),
    "Silent:1b",
    "Invulnerable:1b",
    "PersistenceRequired:1b",
    `Tags:[${tags.map((t) => `"${t}"`).join(",")}]`,
  ];
  if (extra) parts.push(extra);
  return `{${parts.join(",")}}`;
}

function itemOf(raw) {
  if (!raw || typeof raw !== "object") return null;
  const itemId = pick(raw, ["id", "item"]);
  if (typeof itemId !== "string" || itemId === "minecraft:air") return null;
  const count = pick(raw, ["count", "Count"]) ?? 1;
  return { id: itemId, count: Number(count), detail: itemDetail(raw) };
}

/** Stable extra identity for items whose trade pool varies inside one id. */
function itemDetail(raw) {
  const bits = [];
  const tag = raw.tag ?? {};
  if (Array.isArray(tag.StoredEnchantments))
    for (const e of tag.StoredEnchantments) bits.push(`${e.id}=${e.lvl}`);
  if (typeof tag.Potion === "string") bits.push(`potion=${tag.Potion}`);
  const comp = raw.components ?? {};
  let se = comp["minecraft:stored_enchantments"];
  if (se && typeof se === "object" && se.levels) se = se.levels;
  if (se && typeof se === "object")
    for (const [k, v] of Object.entries(se)) bits.push(`${k}=${v}`);
  const pc = comp["minecraft:potion_contents"];
  if (pc) bits.push(`potion=${typeof pc === "string" ? pc : (pc.potion ?? "custom")}`);
  return bits.sort().join("+") || null;
}

function recipeParts(raw) {
  const buy = itemOf(pick(raw, ["buy", "buyA", "baseCostA", "first_cost"]));
  const buyB = itemOf(pick(raw, ["buyB", "second_cost", "costB"]));
  const sell = itemOf(pick(raw, ["sell", "result"]));
  if (!buy || !sell)
    throw new Error(
      `unrecognised merchant offer shape, cannot find buy/sell: ${JSON.stringify(raw).slice(0, 400)}`,
    );
  return {
    buy,
    buyB,
    sell,
    xp: pick(raw, ["xp", "experience"]) ?? null,
    priceMultiplier: pick(raw, ["priceMultiplier", "price_multiplier"]) ?? null,
    maxUses: pick(raw, ["maxUses", "max_uses"]) ?? null,
    rewardExp: pick(raw, ["rewardExp", "reward_exp"]) ?? null,
    demand: pick(raw, ["demand"]) ?? null,
    specialPrice: pick(raw, ["specialPrice", "special_price"]) ?? null,
  };
}

function tradeKey(p) {
  const side = (it) => (it ? `${it.id}${it.detail ? `[${it.detail}]` : ""}` : "");
  return `${side(p.buy)}${p.buyB ? ` + ${side(p.buyB)}` : ""} => ${side(p.sell)}`;
}

// Newer versions stopped generating offers when the entity is serialised:
// AbstractVillager only writes Offers when they already exist, and the only
// server-side path that builds them is a villager restocking at its job site.
// The block each profession claims, used only by that fallback.
const JOB_SITES = {
  armorer: "blast_furnace",
  butcher: "smoker",
  cartographer: "cartography_table",
  cleric: "brewing_stand",
  farmer: "composter",
  fisherman: "barrel",
  fletcher: "fletching_table",
  leatherworker: "cauldron",
  librarian: "lectern",
  mason: "stonecutter",
  shepherd: "loom",
  toolsmith: "smithing_table",
  weaponsmith: "grindstone",
};
const JOB_TICKS = 600;
const JOB_ROUNDS = 4;
const JOB_Y = 100;
const JOB_DAYTIME = 3000;
let offerMode = "eager";
let jobSiteDropped = 0;

// An open floor with the job site blocks spaced three apart. Sealing each
// villager into its own pocket was tried and stopped job site acquisition
// completely, so they are left room to path the one block to their block.
async function buildVillagerBench(size) {
  const maxX = size * 3 + 2;
  await cmd(`fill 0 ${JOB_Y - 1} -2 ${maxX} ${JOB_Y - 1} 4 minecraft:stone`);
  await cmd(`fill 0 ${JOB_Y} -2 ${maxX} ${JOB_Y + 4} 4 minecraft:air`);
}

/** Summon a batch of villagers, read each one's offers, return raw lists. */
async function sampleOffers(profession, level, n) {
  if (offerMode === "job-site") return sampleOffersAtJobSites(profession, level, n);
  const out = [];
  for (let base = 0; base < n; base += VILLAGER_BATCH) {
    const size = Math.min(VILLAGER_BATCH, n - base);
    await cmd("kill @e[tag=vil]");
    for (let k = 0; k < size; k++)
      await cmd(
        `summon minecraft:villager ${VIL_POS.x} ${VIL_POS.y} ${VIL_POS.z} ` +
          villagerNbt(profession, level, ["vil", `vil${k}`]),
      );
    for (let k = 0; k < size; k++) {
      const recipes = await getData("entity", `@e[tag=vil${k},limit=1]`, "Offers.Recipes");
      out.push(Array.isArray(recipes) ? recipes : []);
    }
  }
  await cmd("kill @e[tag=vil]");
  return out;
}

async function sampleOffersAtJobSites(profession, level, n) {
  const site = JOB_SITES[profession];
  if (!site) {
    if (!["none", "nitwit"].includes(profession))
      throw new Error(
        `no job site block known for profession ${profession}; it would be silently recorded ` +
          "as having no trades",
      );
    return Array.from({ length: n }, () => []);
  }
  const spawn = async (k) => {
    await cmd(`kill @e[tag=vil${k}]`);
    // Break the block before re-placing it: reusing the same job site block
    // leaves the point of interest holding the ticket the previous villager
    // claimed, and the replacement never gets to work at it.
    await cmd(`setblock ${k * 3} ${JOB_Y} 0 minecraft:air`);
    await cmd(`setblock ${k * 3} ${JOB_Y} 0 minecraft:${site}`);
    await cmd(
      `summon minecraft:villager ${k * 3 + 0.5} ${JOB_Y} 1.5 ` +
        villagerNbt(profession, level, ["vil", `vil${k}`], null, { withAi: true }),
    );
  };
  const out = [];
  for (let base = 0; base < n; base += VILLAGER_BATCH) {
    const size = Math.min(VILLAGER_BATCH, n - base);
    await cmd("kill @e[tag=vil]");
    // Villagers only restock during the work part of their schedule, and the
    // sprinted ticks add up: without pinning the time back, sampling walks the
    // clock out of the work window and every later villager silently fails.
    await cmd(`time set ${JOB_DAYTIME}`);
    for (let k = 0; k < size; k++) await spawn(k);
    let recipes = new Array(size).fill(null);
    for (let round = 0; round < JOB_ROUNDS; round++) {
      await advance(JOB_TICKS);
      for (let k = 0; k < size; k++) {
        if (recipes[k]) continue;
        recipes[k] = await getData("entity", `@e[tag=vil${k},limit=1]`, "Offers.Recipes");
      }
      const stragglers = recipes.map((r, k) => [r, k]).filter(([r]) => !Array.isArray(r));
      if (!stragglers.length) break;
      // A villager that has not restocked yet gets replaced rather than
      // waited on forever: POI acquisition occasionally does not take.
      if (round >= 1) for (const [, k] of stragglers) await spawn(k);
    }
    const dropped = recipes.filter((r) => !Array.isArray(r)).length;
    if (dropped > Math.max(2, size * 0.05))
      throw new Error(
        `${dropped} of ${size} ${profession} L${level} villagers never restocked at their job ` +
          `site after ${JOB_ROUNDS * JOB_TICKS} ticks`,
      );
    if (dropped) {
      jobSiteDropped += dropped;
      log(`    ${profession} L${level}: dropped ${dropped} villagers that never restocked`);
    }
    // A villager that lost or changed its profession at the job site would
    // silently produce the wrong pool, so confirm one per batch.
    const vd = await getData("entity", "@e[tag=vil0,limit=1]", "VillagerData");
    if (!vd || Number(vd.level) !== level || !String(vd.profession).includes(profession))
      throw new Error(
        `job site sampling changed the villager: wanted ${profession} L${level}, got ` +
          JSON.stringify(vd),
      );
    out.push(...recipes.filter((r) => Array.isArray(r)));
  }
  await cmd("kill @e[tag=vil]");
  return out;
}

function aggregate(samples) {
  const trades = new Map();
  const perVillager = {};
  for (const recipes of samples) {
    perVillager[recipes.length] = (perVillager[recipes.length] ?? 0) + 1;
    const seen = new Set();
    for (const raw of recipes) {
      const p = recipeParts(raw);
      const key = tradeKey(p);
      let t = trades.get(key);
      if (!t) {
        t = {
          key,
          buy: { id: p.buy.id, detail: p.buy.detail, countMin: Infinity, countMax: -Infinity },
          buyB: p.buyB
            ? { id: p.buyB.id, detail: p.buyB.detail, countMin: Infinity, countMax: -Infinity }
            : null,
          sell: { id: p.sell.id, detail: p.sell.detail, countMin: Infinity, countMax: -Infinity },
          xp: new Set(),
          priceMultiplier: new Set(),
          maxUses: new Set(),
          offers: 0,
          offeredBy: 0,
        };
        trades.set(key, t);
      }
      t.buy.countMin = Math.min(t.buy.countMin, p.buy.count);
      t.buy.countMax = Math.max(t.buy.countMax, p.buy.count);
      if (t.buyB && p.buyB) {
        t.buyB.countMin = Math.min(t.buyB.countMin, p.buyB.count);
        t.buyB.countMax = Math.max(t.buyB.countMax, p.buyB.count);
      }
      t.sell.countMin = Math.min(t.sell.countMin, p.sell.count);
      t.sell.countMax = Math.max(t.sell.countMax, p.sell.count);
      if (p.xp !== null) t.xp.add(p.xp);
      if (p.priceMultiplier !== null) t.priceMultiplier.add(p.priceMultiplier);
      if (p.maxUses !== null) t.maxUses.add(p.maxUses);
      t.offers++;
      if (!seen.has(key)) {
        seen.add(key);
        t.offeredBy++;
      }
    }
  }
  const list = [...trades.values()]
    .map((t) => ({
      ...t,
      xp: [...t.xp].sort((a, b) => a - b),
      priceMultiplier: [...t.priceMultiplier].sort((a, b) => a - b),
      maxUses: [...t.maxUses].sort((a, b) => a - b),
    }))
    .sort((a, b) => b.offeredBy - a.offeredBy || a.key.localeCompare(b.key));
  return { recipesPerVillager: perVillager, trades: list };
}

async function runVillager() {
  await cmd("kill @e[type=!minecraft:player]");
  await setRandomTick(0);
  // Batches stack 50 villagers on one block; cramming would cull them on the
  // versions that cannot be frozen.
  await setGamerule("maxEntityCramming", 0);
  if (await tickCommandsAvailable()) await freeze();

  // Fail-fast: a freshly summoned farmer must yield at least one recipe, and
  // the VillagerData we asked for must actually be what the entity carries.
  await cmd(
    `summon minecraft:villager ${VIL_POS.x} ${VIL_POS.y} ${VIL_POS.z} ` +
      villagerNbt("farmer", 2, ["vil", "vil0"]),
  );
  const vd = await getData("entity", "@e[tag=vil0,limit=1]", "VillagerData");
  if (!vd || Number(vd.level) !== 2 || !String(vd.profession).includes("farmer"))
    throw new Error(
      `villager probe: VillagerData did not round trip, got ${JSON.stringify(vd)}`,
    );
  let probeRecipes = await getData("entity", "@e[tag=vil0,limit=1]", "Offers.Recipes");
  await cmd("kill @e[tag=vil]");
  if (!Array.isArray(probeRecipes) || probeRecipes.length < 1) {
    // Newer versions no longer build offers when the entity is written out, so
    // fall back to letting villagers restock at a real job site. Probed, never
    // selected by version number.
    if (!(await tickCommandsAvailable()))
      throw new Error(
        "villager probe: a fresh farmer produced no offers and this version has no tick " +
          "commands, so the job site fallback would take hours of real time",
      );
    offerMode = "job-site";
    await buildVillagerBench(VILLAGER_BATCH);
    await setGamerule("doDaylightCycle", false);
    await cmd(`time set ${JOB_DAYTIME}`);
    log("  offers are not generated on serialisation, sampling at real job sites instead");
    probeRecipes = (await sampleOffers("farmer", 2, 1))[0];
    if (!Array.isArray(probeRecipes) || probeRecipes.length < 1)
      throw new Error("villager probe: a farmer produced no offers even at a job site");
  }
  const sampleRawRecipe = probeRecipes[0];
  recipeParts(sampleRawRecipe); // throws if the offer shape is unrecognised
  await cmd("kill @e[tag=vil]");

  // Gossips written through summon NBT: does the round trip survive?
  await cmd(
    `summon minecraft:villager ${VIL_POS.x} ${VIL_POS.y} ${VIL_POS.z} ` +
      villagerNbt("farmer", 1, ["vil", "gossip"],
        'Gossips:[{Type:"major_positive",Value:20,Target:[I;1,2,3,4]},' +
          '{Type:"minor_negative",Value:5,Target:[I;1,2,3,4]}]'),
  );
  const gossips = await getData("entity", "@e[tag=gossip,limit=1]", "Gossips");
  await cmd("kill @e[tag=vil]");
  const gossipRoundTrip = {
    written: 2,
    readBack: Array.isArray(gossips) ? gossips.length : 0,
    survives: Array.isArray(gossips) && gossips.length === 2,
    value: gossips ?? null,
  };
  log(`  gossips survive summon round trip: ${gossipRoundTrip.survives}`);

  const professions = {};
  const noTrades = [];
  const t0 = Date.now();
  for (const profession of villagerProfessions()) {
    const levels = {};
    let any = false;
    for (let level = 1; level <= 5; level++) {
      const probe = await sampleOffers(profession, level, VILLAGER_PROBE);
      if (!probe.length)
        throw new Error(`villager probe for ${profession} L${level} returned no samples at all`);
      if (probe.every((r) => r.length === 0)) {
        levels[level] = { samples: VILLAGER_PROBE, recipesPerVillager: { 0: VILLAGER_PROBE }, trades: [] };
        continue;
      }
      any = true;
      const samples = await sampleOffers(profession, level, VILLAGER_N);
      levels[level] = { samples: samples.length, ...aggregate(samples) };
      log(
        `  villager ${profession} L${level}: ${levels[level].trades.length} distinct trades ` +
          `(${((Date.now() - t0) / 60000).toFixed(1)} min elapsed)`,
      );
    }
    if (!any) noTrades.push(profession);
    professions[profession] = levels;
  }
  if (await tickCommandsAvailable()) await unfreeze();

  save("villager", {
    note:
      "Trade pools sampled statistically: N villagers summoned per profession and level, " +
      "their generated Offers.Recipes aggregated per distinct (buy, sell) pair. offeredBy " +
      "is how many of the N sampled villagers carried that pair. Levels with no trades were " +
      "confirmed with a short probe instead of a full sample. An empty xp, priceMultiplier or " +
      "maxUses array means the field was absent from every sampled offer, which is the game " +
      "writing its default rather than a measurement gap.",
    measured: true,
    samplesPerCell: VILLAGER_N,
    probeSamples: VILLAGER_PROBE,
    offerGeneration: offerMode,
    jobSiteDroppedSamples: jobSiteDropped,
    offerGenerationNote:
      offerMode === "eager"
        ? "offers are generated when the villager is serialised, so a summoned villager can be read straight away"
        : "offers are only generated when a villager restocks at its job site, so each sample " +
          `stood next to its profession's job block for up to ${JOB_ROUNDS * JOB_TICKS} ticks`,
    professionsWithoutTrades: noTrades,
    gossipRoundTrip,
    sampleRawRecipe,
    professions,
  });
}

// ---------------------------------------------------------------- growth ---
// Arena spans a 32x32 soil plane centred on the origin. Every case rebuilds
// it from scratch, so no case can be contaminated by the previous layout.
const G = { x0: -16, x1: 15, z0: -16, z1: 15, yFloor: 99, ySoil: 100, yCrop: 101 };
const RANDOM_TICK_SPEED = 100;

async function clearArena() {
  await cmd(`fill ${G.x0} ${G.yCrop} ${G.z0} ${G.x1} ${G.yCrop + 19} ${G.z1} minecraft:air`);
  await cmd(`fill ${G.x0} ${G.yFloor} ${G.z0} ${G.x1} ${G.yFloor} ${G.z1} minecraft:stone`);
  await cmd(`fill ${G.x0} ${G.ySoil} ${G.z0} ${G.x1} ${G.ySoil} ${G.z1} minecraft:dirt`);
}

/** Double a seed tile across the arena with clone, which is 6 commands for
 *  a 32x32 field instead of a thousand setblocks. */
async function tile(tileW, tileD) {
  const y0 = G.ySoil;
  const y1 = G.yCrop;
  const W = G.x1 - G.x0 + 1;
  const D = G.z1 - G.z0 + 1;
  let w = tileW;
  while (w < W) {
    const n = Math.min(w, W - w);
    await cmd(
      `clone ${G.x0} ${y0} ${G.z0} ${G.x0 + n - 1} ${y1} ${G.z0 + tileD - 1} ` +
        `${G.x0 + w} ${y0} ${G.z0}`,
    );
    w += n;
  }
  let d = tileD;
  while (d < D) {
    const n = Math.min(d, D - d);
    await cmd(
      `clone ${G.x0} ${y0} ${G.z0} ${G.x1} ${y1} ${G.z0 + n - 1} ${G.x0} ${y0} ${G.z0 + d}`,
    );
    d += n;
  }
}

const soil = (dx, dz, block) => `setblock ${G.x0 + dx} ${G.ySoil} ${G.z0 + dz} ${block}`;
const plant = (dx, dz, block) => `setblock ${G.x0 + dx} ${G.yCrop} ${G.z0 + dz} ${block}`;

/**
 * Growth cases. Every case states the growth-speed inputs it isolates so the
 * tool's test can compute the expected per-random-tick chance:
 *   f = 1 + (centre farmland ? (wet ? 3 : 1) : 0)
 *         + sum over the 8 neighbouring soil cells of (farmland ? (wet?3:1)/4 : 0)
 *   halved when the same crop is adjacent on both axes, or on a diagonal
 *   chance = 1 / (floor(25 / f) + 1)
 */
const GROWTH_CASES = [
  {
    name: "wheat-isolated-hydrated",
    crop: "minecraft:wheat",
    countBlock: "minecraft:wheat",
    maxAge: 7,
    ticks: 400,
    expected: 256,
    growthSpeed: 4,
    layout: {
      description:
        "crops every 2 blocks, farmland only under each crop, water column every 8 blocks in x",
    },
    build: async () => {
      // 8 x 2 seed tile: four spaced crops, one water column.
      for (const dx of [0, 2, 4, 6]) {
        await cmd(soil(dx, 0, "minecraft:farmland[moisture=7]"));
        await cmd(plant(dx, 0, "minecraft:wheat[age=0]"));
      }
      await cmd(soil(7, 0, "minecraft:water"));
      await cmd(soil(7, 1, "minecraft:water"));
      await tile(8, 2);
    },
  },
  {
    name: "wheat-isolated-dry",
    crop: "minecraft:wheat",
    countBlock: "minecraft:wheat",
    maxAge: 7,
    ticks: 400,
    expected: 256,
    growthSpeed: 2,
    layout: { description: "crops every 2 blocks on dry farmland, no water in the arena" },
    build: async () => {
      await cmd(soil(0, 0, "minecraft:farmland[moisture=0]"));
      await cmd(plant(0, 0, "minecraft:wheat[age=0]"));
      await tile(2, 2);
    },
  },
  {
    name: "wheat-row-hydrated",
    crop: "minecraft:wheat",
    countBlock: "minecraft:wheat",
    maxAge: 7,
    ticks: 400,
    expected: 512,
    growthSpeed: 5.5,
    layout: {
      description:
        "continuous rows along x, rows two apart in z, hydrated; each crop has farmland east " +
        "and west but not north or south, and no same-crop neighbour on the z axis",
    },
    build: async () => {
      for (const dz of [0, 2, 4, 6]) {
        await cmd(soil(0, dz, "minecraft:farmland[moisture=7]"));
        await cmd(plant(0, dz, "minecraft:wheat[age=0]"));
      }
      await cmd(soil(0, 1, "minecraft:water"));
      await tile(1, 8);
    },
  },
  {
    name: "wheat-row-dry",
    crop: "minecraft:wheat",
    countBlock: "minecraft:wheat",
    maxAge: 7,
    ticks: 400,
    expected: 512,
    growthSpeed: 2.5,
    layout: { description: "continuous rows along x, rows two apart in z, dry farmland" },
    build: async () => {
      await cmd(soil(0, 0, "minecraft:farmland[moisture=0]"));
      await cmd(plant(0, 0, "minecraft:wheat[age=0]"));
      await tile(1, 2);
    },
  },
  {
    name: "wheat-field-hydrated",
    crop: "minecraft:wheat",
    countBlock: "minecraft:wheat",
    maxAge: 7,
    ticks: 400,
    expected: 5 * 30,
    growthSpeed: 5,
    // Only the interior is counted: edge columns border the water channel and
    // edge rows border bare dirt, so their growth speed differs.
    count: { x0: -2, x1: 2, z0: -15, z1: 14 },
    layout: {
      description:
        "solid 7-wide hydrated field with water channels either side; counted interior has " +
        "full farmland below and the same crop on both axes, so the speed is halved",
    },
    build: async () => {
      await cmd(`fill -3 ${G.ySoil} ${G.z0} 3 ${G.ySoil} ${G.z1} minecraft:farmland[moisture=7]`);
      await cmd(`fill -3 ${G.yCrop} ${G.z0} 3 ${G.yCrop} ${G.z1} minecraft:wheat[age=0]`);
      await cmd(`fill -4 ${G.ySoil} ${G.z0} -4 ${G.ySoil} ${G.z1} minecraft:water`);
      await cmd(`fill 4 ${G.ySoil} ${G.z0} 4 ${G.ySoil} ${G.z1} minecraft:water`);
    },
  },
  {
    name: "carrots-isolated-hydrated",
    crop: "minecraft:carrots",
    countBlock: "minecraft:carrots",
    maxAge: 7,
    ticks: 400,
    expected: 256,
    growthSpeed: 4,
    layout: { description: "crops every 2 blocks, hydrated farmland only under each crop" },
    build: async () => {
      for (const dx of [0, 2, 4, 6]) {
        await cmd(soil(dx, 0, "minecraft:farmland[moisture=7]"));
        await cmd(plant(dx, 0, "minecraft:carrots[age=0]"));
      }
      await cmd(soil(7, 0, "minecraft:water"));
      await cmd(soil(7, 1, "minecraft:water"));
      await tile(8, 2);
    },
  },
  {
    name: "potatoes-isolated-hydrated",
    crop: "minecraft:potatoes",
    countBlock: "minecraft:potatoes",
    maxAge: 7,
    ticks: 400,
    expected: 256,
    growthSpeed: 4,
    layout: { description: "crops every 2 blocks, hydrated farmland only under each crop" },
    build: async () => {
      for (const dx of [0, 2, 4, 6]) {
        await cmd(soil(dx, 0, "minecraft:farmland[moisture=7]"));
        await cmd(plant(dx, 0, "minecraft:potatoes[age=0]"));
      }
      await cmd(soil(7, 0, "minecraft:water"));
      await cmd(soil(7, 1, "minecraft:water"));
      await tile(8, 2);
    },
  },
  {
    name: "beetroots-isolated-hydrated",
    crop: "minecraft:beetroots",
    countBlock: "minecraft:beetroots",
    maxAge: 3,
    ticks: 200,
    expected: 256,
    growthSpeed: 4,
    layout: {
      description:
        "crops every 2 blocks, hydrated farmland only under each crop; fewer ticks because " +
        "beetroot tops out at age 3",
    },
    caveat:
      "measured growth is about two thirds of what the shared farmland speed formula predicts: " +
      "beetroot gates its random tick behind an extra one-in-three roll",
    build: async () => {
      for (const dx of [0, 2, 4, 6]) {
        await cmd(soil(dx, 0, "minecraft:farmland[moisture=7]"));
        await cmd(plant(dx, 0, "minecraft:beetroots[age=0]"));
      }
      await cmd(soil(7, 0, "minecraft:water"));
      await cmd(soil(7, 1, "minecraft:water"));
      await tile(8, 2);
    },
  },
  {
    name: "nether_wart-soul-sand",
    crop: "minecraft:nether_wart",
    countBlock: "minecraft:nether_wart",
    maxAge: 3,
    ticks: 300,
    expected: 32 * 32,
    growthSpeed: null,
    layout: {
      description:
        "solid field of nether wart on soul sand; nether wart ignores light, moisture and " +
        "neighbours, so the whole plane is one homogeneous sample",
    },
    build: async () => {
      await cmd(
        `fill ${G.x0} ${G.ySoil} ${G.z0} ${G.x1} ${G.ySoil} ${G.z1} minecraft:soul_sand`,
      );
      await cmd(
        `fill ${G.x0} ${G.yCrop} ${G.z0} ${G.x1} ${G.yCrop} ${G.z1} minecraft:nether_wart[age=0]`,
      );
    },
  },
  {
    name: "sugar_cane",
    crop: "minecraft:sugar_cane",
    countBlock: "minecraft:sugar_cane",
    maxAge: 15,
    ticks: 256,
    expected: 256,
    growthSpeed: null,
    layout: {
      description:
        "one cane every 2 blocks on sand beside a sealed water cell; the age property counts " +
        "random ticks received exactly, so this doubles as a random tick rate calibration",
    },
    build: async () => {
      await cmd(soil(0, 0, "minecraft:sand"));
      await cmd(plant(0, 0, "minecraft:sugar_cane[age=0]"));
      await cmd(soil(1, 0, "minecraft:water"));
      await tile(2, 2);
    },
    extra: async () => ({
      grownAbove: fillCount(
        await cmd(
          `fill ${G.x0} ${G.yCrop + 1} ${G.z0} ${G.x1} ${G.yCrop + 3} ${G.z1} ` +
            "minecraft:air replace minecraft:sugar_cane",
        ),
      ),
    }),
  },
  {
    name: "cactus",
    crop: "minecraft:cactus",
    countBlock: "minecraft:cactus",
    maxAge: 15,
    ticks: 256,
    expected: 256,
    growthSpeed: null,
    layout: {
      description:
        "one cactus every 2 blocks on sand with no solid horizontal neighbour; age counts " +
        "random ticks received exactly",
    },
    build: async () => {
      await cmd(soil(0, 0, "minecraft:sand"));
      await cmd(plant(0, 0, "minecraft:cactus[age=0]"));
      await tile(2, 2);
    },
    extra: async () => ({
      grownAbove: fillCount(
        await cmd(
          `fill ${G.x0} ${G.yCrop + 1} ${G.z0} ${G.x1} ${G.yCrop + 3} ${G.z1} ` +
            "minecraft:air replace minecraft:cactus",
        ),
      ),
    }),
  },
  {
    name: "bamboo",
    crop: "minecraft:bamboo",
    countBlock: null, // bamboo carries no random-tick counter; count total blocks
    maxAge: null,
    ticks: 256,
    expected: 256,
    growthSpeed: null,
    layout: {
      description:
        "one bamboo every 2 blocks on dirt; bamboo has no age counter that survives growth, " +
        "so the measurement is the total block count after the tick window",
    },
    build: async () => {
      await cmd(plant(0, 0, "minecraft:bamboo[age=0,leaves=none,stage=0]"));
      await tile(2, 2);
    },
    totalOnly: true,
  },
];

async function runGrowthCase(c, sprint) {
  await clearArena();
  await setRandomTick(0);
  await c.build();

  const t0 = await gametime();
  await setRandomTick(RANDOM_TICK_SPEED);
  if (sprint) await advance(c.ticks);
  else await sleep(c.ticks * 50);
  await setRandomTick(0);
  const t1 = await gametime();

  const region = c.count ?? { x0: G.x0, x1: G.x1, z0: G.z0, z1: G.z1 };
  const box = (y0, y1) =>
    `${region.x0} ${y0} ${region.z0} ${region.x1} ${y1} ${region.z1}`;
  const extra = c.extra ? await c.extra() : {};

  let histogram = null;
  let total;
  if (c.totalOnly) {
    total = fillCount(
      await cmd(`fill ${box(G.yCrop, G.yCrop + 19)} minecraft:air replace ${c.crop}`),
    );
  } else {
    histogram = {};
    total = 0;
    for (let age = 0; age <= c.maxAge; age++) {
      const n = fillCount(
        await cmd(
          `fill ${box(G.yCrop, G.yCrop)} minecraft:air replace ${c.countBlock}[age=${age}]`,
        ),
      );
      histogram[age] = n;
      total += n;
    }
  }

  const result = {
    case: c.name,
    block: c.crop,
    layout: c.layout.description,
    caveat: c.caveat ?? null,
    growthSpeed: c.growthSpeed,
    maxAge: c.maxAge,
    samples: total,
    expectedSamples: c.expected,
    ticksElapsed: t1 - t0,
    ticksRequested: c.ticks,
    randomTickSpeed: RANDOM_TICK_SPEED,
    randomTickChancePerBlockPerTick: RANDOM_TICK_SPEED / 4096,
    ageHistogram: histogram,
    ...extra,
  };
  if (!c.totalOnly && total !== c.expected)
    throw new Error(
      `growth case ${c.name}: counted ${total} plants, expected ${c.expected}; ` +
        "the arena did not build as designed",
    );
  if (c.totalOnly && total < c.expected)
    throw new Error(`growth case ${c.name}: counted ${total} blocks, expected at least ${c.expected}`);
  return result;
}

/**
 * Does this server random tick an empty world at all? Before 1.21.11 the
 * random tick loop sits inside the natural-spawning branch, which is gated on
 * a player being within spawning range, so a headless server never random
 * ticks anything. Probed with a single sugar cane at a random tick speed that
 * makes a miss astronomically unlikely, never inferred from a version number.
 */
async function probeRandomTicking(sprint) {
  const N = 4;
  const TICKS = 200;
  await clearArena();
  await setRandomTick(0);
  for (let i = 0; i < N; i++)
    for (let j = 0; j < N; j++) {
      await cmd(`setblock ${G.x0 + i * 2} ${G.ySoil} ${G.z0 + j * 2} minecraft:sand`);
      await cmd(`setblock ${G.x0 + i * 2 + 1} ${G.ySoil} ${G.z0 + j * 2} minecraft:water`);
      await cmd(
        `setblock ${G.x0 + i * 2} ${G.yCrop} ${G.z0 + j * 2} minecraft:sugar_cane[age=0]`,
      );
    }
  // The random tick speed stays at the same value the real cases use: a much
  // higher one makes a single tick exceed the server's watchdog and the
  // server kills itself mid-probe.
  await setRandomTick(RANDOM_TICK_SPEED);
  if (sprint) await advance(TICKS);
  else await sleep(TICKS * 50);
  await setRandomTick(0);
  const box = `${G.x0} ${G.yCrop} ${G.z0} ${G.x1} ${G.yCrop} ${G.z1}`;
  const untouched = fillCount(
    await cmd(`fill ${box} minecraft:air replace minecraft:sugar_cane[age=0]`),
  );
  const advanced = fillCount(
    await cmd(`fill ${box} minecraft:air replace minecraft:sugar_cane`),
  );
  if (untouched + advanced !== N * N)
    throw new Error(
      `random tick probe: placed ${N * N} sugar canes but counted ${untouched + advanced}`,
    );
  await clearArena();
  return advanced > 0;
}

/**
 * Growth constants read straight out of the decompiled source, for the
 * versions where a headless server cannot random tick at all.
 */
function runGrowthFromSource(reason) {
  const neighbourDivisor = constantIn("CropBlock", /!= 0\)\s*\{\s*\S+ \/= (\d+\.\d+)F;/, {
    note: "each of the eight neighbouring soil cells counts for this fraction",
  });
  // The crowding divisor is whichever other divisor the class uses; picking it
  // by source order would be luck, so the remainder has to be unambiguous.
  const otherDivisors = [
    ...new Set(
      [...readClass("CropBlock").matchAll(/\/= (\d+\.\d+)F;/g)]
        .map((m) => Number(m[1]))
        .filter((v) => v !== neighbourDivisor.value),
    ),
  ];
  if (otherDivisors.length !== 1)
    throw new Error(`ambiguous crop crowding divisor in ${id}: found ${otherDivisors.join(", ")}`);
  const crowdingDivisor = {
    value: otherDivisors[0],
    class: "CropBlock",
    note: "applied when the same crop is adjacent on both axes or on a diagonal",
  };
  const rollDivisor = constantIn("CropBlock", /nextInt\(\(int\)\((\d+\.\d+)F\s*\/\s*\S+\)\s*\+\s*\d+\)/);
  const rollOffset = constantIn("CropBlock", /nextInt\(\(int\)\(\d+\.\d+F\s*\/\s*\S+\)\s*\+\s*(\d+)\)/);
  save(
    "growth",
    {
      note:
        "Growth could not be measured live on this version: " +
        reason +
        " The constants below were read out of the decompiled source of the class recorded " +
        "next to each value. Expected chance per random tick for a farmland crop is " +
        "1 / (floor(growthRollDivisor / growthSpeed) + growthRollOffset), where growthSpeed " +
        "starts at 1, adds farmlandWetBonus or farmlandDryBonus for the soil directly below, " +
        "adds the same divided by neighbourDivisor for each of the eight neighbouring soil " +
        "cells, and is divided by crowdingDivisor when the same crop is adjacent on both axes " +
        "or on a diagonal.",
      measured: false,
      sourceConstants: {
        cropGrowth: {
          growthRollDivisor: rollDivisor,
          growthRollOffset: rollOffset,
          minimumLight: constantIn("CropBlock", /getRawBrightness\([^)]*, 0\) >= (\d+)\)/, {
            note: "minimum light level at the crop for the growth roll to run at all",
          }),
          farmlandDryBonus: constantIn(
            "CropBlock",
            /is\(Blocks\.FARMLAND\)\)\s*\{\s*\S+ = (\d+\.\d+)F;/,
          ),
          farmlandWetBonus: constantIn(
            "CropBlock",
            /FarmBlock\.MOISTURE\) > 0\)\s*\{\s*\S+ = (\d+\.\d+)F;/,
          ),
          neighbourDivisor,
          crowdingDivisor,
        },
        beetroot: {
          extraRollDenominator: constantIn("BeetrootBlock", /nextInt\((\d+)\) != 0/, {
            note: "beetroot skips the shared crop roll unless this extra one-in-N roll passes",
          }),
          maxAge: constantIn("BeetrootBlock", /AGE = BlockStateProperties\.AGE_(\d+)/),
        },
        netherWart: {
          rollDenominator: constantIn("NetherWartBlock", /nextInt\((\d+)\) == 0/, {
            note: "nether wart ignores light, moisture and neighbours entirely",
          }),
          maxAge: constantIn("NetherWartBlock", /AGE = BlockStateProperties\.AGE_(\d+)/),
        },
        sugarCane: {
          maxAge: constantIn("SugarCaneBlock", /AGE = BlockStateProperties\.AGE_(\d+)/, {
            note: "age increments once per random tick, so it counts random ticks exactly",
          }),
        },
        cactus: {
          maxAge: constantIn("CactusBlock", /AGE = BlockStateProperties\.AGE_(\d+)/, {
            note: "age increments once per random tick, so it counts random ticks exactly",
          }),
        },
        bamboo: {
          rollDenominator: constantInChain(
            ["BambooStalkBlock", "BambooBlock"],
            /nextInt\((\d+)\) == 0/,
          ),
        },
      },
    },
    "source-derived",
  );
}

async function runGrowth() {
  const sprint = await tickCommandsAvailable();
  await cmd("kill @e[type=!minecraft:player]");
  await cmd("weather clear 1000000");
  await setGamerule("doWeatherCycle", false);
  await setGamerule("doDaylightCycle", false);
  await setGamerule("doMobSpawning", false);
  await setGamerule("mobGriefing", false);
  await cmd("time set noon");
  if (sprint) await freeze();

  if (!(await probeRandomTicking(sprint))) {
    if (sprint) await unfreeze();
    log("  random ticking does not happen on a headless server here, using source constants");
    return runGrowthFromSource(
      "a headless server never random ticks, because the random tick loop is nested inside " +
        "the natural-spawning branch of ServerChunkCache.tickChunks, which is gated on a " +
        "player being close enough to a chunk for spawning.",
    );
  }

  const cases = [];
  for (const c of GROWTH_CASES) {
    const r = await runGrowthCase(c, sprint);
    cases.push(r);
    log(
      `  growth ${c.name}: ${r.samples} samples over ${r.ticksElapsed} ticks` +
        (r.ageHistogram ? ` -> ${JSON.stringify(r.ageHistogram)}` : ` -> ${r.samples} blocks`),
    );
    // Fail-fast: if nothing at all advanced in the very first case, this
    // chunk is not being random ticked and every later case is worthless.
    if (cases.length === 1 && r.ageHistogram && r.ageHistogram[0] === r.samples)
      throw new Error(
        `growth probe: not a single plant advanced in ${r.ticksElapsed} ticks at ` +
          `randomTickSpeed ${RANDOM_TICK_SPEED}; the arena is not being random ticked`,
      );
  }
  if (sprint) await unfreeze();

  save("growth", {
    note:
      "Crop growth measured per random tick. Each case builds a controlled grid, opens a " +
      "known tick window at a fixed random tick speed, then counts the surviving age of every " +
      "plant. Expected chance per random tick is 1 / (floor(25 / growthSpeed) + 1) for the " +
      "crops that use the farmland growth-speed formula. sugar_cane and cactus record the " +
      "random tick count itself, since their age property increments once per random tick.",
    measured: true,
    randomTickSpeed: RANDOM_TICK_SPEED,
    tickMethod: sprint ? "tick-sprint" : "realtime-20tps",
    tickWindowPrecision: sprint ? "exact" : "within one tick at each end",
    cases,
  });
}

// -------------------------------------------------------------- redstone ---
const R = { x: 48, y: 101, z: 0 };
const rpos = (dx, dy = 0, dz = 0) => `${R.x + dx} ${R.y + dy} ${R.z + dz}`;

async function clearRedstone() {
  await cmd(`fill ${R.x - 4} ${R.y - 1} ${R.z - 4} ${R.x + 8} ${R.y + 4} ${R.z + 4} minecraft:air`);
  await cmd(
    `fill ${R.x - 4} ${R.y - 1} ${R.z - 4} ${R.x + 8} ${R.y - 1} ${R.z + 4} minecraft:stone`,
  );
  await cmd("kill @e[type=minecraft:item]");
}

/** Put n items into a container slot, tolerating the pre-1.17 command name. */
async function putItem(pos, slot, item, n) {
  const res = await cmd(`item replace block ${pos} container.${slot} with ${item} ${n}`);
  if (/Unknown or incomplete command|Incorrect argument/i.test(res))
    return cmd(`replaceitem block ${pos} container.${slot} ${item} ${n}`);
  return res;
}

async function containerCount(pos) {
  const items = await getData("block", pos, "Items");
  if (!Array.isArray(items)) return 0;
  let total = 0;
  for (const it of items) total += Number(pick(it, ["count", "Count"]) ?? 0);
  return total;
}

/** Step one tick at a time, sampling a probe, until ticks run out. */
async function sampleTicks(ticks, probe) {
  const series = [];
  for (let t = 1; t <= ticks; t++) {
    await advance(1);
    series.push({ tick: t, value: await probe() });
  }
  return series;
}

function transitions(series, initial) {
  const out = [];
  let prev = initial;
  for (const s of series) {
    if (s.value !== prev) {
      out.push({ tick: s.tick, from: prev, to: s.value });
      prev = s.value;
    }
  }
  return out;
}

/**
 * Which way a diode's facing property points relative to its input is not
 * worth assuming, so it is probed: whichever facing ends up powered when a
 * redstone block sits on one side is the one used, and both failing is a hard
 * error rather than a silently wrong vector.
 */
async function probeDiode(block, extraState) {
  for (const facing of ["east", "west"]) {
    await clearRedstone();
    const state = `minecraft:${block}[facing=${facing}${extraState ? "," + extraState : ""}]`;
    await cmd(`setblock ${rpos(1)} ${state}`);
    await cmd(`setblock ${rpos(0)} minecraft:redstone_block`);
    await advance(20);
    if (await blockIs(rpos(1), `minecraft:${block}[powered=true]`)) return facing;
  }
  throw new Error(`${block} orientation probe failed: no facing ended up powered`);
}

async function runRedstone() {
  if (!(await tickCommandsAvailable())) return runRedstoneFromSource();

  await cmd("kill @e[type=!minecraft:player]");
  await setRandomTick(0);
  await setGamerule("doMobSpawning", false);
  await freeze();

  // Fail-fast: a stepped tick must advance the clock by exactly one, and the
  // block-state readback must be able to tell true from false.
  const before = await gametime();
  await advance(1);
  if ((await gametime()) - before !== 1)
    throw new Error("redstone probe: one stepped tick did not advance the game clock by one");
  await clearRedstone();
  await cmd(`setblock ${rpos(0)} minecraft:redstone_lamp`);
  if (await blockIs(rpos(0), "minecraft:redstone_lamp[lit=true]"))
    throw new Error("redstone probe: an unpowered lamp reported lit=true");
  if (!(await blockIs(rpos(0), "minecraft:redstone_lamp[lit=false]")))
    throw new Error("redstone probe: block-state readback cannot identify an unpowered lamp");

  const cases = [];

  // Hopper cadence into a chest, a hopper, and a furnace.
  for (const [name, target] of [
    ["hopper-to-chest", "minecraft:chest"],
    // Note the destination hopper also pulls from the one above it, so a
    // hopper chain moves two items per cycle, not one.
    ["hopper-to-hopper", "minecraft:hopper[facing=north]"],
    ["hopper-to-furnace", "minecraft:furnace"],
  ]) {
    await clearRedstone();
    await cmd(`setblock ${rpos(0)} ${target}`);
    await cmd(`setblock ${rpos(0, 1)} minecraft:hopper[facing=down]`);
    await putItem(rpos(0, 1), 0, "minecraft:stone", 64);
    const series = await sampleTicks(60, () => containerCount(rpos(0)));
    cases.push({
      case: name,
      description: `full hopper above a ${target}, item count in the destination per tick`,
      ticks: 60,
      series,
      transitions: transitions(series, 0),
    });
    log(`  redstone ${name}: ${JSON.stringify(transitions(series, 0).slice(0, 4))}`);
  }

  // Dropper: an item lands in the chest a fixed number of ticks after power.
  {
    await clearRedstone();
    await cmd(`setblock ${rpos(0)} minecraft:dropper[facing=east]`);
    await cmd(`setblock ${rpos(1)} minecraft:chest`);
    await putItem(rpos(0), 0, "minecraft:stone", 1);
    await cmd(`setblock ${rpos(0, 1)} minecraft:redstone_block`);
    const series = await sampleTicks(12, () => containerCount(rpos(1)));
    cases.push({
      case: "dropper-fire-delay",
      description: "ticks from powering a dropper until the item reaches the chest in front",
      ticks: 12,
      series,
      transitions: transitions(series, 0),
    });
    log(`  redstone dropper: ${JSON.stringify(transitions(series, 0))}`);
  }

  // Dispenser: a non-dispensable item is ejected as an entity.
  {
    await clearRedstone();
    await cmd(`setblock ${rpos(0)} minecraft:dispenser[facing=east]`);
    await putItem(rpos(0), 0, "minecraft:stone", 1);
    await cmd(`setblock ${rpos(0, 1)} minecraft:redstone_block`);
    const series = await sampleTicks(12, () => entityExists("@e[type=minecraft:item,limit=1]"));
    cases.push({
      case: "dispenser-fire-delay",
      description: "ticks from powering a dispenser until the ejected item entity exists",
      ticks: 12,
      series,
      transitions: transitions(series, false),
    });
    await cmd("kill @e[type=minecraft:item]");
    log(`  redstone dispenser: ${JSON.stringify(transitions(series, false))}`);
  }

  // Repeater delays 1..4 and the comparator, on then off.
  const repeaterFacing = await probeDiode("repeater", "delay=1");
  const comparatorFacing = await probeDiode("comparator", "mode=compare");
  for (const spec of [
    ...[1, 2, 3, 4].map((d) => ({
      name: `repeater-delay-${d}`,
      block: "repeater",
      state: `facing=${repeaterFacing},delay=${d}`,
      delay: d,
    })),
    {
      name: "comparator-compare",
      block: "comparator",
      state: `facing=${comparatorFacing},mode=compare`,
      delay: null,
    },
  ]) {
    await clearRedstone();
    await cmd(`setblock ${rpos(1)} minecraft:${spec.block}[${spec.state}]`);
    await cmd(`setblock ${rpos(0)} minecraft:redstone_block`);
    const probe = () => blockIs(rpos(1), `minecraft:${spec.block}[powered=true]`);
    const on = await sampleTicks(16, probe);
    await cmd(`setblock ${rpos(0)} minecraft:air`);
    const off = await sampleTicks(16, probe);
    cases.push({
      case: spec.name,
      description:
        `${spec.block} driven by a redstone block; its own powered state per tick after the ` +
        "input rises and again after it falls",
      repeaterDelaySetting: spec.delay,
      facing: spec.state,
      risingSeries: on,
      risingTransitions: transitions(on, false),
      fallingSeries: off,
      fallingTransitions: transitions(off, true),
    });
    log(
      `  redstone ${spec.name}: on ${JSON.stringify(transitions(on, false))} ` +
        `off ${JSON.stringify(transitions(off, true))}`,
    );
  }

  // Redstone lamp: on and off are not symmetric, and the off delay would
  // corrupt every other case if a lamp were used as the readback probe.
  {
    await clearRedstone();
    await cmd(`setblock ${rpos(1)} minecraft:redstone_lamp`);
    await cmd(`setblock ${rpos(0)} minecraft:redstone_block`);
    const probe = () => blockIs(rpos(1), "minecraft:redstone_lamp[lit=true]");
    const on = await sampleTicks(8, probe);
    await cmd(`setblock ${rpos(0)} minecraft:air`);
    const off = await sampleTicks(8, probe);
    cases.push({
      case: "redstone-lamp",
      description: "lamp lit state per tick after a redstone block is placed beside it, then removed",
      risingSeries: on,
      risingTransitions: transitions(on, false),
      fallingSeries: off,
      fallingTransitions: transitions(off, true),
    });
    log(
      `  redstone lamp: on ${JSON.stringify(transitions(on, false))} ` +
        `off ${JSON.stringify(transitions(off, true))}`,
    );
  }

  // Observer pulse: onset and length, read off the observer itself.
  {
    let facing = null;
    for (const f of ["east", "west"]) {
      await clearRedstone();
      await cmd(`setblock ${rpos(1)} minecraft:observer[facing=${f}]`);
      await advance(8);
      await cmd(`setblock ${rpos(f === "east" ? 2 : 0)} minecraft:stone`);
      const probeSeries = await sampleTicks(8, () =>
        blockIs(rpos(1), "minecraft:observer[powered=true]"),
      );
      if (probeSeries.some((s) => s.value)) {
        facing = f;
        break;
      }
    }
    if (!facing)
      throw new Error("observer orientation probe failed: neither facing produced a pulse");
    await clearRedstone();
    const watchPos = rpos(facing === "east" ? 2 : 0);
    await cmd(`setblock ${rpos(1)} minecraft:observer[facing=${facing}]`);
    await advance(8);
    if (await blockIs(rpos(1), "minecraft:observer[powered=true]"))
      throw new Error("observer probe: observer was still powered before the watched block changed");
    await cmd(`setblock ${watchPos} minecraft:stone`);
    const series = await sampleTicks(10, () =>
      blockIs(rpos(1), "minecraft:observer[powered=true]"),
    );
    cases.push({
      case: "observer-pulse",
      description:
        "ticks from changing the watched block until the observer powers up, and how long it " +
        "stays powered",
      facing,
      watchedSide: facing,
      ticks: 10,
      series,
      transitions: transitions(series, false),
    });
    log(`  redstone observer: ${JSON.stringify(transitions(series, false))}`);
  }

  // Piston extension and retraction.
  {
    await clearRedstone();
    await cmd(`setblock ${rpos(0)} minecraft:piston[facing=east]`);
    await cmd(`setblock ${rpos(0, 1)} minecraft:redstone_block`);
    const pistonProbe = async () => ({
      head: await blockIs(rpos(1), "minecraft:piston_head"),
      moving: await blockIs(rpos(1), "minecraft:moving_piston"),
      extended: await blockIs(rpos(0), "minecraft:piston[extended=true]"),
    });
    const out = await sampleTicks(10, pistonProbe);
    await cmd(`setblock ${rpos(0, 1)} minecraft:air`);
    const back = await sampleTicks(10, pistonProbe);
    const flat = (s) => s.map((x) => ({ tick: x.tick, ...x.value }));
    cases.push({
      case: "piston",
      description: "piston head presence and extended state per tick after power on, then off",
      extendSeries: flat(out),
      extendedAtTick: flat(out).find((x) => x.head)?.tick ?? null,
      retractSeries: flat(back),
      retractedAtTick: flat(back).find((x) => !x.head)?.tick ?? null,
    });
    log(
      `  redstone piston: extend @${cases.at(-1).extendedAtTick} retract @${cases.at(-1).retractedAtTick}`,
    );
  }

  await unfreeze();
  save("redstone", {
    note:
      "Exact component timings measured one stepped tick at a time from a frozen game. " +
      "Tick 1 is the first tick after the setup command that starts the case.",
    measured: true,
    cases,
  });
}

function runRedstoneFromSource() {
  const scheduleTick = /scheduleTick\([^)]*,\s*this,\s*(\d+)\)/;
  const pistonStep = constantIn(
    "PistonMovingBlockEntity",
    [/progress\s*\+\s*(\d*\.\d+)F/, /progress\s*\+=\s*(\d*\.\d+)F/],
    {
      note:
        "pistons are block-event driven, not scheduled: the moving block entity advances its " +
        "progress by this fraction each tick, so a full extension or retraction takes " +
        "1 / progressPerTick ticks",
    },
  );
  const constants = [
    {
      name: "hopper-transfer-cooldown",
      // setCooldown(0) resets the cooldown earlier in the file than the real
      // transfer cadence is ever set, so zeroes are dropped before the
      // remaining matches are required to agree.
      ticks: constantIn(
        "HopperBlockEntity",
        [/setCooldown\((\d+)\);/, /setCooldown\((\d+) - /],
        { zeroIsNoise: true, note: "ticks between one item moving and the next" },
      ),
    },
    { name: "dispenser-and-dropper-fire-delay", ticks: constantIn("DispenserBlock", scheduleTick) },
    {
      name: "repeater-ticks-per-delay-setting",
      ticks: constantIn("RepeaterBlock", /getDelay\([^)]*\)\s*\{\s*return\s+\S+\s*\*\s*(\d+);/, {
        note: "a repeater set to delay N takes N times this many ticks",
      }),
    },
    {
      name: "comparator-delay",
      ticks: constantIn("ComparatorBlock", /getDelay\([^)]*\)\s*\{\s*return\s+(\d+);/),
    },
    { name: "observer-schedule-delay", ticks: constantIn("ObserverBlock", scheduleTick) },
    {
      name: "piston-movement",
      ticks: { ...pistonStep, value: Math.round(1 / pistonStep.value) },
      progressPerTick: pistonStep,
    },
  ];
  save(
    "redstone",
    {
      note:
        "This version has no tick freeze/step commands, so exact per-tick timings cannot be " +
        "measured over RCON. Each constant below was read out of the decompiled source of the " +
        "class recorded next to its value.",
      measured: false,
      sourceConstants: constants,
    },
    "source-derived",
  );
}

// ----------------------------------------------------------------- main ----
try {
  // forceload takes block coordinates: this covers the growth arena, the
  // redstone bench at x=48, the villager bench and the projectile flight
  // corridor, without loading so many chunks that a high random tick speed
  // pushes a single tick past the server watchdog.
  await cmd("forceload add -32 -32 176 32");
  await setGamerule("doMobSpawning", false);
  await setGamerule("sendCommandFeedback", true);
  await setGamerule("commandBlockOutput", false);
  await tickCommandsAvailable();
  await setRandomTick(0);

  if (wanted("projectile")) await runProjectile();
  if (wanted("villager")) await runVillager();
  if (wanted("growth")) await runGrowth();
  if (wanted("redstone")) await runRedstone();
  log(`done, ${commandCount} rcon commands`);
} finally {
  await stop();
  log("server stopped");
}
