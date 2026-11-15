import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { horizonAt } from "./horizon";
import { type Interval, intervalAt, parseIntervals } from "./mission";
import { strictHorizon, strictIntervals } from "./sites";
import {
  type StatusInput,
  NEAR_CROSSING,
  clearanceText,
  geometryAt,
  nearCrossingExplanation,
  selectedTimeStatus,
  signedClearance,
} from "./status";
import type { Horizon, HorizonMode, Manifest, SiteData } from "./types";

const dataDir = new URL("../public/data/", import.meta.url);
const readJson = <T,>(name: string): T => JSON.parse(readFileSync(new URL(name, dataDir), "utf-8")) as T;
const manifest = readJson<Manifest>("manifest.json");
const SITES: Record<string, SiteData> = Object.fromEntries(manifest.sites.map((e) => [e.id, readJson<SiteData>(e.file)]));
const times = SITES["im2-athena"].samples.map((s) => Date.parse(s.time_utc));
const STEP = 600_000;

function input(id: string, mode: HorizonMode): StatusInput {
  const site = SITES[id];
  return { samples: site.samples, times, horizon: strictHorizon(site, mode), intervals: parseIntervals(site, strictIntervals(site, mode)), mode };
}

// Every sample time where the instantaneous center and the 10-minute step's midpoint state
// disagree (science review 2026-11-14: terrain 0 / 5 / 5 / 2; smooth cases found by the same
// enumeration, pipeline/review/design_numbers.py section 3b). clearance = instantaneous
// center elevation - horizon, degrees.
const CASES: { site: string; mode: HorizonMode; body: "sun" | "earth"; t: string; visible: boolean; clearance: number }[] = [
  { site: "im2-athena", mode: "terrain", body: "earth", t: "2026-12-04T08:30:00Z", visible: false, clearance: 0.00022 },
  { site: "im2-athena", mode: "terrain", body: "earth", t: "2026-12-09T14:00:00Z", visible: true, clearance: -0.00012 },
  { site: "im2-athena", mode: "terrain", body: "earth", t: "2026-12-31T07:20:00Z", visible: false, clearance: 0.00037 },
  { site: "im2-athena", mode: "terrain", body: "earth", t: "2027-01-05T21:00:00Z", visible: true, clearance: -0.00133 },
  { site: "im2-athena", mode: "terrain", body: "earth", t: "2027-01-27T10:50:00Z", visible: false, clearance: 0.00111 },
  { site: "connecting-ridge-cr1", mode: "terrain", body: "sun", t: "2026-12-16T09:10:00Z", visible: false, clearance: 0.001 },
  { site: "connecting-ridge-cr1", mode: "terrain", body: "sun", t: "2026-12-24T00:00:00Z", visible: true, clearance: -0.00154 },
  { site: "connecting-ridge-cr1", mode: "terrain", body: "sun", t: "2026-12-27T08:00:00Z", visible: false, clearance: 0.00372 },
  { site: "connecting-ridge-cr1", mode: "terrain", body: "sun", t: "2027-01-05T03:30:00Z", visible: true, clearance: -0.00238 },
  { site: "connecting-ridge-cr1", mode: "terrain", body: "sun", t: "2027-01-13T05:00:00Z", visible: false, clearance: 0.00157 },
  { site: "connecting-ridge-cr1", mode: "terrain", body: "earth", t: "2026-12-15T10:30:00Z", visible: true, clearance: -0.00183 },
  { site: "connecting-ridge-cr1", mode: "terrain", body: "earth", t: "2027-01-22T19:40:00Z", visible: false, clearance: 0.00418 },
  { site: "im2-athena", mode: "smooth", body: "sun", t: "2027-01-27T22:20:00Z", visible: false, clearance: 0.00193 },
  { site: "im2-athena", mode: "smooth", body: "earth", t: "2026-12-11T05:00:00Z", visible: true, clearance: -0.00005 },
  { site: "im2-athena", mode: "smooth", body: "earth", t: "2027-01-26T15:30:00Z", visible: false, clearance: 0.00336 },
  { site: "connecting-ridge-cr1", mode: "smooth", body: "earth", t: "2026-12-26T22:30:00Z", visible: false, clearance: 0.00195 },
  { site: "connecting-ridge-cr1", mode: "smooth", body: "earth", t: "2027-01-23T08:20:00Z", visible: false, clearance: 0.00265 },
];

