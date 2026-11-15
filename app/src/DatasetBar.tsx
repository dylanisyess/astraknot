import { useEffect, useRef } from "react";
import { datasetSearch } from "./datasets";
import type { Dataset } from "./types";

/**
 * Current dataset coverage (always visible). Other releases are reached from "Details": the
 * accepted earlier dataset sits there under "Previous dataset". A legacy link keeps a visible
 * switch to the current release.
 */
export function DatasetBar({ ds, search }: { ds: Dataset; search: string }) {
  const ref = useRef<HTMLDetailsElement>(null);
  // Escape or a click elsewhere closes the disclosure (it floats over the page).
  useEffect(() => {
    const close = (e: Event) => {
      const d = ref.current;
      if (!d?.open) return;
      if (e instanceof KeyboardEvent ? e.key === "Escape" : !d.contains(e.target as Node)) {
        d.open = false;
        if (e instanceof KeyboardEvent) d.querySelector("summary")?.focus();
      }
    };
    window.addEventListener("keydown", close);
    window.addEventListener("pointerdown", close);
    return () => {
      window.removeEventListener("keydown", close);
      window.removeEventListener("pointerdown", close);
    };
  }, []);
  if (!ds.selection) return null;
  const { index } = ds.selection;
  const current = index.datasets.find((d) => d.id === ds.manifest.dataset_id)!;
  const legacy = current.id === index.legacy_dataset_id;
  const others = index.datasets.filter((d) => d.id !== current.id);
  return (
    <aside className="dataset-bar" aria-label="Dataset coverage" data-testid="dataset-bar">
      <span className="ds-cov">
        <strong>{current.label}</strong> · {ds.manifest.coverage_start_utc.slice(0, 10)} to {ds.manifest.coverage_end_utc.slice(0, 10)} UTC · 10-minute samples
      </span>
      {legacy ? (
        <>
          <span>Original dataset retained for this link.</span>
          {others.map((d) => (
            <a key={d.id} href={datasetSearch(search, d.id)}>Switch to {d.label}</a>
          ))}
        </>
      ) : (
        others.length > 0 && (
          <details className="ds-details" ref={ref} data-testid="dataset-details">
            <summary aria-label="Dataset details">Details</summary>
            <div className="ds-pop">
              <p className="ds-h">Current dataset</p>
              <p>
                <code>{current.id}</code>: {current.label}, {ds.manifest.coverage_start_utc.slice(0, 10)} to {ds.manifest.coverage_end_utc.slice(0, 10)} UTC, 10-minute samples.
              </p>
              <p className="ds-h">Previous dataset</p>
              {others.map((d) => (
                <p key={d.id}>
                  {d.label}, kept unchanged for earlier links. <a href={datasetSearch(search, d.id)}>Open accepted 60-day dataset</a>
                </p>
              ))}
            </div>
          </details>
        )
      )}
    </aside>
  );
}
