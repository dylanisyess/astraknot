import { DataError, loadDataset } from "./data";
import type { Dataset, DatasetIndex } from "./types";
import { parseUrlState, resolveSites } from "./urlState";

const SCENARIO_KEYS = ["arrival", "days", "delay", "t", "horizon", "sites", "site", "view", "mission", "cam", "layer", "thr"];

export function checkDatasetIndex(index: DatasetIndex): void {
  if (index.index_version !== "1" || !Array.isArray(index.datasets) || !index.datasets.length) throw new DataError("Unsupported or empty dataset index");
  const ids = index.datasets.map((d) => d.id);
  if (new Set(ids).size !== ids.length || !ids.includes(index.default_dataset_id) || !ids.includes(index.legacy_dataset_id)) throw new DataError("Dataset index has duplicate or missing IDs");
  for (const d of index.datasets) {
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(d.id) || !/^data\/(?:[a-z0-9-]+\/)?$/.test(d.dir) || !d.label) throw new DataError("Invalid dataset entry");
  }
}

/** Old scenario URLs retain their original data. A fresh visit uses the expanded release. */
export function chooseDataset(index: DatasetIndex, search: string) {
  checkDatasetIndex(index);
  const q = new URLSearchParams(search);
  const legacyLink = !q.has("ds") && SCENARIO_KEYS.some((key) => q.has(key));
  const id = q.has("ds") ? q.get("ds") : legacyLink ? index.legacy_dataset_id : index.default_dataset_id;
  const choice = index.datasets.find((d) => d.id === id);
  if (!choice) throw new DataError(`Unknown dataset: ${id || "(empty ds parameter)"}. No different dataset was substituted.`);
  return { choice, legacyLink };
}

/** Keep the scenario when explicitly changing datasets; normal bounds checks apply on load. */
export function datasetSearch(search: string, id: string): string {
  const q = new URLSearchParams(search);
  q.set("ds", id);
  return `?${q.toString()}`;
}

export async function loadIndexedDataset(base: string, search: string, fetchImpl: typeof fetch = fetch): Promise<Dataset> {
  const response = await fetchImpl(`${base}data/datasets.json`);
  if (!response.ok) throw new DataError(`Could not load dataset index (HTTP ${response.status})`);
  const index = await response.json() as DatasetIndex;
  const { choice, legacyLink } = chooseDataset(index, search);
  const want = parseUrlState(search).sites;
  const ds = await loadDataset(base, fetchImpl, { dir: choice.dir, expectedId: choice.id, preload: (ids) => resolveSites(want, ids).ids });
  return { ...ds, selection: { index, legacyLink } };
}
