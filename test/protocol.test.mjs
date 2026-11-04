import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildProtocolExtras,
  cookieHeaderFrom,
  credentialSummary,
  hasLoginMarker,
  unwrapStorageValue,
} from '../src/protocol/credentials.mjs';
import { ProtocolEngine, looksLikeCredentialFailure } from '../src/protocol/client.mjs';

test('unwrapStorageValue：json 字符串 / {value} / 裸值', () => {
  assert.equal(unwrapStorageValue('"abc"'), 'abc');
  assert.equal(unwrapStorageValue('{"value":"abc"}'), 'abc');
  assert.equal(unwrapStorageValue('abc'), 'abc');
  assert.equal(unwrapStorageValue(''), '');
  assert.equal(unwrapStorageValue(null), '');
  // 非字符串对象保持原样，交给调用方判断
  assert.equal(unwrapStorageValue('{"a":1}'), '{"a":1}');
});

test('cookieHeaderFrom：拼接 name=value，忽略坏项', () => {
  const cookies = [
    { name: 'smidV2', value: 'x' },
    { name: 'HWWAFSESID', value: 'y' },
    { name: '', value: 'z' },
    { name: 'noValue' },
  ];
  assert.equal(cookieHeaderFrom(cookies), 'smidV2=x; HWWAFSESID=y');
  assert.equal(cookieHeaderFrom(null), '');
});

test('buildProtocolExtras：只用实测字段，不伪造额外头', () => {
  const extras = buildProtocolExtras({
    cookieHeader: 'a=1',
    hifLeim: 'leim',
    hifDliq: 'dliq',
    userAgent: 'UA/1 Edge/156',
    brands: [
      { brand: 'Not:A-Brand', version: '8' },
      { brand: 'Microsoft Edge', version: '156' },
    ],
    mobile: false,
    platform: 'Win32',
    languages: ['zh-CN'],
  });
  assert.equal(extras.cookie, 'a=1');
  assert.equal(extras['x-hif-leim'], 'leim');
  assert.equal(extras['x-hif-dliq'], 'dliq');
  assert.equal(extras['user-agent'], 'UA/1 Edge/156');
  assert.equal(extras['sec-ch-ua'], '"Not:A-Brand";v="8", "Microsoft Edge";v="156"');
  assert.equal(extras['sec-ch-ua-mobile'], '?0');
  assert.equal(extras['sec-ch-ua-platform'], '"Windows"');
  assert.equal(extras['accept-language'], 'zh-CN');
  // 没有证据的头不出现
  assert.equal(extras['x-requested-with'], undefined);
  assert.equal(extras['sec-ch-ua-full-version-list'], undefined);
});

test('looksLikeCredentialFailure：覆盖实测的 INVALID_TOKEN / session_failed', () => {
  const mk = (message, code, status) => Object.assign(new Error(message), { code, status });
  assert.equal(looksLikeCredentialFailure(mk('创建会话失败：INVALID_TOKEN', 'session_failed', 502)), true);
  assert.equal(looksLikeCredentialFailure(mk('Authorization Failed (invalid token)', null, 200)), true);
  assert.equal(looksLikeCredentialFailure(mk('invalid_token', null, 200)), true);
  assert.equal(looksLikeCredentialFailure(mk('网络错误', 'network', 502)), false);
  assert.equal(looksLikeCredentialFailure(null), false);
});

test('hasLoginMarker：拒绝匿名 guest，只认 hif 缓存', () => {
  // 实测 guest：匿名 token + 5 个 cookie（含 smidV2），但无 hif 缓存
  assert.equal(
    hasLoginMarker({
      userToken: 'guest-token',
      cookies: [
        { name: 'HWWAFSESID' },
        { name: 'HWWAFSESTIME' },
        { name: 'ds_session_id' },
        { name: 'smidV2' },
        { name: '.thumbcache_6b2e' },
      ],
    }),
    false,
  );
  assert.equal(hasLoginMarker({ userToken: 't', cookies: [], hifLeim: 'x' }), true);
  assert.equal(hasLoginMarker({ userToken: 't', cookies: [], hifDliq: 'x' }), true);
  assert.equal(hasLoginMarker({}), false);
  assert.equal(hasLoginMarker(null), false);
});

test('ProtocolEngine：认证失败且关闭刷新/降级时不吞错', async () => {
  const config = {
    protocol: { credentialsFile: 'unused.json', refreshOnAuthFail: false, fallbackToHybrid: false },
    deepseek: {},
  };
  const engine = new ProtocolEngine({ config, logger: { child: () => ({ warn() {}, info() {}, debug() {} }) } });
  const err = Object.assign(new Error('Authorization Failed (40003)'), { status: 401, name: 'ApiError' });
  engine.inner = { chat: async () => { throw err; }, close: () => {} };
  await assert.rejects(
    engine.chat({ prompt: '你好' }),
    (e) => e.name === 'AuthExpiredError' && e.status === 401 && /协议凭据失效/.test(e.message),
  );
  assert.equal(engine.layer, 'protocol');
  assert.equal(engine.degradations, 0);
});

test('ProtocolEngine：降级后由 hybrid 接管', async () => {
  const config = { protocol: {}, deepseek: {} };
  const engine = new ProtocolEngine({ config, logger: { child: () => ({ warn() {}, info() {}, debug() {} }) } });
  let called = 0;
  engine.layer = 'hybrid';
  engine.hybrid = { chat: async () => { called += 1; return { text: 'ok' }; } };
  const out = await engine.chat({ prompt: '你好' });
  assert.equal(called, 1);
  assert.equal(out.text, 'ok');
});

test('credentialSummary：只输出数量/布尔，不泄露值', () => {
  const realToken = 't'.repeat(64);
  const summary = credentialSummary({
    userToken: realToken,
    deviceId: 'secret-device',
    cookieHeader: 'secret=1',
    cookies: [{ name: 'smidV2', value: 'secret' }],
    hifLeim: 'secret-hif',
    harvestedAt: Date.now() - 1000,
    userAgent: 'UA',
  });
  assert.equal(summary.hasToken, true);
  assert.equal(summary.cookieCount, 1);
  assert.deepEqual(summary.cookieNames, ['smidV2']);
  assert.equal(summary.hasHifLeim, true);
  const serialized = JSON.stringify(summary);
  assert.equal(serialized.includes(realToken), false);
  assert.equal(serialized.includes('secret-hif'), false);
  assert.equal(serialized.includes('"secret"'), false);
});
