'use strict';

const { encryptPaper, decryptPaper } = require('../../paperCrypto');
const Paper = require('../models/Paper');
const ApproverShare = require('../models/ApproverShare');
const auditLog = require('../services/auditLog');
const { timeLockStatus } = require('../utils/timeLock');

// ---------------------------------------------------------------------
// 1. Upload — setter encrypts + splits, shares distributed to approvers
// ---------------------------------------------------------------------
const uploadPaper = async (req, res) => {
  try {
    const { title, examStartTime, examEndTime, k } = req.body;
    // approverIds sent as JSON array string, e.g. '["id1","id2","id3"]'
    const approverIds = JSON.parse(req.body.approverIds || '[]');

    if (!req.file) return res.status(400).json({ message: 'file is required' });
    if (!title || !examStartTime || !examEndTime) {
      return res.status(400).json({ message: 'title, examStartTime, examEndTime are required' });
    }
    if (!Array.isArray(approverIds) || approverIds.length < 2) {
      return res.status(400).json({ message: 'approverIds must be an array of at least 2 user ids' });
    }

    const n = approverIds.length;
    const kNum = parseInt(k, 10) || Math.ceil(n / 2) + 1; // sensible default: majority

    if (kNum < 2 || kNum > n) {
      return res.status(400).json({ message: `k must be between 2 and n (n=${n})` });
    }

    // --- Call into B's module exactly per the integration guide ---
    const { ciphertext, shares } = encryptPaper(req.file.buffer, n, kNum);

    const paper = await Paper.create({
      title,
      originalFilename: req.file.originalname,
      uploadedBy: req.user.userId,
      ciphertext,
      n,
      k: kNum,
      approverIds,
      examStartTime: new Date(examStartTime),
      examEndTime: new Date(examEndTime),
      status: 'locked',
    });

    // Distribute: shares[i] -> approverIds[i], one share per document,
    // never co-located (see ApproverShare schema note).
    const shareDocs = approverIds.map((approverId, i) => ({
      paperId: paper._id,
      approverId,
      share: shares[i],
    }));
    await ApproverShare.insertMany(shareDocs);

    await auditLog.appendEntry({
      action: 'PAPER_UPLOADED',
      actor: req.user.userId,
      paperId: paper._id,
      details: { title, n, k: kNum, approverCount: approverIds.length },
    });

    return res.status(201).json({
      id: paper._id,
      title: paper.title,
      n,
      k: kNum,
      examStartTime: paper.examStartTime,
      examEndTime: paper.examEndTime,
      status: paper.status,
    });
  } catch (err) {
    // Crypto/internal errors here are a server bug, not a denied access
    // attempt — safe to log more detail server-side, but still don't
    // leak internals to the client.
    console.error('upload error:', err);
    return res.status(500).json({ message: 'upload failed' });
  }
};

// ---------------------------------------------------------------------
// 2. Approve — an approver "casts" their share toward unlocking a paper.
//    We never return the share itself in any response.
// ---------------------------------------------------------------------
const approvePaper = async (req, res) => {
  try {
    const paper = await Paper.findById(req.params.id);
    if (!paper) return res.status(404).json({ message: 'paper not found' });

    const isDesignatedApprover = paper.approverIds.some((a) => a.toString() === req.user.userId);
    if (!isDesignatedApprover) {
      await auditLog.appendEntry({
        action: 'APPROVAL_DENIED',
        actor: req.user.userId,
        paperId: paper._id,
        details: { reason: 'not_a_designated_approver' },
      });
      return res.status(403).json({ message: 'you are not a designated approver for this paper' });
    }

    if (paper.hasApproved(req.user.userId)) {
      return res.status(409).json({ message: 'you have already approved this paper' });
    }

    // Confirm this approver's share actually exists (sanity check —
    // doesn't expose the share value anywhere in the response).
    const shareDoc = await ApproverShare.findOne({ paperId: paper._id, approverId: req.user.userId });
    if (!shareDoc) {
      return res.status(500).json({ message: 'no share on record for this approver — contact admin' });
    }

    paper.approvals.push({ approverId: req.user.userId });
    if (paper.status === 'locked') paper.status = 'pending_approval';
    await paper.save();

    await auditLog.appendEntry({
      action: 'APPROVAL_SUBMITTED',
      actor: req.user.userId,
      paperId: paper._id,
      details: { approvalCount: paper.approvalCount(), threshold: paper.k },
    });

    return res.json({
      approvalCount: paper.approvalCount(),
      threshold: paper.k,
      meetsThreshold: paper.meetsThreshold(),
    });
  } catch (err) {
    console.error('approve error:', err);
    return res.status(500).json({ message: 'approval failed' });
  }
};

