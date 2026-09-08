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

export const DELIVERY_REASON_CODES = [
  'local_persistence_failed',
  'recipient_evidence_reconciled',
  'transport_result_ambiguous',
  'explicit_reconciliation',
  'deadline_expired',
  'delivery_dead_lettered',
  'authority_revoked',
  'recipient_rejected',
] as const;

export type DeliveryReasonCode = (typeof DELIVERY_REASON_CODES)[number];

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
  reason_code?: DeliveryReasonCode;
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
  reason_code?: DeliveryReasonCode;
}

export interface TransitionDeliveryParams {
  message_id: string;
  recipient: string;
  to: DeliveryState;
  actor: string;
  at?: string;
  evidence?: DeliveryEvidence;
  reason_code?: DeliveryReasonCode;
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
  delivered: ['observed', 'expired', 'dead_lettered', 'revoked'],
  observed: ['acted', 'revoked'],
  acted: ['verified', 'revoked'],
  delivery_unknown: ['routed', 'deferred', 'delivered', 'observed', 'expired', 'dead_lettered', 'revoked'],
  verified: [],
  expired: [],
  dead_lettered: [],
  revoked: [],
  rejected: [],
};

const STATE_SET = new Set<string>(DELIVERY_STATES);
const EVIDENCE_KIND_SET = new Set<string>(DELIVERY_EVIDENCE_KINDS);
const REASON_CODE_SET = new Set<string>(DELIVERY_REASON_CODES);
const EVIDENCE_KEYS = new Set(['kind', 'reference', 'sha256']);
const TRANSITION_KEYS = new Set([
  'sequence',
  'from',
  'to',
  'actor',
  'at',
  'evidence',
  'reason_code',
  'previous_hash',
  'hash',
]);
const RECEIPT_KEYS = new Set([
  'version',
  'message_id',
  'recipient',
  'current_state',
  'created_at',
  'updated_at',
  'chain_hash',
  'transitions',
]);

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

function assertClosedObject(value: object, allowed: ReadonlySet<string>, field: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new Error(`${field} field "${key}" is not allowed`);
    }
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

function assertCanonicalTimestamp(value: unknown, field: string): number {
  assertText(value, field, 64);
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new Error(`${field} must be a canonical UTC timestamp`);
  }
  return timestamp;
}

function assertEvidence(evidence: unknown): asserts evidence is DeliveryEvidence {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)) {
    throw new Error('evidence must be an object');
  }
  assertClosedObject(evidence, EVIDENCE_KEYS, 'evidence');

  const candidate = evidence as Partial<DeliveryEvidence>;
  if (!candidate.kind || !EVIDENCE_KIND_SET.has(candidate.kind)) {
    throw new Error(`evidence.kind must be one of: ${DELIVERY_EVIDENCE_KINDS.join(', ')}`);
  }
  assertText(candidate.reference, 'evidence.reference', 2048);

  if (candidate.sha256 !== undefined && !/^[a-f0-9]{64}$/.test(candidate.sha256)) {
    throw new Error('evidence.sha256 must be a lowercase 64-character SHA-256 digest');
  }
}

function assertReasonCode(reasonCode: unknown): asserts reasonCode is DeliveryReasonCode {
  if (typeof reasonCode !== 'string' || !REASON_CODE_SET.has(reasonCode)) {
    throw new Error(`reason_code must be one of: ${DELIVERY_REASON_CODES.join(', ')}`);
  }
}

function matchesEvidence(
  left: DeliveryEvidence | undefined,
  right: DeliveryEvidence | undefined
): boolean {
  return left?.kind === right?.kind
    && left?.reference === right?.reference
    && left?.sha256 === right?.sha256;
}

function encodeField(value: string | null | undefined): string {
  const normalized = value ?? '';
  return `${Buffer.byteLength(normalized, 'utf8')}:${normalized}`;
}

