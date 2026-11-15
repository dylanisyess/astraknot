// Three-step guide inside Explore (non-modal, skippable). Every action uses the app's own controls
// and state (crossing navigation, the shortlist's addSite, the delay setters, the Arrival Window
// Finder); every number is the scenario's computeMetrics result or the shared selected-time
// status, formatted as elsewhere in the app. Nothing changes the scenario except a guide button
// the user presses.

import { useEffect, useRef } from "react";
import { fmtDeg, fmtUtc } from "../data";
import { type Availability, type DarkRun, type WindowMetrics, fmtOutage, fmtPct } from "../mission";
import type { ReadyScenario, SiteView } from "../scenario";
import type { GuideStep } from "../onboarding";
import { MAX_SITES } from "../urlState";

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
  /** Step 2: the recommended comparison site (catalog rule), or null. */
  compareSiteId?: string | null;
  /** Step 2: add it with the shortlist's own rules (an explicit user action). */
  onAddCompare?: () => void;
  /** Step 3: apply the delay with the app's delay setters. */
  onApplyDelay: () => void;
  /** A note about a viewing-time change the guide made (shown once). */
  note: string | null;
  /** Step 3: open the Arrival Window Finder with example inputs (never applies a result). */
  onOpenFinder?: () => void;
  finderOpened: boolean;
  /** Narrow layout: panels are stacked below the scene, not beside it. */
  narrow?: boolean;
  /** Step 1: the same action as the time bar's Play / Pause (narrow screens also bring the scene into view). */
  onPlay?: () => void;
  /** Step 1: the playback speed the crossing navigation set (e.g. "3 h/s"). */
  speedLabel?: string;
}

const TITLES: Record<GuideStep, string> = { 1: "Watch the Sun clear the ridge", 2: "Compare another site", 3: "Test a 3-day arrival delay" };

export function GuideCard(p: GuideCardProps) {
  const { sc, step } = p;
  const head = useRef<HTMLHeadingElement>(null);
  // Focus follows the guide: on start and on every step, the step heading (keyboard and screen readers land on it).
  useEffect(() => {
    head.current?.focus({ preventScroll: true });
  }, [step]);
  const v = sc.activeView;
  const name = v.profile.short;
  const nav = (
    <div className="gd-nav">
      {step > 1 && <button type="button" className="gd-btn" onClick={() => p.setStep((step - 1) as GuideStep)} data-testid="guide-back">Back</button>}
      {step < 3 ? (
        <button type="button" className="gd-btn gd-next" onClick={() => p.setStep((step + 1) as GuideStep)} data-testid="guide-next">Next</button>
      ) : (
        <button type="button" className="gd-btn gd-next" onClick={p.onFinish} data-testid="guide-finish">Done</button>
      )}
      <button type="button" className="gd-skip" onClick={p.onExit} data-testid="guide-exit">Skip guide</button>
    </div>
  );
  return (
    <section className="guide-card" aria-labelledby="guide-h" data-testid="guide" data-step={step}
      onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); p.onExit(); } }}>
      <div className="gd-head">
        <p className="gd-count">Guide · {step} of 3</p>
        {nav}
      </div>
      <h2 id="guide-h" className="gd-title" ref={head} tabIndex={-1}>{TITLES[step]}</h2>
      {step === 1 && <StepCrossing {...p} name={name} />}
      {step === 2 && <StepCompare {...p} />}
      {step === 3 && <StepDelay {...p} />}
    </section>
  );
}

