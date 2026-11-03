/**
 * hybrid 实测脚本（默认不消耗上游额度）：
 *
 *   node scripts/measure-hybrid.mjs behavior      # 本地 fixture：补齐前/后的事件类型与数量、节奏分布
 *   node scripts/measure-hybrid.mjs resource      # 独立 profile：冷启动、进程树、内存、空闲回收
 *
 * behavior 用真实 Chromium + CDP 输入事件，页面只是本地 textarea/按钮，不访问 DeepSeek。
 * resource 会启动独立 profile（默认 data/hybrid-profile），若未登录会在登录页停下并抛 AuthExpired，
 * 但仍可测「启动 → 页面加载 → 空闲关闭 → 冷启动」的资源数据；不会碰任何外部浏览器。
 */

import { execFileSync } from 'node:child_process';

import { chromium } from 'playwright';

import { CONFIG_ROOT, loadConfig } from '../src/config.mjs';
import { HybridEngine, bezierPath, keyInfoForChar, planTyping } from '../src/hybrid/client.mjs';

const mode = process.argv[2] || 'behavior';
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));

const EVENT_LIST = [
  'keydown', 'keyup', 'input', 'beforeinput', 'click', 'mousedown', 'mouseup',
  'mousemove', 'pointermove', 'compositionstart', 'compositionupdate', 'compositionend',
];

async function snapshot(page) {
  return page.evaluate(() => ({ value: document.querySelector('#input')?.value ?? '', counts: window.__EV__ }));
}

async function setupFixture(browser) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await page.setContent(`<!doctype html><html><body>
    <textarea id="input" style="position:absolute;left:300px;top:200px;width:600px;height:160px"></textarea>
    <div id="send" role="button" style="position:absolute;left:940px;top:380px;width:64px;height:64px;border-radius:50%;background:#4d6bfe"></div>
  </body></html>`);
  await page.evaluate((events) => {
    window.__EV__ = {};
    for (const name of events) {
      window.__EV__[name] = 0;
      document.addEventListener(name, () => { window.__EV__[name] += 1; }, true);
    }
  }, EVENT_LIST);
  const cdp = await context.newCDPSession(page);
  return { context, page, cdp };
}

const clearInput = (page) =>
  page.evaluate(() => {
    const el = document.querySelector('#input');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(el, '');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    window.__EV__ = Object.fromEntries(Object.keys(window.__EV__).map((k) => [k, 0]));
  });

async function moveOld(cdp, x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: x - 120, y: y - 80, button: 'none', buttons: 0 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
}

async function moveCurve(cdp, start, x, y, target = { x, y }) {
  const path = bezierPath(start, target, { rand: Math.random });
  for (const p of path) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: p.x, y: p.y, button: 'none', buttons: 0 });
    await sleep(p.delay);
  }
  return target;
}

async function click(cdp, x, y) {
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1 });
  await sleep(45);
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1 });
}

async function pressKey(cdp, ch) {
  const info = keyInfoForChar(ch);
  if (!info) {
    await cdp.send('Input.insertText', { text: ch });
    return;
  }
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: info.key, code: info.code, text: ch,
    windowsVirtualKeyCode: info.vk, nativeVirtualKeyCode: info.vk, modifiers: info.modifiers,
  });
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: info.key, code: info.code,
    windowsVirtualKeyCode: info.vk, nativeVirtualKeyCode: info.vk, modifiers: info.modifiers,
  });
}

async function pressEnter(cdp) {
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'Enter', code: 'Enter', text: '\r',
    windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers: 8,
  });
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, modifiers: 8,
  });
}

async function pressBackspace(cdp) {
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', commands: ['deleteBackward'],
    windowsVirtualKeyCode: 8,
  });
  await cdp.send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8,
  });
}

async function typeOld(page, cdp, text) {
  for (const ch of text) {
    if (ch === '\n') await pressEnter(cdp);
    else if (/[\u3400-\u9fff]/.test(ch)) await cdp.send('Input.insertText', { text: ch });
    else await pressKey(cdp, ch);
    await sleep(15);
  }
}

