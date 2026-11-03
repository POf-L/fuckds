import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { POW_EXPIRY_SAFETY_MS, powNotExpired } from '../src/direct/client.mjs';
import { PowSolver } from '../src/direct/pow.mjs';

/** 只关注 PoW 缓存过期判定与 ds-pow 协议，不依赖网络 / 账号。 */

test('powNotExpired：正常有效期可用', () => {
  const now = 1_700_000_000_000;
  assert.equal(powNotExpired(Math.floor((now + 60_000) / 1000), now), true);
});

test('powNotExpired：已过期的 challenge 不可用', () => {
  const now = 1_700_000_000_000;
  assert.equal(powNotExpired(Math.floor((now - 1_000) / 1000), now), false);
});

test('powNotExpired：剩余不足安全余量时提前丢弃', () => {
  const now = 1_700_000_000_000;
  const almost = Math.floor((now + POW_EXPIRY_SAFETY_MS - 1) / 1000);
  assert.equal(powNotExpired(almost, now), false);
  const enough = Math.floor((now + POW_EXPIRY_SAFETY_MS + 5_000) / 1000);
  assert.equal(powNotExpired(enough, now), true);
});

test('powNotExpired：兼容毫秒时间戳', () => {
  const now = 1_700_000_000_000;
  assert.equal(powNotExpired(now + 60_000, now), true);
  assert.equal(powNotExpired(now - 60_000, now), false);
});

test('powNotExpired：服务端没给 expire_at 时保守认为可用（与旧行为一致）', () => {
  assert.equal(powNotExpired(undefined), true);
  assert.equal(powNotExpired(0), true);
  assert.equal(powNotExpired(null), true);
});

test('PowSolver 能对已知 challenge 解出正确答案（ds-pow 协议回归）', async (t) => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const bin = process.env.POW_BIN || path.join(root, 'bin', 'ds-pow');
  const exists = fs.existsSync(bin) || (process.platform === 'win32' && fs.existsSync(`${bin}.exe`));
  if (!exists) {
    t.skip(`缺少 ${bin}，先运行 npm run pow:build`);
    return;
  }
  // DeepSeekHashV1("testsalt_1700000000_42") 的官方 WASM 向量（见 deepseek_pow_test.go）
  const challenge = 'd4a2ea58c89e40887c933484868380c6f803eaa8dc53a3b9df8e431b921a4f09';
  const solver = new PowSolver({ bin, logger: { debug() {}, warn() {} } });
  try {
    const solved = await solver.solve({
      challenge,
      salt: 'testsalt',
      expireAt: 1700000000,
      difficulty: 1000,
    });
    assert.equal(solved.answer, 42);
    // 注意 powd 的响应字段带 omitempty：求解快于 1ms 时 ms=0 会被省略，
    // 所以 ms 可能是 undefined（旧版协议行为，Node 侧只用于日志）。
    assert.ok(solved.ms === undefined || typeof solved.ms === 'number');
  } finally {
    solver.close();
  }
});
