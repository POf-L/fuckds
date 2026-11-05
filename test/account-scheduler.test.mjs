import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AccountPool } from '../src/direct/account-pool.mjs';
import { AccountScheduler } from '../src/direct/scheduler.mjs';
import { DirectEngine } from '../src/direct/client.mjs';
import { loadConfig } from '../src/config.mjs';
import { WebSessionStore } from '../src/session/store.mjs';
import { ProtocolEngine } from '../src/protocol/client.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function fakeLogger() {
  const noop = () => {};
  const logger = { info: noop, warn: noop, debug: noop, error: noop, child: () => logger };
  return logger;
}

function tmpDir(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `fuckds-${tag}-`));
}

/** 记录每个任务的开始/结束时间，用来核对「同一账号时间轴不重叠」 */
function recorder() {
  const events = [];
  return {
    events,
    task(id, ms = 80) {
      return async () => {
        const start = Date.now();
        events.push({ id, phase: 'start', at: start });
        await sleep(ms);
        const end = Date.now();
        events.push({ id, phase: 'end', at: end });
        return id;
      };
    },
    overlaps() {
      const spans = [];
      for (const event of events) {
        if (event.phase === 'start') spans.push({ id: event.id, start: event.at, end: null });
        else spans.find((span) => span.id === event.id)?.end && (spans.find((s) => s.id === event.id).end = event.at);
      }
      let max = 0;
      for (const span of spans) {
        const concurrent = spans.filter(
          (other) => other.start <= span.start && (other.end === null || other.end > span.start),
        ).length;
        max = Math.max(max, concurrent);
      }
      return { spans, max };
    },
  };
}

