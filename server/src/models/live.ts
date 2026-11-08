import { Schema, model } from 'mongoose';
import { schemaOpts } from './common';

/**
 * On the restaurant's own (local) server: the link to a live server on the internet that receives a copy of all data.
 * The key is stored encrypted; cursors remember, per collection, the last change already sent.
 */
const liveLinkSchema = new Schema(
  {
    tenantId: { type: Schema.Types.ObjectId, ref: 'Tenant', required: true, unique: true },
    url: { type: String, required: true },
    keyEnc: { type: String, required: true, select: false },
    liveName: String,
    linkedAt: { type: Date, default: () => new Date() },
    linkedBy: String,
    enabled: { type: Boolean, default: true },
    /** { [collection]: { t: epoch ms of updatedAt/createdAt, id: last _id sent at that time } } */
    cursors: { type: Schema.Types.Mixed, default: {} },
    lastAttemptAt: Date,
    lastSuccessAt: Date,
    lastCompareAt: Date,
    lastError: String,
    docsSent: { type: Number, default: 0 },
    /** Upload file names (relative to the business folder) already copied to the live server. */
    uploads: { type: [String], default: [] },
  },
  { ...schemaOpts, minimize: false },
);
export const LiveLink = model('LiveLink', liveLinkSchema);

/**
 * On the live server: present once a local server has linked to it. The live server then holds a read-only copy of
 * that business (businessId) and accepts changes only from the holder of the key.
 */
const liveMirrorSchema = new Schema(
  {
    singleton: { type: String, default: 'mirror', unique: true, immutable: true },
    businessId: { type: Schema.Types.ObjectId, required: true },
    keyHash: { type: String, required: true },
    sourceName: String,
    linkedAt: { type: Date, default: () => new Date() },
    lastPushAt: Date,
    docsReceived: { type: Number, default: 0 },
  },
  schemaOpts,
);
export const LiveMirror = model('LiveMirror', liveMirrorSchema);
