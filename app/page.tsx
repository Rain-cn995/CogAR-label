"use client";

import { ChangeEvent, DragEvent, useEffect, useMemo, useRef, useState } from "react";
import {
  createCsvDraftKey,
  createTimestampDraftAutosaver,
  filterTimestampOverrides,
  readTimestampDraft,
  removeTimestampDraft,
} from "./csv-draft.js";

type CsvRecord = { id: number; values: string[]; seconds: number | null };
type AutosaveStatus = "idle" | "restored" | "retained" | "saving" | "saved" | "error";

const TIMESTAMP_HINTS = ["timestamp", "time_stamp", "video_time", "video timestamp", "elapsed", "elapsed_time", "start_time", "start", "time", "seconds", "sec"];
const AUTOSAVE_COPY: Record<AutosaveStatus, string> = {
  idle: "AUTOSAVE READY",
  restored: "SAVED EDITS RESTORED",
  retained: "PRIOR DRAFT RETAINED",
  saving: "SAVING…",
  saved: "SAVED LOCALLY",
  error: "AUTOSAVE UNAVAILABLE",
};

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
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    const normalized = normalizeNumericTimestamp(numeric, header);
    if (normalized > 1_000_000) return normalized;
  }
  const date = Date.parse(value);
  return Number.isFinite(date) ? date / 1000 : null;
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

function quoteCsv(value: string) {
  return `"${value.replaceAll('"', '""')}"`;
}

