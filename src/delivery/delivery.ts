/**
 * Nymrel Mesh delivery truth ledger.
 *
 * A sender-side success is never allowed to stand in for recipient observation
 * or verified task completion. One tamper-evident receipt is persisted for
 * every (message_id, recipient) pair.
 */

import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { AtomicLockManager } from '../fencing/lock';

export const DELIVERY_RECEIPT_VERSION = '1.0' as const;

export const DELIVERY_STATES = [
  'created',
  'accepted',
  'routed',
  'deferred',
  'delivered',
  'observed',
  'acted',
  'verified',
  'delivery_unknown',
  'expired',
  'dead_lettered',
  'revoked',
  'rejected',
] as const;

export type DeliveryState = (typeof DELIVERY_STATES)[number];

export const DELIVERY_EVIDENCE_KINDS = [
  'receipt_created',
  'outbox_persisted',
  'route_selected',
  'mailbox_persisted',
  'runtime_observed',
  'agent_action',
  'verification',
  'reconciliation',
  'operator_decision',
] as const;

export type DeliveryEvidenceKind = (typeof DELIVERY_EVIDENCE_KINDS)[number];

export interface DeliveryEvidence {
  kind: DeliveryEvidenceKind;
  reference: string;
  sha256?: string;
}

export interface DeliveryTransition {
  sequence: number;
  from: DeliveryState | null;
  to: DeliveryState;
  actor: string;
  at: string;
  evidence?: DeliveryEvidence;
  note?: string;
  previous_hash: string | null;
  hash: string;
}

export interface DeliveryReceipt {
  version: typeof DELIVERY_RECEIPT_VERSION;
  message_id: string;
  recipient: string;
  current_state: DeliveryState;
  created_at: string;
  updated_at: string;
  chain_hash: string;
  transitions: DeliveryTransition[];
}

export interface CreateDeliveryReceiptParams {
  message_id: string;
  recipient: string;
  actor: string;
  at?: string;
  evidence?: DeliveryEvidence;
  note?: string;
}

export interface TransitionDeliveryParams {
  message_id: string;
  recipient: string;
  to: DeliveryState;
  actor: string;
  at?: string;
  evidence?: DeliveryEvidence;
  note?: string;
}

const TERMINAL_STATES = new Set<DeliveryState>([
  'verified',
  'expired',
  'dead_lettered',
  'revoked',
  'rejected',
]);

const ALLOWED_TRANSITIONS: Readonly<Record<DeliveryState, readonly DeliveryState[]>> = {
  created: ['accepted', 'rejected', 'revoked'],
  accepted: ['routed', 'deferred', 'delivery_unknown', 'expired', 'dead_lettered', 'revoked', 'rejected'],
  routed: ['delivered', 'deferred', 'delivery_unknown', 'expired', 'dead_lettered', 'revoked'],
  deferred: ['routed', 'delivery_unknown', 'expired', 'dead_lettered', 'revoked'],
  delivered: ['observed', 'delivery_unknown', 'expired', 'dead_lettered', 'revoked'],
  observed: ['acted', 'delivery_unknown', 'revoked'],
  acted: ['verified', 'delivery_unknown', 'revoked'],
  delivery_unknown: ['routed', 'deferred', 'delivered', 'observed', 'expired', 'dead_lettered', 'revoked'],
  verified: [],
  expired: [],
  dead_lettered: [],
  revoked: [],
  rejected: [],
};

const STATE_SET = new Set<string>(DELIVERY_STATES);
const EVIDENCE_KIND_SET = new Set<string>(DELIVERY_EVIDENCE_KINDS);
const EVIDENCE_KEYS = new Set(['kind', 'reference', 'sha256']);

function cloneReceipt(receipt: DeliveryReceipt): DeliveryReceipt {
  return JSON.parse(JSON.stringify(receipt)) as DeliveryReceipt;
}

function assertText(value: unknown, field: string, maxLength: number): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new Error(`${field} must be a non-empty string without surrounding whitespace`);
  }
  if (value.length > maxLength) {
    throw new Error(`${field} exceeds the maximum length of ${maxLength}`);
  }
  if (/\p{Cc}/u.test(value)) {
    throw new Error(`${field} must not contain control characters`);
  }
}

