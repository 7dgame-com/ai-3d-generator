/**
 * Task routes
 *
 * Permissions:
 *   POST   /api/tasks                      - generate-model
 *   GET    /api/tasks                      - generate-model
 *   GET    /api/tasks/:taskId              - generate-model
 *   GET    /api/tasks/:taskId/download-url - download-model
 *   PUT    /api/tasks/:taskId/meta         - upload-to-main
 */

import { Router } from 'express';
import { auth } from '../middleware/auth';
import { requirePermission } from '../middleware/permission';
import { createTask, listTasks, getTask, getDownloadUrl, updateTaskMeta } from '../controllers/task';

const router = Router();

router.post('/', auth, requirePermission('generate-model'), createTask);
router.get('/', auth, requirePermission('generate-model'), listTasks);

// download-url must be registered before /:taskId to avoid param capture
router.get('/:taskId/download-url', auth, requirePermission('download-model'), getDownloadUrl);
router.get('/:taskId', auth, requirePermission('generate-model'), getTask);

router.put('/:taskId/meta', auth, requirePermission('upload-to-main'), updateTaskMeta);

export default router;
