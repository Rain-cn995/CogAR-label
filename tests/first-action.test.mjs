import assert from "node:assert/strict";
import test from "node:test";
import { prepareRows, column, cell, eventId, trialId, sameTrial, correctness, sourceIssues, sourceFor, makeMarker, validateMarker, markerExportErrors, captureSeconds, serializeTimestamp, relinkMarker } from "../app/first-action.js";

const epoch = Date.parse("2026-08-17T14:00:00Z") / 1000;
const iso = (s) => new Date((epoch + s) * 1000).toISOString();
const headers = ["participant_id", "sheet", "plan_id", "step", "step_name", "action", "event_timestamp_iso", "reliance", "review_decision", "detail", "old_gap_seconds"];
function fixture(reliance = "over_rely", additional = []) {
  const rows = [
    ["1", "p37", "boba", "2", "Sugar", "AI audio", iso(2), "", "", "Instruction", ""],
    ["1", "p37", "boba", "2.0", "Sugar", "AI audio end", iso(6), "", "", "Instruction", ""],
    ["1", "p37", "boba", "2", "Sugar", "AI accepted", iso(10), reliance, "accept", "Decision", "4"],
    ...additional,
  ];
  const prepared = prepareRows(headers, rows, "test-dataset");
  const records = prepared.rows.map((values, id) => ({ id, values, seconds: Date.parse(values[6]) / 1000 }));
  return { headers: prepared.headers, records, source: records[0] };
}
function markerFor(f, seconds = 4, id = "marker-1") {
  return { id: f.records.length, values: makeMarker(f.source, f.headers, 6, epoch + seconds, id, "reach onset"), seconds: epoch + seconds };
}

test("eligibility uses wrong/correct reliance, not accept/reject", () => {
  for (const label of ["over_rely", "app_reject"]) { const f=fixture(label); assert.equal(correctness(f.source,f.records,f.headers).value,"wrong"); }
  for (const label of ["app_rely", "under_rely"]) { const f=fixture(label); assert.equal(correctness(f.source,f.records,f.headers).value,"correct"); assert.ok(sourceIssues(f.source,f.records,f.headers).length); }
  const f=fixture(""); f.records[2].values[5]="AI rejected";
  assert.equal(correctness(f.source,f.records,f.headers).value,"unknown");
});

test("numeric steps normalize, sheet wins over legacy participant id, and task differs", () => {
  const f=fixture("over_rely", [["1","p38","boba","2","Sugar","AI audio",iso(12)], ["1","p37","shelf","2","Shelf","AI audio",iso(12)]]);
  assert.ok(sameTrial(f.source,f.records[1],f.headers));
  assert.ok(!sameTrial(f.source,f.records[3],f.headers));
  assert.ok(!sameTrial(f.source,f.records[4],f.headers));
});

test("conflicting evidence requires explicit manual review", () => {
  const f=fixture("over_rely");
  f.source.values[column(f.headers,"ai_correctness")]="correct";
  assert.equal(correctness(f.source,f.records,f.headers).value,"unknown");
  f.source.values[column(f.headers,"ai_correctness_reviewed")]="true";
  assert.equal(correctness(f.source,f.records,f.headers).value,"correct");
});

test("replays require explicit cue selection, while separate completed attempts have separate trials", () => {
  const repeat=["1","p37","boba","2","Sugar","AI audio",iso(12)];
  const f=fixture("over_rely", [repeat]);
  assert.match(sourceIssues(f.source,f.records,f.headers).join(),/Multiple AI cues/);
  f.source.values[column(f.headers,"first_action_source_selected")]="true";
  assert.deepEqual(sourceIssues(f.source,f.records,f.headers),[]);
  const separate=fixture("over_rely", [["1","p37","boba","2","Sugar","complete",iso(11)], repeat]);
  assert.notEqual(trialId(separate.source,separate.headers),trialId(separate.records[4],separate.headers));
});

test("capture reads current media time, pauses, and checks alignment and readiness", () => {
  let paused=false;
  const video={ readyState:2,seeking:false,duration:30,currentTime:4.125,pause(){ paused=true; } };
  assert.equal(captureSeconds(video,epoch,true),epoch+4.125); assert.ok(paused);
  for (const [v,start,verified] of [[video,epoch,false],[{...video,seeking:true},epoch,true],[{...video,readyState:0},epoch,true],[{...video,currentTime:31},epoch,true],[video,null,true],[{...video,duration:Infinity},epoch,true]]) assert.throws(()=>captureSeconds(v,start,verified));
});

