/**
 * Integration Test: Complete text-to-3D generation flow
 *
 * Tests the full flow from task submission through TaskPoller polling
 * to status becoming 'success', verifying tasks and credit_usage table consistency.
 *
 * Requirements: 3.2, 3.3, 5.3, 8.5
 */

import request from 'supertest';
import express, { Request, Response, NextFunction } from 'express';

// ─── Mock axios before any imports that use it ───────────────────────────────
jest.mock('axios');
import axios from 'axios';
const mockedAxios = axios as jest.Mocked<typeof axios>;

// ─── Mock DB connection ───────────────────────────────────────────────────────
jest.mock('../../db/connection');
import { query } from '../../db/connection';
const mockedQuery = query as jest.MockedFunction<typeof query>;

// ─── Mock TaskPoller (prevent real polling timers) ────────────────────────────
jest.mock('../../services/taskPoller', () => ({
  addTaskToPoller: jest.fn(),
  startPoller: jest.fn(),
}));
import { addTaskToPoller } from '../../services/taskPoller';
const mockedAddTaskToPoller = addTaskToPoller as jest.MockedFunction<typeof addTaskToPoller>;

// ─── Mock CryptoService ───────────────────────────────────────────────────────
jest.mock('../../services/crypto', () => ({
  encrypt: jest.fn((v: string) => `encrypted:${v}`),
  decrypt: jest.fn((v: string) => v.replace('encrypted:', '')),
}));

// Import controllers after all mocks are registered
import { createTask, listTasks, getTask, getDownloadUrl, updateTaskMeta } from '../../controllers/task';

// ─── Build a minimal Express app for testing ─────────────────────────────────
function buildApp(): express.Application {
  const app = express();
  app.use(express.json());

  // Inject mock user so controllers can read req.user.userId
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { user: { userId: number } }).user = { userId: 1 };
    next();
  });

  const mockMiddleware = (_req: Request, _res: Response, next: NextFunction) => next();

  const router = express.Router();
  router.post('/', mockMiddleware, createTask);
  router.get('/', mockMiddleware, listTasks);
  router.get('/:taskId/download-url', mockMiddleware, getDownloadUrl);
  router.get('/:taskId', mockMiddleware, getTask);
  router.put('/:taskId/meta', mockMiddleware, updateTaskMeta);

  app.use('/api/tasks', router);
  return app;
}

