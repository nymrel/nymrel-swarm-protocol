/**
 * @nymrel/swarm-protocol - File-Based Mailbox Manager & Event Stream
 * Copyright (c) 2026 Nymrel / JalenBuilds LLC. Licensed under the MIT License.
 */
import { EnvelopeV2, BusEvent, FencingToken } from '../types';
import { DeliveryReceipt } from '../delivery/delivery';
export declare class EnvelopeConflictError extends Error {
}
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
    private deliveryLedger;
    constructor(swarmRoot: string);
    private ensureDir;
    private getAgentInbox;
    private getAgentOutbox;
    private getAgentArchive;
    private digest;
    private logicalSegment;
    private writeEnvelopeFile;
    private resolveRecipients;
    private createDeliveryReceipt;
    private markDeliveryFailure;
    private markObserved;
    registerAgent(agentId: string): void;
    listMailboxes(): string[];
    getDeliveryReceipt(messageId: string, recipient: string): DeliveryReceipt | null;
    listDeliveryReceipts(messageId?: string): DeliveryReceipt[];
    sendMessage<T = Record<string, unknown>>(envelope: EnvelopeV2<T>): Promise<string>;
    broadcast<T = Record<string, unknown>>(sender: string, topic: string, payload: T, fencing?: FencingToken): Promise<EnvelopeV2<T>>;
    receiveMessages<T = Record<string, unknown>>(agentId: string, options?: ReceiveOptions): Promise<EnvelopeV2<T>[]>;
    acknowledgeMessage(agentId: string, messageId: string): Promise<void>;
    recordEvent(event: BusEvent): Promise<void>;
    readEventStream(limit?: number): Promise<BusEvent[]>;
}
//# sourceMappingURL=mailbox.d.ts.map