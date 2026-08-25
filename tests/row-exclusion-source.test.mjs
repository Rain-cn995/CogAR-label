import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const page = new URL("../app/page.tsx", import.meta.url);
const styles = new URL("../app/globals.css", import.meta.url);

test("row exclusion state is reset with CSV lifecycle and filters CSV export", async () => {
  const source = await readFile(page, "utf8");

  assert.match(source, /excludedRows/);
  assert.match(source, /setExcludedRows\(\{\}\)/);
  assert.match(source, /sortedRecords\.filter\(\(record\) => !excludedRows\[record\.id\]\)/);
});

test("event table exposes a row include toggle and dimmed excluded-row styling", async () => {
  const [source, css] = await Promise.all([
    readFile(page, "utf8"),
    readFile(styles, "utf8"),
  ]);

  assert.match(source, /Exclude sorted row \$\{sortedIndex \+ 1\} from CSV export/);
  assert.match(source, /Include sorted row \$\{sortedIndex \+ 1\} in CSV export/);
  assert.match(source, /row-exclude-button/);
  assert.match(source, /is-excluded/);
  assert.match(css, /tbody tr\.is-excluded/);
  assert.match(css, /\.row-exclude-button/);
});
