"use client";

import { ChangeEvent, DragEvent, useEffect, useMemo, useRef, useState } from "react";

import { METADATA_COLUMNS, column, cell, eventId, trialId, sameTrial, isAiAudio, isAiAudioEnd, isAiCue, isFirstAction, prepareRows, sourceCandidates, sourceFor, sourceIssues, validateMarker, makeMarker, captureSeconds, videoFrameIssue, validSeconds, markerExportErrors, serializeTimestamp, hashText, relinkMarker } from "./first-action.js";
import { createCsvDraftKey, readReviewDraft, createReviewAutosaver } from "./csv-draft.js";

type CaptureInfo = { startSeconds: number; videoSeconds: number; videoKey: string; needsReview: boolean };
type CsvRecord = { id: number; values: string[]; seconds: number | null };
type DecisionValue = "accept" | "reject";

const TIMESTAMP_HINTS = ["timestamp", "time_stamp", "video_time", "video timestamp", "elapsed", "elapsed_time", "start_time", "start", "time", "seconds", "sec"];
const DECISION_HINTS = ["decision", "review_decision", "accept_reject", "status", "label", "result", "judgement", "judgment"];

function splitCsvLine(line: string, delimiter: string) {
  const cells: string[] = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') { value += '"'; index += 1; }
      else quoted = !quoted;
    } else if (character === delimiter && !quoted) { cells.push(value.trim()); value = ""; }
    else value += character;
  }
  cells.push(value.trim());
  return cells;
}

