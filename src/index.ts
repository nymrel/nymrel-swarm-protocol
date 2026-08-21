/**
 * @nymrel/swarm-protocol
 * Zero-dependency, dual-language Multi-Agent Swarm Protocol, Two-Seat Command Studio Contract,
 * and File-Based Bus Engine for autonomous multi-agent swarms.
 *
 * Copyright (c) 2026 Nymrel / JalenBuilds LLC. Licensed under the MIT License.
 */

// Core Types
export * from './types';

// Fencing & Atomic Locking
export { AtomicLockManager } from './fencing/lock';
export { FencingClock } from './fencing/fencing';

// Bus & Mailbox Messaging
export { EnvelopeEngine, CreateEnvelopeParams } from './bus/envelope';
export { FileMailboxManager, ReceiveOptions } from './bus/mailbox';

// Resource Claims & Leases
export { ClaimManager } from './claims/claims';

// Two-Seat Command Studio Protocol
export { TwoSeatProtocol } from './two-seat/two-seat';

// Multi-Agent Platform Adapters
export {
  BaseAgentAdapter,
  ClaudeCodeAdapter,
  CodexCliAdapter,
  GeminiCliAdapter,
  CursorComposerAdapter,
  OllamaAdapter,
  createAdapter,
} from './adapters/adapters';

// CLI entrypoint runner
export { runCli } from './cli';
