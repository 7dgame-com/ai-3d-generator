/**
 * Download routes
 *
 * GET /api/download/:taskId  - download-model
 */

import { Router } from 'express';
import { auth } from '../middleware/auth';
import { requirePermission } from '../middleware/permission';
import { downloadFile } from '../controllers/download';

const router = Router();

router.get('/:taskId', auth, requirePermission('download-model'), (req, res) =>
  downloadFile(req as Parameters<typeof downloadFile>[0], res)
);

export default router;
