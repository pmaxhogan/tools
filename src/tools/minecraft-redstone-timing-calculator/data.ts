/**
 * Redstone timing constants, reimplemented from decompiled and unobfuscated
 * Minecraft server source.
 *
 * Read directly out of six trees under mc-pipeline/work/<id>/src/ (1.16.5,
 * 1.18.2, 1.20.6, 1.21.1, 1.21.11, 26.2). Every entry cites the class and
 * method the number came from. Where a value changed between versions the
 * change is recorded in `perVersion` and again, in prose, in VERSION_CHANGES.
 *
 * This file is hand written rather than generated: these constants live in
 * Java method bodies, not in any data pack or registry dump, so there is
 * nothing for a generator script to read. Nothing here is transcribed Java;
 * the values were read and reimplemented.
 *
 * Baseline facts, identical in all six versions:
 * - net.minecraft.SharedConstants: TICKS_PER_SECOND = 20, MILLIS_PER_TICK =
 *   50, TICKS_PER_MINUTE = 1200, TICKS_PER_GAME_DAY = 24000. 1.16.5 declares
 *   none of these names and uses the same values inline.
 * - A "redstone tick" is not a game concept at all: it is the community name
 *   for two game ticks, the smallest step a repeater or comparator can add
 *   (RepeaterBlock.getDelay returns the DELAY property times 2, and
 *   ComparatorBlock.getDelay returns 2).
 * - Scheduled block ticks run in order of trigger tick, then TickPriority
 *   (EXTREMELY_HIGH -3 through EXTREMELY_LOW +3), then a monotonic sub-tick
 *   insertion counter (net.minecraft.world.ticks.ScheduledTick DRAIN_ORDER;
 *   net.minecraft.world.level.TickNextTickData in 1.16.5). Up to 65536
 *   scheduled ticks run per game tick.
 */
import { ToolError } from "../types";

/** Versions with verified redstone data, oldest first. */
export const REDSTONE_VERSIONS = ["1.16.5", "1.18.2", "1.20.6", "1.21.1", "1.21.11", "26.2"] as const;

export type VersionId = (typeof REDSTONE_VERSIONS)[number];

/** net.minecraft.SharedConstants TICKS_PER_SECOND. */
export const TICKS_PER_SECOND = 20;

/** net.minecraft.SharedConstants MILLIS_PER_TICK. */
export const MS_PER_TICK = 50;

/** One redstone tick, in game ticks. Not a game constant, a community unit. */
export const REDSTONE_TICK_GAME_TICKS = 2;

/** What the headline number on a component actually measures. */
export type TimingKind = "delay" | "pulse" | "duration" | "period" | "fuse" | "instant";

export interface ComponentTiming {
  id: string;
  label: string;
  /** Reference table grouping, also used by the panel's picker. */
  group: string;
  /** The headline timing in game ticks. See `kind` for what it measures. */
  delayTicks: number;
  kind: TimingKind;
  /** Adjustable components: the lowest and highest setting, in game ticks. */
  delayRange?: [number, number];
  /** Output pulse length in game ticks, when the component resets itself. */
  pulseTicks?: number;
  /** Versions that have this component. Omitted means all of them. */
  availableIn?: VersionId[];
  /** Versions where the headline timing differs from `delayTicks`. */
  perVersion?: Partial<Record<VersionId, number>>;
  note: string;
  /** Class and method the value was read from. */
  source: string;
  synonyms: string[];
}

const FROM_1_18_2: VersionId[] = ["1.18.2", "1.20.6", "1.21.1", "1.21.11", "26.2"];
const FROM_1_20_6: VersionId[] = ["1.20.6", "1.21.1", "1.21.11", "26.2"];

