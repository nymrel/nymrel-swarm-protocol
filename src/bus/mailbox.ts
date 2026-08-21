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

  constructor(swarmRoot: string) {
    this.rootDir = swarmRoot;
    this.mailboxesDir = path.join(swarmRoot, 'mailboxes');
    this.broadcastsDir = path.join(swarmRoot, 'broadcasts');
    this.eventsFile = path.join(swarmRoot, 'events.jsonl');
    this.lockManager = new AtomicLockManager(swarmRoot);

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

  /**
   * Send an Envelope v2 to a target agent or broadcast.
   */
  async sendMessage<T = Record<string, unknown>>(envelope: EnvelopeV2<T>): Promise<string> {
    if (!EnvelopeEngine.verify(envelope)) {
      throw new Error('Cannot send invalid Envelope v2: verification failed');
    }

    const { header } = envelope;
    const serialized = EnvelopeEngine.serialize(envelope);
    const filename = `${header.id}.json`;

    // 1. Record in sender's outbox
    const senderOutbox = this.getAgentOutbox(header.sender);
    const outboxPath = path.join(senderOutbox, filename);
    fs.writeFileSync(outboxPath, serialized, 'utf-8');

    // 2. Deliver to recipient(s)
    const isBroadcast = header.recipient === 'broadcast' || header.recipient === 'all';

    if (isBroadcast) {
      // Store in global broadcast spool
      const bcastPath = path.join(this.broadcastsDir, filename);
      fs.writeFileSync(bcastPath, serialized, 'utf-8');

      // Fan-out to all registered agents (excluding sender)
      const allAgents = this.listMailboxes();
      for (const agent of allAgents) {
        if (agent !== header.sender) {
          const inbox = this.getAgentInbox(agent);
          const targetPath = path.join(inbox, filename);
          fs.writeFileSync(targetPath, serialized, 'utf-8');
        }
      }

      await this.recordEvent({
        event_id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        event_type: 'message_broadcast',
        actor: header.sender,
        details: {
          message_id: header.id,
          topic: header.topic,
          recipients_count: allAgents.length - 1,
        },
      });
    } else {
      // Direct delivery
      const recipientInbox = this.getAgentInbox(header.recipient);
      const inboxPath = path.join(recipientInbox, filename);
      fs.writeFileSync(inboxPath, serialized, 'utf-8');

      await this.recordEvent({
        event_id: crypto.randomUUID(),
        timestamp: new Date().toISOString(),
        event_type: 'message_sent',
        actor: header.sender,
        details: {
          message_id: header.id,
          recipient: header.recipient,
          topic: header.topic,
        },
      });
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
      try {
        const raw = fs.readFileSync(filePath, 'utf-8');
        const envelope = EnvelopeEngine.deserialize<T>(raw);
        messages.push(envelope);

        if (options.autoAcknowledge) {
          await this.acknowledgeMessage(agentId, envelope.header.id);
        }
      } catch (err) {
        // Skip or quarantine corrupted files
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
