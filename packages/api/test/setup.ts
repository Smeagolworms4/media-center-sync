import { tmpdir } from 'node:os';
import { Logger } from '@nestjs/common';

/**
 * Where the tests get their environment.
 *
 * It has to be here rather than in a helper: `jest.config.ts` runs this file before
 * the test module is loaded, and the application reads its configuration while its
 * decorators are evaluated — that is, at import time. A variable set inside a test
 * would arrive too late and the suite would open the development database instead of
 * a throwaway one.
 */
process.env.NODE_ENV = 'test';
process.env.DB_TYPE = 'sqlite';
process.env.DB_FILE = ':memory:';
process.env.MCS_JWT_SECRET = 'test-secret';
process.env.MCS_MEDIA_ROOT = tmpdir();
process.env.MCS_STATIC_ROOT = '';

/**
 * Booting a Nest application, running the migrations and answering a request is well
 * over the default five seconds on a cold machine, and a timeout there fails a test
 * that was about to pass.
 */
jest.setTimeout(30_000);

/**
 * Nest logs its whole module graph on every boot. Across a suite that is thousands of
 * lines between the failure and the assertion that reported it.
 */
Logger.overrideLogger(false);
