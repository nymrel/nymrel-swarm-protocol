"""
nymrel_swarm_protocol - Atomic Cross-Process File Lock & Fencing Generation Clock
Copyright (c) 2026 Nymrel / JalenBuilds LLC. Licensed under the MIT License.
"""

import os
import sys
import time
import json
import uuid
import hashlib
import random
import threading
from datetime import datetime, timezone
from typing import Optional, Dict, Any
from dataclasses import dataclass, asdict


def iso_now(offset_ms: int = 0) -> str:
    now_ts = time.time() + (offset_ms / 1000.0)
    dt = datetime.fromtimestamp(now_ts, tz=timezone.utc)
    return dt.strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


@dataclass
class FencingToken:
    resource_id: str
    generation: int
    token: str
    issued_at: str
    claimant: str

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


@dataclass
class FencingState:
    resource_id: str
    current_generation: int
    current_token: str
    holder: str
    updated_at: str

    def to_dict(self) -> Dict[str, Any]:
        return asdict(self)


class AtomicLockManager:
    """
    Cross-process atomic lock using directory creation atomicity,
    in-process thread synchronization, PID tracking, and automatic stale-lock eviction.
    """
    _process_locks: Dict[str, threading.Lock] = {}
    _meta_lock = threading.Lock()

    def __init__(self, swarm_root: str):
        self.base_dir = os.path.join(swarm_root, "locks")
        os.makedirs(self.base_dir, exist_ok=True)

    def _get_thread_lock(self, lock_name: str) -> threading.Lock:
        with self._meta_lock:
            if lock_name not in self._process_locks:
                self._process_locks[lock_name] = threading.Lock()
            return self._process_locks[lock_name]

    def _get_lock_dir(self, lock_name: str) -> str:
        sanitized = "".join(c if c.isalnum() or c in "._-" else "_" for c in lock_name)
        return os.path.join(self.base_dir, f"{sanitized}.lock")

    def _get_meta_path(self, lock_dir: str) -> str:
        return os.path.join(lock_dir, "lock.json")

    def acquire_lock(
        self,
        lock_name: str,
        timeout_ms: int = 5000,
        retry_interval_ms: int = 5,
        stale_threshold_ms: int = 10000,
    ) -> Dict[str, Any]:
        t_lock = self._get_thread_lock(lock_name)
        # Acquire in-process thread lock first
        acquired_thread = t_lock.acquire(timeout=timeout_ms / 1000.0)
        if not acquired_thread:
            raise TimeoutError(f'Failed to acquire thread lock for "{lock_name}" within timeout of {timeout_ms}ms')

        lock_dir = self._get_lock_dir(lock_name)
        meta_path = self._get_meta_path(lock_dir)
        start_time = time.time() * 1000
        pid = os.getpid()

        while True:
            try:
                os.mkdir(lock_dir)
                meta = {
                    "lock_name": lock_name,
                    "pid": pid,
                    "acquired_at": int(time.time() * 1000),
                }
                with open(meta_path, "w", encoding="utf-8") as f:
                    json.dump(meta, f, indent=2)

                return {
                    "lock_name": lock_name,
                    "lock_path": lock_dir,
                    "acquired_at": meta["acquired_at"],
                    "pid": pid,
                    "_thread_lock": t_lock,
                }
            except FileExistsError:
                # Lock exists, check stale threshold
                try:
                    if os.path.exists(meta_path):
                        with open(meta_path, "r", encoding="utf-8") as f:
                            meta = json.load(f)
                        age = (time.time() * 1000) - meta.get("acquired_at", 0)
                        if age > stale_threshold_ms:
                            self._force_remove(lock_dir)
                    else:
                        mtime = os.path.getmtime(lock_dir) * 1000
                        age = (time.time() * 1000) - mtime
                        if age > stale_threshold_ms:
                            self._force_remove(lock_dir)
                except Exception:
                    pass

                if (time.time() * 1000) - start_time >= timeout_ms:
                    t_lock.release()
                    raise TimeoutError(f'Failed to acquire lock "{lock_name}" within timeout of {timeout_ms}ms')

                jitter = random.randint(1, 10) / 1000.0
                time.sleep((retry_interval_ms / 1000.0) + jitter)
            except Exception:
                t_lock.release()
                raise

    def release_lock(self, handle: Dict[str, Any]) -> None:
        try:
            lock_path = handle.get("lock_path")
            if lock_path:
                self._force_remove(lock_path)
        finally:
            t_lock = handle.get("_thread_lock")
            if t_lock and t_lock.locked():
                try:
                    t_lock.release()
                except RuntimeError:
                    pass

    def _force_remove(self, lock_dir: str) -> None:
        try:
            if os.path.exists(lock_dir):
                for root, dirs, files in os.walk(lock_dir, topdown=False):
                    for name in files:
                        try:
                            os.remove(os.path.join(root, name))
                        except Exception:
                            pass
                    for name in dirs:
                        try:
                            os.rmdir(os.path.join(root, name))
                        except Exception:
                            pass
                os.rmdir(lock_dir)
        except Exception:
            pass

    def with_lock(self, lock_name: str, fn, *args, **kwargs):
        handle = self.acquire_lock(lock_name)
        try:
            return fn(*args, **kwargs)
        finally:
            self.release_lock(handle)