async function typeIme(cdp, word) {
  const latin = 'nihao';
  const first = latin.slice(0, 2);
  await cdp.send('Input.imeSetComposition', { text: first, selectionStart: first.length, selectionEnd: first.length });
  await sleep(45);
  await cdp.send('Input.imeSetComposition', { text: latin, selectionStart: latin.length, selectionEnd: latin.length });
  await sleep(60);
  await cdp.send('Input.insertText', { text: word });
}

async function typeNew(cdp, text) {
  const actions = planTyping(text, { baseMs: 45, rhythm: true, typoRate: 0.015, ime: true });
  for (const action of actions) {
    if (action.kind === 'sleep') await sleep(action.ms);
    else if (action.kind === 'ime') await typeIme(cdp, action.word);
    else if (action.kind === 'key') await pressKey(cdp, action.char);
    else if (action.kind === 'enter') await pressEnter(cdp);
    else if (action.kind === 'backspace') await pressBackspace(cdp);
  }
  return actions;
}

const sumCounts = (a, b) => Object.fromEntries(EVENT_LIST.map((k) => [k, (a[k] || 0) + (b[k] || 0)]));

async function runBehavior() {
  const browser = await chromium.launch({ headless: true });
  try {
    const { page, cdp } = await setupFixture(browser);
    const box = await page.locator('#input').boundingBox();
    const btn = await page.locator('#send').boundingBox();
    const text = '帮我解释一下 HTTP 和 HTTPS 的区别，尽量简短。';

    /* ---------------- 补齐前 ---------------- */
    await clearInput(page);
    await moveOld(cdp, box.x + box.width / 2, box.y + box.height / 2);
    await click(cdp, box.x + box.width / 2, box.y + box.height / 2);
    const oldStartedAt = Date.now();
    await typeOld(page, cdp, text);
    const oldMs = Date.now() - oldStartedAt;
    const oldSnap = await snapshot(page);
    const oldTypeCounts = oldSnap.counts;
    await clearInput(page);
    await moveOld(cdp, btn.x + btn.width / 2, btn.y + btn.height / 2);
    await click(cdp, btn.x + btn.width / 2, btn.y + btn.height / 2);
    await sleep(100);
    const oldClickCounts = await page.evaluate(() => window.__EV__);
    const oldCounts = sumCounts(oldTypeCounts, oldClickCounts);

    /* ---------------- 补齐后 ---------------- */
    await clearInput(page);
    let mouse = { x: box.x - 160, y: box.y - 90 };
    mouse = await moveCurve(cdp, mouse, box.x + box.width / 2, box.y + box.height / 2);
    await sleep(150);
    await click(cdp, box.x + box.width / 2, box.y + box.height / 2);
    const newStartedAt = Date.now();
    const actions = await typeNew(cdp, text);
    const newMs = Date.now() - newStartedAt;
    const newSnap = await snapshot(page);
    const newTypeCounts = newSnap.counts;
    const typos = actions.filter((a) => a.typo).length;
    await clearInput(page);
    // 按钮：曲线接近 → hover 停留 → 微移 → 点击 → 漂移
    mouse = await moveCurve(cdp, mouse, btn.x + btn.width / 2 - 20, btn.y + btn.height / 2);
    await sleep(220);
    mouse = await moveCurve(cdp, mouse, btn.x + btn.width / 2 + 1.5, btn.y + btn.height / 2 - 1, {
      x: btn.x + btn.width / 2 + 1.5,
      y: btn.y + btn.height / 2 - 1,
    });
    await sleep(90);
    await click(cdp, btn.x + btn.width / 2 + 1.5, btn.y + btn.height / 2 - 1);
    await sleep(100);
    mouse = await moveCurve(cdp, mouse, btn.x + btn.width / 2 + 4, btn.y + btn.height / 2 + 2);
    await sleep(60);
    const newClickCounts = await page.evaluate(() => window.__EV__);
    const newCounts = sumCounts(newTypeCounts, newClickCounts);

    const rows = EVENT_LIST.map((name) => ({
      event: name,
      before: oldCounts[name],
      after: newCounts[name],
    }));

    console.log('\n=== 行为层事件对比（本地 fixture，真实 Chromium + CDP）===');
    console.log('文本:', text, `（${text.length} 字）`);
    console.log('输入值一致（前/后）:', JSON.stringify(oldSnap.value === text), JSON.stringify(newSnap.value === text));
    console.table(rows);
    console.log(
      `\n输入耗时：补齐前 ${oldMs}ms（${(oldMs / text.length).toFixed(1)}ms/字） → 补齐后 ${newMs}ms（${(newMs / text.length).toFixed(1)}ms/字），IME词组=${actions.filter((a) => a.kind === 'ime').length}，错字回退=${typos} 次`,
    );
    console.log(
      `鼠标：补齐前 mousemove=${oldCounts.mousemove}，补齐后 mousemove=${newCounts.mousemove}（曲线 ${bezierPath({ x: 0, y: 0 }, { x: 300, y: 200 }).length} 点/次）`,
    );

    console.log('\n=== 不同长度 prompt 的计划输入耗时（planTyping 纯函数）===');
    const base = '请解释这个问题，然后给出结论。';
    const table = [];
    for (const len of [20, 80, 200, 800]) {
      const sample = base.repeat(Math.ceil(len / base.length)).slice(0, len);
      const planned = planTyping(sample, { baseMs: 45, rhythm: true, typoRate: 0.015, ime: true });
      const ms = planned.filter((a) => a.kind === 'sleep').reduce((sum, a) => sum + a.ms, 0);
      table.push({ chars: len, plannedMs: Math.round(ms), msPerChar: Math.round((ms / len) * 10) / 10 });
    }
    console.table(table);
  } finally {
    await browser.close();
  }
}

