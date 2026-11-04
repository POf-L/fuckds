import { sleep } from '../util.mjs';

/**
 * 账号级调度：单账号 FIFO + 单飞（in-flight = 1），不同账号之间并行。
 *
 * 硬约束（来自实测发现的缺陷）：同一个账号上任何两条上游请求不允许时间重叠，
 * 哪怕它们属于不同对话。上游网页接口是按「窗口内消息条数」限流的，同时打两条
 * 既会触发风控，也会让 PoW / 会话创建互相抢资源。
 *
 * 另外：单账号除了串行，还要有最小请求间隔（minGapMs）。
 * 队列按入队顺序放行；放行后先等到「上一次放行时间 + minGapMs」，再调用 task。
 *
 * 该调度器只做排队，不做风控伪装：不伪造指纹、不并发探测。
 */
export class AccountScheduler {
  constructor({ pool, logger, minGapMs = 0 }) {
    this.pool = pool;
    this.log = logger;
    this.minGapMs = Math.max(0, Number(minGapMs) || 0);
    /** fingerprint → { account, inflight, queued, lastStartAt, tail } */
    this.states = new Map();
    for (const account of pool.accounts) this.#state(account);
  }

  #state(account) {
    let state = this.states.get(account.fingerprint);
    if (!state) {
      state = { account, inflight: 0, queued: 0, lastStartAt: 0, tail: Promise.resolve() };
      this.states.set(account.fingerprint, state);
    }
    return state;
  }

  /** 该账号当前的排队压力（选择账号时用：负载最低优先） */
  load(account) {
    const state = this.states.get(account.fingerprint);
    return state ? state.inflight + state.queued : 0;
  }

  stats(now = Date.now()) {
    return [...this.states.values()].map((state) => ({
      accountHash: state.account.fingerprint.slice(0, 12),
      index: state.account.index + 1,
      inflight: state.inflight,
      queued: state.queued,
      cooldownMs: Math.max(0, (state.account.cooldownUntil || 0) - now),
      available: (state.account.cooldownUntil || 0) <= now,
      lastStartAt: state.lastStartAt || null,
      minGapMs: this.minGapMs,
    }));
  }

  /**
   * 把一次「上游请求单元」排进该账号的 FIFO 队列。
   * 返回 task 的结果；task 抛错也不影响后续排队（链条照样往下走）。
   */
  run(account, task, { signal } = {}) {
    const state = this.#state(account);
    const previous = state.tail;
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    state.tail = previous.then(() => gate, () => gate);
    state.queued += 1;

    return (async () => {
      await previous.catch(() => {});
      state.queued -= 1;
      if (state.inflight > 0) {
        // 单飞自检：走到这里说明队列实现被破坏了（同一账号出现重叠请求）
        this.log?.warn?.('账号调度自检失败：同一账号出现重叠请求', {
          accountHash: state.account.fingerprint.slice(0, 12),
        });
      }
      const wait = state.lastStartAt + this.minGapMs - Date.now();
      if (wait > 0) await sleep(wait, signal);
      state.lastStartAt = Date.now();
      state.inflight += 1;
      try {
        return await task(account);
      } finally {
        state.inflight -= 1;
        release();
      }
    })();
  }
}
