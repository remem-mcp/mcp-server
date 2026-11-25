import { describe, expect, it } from "vitest";

import {
  addDays,
  addMonths,
  formatLocalDate,
  formatLocalTimestamp,
  getPeriodRange,
  isValidCalendarDate,
  normalizeProject,
  normalizeTags,
} from "../src/utils.js";

describe("date helpers", () => {
  it("formats local dates and timestamps", () => {
    const date = new Date(2026, 0, 5, 3, 4, 5);
    expect(formatLocalDate(date)).toBe("2026-01-05");
    expect(formatLocalTimestamp(date)).toBe("2026-01-05 03:04:05");
  });

  it("validates calendar dates", () => {
    expect(isValidCalendarDate("2026-02-28")).toBe(true);
    expect(isValidCalendarDate("2028-02-29")).toBe(true);
    expect(isValidCalendarDate("2026-02-29")).toBe(false);
    expect(isValidCalendarDate("2026-13-45")).toBe(false);
    expect(isValidCalendarDate("2026-1-5")).toBe(false);
    expect(isValidCalendarDate("")).toBe(false);
  });

  it("adds days and months across boundaries", () => {
    expect(addDays("2026-01-31", 1)).toBe("2026-02-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addMonths("2026-01-31", 1)).toBe("2026-02-28");
    expect(addMonths("2026-03-15", -3)).toBe("2025-12-15");
  });
});

describe("getPeriodRange", () => {
  it("returns the Monday-based week by default", () => {
    // 2026-01-21 is a Wednesday
    expect(getPeriodRange("weekly", "2026-01-21")).toEqual({ start: "2026-01-19", end: "2026-01-25" });
    // Sunday belongs to the week that started the previous Monday
    expect(getPeriodRange("weekly", "2026-01-25")).toEqual({ start: "2026-01-19", end: "2026-01-25" });
    expect(getPeriodRange("weekly", "2026-01-19")).toEqual({ start: "2026-01-19", end: "2026-01-25" });
  });

  it("supports Sunday-based weeks", () => {
    expect(getPeriodRange("weekly", "2026-01-21", "sunday")).toEqual({ start: "2026-01-18", end: "2026-01-24" });
    expect(getPeriodRange("weekly", "2026-01-25", "sunday")).toEqual({ start: "2026-01-25", end: "2026-01-31" });
  });

  it("handles weeks that cross a year boundary", () => {
    expect(getPeriodRange("weekly", "2026-01-01")).toEqual({ start: "2025-12-29", end: "2026-01-04" });
  });

  it("returns whole months, including leap years", () => {
    expect(getPeriodRange("monthly", "2026-01-21")).toEqual({ start: "2026-01-01", end: "2026-01-31" });
    expect(getPeriodRange("monthly", "2026-02-10")).toEqual({ start: "2026-02-01", end: "2026-02-28" });
    expect(getPeriodRange("monthly", "2028-02-10")).toEqual({ start: "2028-02-01", end: "2028-02-29" });
  });
});

describe("label normalization", () => {
  it("normalizes projects", () => {
    expect(normalizeProject("  Remem  ")).toBe("Remem");
    expect(normalizeProject("   ")).toBeNull();
    expect(normalizeProject(undefined)).toBeNull();
  });

  it("normalizes tags", () => {
    expect(normalizeTags([" review ", "#frontend", "review", "", "##"])).toEqual(["review", "frontend"]);
    expect(normalizeTags(undefined)).toEqual([]);
  });
});
