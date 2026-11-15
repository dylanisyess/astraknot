// 5B acceptance: crossing navigation over any range, repeated Next/Previous, countdown,
// overview marker states, edge indicators and parallax-free overview markers.
import { readFileSync } from "node:fs";
import * as THREE from "three";
import { describe, expect, it } from "vitest";
import { type Interval, parseIntervals } from "../mission";
import { strictHorizon, strictIntervals } from "../sites";
import { selectedTimeStatus } from "../status";
import type { SiteData } from "../types";
import { type CrossingAnchor, EVENT_LEAD_MS, MARKER_TEXT, markerState, planCrossing, transitions, untilText } from "./availability";
import { directionFromAzEl, edgePoint } from "./geometry";

const site = (id: string) => JSON.parse(readFileSync(new URL(`../../public/data/${id}.json`, import.meta.url), "utf-8")) as SiteData;
const H = 3_600_000;
const T0 = Date.parse("2026-12-01T00:00:00Z");
const grid = (hours: number) => Array.from({ length: hours * 6 + 1 }, (_, k) => T0 + k * 600_000);
const iv = (a: number, b: number, sun: boolean | null): Interval => ({ start: T0 + a * H, end: T0 + b * H, sun, earth: true });

describe("planCrossing: Next/Previous over a search range", () => {
  const times = grid(48);
  const all = [iv(0, 10, true), iv(10, 20, false), iv(20, 30, true), iv(30, 48, false)];
  const full = { start: times[0], end: times[times.length - 1] };
  const lead = H;
  const step = (selT: number, anchor: CrossingAnchor | null, dir: 1 | -1, range = full) =>
    planCrossing({ intervals: all, body: "sun", range, selT, anchor, dir, leadMs: lead, times });

  it("repeated Next advances event by event although the time sits before each crossing", () => {
    let selT = times[0];
    let anchor: CrossingAnchor | null = null;
    const seen: number[] = [];
    for (let k = 0; k < 3; k++) {
      const p = step(selT, anchor, 1);
      expect(p.kind).toBe("event");
      if (p.kind !== "event") break;
      seen.push((p.x.t - T0) / H);
      expect(p.targetT).toBe(p.x.t - lead); // short lead-in on a sample
      selT = p.targetT;
      anchor = p.anchor;
    }
    expect(seen).toEqual([10, 20, 30]);
    const end = step(selT, anchor, 1);
    expect(end).toEqual({ kind: "none", atDataEnd: true }); // the data end (48 h) is not a crossing
  });

  it("repeated Previous walks back the same way", () => {
    let selT = times[times.length - 1];
    let anchor: CrossingAnchor | null = null;
    const seen: number[] = [];
    for (;;) {
      const p = step(selT, anchor, -1);
      if (p.kind !== "event") break;
      seen.push((p.x.t - T0) / H);
      selT = p.targetT;
      anchor = p.anchor;
    }
    expect(seen).toEqual([30, 20, 10]);
  });

  it("the anchor is ignored once the time has moved (playback, scrubbing): the reference is the time itself", () => {
    const p = step(times[0], null, 1);
    if (p.kind !== "event") throw new Error("expected an event");
    const moved = p.targetT + 2 * H; // played past the 10 h crossing to 11 h
    const q = step(moved, p.anchor, -1);
    expect(q.kind === "event" && (q.x.t - T0) / H).toBe(10); // the crossing just passed
  });

  it("a mission range restricts the search; the lead-in never starts before the range", () => {
    const mission = { start: T0 + 19.5 * H, end: T0 + 29 * H };
    const p = step(mission.start, null, 1, mission);
    expect(p.kind === "event" && (p.x.t - T0) / H).toBe(20);
    expect(p.kind === "event" && p.targetT).toBe(mission.start); // clamped, on a sample
    expect(step(T0 + 25 * H, null, 1, mission)).toEqual({ kind: "none", atDataEnd: false });
  });

  it("real data, all cached data: navigation reaches events outside the mission windows", () => {
    const d = site("im2-athena");
    const ints = parseIntervals(d, strictIntervals(d, "terrain"));
    const ts = d.samples.map((x) => Date.parse(x.time_utc));
    const cov = { start: ts[0], end: ts[ts.length - 1] };
    const list = transitions(ints, "earth", cov);
    const after = list.find((x) => x.t > Date.parse("2026-12-22T00:00:00Z"))!; // beyond a 12-05 + 3 d mission
    const p = planCrossing({ intervals: ints, body: "earth", range: cov, selT: Date.parse("2026-12-16T06:00:00Z"), anchor: null, dir: 1, leadMs: EVENT_LEAD_MS.earth, times: ts });
    expect(p.kind === "event" && p.x.t).toBe(after.t);
    expect(p.kind === "event" && p.targetT).toBe(after.t - EVENT_LEAD_MS.earth);
  });
});

