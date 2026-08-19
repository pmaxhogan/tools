import { ToolError, type ToolLogic } from "../types";

export interface BatteryLifeOpts {
  capacity: number;
  capacityUnit: string; // 'mAh' | 'Wh' | 'mWh'
  voltage: number;
  activeDraw: number;
  drawUnit: string; // 'mA' | 'mW' | 'W'
  sleepDraw: number;
  sleepDrawUnit: string; // 'mA' | 'mW' | 'W'
  activeHoursPerDay: number;
  efficiency: number;
  [key: string]: unknown;
}

export type BatteryLifeResult = Record<string, string>;

/** Convert a battery capacity reading to watt-hours. */
function capacityToWh(capacity: number, unit: string, voltage: number): number {
  switch (unit) {
    case "Wh":
      return capacity;
    case "mWh":
      return capacity / 1000;
    case "mAh":
    default:
      return (capacity / 1000) * voltage;
  }
}

/** Convert a draw reading (current or power) to watts. */
function drawToW(draw: number, unit: string, voltage: number): number {
  switch (unit) {
    case "W":
      return draw;
    case "mW":
      return draw / 1000;
    case "mA":
    default:
      return (draw / 1000) * voltage;
  }
}

/** Hours a given energy budget lasts against a constant power draw, or Infinity if there is no draw. */
function hoursAt(wh: number, powerW: number): number {
  return powerW > 0 ? wh / powerW : Infinity;
}

/** Format a duration in hours as "Xd Yh Zm", dropping zero leading units. */
export function formatDuration(hours: number): string {
  if (!isFinite(hours)) return "Unlimited (no power draw)";
  const totalMinutes = Math.round(hours * 60);
  const days = Math.floor(totalMinutes / 1440);
  const afterDays = totalMinutes - days * 1440;
  const hrs = Math.floor(afterDays / 60);
  const mins = afterDays - hrs * 60;

  if (days > 0) return mins > 0 ? `${days}d ${hrs}h ${mins}m` : `${days}d ${hrs}h`;
  if (hrs > 0) return mins > 0 ? `${hrs}h ${mins}m` : `${hrs}h`;
  return `${mins}m`;
}

export function run(_input: string, opts: BatteryLifeOpts): BatteryLifeResult {
  const capacity = Number(opts.capacity);
  const voltage = Number(opts.voltage);
  const activeDraw = Number(opts.activeDraw);
  const sleepDraw = Number(opts.sleepDraw);
  const activeHoursPerDay = Number(opts.activeHoursPerDay);
  const efficiency = Number(opts.efficiency);

  if (!Number.isFinite(capacity) || capacity <= 0 || !Number.isFinite(voltage) || voltage <= 0)
    throw new ToolError(
      "bad-input",
      "Capacity and voltage must be positive.",
      "Enter positive numbers.",
    );

  if (!Number.isFinite(activeHoursPerDay) || activeHoursPerDay < 0 || activeHoursPerDay > 24)
    throw new ToolError(
      "bad-input",
      "Active hours per day must be between 0 and 24.",
      "Enter a value between 0 and 24.",
    );

  if (!Number.isFinite(efficiency) || efficiency <= 0 || efficiency > 100)
    throw new ToolError(
      "bad-input",
      "Usable capacity percent must be between 1 and 100.",
      "Enter a value between 1 and 100.",
    );

  if (
    !Number.isFinite(activeDraw) ||
    activeDraw < 0 ||
    !Number.isFinite(sleepDraw) ||
    sleepDraw < 0
  )
    throw new ToolError(
      "bad-input",
      "Active and sleep draw must not be negative.",
      "Enter zero or a positive number.",
    );

  const nameplateWh = capacityToWh(capacity, opts.capacityUnit, voltage);
  const usableWh = nameplateWh * (efficiency / 100);
  const usableMah = (usableWh * 1000) / voltage;

  const activePowerW = drawToW(activeDraw, opts.drawUnit, voltage);
  const sleepPowerW = drawToW(sleepDraw, opts.sleepDrawUnit, voltage);

  const sleepHoursPerDay = 24 - activeHoursPerDay;
  const energyPerDayWh = activePowerW * activeHoursPerDay + sleepPowerW * sleepHoursPerDay;

  const runtimeHours = hoursAt(usableWh, energyPerDayWh / 24);
  const continuousActiveHours = hoursAt(usableWh, activePowerW);
  const continuousStandbyHours = hoursAt(usableWh, sleepPowerW);

  return {
    "Usable energy": `${usableWh.toFixed(2)} Wh (${usableMah.toFixed(0)} mAh equivalent)`,
    "Active power": `${activePowerW.toFixed(3)} W`,
    "Sleep power": `${sleepPowerW.toFixed(3)} W`,
    "Energy per day": `${energyPerDayWh.toFixed(2)} Wh/day`,
    "Estimated runtime": formatDuration(runtimeHours),
    "Continuous active": formatDuration(continuousActiveHours),
    "Continuous standby": formatDuration(continuousStandbyHours),
  };
}

export default { run } satisfies ToolLogic<string, BatteryLifeResult, BatteryLifeOpts>;
