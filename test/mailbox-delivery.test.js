const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
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
      'created',
      'accepted',
      'routed',
      'delivered',
    ]);

    const messages = await mailbox.receiveMessages('fable');
    assert.equal(messages.length, 1);
    receipt = mailbox.getDeliveryReceipt(envelope.header.id, 'fable');
    assert.equal(receipt.current_state, 'observed');
    assert.deepEqual(receipt.transitions.map((entry) => entry.to), [
      'created',
      'accepted',
      'routed',
      'delivered',
      'observed',
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
});