function StepCrossing(p: GuideCardProps & { name: string }) {
  const { sc } = p;
  const v = sc.activeView;
  const sun = v.statusSel.sun;
  // step 1: the Sun's state at the viewing time, from the shared status (after the crossing was found)
  const sunUp = sun.visible === true;
  const g = sun.geometry;
  // the smooth-model contrast, from the same geometry: center above 0° but below the terrain skyline
  const smoothContrast = sc.mode === "terrain" && !sunUp && g.elevationDeg !== null && g.horizonDeg !== null && g.elevationDeg > 0 && g.horizonDeg > g.elevationDeg;
  return (
    <div className="gd-body">
      {!p.crossing && (
        <p className="gd-ctx" data-testid="guide-context">
          Hypothetical {sc.days}-day mission at the {v.profile.label}, arriving {fmtUtc(sc.arrival)} ({sc.mode === "terrain" ? "Terrain" : "Smooth"} model): dataset dates, not a replay of the
          historical landing.
        </p>
      )}
      {p.fatal && <p className="gd-warn">The 3D view is unavailable here ({p.fatal.replace(/\.+$/, "")}); the status, timeline and these steps still work.</p>}
      {!p.crossing ? (
        <>
          <p>Near the south pole the Sun skims the horizon, so a ridge can hide it for hours. <strong>Horizon view</strong> shows the sky from the observer’s eye, 1 m above the terrain.</p>
          <button type="button" className="gd-action" onClick={p.onTrackSun} data-testid="guide-track-sun">Show the sunrise in Horizon view</button>
        </>
      ) : (
        <>
          <p className="gd-result" data-testid="guide-crossing">
            {p.crossing.text}{p.crossing.until ? ` Crossing ${p.crossing.until}.` : ""}{p.tracking && !p.fatal ? " The view follows the Sun." : ""}
          </p>
          {smoothContrast && (
            <p className="gd-hint" data-testid="guide-smooth-contrast">
              The Smooth 0° model would already count the Sun as up: its center is {fmtDeg(g.elevationDeg, 2)} above the flat horizon, but the skyline there is {fmtDeg(g.horizonDeg, 2)}.
            </p>
          )}
          {sunUp ? (
            <p className="gd-callout gd-done" role="status" data-testid="guide-play-done">
              <span>✓ The Sun’s center has cleared the ridge: <strong>Solar-power potential</strong> reads <strong>Direct sunlight available</strong>. Pause, then Next.</span>
            </p>
          ) : (
            <p className="gd-callout" role="status" data-testid="guide-play">
              <span className="gd-play-ic" aria-hidden="true">▶</span>
              {sc.playing ? (
                <span>Playing… watch the Sun come out from behind the ridge.</span>
              ) : (
                <span>Press <strong>Play</strong> ({p.narrow ? "here or in the time bar" : "here or bottom left"}, {p.speedLabel ?? "the selected speed"}) to watch the Sun come out from behind the ridge.</span>
              )}
            </p>
          )}
          {p.onPlay && (
            <button type="button" className="gd-action" onClick={p.onPlay} aria-pressed={sc.playing} data-testid="guide-play-btn">{sc.playing ? "Pause" : "▶ Play"}</button>
          )}
        </>
      )}
    </div>
  );
}

/** Bring the Mission setup "Add site" control into view and focus it (it opens the catalog only when pressed). */
function showAddSite() {
  const b = document.querySelector<HTMLElement>(".mission-panel [data-testid=add-site]");
  b?.scrollIntoView?.({ block: "center" });
  b?.focus({ preventScroll: true });
}