export class DeliveryReceiptConflictError extends Error {}

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
    return STATE_SET.has(state) && TERMINAL_STATES.has(state);
  }

  static canTransition(from: DeliveryState, to: DeliveryState): boolean {
    if (!STATE_SET.has(from) || !STATE_SET.has(to)) return false;
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
      transition.reason_code,
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
    if (params.reason_code !== undefined) assertReasonCode(params.reason_code);

    const receiptPath = this.getReceiptPath(params.message_id, params.recipient, true);
    const lockName = this.getLockName(params.message_id, params.recipient);

    return this.lockManager.withLock(lockName, async () => {
      const existing = this.readReceipt(receiptPath);
      if (existing) {
        const creation = existing.transitions[0];
        const requestedEvidence = params.evidence;
        const sameEvidence =
          creation.evidence?.kind === requestedEvidence?.kind &&
          creation.evidence?.reference === requestedEvidence?.reference &&
          creation.evidence?.sha256 === requestedEvidence?.sha256;
        const requestedAtMatches =
          params.at === undefined || creation.at === normalizeTimestamp(params.at);
        if (
          creation.actor !== params.actor ||
          !sameEvidence ||
          creation.reason_code !== params.reason_code ||
          !requestedAtMatches
        ) {
          throw new DeliveryReceiptConflictError(
            'Delivery receipt already exists with a different creation contract'
          );
        }
        return cloneReceipt(existing);
      }

      const at = normalizeTimestamp(params.at);
      const draft: Omit<DeliveryTransition, 'hash'> = {
        sequence: 1,
        from: null,
        to: 'created',
        actor: params.actor,
        at,
        ...(params.evidence ? { evidence: params.evidence } : {}),
        ...(params.reason_code ? { reason_code: params.reason_code } : {}),
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
    if (params.reason_code !== undefined) assertReasonCode(params.reason_code);

    const receiptPath = this.getReceiptPath(params.message_id, params.recipient, false);
    const lockName = this.getLockName(params.message_id, params.recipient);

    return this.lockManager.withLock(lockName, async () => {
      const receipt = this.readReceipt(receiptPath);
      if (!receipt) {
        throw new Error(
          `No delivery receipt exists for message "${params.message_id}" and recipient "${params.recipient}"`
        );
      }

      if (receipt.current_state === params.to) {
        const prior = receipt.transitions.at(-1);
        if (!prior
          || prior.actor !== params.actor
          || !matchesEvidence(prior.evidence, params.evidence)
          || prior.reason_code !== params.reason_code) {
          throw new Error(
            `Conflicting same-state retry for message "${params.message_id}" and recipient "${params.recipient}"`
          );
        }
        if (params.at !== undefined && normalizeTimestamp(params.at) !== prior.at) {
          throw new Error('Conflicting same-state retry timestamp');
        }
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
        ...(params.reason_code ? { reason_code: params.reason_code } : {}),
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
    const receipt = this.readReceipt(this.getReceiptPath(messageId, recipient, false));
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
    assertClosedObject(receipt, RECEIPT_KEYS, 'receipt');

    const candidate = receipt as Partial<DeliveryReceipt>;
    if (candidate.version !== DELIVERY_RECEIPT_VERSION) {
      throw new Error(`Unsupported delivery receipt version: ${String(candidate.version)}`);
    }
    assertText(candidate.message_id, 'receipt.message_id', 512);
    assertText(candidate.recipient, 'receipt.recipient', 512);
    if (!candidate.current_state || !STATE_SET.has(candidate.current_state)) {
      throw new Error('receipt.current_state is invalid');
    }
    const createdAt = assertCanonicalTimestamp(candidate.created_at, 'receipt.created_at');
    const updatedAt = assertCanonicalTimestamp(candidate.updated_at, 'receipt.updated_at');
    if (updatedAt < createdAt) {
      throw new Error('receipt.updated_at must not precede receipt.created_at');
    }
    if (!candidate.chain_hash || !/^[a-f0-9]{64}$/.test(candidate.chain_hash)) {
      throw new Error('receipt.chain_hash is invalid');
    }
    if (!Array.isArray(candidate.transitions) || candidate.transitions.length === 0) {
      throw new Error('receipt.transitions must be a non-empty array');
    }

    let priorState: DeliveryState | null = null;
    let priorHash: string | null = null;
    let priorTimestamp = -Infinity;
    for (let index = 0; index < candidate.transitions.length; index += 1) {
      const transition = candidate.transitions[index] as DeliveryTransition;
      if (!transition || typeof transition !== 'object' || Array.isArray(transition)) {
        throw new Error(`receipt.transitions[${index}] is invalid`);
      }
      assertClosedObject(transition, TRANSITION_KEYS, `receipt.transitions[${index}]`);
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
      const transitionAt = assertCanonicalTimestamp(transition.at, 'transition.at');
      if (transitionAt < priorTimestamp) {
        throw new Error('Delivery transition timestamps must not move backward');
      }
      if (transition.evidence !== undefined) assertEvidence(transition.evidence);
      if (transition.reason_code !== undefined) assertReasonCode(transition.reason_code);
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
      priorTimestamp = transitionAt;
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

  private getReceiptPath(messageId: string, recipient: string, createParent: boolean): string {
    const dir = path.join(this.receiptsDir, this.digest(messageId));
    if (createParent) fs.mkdirSync(dir, { recursive: true });
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
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
      fs.writeFileSync(descriptor, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temporaryPath, receiptPath);
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true });
    }
  }
}