describe("selected-time status: the review's disagreement cases (real data)", () => {
  for (const c of CASES) {
    it(`${c.site} ${c.mode} ${c.body} ${c.t}: interval state kept, true position kept, flagged near crossing`, () => {
      const inp = input(c.site, c.mode);
      const t = Date.parse(c.t);
      const s = selectedTimeStatus(inp, t)[c.body];
      // classification semantics unchanged: exactly the exported interval state
      expect(s.visible).toBe(c.visible);
      expect(s.visible).toBe(intervalAt(inp.intervals, t)![c.body]);
      // body position not altered: the raw sample
      const k = times.indexOf(t);
      const raw = SITES[c.site].samples[k];
      expect(s.geometry.azimuthDeg).toBe(c.body === "sun" ? raw.sun_azimuth_deg : raw.earth_azimuth_deg);
      expect(s.geometry.elevationDeg).toBe(c.body === "sun" ? raw.sun_elevation_deg : raw.earth_elevation_deg);
      expect(s.geometry.clearanceDeg!).toBeCloseTo(c.clearance, 5);
      expect(s.geometry.side).toBe(c.clearance > 0 ? "above" : "below");
      expect(s.nearCrossing).toBe(true);
      expect(s.step).toEqual({ start: t, end: t + STEP });
      // one shared explanation, quoting both values
      const why = nearCrossingExplanation(s, c.body === "sun" ? "Sun" : "Earth", c.mode)!;
      expect(why.startsWith(`${NEAR_CROSSING}:`)).toBe(true);
      expect(why).toContain(c.visible ? "classified visible at its midpoint" : "classified not visible at its midpoint");
      expect(why).toContain(c.clearance > 0 ? "above the" : "below the");
      expect(why).toContain(c.mode === "terrain" ? "skyline" : "0° horizon");
      // at the step midpoint the geometry reproduces the classification (no disagreement there)
      const mid = selectedTimeStatus(inp, t + STEP / 2)[c.body];
      expect(mid.nearCrossing).toBe(false);
      expect(mid.geometry.side === "above").toBe(c.visible);
    });
  }
});

describe("selected-time status: every sample, both sites, both modes", () => {
  for (const id of Object.keys(SITES)) {
    for (const mode of ["smooth", "terrain"] as HorizonMode[]) {
      it(`${id} ${mode}: near-crossing exactly at the listed cases; state always equals the exported interval`, () => {
        const inp = input(id, mode);
        const flagged: string[] = [];
        for (let k = 0; k < times.length - 1; k++) {
          const st = selectedTimeStatus(inp, times[k]);
          for (const body of ["sun", "earth"] as const) {
            expect(st[body].visible).toBe(intervalAt(inp.intervals, times[k])![body]);
            if (st[body].nearCrossing) flagged.push(`${body} ${SITES[id].samples[k].time_utc}`);
          }
          expect(st.inCoverage).toBe(true);
        }
        const expected = CASES.filter((c) => c.site === id && c.mode === mode).map((c) => `${c.body} ${c.t}`);
        expect(flagged.sort()).toEqual(expected.sort());
      });

      it(`${id} ${mode}: at every step midpoint the instantaneous side equals the exported state`, () => {
        const inp = input(id, mode);
        let checked = 0;
        for (let k = 0; k < times.length - 1; k++) {
          const st = selectedTimeStatus(inp, times[k] + STEP / 2);
          for (const body of ["sun", "earth"] as const) {
            expect(st[body].geometry.side === "above").toBe(st[body].visible);
            expect(st[body].nearCrossing).toBe(false);
            checked++;
          }
        }
        expect(checked).toBe(2 * 8640);
      });
    }
  }
});

