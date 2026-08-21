"use strict";
/**
 * @nymrel/swarm-protocol - Strongly-typed JSON Envelope v2
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
exports.EnvelopeEngine = void 0;
const crypto = __importStar(require("node:crypto"));
class EnvelopeEngine {
    /**
     * Compute a deterministic SHA-256 integrity hash for an envelope.
     */
    static computeChecksum(header, payload) {
        const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
        const content = `${header.id}|${header.version}|${header.timestamp}|${header.sender}|${header.recipient}|${header.topic}|${payloadStr}`;
        return crypto.createHash('sha256').update(content).digest('hex');
    }
    /**
     * Create a new Envelope v2 with cryptographic integrity verification.
     */
    static create(params) {
        const header = {
            id: crypto.randomUUID(),
            version: '2.0',
            timestamp: new Date().toISOString(),
            sender: params.sender,
            recipient: params.recipient,
            topic: params.topic,
        };
        if (params.correlation_id !== undefined) {
            header.correlation_id = params.correlation_id;
        }
        if (params.fencing !== undefined) {
            header.fencing = params.fencing;
        }
        const checksum = this.computeChecksum(header, params.payload);
        return {
            header,
            payload: params.payload,
            checksum,
        };
    }
    /**
     * Verify the structural integrity and SHA-256 signature of an Envelope v2.
     */
    static verify(envelope) {
        if (!envelope || typeof envelope !== 'object') {
            return false;
        }
        const env = envelope;
        if (!env.header || !env.checksum) {
            return false;
        }
        const h = env.header;
        if (!h.id ||
            h.version !== '2.0' ||
            !h.timestamp ||
            !h.sender ||
            !h.recipient ||
            !h.topic) {
            return false;
        }
        const expectedChecksum = this.computeChecksum(h, env.payload);
        return expectedChecksum === env.checksum;
    }
    /**
     * Serialize an envelope to formatted JSON string.
     */
    static serialize(envelope) {
        return JSON.stringify(envelope, null, 2);
    }
    /**
     * Deserialize and verify an envelope from raw JSON string.
     */
    static deserialize(raw) {
        const parsed = JSON.parse(raw);
        if (!this.verify(parsed)) {
            throw new Error('Invalid Envelope v2: Integrity checksum mismatch or invalid structure');
        }
        return parsed;
    }
}
exports.EnvelopeEngine = EnvelopeEngine;
//# sourceMappingURL=envelope.js.map