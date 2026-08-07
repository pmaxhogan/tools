/**
 * Curated SMART reference data for the smartctl-analyzer tool.
 *
 * ATA attribute names follow the smartmontools drive database canon. Meanings
 * are hand written plain English, deliberately honest about vendor scaling:
 * many raw values are only comparable against the same drive over time.
 *
 * NVMe entries cover the fields smartctl prints under
 * "SMART/Health Information (NVMe Log 0x02)".
 *
 * Prose rule: no em dashes or en dashes anywhere in this file, because every
 * string here can end up in the rendered report.
 */

/** Which way a healthy raw value moves over the life of the drive. */
export type Direction =
  /** Lower raw values are better, growth is a warning sign. */
  | "lower-better"
  /** The normalized value counts down from 100 toward the threshold. */
  | "higher-better"
  /** A running total. It always climbs and that is normal. */
  | "count";

export interface AtaAttributeInfo {
  /** SMART attribute id, 1 to 254. */
  id: number;
  /** Canonical smartmontools name. */
  name: string;
  /** One sentence or two of plain English. */
  meaning: string;
  /** True when a non-zero raw value genuinely predicts drive failure. */
  isCritical: boolean;
  direction: Direction;
  /** Vendor specific naming for the same id, when it differs. */
  alsoKnownAs?: string;
}

