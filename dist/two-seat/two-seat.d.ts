/**
 * @nymrel/swarm-protocol - Two-Seat Command Studio Protocol
 * Copyright (c) 2026 Nymrel / JalenBuilds LLC. Licensed under the MIT License.
 */
import { MissionRecord, InitMissionParams, HandoverPacket, HandoverResult, ActionValidationResult, FencingToken } from '../types';
export declare class TwoSeatProtocol {
    private baseDir;
    private lockManager;
    private fencingClock;
    private mailboxManager;
    constructor(swarmRoot: string);
    private ensureDir;
    private getMissionPath;
    /**
     * Initialize a new Two-Seat Command Studio mission.
     */
    initMission(params: InitMissionParams): Promise<MissionRecord>;
    /**
     * Retrieve current mission record.
     */
    getMission(missionId: string): Promise<MissionRecord | null>;
    /**
     * Execute planned handover from current mission owner to successor.
     */
    requestHandover(missionId: string, packet: HandoverPacket): Promise<HandoverResult>;
    /**
     * Execute unplanned recovery when owner fails or lease expires.
     */
    executeUnplannedRecovery(missionId: string, controllerId: string, reason: string): Promise<HandoverResult>;
    /**
     * Validate if an agent's proposed action is permitted under the Two-Seat contract.
     */
    validateAction(missionId: string, agentId: string, writeScope?: string, presentedToken?: FencingToken): Promise<ActionValidationResult>;
    /**
     * Terminate and close a mission with terminal verification.
     */
    closeMission(missionId: string, ownerId: string, closeoutData: Record<string, unknown>): Promise<MissionRecord>;
}
//# sourceMappingURL=two-seat.d.ts.map