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
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
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

  private async createDeliveryReceipt(messageId: string, recipient: string, sender: string): Promise<void> {
    await this.deliveryLedger.create({
      message_id: messageId,
      recipient,
      actor: sender,
      evidence: {
        kind: 'receipt_created',
        reference: `envelope://${this.logicalSegment(messageId)}`,
      },
    });
  }

  private async markDeliveryFailure(messageId: string, recipient: string): Promise<void> {
    const receipt = this.deliveryLedger.get(messageId, recipient);
    if (!receipt || DeliveryLedger.isTerminal(receipt.current_state)) {
      return;
    }

    const target: DeliveryState = receipt.current_state === 'created' ? 'rejected' : 'delivery_unknown';
    if (!DeliveryLedger.canTransition(receipt.current_state, target)) {
      return;
    }

    await this.deliveryLedger.transition({
      message_id: messageId,
      recipient,
      to: target,
      actor: 'nymrel-mesh',
      evidence: {
        kind: 'reconciliation',
        reference: `delivery://${this.logicalSegment(messageId)}/${this.logicalSegment(recipient)}/failure`,
      },
      note: 'A required local persistence step failed; the delivery result was not inferred.',
    });
  }

  private async markObserved<T>(agentId: string, envelope: EnvelopeV2<T>): Promise<void> {
    let receipt = this.deliveryLedger.get(envelope.header.id, agentId);
    if (!receipt) {
      return; // Legacy message written before delivery receipts existed.
    }

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
        note: 'Recipient-side mailbox evidence reconciled an interrupted sender-side transition.',
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

  /**
   * Register an agent and ensure its mailbox directories are provisioned.
   */
  registerAgent(agentId: string): void {
    this.getAgentInbox(agentId);
    this.getAgentOutbox(agentId);
    this.getAgentArchive(agentId);
  }

  /**
   * List all registered agent mailboxes.
   */
  listMailboxes(): string[] {
    if (!fs.existsSync(this.mailboxesDir)) {
      return [];
    }
    return fs.readdirSync(this.mailboxesDir, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory())
      .map(dirent => dirent.name);
  }

  /** Read the recipient-specific delivery receipt for one message. */
  getDeliveryReceipt(messageId: string, recipient: string): DeliveryReceipt | null {
    return this.deliveryLedger.get(messageId, recipient);
  }

  /** List delivery receipts, optionally scoped to one message. */
  listDeliveryReceipts(messageId?: string): DeliveryReceipt[] {
    return this.deliveryLedger.list(messageId);
  }

  /**
   * Send an Envelope v2 to a target agent or broadcast.
   *
   * A successful return proves mailbox persistence (`delivered`), not that the
   * recipient runtime observed or acted on the message.
   */
  async sendMessage<T = Record<string, unknown>>(envelope: EnvelopeV2<T>): Promise<string> {
    if (!EnvelopeEngine.verify(envelope)) {
      throw new Error('Cannot send invalid Envelope v2: verification failed');
    }

    const { header } = envelope;
    const serialized = EnvelopeEngine.serialize(envelope);
    const contentDigest = this.digest(serialized);
    const filename = `${header.id}.json`;
    const isBroadcast = header.recipient === 'broadcast' || header.recipient === 'all';
    const recipients = isBroadcast
      ? this.listMailboxes().filter(agent => agent !== header.sender)
      : [header.recipient];

    for (const recipient of recipients) {
      await this.createDeliveryReceipt(header.id, recipient, header.sender);
    }

    const senderOutbox = this.getAgentOutbox(header.sender);
    const outboxPath = path.join(senderOutbox, filename);
    try {
      fs.writeFileSync(outboxPath, serialized, 'utf-8');
      for (const recipient of recipients) {
        await this.deliveryLedger.transition({
          message_id: header.id,
          recipient,
          to: 'accepted',
          actor: header.sender,
          evidence: {
            kind: 'outbox_persisted',
            reference: `mailbox://${this.logicalSegment(header.sender)}/outbox/${this.logicalSegment(header.id)}`,
            sha256: contentDigest,
          },
        });
      }
    } catch (error) {
      for (const recipient of recipients) {
        await this.markDeliveryFailure(header.id, recipient);
      }
      throw error;
    }

    if (isBroadcast) {
      try {
        fs.writeFileSync(path.join(this.broadcastsDir, filename), serialized, 'utf-8');
      } catch (error) {
        for (const recipient of recipients) {
          await this.markDeliveryFailure(header.id, recipient);
        }
        throw error;
      }
    }

    const failedRecipients: string[] = [];
    for (const recipient of recipients) {
      try {
        await this.deliveryLedger.transition({
          message_id: header.id,
          recipient,
          to: 'routed',
          actor: 'nymrel-mesh',
          evidence: {
            kind: 'route_selected',
            reference: `mailbox://${this.logicalSegment(recipient)}`,
          },
        });

        const inbox = this.getAgentInbox(recipient);
        fs.writeFileSync(path.join(inbox, filename), serialized, 'utf-8');

        await this.deliveryLedger.transition({
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
      } catch {
        failedRecipients.push(recipient);
        await this.markDeliveryFailure(header.id, recipient);
      }
    }

    if (failedRecipients.length > 0) {
      throw new Error(`Message delivery was not confirmed for ${failedRecipients.length} recipient(s)`);
    }

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

    return header.id;
  }

  /**
   * Convenience helper to broadcast a message.
   */
  async broadcast<T = Record<string, unknown>>(
    sender: string,
    topic: string,
    payload: T,
    fencing?: FencingToken
  ): Promise<EnvelopeV2<T>> {
    const envelope = EnvelopeEngine.create<T>({
      sender,
      recipient: 'broadcast',
      topic,
      payload,
      fencing,
    });
    await this.sendMessage(envelope);
    return envelope;
  }

  /**
   * Receive unread messages from an agent's inbox.
   *
   * Only a successfully parsed message advances to `observed`; corrupt content
   * is skipped and cannot manufacture recipient-side evidence.
   */
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

      if (options.autoAcknowledge) {
        await this.acknowledgeMessage(agentId, envelope.header.id);
      }
    }

    return messages;
  }

  /**
   * Acknowledge and move a message from inbox to archive.
   */
  async acknowledgeMessage(agentId: string, messageId: string): Promise<void> {
    const inbox = this.getAgentInbox(agentId);
    const archive = this.getAgentArchive(agentId);
    const filename = `${messageId}.json`;
    const src = path.join(inbox, filename);
    const dest = path.join(archive, filename);

    if (fs.existsSync(src)) {
      fs.renameSync(src, dest);
    }
  }

  /**
   * Append an event to the global event stream under atomic lock.
   */
  async recordEvent(event: BusEvent): Promise<void> {
    await this.lockManager.withLock('events_log', async () => {
      const line = JSON.stringify(event) + '\n';
      fs.appendFileSync(this.eventsFile, line, 'utf-8');
    });
  }

  /**
   * Read the latest events from the global event stream.
   */
  async readEventStream(limit = 100): Promise<BusEvent[]> {
    if (!fs.existsSync(this.eventsFile)) {
      return [];
    }

    const content = fs.readFileSync(this.eventsFile, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean);
    const events: BusEvent[] = [];

    const startIdx = Math.max(0, lines.length - limit);
    for (let i = startIdx; i < lines.length; i++) {
      try {
        events.push(JSON.parse(lines[i]));
      } catch {
        // Ignore corrupted lines
      }
    }

    return events;
  }
}