function parseCsv(text: string) {
  const normalized = text.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const firstLine = normalized.split("\n").find((line) => line.trim()) ?? "";
  const delimiter = [",", "\t", ";"].sort((a, b) => splitCsvLine(firstLine, b).length - splitCsvLine(firstLine, a).length)[0];
  const logicalRows: string[] = [];
  let buffer = "";
  let quoted = false;
  for (const line of normalized.split("\n")) {
    buffer = buffer ? `${buffer}\n${line}` : line;
    if ((line.match(/"/g) ?? []).length % 2 === 1) quoted = !quoted;
    if (!quoted && buffer.trim()) { logicalRows.push(buffer); buffer = ""; }
  }
  if (buffer.trim()) logicalRows.push(buffer);
  const rows = logicalRows.map((line) => splitCsvLine(line, delimiter));
  const headers = rows.shift() ?? [];
  return { headers: headers.map((header, index) => header || `Column ${index + 1}`), rows: rows.filter((row) => row.some(Boolean)) };
}

function normalizeNumericTimestamp(value: number, header: string) {
  const unit = header.toLowerCase();
  if (/(^|[_\s])ns($|[_\s])|nanosecond/.test(unit)) return value / 1_000_000_000;
  if (/(^|[_\s])us($|[_\s])|microsecond/.test(unit)) return value / 1_000_000;
  if (/(^|[_\s])ms($|[_\s])|millisecond/.test(unit)) return value / 1000;
  if (Math.abs(value) > 10_000_000_000_000_000) return value / 1_000_000_000;
  if (Math.abs(value) > 10_000_000_000_000) return value / 1_000_000;
  if (Math.abs(value) > 10_000_000_000) return value / 1000;
  return value;
}

function getAbsoluteTimestamp(raw: string, header: string) {
  const value = raw.trim();
  if (!value) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    const normalized = normalizeNumericTimestamp(numeric, header);
    if (normalized > 1_000_000 && Math.abs(normalized) <= 8_640_000_000_000) return normalized;
  }
  const date = Date.parse(value);
  return Number.isFinite(date) && Math.abs(date) <= 8_640_000_000_000_000 ? date / 1000 : null;
}

function formatTime(seconds: number) {
  const safe = Math.max(0, seconds || 0);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const remainder = safe % 60;
  const secondText = remainder.toFixed(remainder % 1 ? 2 : 0).padStart(2, "0");
  return hours > 0 ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${secondText}` : `${String(minutes).padStart(2, "0")}:${secondText}`;
}

function formatIso(seconds: number) {
  return new Date(seconds * 1000).toISOString();
}

function formatVideoTime(seconds: number) {
  const sign = seconds < 0 ? "−" : "+";
  const safe = Math.abs(seconds);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const remainder = (safe % 60).toFixed(3).padStart(6, "0");
  return `${sign}${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${remainder}`;
}

function findTimestampColumn(headers: string[]) {
  const normalized = headers.map((header) => header.trim().toLowerCase());
  for (const hint of TIMESTAMP_HINTS) { const exact = normalized.indexOf(hint); if (exact >= 0) return exact; }
  const partial = normalized.findIndex((header) => /time|stamp|elapsed|second/.test(header));
  return partial >= 0 ? partial : 0;
}

function normalizeDecision(value: string): DecisionValue | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "accept" || normalized === "accepted") return "accept";
  if (normalized === "reject" || normalized === "rejected") return "reject";
  return null;
}

function findDecisionColumn(headers: string[], rows: string[][]) {
  const normalizedHeaders = headers.map((header) => header.trim().toLowerCase());
  for (const hint of DECISION_HINTS) {
    const exact = normalizedHeaders.indexOf(hint);
    if (exact >= 0) return exact;
  }
  return headers.findIndex((_, columnIndex) => rows.some((row) => normalizeDecision(row[columnIndex] ?? "") !== null));
}

function quoteCsv(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

export default function Home() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const csvInputRef = useRef<HTMLInputElement>(null);
  const [videoUrl, setVideoUrl] = useState("");
  const [videoName, setVideoName] = useState("");
  const [videoSize, setVideoSize] = useState(0);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [frameReady, setFrameReady] = useState(false);
  const [headers, setHeaders] = useState<string[]>([]);
  const [rawRows, setRawRows] = useState<string[][]>([]);
  const [csvName, setCsvName] = useState("");
  const [timestampColumn, setTimestampColumn] = useState(0);
  const [decisionColumn, setDecisionColumn] = useState(0);
  const [activeRow, setActiveRow] = useState<number | null>(null);
  const [selectedEndRow, setSelectedEndRow] = useState<number | null>(null);
  const [timestampOverrides, setTimestampOverrides] = useState<Record<number, number>>({});
  const [decisionOverrides, setDecisionOverrides] = useState<Record<number, DecisionValue>>({});
  const [excludedRows, setExcludedRows] = useState<Record<number, boolean>>({});
  const [videoStartSeconds, setVideoStartSeconds] = useState<number | null>(null);
  const [videoStartText, setVideoStartText] = useState("");
  const [videoStartSource, setVideoStartSource] = useState<"none" | "auto" | "manual">("none");
  const [seekNotice, setSeekNotice] = useState("");
  const [timestampDraftEdit, setTimestampDraftEdit] = useState<{ rowId: number | null; value: string }>({ rowId: null, value: "" });
  const [dragging, setDragging] = useState<"video" | "csv" | null>(null);

  const [removedRows, setRemovedRows] = useState<Record<number, boolean>>({});
  const [captureInfo, setCaptureInfo] = useState<Record<number, CaptureInfo>>({});
  const [videoKey, setVideoKey] = useState("");
  const [draftKey, setDraftKey] = useState("");
  const [originalRowCount, setOriginalRowCount] = useState(0);
  const [saveStatus, setSaveStatus] = useState("idle");
  const [showMetadata, setShowMetadata] = useState(false);
  const [lastRemoved, setLastRemoved] = useState<number | null>(null);
  const autosaver = useRef<ReturnType<typeof createReviewAutosaver> | null>(null);
  const loadSequence = useRef(0);

  useEffect(() => {
    try { autosaver.current = createReviewAutosaver(window.localStorage, { onStatus: setSaveStatus }); }
    catch { queueMicrotask(() => setSaveStatus("error")); }
    const flush = () => { autosaver.current?.flush(); };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (autosaver.current && !autosaver.current.flush()) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", beforeUnload);
    return () => { flush(); window.removeEventListener("pagehide", flush); window.removeEventListener("beforeunload", beforeUnload); };
  }, []);

  useEffect(() => {
    if (!draftKey) return;
    autosaver.current?.schedule(draftKey, { originalRowCount, headers, rawRows, timestampColumn, decisionColumn, timestampOverrides, decisionOverrides, excludedRows, removedRows, captureInfo, videoStartSeconds });
  }, [draftKey, originalRowCount, headers, rawRows, timestampColumn, decisionColumn, timestampOverrides, decisionOverrides, excludedRows, removedRows, captureInfo, videoStartSeconds]);

  useEffect(() => {
    if (!headers.length || draftKey) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [headers.length, draftKey]);

  useEffect(() => () => { if (videoUrl) URL.revokeObjectURL(videoUrl); }, [videoUrl]);

  const baseRecords = useMemo<CsvRecord[]>(() => {
    const timeHeader = headers[timestampColumn] ?? "";
    return rawRows.map((values, id) => ({ id, values, seconds: getAbsoluteTimestamp(values[timestampColumn] ?? "", timeHeader) }));
  }, [headers, rawRows, timestampColumn]);
  const records = useMemo<CsvRecord[]>(() => baseRecords.map((record) => ({
    ...record,
    seconds: timestampOverrides[record.id] ?? record.seconds,
  })).filter((record) => !removedRows[record.id]), [baseRecords, timestampOverrides, removedRows]);
  const sortedRecords = useMemo(() => [...records].sort((left, right) => {
    if (left.seconds === null && right.seconds === null) return left.id - right.id;
    if (left.seconds === null) return 1;
    if (right.seconds === null) return -1;
    return left.seconds - right.seconds || left.id - right.id;
  }), [records]);
  const validRecordCount = records.filter((record) => record.seconds !== null).length;
  const excludedRecordCount = records.filter((record) => excludedRows[record.id]).length;
  const exportRecordCount = Math.max(0, records.length - excludedRecordCount);
  const activeRecord = activeRow === null ? null : records.find((record) => record.id === activeRow) ?? null;
  const activeDecision = activeRow === null ? null : decisionOverrides[activeRow] ?? normalizeDecision(rawRows[activeRow]?.[decisionColumn] ?? "");
  const activeRank = activeRow === null ? 0 : sortedRecords.findIndex((record) => record.id === activeRow) + 1;
  const editorMinimum = videoStartSeconds ?? activeRecord?.seconds ?? 0;
  const editorMaximum = videoStartSeconds !== null ? videoStartSeconds + Math.max(duration, 1) : Math.max(...records.map((record) => record.seconds ?? 0), 1);
  const timestampDraft = timestampDraftEdit.rowId === activeRow ? timestampDraftEdit.value : activeRecord && activeRecord.seconds !== null ? formatIso(activeRecord.seconds) : "";
  const hasCalibratedVideo = !!videoUrl && videoStartSeconds !== null && validSeconds(videoStartSeconds) && Number.isFinite(duration) && duration > 0;

  useEffect(() => {
    if (!videoName || !baseRecords.length || videoStartSource !== "none") return;
    const ignored = new Set(["video", "recording", "compressed", "clip", "part", "mov", "mp4", "webm"]);
    const tokens = videoName.toLowerCase().replace(/\.[^.]+$/, "").split(/[^a-z0-9]+/).filter((token) => token.length >= 3 && !ignored.has(token) && !/^p?\d+$/.test(token));
    const match = baseRecords.find((record) => !isFirstAction(record, headers) && tokens.some((token) => record.values.some((value) => value.toLowerCase().includes(token))));
    const start = match?.seconds ?? baseRecords.find((record) => !isFirstAction(record, headers) && record.seconds !== null)?.seconds ?? null;
    if (start !== null) {
      let cancelled = false;
      queueMicrotask(() => {
        if (cancelled) return;
        setVideoStartSeconds(start);
        setVideoStartText(formatIso(start));
        setVideoStartSource("auto");
        setSeekNotice(`Video start set to ${formatIso(start)}`);
      });
      return () => {
        cancelled = true;
      };
    }
  }, [baseRecords, videoName, videoStartSource, headers]);

  const loadVideo = (file?: File) => {
    if (!file || !file.type.startsWith("video/")) return;
    setVideoUrl((current) => { if (current) URL.revokeObjectURL(current); return URL.createObjectURL(file); });
    const nextKey = `${file.name}:${file.size}:${file.lastModified}`;
    const savedCaptures = Object.values(captureInfo).filter((info) => info.videoKey === nextKey);
    const savedStart = savedCaptures.length && savedCaptures.every((info) => Math.abs(info.startSeconds - savedCaptures[0].startSeconds) <= 0.0005) ? savedCaptures[0].startSeconds : null;
    setDuration(0); setFrameReady(false); setVideoKey(nextKey);
    setVideoStartSeconds(savedStart); setVideoStartText(savedStart === null ? "" : formatIso(savedStart));
    setVideoName(file.name); setVideoSize(file.size); setCurrentTime(0); setActiveRow((current) => current === selectedEndRow ? current : null); setVideoStartSource(savedStart === null ? "none" : "manual"); setSeekNotice("");
  };

  const syncVideoFrame = (video: HTMLVideoElement) => {
    setDuration(Number.isFinite(video.duration) ? video.duration : 0);
    setCurrentTime(Number.isFinite(video.currentTime) ? video.currentTime : 0);
    setFrameReady(video.currentSrc === videoUrl && !videoFrameIssue(video));
  };

  const protectPendingEdits = () => {
    if (!headers.length) return true;
    if (draftKey && autosaver.current && autosaver.current.flush()) return true;
    setSeekNotice("Draft could not be saved. Export your CSV before replacing it or resetting.");
    return window.confirm("Draft saving failed. Have you exported your work? Continue without saving this draft?");
  };

  const loadCsv = async (file?: File) => {
    if (!file) return;
    const sequence = ++loadSequence.current;
    try {
      const text = await file.text();
      if (sequence !== loadSequence.current || !protectPendingEdits()) return;
      const parsed = parseCsv(text);
      if (!parsed.headers.length || !parsed.rows.length) { setSeekNotice("Choose a CSV with a header and at least one event."); return; }
      const prepared = prepareRows(parsed.headers, parsed.rows, hashText(text));
      const nextHeaders = prepared.headers;
      const nextRows = prepared.rows;
      let nextDecisionColumn = findDecisionColumn(nextHeaders, nextRows);
      if (nextDecisionColumn < 0) {
        nextDecisionColumn = nextHeaders.length; nextHeaders.push("review_decision"); nextRows.forEach((row: string[]) => row.push(""));
      }
      const key = createCsvDraftKey(text);
      let restored = null;
      let notice = "";
      let invalidDraft = false;
      try { restored = readReviewDraft(window.localStorage, key, parsed.rows.length); }
      catch (error) { notice = error instanceof Error ? error.message : "Draft storage is unavailable. Export to save your edits."; invalidDraft = true; }
      autosaver.current?.cancel();
      setDraftKey(invalidDraft ? "" : key); setOriginalRowCount(parsed.rows.length);
      setHeaders(restored?.headers ?? nextHeaders); setRawRows(restored?.rawRows ?? nextRows);
      setTimestampColumn(restored?.timestampColumn ?? findTimestampColumn(nextHeaders)); setDecisionColumn(restored?.decisionColumn ?? nextDecisionColumn);
      setCsvName(file.name); setActiveRow(null); setSelectedEndRow(null); setTimestampOverrides(restored?.timestampOverrides ?? {}); setDecisionOverrides(restored?.decisionOverrides ?? {});
      setExcludedRows(restored?.excludedRows ?? {}); setRemovedRows(restored?.removedRows ?? {}); setCaptureInfo(restored?.captureInfo ?? {}); setLastRemoved(null);
      setTimestampDraftEdit({ rowId: null, value: "" });
      const restoredStart = restored?.videoStartSeconds ?? null;
      setVideoStartSeconds(restoredStart); setVideoStartText(restoredStart === null ? "" : formatIso(restoredStart)); setVideoStartSource(restoredStart === null ? "none" : "manual");
      setSaveStatus(invalidDraft ? "error" : restored ? "restored" : "idle");
      setSeekNotice(notice || (restored ? "Restored saved review." : ""));
    } catch { setSeekNotice("The CSV could not be read. Your current review is still open."); }
  };

  const jumpTo = (record: CsvRecord) => {
    setActiveRow(record.id);
    setSelectedEndRow(isAiAudioEnd(record, headers) ? record.id : null);
    if (record.seconds === null || !videoUrl || !videoRef.current) return;
    const standardSeconds = record.seconds;
    if (videoStartSeconds === null) {
      setSeekNotice("Set the Video Start ISO before jumping");
      return;
    }
    const videoSeconds = standardSeconds - videoStartSeconds;
    if (videoSeconds < 0 || (duration > 0 && videoSeconds > duration)) {
      setSeekNotice(`Row ${record.id + 1} is outside this video · adjust Video Start ISO`);
      return;
    }
    const video = videoRef.current;
    const target = Math.max(0, Math.min(videoSeconds, duration > 0 ? Math.max(0, duration - 0.01) : videoSeconds));
    const applySeek = () => {
      video.currentTime = target;
      setCurrentTime(target);
      setSeekNotice(`Jumped to ${formatIso(standardSeconds)} · row ${record.id + 1}`);
      video.focus();
    };
    if (video.readyState === 0) video.addEventListener("loadedmetadata", applySeek, { once: true });
    else applySeek();
  };

  const flagChangedRecordingClock = (start: number) => {
    setCaptureInfo((current) => Object.fromEntries(Object.entries(current).map(([id, info]) => [id,
      info.videoKey === videoKey && Math.abs(info.startSeconds - start) > 0.0005
        ? { ...info, needsReview: true } : info,
    ])));
  };

  const alignAllToCurrentTime = (rowId: number) => {
    const standardSeconds = records.find((record) => record.id === rowId)?.seconds;
    if (standardSeconds === null || standardSeconds === undefined) return;
    const start = standardSeconds - (videoRef.current?.currentTime ?? currentTime);
    flagChangedRecordingClock(start);
    setVideoStartSeconds(start);
    setVideoStartText(formatIso(start));
    setVideoStartSource("manual");
    setSeekNotice(`Video start set to ${formatIso(start)}`);
  };

  const updateTimestamp = (rowId: number, nextSeconds: number) => {
    const targetRecord = records.find((record) => record.id === rowId);
    if (targetRecord && isFirstAction(targetRecord, headers)) {
      if (!Number.isFinite(nextSeconds) || Math.abs(nextSeconds) > 8_640_000_000_000) { setSeekNotice("Invalid First action timestamp."); return false; }
      if (videoUrl && videoStartSeconds !== null && (nextSeconds < videoStartSeconds || nextSeconds > videoStartSeconds + duration)) { setSeekNotice("First action is outside this video. The timestamp was not changed."); return false; }
      const proposed = { ...targetRecord, seconds: nextSeconds };
      const validation = validateMarker(proposed, records.map((row) => row.id === rowId ? proposed : row), headers, excludedRows);
      if (validation.errors.length) { setSeekNotice(validation.errors[0]); return false; }
      if (hasCalibratedVideo) setCaptureInfo((current) => ({ ...current, [rowId]: { startSeconds: videoStartSeconds, videoSeconds: nextSeconds - videoStartSeconds, videoKey, needsReview: false } }));
    }
    const safe = targetRecord && isFirstAction(targetRecord, headers) ? nextSeconds : Math.max(editorMinimum, Math.min(Number.isFinite(nextSeconds) ? nextSeconds : editorMinimum, editorMaximum));
    setTimestampOverrides((current) => ({ ...current, [rowId]: Math.round(safe * 1000) / 1000 }));
    setActiveRow(rowId);
    setTimestampDraftEdit({ rowId: null, value: "" });
    if (videoRef.current && videoStartSeconds !== null && duration > 0) {
      const target = safe - videoStartSeconds;
      videoRef.current.currentTime = target;
      setCurrentTime(target);
    }
    return true;
  };

  const applyVideoStartText = () => {
    const parsed = getAbsoluteTimestamp(videoStartText, "event_timestamp_iso");
    if (parsed === null) {
      setSeekNotice("Video Start ISO is invalid");
      return;
    }
    flagChangedRecordingClock(parsed);
    setVideoStartSeconds(parsed);
    setVideoStartText(formatIso(parsed));
    setVideoStartSource("manual");
    setSeekNotice(`Video start set to ${formatIso(parsed)}`);
  };

  const applyTimestampDraft = (rowId: number) => {
    const parsed = getAbsoluteTimestamp(timestampDraft, "event_timestamp_iso");
    if (parsed === null) {
      setSeekNotice("Standard timestamp is invalid");
      return;
    }
    if (!updateTimestamp(rowId, parsed)) return;
    setTimestampDraftEdit({ rowId, value: formatIso(parsed) });
  };

  const resetTimestamp = (rowId: number) => {
    const record = records.find((row) => row.id === rowId);
    if (record && isFirstAction(record, headers)) {
      const original = baseRecords.find((row) => row.id === rowId)?.seconds;
      if (original === null || original === undefined || !updateTimestamp(rowId, original)) return;
    }
    setTimestampDraftEdit({ rowId: null, value: "" });
    setTimestampOverrides((current) => {
      const next = { ...current };
      delete next[rowId];
      return next;
    });
  };

  const updateDecision = (rowId: number, decision: DecisionValue) => {
    if (isFirstAction(records.find((row) => row.id === rowId), headers)) return;
    setDecisionOverrides((current) => ({ ...current, [rowId]: decision }));
    if (activeRow !== rowId) setSelectedEndRow(null);
    setActiveRow(rowId);
  };

  const toggleRowExcluded = (rowId: number) => {
    setExcludedRows((current) => ({ ...current, [rowId]: !current[rowId] }));
  };

  const undoRemovalId = lastRemoved !== null && removedRows[lastRemoved] ? lastRemoved : Object.keys(removedRows).map(Number).filter((id) => removedRows[id]).at(-1) ?? null;
  const activeIsMarker = !!activeRecord && isFirstAction(activeRecord, headers);
  const selectedEnd = activeRecord && activeRecord.id === selectedEndRow && isAiAudioEnd(activeRecord, headers) ? activeRecord : null;
  const activeSource = activeIsMarker ? sourceFor(activeRecord, records, headers) as CsvRecord | null : selectedEnd;
  const trialMarkers = selectedEnd ? records.filter((row) => isFirstAction(row, headers) && sameTrial(row, selectedEnd, headers)) : [];
  const activeMarker = activeIsMarker ? activeRecord : trialMarkers.find((row) => cell(row, headers, "source_ai_event_id") === eventId(selectedEnd, headers)) ?? null;
  const endSourceIssue = selectedEnd && (sourceIssues(selectedEnd, records, headers, excludedRows)[0]
    ?? (trialMarkers.length > 1 ? "Remove duplicate markers before recording again." : null)
    ?? (trialMarkers.length && !activeMarker ? "This trial already has a First action linked to another cue. Review that marker to change its source." : null));
  const selectEndPrompt = "Select an AI audio end row to record a first action.";
  const activeValidation = activeMarker ? validateMarker(activeMarker, records, headers, excludedRows) : { errors: [], warnings: [] };
  const captureNeedsReview = (id: number) => {
    const info = captureInfo[id];
    return !!info?.needsReview;
  };
  const exportIssues = markerExportErrors(records, headers, excludedRows);
  const alignmentIssues = records.filter((row) => isFirstAction(row, headers) && !excludedRows[row.id] && captureNeedsReview(row.id));
  const visibleColumns = headers.map((name, index) => ({ name, index })).filter(({ name }) => showMetadata || !METADATA_COLUMNS.includes(name.toLowerCase()));

  const linkMarker = (marker: CsvRecord, source: CsvRecord) => {
    const repeatedOnset = isAiAudio(source, headers) && sourceCandidates(source, records, headers).filter((row) => isAiAudio(row, headers)).length > 1;
    setRawRows((current) => current.map((values, id) => {
      if (id === marker.id) return relinkMarker(marker, source, headers);
      if (id !== source.id || !repeatedOnset) return values;
      const next = [...values];
      next[column(headers, "first_action_source_selected")] = "true";
      return next;
    }));
  };

  const recordFirstAction = () => {
    if (!selectedEnd) { setSeekNotice(selectEndPrompt); return; }
    if (endSourceIssue) { setSeekNotice(endSourceIssue); return; }
    const video = videoRef.current;
    if (!videoUrl || !video || video.currentSrc !== videoUrl) { setSeekNotice("Load the recording before capturing."); return; }
    try {
      const seconds = captureSeconds(video, videoStartSeconds);
      const existing = activeMarker;
      const id = existing?.id ?? rawRows.length;
      const values = existing ? [...existing.values] : makeMarker(selectedEnd, headers, timestampColumn, seconds, crypto.randomUUID());
      values[timestampColumn] = serializeTimestamp(seconds, headers[timestampColumn], selectedEnd.values[timestampColumn] ?? "");
      const marker = { id, values, seconds };
      const nextRecords = existing ? records.map((row) => row.id === id ? marker : row) : [...records, marker];
      const check = validateMarker(marker, nextRecords, headers, { ...excludedRows, [id]: false });
      if (check.errors.length) { setSeekNotice(check.errors[0]); return; }
      setRawRows((current) => existing ? current.map((row, rowId) => rowId === id ? values : row) : [...current, values]);
      setTimestampOverrides((current) => { const next = { ...current }; delete next[id]; return next; });
      setExcludedRows((current) => ({ ...current, [id]: false }));
      setCaptureInfo((current) => ({ ...current, [id]: { startSeconds: videoStartSeconds!, videoSeconds: video.currentTime, videoKey, needsReview: false } }));
      setTimestampDraftEdit({ rowId: null, value: "" });
      setSeekNotice(check.warnings[0] ?? `First action recorded at ${formatIso(seconds)}`);
    } catch (error) { setSeekNotice(error instanceof Error ? error.message : "Could not capture this frame."); }
  };

  const removeMarker = (id: number) => {
    setRemovedRows((current) => ({ ...current, [id]: true })); setLastRemoved(id);
    if (activeIsMarker) setSelectedEndRow(null);
    setActiveRow(activeSource?.id ?? null); setSeekNotice("First action removed. Use Undo removal to restore it.");
  };

  const exportCsv = () => {
    const errors = markerExportErrors(records, headers, excludedRows);
    const stale = records.filter((row) => isFirstAction(row, headers) && !excludedRows[row.id] && captureNeedsReview(row.id));
    if (errors.length || stale.length) { setSeekNotice(errors[0] ?? "Review captures after changing the video clock before exporting."); return; }
    const rows = sortedRecords.filter((record) => !excludedRows[record.id]).map((record) => rawRows[record.id].map((cell, columnId) => {
      if (columnId === timestampColumn && timestampOverrides[record.id] !== undefined) return serializeTimestamp(timestampOverrides[record.id], headers[columnId], record.values[columnId] ?? "");
      if (columnId === decisionColumn && decisionOverrides[record.id] !== undefined) return decisionOverrides[record.id];
      return cell;
    }));
    const content = [headers, ...rows].map((row) => row.map((cell) => quoteCsv(cell ?? "")).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${csvName.replace(/\.csv$/i, "") || "timestamps"}-edited.csv`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setSeekNotice("Exported CSV with linked First action events.");
  };

  const handleDrop = (event: DragEvent, kind: "video" | "csv") => {
    event.preventDefault(); setDragging(null);
    const file = event.dataTransfer.files[0];
    if (kind === "video") loadVideo(file); else void loadCsv(file);
  };

  const resetAll = () => {
    if (!protectPendingEdits()) return;
    loadSequence.current += 1; autosaver.current?.cancel(); setDraftKey(""); setRemovedRows({}); setCaptureInfo({}); setFrameReady(false); setSelectedEndRow(null); setLastRemoved(null); setSaveStatus("idle");
    setVideoUrl(""); setVideoName(""); setVideoSize(0); setHeaders([]); setRawRows([]); setCsvName(""); setCurrentTime(0); setDuration(0); setActiveRow(null); setTimestampOverrides({}); setDecisionOverrides({}); setExcludedRows({}); setTimestampDraftEdit({ rowId: null, value: "" }); setVideoStartSeconds(null); setVideoStartText(""); setVideoStartSource("none"); setSeekNotice("");
  };

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand"><div className="brand-mark" aria-hidden="true">C</div><div><p className="eyebrow">RESEARCH CONSOLE</p><h1>Cog<span>AR</span></h1></div></div>
        <div className="session-copy"><span className={`status-dot ${videoUrl && headers.length ? "ready" : ""}`} /><div><strong>Video timestamp review</strong><small>Local files · nothing is uploaded</small></div></div>
        <button className="reset-button" type="button" onClick={resetAll} disabled={!videoUrl && !headers.length}>Reset</button>
      </header>

      <section className="hero">
        <div><p className="eyebrow">POST-TASK REVIEW</p><h2>Review every event<br />in its exact moment.</h2></div>
        <p>Load a recording and its CSV. Every recognized timestamp becomes a direct link into the video, so one click takes you to the corresponding frame.</p>
      </section>

      <section className="review-grid">
        <article className="video-panel">
          <div className="panel-header"><div><span>01</span><div><strong>Recording</strong><small>{videoName || "No video selected"}</small></div></div><time>{videoStartSeconds !== null ? <><span>{formatIso(videoStartSeconds + currentTime)}</span><small>VIDEO {formatVideoTime(currentTime)}</small></> : <span>SET VIDEO START ISO</span>}</time></div>
          <div className={`video-stage ${dragging === "video" ? "is-dragging" : ""}`} onDragOver={(event) => { event.preventDefault(); setDragging("video"); }} onDragLeave={() => setDragging(null)} onDrop={(event) => handleDrop(event, "video")}>
            {videoUrl ? <video key={videoUrl} ref={videoRef} src={videoUrl} controls playsInline
              onLoadedMetadata={(event) => syncVideoFrame(event.currentTarget)} onLoadedData={(event) => syncVideoFrame(event.currentTarget)}
              onCanPlay={(event) => syncVideoFrame(event.currentTarget)} onDurationChange={(event) => syncVideoFrame(event.currentTarget)}
              onSeeking={(event) => syncVideoFrame(event.currentTarget)} onSeeked={(event) => syncVideoFrame(event.currentTarget)}
              onTimeUpdate={(event) => syncVideoFrame(event.currentTarget)} onEmptied={() => setFrameReady(false)} onError={() => setFrameReady(false)} /> :
              <button className="empty-stage" type="button" onClick={() => videoInputRef.current?.click()}><span className="upload-symbol">↑</span><strong>Upload your video</strong><small>Click to browse or drop MP4, MOV, WebM and more</small></button>}
            {seekNotice && videoUrl ? <div className="seek-notice" role="status">{seekNotice}</div> : null}
          </div>
          <div className="video-footer"><label className="file-button">{videoUrl ? "Replace video" : "Choose video"}<input ref={videoInputRef} type="file" accept="video/*" onChange={(event: ChangeEvent<HTMLInputElement>) => loadVideo(event.target.files?.[0])} /></label><div className="file-meta"><strong>{videoName || "Waiting for recording"}</strong><small>{videoSize ? `${(videoSize / 1024 / 1024).toFixed(1)} MB · ${formatTime(duration)}` : "The video stays on this device"}</small></div></div>
        </article>

        <article className="data-panel">
          <div className="panel-header"><div><span>02</span><div><strong>Event data</strong><small>{csvName || "No CSV selected"}</small></div></div><b>{validRecordCount} timestamps</b></div>
          {!headers.length ? (
            <div className={`csv-empty ${dragging === "csv" ? "is-dragging" : ""}`} onDragOver={(event) => { event.preventDefault(); setDragging("csv"); }} onDragLeave={() => setDragging(null)} onDrop={(event) => handleDrop(event, "csv")}>
              <button type="button" onClick={() => csvInputRef.current?.click()}><span className="upload-symbol">↥</span><strong>Upload your CSV</strong><small>Timestamp column is detected automatically</small></button>
            </div>
          ) : (
            <><div className="data-toolbar"><label>TIMESTAMP COLUMN<select value={timestampColumn} onChange={(event) => { if (Object.keys(timestampOverrides).length && !window.confirm("Changing the timestamp column clears timestamp edits. Continue?")) return; setTimestampColumn(Number(event.target.value)); setActiveRow(null); setSelectedEndRow(null); setTimestampOverrides({}); setVideoStartSeconds(null); setVideoStartText(""); setVideoStartSource("none"); setCaptureInfo((current) => Object.fromEntries(Object.entries(current).map(([id, info]) => [id, { ...info, needsReview: true }]))); }}>{headers.map((header, index) => <option value={index} key={`${header}-${index}`}>{header}</option>)}</select></label><label>DECISION COLUMN<select value={decisionColumn} onChange={(event) => { setDecisionColumn(Number(event.target.value)); setDecisionOverrides({}); }}>{headers.map((header, index) => <option value={index} disabled={METADATA_COLUMNS.includes(header.toLowerCase()) || header.toLowerCase() === "action" || index === timestampColumn} key={`decision-${header}-${index}`}>{header}</option>)}</select></label><span className={`alignment-badge ${videoStartSource !== "none" ? "is-aligned" : ""}`}>{videoStartSource === "auto" ? "AUTO VIDEO START" : videoStartSource === "manual" ? "MANUAL VIDEO START" : "START TIME REQUIRED"}</span><span className="sort-badge">EXPORT {exportRecordCount}/{records.length}</span><div className="toolbar-actions"><button type="button" onClick={() => csvInputRef.current?.click()}>Replace CSV</button><button className="export-button" type="button" onClick={exportCsv}>Export edited CSV</button></div></div>
            <div className="video-clock-bar"><label>VIDEO START ISO<input type="text" value={videoStartText} onChange={(event) => setVideoStartText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") applyVideoStartText(); }} placeholder="2026-08-17T14:23:06.881Z" /></label><button type="button" onClick={applyVideoStartText}>Apply standard time</button><span>{videoStartSeconds !== null ? `Current video frame: ${formatIso(videoStartSeconds + currentTime)}` : "Enter the recording's standard start time"}</span></div>
            <div className="review-status" aria-live="polite">
              <span className={saveStatus === "error" ? "error-text" : ""}>{saveStatus === "saved" ? "Draft saved on this device" : saveStatus === "saving" ? "Saving draft…" : saveStatus === "restored" ? "Draft restored" : saveStatus === "error" ? "Draft not saved — export your CSV" : "Draft ready"}</span>
              <label><input type="checkbox" checked={showMetadata} onChange={(event) => setShowMetadata(event.target.checked)} /> Show annotation metadata</label>
              {undoRemovalId !== null && <button type="button" onClick={() => { setRemovedRows((current) => ({ ...current, [undoRemovalId]: false })); setActiveRow(undoRemovalId); setLastRemoved(null); }}>Undo removal</button>}
            </div>
            {seekNotice && <p className="review-notice" role="status">{seekNotice}</p>}
            {(exportIssues.length > 0 || alignmentIssues.length > 0) && <div className="annotation-errors" role="alert"><strong>Resolve annotation issues before export</strong><ul>{exportIssues.slice(0, 5).map((issue: string, index: number) => <li key={index}>{issue}</li>)}{alignmentIssues.map((row) => <li key={row.id}><button type="button" onClick={() => setActiveRow(row.id)}>Review row {row.id + 1}</button>: video or alignment changed.</li>)}</ul></div>}
            </>
          )}
            <section className="first-action-panel" aria-label="First action annotation">
              <div className="first-action-heading"><h3>First action</h3><span>{activeMarker ? "Recorded" : "Not recorded"}</span></div>
              <p>Mark the first observable movement toward a task object, whether correct or incorrect. Looking alone does not count.</p>
              {activeSource && <strong>{cell(activeSource, headers, "sheet") || cell(activeSource, headers, "participant_id")} · {cell(activeSource, headers, "plan") || cell(activeSource, headers, "plan_id")} · Step {cell(activeSource, headers, "step")}: {cell(activeSource, headers, "step_name")}</strong>}
              {!selectedEnd && <p>{selectEndPrompt}</p>}
              {endSourceIssue && <p className="error-text">{endSourceIssue}</p>}
              {selectedEnd && !hasCalibratedVideo && <small>Load the recording and set Video Start ISO to enable capture.</small>}
              {selectedEnd && hasCalibratedVideo && !frameReady && <small>Wait for a video frame to finish loading or seeking.</small>}
              {activeIsMarker && <label>Linked AI cue<select aria-label="Link first action to AI cue" value={activeSource?.id ?? ""} onChange={(event) => {
                const source = records.find((row) => row.id === Number(event.target.value));
                if (source && isAiCue(source, headers) && (!trialId(activeRecord, headers) || sameTrial(source, activeRecord, headers))) linkMarker(activeRecord, source);
              }}><option value="" disabled>Select original AI cue</option>{(trialId(activeRecord, headers) ? sourceCandidates(activeRecord, records, headers) : records.filter((row) => isAiCue(row, headers))).map((row: CsvRecord) => <option key={row.id} value={row.id}>Row {row.id + 1} · {cell(row, headers, "action")} · {cell(row, headers, "step_name")} · {row.seconds === null ? "Invalid time" : formatIso(row.seconds)}</option>)}</select></label>}
              {activeMarker && activeMarker.seconds !== null && <output>{formatIso(activeMarker.seconds)}{activeSource && activeSource.seconds !== null && <small>{(activeMarker.seconds - activeSource.seconds).toFixed(3)} s from {isAiAudioEnd(activeSource, headers) ? "AI audio end" : "AI audio onset"}</small>}</output>}
              <div className="first-action-buttons"><button className="capture-button" type="button" disabled={!selectedEnd || !!endSourceIssue || !hasCalibratedVideo || !frameReady} onClick={recordFirstAction}>{activeMarker ? "Update from video" : "Record first action"}</button>{activeMarker && <><button type="button" disabled={!videoUrl || videoStartSeconds === null} onClick={() => jumpTo(activeMarker)}>Go to first action</button><button type="button" onClick={() => removeMarker(activeMarker.id)}>Remove first action</button></>}</div>
              {activeValidation.errors.map((issue, i) => <p className="error-text" key={`error-${i}`}>{issue}</p>)}
              {activeValidation.warnings.map((issue, i) => <p className="warning-text" key={`warning-${i}`}>{issue}</p>)}
              {activeMarker && captureNeedsReview(activeMarker.id) && <div className="capture-review"><p>The video or clock changed since capture. Review the frame before exporting.</p><button type="button" disabled={!hasCalibratedVideo || captureInfo[activeMarker.id]?.videoKey !== videoKey} onClick={() => updateTimestamp(activeMarker.id, videoStartSeconds! + captureInfo[activeMarker.id].videoSeconds)}>Recalculate from captured frame</button><button type="button" disabled={!hasCalibratedVideo || captureInfo[activeMarker.id]?.videoKey !== videoKey || activeMarker.seconds === null} onClick={() => updateTimestamp(activeMarker.id, activeMarker.seconds!)}>Keep ISO time after review</button></div>}
            </section>
          {headers.length > 0 && <>
            {activeRecord && activeRecord.seconds !== null ? (
              <section className="timestamp-editor" aria-label={`Edit timestamp for row ${activeRecord.id + 1}`}>
                <div className="editor-heading"><div><span>EDIT SORTED ROW {String(activeRank).padStart(2, "0")}</span><strong>{timestampOverrides[activeRecord.id] !== undefined ? "Modified standard timestamp" : "Standard timestamp editor"}</strong></div><div className="editor-output"><output>{formatIso(activeRecord.seconds)}</output><small>VIDEO {videoStartSeconds !== null ? formatVideoTime(activeRecord.seconds - videoStartSeconds) : "—"}</small></div></div>
                {!activeIsMarker && <div className="decision-editor"><span>REVIEW DECISION</span><div className="decision-buttons"><button className={activeDecision === "accept" ? "is-accept" : ""} type="button" onClick={() => updateDecision(activeRecord.id, "accept")} aria-pressed={activeDecision === "accept"}>✓ Accept</button><button className={activeDecision === "reject" ? "is-reject" : ""} type="button" onClick={() => updateDecision(activeRecord.id, "reject")} aria-pressed={activeDecision === "reject"}>× Reject</button></div></div>}
                <input className="time-slider" type="range" min={editorMinimum} max={editorMaximum} step="0.001" value={activeRecord.seconds} onChange={(event) => updateTimestamp(activeRecord.id, Number(event.target.value))} aria-label="Standard timestamp position" disabled={videoStartSeconds === null} />
                <div className="editor-controls">
                  <div className="nudge-buttons" aria-label="Fine timestamp adjustment">
                    <button type="button" onClick={() => updateTimestamp(activeRecord.id, activeRecord.seconds! - 1)}>−1s</button>
                    <button type="button" onClick={() => updateTimestamp(activeRecord.id, activeRecord.seconds! - 0.1)}>−0.1s</button>
                    <button type="button" onClick={() => updateTimestamp(activeRecord.id, activeRecord.seconds! + 0.1)}>+0.1s</button>
                    <button type="button" onClick={() => updateTimestamp(activeRecord.id, activeRecord.seconds! + 1)}>+1s</button>
                  </div>
                  <label>STANDARD TIME ISO<input className="standard-time-input" type="text" value={timestampDraft} onChange={(event) => setTimestampDraftEdit({ rowId: activeRecord.id, value: event.target.value })} onKeyDown={(event) => { if (event.key === "Enter") applyTimestampDraft(activeRecord.id); }} /></label>
                  <button type="button" className="undo-time-button" onClick={() => applyTimestampDraft(activeRecord.id)}>Apply ISO</button>
                  {!activeIsMarker && <button className="use-current-button" type="button" onClick={() => videoStartSeconds !== null && updateTimestamp(activeRecord.id, videoStartSeconds + (videoRef.current?.currentTime ?? currentTime))} disabled={!videoUrl || videoStartSeconds === null}>Use video time</button>}
                  <button className="align-all-button" type="button" onClick={() => alignAllToCurrentTime(activeRecord.id)} disabled={!videoUrl || activeIsMarker}>Set as video clock</button>
                  <button className="undo-time-button" type="button" onClick={() => resetTimestamp(activeRecord.id)} disabled={timestampOverrides[activeRecord.id] === undefined}>Undo</button>
                </div>
              </section>
            ) : <div className="editor-placeholder">Click <b>✎</b> beside a timestamp to edit it with a slider and fine controls.</div>}
            <div className="table-wrap"><table><thead><tr><th>EXPORT</th><th>#</th>{visibleColumns.map(({ name: header, index }) => <th key={`${header}-${index}`} className={index === timestampColumn ? "time-column" : index === decisionColumn ? "decision-column" : ""}>{header}</th>)}</tr></thead><tbody>
              {sortedRecords.map((record, sortedIndex) => {
                const decision = decisionOverrides[record.id] ?? normalizeDecision(record.values[decisionColumn] ?? "");
                const isExcluded = excludedRows[record.id] === true;
                return <tr key={record.id} className={`${activeRow === record.id ? "is-active" : ""} ${timestampOverrides[record.id] !== undefined || decisionOverrides[record.id] !== undefined ? "is-modified" : ""} ${isExcluded ? "is-excluded" : ""} ${isFirstAction(record, headers) ? "is-first-action" : ""}`}><td className="export-column"><button className={`row-exclude-button ${isExcluded ? "is-excluded" : ""}`} type="button" onClick={() => toggleRowExcluded(record.id)} aria-pressed={isExcluded} aria-label={isExcluded ? `Include sorted row ${sortedIndex + 1} in CSV export` : `Exclude sorted row ${sortedIndex + 1} from CSV export`} title={isExcluded ? "Include in exported CSV" : "Exclude from exported CSV"}>{isExcluded ? "Off" : "On"}</button></td><td className="row-number" title={`Original CSV row ${record.id + 1}`}>{String(sortedIndex + 1).padStart(2, "0")}</td>{visibleColumns.map(({ index }) => <td key={index} className={index === timestampColumn ? "time-column" : index === decisionColumn ? "decision-column" : ""}>{index === timestampColumn && record.seconds !== null ? <div className="timestamp-cell"><button className="timestamp-button" type="button" onClick={() => jumpTo(record)} disabled={!isAiAudioEnd(record, headers) && (!videoUrl || videoStartSeconds === null)} title={videoUrl && videoStartSeconds !== null ? `Jump video to ${formatIso(record.seconds)}` : isAiAudioEnd(record, headers) ? "Select this AI audio end row" : "Upload a video first"}><span className="play-dot">▶</span><span className="timestamp-copy"><strong>{timestampOverrides[record.id] !== undefined ? formatIso(record.seconds) : (record.values[index] || formatIso(record.seconds))}</strong><small>VIDEO {videoStartSeconds !== null ? formatVideoTime(record.seconds - videoStartSeconds) : "—"}</small></span></button><button className="edit-time-button" type="button" onClick={() => jumpTo(record)} aria-label={`Edit sorted row ${sortedIndex + 1}`} title="Edit standard timestamp">✎</button></div> : index === decisionColumn && !isFirstAction(record, headers) ? <div className="row-decision-buttons" aria-label={`Decision for sorted row ${sortedIndex + 1}`}><button className={decision === "accept" ? "is-accept" : ""} type="button" onClick={() => updateDecision(record.id, "accept")} aria-pressed={decision === "accept"}>Accept</button><button className={decision === "reject" ? "is-reject" : ""} type="button" onClick={() => updateDecision(record.id, "reject")} aria-pressed={decision === "reject"}>Reject</button></div> : (record.values[index] || "—")}</td>)}</tr>;
              })}
            </tbody></table></div></>
          }
          <input ref={csvInputRef} className="visually-hidden" type="file" accept=".csv,text/csv,text/plain" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; void loadCsv(file); }} />
        </article>
      </section>

      <footer><p><strong>How it works</strong> Upload the video, then the CSV. Choose the time column if needed and click any orange timestamp.</p><div><span className={videoUrl ? "done" : ""}>1 Video</span><i>→</i><span className={headers.length ? "done" : ""}>2 CSV</span><i>→</i><span className={activeRow !== null ? "done" : ""}>3 Jump</span></div></footer>
    </main>
  );
}
