// Lazy loading of screening assets for one or more sites. A failure leaves everything
// else (Surface, timeline, status, Analysis) untouched; Retry clears the failure.
import { useEffect, useState } from "react";
import type { SiteData } from "../types";
import { type SlopeState, cachedSlopeAsset, loadSlopeAsset } from "./slope";

export function useSlopeAssets(sites: SiteData[], enabled: boolean): { states: Record<string, SlopeState>; retry: () => void } {
  const base = import.meta.env.BASE_URL;
  const ids = sites.map((s) => s.site.id).join(",");
  const initial = () => {
    const o: Record<string, SlopeState> = {};
    for (const s of sites) {
      const a = cachedSlopeAsset(base, s.site.id);
      o[s.site.id] = a ? { state: "ready", asset: a } : { state: "idle" };
    }
    return o;
  };
  const [states, setStates] = useState<Record<string, SlopeState>>(initial);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    for (const s of sites) {
      const id = s.site.id;
      const a = cachedSlopeAsset(base, id);
      if (a) {
        setStates((o) => (o[id]?.state === "ready" ? o : { ...o, [id]: { state: "ready", asset: a } }));
        continue;
      }
      setStates((o) => ({ ...o, [id]: { state: "loading" } }));
      loadSlopeAsset(base, s)
        .then((asset) => live && setStates((o) => ({ ...o, [id]: { state: "ready", asset } })))
        .catch((e: unknown) => live && setStates((o) => ({ ...o, [id]: { state: "error", message: e instanceof Error ? e.message : String(e) } })));
    }
    return () => {
      live = false;
    };
  }, [ids, enabled, attempt]); // eslint-disable-line react-hooks/exhaustive-deps
  // states for sites no longer requested are ignored by callers (keyed by site id)
  return { states, retry: () => setAttempt((n) => n + 1) };
}
