const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { ClaimManager } = require('../dist/claims/claims');
const { FencingClock } = require('../dist/fencing/fencing');

describe('Concurrency & Collision Protection', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-concurrency-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('only one agent wins exclusive claim race condition', async () => {
    const claims = new ClaimManager(tmpDir);
    const candidateAgents = ['agent-1', 'agent-2', 'agent-3', 'agent-4', 'agent-5'];

    // All 5 agents race simultaneously to acquire 'src/critical-resource'
    const results = await Promise.allSettled(
      candidateAgents.map((agent) =>
        claims.acquireClaim({
          resource_path: 'src/critical-resource',
          owner_agent: agent,
          mode: 'exclusive',
        })
      )
    );

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    assert.equal(fulfilled.length, 1, 'Exactly one agent must win the race');
    assert.equal(rejected.length, 4, 'Remaining 4 agents must be rejected due to conflict');
  });

  test('concurrent fencing increments remain strictly monotonic and serialized', async () => {
    const clock = new FencingClock(tmpDir);
    const n = 25;

    const promises = [];
    for (let i = 0; i < n; i++) {
      promises.push(clock.incrementGeneration('mission-concurrency', `worker-${i}`));
    }

    const tokens = await Promise.all(promises);
    const generations = tokens.map((t) => t.generation);

    assert.equal(generations.length, n);

    // Ensure all generations are unique and in range 1..n
    const genSet = new Set(generations);
    assert.equal(genSet.size, n, 'All generations must be unique');

    for (let i = 1; i <= n; i++) {
      assert.ok(genSet.has(i), `Generation ${i} must exist in the set`);
    }

    const latest = await clock.getLatestToken('mission-concurrency');
    assert.equal(latest?.current_generation, n);
  });
});
