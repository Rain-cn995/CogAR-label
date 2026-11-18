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

1. Upload the event CSV and select the timestamp or pencil on the intended **AI audio end** row. You can select the row before loading the recording. When a trial has repeated cues, select the exact end row to use.
2. Load the recording and check **VIDEO START ISO** against a known event. Apply a corrected start time if needed.
3. Play or scrub to the first observable physical movement toward a task object, then click **Record first action**. Looking alone does not qualify. Movement toward either a correct or incorrect object counts.
4. The panel shows the captured ISO timestamp and signed elapsed time from the selected **AI audio end**. An action before audio end is recorded at its observed time with a negative elapsed value and a warning.
5. Keep the linked end row selected to **Update from video**. Select the marker itself to use the timestamp editor, including the slider, fine controls, and **Apply ISO**. Removal is reversible through **Undo removal**, including after draft recovery.
6. Click **Export edited CSV** for a portable copy that includes the marker and its stable source link.

One marker is retained per resolved trial occurrence. New end-linked captures work with any AI correctness classification, including missing metadata. Selecting a different end leaves an existing marker linked to its original cue. Use **Linked AI cue** on the marker to change its source explicitly. After-decision, recovery, completion, or next-trial times produce review warnings. If no action is observable, leave it unrecorded.

## Clock changes and validation

Capturing requires a valid video start and a loaded recording with a finite duration. The handler checks that the live frame is within the recording and has finished seeking, then pauses playback to capture it. Existing captures whose video or clock changed need review before export. **Recalculate from captured frame** preserves the observed video position under a corrected clock. **Keep ISO time after review** preserves the absolute timestamp. Recalculation is available for the same recording.

Source links, duplicate IDs/markers, and timestamps are revalidated after edits, import, draft recovery, and before export. Older onset-linked markers retain their source links and validation. Excluding an AI source blocks export of its dependent marker until the source is included or the marker is also excluded. Inspect issues shown above the editor.

## CSV schema

The standard study schema is `participant_id`, `sheet`, `plan_id`, `plan`, `step`, `step_name`, `action`, `detail`, `event_timestamp_iso`, `review_decision`, and `reliance`. Header matching is case-insensitive. Task/session aliases are recognized by the grouping helpers. A task and step are required for First action capture.

Numeric step values such as `2` and `2.0` match. Where present, `sheet` takes precedence over legacy participant IDs. Task starts and completed attempts separate repeated trials.

Original columns and values are retained, with timestamp/decision edits and export exclusions applied. Added metadata columns are hidden in the table by default; enable **Show annotation metadata** to inspect them:

| Column | Purpose |
| --- | --- |
| `event_id` | Stable identity, retained on re-import |
| `source_ai_event_id` | Links a First action event to the selected AI audio end or its legacy AI audio onset |
| `trial_id` | Stable trial occurrence, protected against participant/task mismatches |
| `ai_correctness` | Preserved correctness classification on the source cue |
| `ai_correctness_reviewed` | Preserved record of a coder resolving correctness |
| `first_action_source_selected` | Explicit choice among repeated onset cues for legacy markers |
| `annotation_note` | Preserved observation or reason an action remained unrecorded |

Generated rows copy identity/task context only. They leave final-decision, reliance, and old derived gap columns blank. Numeric timestamp columns retain their units. Millisecond formatting does not imply millisecond observation accuracy. Older First action rows without links can be explicitly linked using **Linked AI cue**.

Downstream analysis can join `source_ai_event_id` to the linked cue's `event_id` for the window start and use the First action timestamp for the endpoint.

## Draft recovery

Review changes are saved on this device in a versioned browser local-storage draft keyed by the original CSV's contents. Reopen the same CSV to restore annotations, imported metadata, links, timestamp/decision edits, exclusions, removals, and video-clock information. Load the video again before recording. Files themselves are not stored in the draft.

Export remains the portable record. A storage error is displayed rather than reported as success. The app warns before leaving/replacing/resetting when saving fails. A malformed saved draft is left intact; the original CSV opens with draft saving disabled to avoid overwriting recoverable data. Export the new review before leaving in that case. Browser storage can be cleared externally, so retain exported CSVs.

## Verification and limitations

Tests cover data rules, source association, duplicate/missing metadata, numeric units, draft failures, and component handlers for capture/update/export/re-import/removal/recovery. The component interaction harness runs event handlers without a browser and does not test media decoding or actual layout. A browser smoke check with a real recording is still recommended.

The unchanged Cloudflare scaffolding currently lacks generated types for `cloudflare:workers`, `Fetcher`, and `D1Database` in a standalone `tsc --noEmit` invocation. The vinext build, automated tests, and lint do not depend on those declarations.
