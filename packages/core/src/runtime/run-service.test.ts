import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../config/index.js';
import { MemoryLogger } from '../logger/index.js';
import { runService, type RunningService } from './run-service.js';

const config = () => loadConfig({ PORT: '0', HOST: '127.0.0.1', NODE_ENV: 'test' }, { serviceName: 'test-app' });

describe('runService', () => {
  const running: RunningService[] = [];
  afterEach(async () => {
    while (running.length) await running.pop()!.stop();
  });

  async function start(extra: Parameters<typeof runService>[1] = {}, def: Partial<Parameters<typeof runService>[0]> = {}) {
    const logger = new MemoryLogger();
    const svc = await runService({ name: 'test-app', defaultPort: 0, ...def }, { config: config(), logger, handleSignals: false, ...extra });
    running.push(svc);
    return { svc, logger };
  }

  it('logs the lifecycle and serves /health', async () => {
    const { svc, logger } = await start();
    const res = await fetch(`http://127.0.0.1:${svc.port}/health`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ok', service: 'test-app' });

    const unknown = await fetch(`http://127.0.0.1:${svc.port}/nope`);
    expect(unknown.status).toBe(404);

    expect(logger.records.map((r) => r.fields.lifecycle)).toEqual(['starting', 'config_loaded', 'listening', 'started']);
  });

  it('does not log secrets in the config line', async () => {
    const logger = new MemoryLogger();
    const cfg = loadConfig({ PORT: '0', HOST: '127.0.0.1', CLICKHOUSE_PASSWORD: 'pw-123' });
    const svc = await runService({ name: 'x', defaultPort: 0 }, { config: cfg, logger, handleSignals: false });
    running.push(svc);
    expect(JSON.stringify(logger.records)).not.toContain('pw-123');
  });

  it('stops cleanly: runs onStop, logs, and closes the port', async () => {
    const onStop = vi.fn(async () => undefined);
    const { svc, logger } = await start({}, { onStop });
    await svc.stop('test');
    expect(onStop).toHaveBeenCalledOnce();
    expect(logger.records.map((r) => r.fields.lifecycle).slice(-2)).toEqual(['stopping', 'stopped']);
    await expect(fetch(`http://127.0.0.1:${svc.port}/health`)).rejects.toThrow();
    await svc.stop(); // idempotent
    expect(onStop).toHaveBeenCalledOnce();
  });

  it('shuts down and exits 0 on SIGTERM', async () => {
    const exit = vi.fn();
    const logger = new MemoryLogger();
    const svc = await runService({ name: 'x', defaultPort: 0 }, { config: config(), logger, exit });
    running.push(svc);
    process.emit('SIGTERM', 'SIGTERM'); // Node passes the signal name to listeners
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    expect(logger.records.some((r) => r.fields.lifecycle === 'stopping' && r.fields.reason === 'SIGTERM')).toBe(true);
    expect(process.listenerCount('SIGTERM')).toBe(0);
  });

  it('logs and rethrows when onStart fails', async () => {
    const logger = new MemoryLogger();
    await expect(
      runService(
        { name: 'x', defaultPort: 0, onStart: async () => { throw new Error('no db'); } },
        { config: config(), logger, handleSignals: false }
      )
    ).rejects.toThrow('no db');
    expect(logger.records.at(-1)).toMatchObject({ level: 'error', fields: { lifecycle: 'start_failed' } });
  });
});