test("First action copies context only, leaves original decisions intact, and supports during-audio action", () => {
  const f=fixture(); const before=JSON.stringify(f.records); const marker=markerFor(f);
  assert.equal(cell(marker,f.headers,"action"),"First action");
  for (const name of ["reliance","review_decision","old_gap_seconds"]) assert.equal(cell(marker,f.headers,name),"");
  assert.equal(cell(marker,f.headers,"source_ai_event_id"),eventId(f.source,f.headers));
  assert.deepEqual(validateMarker(marker,[...f.records,marker],f.headers),{errors:[],warnings:[]});
  assert.equal(JSON.stringify(f.records),before);
});

test("validation catches edited onset, duplicates, source exclusion, and later correctness edits", () => {
  const f=fixture(); const m=markerFor(f); const records=[...f.records,m];
  f.source.seconds=epoch+5;
  assert.match(validateMarker(m,records,f.headers).errors.join(),/before AI onset/);
  f.source.seconds=epoch+2;
  assert.match(markerExportErrors(records,f.headers,{0:true}).join(),/excluded/);
  assert.deepEqual(markerExportErrors(records,f.headers,{0:true,[m.id]:true}),[]);
  const duplicate={...markerFor(f,5,"marker-2"),id:m.id+1};
  assert.match(validateMarker(m,[...records,duplicate],f.headers).errors.join(),/Multiple First action/);
  assert.deepEqual(validateMarker(m,[...records,duplicate],f.headers,{[duplicate.id]:true}).errors,[]);
  f.source.values[column(f.headers,"ai_correctness")]="correct";
  f.source.values[column(f.headers,"ai_correctness_reviewed")]="true";
  assert.match(validateMarker(m,records,f.headers).errors.join(),/suggestion is wrong/);
});

test("after-decision timing is flagged without clamping or silently rewriting", () => {
  const f=fixture(); const m=markerFor(f,12);
  const result=validateMarker(m,[...f.records,m],f.headers);
  assert.deepEqual(result.errors,[]); assert.match(result.warnings.join(),/after AI accepted/); assert.equal(m.seconds,epoch+12);
});

test("export/reimport retains IDs and source relationships after sorting", () => {
  const f=fixture(); const m=markerFor(f);
  const sorted=[...f.records,m].sort((a,b)=>a.seconds-b.seconds);
  const reimport=prepareRows(f.headers,sorted.map(r=>r.values),"different-file-hash");
  const records=reimport.rows.map((values,id)=>({id,values,seconds:Date.parse(values[6])/1000}));
  const restored=records.find(r=>cell(r,reimport.headers,"action")==="First action");
  assert.equal(eventId(restored,reimport.headers),"marker-1");
  assert.equal(eventId(sourceFor(restored,records,reimport.headers),reimport.headers),eventId(f.source,f.headers));
  assert.deepEqual(markerExportErrors(records,reimport.headers,{}),[]);
});

test("duplicate IDs, invalid times, and absent source links cannot export", () => {
  const f=fixture(); const m=markerFor(f);
  m.values[column(f.headers,"event_id")]=eventId(f.source,f.headers);
  assert.match(markerExportErrors([...f.records,m],f.headers,{}).join(),/Duplicate/);
  m.values[column(f.headers,"event_id")]="valid";m.seconds=NaN;
  assert.match(validateMarker(m,[...f.records,m],f.headers).errors.join(),/timestamp is invalid/);
  m.seconds=epoch+4;m.values[column(f.headers,"source_ai_event_id")]="missing";
  assert.match(validateMarker(m,[...f.records,m],f.headers).errors.join(),/original AI audio/);
});

test("short rows are padded and numeric timestamp units are respected", () => {
  const f=prepareRows(headers,[["1","p1","boba","2"]],"a");
  assert.equal(f.rows[0].length,f.headers.length);assert.equal(f.rows[0][6],"");
  assert.equal(serializeTimestamp(epoch+4,"timestamp_ms"),String((epoch+4)*1000));
  assert.equal(serializeTimestamp(epoch+4,"timestamp",String(epoch*1000)),String((epoch+4)*1000));
  assert.equal(serializeTimestamp(epoch+4,"event_timestamp_iso"),iso(4));
});


test("imported trial IDs cannot cross-link different participants; explicit relinking copies context", () => {
  const f=fixture(); const marker=markerFor(f);
  marker.values[column(f.headers,"sheet")]="p38";
  assert.ok(!sameTrial(f.source,marker,f.headers));
  assert.match(validateMarker(marker,[...f.records,marker],f.headers).errors.join(),/different trials/);
  marker.values=relinkMarker(marker,f.source,f.headers);
  assert.ok(sameTrial(f.source,marker,f.headers));
  assert.equal(marker.values[6],iso(4));
});

test("a first action after the next trial cue warns without moving the timestamp", () => {
  const f=fixture("over_rely", [["1","p37","boba","3","Other","AI audio",iso(12)]]);
  const marker=markerFor(f,13);
  assert.match(validateMarker(marker,[...f.records,marker],f.headers).warnings.join(),/next trial/);
  assert.equal(marker.seconds,epoch+13);
});