/**
 * 浏览器进程树：以「本 Node 进程的直接子进程」为根（Playwright 直接 spawn 浏览器），
 * 再按 ParentProcessId 递归。
 * 不用命令行里搜 profile 路径：Windows 上 msedge.exe 的 CommandLine 常常读不到，
 * 会把树算成 1 个进程、内存只有 20MB（明显不真实）。
 */
function processTree() {
  const script = `
$ErrorActionPreference='SilentlyContinue'
$procs = @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,WorkingSetSize)
$rootPid = [int]$env:MEASURE_ROOT_PID
$roots = @($procs | Where-Object { [int]$_.ParentProcessId -eq $rootPid -and $_.Name -match '^(msedge|chrome)\\.exe$' })
$ids = @{}
foreach ($r in $roots) { $ids[[int]$r.ProcessId] = $true }
$changed = $true
while ($changed) {
  $changed = $false
  foreach ($p in $procs) {
    if ($ids.ContainsKey([int]$p.ParentProcessId) -and -not $ids.ContainsKey([int]$p.ProcessId)) {
      $ids[[int]$p.ProcessId] = $true; $changed = $true
    }
  }
}
$sel = @($procs | Where-Object { $ids.ContainsKey([int]$_.ProcessId) })
$mb = 0
if ($sel.Count -gt 0) { $mb = [math]::Round((($sel | Measure-Object WorkingSetSize -Sum).Sum) / 1MB, 1) }
$names = @($sel | Group-Object Name | ForEach-Object { [pscustomobject]@{ name = $_.Name; count = $_.Count } })
[pscustomobject]@{ count = $sel.Count; workingSetMB = $mb; rootPids = @($roots | ForEach-Object { $_.ProcessId }); names = $names } | ConvertTo-Json -Compress
`;
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, MEASURE_ROOT_PID: String(process.pid) },
    encoding: 'utf8',
  });
  return JSON.parse(out.trim());
}

