const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { TwoSeatProtocol } = require('../dist/two-seat/two-seat');

describe('Two-Seat Command Studio Protocol', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-twoseat-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('initializes mission with distinct owner and controller', async () => {
    const proto = new TwoSeatProtocol(tmpDir);

    const mission = await proto.initMission({
      mission_id: 'mission-001',
      mission_owner_seat_id: 'codex-sol',
      studio_controller_seat_id: 'claude-opus',
      initial_checkpoint: 'Bootstrap project architecture',
    });

    assert.equal(mission.mission_id, 'mission-001');
    assert.equal(mission.mission_owner_seat_id, 'codex-sol');
    assert.equal(mission.studio_controller_seat_id, 'claude-opus');
    assert.equal(mission.state, 'ACTIVE');
    assert.equal(mission.current_generation, 1);
    assert.equal(mission.fencing_token.generation, 1);
  });

  test('validates action: owner allowed writes, controller prohibited from mutating owner scope', async () => {
    const proto = new TwoSeatProtocol(tmpDir);

    const mission = await proto.initMission({
      mission_id: 'mission-002',
      mission_owner_seat_id: 'codex-sol',
      studio_controller_seat_id: 'claude-opus',
    });

    // Owner should be allowed
    const ownerCheck = await proto.validateAction('mission-002', 'codex-sol', 'src/backend', mission.fencing_token);
    assert.equal(ownerCheck.allowed, true);
    assert.equal(ownerCheck.role, 'mission_owner');

    // Controller should be allowed for read-only observation
    const controllerReadCheck = await proto.validateAction('mission-002', 'claude-opus');
    assert.equal(controllerReadCheck.allowed, true);
    assert.equal(controllerReadCheck.role, 'studio_controller');

    // Controller proposing a write scope MUST be rejected (safety invariant)
    const controllerWriteCheck = await proto.validateAction('mission-002', 'claude-opus', 'src/backend');
    assert.equal(controllerWriteCheck.allowed, false);
    assert.ok(controllerWriteCheck.reason.includes('Invariant violation: studio_controller'));
  });

  test('executes planned handover and increments fencing generation', async () => {
    const proto = new TwoSeatProtocol(tmpDir);

    const initial = await proto.initMission({
      mission_id: 'mission-003',
      mission_owner_seat_id: 'codex-sol',
      studio_controller_seat_id: 'claude-opus',
    });

    const oldToken = initial.fencing_token;

    // Planned handover to claude-opus
    const handover = await proto.requestHandover('mission-003', {
      from_agent: 'codex-sol',
      to_agent: 'claude-opus',
      checkpoint: 'Backend API completed with tests',
      open_claims: [],
      child_tasks: [],
      validation_state: { tests_passed: 12 },
      next_move: 'Build React UI components',
      reason: 'Transitioning to frontend phase',
    });

    assert.equal(handover.success, true);
    assert.equal(handover.new_owner, 'claude-opus');
    assert.equal(handover.fencing_token.generation, 2);

    const mission = await proto.getMission('mission-003');
    assert.equal(mission?.mission_owner_seat_id, 'claude-opus');
    assert.equal(mission?.studio_controller_seat_id, 'codex-sol');
    assert.equal(mission?.current_generation, 2);

    // Prior owner with oldToken (gen 1) is now fenced out
    const staleCheck = await proto.validateAction('mission-003', 'codex-sol', 'src/backend', oldToken);
    assert.equal(staleCheck.allowed, false);
    assert.ok(staleCheck.reason.includes('Stale fencing generation'));
  });

  test('executes unplanned recovery by controller when owner fails', async () => {
    const proto = new TwoSeatProtocol(tmpDir);

    await proto.initMission({
      mission_id: 'mission-004',
      mission_owner_seat_id: 'codex-sol',
      studio_controller_seat_id: 'claude-opus',
    });

    // Controller detects heartbeat loss and executes recovery
    const recovery = await proto.executeUnplannedRecovery(
      'mission-004',
      'claude-opus',
      'Owner heartbeat expired after 60s silence'
    );

    assert.equal(recovery.success, true);
    assert.equal(recovery.new_owner, 'claude-opus');
    assert.equal(recovery.fencing_token.generation, 2);

    const mission = await proto.getMission('mission-004');
    assert.equal(mission?.mission_owner_seat_id, 'claude-opus');
    assert.equal(mission?.health_state, 'RECONCILED');
  });

  test('closes mission cleanly', async () => {
    const proto = new TwoSeatProtocol(tmpDir);

    await proto.initMission({
      mission_id: 'mission-005',
      mission_owner_seat_id: 'codex-sol',
      studio_controller_seat_id: 'claude-opus',
    });

    const closed = await proto.closeMission('mission-005', 'codex-sol', {
      status: 'success',
      deliverables: ['dist/bundle.js'],
    });

    assert.equal(closed.state, 'TERMINATED');
    assert.ok(closed.closed_at);
  });
});
