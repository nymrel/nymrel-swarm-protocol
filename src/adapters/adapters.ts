/**
 * @nymrel/swarm-protocol - Autonomous Agent Adapters
 * Copyright (c) 2026 Nymrel / JalenBuilds LLC. Licensed under the MIT License.
 */

import {
  AdapterConfig,
  EnvelopeV2,
  ClaimRecord,
  ClaimMode,
  FencingToken,
} from '../types';
import { EnvelopeEngine } from '../bus/envelope';
import { FileMailboxManager, ReceiveOptions } from '../bus/mailbox';
import { ClaimManager } from '../claims/claims';
import { FencingClock } from '../fencing/fencing';

export class BaseAgentAdapter {
  readonly config: AdapterConfig;
  protected mailbox: FileMailboxManager;
  protected claims: ClaimManager;
  protected fencing: FencingClock;
  private activeClaimIds: Set<string> = new Set();
  private heartbeatTimer?: NodeJS.Timeout;

  constructor(config: AdapterConfig) {
    this.config = config;
    this.mailbox = new FileMailboxManager(config.swarm_root);
    this.claims = new ClaimManager(config.swarm_root);
    this.fencing = new FencingClock(config.swarm_root);

    // Register mailbox immediately
    this.mailbox.registerAgent(this.config.agent_id);

    if (config.auto_heartbeat) {
      const interval = config.heartbeat_interval_ms ?? 10000;
      this.startHeartbeatLoop(interval);
    }
  }

  get agentId(): string {
    return this.config.agent_id;
  }

  get platform(): string {
    return this.config.platform;
  }

  /**
   * Send a strongly-typed Envelope v2 message to another agent.
   */
  async send<T = Record<string, unknown>>(
    recipient: string,
    topic: string,
    payload: T,
    fencing?: FencingToken,
    correlationId?: string
  ): Promise<string> {
    const envelope = EnvelopeEngine.create<T>({
      sender: this.config.agent_id,
      recipient,
      topic,
      payload,
      fencing,
      correlation_id: correlationId,
    });
    return await this.mailbox.sendMessage(envelope);
  }

  /**
   * Broadcast a message to all agents on the swarm bus.
   */
  async broadcast<T = Record<string, unknown>>(
    topic: string,
    payload: T,
    fencing?: FencingToken
  ): Promise<EnvelopeV2<T>> {
    return await this.mailbox.broadcast(this.config.agent_id, topic, payload, fencing);
  }

  /**
   * Pull unread messages from this agent's inbox.
   */
  async receive<T = Record<string, unknown>>(options: ReceiveOptions = {}): Promise<EnvelopeV2<T>[]> {
    return await this.mailbox.receiveMessages<T>(this.config.agent_id, options);
  }

  /**
   * Acquire a resource claim and register for auto-heartbeat.
   */
  async claim(
    resourcePath: string,
    mode: ClaimMode = 'exclusive',
    leaseDurationMs?: number,
    metadata?: Record<string, unknown>
  ): Promise<ClaimRecord> {
    const record = await this.claims.acquireClaim({
      resource_path: resourcePath,
      owner_agent: this.config.agent_id,
      mode,
      lease_duration_ms: leaseDurationMs,
      metadata: {
        ...metadata,
        platform: this.config.platform,
        agent_name: this.config.agent_name,
      },
    });

    this.activeClaimIds.add(record.claim_id);
    return record;
  }

  /**
   * Release a previously acquired claim.
   */
  async release(claimId: string): Promise<boolean> {
    const success = await this.claims.releaseClaim(claimId, this.config.agent_id);
    if (success) {
      this.activeClaimIds.delete(claimId);
    }
    return success;
  }

  /**
   * Release all claims held by this adapter.
   */
  async releaseAll(): Promise<void> {
    for (const claimId of Array.from(this.activeClaimIds)) {
      await this.release(claimId);
    }
  }

  private startHeartbeatLoop(intervalMs: number): void {
    this.heartbeatTimer = setInterval(async () => {
      for (const claimId of Array.from(this.activeClaimIds)) {
        try {
          await this.claims.heartbeat(claimId, this.config.agent_id);
        } catch {
          // If claim expired or was lost, remove from local tracking
          this.activeClaimIds.delete(claimId);
        }
      }
    }, intervalMs);

    // Unref timer so it does not block Node process exit
    if (this.heartbeatTimer.unref) {
      this.heartbeatTimer.unref();
    }
  }

  /**
   * Stop background timers and clean up resources.
   */
  destroy(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }
}

export class ClaudeCodeAdapter extends BaseAgentAdapter {
  constructor(swarmRoot: string, agentId = 'claude-code', agentName = 'Claude Code') {
    super({
      agent_id: agentId,
      agent_name: agentName,
      platform: 'claude-code',
      swarm_root: swarmRoot,
      auto_heartbeat: true,
    });
  }
}

export class CodexCliAdapter extends BaseAgentAdapter {
  constructor(swarmRoot: string, agentId = 'codex-cli', agentName = 'Codex CLI') {
    super({
      agent_id: agentId,
      agent_name: agentName,
      platform: 'codex-cli',
      swarm_root: swarmRoot,
      auto_heartbeat: true,
    });
  }
}

export class GeminiCliAdapter extends BaseAgentAdapter {
  constructor(swarmRoot: string, agentId = 'gemini-cli', agentName = 'Gemini CLI') {
    super({
      agent_id: agentId,
      agent_name: agentName,
      platform: 'gemini-cli',
      swarm_root: swarmRoot,
      auto_heartbeat: true,
    });
  }
}

export class CursorComposerAdapter extends BaseAgentAdapter {
  constructor(swarmRoot: string, agentId = 'cursor-composer', agentName = 'Cursor Composer') {
    super({
      agent_id: agentId,
      agent_name: agentName,
      platform: 'cursor-composer',
      swarm_root: swarmRoot,
      auto_heartbeat: true,
    });
  }
}

export class OllamaAdapter extends BaseAgentAdapter {
  constructor(swarmRoot: string, agentId = 'ollama-local', agentName = 'Ollama Local LLM') {
    super({
      agent_id: agentId,
      agent_name: agentName,
      platform: 'ollama-local',
      swarm_root: swarmRoot,
      auto_heartbeat: true,
    });
  }
}

export function createAdapter(config: AdapterConfig): BaseAgentAdapter {
  switch (config.platform) {
    case 'claude-code':
      return new ClaudeCodeAdapter(config.swarm_root, config.agent_id, config.agent_name);
    case 'codex-cli':
      return new CodexCliAdapter(config.swarm_root, config.agent_id, config.agent_name);
    case 'gemini-cli':
      return new GeminiCliAdapter(config.swarm_root, config.agent_id, config.agent_name);
    case 'cursor-composer':
      return new CursorComposerAdapter(config.swarm_root, config.agent_id, config.agent_name);
    case 'ollama-local':
      return new OllamaAdapter(config.swarm_root, config.agent_id, config.agent_name);
    default:
      return new BaseAgentAdapter(config);
  }
}
