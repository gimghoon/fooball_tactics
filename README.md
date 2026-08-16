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