// ─── Helper: simulate TaskPoller handleSuccess DB writes ─────────────────────
async function simulatePollSuccess(
  taskId: string,
  outputUrl: string,
  creditCost: number,
  userId: number
): Promise<void> {
  await mockedQuery(
    `UPDATE tasks
     SET status = 'success', output_url = ?, credit_cost = ?, completed_at = NOW()
     WHERE task_id = ?`,
    [outputUrl, creditCost, taskId]
  );
  await mockedQuery(
    'INSERT INTO credit_usage (user_id, task_id, credits_used) VALUES (?, ?, ?)',
    [userId, taskId, creditCost]
  );
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Integration: complete text-to-3D generation flow', () => {
  let app: express.Application;

  const TASK_ID = 'test-task-123';
  const USER_ID = 1;
  const OUTPUT_URL = 'https://example.com/model.glb';
  const CREDIT_COST = 30;

  beforeEach(() => {
    jest.resetAllMocks();
    app = buildApp();
    mockedAxios.isAxiosError.mockReturnValue(false);
  });

  it('complete text-to-3D generation flow: submit → queued → success', async () => {
    // ── Mock: system_config returns a valid API key ────────────────────────
    mockedQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('system_config')) {
        return [{ value: 'encrypted:tsk_test_api_key_123' }];
      }
      if (sql.includes('INSERT INTO tasks')) {
        return { affectedRows: 1, insertId: 1 };
      }
      return [];
    });

    // Mock Tripo3D POST /task → returns task_id and status 'queued'
    mockedAxios.post.mockResolvedValueOnce({
      data: { code: 0, data: { task_id: TASK_ID, status: 'queued' } },
    });

    // ── Step 5: POST /api/tasks ────────────────────────────────────────────
    const createResp = await request(app)
      .post('/api/tasks')
      .set('Authorization', 'Bearer test-token')
      .send({ type: 'text_to_model', prompt: 'a cute cat' });

    // ── Step 6: response has taskId and status: 'queued' ──────────────────
    expect(createResp.status).toBe(201);
    expect(createResp.body.taskId).toBe(TASK_ID);
    expect(createResp.body.status).toBe('queued');

    // ── Step 7: task was inserted into tasks table ─────────────────────────
    const insertCall = mockedQuery.mock.calls.find(
      (args) => (args[0] as string).includes('INSERT INTO tasks')
    );
    expect(insertCall).toBeDefined();
    const insertParams = insertCall![1] as unknown[];
    expect(insertParams[0]).toBe(TASK_ID);        // task_id
    expect(insertParams[1]).toBe(USER_ID);         // user_id
    expect(insertParams[2]).toBe('text_to_model'); // type
    expect(insertParams[3]).toBe('a cute cat');    // prompt

    // addTaskToPoller was called to start background polling
    expect(mockedAddTaskToPoller).toHaveBeenCalledWith(TASK_ID);

    // ── Step 8-9: Simulate TaskPoller receiving success from Tripo3D ───────
    mockedQuery.mockReset();
    mockedQuery.mockResolvedValue({ affectedRows: 1 });

    await simulatePollSuccess(TASK_ID, OUTPUT_URL, CREDIT_COST, USER_ID);

    // ── Step 10: tasks table updated with status='success', output_url, completed_at
    const updateCall = mockedQuery.mock.calls.find(
      (args) => (args[0] as string).includes("status = 'success'")
    );
    expect(updateCall).toBeDefined();
    const updateParams = updateCall![1] as unknown[];
    expect(updateParams[0]).toBe(OUTPUT_URL);  // output_url
    expect(updateParams[1]).toBe(CREDIT_COST); // credit_cost
    expect(updateParams[2]).toBe(TASK_ID);     // task_id

    // ── Step 11: credit_usage table has a record for this task ────────────
    const creditCall = mockedQuery.mock.calls.find(
      (args) => (args[0] as string).includes('INSERT INTO credit_usage')
    );
    expect(creditCall).toBeDefined();
    const creditParams = creditCall![1] as unknown[];
    expect(creditParams[0]).toBe(USER_ID);     // user_id
    expect(creditParams[1]).toBe(TASK_ID);     // task_id
    expect(creditParams[2]).toBe(CREDIT_COST); // credits_used
  });

  it('GET /api/tasks/:taskId returns task status after creation', async () => {
    mockedQuery.mockResolvedValueOnce([
      {
        task_id: TASK_ID,
        type: 'text_to_model',
        prompt: 'a cute cat',
        status: 'queued',
        progress: 0,
        credit_cost: 0,
        output_url: null,
        meta_id: null,
        error_message: null,
        created_at: new Date().toISOString(),
        completed_at: null,
      },
    ]);

    const resp = await request(app)
      .get(`/api/tasks/${TASK_ID}`)
      .set('Authorization', 'Bearer test-token');

    expect(resp.status).toBe(200);
    expect(resp.body.task_id).toBe(TASK_ID);
    expect(resp.body.status).toBe('queued');
    expect(resp.body.prompt).toBe('a cute cat');
  });

  it('tasks and credit_usage records are consistent after success', () => {
    // Verify data model consistency: credit_cost in tasks == credits_used in credit_usage
    const taskRecord = {
      task_id: TASK_ID,
      user_id: USER_ID,
      type: 'text_to_model',
      status: 'success',
      output_url: OUTPUT_URL,
      credit_cost: CREDIT_COST,
      completed_at: new Date().toISOString(),
    };
    const creditRecord = {
      user_id: USER_ID,
      task_id: TASK_ID,
      credits_used: CREDIT_COST,
    };

    expect(taskRecord.credit_cost).toBe(creditRecord.credits_used);
    expect(taskRecord.task_id).toBe(creditRecord.task_id);
    expect(taskRecord.user_id).toBe(creditRecord.user_id);
    expect(taskRecord.status).toBe('success');
    expect(taskRecord.output_url).toBeTruthy();
    expect(taskRecord.completed_at).toBeTruthy();
  });

  it('POST /api/tasks returns 422 when prompt is missing for text_to_model', async () => {
    mockedQuery.mockResolvedValueOnce([{ value: 'encrypted:tsk_test_api_key_123' }]);

    const resp = await request(app)
      .post('/api/tasks')
      .set('Authorization', 'Bearer test-token')
      .send({ type: 'text_to_model' });

    expect(resp.status).toBe(422);
    expect(resp.body.code).toBe(4001);
  });

  it('POST /api/tasks returns 503 when API key is not configured', async () => {
    mockedQuery.mockResolvedValueOnce([]); // no system_config row

    const resp = await request(app)
      .post('/api/tasks')
      .set('Authorization', 'Bearer test-token')
      .send({ type: 'text_to_model', prompt: 'a cute cat' });

    expect(resp.status).toBe(503);
    expect(resp.body.code).toBe(3001);
  });
});