export const COMPONENTS: ComponentTiming[] = [
  {
    id: "redstone_wire",
    label: "Redstone dust",
    group: "Signal",
    delayTicks: 0,
    kind: "instant",
    note: "Dust carries a signal with no delay at all. Strength starts at 15 and drops by 1 for every dust block travelled, so a line reaches 15 blocks and then dies.",
    source: "RedStoneWireBlock calculateTargetStrength (1.16.5 to 1.21.1), DefaultRedstoneWireEvaluator calculateTargetStrength and RedstoneWireEvaluator getIncomingWireSignal (1.21.11, 26.2)",
    synonyms: ["dust", "wire", "signal decay", "15 blocks", "power level"],
  },
  {
    id: "lever",
    label: "Lever",
    group: "Input",
    delayTicks: 0,
    kind: "instant",
    note: "A lever switches on the same tick it is flipped and stays until flipped back. It is the only input with no timer of its own.",
    source: "LeverBlock useWithoutItem and neighbour updates, no scheduleTick call in any version",
    synonyms: ["switch", "toggle", "manual input"],
  },
  {
    id: "note_block",
    label: "Note block",
    group: "Output",
    delayTicks: 0,
    kind: "instant",
    note: "Plays on the same tick the power arrives. The note block schedules nothing, so it never adds delay to a chain.",
    source: "NoteBlockBlock neighborChanged, no scheduleTick call in any version",
    synonyms: ["music", "noteblock", "sound"],
  },
  {
    id: "door_trapdoor_gate",
    label: "Door, trapdoor, or fence gate",
    group: "Output",
    delayTicks: 0,
    kind: "instant",
    note: "All three open and close on the tick the power changes. The only scheduled ticks in the trapdoor code are water fluid ticks for the waterlogged state, never a delay on the trapdoor itself.",
    source: "DoorBlock, TrapDoorBlock, and FenceGateBlock neighborChanged in all six versions",
    synonyms: ["iron door", "gate", "trapdoor", "instant"],
  },
  {
    id: "copper_bulb",
    label: "Copper bulb",
    group: "Output",
    delayTicks: 0,
    kind: "instant",
    availableIn: FROM_1_20_6,
    note: "Toggles on the same tick, and only on the rising edge, which makes it a one block T flip flop. A comparator reads 15 when it is lit.",
    source: "CopperBulbBlock neighborChanged and checkAndFlip, no scheduleTick call",
    synonyms: ["bulb", "t flip flop", "toggle", "copper"],
  },
  {
    id: "redstone_torch",
    label: "Redstone torch",
    group: "Signal",
    delayTicks: 2,
    kind: "delay",
    note: "Inverts its input after 1 redstone tick. Toggling a torch more than 8 times in 60 ticks burns it out for 160 ticks, which is what makes a bare torch loop unreliable.",
    source: "RedstoneTorchBlock neighborChanged scheduleTick of 2, plus RECENT_TOGGLE_TIMER 60, MAX_RECENT_TOGGLES 8, and the 160 tick burnout reschedule",
    synonyms: ["torch", "inverter", "not gate", "burnout"],
  },
  {
    id: "repeater",
    label: "Repeater",
    group: "Delay",
    delayTicks: 2,
    kind: "delay",
    delayRange: [2, 8],
    note: "Four settings, 1 to 4 redstone ticks, which is 2, 4, 6 or 8 game ticks. It always outputs strength 15, and a signal into its side from another diode locks it.",
    source: "RepeaterBlock getDelay returns the DELAY property (1 to 4) times 2; DiodeBlock getOutputSignal returns 15; RepeaterBlock isLocked",
    synonyms: ["repeater", "delay", "diode", "lock", "1 tick", "4 tick"],
  },
  {
    id: "comparator",
    label: "Comparator",
    group: "Delay",
    delayTicks: 2,
    kind: "delay",
    note: "Always exactly 1 redstone tick, with no setting. In subtract mode it outputs the front signal minus the strongest side signal; in compare mode it passes the front signal through unless a side beats it.",
    source: "ComparatorBlock getDelay returns 2; shouldTurnOn and calculateOutputSignal",
    synonyms: ["comparator", "subtract", "compare", "2 ticks", "analog"],
  },
  {
    id: "observer",
    label: "Observer",
    group: "Detection",
    delayTicks: 2,
    kind: "delay",
    pulseTicks: 2,
    note: "Arms 2 game ticks after the block in front changes, then emits a 2 game tick pulse of strength 15 out the back. That 2 tick pulse is the shortest reliable pulse in vanilla.",
    source: "ObserverBlock updateShape and tick, both scheduling 2 ticks at NORMAL priority",
    synonyms: ["observer", "block update detector", "bud", "1 tick pulse", "2 tick pulse"],
  },
  {
    id: "piston",
    label: "Piston",
    group: "Movement",
    delayTicks: 2,
    kind: "duration",
    note: "A piston does not schedule a block tick at all: it fires a block event on the same tick the update lands, and the head then travels over 2 game ticks. A sticky piston that loses power for less than 2 ticks drops the block it was holding.",
    source: "PistonBaseBlock checkIfExtend and triggerEvent (block events 0, 1 and 2); PistonMovingBlockEntity TICKS_TO_EXTEND 2 with progress rising 0.5 per tick",
    synonyms: ["piston", "sticky piston", "block event", "slime block", "0 tick"],
  },
  {
    id: "dispenser",
    label: "Dispenser",
    group: "Item transport",
    delayTicks: 4,
    kind: "delay",
    note: "Fires 4 game ticks after a rising edge, and only on a rising edge: the power has to drop before it will fire again.",
    source: "DispenserBlock neighborChanged, scheduleTick of 4 at NORMAL priority, guarded by the TRIGGERED property",
    synonyms: ["dispenser", "shoot", "4 ticks", "2 redstone ticks"],
  },
  {
    id: "dropper",
    label: "Dropper",
    group: "Item transport",
    delayTicks: 4,
    kind: "delay",
    note: "Identical timing to a dispenser: the dropper class adds no scheduling of its own. It pushes one item into the container it faces, or throws one if there is none.",
    source: "DropperBlock extends DispenserBlock and has no scheduleTick call of its own in any version",
    synonyms: ["dropper", "item elevator", "4 ticks"],
  },
  {
    id: "redstone_lamp",
    label: "Redstone lamp",
    group: "Output",
    delayTicks: 4,
    kind: "delay",
    note: "Lights on the same tick the power arrives but stays lit for 4 more game ticks after the power goes away. That asymmetry is why a lamp is a poor probe for measuring anything shorter than 4 ticks.",
    source: "RedstoneLampBlock neighborChanged lights immediately and schedules a 4 tick turn off; identical in all six versions",
    synonyms: ["lamp", "light", "4 ticks", "turn off delay"],
  },
  {
    id: "crafter",
    label: "Crafter",
    group: "Item transport",
    delayTicks: 4,
    kind: "delay",
    availableIn: FROM_1_20_6,
    note: "Crafts 4 game ticks after a rising edge, then plays a 6 tick crafting state. The craft itself lands on the 4 tick mark.",
    source: "CrafterBlock CRAFTING_TICK_DELAY 4 in neighborChanged and onPlace; CrafterBlockEntity MAX_CRAFTING_TICKS 6",
    synonyms: ["crafter", "auto crafting", "1.21"],
  },
  {
    id: "target_block",
    label: "Target block",
    group: "Detection",
    delayTicks: 8,
    kind: "duration",
    note: "Stays powered for 8 game ticks when hit by anything except an arrow, and for 20 game ticks when an arrow sticks in it. Strength depends on how close to the middle the hit landed.",
    source: "TargetBlock updateRedstoneOutput, duration 20 for an AbstractArrow and 8 otherwise; getRedstoneStrength",
    synonyms: ["target", "arrow", "snowball", "8 ticks", "20 ticks"],
  },
  {
    id: "lightning_rod",
    label: "Lightning rod",
    group: "Detection",
    delayTicks: 8,
    kind: "duration",
    availableIn: FROM_1_18_2,
    note: "Outputs strength 15 for 8 game ticks after a strike, out of the face it points. It also pulls strikes from up to 128 blocks away.",
    source: "LightningRodBlock ACTIVATION_TICKS 8 and RANGE 128 in onLightningStrike",
    synonyms: ["lightning", "rod", "storm", "copper"],
  },
  {
    id: "hopper",
    label: "Hopper",
    group: "Item transport",
    delayTicks: 8,
    kind: "period",
    note: "Moves an item, then sits on an 8 game tick cooldown before it can move another. Pushing into a container, pulling from one, and picking an item entity up off the ground all pay the same 8 ticks.",
    source: "HopperBlockEntity MOVE_ITEM_SPEED 8, set by tryMoveItems as setCooldown(8) on any successful transfer",
    synonyms: ["hopper", "8 ticks", "2.5 items per second", "item speed", "cooldown"],
  },
  {
    id: "calibrated_sculk_sensor",
    label: "Calibrated sculk sensor",
    group: "Detection",
    delayTicks: 10,
    kind: "duration",
    availableIn: FROM_1_20_6,
    note: "Stays active for 10 game ticks, a third of a plain sculk sensor, and only reacts to the vibration frequency fed into its side by a comparator.",
    source: "CalibratedSculkSensorBlock getActiveTicks returns 10, overriding SculkSensorBlock",
    synonyms: ["calibrated", "sculk", "vibration", "frequency"],
  },
  {
    id: "weighted_pressure_plate",
    label: "Weighted pressure plate",
    group: "Input",
    delayTicks: 10,
    kind: "duration",
    note: "Rechecks every 10 game ticks while something is on it, half the interval of a normal pressure plate. Output strength counts the items or entities standing on it.",
    source: "WeightedPressurePlateBlock getPressedTime returns 10",
    synonyms: ["weighted plate", "gold plate", "iron plate", "item counter"],
  },
  {
    id: "stone_button",
    label: "Stone button",
    group: "Input",
    delayTicks: 20,
    kind: "duration",
    note: "Stays pressed for 20 game ticks, exactly 1 second on a healthy server.",
    source: "ButtonBlock ticks_to_stay_pressed, registered as 20 for stone and polished blackstone buttons in Blocks (getPressDuration returns 20 for a non sensitive button in 1.16.5)",
    synonyms: ["stone button", "1 second", "20 ticks", "blackstone button"],
  },
  {
    id: "pressure_plate",
    label: "Pressure plate",
    group: "Input",
    delayTicks: 20,
    kind: "duration",
    note: "Rechecks every 20 game ticks while something stands on it, so it stays on for at least a second after the last step off.",
    source: "BasePressurePlateBlock getPressedTime returns 20",
    synonyms: ["plate", "pressure plate", "20 ticks", "1 second"],
  },
  {
    id: "detector_rail",
    label: "Detector rail",
    group: "Detection",
    delayTicks: 20,
    kind: "period",
    note: "Rechecks every 20 game ticks while a minecart sits on it. A comparator on a detector rail reads the fullness of a container minecart passing over.",
    source: "DetectorRailBlock PRESSED_CHECK_PERIOD 20 in checkPressed",
    synonyms: ["rail", "minecart detector", "20 ticks"],
  },
  {
    id: "daylight_detector",
    label: "Daylight detector",
    group: "Detection",
    delayTicks: 20,
    kind: "period",
    note: "Recomputes its output once every 20 game ticks, when the game time is a multiple of 20. Inverted mode subtracts the reading from 15.",
    source: "DaylightDetectorBlock tickEntity, gated on game time modulo 20 (DaylightDetectorBlockEntity tick in 1.16.5)",
    synonyms: ["daylight sensor", "solar", "sunlight", "20 ticks"],
  },
  {
    id: "sculk_sensor",
    label: "Sculk sensor",
    group: "Detection",
    delayTicks: 30,
    kind: "duration",
    availableIn: FROM_1_18_2,
    perVersion: { "1.18.2": 40 },
    note: "Stays active for 30 game ticks and then sits on a 10 tick cooldown. In 1.18.2 it stayed active for 40 ticks with only a 1 tick cooldown, which is why old sensor circuits retime badly on modern versions.",
    source: "SculkSensorBlock ACTIVE_TICKS and COOLDOWN_TICKS: 40 and 1 in 1.18.2, 30 and 10 from 1.20.6 on",
    synonyms: ["sculk", "vibration", "deep dark", "warden", "40 ticks", "30 ticks"],
  },
  {
    id: "wooden_button",
    label: "Wooden button",
    group: "Input",
    delayTicks: 30,
    kind: "duration",
    note: "Stays pressed for 30 game ticks, half again as long as a stone button, and can also be triggered by an arrow.",
    source: "ButtonBlock ticks_to_stay_pressed, registered as 30 for every wooden button in Blocks (getPressDuration returns 30 for a sensitive button in 1.16.5)",
    synonyms: ["wood button", "1.5 seconds", "30 ticks", "arrow button"],
  },
  {
    id: "tnt",
    label: "TNT",
    group: "Explosives",
    delayTicks: 80,
    kind: "fuse",
    note: "The default fuse is 80 game ticks, exactly 4 seconds. TNT lit by another explosion instead gets a random fuse of 10 to 29 ticks, which is what spreads a chain reaction out.",
    source: "PrimedTnt DEFAULT_FUSE_TIME 80; TntBlock chain ignition uses a random fuse of fuse/8 plus a roll under fuse/4",
    synonyms: ["tnt", "fuse", "4 seconds", "80 ticks", "explosion"],
  },
];

