import assert from "node:assert/strict";
import test from "node:test";
import { mountPage, text } from "./helpers/component-harness.mjs";

test("component handlers record only from the selected audio end, preserve legacy links, and restore drafts", async () => {
  const storage = new Map();
  const downloads = [];
  const previous = { window: globalThis.window, document: globalThis.document, create: URL.createObjectURL, revoke: URL.revokeObjectURL };
  globalThis.window = { localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) }, addEventListener() {}, removeEventListener() {}, confirm: () => true };
  globalThis.document = { createElement: () => ({ click() {} }) };
  URL.createObjectURL = (blob) => {
    if (blob.type === "text/csv;charset=utf-8") downloads.push(blob);
    return "blob:synthetic";
  };
  URL.revokeObjectURL = () => {};
  const iso = (seconds) => new Date(Date.parse("2026-08-17T14:00:00Z") + seconds * 1000).toISOString();
  const csv = [
    "participant_id,sheet,plan_id,step,step_name,action,event_timestamp_iso,reliance,review_decision,event_id,source_ai_event_id,annotation_note",
    `1,p37,boba,,Task,start,${iso(0)},,,start,,`,
    `1,p37,boba,2,Sugar,AI audio,${iso(2)},,,sugar-onset,,`,
    `1,p37,boba,2,Sugar,AI audio end,${iso(6)},,,sugar-first-end,,`,
    `1,p37,boba,2,Sugar,AI audio end,${iso(7)},,,sugar-second-end,,`,
    `1,p37,boba,2,Sugar,AI accepted,${iso(10)},,accept,sugar-decision,,`,
    `1,p37,boba,3,Correct,AI audio end,${iso(14)},,,correct-end,,`,
    `1,p37,boba,3,Correct,AI accepted,${iso(18)},app_rely,accept,correct-decision,,`,
    `1,p37,boba,4,Legacy,AI audio,${iso(20)},,,legacy-onset,,`,
    `1,p37,boba,4,Legacy,First action,${iso(21)},,,legacy-marker,legacy-onset,imported note`,
    `1,p37,boba,4,Legacy,AI audio end,${iso(22)},,,legacy-end,,`,
    `1,p37,boba,4,Legacy,AI accepted,${iso(24)},over_rely,accept,legacy-decision,,`,
  ].join("\n");
  const app = await mountPage();
  const find = (predicate) => {
    const node = app.nodes().find(predicate);
    assert.ok(node, "Expected rendered element");
    return node;
  };
  const button = (label) => find((node) => node.type === "button" && text(node) === label);
  const capture = () => find((node) => node.props.className === "capture-button");
  const click = async (label) => {
    const node = button(label);
    assert.ok(!node.props.disabled, `${label} enabled`);
    await app.act(() => node.props.onClick());
  };
  const upload = async (contents, name = "events.csv") => app.act(() => find((node) => node.type === "input" && node.props.accept?.startsWith(".csv")).props.onChange({ target: { files: [{ name, text: async () => contents }], value: "fake" } }));
  const rows = () => app.nodes().filter((node) => node.type === "tr" && node.props.className !== undefined);
  const rowAt = (seconds) => rows().find((row) => text(row).includes(iso(seconds)));
  const markers = () => rows().filter((node) => node.props.className.includes("is-first-action"));
  const sugarMarker = () => markers().find((node) => text(node).includes("Sugar"));
  const timestampControls = (row) => row.props.children.flat(Infinity).find((node) => node?.type === "td" && node.props.className === "time-column").props.children.props.children;
  const edit = async (row) => app.act(() => timestampControls(row)[1].props.onClick());
  const notice = () => text(find((node) => node.props.className === "review-notice"));
  const panel = () => text(find((node) => node.type === "section" && node.props["aria-label"] === "First action annotation"));
  const setClock = async (value) => {
    await app.act(() => find((node) => node.type === "input" && node.props.placeholder === "2026-08-17T14:23:06.881Z").props.onChange({ target: { value } }));
    await click("Apply standard time");
  };

  try {
    assert.equal(capture().props.disabled, true);
    assert.match(panel(), /Select an AI audio end row/);
    await upload(csv);
    assert.equal(rows().length, 11);
    assert.equal(capture().props.disabled, true);
    assert.equal(timestampControls(rowAt(7))[0].props.disabled, false);
    await app.act(() => timestampControls(rowAt(7))[0].props.onClick());
    assert.match(panel(), /Step 2: Sugar/);
    assert.equal(capture().props.disabled, true);
    assert.equal(app.nodes().some((node) => ["Annotation note", "AI suggestion correctness"].includes(node.props["aria-label"])), false);
    assert.equal(app.nodes().some((node) => node.props.className === "clock-confirmation"), false);
    await app.act(() => capture().props.onClick());
    assert.match(notice(), /Load the recording/);
    assert.equal(sugarMarker(), undefined);

    await app.act(() => find((node) => node.type === "input" && node.props.accept === "video/*").props.onChange({ target: { files: [{ name: "test.mp4", size: 100, lastModified: 1, type: "video/mp4" }] } }));
    let pauses = 0;
    const video = { currentSrc: "blob:synthetic", readyState: 1, seeking: false, duration: 30, currentTime: 0, pause() { pauses += 1; }, focus() {} };
    const mediaEvent = async (name) => app.act(() => find((node) => node.type === "video").props[name]({ currentTarget: video }));
    find((node) => node.type === "video").props.ref.current = video;
    await mediaEvent("onLoadedMetadata");
    assert.equal(capture().props.disabled, true);
    video.readyState = 2;
    await mediaEvent("onLoadedData");
    assert.equal(capture().props.disabled, false);

    for (const [field, invalid] of [["readyState", 1], ["seeking", true], ["duration", Infinity], ["duration", 0], ["currentTime", -0.01], ["currentTime", 31], ["currentTime", NaN], ["currentSrc", "blob:previous"]]) {
      const previousValue = video[field];
      video[field] = invalid;
      assert.equal(capture().props.disabled, false, `${field} is tested before the corresponding media event`);
      await app.act(() => capture().props.onClick());
      assert.equal(sugarMarker(), undefined, `${field} blocked the live capture`);
      video[field] = previousValue;
    }
    assert.equal(pauses, 0);
    video.seeking = true;
    await mediaEvent("onSeeking");
    assert.equal(capture().props.disabled, true);
    video.seeking = false;
    await mediaEvent("onSeeked");
    assert.equal(capture().props.disabled, false);

    await edit(rowAt(2));
    assert.equal(capture().props.disabled, true);
    await app.act(() => capture().props.onClick());
    assert.match(notice(), /Select an AI audio end row/);
    assert.equal(sugarMarker(), undefined);
    const endRowAccept = rowAt(7).props.children.flat(Infinity).find((node) => node?.props?.className === "decision-column").props.children.props.children[0];
    await app.act(() => endRowAccept.props.onClick());
    assert.equal(capture().props.disabled, true, "editing an end-row decision does not select it for capture");
    await edit(rowAt(7));
    video.currentTime = 6.125;
    await click("Record first action");
    assert.equal(markers().length, 2);
    assert.match(panel(), /-0\.875 s from AI audio end/);
    assert.match(panel(), /elapsed time is negative/);
    assert.ok(!text(sugarMarker()).includes("AcceptReject"));
    video.currentTime = 8;
    await click("Update from video");
    assert.equal(markers().length, 2);
    assert.match(panel(), /1\.000 s from AI audio end/);
    await edit(rowAt(6));
    assert.equal(capture().props.disabled, true);
    assert.match(panel(), /already has a First action linked to another cue/);

    await edit(sugarMarker());
    assert.equal(capture().props.disabled, true);
    assert.equal(app.nodes().some((node) => node.props.className === "use-current-button"), false);
    assert.ok(app.nodes().some((node) => node.type === "option" && text(node).includes("AI audio end")));
    video.currentTime = 9;
    await app.act(() => capture().props.onClick());
    assert.match(panel(), /1\.000 s from AI audio end/);
    await app.act(() => find((node) => node.props.className === "standard-time-input").props.onChange({ target: { value: iso(31) } }));
    await click("Apply ISO");
    assert.match(notice(), /outside this video/);

    await edit(rowAt(22));
    assert.equal(capture().props.disabled, true, "selecting the legacy trial end leaves its onset link in place");
    await edit(rowAt(21));
    assert.match(panel(), /1\.000 s from AI audio onset/);
    await edit(rowAt(14));
    assert.equal(capture().props.disabled, false, "imported correct classification does not gate capture");

    await edit(sugarMarker());
    await setClock(iso(1));
    await click("Export edited CSV");
    assert.equal(downloads.length, 0);
    assert.match(notice(), /clock/);
    await click("Recalculate from captured frame");
    assert.ok(panel().includes(iso(9)));
    await setClock(iso(0));
    await click("Recalculate from captured frame");
    assert.ok(panel().includes(iso(8)));
    await click("Export edited CSV");
    assert.equal(downloads.length, 1);
    const exported = await downloads[0].text();
    assert.match(exported, /"First action"[^\n]+"sugar-second-end"/);
    assert.match(exported, /"legacy-marker","legacy-onset","imported note"/);
    await upload(exported, "reimport.csv");
    assert.equal(markers().length, 2);
    await edit(sugarMarker());
    assert.match(panel(), /1\.000 s from AI audio end/);
    assert.ok(!app.nodes().some((node) => node.props.className === "annotation-errors"));
    await click("Remove first action");
    assert.equal(sugarMarker(), undefined);
    await click("Undo removal");
    await click("Remove first action");
    await click("Reset");
    await upload(exported, "reimport.csv");
    assert.equal(sugarMarker(), undefined);
    await click("Undo removal");
    assert.match(panel(), /1\.000 s from AI audio end/);
    assert.ok(text(rowAt(10)).includes("AI accepted"));
    const toggle = rowAt(7).props.children[0].props.children;
    await app.act(() => toggle.props.onClick());
    await click("Export edited CSV");
    assert.equal(downloads.length, 1);
    assert.match(notice(), /excluded/);
  } finally {
    app.dispose();
    globalThis.window = previous.window;
    globalThis.document = previous.document;
    URL.createObjectURL = previous.create;
    URL.revokeObjectURL = previous.revoke;
  }
});
