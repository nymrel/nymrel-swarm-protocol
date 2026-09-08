const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { DeliveryLedger } = require('../dist/delivery/delivery');

function receiptPath(root) {
  const deliveryRoot = path.join(root, 'deliveries');
  const messageDir = path.join(deliveryRoot, fs.readdirSync(deliveryRoot)[0]);
  return path.join(messageDir, fs.readdirSync(messageDir)[0]);
}

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

  test('receipt creation is idempotent only for the same creation contract', async () => {
    await ledger.create({
      message_id: 'msg-create-contract',
      recipient: 'fable',
      actor: 'sol',
      evidence: {
        kind: 'receipt_created',
        reference: 'envelope://msg-create-contract',
        sha256: 'a'.repeat(64),
      },
    });

    await ledger.create({
      message_id: 'msg-create-contract',
      recipient: 'fable',
      actor: 'sol',
      evidence: {
        kind: 'receipt_created',
        reference: 'envelope://msg-create-contract',
        sha256: 'a'.repeat(64),
      },
    });

    await assert.rejects(
      ledger.create({
        message_id: 'msg-create-contract',
        recipient: 'fable',
        actor: 'other-sender',
        evidence: {
          kind: 'receipt_created',
          reference: 'envelope://msg-create-contract',
          sha256: 'b'.repeat(64),
        },
      }),
      /different creation contract/
    );
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

  test('does not downgrade proven delivery to delivery_unknown', async () => {
    await ledger.create({ message_id: 'msg-known', recipient: 'fable', actor: 'sol' });
    await ledger.transition({ message_id: 'msg-known', recipient: 'fable', to: 'accepted', actor: 'sol' });
    await ledger.transition({ message_id: 'msg-known', recipient: 'fable', to: 'routed', actor: 'mesh' });
    await ledger.transition({ message_id: 'msg-known', recipient: 'fable', to: 'delivered', actor: 'mesh' });

    await assert.rejects(
      ledger.transition({
        message_id: 'msg-known',
        recipient: 'fable',
        to: 'delivery_unknown',
        actor: 'mesh',
      }),
      /Invalid delivery transition delivered -> delivery_unknown/
    );
    assert.equal(ledger.get('msg-known', 'fable').current_state, 'delivered');
  });

  test('reconciles delivery_unknown only through explicit allowed transitions', async () => {
    await ledger.create({ message_id: 'msg-4', recipient: 'hermes', actor: 'sol' });
    await ledger.transition({ message_id: 'msg-4', recipient: 'hermes', to: 'accepted', actor: 'sol' });
    await ledger.transition({
      message_id: 'msg-4',
      recipient: 'hermes',
      to: 'delivery_unknown',
      actor: 'transport',
      reason_code: 'transport_result_ambiguous',
    });
    const reconciled = await ledger.transition({
      message_id: 'msg-4',
      recipient: 'hermes',
      to: 'delivered',
      actor: 'reconciler',
      reason_code: 'explicit_reconciliation',
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

  test('rejects free-form transition reasons', async () => {
    await assert.rejects(
      ledger.create({
        message_id: 'msg-reason',
        recipient: 'fable',
        actor: 'sol',
        reason_code: 'contains-a-secret',
      }),
      /reason_code must be one of/
    );
  });

  test('missing reads do not create receipt subdirectories', () => {
    assert.equal(ledger.get('missing-message', 'fable'), null);
    assert.deepEqual(fs.readdirSync(path.join(root, 'deliveries')), []);
  });

  test('detects persisted receipt tampering', async () => {
    await ledger.create({ message_id: 'msg-6', recipient: 'fable', actor: 'sol' });
    const storedPath = receiptPath(root);
    const stored = JSON.parse(fs.readFileSync(storedPath, 'utf8'));
    stored.transitions[0].actor = 'attacker';
    fs.writeFileSync(storedPath, JSON.stringify(stored, null, 2));

    assert.throws(() => ledger.get('msg-6', 'fable'), /hash mismatch/);
  });

  test('rejects unknown top-level and transition fields', async () => {
    await ledger.create({ message_id: 'msg-closed', recipient: 'fable', actor: 'sol' });
    const storedPath = receiptPath(root);
    const stored = JSON.parse(fs.readFileSync(storedPath, 'utf8'));
    stored.secret = 'not-allowed';
    fs.writeFileSync(storedPath, JSON.stringify(stored, null, 2));
    assert.throws(() => ledger.get('msg-closed', 'fable'), /receipt field "secret" is not allowed/);

    delete stored.secret;
    stored.transitions[0].payload = 'not-allowed';
    fs.writeFileSync(storedPath, JSON.stringify(stored, null, 2));
    assert.throws(
      () => ledger.get('msg-closed', 'fable'),
      /receipt\.transitions\[0\] field "payload" is not allowed/
    );
  });

  test('requires canonical nondecreasing stored timestamps', async () => {
    await ledger.create({
      message_id: 'msg-time',
      recipient: 'fable',
      actor: 'sol',
      at: '2026-09-02T12:00:00.000Z',
    });
    const storedPath = receiptPath(root);
    const stored = JSON.parse(fs.readFileSync(storedPath, 'utf8'));
    stored.created_at = '2026-09-02T05:00:00.000-07:00';
    fs.writeFileSync(storedPath, JSON.stringify(stored, null, 2));
    assert.throws(() => ledger.get('msg-time', 'fable'), /canonical UTC timestamp/);
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