export function componentsForVersion(version: VersionId): ComponentTiming[] {
  return COMPONENTS.filter((c) => (c.availableIn ?? REDSTONE_VERSIONS).includes(version));
}

export function componentById(version: VersionId, id: string): ComponentTiming {
  const found = componentsForVersion(version).find((c) => c.id === id);
  if (!found) {
    throw new ToolError(
      "unknown-component",
      `There is no component "${id}" in ${version}.`,
      "Pick a component from this version's list.",
    );
  }
  return found;
}

/* ------------------------------------------------------------------ */
/* containers a comparator can read for fullness                       */
/* ------------------------------------------------------------------ */

export interface ContainerSpec {
  id: string;
  label: string;
  /** Slot count the fullness formula divides by. */
  slots: number;
  /** The container's own stack cap. Every vanilla container caps at 64. */
  maxStackSize: number;
  availableIn?: VersionId[];
  note: string;
  source: string;
  synonyms: string[];
}

export const CONTAINERS: ContainerSpec[] = [
  {
    id: "double_chest",
    label: "Double chest",
    slots: 54,
    maxStackSize: 64,
    note: "Two single chests read as one 54 slot container, which is why a double chest needs twice the items of a single chest for the same signal.",
    source: "ChestBlock getContainer builds a CompoundContainer of two ChestBlockEntity inventories of 27 slots each",
    synonyms: ["large chest", "54 slots", "double chest", "big chest"],
  },
  {
    id: "chest",
    label: "Chest",
    slots: 27,
    maxStackSize: 64,
    note: "A single chest, trapped or not, is 27 slots.",
    source: "ChestBlockEntity, 27 slot inventory",
    synonyms: ["single chest", "27 slots", "trapped chest"],
  },
  {
    id: "barrel",
    label: "Barrel",
    slots: 27,
    maxStackSize: 64,
    note: "Identical to a single chest for comparator purposes: 27 slots.",
    source: "BarrelBlockEntity, 27 slot inventory",
    synonyms: ["barrel", "27 slots"],
  },
  {
    id: "shulker_box",
    label: "Shulker box",
    slots: 27,
    maxStackSize: 64,
    note: "27 slots like a chest. A shulker box cannot hold another shulker box, so the practical stack size is what you put in it.",
    source: "ShulkerBoxBlockEntity CONTAINER_SIZE 27",
    synonyms: ["shulker", "27 slots", "portable storage"],
  },
  {
    id: "chest_minecart",
    label: "Minecart with chest",
    slots: 27,
    maxStackSize: 64,
    note: "27 slots, read by a comparator on a detector rail rather than on the container itself.",
    source: "MinecartChest getContainerSize returns 27; DetectorRailBlock reads it through getRedstoneSignalFromContainer",
    synonyms: ["chest minecart", "minecart", "detector rail"],
  },
  {
    id: "dispenser",
    label: "Dispenser",
    slots: 9,
    maxStackSize: 64,
    note: "9 slots, so each slot is worth well over one signal step and the readings jump in coarse blocks.",
    source: "DispenserBlockEntity CONTAINER_SIZE 9",
    synonyms: ["dispenser", "9 slots"],
  },
  {
    id: "dropper",
    label: "Dropper",
    slots: 9,
    maxStackSize: 64,
    note: "9 slots, the same shape as a dispenser.",
    source: "DispenserBlockEntity CONTAINER_SIZE 9, shared by DropperBlockEntity",
    synonyms: ["dropper", "9 slots"],
  },
  {
    id: "crafter",
    label: "Crafter",
    slots: 9,
    maxStackSize: 64,
    availableIn: FROM_1_20_6,
    note: "9 slots. Disabled slots still count as empty slots for the fullness formula.",
    source: "CrafterBlockEntity CONTAINER_SIZE 9",
    synonyms: ["crafter", "9 slots", "auto crafting"],
  },
  {
    id: "hopper",
    label: "Hopper",
    slots: 5,
    maxStackSize: 64,
    note: "5 slots. One item in a hopper gives signal 1, and a hopper is the usual container for item clocks and item counters.",
    source: "HopperBlockEntity HOPPER_CONTAINER_SIZE 5",
    synonyms: ["hopper", "5 slots", "item clock"],
  },
  {
    id: "hopper_minecart",
    label: "Minecart with hopper",
    slots: 5,
    maxStackSize: 64,
    note: "5 slots, like a block hopper, read through a detector rail.",
    source: "MinecartHopper getContainerSize returns 5",
    synonyms: ["hopper minecart", "5 slots"],
  },
  {
    id: "brewing_stand",
    label: "Brewing stand",
    slots: 5,
    maxStackSize: 64,
    note: "5 slots: three bottles, the ingredient, and the blaze powder. Potions stack to 1, so pick a stack size of 1 when reading bottles.",
    source: "BrewingStandBlockEntity, 5 slot inventory",
    synonyms: ["brewing", "potion", "5 slots"],
  },
  {
    id: "furnace",
    label: "Furnace, blast furnace, or smoker",
    slots: 3,
    maxStackSize: 64,
    note: "3 slots: input, fuel and output. With so few slots most signal strengths are unreachable.",
    source: "AbstractFurnaceBlockEntity, 3 slot inventory shared by all three furnace types",
    synonyms: ["furnace", "smoker", "blast furnace", "3 slots"],
  },
];

