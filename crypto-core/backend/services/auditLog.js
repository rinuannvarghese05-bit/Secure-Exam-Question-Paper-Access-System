'use strict';

const crypto = require('crypto');
const AuditLog = require('../models/AuditLog');

const GENESIS_HASH = '0'.repeat(64);

/**
 * Deterministically stringify the fields that go into a hash so re-computing
 * later (verifyChain) matches exactly what was hashed at write time.
 */
function canonicalize(entry) {
  return JSON.stringify({
    action: entry.action,
    actor: entry.actor ? entry.actor.toString() : null,
    paperId: entry.paperId ? entry.paperId.toString() : null,
    details: entry.details || {},
    timestamp: entry.timestamp.toISOString(),
    prevHash: entry.prevHash,
  });
}

function computeHash(entry) {
  return crypto.createHash('sha256').update(canonicalize(entry)).digest('hex');
}

/**
 * Append a new audit entry, chained to the previous one.
 * Call this for EVERY action Person C's routes perform: upload, approval
 * submitted, unlock attempt (success or failure), time-lock rejection, etc.
 *
 * NEVER put raw shares, reconstructed keys, or raw crypto error messages
 * in `details` — keep it to ids, role, action outcome, reason category.
 */
async function appendEntry({ action, actor = null, paperId = null, details = {} }) {
  const last = await AuditLog.findOne().sort({ _id: -1 }).lean();
  const prevHash = last ? last.hash : GENESIS_HASH;

  const draft = { action, actor, paperId, details, timestamp: new Date(), prevHash };
  const hash = computeHash(draft);

  return AuditLog.create({ ...draft, hash });
}

/**
 * Walk the whole chain and confirm every entry's stored hash matches a
 * fresh recomputation, and that prevHash correctly points at the previous
 * entry's hash. Returns { valid: boolean, brokenAtIndex: number|null }.
 *
 * Person D's frontend calls the route that wraps this to show integrity
 * status / detect tampering.
 */
async function verifyChain() {
  const entries = await AuditLog.find().sort({ _id: 1 }).lean();

  let expectedPrevHash = GENESIS_HASH;

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];

    if (entry.prevHash !== expectedPrevHash) {
      return { valid: false, brokenAtIndex: i, reason: 'prevHash mismatch (record deleted/reordered?)' };
    }

    const recomputed = computeHash(entry);
    if (recomputed !== entry.hash) {
      return { valid: false, brokenAtIndex: i, reason: 'stored hash does not match recomputed hash (record modified)' };
    }

    expectedPrevHash = entry.hash;
  }

  return { valid: true, brokenAtIndex: null, reason: null, entriesChecked: entries.length };
}

module.exports = { appendEntry, verifyChain, GENESIS_HASH };