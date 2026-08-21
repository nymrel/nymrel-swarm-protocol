/**
 * @nymrel/swarm-protocol - Autonomous Agent Adapters
 * Copyright (c) 2026 Nymrel / JalenBuilds LLC. Licensed under the MIT License.
 */
import { AdapterConfig, EnvelopeV2, ClaimRecord, ClaimMode, FencingToken } from '../types';
import { FileMailboxManager, ReceiveOptions } from '../bus/mailbox';
import { ClaimManager } from '../claims/claims';
import { FencingClock } from '../fencing/fencing';
export declare class BaseAgentAdapter {
    readonly config: AdapterConfig;
    protected mailbox: FileMailboxManager;
    protected claims: ClaimManager;
    protected fencing: FencingClock;
    private activeClaimIds;
    private heartbeatTimer?;
    constructor(config: AdapterConfig);
    get agentId(): string;
    get platform(): string;
    /**
     * Send a strongly-typed Envelope v2 message to another agent.
     */
    send<T = Record<string, unknown>>(recipient: string, topic: string, payload: T, fencing?: FencingToken, correlationId?: string): Promise<string>;
    /**
     * Broadcast a message to all agents on the swarm bus.
     */
    broadcast<T = Record<string, unknown>>(topic: string, payload: T, fencing?: FencingToken): Promise<EnvelopeV2<T>>;
    /**
     * Pull unread messages from this agent's inbox.
     */
    receive<T = Record<string, unknown>>(options?: ReceiveOptions): Promise<EnvelopeV2<T>[]>;
    /**
     * Acquire a resource claim and register for auto-heartbeat.
     */
    claim(resourcePath: string, mode?: ClaimMode, leaseDurationMs?: number, metadata?: Record<string, unknown>): Promise<ClaimRecord>;
    /**
     * Release a previously acquired claim.
     */
    release(claimId: string): Promise<boolean>;
    /**
     * Release all claims held by this adapter.
     */
    releaseAll(): Promise<void>;
    private startHeartbeatLoop;
    /**
     * Stop background timers and clean up resources.
     */
    destroy(): void;
}
export declare class ClaudeCodeAdapter extends BaseAgentAdapter {
    constructor(swarmRoot: string, agentId?: string, agentName?: string);
}
export declare class CodexCliAdapter extends BaseAgentAdapter {
    constructor(swarmRoot: string, agentId?: string, agentName?: string);
}
export declare class GeminiCliAdapter extends BaseAgentAdapter {
    constructor(swarmRoot: string, agentId?: string, agentName?: string);
}
export declare class CursorComposerAdapter extends BaseAgentAdapter {
    constructor(swarmRoot: string, agentId?: string, agentName?: string);
}
export declare class OllamaAdapter extends BaseAgentAdapter {
    constructor(swarmRoot: string, agentId?: string, agentName?: string);
}
export declare function createAdapter(config: AdapterConfig): BaseAgentAdapter;
//# sourceMappingURL=adapters.d.ts.map