async function runResource() {
  const config = loadConfig();
  config.engine = 'hybrid';
  // 测资源不要连外部浏览器；profile 固定到本仓库 data 下
  config.hybrid.cdpUrl = '';
  config.hybrid.profileDir = config.hybrid.profileDir || `${CONFIG_ROOT}/data/hybrid-profile`;
  config.hybrid.idleCloseMs = Number(process.env.MEASURE_IDLE_MS || 8_000);
  config.hybrid.headless = process.env.MEASURE_HEADLESS === '1';

  const logger = {
    debug() {},
    info: (...args) => console.log('[hybrid]', ...args),
    warn: (...args) => console.warn('[hybrid]', ...args),
    error: (...args) => console.error('[hybrid]', ...args),
    child() {
      return logger;
    },
  };
  const engine = new HybridEngine({ config, logger });
  const lines = [];

  const warm = async (label) => {
    const t0 = Date.now();
    let error = null;
    try {
      await engine.chat({ prompt: '你好' });
    } catch (err) {
      error = err;
    }
    const elapsedMs = Date.now() - t0;
    const info = processTree();
    lines.push({
      label,
      coldStartMs: elapsedMs,
      outcome: error ? `${error.name}: ${String(error.message).slice(0, 60)}` : 'ok',
      profiles: info,
    });
    return error;
  };

  console.log(`\n=== hybrid 资源实测（profile=${config.hybrid.profileDir}，空闲关闭=${config.hybrid.idleCloseMs}ms）===`);
  await warm('第 1 次冷启动');
  const idleStartedAt = Date.now();
  const idleClosedAt = await new Promise((resolve) => {
    const deadline = Date.now() + config.hybrid.idleCloseMs + 20_000;
    const timer = setInterval(() => {
      const info = processTree();
      if (info.count === 0 || Date.now() > deadline) {
        clearInterval(timer);
        resolve({ waitedMs: Date.now() - idleStartedAt, profiles: info });
      }
    }, 500);
  });
  await sleep(500);
  lines.push({ label: '空闲关闭后', profiles: idleClosedAt.profiles, health: engine.health() });
  await warm('第 2 次冷启动（profile 复用）');
  await engine.close();
  await sleep(1_200);
  lines.push({ label: 'engine.close() 后', profiles: processTree() });

  console.log(JSON.stringify(lines, null, 2));
  console.log(`\nprofile 目录：${config.hybrid.profileDir}`);
  console.log(`登录态是否落盘：${processTree().count === 0 ? '浏览器已关闭（cookie/localStorage 仍在 profile 目录）' : '仍有进程'}`);
}

/**
 * 流式对比：同账号、同 prompt，incremental（CDP Network 真增量） vs batch（收完整体回放）。
 * onDelta 的第一次回调时间就是「客户端看到第一个 token」的时间。
 * 两次请求之间留间隔，避免触发风控；只发最短的「你好」。
 */
async function runStream() {
  const config = loadConfig();
  config.engine = 'hybrid';
  config.hybrid.cdpUrl = '';
  config.hybrid.headless = false;
  config.hybrid.idleCloseMs = 0; // 对比期间不要被空闲回收打断

  const logger = {
    debug() {},
    info() {},
    warn: (...args) => console.warn('[hybrid]', ...args),
    error: (...args) => console.error('[hybrid]', ...args),
    child() {
      return logger;
    },
  };
  const engine = new HybridEngine({ config, logger });
  const prompt = '你好';
  const gapMs = Number(process.env.MEASURE_GAP_MS || 60_000);
  const rows = [];

  try {
    for (const streamMode of ['incremental', 'batch']) {
      config.hybrid.streamMode = streamMode;
      const startedAt = Date.now();
      let firstDeltaAt = 0;
      let lastDeltaAt = 0;
      let deltas = 0;
      let thinkingDeltas = 0;
      const result = await engine.chat({
        prompt,
        onDelta: () => {
          deltas += 1;
          const at = Date.now() - startedAt;
          if (!firstDeltaAt) firstDeltaAt = at;
          lastDeltaAt = at;
        },
        onThinking: () => {
          thinkingDeltas += 1;
        },
      });
      const totalMs = Date.now() - startedAt;
      const t = result.timings || {};
      rows.push({
        streamMode,
        reportedMode: t.streamMode,
        chunks: t.chunks,
        deltas,
        thinkingDeltas,
        firstDeltaMsFromStart: firstDeltaAt || null,
        firstDeltaAfterClickMs: firstDeltaAt && t.prepareMs ? firstDeltaAt - t.prepareMs : null,
        lastDeltaMsFromStart: lastDeltaAt || null,
        totalMs,
        prepareMs: t.prepareMs,
        captureMs: t.captureMs,
        textChars: result.text.length,
        usage: Boolean(result.usage?.total_tokens ?? result.usage?.output_tokens ?? result.usage),
      });
      console.log(`[measure] ${streamMode} 完成`, JSON.stringify(rows[rows.length - 1]));
      if (streamMode === 'incremental') await sleep(gapMs);
    }
    console.log('\n=== 真增量 vs 整段回放（同一账号 / 同一 prompt）===');
    console.log(JSON.stringify(rows, null, 2));
  } finally {
    await engine.close().catch(() => {});
  }
}

