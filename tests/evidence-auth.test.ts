import assert from "node:assert/strict";
import test from "node:test";

import {
  authorizeEvidenceAdmin,
  decideEvidenceAdminApi,
  decideEvidenceAdminPage,
  parseAdminUserIds,
} from "../lib/server/evidence-auth.ts";
import type { ChatGPTUser } from "../app/chatgpt-auth.ts";

const user: ChatGPTUser = {
  userId: "user-2",
  email: "a@x.test",
  displayName: "A",
  fullName: null,
};

test("only exact allowlisted user IDs are admins", () => {
  assert.equal(authorizeEvidenceAdmin(user, "user-1,user-2")?.userId, "user-2");
  assert.equal(authorizeEvidenceAdmin(user, "user-20"), null);
});

test("admin IDs are trimmed and empty entries are discarded", () => {
  assert.deepEqual(parseAdminUserIds(" user-1, ,user-2 ,,"), new Set(["user-1", "user-2"]));
  assert.deepEqual(parseAdminUserIds(undefined), new Set());
});

test("page decision sends missing login through ChatGPT sign-in with the requested return path", () => {
  assert.deepEqual(decideEvidenceAdminPage(null, "user-1", "/admin/evidence?step=2"), {
    kind: "signin",
    returnTo: "/admin/evidence?step=2",
  });
});

test("page decision forbids a logged-in non-admin and admits an exact admin", () => {
  assert.deepEqual(decideEvidenceAdminPage({ ...user, userId: "user-2" }, "user-1", "/admin/evidence"), {
    kind: "forbidden",
  });
  assert.deepEqual(decideEvidenceAdminPage(user, "user-2", "/admin/evidence"), {
    kind: "admin",
    admin: user,
  });
});

test("API decision is 401 for missing login and 403 for a logged-in non-admin", () => {
  assert.deepEqual(decideEvidenceAdminApi(null, "user-1"), {
    kind: "response",
    status: 401,
    error: "로그인이 필요해요.",
  });
  assert.deepEqual(decideEvidenceAdminApi({ ...user, userId: "user-2" }, "user-1"), {
    kind: "response",
    status: 403,
    error: "자료 관리자 권한이 필요해요.",
  });
});

test("API decision ignores spoofed headers and uses only the exact authenticated user ID", () => {
  const spoofedHeaders = {
    "x-evidence-admin-user-id": "user-1",
    "x-user-id": "user-1",
    cookie: "evidence-admin=user-1",
  };
  void spoofedHeaders;

  assert.deepEqual(decideEvidenceAdminApi(user, "user-2"), {
    kind: "admin",
    admin: user,
  });
});
