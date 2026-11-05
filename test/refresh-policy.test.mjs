import test from 'node:test';
import assert from 'node:assert/strict';

import { decideRefresh } from '../src/auth/refresh-policy.mjs';

const NOW = 1_700_000_000_000;

test('有活实例：静默刷新走 live（connectOverCDP 复用），不新开浏览器', () => {
  const d = decideRefresh({ hasLiveInstance: true, now: NOW, lastAttemptAt: null });
  assert.equal(d.action, 'live');
  assert.equal(d.reason, 'live-instance');
});

test('无活实例且未显式授权：拒绝刷新（不启动浏览器）', () => {
  const d = decideRefresh({ hasLiveInstance: false, allowBrowserRefresh: false, now: NOW });
  assert.equal(d.action, 'reject');
  assert.equal(d.reason, 'no-live-instance');
});

test('无活实例但显式 ALLOW_BROWSER_REFRESH=true：才允许 launch', () => {
  const d = decideRefresh({ hasLiveInstance: false, allowBrowserRefresh: true, now: NOW });
  assert.equal(d.action, 'launch');
  assert.equal(d.reason, 'explicit-allow');
});

test('同账号刷新节流：60s 内第二次刷新被 throttled（即使有活实例）', () => {
  const d = decideRefresh({ hasLiveInstance: true, now: NOW, lastAttemptAt: NOW - 30_000, minIntervalMs: 60_000 });
  assert.equal(d.action, 'throttled');
  assert.equal(d.sinceLastMs, 30_000);
});

test('节流边界：刚好 60s 允许刷新；自定义间隔生效', () => {
  const at60 = decideRefresh({ hasLiveInstance: true, now: NOW, lastAttemptAt: NOW - 60_000, minIntervalMs: 60_000 });
  assert.equal(at60.action, 'live');
  const custom = decideRefresh({ hasLiveInstance: true, now: NOW, lastAttemptAt: NOW - 90_000, minIntervalMs: 120_000 });
  assert.equal(custom.action, 'throttled');
});
