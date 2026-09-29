import { DateTime } from "luxon";
import { config } from "../config/env.js";

export type Slot = "MORNING" | "MIDDAY" | "EVENING";
export const SLOTS: Slot[] = ["MORNING", "MIDDAY", "EVENING"];

export function tz(): string {
  return config().timezone;
}

export function nowLocal(now: Date = new Date()): DateTime {
  return DateTime.fromJSDate(now, { zone: tz() });
}

/** YYYY-MM-DD in the configured timezone. */
export function localDate(now: Date = new Date()): string {
  return nowLocal(now).toISODate()!;
}

export function slotTime(date: string, slot: Slot): DateTime {
  const [h, m] = config().reports[slot].split(":").map(Number);
  return DateTime.fromISO(date, { zone: tz() }).set({ hour: h, minute: m, second: 0, millisecond: 0 });
}

export function startOfLocalDay(now: Date = new Date()): Date {
  return nowLocal(now).startOf("day").toJSDate();
}

export function startOfLocalMonth(now: Date = new Date()): Date {
  return nowLocal(now).startOf("month").toJSDate();
}

export function monthKey(now: Date = new Date()): string {
  return nowLocal(now).toFormat("yyyy-LL");
}

export function fmtLocal(d: Date | null | undefined, fmt = "dd.LL HH:mm"): string {
  if (!d) return "—";
  return DateTime.fromJSDate(d, { zone: tz() }).toFormat(fmt);
}

/** Parse an ISO string from the AI; treat offset-less values as local time. Returns null when invalid. */
export function parseAiDate(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const dt = DateTime.fromISO(iso, { zone: tz(), setZone: false });
  return dt.isValid ? dt.toJSDate() : null;
}

/** Floor a timestamp to the batch window. */
export function windowStart(d: Date, minutes: number): Date {
  const ms = minutes * 60_000;
  return new Date(Math.floor(d.getTime() / ms) * ms);
}
