import fs from 'node:fs';

import { DeepSeekWeb } from './browser/driver.mjs';
import { DirectEngine } from './direct/client.mjs';
import { HybridEngine } from './hybrid/client.mjs';
import { LightEngine } from './light/client.mjs';
import { ProtocolEngine } from './protocol/client.mjs';

/**
 * 选择引擎（默认 direct）：
 *   ENGINE=direct  只直连（需要 bin/ds-pow）；条件不满足直接抛错
 *   ENGINE=browser 只走 Playwright（驱动真实网页，不依赖 PoW 求解器）
 *   ENGINE=light   浏览器网络栈 + 页面内 fetch（不驱动 UI，也不需要 token 文件）
 *   ENGINE=hybrid  真实键鼠事件驱动页面，抓页面原生补全流（不读 DOM 文本）
 *   ENGINE=protocol 协议优先：Node 直接 HTTPS（cookie + hif + PoW），失败按证据刷新/降级
 *   ENGINE=auto    有 Go 求解器且已有协议凭据就走 protocol，否则直连/浏览器
 */
// Go 产物在 Windows 上带 .exe，配置默认值仍是 bin/ds-pow，这里统一判断
function powBinExists(bin) {
  if (!bin) return false;
  return fs.existsSync(bin) || (process.platform === 'win32' && fs.existsSync(`${bin}.exe`));
}

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
  if (engine === 'protocol') {
    if (!powBinExists(config.direct.powBin)) {
      throw new Error(`ENGINE=protocol 需要 PoW 求解器 ${config.direct.powBin}，先执行 npm run pow:build`);
    }
    return new ProtocolEngine({ config, logger: logger.child('protocol') });
  }

  const binExists = powBinExists(config.direct.powBin);
  const canDirect = binExists && Boolean(config.deepseek.token);
  const hasAccountFiles = (() => {
    try {
      return fs.readdirSync(config.protocol.accountsDir).some((name) => name.endsWith('.json'));
    } catch {
      return false;
    }
  })();
  if (engine === 'auto' && binExists && (fs.existsSync(config.protocol.credentialsFile) || hasAccountFiles)) {
    logger.info('auto：发现协议凭据，优先走 protocol（不启动浏览器）');
    return new ProtocolEngine({ config, logger: logger.child('protocol') });
  }
  const wantDirect = engine !== 'browser';

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