# Futsal Tactics Training MVP Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a mobile-first team training MVP for a coach-verified diamond 1-2-1 futsal campaign.

**Architecture:** A vinext/Next-compatible PWA renders scenario data on an SVG pitch. Pure TypeScript domain modules judge touches and calculate mastery; route handlers persist rooms, participants, attempts, and reflections in Cloudflare D1 while device storage holds only the recovery token and unsynced events.

**Tech Stack:** React 19, TypeScript, vinext, Cloudflare D1, Drizzle, Node test runner.

## Global Constraints

- Unverified coach material cannot become playable answer content.
- No sign-in, ranking, real-time multiplayer, AI generation, or user authoring in the MVP.
- Mobile portrait touch targets must be at least 44px.
- Detailed wrong-answer history is private to the participant.

---

### Task 1: Product shell and domain foundations

- [ ] Write failing tests for touch-zone boundary checks, mastery calculation, campaign visibility, and duplicate offline events.
- [ ] Implement pure domain modules until the tests pass.
- [ ] Build the mobile app shell, campaign overview, and reviewed-content guard.

### Task 2: Scenario campaign

- [ ] Write interaction tests for role order, hint progression, retry, and completion.
- [ ] Implement the SVG pitch and direct-touch scenario runner.
- [ ] Add team-motion recap, practical mission, and review mode.

### Task 3: Team room and persistence

- [ ] Define D1 schema and indexes for rooms, participants, attempts, mastery, and reflections.
- [ ] Write route-level tests for room creation, nickname uniqueness, recovery tokens, removal, and invite rotation.
- [ ] Implement route handlers and client-side retry queue with idempotency keys.

### Task 4: Validation and deployment

- [ ] Verify unit, integration, build, lint, and responsive mobile behavior.
- [ ] Generate and inspect D1 migrations.
- [ ] Deploy through Sites and complete the four-player pilot checklist.

