'use strict';

const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema({
  action: {
    type: String,
    required: true,
  },
  actor: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
  paperId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Paper',
    default: null,
  },
  details: {
    type: mongoose.Schema.Types.Mixed,
    default: {},
  },
  timestamp: {
    type: Date,
    required: true,
  },
  prevHash: {
    type: String,
    required: true,
  },
  hash: {
    type: String,
    required: true,
  },
});

module.exports = mongoose.model('AuditLog', auditLogSchema);