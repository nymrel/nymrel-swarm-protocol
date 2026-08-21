/**
 * @nymrel/swarm-protocol - Atomic Cross-Process File Lock
 * Copyright (c) 2026 Nymrel / JalenBuilds LLC. Licensed under the MIT License.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { LockHandle, LockOptions } from '../types';

export class AtomicLockManager {
  private baseDir: string;

  constructor(swarmRoot: string) {
    this.baseDir = path.join(swarmRoot, 'locks');
    this.ensureDir(this.baseDir);
  }

  private ensureDir(dirPath: string): void {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  private getLockDir(lockName: string): string {
    const sanitized = lockName.replace(/[^a-zA-Z0-9._-]/g, '_');
    return path.join(this.baseDir, `${sanitized}.lock`);
  }

  private getMetaPath(lockDir: string): string {
    return path.join(lockDir, 'lock.json');
  }

  /**
   * Acquire a cross-process atomic lock using directory atomicity and metadata verification.
   */
  async acquireLock(lockName: string, options: LockOptions = {}): Promise<LockHandle> {
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
      } catch (err: unknown) {
        const error = err as NodeJS.ErrnoException;
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
                } catch {
                  // Ignore race in stale lock removal
                }
              }
            } else {
              // Directory exists without meta (incomplete creation race or partial stale lock)
              const stats = fs.statSync(lockDir);
              const age = Date.now() - stats.mtimeMs;
              if (age > staleThresholdMs) {
                try {
                  fs.rmSync(lockDir, { recursive: true, force: true });
                } catch {
                  // Ignore
                }
              }
            }
          } catch {
            // Ignore read errors during race
          }

          if (Date.now() - startTime >= timeoutMs) {
            throw new Error(`Failed to acquire lock "${lockName}" within timeout of ${timeoutMs}ms`);
          }

          // Backoff with jitter
          const jitter = Math.floor(Math.random() * 20);
          await new Promise((resolve) => setTimeout(resolve, retryIntervalMs + jitter));
        } else {
          throw err;
        }
      }
    }
  }

  /**
   * Release an acquired lock handle.
   */
  async releaseLock(handle: LockHandle): Promise<void> {
    try {
      if (fs.existsSync(handle.lock_path)) {
        fs.rmSync(handle.lock_path, { recursive: true, force: true });
      }
    } catch (err) {
      // Best-effort cleanup
    }
  }

  /**
   * Execute a function wrapped inside an atomic lock.
   */
  async withLock<T>(lockName: string, fn: () => Promise<T>, options?: LockOptions): Promise<T> {
    const handle = await this.acquireLock(lockName, options);
    try {
      return await fn();
    } finally {
      await this.releaseLock(handle);
    }
  }
}
