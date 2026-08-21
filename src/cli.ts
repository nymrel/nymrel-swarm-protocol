/**
 * @nymrel/swarm-protocol - Command Line Interface
 * Copyright (c) 2026 Nymrel / JalenBuilds LLC. Licensed under the MIT License.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { EnvelopeEngine } from './bus/envelope';
import { FileMailboxManager } from './bus/mailbox';
import { ClaimManager } from './claims/claims';
import { FencingClock } from './fencing/fencing';
import { TwoSeatProtocol } from './two-seat/two-seat';
import { ClaimMode } from './types';

function getSwarmRoot(argRoot?: string): string {
  if (argRoot) {
    return path.resolve(argRoot);
  }
  if (process.env.SWARM_ROOT) {
    return path.resolve(process.env.SWARM_ROOT);
  }
  return path.resolve(process.cwd(), '.swarm');
}

function parseArgs(args: string[]): { command: string; subcommand?: string; flags: Record<string, string>; positional: string[] } {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  let command = '';
  let subcommand: string | undefined;

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i += 2;
      } else {
        flags[key] = 'true';
        i++;
      }
    } else if (arg.startsWith('-')) {
      const key = arg.slice(1);
      const next = args[i + 1];
      if (next && !next.startsWith('-')) {
        flags[key] = next;
        i += 2;
      } else {
        flags[key] = 'true';
        i++;
      }
    } else {
      if (!command) {
        command = arg;
      } else if (!subcommand && (command === 'two-seat' || command === 'claims' || command === 'bus')) {
        subcommand = arg;
      } else {
        positional.push(arg);
      }
      i++;
    }
  }

  return { command, subcommand, flags, positional };
}

export async function runCli(argv = process.argv.slice(2)): Promise<void> {
  const { command, subcommand, flags, positional } = parseArgs(argv);
  const swarmRoot = getSwarmRoot(flags.root);

  const mailbox = new FileMailboxManager(swarmRoot);
  const claims = new ClaimManager(swarmRoot);
  const fencing = new FencingClock(swarmRoot);
  const twoSeat = new TwoSeatProtocol(swarmRoot);

  switch (command) {
    case 'init': {
      fs.mkdirSync(path.join(swarmRoot, 'mailboxes'), { recursive: true });
      fs.mkdirSync(path.join(swarmRoot, 'broadcasts'), { recursive: true });
      fs.mkdirSync(path.join(swarmRoot, 'claims'), { recursive: true });
      fs.mkdirSync(path.join(swarmRoot, 'fencing'), { recursive: true });
      fs.mkdirSync(path.join(swarmRoot, 'locks'), { recursive: true });
      fs.mkdirSync(path.join(swarmRoot, 'two-seat'), { recursive: true });
      console.log(`[OK] Swarm Protocol bus initialized at: ${swarmRoot}`);
      break;
    }

    case 'claim': {
      const resource = positional[0] || flags.resource;
      const agent = flags.agent || flags.from;
      const mode = (flags.mode as ClaimMode) || 'exclusive';
      const duration = flags.duration ? parseInt(flags.duration, 10) : undefined;
      const metadata = flags.meta ? JSON.parse(flags.meta) : undefined;

      if (!resource || !agent) {
        console.error('Error: "claim" requires <resource> and --agent <agent>');
        process.exit(1);
      }

      try {
        const claim = await claims.acquireClaim({
          resource_path: resource,
          owner_agent: agent,
          mode,
          lease_duration_ms: duration,
          metadata,
        });
        console.log(JSON.stringify(claim, null, 2));
      } catch (err: unknown) {
        console.error(`[CLAIM REJECTED] ${(err as Error).message}`);
        process.exit(1);
      }
      break;
    }

    case 'release': {
      const claimId = positional[0] || flags.claim_id || flags.id;
      const agent = flags.agent || flags.from;

      if (!claimId || !agent) {
        console.error('Error: "release" requires <claim_id> and --agent <agent>');
        process.exit(1);
      }

      try {
        const ok = await claims.releaseClaim(claimId, agent);
        if (ok) {
          console.log(`[OK] Claim "${claimId}" successfully released by "${agent}".`);
        } else {
          console.log(`[WARN] Claim "${claimId}" not found or already released.`);
        }
      } catch (err: unknown) {
        console.error(`[RELEASE FAILED] ${(err as Error).message}`);
        process.exit(1);
      }
      break;
    }

    case 'heartbeat': {
      const claimId = positional[0] || flags.claim_id || flags.id;
      const agent = flags.agent || flags.from;

      if (!claimId || !agent) {
        console.error('Error: "heartbeat" requires <claim_id> and --agent <agent>');
        process.exit(1);
      }

      try {
        const refreshed = await claims.heartbeat(claimId, agent);
        console.log(`[OK] Claim "${claimId}" refreshed. New expires_at: ${refreshed.expires_at}`);
      } catch (err: unknown) {
        console.error(`[HEARTBEAT FAILED] ${(err as Error).message}`);
        process.exit(1);
      }
      break;
    }

    case 'status': {
      const activeClaims = await claims.listClaims({ status: 'active' });
      const mailboxes = mailbox.listMailboxes();
      const events = await mailbox.readEventStream(5);

      console.log('====================================================');
      console.log('       NYMREL SWARM PROTOCOL BUS STATUS             ');
      console.log('====================================================');
      console.log(`Swarm Root:   ${swarmRoot}`);
      console.log(`Mailboxes (${mailboxes.length}): ${mailboxes.join(', ') || 'none'}`);
      console.log(`Active Claims (${activeClaims.length}):`);
      for (const c of activeClaims) {
        console.log(`  - [${c.mode.toUpperCase()}] ${c.resource_path} -> ${c.owner_agent} (gen: ${c.fencing_generation}, expires: ${c.expires_at})`);
      }
      console.log(`\nRecent Events (${events.length}):`);
      for (const e of events) {
        console.log(`  - [${e.timestamp}] ${e.event_type} by ${e.actor}`);
      }
      console.log('====================================================');
      break;
    }

    case 'send': {
      const from = flags.from;
      const to = flags.to;
      const topic = flags.topic;
      const payloadRaw = flags.payload || '{}';

      if (!from || !to || !topic) {
        console.error('Error: "send" requires --from, --to, --topic, [--payload]');
        process.exit(1);
      }

      const payload = JSON.parse(payloadRaw);
      const envelope = EnvelopeEngine.create({
        sender: from,
        recipient: to,
        topic,
        payload,
      });

      const msgId = await mailbox.sendMessage(envelope);
      console.log(`[OK] Message sent. ID: ${msgId}, Checksum: ${envelope.checksum.substring(0, 12)}...`);
      break;
    }

    case 'broadcast': {
      const from = flags.from;
      const topic = flags.topic;
      const payloadRaw = flags.payload || '{}';

      if (!from || !topic) {
        console.error('Error: "broadcast" requires --from, --topic, [--payload]');
        process.exit(1);
      }

      const payload = JSON.parse(payloadRaw);
      const envelope = await mailbox.broadcast(from, topic, payload);
      console.log(`[OK] Broadcast sent. ID: ${envelope.header.id}`);
      break;
    }

    case 'receive': {
      const agent = flags.agent || flags.to;
      const autoAck = flags.ack === 'true' || flags.ack === '1';

      if (!agent) {
        console.error('Error: "receive" requires --agent <agent>');
        process.exit(1);
      }

      const messages = await mailbox.receiveMessages(agent, { autoAcknowledge: autoAck });
      console.log(JSON.stringify(messages, null, 2));
      break;
    }

    case 'reap':
    case 'clean-expired': {
      const expired = await claims.reapExpiredLeases();
      console.log(`[OK] Reaped ${expired.length} expired claims.`);
      for (const c of expired) {
        console.log(`  - Expired: ${c.resource_path} (Owner: ${c.owner_agent})`);
      }
      break;
    }

    case 'two-seat': {
      if (subcommand === 'init') {
        const mission = flags.mission || positional[0];
        const owner = flags.owner;
        const controller = flags.controller;
        const checkpoint = flags.checkpoint;

        if (!mission || !owner || !controller) {
          console.error('Error: "two-seat init" requires --mission <id> --owner <agent> --controller <agent>');
          process.exit(1);
        }

        const res = await twoSeat.initMission({
          mission_id: mission,
          mission_owner_seat_id: owner,
          studio_controller_seat_id: controller,
          initial_checkpoint: checkpoint,
        });
        console.log(JSON.stringify(res, null, 2));
      } else if (subcommand === 'handover') {
        const mission = flags.mission || positional[0];
        const from = flags.from;
        const to = flags.to;
        const checkpoint = flags.checkpoint || 'Manual handover';
        const nextMove = flags.next || flags.next_move || 'Proceed with next planned step';
        const reason = flags.reason;

        if (!mission || !from || !to) {
          console.error('Error: "two-seat handover" requires --mission <id> --from <agent> --to <agent>');
          process.exit(1);
        }

        const res = await twoSeat.requestHandover(mission, {
          from_agent: from,
          to_agent: to,
          checkpoint,
          open_claims: [],
          child_tasks: [],
          validation_state: { mode: 'manual_cli' },
          next_move: nextMove,
          reason,
        });
        console.log(JSON.stringify(res, null, 2));
      } else if (subcommand === 'recover') {
        const mission = flags.mission || positional[0];
        const controller = flags.controller || flags.from;
        const reason = flags.reason || 'Controller initiated unplanned recovery';

        if (!mission || !controller) {
          console.error('Error: "two-seat recover" requires --mission <id> --controller <agent> --reason <text>');
          process.exit(1);
        }

        const res = await twoSeat.executeUnplannedRecovery(mission, controller, reason);
        console.log(JSON.stringify(res, null, 2));
      } else if (subcommand === 'status') {
        const missionId = flags.mission || positional[0];
        if (!missionId) {
          console.error('Error: "two-seat status" requires --mission <id>');
          process.exit(1);
        }
        const record = await twoSeat.getMission(missionId);
        if (!record) {
          console.error(`Mission "${missionId}" not found`);
          process.exit(1);
        }
        console.log(JSON.stringify(record, null, 2));
      } else {
        console.log('Available two-seat subcommands: init, handover, recover, status');
      }
      break;
    }

    default: {
      console.log(`
Nymrel Swarm Protocol CLI (@nymrel/swarm-protocol)
Usage:
  swarm-protocol init [--root <dir>]
  swarm-protocol claim <resource> --agent <agent> [--mode exclusive|shared] [--duration <ms>]
  swarm-protocol release <claim_id> --agent <agent>
  swarm-protocol heartbeat <claim_id> --agent <agent>
  swarm-protocol status [--root <dir>]
  swarm-protocol send --from <agent> --to <agent> --topic <topic> --payload <json>
  swarm-protocol broadcast --from <agent> --topic <topic> --payload <json>
  swarm-protocol receive --agent <agent> [--ack]
  swarm-protocol reap [--root <dir>]
  swarm-protocol two-seat init --mission <id> --owner <agent> --controller <agent>
  swarm-protocol two-seat handover --mission <id> --from <agent> --to <agent>
  swarm-protocol two-seat recover --mission <id> --controller <agent> --reason <text>
  swarm-protocol two-seat status --mission <id>
`);
      break;
    }
  }
}
