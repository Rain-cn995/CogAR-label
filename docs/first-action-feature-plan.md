# First-action timestamp annotation plan

Date: November 17, 2026 (America/Chicago)
Status: Implemented locally on `feature/first-action` on November 18, 2026. Browser smoke verification remains outstanding because this environment blocked local browser execution.
Baseline: `main` at `c5dca0925da629eacd1fc7ea66ecbd530b551cf8`.

## Goal

Record the participant's first observable action toward a task object during an AI-wrong suggestion step. Make that timestamp available as the endpoint of the AI-audio-to-first-action analysis window, while keeping existing final-decision events available for comparison.

Recommended coding definition: the onset of an observable, intentional physical movement toward a task object, whether the chosen object is correct or incorrect. Looking at an object alone does not qualify. Reaching onset can precede touching, picking up, or the final decision. This is a proposed coding rule for the research team to settle before annotation; the app does not infer intent or detect actions automatically.

The initial window preview uses the existing `AI audio` onset, not `AI audio end`. Preserve both markers so subsequent analysis can use either baseline explicitly. An action during audio playback is valid for the onset-based window. Do not require it to follow audio end.

## What exists now

- `app/page.tsx` loads a local video and CSV, detects the timestamp and decision columns, sorts event rows chronologically, and edits timestamps and Accept/Reject labels.
- The visible `action` column comes from the uploaded CSV. It is not currently an application-defined dropdown or event list.
- The current video clock is `videoStartSeconds + video.currentTime`. The app initially guesses the video start from CSV contents; the researcher can set or align it manually.
- Row IDs currently use CSV array indexes. Timestamp edits, decision edits, and export exclusions use those IDs.
- Export currently uses original rows plus timestamp/decision overrides. It has no support for creating new events.
- Latest `main` has no draft autosave. The preserved `feature/timestamp-autosave` branch contains reusable draft-saving logic, but is not merged into `main`.

## Proposed interaction

1. Load the video and CSV and verify the video clock alignment.
2. Select an `AI audio` row. Add a **First action** panel inside the existing timestamp editor, showing the participant/session, task, step, and AI correctness status.
3. For a known AI-wrong step, show **First action: Not recorded** and a **Record first action** button. Keep the target step selected while the researcher plays or scrubs the video.
4. At the first object-directed movement, pause and click the button. If playback is still running, the handler pauses it and captures the media element's current position directly.
5. Insert a distinct event with `action = "First action"`. Display it in the existing chronological table with its ISO timestamp and video-relative timestamp. Keep the source AI event and final-decision row intact.
6. Show the recorded timestamp and the elapsed time from AI onset in the panel. Offer **Go to**, **Update from video**, and **Remove**. Repeated recording updates the same marker for that step occurrence.
7. Reuse the ISO input, timestamp slider, and fine-adjustment buttons for this event. New markers also support the existing export include/exclude toggle. Do not show Accept/Reject controls on generated First action rows.
8. Export the edited CSV using the existing button. Re-import must recognize First action rows and reconnect them to their source events.

A small **AI wrong: N/M first actions recorded** indicator is useful. An optional **Missing first action** filter can make the annotation pass faster, but is secondary to reliable capture and export.

## Eligibility: AI-wrong steps only

Use explicit correctness metadata when present. For the existing study schema, derive eligibility from the associated decision row's `reliance` value:

| Imported evidence | AI correctness | Recording behavior |
| --- | --- | --- |
| `over_rely` or `app_reject` | Wrong | Enable recording |
| `app_rely` or `under_rely` | Correct | Disable recording |
| Missing or conflicting evidence | Unknown | Require explicit classification before recording |

These mappings come from the project's existing analysis definitions. They are not a universal interpretation of arbitrary CSV labels. Preserve the original reliance label even if review decisions are edited.

For CSVs without this metadata, offer an explicit **AI suggestion: Wrong / Correct / Unknown** control for the selected step. Persist manual classification as `ai_correctness` on the associated source event. Existing explicit metadata that conflicts with inferred evidence must be resolved visibly rather than silently overridden.

Do not infer AI correctness from `AI rejected`, a Reject button, object names, or instruction wording alone. A user can reject a correct suggestion. Do not hardcode step numbers: step positions vary across participants.

## Event association and identity

Use the loaded dataset/session, participant identity, plan/task, normalized numeric step, and trial occurrence to group related events. Prefer `sheet` as the participant identity when present: the existing analysis documents legacy participant-ID mismatches in some sheets. Preserve both fields in exports. Normalize numeric step values such as `2` and `2.0` only for matching, preserving their original exported representation.

