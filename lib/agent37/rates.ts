/**
 * What Agent37 charges for a Brick's computer: ONE table to update when its published prices change, and the rule that turns a
 * machine's shape into a price for a minute. No network and no database in here, so the meter and the tests read the same numbers.
 *
 * Source: agent37.com/docs/agents-api/billing and instances/create, read 14 Nov 2026. Money is in millionths of a dollar ("micros").
 * A month is 730 hours. Billing is by whole minute while a machine is awake, and only its disk while it rests.
 *
 * The check on 13 Nov showed the same numbers on a real machine (awake about $0.0065 an hour for 2 CPU, 4 GB, 4 GB disk).
 */

export const AGENT37_RATES_READ_ON = '2026-11-14';
export const AGENT37_RATES_SOURCE = 'agent37.com/docs/agents-api/billing';

const HOURS_PER_MONTH = 730;
const MINUTES_PER_MONTH = HOURS_PER_MONTH * 60;

/** Per month, in micros: one vCPU, one GB of memory, one GB of disk. */
export const CPU_MONTH_MICROS = 800_000;
export const MEMORY_MONTH_MICROS = 700_000;
export const DISK_MONTH_MICROS = 90_000;
/** A disk of a computer that has been resting for a long while is moved to cold storage and costs this per GB a month. */
export const COLD_DISK_MONTH_MICROS = 30_000;

/** The compute rate of each machine type, as a multiple of the normal one. */
export const TYPE_MULTIPLIER = { default: 1, vm: 2.5, performance: 4 } as const;
export type MachineType = keyof typeof TYPE_MULTIPLIER;

/** The normal shape of a Brick's computer: the size Agent37's own Hermes starts on, and the one the plan prices. */
export const BRICK_SHAPE = { cpu: 2, memory: 4, disk: 4, type: 'default' as MachineType };

export interface Shape {
  cpu: number;
  memory: number;
  disk: number;
  type?: MachineType;
}

/** What one awake minute costs for this shape, in micros, disk included. */
export function awakeMicrosPerMinute(shape: Shape = BRICK_SHAPE): number {
  const multiplier = TYPE_MULTIPLIER[shape.type ?? 'default'];
  const compute = (shape.cpu * CPU_MONTH_MICROS + shape.memory * MEMORY_MONTH_MICROS) * multiplier;
  return (compute + shape.disk * DISK_MONTH_MICROS) / MINUTES_PER_MONTH;
}

/** What keeping the disk costs for a month while the machine rests, in micros. */
export function keptDiskMonthMicros(shape: Shape = BRICK_SHAPE): number {
  return shape.disk * DISK_MONTH_MICROS;
}

/** What a day of running costs: Agent37 refuses to make or start a machine when the wallet holds less than this. */
export function dayOfRunningMicros(shape: Shape = BRICK_SHAPE): number {
  return Math.ceil(awakeMicrosPerMinute(shape) * 60 * 24);
}
