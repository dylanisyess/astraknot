import { useState } from "react";
import { type TimeScale, timeTicks, useTimePointer } from "./axis";
import { type DarkRun, type Interval, type TimeWindow, type Tri, bothState, clip } from "./mission";
import { fmtUtc } from "./data";

export interface TimelineGroup {
  key: "baseline" | "delayed";
  label: string;
  window: TimeWindow;
  longestDark: DarkRun | null;
}

/** One site's rows: its own intervals (for the shared horizon mode) and the shared mission windows. */
export interface TimelineTrack {
  key: string;
  label: string;
  /** Short status shown after the label, e.g. the model or "provisional". */
  note?: string;
  intervals: Interval[];
  groups: TimelineGroup[];
}

interface Props {
  scale: TimeScale;
  tracks: TimelineTrack[];
  cursor: number;
  onSelect: (t: number) => void;
}

const ROWS: { key: "sun" | "earth" | "both"; label: string }[] = [
  { key: "sun", label: "Sun" },
  { key: "earth", label: "Earth" },
  { key: "both", label: "Both" },
];
const ROW_H = 16;
const ROW_GAP = 4;
const HEAD_H = 18;
const GROUP_GAP = 10;
const TRACK_H = 22;
const TRACK_GAP = 14;

const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
/** "Dec 8 00:00" (UTC) for narrow screens. */
function compactUtc(ms: number): string {
  const d = new Date(ms);
  return `${MON[d.getUTCMonth()]} ${d.getUTCDate()} ${d.toISOString().slice(11, 16)}`;
}

function stateClass(row: "sun" | "earth" | "both", s: Tri): string {
  if (s === null) return "seg seg-unknown";
  return s ? `seg seg-on seg-${row}` : "seg seg-off";
}

export function Timeline({ scale, tracks, cursor, onSelect }: Props) {
  const [hover, setHover] = useState<number | null>(null);
  const x = scale.x;
  const groupH = HEAD_H + ROWS.length * (ROW_H + ROW_GAP);
  const axisH = 22;
  const trackH = (t: TimelineTrack) => TRACK_H + t.groups.length * groupH + (t.groups.length - 1) * GROUP_GAP;
  const offsets: number[] = [];
  let acc = 0;
  for (const t of tracks) {
    offsets.push(acc);
    acc += trackH(t) + TRACK_GAP;
  }
  const height = acc - TRACK_GAP + axisH + 4;
  const plotRight = scale.left + scale.plotWidth;
  const pointer = useTimePointer(scale, onSelect, setHover);
  const ticks = timeTicks(scale);

  return (
    <svg
      width={scale.width}
      height={height}
      viewBox={`0 0 ${scale.width} ${height}`}
      className="timeline"
      role="img"
      aria-label={`Visibility timeline on one UTC axis for ${tracks.map((t) => t.label).join(" and ")}: Sun, Earth and both-visible rows for each mission window. Exact intervals are listed in the tables below.`}
      {...pointer}
    >
      <defs>
        <pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <rect width="6" height="6" className="hatch-bg" />
          <line x1="0" y1="0" x2="0" y2="6" className="hatch-line" />
        </pattern>
      </defs>
      {tracks.map((tr, ti) => {
        const ty = offsets[ti];
        return (
          <g key={tr.key} data-site={tr.key}>
            <text className="track-label" x={4} y={ty + 14}>
              {tr.label}
              {tr.note && <tspan className="track-note">{`  ${tr.note}`}</tspan>}
            </text>
            {tr.groups.map((g, gi) => {
              const gy = ty + TRACK_H + gi * (groupH + GROUP_GAP);
              const parts = clip(tr.intervals, g.window);
              return (
                <g key={g.key}>
                  <text className="group-label" x={4} y={gy + 12}>
                    {g.label}
                  </text>
                  <text className="group-range" x={plotRight} y={gy + 12} textAnchor="end">
                    {scale.left < 100
                      ? `${compactUtc(g.window.start)} → ${compactUtc(g.window.end)} UTC`
                      : `${fmtUtc(g.window.start)} → ${fmtUtc(g.window.end)}`}
                  </text>
                  {ROWS.map((row, ri) => {
                    const ry = gy + HEAD_H + ri * (ROW_H + ROW_GAP);
                    return (
                      <g key={row.key}>
                        <text className="row-label" x={scale.left - 8} y={ry + ROW_H / 2} dy="0.32em" textAnchor="end">
                          {row.label}
                        </text>
                        <rect className="row-bg" x={scale.left} y={ry} width={scale.plotWidth} height={ROW_H} rx={3} />
                        {parts.map((iv) => {
                          const s = row.key === "both" ? bothState(iv.sun, iv.earth) : iv[row.key];
                          const x0 = x(iv.start);
                          const w = Math.max(1, x(iv.end) - x0);
                          return (
                            <rect key={iv.start} className={stateClass(row.key, s)} x={x0} y={ry} width={w} height={ROW_H}>
                              <title>
                                {`${tr.label}, ${row.label}: ${s === null ? "unknown" : s ? "visible" : "not visible"}, ${fmtUtc(iv.start)} – ${fmtUtc(iv.end)} (body centers; boundaries are estimates on the 10-minute reporting grid)`}
                              </title>
                            </rect>
                          );
                        })}
                        {row.key === "sun" && g.longestDark && (
                          <g className="dark-mark">
                            <rect
                              x={x(g.longestDark.start)}
                              y={ry - 2}
                              width={Math.max(1, x(g.longestDark.end) - x(g.longestDark.start))}
                              height={ROW_H + 4}
                              className="dark-outline"
                              rx={3}
                            />
                            {g.longestDark.touchesStart && x(g.longestDark.end) - x(g.longestDark.start) > 150 && (
                              <text className="edge-flag" x={x(g.longestDark.start) + 4} y={ry + ROW_H / 2} dy="0.32em">
                                ◂ may extend before window
                              </text>
                            )}
                            {g.longestDark.touchesEnd && x(g.longestDark.end) - x(g.longestDark.start) > 150 && (
                              <text className="edge-flag" x={x(g.longestDark.end) - 4} y={ry + ROW_H / 2} dy="0.32em" textAnchor="end">
                                may extend after window ▸
                              </text>
                            )}
                          </g>
                        )}
                      </g>
                    );
                  })}
                </g>
              );
            })}
            {ti > 0 && <line className="track-sep" x1={0} x2={scale.width} y1={ty - TRACK_GAP / 2} y2={ty - TRACK_GAP / 2} />}
          </g>
        );
      })}
      {(() => {
        const ay = height - axisH;
        return (
          <g>
            <line className="axis" x1={scale.left} x2={plotRight} y1={ay} y2={ay} />
            {ticks.map((tk) => (
              <g key={tk.t}>
                <line className="axis-tick" x1={x(tk.t)} x2={x(tk.t)} y1={ay} y2={ay + (tk.label ? 5 : 3)} />
                {tk.label && (
                  <text className="tick" x={x(tk.t)} y={ay + 17} textAnchor="middle">
                    {tk.label}
                  </text>
                )}
              </g>
            ))}
          </g>
        );
      })()}
      {hover !== null && <line className="crosshair" x1={x(hover)} x2={x(hover)} y1={0} y2={height - axisH} />}
      <line className="cursor" x1={x(cursor)} x2={x(cursor)} y1={0} y2={height - axisH} />
    </svg>
  );
}
