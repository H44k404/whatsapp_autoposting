const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DisconnectReason } = require('baileys');

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'whatsapp-auth-test-'));
const previousWorkspacesDir = process.env.WORKSPACES_DIR;
const previousLegacyAuthDir = process.env.LEGACY_AUTH_DIR;
process.env.WORKSPACES_DIR = path.join(testRoot, 'workspaces');
process.env.LEGACY_AUTH_DIR = path.join(testRoot, 'auth');
const workspaceMod = require('../src/workspace');
const legacyAuthDir = process.env.LEGACY_AUTH_DIR;
const workspaceAuthDir = path.join(testRoot, 'workspaces', 'admin', 'auth');

test('workspace auth ignores stale legacy sessions and retries are bounded', () => {
  try {
    fs.mkdirSync(legacyAuthDir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(legacyAuthDir, 'legacy-session.json'), JSON.stringify({ stale: true }));

    workspaceMod.ensureWorkspace('admin');

    assert.equal(fs.existsSync(path.join(workspaceAuthDir, 'legacy-session.json')), false);
    const { shouldAttemptReconnect } = require('../src/whatsapp');
    assert.equal(shouldAttemptReconnect(DisconnectReason.loggedOut, false, 0), false);
    assert.equal(shouldAttemptReconnect(DisconnectReason.timedOut, false, 0), true);
    assert.equal(shouldAttemptReconnect(DisconnectReason.timedOut, false, 5), false);
    assert.equal(shouldAttemptReconnect(DisconnectReason.connectionReplaced, false, 0), false);
  } finally {
    fs.rmSync(testRoot, { recursive: true, force: true });
    if (previousWorkspacesDir === undefined) delete process.env.WORKSPACES_DIR;
    else process.env.WORKSPACES_DIR = previousWorkspacesDir;
    if (previousLegacyAuthDir === undefined) delete process.env.LEGACY_AUTH_DIR;
    else process.env.LEGACY_AUTH_DIR = previousLegacyAuthDir;
  }
});