export function containersForVersion(version: VersionId): ContainerSpec[] {
  return CONTAINERS.filter((c) => (c.availableIn ?? REDSTONE_VERSIONS).includes(version));
}

export function containerById(version: VersionId, id: string): ContainerSpec {
  const found = containersForVersion(version).find((c) => c.id === id);
  if (!found) {
    throw new ToolError(
      "unknown-container",
      `There is no container "${id}" in ${version}.`,
      "Pick a container from this version's list.",
    );
  }
  return found;
}

/* ------------------------------------------------------------------ */
/* item transport methods                                              */
/* ------------------------------------------------------------------ */

export interface TransportSpec {
  id: string;
  label: string;
  /** Game ticks per transfer, already resolved for the chosen version. */
  ticksPerItem: number;
  /** Items per transfer. "stack" means a whole stack moves at once. */
  itemsPerTransfer: number | "stack";
  /** Latency before the first item arrives, for non chainable transports. */
  startupTicks: number;
  /** Whether stringing several in a row adds latency but not throughput. */
  chainable: boolean;
  /** Whether the rate is set by the clock driving it rather than by itself. */
  clockDriven: boolean;
  /** Shortest clock period that still works, in game ticks. */
  minClockPeriod?: number;
  availableIn?: VersionId[];
  /** Versions where ticksPerItem differs from the default above. */
  perVersionTicks?: Partial<Record<VersionId, number>>;
  note: string;
  source: string;
  synonyms: string[];
}

