import assert from "node:assert/strict";
import test from "node:test";

import {
  authorizeEvidenceAdmin,
  parseAdminUserIds,
  requireEvidenceAdminApi,
  type EvidenceAdminAuthDependencies,
} from "../lib/server/evidence-auth.ts";
import type { ChatGPTUser } from "../app/chatgpt-auth.ts";

const user: ChatGPTUser = {
  userId: "user-2",
  email: "a@x.test",
  displayName: "A",
  fullName: null,
};

function request(headers: Record<string, string> = {}) {
  return new Request("http://localhost/api/admin/evidence", { headers });
}

function requireEvidenceAdminApiWith(
  authenticatedUser: ChatGPTUser | null,
  adminUserIds: string | undefined,
) {
  const dependencies: EvidenceAdminAuthDependencies = {
    getUser: async () => authenticatedUser,
    adminUserIds,
  };
  return requireEvidenceAdminApi(request(), dependencies);
}

test("only exact allowlisted user IDs are admins", () => {
  assert.equal(authorizeEvidenceAdmin(user, "user-1,user-2")?.userId, "user-2");
  assert.equal(authorizeEvidenceAdmin(user, "user-20"), null);
});

test("admin IDs are trimmed and empty entries are discarded", () => {
  assert.deepEqual(parseAdminUserIds(" user-1, ,user-2 ,,"), new Set(["user-1", "user-2"]));
  assert.deepEqual(parseAdminUserIds(undefined), new Set());
});

test("missing login is 401 and logged-in non-admin is 403", async () => {
  assert.equal((await requireEvidenceAdminApiWith(null, "user-1")).status, 401);
  assert.equal((await requireEvidenceAdminApiWith({ ...user, userId: "user-2" }, "user-1")).status, 403);
});

test("API authority ignores request headers and accepts only the authenticated user ID", async () => {
  const response = await requireEvidenceAdminApi(
    request({
      "x-evidence-admin-user-id": "user-1",
      "x-user-id": "user-1",
      cookie: "evidence-admin=user-1",
    }),
    {
      getUser: async () => user,
      adminUserIds: "user-2",
    },
  );

  assert.equal(response instanceof Response, false);
  assert.equal((response as ChatGPTUser).userId, "user-2");
});