function normalizeTimestamp(at?: string): string {
  if (at === undefined) return new Date().toISOString();
  assertText(at, 'at', 64);
  if (!/(?:Z|[+-]\d{2}:\d{2})$/.test(at)) {
    throw new Error('at must include an explicit UTC or offset timezone');
  }
  const parsed = new Date(at);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error('at must be a valid timestamp');
  }
  return parsed.toISOString();
}

function assertEvidence(evidence: unknown): asserts evidence is DeliveryEvidence {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    throw new Error('evidence must be an object');
  }

  for (const key of Object.keys(evidence)) {
    if (!EVIDENCE_KEYS.has(key)) {
      throw new Error(`evidence field "${key}" is not allowed`);
    }
  }

  const candidate = evidence as Partial<DeliveryEvidence>;
  if (!candidate.kind || !EVIDENCE_KIND_SET.has(candidate.kind)) {
    throw new Error(`evidence.kind must be one of: ${DELIVERY_EVIDENCE_KINDS.join(', ')}`);
  }
  assertText(candidate.reference, 'evidence.reference', 2048);

  if (candidate.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(candidate.sha256)) {
    throw new Error('evidence.sha256 must be a lowercase 64-character SHA-256 digest');
  }
}

function assertNote(note: unknown): asserts note is string {
  assertText(note, 'note', 1000);
}

function encodeField(value: string | null | undefined): string {
  const normalized = value ?? '';
  return `${Buffer.byteLength(normalized, 'utf8')}:${normalized}`;
}

export class DeliveryLedger {
  private readonly receiptsDir: string;
  private readonly lockManager: AtomicLockManager;

  constructor(swarmRoot: string) {
    assertText(swarmRoot, 'swarmRoot', 4096);
    this.receiptsDir = path.join(swarmRoot, 'deliveries');
    this.lockManager = new AtomicLockManager(swarmRoot);
    fs.mkdirSync(this.receiptsDir, { recursive: true });
  }

  static isTerminal(state: DeliveryState): boolean {
    return TERMINAL_STATES.has(state);
  }

  static canTransition(from: DeliveryState, to: DeliveryState): boolean {
    return from === to || ALLOWED_TRANSITIONS[from].includes(to);
  }

  static computeTransitionHash(
    messageId: string,
    recipient: string,
    transition: Omit<DeliveryTransition, 'hash'>
  ): string {
    const material = [
      messageId,
      recipient,
      String(transition.sequence),
      transition.from,
      transition.to,
      transition.actor,
      transition.at,
      transition.evidence?.kind,
      transition.evidence?.reference,
      transition.evidence?.sha256,
      transition.note,
      transition.previous_hash,
    ]
      .map(encodeField)
      .join('');

    return crypto.createHash('sha256').update(material, 'utf8').digest('hex');
  }

  static verifyReceipt(receipt: unknown): receipt is DeliveryReceipt {
    try {
      DeliveryLedger.assertReceipt(receipt);
      return true;
    } catch {
      return false;
    }
  }

  async create(params: CreateDeliveryReceiptParams): Promise<DeliveryReceipt> {
    this.assertIdentity(params.message_id, 'message_id');
    this.assertIdentity(params.recipient, 'recipient');
    this.assertIdentity(params.actor, 'actor');
    if (params.evidence !== undefined) assertEvidence(params.evidence);
    if (params.note !== undefined) assertNote(params.note);

    const receiptPath = this.getReceiptPath(params.message_id, params.recipient);
    const lockName = this.getLockName(params.message_id, params.recipient);

    return this.lockManager.withLock(lockName, async () => {
      const existing = this.readReceipt(receiptPath);
      if (existing) return cloneReceipt(existing);

      const at = normalizeTimestamp(params.at);
      const draft: Omit<DeliveryTransition, 'hash'> = {
        sequence: 1,
        from: null,
        to: 'created',
        actor: params.actor,
        at,
        ...(params.evidence ? { evidence: params.evidence } : {}),
        ...(params.note ? { note: params.note } : {}),
        previous_hash: null,
      };
      const transition: DeliveryTransition = {
        ...draft,
        hash: DeliveryLedger.computeTransitionHash(params.message_id, params.recipient, draft),
      };
      const receipt: DeliveryReceipt = {
        version: DELIVERY_RECEIPT_VERSION,
        message_id: params.message_id,
        recipient: params.recipient,
        current_state: 'created',
        created_at: at,
        updated_at: at,
        chain_hash: transition.hash,
        transitions: [transition],
      };

      this.writeReceipt(receiptPath, receipt);
      return cloneReceipt(receipt);
    });
  }