const TRANSPORT_DEFS: TransportSpec[] = [
  {
    id: "hopper",
    label: "Hopper",
    ticksPerItem: 8,
    itemsPerTransfer: 1,
    startupTicks: 8,
    chainable: false,
    clockDriven: false,
    note: "One item every 8 game ticks, which is 2.5 items a second or 9000 an hour. The same cooldown applies whether the hopper is pushing, pulling, or picking items up off the ground.",
    source: "HopperBlockEntity MOVE_ITEM_SPEED 8 and setCooldown(8) in tryMoveItems",
    synonyms: ["hopper", "2.5 per second", "9000 per hour", "8 ticks"],
  },
  {
    id: "hopper_to_hopper",
    label: "Hopper into a hopper",
    ticksPerItem: 8,
    itemsPerTransfer: 2,
    startupTicks: 8,
    chainable: false,
    clockDriven: false,
    note: "Two items every 8 game ticks, 5 a second, because both hoppers act. The upper hopper pushes one item down on its own cooldown, and the lower hopper separately pulls one item out of the container above it on its cooldown. Measured on a live server, and it is why a hopper into a hopper beats a hopper into a chest.",
    source: "HopperBlockEntity tryMoveItems runs ejectItems and suckInItems for each hopper independently, each paying its own setCooldown(8)",
    synonyms: ["hopper to hopper", "5 per second", "two items", "hopper pair"],
  },
  {
    id: "hopper_chain",
    label: "Hopper chain into a chest",
    ticksPerItem: 8,
    itemsPerTransfer: 1,
    startupTicks: 8,
    chainable: true,
    clockDriven: false,
    note: "Links between hoppers carry 2 items every 8 game ticks, but the last hop into a chest or barrel only carries 1, so the sustained rate of the whole chain is 2.5 items a second. What the extra hoppers add is latency, 8 game ticks each, and the game resyncs a freshly filled hopper to 7 ticks so the chain does not drift.",
    source: "HopperBlockEntity tryMoveItems setCooldown(8), plus addItem setting setCooldown(8 minus 1) on a hopper that has already ticked this game tick",
    synonyms: ["hopper line", "hopper chain", "latency", "sorter", "2.5 per second"],
  },
  {
    id: "hopper_minecart",
    label: "Hopper minecart under a container",
    ticksPerItem: 1,
    itemsPerTransfer: 1,
    startupTicks: 1,
    chainable: false,
    clockDriven: false,
    perVersionTicks: { "1.16.5": 4, "1.18.2": 4 },
    note: "From 1.20.6 on a hopper minecart pulls one item every single game tick, 20 a second, which is eight times a block hopper. In 1.16.5 and 1.18.2 a stationary hopper minecart still paid a 4 tick cooldown, so it managed 5 a second.",
    source: "MinecartHopper tick: 1.16.5 and 1.18.2 call setCooldown(4) after a successful suck; 1.20.6 and later dropped the cooldown entirely and 1.21.11 replaced it with a once per tick guard",
    synonyms: ["hopper minecart", "unloader", "20 per second", "fast unload"],
  },
  {
    id: "water_stream",
    label: "Water stream into a hopper",
    ticksPerItem: 8,
    itemsPerTransfer: "stack",
    startupTicks: 8,
    chainable: false,
    clockDriven: false,
    note: "A hopper picking an item entity off the ground absorbs the whole entity in one transfer, so a merged stack of 64 costs the same 8 ticks as a single item. That is why a water stream feeding a hopper massively outruns a hopper feeding a hopper. The figure here is the best case, with items fully merged before they arrive.",
    source: "HopperBlockEntity addItem(Container, ItemEntity) moves the entire ItemEntity stack, then tryMoveItems pays one setCooldown(8)",
    synonyms: ["water stream", "item pickup", "collection", "merged stacks", "flush"],
  },
  {
    id: "dropper",
    label: "Dropper on a clock",
    ticksPerItem: 4,
    itemsPerTransfer: 1,
    startupTicks: 4,
    chainable: false,
    clockDriven: true,
    minClockPeriod: 4,
    note: "A dropper fires one item 4 game ticks after each rising edge, and needs the power to drop before it will fire again. The fastest useful driver is a 2 tick on, 2 tick off clock, giving one item every 4 game ticks.",
    source: "DispenserBlock neighborChanged schedules 4 ticks and latches the TRIGGERED property; DropperBlock inherits it unchanged",
    synonyms: ["dropper", "dropper clock", "5 per second", "item elevator"],
  },
  {
    id: "dropper_chain",
    label: "Dropper chain",
    ticksPerItem: 4,
    itemsPerTransfer: 1,
    startupTicks: 4,
    chainable: true,
    clockDriven: true,
    minClockPeriod: 4,
    note: "Droppers feeding droppers, the standard item elevator. Throughput is set by the clock, not by the number of droppers; each extra dropper adds one clock period of latency.",
    source: "DropperBlock, which inherits DispenserBlock's 4 tick scheduled tick and TRIGGERED latch",
    synonyms: ["item elevator", "dropper tower", "vertical transport"],
  },
  {
    id: "dispenser",
    label: "Dispenser on a clock",
    ticksPerItem: 4,
    itemsPerTransfer: 1,
    startupTicks: 4,
    chainable: false,
    clockDriven: true,
    minClockPeriod: 4,
    note: "Same 4 tick delay and same rising edge rule as a dropper. A dispenser throws or uses the item instead of inserting it into a container.",
    source: "DispenserBlock neighborChanged, scheduleTick of 4 guarded by TRIGGERED",
    synonyms: ["dispenser", "shooter", "auto feeder"],
  },
];

