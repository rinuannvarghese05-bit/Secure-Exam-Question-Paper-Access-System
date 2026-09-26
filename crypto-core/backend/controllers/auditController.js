'use strict';

const AuditLog = require('../models/AuditLog');
const { verifyChain } = require('../services/auditLog');

// History — Person D's dashboard lists these.
const getAuditHistory = async (req, res) => {
  const { paperId } = req.query;
  const filter = paperId ? { paperId } : {};
  const entries = await AuditLog.find(filter).sort({ _id: 1 }).lean();
  return res.json(entries);
};

// Integrity check — Person D's "verify" button hits this.
const verifyAuditChain = async (req, res) => {
  const result = await verifyChain();
  return res.json(result);
};

module.exports = { getAuditHistory, verifyAuditChain };