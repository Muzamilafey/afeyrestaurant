import { Schema, model, InferSchemaType, HydratedDocument } from 'mongoose';
import { schemaOpts, tenantRef, branchRef, money } from './common';

export const PAYMENT_METHODS = ['cash', 'mpesa', 'card', 'qr', 'account', 'voucher', 'complimentary'] as const;

/**
 * One attempt to collect money (e.g. a single STK Push). An attempt only becomes a Payment once the
 * provider confirms it. Attempts track the provider lifecycle including late/duplicate callbacks.
 */
const paymentAttemptSchema = new Schema(
  {
    tenantId: tenantRef,
    branchId: branchRef,
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true, index: true },
    method: { type: String, enum: PAYMENT_METHODS, required: true },
    amount: money,
    phone: String,
    idempotencyKey: { type: String, required: true },
    status: { type: String, enum: ['initiated', 'pending', 'succeeded', 'failed', 'cancelled', 'timeout', 'error'], default: 'initiated', index: true },
    provider: { type: String, enum: ['daraja', 'mock', 'manual', 'none'], default: 'none' },
    environment: { type: String, enum: ['sandbox', 'production', 'mock'] },
    merchantRequestId: String,
    checkoutRequestId: String,
    /** Unguessable token embedded in the callback URL — callbacks must present it. */
    callbackTokenHash: String,
    resultCode: Number,
    resultDesc: String,
    mpesaReceipt: String,
    providerAmount: Number,
    providerPhone: String,
    providerTransactionDate: String,
    callbackCount: { type: Number, default: 0 },
    lastCallbackAt: Date,
    queryCount: { type: Number, default: 0 },
    lastQueryAt: Date,
    expiresAt: Date,
    paymentId: Schema.Types.ObjectId,
    initiatedBy: Schema.Types.ObjectId,
    error: String,
    /** Registered M-Pesa name of the payer, from Safaricom's Transaction Status API (DebitPartyName). */
    payerName: String,
    /** Part of `amount` that is a tip (the prompt asks for bill + tip in one go). */
    tip: { ...money },
    /** The name lookup: requested -> received | failed | unavailable (not configured / not reachable). */
    nameLookup: {
      status: { type: String, enum: ['requested', 'received', 'failed', 'unavailable'] },
      tokenHash: String,
      requestedAt: Date,
      receivedAt: Date,
      error: String,
    },
  },
  schemaOpts,
);
paymentAttemptSchema.index({ tenantId: 1, idempotencyKey: 1 }, { unique: true });
paymentAttemptSchema.index({ checkoutRequestId: 1 }, { unique: true, partialFilterExpression: { checkoutRequestId: { $type: 'string' } } });
export const PaymentAttempt = model('PaymentAttempt', paymentAttemptSchema);
export type PaymentAttemptDoc = HydratedDocument<InferSchemaType<typeof paymentAttemptSchema>>;

/**
 * Immutable ledger of confirmed money received. Never updated after creation except for the
 * `refundedAmount` running total; corrections are separate Refund documents.
 */
const paymentSchema = new Schema(
  {
    tenantId: tenantRef,
    branchId: branchRef,
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', required: true, index: true },
    orderNumber: String,
    attemptId: Schema.Types.ObjectId,
    method: { type: String, enum: PAYMENT_METHODS, required: true },
    amount: money, // amount applied to the order
    tendered: { ...money }, // cash handed over
    change: { ...money },
    reference: String, // M-Pesa receipt, card approval code, etc.
    phone: String,
    /** M-Pesa: the payer's registered name (Transaction Status API or the C2B confirmation). */
    payerName: String,
    /** Tip given with this payment — not part of the sale (not in `amount`), credited to the waiter. */
    tip: { ...money },
    tipFor: { userId: Schema.Types.ObjectId, name: String },
    customerId: Schema.Types.ObjectId,
    status: { type: String, enum: ['confirmed', 'provisional'], default: 'confirmed' },
    /** provider | manual | cash | offline_cash | offline_mpesa (code typed in while offline, confirmed against C2B) */
    verification: { type: String, enum: ['provider', 'stk_query', 'manual', 'cash', 'offline_cash', 'offline_mpesa'], required: true },
    /** An offline M-Pesa code that was already used on another sale (kept for review instead of losing the sale). */
    claimedReference: String,
    manualConfirmation: { by: Schema.Types.ObjectId, reason: String },
    refundedAmount: { ...money },
    receivedBy: Schema.Types.ObjectId,
    cashSessionId: Schema.Types.ObjectId,
    idempotencyKey: { type: String, required: true },
    receivedAt: { type: Date, default: Date.now },
  },
  schemaOpts,
);
paymentSchema.index({ tenantId: 1, idempotencyKey: 1 }, { unique: true });
paymentSchema.index({ tenantId: 1, method: 1, reference: 1 }, { unique: true, partialFilterExpression: { method: 'mpesa', reference: { $type: 'string' } } });
paymentSchema.index({ tenantId: 1, branchId: 1, receivedAt: -1 });
export const Payment = model('Payment', paymentSchema);

