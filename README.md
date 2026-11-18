# CogAR label

Local video/CSV review for CogAR event timestamps, decisions, and first-action annotations. Recordings and CSV contents stay in the browser; nothing is uploaded by the review app.

## Run

Requires Node.js >=22.13.0 and installed dependencies.

```bash
npm install
npm run dev
```

`npm test` builds the app and runs its automated tests. `npm run lint` runs ESLint. Deployment configuration supports GitHub Pages and the existing vinext/Cloudflare scaffold.

## Record a first action

1. Upload the recording and its event CSV. Check **VIDEO START ISO** against a known event, adjust if necessary, then check **I verified the video clock alignment**. An automatic clock estimate is not itself verification.
2. Click the timestamp/edit button on the original **AI audio** row for the step.
3. Check **AI suggestion**. Imported `over_rely` / `app_reject` labels identify wrong suggestions; `app_rely` / `under_rely` identify correct suggestions. Missing or conflicting metadata requires explicit review. Accept/Reject alone does not establish correctness. Selecting Wrong/Correct/Unknown explicitly overrides the inferred classification for this cue.
4. If there are repeated AI cues in a trial, select the intended original cue and click **Use this AI cue for this trial**. Recovery audio is not an original AI cue.
5. Play or scrub to the first observable physical movement toward a task object, then click **Record first action**. The handler pauses playback and reads the actual video position. Looking at an object alone does not qualify; movement toward either a correct or incorrect object counts. Agree on this coding rule with the research team before annotation.
6. The app adds a **First action** event with an ISO timestamp and an elapsed-time preview measured from **AI audio onset**. Movement during audio playback is allowed. It preserves the existing final-decision event and audio-end marker.
7. Use **Update from video**, **Go to first action**, or the existing timestamp slider/nudge controls to refine the marker. A typed ISO time takes effect through **Apply ISO** or Enter. Remove is reversible with **Undo removal**, including after draft recovery.
8. Click **Export edited CSV** for a portable copy. Export includes the new event and its stable source link.

One marker is retained per resolved trial occurrence. Known-correct cues cannot be recorded. Before-onset timestamps are rejected rather than clamped. After-decision, recovery, completion, or next-trial times produce review warnings. If no action is observable, leave it unrecorded and add an annotation note; the app never substitutes a final-decision timestamp.

## Clock changes and validation

Capturing requires a loaded, seek-complete video and verified alignment. Replacing the video or changing its clock clears verification. Existing captures whose video/clock changed must be reviewed before export. **Recalculate from captured frame** preserves the observed video position under a corrected clock; **Keep ISO time after review** explicitly preserves the absolute timestamp. Recalculation is available only for the same recording.

Source links, duplicate IDs/markers, correctness, and timestamps are revalidated after edits, import, draft recovery, and before export. Excluding an AI source blocks export of its dependent marker until the source is included or the marker is also excluded. Inspect issues shown above the editor. Invalid original CSV IDs should be corrected in the source file.

## CSV schema

The standard study schema is `participant_id`, `sheet`, `plan_id`, `plan`, `step`, `step_name`, `action`, `detail`, `event_timestamp_iso`, `review_decision`, and `reliance`. Header matching is case-insensitive. Task/session aliases are recognized by the grouping helpers. A task and step are required for First action capture.

Wrong step numbers are not hardcoded. Numeric step values such as `2` and `2.0` match. Where present, `sheet` takes precedence over legacy participant IDs. Task starts and completed attempts separate repeated trials; unresolved multiple cues require explicit selection.

Original columns and values are retained, with timestamp/decision edits and export exclusions applied. Added metadata columns are hidden in the table by default; enable **Show annotation metadata** to inspect them:

| Column | Purpose |
| --- | --- |
| `event_id` | Stable identity, retained on re-import |
| `source_ai_event_id` | Links a First action event to its original AI cue |
| `trial_id` | Stable trial occurrence, protected against participant/task mismatches |
| `ai_correctness` | Explicit Wrong/Correct/Unknown classification on the source cue |
| `ai_correctness_reviewed` | Records that a coder explicitly resolved correctness |
| `first_action_source_selected` | Records an explicit choice among repeated cues |
| `annotation_note` | Optional observation or reason an action remains unrecorded |

Generated rows copy identity/task context only. They leave final-decision, reliance, and old derived gap columns blank. Numeric timestamp columns retain their units. Millisecond formatting does not imply millisecond observation accuracy. Older First action rows without links can be explicitly linked using **Linked AI audio**.

Downstream analysis must join the First action row to `source_ai_event_id` and use that timestamp as the window endpoint. This feature does not automatically change the separate eye-gaze analysis pipeline.

## Draft recovery

Review changes are saved on this device in a versioned browser local-storage draft keyed by the original CSV's contents. Reopen the same CSV to restore annotations, notes, links, classifications, timestamp/decision edits, exclusions, removals, and video-clock information. Select the video again and verify alignment before recording. Files themselves are not stored in the draft.

Export remains the portable record. A storage error is displayed rather than reported as success. The app warns before leaving/replacing/resetting when saving fails. A malformed saved draft is left intact; the original CSV opens with draft saving disabled to avoid overwriting recoverable data. Export the new review before leaving in that case. Browser storage can be cleared externally, so retain exported CSVs.

## Verification and limitations

Tests cover data rules, source association, duplicate/missing metadata, numeric units, draft failures, and component handlers for capture/update/export/re-import/removal/recovery. The component interaction harness runs event handlers without a browser and does not test media decoding or actual layout. A browser smoke check with a real recording is still recommended.

The unchanged Cloudflare scaffolding currently lacks generated types for `cloudflare:workers`, `Fetcher`, and `D1Database` in a standalone `tsc --noEmit` invocation. The vinext build, automated tests, and lint do not depend on those declarations.
