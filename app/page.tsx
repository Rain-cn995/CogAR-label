"use client";

import { ChangeEvent, DragEvent, useEffect, useMemo, useRef, useState } from "react";

type CsvRecord = { id: number; values: string[]; seconds: number | null };

const TIMESTAMP_HINTS = ["timestamp", "time_stamp", "video_time", "video timestamp", "elapsed", "elapsed_time", "start_time", "start", "time", "seconds", "sec"];

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

function parseTimestamp(raw: string, firstAbsolute: number | null, header: string) {
  const value = raw.trim();
  if (!value) return null;
  if (/^\d{1,3}:\d{2}(?::\d{2})?(?:\.\d+)?$/.test(value)) {
    const parts = value.split(":").map(Number);
    return parts.length === 3 ? parts[0] * 3600 + parts[1] * 60 + parts[2] : parts[0] * 60 + parts[1];
  }
  const numeric = Number(value);
  if (Number.isFinite(numeric)) {
    const normalized = normalizeNumericTimestamp(numeric, header);
    return firstAbsolute !== null && normalized > 1_000_000 ? normalized - firstAbsolute : normalized;
  }
  const date = Date.parse(value);
  if (Number.isFinite(date)) return firstAbsolute === null ? 0 : date / 1000 - firstAbsolute;
  return null;
}

