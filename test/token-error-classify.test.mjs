import test from 'node:test';
import assert from 'node:assert/strict';

import { AccountPool } from '../src/direct/account-pool.mjs';
import { isAuthInvalidMessage } from '../src/direct/client.mjs';

const fakeLog = { info() {}, warn() {}, error() {}, debug() {}, trace() {}, child() { return this; } };

const makePool = (tokens) => new AccountPool({ tokens, dataDir: '/tmp', logger: fakeLog });

/* ---------------- 登录失效文案识别 ---------------- */

test('isAuthInvalidMessage: 只认明确的失效业务码文案', () => {
  for (const message of ['INVALID_TOKEN', 'TOKEN_EXPIRED', 'TOKEN_INVALID', 'USER_NOT_FOUND', 'NOT_LOGGED_IN']) {
    assert.equal(isAuthInvalidMessage(message), true, message);
  }
});

test('isAuthInvalidMessage: 大小写与前后空格不敏感', () => {
  assert.equal(isAuthInvalidMessage('token_invalid'), true);
  assert.equal(isAuthInvalidMessage('  INVALID_TOKEN  '), true);
});

test('isAuthInvalidMessage: 模糊文案不识别（避免误伤风控临时拦截）', () => {
  // 这条同时可能是真失效，也可能是风控临时拦截；
  // 用它触发 24h 停用会把好号误锁一天（authFailed 一旦置位不会自愈），所以不认。
  for (const message of [
    'Authorization Failed (invalid token)',
    '获取 PoW 挑战失败：Authorization Failed (invalid token)',
    '内容违规',
    '消息发送过于频繁',
    'CHALLENGE_REQUIRED',
    '',
    null,
    undefined,
  ]) {
    assert.equal(isAuthInvalidMessage(message), false, String(message));
  }
});

/* ---------------- 失败类型记录 ---------------- */

test('markUnavailable: 记录失败类型，供「全部冷却」时区分登录失效与限流', () => {
  const pool = makePool(['t1', 't2']);
  const bad = pool.accounts[0];
  bad.lastFailureKind = 'upstream';

  pool.markUnavailable(bad, 1000, '登录态失效', { authFailed: true, kind: 'auth' });
  assert.equal(bad.lastFailureKind, 'auth');
  assert.equal(bad.authFailed, true);
});

test('markLimited: 记录为限流类型', () => {
  const pool = makePool(['t1', 't2']);
  const acc = pool.accounts[0];
  pool.markLimited(acc, 1000);
  assert.equal(acc.lastFailureKind, 'rate_limit');
});

test('markHealthy: 清掉失败类型', () => {
  const pool = makePool(['t1', 't2']);
  const acc = pool.accounts[0];
  acc.lastFailureKind = 'upstream';
  pool.markHealthy(acc);
  assert.equal(acc.lastFailureKind, null);
});

/* ---------------- 「全部登录失效」判断 ---------------- */

test('allAuthUnavailable: INVALID_TOKEN 走普通 markUnavailable 时也能识别', () => {
  const pool = makePool(['t1', 't2']);
  // 模拟 INVALID_TOKEN 的路径：不置 authFailed，但记录 kind=auth
  pool.markUnavailable(pool.accounts[0], 1000, '创建会话失败：INVALID_TOKEN', { kind: 'auth' });
  pool.markUnavailable(pool.accounts[1], 1000, '创建会话失败：INVALID_TOKEN', { kind: 'auth' });

  assert.equal(pool.allAuthFailed(), false, 'authFailed 标志位确实是 false');
  assert.equal(pool.allAuthUnavailable(), true, '但应当能识别出都是登录失效');
});

test('allAuthUnavailable: 真限流时不误判为登录失效', () => {
  const pool = makePool(['t1', 't2']);
  pool.markLimited(pool.accounts[0], 1000);
  pool.markLimited(pool.accounts[1], 1000);

  assert.equal(pool.allAuthUnavailable(), false, '限流不该被当成登录失效');
});

test('allAuthUnavailable: 一好一坏时不算「全部失效」', () => {
  const pool = makePool(['t1', 't2']);
  pool.markUnavailable(pool.accounts[0], 1000, '登录态失效', { authFailed: true, kind: 'auth' });

  assert.equal(pool.allAuthUnavailable(), false, '还有一个号没失效');
});

test('allAuthUnavailable: 空池返回 false', () => {
  assert.equal(makePool([]).allAuthUnavailable(), false);
});
