// CSV event helpers are independent of React so annotation rules can be tested.
export const METADATA_COLUMNS = ["event_id", "source_ai_event_id", "trial_id", "ai_correctness", "ai_correctness_reviewed", "first_action_source_selected", "annotation_note"];
const contextNames = new Set(["participant_id", "participant", "sheet", "session", "session_id", "recording_id", "plan_id", "plan", "task", "task_id", "step", "step_name", "trial_id"]);
export const normalize = (value) => String(value ?? "").trim().toLowerCase();
export const column = (headers, name) => headers.findIndex((header) => normalize(header) === name);
export const cell = (record, headers, name) => record?.values[column(headers, name)] ?? "";
export const isFirstAction = (record, headers) => normalize(cell(record, headers, "action")) === "first action";
export const isAiAudio = (record, headers) => normalize(cell(record, headers, "action")) === "ai audio";
export const eventId = (record, headers) => cell(record, headers, "event_id");
export const trialId = (record, headers) => cell(record, headers, "trial_id");
function contextKey(record, headers) {
  const get = (name) => cell(record, headers, name).trim();
  const step = get("step");
  return JSON.stringify([
    get("sheet") || get("participant_id") || get("participant") || "local",
    get("session_id") || get("session") || get("recording_id"),
    get("plan_id") || get("task_id") || get("plan") || get("task"),
    step && Number.isFinite(Number(step)) ? String(Number(step)) : step,
  ]);
}
export const sameTrial = (a, b, headers) => !!trialId(a, headers) && trialId(a, headers) === trialId(b, headers) && contextKey(a, headers) === contextKey(b, headers);

export function relinkMarker(marker, source, headers) {
  return marker.values.map((value, index) => normalize(headers[index]) === "source_ai_event_id" ? eventId(source, headers) : contextNames.has(normalize(headers[index])) ? source.values[index] ?? "" : value);
}
export const validSeconds = (value) => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 8_640_000_000_000;

export function hashText(value) {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < value.length; i += 1) {
    hash ^= BigInt(value.charCodeAt(i));
    hash = BigInt.asUintN(64, hash * 0x100000001b3n);
  }
  return hash.toString(36);
}

export function prepareRows(inputHeaders, inputRows, namespace) {
  const headers = [...inputHeaders];
  for (const name of METADATA_COLUMNS) if (column(headers, name) < 0) headers.push(name);
  const rows = inputRows.map((row) => Array.from({ length: headers.length }, (_, i) => row[i] ?? ""));
  const sessions = new Map();
  const occurrences = new Map();
  const finished = new Set();
  rows.forEach((values, index) => {
    const read = (name) => values[column(headers, name)] ?? "";
    const person = read("sheet") || read("participant_id") || read("participant") || "local";
    const session = read("session_id") || read("session") || read("recording_id");
    const plan = read("plan_id") || read("task_id") || read("plan") || read("task");
    const scope = JSON.stringify([person, session, plan]);
    const action = normalize(read("action"));
    if (action === "start") sessions.set(scope, (sessions.get(scope) ?? 0) + 1);
    const rawStep = read("step").trim();
    const step = rawStep && Number.isFinite(Number(rawStep)) ? String(Number(rawStep)) : rawStep;
    const key = JSON.stringify([scope, sessions.get(scope) ?? 0, step]);
    if (action === "ai audio" && finished.has(key)) {
      occurrences.set(key, (occurrences.get(key) ?? 0) + 1);
      finished.delete(key);
    }
    // Keep imported identities; array position is only a local rendering handle.
    if (!read("event_id")) values[column(headers, "event_id")] = `${namespace}-event-${index}`;
    if (!read("trial_id") && step && plan) values[column(headers, "trial_id")] = `${namespace}-trial-${hashText(key)}-${occurrences.get(key) ?? 0}`;
    if (action === "complete" && step) finished.add(key);
  });
  return { headers, rows };
}

export function correctness(source, records, headers) {
  if (!source) return { value: "unknown", reason: "Select an AI audio event." };
  const explicit = normalize(cell(source, headers, "ai_correctness"));
  const manual = cell(source, headers, "ai_correctness_reviewed") === "true";
  if (manual && ["wrong", "correct", "unknown"].includes(explicit)) return { value: explicit, reason: "Manually reviewed for this AI cue." };
  const evidence = new Set();
  for (const record of records.filter((row) => sameTrial(row, source, headers) && !isFirstAction(row, headers))) {
    const reliance = normalize(cell(record, headers, "reliance"));
    if (["over_rely", "app_reject"].includes(reliance)) evidence.add("wrong");
    if (["app_rely", "under_rely"].includes(reliance)) evidence.add("correct");
  }
  if (["wrong", "correct"].includes(explicit)) evidence.add(explicit);
  if (evidence.size > 1) return { value: "unknown", reason: "Conflicting correctness evidence. Review this cue explicitly." };
  if (evidence.size === 1) return { value: [...evidence][0], reason: "From imported correctness / reliance metadata." };
  return { value: "unknown", reason: "No correctness metadata. Classify this cue explicitly." };
}

export function sourceCandidates(record, records, headers) {
  return records.filter((row) => isAiAudio(row, headers) && sameTrial(row, record, headers));
}

export function sourceFor(marker, records, headers) {
  const linked = cell(marker, headers, "source_ai_event_id");
  const matches = records.filter((row) => eventId(row, headers) === linked && isAiAudio(row, headers));
  return matches.length === 1 ? matches[0] : null;
}

