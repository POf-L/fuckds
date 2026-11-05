/**
 * 挑战恢复 / 冒烟（recover:challenge）
 *
 * 使用场景：上游返回 `{ code: 40303, msg: 'CHALLENGE_REQUIRED' }`，网关立刻停止自动重试，
 * 需要人在「已经登录的同一个浏览器实例」里完成人机挑战。本脚本只做三件事：
 *   1. 找到已存在的 profile 浏览器实例（profile-lock / CDP 复用），**绝不新开第二个实例**；
 *   2. 在该实例里打开/切到对话页，检测是否还有挑战，提示人在页面里完成；
 *   3. 挑战消失且 `userToken` + hif 缓存都就绪后，采集凭据写入 data/（0600），
 *      只打印哈希前缀与布尔状态，**绝不打印任何凭据值**。
 *
 * 用法：
 *   npm run recover:challenge                # 复用已存在的实例，最多等 10 分钟
 *   RECOVER_TIMEOUT_MS=300000 npm run recover:challenge   # 自定义超时（毫秒）
 *   RECOVER_POLL_MS=1500 npm run recover:challenge        # 自定义轮询间隔（毫秒）
 *   node scripts/recover-challenge.mjs --help
 *
 * 前置条件：
 *   - 有一个正在运行的 profile 实例（网关 protocol 模式 / 手动 `npm run auth:hybrid` 留下的都算）；
 *   - 没有活实例时本脚本直接退出并提示 `npm run auth:hybrid`，不会自己拉起浏览器。
 *
 * 退出码：0 = 凭据已恢复并写入；1 = 无活实例 / 超时 / 只拿到匿名 token。
 * 输出：单行 JSON（ok / reason / 状态位 / 写入的文件路径）；凭据值一律不出现。
 */

import fs from 'node:fs';
import path from 'node:path';

import { chromium } from 'playwright';

import { looksLikeLoginToken } from '../src/auth/credential-state.mjs';
import { liveProfilePort } from '../src/browser/profile-lock.mjs';
import { loadConfig } from '../src/config.mjs';
import { fingerprintOf } from '../src/direct/account-pool.mjs';
import {
  credentialSummary,
  extractCredentialsFromContext,
  hasLoginMarker,
  saveCredentials,
} from '../src/protocol/credentials.mjs';

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) {
  console.log(`用法: npm run recover:challenge
环境变量:
  RECOVER_TIMEOUT_MS  总等待时间，默认 600000（10 分钟）
  RECOVER_POLL_MS     轮询间隔，默认 2500
说明: 只复用已存在的浏览器实例，不会新开第二个；完成挑战后自动写入 data/。`);
  process.exit(0);
}

