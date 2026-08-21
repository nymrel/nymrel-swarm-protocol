/**
 * @nymrel/swarm-protocol
 * Zero-dependency, dual-language Multi-Agent Swarm Protocol, Two-Seat Command Studio Contract,
 * and File-Based Bus Engine for autonomous multi-agent swarms.
 *
 * Copyright (c) 2026 Nymrel / JalenBuilds LLC. Licensed under the MIT License.
 */
export * from './types';
export { AtomicLockManager } from './fencing/lock';
export { FencingClock } from './fencing/fencing';
export { EnvelopeEngine, CreateEnvelopeParams } from './bus/envelope';
export { FileMailboxManager, ReceiveOptions } from './bus/mailbox';
export { ClaimManager } from './claims/claims';
export { TwoSeatProtocol } from './two-seat/two-seat';
export { BaseAgentAdapter, ClaudeCodeAdapter, CodexCliAdapter, GeminiCliAdapter, CursorComposerAdapter, OllamaAdapter, createAdapter, } from './adapters/adapters';
export { runCli } from './cli';
//# sourceMappingURL=index.d.ts.map