export function sourceIssues(source, records, headers, excluded = {}) {
  if (!source || !isAiAudio(source, headers)) return ["Select an original AI audio event."];
  const issues = [];
  if (!trialId(source, headers)) issues.push("Task and step are missing; this cue cannot be assigned to a trial.");
  if (!validSeconds(source.seconds)) issues.push("The AI onset timestamp is invalid.");
  if (records.filter((r) => eventId(r, headers) === eventId(source, headers)).length !== 1) issues.push("Duplicate source event ID; repair the CSV IDs before annotating.");
  if (excluded[source.id]) issues.push("The source AI audio is excluded from export.");
  if (correctness(source, records, headers).value !== "wrong") issues.push("Confirm that the AI suggestion is wrong before recording.");
  if (sourceCandidates(source, records, headers).length > 1 && cell(source, headers, "first_action_source_selected") !== "true") issues.push("Multiple AI cues in this trial. Choose the intended original cue explicitly.");
  return issues;
}

export function validateMarker(marker, records, headers, excluded = {}) {
  const source = sourceFor(marker, records, headers);
  const errors = sourceIssues(source, records, headers, excluded);
  const warnings = [];
  if (!validSeconds(marker.seconds)) errors.push("First action timestamp is invalid.");
  if (source) {
    if (!sameTrial(source, marker, headers)) errors.push("First action and AI cue belong to different trials.");
    if (validSeconds(marker.seconds) && validSeconds(source.seconds) && marker.seconds < source.seconds) errors.push("First action is before AI onset. Record a note instead of moving the timestamp to onset.");
    const duplicates = records.filter((r) => isFirstAction(r, headers) && sameTrial(r, marker, headers) && !excluded[r.id]);
    if (duplicates.length > 1) errors.push("Multiple First action markers in this trial. Remove or exclude the duplicate.");
    const participant = (row) => cell(row, headers, "sheet") || cell(row, headers, "participant_id") || cell(row, headers, "participant");
    const task = (row) => cell(row, headers, "plan_id") || cell(row, headers, "task_id") || cell(row, headers, "plan") || cell(row, headers, "task");
    const session = (row) => cell(row, headers, "session_id") || cell(row, headers, "session") || cell(row, headers, "recording_id");
    const crossedNextCue = records.some((row) => isAiAudio(row, headers) && !sameTrial(row, source, headers) && !excluded[row.id]
      && participant(row) === participant(source) && task(row) === task(source) && session(row) === session(source)
      && validSeconds(row.seconds) && row.seconds > source.seconds && row.seconds < marker.seconds);
    if (crossedNextCue) warnings.push("First action is after the next trial's AI cue; review the trial boundary.");
    for (const row of records.filter((r) => sameTrial(r, marker, headers) && !excluded[r.id] && validSeconds(r.seconds))) {
      const action = normalize(cell(row, headers, "action"));
      if (validSeconds(marker.seconds) && row.seconds < marker.seconds && ["ai accepted", "ai rejected", "recovery audio", "complete"].includes(action)) warnings.push(`First action is after ${cell(row, headers, "action")}; review the annotation.`);
    }
  }
  if (records.filter((r) => eventId(r, headers) === eventId(marker, headers)).length !== 1) errors.push("Duplicate First action event ID; repair the CSV IDs.");
  return { errors: [...new Set(errors)], warnings: [...new Set(warnings)] };
}

export function serializeTimestamp(seconds, header, sample = "") {
  if (!validSeconds(seconds)) throw new Error("Invalid timestamp");
  const unit = normalize(header);
  let factor = /(^|[_\s])ns($|[_\s])|nanosecond/.test(unit) ? 1e9 : /(^|[_\s])us($|[_\s])|microsecond/.test(unit) ? 1e6 : /(^|[_\s])ms($|[_\s])|millisecond/.test(unit) ? 1e3 : null;
  if (factor === null && sample.trim() && Number.isFinite(Number(sample))) {
    const n = Math.abs(Number(sample));
    factor = n > 1e16 ? 1e9 : n > 1e13 ? 1e6 : n > 1e10 ? 1e3 : 1;
  }
  return factor === null ? new Date(seconds * 1000).toISOString() : String(seconds * factor);
}

export function makeMarker(source, headers, timestampColumn, seconds, id, note = "") {
  const values = headers.map((header, index) => contextNames.has(normalize(header)) ? source.values[index] ?? "" : "");
  const put = (name, value) => { const index = column(headers, name); if (index >= 0) values[index] = value; };
  put("action", "First action");
  put("event_id", id);
  put("source_ai_event_id", eventId(source, headers));
  put("detail", "First observable action toward a task object");
  put("annotation_note", note);
  values[timestampColumn] = serializeTimestamp(seconds, headers[timestampColumn], source.values[timestampColumn] ?? "");
  return values;
}

export function captureSeconds(video, startSeconds, verified) {
  if (!video || !verified || !validSeconds(startSeconds)) throw new Error("Load a video and verify its clock alignment first.");
  if (video.readyState < 2 || video.seeking) throw new Error("Wait for the video frame to finish loading or seeking.");
  if (!Number.isFinite(video.duration) || video.duration <= 0 || !Number.isFinite(video.currentTime) || video.currentTime < 0 || video.currentTime > video.duration) throw new Error("The current frame is outside the recording.");
  video.pause();
  return Math.round((startSeconds + video.currentTime) * 1000) / 1000;
}

export function markerExportErrors(records, headers, excluded) {
  return records.filter((r) => isFirstAction(r, headers) && !excluded[r.id]).flatMap((r) => validateMarker(r, records, headers, excluded).errors.map((error) => `Row ${r.id + 1}: ${error}`));
}
