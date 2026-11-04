import assert from 'node:assert/strict';
import test from 'node:test';

import { anthropicErrorPayload } from '../src/anthropic/response.mjs';
import { ApiError, AUTH_NEXT_ACTION, AuthExpiredError, badRequest } from '../src/errors.mjs';

test('401 错误体带 nextAction 与可执行命令，原始 code/message 保留', () => {
  const err = new AuthExpiredError('协议凭据失效：创建会话失败：INVALID_TOKEN');
  const body = err.toJSON();
  assert.equal(body.error.code, 'deepseek_auth_required');
  assert.match(body.error.message, /INVALID_TOKEN/);
  assert.match(body.error.message, /请重新登录：npm run auth:hybrid/);
  assert.equal(body.error.nextAction.action, 're-login');
  assert.equal(body.error.nextAction.command, 'npm run auth:hybrid');
  assert.deepEqual(body.error.nextAction, AUTH_NEXT_ACTION);
});

test('AuthExpiredError 默认文案自带一条命令', () => {
  const body = new AuthExpiredError().toJSON();
  assert.equal(body.error.message.includes('npm run auth:hybrid'), true);
  assert.equal(body.error.nextAction.action, 're-login');
});

test('Anthropic 错误体同样带 nextAction，不重复追加命令', () => {
  const err = new AuthExpiredError('协议凭据失效：创建会话失败：INVALID_TOKEN');
  const body = anthropicErrorPayload(err);
  assert.equal(body.type, 'error');
  assert.equal(body.error.type, 'authentication_error');
  assert.match(body.error.message, /INVALID_TOKEN/);
  assert.match(body.error.message, /npm run auth:hybrid/);
  assert.equal(body.error.message.match(/npm run auth:hybrid/g).length, 1);
  assert.equal(body.error.nextAction.action, 're-login');
});

test('非认证错误不注入 nextAction', () => {
  const body = badRequest('缺少 messages').toJSON();
  assert.equal(body.error.nextAction, undefined);
  assert.equal(body.error.code, 'invalid_request');
  const upstream = new ApiError(502, '上游超时').toJSON();
  assert.equal(upstream.error.nextAction, undefined);
});