An ordinary validated trial has one original `AI audio` onset. When a step has repeated cues, multiple attempts, or conflicting decision rows, show the candidate source events and require the researcher to select the intended original suggestion/attempt. Do not silently use the latest or nearest cue. `Recovery audio` is not the original AI-suggestion baseline.

Store one First action annotation per resolved step occurrence and link it to the chosen AI event. Sorting and timestamp changes must not change that association. Imported duplicate markers or duplicate event IDs are review errors, not a reason to silently discard a row.

Add stable `event_id` values for events lacking them, retain imported IDs, and add `source_ai_event_id` to generated annotations. Persist the IDs on export and in drafts so re-import can preserve links even after timestamp edits or chronological reordering. For older First action files without links, offer explicit source matching when the relationship is ambiguous.

## Capture and validation

Read `videoRef.current.currentTime` at capture time, not the React `currentTime` display state and not the computer's wall clock. Compute:

```text
first_action_timestamp_iso = ISO(videoStartSeconds + video.currentTime)
onset_to_first_action_seconds = first_action_seconds - source_ai_onset_seconds
```

Keep millisecond storage precision, matching the current editor. Display precision does not imply millisecond annotation accuracy; accuracy depends on video frames and the coding procedure.

Require a loaded recording with usable metadata, a finite duration/current position, a calibrated video start, a valid selected AI event, and AI-wrong classification. Do not capture while a seek is pending. The captured frame must lie within the video and at or after the intended AI onset. If the first movement was already underway before the cue, record that as a review note rather than clamping it to the cue or inventing a zero-length window.

Flag timestamps inconsistent with known trial boundaries, a recorded final decision, or recovery audio for review. Do not automatically clamp, overwrite, or substitute a final-decision timestamp. A genuinely unobservable first action stays missing; allow a short note such as "hand occluded".

Apply the same source, eligibility, and timing validation after ISO/slider/nudge edits, changes to the source AI timestamp or correctness, CSV import, draft restore, and before export. Generated-event edits must not inherit the current editor's silent clamping behavior. If a source is later classified as correct or becomes ambiguous, flag its marker as ineligible and require resolution or exclusion before export.

Show the alignment source and require the researcher to verify automatically inferred alignment before the first capture. Store the captured video position and alignment in the local draft for audit/review. If video alignment changes afterward, flag affected captures and offer explicit recalibration; do not silently move annotations. Reloading/replacing video or changing timestamp columns must clear stale capture readiness and revalidate links.

## CSV representation

Create a normal event row with the same width as the exported header list. Copy identity/context fields only; do not clone the entire AI-audio row.

| Field | First action row value |
| --- | --- |
| `participant_id`, `sheet`, session identifiers | Same as the resolved trial |
| `plan_id`, `plan`, `step`, `step_name` | Same as the resolved trial |
| `action` | `First action` |
| Selected timestamp column | Captured timestamp; ISO for the study's `event_timestamp_iso` |
| `detail` | `First observable action toward a task object`, plus an optional coder note |
| `event_id` | Stable annotation identifier |
| `source_ai_event_id` | Original AI-suggestion event identifier |
| `review_decision`, `reliance`, existing derived gap fields | Blank |

Retain all original columns and source row values, plus existing user edits and exclusions. Pad short rows before appending new metadata columns. If supporting numeric timestamp columns, serialize captures in the selected column's units consistently; never place epoch seconds in a millisecond column.

Include generated events in the combined chronological export. Onset-to-first-action duration is computed from linked timestamps, avoiding a stale cached duration column. Downstream analysis should select `action == "First action"` as its endpoint and explicitly join to the original AI source event. Updating the eye-gaze analysis pipeline is a separate follow-on task, not an automatic consequence of exporting annotations.

If the source AI event is excluded, visibly mark the dependent annotation as having an excluded source and block its export until the source is included or the marker is also excluded. Never silently export an orphaned source reference. Source events with malformed IDs or unresolved links also require review before the annotation is exported.

## Persistence

Port the useful draft-saving pattern from `feature/timestamp-autosave` into a versioned review draft compatible with current `main`. Save First action annotations, their links, manual correctness classifications, notes, timestamp/decision edits, and exclusions together, keyed by CSV content. Restore only against the matching source dataset and validate row bounds/IDs.

Keep export as the portable record. Show a clear saved/error status and protect pending edits when replacing a CSV or resetting the review. Do not claim annotations are durable when local storage fails. Exported CSV re-import must work without a saved browser draft.

## Implementation plan

