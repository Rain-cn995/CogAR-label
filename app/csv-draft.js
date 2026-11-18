import { hashText, column, validSeconds } from "./first-action.js";

export const createCsvDraftKey = (text) => `cogar:review-draft:v2:${hashText(text)}`;
const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

export function validateReviewDraft(draft, originalRowCount) {
  if (!object(draft) || draft.version !== 2 || draft.originalRowCount !== originalRowCount) return false;
  if (!Array.isArray(draft.headers) || !draft.headers.length || !draft.headers.every((v) => typeof v === "string")) return false;
  if (!Array.isArray(draft.rawRows) || draft.rawRows.length < originalRowCount || !draft.rawRows.every((r) => Array.isArray(r) && r.length === draft.headers.length && r.every((v) => typeof v === "string"))) return false;
  if (![draft.timestampColumn, draft.decisionColumn].every((v) => Number.isInteger(v) && v >= 0 && v < draft.headers.length)) return false;
  const validMap = (map, check) => object(map) && Object.entries(map).every(([key, value]) => /^(0|[1-9]\d*)$/.test(key) && Number(key) < draft.rawRows.length && check(value, Number(key)));
  if (!validMap(draft.timestampOverrides, validSeconds) || !validMap(draft.decisionOverrides, (v) => ["accept", "reject"].includes(v))) return false;
  if (!validMap(draft.excludedRows, (v) => typeof v === "boolean")) return false;
  if (!validMap(draft.removedRows, (v, id) => typeof v === "boolean" && (!v || draft.rawRows[id][column(draft.headers, "action")]?.trim().toLowerCase() === "first action"))) return false;
  if (!validMap(draft.captureInfo, (v) => object(v) && validSeconds(v.startSeconds) && Number.isFinite(v.videoSeconds) && v.videoSeconds >= 0 && typeof v.videoKey === "string" && typeof v.needsReview === "boolean")) return false;
  if (draft.videoStartSeconds !== null && !validSeconds(draft.videoStartSeconds)) return false;
  return Number.isFinite(draft.savedAt);
}

export function readReviewDraft(storage, key, originalRowCount) {
  const value = storage.getItem(key);
  if (value === null) return null;
  const draft = JSON.parse(value);
  if (!validateReviewDraft(draft, originalRowCount)) throw new Error("Saved draft is invalid. Original CSV loaded; saved data was not overwritten.");
  return draft;
}

// Debounce writes, retain pending data on failure, and flush before file changes.
export function createReviewAutosaver(storage, { delay = 300, onStatus = (status) => { void status; } } = {}) {
  let timer = null;
  let pending = null;
  const flush = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    if (!pending) return true;
    try {
      storage.setItem(pending.key, JSON.stringify({ ...pending.draft, version: 2, savedAt: Date.now() }));
      pending = null;
      onStatus("saved");
      return true;
    } catch {
      onStatus("error");
      return false;
    }
  };
  return {
    schedule(key, draft) {
      if (timer !== null) clearTimeout(timer);
      pending = { key, draft };
      onStatus("saving");
      timer = setTimeout(flush, delay);
    },
    flush,
    cancel() { if (timer !== null) clearTimeout(timer); timer = null; pending = null; },
  };
}
