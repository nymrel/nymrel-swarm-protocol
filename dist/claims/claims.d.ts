/**
 * @nymrel/swarm-protocol - Resource Claims & Auto-Expiring Leases
 * Copyright (c) 2026 Nymrel / JalenBuilds LLC. Licensed under the MIT License.
 */
import { ClaimRecord, AcquireClaimParams, ClaimFilter, ClaimMode } from '../types';
export declare class ClaimManager {
    private baseDir;
    private lockManager;
    private fencingClock;
    private mailboxManager;
    private defaultLeaseMs;
    constructor(swarmRoot: string, defaultLeaseMs?: number);
    private ensureDir;
    private getClaimPath;
    /**
     * Normalize path for cross-platform hierarchy checks.
     */
    static normalizeResourcePath(resourcePath: string): string;
    /**
     * Check if path A is an ancestor or exact match of path B.
     */
    static isSubPath(parent: string, child: string): boolean;
    /**
     * Check if two claims conflict based on path hierarchy and mode.
     */
    static checkConflict(pathA: string, modeA: ClaimMode, pathB: string, modeB: ClaimMode): boolean;
    /**
     * Acquire a new resource claim with lease and fencing generation.
     */
    acquireClaim(params: AcquireClaimParams): Promise<ClaimRecord>;
    /**
     * Send heartbeat to keep an active claim refreshed.
     */
    heartbeat(claimId: string, agentId: string): Promise<ClaimRecord>;
    /**
     * Release a held claim.
     */
    releaseClaim(claimId: string, agentId: string): Promise<boolean>;
    /**
     * Retrieve a claim by ID.
     */
    getClaim(claimId: string): Promise<ClaimRecord | null>;
    /**
     * Scan and list claims with optional filtering.
     */
    listClaims(filter?: ClaimFilter): Promise<ClaimRecord[]>;
    private listActiveClaimsInternal;
    /**
     * Auto-Arbiter: Scans and marks expired leases.
     */
    reapExpiredLeases(): Promise<ClaimRecord[]>;
}
//# sourceMappingURL=claims.d.ts.map