/**
 * Nymrel Mesh delivery truth ledger.
 *
 * A sender-side success is never allowed to stand in for recipient observation
 * or verified task completion. One tamper-evident receipt is persisted for
 * every (message_id, recipient) pair.
 */
export declare const DELIVERY_RECEIPT_VERSION: '1.0';
export declare const DELIVERY_STATES: readonly ['created', 'accepted', 'routed', 'deferred', 'delivered', 'observed', 'acted', 'verified', 'delivery_unknown', 'expired', 'dead_lettered', 'revoked', 'rejected'];
export type DeliveryState = (typeof DELIVERY_STATES)[number];
export declare const DELIVERY_EVIDENCE_KINDS: readonly ['receipt_created', 'outbox_persisted', 'route_selected', 'mailbox_persisted', 'runtime_observed', 'agent_action', 'verification', 'reconciliation', 'operator_decision'];
export type DeliveryEvidenceKind = (typeof DELIVERY_EVIDENCE_KINDS)[number];
export declare const DELIVERY_REASON_CODES: readonly ['local_persistence_failed', 'recipient_evidence_reconciled', 'transport_result_ambiguous', 'explicit_reconciliation', 'deadline_expired', 'delivery_dead_lettered', 'authority_revoked', 'recipient_rejected'];
export type DeliveryReasonCode = (typeof DELIVERY_REASON_CODES)[number];
export interface DeliveryEvidence {
    kind: DeliveryEvidenceKind;
    reference: string;
    sha256?: string;
}
export interface DeliveryTransition {
    sequence: number;
    from: DeliveryState | null;
    to: DeliveryState;
    actor: string;
    at: string;
    evidence?: DeliveryEvidence;
    reason_code?: DeliveryReasonCode;
    previous_hash: string | null;
    hash: string;
}
export interface DeliveryReceipt {
    version: typeof DELIVERY_RECEIPT_VERSION;
    message_id: string;
    recipient: string;
    current_state: DeliveryState;
    created_at: string;
    updated_at: string;
    chain_hash: string;
    transitions: DeliveryTransition[];
}
export interface CreateDeliveryReceiptParams {
    message_id: string;
    recipient: string;
    actor: string;
    at?: string;
    evidence?: DeliveryEvidence;
    reason_code?: DeliveryReasonCode;
}
export interface TransitionDeliveryParams {
    message_id: string;
    recipient: string;
    to: DeliveryState;
    actor: string;
    at?: string;
    evidence?: DeliveryEvidence;
    reason_code?: DeliveryReasonCode;
}
export declare class DeliveryReceiptConflictError extends Error {
}
export declare class DeliveryLedger {
    private readonly receiptsDir;
    private readonly lockManager;
    constructor(swarmRoot: string);
    static isTerminal(state: DeliveryState): boolean;
    static canTransition(from: DeliveryState, to: DeliveryState): boolean;
    static computeTransitionHash(messageId: string, recipient: string, transition: Omit<DeliveryTransition, 'hash'>): string;
    static verifyReceipt(receipt: unknown): receipt is DeliveryReceipt;
    create(params: CreateDeliveryReceiptParams): Promise<DeliveryReceipt>;
    transition(params: TransitionDeliveryParams): Promise<DeliveryReceipt>;
    get(messageId: string, recipient: string): DeliveryReceipt | null;
    list(messageId?: string): DeliveryReceipt[];
    private static assertReceipt;
    private assertIdentity;
    private assertState;
    private digest;
    private getReceiptPath;
    private getLockName;
    private readReceipt;
    private writeReceipt;
}
//# sourceMappingURL=delivery.d.ts.map