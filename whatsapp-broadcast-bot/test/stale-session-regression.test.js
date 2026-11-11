const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { DisconnectReason } = require('baileys');

const workspaceMod = require('../src/workspace');
const { shouldAttemptReconnect } = require('../src/whatsapp');
const rootDir = path.join(__dirname, '..');
const legacyAuthDir = path.join(rootDir, 'auth');
const workspaceAuthDir = path.join(rootDir, 'data', 'workspaces', 'admin', 'auth');

function cleanup() {
  fs.rmSync(legacyAuthDir, { recursive: true, force: true });
  fs.rmSync(workspaceAuthDir, { recursive: true, force: true });
  fs.mkdirSync(path.join(rootDir, 'data', 'workspaces', 'admin'), { recursive: true, mode: 0o700 });
}

test('ensureWorkspace does not restore stale legacy auth for admin workspace', () => {
  cleanup();
  fs.mkdirSync(legacyAuthDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(legacyAuthDir, 'legacy-session.json'), JSON.stringify({ stale: true }));

  workspaceMod.ensureWorkspace('admin');

  assert.equal(fs.existsSync(path.join(workspaceAuthDir, 'legacy-session.json')), false);
  cleanup();
});

test('transient disconnects keep retrying while logout and replaced sessions stop', () => {
  assert.equal(shouldAttemptReconnect(DisconnectReason.loggedOut, false, 0), false);
  assert.equal(shouldAttemptReconnect(DisconnectReason.timedOut, false, 0), true);
  assert.equal(shouldAttemptReconnect(DisconnectReason.timedOut, false, 100), true);
  assert.equal(shouldAttemptReconnect(DisconnectReason.connectionReplaced, false, 0), false);
  assert.equal(shouldAttemptReconnect(DisconnectReason.forbidden, false, 0), false);
});
