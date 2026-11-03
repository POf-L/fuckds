import fs from 'node:fs';

import { DeepSeekWeb } from './browser/driver.mjs';
import { DirectEngine } from './direct/client.mjs';
import { HybridEngine } from './hybrid/client.mjs';
import { LightEngine } from './light/client.mjs';

/**
 * 选择引擎（默认 direct）：
 *   ENGINE=direct  只直连（需要 bin/ds-pow）；条件不满足直接抛错
 *   ENGINE=browser 只走 Playwright（驱动真实网页，不依赖 PoW 求解器）
 *   ENGINE=light   浏览器网络栈 + 页面内 fetch（不驱动 UI，也不需要 token 文件）
 *   ENGINE=hybrid  真实键鼠事件驱动页面，抓页面原生补全流（不读 DOM 文本）
 *   ENGINE=auto    有 Go 求解器就直连，否则回退浏览器
 */
export function createEngine({ config, logger }) {
  // 未显式指定时默认 direct
  const engine = config.engine ?? 'direct';

  // light / hybrid 的登录态在浏览器里，不读 data/auth.json，也不需要 token
  if (engine === 'light') {
    return new LightEngine({ config, logger: logger.child('light') });
  }
  if (engine === 'hybrid') {
    return new HybridEngine({ config, logger: logger.child('hybrid') });
  }

  const wantDirect = engine !== 'browser';
  const binExists = fs.existsSync(config.direct.powBin);
  const canDirect = binExists && Boolean(config.deepseek.token);

  if (wantDirect && canDirect) {
    return new DirectEngine({ config, logger: logger.child('direct') });
  }

  if (engine === 'direct') {
    throw new Error(
      `ENGINE=direct 但条件不满足：powBin=${config.direct.powBin}（存在=${binExists}），token=${Boolean(config.deepseek.token)}。先执行 npm run pow:build`,
    );
  }
  if (wantDirect) {
    logger.warn('没有可用的 Go PoW 求解器（npm run pow:build），回退到 Playwright 引擎');
  }
  return new DeepSeekWeb({ config, logger: logger.child('web') });
}