| File | Planned responsibility |
| --- | --- |
| `app/first-action.js` (new) | Pure helpers for schema detection, eligibility, trial association, stable IDs, annotation upsert, validation, and export serialization |
| `app/page.tsx` | Connect helpers to state; use ID-based lookups rather than `records[activeRow]`; add capture/edit/remove UI; combine original and generated records for display/export |
| `app/globals.css` | First action panel, eligibility/status messages, generated-row styling, responsive controls |
| `app/csv-draft.js` (adapt from preserved branch) | Versioned draft persistence for the complete review state |
| `tests/first-action.test.mjs` (new) | Behavioral tests of eligibility, identity, capture calculations, update/removal, CSV round trips, exclusions, and ambiguity handling |
| Draft tests and existing tests | Verify persistence and preserve current timestamp/decision/export behavior |
| `README.md` | Annotation workflow, correctness rules, clock alignment, first-action definition, and export schema |

Build the pure data helpers first, then the UI, then draft/export integration. Use synthetic fixtures derived from the known schema, without committing participant recordings or raw study data.

## Acceptance checks

1. Wrong suggestions enable capture; correct suggestions do not. Both accepted-wrong and rejected-wrong steps are eligible. Unknown/conflicting metadata requires explicit resolution.
2. Reordered participant steps, `2` versus `2.0`, sheet-based identity, repeated trials, and multiple AI cues never cross-link annotations.
3. Capturing from a paused or playing video uses the actual media position; invalid alignment, pending seeks, and out-of-video values cannot silently create valid markers.
4. First action during AI audio is accepted for the onset window. Before-onset and anomalous trial timings receive explicit review handling.
5. Updating a marker does not create duplicates. Editing and re-sorting preserve its trial/source link. Removal is reversible through an undo or draft recovery path.
6. Original final-decision timestamps and reliance labels remain present; generated rows have no copied decision/reliance/gap values.
7. Export includes one valid marker per annotated step occurrence, honors exclusions without orphaning markers, and preserves source columns. Export/re-import and browser-draft restore recover links and edits.
8. Existing timestamp editing, decision editing, row exclusion, and video seeking remain usable. Verify the workflow with a synthetic CSV/video, plus lint, TypeScript, and existing build/tests.

## Repository update completed for this planning pass

Local `main` was four commits behind upstream. It is now at `c5dca09`, matching GitHub, including editable decisions, GitHub Pages configuration, and CSV row exclusions. The old autosave feature branch remains intact. The existing local lockfile change was backed up in a Git stash and already exactly matches the updated upstream lockfile. No feature implementation, commit, push, or deployment was performed for this plan.

Baseline verification: `npm run lint` passed; `npm test` built successfully and passed all three existing tests. A separate `tsc --noEmit --incremental false` check found existing missing Cloudflare type declarations (`cloudflare:workers`, `Fetcher`, and `D1Database`). These errors are in the unchanged upstream database/worker scaffolding. The feature itself has not been implemented or tested yet.

## Evidence reviewed

- `app/page.tsx` and current tests at the baseline commit.
- `app/csv-draft.js` and its tests on preserved `feature/timestamp-autosave`.
- Adjacent study data schema: `../CogAR-DataAnalysis/win/cache/event_log.csv`.
- Existing trial/window grouping: `../CogAR-DataAnalysis/build_reliance_window_notebook.py`, especially the AI-audio/decision association logic.
- Existing correctness and identity definitions: `../CogAR-DataAnalysis/docs/superpowers/specs/2026-09-04-audio-end-window-comparison.md`.


## Implementation completion — November 18, 2026

Implemented capture/update/remove/undo, linked First action event rows, eligibility and explicit cue/correctness review, timestamp validation, CSV export/re-import, complete review drafts, clock-change review, and annotation notes. Stable `trial_id` metadata is exported alongside event IDs to preserve trial occurrence across sorting. Annotation metadata is hidden by default and can be shown in the table.

The optional missing-only filter was not added; the recorded/eligible trial count is available. Existing ISO edits now use an explicit Apply ISO button or Enter to avoid an on-blur seek changing the frame immediately before capture.

Added `tests/helpers/component-harness.mjs` and `tests/first-action-ui.test.mjs` to exercise actual component event handlers without a browser. This harness does not test browser rendering or media decoding. The normal dev server was blocked from binding its inspector port, headless Chromium could not launch, and browser security policy rejected the standalone local test page. No browser success is claimed.

The Cloudflare type-declaration baseline issue remains outside this feature. No commit, push, or deployment is part of this implementation pass.
