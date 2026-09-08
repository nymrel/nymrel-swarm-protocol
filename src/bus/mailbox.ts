/**
 * @nymrel/swarm-protocol - File-Based Mailbox Manager & Event Stream
 * Copyright (c) 2026 Nymrel / JalenBuilds LLC. Licensed under the MIT License.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { EnvelopeV2, BusEvent, FencingToken } from '../types';
import { EnvelopeEngine } from './envelope';
import { AtomicLockManager } from '../fencing/lock';
import { DeliveryLedger, DeliveryReceipt, DeliveryState } from '../delivery/delivery';

export class EnvelopeConflictError extends Error {}

export interface ReceiveOptions {
  limit?: number;
  autoAcknowledge?: boolean;
}

export class FileMailboxManager {
  private rootDir: string;
  private mailboxesDir: string;
  private broadcastsDir: string;
  private eventsFile: string;
  private lockManager: AtomicLockManager;
  private deliveryLedger: DeliveryLedger;

  constructor(swarmRoot: string) {
    this.rootDir = swarmRoot;
    this.mailboxesDir = path.join(swarmRoot, 'mailboxes');
    this.broadcastsDir = path.join(swarmRoot, 'broadcasts');
    this.eventsFile = path.join(swarmRoot, 'events.jsonl');
    this.lockManager = new AtomicLockManager(swarmRoot);
    this.deliveryLedger = new DeliveryLedger(swarmRoot);

    this.ensureDir(this.rootDir);
    this.ensureDir(this.mailboxesDir);
    this.ensureDir(this.broadcastsDir);
  }

  private ensureDir(dirPath: string): void {
    if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
  }

  private getAgentInbox(agentId: string): string {
    const dir = path.join(this.mailboxesDir, agentId, 'inbox');
    this.ensureDir(dir);
    return dir;
  }

  private getAgentOutbox(agentId: string): string {
    const dir = path.join(this.mailboxesDir, agentId, 'outbox');
    this.ensureDir(dir);
    return dir;
  }

  private getAgentArchive(agentId: string): string {
    const dir = path.join(this.mailboxesDir, agentId, 'archive');
    this.ensureDir(dir);
    return dir;
  }

  private digest(value: string): string {
    return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
  }

  private logicalSegment(value: string): string {
    return encodeURIComponent(value);
  }

  private writeEnvelopeFile(filePath: string, serialized: string): boolean {
    if (fs.existsSync(filePath)) {
      if (fs.readFileSync(filePath, 'utf8') !== serialized) {
        throw new EnvelopeConflictError('Message id is already bound to different envelope bytes');
      }
      return false;
    }

    const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(temporaryPath, 'wx', 0o600);
      fs.writeFileSync(descriptor, serialized, 'utf8');
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;

      if (fs.existsSync(filePath)) {
        if (fs.readFileSync(filePath, 'utf8') !== serialized) {
          throw new EnvelopeConflictError('Message id is already bound to different envelope bytes');
        }
        return false;
      }

      fs.renameSync(temporaryPath, filePath);
      return true;
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true });
    }
  }

  private resolveRecipients<T>(envelope: EnvelopeV2<T>, isBroadcast: boolean): string[] {
    const existing = this.deliveryLedger.list(envelope.header.id);
    if (isBroadcast) {
      if (existing.length > 0) {
        return existing.map((receipt) => receipt.recipient);
      }
      const recipients = this.listMailboxes()
        .filter((agent) => agent !== envelope.header.sender)
        .sort();
      if (recipients.length === 0) {
        throw new EnvelopeConflictError('Broadcast requires at least one registered recipient');
      }
      return recipients;
    }

    if (existing.some((receipt) => receipt.recipient !== envelope.header.recipient)) {
      throw new EnvelopeConflictError('Message id is already bound to a different recipient set');
    }
    return [envelope.header.recipient];
  }

  private async createDeliveryReceipt(
    messageId: string,
    recipient: string,
    sender: string,
    envelopeSha256: string
  ): Promise<void> {
    await this.deliveryLedger.create({
      message_id: messageId,
      recipient,
      actor: sender,
      evidence: {
        kind: 'receipt_created',
        reference: `envelope://${this.logicalSegment(messageId)}`,
        sha256: envelopeSha256,
      },
    });
  }

  private async markDeliveryFailure(messageId: string, recipient: string): Promise<void> {
    const receipt = this.deliveryLedger.get(messageId, recipient);
    if (!receipt || DeliveryLedger.isTerminal(receipt.current_state)) return;
    if (!['created', 'accepted', 'routed', 'deferred'].includes(receipt.current_state)) return;

    const target: DeliveryState = receipt.current_state === 'created' ? 'rejected' : 'delivery_unknown';
    await this.deliveryLedger.transition({
      message_id: messageId,
      recipient,
      to: target,
      actor: 'nymrel-mesh',
      evidence: {
        kind: 'reconciliation',
        reference: `delivery://${this.logicalSegment(messageId)}/${this.logicalSegment(recipient)}/failure`,
      },
      reason_code: 'local_persistence_failed',
    });
  }

  private async markObserved<T>(agentId: string, envelope: EnvelopeV2<T>): Promise<void> {
    let receipt = this.deliveryLedger.get(envelope.header.id, agentId);
    if (!receipt) return; // Legacy message written before delivery receipts existed.

    const evidence = {
      kind: 'runtime_observed' as const,
      reference: `mailbox://${this.logicalSegment(agentId)}/inbox/${this.logicalSegment(envelope.header.id)}`,
      sha256: this.digest(EnvelopeEngine.serialize(envelope)),
    };

    if (receipt.current_state === 'created') {
      receipt = await this.deliveryLedger.transition({
        message_id: envelope.header.id,
        recipient: agentId,
        to: 'accepted',
        actor: 'nymrel-mesh-reconciler',
        evidence: { kind: 'reconciliation', reference: evidence.reference, sha256: evidence.sha256 },
        reason_code: 'recipient_evidence_reconciled',
      });
    }
    if (receipt.current_state === 'accepted' || receipt.current_state === 'deferred') {
      receipt = await this.deliveryLedger.transition({
        message_id: envelope.header.id,
        recipient: agentId,
        to: 'routed',
        actor: 'nymrel-mesh-reconciler',
        evidence: { kind: 'reconciliation', reference: evidence.reference, sha256: evidence.sha256 },
      });
    }
    if (receipt.current_state === 'routed') {
      receipt = await this.deliveryLedger.transition({
        message_id: envelope.header.id,
        recipient: agentId,
        to: 'delivered',
        actor: 'nymrel-mesh-reconciler',
        evidence: { kind: 'mailbox_persisted', reference: evidence.reference, sha256: evidence.sha256 },
      });
    }
    if (receipt.current_state === 'delivered' || receipt.current_state === 'delivery_unknown') {
      await this.deliveryLedger.transition({
        message_id: envelope.header.id,
        recipient: agentId,
        to: 'observed',
        actor: agentId,
        evidence,
      });
      return;
    }
    if (receipt.current_state === 'observed' || receipt.current_state === 'acted' || receipt.current_state === 'verified') {
      return;
    }
    throw new Error(
      `Delivery receipt is terminal at ${receipt.current_state}, but message "${envelope.header.id}" exists in recipient inbox`
    );
  }

  registerAgent(agentId: string): void {
    this.getAgentInbox(agentId);
    this.getAgentOutbox(agentId);
    this.getAgentArchive(agentId);
  }

  listMailboxes(): string[] {
    if (!fs.existsSync(this.mailboxesDir)) return [];
    return fs.readdirSync(this.mailboxesDir, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory())
      .map(dirent => dirent.name);
  }

  getDeliveryReceipt(messageId: string, recipient: string): DeliveryReceipt | null {
    return this.deliveryLedger.get(messageId, recipient);
  }

  listDeliveryReceipts(messageId?: string): DeliveryReceipt[] {
    return this.deliveryLedger.list(messageId);
  }

  async sendMessage<T = Record<string, unknown>>(envelope: EnvelopeV2<T>): Promise<string> {
    if (!EnvelopeEngine.verify(envelope)) {
      throw new Error('Cannot send invalid Envelope v2: verification failed');
    }

    const { header } = envelope;
    const serialized = EnvelopeEngine.serialize(envelope);
    const contentDigest = this.digest(serialized);
    const filename = `${header.id}.json`;
    const isBroadcast = header.recipient === 'broadcast' || header.recipient === 'all';

    return this.lockManager.withLock(`message_send_${this.digest(header.id)}`, async () => {
      let changed = false;
      const recipients = this.resolveRecipients(envelope, isBroadcast);
      for (const recipient of recipients) {
        await this.createDeliveryReceipt(header.id, recipient, header.sender, contentDigest);
      }

      const outboxReference =
        `mailbox://${this.logicalSegment(header.sender)}/outbox/${this.logicalSegment(header.id)}`;
      const senderOutbox = this.getAgentOutbox(header.sender);
      const outboxPath = path.join(senderOutbox, filename);
      try {
        changed = this.writeEnvelopeFile(outboxPath, serialized) || changed;
        for (const recipient of recipients) {
          const receipt = this.deliveryLedger.get(header.id, recipient);
          if (receipt?.current_state === 'created') {
            await this.deliveryLedger.transition({
              message_id: header.id,
              recipient,
              to: 'accepted',
              actor: header.sender,
              evidence: {
                kind: 'outbox_persisted',
                reference: outboxReference,
                sha256: contentDigest,
              },
            });
            changed = true;
          }
        }
      } catch (error) {
        if (!(error instanceof EnvelopeConflictError)) {
          for (const recipient of recipients) {
            await this.markDeliveryFailure(header.id, recipient);
          }
        }
        throw error;
      }

      if (isBroadcast) {
        try {
          changed = this.writeEnvelopeFile(path.join(this.broadcastsDir, filename), serialized) || changed;
        } catch (error) {
          if (!(error instanceof EnvelopeConflictError)) {
            for (const recipient of recipients) {
              await this.markDeliveryFailure(header.id, recipient);
            }
          }
          throw error;
        }
      }

      const failedRecipients: string[] = [];
      let firstFailure: unknown;
      for (const recipient of recipients) {
        try {
          let receipt = this.deliveryLedger.get(header.id, recipient);
          if (!receipt) {
            throw new Error('Delivery receipt disappeared during send');
          }

          if (
            receipt.current_state === 'accepted' ||
            receipt.current_state === 'deferred' ||
            receipt.current_state === 'delivery_unknown'
          ) {
            receipt = await this.deliveryLedger.transition({
              message_id: header.id,
              recipient,
              to: 'routed',
              actor: 'nymrel-mesh',
              evidence: {
                kind: receipt.current_state === 'delivery_unknown' ? 'reconciliation' : 'route_selected',
                reference: `mailbox://${this.logicalSegment(recipient)}`,
              },
            });
            changed = true;
          }

          const inbox = this.getAgentInbox(recipient);
          const inboxPath = path.join(inbox, filename);
          const archivePath = path.join(this.getAgentArchive(recipient), filename);

          if (receipt.current_state === 'routed') {
            this.writeEnvelopeFile(inboxPath, serialized);
            receipt = await this.deliveryLedger.transition({
              message_id: header.id,
              recipient,
              to: 'delivered',
              actor: 'nymrel-mesh',
              evidence: {
                kind: 'mailbox_persisted',
                reference: `mailbox://${this.logicalSegment(recipient)}/inbox/${this.logicalSegment(header.id)}`,
                sha256: contentDigest,
              },
            });
            changed = true;
          }

          if (
            receipt.current_state === 'delivered' ||
            receipt.current_state === 'observed' ||
            receipt.current_state === 'acted' ||
            receipt.current_state === 'verified'
          ) {
            const persistedPath = fs.existsSync(inboxPath) ? inboxPath : archivePath;
            if (!fs.existsSync(persistedPath)) {
              throw new Error('Delivery receipt claims persistence, but no recipient copy exists');
            }
            this.writeEnvelopeFile(persistedPath, serialized);
            continue;
          }

          throw new Error(`Message cannot be retried from terminal delivery state ${receipt.current_state}`);
        } catch (error) {
          failedRecipients.push(recipient);
          if (firstFailure === undefined) firstFailure = error;
          if (!(error instanceof EnvelopeConflictError)) {
            await this.markDeliveryFailure(header.id, recipient);
          }
        }
      }

      if (failedRecipients.length > 0) {
        if (firstFailure instanceof Error) throw firstFailure;
        throw new Error(`Message delivery was not confirmed for ${failedRecipients.length} recipient(s)`);
      }

      if (changed) {
        try {
          await this.recordEvent({
            event_id: crypto.randomUUID(),
            timestamp: new Date().toISOString(),
            event_type: isBroadcast ? 'message_broadcast' : 'message_sent',
            actor: header.sender,
            details: isBroadcast
              ? { message_id: header.id, topic: header.topic, recipients_count: recipients.length }
              : { message_id: header.id, recipient: header.recipient, topic: header.topic },
          });
        } catch {
          // Delivery truth is already persisted. An ancillary event-log failure
          // must not be reported as message-delivery failure.
        }
      }

      return header.id;
    });
  }

  async broadcast<T = Record<string, unknown>>(
    sender: string,
    topic: string,
    payload: T,
    fencing?: FencingToken
  ): Promise<EnvelopeV2<T>> {
    const envelope = EnvelopeEngine.create<T>({ sender, recipient: 'broadcast', topic, payload, fencing });
    await this.sendMessage(envelope);
    return envelope;
  }

  async receiveMessages<T = Record<string, unknown>>(
    agentId: string,
    options: ReceiveOptions = {}
  ): Promise<EnvelopeV2<T>[]> {
    const inbox = this.getAgentInbox(agentId);
    const files = fs.readdirSync(inbox).filter(f => f.endsWith('.json'));
    const limit = options.limit ?? files.length;
    const selectedFiles = files.slice(0, limit);
    const messages: EnvelopeV2<T>[] = [];

    for (const file of selectedFiles) {
      const filePath = path.join(inbox, file);
      let envelope: EnvelopeV2<T>;
      try {
        envelope = EnvelopeEngine.deserialize<T>(fs.readFileSync(filePath, 'utf-8'));
      } catch {
        continue; // Corrupt message content is not evidence of observation.
      }

      await this.markObserved(agentId, envelope);
      messages.push(envelope);
      if (options.autoAcknowledge) await this.acknowledgeMessage(agentId, envelope.header.id);
    }

    return messages;
  }

  async acknowledgeMessage(agentId: string, messageId: string): Promise<void> {
    const inbox = this.getAgentInbox(agentId);
    const archive = this.getAgentArchive(agentId);
    const filename = `${messageId}.json`;
    const src = path.join(inbox, filename);
    const dest = path.join(archive, filename);
    if (fs.existsSync(src)) fs.renameSync(src, dest);
  }

  async recordEvent(event: BusEvent): Promise<void> {
    await this.lockManager.withLock('events_log', async () => {
      fs.appendFileSync(this.eventsFile, JSON.stringify(event) + '\n', 'utf-8');
    });
  }

  async readEventStream(limit = 100): Promise<BusEvent[]> {
    if (!fs.existsSync(this.eventsFile)) return [];
    const lines = fs.readFileSync(this.eventsFile, 'utf-8').trim().split('\n').filter(Boolean);
    const events: BusEvent[] = [];
    for (let i = Math.max(0, lines.length - limit); i < lines.length; i++) {
      try { events.push(JSON.parse(lines[i])); } catch { /* Ignore corrupted event lines. */ }
    }
    return events;
  }
}
