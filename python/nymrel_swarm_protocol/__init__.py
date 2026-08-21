"""
nymrel_swarm_protocol
Zero-dependency Multi-Agent Swarm Protocol, Two-Seat Command Studio Contract,
and File-Based Bus Engine.

Copyright (c) 2026 Nymrel / JalenBuilds LLC. Licensed under the MIT License.
"""

from .fencing import (
    AtomicLockManager,
    FencingClock,
    FencingToken,
    FencingState,
)
from .bus import (
    EnvelopeHeader,
    EnvelopeV2,
    EnvelopeEngine,
    FileMailboxManager,
    BusEvent,
)
from .claims import (
    ClaimManager,
    ClaimRecord,
    ClaimMode,
    ClaimStatus,
)
from .two_seat import (
    TwoSeatProtocol,
    MissionRecord,
    HandoverPacket,
    HandoverResult,
    ActionValidationResult,
    TwoSeatRole,
    MissionState,
    HealthState,
)
from .adapters import (
    BaseAgentAdapter,
    ClaudeCodeAdapter,
    CodexCliAdapter,
    GeminiCliAdapter,
    CursorComposerAdapter,
    OllamaAdapter,
    create_adapter,
)

__version__ = "1.0.0"
__author__ = "Nymrel / JalenBuilds LLC <contact@nymrel.com>"

__all__ = [
    "AtomicLockManager",
    "FencingClock",
    "FencingToken",
    "FencingState",
    "EnvelopeHeader",
    "EnvelopeV2",
    "EnvelopeEngine",
    "FileMailboxManager",
    "BusEvent",
    "ClaimManager",
    "ClaimRecord",
    "ClaimMode",
    "ClaimStatus",
    "TwoSeatProtocol",
    "MissionRecord",
    "HandoverPacket",
    "HandoverResult",
    "ActionValidationResult",
    "TwoSeatRole",
    "MissionState",
    "HealthState",
    "BaseAgentAdapter",
    "ClaudeCodeAdapter",
    "CodexCliAdapter",
    "GeminiCliAdapter",
    "CursorComposerAdapter",
    "OllamaAdapter",
    "create_adapter",
]