export const ATA_ATTRIBUTES: Record<number, AtaAttributeInfo> = {
  1: {
    id: 1,
    name: "Raw_Read_Error_Rate",
    meaning:
      "How often the drive hit an error reading raw data off the platters or the flash. Seagate and WD scale this number completely differently, so a huge raw value is normal on some drives and meaningless on its own.",
    isCritical: false,
    direction: "lower-better",
  },
  3: {
    id: 3,
    name: "Spin_Up_Time",
    meaning:
      "Milliseconds the platters needed to reach full speed. Spinning drives only. A slow creep upward over months can mean a tired motor or a weak power supply.",
    isCritical: false,
    direction: "lower-better",
  },
  4: {
    id: 4,
    name: "Start_Stop_Count",
    meaning:
      "How many times the drive has spun up and back down. This is a running total, not a fault.",
    isCritical: false,
    direction: "count",
  },
  5: {
    id: 5,
    name: "Reallocated_Sector_Ct",
    meaning:
      "Sectors that went bad and were swapped for spares. Zero is ideal. A small number that never changes is survivable. Growth between checks is the real danger sign.",
    isCritical: true,
    direction: "lower-better",
  },
  7: {
    id: 7,
    name: "Seek_Error_Rate",
    meaning:
      "Errors while moving the heads to a track. Seagate encodes two counters into one raw number here, so a large value by itself is usually not a fault.",
    isCritical: false,
    direction: "lower-better",
  },
  9: {
    id: 9,
    name: "Power_On_Hours",
    meaning:
      "Total time the drive has been powered on. Most vendors log hours, a few log minutes or half hours, so an implausibly large figure usually means different units.",
    isCritical: false,
    direction: "count",
  },
  10: {
    id: 10,
    name: "Spin_Retry_Count",
    meaning:
      "Times the platters failed to spin up on the first attempt. Anything above zero points at a failing motor or insufficient power.",
    isCritical: true,
    direction: "lower-better",
  },
  12: {
    id: 12,
    name: "Power_Cycle_Count",
    meaning: "How many times the drive has been powered on. A running total, not a fault.",
    isCritical: false,
    direction: "count",
  },
  171: {
    id: 171,
    name: "Program_Fail_Count",
    meaning:
      "Flash cells that refused a write. On an SSD a steady climb means the NAND is wearing out.",
    isCritical: false,
    direction: "lower-better",
  },
  172: {
    id: 172,
    name: "Erase_Fail_Count",
    meaning:
      "Flash blocks that failed to erase. On an SSD a steady climb means the NAND is wearing out.",
    isCritical: false,
    direction: "lower-better",
  },
  173: {
    id: 173,
    name: "Wear_Leveling_Count",
    meaning:
      "Average erase cycles used per flash block. It measures wear, not damage, and the normalized value counts down for the whole life of the SSD.",
    isCritical: false,
    direction: "higher-better",
  },
  174: {
    id: 174,
    name: "Unexpect_Power_Loss_Ct",
    meaning:
      "Times the SSD lost power without a clean shutdown. High counts raise the odds of corrupted files, not of the drive dying.",
    isCritical: false,
    direction: "count",
  },
  177: {
    id: 177,
    name: "Wear_Leveling_Count",
    meaning:
      "Samsung wear gauge. The normalized value starts near 100 and counts down toward the threshold as the flash is used up, so read the value column here, not the raw one.",
    isCritical: false,
    direction: "higher-better",
    alsoKnownAs: "Samsung Wear_Leveling_Count",
  },
  179: {
    id: 179,
    name: "Used_Rsvd_Blk_Cnt_Tot",
    meaning: "Spare flash blocks already consumed across the whole SSD.",
    isCritical: false,
    direction: "lower-better",
  },
  180: {
    id: 180,
    name: "Unused_Rsvd_Blk_Cnt_Tot",
    meaning:
      "Spare flash blocks still available. This one counts down. Reaching zero means the SSD has no spares left and the next bad block is data loss.",
    isCritical: false,
    direction: "higher-better",
  },
  181: {
    id: 181,
    name: "Program_Fail_Cnt_Total",
    meaning:
      "Total flash write failures across the drive. Same story as attribute 171, counted differently by some vendors.",
    isCritical: false,
    direction: "lower-better",
  },
  182: {
    id: 182,
    name: "Erase_Fail_Count_Total",
    meaning:
      "Total flash erase failures across the drive. Same story as attribute 172, counted differently by some vendors.",
    isCritical: false,
    direction: "lower-better",
  },
  183: {
    id: 183,
    name: "Runtime_Bad_Block",
    meaning:
      "Bad blocks found while the drive was running. Some SATA drives use this id for downshift events on the link instead.",
    isCritical: false,
    direction: "lower-better",
    alsoKnownAs: "SATA_Downshift_Count on some drives",
  },
  184: {
    id: 184,
    name: "End-to-End_Error",
    meaning:
      "Data changed between the drive cache and the media and the parity check caught it. Any value above zero points at failing drive electronics.",
    isCritical: true,
    direction: "lower-better",
  },
  187: {
    id: 187,
    name: "Reported_Uncorrect",
    meaning:
      "Reads the drive could not fix with its own error correction. Large scale failure studies rate this one of the strongest predictors that a drive is on its way out.",
    isCritical: true,
    direction: "lower-better",
  },
  188: {
    id: 188,
    name: "Command_Timeout",
    meaning:
      "Commands the drive never finished in time. Often a cable or power delivery problem rather than the drive itself, but a high count deserves attention either way.",
    isCritical: true,
    direction: "lower-better",
  },
  189: {
    id: 189,
    name: "High_Fly_Writes",
    meaning:
      "Writes made while the head was flying outside its normal height. Common on Seagate drives and rarely fatal on its own.",
    isCritical: false,
    direction: "lower-better",
  },
  190: {
    id: 190,
    name: "Airflow_Temperature_Cel",
    meaning:
      "Drive temperature in Celsius from the airflow sensor. Many vendors store 100 minus the temperature in the normalized value, which is why that column looks upside down.",
    isCritical: false,
    direction: "lower-better",
  },
  192: {
    id: 192,
    name: "Power-Off_Retract_Count",
    meaning:
      "Emergency head retracts, usually after an unexpected power loss. On SSDs the same id often counts unsafe shutdowns.",
    isCritical: false,
    direction: "count",
  },
  193: {
    id: 193,
    name: "Load_Cycle_Count",
    meaning:
      "Head park and unpark cycles. Laptop and green drives with aggressive head parking can burn through their rated 300,000 cycles in a couple of years.",
    isCritical: false,
    direction: "count",
  },
  194: {
    id: 194,
    name: "Temperature_Celsius",
    meaning:
      "Current drive temperature in Celsius. The raw field usually carries the lifetime minimum and maximum in brackets after the current reading.",
    isCritical: false,
    direction: "lower-better",
  },
  195: {
    id: 195,
    name: "Hardware_ECC_Recovered",
    meaning:
      "Read errors the drive corrected on its own. A big number here is normal on Seagate and Hitachi drives and is not a fault.",
    isCritical: false,
    direction: "count",
  },
  196: {
    id: 196,
    name: "Reallocated_Event_Count",
    meaning:
      "Attempts to remap a sector, whether or not they succeeded. Read it next to attribute 5. A gap between the two means some remaps failed.",
    isCritical: true,
    direction: "lower-better",
  },
  197: {
    id: 197,
    name: "Current_Pending_Sector",
    meaning:
      "Sectors the drive cannot read and has not remapped yet. These are unreadable right now, so any value above zero means some of your data is already at risk.",
    isCritical: true,
    direction: "lower-better",
  },
  198: {
    id: 198,
    name: "Offline_Uncorrectable",
    meaning:
      "Sectors that failed the offline surface scan the drive runs on itself and could not be recovered. Any value above zero is bad news.",
    isCritical: true,
    direction: "lower-better",
  },
  199: {
    id: 199,
    name: "UDMA_CRC_Error_Count",
    meaning:
      "Data that arrived corrupted over the SATA cable and had to be resent. This almost always means a loose or bad cable, a flaky port, or a marginal power supply, not a dying drive.",
    isCritical: false,
    direction: "lower-better",
  },
  200: {
    id: 200,
    name: "Multi_Zone_Error_Rate",
    meaning:
      "Write error rate across the zones of the platter. On Western Digital drives a rising value suggests the recording surface is degrading.",
    isCritical: false,
    direction: "lower-better",
  },
  202: {
    id: 202,
    name: "Percent_Lifetime_Remain",
    meaning:
      "On Crucial and Micron SSDs this is the percentage of rated write life still left, counting down from 100. On some older hard drives the same id means Data_Address_Mark_Errs instead, so check the name smartctl printed.",
    isCritical: false,
    direction: "higher-better",
    alsoKnownAs: "Data_Address_Mark_Errs on some hard drives",
  },
  231: {
    id: 231,
    name: "SSD_Life_Left",
    meaning:
      "Kingston and SandForce controllers report remaining SSD life here, counting down from 100 toward zero. Some hard drives use the same id for temperature, so trust the name in the table.",
    isCritical: false,
    direction: "higher-better",
    alsoKnownAs: "Temperature_Celsius on some hard drives",
  },
  232: {
    id: 232,
    name: "Available_Reservd_Space",
    meaning:
      "Percentage of the reserved spare flash area still unused. It counts down, and Intel treats crossing the threshold as end of life.",
    isCritical: false,
    direction: "higher-better",
  },
  233: {
    id: 233,
    name: "Media_Wearout_Indicator",
    meaning:
      "Intel flash wear gauge. It starts at 100 and counts down as the rated erase cycles are used. At 1 the drive has used its rated write life.",
    isCritical: false,
    direction: "higher-better",
  },
  240: {
    id: 240,
    name: "Head_Flying_Hours",
    meaning:
      "Hours the heads spent actually flying over the platters, which is less than total power on hours.",
    isCritical: false,
    direction: "count",
  },
  241: {
    id: 241,
    name: "Total_LBAs_Written",
    meaning:
      "Lifetime host writes counted in logical blocks. The unit is vendor defined, so any terabyte figure derived from it is an estimate rather than a fact.",
    isCritical: false,
    direction: "count",
  },
  242: {
    id: 242,
    name: "Total_LBAs_Read",
    meaning:
      "Lifetime host reads counted in logical blocks. The unit is vendor defined, exactly like attribute 241.",
    isCritical: false,
    direction: "count",
  },
};

