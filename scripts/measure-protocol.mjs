import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

import { loadConfig } from '../src/config.mjs';
import { createLogger } from '../src/logger.mjs';
import { createEngine } from '../src/engine.mjs';

/**
 * 协议通道实测：一条最短消息「你好」。
 *   node scripts/measure-protocol.mjs            # 有缓存就用缓存（warm）
 *   node scripts/measure-protocol.mjs --cold     # 删掉缓存，走「采集凭据 → 请求」冷路径
 * 只打印脱敏信息（不输出 token/cookie/hif 值）。
 */

const mode = process.argv.includes('--cold') ? 'cold' : 'warm';
const config = loadConfig();
const logger = createLogger('warn', 'protocol-measure');
config.engine = 'protocol';

if (mode === 'cold') {
  fs.rmSync(config.protocol.credentialsFile, { force: true });
}

/** 以本 Node 进程为根的浏览器进程树（协议通道正常应为 0） */
function browserTree() {
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
[pscustomobject]@{ count = $sel.Count; workingSetMB = $mb } | ConvertTo-Json -Compress
`;
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    env: { ...process.env, MEASURE_ROOT_PID: String(process.pid) },
    encoding: 'utf8',
  });
  return JSON.parse(out.trim());
}

const rss = () => Math.round(process.memoryUsage().rss / (1024 * 1024));
const startedAt = Date.now();
const rssBefore = rss();
const browserBefore = browserTree();
const engine = createEngine({ config, logger });
let firstDeltaAt = 0;
let deltas = 0;
try {
  const result = await engine.chat({
    prompt: '你好',
    onDelta: () => {
      deltas += 1;
      if (!firstDeltaAt) firstDeltaAt = Date.now() - startedAt;
    },
  });
  const totalMs = Date.now() - startedAt;
  const status = engine.status();
  const browserAfter = browserTree();
  console.log(JSON.stringify({
    mode,
    totalMs,
    firstDeltaMsFromStart: firstDeltaAt || null,
    deltas,
    textChars: result.text.length,
    text: result.text.slice(0, 120),
    usage: Boolean(result.usage),
    timings: result.timings || null,
    status: {
      layer: status.layer,
      degradations: status.degradations,
      lastReason: status.lastReason,
      credentialSource: status.credentialSource,
      lastHarvestMs: status.lastHarvestMs,
      credentials: status.credentials,
    },
    memory: {
      nodeRssBeforeMB: rssBefore,
      nodeRssAfterMB: rss(),
      browserProcessesBefore: browserBefore,
      browserProcessesAfter: browserAfter,
    },
  }, null, 2));
} finally {
  await engine.close().catch(() => {});
}