  async transition(params: TransitionDeliveryParams): Promise<DeliveryReceipt> {
    this.assertIdentity(params.message_id, 'message_id');
    this.assertIdentity(params.recipient, 'recipient');
    this.assertIdentity(params.actor, 'actor');
    this.assertState(params.to);
    if (params.evidence !== undefined) assertEvidence(params.evidence);
    if (params.note !== undefined) assertNote(params.note);

    const receiptPath = this.getReceiptPath(params.message_id, params.recipient);
    const lockName = this.getLockName(params.message_id, params.recipient);

    return this.lockManager.withLock(lockName, async () => {
      const receipt = this.readReceipt(receiptPath);
      if (!receipt) {
        throw new Error(
          `No delivery receipt exists for message "${params.message_id}" and recipient "${params.recipient}"`
        );
      }

      if (receipt.current_state === params.to) {
        return cloneReceipt(receipt);
      }

      if (!DeliveryLedger.canTransition(receipt.current_state, params.to)) {
        throw new Error(
          `Invalid delivery transition ${receipt.current_state} -> ${params.to} for message "${params.message_id}"`
        );
      }

      const at = normalizeTimestamp(params.at);
      if (Date.parse(at) < Date.parse(receipt.updated_at)) {
        throw new Error('Delivery transition timestamp must not move backward');
      }

      const previousHash = receipt.chain_hash;
      const draft: Omit<DeliveryTransition, 'hash'> = {
        sequence: receipt.transitions.length + 1,
        from: receipt.current_state,
        to: params.to,
        actor: params.actor,
        at,
        ...(params.evidence ? { evidence: params.evidence } : {}),
        ...(params.note ? { note: params.note } : {}),
        previous_hash: previousHash,
      };
      const transition: DeliveryTransition = {
        ...draft,
        hash: DeliveryLedger.computeTransitionHash(params.message_id, params.recipient, draft),
      };

      receipt.current_state = params.to;
      receipt.updated_at = at;
      receipt.chain_hash = transition.hash;
      receipt.transitions.push(transition);

      this.writeReceipt(receiptPath, receipt);
      return cloneReceipt(receipt);
    });
  }

  get(messageId: string, recipient: string): DeliveryReceipt | null {
    this.assertIdentity(messageId, 'message_id');
    this.assertIdentity(recipient, 'recipient');
    const receipt = this.readReceipt(this.getReceiptPath(messageId, recipient));
    return receipt ? cloneReceipt(receipt) : null;
  }

  list(messageId?: string): DeliveryReceipt[] {
    if (messageId !== undefined) this.assertIdentity(messageId, 'message_id');
    const messageDirs = messageId
      ? [path.join(this.receiptsDir, this.digest(messageId))]
      : fs
          .readdirSync(this.receiptsDir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory())
          .map((entry) => path.join(this.receiptsDir, entry.name));

    const receipts: DeliveryReceipt[] = [];
    for (const dir of messageDirs) {
      if (!fs.existsSync(dir)) continue;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
        const receipt = this.readReceipt(path.join(dir, entry.name));
        if (receipt && (messageId === undefined || receipt.message_id === messageId)) {
          receipts.push(cloneReceipt(receipt));
        }
      }
    }

