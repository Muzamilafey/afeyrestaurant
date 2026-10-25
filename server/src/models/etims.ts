import { Schema, model } from 'mongoose';
import { schemaOpts, tenantRef } from './common';

/**
 * KRA eTIMS (OSCU). Every paid sale and every refund becomes an invoice signed by KRA. Invoice numbers (`invcNo`)
 * must start at 1 and rise by exactly one per KRA branch, so a number is given out once, in the order sales were
 * paid, and a failed invoice is resent with the same number until KRA accepts it.
 */
const etimsInvoiceSchema = new Schema(
  {
    tenantId: tenantRef,
    branchId: { type: Schema.Types.ObjectId, required: true },
    /** KRA PIN + branch the number belongs to ("P051234567A-00"). */
    series: { type: String, required: true },
    invcNo: { type: Number, required: true },
    kind: { type: String, enum: ['sale', 'credit_note'], required: true },
    orderId: { type: Schema.Types.ObjectId, required: true, index: true },
    orderNumber: String,
    receiptNumber: String,
    /** For a credit note: the refund it reports and the sale invoice it credits. */
    refundId: Schema.Types.ObjectId,
    orgInvcNo: Number,
    amount: { type: Number, required: true }, // cents, as reported to KRA
    status: { type: String, enum: ['queued', 'signed', 'rejected', 'duplicate'], default: 'queued', index: true },
    attempts: { type: Number, default: 0 },
    nextAttemptAt: { type: Date, default: () => new Date() },
    lastError: String,
    lastResultCd: String,
    simulated: { type: Boolean, default: false },
    /** KRA's signature, printed on the receipt. */
    result: {
      sdcId: String,
      curRcptNo: Number,
      totRcptNo: Number,
      intrlData: String,
      rcptSign: String,
      sdcDateTime: String,
      mrcNo: String,
    },
    qrUrl: String,
    signedAt: Date,
  },
  schemaOpts,
);
etimsInvoiceSchema.index({ tenantId: 1, series: 1, invcNo: 1 }, { unique: true });
etimsInvoiceSchema.index({ tenantId: 1, kind: 1, orderId: 1, refundId: 1 }, { unique: true });
etimsInvoiceSchema.index({ tenantId: 1, status: 1, nextAttemptAt: 1 });
export const EtimsInvoice = model('EtimsInvoice', etimsInvoiceSchema);

/** Items registered with KRA (products, plus "Service charge" and "Delivery fee"). */
const etimsItemSchema = new Schema(
  {
    tenantId: tenantRef,
    series: { type: String, required: true },
    /** product:<id> | fee:service_charge | fee:delivery */
    key: { type: String, required: true },
    itemCd: { type: String, required: true },
    itemClsCd: String,
    taxTyCd: String,
    name: String,
    /** What was last registered; a change (name, class, tax) registers the item again. */
    hash: String,
    registeredAt: Date,
  },
  schemaOpts,
);
etimsItemSchema.index({ tenantId: 1, series: 1, key: 1 }, { unique: true });
export const EtimsItem = model('EtimsItem', etimsItemSchema);

/** Running numbers per KRA PIN + branch. */
const etimsCounterSchema = new Schema(
  {
    tenantId: tenantRef,
    series: { type: String, required: true },
    lastInvcNo: { type: Number, default: 0 },
    lastItemSeq: { type: Number, default: 0 },
  },
  schemaOpts,
);
etimsCounterSchema.index({ tenantId: 1, series: 1 }, { unique: true });
export const EtimsCounter = model('EtimsCounter', etimsCounterSchema);
