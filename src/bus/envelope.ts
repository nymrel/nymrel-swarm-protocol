/**
 * @nymrel/swarm-protocol - Strongly-typed JSON Envelope v2
 * Copyright (c) 2026 Nymrel / JalenBuilds LLC. Licensed under the MIT License.
 */

import * as crypto from 'node:crypto';
import { EnvelopeV2, EnvelopeHeader, FencingToken } from '../types';

export interface CreateEnvelopeParams<T = Record<string, unknown>> {
  sender: string;
  recipient: string;
  topic: string;
  payload: T;
  correlation_id?: string;
  fencing?: FencingToken;
}

export class EnvelopeEngine {
  /**
   * Compute a deterministic SHA-256 integrity hash for an envelope.
   */
  static computeChecksum(header: EnvelopeHeader, payload: unknown): string {
    const payloadStr = typeof payload === 'string' ? payload : JSON.stringify(payload);
    const content = `${header.id}|${header.version}|${header.timestamp}|${header.sender}|${header.recipient}|${header.topic}|${payloadStr}`;
    return crypto.createHash('sha256').update(content).digest('hex');
  }

  /**
   * Create a new Envelope v2 with cryptographic integrity verification.
   */
  static create<T = Record<string, unknown>>(params: CreateEnvelopeParams<T>): EnvelopeV2<T> {
    const header: EnvelopeHeader = {
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
  static verify(envelope: unknown): envelope is EnvelopeV2 {
    if (!envelope || typeof envelope !== 'object') {
      return false;
    }

    const env = envelope as Partial<EnvelopeV2>;
    if (!env.header || !env.checksum) {
      return false;
    }

    const h = env.header;
    if (
      !h.id ||
      h.version !== '2.0' ||
      !h.timestamp ||
      !h.sender ||
      !h.recipient ||
      !h.topic
    ) {
      return false;
    }

    const expectedChecksum = this.computeChecksum(h, env.payload);
    return expectedChecksum === env.checksum;
  }

  /**
   * Serialize an envelope to formatted JSON string.
   */
  static serialize<T>(envelope: EnvelopeV2<T>): string {
    return JSON.stringify(envelope, null, 2);
  }

  /**
   * Deserialize and verify an envelope from raw JSON string.
   */
  static deserialize<T = Record<string, unknown>>(raw: string): EnvelopeV2<T> {
    const parsed = JSON.parse(raw);
    if (!this.verify(parsed)) {
      throw new Error('Invalid Envelope v2: Integrity checksum mismatch or invalid structure');
    }
    return parsed as EnvelopeV2<T>;
  }
}
