/**
 * Global event bus — a tiny EventEmitter singleton shared across all bot modules.
 * Modules emit events here; src/server.js listens and forwards them to Socket.IO
 * so the dashboard gets real-time updates without tight coupling.
 */
const { EventEmitter } = require("events");

const bus = new EventEmitter();
bus.setMaxListeners(30);

module.exports = bus;
