"use strict";
/**
 * @nymrel/swarm-protocol - Resource Claims & Auto-Expiring Leases
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
exports.ClaimManager = void 0;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const crypto = __importStar(require("node:crypto"));
const lock_1 = require("../fencing/lock");
const fencing_1 = require("../fencing/fencing");
const mailbox_1 = require("../bus/mailbox");
class ClaimManager {
    baseDir;
    lockManager;
    fencingClock;
    mailboxManager;
    defaultLeaseMs;
    constructor(swarmRoot, defaultLeaseMs = 30000) {
        this.baseDir = path.join(swarmRoot, 'claims');
        this.lockManager = new lock_1.AtomicLockManager(swarmRoot);
        this.fencingClock = new fencing_1.FencingClock(swarmRoot);
        this.mailboxManager = new mailbox_1.FileMailboxManager(swarmRoot);
        this.defaultLeaseMs = defaultLeaseMs;
        this.ensureDir(this.baseDir);
    }
    ensureDir(dirPath) {
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
        }
    }
    getClaimPath(claimId) {
        return path.join(this.baseDir, `${claimId}.json`);
    }
    /**
     * Normalize path for cross-platform hierarchy checks.
     */
    static normalizeResourcePath(resourcePath) {
        let normalized = resourcePath.replace(/\\/g, '/').trim();
        if (normalized.endsWith('/') && normalized.length > 1) {
            normalized = normalized.slice(0, -1);
        }
        // Lowercase for Windows path case-insensitivity
        return normalized.toLowerCase();
    }
    /**
     * Check if path A is an ancestor or exact match of path B.
     */
    static isSubPath(parent, child) {
        if (parent === child)
            return true;
        const parentWithSlash = parent.endsWith('/') ? parent : `${parent}/`;
        return child.startsWith(parentWithSlash);
    }
    /**
     * Check if two claims conflict based on path hierarchy and mode.
     */
    static checkConflict(pathA, modeA, pathB, modeB) {
        const isRelated = this.isSubPath(pathA, pathB) || this.isSubPath(pathB, pathA);
        if (!isRelated) {
            return false;
        }
        // If either claim is exclusive, any hierarchy overlap is a conflict
        if (modeA === 'exclusive' || modeB === 'exclusive') {
            return true;
        }
        // Both shared claims on related paths can co-exist
        return false;
    }
    /**
     * Acquire a new resource claim with lease and fencing generation.
     */
    async acquireClaim(params) {
        return await this.lockManager.withLock('claims_mutex', async () => {
            const normPath = ClaimManager.normalizeResourcePath(params.resource_path);
            const mode = params.mode ?? 'exclusive';
            const leaseDurationMs = params.lease_duration_ms ?? this.defaultLeaseMs;
            const nowMs = Date.now();
            const nowIso = new Date(nowMs).toISOString();
            const expiresIso = new Date(nowMs + leaseDurationMs).toISOString();
            // Read active claims and check for conflicts
            const activeClaims = await this.listActiveClaimsInternal();
            for (const existing of activeClaims) {
                // Skip same agent re-claiming exact same path
                if (existing.owner_agent === params.owner_agent && existing.resource_path === normPath) {
                    // Refresh existing claim
                    existing.lease_duration_ms = leaseDurationMs;
                    existing.expires_at = expiresIso;
                    existing.heartbeat_at = nowIso;
                    existing.metadata = { ...existing.metadata, ...params.metadata };
                    fs.writeFileSync(this.getClaimPath(existing.claim_id), JSON.stringify(existing, null, 2), 'utf-8');
                    return existing;
                }
                const conflict = ClaimManager.checkConflict(existing.resource_path, existing.mode, normPath, mode);
                if (conflict) {
                    throw new Error(`Claim conflict on "${params.resource_path}": Already held by "${existing.owner_agent}" ` +
                        `(${existing.mode} mode, claim_id: ${existing.claim_id}, expires: ${existing.expires_at})`);
                }
            }
            // Generate monotonic fencing token for the resource
            const fencingToken = await this.fencingClock.incrementGeneration(normPath, params.owner_agent);
            const claimId = crypto.randomUUID();
            const record = {
                claim_id: claimId,
                resource_path: normPath,
                owner_agent: params.owner_agent,
                mode,
                status: 'active',
                fencing_generation: fencingToken.generation,
                lease_duration_ms: leaseDurationMs,
                acquired_at: nowIso,
                expires_at: expiresIso,
                heartbeat_at: nowIso,
                metadata: params.metadata,
            };
            fs.writeFileSync(this.getClaimPath(claimId), JSON.stringify(record, null, 2), 'utf-8');
            // Record event
            await this.mailboxManager.recordEvent({
                event_id: crypto.randomUUID(),
                timestamp: nowIso,
                event_type: 'claim_acquired',
                actor: params.owner_agent,
                resource: normPath,
                details: {
                    claim_id: claimId,
                    mode,
                    generation: fencingToken.generation,
                    expires_at: expiresIso,
                },
            });
            return record;
        });
    }
    /**
     * Send heartbeat to keep an active claim refreshed.
     */
    async heartbeat(claimId, agentId) {
        return await this.lockManager.withLock('claims_mutex', async () => {
            const claim = await this.getClaim(claimId);
            if (!claim) {
                throw new Error(`Claim not found: ${claimId}`);
            }
            if (claim.owner_agent !== agentId) {
                throw new Error(`Unauthorized heartbeat: Claim ${claimId} is owned by "${claim.owner_agent}", not "${agentId}"`);
            }
            if (claim.status === 'released' || claim.status === 'revoked') {
                throw new Error(`Cannot heartbeat claim in "${claim.status}" status`);
            }
            const nowMs = Date.now();
            const nowIso = new Date(nowMs).toISOString();
            const newExpiresIso = new Date(nowMs + claim.lease_duration_ms).toISOString();
            claim.status = 'active';
            claim.heartbeat_at = nowIso;
            claim.expires_at = newExpiresIso;
            fs.writeFileSync(this.getClaimPath(claimId), JSON.stringify(claim, null, 2), 'utf-8');
            await this.mailboxManager.recordEvent({
                event_id: crypto.randomUUID(),
                timestamp: nowIso,
                event_type: 'claim_heartbeat',
                actor: agentId,
                resource: claim.resource_path,
                details: {
                    claim_id: claimId,
                    expires_at: newExpiresIso,
                },
            });
            return claim;
        });
    }
    /**
     * Release a held claim.
     */
    async releaseClaim(claimId, agentId) {
        return await this.lockManager.withLock('claims_mutex', async () => {
            const claim = await this.getClaim(claimId);
            if (!claim) {
                return false;
            }
            if (claim.owner_agent !== agentId) {
                throw new Error(`Unauthorized release: Claim ${claimId} is owned by "${claim.owner_agent}", not "${agentId}"`);
            }
            claim.status = 'released';
            fs.writeFileSync(this.getClaimPath(claimId), JSON.stringify(claim, null, 2), 'utf-8');
            await this.mailboxManager.recordEvent({
                event_id: crypto.randomUUID(),
                timestamp: new Date().toISOString(),
                event_type: 'claim_released',
                actor: agentId,
                resource: claim.resource_path,
                details: { claim_id: claimId },
            });
            return true;
        });
    }
    /**
     * Retrieve a claim by ID.
     */
    async getClaim(claimId) {
        const filePath = this.getClaimPath(claimId);
        if (!fs.existsSync(filePath)) {
            return null;
        }
        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            return JSON.parse(content);
        }
        catch {
            return null;
        }
    }
    /**
     * Scan and list claims with optional filtering.
     */
    async listClaims(filter = {}) {
        if (!fs.existsSync(this.baseDir)) {
            return [];
        }
        const files = fs.readdirSync(this.baseDir).filter(f => f.endsWith('.json'));
        const records = [];
        const nowMs = Date.now();
        for (const file of files) {
            try {
                const content = fs.readFileSync(path.join(this.baseDir, file), 'utf-8');
                const record = JSON.parse(content);
                // Check if active lease has expired in real-time
                if (record.status === 'active' && new Date(record.expires_at).getTime() < nowMs) {
                    record.status = 'expired';
                }
                if (filter.owner_agent && record.owner_agent !== filter.owner_agent)
                    continue;
                if (filter.resource_path && record.resource_path !== ClaimManager.normalizeResourcePath(filter.resource_path))
                    continue;
                if (filter.mode && record.mode !== filter.mode)
                    continue;
                if (filter.status && record.status !== filter.status)
                    continue;
                if (!filter.include_expired && filter.status !== 'expired' && record.status === 'expired')
                    continue;
                records.push(record);
            }
            catch {
                // Skip corrupted entries
            }
        }
        return records;
    }
    async listActiveClaimsInternal() {
        const nowMs = Date.now();
        const all = await this.listClaims({ include_expired: true });
        return all.filter(c => c.status === 'active' && new Date(c.expires_at).getTime() >= nowMs);
    }
    /**
     * Auto-Arbiter: Scans and marks expired leases.
     */
    async reapExpiredLeases() {
        return await this.lockManager.withLock('claims_mutex', async () => {
            const files = fs.readdirSync(this.baseDir).filter(f => f.endsWith('.json'));
            const nowMs = Date.now();
            const expired = [];
            for (const file of files) {
                const filePath = path.join(this.baseDir, file);
                try {
                    const content = fs.readFileSync(filePath, 'utf-8');
                    const record = JSON.parse(content);
                    if (record.status === 'active' && new Date(record.expires_at).getTime() < nowMs) {
                        record.status = 'expired';
                        fs.writeFileSync(filePath, JSON.stringify(record, null, 2), 'utf-8');
                        expired.push(record);
                        await this.mailboxManager.recordEvent({
                            event_id: crypto.randomUUID(),
                            timestamp: new Date().toISOString(),
                            event_type: 'claim_expired',
                            actor: 'auto_arbiter',
                            resource: record.resource_path,
                            details: {
                                claim_id: record.claim_id,
                                expired_owner: record.owner_agent,
                                expired_at: record.expires_at,
                            },
                        });
                    }
                }
                catch {
                    // Ignore
                }
            }
            return expired;
        });
    }
}
exports.ClaimManager = ClaimManager;
//# sourceMappingURL=claims.js.map