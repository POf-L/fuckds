import assert from 'node:assert/strict';
import test from 'node:test';

import { MUTED_COOLDOWN_MS, isMutedMessage } from '../src/direct/client.mjs';
import { RateLimitError } from '../src/errors.mjs';
import { looksLikeCredentialFailure } from '../src/protocol/client.mjs';

test('识别上游禁言文案', () => {
  assert.equal(isMutedMessage('user is muted'), true);
  assert.equal(isMutedMessage('User Is Muted'), true);
  assert.equal(isMutedMessage('账号已被禁言'), true);
  assert.equal(isMutedMessage(''), false);
  assert.equal(isMutedMessage('INVALID_TOKEN'), false);
  assert.equal(isMutedMessage('创建会话失败：HTTP 502'), false);
});

test('禁言按账号级限流处理，不判定为凭据失效', () => {
  const muted = new RateLimitError('DeepSeek 上游提示账号被禁言（user is muted）', {
    retryAfterMs: MUTED_COOLDOWN_MS,
  });
  assert.equal(muted.status, 429);
  assert.equal(muted.code, 'deepseek_rate_limited');
  assert.ok(muted.retryAfterMs >= 5 * 60_000);
  // 禁言不是登录态失效：协议层不能因此去刷新/降级（那会重开浏览器）
  assert.equal(looksLikeCredentialFailure(muted), false);
});
