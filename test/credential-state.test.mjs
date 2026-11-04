import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { AccountPool } from '../src/direct/account-pool.mjs';
import { ProtocolEngine } from '../src/protocol/client.mjs';
import { credentialSummary } from '../src/protocol/credentials.mjs';
import { evaluateCredentialState } from '../src/auth/credential-state.mjs';

const TOKEN64 = 'a'.repeat(64);
const HOUR = 60 * 60 * 1000;

function fakeLogger() {
  const noop = () => {};
  const logger = { info: noop, warn: noop, debug: noop, error: noop, child: () => logger };
  return logger;
}

function makePool(tokens) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fuckds-cred-'));
  return { pool: new AccountPool({ tokens, dataDir, logger: fakeLogger() }), dataDir };
}

test('evaluateCredentialState：有效 token 为 valid', () => {
  const state = evaluateCredentialState({ token: TOKEN64, hasLoginMarker: true, harvestedAt: Date.now() - 1000 });
  assert.equal(state.credentialState, 'valid');
  assert.equal(state.hasToken, true);
  assert.equal(state.ageMs != null, true);
});

test('evaluateCredentialState：匿名访客 token（30 字符）判 anonymous，hasToken=false', () => {
  const state = evaluateCredentialState({ token: 'b'.repeat(30), hasLoginMarker: false });
  assert.equal(state.credentialState, 'anonymous');
  assert.equal(state.hasToken, false);
  assert.equal(state.reason, 'token-shape');
});

test('evaluateCredentialState：缺 hif 登录标记判 anonymous', () => {
  const state = evaluateCredentialState({ token: TOKEN64, hasLoginMarker: false });
  assert.equal(state.credentialState, 'anonymous');
  assert.equal(state.hasToken, false);
  assert.equal(state.reason, 'no-login-marker');
});

test('evaluateCredentialState：401 之后判 invalid；年龄超硬阈值也 invalid；超软阈值 stale', () => {
  const failed = evaluateCredentialState({
    token: TOKEN64,
    hasLoginMarker: true,
    authFailed: true,
    lastAuthError: { at: Date.now() - 1000, code: 'INVALID_TOKEN' },
  });
  assert.equal(failed.credentialState, 'invalid');
  assert.equal(failed.reason, 'auth-failed');
  assert.equal(failed.lastAuthError.code, 'INVALID_TOKEN');

  const tooOld = evaluateCredentialState({ token: TOKEN64, hasLoginMarker: true, harvestedAt: Date.now() - 9 * HOUR });
  assert.equal(tooOld.credentialState, 'invalid');
  assert.equal(tooOld.reason, 'age-exceeded');

  const stale = evaluateCredentialState({ token: TOKEN64, hasLoginMarker: true, harvestedAt: Date.now() - 7 * HOUR });
  assert.equal(stale.credentialState, 'stale');
});

test('AccountPool：401 后状态变为 invalid，available/dispatchable=false 且不能选号', () => {
  const { pool } = makePool([TOKEN64]);
  const account = pool.accounts[0];
  pool.markUnavailable(account, 1000, '登录态失效', { authFailed: true, authErrorCode: 'INVALID_TOKEN' });
  const [status] = pool.status();
  assert.equal(status.credentialState, 'invalid');
  assert.equal(status.hasToken, true);
  assert.equal(status.dispatchable, false);
  assert.equal(status.available, false);
  assert.equal(status.lastAuthError.code, 'INVALID_TOKEN');
  assert.equal(typeof status.lastAuthError.at, 'number');
  assert.equal(pool.pick(), null);
});

test('credentialSummary：匿名 token 不再报 hasToken=true', () => {
  const guest = credentialSummary({ userToken: 'c'.repeat(30), cookies: [], hifLeim: null, hifDliq: null });
  assert.equal(guest.hasToken, false);
  const real = credentialSummary({ userToken: TOKEN64, cookies: [], hifLeim: 'h' });
  assert.equal(real.hasToken, true);
  assert.equal(JSON.stringify(real).includes(TOKEN64), false);
});

test('ProtocolEngine.status：年龄超阈值 → invalid + nextAction=re-login；匿名 → anonymous', () => {
  const engine = new ProtocolEngine({
    config: { protocol: { tokenMaxAgeMs: 8 * HOUR, tokenStaleAgeMs: 6 * HOUR }, deepseek: {} },
    logger: fakeLogger(),
  });
  engine.layer = 'protocol';
  const fakeInner = { status: () => ({ scheduler: [{ cooldownMs: 0, inflight: 0, queued: 0 }], accounts: [{ authFailed: false }] }) };
  engine.accounts = [
    { creds: { userToken: TOKEN64, harvestedAt: Date.now() - 9 * HOUR, hifLeim: 'h' }, fingerprint: 'f'.repeat(16), engine: fakeInner },
    { creds: { userToken: 'd'.repeat(30), harvestedAt: Date.now() - 1000, hifLeim: null, hifDliq: null }, fingerprint: 'e'.repeat(16), engine: fakeInner },
  ];
  const st = engine.status();
  assert.equal(st.accounts[0].credentialState, 'invalid');
  assert.equal(st.accounts[0].dispatchable, false);
  assert.equal(st.accounts[0].available, false);
  assert.equal(st.accounts[0].credentials.hasToken, true);
  assert.equal(st.accounts[1].credentialState, 'anonymous');
  assert.equal(st.accounts[1].hasToken, false);
  assert.equal(st.credentialState, 'invalid');
  assert.equal(st.nextAction, 're-login');
});
