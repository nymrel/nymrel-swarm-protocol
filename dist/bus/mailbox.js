"use strict";
/**
 * @nymrel/swarm-protocol - File-Based Mailbox Manager & Event Stream
 * Copyright (c) 2026 Nymrel / JalenBuilds LLC. Licensed under the MIT License.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.FileMailboxManager = void 0;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const crypto = __importStar(require("node:crypto"));
const envelope_1 = require("./envelope");
const lock_1 = require("../fencing/lock");
class FileMailboxManager {
    rootDir;
    mailboxesDir;
    broadcastsDir;
    eventsFile;
    lockManager;
    constructor(swarmRoot) {
        this.rootDir = swarmRoot;
        this.mailboxesDir = path.join(swarmRoot, 'mailboxes');
        this.broadcastsDir = path.join(swarmRoot, 'broadcasts');
        this.eventsFile = path.join(swarmRoot, 'events.jsonl');
        this.lockManager = new lock_1.AtomicLockManager(swarmRoot);
        this.ensureDir(this.rootDir);
        this.ensureDir(this.mailboxesDir);
        this.ensureDir(this.broadcastsDir);
    }
    ensureDir(dirPath) {
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
        }
    }
    getAgentInbox(agentId) {
        const dir = path.join(this.mailboxesDir, agentId, 'inbox');
        this.ensureDir(dir);
        return dir;
    }
    getAgentOutbox(agentId) {
        const dir = path.join(this.mailboxesDir, agentId, 'outbox');
        this.ensureDir(dir);
        return dir;
    }
    getAgentArchive(agentId) {
        const dir = path.join(this.mailboxesDir, agentId, 'archive');
        this.ensureDir(dir);
        return dir;
    }
    /**
     * Register an agent and ensure its mailbox directories are provisioned.
     */
    registerAgent(agentId) {
        this.getAgentInbox(agentId);
        this.getAgentOutbox(agentId);
        this.getAgentArchive(agentId);
    }
    /**
     * List all registered agent mailboxes.
     */
    listMailboxes() {
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
    async sendMessage(envelope) {
        if (!envelope_1.EnvelopeEngine.verify(envelope)) {
            throw new Error('Cannot send invalid Envelope v2: verification failed');
        }
        const { header } = envelope;
        const serialized = envelope_1.EnvelopeEngine.serialize(envelope);
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
        }
        else {
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
    async broadcast(sender, topic, payload, fencing) {
        const envelope = envelope_1.EnvelopeEngine.create({
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
    async receiveMessages(agentId, options = {}) {
        const inbox = this.getAgentInbox(agentId);
        const files = fs.readdirSync(inbox).filter(f => f.endsWith('.json'));
        const limit = options.limit ?? files.length;
        const selectedFiles = files.slice(0, limit);
        const messages = [];
        for (const file of selectedFiles) {
            const filePath = path.join(inbox, file);
            try {
                const raw = fs.readFileSync(filePath, 'utf-8');
                const envelope = envelope_1.EnvelopeEngine.deserialize(raw);
                messages.push(envelope);
                if (options.autoAcknowledge) {
                    await this.acknowledgeMessage(agentId, envelope.header.id);
                }
            }
            catch (err) {
                // Skip or quarantine corrupted files
            }
        }
        return messages;
    }
    /**
     * Acknowledge and move a message from inbox to archive.
     */
    async acknowledgeMessage(agentId, messageId) {
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
    async recordEvent(event) {
        await this.lockManager.withLock('events_log', async () => {
            const line = JSON.stringify(event) + '\n';
            fs.appendFileSync(this.eventsFile, line, 'utf-8');
        });
    }
    /**
     * Read the latest events from the global event stream.
     */
    async readEventStream(limit = 100) {
        if (!fs.existsSync(this.eventsFile)) {
            return [];
        }
        const content = fs.readFileSync(this.eventsFile, 'utf-8');
        const lines = content.trim().split('\n').filter(Boolean);
        const events = [];
        const startIdx = Math.max(0, lines.length - limit);
        for (let i = startIdx; i < lines.length; i++) {
            try {
                events.push(JSON.parse(lines[i]));
            }
            catch {
                // Ignore corrupted lines
            }
        }
        return events;
    }
}
exports.FileMailboxManager = FileMailboxManager;
//# sourceMappingURL=mailbox.js.map