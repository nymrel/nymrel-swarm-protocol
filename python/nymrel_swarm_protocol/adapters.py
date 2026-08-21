"""
nymrel_swarm_protocol - Autonomous Agent Adapters
Copyright (c) 2026 Nymrel / JalenBuilds LLC. Licensed under the MIT License.
"""

import threading
import time
from typing import Optional, Dict, Any, List, Set, Union
from .bus import FileMailboxManager, EnvelopeEngine, EnvelopeV2
from .claims import ClaimManager, ClaimRecord, ClaimMode
from .fencing import FencingClock, FencingToken


class BaseAgentAdapter:
    def __init__(
        self,
        agent_id: str,
        agent_name: str,
        platform: str,
        swarm_root: str,
        auto_heartbeat: bool = False,
        heartbeat_interval_sec: float = 10.0,
    ):
        self.agent_id = agent_id
        self.agent_name = agent_name
        self.platform = platform
        self.swarm_root = swarm_root
        self.mailbox = FileMailboxManager(swarm_root)
        self.claims = ClaimManager(swarm_root)
        self.fencing = FencingClock(swarm_root)
        self._active_claim_ids: Set[str] = set()
        self._stop_heartbeat = threading.Event()
        self._heartbeat_thread: Optional[threading.Thread] = None

        self.mailbox.register_agent(agent_id)

        if auto_heartbeat:
            self._start_heartbeat(heartbeat_interval_sec)

    def send(
        self,
        recipient: str,
        topic: str,
        payload: Any,
        fencing: Optional[Union[FencingToken, Dict[str, Any]]] = None,
        correlation_id: Optional[str] = None,
    ) -> str:
        envelope = EnvelopeEngine.create(
            sender=self.agent_id,
            recipient=recipient,
            topic=topic,
            payload=payload,
            fencing=fencing,
            correlation_id=correlation_id,
        )
        return self.mailbox.send_message(envelope)

    def broadcast(
        self,
        topic: str,
        payload: Any,
        fencing: Optional[Union[FencingToken, Dict[str, Any]]] = None,
    ) -> EnvelopeV2:
        return self.mailbox.broadcast(self.agent_id, topic, payload, fencing)

    def receive(
        self,
        limit: Optional[int] = None,
        auto_acknowledge: bool = False,
    ) -> List[EnvelopeV2]:
        return self.mailbox.receive_messages(self.agent_id, limit=limit, auto_acknowledge=auto_acknowledge)

    def claim(
        self,
        resource_path: str,
        mode: ClaimMode = "exclusive",
        lease_duration_ms: Optional[int] = None,
        metadata: Optional[Dict[str, Any]] = None,
    ) -> ClaimRecord:
        meta = {
            **(metadata or {}),
            "platform": self.platform,
            "agent_name": self.agent_name,
        }
        record = self.claims.acquire_claim(
            resource_path=resource_path,
            owner_agent=self.agent_id,
            mode=mode,
            lease_duration_ms=lease_duration_ms,
            metadata=meta,
        )
        self._active_claim_ids.add(record.claim_id)
        return record

    def release(self, claim_id: str) -> bool:
        ok = self.claims.release_claim(claim_id, self.agent_id)
        if ok and claim_id in self._active_claim_ids:
            self._active_claim_ids.remove(claim_id)
        return ok

    def release_all(self) -> None:
        for cid in list(self._active_claim_ids):
            self.release(cid)

    def _start_heartbeat(self, interval_sec: float) -> None:
        def _loop():
            while not self._stop_heartbeat.is_set():
                for cid in list(self._active_claim_ids):
                    try:
                        self.claims.heartbeat(cid, self.agent_id)
                    except Exception:
                        self._active_claim_ids.discard(cid)
                self._stop_heartbeat.wait(interval_sec)

        self._heartbeat_thread = threading.Thread(target=_loop, daemon=True)
        self._heartbeat_thread.start()

    def destroy(self) -> None:
        self._stop_heartbeat.set()


class ClaudeCodeAdapter(BaseAgentAdapter):
    def __init__(self, swarm_root: str, agent_id: str = "claude-code", agent_name: str = "Claude Code"):
        super().__init__(
            agent_id=agent_id,
            agent_name=agent_name,
            platform="claude-code",
            swarm_root=swarm_root,
            auto_heartbeat=True,
        )


class CodexCliAdapter(BaseAgentAdapter):
    def __init__(self, swarm_root: str, agent_id: str = "codex-cli", agent_name: str = "Codex CLI"):
        super().__init__(
            agent_id=agent_id,
            agent_name=agent_name,
            platform="codex-cli",
            swarm_root=swarm_root,
            auto_heartbeat=True,
        )


class GeminiCliAdapter(BaseAgentAdapter):
    def __init__(self, swarm_root: str, agent_id: str = "gemini-cli", agent_name: str = "Gemini CLI"):
        super().__init__(
            agent_id=agent_id,
            agent_name=agent_name,
            platform="gemini-cli",
            swarm_root=swarm_root,
            auto_heartbeat=True,
        )


class CursorComposerAdapter(BaseAgentAdapter):
    def __init__(self, swarm_root: str, agent_id: str = "cursor-composer", agent_name: str = "Cursor Composer"):
        super().__init__(
            agent_id=agent_id,
            agent_name=agent_name,
            platform="cursor-composer",
            swarm_root=swarm_root,
            auto_heartbeat=True,
        )


class OllamaAdapter(BaseAgentAdapter):
    def __init__(self, swarm_root: str, agent_id: str = "ollama-local", agent_name: str = "Ollama Local LLM"):
        super().__init__(
            agent_id=agent_id,
            agent_name=agent_name,
            platform="ollama-local",
            swarm_root=swarm_root,
            auto_heartbeat=True,
        )


def create_adapter(platform: str, swarm_root: str, agent_id: Optional[str] = None, agent_name: Optional[str] = None) -> BaseAgentAdapter:
    if platform == "claude-code":
        return ClaudeCodeAdapter(swarm_root, agent_id or "claude-code", agent_name or "Claude Code")
    elif platform == "codex-cli":
        return CodexCliAdapter(swarm_root, agent_id or "codex-cli", agent_name or "Codex CLI")
    elif platform == "gemini-cli":
        return GeminiCliAdapter(swarm_root, agent_id or "gemini-cli", agent_name or "Gemini CLI")
    elif platform == "cursor-composer":
        return CursorComposerAdapter(swarm_root, agent_id or "cursor-composer", agent_name or "Cursor Composer")
    elif platform == "ollama-local":
        return OllamaAdapter(swarm_root, agent_id or "ollama-local", agent_name or "Ollama Local LLM")
    else:
        return BaseAgentAdapter(
            agent_id=agent_id or f"agent_{platform}",
            agent_name=agent_name or f"Agent {platform}",
            platform=platform,
            swarm_root=swarm_root,
            auto_heartbeat=True,
        )