/** Attribute ids whose meaning does not change between vendors enough to matter. */
export const CRITICAL_IDS: number[] = Object.values(ATA_ATTRIBUTES)
  .filter((a) => a.isCritical)
  .map((a) => a.id);

export interface NvmeFieldInfo {
  /** Normalized key: lowercase, non alphanumerics collapsed to underscores. */
  key: string;
  /** Human label as smartctl prints it. */
  label: string;
  meaning: string;
}

export const NVME_FIELDS: Record<string, NvmeFieldInfo> = {
  critical_warning: {
    key: "critical_warning",
    label: "Critical Warning",
    meaning:
      "A bitmask the controller sets when something is wrong. 0x00 means no warnings. Any other value names a specific fault, decoded below.",
  },
  temperature: {
    key: "temperature",
    label: "Temperature",
    meaning:
      "Composite controller temperature in Celsius. Consumer NVMe drives throttle around 70 to 80 C, and sustained heat shortens flash life.",
  },
  available_spare: {
    key: "available_spare",
    label: "Available Spare",
    meaning:
      "Percentage of the spare flash blocks still unused. It counts down, and dropping under the threshold sets a critical warning.",
  },
  available_spare_threshold: {
    key: "available_spare_threshold",
    label: "Available Spare Threshold",
    meaning: "The spare percentage at which the controller raises a critical warning.",
  },
  percentage_used: {
    key: "percentage_used",
    label: "Percentage Used",
    meaning:
      "Vendor estimate of the rated write endurance consumed. 100% means the warranty endurance is used up, not that the drive stops working, and values above 100% are allowed.",
  },
  data_units_read: {
    key: "data_units_read",
    label: "Data Units Read",
    meaning:
      "Host reads counted in units of 1000 blocks of 512 bytes, so one unit is 512,000 bytes exactly.",
  },
  data_units_written: {
    key: "data_units_written",
    label: "Data Units Written",
    meaning:
      "Host writes counted in units of 1000 blocks of 512 bytes, so one unit is 512,000 bytes exactly. This is the number to compare against the drive rated endurance.",
  },
  host_read_commands: {
    key: "host_read_commands",
    label: "Host Read Commands",
    meaning: "Total read commands the controller has served. A workload counter, not a fault.",
  },
  host_write_commands: {
    key: "host_write_commands",
    label: "Host Write Commands",
    meaning: "Total write commands the controller has served. A workload counter, not a fault.",
  },
  controller_busy_time: {
    key: "controller_busy_time",
    label: "Controller Busy Time",
    meaning: "Minutes the controller spent with at least one command outstanding.",
  },
  power_cycles: {
    key: "power_cycles",
    label: "Power Cycles",
    meaning: "How many times the drive has been powered on.",
  },
  power_on_hours: {
    key: "power_on_hours",
    label: "Power On Hours",
    meaning: "Total hours the drive has been powered on.",
  },
  unsafe_shutdowns: {
    key: "unsafe_shutdowns",
    label: "Unsafe Shutdowns",
    meaning:
      "Power losses without a clean shutdown notification. High counts raise the risk of corrupted files and point at power or suspend problems in the host, not at a failing drive.",
  },
  media_and_data_integrity_errors: {
    key: "media_and_data_integrity_errors",
    label: "Media and Data Integrity Errors",
    meaning:
      "Unrecovered data integrity failures. This is the NVMe equivalent of uncorrectable sectors, and anything above zero means the drive has already lost data it could not rebuild.",
  },
  error_information_log_entries: {
    key: "error_information_log_entries",
    label: "Error Information Log Entries",
    meaning:
      "How many entries the controller error log holds. Aborted commands and host resets land here too, so a non-zero count is not automatically a drive fault.",
  },
  warning_comp_temperature_time: {
    key: "warning_comp_temperature_time",
    label: "Warning Comp. Temperature Time",
    meaning: "Minutes spent above the warning temperature threshold.",
  },
  critical_comp_temperature_time: {
    key: "critical_comp_temperature_time",
    label: "Critical Comp. Temperature Time",
    meaning: "Minutes spent above the critical temperature threshold, where the drive throttles.",
  },
};

