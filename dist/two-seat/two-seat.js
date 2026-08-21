"use strict";
/**
 * @nymrel/swarm-protocol - Two-Seat Command Studio Protocol
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
exports.TwoSeatProtocol = void 0;
const fs = __importStar(require("node:fs"));
const path = __importStar(require("node:path"));
const crypto = __importStar(require("node:crypto"));
const lock_1 = require("../fencing/lock");
const fencing_1 = require("../fencing/fencing");
const mailbox_1 = require("../bus/mailbox");
class TwoSeatProtocol {
    baseDir;
    lockManager;
    fencingClock;
    mailboxManager;
    constructor(swarmRoot) {
        this.baseDir = path.join(swarmRoot, 'two-seat');
        this.lockManager = new lock_1.AtomicLockManager(swarmRoot);
        this.fencingClock = new fencing_1.FencingClock(swarmRoot);
        this.mailboxManager = new mailbox_1.FileMailboxManager(swarmRoot);
        this.ensureDir(this.baseDir);
    }
    ensureDir(dirPath) {
        if (!fs.existsSync(dirPath)) {
            fs.mkdirSync(dirPath, { recursive: true });
        }
    }
    getMissionPath(missionId) {
        const sanitized = missionId.replace(/[^a-zA-Z0-9._-]/g, '_');
        return path.join(this.baseDir, `${sanitized}.json`);
    }
    /**
     * Initialize a new Two-Seat Command Studio mission.
     */
    async initMission(params) {
        return await this.lockManager.withLock(`mission_${params.mission_id}`, async () => {
            const filePath = this.getMissionPath(params.mission_id);
            if (fs.existsSync(filePath)) {
                throw new Error(`Mission "${params.mission_id}" already exists`);
            }
            if (params.mission_owner_seat_id === params.studio_controller_seat_id) {
                throw new Error('Two-Seat invariant violation: mission_owner and studio_controller cannot be the same seat');
            }
            const now = new Date().toISOString();
            const fencingToken = await this.fencingClock.incrementGeneration(`mission_${params.mission_id}`, params.mission_owner_seat_id);
            const record = {
                mission_id: params.mission_id,
                mission_owner_seat_id: params.mission_owner_seat_id,
                studio_controller_seat_id: params.studio_controller_seat_id,
                state: 'ACTIVE',
                health_state: 'HEALTHY',
                current_generation: fencingToken.generation,
                fencing_token: fencingToken,
                active_claims: [],
                checkpoints: [
                    {
                        timestamp: now,
                        author: params.mission_owner_seat_id,
                        summary: params.initial_checkpoint ?? 'Mission initialized under Two-Seat Command Studio contract',
                    },
                ],
                handover_history: [],
                created_at: now,
                updated_at: now,
            };
            fs.writeFileSync(filePath, JSON.stringify(record, null, 2), 'utf-8');
            await this.mailboxManager.recordEvent({
                event_id: crypto.randomUUID(),
                timestamp: now,
                event_type: 'mission_initialized',
                actor: params.mission_owner_seat_id,
                resource: params.mission_id,
                details: {
                    owner: params.mission_owner_seat_id,
                    controller: params.studio_controller_seat_id,
                    generation: fencingToken.generation,
                },
            });
            return record;
        });
    }
    /**
     * Retrieve current mission record.
     */
    async getMission(missionId) {
        const filePath = this.getMissionPath(missionId);
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
     * Execute planned handover from current mission owner to successor.
     */
    async requestHandover(missionId, packet) {
        return await this.lockManager.withLock(`mission_${missionId}`, async () => {
            const mission = await this.getMission(missionId);
            if (!mission) {
                throw new Error(`Mission "${missionId}" not found`);
            }
            if (mission.state === 'TERMINATED') {
                throw new Error(`Mission "${missionId}" is already terminated`);
            }
            if (mission.mission_owner_seat_id !== packet.from_agent) {
                throw new Error(`Unauthorized handover: "${packet.from_agent}" is not current mission_owner ("${mission.mission_owner_seat_id}")`);
            }
            // Increment fencing generation to invalidate previous holder
            const newFencingToken = await this.fencingClock.incrementGeneration(`mission_${missionId}`, packet.to_agent);
            const now = new Date().toISOString();
            const previousOwner = mission.mission_owner_seat_id;
            // Update seats: old owner becomes controller if successor was controller, or swaps
            mission.mission_owner_seat_id = packet.to_agent;
            if (mission.studio_controller_seat_id === packet.to_agent) {
                mission.studio_controller_seat_id = previousOwner;
            }
            mission.state = 'TRANSFERRED';
            mission.current_generation = newFencingToken.generation;
            mission.fencing_token = newFencingToken;
            mission.updated_at = now;
            mission.checkpoints.push({
                timestamp: now,
                author: packet.from_agent,
                summary: `Handover checkpoint: ${packet.checkpoint}. Next move: ${packet.next_move}`,
                data: {
                    open_claims: packet.open_claims,
                    child_tasks: packet.child_tasks,
                    validation_state: packet.validation_state,
                },
            });
            mission.handover_history.push({
                timestamp: now,
                from: packet.from_agent,
                to: packet.to_agent,
                reason: packet.reason ?? 'Planned mission transfer',
                generation: newFencingToken.generation,
            });
            // Switch state back to ACTIVE for the new owner
            mission.state = 'ACTIVE';
            fs.writeFileSync(this.getMissionPath(missionId), JSON.stringify(mission, null, 2), 'utf-8');
            await this.mailboxManager.recordEvent({
                event_id: crypto.randomUUID(),
                timestamp: now,
                event_type: 'mission_handover',
                actor: packet.from_agent,
                resource: missionId,
                details: {
                    from: packet.from_agent,
                    to: packet.to_agent,
                    generation: newFencingToken.generation,
                },
            });
            return {
                success: true,
                mission_id: missionId,
                new_owner: packet.to_agent,
                new_controller: mission.studio_controller_seat_id,
                fencing_token: newFencingToken,
                state: 'ACTIVE',
                timestamp: now,
            };
        });
    }
    /**
     * Execute unplanned recovery when owner fails or lease expires.
     */
    async executeUnplannedRecovery(missionId, controllerId, reason) {
        return await this.lockManager.withLock(`mission_${missionId}`, async () => {
            const mission = await this.getMission(missionId);
            if (!mission) {
                throw new Error(`Mission "${missionId}" not found`);
            }
            if (mission.state === 'TERMINATED') {
                throw new Error(`Mission "${missionId}" is terminated`);
            }
            if (mission.studio_controller_seat_id !== controllerId) {
                throw new Error(`Unauthorized recovery: Seat "${controllerId}" is not registered studio_controller ("${mission.studio_controller_seat_id}")`);
            }
            const previousOwner = mission.mission_owner_seat_id;
            const newFencingToken = await this.fencingClock.incrementGeneration(`mission_${missionId}`, controllerId);
            const now = new Date().toISOString();
            mission.mission_owner_seat_id = controllerId;
            mission.studio_controller_seat_id = `unassigned_controller_${crypto.randomUUID().substring(0, 8)}`;
            mission.state = 'ACTIVE';
            mission.health_state = 'RECONCILED';
            mission.current_generation = newFencingToken.generation;
            mission.fencing_token = newFencingToken;
            mission.updated_at = now;
            mission.checkpoints.push({
                timestamp: now,
                author: controllerId,
                summary: `Unplanned recovery executed by controller: ${reason}`,
            });
            mission.handover_history.push({
                timestamp: now,
                from: previousOwner,
                to: controllerId,
                reason: `Recovery: ${reason}`,
                generation: newFencingToken.generation,
            });
            fs.writeFileSync(this.getMissionPath(missionId), JSON.stringify(mission, null, 2), 'utf-8');
            await this.mailboxManager.recordEvent({
                event_id: crypto.randomUUID(),
                timestamp: now,
                event_type: 'mission_recovery',
                actor: controllerId,
                resource: missionId,
                details: {
                    previous_owner: previousOwner,
                    new_owner: controllerId,
                    reason,
                    generation: newFencingToken.generation,
                },
            });
            return {
                success: true,
                mission_id: missionId,
                new_owner: controllerId,
                new_controller: mission.studio_controller_seat_id,
                fencing_token: newFencingToken,
                state: 'ACTIVE',
                timestamp: now,
            };
        });
    }
    /**
     * Validate if an agent's proposed action is permitted under the Two-Seat contract.
     */
    async validateAction(missionId, agentId, writeScope, presentedToken) {
        const mission = await this.getMission(missionId);
        if (!mission) {
            return { allowed: false, reason: `Mission "${missionId}" does not exist` };
        }
        if (mission.state === 'TERMINATED') {
            return { allowed: false, reason: `Mission "${missionId}" is terminated` };
        }
        const isOwner = mission.mission_owner_seat_id === agentId;
        const isController = mission.studio_controller_seat_id === agentId;
        if (!isOwner && !isController) {
            return {
                allowed: false,
                reason: `Agent "${agentId}" is neither mission_owner nor studio_controller for mission "${missionId}"`,
            };
        }
        const role = isOwner ? 'mission_owner' : 'studio_controller';
        // Fencing token validation if token provided
        if (presentedToken) {
            if (presentedToken.generation !== mission.current_generation) {
                return {
                    allowed: false,
                    role,
                    current_generation: mission.current_generation,
                    token_valid: false,
                    reason: `Stale fencing generation: Presented generation ${presentedToken.generation} is less than active generation ${mission.current_generation}. Writer has been fenced out.`,
                };
            }
        }
        // Safety Rule: Controller cannot countermand or execute writes in active mission scope
        if (isController && writeScope) {
            return {
                allowed: false,
                role,
                current_generation: mission.current_generation,
                reason: `Invariant violation: studio_controller "${agentId}" cannot perform state-mutating writes in mission scope. Writes belong solely to active mission_owner "${mission.mission_owner_seat_id}".`,
            };
        }
        return {
            allowed: true,
            role,
            current_generation: mission.current_generation,
            token_valid: true,
            reason: isOwner ? 'Action permitted: Agent is active mission_owner' : 'Read/Observation permitted: Agent is active studio_controller',
        };
    }
    /**
     * Terminate and close a mission with terminal verification.
     */
    async closeMission(missionId, ownerId, closeoutData) {
        return await this.lockManager.withLock(`mission_${missionId}`, async () => {
            const mission = await this.getMission(missionId);
            if (!mission) {
                throw new Error(`Mission "${missionId}" not found`);
            }
            if (mission.mission_owner_seat_id !== ownerId) {
                throw new Error(`Unauthorized closeout: Only current mission_owner ("${mission.mission_owner_seat_id}") can close mission`);
            }
            const now = new Date().toISOString();
            mission.state = 'TERMINATED';
            mission.closed_at = now;
            mission.updated_at = now;
            mission.checkpoints.push({
                timestamp: now,
                author: ownerId,
                summary: 'Terminal validated mission closeout',
                data: closeoutData,
            });
            fs.writeFileSync(this.getMissionPath(missionId), JSON.stringify(mission, null, 2), 'utf-8');
            await this.mailboxManager.recordEvent({
                event_id: crypto.randomUUID(),
                timestamp: now,
                event_type: 'mission_closed',
                actor: ownerId,
                resource: missionId,
                details: { closeout: closeoutData },
            });
            return mission;
        });
    }
}
exports.TwoSeatProtocol = TwoSeatProtocol;
//# sourceMappingURL=two-seat.js.map