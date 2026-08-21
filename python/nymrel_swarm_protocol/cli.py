"""
nymrel_swarm_protocol - Command Line Interface
Copyright (c) 2026 Nymrel / JalenBuilds LLC. Licensed under the MIT License.
"""

import os
import sys
import json
import argparse
from .bus import FileMailboxManager, EnvelopeEngine
from .claims import ClaimManager
from .fencing import FencingClock
from .two_seat import TwoSeatProtocol, HandoverPacket


def get_swarm_root(arg_root: str = None) -> str:
    if arg_root:
        return os.path.abspath(arg_root)
    if os.environ.get("SWARM_ROOT"):
        return os.path.abspath(os.environ["SWARM_ROOT"])
    return os.path.abspath(os.path.join(os.getcwd(), ".swarm"))


def main(argv=None):
    if argv is None:
        argv = sys.argv[1:]

    parser = argparse.ArgumentParser(
        prog="swarm-protocol-py",
        description="Nymrel Swarm Protocol CLI (Python Engine)",
    )
    parser.add_argument("--root", help="Path to .swarm root directory")

    subparsers = parser.add_subparsers(dest="command", help="Command to run")

    # init
    init_p = subparsers.add_parser("init", help="Initialize swarm protocol bus directory")

    # claim
    claim_p = subparsers.add_parser("claim", help="Acquire a resource claim")
    claim_p.add_argument("resource", nargs="?", help="Resource path to claim")
    claim_p.add_argument("--resource", dest="resource_flag", help="Resource path to claim")
    claim_p.add_argument("--agent", required=True, help="Claimant agent ID")
    claim_p.add_argument("--mode", choices=["exclusive", "shared"], default="exclusive")
    claim_p.add_argument("--duration", type=int, help="Lease duration in milliseconds")
    claim_p.add_argument("--meta", help="JSON metadata string")

    # release
    release_p = subparsers.add_parser("release", help="Release an active claim")
    release_p.add_argument("claim_id", nargs="?", help="Claim ID to release")
    release_p.add_argument("--id", dest="claim_id_flag", help="Claim ID to release")
    release_p.add_argument("--agent", required=True, help="Agent ID holding claim")

    # heartbeat
    hb_p = subparsers.add_parser("heartbeat", help="Send heartbeat to refresh lease")
    hb_p.add_argument("claim_id", nargs="?", help="Claim ID")
    hb_p.add_argument("--id", dest="claim_id_flag", help="Claim ID")
    hb_p.add_argument("--agent", required=True, help="Agent ID")

    # status
    status_p = subparsers.add_parser("status", help="Display swarm status and active claims")

    # send
    send_p = subparsers.add_parser("send", help="Send message envelope to another agent")
    send_p.add_argument("--from", dest="from_agent", required=True, help="Sender agent ID")
    send_p.add_argument("--to", dest="to_agent", required=True, help="Recipient agent ID")
    send_p.add_argument("--topic", required=True, help="Message topic")
    send_p.add_argument("--payload", default="{}", help="JSON payload string")

    # broadcast
    bcast_p = subparsers.add_parser("broadcast", help="Broadcast message to all swarm agents")
    bcast_p.add_argument("--from", dest="from_agent", required=True, help="Sender agent ID")
    bcast_p.add_argument("--topic", required=True, help="Message topic")
    bcast_p.add_argument("--payload", default="{}", help="JSON payload string")

    # receive
    recv_p = subparsers.add_parser("receive", help="Receive messages from agent inbox")
    recv_p.add_argument("--agent", required=True, help="Agent ID")
    recv_p.add_argument("--ack", action="store_true", help="Auto acknowledge received messages")

    # reap / clean-expired
    reap_p = subparsers.add_parser("reap", help="Reap expired leases")
    clean_p = subparsers.add_parser("clean-expired", help="Reap expired leases")

    # two-seat
    two_seat_p = subparsers.add_parser("two-seat", help="Two-Seat Command Studio commands")
    two_seat_sub = two_seat_p.add_subparsers(dest="two_seat_cmd", help="Two-seat subcommand")

    ts_init = two_seat_sub.add_parser("init", help="Initialize two-seat mission")
    ts_init.add_argument("--mission", required=True, help="Mission ID")
    ts_init.add_argument("--owner", required=True, help="Mission Owner seat ID")
    ts_init.add_argument("--controller", required=True, help="Studio Controller seat ID")
    ts_init.add_argument("--checkpoint", help="Initial checkpoint summary")

    ts_handover = two_seat_sub.add_parser("handover", help="Execute planned mission handover")
    ts_handover.add_argument("--mission", required=True, help="Mission ID")
    ts_handover.add_argument("--from", dest="from_agent", required=True, help="Current owner")
    ts_handover.add_argument("--to", dest="to_agent", required=True, help="Successor owner")
    ts_handover.add_argument("--checkpoint", default="Manual handover", help="Handover checkpoint")
    ts_handover.add_argument("--next", default="Proceed with next planned step", help="Next move")
    ts_handover.add_argument("--reason", help="Reason for handover")

    ts_recover = two_seat_sub.add_parser("recover", help="Execute unplanned recovery by controller")
    ts_recover.add_argument("--mission", required=True, help="Mission ID")
    ts_recover.add_argument("--controller", required=True, help="Studio controller ID")
    ts_recover.add_argument("--reason", default="Controller initiated unplanned recovery", help="Recovery reason")

    ts_status = two_seat_sub.add_parser("status", help="Get mission status")
    ts_status.add_argument("--mission", required=True, help="Mission ID")

    args = parser.parse_args(argv)

    if not args.command:
        parser.print_help()
        return

    swarm_root = get_swarm_root(args.root)
    mailbox = FileMailboxManager(swarm_root)
    claims = ClaimManager(swarm_root)
    fencing = FencingClock(swarm_root)
    two_seat = TwoSeatProtocol(swarm_root)

    if args.command == "init":
        os.makedirs(os.path.join(swarm_root, "mailboxes"), exist_ok=True)
        os.makedirs(os.path.join(swarm_root, "broadcasts"), exist_ok=True)
        os.makedirs(os.path.join(swarm_root, "claims"), exist_ok=True)
        os.makedirs(os.path.join(swarm_root, "fencing"), exist_ok=True)
        os.makedirs(os.path.join(swarm_root, "locks"), exist_ok=True)
        os.makedirs(os.path.join(swarm_root, "two-seat"), exist_ok=True)
        print(f"[OK] Swarm Protocol bus initialized at: {swarm_root}")

    elif args.command == "claim":
        resource = args.resource or args.resource_flag
        if not resource:
            print("Error: claim requires resource path", file=sys.stderr)
            sys.exit(1)
        meta = json.loads(args.meta) if args.meta else None
        try:
            record = claims.acquire_claim(
                resource_path=resource,
                owner_agent=args.agent,
                mode=args.mode,
                lease_duration_ms=args.duration,
                metadata=meta,
            )
            print(json.dumps(record.to_dict(), indent=2))
        except Exception as e:
            print(f"[CLAIM REJECTED] {e}", file=sys.stderr)
            sys.exit(1)

    elif args.command == "release":
        claim_id = args.claim_id or args.claim_id_flag
        if not claim_id:
            print("Error: release requires claim_id", file=sys.stderr)
            sys.exit(1)
        try:
            ok = claims.release_claim(claim_id, args.agent)
            if ok:
                print(f'[OK] Claim "{claim_id}" successfully released by "{args.agent}".')
            else:
                print(f'[WARN] Claim "{claim_id}" not found or already released.')
        except Exception as e:
            print(f"[RELEASE FAILED] {e}", file=sys.stderr)
            sys.exit(1)

    elif args.command == "heartbeat":
        claim_id = args.claim_id or args.claim_id_flag
        if not claim_id:
            print("Error: heartbeat requires claim_id", file=sys.stderr)
            sys.exit(1)
        try:
            record = claims.heartbeat(claim_id, args.agent)
            print(f'[OK] Claim "{claim_id}" refreshed. New expires_at: {record.expires_at}')
        except Exception as e:
            print(f"[HEARTBEAT FAILED] {e}", file=sys.stderr)
            sys.exit(1)

    elif args.command == "status":
        active_claims = claims.list_claims(status="active")
        mailboxes = mailbox.list_mailboxes()
        events = mailbox.read_event_stream(5)

        print("====================================================")
        print("       NYMREL SWARM PROTOCOL BUS STATUS (PYTHON)    ")
        print("====================================================")
        print(f"Swarm Root:   {swarm_root}")
        print(f"Mailboxes ({len(mailboxes)}): {', '.join(mailboxes) if mailboxes else 'none'}")
        print(f"Active Claims ({len(active_claims)}):")
        for c in active_claims:
            print(f"  - [{c.mode.upper()}] {c.resource_path} -> {c.owner_agent} (gen: {c.fencing_generation}, expires: {c.expires_at})")
        print(f"\nRecent Events ({len(events)}):")
        for e in events:
            print(f"  - [{e.get('timestamp')}] {e.get('event_type')} by {e.get('actor')}")
        print("====================================================")

    elif args.command == "send":
        payload = json.loads(args.payload)
        env = EnvelopeEngine.create(
            sender=args.from_agent,
            recipient=args.to_agent,
            topic=args.topic,
            payload=payload,
        )
        msg_id = mailbox.send_message(env)
        print(f"[OK] Message sent. ID: {msg_id}, Checksum: {env.checksum[:12]}...")

    elif args.command == "broadcast":
        payload = json.loads(args.payload)
        env = mailbox.broadcast(args.from_agent, args.topic, payload)
        print(f"[OK] Broadcast sent. ID: {env.header.id}")

    elif args.command == "receive":
        msgs = mailbox.receive_messages(args.agent, auto_acknowledge=args.ack)
        print(json.dumps([m.to_dict() for m in msgs], indent=2))

    elif args.command in ("reap", "clean-expired"):
        expired = claims.reap_expired_leases()
        print(f"[OK] Reaped {len(expired)} expired claims.")
        for c in expired:
            print(f"  - Expired: {c.resource_path} (Owner: {c.owner_agent})")

    elif args.command == "two-seat":
        if args.two_seat_cmd == "init":
            rec = two_seat.init_mission(
                mission_id=args.mission,
                mission_owner_seat_id=args.owner,
                studio_controller_seat_id=args.controller,
                initial_checkpoint=args.checkpoint,
            )
            print(json.dumps(rec.to_dict(), indent=2))
        elif args.two_seat_cmd == "handover":
            res = two_seat.request_handover(
                args.mission,
                HandoverPacket(
                    from_agent=args.from_agent,
                    to_agent=args.to_agent,
                    checkpoint=args.checkpoint,
                    open_claims=[],
                    child_tasks=[],
                    validation_state={"mode": "manual_cli"},
                    next_move=args.next,
                    reason=args.reason,
                ),
            )
            print(json.dumps(res.to_dict(), indent=2))
        elif args.two_seat_cmd == "recover":
            res = two_seat.execute_unplanned_recovery(args.mission, args.controller, args.reason)
            print(json.dumps(res.to_dict(), indent=2))
        elif args.two_seat_cmd == "status":
            rec = two_seat.get_mission(args.mission)
            if not rec:
                print(f'Mission "{args.mission}" not found', file=sys.stderr)
                sys.exit(1)
            print(json.dumps(rec.to_dict(), indent=2))
        else:
            two_seat_p.print_help()


if __name__ == "__main__":
    main()
