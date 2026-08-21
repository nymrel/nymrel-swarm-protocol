const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { ClaimManager } = require('../dist/claims/claims');

describe('ClaimManager & Leases', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-claims-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('normalizes paths correctly across platforms', () => {
    assert.equal(ClaimManager.normalizeResourcePath('src\\backend\\api/'), 'src/backend/api');
    assert.equal(ClaimManager.normalizeResourcePath('SRC/BACKEND/API'), 'src/backend/api');
  });

  test('detects path hierarchy conflicts accurately', () => {
    // Exclusive overlaps
    assert.equal(ClaimManager.checkConflict('src', 'exclusive', 'src/bus', 'exclusive'), true);
    assert.equal(ClaimManager.checkConflict('src/bus', 'exclusive', 'src', 'exclusive'), true);
    assert.equal(ClaimManager.checkConflict('src', 'exclusive', 'src/bus', 'shared'), true);
    assert.equal(ClaimManager.checkConflict('src', 'shared', 'src/bus', 'exclusive'), true);

    // Shared on shared is permitted
    assert.equal(ClaimManager.checkConflict('src', 'shared', 'src/bus', 'shared'), false);
    assert.equal(ClaimManager.checkConflict('src', 'shared', 'src', 'shared'), false);

    // Unrelated paths
    assert.equal(ClaimManager.checkConflict('src/backend', 'exclusive', 'src/frontend', 'exclusive'), false);
  });

  test('acquires exclusive claim and blocks conflicting claim', async () => {
    const claims = new ClaimManager(tmpDir);

    const claim1 = await claims.acquireClaim({
      resource_path: 'src/core',
      owner_agent: 'codex-sol',
      mode: 'exclusive',
      lease_duration_ms: 10000,
    });

    assert.equal(claim1.owner_agent, 'codex-sol');
    assert.equal(claim1.status, 'active');
    assert.equal(claim1.fencing_generation, 1);

    // Conflicting claim by claude-opus must throw
    await assert.rejects(
      async () => {
        await claims.acquireClaim({
          resource_path: 'src/core/utils',
          owner_agent: 'claude-opus',
          mode: 'exclusive',
        });
      },
      /Claim conflict on "src\/core\/utils"/
    );
  });

  test('refreshes lease via heartbeat', async () => {
    const claims = new ClaimManager(tmpDir);

    const claim = await claims.acquireClaim({
      resource_path: 'src/api',
      owner_agent: 'codex-sol',
      lease_duration_ms: 2000,
    });

    const oldExpiresAt = claim.expires_at;
    await new Promise((r) => setTimeout(r, 100));

    const refreshed = await claims.heartbeat(claim.claim_id, 'codex-sol');
    assert.ok(new Date(refreshed.expires_at).getTime() > new Date(oldExpiresAt).getTime());
  });

  test('releases claim cleanly', async () => {
    const claims = new ClaimManager(tmpDir);

    const claim = await claims.acquireClaim({
      resource_path: 'src/db',
      owner_agent: 'codex-sol',
    });

    const released = await claims.releaseClaim(claim.claim_id, 'codex-sol');
    assert.equal(released, true);

    const updated = await claims.getClaim(claim.claim_id);
    assert.equal(updated?.status, 'released');

    // Another agent can now claim it
    const claim2 = await claims.acquireClaim({
      resource_path: 'src/db',
      owner_agent: 'claude-opus',
    });
    assert.equal(claim2.owner_agent, 'claude-opus');
  });

  test('auto-arbiter reaps expired leases', async () => {
    const claims = new ClaimManager(tmpDir);

    // Acquire claim with very short lease (10ms)
    const claim = await claims.acquireClaim({
      resource_path: 'src/temp',
      owner_agent: 'agent-fast',
      lease_duration_ms: 10,
    });

    await new Promise((r) => setTimeout(r, 50));

    const reaped = await claims.reapExpiredLeases();
    assert.equal(reaped.length, 1);
    assert.equal(reaped[0].claim_id, claim.claim_id);
    assert.equal(reaped[0].status, 'expired');
  });
});