/**
 * 单条「你好」：默认配置（拟人化全关）下的端到端耗时、输入阶段耗时、首字延迟，
 * 以及真实事件计数（确认快速路径仍产生 keydown/keyup/input/beforeinput）。
 * 只发一条消息，低频验证。
 */
async function runSingle() {
  const config = loadConfig();
  config.engine = 'hybrid';
  config.hybrid.cdpUrl = '';
  config.hybrid.idleCloseMs = 0;
  const logger = {
    debug() {},
    info() {},
    warn: (...args) => console.warn('[hybrid]', ...args),
    error: (...args) => console.error('[hybrid]', ...args),
    child() {
      return logger;
    },
  };
  const engine = new HybridEngine({ config, logger });
  try {
    const startedAt = Date.now();
    let firstDeltaAt = 0;
    let deltas = 0;
    const result = await engine.chat({
      prompt: '你好',
      onDelta: () => {
        deltas += 1;
        if (!firstDeltaAt) firstDeltaAt = Date.now() - startedAt;
      },
    });
    const totalMs = Date.now() - startedAt;
    const status = engine.status();
    const ui = status.lastUiTrace || {};
    const after = ui.after || {};
    console.log('\n=== 单条「你好」（默认快速档）===');
    console.log(JSON.stringify({
      totalMs,
      typingMs: status.lastTypingTrace?.typingMs ?? null,
      keyEventChars: status.lastTypingTrace?.keyEventChars ?? null,
      imeWords: status.lastTypingTrace?.imeWords ?? null,
      typos: status.lastTypingTrace?.typos ?? null,
      prepareMs: result.timings?.prepareMs ?? null,
      captureMs: result.timings?.captureMs ?? null,
      firstDeltaMsFromStart: firstDeltaAt || null,
      firstDeltaAfterClickMs: firstDeltaAt && result.timings?.prepareMs ? firstDeltaAt - result.timings.prepareMs : null,
      deltas,
      chunks: result.timings?.chunks ?? null,
      streamMode: result.timings?.streamMode ?? null,
      textChars: result.text.length,
      usage: Boolean(result.usage),
      events: {
        keydown: after.keydown,
        keyup: after.keyup,
        beforeinput: after.beforeinput,
        input: after.input,
        click: after.click,
        mousedown: after.mousedown,
        mouseup: after.mouseup,
        mousemove: after.mousemove,
        compositionstart: after.compositionstart,
        compositionend: after.compositionend,
      },
      inputMethod: ui.inputMethod,
      mouseCurve: ui.mouseCurve,
    }, null, 2));
    console.log('\n请求指纹（脱敏）:', JSON.stringify(status.lastTrace, null, 2));
  } finally {
    await engine.close().catch(() => {});
  }
}

/**
 * 只读审计：不发送任何消息，只列出 cookie 名（不含值）、localStorage 键名、
 * navigator 可观测字段、页面实际发出的 API 请求里风控头的存在性与变化。
 * 用独立 profile 直接打开 chat 页面；两次 reload 对比 x-hif / pow 是否每次重新生成。
 */
