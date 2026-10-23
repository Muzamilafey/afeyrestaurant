import type { ClientSession, Types } from 'mongoose';
import { MpesaC2BTransaction, Payment, Tenant } from '../models';
import { logger } from '../lib/logger';

/**
 * M-Pesa codes taken while a till was offline are saved as provisional. They are confirmed as soon as the matching
 * Till/Paybill (C2B) confirmation from Safaricom is on the server — whichever arrives first: at sync time, or when
 * the confirmation comes in later. The amount received must cover the amount recorded on the sale.
 */
export async function confirmOfflineMpesa(tenantId: Types.ObjectId, code: string, session?: ClientSession) {
  const tx = await MpesaC2BTransaction.findOne({ tenantId, transId: code, status: 'unmatched' }).session(session ?? null);
  if (!tx) return false;
  const payment = await Payment.findOne({ tenantId, method: 'mpesa', reference: code, status: 'provisional' }).session(session ?? null);
  if (!payment) return false;
  if ((tx.amount ?? 0) < payment.amount) {
    logger.warn({ code, received: tx.amount, recorded: payment.amount }, 'Offline M-Pesa code found but the amount received is less than the sale');
    return false;
  }
  payment.set({ status: 'confirmed', verification: 'provider', phone: payment.phone ?? tx.msisdn });
  await payment.save({ session });
  tx.set({ status: 'matched', matchedOrderId: payment.orderId, matchedPaymentId: payment._id });
  await tx.save({ session });
  return true;
}

/** Whether the restaurant allows this payment method while offline (Settings -> Business -> Offline). */
export function offlineMethodAllowed(allowed: string[], method: 'cash' | 'card' | 'mpesa') {
  return allowed.includes(method === 'cash' ? 'cash_payment' : method === 'card' ? 'card_payment' : 'mpesa_payment');
}

/**
 * One-time upgrade: businesses set up before card and M-Pesa could be taken offline had only "cash_payment". If they
 * allowed offline cash, allow offline card and M-Pesa too (they can switch them off in Settings).
 */
export async function upgradeOfflinePaymentSettings() {
  await Tenant.updateMany(
    { 'settings.offlineMethodsUpgraded': { $ne: true }, 'settings.offlineAllowedActions': 'cash_payment' },
    { $addToSet: { 'settings.offlineAllowedActions': { $each: ['card_payment', 'mpesa_payment'] } }, $set: { 'settings.offlineMethodsUpgraded': true } },
  );
  await Tenant.updateMany({ 'settings.offlineMethodsUpgraded': { $ne: true } }, { $set: { 'settings.offlineMethodsUpgraded': true } });
}
