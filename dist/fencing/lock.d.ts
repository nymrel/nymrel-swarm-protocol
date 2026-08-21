/**
 * @nymrel/swarm-protocol - Atomic Cross-Process File Lock
 * Copyright (c) 2026 Nymrel / JalenBuilds LLC. Licensed under the MIT License.
 */
import { LockHandle, LockOptions } from '../types';
export declare class AtomicLockManager {
    private baseDir;
    constructor(swarmRoot: string);
    private ensureDir;
    private getLockDir;
    private getMetaPath;
    /**
     * Acquire a cross-process atomic lock using directory atomicity and metadata verification.
     */
    acquireLock(lockName: string, options?: LockOptions): Promise<LockHandle>;
    /**
     * Release an acquired lock handle.
     */
    releaseLock(handle: LockHandle): Promise<void>;
    /**
     * Execute a function wrapped inside an atomic lock.
     */
    withLock<T>(lockName: string, fn: () => Promise<T>, options?: LockOptions): Promise<T>;
}
//# sourceMappingURL=lock.d.ts.map