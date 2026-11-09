import { useCallback, useEffect, useState } from 'react';

import { adminApi } from '../api.js';
import {
  Btn,
  Card,
  Chip,
  ErrorBanner,
  Stat,
  askConfirm,
  formatMs,
  formatTime,
  formatUptime,
  notify,
  toast,
} from '../ui.jsx';

export default function Overview({ navigate }) {
  const [data, setData] = useState(null);
  const [logs, setLogs] = useState([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [restarting, setRestarting] = useState(false);

  const load = useCallback(async () => {
    try {
      const [overview, tail] = await Promise.all([
        adminApi('/overview'),
        adminApi('/logs?lines=12').catch(() => ({ lines: [] })),
      ]);
      setData(overview);
      setLogs(tail.lines ?? []);
      setError('');
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
    const timer = setInterval(load, 8000);
    return () => clearInterval(timer);
  }, [load]);

  const restart = async () => {
    const ok = await askConfirm(
      '重启会短暂中断当前请求，正在进行的对话会被断开。重启后页面会自动重连。',
      '重启服务',
      '立即重启',
    );
    if (!ok) return;
    setRestarting(true);
    try {
      await adminApi('/restart', { method: 'POST' });
      toast('已发出重启指令，等待服务恢复…');
      let recovered = false;
      for (let i = 0; i < 45; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        try {
          const res = await fetch(`/healthz?ts=${Date.now()}`, { cache: 'no-store' });
          if (res.ok) {
            recovered = true;
            break;
          }
        } catch {
          /* 还没起来 */
        }
      }
      if (recovered) {
        toast('服务已恢复');
        await load();
      } else {
        await notify('重启后 45 秒内没有恢复，请到日志页查看原因。', '重启超时');
      }
    } catch (err) {
      await notify(err.message, '重启失败');
    } finally {
      setRestarting(false);
    }
  };

  if (loading) {
    return (
      <div className="page">
        <div className="loading-bar" />
      </div>
    );
  }

  if (!data) {
    return (
      <div className="page">
        <ErrorBanner message={error || '加载失败'} onRetry={load} />
      </div>
    );
  }

  const accounts = data.accounts ?? [];
  const available = accounts.filter((account) => account.available).length;
  const authFailed = accounts.filter((account) => account.authFailed).length;
  const engineLabel = data.engine === 'direct' ? '直连（direct）' : data.engine === 'browser' ? '浏览器（browser）' : data.engine;

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>概览</h1>
          <p className="muted">
            进程 {data.pid} · 启动于 {formatTime(data.startedAt)} · 已运行 {formatUptime(data.uptime_s)}
          </p>
        </div>
        <div className="page-actions">
          <Btn variant="tonal" icon="refresh" onClick={load}>
            刷新
          </Btn>
          <Btn variant="filled" icon="restart_alt" loading={restarting} onClick={restart}>
            重启服务
          </Btn>
        </div>
      </div>

      {error ? <ErrorBanner message={error} onRetry={load} /> : null}

      <div className="stat-grid">
        <Stat
          label="服务状态"
          icon="dns"
          tone={data.ok ? 'ok' : 'error'}
          value={data.ok ? '运行中' : '异常'}
          hint={`${data.config.host}:${data.config.port} · ${engineLabel}`}
        />
        <Stat
          label="登录态"
          icon="vpn_key"
          tone={accounts.length ? (authFailed ? 'error' : 'ok') : 'error'}
          value={accounts.length ? `运行中 ${accounts.length} 个账号` : '未配置'}
          hint={
            accounts.length
              ? `${available} 个当前可用${authFailed ? ` · ${authFailed} 个失效` : ''}${
                  data.engine === 'protocol' && data.savedCount
                    ? ` · 另有 ${data.savedCount} 个粘贴 token（未使用）`
                    : ''
                }`
              : '去「账号」页添加'
          }
        />
        <Stat
          label="模型"
          icon="smart_toy"
          value={`${data.models.length} 个`}
          hint={data.models.slice(0, 3).join(' · ')}
        />
        <Stat
          label="并发 / 排队"
          icon="speed"
          value={`${data.busy} / ${data.queued}`}
          hint={`并发上限 ${data.config.concurrency} · 队列 ${data.config.queueLimit}`}
        />
      </div>

      <Card
        title="账号池"
        subtitle="运行中的号池状态（改完 token 需要重启才生效）"
        actions={
          <Btn variant="text" icon="key" onClick={() => navigate('accounts')}>
            管理账号
          </Btn>
        }
      >
        {accounts.length ? (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>#</th>
                  <th>Token</th>
                  <th>状态</th>
                  <th>请求数</th>
                  <th>冷却</th>
                  <th>最近错误</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((account) => (
                  <tr key={account.index}>
                    <td className="numeric">{account.index}</td>
                    <td className="mono">{account.token}</td>
                    <td>
                      {account.authFailed ? (
                        <Chip tone="error">登录态失效</Chip>
                      ) : account.available ? (
                        <Chip tone="ok">可用</Chip>
                      ) : (
                        <Chip tone="warn">冷却中</Chip>
                      )}
                    </td>
                    <td className="numeric">{account.requests}</td>
                    <td className="numeric">{account.cooldownMs ? formatMs(account.cooldownMs) : '—'}</td>
                    <td className="muted">{account.lastError || '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="banner banner-warn">
            <mdui-icon name="warning_amber" />
            <span>当前进程里没有可用账号，先去「账号」页配置 token。</span>
            <Btn variant="text" onClick={() => navigate('accounts')}>
              去配置
            </Btn>
          </div>
        )}
      </Card>

      <div className="form-grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(360px, 1fr))' }}>
        <Card
          title="最近日志"
          actions={
            <Btn variant="text" endIcon="arrow_forward" onClick={() => navigate('logs')}>
              全部日志
            </Btn>
          }
        >
          {logs.length ? (
            <div className="log-view" style={{ maxHeight: 220 }}>
              {logs.map((line, index) => (
                <span key={index} className="log-line">
                  {line}
                </span>
              ))}
            </div>
          ) : (
            <div className="empty muted">还没有日志（服务用 npm run up 启动后日志写在 data/server.log）</div>
          )}
        </Card>

        <Card title="运行环境">
          <dl className="kv">
            <dt>监听</dt>
            <dd className="mono">
              {data.config.host}:{data.config.port}
            </dd>
            <dt>引擎</dt>
            <dd>{engineLabel}</dd>
            <dt>深度思考</dt>
            <dd>{data.config.thinking}</dd>
            <dt>智能搜索</dt>
            <dd>{data.config.search ? '开启' : '关闭'}</dd>
            <dt>Node</dt>
            <dd className="mono">{data.node}</dd>
            <dt>日志文件</dt>
            <dd className="mono">{data.files.logFile}</dd>
            <dt>号池文件</dt>
            <dd className="mono">{data.files.authFile}</dd>
            <dt>数据目录</dt>
            <dd className="mono">{data.files.dataDir}</dd>
            <dt>API Key</dt>
            <dd>{data.config.apiKeySet ? '已设置（接口需要鉴权）' : '未设置（仅本机可用建议）'}</dd>
          </dl>
        </Card>
      </div>
    </div>
  );
}
