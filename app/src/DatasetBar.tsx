import { datasetSearch } from "./datasets";
import type { Dataset } from "./types";

export function DatasetBar({ ds, search }: { ds: Dataset; search: string }) {
  if (!ds.selection) return null;
  const { index } = ds.selection;
  const current = index.datasets.find((d) => d.id === ds.manifest.dataset_id)!;
  const legacy = current.id === index.legacy_dataset_id;
  return (
    <aside className="dataset-bar" aria-label="Dataset coverage" data-testid="dataset-bar">
      <span><strong>{current.label}</strong> · {ds.manifest.coverage_start_utc.slice(0, 10)} to {ds.manifest.coverage_end_utc.slice(0, 10)} UTC · 10-minute samples</span>
      {legacy && <span>Original dataset retained for this link.</span>}
      {index.datasets.filter((d) => d.id !== current.id).map((d) => (
        <a key={d.id} href={datasetSearch(search, d.id)}>{legacy ? "Switch to 120 days / 4 sites" : "Open accepted 60-day dataset"}</a>
      ))}
    </aside>
  );
}
