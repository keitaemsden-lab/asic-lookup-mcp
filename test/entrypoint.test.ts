import { type ChildProcessWithoutNullStreams, execFileSync, spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { privateKeyToAccount } from 'viem/accounts';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { SERVER_VERSION } from '../src/server.js';

/**
 * The built entrypoint, run as a real process the way an MCP client runs it.
 *
 * Everything else in the suite drives `buildServer` in-process, which cannot see
 * what `src/index.ts` itself does: the exit code on bad config, what reaches
 * stderr, and above all whether stdout stays a clean JSON-RPC stream.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = resolve(ROOT, 'dist/index.js');

// Hardhat's public account #1, the same key the in-process tests use. Never funded.
const TEST_KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d';

// `.invalid` is reserved (RFC 2606) and never resolves, so any request made to
// it fails loudly in stderr instead of silently reaching something real.
const UNRESOLVABLE_API = 'https://asic-lookup-mcp-entrypoint-test.invalid';

const CONFIG_URL = 'https://github.com/keitaemsden-lab/asic-lookup-mcp#configuration';

interface Run {
  child: ChildProcessWithoutNullStreams;
  stdout: () => string;
  stderr: () => string;
  exited: Promise<number | null>;
  /** Resolves once `predicate` holds for the output seen so far, checked on every chunk. */
  waitFor: (stream: 'stdout' | 'stderr', predicate: (text: string) => boolean) => Promise<string>;
}

const running: ChildProcessWithoutNullStreams[] = [];

/**
 * Spawn the entrypoint with exactly the env given, plus PATH. Nothing is
 * inherited from the test runner, so a PRIVATE_KEY or SPEND_CAP_USD in the
 * developer's shell cannot leak in and change the outcome.
 */
function start(env: Record<string, string>): Run {
  const child = spawn(process.execPath, [ENTRY], {
    cwd: ROOT,
    env: { PATH: process.env['PATH'] ?? '', ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  running.push(child);

  const out = { stdout: '', stderr: '' };
  const waiters: Array<() => void> = [];
  const notify = () => {
    for (const waiter of [...waiters]) waiter();
  };
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
    out.stdout += chunk;
    notify();
  });
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
    out.stderr += chunk;
    notify();
  });

  const exited = new Promise<number | null>((resolveExit) => {
    child.on('close', (code) => {
      notify();
      resolveExit(code);
    });
  });

  const waitFor: Run['waitFor'] = (stream, predicate) =>
    new Promise((resolveWait, rejectWait) => {
      const check = () => {
        if (predicate(out[stream])) {
          waiters.splice(waiters.indexOf(check), 1);
          resolveWait(out[stream]);
        } else if (child.exitCode !== null || child.signalCode !== null) {
          waiters.splice(waiters.indexOf(check), 1);
          rejectWait(
            new Error(
              `entrypoint exited (${child.exitCode ?? child.signalCode}) before ${stream} matched.\n` +
                `stdout:\n${out.stdout}\nstderr:\n${out.stderr}`,
            ),
          );
        }
      };
      waiters.push(check);
      check();
    });

  return { child, stdout: () => out.stdout, stderr: () => out.stderr, exited, waitFor };
}

function send(run: Run, message: unknown): void {
  run.child.stdin.write(`${JSON.stringify(message)}\n`);
}

/** Complete lines only: a trailing partial line is still being written. */
function lines(text: string): string[] {
  return text.split('\n').slice(0, -1);
}

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'entrypoint-test', version: '0.0.0' },
  },
};

beforeAll(() => {
  execFileSync('npx', ['tsc', '-p', 'tsconfig.json'], { cwd: ROOT, stdio: 'pipe' });
}, 120_000);

afterEach(() => {
  for (const child of running.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

describe('entrypoint', () => {
  it('refuses to start without SPEND_CAP_USD, says why on stderr, and leaves stdout empty', async () => {
    const run = start({ API_BASE_URL: UNRESOLVABLE_API });

    expect(await run.exited).toBe(1);
    expect(run.stderr()).toContain('refusing to start');
    expect(run.stderr()).toContain('SPEND_CAP_USD is required');
    expect(run.stderr()).toContain(CONFIG_URL);
    expect(run.stdout()).toBe('');
  }, 15_000);

  it('refuses a malformed key without echoing any of it', async () => {
    const malformed = `0x${'c0ffee'.repeat(10)}`; // 60 hex characters: plausible, but short
    const run = start({
      SPEND_CAP_USD: '1.00',
      PRIVATE_KEY: malformed,
      API_BASE_URL: UNRESOLVABLE_API,
    });

    expect(await run.exited).toBe(1);
    expect(run.stderr()).toContain('refusing to start');
    expect(run.stderr()).toContain('not a 32-byte hex private key');
    expect(run.stderr()).not.toContain(malformed);
    expect(run.stderr()).not.toContain(malformed.slice(2));
    expect(run.stderr()).not.toContain('c0ffeec0ffee');
    expect(run.stdout()).toBe('');
  }, 15_000);

  it('starts on a valid config, answers initialize on a clean stdout, and makes no HTTP request', async () => {
    const run = start({
      SPEND_CAP_USD: '1.00',
      PRIVATE_KEY: TEST_KEY,
      API_BASE_URL: UNRESOLVABLE_API,
    });

    const stderr = await run.waitFor('stderr', (text) => text.includes(' ready.'));
    expect(stderr).toContain(`v${SERVER_VERSION} ready`);
    expect(stderr).toContain(privateKeyToAccount(TEST_KEY).address);
    expect(stderr).not.toContain(TEST_KEY.slice(2));

    send(run, INITIALIZE);
    await run.waitFor('stdout', (text) => lines(text).length >= 1);

    const first = JSON.parse(lines(run.stdout())[0]!) as {
      jsonrpc: string;
      id: number;
      result: { serverInfo: { name: string; version: string } };
    };
    expect(first.jsonrpc).toBe('2.0');
    expect(first.id).toBe(1);
    expect(first.result.serverInfo.version).toBe(SERVER_VERSION);

    // Drive one more round trip so anything written after the handshake has had
    // a chance to land on stdout before it is inspected.
    send(run, { jsonrpc: '2.0', method: 'notifications/initialized' });
    send(run, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
    await run.waitFor('stdout', (text) => lines(text).some((line) => line.includes('"id":2')));

    expect(run.stdout().endsWith('\n')).toBe(true);
    for (const line of lines(run.stdout())) {
      const message = JSON.parse(line) as { jsonrpc?: unknown };
      expect(message.jsonrpc).toBe('2.0');
    }

    // Startup and initialize must not touch the network. Any attempt against the
    // unresolvable host would surface as a resolution error or a fatal note.
    expect(run.stderr()).not.toMatch(/ENOTFOUND|EAI_AGAIN|fetch failed|fatal|error/i);
    expect(run.child.exitCode).toBeNull();
  }, 15_000);
});
