/**
 * @nymrel/swarm-protocol - Monotonic Fencing Generation Clock
 * Copyright (c) 2026 Nymrel / JalenBuilds LLC. Licensed under the MIT License.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { FencingToken, FencingState } from '../types';
import { AtomicLockManager } from './lock';

export class FencingClock {
  private baseDir: string;
  private lockManager: AtomicLockManager;

  constructor(swarmRoot: string) {
    this.baseDir = path.join(swarmRoot, 'fencing');
    this.lockManager = new AtomicLockManager(swarmRoot);
    this.ensureDir(this.baseDir);
  }

  private ensureDir(dirPath: string): void {
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true });
    }
  }

  private getFencingPath(resourceId: string): string {
    const sanitized = resourceId.replace(/[^a-zA-Z0-9._-]/g, '_');
    return path.join(this.baseDir, `${sanitized}.json`);
  }

  private generateTokenString(resourceId: string, generation: number, claimant: string, timestamp: string): string {
    const raw = `${resourceId}:${generation}:${claimant}:${timestamp}`;
    const hash = crypto.createHash('sha256').update(raw).digest('hex').substring(0, 16);
    return `fenc_gen${generation}_${hash}`;
  }

  /**
   * Atomically increment the fencing generation and issue a new fencing token.
   */
  async incrementGeneration(resourceId: string, claimant: string): Promise<FencingToken> {
    return await this.lockManager.withLock(`fencing_${resourceId}`, async () => {
      const filePath = this.getFencingPath(resourceId);
      let currentGen = 0;

      if (fs.existsSync(filePath)) {
        try {
          const content = fs.readFileSync(filePath, 'utf-8');
          const state: FencingState = JSON.parse(content);
          currentGen = state.current_generation || 0;
        } catch {
          currentGen = 0;
        }
      }

      const nextGen = currentGen + 1;
      const now = new Date().toISOString();
      const tokenStr = this.generateTokenString(resourceId, nextGen, claimant, now);

      const token: FencingToken = {
        resource_id: resourceId,
        generation: nextGen,
        token: tokenStr,
        issued_at: now,
        claimant,
      };

      const newState: FencingState = {
        resource_id: resourceId,
        current_generation: nextGen,
        current_token: tokenStr,
        holder: claimant,
        updated_at: now,
      };

      fs.writeFileSync(filePath, JSON.stringify(newState, null, 2), 'utf-8');
      return token;
    });
  }

  /**
   * Read the latest state of a fencing token for a given resource.
   */
  async getLatestToken(resourceId: string): Promise<FencingState | null> {
    const filePath = this.getFencingPath(resourceId);
    if (!fs.existsSync(filePath)) {
      return null;
    }
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(content) as FencingState;
    } catch {
      return null;
    }
  }

  /**
   * Validate if a presented token is active and matches the highest current generation.
   */
  async validateGeneration(resourceId: string, presentedToken: FencingToken | string): Promise<boolean> {
    const state = await this.getLatestToken(resourceId);
    if (!state) {
      return false;
    }

    if (typeof presentedToken === 'string') {
      return state.current_token === presentedToken;
    }

    return (
      presentedToken.resource_id === resourceId &&
      presentedToken.generation === state.current_generation &&
      presentedToken.token === state.current_token
    );
  }
}
