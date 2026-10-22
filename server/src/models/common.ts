import { Schema, Types } from 'mongoose';

export const tenantRef = { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, index: true } as const;
export const branchRef = { type: Schema.Types.ObjectId, ref: 'Branch', required: true, index: true } as const;
export const optBranchRef = { type: Schema.Types.ObjectId, ref: 'Branch', index: true } as const;
export const userRef = { type: Schema.Types.ObjectId, ref: 'User' } as const;
/** Money in integer minor units (cents). */
export const money = { type: Number, required: true, default: 0, validate: { validator: Number.isInteger, message: 'Money must be an integer number of cents' } } as const;
export const optMoney = { type: Number, validate: { validator: (v: unknown) => v == null || Number.isInteger(v), message: 'Money must be an integer number of cents' } } as const;

export const schemaOpts = { timestamps: true, versionKey: '__v' as const, optimisticConcurrency: false };

export type Id = Types.ObjectId;
export const oid = (v: string | Types.ObjectId) => (typeof v === 'string' ? new Types.ObjectId(v) : v);
export const isOid = (v: unknown): v is string => typeof v === 'string' && Types.ObjectId.isValid(v) && /^[a-f0-9]{24}$/i.test(v);