const refundSchema = new Schema(
  {
    tenantId: tenantRef,
    branchId: branchRef,
    orderId: { type: Schema.Types.ObjectId, required: true, index: true },
    paymentId: { type: Schema.Types.ObjectId, required: true },
    method: { type: String, enum: PAYMENT_METHODS, required: true },
    amount: money,
    reason: { type: String, required: true },
    status: { type: String, enum: ['pending', 'completed', 'failed'], default: 'completed' },
    reference: String,
    requestedBy: Schema.Types.ObjectId,
    approvedBy: Schema.Types.ObjectId,
    restock: { type: Boolean, default: false },
    idempotencyKey: { type: String, required: true },
  },
  schemaOpts,
);
refundSchema.index({ tenantId: 1, idempotencyKey: 1 }, { unique: true });
export const Refund = model('Refund', refundSchema);

const cashSessionSchema = new Schema(
  {
    tenantId: tenantRef,
    branchId: branchRef,
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    userName: String,
    terminal: String,
    /** Branch-wide drawer used by everyone (cashDrawerMode 'shared'); userId/userName is who opened it. */
    shared: { type: Boolean, default: false },
    status: { type: String, enum: ['open', 'closed'], default: 'open', index: true },
    openingFloat: money,
    openedAt: { type: Date, default: Date.now },
    closedAt: Date,
    countedCash: Number,
    expectedCash: Number,
    variance: Number,
    denominations: [{ value: Number, count: Number }],
    totals: { cashSales: Number, cashRefunds: Number, drops: Number, expenses: Number, payIns: Number, mpesa: Number, card: Number, other: Number, cashTips: Number, tips: Number },
    closingNotes: String,
    closedBy: Schema.Types.ObjectId,
  },
  schemaOpts,
);
// One open drawer per cashier per branch.
cashSessionSchema.index({ tenantId: 1, branchId: 1, userId: 1 }, { unique: true, partialFilterExpression: { status: 'open' } });
// At most one open shared drawer per branch.
cashSessionSchema.index({ tenantId: 1, branchId: 1, shared: 1 }, { unique: true, partialFilterExpression: { status: 'open', shared: true } });
export const CashSession = model('CashSession', cashSessionSchema);

const cashMovementSchema = new Schema(
  {
    tenantId: tenantRef,
    branchId: branchRef,
    sessionId: { type: Schema.Types.ObjectId, required: true, index: true },
    type: { type: String, enum: ['drop', 'pay_in', 'expense', 'payout'], required: true },
    amount: money,
    reason: { type: String, required: true },
    by: Schema.Types.ObjectId,
    expenseId: Schema.Types.ObjectId,
  },
  schemaOpts,
);
export const CashMovement = model('CashMovement', cashMovementSchema);

const expenseSchema = new Schema(
  {
    tenantId: tenantRef,
    branchId: branchRef,
    category: { type: String, required: true },
    description: String,
    amount: money,
    paidFrom: { type: String, enum: ['cash_drawer', 'mpesa', 'bank', 'petty_cash', 'other'], default: 'petty_cash' },
    supplierId: Schema.Types.ObjectId,
    reference: String,
    date: { type: Date, default: Date.now, index: true },
    recordedBy: Schema.Types.ObjectId,
    cashSessionId: Schema.Types.ObjectId,
    reversedBy: Schema.Types.ObjectId,
    reversalOf: Schema.Types.ObjectId,
  },
  schemaOpts,
);
export const Expense = model('Expense', expenseSchema);

/** C2B (Paybill/Till) confirmations received from Daraja — matched to orders by the cashier or by bill reference. */
const c2bSchema = new Schema(
  {
    tenantId: tenantRef,
    branchId: { type: Schema.Types.ObjectId },
    transId: { type: String, required: true },
    transType: String,
    amount: money,
    shortCode: String,
    billRef: String,
    msisdn: String, // may be hashed by Safaricom on newer API versions
    firstName: String,
    /** First, middle and last name from the C2B confirmation. */
    payerName: String,
    transTime: String,
    status: { type: String, enum: ['unmatched', 'matched', 'ignored'], default: 'unmatched', index: true },
    matchedOrderId: Schema.Types.ObjectId,
    matchedPaymentId: Schema.Types.ObjectId,
    matchedBy: Schema.Types.ObjectId,
    raw: Schema.Types.Mixed,
  },
  schemaOpts,
);
c2bSchema.index({ tenantId: 1, transId: 1 }, { unique: true });
export const MpesaC2BTransaction = model('MpesaC2BTransaction', c2bSchema);
