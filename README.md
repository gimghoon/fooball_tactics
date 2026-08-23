# TACTIQ coach development guide

TACTIQ is a futsal decision-training app. Coaches author structured scenarios;
only a fully reviewed structured scenario can become publicly playable.

## Scenario payload

Each structured `contentJson` payload uses these exact values:

- Defense type: `front_press`, `central_block`, `wide_funnel`, `one_v_one`,
  `numerical_advantage`, or `numerical_disadvantage`.
- Player action: `pass`, `dribble`, or `move`.
- Explanation kind: `observe`, `benefit`, `risk`, and `remember` — exactly one
  of each is required.

The payload also contains the pitch, actor, allowed actions, preferred and
alternative answers, timeline, highlights, and review flags. A timeline must
have valid ordered time ranges, and every explanation highlight must point to
an existing player, zone, or supported path.

## Coach review and publication

Review each scenario in this order:

1. Confirm the source and set `review.sourceReviewed` to `true`.
2. Play the full timeline, then verify each explanation’s time range and that
   its visual highlight is aligned with the animation; set
   `review.timelineReviewed` and `review.explanationsReviewed` to `true`.
3. Call `POST /api/content/scenarios/:id/review` with
   `{ "status": "reviewed", "sourceTitle": "…", "sourceUrl": "…" }` and
   the `x-review-key` header matching `CONTENT_REVIEW_KEY`.

The server must configure `CONTENT_REVIEWER_NAME` together with
`CONTENT_REVIEW_KEY`. The endpoint records that server-owned reviewer name,
the normalized source title and URL, and the server timestamp in one database
update. It never accepts reviewer identity from the request body. Moving a
scenario back to `draft` or `pending` clears those audit fields so an earlier
approval cannot be mistaken for the current content. The same update stores the
exact reviewed content snapshot; any later content edit invalidates publication
and attempt submission until the scenario is reviewed again.

Publication requires all three flags (`sourceReviewed`, `timelineReviewed`, and
`explanationsReviewed`) plus valid structured content containing all four
explanation kinds. The endpoint returns a Korean `409` validation error for an
incomplete review. `draft` and `pending` transitions are allowed while content
is still being prepared.

Legacy pass-only rows have empty `contentJson` and `defenseType: null`. They
remain compatible for existing training, but cannot be transitioned to
`reviewed` as if they were newly structured and reviewed content.

## Coach evidence bundles and LLM drafts

The protected `/admin/evidence` workspace lets an allowlisted administrator
assemble a narrow evidence bundle, start analysis manually, and review every
generated tactic card beside its citations. The LLM output is always a draft:
it may organize uploaded evidence and operator observations, but it does not
approve tactical truth or publish a playable scenario.

Required server configuration names are:

- `EVIDENCE_ADMIN_USER_IDS`: comma-separated Sites user IDs allowed to use the
  evidence workspace.
- `EVIDENCE_LLM_ENDPOINT`, `EVIDENCE_LLM_API_KEY`, and `EVIDENCE_LLM_MODEL`:
  server-only analyzer configuration. Never expose their values to client code.
- `DB`: the logical D1 binding for workflow state, versions, and audit events.
- `EVIDENCE_FILES`: the logical R2 binding for original files and extracted
  text.

Evidence files may be PDF, TXT, Markdown, or `.markdown`, with an exact maximum
of 20 MiB per file. Text must be UTF-8. PDF extraction supports text layers;
image-only scans are retained but marked as requiring OCR, which this MVP does
not perform. Video evidence is recorded as an HTTPS URL plus an increasing
start/end timecode and a human observation; the video itself is not copied.

Use the workflow in this order:

1. Name one training purpose and add traceable source files or video ranges.
2. Review the complete inventory and explicitly confirm that only those sources
   may be analyzed.
3. Start analysis manually. A failed job can be retried without duplicating a
   completed stage.
4. Compare every action and reason with its cited excerpt or timecode. Low
   confidence, unresolved conflicts, missing citations, and stale bundle
   versions cannot be approved.
5. Record owner review. An approved card can create only an unreviewed scenario
   draft and must still pass the existing source, animation timeline, and
   explanation review gates before publication.

Changing or removing evidence advances the authoritative bundle version and
invalidates prior analysis and approval. Deletion is blocked while cards or
scenario drafts still reference a source, and the admin UI shows that impact
before confirmation. Original filenames are display metadata only; storage
uses opaque keys and authenticated downloads.

Anonymous team-room return keys remain a separate device credential. If a
participant loses that key, their anonymous progress cannot be recovered; the
evidence administration workflow does not change this rule.

## Database migration

Generate a migration after changing the Drizzle schema:

```bash
npm run db:generate
```

Inspect the generated SQL before committing. Keep changes additive so existing
D1 data is preserved.

## Local development and verification

```bash
npm install
npm run dev
npm test
npm run lint
```

The test suite uses local example fixtures to exercise the UI and review
workflow. Those fixtures are never inserted into D1 and are not tactical
recommendations. They only verify that all six defense labels and the training
interaction can render safely without publishing content.