export const TRANSPORTS: TransportSpec[] = TRANSPORT_DEFS;

export function transportsForVersion(version: VersionId): TransportSpec[] {
  return TRANSPORT_DEFS.filter((t) => (t.availableIn ?? REDSTONE_VERSIONS).includes(version)).map(
    (t) => ({ ...t, ticksPerItem: t.perVersionTicks?.[version] ?? t.ticksPerItem }),
  );
}

export function transportById(version: VersionId, id: string): TransportSpec {
  const found = transportsForVersion(version).find((t) => t.id === id);
  if (!found) {
    throw new ToolError(
      "unknown-transport",
      `There is no item transport called "${id}" in ${version}.`,
      `Use one of: ${transportsForVersion(version)
        .map((t) => t.id)
        .join(", ")}.`,
    );
  }
  return found;
}

/* ------------------------------------------------------------------ */
/* version boundaries                                                  */
/* ------------------------------------------------------------------ */

export interface VersionChange {
  version: VersionId;
  summary: string;
  source: string;
}

/**
 * Every place the six verified trees disagree about timing. Renames and file
 * moves are excluded; only behaviour that a builder would feel is listed.
 */
export const VERSION_CHANGES: VersionChange[] = [
  {
    version: "1.16.5",
    summary:
      "Baseline. Repeater 2 to 8 ticks, comparator 2, observer 2 armed plus a 2 tick pulse, hopper 8, dropper and dispenser 4, TNT fuse 80, piston head 2 ticks. A stationary hopper minecart pulls one item every 4 game ticks. There is no sculk sensor, no lightning rod, no crafter and no copper bulb yet. A comparator in compare mode also stores the front signal rather than 0 when a side signal beats it, which can schedule a tick that later versions skip.",
    source: "RepeaterBlock, ComparatorBlock, ObserverBlock, HopperBlockEntity, DispenserBlock, TntBlock, PistonMovingBlockEntity, MinecartHopper in mc-pipeline/work/1.16.5/src",
  },
  {
    version: "1.18.2",
    summary:
      "The sculk sensor arrives, active for 40 game ticks with a 1 tick cooldown. The lightning rod arrives with an 8 tick output. The comparator gains the clamp that stores 0 when a side signal beats the front one. Every other timing constant is unchanged from 1.16.5, including the 4 tick hopper minecart cooldown.",
    source: "SculkSensorBlock ACTIVE_TICKS 40 and COOLDOWN_TICKS 1, LightningRodBlock ACTIVATION_TICKS 8, ComparatorBlock calculateOutputSignal in mc-pipeline/work/1.18.2/src",
  },
  {
    version: "1.20.6",
    summary:
      "The sculk sensor is retimed to 30 active ticks with a 10 tick cooldown, so 1.18 era sensor circuits change behaviour. The calibrated sculk sensor arrives at 10 active ticks. The crafter arrives with a 4 tick delay and the copper bulb arrives with none at all. The hopper minecart loses its pull cooldown and jumps from 5 items a second to 20.",
    source: "SculkSensorBlock ACTIVE_TICKS 30 and COOLDOWN_TICKS 10, CalibratedSculkSensorBlock getActiveTicks 10, CrafterBlock CRAFTING_TICK_DELAY 4, CopperBulbBlock, MinecartHopper tick in mc-pipeline/work/1.20.6/src",
  },
  {
    version: "1.21.1",
    summary:
      "No timing changes. Every constant in this tool is identical to 1.20.6.",
    source: "Full diff of RepeaterBlock, ComparatorBlock, ObserverBlock, HopperBlockEntity, DispenserBlock, PistonBaseBlock, SculkSensorBlock, CrafterBlock between mc-pipeline/work/1.20.6/src and 1.21.1/src",
  },
  {
    version: "1.21.11",
    summary:
      "No timing changes to any component. The redstone wire evaluator was split out into its own package and an experimental replacement now exists, but it is gated behind the redstone experiments feature flag and the default evaluator still drops 1 strength per dust block. The hopper minecart's per tick pull is now guarded by an explicit once per tick flag, which keeps the same 20 items a second.",
    source: "DefaultRedstoneWireEvaluator and ExperimentalRedstoneWireEvaluator under world/level/redstone, RedStoneWireBlock useExperimentalEvaluator, MinecartHopper tryConsumeItems in mc-pipeline/work/1.21.11/src",
  },
  {
    version: "26.2",
    summary:
      "No timing changes. The TNT chain ignition fuse moved into a helper with a divide by zero guard, which produces the same 10 to 29 tick range for a standard 80 tick fuse. This version ships unobfuscated, so the numbers were read straight from the shipped source.",
    source: "PrimedTnt getRandomShortFuse and TntBlock in mc-pipeline/work/26.2/src",
  },
];
