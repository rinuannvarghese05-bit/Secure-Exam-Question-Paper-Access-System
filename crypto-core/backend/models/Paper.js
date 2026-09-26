'use strict';

const mongoose = require('mongoose');

const approvalSchema = new mongoose.Schema(
  {
    approverId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    approvedAt: {
      type: Date,
      default: Date.now,
    },
  },
  { _id: false }
);

const paperSchema = new mongoose.Schema(
  {
    title: {
      type: String,
      required: true,
    },
    originalFilename: {
      type: String,
      required: true,
    },
    uploadedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    ciphertext: {
      type: Buffer,
      required: true,
    },
    n: {
      type: Number,
      required: true,
    },
    k: {
      type: Number,
      required: true,
    },
    approverIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
      },
    ],
    approvals: [approvalSchema],
    examStartTime: {
      type: Date,
      required: true,
    },
    examEndTime: {
      type: Date,
      required: true,
    },
    status: {
      type: String,
      enum: ['locked', 'pending_approval', 'unlocked'],
      default: 'locked',
    },
    unlockedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    unlockedAt: {
      type: Date,
    },
  },
  { timestamps: true }
);

// --- Instance methods used by paperController.js ---

paperSchema.methods.hasApproved = function (userId) {
  return this.approvals.some((a) => a.approverId.toString() === userId.toString());
};

paperSchema.methods.approvalCount = function () {
  return this.approvals.length;
};

paperSchema.methods.meetsThreshold = function () {
  return this.approvalCount() >= this.k;
};

module.exports = mongoose.model('Paper', paperSchema);