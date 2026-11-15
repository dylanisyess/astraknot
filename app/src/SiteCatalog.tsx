// Site catalog and comparison shortlist (release 6, checkpoint 2).
// - Chips for the selected sites (one active), each with a remove action (never the last one).
// - "Add site" opens the catalog: name, location type, coordinates and the site's measured data
//   capabilities (catalog.json, pipeline/catalog.py), without loading any time series.
// - Panels for a selected site that has no view yet: loading, load error (Retry), or no terrain
//   horizon in Terrain mode (an explicit offer of the common Smooth comparison; never a silent mix).

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { fmtLat, fmtLonEast, fmtUtc, parseUtc } from "./data";
import type { PendingSite, Scenario } from "./scenario";
import type { CatalogSite, LocationType } from "./types";
import { profileFor } from "./sites";
import { MAX_SITES } from "./urlState";

export const LOCATION_TYPE_LABEL: Record<LocationType, string> = {
  actual_landing_point: "Actual landing point",
  intended_landing_target: "Intended landing target",
  study_location: "Study location",
  user_defined_study_point: "User-defined study point",
};

export interface CapabilityRow {
  key: "positions" | "smooth" | "terrain" | "terrain3d" | "slope";
  label: string;
  ok: boolean;
  text: string;
}

const days = (a: string, b: string) => Math.round((parseUtc(b) - parseUtc(a)) / 86_400_000);
const metres = (n: number) => Number(n.toFixed(1));

/** The five measured data capabilities of a catalog site, in a fixed order (caveats: modelNotes). */
export function capabilityRows(c: CatalogSite): CapabilityRow[] {
  const k = c.capabilities;
  const p = k.positions;
  const th = k.terrain_horizon;
  const t3 = k.terrain_3d;
  const sl = k.slope_screening;
  return [
    {
      key: "positions",
      label: "Cached position coverage",
      ok: p.available,
      text: p.available
        ? `${fmtUtc(parseUtc(p.coverage_start_utc))} – ${fmtUtc(parseUtc(p.coverage_end_utc))} (${days(p.coverage_start_utc, p.coverage_end_utc)} days, ${p.sample_step_seconds / 60}-minute samples)`
        : "Positions do not cover the dataset",
    },
    { key: "smooth", label: "Smooth visibility", ok: k.smooth_visibility.available, text: k.smooth_visibility.available ? "0° horizontal-plane comparison" : "Not available" },
    {
      key: "terrain",
      label: "Terrain horizon",
      ok: th.available,
      text: th.available ? `${th.products.join(" + ")} (${metres(th.near_pixel_m)} m pixels near the site)${th.unknown_azimuths ? `; ${th.unknown_azimuths} unknown directions` : ""}` : th.reason,
    },
    { key: "terrain3d", label: "3D terrain", ok: t3.available, text: t3.available ? `${t3.source_product} mesh, ${(t3.bytes / 1e6).toFixed(1)} MB (loaded only when shown)` : t3.reason },
    {
      key: "slope",
      label: "Slope screening",
      ok: sl.available,
      text: sl.available ? `${sl.source_product}: ${metres(sl.dem_pixel_m)} m pixels, slope over ≈${Math.round(sl.baseline_m)} m, within ${sl.radius_m} m` : sl.reason,
    },
  ];
}

/**
 * Documented site-specific caveats that are not in the catalog file (sources: docs/STATUS.md,
 * docs/COORDINATE_PIPELINE.md, docs/ADDITIONAL_SITE_TERRAIN.md). Keyed by site ID so text written
 * for one site never appears for another.
 */
const DOCUMENTED_NOTES: Record<string, string[]> = {
  "apollo17-lm": [
    "The 3D terrain mesh departs from the exported skyline by up to about 0.11° in some directions (10 of 50 checked exceed the proposed 0.05° target). Status and Horizon view use the exported skyline.",
  ],
  "im1-odysseus": [
    "The NAIF IM-1 kernel lists a 2.583 km landing-site altitude, about 11.5 m below the DEM-based observer used here (2.5945 km); the cause is unresolved. The DEM-based observer is used throughout.",
  ],
};

