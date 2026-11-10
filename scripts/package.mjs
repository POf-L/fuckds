import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 打干净的发布包：之前有人直接把工作目录压成 zip，
 * web/node_modules（55MB）和 test/.artifacts（测试截图）全被带进去，
 * 56MB 的包里源码其实只有约 2MB。
 *
 * 用法：npm run package
 * 产物：fuckds-optimized.zip（优先用 zip；没有 zip 时退回 tar.gz）
 * 排除：node_modules、data、.env、测试产物、.bak、.git、
 *       以及本脚本生成的旧包。
 * web/dist 是构建产物（仓库里不提交），但如果本地已经构建过，
 * 打包时一并带上，解压后 /admin 可直接用，不用先构建。
 */
const ROOT = path.resolve(import.meta.dirname, '..');
const out = path.join(ROOT, 'fuckds-optimized.zip');
const excludes = [
  'node_modules/*',
  'web/node_modules/*',
  'data/*',
  '.env',
  'test/.artifacts/*',
  '*.bak',
  '.git/*',
  'fuckds-optimized.zip',
  'fuckds-optimized.tar.gz',
];

function run(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit' });
  if (r.error) return false;
  return r.status === 0;
}

for (const old of [out, path.join(ROOT, 'fuckds-optimized.tar.gz')]) {
  try { fs.unlinkSync(old); } catch { /* 不存在就跳过 */ }
}

if (run('zip', ['-r', '-q', out, '.', ...excludes.flatMap((e) => ['-x', e])])) {
  console.log(`已生成 ${out}（${(fs.statSync(out).size / 1024 / 1024).toFixed(2)} MB）`);
  process.exit(0);
}

const tarOut = path.join(ROOT, 'fuckds-optimized.tar.gz');
const tarArgs = ['-czf', tarOut, ...excludes.flatMap((e) => ['--exclude', e]), '.'];
if (run('tar', tarArgs)) {
  console.log(`zip 不可用，已改用 tar 生成 ${tarOut}（${(fs.statSync(tarOut).size / 1024 / 1024).toFixed(2)} MB）`);
  process.exit(0);
}

console.error('打包失败：本机既没有 zip 也没有 tar');
process.exit(1);