test('调度：同一账号 FIFO + 单飞，时间轴不重叠且满足最小间隔', async () => {
  const dir = tmpDir('sched-one');
  try {
    const pool = new AccountPool({ tokens: ['token-a'], dataDir: dir, logger: fakeLogger() });
    const scheduler = new AccountScheduler({ pool, logger: fakeLogger(), minGapMs: 120 });
    const rec = recorder();
    const account = pool.accounts[0];

    await Promise.all([
      scheduler.run(account, rec.task('A1')),
      scheduler.run(account, rec.task('A2')),
    ]);

    const spans = rec.overlaps().spans.sort((a, b) => a.start - b.start);
    assert.equal(spans.length, 2);
    assert.ok(spans[0].end < spans[1].start, `同一账号请求时间重叠：${spans[0].end} >= ${spans[1].start}`);
    assert.ok(spans[1].start - spans[0].start >= 120, `最小间隔不足：${spans[1].start - spans[0].start}ms`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('调度：不同账号并行（同时最多 2 条，互不阻塞）', async () => {
  const dir = tmpDir('sched-two');
  try {
    const pool = new AccountPool({ tokens: ['token-a', 'token-b'], dataDir: dir, logger: fakeLogger() });
    const scheduler = new AccountScheduler({ pool, logger: fakeLogger(), minGapMs: 0 });
    const rec = recorder();
    const [a, b] = pool.accounts;

    const started = Date.now();
    await Promise.all([
      scheduler.run(a, rec.task('A1', 200)),
      scheduler.run(b, rec.task('B1', 200)),
    ]);
    const elapsed = Date.now() - started;

    assert.equal(rec.overlaps().max, 2, '两个账号必须真正并行');
    assert.ok(elapsed < 350, `并行被串行化了：${elapsed}ms`);
    // 每个账号的 stats 都能看到自己的队列
    const stats = scheduler.stats();
    assert.equal(stats.length, 2);
    assert.ok(stats.every((item) => item.accountHash.length === 12));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('调度：某账号冷却时 stats 暴露 available=false，且排队仍然只落在自己账号', async () => {
  const dir = tmpDir('sched-cool');
  try {
    const pool = new AccountPool({ tokens: ['token-a'], dataDir: dir, logger: fakeLogger() });
    const scheduler = new AccountScheduler({ pool, logger: fakeLogger(), minGapMs: 0 });
    const account = pool.accounts[0];
    account.cooldownUntil = Date.now() + 60_000;
    const stats = scheduler.stats();
    assert.equal(stats[0].available, false);
    assert.ok(stats[0].cooldownMs > 59_000);
    assert.equal(pool.pick(Date.now(), () => 0), null, '冷却中的账号不能被选中');

    const rec = recorder();
    await scheduler.run(account, rec.task('A1'));
    assert.equal(rec.events.length, 2, '绑定的对话即使冷却也留在原账号（串行执行，不换号）');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function fakeAccount(fingerprint, info, calls) {
  return {
    fingerprint,
    creds: { userToken: `secret-${fingerprint}` },
    engine: {
      describeAccount: () => ({ fingerprint, ...info }),
      status: () => ({ scheduler: [{ ...info, accountHash: fingerprint.slice(0, 12) }] }),
      chat: async () => {
        calls.push(fingerprint);
        return { text: 'ok', accountFingerprint: fingerprint };
      },
      close: async () => {},
    },
  };
}

test('调度：工具轮按 toolMinGapMs 排队（独立于普通对话间隔）', async () => {
  const dir = tmpDir('sched-tool-gap');
  try {
    const pool = new AccountPool({ tokens: ['token-a'], dataDir: dir, logger: fakeLogger() });
    const scheduler = new AccountScheduler({ pool, logger: fakeLogger(), minGapMs: 50, toolMinGapMs: 300 });
    const rec = recorder();
    const account = pool.accounts[0];

    await Promise.all([
      scheduler.run(account, rec.task('T1')),
      // 工具轮：显式使用专用间隔（达到默认 15000 的同等语义，只是数值缩小以便快速测试）
      scheduler.run(account, rec.task('T2'), { minGapMs: scheduler.toolMinGapMs }),
    ]);

    const spans = rec.overlaps().spans.sort((a, b) => a.start - b.start);
    const gap = spans[1].start - spans[0].start;
    assert.ok(gap >= 300, `工具轮未按 toolMinGapMs 排队：${gap}ms < 300ms`);
    assert.equal(scheduler.stats()[0].toolMinGapMs, 300, 'stats 未暴露 toolMinGapMs');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('调度：客户端在等最小间隔时取消，不得把该账号的 FIFO 永久堵死', async () => {
  const dir = tmpDir('sched-abort');
  try {
    const pool = new AccountPool({ tokens: ['token-a'], dataDir: dir, logger: fakeLogger() });
    const scheduler = new AccountScheduler({ pool, logger: fakeLogger(), minGapMs: 200 });
    const account = pool.accounts[0];

    const first = scheduler.run(account, async () => {
      await sleep(100);
      return 'A';
    });
    const controller = new AbortController();
    // 第二条会先等第一条结束，再等 minGapMs（约 t+200ms）才放行；在 t+150ms 取消，
    // 正好落在 sleep(wait, signal) 里 —— 这里曾因为 release() 不在最外层 finally 而永久堵死
    const second = scheduler.run(account, async () => 'B', { signal: controller.signal });
    await sleep(150);
    controller.abort();
    await assert.rejects(second, (err) => err.name === 'AbortError' || /abort/i.test(String(err.message)));
    assert.equal(await first, 'A');

    const third = await Promise.race([
      scheduler.run(account, async () => 'C'),
      sleep(1500).then(() => 'TIMEOUT'),
    ]);
    assert.equal(third, 'C', '取消后队列被堵死了：后续请求 1.5s 内没有执行');
    const stats = scheduler.stats()[0];
    assert.equal(stats.inflight, 0);
    assert.equal(stats.queued, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('默认配置：ACCOUNT_TOOL_MIN_GAP_MS=15000，且工具轮实际使用该值', async () => {
  const dir = tmpDir('cfg-tool-gap');
  try {
    const config = loadConfig({ DATA_DIR: dir });
    assert.equal(config.runtime.accountMinGapMs, 8000, '普通对话默认间隔应保持 8000');
    assert.equal(config.runtime.toolMinGapMs, 15000, '工具轮默认间隔应为 15000');
    assert.equal(
      loadConfig({ DATA_DIR: dir, ACCOUNT_TOOL_MIN_GAP_MS: '2500' }).runtime.toolMinGapMs,
      2500,
      '环境变量应可覆盖工具轮间隔',
    );

    const engine = new DirectEngine({
      config: {
        ...config,
        deepseek: { ...config.deepseek, token: 'token-a', tokens: ['token-a'], baseUrl: 'https://chat.deepseek.com' },
      },
      logger: fakeLogger(),
    });
    const seen = [];
    // 只验证排队参数，不真的发请求
    engine.scheduler.run = async (account, task, opts) => {
      seen.push(opts?.minGapMs);
      return { text: 'ok' };
    };
    await engine.chat({ prompt: '带工具', tools: [{ type: 'function', function: { name: 'read_file' } }] });
    await engine.chat({ prompt: '普通对话' });
    assert.deepEqual(seen, [15000, undefined], '工具轮应传 15000，普通对话不应覆盖默认值');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('协议多账号：新对话选负载最低的可用账号，绑定的对话钉住原账号', () => {
  const dir = tmpDir('proto-route');
  try {
    const calls = [];
    const engine = new ProtocolEngine({
      config: { protocol: {}, deepseek: {}, dataDir: dir },
      logger: fakeLogger(),
    });
    engine.accounts = [
      fakeAccount('aaaaaaaaaaaa', { available: true, load: 3, cooldownMs: 0 }, calls),
      fakeAccount('bbbbbbbbbbbb', { available: true, load: 0, cooldownMs: 0 }, calls),
      fakeAccount('cccccccccccc', { available: false, load: 0, cooldownMs: 30_000 }, calls),
    ];

    // 新对话：负载最低（bbbb）
    assert.equal(engine.planAccount(null).fingerprint, 'bbbbbbbbbbbb');
    // 已绑定 aaaa：即使它负载更高也钉住
    assert.equal(engine.planAccount('aaaaaaaaaaaa').fingerprint, 'aaaaaaaaaaaa');
    // 全部冷却：选冷却结束最早的（cccc 30s）
    for (const account of engine.accounts) account.engine.describeAccount = () => ({ available: false, load: 0, cooldownMs: account.fingerprint === 'cccccccccccc' ? 30_000 : 50_000 });
    assert.equal(engine.planAccount(null).fingerprint, 'cccccccccccc');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('协议多账号：/healthz 状态按账号给出 in-flight / 队列 / 冷却，不泄露原值', () => {
  const dir = tmpDir('proto-health');
  try {
    const engine = new ProtocolEngine({
      config: { protocol: {}, deepseek: {}, dataDir: dir },
      logger: fakeLogger(),
    });
    engine.accounts = [
      fakeAccount('aaaaaaaaaaaa', { available: true, load: 0, inflight: 1, queued: 2 }, []),
      fakeAccount('bbbbbbbbbbbb', { available: false, load: 0, inflight: 0, queued: 0, cooldownMs: 12_000 }, []),
    ];
    const status = engine.status();
    assert.equal(status.accountsTotal, 2);
    assert.equal(status.accounts.length, 2);
    assert.equal(status.accounts[0].accountHash, 'aaaaaaaaaaaa');
    assert.equal(status.accounts[0].inflight, 1);
    assert.equal(status.accounts[0].queued, 2);
    assert.equal(status.accounts[1].available, false);
    assert.equal(status.accounts[1].cooldownMs, 12_000);
    const serialized = JSON.stringify(status);
    assert.equal(serialized.includes('secret-'), false, '/healthz 泄露了凭据原值');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('协议多账号：对话粘性——同一对话多次请求始终落在同一账号', async () => {
  const dir = tmpDir('proto-sticky');
  try {
    const calls = [];
    const engine = new ProtocolEngine({
      config: { protocol: {}, deepseek: {}, dataDir: dir },
      logger: fakeLogger(),
    });
    engine.accounts = [
      fakeAccount('aaaaaaaaaaaa', { available: true, load: 0 }, calls),
      fakeAccount('bbbbbbbbbbbb', { available: true, load: 0 }, calls),
    ];
    const bound = 'aaaaaaaaaaaa';
    for (let i = 0; i < 3; i += 1) {
      await engine.chat({ prompt: `第${i}轮`, session: { chatSessionId: 'sess-x', accountFingerprint: bound } });
    }
    assert.deepEqual(calls, [bound, bound, bound]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('会话命名空间：不同账号下同名映射键互相隔离', () => {
  const dir = tmpDir('proto-ns');
  try {
    const store = new WebSessionStore({ dataDir: dir, logger: fakeLogger() });
    const messages = [
      { role: 'system', content: '同一个 system' },
      { role: 'user', content: '同一个开头' },
    ];
    const plan = store.plan(messages, { conversationId: 'conv-ns', scope: 'aaaaaaaaaaaa' });
    assert.equal(plan.key.startsWith('aaaaaaaaaaaa|'), true);
    store.commit(plan.key, { chatSessionId: 'sess-aaaa', lastMessageId: 'msg-aaaa', sentHashes: plan.hashes });

    // 另一个账号用同样的键：必须当成新对话，不能复用 aaaa 的网页会话
    const other = store.plan(messages, { conversationId: 'conv-ns', scope: 'bbbbbbbbbbbb' });
    assert.equal(other.reuse, false);
    assert.equal(other.reason, 'new-conversation');
    assert.equal(other.key.startsWith('bbbbbbbbbbbb|'), true);

    // 不传 scope 的只读查询能发现「这段对话已经绑定在 aaaa」
    const binding = store.lookup(messages, { conversationId: 'conv-ns' });
    assert.equal(binding.scope, 'aaaaaaaaaaaa');
    assert.equal(binding.entry.chatSessionId, 'sess-aaaa');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
