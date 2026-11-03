import { loadConfig } from './config.mjs';
import { createLogger } from './logger.mjs';
import { createEngine } from './engine.mjs';
import { createServer } from './server.mjs';

const config = loadConfig();
const logger = createLogger(config.logLevel);

const web = createEngine({ config, logger });
const server = createServer({ config, logger, web });

const shutdown = async (signal) => {
  logger.info(`收到 ${signal}，正在关闭…`);
  server.close();
  await web.close().catch(() => {});
  process.exit(0);
};

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (err) => logger.error('未处理的 Promise 拒绝:', err));

if (config.runtime.warmup) {
  web.warmUp()
    .then(() => logger.info('浏览器和对话页已预热'))
    .catch((err) => logger.warn('预热失败（首次请求会重新启动）:', err.message));
}

server.listen(config.server.port, config.server.host, () => {
  const base = `http://${config.server.host}:${config.server.port}`;
  logger.info('服务已启动');
  logger.info(`  接口       ${base}/v1/chat/completions`);
  logger.info(`  模型列表   ${base}/v1/models`);
  logger.info(`  健康检查   ${base}/healthz`);
  logger.info(
    `  登录态     ${
      config.engine === 'light'
        ? '浏览器内登录态（light 引擎）'
        : config.deepseek.tokens.length
          ? `已配置 ✅ 号池 ${config.deepseek.tokens.length} 个`
          : '未配置 ❌（npm run auth -- <userToken>）'
    }`,
  );
  logger.info(`  引擎       ${web.status().engine || 'browser'}`);
  logger.info(`  并发       ${config.runtime.concurrency}，单次超时 ${Math.round(config.runtime.requestTimeoutMs / 1000)}s`);
});

server.on('error', (err) => {
  logger.error('HTTP 服务启动失败:', err.message);
  process.exit(1);
});
