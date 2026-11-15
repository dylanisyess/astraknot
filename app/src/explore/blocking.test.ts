// Site overview "blocked here" point: the exported skyline-setting terrain on the eye's line
// of sight, only when the exported status says the body is hidden by terrain.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { manifestTimes } from "../data";
import { parseIntervals } from "../mission";
import { selectedTimeStatus } from "../status";
import type { HorizonMode, Manifest, SiteData } from "../types";
import { blockingPoint, blockingText, fmtRange } from "./blocking";

const dir = new URL("../../public/data/lvn-2026-12-01-120d/", import.meta.url);
const read = <T,>(f: string): T => JSON.parse(readFileSync(new URL(f, dir), "utf-8")) as T;
const times = manifestTimes(read<Manifest>("manifest.json"));
const status = (d: SiteData, iso: string, mode: HorizonMode) =>
  selectedTimeStatus(
    { samples: d.samples, times, mode, horizon: mode === "terrain" ? d.terrain_horizon!.horizon : d.horizon, intervals: parseIntervals(d, mode === "terrain" ? d.terrain_horizon!.visibility_intervals : d.visibility_intervals) },
    Date.parse(iso),
  );

describe("blocked-view point in the Site overview", () => {
  it.each([
    ["connecting-ridge-cr1", "2026-12-22T08:30:00Z", 100, 200],
    ["im1-odysseus", "2026-12-18T06:50:00Z", 250, 450],
  ])("%s at %s: the Sun is hidden by nearby terrain on its line of sight", (id, iso, dMin, dMax) => {
    const d = read<SiteData>(`${id}.json`);
    const s = status(d, iso, "terrain");
    expect(s.sun.visible).toBe(false);
    const b = blockingPoint(d, s.sun, "terrain")!;
    expect(b).not.toBeNull();
    expect(b.distanceM).toBeGreaterThan(dMin);
    expect(b.distanceM).toBeLessThan(dMax);
    expect(b.skylineDeg).toBeGreaterThan(b.bodyDeg); // the terrain point is above the Sun's center
    // the point is on the eye's line of sight at the skyline elevation and the Sun's azimuth
    const [x, y, z] = b.position;
    expect((Math.atan2(y, Math.hypot(x, z)) * 180) / Math.PI).toBeCloseTo(b.skylineDeg, 6);
    const az = ((Math.atan2(x, -z) * 180) / Math.PI + 360) % 360;
    expect(Math.abs(((az - s.sun.geometry.azimuthDeg! + 540) % 360) - 180)).toBeLessThan(0.051);
    expect(Math.hypot(x, z)).toBeCloseTo(b.distanceM, 6);
    expect(blockingText("Sun", b).sub).toMatch(/^terrain \d+ m away rises to \d+\.\d\d°; Sun center \d+\.\d\d°$/);
    // never in the Smooth model
    expect(blockingPoint(d, status(d, iso, "smooth").sun, "smooth")).toBeNull();
  });
  it("nothing for a visible body, an unknown state or near an estimated crossing", () => {
    const d = read<SiteData>("apollo17-lm.json");
    const s = status(d, "2027-02-15T00:00:00Z", "terrain");
    expect(s.sun.visible).toBe(true);
    expect(blockingPoint(d, s.sun, "terrain")).toBeNull();
    const cr = read<SiteData>("connecting-ridge-cr1.json");
    const hidden = status(cr, "2026-12-22T08:30:00Z", "terrain").sun;
    expect(blockingPoint(cr, { ...hidden, visible: null }, "terrain")).toBeNull();
    expect(blockingPoint(cr, { ...hidden, nearCrossing: true }, "terrain")).toBeNull();
  });
  it("formats ranges", () => {
    expect(fmtRange(137)).toBe("140 m");
    expect(fmtRange(4.4)).toBe("4 m");
    expect(fmtRange(86)).toBe("86 m");
    expect(fmtRange(2350)).toBe("2.4 km");
    expect(fmtRange(49_100)).toBe("49 km");
  });
});
