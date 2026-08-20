const assert = require("assert");
const fs = require("fs");
const { ensureWorkspace } = require("../src/workspace");
const store = require("../src/store");

const workspaceIds = ["test-isolation-a", "test-isolation-b"];
let paths = [];

try {
  paths = workspaceIds.map(ensureWorkspace);
  assert.notStrictEqual(paths[0].auth, paths[1].auth);
  assert.notStrictEqual(paths[0].groups, paths[1].groups);
  assert.notStrictEqual(paths[0].pending, paths[1].pending);
  assert.notStrictEqual(paths[0].media, paths[1].media);
  assert(paths[0].auth.endsWith("data\\workspaces\\test-isolation-a\\auth") || paths[0].auth.endsWith("data/workspaces/test-isolation-a/auth"));

  store.savePending("only-a", { status: "pending", workspaceMarker: "a" }, workspaceIds[0]);
  assert.deepStrictEqual(store.getPending("only-a", workspaceIds[0]), { status: "pending", workspaceMarker: "a" });
  assert.strictEqual(store.getPending("only-a", workspaceIds[1]), undefined);
  console.log("workspace isolation: PASS (auth/config/pending/media paths and pending data are separate)");
} finally {
  for (const workspace of paths || []) fs.rmSync(workspace.root, { recursive: true, force: true });
}