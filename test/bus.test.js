const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { FileMailboxManager } = require('../dist/bus/mailbox');
const { EnvelopeEngine } = require('../dist/bus/envelope');

describe('FileMailboxManager & Event Stream', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-bus-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('registers mailboxes and delivers direct messages', async () => {
    const mailbox = new FileMailboxManager(tmpDir);
    mailbox.registerAgent('codex-sol');
    mailbox.registerAgent('claude-opus');

    const env = EnvelopeEngine.create({
      sender: 'codex-sol',
      recipient: 'claude-opus',
      topic: 'test.direct',
      payload: { hello: 'world' },
    });

    const msgId = await mailbox.sendMessage(env);
    assert.equal(msgId, env.header.id);

    const received = await mailbox.receiveMessages('claude-opus');
    assert.equal(received.length, 1);
    assert.equal(received[0].header.id, env.header.id);
    assert.deepEqual(received[0].payload, { hello: 'world' });
  });

  test('fans out broadcast messages to all registered agents except sender', async () => {
    const mailbox = new FileMailboxManager(tmpDir);
    mailbox.registerAgent('sender-agent');
    mailbox.registerAgent('worker-1');
    mailbox.registerAgent('worker-2');
    mailbox.registerAgent('worker-3');

    await mailbox.broadcast('sender-agent', 'cluster.sync', { epoch: 42 });

    const w1Msgs = await mailbox.receiveMessages('worker-1');
    const w2Msgs = await mailbox.receiveMessages('worker-2');
    const w3Msgs = await mailbox.receiveMessages('worker-3');
    const senderMsgs = await mailbox.receiveMessages('sender-agent');

    assert.equal(w1Msgs.length, 1);
    assert.equal(w2Msgs.length, 1);
    assert.equal(w3Msgs.length, 1);
    assert.equal(senderMsgs.length, 0);
  });

  test('acknowledges and moves message to archive', async () => {
    const mailbox = new FileMailboxManager(tmpDir);
    mailbox.registerAgent('receiver');

    const env = EnvelopeEngine.create({
      sender: 'sender',
      recipient: 'receiver',
      topic: 'task.one',
      payload: { value: 1 },
    });

    await mailbox.sendMessage(env);

    const msgs = await mailbox.receiveMessages('receiver', { autoAcknowledge: true });
    assert.equal(msgs.length, 1);

    // Second read should be empty
    const msgsAfter = await mailbox.receiveMessages('receiver');
    assert.equal(msgsAfter.length, 0);
  });

  test('records and reads event stream correctly', async () => {
    const mailbox = new FileMailboxManager(tmpDir);
    mailbox.registerAgent('agent-a');
    mailbox.registerAgent('agent-b');

    const env = EnvelopeEngine.create({
      sender: 'agent-a',
      recipient: 'agent-b',
      topic: 'event.check',
      payload: {},
    });

    await mailbox.sendMessage(env);

    const stream = await mailbox.readEventStream();
    assert.ok(stream.length >= 1);
    assert.equal(stream[0].actor, 'agent-a');
    assert.equal(stream[0].event_type, 'message_sent');
  });
});
