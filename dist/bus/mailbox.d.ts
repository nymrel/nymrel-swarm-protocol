/**
 * @nymrel/swarm-protocol - File-Based Mailbox Manager & Event Stream
 * Copyright (c) 2026 Nymrel / JalenBuilds LLC. Licensed under the MIT License.
 */
import { EnvelopeV2, BusEvent, FencingToken } from '../types';
export interface ReceiveOptions {
    limit?: number;
    autoAcknowledge?: boolean;
}
export declare class FileMailboxManager {
    private rootDir;
    private mailboxesDir;
    private broadcastsDir;
    private eventsFile;
    private lockManager;
    constructor(swarmRoot: string);
    private ensureDir;
    private getAgentInbox;
    private getAgentOutbox;
    private getAgentArchive;
    /**
     * Register an agent and ensure its mailbox directories are provisioned.
     */
    registerAgent(agentId: string): void;
    /**
     * List all registered agent mailboxes.
     */
    listMailboxes(): string[];
    /**
     * Send an Envelope v2 to a target agent or broadcast.
     */
    sendMessage<T = Record<string, unknown>>(envelope: EnvelopeV2<T>): Promise<string>;
    /**
     * Convenience helper to broadcast a message.
     */
    broadcast<T = Record<string, unknown>>(sender: string, topic: string, payload: T, fencing?: FencingToken): Promise<EnvelopeV2<T>>;
    /**
     * Receive unread messages from an agent's inbox.
     */
    receiveMessages<T = Record<string, unknown>>(agentId: string, options?: ReceiveOptions): Promise<EnvelopeV2<T>[]>;
    /**
     * Acknowledge and move a message from inbox to archive.
     */
    acknowledgeMessage(agentId: string, messageId: string): Promise<void>;
    /**
     * Append an event to the global event stream under atomic lock.
     */
    recordEvent(event: BusEvent): Promise<void>;
    /**
     * Read the latest events from the global event stream.
     */
    readEventStream(limit?: number): Promise<BusEvent[]>;
}
//# sourceMappingURL=mailbox.d.ts.map