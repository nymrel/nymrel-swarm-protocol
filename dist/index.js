"use strict";
/**
 * @nymrel/swarm-protocol
 * Zero-dependency, dual-language Multi-Agent Swarm Protocol, Two-Seat Command Studio Contract,
 * and File-Based Bus Engine for autonomous multi-agent swarms.
 *
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
var __exportStar = (this && this.__exportStar) || function(m, exports) {
    for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports, p)) __createBinding(exports, m, p);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.runCli = exports.createAdapter = exports.OllamaAdapter = exports.CursorComposerAdapter = exports.GeminiCliAdapter = exports.CodexCliAdapter = exports.ClaudeCodeAdapter = exports.BaseAgentAdapter = exports.TwoSeatProtocol = exports.ClaimManager = exports.EnvelopeConflictError = exports.FileMailboxManager = exports.EnvelopeEngine = exports.DELIVERY_REASON_CODES = exports.DELIVERY_EVIDENCE_KINDS = exports.DELIVERY_STATES = exports.DELIVERY_RECEIPT_VERSION = exports.DeliveryReceiptConflictError = exports.DeliveryLedger = exports.FencingClock = exports.AtomicLockManager = void 0;
// Core Types
__exportStar(require("./types"), exports);
// Fencing & Atomic Locking
var lock_1 = require("./fencing/lock");
Object.defineProperty(exports, "AtomicLockManager", { enumerable: true, get: function () { return lock_1.AtomicLockManager; } });
var fencing_1 = require("./fencing/fencing");
Object.defineProperty(exports, "FencingClock", { enumerable: true, get: function () { return fencing_1.FencingClock; } });
// Delivery Truth
var delivery_1 = require("./delivery/delivery");
Object.defineProperty(exports, "DeliveryLedger", { enumerable: true, get: function () { return delivery_1.DeliveryLedger; } });
Object.defineProperty(exports, "DeliveryReceiptConflictError", { enumerable: true, get: function () { return delivery_1.DeliveryReceiptConflictError; } });
Object.defineProperty(exports, "DELIVERY_RECEIPT_VERSION", { enumerable: true, get: function () { return delivery_1.DELIVERY_RECEIPT_VERSION; } });
Object.defineProperty(exports, "DELIVERY_STATES", { enumerable: true, get: function () { return delivery_1.DELIVERY_STATES; } });
Object.defineProperty(exports, "DELIVERY_EVIDENCE_KINDS", { enumerable: true, get: function () { return delivery_1.DELIVERY_EVIDENCE_KINDS; } });
Object.defineProperty(exports, "DELIVERY_REASON_CODES", { enumerable: true, get: function () { return delivery_1.DELIVERY_REASON_CODES; } });
// Bus & Mailbox Messaging
var envelope_1 = require("./bus/envelope");
Object.defineProperty(exports, "EnvelopeEngine", { enumerable: true, get: function () { return envelope_1.EnvelopeEngine; } });
var mailbox_1 = require("./bus/mailbox");
Object.defineProperty(exports, "FileMailboxManager", { enumerable: true, get: function () { return mailbox_1.FileMailboxManager; } });
Object.defineProperty(exports, "EnvelopeConflictError", { enumerable: true, get: function () { return mailbox_1.EnvelopeConflictError; } });
// Resource Claims & Leases
var claims_1 = require("./claims/claims");
Object.defineProperty(exports, "ClaimManager", { enumerable: true, get: function () { return claims_1.ClaimManager; } });
// Two-Seat Command Studio Protocol
var two_seat_1 = require("./two-seat/two-seat");
Object.defineProperty(exports, "TwoSeatProtocol", { enumerable: true, get: function () { return two_seat_1.TwoSeatProtocol; } });
// Multi-Agent Platform Adapters
var adapters_1 = require("./adapters/adapters");
Object.defineProperty(exports, "BaseAgentAdapter", { enumerable: true, get: function () { return adapters_1.BaseAgentAdapter; } });
Object.defineProperty(exports, "ClaudeCodeAdapter", { enumerable: true, get: function () { return adapters_1.ClaudeCodeAdapter; } });
Object.defineProperty(exports, "CodexCliAdapter", { enumerable: true, get: function () { return adapters_1.CodexCliAdapter; } });
Object.defineProperty(exports, "GeminiCliAdapter", { enumerable: true, get: function () { return adapters_1.GeminiCliAdapter; } });
Object.defineProperty(exports, "CursorComposerAdapter", { enumerable: true, get: function () { return adapters_1.CursorComposerAdapter; } });
Object.defineProperty(exports, "OllamaAdapter", { enumerable: true, get: function () { return adapters_1.OllamaAdapter; } });
Object.defineProperty(exports, "createAdapter", { enumerable: true, get: function () { return adapters_1.createAdapter; } });
// CLI entrypoint runner
var cli_1 = require("./cli");
Object.defineProperty(exports, "runCli", { enumerable: true, get: function () { return cli_1.runCli; } });
//# sourceMappingURL=index.js.map