async function runAudit() {
  const config = loadConfig();
  const { chromium } = await import('playwright');
  const { hybridLaunchArgs } = await import('../src/hybrid/client.mjs');
  const { createHash } = await import('node:crypto');
  const ctx = await chromium.launchPersistentContext(config.hybrid.profileDir, {
    headless: false,
    channel: config.hybrid.channel || undefined,
    args: hybridLaunchArgs(),
  });
  const hash = (v) => (v ? createHash('sha256').update(String(v)).digest('hex').slice(0, 10) : null);
  const samples = [];
  const page = ctx.pages()[0] || (await ctx.newPage());
  const onRequest = (req) => {
    const url = req.url();
    if (!/chat\.deepseek\.com\/api\//.test(url)) return;
    const h = req.headers();
    const risk = {
      at: new Date().toISOString(),
      path: url.replace(/^https:\/\/chat\.deepseek\.com/, '').split('?')[0],
      has: {
        pow: Boolean(h['x-ds-pow-response']),
        leim: Boolean(h['x-hif-leim']),
        dliq: Boolean(h['x-hif-dliq']),
        deviceId: Boolean(h['x-device-id']),
        deviceModel: Boolean(h['x-device-model']),
      },
      // 只比较「是否每次都不同」，不保留原值
      digest: {
        pow: hash(h['x-ds-pow-response']),
        leim: hash(h['x-hif-leim']),
        dliq: hash(h['x-hif-dliq']),
      },
    };
    samples.push(risk);
  };
  ctx.on('request', onRequest);
  try {
    for (const round of [1, 2]) {
      await page.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded' }).catch(() => {});
      await page.waitForFunction(() => Boolean(localStorage.getItem('userToken')), { timeout: 15000 }).catch(() => {});
      await page.waitForTimeout(2500);
      console.log(`[audit] 第 ${round} 轮页面请求数=${samples.length}`);
      if (round === 1) {
        await page.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
        await page.waitForTimeout(2500);
      }
    }
    const cookies = await ctx.cookies('https://chat.deepseek.com');
    const localKeys = await page.evaluate(() => Object.keys(localStorage)).catch(() => []);
    // 只看缓存值的结构（键名/类型），不读签名内容
    const cacheShape = await page.evaluate(() => {
      const out = {};
      for (const name of ['hif_leim_cached', 'hif_dliq_cached']) {
        const raw = localStorage.getItem(name);
        if (!raw) {
          out[name] = null;
          continue;
        }
        try {
          const parsed = JSON.parse(raw);
          out[name] = {
            topLevel: Array.isArray(parsed) ? 'array' : typeof parsed,
            keys: parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? Object.keys(parsed) : [],
            numericFields: parsed && typeof parsed === 'object'
              ? Object.keys(parsed).filter((k) => typeof parsed[k] === 'number')
              : [],
          };
        } catch {
          out[name] = { topLevel: 'string', length: raw.length, keys: [], numericFields: [] };
        }
      }
      return out;
    }).catch(() => null);
    const nav = await page.evaluate(() => ({
      userAgent: navigator.userAgent,
      webdriver: navigator.webdriver,
      languages: navigator.languages,
      platform: navigator.platform,
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemory: navigator.deviceMemory,
      brands: navigator.userAgentData?.brands || null,
    })).catch(() => null);
    console.log('\n=== 风控只读审计（无消息发送）===');
    console.log(JSON.stringify({
      cookies: cookies.map((c) => ({
        name: c.name, domain: c.domain, httpOnly: c.httpOnly, secure: c.secure, sameSite: c.sameSite,
      })), // 只列名与属性，不打印值
      localStorageKeys: localKeys,
      hasDeviceId: localKeys.includes('deepseek-device-id:chat'),
      hifCacheShape: cacheShape,
      navigator: nav,
      apiSummary: (() => {
        const byPath = {};
        for (const s of samples) {
          const cur = byPath[s.path] || { requests: 0, has: { ...s.has }, digests: { pow: [], leim: [], dliq: [] } };
          cur.requests += 1;
          for (const k of ['pow', 'leim', 'dliq']) {
            if (s.digest[k] && !cur.digests[k].includes(s.digest[k])) cur.digests[k].push(s.digest[k]);
          }
          byPath[s.path] = cur;
        }
        return byPath;
      })(), // 只保留摘要：每个 path 出现次数 + 风控头是否存在 + 签名摘要去重数
    }, null, 2));
  } finally {
    ctx.removeListener('request', onRequest);
    await ctx.close().catch(() => {});
  }
}

if (mode === 'resource') await runResource();
else if (mode === 'stream') await runStream();
else if (mode === 'single') await runSingle();
else if (mode === 'audit') await runAudit();
else await runBehavior();