const TIMEOUT_MS = Number(process.env.RECOVER_TIMEOUT_MS || 10 * 60_000);
const POLL_MS = Number(process.env.RECOVER_POLL_MS || 2_500);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 挑战特征：页面文案 + 验证类 iframe + 验证类容器（只看存在性，不输出正文） */
function inspectPage(page) {
  return page
    .evaluate(() => {
      const text = (document.body?.innerText || '').slice(0, 4_000);
      const patterns = [
        /人机验证/,
        /安全验证/,
        /完成验证/,
        /拖动滑块/,
        /请完成(下方|以上)?验证/,
        /verify you are (human|a robot)/i,
        /are you a robot/i,
      ];
      const textHits = patterns.filter((re) => re.test(text)).map((re) => String(re));
      const iframes = Array.from(document.querySelectorAll('iframe'))
        .map((el) => String(el.src || ''))
        .filter((src) => /captcha|challenge|verify|waf/i.test(src))
        .slice(0, 5);
      const nodes = Array.from(
        document.querySelectorAll(
          '[class*="captcha" i],[id*="captcha" i],[class*="challenge" i],[id*="challenge" i]',
        ),
      )
        .slice(0, 5)
        .map((el) => `${el.tagName.toLowerCase()}${el.id ? `#${el.id}` : ''}`);
      let hasUserToken = false;
      try {
        hasUserToken = Boolean(localStorage.getItem('userToken'));
      } catch {
        /* ignore */
      }
      return { textHits, iframes, nodes, hasUserToken, url: location.href };
    })
    .catch((err) => ({ textHits: [], iframes: [], nodes: [], hasUserToken: false, error: err.message }));
}

function report(payload, code = 0) {
  console.log(JSON.stringify(payload, null, 2));
  process.exit(code);
}

const config = loadConfig();
const profileDir = config.hybrid.profileDir;
const baseUrl = (config.deepseek.baseUrl || 'https://chat.deepseek.com').replace(/\/+$/, '');

// 关键约束：只探测，不启动。没有活实例 → 交回给用户显式 `npm run auth:hybrid`。
const port = await liveProfilePort(profileDir);
if (!port) {
  report(
    {
      ok: false,
      reason: 'no-live-instance',
      profileDir,
      hint: '没有可复用的浏览器实例；本脚本拒绝新开第二个。请先运行 `npm run auth:hybrid`（它会复用单实例锁）',
    },
    1,
  );
}

let browser;
try {
  browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
  const context = browser.contexts()[0];
  if (!context) {
    report({ ok: false, reason: 'no-context', port, hint: 'CDP 已连上但没有上下文，请重启该实例' }, 1);
  }

  // 优先复用已经在对话页上的标签，避免多开页面；没有就新建一个页面（不是新浏览器实例）。
  const pages = context.pages();
  let page = pages.find((p) => String(p.url()).includes('chat.deepseek.com')) || pages[0];
  if (!page) page = await context.newPage();
  await page
    .goto(`${baseUrl}/`, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    .catch((err) => console.log(`打开对话页失败（继续用当前页面）：${err.message}`));

  console.log(
    `已复用现有浏览器实例（CDP ${port}），最多等待 ${Math.round(TIMEOUT_MS / 1000)}s。` +
      '如果页面出现人机挑战/验证，请直接在浏览器里手动完成。',
  );

  const deadline = Date.now() + TIMEOUT_MS;
  let last = null;
  let announced = false;

  while (Date.now() < deadline) {
    const state = await inspectPage(page);
    const challenged = state.textHits.length > 0 || state.iframes.length > 0 || state.nodes.length > 0;

    let creds = null;
    if (state.hasUserToken) {
      creds = await extractCredentialsFromContext(context, page).catch(() => null);
    }
    const signedIn = Boolean(creds?.userToken) && looksLikeLoginToken(creds.userToken);
    const hasHif = hasLoginMarker(creds || {});

    last = {
      at: new Date().toISOString(),
      challenge: challenged,
      challengeSignals: state.textHits,
      challengeIframes: state.iframes,
      challengeNodes: state.nodes,
      signedIn,
      hasHif,
      page: state.url,
    };

    if (challenged && !announced) {
      announced = true;
      console.log('检测到人机挑战：请在已打开的浏览器页面里手动完成（脚本会继续等待）。');
    }
    if (!challenged) announced = false;

    // 成功判据：挑战消失 + 登录 token 形状正确 + hif 登录标记就绪
    if (!challenged && signedIn && hasHif) {
      const files = [];
      const primary = config.protocol.credentialsFile;
      saveCredentials(primary, creds);
      files.push(primary);

      // 与 protocol 多账号目录保持同一命名规则，网关重启后可直接读到
      fs.mkdirSync(config.protocol.accountsDir, { recursive: true });
      const accountFile = path.join(
        config.protocol.accountsDir,
        `account-${fingerprintOf(creds.userToken)}.json`,
      );
      saveCredentials(accountFile, creds);
      files.push(accountFile);

      // 只输出哈希前缀 / 布尔位 / cookie 名称，不输出任何值
      report({
        ok: true,
        reason: 'recovered',
        port,
        files,
        tokenHashPrefix: fingerprintOf(creds.userToken).slice(0, 12),
        summary: credentialSummary(creds),
      });
    }

    await sleep(POLL_MS);
  }

  report(
    {
      ok: false,
      reason: 'timeout',
      port,
      last,
      hint: last?.challenge
        ? '挑战仍未完成：请在浏览器里完成验证后重新运行'
        : !last?.signedIn
          ? '页面里没有有效的登录 token：请先在该浏览器里登录'
          : '缺少 hif 缓存：请保持页面打开稍等，或重新运行 `npm run auth:hybrid`',
    },
    1,
  );
} catch (err) {
  report({ ok: false, reason: 'error', port, message: err.message }, 1);
} finally {
  // connectOverCDP 的 close 只断开本客户端，不会关闭用户的浏览器/页面
  await browser?.close?.().catch(() => {});
}