    return receipts.sort((left, right) =>
      `${left.message_id}\u0000${left.recipient}`.localeCompare(`${right.message_id}\u0000${right.recipient}`)
    );
  }

  private static assertReceipt(receipt: unknown): asserts receipt is DeliveryReceipt {
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
      throw new Error('Delivery receipt must be an object');
    }
    const candidate = receipt as Partial<DeliveryReceipt>;
    if (candidate.version !== DELIVERY_RECEIPT_VERSION) {
      throw new Error(`Unsupported delivery receipt version: ${String(candidate.version)}`);
    }
    assertText(candidate.message_id, 'receipt.message_id', 512);
    assertText(candidate.recipient, 'receipt.recipient', 512);
    if (!candidate.current_state || !STATE_SET.has(candidate.current_state)) {
      throw new Error('receipt.current_state is invalid');
    }
    assertText(candidate.created_at, 'receipt.created_at', 64);
    assertText(candidate.updated_at, 'receipt.updated_at', 64);
    if (Number.isNaN(Date.parse(candidate.created_at)) || Number.isNaN(Date.parse(candidate.updated_at))) {
      throw new Error('Delivery receipt timestamps are invalid');
    }
    if (!candidate.chain_hash || !/^[a-f0-9]{64}$/.test(candidate.chain_hash)) {
      throw new Error('receipt.chain_hash is invalid');
    }
    if (!Array.isArray(candidate.transitions) || candidate.transitions.length === 0) {
      throw new Error('receipt.transitions must be a non-empty array');
    }

    let priorState: DeliveryState | null = null;
    let priorHash: string | null = null;
    for (let index = 0; index < candidate.transitions.length; index += 1) {
      const transition = candidate.transitions[index] as DeliveryTransition;
      if (!transition || typeof transition !== 'object') {
        throw new Error(`receipt.transitions[${index}] is invalid`);
      }
      if (transition.sequence !== index + 1) {
        throw new Error('Delivery transition sequence is not contiguous');
      }
      if (transition.from !== priorState) {
        throw new Error('Delivery transition predecessor does not match the prior state');
      }
      if (!STATE_SET.has(transition.to)) {
        throw new Error('Delivery transition target state is invalid');
      }
      if (index === 0 && transition.to !== 'created') {
        throw new Error('The first delivery transition must create the receipt');
      }
      if (index > 0 && (!priorState || !ALLOWED_TRANSITIONS[priorState].includes(transition.to))) {
        throw new Error(`Stored delivery transition ${String(priorState)} -> ${transition.to} is invalid`);
      }
      assertText(transition.actor, 'transition.actor', 512);
      assertText(transition.at, 'transition.at', 64);
      if (Number.isNaN(Date.parse(transition.at))) {
        throw new Error('Delivery transition timestamp is invalid');
      }
      if (transition.evidence !== undefined) assertEvidence(transition.evidence);
      if (transition.note !== undefined) assertNote(transition.note);
      if (transition.previous_hash !== priorHash) {
        throw new Error('Delivery transition hash chain predecessor is invalid');
      }
      if (!/^[a-f0-9]{64}$/.test(transition.hash)) {
        throw new Error('Delivery transition hash is invalid');
      }
      const { hash: _hash, ...draft } = transition;
      const expectedHash = DeliveryLedger.computeTransitionHash(
        candidate.message_id,
        candidate.recipient,
        draft
      );
      if (expectedHash !== transition.hash) {
        throw new Error('Delivery transition hash mismatch');
      }
      priorState = transition.to;
      priorHash = transition.hash;
    }

    if (candidate.current_state !== priorState || candidate.chain_hash !== priorHash) {
      throw new Error('Delivery receipt head does not match its transition chain');
    }
    if (candidate.created_at !== candidate.transitions[0].at) {
      throw new Error('receipt.created_at does not match the first transition');
    }
    if (candidate.updated_at !== candidate.transitions[candidate.transitions.length - 1].at) {
      throw new Error('receipt.updated_at does not match the final transition');
    }
  }

  private assertIdentity(value: unknown, field: string): asserts value is string {
    assertText(value, field, 512);
  }

  private assertState(value: unknown): asserts value is DeliveryState {
    if (typeof value !== 'string' || !STATE_SET.has(value)) {
      throw new Error(`Delivery state must be one of: ${DELIVERY_STATES.join(', ')}`);
    }
  }

  private digest(value: string): string {
    return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
  }

  private getReceiptPath(messageId: string, recipient: string): string {
    const dir = path.join(this.receiptsDir, this.digest(messageId));
    fs.mkdirSync(dir, { recursive: true });
    return path.join(dir, `${this.digest(recipient)}.json`);
  }

  private getLockName(messageId: string, recipient: string): string {
    return `delivery_${this.digest(messageId)}_${this.digest(recipient)}`;
  }

  private readReceipt(receiptPath: string): DeliveryReceipt | null {
    if (!fs.existsSync(receiptPath)) return null;
    const parsed: unknown = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    DeliveryLedger.assertReceipt(parsed);
    return parsed;
  }

  private writeReceipt(receiptPath: string, receipt: DeliveryReceipt): void {
    DeliveryLedger.assertReceipt(receipt);
    const temporaryPath = `${receiptPath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(receipt, null, 2), { encoding: 'utf8', mode: 0o600 });
    try {
      fs.renameSync(temporaryPath, receiptPath);
    } finally {
      if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true });
    }
  }
}
