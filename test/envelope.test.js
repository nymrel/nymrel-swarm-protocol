const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EnvelopeEngine } = require('../dist/bus/envelope');

describe('EnvelopeEngine v2', () => {
  test('creates valid envelope with SHA-256 checksum', () => {
    const env = EnvelopeEngine.create({
      sender: 'codex-sol',
      recipient: 'claude-opus',
      topic: 'task.dispatch',
      payload: { task_id: 'task-101', priority: 'high' },
    });

    assert.equal(env.header.version, '2.0');
    assert.equal(env.header.sender, 'codex-sol');
    assert.equal(env.header.recipient, 'claude-opus');
    assert.equal(env.header.topic, 'task.dispatch');
    assert.ok(env.header.id);
    assert.ok(env.header.timestamp);
    assert.ok(env.checksum);
    assert.equal(EnvelopeEngine.verify(env), true);
  });

  test('detects tampered payload', () => {
    const env = EnvelopeEngine.create({
      sender: 'codex-sol',
      recipient: 'claude-opus',
      topic: 'task.dispatch',
      payload: { amount: 100 },
    });

    assert.equal(EnvelopeEngine.verify(env), true);

    // Tamper with payload
    const tampered = {
      ...env,
      payload: { amount: 999999 },
    };

    assert.equal(EnvelopeEngine.verify(tampered), false);
  });

  test('serializes and deserializes correctly', () => {
    const env = EnvelopeEngine.create({
      sender: 'cursor-grok',
      recipient: 'all',
      topic: 'heartbeat',
      payload: { status: 'healthy', load: 0.12 },
    });

    const serialized = EnvelopeEngine.serialize(env);
    const deserialized = EnvelopeEngine.deserialize(serialized);

    assert.deepEqual(deserialized, env);
  });

  test('rejects corrupted raw JSON during deserialization', () => {
    const raw = JSON.stringify({
      header: { id: 'bad', version: '1.0' },
      payload: {},
      checksum: 'invalid',
    });

    assert.throws(() => EnvelopeEngine.deserialize(raw), /Invalid Envelope v2/);
  });
});
