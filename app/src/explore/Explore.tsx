// Explore: the default view. A 3D scene of real LOLA terrain around the fixed modeled
// observer, framed around the challenge: direct sunlight (solar-power potential) and
// Earth visibility (direct-to-Earth communication windows), with a four-state mission
// timeline and guided horizon crossings. Everything scientific shown here comes from the
// shared Scenario (scenario.ts: intervals and computeMetrics) and selectedTimeStatus
// (status.ts); the 3D scene (lazy-loaded) only draws.

import { Component, type ReactNode, Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { compass, fmtDeg, fmtLat, fmtLonEast, fmtUtc, nearestIndex } from "../data";
import { type Availability, type DarkRun, type TimeWindow, fmtDuration, fmtOutage, fmtPct, fromUtcDateHour, nextChange, scenarioWindow, utcDateString, utcHour } from "../mission";
import type { ReadyScenario, Scenario, SiteView } from "../scenario";
import { MixedTerrainNotice, SiteChips } from "../SiteCatalog";
import { linkableUrl, terrainModelLabel, terrainModelShortLabel } from "../sites";
import { UserDefinedPointFacts } from "../UserDefinedPoint";
import { type BodyStatus, NEAR_CROSSING, horizonName, nearCrossingExplanation, signedClearance, unknownText } from "../status";
import type { HorizonMode } from "../types";
import type { MissionKey } from "../urlState";
import type { AssetState, CameraCommand, CameraMode } from "./TerrainScene";
import {
  AVAIL_LABEL,
  type CrossingAnchor,
  EVENT_LEAD_MS,
  PURPOSE_NOTE,
  type Segment,
  type Transition,
  availabilitySegments,
  commsStatus,
  planCrossing,
  powerStatus,
  segmentAt,
  transitionText,
  untilText,
} from "./availability";
import { diskRelation } from "./geometry";
import type { TerrainAssetMeta } from "./terrainAsset";
import type { ContextMeta } from "./contextTerrain";
import type { Vec3 } from "./geometry";
import { ScreeningRow, TerrainDetails } from "./TerrainScreening";
import { inspect, reproduceCommand, screeningView } from "./slope";
import { useSlopeAssets } from "./useSlope";
import { type TrackBody, trackSummary } from "./tracking";
import { FindWindowsButton } from "../ArrivalFinder";
import { GuideCard } from "../welcome/Guide";
import type { GuideStep } from "../onboarding";

const TerrainScene = lazy(() => import("./TerrainScene"));

const HOURS = Array.from({ length: 24 }, (_, h) => h);
/** Composed default overview distance per site (m): CR1's skyline is within 480 m, Athena's to 30 km. */
// (5C: a little closer than 5B so the 500 m assessed area is discoverable; the horizon stays in frame.)
const OVERVIEW_DIST: Record<string, number> = { "connecting-ridge-cr1": 3000, "im2-athena": 4800 };
/**
 * Playback speeds in viewing time per real second. Each tick advances `perTick` 10-minute samples,
 * at stepsPerSec / perTick ticks per second (12 h/s moves two samples per tick, so it renders no
 * more often than 6 h/s). Playback never passes its endpoint (scenario.ts playStep).
 */
export const SPEEDS = [
  { id: "10m", label: "10 min/s", stepsPerSec: 1, perTick: 1 },
  { id: "1h", label: "1 h/s", stepsPerSec: 6, perTick: 1 },
  { id: "3h", label: "3 h/s", stepsPerSec: 18, perTick: 1 },
  { id: "6h", label: "6 h/s", stepsPerSec: 36, perTick: 1 },
  { id: "12h", label: "12 h/s", stepsPerSec: 72, perTick: 2 },
] as const;
type Speed = (typeof SPEEDS)[number];
export const speedById = (id: Speed["id"]): Speed => SPEEDS.find((s) => s.id === id)!;
/** Speed when Play is first pressed. */
export const DEFAULT_SPEED: Speed = speedById("3h");
/**
 * Speed the guided example sets for its Sun crossing (the crossing controls keep their own): the
 * guide starts 3 h before the crossing (EXAMPLE.leadMs), so Play shows the event after about 1 s.
 */
export const GUIDE_SPEED: Speed = speedById("3h");
const SUN_R = 0.265;
const EARTH_R = 0.95;

function useReducedMotion() {
  const [r, setR] = useState(false);
  useEffect(() => {
    const q = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    if (!q) return;
    setR(q.matches);
    const f = () => setR(q.matches);
    q.addEventListener("change", f);
    return () => q.removeEventListener("change", f);
  }, []);
  return r;
}

/** Narrow layout: panels start collapsed so the scene stays visible. */
function useNarrow() {
  const [n, setN] = useState(false);
  useEffect(() => {
    const q = window.matchMedia?.("(max-width: 760px)");
    if (!q) return;
    setN(q.matches);
    const f = () => setN(q.matches);
    q.addEventListener("change", f);
    return () => q.removeEventListener("change", f);
  }, []);
  return n;
}

class SceneBoundary extends Component<{ onError: (m: string) => void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(e: unknown) {
    this.props.onError(e instanceof Error ? e.message : String(e));
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

export interface ExploreProps {
  sc: ReadyScenario;
  /** For tests: start with a terrain inspection point (renderer frame). */
  initialInspection?: Vec3;
  /** For tests: start with the terrain detail area open. */
  initialTerrainDetails?: boolean;
  /** For tests: start in the renderer-failure state (as after a WebGL failure). */
  initialFatal?: string;
  /** For tests: start tracking a body (Horizon view). */
  initialTrack?: TrackBody;
  /** Opens the Arrival Window Finder (App shell). */
  onFindWindows?: () => void;
  /** Guided example (onboarding): shown as a non-modal card; null/absent when not guiding. */
  guide?: ExploreGuide | null;
}

export interface ExploreGuide {
  step: GuideStep;
  setStep: (s: GuideStep) => void;
  exit: () => void;
  finish: () => void;
  /** The existing delay option the example demonstrates. */
  delayDays: number;
  /** How long before the Sun crossing the guide sets the viewing time (ms). */
  leadMs?: number;
  /** Recommended comparison site (same windows and model as every compared site), or null. */
  compareSiteId?: string | null;
  /** Opens the Arrival Window Finder with example inputs (never applies a result). */
  openFinder?: () => void;
  finderOpened: boolean;
  /** The finder drawer is open now (the card makes room for it). */
  finderOpen?: boolean;
}

interface EventMsg {
  siteId: string;
  mode: HorizonMode;
  kind: "event" | "none";
  text: string;
  x?: Transition;
}

/** The mission window shown on the timeline and searched for crossings. */
export function activeWindow(sc: Pick<Scenario, "baseW" | "actW" | "effDelay">, focus: MissionKey): { key: MissionKey; label: string; w: TimeWindow } {
  return focus === "delayed" && sc.effDelay > 0
    ? { key: "delayed", label: `Delay +${sc.effDelay} d mission`, w: sc.actW }
    : { key: "baseline", label: "Baseline mission", w: sc.baseW };
}

/** Timeline span: the scenario windows, widened to include a viewing time outside them. */
export function timelineSpan(domain: TimeWindow, selT: number): TimeWindow {
  const pad = 6 * 3_600_000;
  if (selT < domain.start) return { start: Math.max(0, selT - pad), end: domain.end };
  if (selT >= domain.end) return { start: domain.start, end: selT + pad };
  return domain;
}

export default function Explore({ sc, initialFatal, initialInspection, initialTerrainDetails, initialTrack, onFindWindows, guide }: ExploreProps) {
  const camera: CameraMode = sc.cam === "horizon" ? "eye" : "overview";
  const v = sc.activeView;
  const siteId = v.entry.id;
  // Body tracking (tracking.ts) belongs to one site: changing site clears it at once (and pauses
  // playback, scenario.ts), so nothing moves unexpectedly while that site's assets load.
  const [trackRaw, setTrackRaw] = useState<{ siteId: string; body: TrackBody } | null>(initialTrack ? { siteId, body: initialTrack } : null);
  const track: TrackBody | null = trackRaw && trackRaw.siteId === siteId && camera === "eye" ? trackRaw.body : null;
  useEffect(() => {
    if (trackRaw && (trackRaw.siteId !== siteId || camera !== "eye")) setTrackRaw(null);
  }, [siteId, camera, trackRaw]);
  const stopTracking = () => setTrackRaw(null);
  /** Switching to the Site overview stops tracking (no automatic overview tracking). */
  const setCamera = (c: CameraMode) => {
    if (c === "overview") stopTracking();
    sc.setCam(c === "eye" ? "horizon" : "overview");
  };
  const [command, setCommand] = useState<CameraCommand | null>(null);
  const [asset, setAsset] = useState<AssetState | null>(null);
  const [fatal, setFatal] = useState<string | null>(initialFatal ?? null);
  const [sceneKey, setSceneKey] = useState(0);
  const [details, setDetails] = useState(false);
  const narrow = useNarrow();
  const [setupOpen, setSetupOpen] = useState(true);
  const [condOpen, setCondOpen] = useState(true);
  useEffect(() => {
    if (narrow) setSetupOpen(false);
  }, [narrow]);
  const [speed, setSpeed] = useState<Speed>(DEFAULT_SPEED);
  const [evBody, setEvBody] = useState<"sun" | "earth">("sun");
  const [evRange, setEvRange] = useState<"mission" | "all">("mission");
  const [evMsg, setEvMsg] = useState<EventMsg | null>(null);
  const anchor = useRef<CrossingAnchor | null>(null);
  const reducedMotion = useReducedMotion();
  // 5C terrain screening: an inspection point belongs to one site and never moves the observer.
  const [inspRaw, setInsp] = useState<{ siteId: string; p: Vec3 } | null>(initialInspection ? { siteId, p: initialInspection } : null);
  const insp = inspRaw && inspRaw.siteId === siteId ? inspRaw.p : null;
  const terrainActive = sc.layer !== "surface" || insp !== null;
  // Screening loads automatically for the active site, whatever the overlay, date or model.
  // Capabilities come from the catalog: a site without an asset is never requested or substituted.
  const caps = sc.catalogSite(siteId).capabilities;
  const slopeLoad = useSlopeAssets([v.data], caps.slope_screening.available);
  const slopeState = slopeLoad.states[siteId] ?? { state: "idle" as const };
  const slopeAsset = slopeState.state === "ready" && slopeState.asset.site.id === siteId ? slopeState.asset : null;
  const screening = screeningView(slopeState, siteId, sc.slopeThr);
  const inspection = insp && slopeAsset ? inspect(slopeAsset, insp, sc.slopeThr) : null;
  const [tdOpen, setTdOpen] = useState(initialInspection !== undefined || !!initialTerrainDetails); // an inspection opens the detail area
  // Overlay changes never move the camera; only "Frame assessed area" and Reset do.
  const win = activeWindow(sc, sc.mission);
  const st = v.statusSel;

  // Playback: `perTick` 10-minute steps per tick, never past the endpoint (scenario.ts); pauses on leave.
  const stepRef = useRef(sc.playStep);
  stepRef.current = sc.playStep;
  useEffect(() => {
    if (!sc.playing) return;
    const id = window.setInterval(() => stepRef.current(speed.perTick), (1000 * speed.perTick) / speed.stepsPerSec);
    return () => window.clearInterval(id);
  }, [sc.playing, speed]);
  useEffect(() => () => sc.setPlaying(false), []); // eslint-disable-line react-hooks/exhaustive-deps

  // A crossing selection belongs to one site, model, scenario, body and range: drop it when they change.
  useEffect(() => {
    setEvMsg(null);
    anchor.current = null;
  }, [siteId, sc.mode, sc.arrival, sc.days, sc.effDelay, sc.mission, evBody, evRange, sc.applyN]);
  // An applied Arrival Window Finder result stops body tracking (the camera mode is kept).
  useEffect(() => {
    if (sc.applyN) setTrackRaw(null);
  }, [sc.applyN]);

  const cmd = (kind: CameraCommand["kind"], fov?: number) => setCommand((c) => ({ kind, n: (c?.n ?? 0) + 1, fov }));
  /** Track a body: enter the Horizon view and keep its modeled direction centred. Switching body is immediate. */
  const startTracking = (b: TrackBody) => {
    sc.setCam("horizon");
    setTrackRaw({ siteId, body: b });
  };
  /** Reset stops tracking, then restores the default view. */
  const reset = () => {
    stopTracking();
    cmd("reset");
  };
  /** Full slope map, in the Site overview, framed on the 500 m assessed area (time and mission unchanged; reduced motion: instant). */
  const slopeMapFramed = () => {
    sc.setLayer("slope");
    setCamera("overview");
    cmd("frame");
  };


  // The asset state is only meaningful for the site it was reported for.
  const assetHere = asset && asset.siteId === siteId ? asset : { state: "loading" as const, siteId };
  const meta: TerrainAssetMeta | null = assetHere.state === "ready" ? assetHere.meta : null;
  const contextMeta: ContextMeta | null = assetHere.state === "ready" && assetHere.context?.state === "ready" ? assetHere.context.meta : null;
  const msg = evMsg && evMsg.siteId === siteId && evMsg.mode === sc.mode ? evMsg : null;

  // ---------------------------------------------------------------- guided horizon crossings
  const goCrossing = (dir: 1 | -1, opts: { body?: "sun" | "earth"; range?: "mission" | "all"; fromT?: number; speed?: Speed; leadMs?: number } = {}) => {
    sc.setPlaying(false);
    const body = opts.body ?? evBody;
    const inRange = opts.range ?? evRange;
    const name = body === "sun" ? "Sun" : "Earth";
    const range = inRange === "mission" ? win.w : { start: sc.cov.start, end: sc.cov.end };
    const from = opts.fromT ?? sc.selT;
    const plan = planCrossing({ intervals: v.intervals, body, range, selT: from, anchor: opts.fromT === undefined ? anchor.current : null, dir, leadMs: opts.leadMs ?? EVENT_LEAD_MS[body], times: sc.times });
    const base = { siteId, mode: sc.mode };
    if (plan.kind === "none") {
      const where = inRange === "mission" ? `the ${win.label.toLowerCase()} (${fmtUtc(range.start)} – ${fmtUtc(range.end)})` : "the cached data";
      const endNote = plan.atDataEnd ? ` The data ends ${fmtUtc(sc.cov.end)}; that is not a crossing.` : "";
      setEvMsg({ ...base, kind: "none", text: `No ${dir === 1 ? "later" : "earlier"} ${name} crossing in ${where}.${endNote}` });
      return;
    }
    sc.setSel(nearestIndex(sc.times, plan.targetT));
    anchor.current = plan.anchor;
    setSpeed(opts.speed ?? speedById(body === "sun" ? "10m" : "1h"));
    // Crossing navigation tracks the event's body. A first engagement frames the crossing
    // (narrower field of view); while already tracking, the user's field of view is kept.
    if (!track) cmd("fov", body === "sun" ? 10 : 18);
    startTracking(body);
    setEvMsg({ ...base, kind: "event", text: transitionText(plan.x, sc.mode), x: plan.x });
  };
  const jumpToCrossing = () => {
    if (!msg?.x) return;
    sc.setPlaying(false);
    sc.setSel(nearestIndex(sc.times, msg.x.t));
    anchor.current = null;
  };

  // ---------------------------------------------------------------- guided example (onboarding)
  const [guideNote, setGuideNote] = useState<string | null>(null);
  /** Step 1: the Sun crossing of the selected mission, found from its start by the crossing navigation. */
  const guideTrackSun = () => {
    // body and range are passed explicitly: changing the crossing controls' state would clear the result
    goCrossing(1, { body: "sun", range: "mission", fromT: win.w.start, speed: GUIDE_SPEED, leadMs: guide?.leadMs });
    showStage();
  };
  /** Narrow screens stack the card below the scene: bring the scene (and the Sun in it) into view. */
  const stageRef = useRef<HTMLDivElement>(null);
  const showStage = () => {
    if (!narrow) return;
    window.setTimeout(() => stageRef.current?.scrollIntoView?.({ block: "start", behavior: reducedMotion ? "auto" : "smooth" }), 0);
  };
  const guidePlay = () => {
    if (sc.playing) return sc.setPlaying(false);
    sc.setPlaying(true);
    showStage();
  };
  /** Changing step pauses playback; entering step 2 brings the viewing time back into the mission. */
  const guideSetStep = (s: GuideStep) => {
    if (!guide) return;
    sc.setPlaying(false);
    setGuideNote(null);
    if (s === 3 && (sc.selT < win.w.start || sc.selT >= win.w.end)) {
      sc.setSel(nearestIndex(sc.times, win.w.start));
      setGuideNote(`Viewing time was outside the ${win.label.toLowerCase()}; it is back at its start, ${fmtUtc(win.w.start)}.`);
    }
    // narrow screens: the delay buttons and Find arrival windows are in the collapsed setup panel
    if (s === 3 && narrow) setSetupOpen(true);
    guide.setStep(s);
  };
  /** Step 2: add the recommended comparison site (an explicit action; the shortlist rules apply). */
  const guideAddCompare = () => {
    const id = guide?.compareSiteId;
    if (!id || sc.selIds.includes(id) || sc.addBlocked(id)) return;
    sc.addSite(id);
  };
  /** Step 2: the same state change as the Arrival delay button, then viewing time into that mission. */
  const guideApplyDelay = () => {
    if (!guide) return;
    const d = guide.delayDays;
    const w = scenarioWindow(sc.arrival, d, sc.durationMs);
    sc.setDelay(d);
    sc.setMission("delayed");
    if (sc.selT < w.start || sc.selT >= w.end) {
      sc.setSel(nearestIndex(sc.times, w.start));
      setGuideNote(`Viewing time moved to the +${d} d arrival, ${fmtUtc(w.start)}; the baseline arrival is unchanged.`);
    }
  };
  const guideCrossing = msg ? { text: msg.text, until: msg.x ? untilText(sc.selT, msg.x.t) : null } : null;

  return (
    <main className="explore" id="explore" data-site={siteId} data-camera={camera} data-mode={sc.mode} data-tracking={track ?? undefined}
      data-guide-step={guide ? guide.step : undefined} data-guide-hint={guide && guide.step === 1 ? (msg ? (v.statusSel.sun.visible === true ? "done" : "play") : "conditions") : undefined} data-guide-finder={guide?.finderOpen ? "open" : undefined}>
      <div className="stage" ref={stageRef}>
        {!caps.terrain_3d.available ? (
          <div className="scene-message" role="status" data-testid="no-3d">
            <strong>No 3D terrain for {v.profile.short}.</strong>
            <span>{caps.terrain_3d.reason}. No other terrain is shown in its place.</span>
            <span>Status, the timeline and the full comparison in Analysis still work.</span>
            <div className="msg-actions">
              <button type="button" className="primary" onClick={() => sc.setView("analysis")}>Open Analysis</button>
            </div>
          </div>
        ) : fatal ? (
          <div className="scene-message scene-error" role="alert" data-testid="scene-fatal">
            <strong>The 3D view is unavailable.</strong>
            <span>{fatal}</span>
            <span>Status, controls and the full comparison in Analysis still work.</span>
            <div className="msg-actions">
              <button type="button" onClick={() => { setFatal(null); setSceneKey((k) => k + 1); }}>Try again</button>
              <button type="button" className="primary" onClick={() => sc.setView("analysis")}>Open Analysis</button>
            </div>
          </div>
        ) : (
          <SceneBoundary key={sceneKey} onError={(m) => setFatal(`The renderer failed: ${m}`)}>
            <Suspense fallback={<div className="scene-message" role="status">Loading 3D renderer…</div>}>
              <TerrainScene
                key={sceneKey}
                site={v.data}
                siteShort={v.profile.short}
                mode={sc.mode}
                status={st}
                camera={camera}
                command={command}
                lookAz={v.profile.panoramaCenterAz}
                overviewDist={OVERVIEW_DIST[siteId] ?? 3000}
                reducedMotion={reducedMotion}
                onAssetState={setAsset}
                onFatal={setFatal}
                onLook={(b) => startTracking(b)}
                track={track}
                onTrackBreak={stopTracking}
                layer={sc.layer}
                slope={slopeAsset}
                thresholdDeg={sc.slopeThr}
                inspection={insp}
                inspectEnabled={sc.layer !== "surface"}
                onInspect={(p) => {
                  setInsp({ siteId, p });
                  setTdOpen(true); // inspection results use the terrain detail area
                }}
                showRings={terrainActive}
                layoutKey={`${sc.layer}|${sc.slopeThr}|${tdOpen}|${slopeState.state}|${condOpen}|${setupOpen}|${guide?.step ?? 0}|${guideNote ? 1 : 0}|${msg ? 1 : 0}|${sc.effDelay}`}
              />
            </Suspense>
          </SceneBoundary>
        )}
        <ViewToolbar camera={camera} setCamera={setCamera} onReset={reset} track={track} onTrack={(b) => (track === b ? stopTracking() : startTracking(b))} />
        {track && <TrackIndicator body={track} s={st[track]} mode={sc.mode} reducedMotion={reducedMotion} onStop={stopTracking} />}
        {!fatal && caps.terrain_3d.available && assetHere.state === "loading" && (
          <div className="scene-toast" role="status" data-testid="asset-loading">
            <span className="spinner" aria-hidden="true" /> Loading {v.profile.short} terrain…
          </div>
        )}
        {!fatal && caps.terrain_3d.available && assetHere.state === "error" && (
          <div className="scene-message scene-error" role="alert" data-testid="asset-error">
            <strong>{v.profile.short} terrain could not be loaded.</strong>
            <span>{assetHere.message}</span>
            <span>No other terrain is substituted. Status and Analysis are unaffected.</span>
            <div className="msg-actions">
              <button type="button" onClick={() => setSceneKey((k) => k + 1)}>Retry</button>
              <button type="button" className="primary" onClick={() => sc.setView("analysis")}>Open Analysis</button>
            </div>
          </div>
        )}
        {sc.mode === "smooth" && assetHere.state !== "loading" && !fatal && (
          <p className="stage-note" role="note" data-testid="smooth-note">
            <strong>Smooth model:</strong> status uses the 0° horizontal reference; terrain is context only and hides nothing.
          </p>
        )}
        {msg && !guide && <EventCard msg={msg} selT={sc.selT} onJump={jumpToCrossing} onClose={() => setEvMsg(null)} outsideMission={msg.x ? msg.x.t < win.w.start || msg.x.t >= win.w.end : false} />}
        <SceneLegend camera={camera} mode={sc.mode} meta={meta} context={contextMeta} />
      </div>

      {guide && (
        <GuideCard
          sc={sc}
          step={guide.step}
          setStep={guideSetStep}
          onExit={guide.exit}
          onFinish={guide.finish}
          delayDays={guide.delayDays}
          onTrackSun={guideTrackSun}
          crossing={guideCrossing}
          tracking={track === "sun"}
          fatal={fatal ?? (!caps.terrain_3d.available ? caps.terrain_3d.reason : assetHere.state === "error" ? assetHere.message : null)}
          onApplyDelay={guideApplyDelay}
          compareSiteId={guide.compareSiteId ?? null}
          onAddCompare={guideAddCompare}
          note={guideNote}
          onOpenFinder={guide.openFinder}
          finderOpened={guide.finderOpened}
          narrow={narrow}
          onPlay={guidePlay}
          speedLabel={speed.label}
        />
      )}
      <MissionPanel sc={sc} focus={win.key} open={setupOpen} onToggle={() => setSetupOpen((o) => !o)} onFindWindows={onFindWindows} />
      <div className="right-col">
        <ConditionsPanel
          v={v}
          st={st}
          mode={sc.mode}
          open={condOpen}
          onToggle={() => setCondOpen((o) => !o)}
          onDetails={() => setDetails(true)}
          compact={tdOpen}
          terrain={
            <>
              {!caps.slope_screening.available ? (
                <div className="ts-row small" data-testid="screening-unavailable">
                  <p><strong>Terrain screening: not available for {v.profile.short}.</strong> {caps.slope_screening.reason}.</p>
                </div>
              ) : (
              <ScreeningRow
                view={screening}
                siteShort={v.profile.short}
                layer={sc.layer}
                thresholdDeg={sc.slopeThr}
                detailsOpen={tdOpen}
                onDetails={() => setTdOpen((o) => !o)}
                onSlopeMap={slopeMapFramed}
                onSteep={() => sc.setLayer("exceed")}
                onRetry={slopeLoad.retry}
              />
              )}
              {tdOpen && caps.slope_screening.available && (
                <TerrainDetails
                  state={slopeAsset ? slopeState : { state: "loading" }}
                  siteShort={v.profile.short}
                  provisional={v.profile.provisionalTerrain}
                  layer={sc.layer}
                  setLayer={sc.setLayer}
                  camera={camera}
                  thresholdDeg={sc.slopeThr}
                  setThreshold={sc.setSlopeThr}
                  inspection={inspection}
                  hasInspection={insp !== null}
                  onClearInspection={() => setInsp(null)}
                  onClose={() => setTdOpen(false)}
                />
              )}
            </>
          }
        />
      </div>
      <TimeBar
        sc={sc}
        win={win}
        speed={speed}
        setSpeed={setSpeed}
        evBody={evBody}
        setEvBody={setEvBody}
        evRange={evRange}
        setEvRange={setEvRange}
        onCrossing={goCrossing}
        onJumpMission={() => { setEvMsg(null); anchor.current = null; }}
      />
      {details && <DetailsSheet v={v} mode={sc.mode} meta={meta} assetState={assetHere} contextMeta={contextMeta} onClose={() => setDetails(false)} onAnalysis={() => sc.setView("analysis")} />}
    </main>
  );
}

function EventCard({ msg, selT, onJump, onClose, outsideMission }: { msg: EventMsg; selT: number; onJump: () => void; onClose: () => void; outsideMission: boolean }) {
  return (
    <div className={`event-card event-${msg.kind}`} role="status" data-testid="event-card">
      <p>{msg.text}</p>
      {msg.x && (
        <p className="event-meta small">
          <span className="num" data-field="until">Crossing {untilText(selT, msg.x.t)}</span>
          {outsideMission && <span className="ev-outside">Outside selected mission</span>}
          <span className="muted">Estimated on the 10-minute grid.</span>
          <button type="button" className="tool-btn compact" onClick={onJump} data-testid="jump-crossing">Jump to crossing</button>
        </p>
      )}
      <button type="button" className="icon-btn ev-close" aria-label="Dismiss" onClick={onClose}>✕</button>
    </div>
  );
}

// ------------------------------------------------------------------ icons (inline, labelled by their buttons)

const Icon = {
  sun: <svg viewBox="0 0 16 16" aria-hidden="true" className="ic"><circle cx="8" cy="8" r="3.2" /><path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6 13 13M3 13l1.4-1.4M11.6 4.4 13 3" /></svg>,
  earth: <svg viewBox="0 0 16 16" aria-hidden="true" className="ic"><circle cx="8" cy="8" r="6" /><path d="M2.5 6.5c2 .8 3.5.2 4.8 1.4s.4 3 2 3.8 2.6-.3 4.2.3M6.5 2.2c.6 1.3 2.2 1.6 3.6 1.1" /></svg>,
  panel: <svg viewBox="0 0 20 20" aria-hidden="true" className="ic ic-lg"><path d="M3 12.5 6 4h11l-3 8.5z" /><path d="M7.8 4 5.6 12.5M11.6 4 9.6 12.5M4.6 8.2h11" /><path d="M10 12.5V17M6.5 17h7" /></svg>,
  antenna: <svg viewBox="0 0 20 20" aria-hidden="true" className="ic ic-lg"><path d="M4.5 5.5a7 7 0 0 0 9.9 9.9z" /><path d="M9.5 10.5 14 6" /><circle cx="14.6" cy="5.4" r="1" /><path d="M7 15.5 5 18h7" /></svg>,
  orbit: <svg viewBox="0 0 16 16" aria-hidden="true" className="ic"><ellipse cx="8" cy="9" rx="6.5" ry="2.8" /><path d="M8 9V3.5" /><circle cx="8" cy="3" r="1.1" /></svg>,
  eye: <svg viewBox="0 0 16 16" aria-hidden="true" className="ic"><path d="M1 8s2.6-4.5 7-4.5S15 8 15 8s-2.6 4.5-7 4.5S1 8 1 8z" /><circle cx="8" cy="8" r="2.2" /></svg>,
  reset: <svg viewBox="0 0 16 16" aria-hidden="true" className="ic"><path d="M3 8a5 5 0 1 0 1.5-3.6M3 2.5v2.5h2.5" /></svg>,
  play: <svg viewBox="0 0 16 16" aria-hidden="true" className="ic ic-fill"><path d="M5 3.2v9.6L12.5 8z" /></svg>,
  pause: <svg viewBox="0 0 16 16" aria-hidden="true" className="ic ic-fill"><path d="M4.5 3h2.4v10H4.5zM9.1 3h2.4v10H9.1z" /></svg>,
  info: <svg viewBox="0 0 16 16" aria-hidden="true" className="ic"><circle cx="8" cy="8" r="6.3" /><path d="M8 7.2V11.5M8 4.6v.1" /></svg>,
  chevron: <svg viewBox="0 0 16 16" aria-hidden="true" className="ic"><path d="M4 6l4 4 4-4" /></svg>,
  prev: <svg viewBox="0 0 16 16" aria-hidden="true" className="ic"><path d="M10 3.5 5.5 8l4.5 4.5" /></svg>,
  next: <svg viewBox="0 0 16 16" aria-hidden="true" className="ic"><path d="M6 3.5 10.5 8 6 12.5" /></svg>,
};


// ------------------------------------------------------------------ mission setup (left)

/** "2026-12-05 00:00 → 12-19 00:00 UTC" (year once). */
function shortRange(w: { start: number; end: number }) {
  const a = new Date(w.start).toISOString();
  const b = new Date(w.end).toISOString();
  return `${a.slice(0, 10)} ${a.slice(11, 16)} → ${b.slice(0, 4) === a.slice(0, 4) ? b.slice(5, 10) : b.slice(0, 10)} ${b.slice(11, 16)} UTC`;
}

const ABOUT_KEY = "lvn.siteAboutOpen";
function useSessionFlag(key: string): [boolean, (v: boolean) => void] {
  const [v, setV] = useState(() => {
    try {
      return typeof sessionStorage !== "undefined" && sessionStorage.getItem(key) === "1";
    } catch {
      return false;
    }
  });
  return [
    v,
    (x: boolean) => {
      setV(x);
      try {
        sessionStorage.setItem(key, x ? "1" : "0");
      } catch {
        /* storage unavailable: keep the in-memory state */
      }
    },
  ];
}

function MissionPanel({ sc, focus, open, onToggle, onFindWindows }: { sc: ReadyScenario; focus: MissionKey; open: boolean; onToggle: () => void; onFindWindows?: () => void }) {
  const [aboutOpen, setAboutOpen] = useSessionFlag(ABOUT_KEY);
  const v = sc.activeView;
  const meta = v.data.site;
  const arrivalDate = utcDateString(sc.arrival);
  const provisional = v.profile.provisionalTerrain;
  return (
    <section className={open ? "panel mission-panel" : "panel mission-panel collapsed"} aria-label="Mission setup">
      <div className="panel-head">
        <h2 className="panel-title">Mission setup</h2>
        <button type="button" className="icon-btn panel-toggle" aria-expanded={open} onClick={onToggle} aria-label={open ? "Collapse mission setup" : "Expand mission setup"}>
          {Icon.chevron}
        </button>
      </div>
      <div className="panel-sitebar">
        <SiteChips sc={sc} theme="explore" />
        {provisional && (
          <p className="badge-prov" data-field="provisional" title="CR1's terrain result is highly sensitive to near-field relief, the terrain model, eye height and position. See Details.">
            {provisional}
          </p>
        )}
      </div>
      {open && (
        <div className="panel-body">
          <details className="site-about" open={aboutOpen} onToggle={(e) => setAboutOpen((e.currentTarget as HTMLDetailsElement).open)}>
            <summary data-field="site-name" title={v.profile.label}>About {v.profile.short}</summary>
            <p className="small"><strong>{v.profile.label}</strong></p>
            <p className="small">{v.profile.kind}.</p>
            <p className="small num">{fmtLat(meta.latitude_deg)}, {fmtLonEast(meta.longitude_deg_east)}</p>
            {v.profile.pointSource === "user-defined" && <UserDefinedPointFacts site={v.data} />}
          </details>
          <div className="ctl ctl-inline">
            <span className="ctl-label" id="lbl-model">Horizon model</span>
            <div className="seg" role="radiogroup" aria-labelledby="lbl-model">
              {(["smooth", "terrain"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  role="radio"
                  aria-checked={sc.mode === m}
                  className={sc.mode === m ? "seg-b on" : "seg-b"}
                  title={m === "terrain" && !sc.avail.terrain ? `No terrain horizon for ${sc.avail.missing.map((x) => x.id).join(", ")}` : m === "smooth" ? "0° horizontal reference; terrain ignored" : "Terrain skyline"}
                  onClick={() => sc.setMode(m)}
                  data-mode-btn={m}
                >
                  {m === "smooth" ? "Smooth 0°" : "Terrain"}
                </button>
              ))}
            </div>
          </div>
          <MixedTerrainNotice sc={sc} />
          <div className="ctl-row">
            <label className="ctl grow">
              <span className="ctl-label">Baseline arrival (UTC)</span>
              <input
                type="date"
                value={arrivalDate}
                min={utcDateString(sc.bounds.earliest)}
                max={utcDateString(sc.bounds.latest)}
                onChange={(e) => e.target.value && sc.setArrival(fromUtcDateHour(e.target.value, utcHour(sc.arrival)))}
              />
            </label>
            <label className="ctl">
              <span className="ctl-label">Hour</span>
              <select value={utcHour(sc.arrival)} onChange={(e) => sc.setArrival(fromUtcDateHour(arrivalDate, Number(e.target.value)))}>
                {HOURS.map((h) => {
                  const t = fromUtcDateHour(arrivalDate, h);
                  return (
                    <option key={h} value={h} disabled={t < sc.bounds.earliest || t > sc.bounds.latest}>
                      {String(h).padStart(2, "0")}:00
                    </option>
                  );
                })}
              </select>
            </label>
          </div>
          <div className="ctl-row ctl-row-end">
            <label className="ctl dur">
              <span className="ctl-label">Duration</span>
              <span className="with-unit">
                <input
                  type="number"
                  min={1}
                  max={sc.maxDays}
                  step={1}
                  value={sc.days}
                  onChange={(e) => {
                    const n = Math.round(Number(e.target.value));
                    if (Number.isFinite(n) && n >= 1) sc.setDays(n);
                  }}
                  aria-label="Mission duration in Earth days"
                />
                <span className="unit">days</span>
              </span>
            </label>
            {onFindWindows && <FindWindowsButton onOpen={onFindWindows} className="tool-btn find-inline" />}
          </div>
            <div className="ctl ctl-inline">
              <span className="ctl-label" id="lbl-delay">Arrival delay</span>
              <div className="seg" role="radiogroup" aria-labelledby="lbl-delay">
                {sc.options.map((o) => (
                  <button
                    key={o.days}
                    type="button"
                    role="radio"
                    aria-checked={sc.effDelay === o.days}
                    className={sc.effDelay === o.days ? "seg-b on" : "seg-b"}
                    disabled={!o.enabled}
                    aria-describedby={o.enabled ? undefined : "delay-why"}
                    title={o.reason ?? `${fmtUtc(o.window.start)} → ${fmtUtc(o.window.end)}`}
                    onClick={() => {
                      sc.setDelay(o.days);
                      sc.setMission(o.days > 0 ? "delayed" : "baseline");
                    }}
                    data-delay-btn={o.days}
                  >
                    {o.days === 0 ? "None" : `+${o.days} d`}
                  </button>
                ))}
              </div>
            </div>
          {sc.options.some((o) => !o.enabled) && (
            <p className="muted small delay-why" id="delay-why" data-testid="delay-unavailable">
              {sc.options.filter((o) => !o.enabled).map((o) => `+${o.days} d`).join(", ")} unavailable: this mission plus the selected delay exceeds cached coverage (data end {fmtUtc(sc.cov.end)}).
            </p>
          )}
          {!sc.chosen.enabled && <p className="note small" role="status">+{sc.delay} d no longer fits the data with this arrival; showing the baseline only.</p>}
          <MissionSummary sc={sc} focus={focus} setFocus={sc.setMission} />
        </div>
      )}
      {onFindWindows && !open && (
        <div className="panel-finder">
          <FindWindowsButton onOpen={onFindWindows} className="tool-btn" />
        </div>
      )}
    </section>
  );
}

function pct(a: Availability<number>) {
  return a.ok ? fmtPct(a.value) : "unavailable";
}

function darkText(m: Availability<DarkRun | null>) {
  if (!m.ok) return "unavailable";
  if (!m.value) return "none";
  return `${fmtOutage(m.value.durationMs)}${m.value.touchesStart || m.value.touchesEnd ? " ⚠" : ""}`;
}

/** Where the longest period without direct sunlight touches the window (same flags as Analysis), or null. */
function darkEdge(m: Availability<DarkRun | null>) {
  if (!m.ok || !m.value || !(m.value.touchesStart || m.value.touchesEnd)) return null;
  const d = m.value;
  return d.touchesStart && d.touchesEnd ? "both edges" : d.touchesStart ? "start" : "end";
}

/**
 * Mission comparison for the active site, from the scenario's computeMetrics results (the
 * same values as the Analysis cards). The mission buttons choose the mission shown on the
 * timeline and searched for crossings; the collapsed line keeps the active mission's numbers.
 */
export function MissionSummary({ sc, focus, setFocus, initialOpen = false }: { sc: Pick<ReadyScenario, "activeView" | "effDelay" | "baseW" | "actW">; focus: MissionKey; setFocus: (f: MissionKey) => void; initialOpen?: boolean }) {
  const [open, setOpen] = useState(initialOpen);
  const v = sc.activeView;
  const cols: { key: MissionKey; label: string; short: string; w: TimeWindow; m: typeof v.base }[] = [{ key: "baseline", label: "Baseline", short: "Baseline", w: sc.baseW, m: v.base }];
  if (sc.effDelay > 0) cols.push({ key: "delayed", label: `Delay +${sc.effDelay} d`, short: `+${sc.effDelay} d`, w: sc.actW, m: v.act });
  const active = cols.find((c) => c.key === focus) ?? cols[0];
  const rows: { k: string; icon?: ReactNode; f: (m: typeof v.base) => string; field: string }[] = [
    { k: "Direct sunlight", icon: Icon.sun, f: (m) => pct(m.sunPct), field: "sun" },
    { k: "Earth window", icon: Icon.earth, f: (m) => pct(m.earthPct), field: "earth" },
    { k: "Both", f: (m) => pct(m.bothPct), field: "both" },
    { k: "Longest without sunlight", f: (m) => darkText(m.longestDark), field: "dark" },
  ];
  const edges = cols.map((c) => ({ label: c.label, where: darkEdge(c.m.longestDark) })).filter((x) => x.where);
  return (
    <div className="mission-summary" data-field="metrics" data-active={active.key}>
      <div className="ms-head">
        <button type="button" className="ms-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)} data-testid="ms-toggle">
          {Icon.chevron}<span>Mission comparison</span>
        </button>
        <div className="seg seg-small" role="radiogroup" aria-label="Mission shown on the timeline">
          {cols.map((c) => (
            <button key={c.key} type="button" role="radio" aria-checked={c.key === active.key} className={c.key === active.key ? "seg-b on" : "seg-b"} onClick={() => setFocus(c.key)} data-focus-btn={c.key} title={`${c.label}: ${shortRange(c.w)}`}>
              {c.short}
            </button>
          ))}
        </div>
      </div>
      <p className="ms-line small num" data-field="ms-line">
        <span>{Icon.sun}{pct(active.m.sunPct)}</span>
        <span>{Icon.earth}{pct(active.m.earthPct)}</span>
        <span>Both {pct(active.m.bothPct)}</span>
      </p>
      <p className="ms-window small" data-field="windows" title={`${active.label}: ${shortRange(active.w)} · ${fmtDuration(active.w.end - active.w.start)}`}>{active.label}: {shortRange(active.w)}</p>
      {open && (
        <table className="ms-table">
          <colgroup><col /><col className="ms-num" />{cols.length > 1 && <col className="ms-num" />}</colgroup>
          <thead>
            <tr>
              <th scope="col"><span className="sr-only">Measure</span></th>
              {cols.map((c) => <th scope="col" key={c.key} className={c.key === active.key ? "on" : undefined}>{c.short}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.k} data-row={r.field}>
                <th scope="row">{r.icon}{r.k}</th>
                {cols.map((c) => <td key={c.key} className={c.key === active.key ? "num on" : "num"}>{r.f(c.m)}</td>)}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {edges.length > 0 && !open && (
        <p className="ms-caveat small" data-field="dark-flag">⚠ Longest period without sunlight touches a window edge (see Mission comparison).</p>
      )}
      {edges.length > 0 && open && (
        <p className="note small" data-field="dark-note">
          ⚠ The longest period without direct sunlight touches the window {edges.map((x) => `${x.where} (${x.label})`).join(", ")}; it may be longer than shown.
        </p>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ current conditions (right)

function nextText(v: SiteView, body: "sun" | "earth", t: number) {
  const c = nextChange(v.intervals, t, body);
  if (!c.found) return "No change found in the available data";
  if (c.to === null) return `Status becomes unknown ≈ ${fmtUtc(c.at)}`;
  if (body === "sun") return `${c.to ? "Direct sunlight begins" : "Direct sunlight ends"} ≈ ${fmtUtc(c.at)}`;
  return `${c.to ? "Earth window opens" : "Earth window closes"} ≈ ${fmtUtc(c.at)}`;
}

function StatusGroup({ s, kind, v, mode }: { s: BodyStatus; kind: "power" | "comms"; v: SiteView; mode: HorizonMode }) {
  const body = kind === "power" ? "sun" : "earth";
  const name = kind === "power" ? "Sun" : "Earth";
  const f = kind === "power" ? powerStatus(s) : commsStatus(s);
  const why = nearCrossingExplanation(s, name, mode);
  return (
    <div className={`status-group group-${kind} body-${body}`} data-body={body} data-state={f.tone} data-near={s.nearCrossing ? "true" : undefined}>
      <p className="group-title">{kind === "power" ? Icon.panel : Icon.antenna}<span>{kind === "power" ? "Solar-power potential" : "Direct-to-Earth communication window"}</span></p>
      <div className="group-main">
        <span className={`avail avail-${f.tone}`} data-field="state">{f.label}</span>
        {s.nearCrossing && <span className="pill pill-near" data-field="near">{NEAR_CROSSING}</span>}
      </div>
      <p className="body-next small" data-field="next">{nextText(v, body, s.t)}</p>
      {why && <p className="body-note small" data-field="near-note">{why}</p>}
      {s.visible === null && s.unknownReason && <p className="body-note small" data-field="unknown">Unknown: {unknownText(s.unknownReason)}.</p>}
    </div>
  );
}

function GeometryRow({ s, name, mode }: { s: BodyStatus; name: "Sun" | "Earth"; mode: HorizonMode }) {
  const g = s.geometry;
  const rel = diskRelation(g.clearanceDeg, name === "Sun" ? SUN_R : EARTH_R);
  return (
    <div className="geo-row" data-geo={name.toLowerCase()}>
      <dt>{name}</dt>
      <dd className="num">
        center {signedClearance(g)} vs {horizonName(mode)} · el {fmtDeg(g.elevationDeg, 2)} · az {fmtDeg(g.azimuthDeg, 1)} {compass(g.azimuthDeg)}
        {rel === "straddles" && <span className="geo-disk" data-field="disk"> · nominal disk straddles the {horizonName(mode)}; its center is {g.side === "above" ? "above" : "below"} it</span>}
      </dd>
    </div>
  );
}

export function ConditionsPanel({ v, st, mode, open, onToggle, onDetails, terrain, compact = false }: { v: SiteView; st: SiteView["statusSel"]; mode: HorizonMode; open: boolean; onToggle: () => void; onDetails: () => void; terrain?: ReactNode; /** Terrain details open: secondary lines are hidden so states and controls stay in view. */ compact?: boolean }) {
  const both = st.both.visible === null ? "Unknown" : st.both.visible ? "Yes" : "No";
  return (
    <section className={`panel status-panel${open ? "" : " collapsed"}${compact ? " td-open" : ""}`} aria-label="Current conditions" data-site={v.entry.id} data-testid="status-panel">
      <div className="panel-head">
        <h2 className="panel-title">Conditions <span className="muted">· {v.profile.short}</span></h2>
        <button type="button" className="icon-btn labelled" onClick={onDetails} aria-haspopup="dialog">{Icon.info}<span>Details</span></button>
        <button type="button" className="icon-btn panel-toggle" aria-expanded={open} onClick={onToggle} aria-label={open ? "Collapse current conditions" : "Expand current conditions"}>{Icon.chevron}</button>
      </div>
      <p className="model-chip small" data-field="model" data-mode={mode} title={mode === "terrain" ? `Terrain skyline: ${terrainModelLabel(v.data) ?? "terrain model"}. Full model names: Geometry at this time, or Details.` : undefined}>
        {mode === "terrain" ? `Terrain skyline · ${terrainModelShortLabel(v.data) ?? "terrain model"}` : "Smooth model · 0° horizontal reference, terrain ignored"}
      </p>
      <StatusGroup s={st.sun} kind="power" v={v} mode={mode} />
      <StatusGroup s={st.earth} kind="comms" v={v} mode={mode} />
      {terrain}
      {open && (
        <>
          <div className="both-row small" data-body="both" data-near={st.both.nearCrossing ? "true" : undefined}>
            <span>Simultaneous availability</span>
            <span className={`pill pill-${st.both.visible === null ? "unknown" : st.both.visible ? "on" : "off"}`} data-field="state">{both}</span>
            {st.both.nearCrossing && <span className="pill pill-near">{NEAR_CROSSING}</span>}
          </div>
          <details className="geo-details">
            <summary>Geometry at this time</summary>
            <dl className="geo">
              <GeometryRow s={st.sun} name="Sun" mode={mode} />
              <GeometryRow s={st.earth} name="Earth" mode={mode} />
              <div className="geo-row"><dt>Model</dt><dd>{mode === "terrain" ? terrainModelLabel(v.data) ?? "terrain model" : "0° plane (smooth)"}</dd></div>
            </dl>
            <p className="muted small">Body centers, classified per exported 10-minute step. Camera movement never changes this status.</p>
          </details>
        </>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ viewport toolbar (top of the scene)

function ViewToolbar({ camera, setCamera, onReset, track, onTrack }: { camera: CameraMode; setCamera: (c: CameraMode) => void; onReset: () => void; track: TrackBody | null; onTrack: (b: TrackBody) => void }) {
  return (
    <div className="view-toolbar" role="toolbar" aria-label="View">
      <div className="seg seg-dark" role="radiogroup" aria-label="Camera mode">
        <button type="button" role="radio" aria-checked={camera === "overview"} className={camera === "overview" ? "seg-b on" : "seg-b"} onClick={() => setCamera("overview")} data-cam-btn="overview">
          {Icon.orbit}<span>Site overview</span>
        </button>
        <button type="button" role="radio" aria-checked={camera === "eye"} className={camera === "eye" ? "seg-b on" : "seg-b"} onClick={() => setCamera("eye")} data-cam-btn="eye">
          {Icon.eye}<span>Horizon view</span>
        </button>
      </div>
      <span className="tb-sep" aria-hidden="true" />
      <button type="button" className="tool-btn ghost" onClick={onReset} data-cam-cmd="reset" title="Reset view" aria-label="Reset view">{Icon.reset}<span>Reset</span></button>
      {(["sun", "earth"] as const).map((b) => {
        const name = b === "sun" ? "Sun" : "Earth";
        const on = track === b;
        return (
          <button
            key={b}
            type="button"
            className={`tool-btn ghost tool-${b}${on ? " tracking" : ""}`}
            onClick={() => onTrack(b)}
            aria-pressed={on}
            data-track-btn={b}
            title={on ? `Stop tracking the ${name}` : `Track the ${name}: Horizon view, kept centred on its modeled direction as time changes`}
          >
            {b === "sun" ? Icon.sun : Icon.earth}<span>{on ? `Tracking ${name}` : `Track ${name}`}</span>
          </button>
        );
      })}
    </div>
  );
}

/** Active-tracking indicator: which body, where it is relative to the horizon, and Stop tracking. */
function TrackIndicator({ body, s, mode, reducedMotion, onStop }: { body: TrackBody; s: BodyStatus; mode: HorizonMode; reducedMotion: boolean; onStop: () => void }) {
  const name = body === "sun" ? "Sun" : "Earth";
  const sum = trackSummary(s, body, mode);
  return (
    <div className={`track-indicator track-${body}`} role="status" data-testid="track-indicator" data-track={body} data-state={sum.state}>
      <p className="ti-main">
        <span className="ti-dot" aria-hidden="true" />
        <strong>Tracking {name}</strong>
        <span className="ti-line num" data-field="track-line">{sum.line}</span>
        {mode === "smooth" && <span className="ti-model">Smooth model: terrain ignored</span>}
        <button type="button" className="tool-btn compact ti-stop" onClick={onStop} data-testid="stop-tracking">Stop tracking</button>
      </p>
      {sum.note && <p className="ti-note small" data-field="track-note">{sum.note}</p>}
      <p className="ti-foot small muted">
        The view follows the modeled direction at each 10-minute sample{reducedMotion ? " (no transition animation: reduced motion)" : ""}; it does not refine event times. Dragging to look elsewhere stops tracking; zooming keeps it.
      </p>
    </div>
  );
}

// ------------------------------------------------------------------ compact legend with an info disclosure

function SceneLegend({ camera, mode, meta, context }: { camera: CameraMode; mode: HorizonMode; meta: TerrainAssetMeta | null; context: ContextMeta | null }) {
  const [info, setInfo] = useState(false);
  const extent = meta ? `${(meta.sampling.outer_half_width_m / 1000).toFixed(1)} km` : null;
  return (
    <div className="scene-legend small" aria-label="Legend" data-testid="legend">
      <div className="lg-row">
        {camera === "overview" ? (
          <>
            <span className="lg"><i className="lg-dot lg-dot-sun" />Sun</span>
            <span className="lg"><i className="lg-dot lg-dot-earth" />Earth</span>
            <span className="lg"><i className="lg-dot lg-dot-hidden" />below horizon</span>
            <span className="lg lg-quiet">Body markers enlarged for orientation</span>
          </>
        ) : mode === "terrain" ? (
          <>
            <span className="lg"><i className="lg-line" />Skyline (exported profile)</span>
            <span className="lg"><i className="lg-ref" />0°</span>
            <span className="lg lg-quiet">Disks at nominal size</span>
          </>
        ) : (
          <>
            <span className="lg"><i className="lg-line" />0° reference horizon</span>
            <span className="lg lg-quiet">Disks at nominal size</span>
          </>
        )}
        <span className="lg lg-quiet">Illustrative lighting</span>
        <button type="button" className="icon-btn lg-info" aria-expanded={info} aria-label="About this rendering" onClick={() => setInfo((x) => !x)} data-testid="legend-info">{Icon.info}</button>
      </div>
      {info && (
        <div className="lg-pop" role="note">
          {camera === "overview" ? (
            <ul>
              <li>Direction rays start at the fixed modeled observer and point along the Sun and Earth directions at the selected time. They show direction only: their drawn length does not represent distance. Markers sit at the far end of those directions; their size is for orientation, not angular size.</li>
              <li>Outlined markers are below the observer’s horizon in the selected model. Click a marker to view it at the horizon.</li>
              <li>When terrain hides the Sun or Earth, a ringed point marks the terrain that sets the skyline on the observer’s line of sight (often only tens or hundreds of metres away). The camera is far above the 1 m eye, so that rise rarely looks like a barrier from here; Horizon view shows it as the observer sees it.</li>
              <li>
                The terrain is the real {meta ? `${meta.source_dem.product} ` : ""}DEM mesh, true scale
                {extent && context
                  ? `: detailed to ${extent}, then coarser context terrain to ${(context.outer_half_width_m / 1000).toFixed(0)} km (dashed outline) so nearby craters and massifs are visible. Zoom out to see it all.`
                  : extent ? `, meshed to ${extent} (dashed outline).` : "."}
              </li>
            </ul>
          ) : (
            <ul>
              <li>{mode === "terrain" ? "The bright line is the exported 0.1° skyline that decides status. Terrain is clipped to it, and only it hides the Sun or Earth." : "Smooth model: the 0° line is the horizon; terrain is context only."}</li>
              <li>Sun 0.53° and Earth 1.9° are nominal sizes; the dashed ring is a click target, the cross its center. Earth’s grid is decorative, not geography or phase.</li>
            </ul>
          )}
          <p>Terrain brightness is a fixed display light, not sunlight. No shadows are computed.</p>
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ time area: playback, timeline, crossings

function segmentText(s: Segment) {
  const sun = s.sun === null ? "unknown" : s.sun ? "available" : "blocked";
  const earth = s.earth === null ? "unknown" : s.earth ? "open" : "below horizon";
  return `${AVAIL_LABEL[s.state]} · ${fmtUtc(s.start)} – ${fmtUtc(s.end)} · Direct sunlight ${sun} · Earth window ${earth}`;
}

function TimeBar({ sc, win, speed, setSpeed, evBody, setEvBody, evRange, setEvRange, onCrossing, onJumpMission }: {
  sc: ReadyScenario;
  win: { key: MissionKey; label: string; w: TimeWindow };
  speed: Speed;
  setSpeed: (s: Speed) => void;
  evBody: "sun" | "earth";
  setEvBody: (b: "sun" | "earth") => void;
  evRange: "mission" | "all";
  setEvRange: (r: "mission" | "all") => void;
  onCrossing: (dir: 1 | -1) => void;
  onJumpMission: () => void;
}) {
  const { baseW, actW, effDelay, selT, sel, times } = sc;
  const span = timelineSpan(sc.domain, selT);
  const dur = span.end - span.start;
  const frac = (t: number) => (t - span.start) / dur;
  const pos = (t: number) => `${(frac(t) * 100).toFixed(3)}%`;
  const segs = useMemo(() => availabilitySegments(sc.activeView.intervals, span), [sc.activeView.intervals, span.start, span.end]); // eslint-disable-line react-hooks/exhaustive-deps
  const j0 = nearestIndex(times, span.start);
  const j1 = Math.min(times.length - 1, nearestIndex(times, span.end));
  const last = times.length - 1;
  const atEnd = sel >= last;
  const [hover, setHover] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);
  const tipT = hover ?? (focused ? selT : null);
  const tipSeg = tipT === null ? null : segmentAt(segs, Math.min(tipT, span.end - 1));
  const outside = selT < win.w.start || selT >= win.w.end;
  const ticks = useMemo(() => {
    const out: { t: number; label: string }[] = [];
    const d0 = Math.ceil(span.start / 86_400_000) * 86_400_000;
    const every = dur > 20 * 86_400_000 ? 4 : dur > 10 * 86_400_000 ? 2 : 1;
    for (let t = d0, k = 0; t <= span.end; t += 86_400_000, k++) {
      if (k % every === 0 && t - span.start > dur * 0.015 && span.end - t > dur * 0.03) out.push({ t, label: new Date(t).toISOString().slice(5, 10) });
    }
    return out;
  }, [span.start, span.end, dur]);
  const curSeg = segmentAt(segs, Math.min(selT, span.end - 1));
  const winRect = (w: TimeWindow) => ({ left: pos(Math.max(w.start, span.start)), width: `calc(${pos(Math.min(w.end, span.end))} - ${pos(Math.max(w.start, span.start))})` });
  return (
    <section className="timebar" aria-label="Time">
      <div className="tb-row">
        <div className="tb-left">
          <button type="button" className="play-btn" onClick={() => sc.setPlaying(!sc.playing)} disabled={!sc.playing && atEnd} aria-pressed={sc.playing} title={atEnd ? "At the end of the data" : undefined} data-testid="play">
            {sc.playing ? Icon.pause : Icon.play}
            <span>{sc.playing ? "Pause" : "Play"}</span>
          </button>
          <div className="step-btns">
            <button type="button" className="tool-btn compact" onClick={() => sc.stepSel(-1)} disabled={sel <= 0} aria-label="Back 10 minutes" data-testid="step-back">−10 min</button>
            <button type="button" className="tool-btn compact" onClick={() => sc.stepSel(1)} disabled={sel >= last} aria-label="Forward 10 minutes" data-testid="step-fwd">+10 min</button>
          </div>
          <div className="sel-time">
            <span className="ctl-label">Viewing time</span>
            <span className="num sel-time-v" data-field="selected-time">{fmtUtc(selT)}</span>
          </div>
          {outside && (
            <div className="outside" role="status" data-testid="outside-mission">
              <span>Outside selected mission</span>
              <button type="button" className="tool-btn compact" onClick={() => { sc.setPlaying(false); sc.setSel(nearestIndex(sc.times, win.w.start)); onJumpMission(); }} data-testid="jump-mission">Jump to mission</button>
            </div>
          )}
        </div>
        <label className="speed">
          <span className="ctl-label">Speed</span>
          <select value={speed.id} onChange={(e) => setSpeed(SPEEDS.find((s) => s.id === e.target.value)!)} data-testid="speed">
            {SPEEDS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </label>
      </div>
      <div className="tb-track">
        <div className="tb-windows" aria-hidden="true">
          <span className={win.key === "baseline" ? "win win-base active" : "win win-base"} style={winRect(baseW)}>
            <span className="win-l">Baseline arrival<span className="wl-t"> {fmtUtc(baseW.start).slice(5, 16)}</span></span>
          </span>
          {effDelay > 0 && (
            <span className={win.key === "delayed" ? "win win-delay active" : "win win-delay"} style={winRect(actW)}>
              <span className="win-l">+{effDelay} d arrival<span className="wl-t"> {fmtUtc(actW.start).slice(5, 16)}</span></span>
            </span>
          )}
        </div>
        <div
          className="tb-scrub"
          onPointerMove={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setHover(span.start + Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)) * dur);
          }}
          onPointerLeave={() => setHover(null)}
        >
          <svg className="tb-band" width="100%" height="100%" preserveAspectRatio="none" aria-hidden="true" data-testid="avail-band">
            <defs>
              <pattern id="hatch-unknown" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect width="6" height="6" className="av-unknown-bg" />
                <line x1="0" y1="0" x2="0" y2="6" className="av-hatch" />
              </pattern>
            </defs>
            {segs.map((s) => {
              const x = `${(frac(s.start) * 100).toFixed(4)}%`;
              const w = `${(((s.end - s.start) / dur) * 100).toFixed(4)}%`;
              if (s.state === "both") {
                return (
                  <g key={s.start} data-state="both">
                    <rect x={x} width={w} y="0" height="50%" className="av-sun" />
                    <rect x={x} width={w} y="50%" height="50%" className="av-earth" />
                  </g>
                );
              }
              const cls = s.state === "sun" ? "av-sun" : s.state === "earth" ? "av-earth" : s.state === "neither" ? "av-neither" : "av-unknown";
              return <rect key={s.start} data-state={s.state} x={x} width={w} y={s.state === "earth" ? "50%" : "0"} height={s.state === "sun" || s.state === "earth" ? "50%" : "100%"} className={cls} />;
            })}
            <rect x="0" width={`${(Math.max(0, frac(win.w.start)) * 100).toFixed(4)}%`} y="0" height="100%" className="av-dim" />
            <rect x={`${(Math.min(1, frac(win.w.end)) * 100).toFixed(4)}%`} width={`${((1 - Math.min(1, frac(win.w.end))) * 100).toFixed(4)}%`} y="0" height="100%" className="av-dim" />
          </svg>
          <span className="tb-cursor" style={{ left: pos(selT) }} aria-hidden="true" />
          <input
            type="range"
            className="scrubber"
            min={j0}
            max={j1}
            step={1}
            value={sel}
            onChange={(e) => sc.setSel(Number(e.target.value))}
            onPointerDown={() => sc.setPlaying(false)}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
            aria-label="Viewing time on the mission timeline"
            aria-valuetext={`${fmtUtc(selT)}${curSeg ? `, ${AVAIL_LABEL[curSeg.state]}` : ""}`}
            data-testid="scrubber"
          />
          {tipT !== null && <span className="tb-hover" style={{ left: pos(tipT) }} aria-hidden="true" />}
        </div>
        <div className="tb-ticks small num" aria-hidden="true">
          {ticks.map((k) => <span key={k.t} style={{ left: pos(k.t) }}>{k.label}</span>)}
        </div>
      </div>
      <div className="tb-row tb-foot">
        {/* crossings first: the bottom-right corner can hold a host badge (see .tb-foot in explore.css) */}
        <div className="xing" role="group" aria-label="Horizon crossings">
          <span className="ctl-label">Horizon crossings</span>
          <div className="seg seg-dark" role="radiogroup" aria-label="Crossing body">
            {(["sun", "earth"] as const).map((b) => (
              <button key={b} type="button" role="radio" aria-checked={evBody === b} className={evBody === b ? "seg-b on" : "seg-b"} onClick={() => setEvBody(b)} data-ev-body={b} aria-label={b === "sun" ? "Sun" : "Earth"}>
                {b === "sun" ? Icon.sun : Icon.earth}<span>{b === "sun" ? "Sun" : "Earth"}</span>
              </button>
            ))}
          </div>
          <button type="button" className="tool-btn" onClick={() => onCrossing(-1)} data-testid="ev-prev" aria-label={`Previous ${evBody === "sun" ? "Sun" : "Earth"} crossing`}>{Icon.prev}<span>Prev</span></button>
          <button type="button" className="tool-btn" onClick={() => onCrossing(1)} data-testid="ev-next" aria-label={`Next ${evBody === "sun" ? "Sun" : "Earth"} crossing`}><span>Next</span>{Icon.next}</button>
          <select value={evRange} onChange={(e) => setEvRange(e.target.value as "mission" | "all")} aria-label="Search crossings in" data-testid="ev-range">
            <option value="mission">in selected mission</option>
            <option value="all">in all cached data</option>
          </select>
        </div>
        {tipSeg ? (
          <p className="tb-info small" role="status" data-testid="timeline-tip">{segmentText(tipSeg)}</p>
        ) : (
        <div className="tb-legend small" aria-label="Timeline legend">
          <span><i className="lk lk-both" />Sun + Earth</span>
          <span><i className="lk lk-sun" />Sun only</span>
          <span><i className="lk lk-earth" />Earth only</span>
          <span><i className="lk lk-neither" />Neither</span>
          <span><i className="lk lk-unknown" />Unknown</span>
          <span className="muted lg-note">Body centers; not a go/no-go.</span>
        </div>
        )}
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ details sheet

const f5 = (x: number | undefined) => (x === undefined ? "n/a" : `${x >= 0 ? "+" : "−"}${Math.abs(x).toFixed(3)}°`);
const a3 = (x: number | undefined) => (x === undefined ? "n/a" : `${x.toFixed(3)}°`);

function DetailsSheet({ v, mode, meta, assetState, contextMeta, onClose, onAnalysis }: {
  v: SiteView; mode: HorizonMode; meta: TerrainAssetMeta | null; assetState: AssetState; contextMeta: ContextMeta | null; onClose: () => void; onAnalysis: () => void;
}) {
  const ctxState = assetState.state === "ready" ? assetState.context : undefined;
  useEffect(() => {
    const f = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", f);
    return () => window.removeEventListener("keydown", f);
  }, [onClose]);
  const s = v.data.site;
  const coord = v.data.sources.find((x) => x.id === "site-coordinates");
  const mc = meta?.mesh_check;
  const inside = mc?.setting_point_inside_mesh;
  const fine = mc?.fine_reference;
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <aside className="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-h" onClick={(e) => e.stopPropagation()} data-site={v.entry.id}>
        <div className="sheet-head">
          <h2 id="sheet-h">Details · {v.profile.short}</h2>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Close details" autoFocus>✕</button>
        </div>
        <div className="sheet-body">
          <section>
            <h3>What the availability means</h3>
            <p className="small">Sources: Sun and Earth positions from JPL Horizons (cached, airless, 10-minute samples); terrain and skyline from {v.data.terrain_horizon ? Object.keys(v.data.terrain_horizon.horizon.resolution.dem_pixel_m).join(" and ") : "no terrain model (smooth model only)"}. All times UTC.</p>
            <p className="small purpose" data-testid="purpose-note">{PURPOSE_NOTE}</p>
            <p className="small">Visibility refers to body <strong>centers</strong>, classified per exported 10-minute step; crossing times are estimates on that grid. Part of a disk can be above the {horizonName(mode)} while its center is not.</p>
          </section>
          <section>
            <h3>What this view shows</h3>
            <ul>
              <li>The fixed <strong>modeled observer</strong>: the exported observer point, {s.observer_height_above_surface_m} m nominal above the DEM surface{v.data.terrain_horizon?.observer ? ` (eye ${v.data.terrain_horizon.observer.eye_above_dem_surface_m.toFixed(3)} m above the interpolated surface)` : ""}. Moving the camera never moves it or changes any status.</li>
              <li>{mode === "terrain"
                ? <><strong>Observer view uses the exported skyline profile for the horizon.</strong> The bright line is the 0.1° profile that decides status. Terrain is clipped to that line, and only the profile hides the Sun or Earth; the simplified meshes, which differ from the profile (the detailed mesh by up to about 0.1°, the coarser context rings by more), never add or remove occlusion here. Where the meshes are lower than the profile, the profile is filled as a flat band (an angular outline, not 3D geometry). The overview shows the unclipped mesh.</>
                : "Smooth mode: status uses the 0° horizontal reference plane. Terrain is drawn for context only and does not hide the Sun or Earth."}</li>
              <li>The Sun and Earth are drawn at <strong>nominal</strong> sizes (0.53° and 1.9°) at their exact centers; the dataset holds no diameters. Near a crossing the drawn center and the step’s label can briefly disagree: that is the “{NEAR_CROSSING}” case, explained in the status panel.</li>
              <li>Terrain brightness is display lighting from a fixed direction; it does not show sunlight at the observer or on the ground. No shadows are computed.</li>
            </ul>
          </section>
          <section>
            <h3>Site and coordinates</h3>
            <dl className="facts">
              <dt>Point</dt><dd>{v.profile.label}. {v.profile.kind}.</dd>
              <dt>Coordinates</dt><dd className="num">{fmtLat(s.latitude_deg)}, {fmtLonEast(s.longitude_deg_east)}{coord && linkableUrl(coord.url) ? <> · <a href={coord.url} target="_blank" rel="noreferrer">source</a></> : coord ? <> · {coord.title}</> : null}</dd>
              <dt>Frame</dt><dd>{s.coordinate_frame}</dd>
              <dt>Observer</dt><dd className="num">Horizons altitude {s.horizons_site_altitude_km} km above the 1737.4 km sphere</dd>
              {v.profile.provisionalTerrain && <><dt>Status</dt><dd><strong>{v.profile.provisionalTerrain}.</strong> {v.profile.limitations.join(" ")}</dd></>}
              <dt>Limits</dt><dd>{v.profile.realityNote}</dd>
            </dl>
          </section>
          <section>
            <h3>Terrain mesh (rendering asset)</h3>
            {assetState.state === "error" && <p className="note-err small">Not loaded: {assetState.message}</p>}
            {assetState.state === "loading" && <p className="muted small">Loading…</p>}
            {meta && (
              <>
                <p className="small">
                  {meta.source_dem.product} (sha256 <code>{meta.source_dem.sha256.slice(0, 12)}…</code>), the same DEM and registration as the terrain horizon. Heights are bilinear between DEM pixel centres; finer mesh spacing interpolates and adds no measured detail. No vertical exaggeration; curvature is in the vertex positions once. Shading normals are averaged over about 10 m (shading only).
                </p>
                <div className="table-scroll plain">
                  <table className="mini-table">
                    <thead><tr><th scope="col">Ring</th><th scope="col">Spacing</th><th scope="col">Half-width</th><th scope="col">Vertices</th></tr></thead>
                    <tbody>
                      {meta.levels.map((l) => (
                        <tr key={l.index}><td>{l.index + 1}</td><td className="num">{l.spacing_m} m</td><td className="num">{(l.half_width_m / 1000).toFixed(2)} km</td><td className="num">{l.vertex_count.toLocaleString("en-US")}</td></tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <p className="small">
                  {meta.counts.vertices.toLocaleString("en-US")} vertices, {meta.counts.triangles.toLocaleString("en-US")} triangles, {(meta.counts.bin_bytes / 1e6).toFixed(1)} MB.{" "}
                  {contextMeta
                    ? `Beyond the ${(meta.sampling.outer_half_width_m / 1000).toFixed(2)} km detailed square, coarser context terrain continues to ${(contextMeta.outer_half_width_m / 1000).toFixed(0)} km (below); beyond that, terrain is represented only by the exported skyline in Horizon view.`
                    : meta.sampling.unmeshed}
                </p>
              </>
            )}
          </section>
          {meta && (
            <section data-testid="context-details">
              <h3>Context terrain (rendering asset)</h3>
              {ctxState?.state === "loading" && <p className="muted small">Loading…</p>}
              {ctxState?.state === "error" && <p className="note-err small">Not loaded: {ctxState.message}. The detailed mesh, status and Analysis are unaffected.</p>}
              {contextMeta && (
                <>
                  <p className="small">
                    Coarser rings around the detailed mesh for orientation, so nearby craters and massifs are visible: {contextMeta.sources_used.join(", ")}, sampled bilinearly from
                    the same cached DEMs and source priority as the terrain horizon. No invented detail, no vertical exaggeration; curvature once. Where the two meshes meet,
                    context cells inside the detailed square are omitted and the rest sit slightly below it (at most 0.05 % of the distance plus 1 m), so the detailed mesh
                    is always the visible surface. Display only: never used for status, metrics or the skyline.
                  </p>
                  <div className="table-scroll plain">
                    <table className="mini-table">
                      <thead><tr><th scope="col">Ring</th><th scope="col">Spacing</th><th scope="col">Half-width</th><th scope="col">Source</th></tr></thead>
                      <tbody>
                        {contextMeta.levels.map((l) => (
                          <tr key={l.index}><td>{l.index + 1}</td><td className="num">{l.spacing_m} m</td><td className="num">{(l.half_width_m / 1000).toFixed(2)} km</td><td>{l.sources_used.join(", ")}{l.nodata_vertices ? ` (${l.nodata_vertices} points without data, not drawn)` : ""}</td></tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="small">Reproduce: <code>{contextMeta.reproduce}</code></p>
                </>
              )}
            </section>
          )}
          {mc && inside && (
            <section>
              <h3>Mesh silhouette vs exported skyline</h3>
              <p className="small">
                Measured from the observer at every 0.1° of azimuth ({inside.n} azimuths with the skyline-setting point inside the mesh;{" "}
                {mc.setting_point_beyond_mesh.n} beyond it). Mesh minus profile: {f5(inside.signed_min_deg)} to {f5(inside.signed_max_deg)}, 95th percentile |Δ| {a3(inside.abs_p95_deg)}, maximum |Δ| {a3(inside.abs_max_deg)};{" "}
                {inside.n_abs_over_target} azimuths exceed the proposed {mc.target_deg}° rendering target{mc.meets_target_inside_mesh ? "" : " (target not met everywhere)"}. This is why the observer view clips terrain to the profile.
              </p>
              {fine && (
                <p className="small">
                  Against a finer ray march of the same DEM ({fine.mesh_minus_fine_reference.n} azimuths), the mesh differs by at most {a3(fine.mesh_minus_fine_reference.abs_max_deg)}; the exported profile’s own radial sampling accounts for up to {a3(fine.fine_reference_minus_profile.abs_max_deg)}. Status always uses the exported profile.
                </p>
              )}
              <p className="muted small">{mc.target_note} Source terrain uncertainty is larger{v.profile.provisionalTerrain ? ", for CR1 by degrees" : ""}.</p>
            </section>
          )}
          <section>
            <p className="small">
              Reproduce: <code>{reproduceCommand(meta?.reproduce, v.entry.id, `python pipeline/render_assets.py --site ${v.entry.id}`)}</code>
            </p>
            <button type="button" className="primary" onClick={onAnalysis}>Open Analysis for the full comparison</button>
          </section>
        </div>
      </aside>
    </div>
  );
}
