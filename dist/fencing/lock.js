"use strict";
/**
 * @nymrel/swarm-protocol - Atomic Cross-Process File Lock
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
exports.AtomicLockManager = void 0;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
class AtomicLockManager {
    baseDir;
    constructor(swarmRoot) {
        this.baseDir = path.join(swarmRoot, 'locks');
        this.ensureDir(this.baseDir);
    }
    ensureDir(dirPath) {
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
        }
    }
    getLockDir(lockName) {
        const sanitized = lockName.replace(/[^a-zA-Z0-9._-]/g, '_');
        return path.join(this.baseDir, `${sanitized}.lock`);
    }
    getMetaPath(lockDir) {
        return path.join(lockDir, 'lock.json');
    }
    /**
     * Acquire a cross-process atomic lock using directory atomicity and metadata verification.
     */
    async acquireLock(lockName, options = {}) {
        const timeoutMs = options.timeout_ms ?? 5000;
        const retryIntervalMs = options.retry_interval_ms ?? 50;
        const staleThresholdMs = options.stale_threshold_ms ?? 10000;
        const lockDir = this.getLockDir(lockName);
        const metaPath = this.getMetaPath(lockDir);
        const startTime = Date.now();
        const pid = process.pid;
        while (true) {
            try {
                // Atomic directory creation
                fs.mkdirSync(lockDir);
                // Created lock directory successfully, write metadata
                const meta = {
                    lock_name: lockName,
                    pid,
                    acquired_at: Date.now(),
                };
                fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), 'utf-8');
                return {
                    lock_name: lockName,
                    lock_path: lockDir,
                    acquired_at: meta.acquired_at,
                    pid,
                };
            }
            catch (err) {
                const error = err;
                if (error.code === 'EEXIST') {
                    // Lock exists. Check if it is stale
                    try {
                        if (fs.existsSync(metaPath)) {
                            const content = fs.readFileSync(metaPath, 'utf-8');
                            const meta = JSON.parse(content);
                            const age = Date.now() - (meta.acquired_at || 0);
                            if (age > staleThresholdMs) {
                                // Stale lock detected, force eviction
                                try {
                                    fs.rmSync(lockDir, { recursive: true, force: true });
                                }
                                catch {
                                    // Ignore race in stale lock removal
                                }
                            }
                        }
                        else {
                            // Directory exists without meta (incomplete creation race or partial stale lock)
                            const stats = fs.statSync(lockDir);
                            const age = Date.now() - stats.mtimeMs;
                            if (age > staleThresholdMs) {
                                try {
                                    fs.rmSync(lockDir, { recursive: true, force: true });
                                }
                                catch {
                                    // Ignore
                                }
                            }
                        }
                    }
                    catch {
                        // Ignore read errors during race
                    }
                    if (Date.now() - startTime >= timeoutMs) {
                        throw new Error(`Failed to acquire lock "${lockName}" within timeout of ${timeoutMs}ms`);
                    }
                    // Backoff with jitter
                    const jitter = Math.floor(Math.random() * 20);
                    await new Promise((resolve) => setTimeout(resolve, retryIntervalMs + jitter));
                }
                else {
                    throw err;
                }
            }
        }
    }
    /**
     * Release an acquired lock handle.
     */
    async releaseLock(handle) {
        try {
            if (fs.existsSync(handle.lock_path)) {
                fs.rmSync(handle.lock_path, { recursive: true, force: true });
            }
        }
        catch (err) {
            // Best-effort cleanup
        }
    }
    /**
     * Execute a function wrapped inside an atomic lock.
     */
    async withLock(lockName, fn, options) {
        const handle = await this.acquireLock(lockName, options);
        try {
            return await fn();
        }
        finally {
            await this.releaseLock(handle);
        }
    }
}
exports.AtomicLockManager = AtomicLockManager;
//# sourceMappingURL=lock.js.map