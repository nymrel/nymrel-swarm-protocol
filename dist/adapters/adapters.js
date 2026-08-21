"use strict";
/**
 * @nymrel/swarm-protocol - Autonomous Agent Adapters
 * Copyright (c) 2026 Nymrel / JalenBuilds LLC. Licensed under the MIT License.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.OllamaAdapter = exports.CursorComposerAdapter = exports.GeminiCliAdapter = exports.CodexCliAdapter = exports.ClaudeCodeAdapter = exports.BaseAgentAdapter = void 0;
exports.createAdapter = createAdapter;
const envelope_1 = require("../bus/envelope");
const mailbox_1 = require("../bus/mailbox");
const claims_1 = require("../claims/claims");
const fencing_1 = require("../fencing/fencing");
class BaseAgentAdapter {
    config;
    mailbox;
    claims;
    fencing;
    activeClaimIds = new Set();
    heartbeatTimer;
    constructor(config) {
        this.config = config;
        this.mailbox = new mailbox_1.FileMailboxManager(config.swarm_root);
        this.claims = new claims_1.ClaimManager(config.swarm_root);
        this.fencing = new fencing_1.FencingClock(config.swarm_root);
        // Register mailbox immediately
        this.mailbox.registerAgent(this.config.agent_id);
        if (config.auto_heartbeat) {
            const interval = config.heartbeat_interval_ms ?? 10000;
            this.startHeartbeatLoop(interval);
        }
    }
    get agentId() {
        return this.config.agent_id;
    }
    get platform() {
        return this.config.platform;
    }
    /**
     * Send a strongly-typed Envelope v2 message to another agent.
     */
    async send(recipient, topic, payload, fencing, correlationId) {
        const envelope = envelope_1.EnvelopeEngine.create({
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
    async broadcast(topic, payload, fencing) {
        return await this.mailbox.broadcast(this.config.agent_id, topic, payload, fencing);
    }
    /**
     * Pull unread messages from this agent's inbox.
     */
    async receive(options = {}) {
        return await this.mailbox.receiveMessages(this.config.agent_id, options);
    }
    /**
     * Acquire a resource claim and register for auto-heartbeat.
     */
    async claim(resourcePath, mode = 'exclusive', leaseDurationMs, metadata) {
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
    async release(claimId) {
        const success = await this.claims.releaseClaim(claimId, this.config.agent_id);
        if (success) {
            this.activeClaimIds.delete(claimId);
        }
        return success;
    }
    /**
     * Release all claims held by this adapter.
     */
    async releaseAll() {
        for (const claimId of Array.from(this.activeClaimIds)) {
            await this.release(claimId);
        }
    }
    startHeartbeatLoop(intervalMs) {
        this.heartbeatTimer = setInterval(async () => {
            for (const claimId of Array.from(this.activeClaimIds)) {
                try {
                    await this.claims.heartbeat(claimId, this.config.agent_id);
                }
                catch {
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
    destroy() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = undefined;
        }
    }
}
exports.BaseAgentAdapter = BaseAgentAdapter;
class ClaudeCodeAdapter extends BaseAgentAdapter {
    constructor(swarmRoot, agentId = 'claude-code', agentName = 'Claude Code') {
        super({
            agent_id: agentId,
            agent_name: agentName,
            platform: 'claude-code',
            swarm_root: swarmRoot,
            auto_heartbeat: true,
        });
    }
}
exports.ClaudeCodeAdapter = ClaudeCodeAdapter;
class CodexCliAdapter extends BaseAgentAdapter {
    constructor(swarmRoot, agentId = 'codex-cli', agentName = 'Codex CLI') {
        super({
            agent_id: agentId,
            agent_name: agentName,
            platform: 'codex-cli',
            swarm_root: swarmRoot,
            auto_heartbeat: true,
        });
    }
}
exports.CodexCliAdapter = CodexCliAdapter;
class GeminiCliAdapter extends BaseAgentAdapter {
    constructor(swarmRoot, agentId = 'gemini-cli', agentName = 'Gemini CLI') {
        super({
            agent_id: agentId,
            agent_name: agentName,
            platform: 'gemini-cli',
            swarm_root: swarmRoot,
            auto_heartbeat: true,
        });
    }
}
exports.GeminiCliAdapter = GeminiCliAdapter;
class CursorComposerAdapter extends BaseAgentAdapter {
    constructor(swarmRoot, agentId = 'cursor-composer', agentName = 'Cursor Composer') {
        super({
            agent_id: agentId,
            agent_name: agentName,
            platform: 'cursor-composer',
            swarm_root: swarmRoot,
            auto_heartbeat: true,
        });
    }
}
exports.CursorComposerAdapter = CursorComposerAdapter;
class OllamaAdapter extends BaseAgentAdapter {
    constructor(swarmRoot, agentId = 'ollama-local', agentName = 'Ollama Local LLM') {
        super({
            agent_id: agentId,
            agent_name: agentName,
            platform: 'ollama-local',
            swarm_root: swarmRoot,
            auto_heartbeat: true,
        });
    }
}
exports.OllamaAdapter = OllamaAdapter;
function createAdapter(config) {
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
//# sourceMappingURL=adapters.js.map