describe("countdown text", () => {
  it("reads the time until or since the crossing on the 10-minute grid", () => {
    expect(untilText(T0, T0 + 60 * 60_000)).toBe("in 1 h");
    expect(untilText(T0, T0 + 6 * H + 20 * 60_000)).toBe("in 6 h 20 min");
    expect(untilText(T0, T0 + 40 * 60_000)).toBe("in 40 min");
    expect(untilText(T0, T0)).toBe("now");
    expect(untilText(T0 + 20 * 60_000, T0)).toBe("20 min ago");
  });
});

describe("overview body markers", () => {
  const status = (id: string, t: string) => {
    const d = site(id);
    const ts = d.samples.map((x) => Date.parse(x.time_utc));
    return selectedTimeStatus({ samples: d.samples, times: ts, horizon: strictHorizon(d, "terrain"), intervals: parseIntervals(d, strictIntervals(d, "terrain")), mode: "terrain" }, Date.parse(t));
  };
  it("are styled from the interval state, never from the render", () => {
    const s = status("connecting-ridge-cr1", "2027-01-16T00:00:00Z");
    expect(markerState(s.sun)).toBe("below");
    expect(markerState(s.earth)).toBe("visible");
    expect(MARKER_TEXT.below).toBe("Below observer horizon");
    const end = status("connecting-ridge-cr1", "2027-01-30T00:00:00Z");
    expect(markerState(end.sun)).toBe("unknown");
    // near a crossing the marker follows the step state, like the labels
    const near = status("im2-athena", "2026-12-09T14:00:00Z");
    expect(near.earth.nearCrossing).toBe(true);
    expect(markerState(near.earth)).toBe("visible");
  });

  it("sit at the direction's vanishing point: camera translation does not move them (no parallax)", () => {
    const d = directionFromAzEl(129.7, 5.6);
    const ndc = (pos: THREE.Vector3) => {
      const cam = new THREE.PerspectiveCamera(50, 16 / 9, 0.5, 600_000);
      cam.position.copy(pos);
      cam.quaternion.setFromEuler(new THREE.Euler(-0.2, 2.2, 0, "YXZ")); // same orientation for both positions
      cam.updateMatrixWorld();
      const far = new THREE.Vector3(pos.x + d[0] * 200_000, pos.y + d[1] * 200_000, pos.z + d[2] * 200_000);
      return far.project(cam);
    };
    const a = ndc(new THREE.Vector3(-3000, 900, 2000));
    const b = ndc(new THREE.Vector3(-1500, 400, 500));
    expect(Math.abs(a.x - b.x)).toBeLessThan(1e-9);
    expect(Math.abs(a.y - b.y)).toBeLessThan(1e-9);
    // and it is the vanishing point of the observer's ray: a far point on that ray projects there too
    const cam = new THREE.PerspectiveCamera(50, 16 / 9, 0.5, 1e9);
    cam.position.set(-3000, 900, 2000);
    cam.quaternion.setFromEuler(new THREE.Euler(-0.2, 2.2, 0, "YXZ"));
    cam.updateMatrixWorld();
    const rayFar = new THREE.Vector3(d[0] * 1e8, d[1] * 1e8, d[2] * 1e8).project(cam);
    expect(Math.abs(rayFar.x - a.x)).toBeLessThan(1e-3);
    expect(Math.abs(rayFar.y - a.y)).toBeLessThan(1e-3);
  });
});

describe("edge indicators stay inside the usable viewport", () => {
  const r = { left: 330, right: 1585, top: 64, bottom: 970 };
  it("leave the inset rectangle on the side the body lies", () => {
    expect(edgePoint(960, 500, 1, 0, r)).toEqual({ x: 1585, y: 500, edge: "right" });
    expect(edgePoint(960, 500, -1, 0, r)).toEqual({ x: 330, y: 500, edge: "left" });
    expect(edgePoint(960, 500, 0, -1, r)).toEqual({ x: 960, y: 64, edge: "top" });
    const diag = edgePoint(960, 500, 1, -1, r);
    expect(diag.x).toBeLessThanOrEqual(1585);
    expect(diag.y).toBeGreaterThanOrEqual(64);
  });
});
