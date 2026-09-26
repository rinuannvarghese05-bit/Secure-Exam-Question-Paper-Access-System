'use strict';

const express = require('express');
const multer = require('multer');

const authMiddleware = require('../middleware/authMiddleware');
const authorize = require('../middleware/roleMiddleware');
const { uploadPaper, approvePaper, getPaperStatus, unlockPaper } = require('../controllers/paperController');

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage() });

router.post('/', authMiddleware, authorize('setter'), upload.single('file'), uploadPaper);
router.post('/:id/approve', authMiddleware, authorize('approver', 'invigilator'), approvePaper);
router.get('/:id/status', authMiddleware, getPaperStatus);
router.post('/:id/unlock', authMiddleware, authorize('invigilator'), unlockPaper);

module.exports = router;