describe("coverage boundaries (no extrapolation)", () => {
  const inp = input("im2-athena", "terrain");
  const first = times[0];
  const last = times[times.length - 1];

  it("the first sample is a normal, known status", () => {
    const st = selectedTimeStatus(inp, first);
    expect(st.inCoverage).toBe(true);
    expect(st.sun.visible).not.toBeNull();
    expect(st.sun.unknownReason).toBeNull();
  });

  it("the final sample has a position but no step: state unknown (end of data), never borrowed from the last step", () => {
    const st = selectedTimeStatus(inp, last);
    for (const body of ["sun", "earth"] as const) {
      expect(st[body].visible).toBeNull();
      expect(st[body].unknownReason).toBe("end-of-data");
      expect(st[body].geometry.side).not.toBeNull(); // the sample itself exists
      expect(st[body].nearCrossing).toBe(false);
      expect(st[body].step).toBeNull();
    }
    expect(st.both.visible).toBeNull();
  });

  it("outside coverage nothing is computed", () => {
    for (const t of [first - 1, last + 1, first - STEP, NaN]) {
      const st = selectedTimeStatus(inp, t);
      expect(st.inCoverage).toBe(false);
      for (const body of ["sun", "earth"] as const) {
        expect(st[body].visible).toBeNull();
        expect(st[body].unknownReason).toBe("outside-coverage");
        expect(st[body].geometry).toEqual({ azimuthDeg: null, elevationDeg: null, horizonDeg: null, clearanceDeg: null, side: null });
      }
    }
  });

  it("between samples the geometry is interpolated, on the shortest azimuth path", () => {
    const k = 100;
    const a = SITES["im2-athena"].samples[k];
    const b = SITES["im2-athena"].samples[k + 1];
    const g = geometryAt(inp, "earth", times[k] + 0.3 * STEP);
    expect(g.elevationDeg!).toBeCloseTo(a.earth_elevation_deg! + 0.3 * (b.earth_elevation_deg! - a.earth_elevation_deg!), 12);
    expect(g.horizonDeg).toBe(horizonAt(inp.horizon, g.azimuthDeg!));
  });
});

