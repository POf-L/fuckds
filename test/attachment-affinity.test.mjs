import test from 'node:test';
import assert from 'node:assert/strict';

import { AccountPool } from '../src/direct/account-pool.mjs';

const fakeLog = { info() {}, warn() {}, error() {}, debug() {}, trace() {}, child() { return this; } };

/**
 * 附件/图片是账号私有的：用 A 账号上传、用 B 账号发请求，ref_file_ids 会被静默忽略。
 * 这里验证「按 file id 把账号钉回上传方」的选号逻辑。
 *
 * 直接测 DirectEngine 会真的发网络请求，所以用 AccountPool + 相同的选号规则做等价验证。
 */
function makePool(tokens) {
  return new AccountPool({ tokens, dataDir: '/tmp', logger: fakeLog });
}

/** 复刻 client.mjs 里 chat() 的选号规则 */
function pickAccount(pool, { refFileIds = [], fileOwners = new Map(), now = Date.now() } = {}) {
  const fileOwnerIndex = (() => {
    if (!refFileIds.length) return null;
    const owners = refFileIds.map((id) => fileOwners.get(id)).filter((index) => index !== undefined);
    if (!owners.length) return null;
    return owners.every((index) => index === owners[0]) ? owners[0] : null;
  })();

  const pinned =
    fileOwnerIndex !== null && fileOwnerIndex !== undefined ? pool.accounts[fileOwnerIndex] ?? null : null;

  return pinned && pinned.cooldownUntil <= now ? pinned : pool.pick(now);
}

test('账号亲和：带附件时锁回上传它的账号，而不是轮询下一个', () => {
  const pool = makePool(['token-a', 'token-b', 'token-c']);
  const fileOwners = new Map([['file-1', 0], ['file-2', 0]]);

  // 先把游标推走，模拟轮询到别的账号
  pool.pick();
  pool.pick();

  const account = pickAccount(pool, { refFileIds: ['file-1', 'file-2'], fileOwners });
  assert.equal(account.index, 0, '必须回到上传附件的账号 0');
});

test('账号亲和：多个 file 属于不同账号时不强行钉，交给轮询', () => {
  const pool = makePool(['token-a', 'token-b']);
  const fileOwners = new Map([['file-a', 0], ['file-b', 1]]);

  const account = pickAccount(pool, { refFileIds: ['file-a', 'file-b'], fileOwners });
  assert.ok(account, '应当能选出一个账号');
  assert.equal(pool.accounts[account.index], account, '选出来的必须是池里的账号');
});

test('账号亲和：没有附件时保持原有轮询', () => {
  const pool = makePool(['token-a', 'token-b']);
  const first = pickAccount(pool, {});
  const second = pickAccount(pool, {});
  assert.notEqual(first.index, second.index, '无附件时应当轮询到不同账号');
});

test('账号亲和：上传账号在冷却中时不强行用它', () => {
  const pool = makePool(['token-a', 'token-b']);
  const fileOwners = new Map([['file-1', 0]]);
  pool.accounts[0].cooldownUntil = Date.now() + 60_000; // 账号 0 冷却中

  const account = pickAccount(pool, { refFileIds: ['file-1'], fileOwners });
  assert.equal(account.index, 1, '冷却中的账号不该被钉住用');
});

test('账号亲和：未知 file id 不误钉', () => {
  const pool = makePool(['token-a', 'token-b']);
  const account = pickAccount(pool, { refFileIds: ['file-unknown'], fileOwners: new Map() });
  assert.ok(account, '未知 file id 时应当正常轮询取号');
});
