// Three-step guide inside Explore (non-modal, skippable). Every action uses the app's own controls
// and state (crossing navigation, the delay setters, the Arrival Window Finder); every number is
// the scenario's computeMetrics result for the active site, formatted as elsewhere in the app.

import { useEffect, useRef } from "react";
import { fmtUtc } from "../data";
import { type Availability, type DarkRun, type WindowMetrics, fmtOutage, fmtPct } from "../mission";
import type { ReadyScenario } from "../scenario";
import type { GuideStep } from "../onboarding";

const pct = (a: Availability<number>) => (a.ok ? fmtPct(a.value) : "unavailable");
const run = (a: Availability<DarkRun | null>) => (!a.ok ? "unavailable" : !a.value ? "none" : `${fmtOutage(a.value.durationMs)}${a.value.touchesStart || a.value.touchesEnd ? " ⚠" : ""}`);

/** One-line description of what the delay changed, from the shared comparison (no fixed numbers). */
export function delaySummary(base: WindowMetrics, act: WindowMetrics, delayDays: number): string[] {
  const out: string[] = [];
  if (base.sunPct.ok && act.sunPct.ok) {
    const d = act.sunPct.value - base.sunPct.value;
    out.push(
      Math.abs(d) < 0.05
        ? `Direct sunlight is unchanged (${fmtPct(base.sunPct.value)}).`
        : `Direct sunlight ${d < 0 ? "falls" : "rises"} by ${Math.abs(d).toFixed(1)} pp: ${fmtPct(base.sunPct.value)} → ${fmtPct(act.sunPct.value)}.`,
    );
  }
  if (base.longestDark.ok && act.longestDark.ok) {
    const a = base.longestDark.value?.durationMs ?? 0;
    const b = act.longestDark.value?.durationMs ?? 0;
    if (a !== b) out.push(`The longest period without direct sunlight ${b > a ? "grows" : "shrinks"} from ${a ? fmtOutage(a) : "none"} to ${b ? fmtOutage(b) : "none"}.`);
    const e = act.longestDark.value;
    if (e && (e.touchesStart || e.touchesEnd)) out.push(`⚠ With the +${delayDays} d slip it touches the window ${e.touchesStart && e.touchesEnd ? "start and end" : e.touchesStart ? "start" : "end"}, so it may be longer than shown.`);
  }
  if (base.earthPct.ok && act.earthPct.ok) {
    const d = act.earthPct.value - base.earthPct.value;
    out.push(
      base.earthPct.value === 100 && act.earthPct.value === 100
        ? "Earth stays above the horizon through both missions, so direct-to-Earth visibility does not change."
        : Math.abs(d) < 0.05
          ? `Earth visibility is unchanged (${fmtPct(base.earthPct.value)}).`
          : `Earth visibility ${d < 0 ? "falls" : "rises"}: ${fmtPct(base.earthPct.value)} → ${fmtPct(act.earthPct.value)}.`,
    );
  }
  return out;
}

export interface GuideCardProps {
  sc: ReadyScenario;
  step: GuideStep;
  setStep: (s: GuideStep) => void;
  onExit: () => void;
  onFinish: () => void;
  /** The delay the example demonstrates (an existing option). */
  delayDays: number;
  /** Step 1: real crossing navigation to the Sun crossing in the selected mission, with tracking. */
  onTrackSun: () => void;
  /** Step 1: the crossing found by that navigation, if any (the same text as the crossing card). */
  crossing: { text: string; until: string | null } | null;
  tracking: boolean;
  /** Renderer failure message, if the 3D view is unavailable. */
  fatal: string | null;
  /** Step 2: apply the delay with the app's delay setters; returns where viewing time went. */
  onApplyDelay: () => void;
  /** A note about a viewing-time change the guide made (shown once). */
  note: string | null;
  /** Step 3: open the Arrival Window Finder with example inputs (never applies a result). */
  onOpenFinder?: () => void;
  finderOpened: boolean;
}

