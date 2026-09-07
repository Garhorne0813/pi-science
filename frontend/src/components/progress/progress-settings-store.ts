import { apiRequest } from "../../lib/client/api";
import { defaultProgressAppearance, type ProgressAppearance } from "@pi-science/contracts";
import { settingsApi } from "../../lib/settings/settings-api";
import { normalizeProgressAppearance, type ProgressSlot } from "./ProgressPatternCatalog";

/** Single controller for the progress appearance: the shared preview/draft,
 *  its save queue and its hydration all live here so every consumer (the
 *  conversation view, the settings tab, the module-level preview) observes
 *  one coherent state. Edits carry a revision; receipts and hydration reads
 *  may only reconcile a draft they actually produced. */

const SAVE_DEBOUNCE_MS = 250;
const SAVE_RETRY_BASE_MS = 1_000;
const SAVE_RETRY_MAX_MS = 30_000;

export interface ProgressSettingsSnapshot {
  appearance: ProgressAppearance;
  /** A save request is in flight. */
  saving: boolean;
  /** The latest save failed; the queued draft retries with backoff. */
  saveError: boolean;
  /** Local edits the server has not confirmed yet. */
  dirty: boolean;
}

type SaveJob = { appearance: ProgressAppearance; revision: number };

let current: ProgressAppearance = structuredClone(defaultProgressAppearance);
let revision = 0;
let dirty = false;
let saving = false;
let saveError = false;
let retryDelayMs = SAVE_RETRY_BASE_MS;
let saveTimer: ReturnType<typeof setTimeout> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let hydration: Promise<void> | null = null;
let hydrated = false;
let inFlight = false;
let pending: SaveJob | null = null;

const listeners = new Set<() => void>();
let snapshot: ProgressSettingsSnapshot = { appearance: current, saving, saveError, dirty };

function notify(): void {
  snapshot = { appearance: current, saving, saveError, dirty };
  listeners.forEach((listener) => listener());
}

export function getProgressSettings(): ProgressSettingsSnapshot { return snapshot; }
export function subscribeProgressSettings(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/* ── Preview surface (consumed by ProgressVisual) ── */

export function getProgressAppearance(): ProgressAppearance { return current; }
export function subscribeProgressAppearance(listener: () => void): () => void { return subscribeProgressSettings(listener); }
/** Set the shared state directly, without editing semantics. Test and seed paths. */
export function setProgressAppearance(next: ProgressAppearance): void {
  current = normalizeProgressAppearance(next);
  notify();
}

/* ── Edit entry points ── */

/** Local edit: adopts the next appearance, queues a debounced save. */
export function updateProgressAppearance(next: ProgressAppearance): void {
  current = normalizeProgressAppearance(structuredClone(next));
  revision += 1;
  dirty = true;
  saveError = false;
  queueSave();
  notify();
}

/** A manual pattern selection leaves the preset identity: preset bundles are
 *  pattern sets, and a legal explicit choice must survive normalization
 *  instead of being re-interpreted as a stale preset default. */
export function updateProgressPattern(slot: ProgressSlot, pattern: ProgressAppearance["patterns"][ProgressSlot]): void {
  updateProgressAppearance({ ...current, preset: "custom", patterns: { ...current.patterns, [slot]: pattern } });
}

export function updateProgressPreset(preset: ProgressAppearance["preset"], patterns?: ProgressAppearance["patterns"]): void {
  updateProgressAppearance({ ...current, preset, ...(patterns ? { patterns } : {}) });
}

/* ── Save queue ── */

function queueSave(): void {
  pending = { appearance: structuredClone(current), revision };
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { saveTimer = null; void flush(); }, SAVE_DEBOUNCE_MS);
}

function scheduleRetry(): void {
  if (retryTimer) clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    retryDelayMs = Math.min(retryDelayMs * 2, SAVE_RETRY_MAX_MS);
    void flush();
  }, retryDelayMs);
}

async function flush(): Promise<void> {
  if (inFlight) return;
  inFlight = true;
  saving = true;
  notify();
  try {
    while (pending) {
      const job = pending;
      pending = null;
      try {
        const confirmed = await settingsApi.saveProgress(job.appearance);
        retryDelayMs = SAVE_RETRY_BASE_MS;
        saveError = false;
        // The receipt may only reconcile a draft it actually produced. When
        // newer edits happened during the request they keep their state and
        // their own queued save; an older receipt never rolls them back.
        if (job.revision === revision) {
          current = normalizeProgressAppearance(confirmed ?? job.appearance);
          dirty = false;
        }
        notify();
      } catch {
        // Keep the unsaved state queued: the newest edit — or this job when
        // nothing newer exists — retries until the server confirms it.
        saveError = true;
        if (!pending) pending = job;
        scheduleRetry();
        return;
      }
    }
  } finally {
    inFlight = false;
    saving = false;
    notify();
  }
}

/* ── Hydration ── */

export function hydrateProgressAppearance(): Promise<void> {
  if (hydration) return hydration;
  const atRevision = revision;
  hydration = (async () => {
    try {
      const data = await apiRequest<{ progress_appearance?: ProgressAppearance }>("/api/settings/config");
      // A snapshot read at request start must not roll back edits made while
      // it was in flight (or unsaved edits from a failed save).
      if (data.progress_appearance && atRevision === revision && !dirty && !inFlight) {
        current = normalizeProgressAppearance(structuredClone(data.progress_appearance));
        dirty = false;
        hydrated = true;
        notify();
      }
    } catch {
      hydration = null; // allow a later retry
    }
  })();
  return hydration;
}

/** Seed from an already fetched settings payload. Applies only when nothing
 *  else has established the appearance yet (no edits, no completed hydration). */
export function seedProgressAppearance(server: ProgressAppearance | undefined): void {
  if (!server || revision !== 0 || hydrated) return;
  current = normalizeProgressAppearance(structuredClone(server));
  notify();
}

/* ── Page-close best effort ── */

if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    const job = pending;
    if (!job || job.revision !== revision) return;
    // A queued draft must at least be attempted: keepalive requests survive
    // the unload even though their result cannot be observed here.
    void fetch("/api/settings/progress", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(job.appearance),
      credentials: "include",
      keepalive: true,
    }).catch(() => undefined);
  });
}

/* ── Test-only ── */

export function resetProgressSettingsForTests(): void {
  if (saveTimer) clearTimeout(saveTimer);
  if (retryTimer) clearTimeout(retryTimer);
  saveTimer = null;
  retryTimer = null;
  current = structuredClone(defaultProgressAppearance);
  revision = 0;
  dirty = false;
  saving = false;
  saveError = false;
  retryDelayMs = SAVE_RETRY_BASE_MS;
  hydration = null;
  hydrated = false;
  inFlight = false;
  pending = null;
  notify();
}
