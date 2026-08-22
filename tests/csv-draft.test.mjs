import assert from "node:assert/strict";
import test from "node:test";

import {
  createTimestampDraftAutosaver,
  createCsvDraftKey,
  filterTimestampOverrides,
  readTimestampDraft,
  removeTimestampDraft,
  writeTimestampDraft,
} from "../app/csv-draft.js";

class MemoryStorage {
  #values = new Map();

  getItem(key) { return this.#values.get(key) ?? null; }
  setItem(key, value) { this.#values.set(key, String(value)); }
  removeItem(key) { this.#values.delete(key); }
}

test("uses CSV contents to distinguish drafts for files with the same metadata", () => {
  const file = { name: "events.csv", size: 42, lastModified: 1_787_070_000_000 };

  const firstKey = createCsvDraftKey(file, "timestamp,label\n100,first");
  const secondKey = createCsvDraftKey(file, "timestamp,label\n200,second");

  assert.notEqual(firstKey, secondKey);
  assert.equal(firstKey, createCsvDraftKey(file, "timestamp,label\n100,first"));
});

test("recognizes identical CSV contents after the file is downloaded again", () => {
  const csvText = "timestamp,label\n100,first";

  assert.equal(
    createCsvDraftKey({ name: "events.csv", size: 42, lastModified: 1 }, csvText),
    createCsvDraftKey({ name: "events-copy.csv", size: 42, lastModified: 2 }, csvText),
  );
});

test("drops saved edits for rows that are not present in the uploaded CSV", () => {
  assert.deepEqual(
    filterTimestampOverrides({ 0: 100, 2: 200, 5: 500 }, 3),
    { 0: 100, 2: 200 },
  );
});

test("restores the timestamp column and finite timestamp overrides", () => {
  const storage = new MemoryStorage();
  const draft = {
    timestampColumn: 2,
    timestampOverrides: { 0: 1_787_070_000.125, 7: 1_787_070_012.5 },
  };

  writeTimestampDraft(storage, "draft-key", draft, 1_787_070_099_000);

  assert.deepEqual(readTimestampDraft(storage, "draft-key"), {
    version: 1,
    timestampColumn: 2,
    timestampOverrides: { 0: 1_787_070_000.125, 7: 1_787_070_012.5 },
    savedAt: 1_787_070_099_000,
  });
});

test("ignores malformed or incompatible saved drafts", () => {
  const storage = new MemoryStorage();
  storage.setItem("broken-json", "{");
  storage.setItem("wrong-version", JSON.stringify({
    version: 2,
    timestampColumn: 0,
    timestampOverrides: {},
    savedAt: 1,
  }));
  storage.setItem("invalid-override", JSON.stringify({
    version: 1,
    timestampColumn: 0,
    timestampOverrides: { 3: null },
    savedAt: 1,
  }));
  storage.setItem("out-of-range-date", JSON.stringify({
    version: 1,
    timestampColumn: 0,
    timestampOverrides: { 0: 1e300 },
    savedAt: 1,
  }));
  storage.setItem("noncanonical-row", JSON.stringify({
    version: 1,
    timestampColumn: 0,
    timestampOverrides: { "01": 100 },
    savedAt: 1,
  }));

  assert.equal(readTimestampDraft(storage, "broken-json"), null);
  assert.equal(readTimestampDraft(storage, "wrong-version"), null);
  assert.equal(readTimestampDraft(storage, "invalid-override"), null);
  assert.equal(readTimestampDraft(storage, "out-of-range-date"), null);
  assert.equal(readTimestampDraft(storage, "noncanonical-row"), null);
});

test("discarding a draft removes its saved edits", () => {
  const storage = new MemoryStorage();
  writeTimestampDraft(storage, "draft-key", {
    timestampColumn: 1,
    timestampOverrides: { 2: 1_787_070_012.5 },
  });

  removeTimestampDraft(storage, "draft-key");

  assert.equal(readTimestampDraft(storage, "draft-key"), null);
});

test("debounces rapid edits and saves only the latest timestamp", async () => {
  const storage = new MemoryStorage();
  const statuses = [];
  const autosaver = createTimestampDraftAutosaver(storage, {
    delay: 10,
    now: () => 1_787_070_099_000,
    onStatus: (status) => statuses.push(status),
  });

  autosaver.schedule("draft-key", { timestampColumn: 0, timestampOverrides: { 1: 10 } });
  autosaver.schedule("draft-key", { timestampColumn: 0, timestampOverrides: { 1: 20 } });
  await new Promise((resolve) => setTimeout(resolve, 25));

  assert.deepEqual(readTimestampDraft(storage, "draft-key")?.timestampOverrides, { 1: 20 });
  assert.equal(statuses.at(-1), "saved");
});

test("reports an autosave error when browser storage rejects a write", async () => {
  const storage = new MemoryStorage();
  storage.setItem = () => { throw new Error("quota exceeded"); };
  const statuses = [];
  const autosaver = createTimestampDraftAutosaver(storage, {
    delay: 5,
    onStatus: (status) => statuses.push(status),
  });

  autosaver.schedule("draft-key", { timestampColumn: 0, timestampOverrides: { 1: 20 } });
  await new Promise((resolve) => setTimeout(resolve, 15));

  assert.equal(statuses.at(-1), "error");
});

test("flushes a pending edit before the debounce delay finishes", () => {
  const storage = new MemoryStorage();
  const autosaver = createTimestampDraftAutosaver(storage, { delay: 10_000 });

  autosaver.schedule("draft-key", { timestampColumn: 0, timestampOverrides: { 4: 25 } });
  autosaver.flush();

  assert.deepEqual(readTimestampDraft(storage, "draft-key")?.timestampOverrides, { 4: 25 });
});

test("reports when a pending edit cannot be flushed", () => {
  const storage = new MemoryStorage();
  storage.setItem = () => { throw new Error("quota exceeded"); };
  const autosaver = createTimestampDraftAutosaver(storage, { delay: 10_000 });

  autosaver.schedule("draft-key", { timestampColumn: 0, timestampOverrides: { 4: 25 } });

  assert.equal(autosaver.flush(), false);
});

test("keeps a failed debounced write pending for a later flush", async () => {
  const storage = new MemoryStorage();
  storage.setItem = () => { throw new Error("quota exceeded"); };
  const autosaver = createTimestampDraftAutosaver(storage, { delay: 5 });

  autosaver.schedule("draft-key", { timestampColumn: 0, timestampOverrides: { 4: 25 } });
  await new Promise((resolve) => setTimeout(resolve, 15));

  assert.equal(autosaver.flush(), false);
});