export function GuideCard(p: GuideCardProps) {
  const { sc, step } = p;
  const head = useRef<HTMLHeadingElement>(null);
  // Focus follows the guide: on start and on every step, the step heading (keyboard and screen readers land on it).
  useEffect(() => {
    head.current?.focus({ preventScroll: true });
  }, [step]);
  const v = sc.activeView;
  const name = v.profile.short;
  const applied = sc.effDelay === p.delayDays;
  // step 1: the Sun's state at the viewing time, from the shared status (after the crossing was found)
  const sunUp = v.statusSel.sun.visible === true;
  const option = sc.options.find((o) => o.days === p.delayDays);
  const titles: Record<GuideStep, string> = { 1: "See the terrain and horizon", 2: "Test an arrival delay", 3: "Find another arrival" };
  const nav = (
    <div className="gd-nav">
      {step > 1 && <button type="button" className="gd-btn" onClick={() => p.setStep((step - 1) as GuideStep)} data-testid="guide-back">Back</button>}
      {step < 3 ? (
        <button type="button" className="gd-btn gd-next" onClick={() => p.setStep((step + 1) as GuideStep)} data-testid="guide-next">Next</button>
      ) : (
        <button type="button" className="gd-btn gd-next" onClick={p.onFinish} data-testid="guide-finish">Continue exploring</button>
      )}
      <button type="button" className="gd-skip" onClick={p.onExit} data-testid="guide-exit">Exit guide</button>
    </div>
  );
  const cols: { k: string; label: string; f: (m: WindowMetrics) => string }[] = [
    { k: "sun", label: "Direct sunlight", f: (m) => pct(m.sunPct) },
    { k: "earth", label: "Earth visible", f: (m) => pct(m.earthPct) },
    { k: "both", label: "Sun + Earth", f: (m) => pct(m.bothPct) },
    { k: "dark", label: "Longest without sunlight", f: (m) => run(m.longestDark) },
    { k: "earth-block", label: "Longest Earth blockage", f: (m) => run(m.longestEarthBlock) },
  ];
  const rows: { k: string; label: string; m: WindowMetrics }[] = [{ k: "baseline", label: "Baseline", m: v.base }];
  if (applied) rows.push({ k: "delayed", label: `+${p.delayDays} d`, m: v.act });
  return (
    <section className="guide-card" aria-labelledby="guide-h" data-testid="guide" data-step={step}
      onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); p.onExit(); } }}>
      <div className="gd-head">
        <p className="gd-count">Guide · {step} of 3</p>
        {nav}
      </div>
      <h2 id="guide-h" className="gd-title" ref={head} tabIndex={-1}>{titles[step]}</h2>

      {step === 1 && (
        <div className="gd-body">
          {!p.crossing && <p className="gd-ctx">Hypothetical {sc.days}-day mission at the historic {name} landing site, arriving {fmtUtc(sc.arrival)}: dataset dates, not a replay of the 1972 mission.</p>}
          {!p.crossing && (
            <>
              <p>The highlighted <strong>Conditions</strong> panel shows three things at the viewing time:</p>
              <ol className="gd-conditions" data-testid="guide-conditions">
                <li><strong>Solar-power potential</strong>: is the Sun’s center above the horizon (direct sunlight)?</li>
                <li><strong>Direct-to-Earth communication window</strong>: is Earth above it?</li>
                <li><strong>Terrain screening</strong>: steep slopes within 500 m (not a safety rating).</li>
              </ol>
            </>
          )}
          <p><strong>Site overview</strong> shows the terrain from above; <strong>Horizon view</strong> shows the sky from the observer’s eye, 1 m above the surface.</p>
          {p.fatal && <p className="gd-warn">The 3D view is unavailable here ({p.fatal.replace(/\.+$/, "")}); the status, timeline and these steps still work.</p>}
          {!p.crossing ? (
            <button type="button" className="gd-action" onClick={p.onTrackSun} data-testid="guide-track-sun">Track the Sun at its crossing</button>
          ) : (
            <>
              <p className="gd-result" data-testid="guide-crossing">
                {p.crossing.text}{p.crossing.until ? ` Crossing ${p.crossing.until}.` : ""}{p.tracking && !p.fatal ? " The view follows the Sun." : ""}
              </p>
              {sunUp ? (
                <p className="gd-callout gd-done" role="status" data-testid="guide-play-done">
                  <span>✓ The Sun’s center has crossed the skyline: <strong>Solar-power potential</strong> now reads <strong>Direct sunlight available</strong>. Press <strong>Pause</strong>, then Next.</span>
                </p>
              ) : (
                <p className="gd-callout" role="status" data-testid="guide-play">
                  <span className="gd-play-ic" aria-hidden="true">▶</span>
                  {sc.playing ? (
                    <span>Playing… watch the Sun reach the skyline and <strong>Solar-power potential</strong> change.</span>
                  ) : (
                    <span>Press <strong>Play</strong> (bottom left, set to 3 h/s) to watch the sunrise. <strong>Solar-power potential</strong> turns to Direct sunlight available when the Sun’s center clears the skyline.</span>
                  )}
                </p>
              )}
            </>
          )}
        </div>
      )}

      {step === 2 && (
        <div className="gd-body">
          <p><strong>Arrival</strong> sets the {sc.days}-day mission window; <strong>viewing time</strong> (bottom bar) only picks the moment shown in 3D and Conditions.</p>
          {p.note && <p className="gd-note" role="status">{p.note}</p>}
          <table className="gd-table" data-testid="guide-metrics">
            <thead>
              <tr><th scope="col"><span className="sr-only">Mission</span></th>{cols.map((c) => <th scope="col" key={c.k}>{c.label}</th>)}</tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.k} data-row={r.k}><th scope="row">{r.label}</th>{cols.map((c) => <td key={c.k} data-col={c.k}>{c.f(r.m)}</td>)}</tr>
              ))}
            </tbody>
          </table>
          {!applied ? (
            option?.enabled ? (
              <p className="gd-row">
                <button type="button" className="gd-action" onClick={p.onApplyDelay} data-testid="guide-apply-delay">Apply a +{p.delayDays}-day arrival slip</button>
                <span className="gd-hint">same as <strong>+{p.delayDays} d</strong> under Arrival delay</span>
              </p>
            ) : (
              <p className="gd-warn">+{p.delayDays} d is not available for this arrival: {option?.reason ?? "outside the data"}.</p>
            )
          ) : (
            <p className="gd-summary" data-testid="guide-delta">{delaySummary(v.base, v.act, p.delayDays).join(" ")}</p>
          )}
        </div>
      )}

      {step === 3 && (
        <div className="gd-body">
          <p><strong>Find arrival windows</strong> checks one arrival per day across the data, ranks the best by sunlight and Earth visibility, compares sites, and previews +1/+3/+7-day slips for any result.</p>
          {p.onOpenFinder && (
            <button type="button" className="gd-action" onClick={p.onOpenFinder} data-testid="guide-open-finder">{p.finderOpened ? "Show Find arrival windows" : "Open Find arrival windows"}</button>
          )}
          {p.finderOpened && <p className="gd-hint">All four sites are selected for comparison. Press <strong>Find windows</strong>; nothing changes here until you choose <strong>Use this arrival</strong>.</p>}
        </div>
      )}
    </section>
  );
}