describe("unknown data and wording (synthetic)", () => {
  const T0 = Date.parse("2030-01-01T00:00:00Z");
  const ts = [T0, T0 + STEP, T0 + 2 * STEP, T0 + 3 * STEP];
  const flat: Horizon = {
    model: "terrain", azimuth_deg: [0, 90, 180, 270], elevation_deg: [0.5, 0.5, null, 0.5],
    observer_height_above_surface_m: 1, interpolation: "linear_periodic", processing_notes: "synthetic",
  };
  const samples = [
    { time_utc: "", sun_azimuth_deg: 359, sun_elevation_deg: 0.6, earth_azimuth_deg: 45, earth_elevation_deg: 1 },
    { time_utc: "", sun_azimuth_deg: 1, sun_elevation_deg: 0.4, earth_azimuth_deg: 180, earth_elevation_deg: 1 },
    { time_utc: "", sun_azimuth_deg: null, sun_elevation_deg: null, earth_azimuth_deg: 180, earth_elevation_deg: 1 },
    { time_utc: "", sun_azimuth_deg: 5, sun_elevation_deg: 1, earth_azimuth_deg: 45, earth_elevation_deg: 1 },
  ];
  const intervals: Interval[] = [
    { start: ts[0], end: ts[1], sun: false, earth: null }, // Sun midpoint 0.5 at az 0: not strictly above
    { start: ts[1], end: ts[3], sun: null, earth: null },
  ];
  const inp: StatusInput = { samples, times: ts, horizon: flat, intervals, mode: "terrain" };

  it("interval unknown because the position is missing; geometry unknown, never 0", () => {
    const s = selectedTimeStatus(inp, ts[2]).sun;
    expect(s.visible).toBeNull();
    expect(s.unknownReason).toBe("position-unavailable");
    expect(s.geometry.side).toBeNull();
    expect(s.nearCrossing).toBe(false);
    expect(signedClearance(s.geometry)).toBe("unavailable");
  });

  it("interval unknown because the horizon is unknown in that direction", () => {
    const e = selectedTimeStatus(inp, ts[1]).earth;
    expect(e.unknownReason).toBe("horizon-unknown");
    expect(e.geometry.horizonDeg).toBeNull();
    expect(e.geometry.side).toBeNull();
  });

  it("wraps through north in both directions, using the strict above-horizon rule", () => {
    for (const azimuths of [[359, 1], [1, 359]]) {
      const wrapped = samples.map((s, k) => ({ ...s, sun_azimuth_deg: azimuths[k] ?? s.sun_azimuth_deg }));
      const st = selectedTimeStatus({ ...inp, samples: wrapped }, T0 + STEP / 2).sun;
      expect(st.geometry.azimuthDeg).toBe(0);
      expect(st.geometry.elevationDeg).toBe(0.5);
      expect(st.geometry.horizonDeg).toBe(0.5);
      expect(st.geometry.clearanceDeg).toBe(0);
      expect(st.geometry.side).toBe("below"); // equality is not visible
      expect(st.visible).toBe(false);
      expect(st.nearCrossing).toBe(false);
    }
  });

  it("an unknown step can have known instantaneous geometry without a crossing flag", () => {
    const s = selectedTimeStatus(inp, ts[1]).sun;
    expect(s.visible).toBeNull();
    expect(s.unknownReason).toBe("position-unavailable"); // missing next endpoint
    expect(s.geometry.side).toBe("below"); // this endpoint is available
    expect(s.nearCrossing).toBe(false);
    expect(nearCrossingExplanation(s, "Sun", "terrain")).toBeNull();
  });

  it("an explicit unknown with known midpoint geometry remains unknown", () => {
    const unknown = intervals.map((iv) => ({ ...iv, sun: null }));
    const s = selectedTimeStatus({ ...inp, intervals: unknown }, T0).sun;
    expect(s.visible).toBeNull();
    expect(s.unknownReason).toBe("state-unknown");
    expect(s.geometry.side).toBe("above");
    expect(s.nearCrossing).toBe(false);
  });

  it("an interior interval gap is state unknown, with its sample step retained", () => {
    const s = selectedTimeStatus({ ...inp, intervals: intervals.slice(1) }, T0).sun;
    expect(s.visible).toBeNull();
    expect(s.unknownReason).toBe("state-unknown");
    expect(s.step).toEqual({ start: ts[0], end: ts[1] });
    expect(s.interval).toBeNull();
    expect(s.geometry.side).toBe("above");
    expect(s.nearCrossing).toBe(false);
  });

  it("the final sample cannot borrow a state even if an interval extends past coverage", () => {
    const extended = [{ start: T0, end: ts[3] + STEP, sun: true, earth: true }];
    const st = selectedTimeStatus({ ...inp, intervals: extended }, ts[3]);
    expect(st.inCoverage).toBe(true); // position coverage includes the endpoint
    for (const body of ["sun", "earth"] as const) {
      expect(st[body].visible).toBeNull();
      expect(st[body].unknownReason).toBe("end-of-data");
      expect(st[body].step).toBeNull();
      expect(st[body].interval).toBeNull();
      expect(st[body].geometry.side).toBe("above");
      expect(st[body].nearCrossing).toBe(false);
    }
  });

  it("uses half-open steps at an interior boundary", () => {
    const before = selectedTimeStatus(inp, ts[1] - 1).sun;
    const at = selectedTimeStatus(inp, ts[1]).sun;
    expect(before.visible).toBe(false);
    expect(before.step).toEqual({ start: ts[0], end: ts[1] });
    expect(at.visible).toBeNull();
    expect(at.step).toEqual({ start: ts[1], end: ts[2] });
  });

  it("a disagreement on one body flags 'both' only when the instantaneous both differs", () => {
    // t0: Sun step false while its center is 0.1 deg above; Earth center above too
    const st = selectedTimeStatus(inp, ts[0]);
    expect(st.sun.nearCrossing).toBe(true);
    expect(st.earth.visible).toBeNull();
    expect(st.both.visible).toBe(false); // Sun false decides "both" even with Earth unknown
    expect(st.both.nearCrossing).toBe(true); // instantaneously both centers are above
    // Earth center below the horizon: "both" is false either way, so no flag on "both"
    const low = samples.map((x, k) => (k === 0 ? { ...x, earth_elevation_deg: 0.2 } : x));
    const st2 = selectedTimeStatus({ ...inp, samples: low }, ts[0]);
    expect(st2.sun.nearCrossing).toBe(true);
    expect(st2.both.nearCrossing).toBe(false);
  });

  it("clearance wording keeps tiny values visible and names the horizon", () => {
    const g = { azimuthDeg: 0, elevationDeg: 0, horizonDeg: 0, clearanceDeg: -0.00005, side: "below" as const };
    expect(clearanceText(g, "smooth")).toBe("center 0.00005° below the 0° horizon");
    expect(signedClearance(g)).toBe("−0.00005°");
    expect(signedClearance({ ...g, clearanceDeg: 0.1234, side: "above" })).toBe("+0.12°");
    expect(clearanceText({ ...g, clearanceDeg: 0.00133, side: "above" }, "terrain")).toBe("center 0.0013° above the skyline");
  });
});