export default function Home() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const videoInputRef = useRef<HTMLInputElement>(null);
  const csvInputRef = useRef<HTMLInputElement>(null);
  const draftAutosaverRef = useRef<ReturnType<typeof createTimestampDraftAutosaver> | null>(null);
  const restoredDraftKeyRef = useRef("");
  const [videoUrl, setVideoUrl] = useState("");
  const [videoName, setVideoName] = useState("");
  const [videoSize, setVideoSize] = useState(0);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [headers, setHeaders] = useState<string[]>([]);
  const [rawRows, setRawRows] = useState<string[][]>([]);
  const [csvName, setCsvName] = useState("");
  const [timestampColumn, setTimestampColumn] = useState(0);
  const [activeRow, setActiveRow] = useState<number | null>(null);
  const [timestampOverrides, setTimestampOverrides] = useState<Record<number, number>>({});
  const [videoStartSeconds, setVideoStartSeconds] = useState<number | null>(null);
  const [videoStartText, setVideoStartText] = useState("");
  const [videoStartSource, setVideoStartSource] = useState<"none" | "auto" | "manual">("none");
  const [seekNotice, setSeekNotice] = useState("");
  const [timestampDraft, setTimestampDraft] = useState("");
  const [dragging, setDragging] = useState<"video" | "csv" | null>(null);
  const [draftKey, setDraftKey] = useState("");
  const [autosaveStatus, setAutosaveStatus] = useState<AutosaveStatus>("idle");

  useEffect(() => () => { if (videoUrl) URL.revokeObjectURL(videoUrl); }, [videoUrl]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    let autosaver: ReturnType<typeof createTimestampDraftAutosaver>;
    try {
      autosaver = createTimestampDraftAutosaver(window.localStorage, {
        onStatus: (status: AutosaveStatus) => setAutosaveStatus(status),
      });
    } catch {
      const errorNotice = window.setTimeout(() => setAutosaveStatus("error"), 0);
      return () => window.clearTimeout(errorNotice);
    }
    draftAutosaverRef.current = autosaver;
    const flushPendingDraft = () => autosaver.flush();
    window.addEventListener("pagehide", flushPendingDraft);
    return () => {
      window.removeEventListener("pagehide", flushPendingDraft);
      autosaver.flush();
    };
  }, []);

  useEffect(() => {
    if (!draftKey || !draftAutosaverRef.current) return;
    if (!Object.keys(timestampOverrides).length) {
      draftAutosaverRef.current.cancel();
      return;
    }
    if (restoredDraftKeyRef.current === draftKey) {
      restoredDraftKeyRef.current = "";
      return;
    }
    draftAutosaverRef.current.schedule(draftKey, { timestampColumn, timestampOverrides });
  }, [draftKey, timestampColumn, timestampOverrides]);

  const baseRecords = useMemo<CsvRecord[]>(() => {
    const timeHeader = headers[timestampColumn] ?? "";
    return rawRows.map((values, id) => ({ id, values, seconds: getAbsoluteTimestamp(values[timestampColumn] ?? "", timeHeader) }));
  }, [headers, rawRows, timestampColumn]);
  const records = useMemo<CsvRecord[]>(() => baseRecords.map((record) => ({
    ...record,
    seconds: timestampOverrides[record.id] ?? record.seconds,
  })), [baseRecords, timestampOverrides]);
  const sortedRecords = useMemo(() => [...records].sort((left, right) => {
    if (left.seconds === null && right.seconds === null) return left.id - right.id;
    if (left.seconds === null) return 1;
    if (right.seconds === null) return -1;
    return left.seconds - right.seconds || left.id - right.id;
  }), [records]);
  const validRecordCount = records.filter((record) => record.seconds !== null).length;
  const activeRecord = activeRow === null ? null : records[activeRow] ?? null;
  const activeRank = activeRow === null ? 0 : sortedRecords.findIndex((record) => record.id === activeRow) + 1;
  const editorMinimum = videoStartSeconds ?? activeRecord?.seconds ?? 0;
  const editorMaximum = videoStartSeconds !== null ? videoStartSeconds + Math.max(duration, 1) : Math.max(...records.map((record) => record.seconds ?? 0), 1);

  useEffect(() => {
    setTimestampDraft(activeRecord && activeRecord.seconds !== null ? formatIso(activeRecord.seconds) : "");
  }, [activeRecord, activeRow]);

  useEffect(() => {
    if (!videoName || !baseRecords.length || videoStartSource === "manual") return;
    const ignored = new Set(["video", "recording", "compressed", "clip", "part", "mov", "mp4", "webm"]);
    const tokens = videoName.toLowerCase().replace(/\.[^.]+$/, "").split(/[^a-z0-9]+/).filter((token) => token.length >= 3 && !ignored.has(token) && !/^p?\d+$/.test(token));
    const match = baseRecords.find((record) => tokens.some((token) => record.values.some((value) => value.toLowerCase().includes(token))));
    const start = match?.seconds ?? baseRecords.find((record) => record.seconds !== null)?.seconds ?? null;
    if (start !== null) {
      setVideoStartSeconds(start);
      setVideoStartText(formatIso(start));
      setVideoStartSource("auto");
      setSeekNotice(`Video start set to ${formatIso(start)}`);
    }
  }, [baseRecords, videoName, videoStartSource]);

  const loadVideo = (file?: File) => {
    if (!file || !file.type.startsWith("video/")) return;
    setVideoUrl((current) => { if (current) URL.revokeObjectURL(current); return URL.createObjectURL(file); });
    setVideoName(file.name); setVideoSize(file.size); setCurrentTime(0); setActiveRow(null); setVideoStartSource("none"); setSeekNotice("");
  };

  const flushPendingEdits = () => {
    if (!Object.keys(timestampOverrides).length) return true;
    const saved = draftAutosaverRef.current?.flush() ?? false;
    if (!saved) {
      setAutosaveStatus("error");
      setSeekNotice("Latest timestamp edits could not be saved · keep this CSV open");
    }
    return saved;
  };

  const loadCsv = async (file?: File) => {
    if (!file) return;
    if (!flushPendingEdits()) return;
    const csvText = await file.text();
    const parsed = parseCsv(csvText);
    const nextDraftKey = createCsvDraftKey(file, csvText);
    let restoredDraft = null;
    let storageFailed = false;
    try {
      restoredDraft = readTimestampDraft(window.localStorage, nextDraftKey);
    } catch {
      storageFailed = true;
    }
    const canRestore = restoredDraft && restoredDraft.timestampColumn < parsed.headers.length;
    const candidateOverrides = canRestore ? restoredDraft.timestampOverrides : {};
    const filteredOverrides = filterTimestampOverrides(candidateOverrides, parsed.rows.length);
    const draftWasTrimmed = Boolean(restoredDraft && !canRestore) || Object.keys(candidateOverrides).length !== Object.keys(filteredOverrides).length;
    const restoredOverrides = draftWasTrimmed ? {} : filteredOverrides;
    if (draftWasTrimmed) {
      try { removeTimestampDraft(window.localStorage, nextDraftKey); }
      catch { storageFailed = true; }
    }
    restoredDraftKeyRef.current = Object.keys(restoredOverrides).length && !draftWasTrimmed ? nextDraftKey : "";
    setHeaders(parsed.headers); setRawRows(parsed.rows); setTimestampColumn(canRestore ? restoredDraft.timestampColumn : findTimestampColumn(parsed.headers)); setCsvName(file.name); setActiveRow(null); setTimestampOverrides(restoredOverrides); setDraftKey(nextDraftKey); setAutosaveStatus(storageFailed || draftWasTrimmed ? "error" : Object.keys(restoredOverrides).length ? "restored" : "idle"); setVideoStartSeconds(null); setVideoStartText(""); setVideoStartSource("none"); setSeekNotice(draftWasTrimmed ? "Some saved edits were invalid and were not restored" : Object.keys(restoredOverrides).length ? `Restored ${Object.keys(restoredOverrides).length} saved timestamp edit${Object.keys(restoredOverrides).length === 1 ? "" : "s"}` : "");
  };

  const jumpTo = (record: CsvRecord) => {
    if (record.seconds === null || !videoRef.current) return;
    const recordSeconds = record.seconds;
    setActiveRow(record.id);
    if (videoStartSeconds === null) {
      setSeekNotice("Set the Video Start ISO before jumping");
      return;
    }
    const videoSeconds = recordSeconds - videoStartSeconds;
    if (videoSeconds < 0 || (duration > 0 && videoSeconds > duration)) {
      setSeekNotice(`Row ${record.id + 1} is outside this video · adjust Video Start ISO`);
      return;
    }
    const video = videoRef.current;
    const target = Math.max(0, Math.min(videoSeconds, duration > 0 ? Math.max(0, duration - 0.01) : videoSeconds));
    const applySeek = () => {
      video.currentTime = target;
      setCurrentTime(target);
      setSeekNotice(`Jumped to ${formatIso(recordSeconds)} · row ${record.id + 1}`);
      video.focus();
    };
    if (video.readyState === 0) video.addEventListener("loadedmetadata", applySeek, { once: true });
    else applySeek();
  };

  const alignAllToCurrentTime = (rowId: number) => {
    const standardSeconds = records[rowId]?.seconds;
    if (standardSeconds === null || standardSeconds === undefined) return;
    const start = standardSeconds - currentTime;
    setVideoStartSeconds(start);
    setVideoStartText(formatIso(start));
    setVideoStartSource("manual");
    setSeekNotice(`Video start set to ${formatIso(start)}`);
  };

  const updateTimestamp = (rowId: number, nextSeconds: number) => {
    const safe = Math.max(editorMinimum, Math.min(Number.isFinite(nextSeconds) ? nextSeconds : editorMinimum, editorMaximum));
    setTimestampOverrides((current) => ({ ...current, [rowId]: Math.round(safe * 1000) / 1000 }));
    setActiveRow(rowId);
    if (videoRef.current && videoStartSeconds !== null) {
      const target = safe - videoStartSeconds;
      videoRef.current.currentTime = target;
      setCurrentTime(target);
    }
  };

  const applyVideoStartText = () => {
    const parsed = getAbsoluteTimestamp(videoStartText, "event_timestamp_iso");
    if (parsed === null) {
      setSeekNotice("Video Start ISO is invalid");
      return;
    }
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
    updateTimestamp(rowId, parsed);
    setTimestampDraft(formatIso(parsed));
  };

  const clearSavedDraft = () => {
    draftAutosaverRef.current?.cancel();
    if (!draftKey) return true;
    try {
      removeTimestampDraft(window.localStorage, draftKey);
      return true;
    } catch {
      setAutosaveStatus("error");
      return false;
    }
  };

  const resetTimestamp = (rowId: number) => {
    const next = { ...timestampOverrides };
    delete next[rowId];
    if (!Object.keys(next).length && !clearSavedDraft()) return;
    setTimestampOverrides(next);
    if (!Object.keys(next).length) setAutosaveStatus("idle");
  };

  const discardSavedEdits = () => {
    if (clearSavedDraft()) {
      setTimestampOverrides({});
      setAutosaveStatus("idle");
      setSeekNotice("Discarded all saved timestamp edits");
    }
  };

  const changeTimestampColumn = (column: number) => {
    const hadEdits = Object.keys(timestampOverrides).length > 0;
    if (!flushPendingEdits()) return;
    setTimestampColumn(column); setActiveRow(null); setTimestampOverrides({}); setAutosaveStatus(hadEdits ? "retained" : "idle"); setVideoStartSeconds(null); setVideoStartText(""); setVideoStartSource("none");
  };

  const exportCsv = () => {
    const rows = sortedRecords.map((record) => rawRows[record.id].map((cell, columnId) =>
      columnId === timestampColumn && timestampOverrides[record.id] !== undefined
        ? formatIso(timestampOverrides[record.id])
        : cell,
    ));
    const content = [headers, ...rows].map((row) => row.map((cell) => quoteCsv(cell ?? "")).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${csvName.replace(/\.csv$/i, "") || "timestamps"}-edited.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const handleDrop = (event: DragEvent, kind: "video" | "csv") => {
    event.preventDefault(); setDragging(null);
    const file = event.dataTransfer.files[0];
    if (kind === "video") loadVideo(file); else void loadCsv(file);
  };

  const resetAll = () => {
    if (!flushPendingEdits()) return;
    setVideoUrl(""); setVideoName(""); setVideoSize(0); setHeaders([]); setRawRows([]); setCsvName(""); setCurrentTime(0); setDuration(0); setActiveRow(null); setTimestampOverrides({}); setDraftKey(""); setAutosaveStatus("idle"); setVideoStartSeconds(null); setVideoStartText(""); setVideoStartSource("none"); setSeekNotice("");
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
            {videoUrl ? <video ref={videoRef} src={videoUrl} controls playsInline onLoadedMetadata={(event) => setDuration(event.currentTarget.duration || 0)} onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)} /> :
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
            <><div className="data-toolbar"><label>TIMESTAMP COLUMN<select value={timestampColumn} onChange={(event) => changeTimestampColumn(Number(event.target.value))}>{headers.map((header, index) => <option value={index} key={`${header}-${index}`}>{header}</option>)}</select></label><span className={`alignment-badge ${videoStartSource !== "none" ? "is-aligned" : ""}`}>{videoStartSource === "auto" ? "AUTO VIDEO START" : videoStartSource === "manual" ? "MANUAL VIDEO START" : "START TIME REQUIRED"}</span><span className={`autosave-status is-${autosaveStatus}`} role="status">{AUTOSAVE_COPY[autosaveStatus]}</span><span className="sort-badge">STANDARD TIME ↑</span><div className="toolbar-actions"><button type="button" onClick={() => csvInputRef.current?.click()}>Replace CSV</button><button type="button" onClick={discardSavedEdits} disabled={!Object.keys(timestampOverrides).length && autosaveStatus !== "retained"}>Discard edits</button><button className="export-button" type="button" onClick={exportCsv}>Export edited CSV</button></div></div>
            <div className="video-clock-bar"><label>VIDEO START ISO<input type="text" value={videoStartText} onChange={(event) => setVideoStartText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") applyVideoStartText(); }} placeholder="2026-08-17T14:23:06.881Z" /></label><button type="button" onClick={applyVideoStartText}>Apply standard time</button><span>{videoStartSeconds !== null ? `Current video frame: ${formatIso(videoStartSeconds + currentTime)}` : "Enter the recording's standard start time"}</span></div>
            {activeRecord && activeRecord.seconds !== null ? (
              <section className="timestamp-editor" aria-label={`Edit timestamp for row ${activeRecord.id + 1}`}>
                <div className="editor-heading"><div><span>EDIT SORTED ROW {String(activeRank).padStart(2, "0")}</span><strong>{timestampOverrides[activeRecord.id] !== undefined ? "Modified standard timestamp" : "Standard timestamp editor"}</strong></div><div className="editor-output"><output>{formatIso(activeRecord.seconds)}</output><small>VIDEO {videoStartSeconds !== null ? formatVideoTime(activeRecord.seconds - videoStartSeconds) : "—"}</small></div></div>
                <input className="time-slider" type="range" min={editorMinimum} max={editorMaximum} step="0.001" value={activeRecord.seconds} onChange={(event) => updateTimestamp(activeRecord.id, Number(event.target.value))} aria-label="Standard timestamp position" disabled={videoStartSeconds === null} />
                <div className="editor-controls">
                  <div className="nudge-buttons" aria-label="Fine timestamp adjustment">
                    <button type="button" onClick={() => updateTimestamp(activeRecord.id, activeRecord.seconds! - 1)}>−1s</button>
                    <button type="button" onClick={() => updateTimestamp(activeRecord.id, activeRecord.seconds! - 0.1)}>−0.1s</button>
                    <button type="button" onClick={() => updateTimestamp(activeRecord.id, activeRecord.seconds! + 0.1)}>+0.1s</button>
                    <button type="button" onClick={() => updateTimestamp(activeRecord.id, activeRecord.seconds! + 1)}>+1s</button>
                  </div>
                  <label>STANDARD TIME ISO<input className="standard-time-input" type="text" value={timestampDraft} onChange={(event) => setTimestampDraft(event.target.value)} onBlur={() => applyTimestampDraft(activeRecord.id)} onKeyDown={(event) => { if (event.key === "Enter") applyTimestampDraft(activeRecord.id); }} /></label>
                  <button className="use-current-button" type="button" onClick={() => videoStartSeconds !== null && updateTimestamp(activeRecord.id, videoStartSeconds + currentTime)} disabled={!videoUrl || videoStartSeconds === null}>Use video time</button>
                  <button className="align-all-button" type="button" onClick={() => alignAllToCurrentTime(activeRecord.id)} disabled={!videoUrl}>Set as video clock</button>
                  <button className="undo-time-button" type="button" onClick={() => resetTimestamp(activeRecord.id)} disabled={timestampOverrides[activeRecord.id] === undefined}>Undo</button>
                </div>
              </section>
            ) : <div className="editor-placeholder">Click <b>✎</b> beside a timestamp to edit it with a slider and fine controls.</div>}
            <div className="table-wrap"><table><thead><tr><th>#</th>{headers.map((header, index) => <th key={`${header}-${index}`} className={index === timestampColumn ? "time-column" : ""}>{header}</th>)}</tr></thead><tbody>
              {sortedRecords.map((record, sortedIndex) => <tr key={record.id} className={`${activeRow === record.id ? "is-active" : ""} ${timestampOverrides[record.id] !== undefined ? "is-modified" : ""}`}><td className="row-number" title={`Original CSV row ${record.id + 1}`}>{String(sortedIndex + 1).padStart(2, "0")}</td>{headers.map((_, index) => <td key={index} className={index === timestampColumn ? "time-column" : ""}>{index === timestampColumn && record.seconds !== null ? <div className="timestamp-cell"><button className="timestamp-button" type="button" onClick={() => jumpTo(record)} disabled={!videoUrl || videoStartSeconds === null} title={videoUrl ? `Jump video to ${formatIso(record.seconds)}` : "Upload a video first"}><span className="play-dot">▶</span><span className="timestamp-copy"><strong>{timestampOverrides[record.id] !== undefined ? formatIso(record.seconds) : (record.values[index] || formatIso(record.seconds))}</strong><small>VIDEO {videoStartSeconds !== null ? formatVideoTime(record.seconds - videoStartSeconds) : "—"}</small></span></button><button className="edit-time-button" type="button" onClick={() => { setActiveRow(record.id); if (videoUrl) jumpTo(record); }} aria-label={`Edit sorted row ${sortedIndex + 1}`} title="Edit standard timestamp">✎</button></div> : (record.values[index] || "—")}</td>)}</tr>)}
            </tbody></table></div></>
          )}
          <input ref={csvInputRef} className="visually-hidden" type="file" accept=".csv,text/csv,text/plain" onChange={(event) => { const file = event.target.files?.[0]; event.target.value = ""; void loadCsv(file); }} />
        </article>
      </section>

      <footer><p><strong>How it works</strong> Upload the video, then the CSV. Choose the time column if needed and click any orange timestamp.</p><div><span className={videoUrl ? "done" : ""}>1 Video</span><i>→</i><span className={headers.length ? "done" : ""}>2 CSV</span><i>→</i><span className={activeRow !== null ? "done" : ""}>3 Jump</span></div></footer>
    </main>
  );
}
