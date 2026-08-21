/**
 * @nymrel/swarm-protocol - Monotonic Fencing Generation Clock
 * Copyright (c) 2026 Nymrel / JalenBuilds LLC. Licensed under the MIT License.
 */
import { FencingToken, FencingState } from '../types';
export declare class FencingClock {
    private baseDir;
    private lockManager;
    constructor(swarmRoot: string);
    private ensureDir;
    private getFencingPath;
    private generateTokenString;
    /**
     * Atomically increment the fencing generation and issue a new fencing token.
     */
    incrementGeneration(resourceId: string, claimant: string): Promise<FencingToken>;
    /**
     * Read the latest state of a fencing token for a given resource.
     */
    getLatestToken(resourceId: string): Promise<FencingState | null>;
    /**
     * Validate if a presented token is active and matches the highest current generation.
     */
    validateGeneration(resourceId: string, presentedToken: FencingToken | string): Promise<boolean>;
}
//# sourceMappingURL=fencing.d.ts.map