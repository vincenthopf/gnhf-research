import { describe, expect, it } from "vitest";
import { parseUntil } from "./deadline.js";

describe("parseUntil", () => {
  const now = new Date(2026, 9, 10, 9, 30, 0);

  it("resolves HH:MM later today to today", () => {
    expect(parseUntil("17:30", now)).toEqual(new Date(2026, 9, 10, 17, 30, 0));
  });

  it("resolves HH:MM that already passed today to tomorrow", () => {
    expect(parseUntil("07:00", now)).toEqual(new Date(2026, 9, 11, 7, 0, 0));
  });

  it("accepts a single-digit hour", () => {
    expect(parseUntil("9:45", now)).toEqual(new Date(2026, 9, 10, 9, 45, 0));
  });

  it("accepts a local date and time", () => {
    expect(parseUntil("2026-10-11T06:15", now)).toEqual(
      new Date(2026, 9, 11, 6, 15, 0),
    );
  });

  it("accepts an ISO timestamp with an offset, even in the past", () => {
    expect(parseUntil("2026-10-09T20:00:00Z", now)).toEqual(
      new Date(Date.UTC(2026, 9, 9, 20, 0, 0)),
    );
  });

  it.each([
    "",
    "tomorrow",
    "25:00",
    "12:60",
    "1730",
    "2026-10-11",
    "12:00pm",
    "2026-02-30T10:00",
    "2026-10-11T24:00",
  ])("rejects %j", (value) => {
    expect(() => parseUntil(value, now)).toThrow(/HH:MM/);
  });

  it("keeps the wall-clock time when rolling over a DST change", () => {
    const dayBefore = new Date(2026, 2, 7, 23, 0, 0);
    const deadline = parseUntil("22:00", dayBefore);
    expect(deadline.getDate()).toBe(8);
    expect(deadline.getHours()).toBe(22);
    expect(deadline.getMinutes()).toBe(0);
  });
});
