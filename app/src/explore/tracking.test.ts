// Continuous body tracking (release 6, checkpoint 1): pure target/blend/summary rules,
// checked against the real exported positions (including the Sun's 359°/0° passages).
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseIntervals } from "../mission";
import { strictHorizon, strictIntervals } from "../sites";
import { type BodyStatus, selectedTimeStatus } from "../status";
import type { SiteData } from "../types";
import { azDelta } from "./geometry";
import { MAX_PITCH_DEG, blendPose, maxYawStep, trackSummary, trackTarget } from "./tracking";

const dataDir = new URL("../../public/data/", import.meta.url);
const site = (id: string) => JSON.parse(readFileSync(new URL(`${id}.json`, dataDir), "utf-8")) as SiteData;
const ATHENA = site("im2-athena");
const CR1 = site("connecting-ridge-cr1");

describe("trackTarget", () => {
  it("centres the modeled direction; yaw normalized to [0, 360)", () => {
    expect(trackTarget({ azimuthDeg: 359.95, elevationDeg: 2.5 })).toEqual({ kind: "aim", yaw: 359.95, pitch: 2.5, clamped: false });
    expect(trackTarget({ azimuthDeg: 360, elevationDeg: -1 })).toMatchObject({ kind: "aim", yaw: 0, pitch: -1 });
  });
  it("missing geometry is an explicit state, never a target", () => {
    expect(trackTarget({ azimuthDeg: null, elevationDeg: 3 })).toEqual({ kind: "missing" });
    expect(trackTarget({ azimuthDeg: 120, elevationDeg: null })).toEqual({ kind: "missing" });
    expect(trackTarget({ azimuthDeg: Number.NaN, elevationDeg: 1 })).toEqual({ kind: "missing" });
  });
  it("clamps the tilt like manual looking and reports it", () => {
    expect(trackTarget({ azimuthDeg: 10, elevationDeg: 88 })).toEqual({ kind: "aim", yaw: 10, pitch: MAX_PITCH_DEG, clamped: true });
  });
});

describe("azimuth wraparound", () => {
  it("blending 359° -> 1° passes through 0°, never the long way", () => {
    const mid = blendPose({ yaw: 359, pitch: 0 }, { yaw: 1, pitch: 0 }, 0.5);
    expect(mid.yaw).toBeCloseTo(0, 9);
    const q = blendPose({ yaw: 359, pitch: 0 }, { yaw: 1, pitch: 0 }, 0.25);
    expect(q.yaw).toBeCloseTo(359.5, 9);
    const back = blendPose({ yaw: 1, pitch: 0 }, { yaw: 359, pitch: 4 }, 0.5);
    expect(back.yaw).toBeCloseTo(0, 9);
    expect(back.pitch).toBeCloseTo(2, 9);
    for (let f = 0; f <= 1; f += 0.05) {
      const p = blendPose({ yaw: 350, pitch: 0 }, { yaw: 10, pitch: 0 }, f);
      expect(Math.abs(azDelta(350, p.yaw))).toBeLessThanOrEqual(20 + 1e-9); // never more than the 20° short arc
    }
  });
  it("real data: tracking the Sun through every 359°/0° passage changes yaw by one sample step only", () => {
    for (const s of [ATHENA, CR1]) {
      const poses = s.samples.map((x) => trackTarget({ azimuthDeg: x.sun_azimuth_deg, elevationDeg: x.sun_elevation_deg })).map((t) => {
        if (t.kind !== "aim") throw new Error("unexpected missing sample");
        return { yaw: t.yaw, pitch: t.pitch };
      });
      const wraps = poses.filter((p, i) => i > 0 && Math.abs(p.yaw - poses[i - 1].yaw) > 180).length;
      expect(wraps).toBeGreaterThanOrEqual(1); // the Sun circles the sky about twice in 60 days
      // the largest per-sample change is the Sun's own motion (~0.085° per 10 min), even at the wrap
      expect(maxYawStep(poses)).toBeLessThan(0.2);
    }
  });
  it("real data: Earth at Athena stays in its 322–339° band; tracking it never wraps", () => {
    const poses = ATHENA.samples.map((x) => ({ yaw: x.earth_azimuth_deg!, pitch: x.earth_elevation_deg! }));
    expect(maxYawStep(poses)).toBeLessThan(0.2);
    expect(Math.min(...poses.map((p) => p.yaw))).toBeGreaterThan(320);
  });
});

function statusAt(s: SiteData, mode: "smooth" | "terrain", iso: string) {
  const times = s.samples.map((x) => Date.parse(x.time_utc));
  const intervals = parseIntervals(s, strictIntervals(s, mode));
  return selectedTimeStatus({ samples: s.samples, times, horizon: strictHorizon(s, mode), intervals, mode }, Date.parse(iso));
}

describe("trackSummary (indicator text from the shared status only)", () => {
  it("visible, hidden and unknown states keep the status words and explain occlusion", () => {
    // find one visible and one hidden Sun step for Athena (terrain)
    const times = ATHENA.samples.map((x) => x.time_utc);
    let vis: BodyStatus | null = null;
    let hid: BodyStatus | null = null;
    for (let i = 0; i < times.length - 1 && (!vis || !hid); i += 37) {
      const st = statusAt(ATHENA, "terrain", times[i]).sun;
      if (st.visible === true && !st.nearCrossing && !vis) vis = st;
      if (st.visible === false && !st.nearCrossing && !hid) hid = st;
    }
    const v = trackSummary(vis!, "sun", "terrain");
    expect(v.state).toBe("visible");
    expect(v.line).toMatch(/^Sun center \d+\.\d\d° above the terrain skyline$/);
    expect(v.note).toBeNull();
    const h = trackSummary(hid!, "sun", "terrain");
    expect(h.state).toBe("hidden");
    expect(h.line).toMatch(/below the terrain skyline/);
    expect(h.note).toMatch(/Hidden by the terrain skyline/);
    // final sample: position known, state unknown (end of data)
    const end = statusAt(ATHENA, "terrain", times[times.length - 1]).earth;
    const u = trackSummary(end, "earth", "terrain");
    expect(u.state).toBe("unknown");
    expect(u.note).toMatch(/unknown/);
  });
  it("smooth mode names the 0° reference horizon", () => {
    const st = statusAt(CR1, "smooth", "2026-12-06T00:00:00Z").sun;
    expect(trackSummary(st, "sun", "smooth").line).toMatch(/0° reference horizon/);
  });
  it("near-crossing steps keep the step state and say so", () => {
    // pinned case (SCIENCE_REVIEW.md): CR1 terrain Sun 2026-12-27 08:00, step not visible, center +0.00372°
    const st = statusAt(CR1, "terrain", "2026-12-27T08:00:00Z").sun;
    expect(st.nearCrossing).toBe(true);
    const sum = trackSummary(st, "sun", "terrain");
    expect(sum.state).toBe("hidden");
    expect(sum.note).toMatch(/Near an estimated crossing/);
  });
  it("missing direction says the view is not pointing at the body", () => {
    const st = statusAt(ATHENA, "terrain", "2026-12-06T00:00:00Z").sun;
    const missing: BodyStatus = { ...st, visible: null, unknownReason: "position-unavailable", geometry: { azimuthDeg: null, elevationDeg: null, horizonDeg: null, clearanceDeg: null, side: null } };
    const sum = trackSummary(missing, "sun", "terrain");
    expect(sum.state).toBe("missing");
    expect(sum.note).toMatch(/not pointing at the Sun/);
  });
});
