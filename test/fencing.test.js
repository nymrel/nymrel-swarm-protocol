const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { AtomicLockManager } = require('../dist/fencing/lock');
const { FencingClock } = require('../dist/fencing/fencing');

describe('Fencing & Atomic Lock Manager', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-fencing-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('acquires and releases atomic lock', async () => {
    const lockMgr = new AtomicLockManager(tmpDir);
    const handle = await lockMgr.acquireLock('test_lock', { timeout_ms: 1000 });
    assert.ok(handle);
    assert.equal(handle.lock_name, 'test_lock');
    assert.ok(fs.existsSync(handle.lock_path));

    await lockMgr.releaseLock(handle);
    assert.equal(fs.existsSync(handle.lock_path), false);
  });

  test('withLock executes code and safely releases lock', async () => {
    const lockMgr = new AtomicLockManager(tmpDir);
    let executed = false;

    await lockMgr.withLock('scoped_lock', async () => {
      executed = true;
    });

    assert.equal(executed, true);
    // Lock should be released
    const handle = await lockMgr.acquireLock('scoped_lock', { timeout_ms: 500 });
    await lockMgr.releaseLock(handle);
  });

  test('increments fencing generation monotonically', async () => {
    const clock = new FencingClock(tmpDir);

    const token1 = await clock.incrementGeneration('repo/backend', 'agent-alpha');
    assert.equal(token1.generation, 1);
    assert.equal(token1.claimant, 'agent-alpha');
    assert.ok(token1.token.startsWith('fenc_gen1_'));

    const token2 = await clock.incrementGeneration('repo/backend', 'agent-beta');
    assert.equal(token2.generation, 2);
    assert.equal(token2.claimant, 'agent-beta');
    assert.ok(token2.token.startsWith('fenc_gen2_'));

    // Validate generation
    const isValidToken2 = await clock.validateGeneration('repo/backend', token2);
    assert.equal(isValidToken2, true);

    // Older token1 must be invalid now
    const isValidToken1 = await clock.validateGeneration('repo/backend', token1);
    assert.equal(isValidToken1, false);
  });
});
