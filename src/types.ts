/**
 * @nymrel/swarm-protocol - Core Type Definitions
 * Copyright (c) 2026 Nymrel / JalenBuilds LLC. Licensed under the MIT License.
 */

export type ClaimMode = 'exclusive' | 'shared';

export type ClaimStatus = 'active' | 'expired' | 'released' | 'revoked';

export interface FencingToken {
  resource_id: string;
  generation: number;
  token: string;
  issued_at: string;
  claimant: string;
}

export interface FencingState {
  resource_id: string;
  current_generation: number;
  current_token: string;
  holder: string;
  updated_at: string;
}

export interface EnvelopeHeader {
  id: string;
  version: string; // '2.0'
  timestamp: string;
  sender: string;
  recipient: string; // agent_id | 'broadcast' | 'all'
  topic: string;
  correlation_id?: string;
  fencing?: FencingToken;
}

export interface EnvelopeV2<T = Record<string, unknown>> {
  header: EnvelopeHeader;
  payload: T;
  checksum: string; // SHA-256 integrity hash
}

export interface ClaimRecord {
  claim_id: string;
  resource_path: string;
  owner_agent: string;
  mode: ClaimMode;
  status: ClaimStatus;
  fencing_generation: number;
  lease_duration_ms: number;
  acquired_at: string;
  expires_at: string;
  heartbeat_at: string;
  metadata?: Record<string, unknown>;
}

export interface AcquireClaimParams {
  resource_path: string;
  owner_agent: string;
  mode?: ClaimMode;
  lease_duration_ms?: number;
  metadata?: Record<string, unknown>;
}

export interface ClaimFilter {
  owner_agent?: string;
  resource_path?: string;
  mode?: ClaimMode;
  status?: ClaimStatus;
  include_expired?: boolean;
}

export type TwoSeatRole = 'mission_owner' | 'studio_controller';

export type MissionState =
  | 'INIT'
  | 'ACTIVE'
  | 'TRANSFER_REQUESTED'
  | 'TRANSFERRED'
  | 'RECOVERING'
  | 'TERMINATED';

export type HealthState =
  | 'HEALTHY'
  | 'SUSPECT'
  | 'STALE'
  | 'LEASE_EXPIRED'
  | 'RECOVERING'
  | 'RECONCILED';

export interface HandoverPacket {
  from_agent: string;
  to_agent: string;
  checkpoint: string;
  open_claims: string[];
  child_tasks: string[];
  validation_state: Record<string, unknown>;
  next_move: string;
  reason?: string;
}

export interface HandoverResult {
  success: boolean;
  mission_id: string;
  new_owner: string;
  new_controller: string;
  fencing_token: FencingToken;
  state: MissionState;
  timestamp: string;
  error?: string;
}

export interface MissionRecord {
  mission_id: string;
  mission_owner_seat_id: string;
  studio_controller_seat_id: string;
  state: MissionState;
  health_state: HealthState;
  current_generation: number;
  fencing_token: FencingToken;
  active_claims: string[];
  checkpoints: Array<{
    timestamp: string;
    author: string;
    summary: string;
    data?: Record<string, unknown>;
  }>;
  handover_history: Array<{
    timestamp: string;
    from: string;
    to: string;
    reason: string;
    generation: number;
  }>;
  created_at: string;
  updated_at: string;
  closed_at?: string;
}

export interface InitMissionParams {
  mission_id: string;
  mission_owner_seat_id: string;
  studio_controller_seat_id: string;
  initial_checkpoint?: string;
}

export interface ActionValidationResult {
  allowed: boolean;
  reason: string;
  role?: TwoSeatRole;
  current_generation?: number;
  token_valid?: boolean;
}

export interface BusEvent {
  event_id: string;
  timestamp: string;
  event_type:
    | 'claim_acquired'
    | 'claim_released'
    | 'claim_expired'
    | 'claim_heartbeat'
    | 'message_sent'
    | 'message_broadcast'
    | 'message_delivered'
    | 'fencing_incremented'
    | 'mission_initialized'
    | 'mission_handover'
    | 'mission_recovery'
    | 'mission_closed';
  actor: string;
  resource?: string;
  details: Record<string, unknown>;
}

export interface LockOptions {
  timeout_ms?: number;
  retry_interval_ms?: number;
  stale_threshold_ms?: number;
}

export interface LockHandle {
  lock_name: string;
  lock_path: string;
  acquired_at: number;
  pid: number;
}

export interface SwarmConfig {
  swarm_root: string;
  default_lease_ms?: number;
  heartbeat_interval_ms?: number;
  lock_timeout_ms?: number;
}

export interface AdapterConfig {
  agent_id: string;
  agent_name: string;
  role?: string;
  platform: 'claude-code' | 'codex-cli' | 'gemini-cli' | 'cursor-composer' | 'ollama-local' | 'custom';
  swarm_root: string;
  auto_heartbeat?: boolean;
  heartbeat_interval_ms?: number;
}
