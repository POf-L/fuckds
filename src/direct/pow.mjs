import { spawn } from 'node:child_process';
import fs from 'node:fs';
import readline from 'node:readline';

/**
 * Go 版 PoW 求解器（bin/ds-pow）的进程封装。
 *
 * 为什么用 Go：DeepSeekHashV1 要在 [0, difficulty)（常见 14.4 万）里线性搜索，
 * Go 实测 ~20-30ms，Node 里跑同样逻辑要慢一个数量级。
 */
export class PowSolver {
  constructor({ bin, logger }) {
    this.bin = bin;
    this.log = logger;
    this.proc = null;
    this.pending = new Map();
    this.seq = 0;
  }

  #ensureProcess() {
    if (this.proc && !this.proc.killed) return;

    // Windows 的 Go 产物带 .exe 后缀，配置里的默认值仍是 bin/ds-pow，这里做一次兼容
    let bin = this.bin;
    if (!fs.existsSync(bin) && process.platform === 'win32' && fs.existsSync(`${bin}.exe`)) {
      bin = `${bin}.exe`;
    }

    if (!fs.existsSync(bin)) {
      throw new Error(
        `找不到 PoW 求解器 ${this.bin}，先执行 \`npm run pow:build\`（需要 Go 工具链）`,
      );
    }

    this.proc = spawn(bin, [], { stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc.on('exit', (code) => {
      this.log?.warn(`PoW 求解器退出（code ${code}）`);
      this.proc = null;
      for (const { reject } of this.pending.values()) reject(new Error('PoW 求解器已退出'));
      this.pending.clear();
    });
    this.proc.stderr.on('data', (chunk) => this.log?.debug(`[ds-pow] ${String(chunk).trim()}`));

    const rl = readline.createInterface({ input: this.proc.stdout });
    rl.on('line', (line) => {
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      const waiter = this.pending.get(msg.id);
      if (!waiter) return;
      this.pending.delete(msg.id);
      if (msg.error) waiter.reject(new Error(`PoW: ${msg.error}`));
      else waiter.resolve({ answer: msg.answer, ms: msg.ms });
    });
  }

  solve({ challenge, salt, expireAt, difficulty }) {
    this.#ensureProcess();
    const id = (this.seq += 1);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error('PoW 求解超时'));
      }, 15_000);

      this.pending.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolve(result);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });

      this.proc.stdin.write(
        `${JSON.stringify({ id, challenge, salt, expireAt, difficulty })}\n`,
        (err) => {
          if (err) reject(err);
        },
      );
    });
  }

  close() {
    if (this.proc && !this.proc.killed) this.proc.kill();
    this.proc = null;
    // 先 reject 掉在途请求：它们的 15s 超时定时器只有走 resolve/reject 包装才会被清掉，
    // 否则进程退出（或测试结束）会被这些定时器拖住十几秒。
    for (const { reject } of this.pending.values()) reject(new Error('PoW 求解器已关闭'));
    this.pending.clear();
  }
}
