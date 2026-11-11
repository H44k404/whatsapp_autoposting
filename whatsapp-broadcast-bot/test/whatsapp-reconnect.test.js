const test = require('node:test');
const assert = require('node:assert/strict');
const { DisconnectReason } = require('baileys');
const { getReconnectDelay, shouldAttemptReconnect } = require('../src/whatsapp');

test('transient WhatsApp disconnects continue retrying beyond five failures', () => {
  assert.equal(shouldAttemptReconnect(DisconnectReason.timedOut, false, 100), true);
  assert.equal(shouldAttemptReconnect(DisconnectReason.connectionClosed, false, 100), true);
});

test('reconnect delay grows exponentially and remains capped', () => {
  assert.deepEqual(
    [1, 2, 3, 4, 5, 6, 10].map(getReconnectDelay),
    [3000, 6000, 12000, 24000, 48000, 60000, 60000]
  );
});

test('logged-out, forbidden, and replaced sessions stop automatic retries', () => {
  assert.equal(shouldAttemptReconnect(DisconnectReason.loggedOut, false), false);
  assert.equal(shouldAttemptReconnect(DisconnectReason.forbidden, false), false);
  assert.equal(shouldAttemptReconnect(DisconnectReason.connectionReplaced, false), false);
  assert.equal(shouldAttemptReconnect(DisconnectReason.connectionClosed, true), false);
});
