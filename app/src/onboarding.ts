// First-visit introduction and the guided Apollo 17 example (presentation only).
// - Entry intent is decided from the URL the visitor arrived with, captured in main.tsx before
//   the app rewrites the address to the canonical scenario (useScenario writes defaults).
// - "Onboarded" is a per-browser convenience flag; storage may be unavailable, in which case it
//   lives in memory for this page only.
// - The example is an ordinary scenario link of the current dataset; every number shown about it
//   comes from the scenario's own computeMetrics results, never from this file.

import { writeUrlState } from "./urlState";

/** URL parameters that make a link an explicit scenario (or dataset) request. */
export const ENTRY_KEYS = ["arrival", "days", "delay", "t", "horizon", "sites", "site", "view", "mission", "cam", "layer", "thr", "ds"] as const;

/** True when the visitor arrived with a scenario link: it loads directly, with no introduction. */
export function isExplicitScenario(search: string): boolean {
  const q = new URLSearchParams(search);
  return ENTRY_KEYS.some((k) => q.has(k));
}

export const ONBOARDED_KEY = "lvn.onboarded";
let memoryFlag = false;

/** Storage that may throw (private mode, blocked site data) or be missing. */
export type FlagStore = Pick<Storage, "getItem" | "setItem"> | null | undefined;
const defaultStore = (): FlagStore => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

export function readOnboarded(store: FlagStore = defaultStore()): boolean {
  if (memoryFlag) return true;
  try {
    return store?.getItem(ONBOARDED_KEY) === "1";
  } catch {
    return false;
  }
}

/** Records that the introduction was completed or skipped. Never throws. */
export function writeOnboarded(store: FlagStore = defaultStore()): void {
  memoryFlag = true;
  try {
    store?.setItem(ONBOARDED_KEY, "1");
  } catch {
    /* storage unavailable: the in-memory flag covers this page */
  }
}

/** For tests. */
export function resetOnboardedMemory(): void {
  memoryFlag = false;
}

/** Show the welcome screen: a root visit without a scenario, by a visitor who has not finished or skipped it. */
export function showWelcomeOnEntry(entrySearch: string, store?: FlagStore): boolean {
  return !isExplicitScenario(entrySearch) && !readOnboarded(store);
}

/**
 * The guided example: a hypothetical 14-day Terrain mission at the historic Apollo 17 landing
 * site within the 120-day dataset. Chosen from the site's own data (see docs/STATUS.md,
 * "Onboarding"): the arrival is shortly before a modeled sunrise, so the baseline has nearly
 * continuous sunlight and the +3-day slip runs into lunar night. The guide applies the delay;
 * the example starts with none.
 */
export const EXAMPLE = {
  datasetId: "lvn-2026-12-01-120d",
  siteId: "apollo17-lm",
  arrival: "2027-01-13T00:00:00Z",
  days: 14,
  delay: 3,
  horizon: "terrain",
} as const;

/** Search string that loads the example (no delay yet; viewing time at the arrival; Site overview). */
export function exampleSearch(): string {
  const url = writeUrlState(new URL("http://localhost/"), {
    arrival: Date.parse(EXAMPLE.arrival),
    days: EXAMPLE.days,
    delay: 0,
    t: new Date(Date.parse(EXAMPLE.arrival)).toISOString().replace(".000Z", "Z"),
    horizon: EXAMPLE.horizon,
    sites: [EXAMPLE.siteId],
    site: EXAMPLE.siteId,
    view: "explore",
    mission: "baseline",
    cam: "overview",
  });
  url.searchParams.set("ds", EXAMPLE.datasetId);
  return url.search;
}

/** Does the current address already hold the example's starting scenario? */
export function isExampleScenario(search: string): boolean {
  const q = new URLSearchParams(search);
  const e = new URLSearchParams(exampleSearch());
  return ["ds", "sites", "site", "arrival", "days", "delay", "horizon"].every((k) => q.get(k) === e.get(k));
}

export type GuideStep = 1 | 2 | 3;
