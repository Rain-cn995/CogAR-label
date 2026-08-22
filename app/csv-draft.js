const DRAFT_PREFIX = "cogar:timestamp-draft:v1";
const MAX_DATE_SECONDS = 8_640_000_000_000;

function hashText(value) {
  let hash = 0xcbf29ce484222325n;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(36);
}

export function createCsvDraftKey(file, csvText) {
  void file;
  return `${DRAFT_PREFIX}:${hashText(csvText)}`;
}

export function filterTimestampOverrides(overrides, rowCount) {
  return Object.fromEntries(Object.entries(overrides).filter(([rowId]) => Number(rowId) < rowCount));
}

export function writeTimestampDraft(storage, key, draft, savedAt = Date.now()) {
  storage.setItem(key, JSON.stringify({
    version: 1,
    timestampColumn: draft.timestampColumn,
    timestampOverrides: draft.timestampOverrides,
    savedAt,
  }));
}

export function readTimestampDraft(storage, key) {
  const value = storage.getItem(key);
  if (value === null) return null;
  try {
    const draft = JSON.parse(value);
    const overrides = draft?.timestampOverrides;
    const validOverrides = overrides !== null
      && typeof overrides === "object"
      && !Array.isArray(overrides)
      && Object.entries(overrides).every(([rowId, seconds]) => (
        /^\d+$/.test(rowId)
        && String(Number(rowId)) === rowId
        && Number.isFinite(seconds)
        && Math.abs(seconds) <= MAX_DATE_SECONDS
      ));
    if (
      draft?.version !== 1
      || !Number.isInteger(draft.timestampColumn)
      || draft.timestampColumn < 0
      || !validOverrides
      || !Number.isFinite(draft.savedAt)
    ) return null;
    return draft;
  } catch {
    return null;
  }
}

export function removeTimestampDraft(storage, key) {
  storage.removeItem(key);
}

export function createTimestampDraftAutosaver(storage, options = {}) {
  const delay = options.delay ?? 300;
  const now = options.now ?? Date.now;
  const onStatus = options.onStatus ?? (() => {});
  let timeoutId = null;
  let pendingDraft = null;

  const persistPendingDraft = () => {
    if (pendingDraft === null) return true;
    const { key, draft } = pendingDraft;
    timeoutId = null;
    try {
      writeTimestampDraft(storage, key, draft, now());
      pendingDraft = null;
      onStatus("saved");
      return true;
    } catch {
      onStatus("error");
      return false;
    }
  };

  return {
    schedule(key, draft) {
      if (timeoutId !== null) clearTimeout(timeoutId);
      pendingDraft = { key, draft };
      onStatus("saving");
      timeoutId = setTimeout(persistPendingDraft, delay);
    },
    cancel() {
      if (timeoutId !== null) clearTimeout(timeoutId);
      timeoutId = null;
      pendingDraft = null;
    },
    flush() {
      if (timeoutId !== null) clearTimeout(timeoutId);
      return persistPendingDraft();
    },
  };
}
