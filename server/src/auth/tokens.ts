import jwt from 'jsonwebtoken';
import { randomUUID } from 'node:crypto';
import type { Types } from 'mongoose';
import { env } from '../config/env';
import { RefreshToken } from '../models';
import { randomToken, sha256 } from '../lib/crypto';
import { unauthorized } from '../lib/errors';
import { logger } from '../lib/logger';

export interface AccessClaims {
  sub: string;
  tid: string | null;
  ver: number;
}

export function signAccessToken(user: { _id: Types.ObjectId; tenantId?: Types.ObjectId | null; tokenVersion?: number }) {
  const claims: AccessClaims = { sub: String(user._id), tid: user.tenantId ? String(user.tenantId) : null, ver: user.tokenVersion ?? 0 };
  return jwt.sign(claims, env.JWT_ACCESS_SECRET, { expiresIn: env.JWT_ACCESS_TTL as jwt.SignOptions['expiresIn'], issuer: 'chili-pos', audience: 'chili-pos-api' });
}

export function verifyAccessToken(token: string): AccessClaims {
  try {
    return jwt.verify(token, env.JWT_ACCESS_SECRET, { issuer: 'chili-pos', audience: 'chili-pos-api' }) as AccessClaims;
  } catch {
    throw unauthorized('Invalid or expired access token');
  }
}

export async function issueRefreshToken(userId: Types.ObjectId, meta: { ip?: string; userAgent?: string }, familyId = randomUUID()) {
  const token = randomToken(48);
  await RefreshToken.create({
    userId,
    tokenHash: sha256(token),
    familyId,
    expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86400_000),
    ip: meta.ip,
    userAgent: meta.userAgent?.slice(0, 200),
  });
  return token;
}

const REUSE_GRACE_MS = 30_000;

/**
 * Rotate a refresh token. Reuse of an already-rotated token revokes the whole token family
 * (a strong signal that the token was stolen).
 */
export async function rotateRefreshToken(token: string, meta: { ip?: string; userAgent?: string }) {
  const doc = await RefreshToken.findOne({ tokenHash: sha256(token) });
  if (!doc) throw unauthorized('Invalid refresh token');
  if (doc.revokedAt) {
    // Grace window: two tabs (or a double-mounted app) refreshing at the same moment present the same token.
    // A token rotated seconds ago is a benign race, not theft — reject without revoking the family.
    if (doc.replacedBy && Date.now() - doc.revokedAt.getTime() < REUSE_GRACE_MS) throw unauthorized('Session refreshed in another tab');
    await RefreshToken.updateMany({ familyId: doc.familyId, revokedAt: null }, { $set: { revokedAt: new Date() } });
    logger.warn({ userId: doc.userId, familyId: doc.familyId }, 'Refresh token reuse detected — family revoked');
    throw unauthorized('Session expired, please sign in again');
  }
  if (doc.expiresAt < new Date()) throw unauthorized('Session expired, please sign in again');
  const next = randomToken(48);
  // Atomic claim: only one concurrent rotation of the same token succeeds.
  const claimed = await RefreshToken.findOneAndUpdate(
    { _id: doc._id, revokedAt: null },
    { $set: { revokedAt: new Date(), replacedBy: sha256(next) } },
  );
  if (!claimed) throw unauthorized('Session expired, please sign in again');
  await RefreshToken.create({
    userId: doc.userId,
    tokenHash: sha256(next),
    familyId: doc.familyId,
    expiresAt: new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 86400_000),
    ip: meta.ip,
    userAgent: meta.userAgent?.slice(0, 200),
  });
  return { userId: doc.userId, token: next };
}

export async function revokeRefreshToken(token: string) {
  await RefreshToken.updateOne({ tokenHash: sha256(token), revokedAt: null }, { $set: { revokedAt: new Date() } });
}

export async function revokeAllForUser(userId: Types.ObjectId) {
  await RefreshToken.updateMany({ userId, revokedAt: null }, { $set: { revokedAt: new Date() } });
}
