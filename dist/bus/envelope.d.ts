/**
 * @nymrel/swarm-protocol - Strongly-typed JSON Envelope v2
 * Copyright (c) 2026 Nymrel / JalenBuilds LLC. Licensed under the MIT License.
 */
import { EnvelopeV2, EnvelopeHeader, FencingToken } from '../types';
export interface CreateEnvelopeParams<T = Record<string, unknown>> {
    sender: string;
    recipient: string;
    topic: string;
    payload: T;
    correlation_id?: string;
    fencing?: FencingToken;
}
export declare class EnvelopeEngine {
    /**
     * Compute a deterministic SHA-256 integrity hash for an envelope.
     */
    static computeChecksum(header: EnvelopeHeader, payload: unknown): string;
    /**
     * Create a new Envelope v2 with cryptographic integrity verification.
     */
    static create<T = Record<string, unknown>>(params: CreateEnvelopeParams<T>): EnvelopeV2<T>;
    /**
     * Verify the structural integrity and SHA-256 signature of an Envelope v2.
     */
    static verify(envelope: unknown): envelope is EnvelopeV2;
    /**
     * Serialize an envelope to formatted JSON string.
     */
    static serialize<T>(envelope: EnvelopeV2<T>): string;
    /**
     * Deserialize and verify an envelope from raw JSON string.
     */
    static deserialize<T = Record<string, unknown>>(raw: string): EnvelopeV2<T>;
}
//# sourceMappingURL=envelope.d.ts.map