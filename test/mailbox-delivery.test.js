const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { FileMailboxManager } = require('../dist/bus/mailbox');
const { EnvelopeEngine } = require('../dist/bus/envelope');

function messagePath(root, recipient, messageId) {
  return path.join(root, 'mailboxes', recipient, 'inbox', `${messageId}.json`);
}

describe('FileMailboxManager delivery truth integration', () => {
  let root;
  let mailbox;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'mailbox-delivery-'));
    mailbox = new FileMailboxManager(root);
    mailbox.registerAgent('sol');
    mailbox.registerAgent('fable');
    mailbox.registerAgent('gemini');
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  test('separates mailbox persistence from recipient observation', async () => {
    const envelope = EnvelopeEngine.create({
      sender: 'sol',
      recipient: 'fable',
      topic: 'review.requested',
      payload: { artifact: 'pr://42' },
    });

    await mailbox.sendMessage(envelope);
    let receipt = mailbox.getDeliveryReceipt(envelope.header.id, 'fable');
    assert.equal(receipt.current_state, 'delivered');
    assert.deepEqual(receipt.transitions.map((entry) => entry.to), [
      'created', 'accepted', 'routed', 'delivered',
    ]);

    const messages = await mailbox.receiveMessages('fable');
    assert.equal(messages.length, 1);
    receipt = mailbox.getDeliveryReceipt(envelope.header.id, 'fable');
    assert.equal(receipt.current_state, 'observed');
    assert.deepEqual(receipt.transitions.map((entry) => entry.to), [
      'created', 'accepted', 'routed', 'delivered', 'observed',
    ]);
  });

  test('creates one recipient-specific receipt for every broadcast target', async () => {
    const envelope = await mailbox.broadcast('sol', 'studio.notice', { value: 1 });
    const receipts = mailbox.listDeliveryReceipts(envelope.header.id);
    assert.deepEqual(receipts.map((receipt) => receipt.recipient), ['fable', 'gemini']);
    assert.ok(receipts.every((receipt) => receipt.current_state === 'delivered'));

    await mailbox.receiveMessages('fable');
    const fable = mailbox.getDeliveryReceipt(envelope.header.id, 'fable');
    const gemini = mailbox.getDeliveryReceipt(envelope.header.id, 'gemini');
    assert.equal(fable.current_state, 'observed');
    assert.equal(gemini.current_state, 'delivered');
  });

  test('does not record observation for a corrupted inbox message', async () => {
    const envelope = EnvelopeEngine.create({
      sender: 'sol',
      recipient: 'fable',
      topic: 'test.corruption',
      payload: { safe: true },
    });
    await mailbox.sendMessage(envelope);

    const filePath = messagePath(root, 'fable', envelope.header.id);
    const stored = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    stored.payload.safe = false;
    fs.writeFileSync(filePath, JSON.stringify(stored, null, 2));

    const messages = await mailbox.receiveMessages('fable');
    assert.equal(messages.length, 0);
    assert.equal(mailbox.getDeliveryReceipt(envelope.header.id, 'fable').current_state, 'delivered');
  });

  test('re-reading an unarchived message does not duplicate observed history', async () => {
    const envelope = EnvelopeEngine.create({
      sender: 'sol',
      recipient: 'fable',
      topic: 'test.retry',
      payload: {},
    });
    await mailbox.sendMessage(envelope);
    await mailbox.receiveMessages('fable');
    await mailbox.receiveMessages('fable');

    const receipt = mailbox.getDeliveryReceipt(envelope.header.id, 'fable');
    assert.equal(receipt.current_state, 'observed');
    assert.equal(receipt.transitions.filter((entry) => entry.to === 'observed').length, 1);
  });

  test('re-sending the same envelope is idempotent', async () => {
    const envelope = EnvelopeEngine.create({
      sender: 'sol',
      recipient: 'fable',
      topic: 'test.replay',
      payload: { value: 7 },
    });
    await mailbox.sendMessage(envelope);
    await mailbox.sendMessage(envelope);

    const receipt = mailbox.getDeliveryReceipt(envelope.header.id, 'fable');
    assert.equal(receipt.current_state, 'delivered');
    assert.equal(receipt.transitions.filter((entry) => entry.to === 'delivered').length, 1);
    assert.equal((await mailbox.readEventStream()).length, 1);
  });

  test('replay refuses changed bytes without downgrading proven delivery', async () => {
    const envelope = EnvelopeEngine.create({
      sender: 'sol',
      recipient: 'fable',
      topic: 'test.collision',
      payload: { value: 1 },
    });
    await mailbox.sendMessage(envelope);

    const changed = JSON.parse(JSON.stringify(envelope));
    changed.payload.value = 2;
    changed.checksum = EnvelopeEngine.computeChecksum(changed.header, changed.payload);

    await assert.rejects(mailbox.sendMessage(changed), /different (?:envelope bytes|creation contract)/);
    assert.equal(mailbox.getDeliveryReceipt(envelope.header.id, 'fable').current_state, 'delivered');
  });

  test('an interrupted receipt cannot be rebound to different envelope bytes', async () => {
    const envelope = EnvelopeEngine.create({
      sender: 'sol',
      recipient: 'fable',
      topic: 'test.receipt-only-conflict',
      payload: { value: 1 },
    });
    const serialized = EnvelopeEngine.serialize(envelope);
    const digest = crypto.createHash('sha256').update(serialized, 'utf8').digest('hex');
    const { DeliveryLedger } = require('../dist/delivery/delivery');
    const ledger = new DeliveryLedger(root);
    await ledger.create({
      message_id: envelope.header.id,
      recipient: 'fable',
      actor: 'sol',
      evidence: {
        kind: 'receipt_created',
        reference: `envelope://${encodeURIComponent(envelope.header.id)}`,
        sha256: digest,
      },
    });

    const changed = JSON.parse(JSON.stringify(envelope));
    changed.payload.value = 2;
    changed.checksum = EnvelopeEngine.computeChecksum(changed.header, changed.payload);
    await assert.rejects(mailbox.sendMessage(changed), /different creation contract/);
    assert.equal(mailbox.getDeliveryReceipt(envelope.header.id, 'fable').current_state, 'created');
  });

  test('broadcast replay preserves its original recipient set', async () => {
    const envelope = await mailbox.broadcast('sol', 'test.broadcast-replay', { value: 1 });
    mailbox.registerAgent('grok');
    await mailbox.sendMessage(envelope);

    assert.deepEqual(
      mailbox.listDeliveryReceipts(envelope.header.id).map((receipt) => receipt.recipient),
      ['fable', 'gemini']
    );
    assert.equal(await mailbox.receiveMessages('grok').then((messages) => messages.length), 0);
  });

  test('broadcast with no registered target fails before writing delivery state', async () => {
    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mailbox-empty-broadcast-'));
    try {
      const isolated = new FileMailboxManager(emptyRoot);
      isolated.registerAgent('sol');
      const envelope = EnvelopeEngine.create({
        sender: 'sol',
        recipient: 'broadcast',
        topic: 'test.empty-broadcast',
        payload: {},
      });
      await assert.rejects(
        isolated.sendMessage(envelope),
        /Broadcast requires at least one registered recipient/
      );
      assert.deepEqual(isolated.listDeliveryReceipts(envelope.header.id), []);
      assert.equal(fs.existsSync(path.join(emptyRoot, 'mailboxes', 'sol', 'outbox', `${envelope.header.id}.json`)), false);
    } finally {
      fs.rmSync(emptyRoot, { recursive: true, force: true });
    }
  });

  test('missing recipient bytes raise an integrity failure without downgrading delivered state', async () => {
    const envelope = EnvelopeEngine.create({
      sender: 'sol',
      recipient: 'fable',
      topic: 'test.missing-copy',
      payload: {},
    });
    await mailbox.sendMessage(envelope);
    fs.rmSync(messagePath(root, 'fable', envelope.header.id));

    await assert.rejects(
      mailbox.sendMessage(envelope),
      /Delivery receipt claims persistence, but no recipient copy exists/
    );
    assert.equal(mailbox.getDeliveryReceipt(envelope.header.id, 'fable').current_state, 'delivered');
  });

  test('message id cannot be rebound to another recipient', async () => {
    const envelope = EnvelopeEngine.create({
      sender: 'sol',
      recipient: 'fable',
      topic: 'test.recipient-binding',
      payload: {},
    });
    await mailbox.sendMessage(envelope);

    const changed = JSON.parse(JSON.stringify(envelope));
    changed.header.recipient = 'gemini';
    changed.checksum = EnvelopeEngine.computeChecksum(changed.header, changed.payload);
    await assert.rejects(
      mailbox.sendMessage(changed),
      /Message id is already bound to a different recipient set/
    );
    assert.equal(mailbox.getDeliveryReceipt(envelope.header.id, 'fable').current_state, 'delivered');
    assert.equal(mailbox.getDeliveryReceipt(envelope.header.id, 'gemini'), null);
  });
});
