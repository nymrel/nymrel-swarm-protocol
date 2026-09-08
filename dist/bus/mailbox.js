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
exports.FileMailboxManager = exports.EnvelopeConflictError = void 0;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const crypto = __importStar(require("node:crypto"));
const envelope_1 = require("./envelope");
const lock_1 = require("../fencing/lock");
const delivery_1 = require("../delivery/delivery");
class EnvelopeConflictError extends Error {
}
exports.EnvelopeConflictError = EnvelopeConflictError;
class FileMailboxManager {
    rootDir;
    mailboxesDir;
    broadcastsDir;
    eventsFile;
    lockManager;
    deliveryLedger;
    constructor(swarmRoot) {
        this.rootDir = swarmRoot;
        this.mailboxesDir = path.join(swarmRoot, 'mailboxes');
        this.broadcastsDir = path.join(swarmRoot, 'broadcasts');
        this.eventsFile = path.join(swarmRoot, 'events.jsonl');
        this.lockManager = new lock_1.AtomicLockManager(swarmRoot);
        this.deliveryLedger = new delivery_1.DeliveryLedger(swarmRoot);
        this.ensureDir(this.rootDir);
        this.ensureDir(this.mailboxesDir);
        this.ensureDir(this.broadcastsDir);
    }
    ensureDir(dirPath) {
        if (!fs.existsSync(dirPath))
            fs.mkdirSync(dirPath, { recursive: true });
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
    digest(value) {
        return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
    }
    logicalSegment(value) {
        return encodeURIComponent(value);
    }
    writeEnvelopeFile(filePath, serialized) {
        if (fs.existsSync(filePath)) {
            if (fs.readFileSync(filePath, 'utf8') !== serialized) {
                throw new EnvelopeConflictError('Message id is already bound to different envelope bytes');
            }
            return false;
        }
        const temporaryPath = `${filePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
        let descriptor;
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
        }
        finally {
            if (descriptor !== undefined)
                fs.closeSync(descriptor);
            if (fs.existsSync(temporaryPath))
                fs.rmSync(temporaryPath, { force: true });
        }
    }
    resolveRecipients(envelope, isBroadcast) {
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
    async createDeliveryReceipt(messageId, recipient, sender, envelopeSha256) {
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
    async markDeliveryFailure(messageId, recipient) {
        const receipt = this.deliveryLedger.get(messageId, recipient);
        if (!receipt || delivery_1.DeliveryLedger.isTerminal(receipt.current_state))
            return;
        if (!['created', 'accepted', 'routed', 'deferred'].includes(receipt.current_state))
            return;
        const target = receipt.current_state === 'created' ? 'rejected' : 'delivery_unknown';
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
    async markObserved(agentId, envelope) {
        let receipt = this.deliveryLedger.get(envelope.header.id, agentId);
        if (!receipt)
            return; // Legacy message written before delivery receipts existed.
        const evidence = {
            kind: 'runtime_observed',
            reference: `mailbox://${this.logicalSegment(agentId)}/inbox/${this.logicalSegment(envelope.header.id)}`,
            sha256: this.digest(envelope_1.EnvelopeEngine.serialize(envelope)),
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
        throw new Error(`Delivery receipt is terminal at ${receipt.current_state}, but message "${envelope.header.id}" exists in recipient inbox`);
    }
    registerAgent(agentId) {
        this.getAgentInbox(agentId);
        this.getAgentOutbox(agentId);
        this.getAgentArchive(agentId);
    }
    listMailboxes() {
        if (!fs.existsSync(this.mailboxesDir))
            return [];
        return fs.readdirSync(this.mailboxesDir, { withFileTypes: true })
            .filter(dirent => dirent.isDirectory())
            .map(dirent => dirent.name);
    }
    getDeliveryReceipt(messageId, recipient) {
        return this.deliveryLedger.get(messageId, recipient);
    }
    listDeliveryReceipts(messageId) {
        return this.deliveryLedger.list(messageId);
    }
    async sendMessage(envelope) {
        if (!envelope_1.EnvelopeEngine.verify(envelope)) {
            throw new Error('Cannot send invalid Envelope v2: verification failed');
        }
        const { header } = envelope;
        const serialized = envelope_1.EnvelopeEngine.serialize(envelope);
        const contentDigest = this.digest(serialized);
        const filename = `${header.id}.json`;
        const isBroadcast = header.recipient === 'broadcast' || header.recipient === 'all';
        return this.lockManager.withLock(`message_send_${this.digest(header.id)}`, async () => {
            let changed = false;
            const recipients = this.resolveRecipients(envelope, isBroadcast);
            for (const recipient of recipients) {
                await this.createDeliveryReceipt(header.id, recipient, header.sender, contentDigest);
            }
            const outboxReference = `mailbox://${this.logicalSegment(header.sender)}/outbox/${this.logicalSegment(header.id)}`;
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
            }
            catch (error) {
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
                }
                catch (error) {
                    if (!(error instanceof EnvelopeConflictError)) {
                        for (const recipient of recipients) {
                            await this.markDeliveryFailure(header.id, recipient);
                        }
                    }
                    throw error;
                }
            }
            const failedRecipients = [];
            let firstFailure;
            for (const recipient of recipients) {
                try {
                    let receipt = this.deliveryLedger.get(header.id, recipient);
                    if (!receipt) {
                        throw new Error('Delivery receipt disappeared during send');
                    }
                    if (receipt.current_state === 'accepted' ||
                        receipt.current_state === 'deferred' ||
                        receipt.current_state === 'delivery_unknown') {
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
                    if (receipt.current_state === 'delivered' ||
                        receipt.current_state === 'observed' ||
                        receipt.current_state === 'acted' ||
                        receipt.current_state === 'verified') {
                        const persistedPath = fs.existsSync(inboxPath) ? inboxPath : archivePath;
                        if (!fs.existsSync(persistedPath)) {
                            throw new Error('Delivery receipt claims persistence, but no recipient copy exists');
                        }
                        this.writeEnvelopeFile(persistedPath, serialized);
                        continue;
                    }
                    throw new Error(`Message cannot be retried from terminal delivery state ${receipt.current_state}`);
                }
                catch (error) {
                    failedRecipients.push(recipient);
                    if (firstFailure === undefined)
                        firstFailure = error;
                    if (!(error instanceof EnvelopeConflictError)) {
                        await this.markDeliveryFailure(header.id, recipient);
                    }
                }
            }
            if (failedRecipients.length > 0) {
                if (firstFailure instanceof Error)
                    throw firstFailure;
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
                }
                catch {
                    // Delivery truth is already persisted. An ancillary event-log failure
                    // must not be reported as message-delivery failure.
                }
            }
            return header.id;
        });
    }
    async broadcast(sender, topic, payload, fencing) {
        const envelope = envelope_1.EnvelopeEngine.create({ sender, recipient: 'broadcast', topic, payload, fencing });
        await this.sendMessage(envelope);
        return envelope;
    }
    async receiveMessages(agentId, options = {}) {
        const inbox = this.getAgentInbox(agentId);
        const files = fs.readdirSync(inbox).filter(f => f.endsWith('.json'));
        const limit = options.limit ?? files.length;
        const selectedFiles = files.slice(0, limit);
        const messages = [];
        for (const file of selectedFiles) {
            const filePath = path.join(inbox, file);
            let envelope;
            try {
                envelope = envelope_1.EnvelopeEngine.deserialize(fs.readFileSync(filePath, 'utf-8'));
            }
            catch {
                continue; // Corrupt message content is not evidence of observation.
            }
            await this.markObserved(agentId, envelope);
            messages.push(envelope);
            if (options.autoAcknowledge)
                await this.acknowledgeMessage(agentId, envelope.header.id);
        }
        return messages;
    }
    async acknowledgeMessage(agentId, messageId) {
        const inbox = this.getAgentInbox(agentId);
        const archive = this.getAgentArchive(agentId);
        const filename = `${messageId}.json`;
        const src = path.join(inbox, filename);
        const dest = path.join(archive, filename);
        if (fs.existsSync(src))
            fs.renameSync(src, dest);
    }
    async recordEvent(event) {
        await this.lockManager.withLock('events_log', async () => {
            fs.appendFileSync(this.eventsFile, JSON.stringify(event) + '\n', 'utf-8');
        });
    }
    async readEventStream(limit = 100) {
        if (!fs.existsSync(this.eventsFile))
            return [];
        const lines = fs.readFileSync(this.eventsFile, 'utf-8').trim().split('\n').filter(Boolean);
        const events = [];
        for (let i = Math.max(0, lines.length - limit); i < lines.length; i++) {
            try {
                events.push(JSON.parse(lines[i]));
            }
            catch { /* Ignore corrupted event lines. */ }
        }
        return events;
    }
}
exports.FileMailboxManager = FileMailboxManager;
//# sourceMappingURL=mailbox.js.map