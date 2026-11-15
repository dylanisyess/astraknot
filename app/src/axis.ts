// Shared horizontal geometry so the elevation chart and visibility timelines
// line up exactly (same margins, same scale, same cursor x).

import { useEffect, useRef, useState } from "react";

export const PLOT = { left: 112, leftNarrow: 64, right: 24 };
const HOUR = 3_600_000;
const DAY = 86_400_000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export interface TimeScale {
  t0: number;
  t1: number;
  width: number;
  x: (t: number) => number;
  t: (x: number) => number;
  plotWidth: number;
  left: number;
}

export function timeScale(t0: number, t1: number, width: number): TimeScale {
  const left = width < 560 ? PLOT.leftNarrow : PLOT.left;
  const pw = Math.max(1, width - left - PLOT.right);
  return {
    t0,
    t1,
    width,
    left,
    plotWidth: pw,
    x: (t) => left + ((t - t0) / (t1 - t0)) * pw,
    t: (x) => t0 + ((x - left) / pw) * (t1 - t0),
  };
}

export interface Tick {
  t: number;
  label: string | null;
  major: boolean;
}

/** Daily ticks (labelled every k days so labels never crowd) or hourly ticks for short spans. */
export function timeTicks(s: TimeScale): Tick[] {
  const span = s.t1 - s.t0;
  const ticks: Tick[] = [];
  if (span <= 2 * DAY) {
    const step = (s.plotWidth < 500 ? 6 : 3) * HOUR;
    for (let t = Math.ceil(s.t0 / step) * step; t <= s.t1; t += step) {
      ticks.push({ t, label: new Date(t).toISOString().slice(11, 16), major: t % DAY === 0 });
    }
    return ticks;
  }
  const pxPerDay = s.plotWidth / (span / DAY);
  const every = [1, 2, 3, 5, 7, 10].find((k) => k * pxPerDay >= 46) ?? 14;
  const first = Math.ceil(s.t0 / DAY) * DAY;
  for (let t = first, n = 0; t <= s.t1; t += DAY, n++) {
    const d = new Date(t);
    const label = n % every === 0 ? `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}` : null;
    ticks.push({ t, label, major: label !== null });
  }
  return ticks;
}

export function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(900);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setW(Math.max(300, Math.round(e.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

/**
 * Pointer handlers that turn click/drag on an SVG into time selection.
 * A drag selects at most once per animation frame (the latest position wins): every selection
 * re-renders the whole Analysis view, and touch screens deliver pointer moves faster than a
 * phone can render, which queued seconds of work and made the page unresponsive. A press and
 * the final position are always applied, so no selection is lost.
 */
export function useTimePointer(scale: TimeScale, onSelect: (t: number) => void, onHover?: (t: number | null) => void) {
  const dragging = useRef(false);
  const pending = useRef<{ t: number; raf: number } | null>(null);
  const latest = useRef(onSelect);
  latest.current = onSelect;
  useEffect(() => () => {
    if (pending.current) cancelAnimationFrame(pending.current.raf);
  }, []);
  const flush = () => {
    const p = pending.current;
    if (!p) return;
    cancelAnimationFrame(p.raf);
    pending.current = null;
    latest.current(p.t);
  };
  const schedule = (t: number) => {
    if (pending.current) {
      pending.current.t = t;
      return;
    }
    if (typeof requestAnimationFrame === "undefined") return latest.current(t);
    pending.current = { t, raf: requestAnimationFrame(() => flush()) };
  };
  const toT = (e: React.PointerEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / Math.max(1, r.width)) * scale.width;
    return Math.min(scale.t1, Math.max(scale.t0, scale.t(px)));
  };
  const end = () => {
    if (!dragging.current) return;
    dragging.current = false;
    flush();
  };
  return {
    onPointerDown: (e: React.PointerEvent<SVGSVGElement>) => {
      dragging.current = true;
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        /* capture is optional (e.g. a synthetic or already-released pointer) */
      }
      flush();
      latest.current(toT(e));
    },
    onPointerMove: (e: React.PointerEvent<SVGSVGElement>) => {
      const t = toT(e);
      if (dragging.current) schedule(t);
      else onHover?.(t);
    },
    onPointerUp: end,
    onPointerCancel: end,
    onPointerLeave: () => onHover?.(null),
  };
}
