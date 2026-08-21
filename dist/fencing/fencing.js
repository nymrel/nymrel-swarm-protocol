"use strict";
/**
 * @nymrel/swarm-protocol - Monotonic Fencing Generation Clock
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
exports.FencingClock = void 0;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const crypto = __importStar(require("node:crypto"));
const lock_1 = require("./lock");
class FencingClock {
    baseDir;
    lockManager;
    constructor(swarmRoot) {
        this.baseDir = path.join(swarmRoot, 'fencing');
        this.lockManager = new lock_1.AtomicLockManager(swarmRoot);
        this.ensureDir(this.baseDir);
    }
    ensureDir(dirPath) {
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
        }
    }
    getFencingPath(resourceId) {
        const sanitized = resourceId.replace(/[^a-zA-Z0-9._-]/g, '_');
        return path.join(this.baseDir, `${sanitized}.json`);
    }
    generateTokenString(resourceId, generation, claimant, timestamp) {
        const raw = `${resourceId}:${generation}:${claimant}:${timestamp}`;
        const hash = crypto.createHash('sha256').update(raw).digest('hex').substring(0, 16);
        return `fenc_gen${generation}_${hash}`;
    }
    /**
     * Atomically increment the fencing generation and issue a new fencing token.
     */
    async incrementGeneration(resourceId, claimant) {
        return await this.lockManager.withLock(`fencing_${resourceId}`, async () => {
            const filePath = this.getFencingPath(resourceId);
            let currentGen = 0;
            if (fs.existsSync(filePath)) {
                try {
                    const content = fs.readFileSync(filePath, 'utf-8');
                    const state = JSON.parse(content);
                    currentGen = state.current_generation || 0;
                }
                catch {
                    currentGen = 0;
                }
            }
            const nextGen = currentGen + 1;
            const now = new Date().toISOString();
            const tokenStr = this.generateTokenString(resourceId, nextGen, claimant, now);
            const token = {
                resource_id: resourceId,
                generation: nextGen,
                token: tokenStr,
                issued_at: now,
                claimant,
            };
            const newState = {
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
    async getLatestToken(resourceId) {
        const filePath = this.getFencingPath(resourceId);
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
     * Validate if a presented token is active and matches the highest current generation.
     */
    async validateGeneration(resourceId, presentedToken) {
        const state = await this.getLatestToken(resourceId);
        if (!state) {
            return false;
        }
        if (typeof presentedToken === 'string') {
            return state.current_token === presentedToken;
        }
        return (presentedToken.resource_id === resourceId &&
            presentedToken.generation === state.current_generation &&
            presentedToken.token === state.current_token);
    }
}
exports.FencingClock = FencingClock;
//# sourceMappingURL=fencing.js.map