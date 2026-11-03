#!/usr/bin/env node
/** 编译 Go 版 PoW 求解器：go build -o bin/ds-pow ./cmd/powd */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const candidates = [
  process.env.GO_BIN,
  'go',
  path.join(process.env.HOME || '', '.local', 'go', 'bin', 'go'),
  '/usr/local/go/bin/go',
].filter(Boolean);

const go = candidates.find((bin) => {
  try {
    return spawnSync(bin, ['version'], { stdio: 'ignore' }).status === 0;
  } catch {
    return false;
  }
});

if (!go) {
  console.error('找不到 Go 工具链。安装 Go 1.21+ 后重试，或把 GO_BIN 指向 go 可执行文件。');
  process.exit(1);
}

fs.mkdirSync(path.join(root, 'bin'), { recursive: true });
// Windows 上 CreateProcess 不会自动补 .exe，Node spawn 无扩展名的 PE 会报 ENOENT
const binName = process.platform === 'win32' ? 'ds-pow.exe' : 'ds-pow';
const binPath = path.join(root, 'bin', binName);
const result = spawnSync(go, ['build', '-o', binPath, './cmd/powd'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, CGO_ENABLED: '0' },
});
if (result.status !== 0) process.exit(result.status ?? 1);
console.log(`✅ 已生成 ${path.relative(root, binPath)}`);
