import crypto from 'node:crypto';

import { ApiError } from './errors.mjs';

/**
 * server.mjs / admin/routes.mjs 原来各有一份 readJson / sendJson / sendHtml /
 * escapeHtml / API Key 比较，行为还不一致（请求体上限 8MB vs 2MB、
 * 字符串比较 vs 恒时比较）。抽到这里统一，协议层只留路由逻辑。
 */

/** 恒时比较：先对两边做 SHA-256，再比较等长摘要，避免长度/时序泄露。 */
export function isApiKeyValid(provided, expected) {
  if (!expected) return true;
  if (typeof provided !== 'string' || !provided) return false;
  const a = crypto.createHash('sha256').update(provided).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
}

/** 从 Authorization Bearer / x-api-key 里取 key，任一匹配即通过。 */
export function requireApiKey(req, config, { message = 'API Key 无效' } = {}) {
  if (!config.server.apiKey) return;
  const header = req.headers.authorization || '';
  const bearer = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const apiKeyHeader = typeof req.headers['x-api-key'] === 'string' ? req.headers['x-api-key'].trim() : '';
  if (!isApiKeyValid(bearer, config.server.apiKey) && !isApiKeyValid(apiKeyHeader, config.server.apiKey)) {
    throw new ApiError(401, message, { type: 'authentication_error', code: 'invalid_api_key' });
  }
}

export function readJsonBody(req, maxBytes = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let rejected = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBytes && !rejected) {
        rejected = true;
        reject(new ApiError(413, '请求体过大', { code: 'body_too_large' }));
        req.destroy();
        return;
      }
      if (!rejected) chunks.push(chunk);
    });
    req.on('end', () => {
      if (rejected) return;
      if (!chunks.length) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new ApiError(400, '请求体不是合法 JSON', { code: 'invalid_json' }));
      }
    });
    req.on('error', reject);
  });
}

export function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

export function sendHtml(res, status, html) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(html);
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}
