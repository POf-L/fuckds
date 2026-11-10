import test from 'node:test';
import assert from 'node:assert/strict';

import { loadImage } from '../src/openai/images.mjs';
import { collectImages } from '../src/openai/request.mjs';

test('loadImage: 解析 data URL', async () => {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const image = await loadImage(`data:image/png;base64,${png.toString('base64')}`);
  assert.equal(image.mime, 'image/png');
  assert.deepEqual(image.buffer, png);
  assert.match(image.name, /\.png$/);
});

test('loadImage: 非图片/空地址报错', async () => {
  await assert.rejects(() => loadImage(''), /image_url 为空/);
  await assert.rejects(() => loadImage('ftp://x/y.png'), /不支持的图片地址/);
});

test('loadImage: http 下载（注入 fetch）', async () => {
  const body = Buffer.from([1, 2, 3]);
  const fakeFetch = async () => new Response(body, { headers: { 'content-type': 'image/webp' } });
  const image = await loadImage('https://example.com/a.webp', { fetchImpl: fakeFetch });
  assert.equal(image.mime, 'image/webp');
  assert.deepEqual(image.buffer, body);
});

test('collectImages: 只收 user 的图片部分', () => {
  const images = collectImages([
    { role: 'system', content: 'x' },
    {
      role: 'user',
      content: [
        { type: 'text', text: '看这两张' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AA' } },
        { type: 'input_image', image_url: 'https://x/y.jpg' },
      ],
    },
    { role: 'assistant', content: [{ type: 'image_url', image_url: { url: 'ignored' } }] },
  ]);
  assert.equal(images.length, 2);
  assert.equal(images[1].url, 'https://x/y.jpg');
});

test('collectImages: 历史里的图片不会被重复收集（聊久了不该报 too_many_images）', () => {
  // 回归：以前扫描全部 messages，历史截图每轮都会被重新收集，
  // 聊天轮次一多就超过 8 张直接 400 —— 表现是「一张图没发却报 9 张图」。
  const messages = [{ role: 'user', content: [{ type: 'text', text: '开始' }] }];
  for (let i = 0; i < 13; i += 1) {
    messages.push({ role: 'assistant', content: 'ok' });
    messages.push({
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: `data:image/png;base64,${'A'.repeat(100 + i)}` } }],
    });
  }
  messages.push({ role: 'assistant', content: 'ok' });
  messages.push({ role: 'user', content: [{ type: 'text', text: '继续聊' }] });

  assert.deepEqual(collectImages(messages), [], '最后一条 user 没有图片时不应该收集任何历史图片');
});

test('collectImages: 只看最后一条 user 消息里的图片', () => {
  const messages = [
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,OLD' } }] },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,NEW' } }] },
  ];
  const images = collectImages(messages);
  assert.equal(images.length, 1);
  assert.equal(images[0].url, 'data:image/png;base64,NEW');
});

test('collectImages: 最后一条消息自己超过 8 张才报错', () => {
  const messages = [
    {
      role: 'user',
      content: Array.from({ length: 9 }, (_, i) => ({
        type: 'image_url',
        image_url: { url: `data:image/png;base64,IMG${i}` },
      })),
    },
  ];
  assert.throws(() => collectImages(messages), /一条请求最多 8 张图片/);
});