// ---------------------------------------------------------------------
// 3. Status — for D's dashboard: approval count + time-lock state
// ---------------------------------------------------------------------
const getPaperStatus = async (req, res) => {
  const paper = await Paper.findById(req.params.id);
  if (!paper) return res.status(404).json({ message: 'paper not found' });

  const tl = timeLockStatus(paper);

  return res.json({
    id: paper._id,
    title: paper.title,
    status: paper.status,
    approvalCount: paper.approvalCount(),
    threshold: paper.k,
    meetsThreshold: paper.meetsThreshold(),
    examStartTime: paper.examStartTime,
    examEndTime: paper.examEndTime,
    timeLock: tl,
  });
};

// ---------------------------------------------------------------------
// 4. Unlock — the gated decrypt. Only fires when ALL THREE hold:
//    auth/role (middleware) + approval-count threshold + time-lock.
// ---------------------------------------------------------------------
const unlockPaper = async (req, res) => {
  const paper = await Paper.findById(req.params.id);
  if (!paper) return res.status(404).json({ message: 'paper not found' });

  // Gate 1: approval-count threshold
  if (!paper.meetsThreshold()) {
    await auditLog.appendEntry({
      action: 'UNLOCK_DENIED',
      actor: req.user.userId,
      paperId: paper._id,
      details: { reason: 'insufficient_approvals', have: paper.approvalCount(), need: paper.k },
    });
    return res.status(403).json({ message: 'insufficient approvals' });
  }

  // Gate 2: time-lock
  const tl = timeLockStatus(paper);
  if (!tl.ok) {
    await auditLog.appendEntry({
      action: 'UNLOCK_DENIED',
      actor: req.user.userId,
      paperId: paper._id,
      details: { reason: tl.reason },
    });
    return res.status(403).json({ message: `access denied: ${tl.reason === 'too_early' ? 'exam has not started yet' : 'exam window has closed'}` });
  }

  // Gate 3 (implicit): only approved approvers' shares are collected —
  // never pull shares for approvers who haven't actually approved.
  try {
    const approvedIds = paper.approvals.map((a) => a.approverId);
    const shareDocs = await ApproverShare.find({
      paperId: paper._id,
      approverId: { $in: approvedIds },
    });
    const shares = shareDocs.map((s) => s.share);

    // --- Call into B's module exactly per the integration guide ---
    const originalFile = decryptPaper(paper.ciphertext, shares);

    paper.status = 'unlocked';
    paper.unlockedBy = req.user.userId;
    paper.unlockedAt = new Date();
    await paper.save();

    await auditLog.appendEntry({
      action: 'UNLOCK_SUCCESS',
      actor: req.user.userId,
      paperId: paper._id,
      details: { approvalCount: approvedIds.length },
    });

    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${paper.originalFilename}"`);
    return res.send(originalFile);
  } catch (err) {
    // Per integration guide: treat any thrown error from decryptPaper as a
    // denied/failed attempt. Don't leak err.message to the client — it's
    // deliberately vague already, but we collapse it further here for
    // defense in depth. Full message goes server-side only.
    console.error('decrypt failed:', err.message);
    await auditLog.appendEntry({
      action: 'UNLOCK_DENIED',
      actor: req.user.userId,
      paperId: paper._id,
      details: { reason: 'decryption_failed' }, // no raw err.message in the audit log
    });
    return res.status(403).json({ message: 'access denied' });
  }
};

module.exports = { uploadPaper, approvePaper, getPaperStatus, unlockPaper };