class FencingClock:
    """
    Monotonic generation clock for cross-agent fencing.
    """

    def __init__(self, swarm_root: str):
        self.base_dir = os.path.join(swarm_root, "fencing")
        self.lock_manager = AtomicLockManager(swarm_root)
        os.makedirs(self.base_dir, exist_ok=True)

    def _get_fencing_path(self, resource_id: str) -> str:
        sanitized = "".join(c if c.isalnum() or c in "._-" else "_" for c in resource_id)
        return os.path.join(self.base_dir, f"{sanitized}.json")

    def _generate_token_string(self, resource_id: str, generation: int, claimant: str, timestamp: str) -> str:
        raw = f"{resource_id}:{generation}:{claimant}:{timestamp}".encode("utf-8")
        h = hashlib.sha256(raw).hexdigest()[:16]
        return f"fenc_gen{generation}_{h}"

    def increment_generation(self, resource_id: str, claimant: str) -> FencingToken:
        def _op():
            file_path = self._get_fencing_path(resource_id)
            current_gen = 0

            if os.path.exists(file_path):
                try:
                    with open(file_path, "r", encoding="utf-8") as f:
                        data = json.load(f)
                        current_gen = data.get("current_generation", 0)
                except Exception:
                    current_gen = 0

            next_gen = current_gen + 1
            now = iso_now()
            token_str = self._generate_token_string(resource_id, next_gen, claimant, now)

            token = FencingToken(
                resource_id=resource_id,
                generation=next_gen,
                token=token_str,
                issued_at=now,
                claimant=claimant,
            )

            state = FencingState(
                resource_id=resource_id,
                current_generation=next_gen,
                current_token=token_str,
                holder=claimant,
                updated_at=now,
            )

            with open(file_path, "w", encoding="utf-8") as f:
                json.dump(state.to_dict(), f, indent=2)

            return token

        return self.lock_manager.with_lock(f"fencing_{resource_id}", _op)

    def get_latest_token(self, resource_id: str) -> Optional[FencingState]:
        file_path = self._get_fencing_path(resource_id)
        if not os.path.exists(file_path):
            return None
        try:
            with open(file_path, "r", encoding="utf-8") as f:
                data = json.load(f)
            return FencingState(**data)
        except Exception:
            return None

    def validate_generation(self, resource_id: str, presented_token: Any) -> bool:
        state = self.get_latest_token(resource_id)
        if not state:
            return False

        if isinstance(presented_token, str):
            return state.current_token == presented_token

        if isinstance(presented_token, dict):
            return (
                presented_token.get("resource_id") == resource_id
                and presented_token.get("generation") == state.current_generation
                and presented_token.get("token") == state.current_token
            )

        if isinstance(presented_token, FencingToken):
            return (
                presented_token.resource_id == resource_id
                and presented_token.generation == state.current_generation
                and presented_token.token == state.current_token
            )

        return False