/** Bit index in the NVMe Critical Warning byte to what it actually means. */
export const NVME_CRITICAL_WARNING_BITS: { bit: number; label: string; meaning: string }[] = [
  {
    bit: 0,
    label: "Spare capacity below threshold",
    meaning:
      "The pool of spare flash blocks has fallen under the vendor threshold. The drive is running out of room to retire bad blocks.",
  },
  {
    bit: 1,
    label: "Temperature out of range",
    meaning:
      "The controller is above its critical temperature or below its minimum. Check airflow and any heatsink before blaming the flash.",
  },
  {
    bit: 2,
    label: "NVM subsystem reliability degraded",
    meaning:
      "The controller has decided the media itself is no longer reliable. This is the closest thing NVMe has to a failure prediction.",
  },
  {
    bit: 3,
    label: "Media placed in read only mode",
    meaning:
      "The drive has stopped accepting writes to protect what is already stored. Copy the data off now, because this state is not reversible.",
  },
  {
    bit: 4,
    label: "Volatile memory backup failed",
    meaning:
      "The backup power that flushes the write cache on power loss has failed. Writes in flight during an outage can be lost.",
  },
  {
    bit: 5,
    label: "Persistent memory region is read only or unreliable",
    meaning:
      "The persistent memory region, when the drive has one, can no longer be trusted for writes.",
  },
];

/** One NVMe data unit is 1000 logical blocks of 512 bytes. */
export const NVME_DATA_UNIT_BYTES = 512_000;
