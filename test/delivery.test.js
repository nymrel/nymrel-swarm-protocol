const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DeliveryLedger } = require('../dist/delivery/delivery');

describe('DeliveryLedger', () => {
  let root;
  let ledger;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-ledger-'));
    ledger = new DeliveryLedger(root);
  });

  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  test('records a forward-only delivery lifecycle with a valid hash chain', async () => {
    await ledger.create({ message_id: 'msg-1', recipient: 'fable', actor: 'sol' });
    for (const to of ['accepted', 'routed', 'delivered', 'observed', 'acted', 'verified']) {
      await ledger.transition({
        message_id: 'msg-1',
        recipient: 'fable',
        to,
        actor: to === 'observed' ? 'fable' : 'studio',
        evidence: {
          kind: to === 'verified' ? 'verification' : 'reconciliation',
          reference: `receipt://${to}`,
        },
      });
    }

    const receipt = ledger.get('msg-1', 'fable');
    assert.equal(receipt.current_state, 'verified');
    assert.equal(receipt.transitions.length, 7);
    assert.equal(DeliveryLedger.verifyReceipt(receipt), true);
  });

  test('same-state retries are idempotent', async () => {
    await ledger.create({ message_id: 'msg-2', recipient: 'gemini', actor: 'sol' });
    const first = await ledger.transition({
      message_id: 'msg-2',
      recipient: 'gemini',
      to: 'accepted',
      actor: 'sol',
    });
    const retry = await ledger.transition({
      message_id: 'msg-2',
      recipient: 'gemini',
      to: 'accepted',
      actor: 'sol',
    });
    assert.equal(first.transitions.length, 2);
    assert.equal(retry.transitions.length, 2);
    assert.equal(first.chain_hash, retry.chain_hash);
  });

  test('rejects backward and post-terminal transitions', async () => {
    await ledger.create({ message_id: 'msg-3', recipient: 'grok', actor: 'sol' });
    await ledger.transition({ message_id: 'msg-3', recipient: 'grok', to: 'accepted', actor: 'sol' });
    await ledger.transition({ message_id: 'msg-3', recipient: 'grok', to: 'rejected', actor: 'router' });

    await assert.rejects(
      ledger.transition({ message_id: 'msg-3', recipient: 'grok', to: 'routed', actor: 'router' }),
      /Invalid delivery transition rejected -> routed/
    );
  });

  test('reconciles delivery_unknown only through explicit allowed transitions', async () => {
    await ledger.create({ message_id: 'msg-4', recipient: 'hermes', actor: 'sol' });
    await ledger.transition({ message_id: 'msg-4', recipient: 'hermes', to: 'accepted', actor: 'sol' });
    await ledger.transition({
      message_id: 'msg-4',
      recipient: 'hermes',
      to: 'delivery_unknown',
      actor: 'transport',
    });
    const reconciled = await ledger.transition({
      message_id: 'msg-4',
      recipient: 'hermes',
      to: 'delivered',
      actor: 'reconciler',
      evidence: { kind: 'reconciliation', reference: 'receipt://recipient-side-proof' },
    });
    assert.equal(reconciled.current_state, 'delivered');
  });

  test('rejects open-ended evidence payloads', async () => {
    await assert.rejects(
      ledger.create({
        message_id: 'msg-5',
        recipient: 'fable',
        actor: 'sol',
        evidence: {
          kind: 'receipt_created',
          reference: 'receipt://created',
          secret: 'not-allowed',
        },
      }),
      /evidence field "secret" is not allowed/
    );
  });

  test('detects persisted receipt tampering', async () => {
    await ledger.create({ message_id: 'msg-6', recipient: 'fable', actor: 'sol' });
    const receipts = ledger.list();
    assert.equal(receipts.length, 1);

    const deliveryRoot = path.join(root, 'deliveries');
    const messageDir = path.join(deliveryRoot, fs.readdirSync(deliveryRoot)[0]);
    const receiptPath = path.join(messageDir, fs.readdirSync(messageDir)[0]);
    const stored = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    stored.transitions[0].actor = 'attacker';
    fs.writeFileSync(receiptPath, JSON.stringify(stored, null, 2));

    assert.throws(() => ledger.get('msg-6', 'fable'), /hash mismatch/);
  });

  test('matches the cross-language delivery hash vector', async () => {
    await ledger.create({
      message_id: 'msg-parity',
      recipient: 'fable',
      actor: 'sol',
      at: '2026-09-02T12:00:00.000Z',
      evidence: { kind: 'receipt_created', reference: 'receipt://created' },
    });
    const receipt = await ledger.transition({
      message_id: 'msg-parity',
      recipient: 'fable',
      to: 'accepted',
      actor: 'sol',
      at: '2026-09-02T12:00:01.000Z',
      evidence: {
        kind: 'outbox_persisted',
        reference: 'file://outbox/msg-parity',
        sha256: 'a'.repeat(64),
      },
    });
    assert.equal(
      receipt.chain_hash,
      'afb4e0debaeca540d983b4e5e4b9f7ae11608a4509cbdb1e01baa369d66de140'
    );
  });
});