function formatTime(seconds: number) {
  const safe = Math.max(0, seconds || 0);
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const remainder = safe % 60;
  const secondText = remainder.toFixed(remainder % 1 ? 2 : 0).padStart(2, "0");
  return hours > 0 ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${secondText}` : `${String(minutes).padStart(2, "0")}:${secondText}`;
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
  const [dragging, setDragging] = useState<"video" | "csv" | null>(null);

  useEffect(() => () => { if (videoUrl) URL.revokeObjectURL(videoUrl); }, [videoUrl]);

  const records = useMemo<CsvRecord[]>(() => {
    const timeHeader = headers[timestampColumn] ?? "";
    const firstAbsolute = rawRows.map((row) => getAbsoluteTimestamp(row[timestampColumn] ?? "", timeHeader)).find((value) => value !== null) ?? null;
    return rawRows.map((values, id) => ({ id, values, seconds: timestampOverrides[id] ?? parseTimestamp(values[timestampColumn] ?? "", firstAbsolute, timeHeader) }));
  }, [headers, rawRows, timestampColumn, timestampOverrides]);
  const validRecordCount = records.filter((record) => record.seconds !== null).length;
  const activeRecord = activeRow === null ? null : records[activeRow] ?? null;
  const editorMaximum = Math.max(duration, ...records.map((record) => record.seconds ?? 0), 60);

  const loadVideo = (file?: File) => {
    if (!file || !file.type.startsWith("video/")) return;
    setVideoUrl((current) => { if (current) URL.revokeObjectURL(current); return URL.createObjectURL(file); });
    setVideoName(file.name); setVideoSize(file.size); setCurrentTime(0); setActiveRow(null);
  };

  const loadCsv = async (file?: File) => {
    if (!file) return;
    const parsed = parseCsv(await file.text());
    setHeaders(parsed.headers); setRawRows(parsed.rows); setTimestampColumn(findTimestampColumn(parsed.headers)); setCsvName(file.name); setActiveRow(null); setTimestampOverrides({});
  };

  const jumpTo = (record: CsvRecord) => {
    if (record.seconds === null || !videoRef.current) return;
    const target = Math.max(0, Math.min(record.seconds, duration || record.seconds));
    videoRef.current.currentTime = target; setCurrentTime(target); setActiveRow(record.id); videoRef.current.focus();
  };

  const updateTimestamp = (rowId: number, nextSeconds: number) => {
    const safe = Math.max(0, Math.min(Number.isFinite(nextSeconds) ? nextSeconds : 0, editorMaximum));
    setTimestampOverrides((current) => ({ ...current, [rowId]: Math.round(safe * 1000) / 1000 }));
    setActiveRow(rowId);
    if (videoRef.current) {
      videoRef.current.currentTime = safe;
      setCurrentTime(safe);
    }
  };

  const resetTimestamp = (rowId: number) => {
    setTimestampOverrides((current) => {
      const next = { ...current };
      delete next[rowId];
      return next;
    });
  };

  const exportCsv = () => {
    const rows = rawRows.map((row, rowId) => row.map((cell, columnId) =>
      columnId === timestampColumn && timestampOverrides[rowId] !== undefined
        ? formatTime(timestampOverrides[rowId])
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
    setVideoUrl(""); setVideoName(""); setVideoSize(0); setHeaders([]); setRawRows([]); setCsvName(""); setCurrentTime(0); setDuration(0); setActiveRow(null); setTimestampOverrides({});
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
          <div className="panel-header"><div><span>01</span><div><strong>Recording</strong><small>{videoName || "No video selected"}</small></div></div><time>{formatTime(currentTime)} <i>/</i> {formatTime(duration)}</time></div>
          <div className={`video-stage ${dragging === "video" ? "is-dragging" : ""}`} onDragOver={(event) => { event.preventDefault(); setDragging("video"); }} onDragLeave={() => setDragging(null)} onDrop={(event) => handleDrop(event, "video")}>
            {videoUrl ? <video ref={videoRef} src={videoUrl} controls playsInline onLoadedMetadata={(event) => setDuration(event.currentTarget.duration || 0)} onTimeUpdate={(event) => setCurrentTime(event.currentTarget.currentTime)} /> :
              <button className="empty-stage" type="button" onClick={() => videoInputRef.current?.click()}><span className="upload-symbol">↑</span><strong>Upload your video</strong><small>Click to browse or drop MP4, MOV, WebM and more</small></button>}
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
            <><div className="data-toolbar"><label>TIMESTAMP COLUMN<select value={timestampColumn} onChange={(event) => { setTimestampColumn(Number(event.target.value)); setActiveRow(null); setTimestampOverrides({}); }}>{headers.map((header, index) => <option value={index} key={`${header}-${index}`}>{header}</option>)}</select></label><div className="toolbar-actions"><button type="button" onClick={() => csvInputRef.current?.click()}>Replace CSV</button><button className="export-button" type="button" onClick={exportCsv}>Export edited CSV</button></div></div>
            {activeRecord && activeRecord.seconds !== null ? (
              <section className="timestamp-editor" aria-label={`Edit timestamp for row ${activeRecord.id + 1}`}>
                <div className="editor-heading"><div><span>EDIT ROW {String(activeRecord.id + 1).padStart(2, "0")}</span><strong>{timestampOverrides[activeRecord.id] !== undefined ? "Modified timestamp" : "Timestamp editor"}</strong></div><output>{formatTime(activeRecord.seconds)}</output></div>
                <input className="time-slider" type="range" min="0" max={editorMaximum} step="0.01" value={activeRecord.seconds} onChange={(event) => updateTimestamp(activeRecord.id, Number(event.target.value))} aria-label="Timestamp position" />
                <div className="editor-controls">
                  <div className="nudge-buttons" aria-label="Fine timestamp adjustment">
                    <button type="button" onClick={() => updateTimestamp(activeRecord.id, activeRecord.seconds! - 1)}>−1s</button>
                    <button type="button" onClick={() => updateTimestamp(activeRecord.id, activeRecord.seconds! - 0.1)}>−0.1s</button>
                    <button type="button" onClick={() => updateTimestamp(activeRecord.id, activeRecord.seconds! + 0.1)}>+0.1s</button>
                    <button type="button" onClick={() => updateTimestamp(activeRecord.id, activeRecord.seconds! + 1)}>+1s</button>
                  </div>
                  <label>SECONDS<input type="number" min="0" max={editorMaximum} step="0.01" value={activeRecord.seconds} onChange={(event) => updateTimestamp(activeRecord.id, Number(event.target.value))} /></label>
                  <button className="use-current-button" type="button" onClick={() => updateTimestamp(activeRecord.id, currentTime)} disabled={!videoUrl}>Use video time</button>
                  <button className="undo-time-button" type="button" onClick={() => resetTimestamp(activeRecord.id)} disabled={timestampOverrides[activeRecord.id] === undefined}>Undo</button>
                </div>
              </section>
            ) : <div className="editor-placeholder">Click <b>✎</b> beside a timestamp to edit it with a slider and fine controls.</div>}
            <div className="table-wrap"><table><thead><tr><th>#</th>{headers.map((header, index) => <th key={`${header}-${index}`} className={index === timestampColumn ? "time-column" : ""}>{header}</th>)}</tr></thead><tbody>
              {records.map((record) => <tr key={record.id} className={`${activeRow === record.id ? "is-active" : ""} ${timestampOverrides[record.id] !== undefined ? "is-modified" : ""}`}><td className="row-number">{String(record.id + 1).padStart(2, "0")}</td>{headers.map((_, index) => <td key={index} className={index === timestampColumn ? "time-column" : ""}>{index === timestampColumn && record.seconds !== null ? <div className="timestamp-cell"><button className="timestamp-button" type="button" onClick={() => jumpTo(record)} disabled={!videoUrl} title={videoUrl ? `Jump video to ${formatTime(record.seconds)}` : "Upload a video first"}><span>▶</span>{timestampOverrides[record.id] !== undefined ? formatTime(record.seconds) : (record.values[index] || formatTime(record.seconds))}</button><button className="edit-time-button" type="button" onClick={() => { setActiveRow(record.id); if (videoUrl) jumpTo(record); }} aria-label={`Edit timestamp for row ${record.id + 1}`} title="Edit timestamp">✎</button></div> : (record.values[index] || "—")}</td>)}</tr>)}
            </tbody></table></div></>
          )}
          <input ref={csvInputRef} className="visually-hidden" type="file" accept=".csv,text/csv,text/plain" onChange={(event) => void loadCsv(event.target.files?.[0])} />
        </article>
      </section>

      <footer><p><strong>How it works</strong> Upload the video, then the CSV. Choose the time column if needed and click any orange timestamp.</p><div><span className={videoUrl ? "done" : ""}>1 Video</span><i>→</i><span className={headers.length ? "done" : ""}>2 CSV</span><i>→</i><span className={activeRow !== null ? "done" : ""}>3 Jump</span></div></footer>
    </main>
  );
}