/** Applies to every site; stated so that a site without its own caveat is never read as having none. */
export const GENERAL_MODEL_NOTE =
  "Sun and Earth visibility refers to body centers at 10-minute samples, for a modeled observer 1 m above the terrain model. It is not power output, a radio link or a landing-safety rating.";

export interface ModelNotes {
  /** Catalog provisional flag, shown as a caution. */
  caution: string | null;
  /** Site-specific caveats (site profile and documentation). */
  site: string[];
  /** What the result is (and is not) for this point. */
  reality: string;
  /** True when no site-specific caveat is recorded (not a claim that there are no limitations). */
  noneRecorded: boolean;
}

/** Model notes for a catalog site, separate from its capabilities. */
export function modelNotes(c: CatalogSite): ModelNotes {
  const p = profileFor(null, c);
  const site = [...p.limitations, ...(DOCUMENTED_NOTES[c.id] ?? [])];
  const caution = c.capabilities.provisional ?? null;
  return { caution, site, reality: p.realityNote, noneRecorded: !caution && site.length === 0 };
}

// ------------------------------------------------------------------ chips (selected sites)

export function SiteChips({ sc, theme }: { sc: Scenario; theme: "explore" | "page" }) {
  const [open, setOpen] = useState(false);
  const more = sc.allIds.length - sc.selIds.length;
  return (
    <div className={`site-chips chips-${theme}`} data-testid="site-chips">
      <div className="chip-row" role="tablist" aria-label="Compared sites (one active)">
        {sc.selIds.map((id) => {
          const cs = sc.catalogSite(id);
          const p = sc.pending.find((x) => x.id === id);
          const on = sc.active === id;
          const short = sc.views.find((v) => v.entry.id === id)?.profile.short ?? p?.short ?? cs.short_name;
          return (
            <span key={id} className={on ? "site-chip on" : "site-chip"} data-site-chip={id} data-state={p?.state ?? "ready"}>
              <button
                type="button"
                role="tab"
                aria-selected={on}
                className="chip-main"
                onClick={() => sc.setActive(id)}
                data-site-btn={id}
                title={`${cs.name}${p ? ` (${p.state === "loading" ? "loading" : p.state === "error" ? "could not be loaded" : "no terrain horizon"})` : ""}`}
              >
                {p?.state === "loading" && <span className="chip-spin" aria-hidden="true" />}
                {p && p.state !== "loading" && <span className="chip-warn" aria-hidden="true">!</span>}
                {short}
                {cs.capabilities.provisional && <span className="chip-prov" title={cs.capabilities.provisional}>provisional</span>}
              </button>
              <button
                type="button"
                className="chip-x"
                onClick={() => sc.removeSite(id)}
                disabled={sc.selIds.length <= 1}
                aria-label={`Remove ${short} from the comparison`}
                title={sc.selIds.length <= 1 ? "The last site cannot be removed" : `Remove ${short} from the comparison`}
                data-remove-site={id}
              >
                ✕
              </button>
            </span>
          );
        })}
        <button
          type="button"
          className="chip-add"
          onClick={() => setOpen(true)}
          aria-haspopup="dialog"
          aria-label={`${sc.selIds.length >= MAX_SITES ? "Site catalog (comparison full)" : sc.selIds.length > 1 ? "Add another site" : "Add site"}: ${sc.selIds.length} of ${MAX_SITES} sites compared, ${more} more in the catalog`}
          data-testid="add-site"
        >
          <span className="chip-add-plus" aria-hidden="true">+</span>
          {sc.selIds.length >= MAX_SITES ? "Comparison full" : sc.selIds.length > 1 ? "Add another site" : "Add site"}
          {more > 0 && sc.selIds.length < MAX_SITES ? <span className="chip-more" aria-hidden="true"> ({more} more)</span> : null}
        </button>
      </div>
      <p className="chip-count small">
        {sc.selIds.length} of {MAX_SITES} sites compared · {theme === "explore" ? "the selected one is shown in 3D" : "one shown in 3D and the panorama"}
      </p>
      {open && createPortal(<CatalogDialog sc={sc} onClose={() => setOpen(false)} />, document.body)}
    </div>
  );
}

