import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeExternalUrl,
  parseSearchCandidateDraft,
  parseSearchSelection,
} from "../lib/domain/evidence-search.ts";

function candidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    url: "https://UEFA.com/a/?b=2&a=1#part",
    canonicalUrl: "https://uefa.com/a/?a=1&b=2",
    title: "UEFA coaching guidance",
    publisher: "UEFA",
    publishedAt: "2026-08-26",
    documentType: "web_page",
    quote: "Pressing shape should keep the central lane protected.",
    relevance: "Explains the team's central-pressure escape pattern.",
    proposedTrustTier: 1,
    ...overrides,
  };
}

test("normalizes HTTPS URLs and removes fragments", () => {
  assert.equal(normalizeExternalUrl("https://UEFA.com/a/?b=2&a=1#part"), "https://uefa.com/a/?a=1&b=2");
  assert.throws(() => normalizeExternalUrl("http://uefa.com/a"), /HTTPS/);
  assert.throws(() => normalizeExternalUrl("https://user:pass@uefa.com/a"), /URL/);
});

test("candidate metadata and selection limits are strict", () => {
  assert.throws(() => parseSearchCandidateDraft({ ...candidate(), publishedAt: "" }), /게시일/);
  assert.throws(() => parseSearchSelection({ expectedBundleVersion: 3, selectedIds: ["1", "2", "3", "4", "5", "6"], excludedIds: [] }), /5개/);
  assert.throws(() => parseSearchSelection({ expectedBundleVersion: 3, selectedIds: ["1"], excludedIds: ["1"] }), /동시에/);
});

test("candidate parser trims fields and requires canonical URL consistency", () => {
  const draft = parseSearchCandidateDraft(candidate({
    title: " UEFA coaching guidance ",
    publisher: " UEFA ",
    quote: " Pressing shape should keep the central lane protected. ",
    relevance: " Explains the team's central-pressure escape pattern. ",
  }));

  assert.deepEqual(draft, {
    ...candidate(),
    url: "https://uefa.com/a/?a=1&b=2",
    canonicalUrl: "https://uefa.com/a/?a=1&b=2",
    title: "UEFA coaching guidance",
    publisher: "UEFA",
    quote: "Pressing shape should keep the central lane protected.",
    relevance: "Explains the team's central-pressure escape pattern.",
  });
  assert.throws(() => parseSearchCandidateDraft(candidate({ canonicalUrl: "https://uefa.com/other" })), /canonicalUrl/);
});
