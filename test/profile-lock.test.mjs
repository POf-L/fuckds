import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  launchOrReusePersistent,
  profileLockPath,
  readProfileLock,
  releaseProfileLock,
} from '../src/browser/profile-lock.mjs';

function tmpProfile() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'fuckds-profile-'));
}

function fakeContext() {
  return {
    on() {},
    browser() {
      return { isConnected: () => true };
    },
    async close() {},
  };
}

function writeLock(profileDir, payload) {
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(profileLockPath(profileDir), JSON.stringify(payload));
}

test('陈旧锁（进程已死）：清锁后自己启动，并写入新锁', async () => {
  const profileDir = tmpProfile();
  writeLock(profileDir, { pid: 999_999_999, at: Date.now() });
  let launchCalls = 0;
  const result = await launchOrReusePersistent({
    chromium: {},
    profileDir,
    readyTimeoutMs: 0,
    launch: async (extraArgs) => {
      launchCalls += 1;
      assert.deepEqual(extraArgs, ['--remote-debugging-port=0']);
      return fakeContext();
    },
  });
  assert.equal(launchCalls, 1);
  assert.equal(result.reused, false);
  assert.equal(readProfileLock(profileDir).pid, process.pid);
  await result.release();
  assert.equal(fs.existsSync(profileLockPath(profileDir)), false);
});

test('锁被活进程持有且 CDP 可达：只复用，不启动第二个实例', async () => {
  const profileDir = tmpProfile();
  const server = http.createServer((req, res) => {
    if (req.url === '/json/version') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"Browser":"Chromium"}');
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(path.join(profileDir, 'DevToolsActivePort'), `${port}\n/devtools/browser/x\n`);
    writeLock(profileDir, { pid: process.ppid, at: Date.now(), port });

    let launchCalls = 0;
    const sharedContext = fakeContext();
    const result = await launchOrReusePersistent({
      chromium: {
        connectOverCDP: async (url) => {
          assert.equal(url, `http://127.0.0.1:${port}`);
          return { contexts: () => [sharedContext], close: async () => {} };
        },
      },
      profileDir,
      readyTimeoutMs: 0,
      launch: async () => {
        launchCalls += 1;
        return fakeContext();
      },
    });
    assert.equal(launchCalls, 0, '有活实例时绝不能启动第二个浏览器');
    assert.equal(result.reused, true);
    assert.equal(result.context, sharedContext);
    // 复用方不释放别人的锁
    await result.release();
    assert.ok(fs.existsSync(profileLockPath(profileDir)));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('锁被活进程持有但 CDP 不可达：拒绝启动，返回 profile_in_use', async () => {
  const profileDir = tmpProfile();
  writeLock(profileDir, { pid: process.ppid, at: Date.now(), port: 1 });
  let launchCalls = 0;
  await assert.rejects(
    () => launchOrReusePersistent({
      chromium: {},
      profileDir,
      waitMs: 150,
      readyTimeoutMs: 0,
      launch: async () => {
        launchCalls += 1;
        return fakeContext();
      },
    }),
    (err) => err.code === 'profile_in_use',
  );
  assert.equal(launchCalls, 0);
});

test('releaseProfileLock 不会删掉别的进程持有的锁', () => {
  const profileDir = tmpProfile();
  writeLock(profileDir, { pid: process.ppid, at: Date.now() });
  assert.equal(releaseProfileLock(profileDir, process.pid), false);
  assert.ok(fs.existsSync(profileLockPath(profileDir)));
});