// ------------------------------------------------------------------ catalog dialog

export function CatalogDialog({ sc, onClose }: { sc: Scenario; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const f = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(); }
      if (e.key !== "Tab") return;
      const buttons = Array.from(ref.current?.querySelectorAll<HTMLElement>("button:not(:disabled), a[href], input:not(:disabled), [tabindex='0']") ?? []);
      const first = buttons[0], last = buttons.at(-1);
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    };
    window.addEventListener("keydown", f);
    ref.current?.querySelector<HTMLElement>("button")?.focus();
    return () => { window.removeEventListener("keydown", f); previous?.focus(); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="catalog-backdrop" onClick={onClose}>
      <div className="catalog-dialog" role="dialog" aria-modal="true" aria-labelledby="catalog-h" onClick={(e) => e.stopPropagation()} ref={ref} data-testid="catalog">
        <div className="catalog-head">
          <h2 id="catalog-h">Site catalog · dataset <code>{sc.ds.manifest.dataset_id}</code></h2>
          <button type="button" className="catalog-close" onClick={onClose} aria-label="Close the catalog">✕</button>
        </div>
        <p className="catalog-intro small">
          Up to {MAX_SITES} sites can be compared with the same windows, model and time. Capabilities are measured from each site’s files; a missing
          capability is stated, never filled in. Adding a site loads only its own data.
        </p>
        <ul className="catalog-list">
          {sc.ds.catalog.sites.map((c) => {
            const blocked = sc.addBlocked(c.id);
            const inComparison = sc.selIds.includes(c.id);
            return (
              <li key={c.id} className="catalog-item" data-catalog-site={c.id}>
                <div className="ci-head">
                  <div>
                    <h3>{c.name}</h3>
                    <p className="small ci-type"><strong>{LOCATION_TYPE_LABEL[c.location_type]}</strong> · {c.location_label}</p>
                    <p className="small num">{fmtLat(c.latitude_deg)}, {fmtLonEast(c.longitude_deg_east)}</p>
                  </div>
                  {inComparison ? (
                    <span className="ci-in small">In comparison{sc.active === c.id ? " · active" : ""}</span>
                  ) : (
                    <button
                      type="button"
                      className="ci-add"
                      disabled={!!blocked}
                      title={blocked ?? `Add ${c.short_name} to the comparison and show it`}
                      onClick={() => {
                        if (sc.addSite(c.id)) onClose();
                      }}
                      data-add-site={c.id}
                    >
                      Add {c.short_name}
                    </button>
                  )}
                </div>
                {!inComparison && blocked && <p className="small ci-blocked">Cannot add: {blocked}.</p>}
                <h4 className="ci-sub small">Capabilities</h4>
                <dl className="ci-caps small">
                  {capabilityRows(c).map((r) => (
                    <div key={r.key} className="ci-cap" data-cap={r.key} data-ok={r.ok ? "yes" : "no"}>
                      <dt>
                        <span className="cap-mark" aria-hidden="true">{r.ok ? "✓" : "✕"}</span>
                        {r.label}
                        <span className="sr-only">: {r.ok ? "available" : "not available"}</span>
                      </dt>
                      <dd>{r.text}</dd>
                    </div>
                  ))}
                </dl>
                <ModelNotesList n={modelNotes(c)} />
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}

function ModelNotesList({ n }: { n: ModelNotes }) {
  return (
    <>
      <h4 className="ci-sub small">Model notes</h4>
      <ul className="ci-notes small" data-testid="model-notes">
        {n.caution && <li className="ci-caution" data-note="provisional"><span aria-hidden="true">⚠ </span>{n.caution}.</li>}
        {n.site.map((t) => <li key={t} data-note="site">{t}</li>)}
        {n.noneRecorded && <li data-note="none-recorded">No site-specific caveat is recorded in this catalog. That does not mean the terrain model has no limitations; the notes below apply.</li>}
        <li data-note="reality">{n.reality}</li>
        <li data-note="general">{GENERAL_MODEL_NOTE}</li>
      </ul>
    </>
  );
}

// ------------------------------------------------------------------ a selected site without a view

/** Explicit offer when Terrain is requested but some selected sites have no terrain horizon. */
export function MixedTerrainNotice({ sc }: { sc: Scenario }) {
  if (!sc.terrainRequestedButMissing) return null;
  const lacking = sc.avail.missing;
  const names = lacking.map((m) => sc.views.find((v) => v.entry.id === m.id)?.profile.short ?? sc.catalogSite(m.id).short_name);
  return (
    <div className="mixed-notice" role="alert" data-testid="mixed-terrain">
      <p>
        <strong>Terrain comparison is unavailable for this set:</strong>{" "}
        {lacking.map((m, k) => (
          <span key={m.id}>{k ? "; " : ""}<strong>{names[k]}</strong> has no terrain horizon ({m.reason})</span>
        ))}
        {". "}{names.length === 1 ? "It shows" : "They show"} no results in Terrain mode; the other sites keep their terrain results. Models are never mixed.
      </p>
      <div className="mixed-actions">
        <button type="button" className="primary" onClick={() => sc.setMode("smooth")} data-testid="use-common-smooth">
          {sc.selIds.length === 1 ? "Use the Smooth model" : `Compare all ${sc.selIds.length} sites with the Smooth model`}
        </button>
        {sc.selIds.length > lacking.length &&
          lacking.map((m, k) => (
            <button key={m.id} type="button" onClick={() => sc.removeSite(m.id)} data-testid={`remove-lacking-${m.id}`}>
              Remove {names[k]}
            </button>
          ))}
      </div>
    </div>
  );
}

/** Text for a pending site: what is missing and why; never another site's data. */
export function pendingText(p: PendingSite): { title: string; body: string } {
  if (p.state === "loading") return { title: `Loading ${p.short}…`, body: "Its data is loading. Nothing from another site is shown in its place." };
  if (p.state === "error") return { title: `${p.short} could not be loaded`, body: `${p.reason}. No substitute data is shown.` };
  return {
    title: `${p.short}: no terrain horizon`,
    body: `This site has no terrain horizon (${p.reason}), so it has no Terrain-mode results. Its Smooth (0°) results are available in a common Smooth comparison.`,
  };
}

/** Card/panel for a selected site that has no view in the current model. */
export function PendingCard({ sc, p, compact = false }: { sc: Scenario; p: PendingSite; compact?: boolean }) {
  const t = pendingText(p);
  return (
    <div className={`pending-card pending-${p.state}${compact ? " compact" : ""}`} data-pending-site={p.id} data-state={p.state} role={p.state === "loading" ? "status" : "alert"}>
      <p className="pending-title">
        {p.state === "loading" && <span className="chip-spin" aria-hidden="true" />}
        <strong>{t.title}</strong>
      </p>
      <p className="small">{t.body}</p>
      <div className="pending-actions">
        {p.state === "error" && <button type="button" onClick={() => sc.retrySite(p.id)} data-testid={`retry-${p.id}`}>Retry</button>}
        {p.state === "no-terrain" && (
          <button type="button" className="primary" onClick={() => sc.setMode("smooth")} data-testid="use-common-smooth">
            {sc.selIds.length === 1 ? "Use the Smooth model" : `Compare all ${sc.selIds.length} sites with the Smooth model`}
          </button>
        )}
        {sc.selIds.length > 1 && <button type="button" onClick={() => sc.removeSite(p.id)}>Remove {p.short}</button>}
      </div>
    </div>
  );
}