function StepCompare(p: GuideCardProps) {
  const { sc } = p;
  const id = p.compareSiteId ?? null;
  const cs = id ? sc.ds.catalog.sites.find((c) => c.id === id) ?? null : null;
  const inSel = !!id && sc.selIds.includes(id);
  const blocked = id && !inSel ? sc.addBlocked(id) : null;
  const pending = id ? sc.pending.find((x) => x.id === id) : undefined;
  const rows = sc.selIds.map((x) => ({ id: x, v: sc.views.find((w) => w.entry.id === x) ?? null, short: sc.views.find((w) => w.entry.id === x)?.profile.short ?? sc.catalogSite(x).short_name }));
  return (
    <div className="gd-body">
      <p>
        <strong>+ Add site</strong> ({p.narrow ? "in Mission setup, further down" : "top left, in Mission setup"}) adds another location to the comparison: up to {MAX_SITES} sites, all with the same dates and horizon model.
        {p.narrow && (
          <>
            {" "}
            <button type="button" className="link-btn gd-link" onClick={showAddSite} data-testid="guide-show-add-site">Show me where</button>
          </>
        )}
      </p>
      {cs && !inSel && (
        blocked ? (
          <p className="gd-warn" data-testid="guide-compare-blocked">{cs.short_name} cannot be added: {blocked}. Remove a site with its ✕ to make room.</p>
        ) : (
          <p className="gd-row">
            <button type="button" className="gd-action" onClick={p.onAddCompare} data-testid="guide-add-compare">Add {cs.short_name} for comparison</button>
            <span className="gd-hint">another south-polar landing point, same window and model</span>
          </p>
        )
      )}
      {!cs && <p className="gd-hint">Use <strong>+ Add site</strong> to choose any site in the catalog.</p>}
      {inSel && pending?.state === "loading" && <p className="gd-hint" role="status">Loading {pending.short}…</p>}
      {inSel && rows.length > 1 && (
        <>
          <table className="gd-table" data-testid="guide-compare">
            <caption className="sr-only">Baseline mission, {sc.mode === "terrain" ? "Terrain" : "Smooth"} model, the same window for every site</caption>
            <thead>
              <tr><th scope="col">Site</th><th scope="col">Direct sunlight</th><th scope="col">Earth visible</th><th scope="col">Longest without sunlight</th></tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} data-row={r.id} className={r.id === sc.active ? "on" : undefined}>
                  <th scope="row">
                    <button type="button" className="gd-site" aria-pressed={r.id === sc.active} onClick={() => sc.setActive(r.id)} data-guide-site={r.id}>{r.short}</button>
                  </th>
                  {r.v ? (
                    <>
                      <td data-col="sun">{pct(r.v.base.sunPct)}</td>
                      <td data-col="earth">{pct(r.v.base.earthPct)}</td>
                      <td data-col="dark">{run(r.v.base.longestDark)}</td>
                    </>
                  ) : (
                    <td colSpan={3} className="muted">{sc.pending.find((x) => x.id === r.id)?.state === "loading" ? "loading…" : "no result in this model"}</td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
          <p className="gd-hint">
            Baseline mission, same window and model. Press a site name (or its chip, top left) to switch the 3D view and Conditions. <strong>Analysis</strong> lists every metric side by side.
          </p>
        </>
      )}
    </div>
  );
}

function deltaCell(base: Availability<number>, act: Availability<number>, applied: boolean) {
  return applied ? `${pct(base)} → ${pct(act)}` : pct(base);
}
function darkDelta(base: Availability<DarkRun | null>, act: Availability<DarkRun | null>, applied: boolean) {
  return applied ? `${run(base)} → ${run(act)}` : run(base);
}

function StepDelay(p: GuideCardProps) {
  const { sc } = p;
  const v = sc.activeView;
  const applied = sc.effDelay === p.delayDays;
  const option = sc.options.find((o) => o.days === p.delayDays);
  const views: SiteView[] = sc.selIds.map((id) => sc.views.find((w) => w.entry.id === id)).filter((w): w is SiteView => !!w);
  return (
    <div className="gd-body">
      <p><strong>Arrival</strong> sets the {sc.days}-day mission window; <strong>viewing time</strong> (bottom bar) only picks the moment shown.</p>
      {p.note && <p className="gd-note" role="status">{p.note}</p>}
      <table className="gd-table" data-testid="guide-metrics">
        <caption className="sr-only">{applied ? `Baseline → +${p.delayDays} d` : "Baseline"}, {sc.mode === "terrain" ? "Terrain" : "Smooth"} model</caption>
        <thead>
          <tr><th scope="col">{applied ? `Baseline → +${p.delayDays} d` : "Baseline"}</th><th scope="col">Direct sunlight</th><th scope="col">Earth visible</th><th scope="col">Longest without sunlight</th></tr>
        </thead>
        <tbody>
          {views.map((w) => (
            <tr key={w.entry.id} data-row={w.entry.id}>
              <th scope="row">{w.profile.short}</th>
              <td data-col="sun">{deltaCell(w.base.sunPct, w.act.sunPct, applied)}</td>
              <td data-col="earth">{deltaCell(w.base.earthPct, w.act.earthPct, applied)}</td>
              <td data-col="dark">{darkDelta(w.base.longestDark, w.act.longestDark, applied)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!applied ? (
        option?.enabled ? (
          <p className="gd-row">
            <button type="button" className="gd-action" onClick={p.onApplyDelay} data-testid="guide-apply-delay">Apply a +{p.delayDays}-day arrival delay</button>
            <span className="gd-hint">same as <strong>+{p.delayDays} d</strong> under Arrival delay</span>
          </p>
        ) : (
          <p className="gd-warn">+{p.delayDays} d is not available for this arrival: {option?.reason ?? "outside the data"}.</p>
        )
      ) : (
        <p className="gd-summary" data-testid="guide-delta">{v.profile.short}: {delaySummary(v.base, v.act, p.delayDays).filter((l) => l.startsWith("Direct sunlight") || l.startsWith("⚠")).join(" ")}</p>
      )}
      {(
        <>
          <p className="gd-hint">
            <strong>Find arrival windows</strong> (Mission setup) checks one arrival per day across the data and ranks them by sunlight and Earth visibility for the compared sites.
          </p>
          {p.onOpenFinder && (
            <button type="button" className="gd-action" onClick={p.onOpenFinder} data-testid="guide-open-finder">{p.finderOpened ? "Show Find arrival windows" : "Open Find arrival windows"}</button>
          )}
          {p.finderOpened && <p className="gd-hint">Press <strong>Find windows</strong>; nothing changes here until you choose <strong>Use this arrival</strong>.</p>}
        </>
      )}
    </div>
  );
}
