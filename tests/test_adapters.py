"""
Unit tests for Autonomous Agent Adapters (Python)
"""

import os
import shutil
import tempfile
import unittest
from nymrel_swarm_protocol.adapters import (
    ClaudeCodeAdapter,
    CodexCliAdapter,
    GeminiCliAdapter,
    CursorComposerAdapter,
    OllamaAdapter,
)


class TestAdapters(unittest.TestCase):
    def setUp(self):
        self.tmp_dir = tempfile.mkdtemp(prefix="swarm-adapters-py-")

    def tearDown(self):
        shutil.rmtree(self.tmp_dir, ignore_errors=True)

    def test_claude_and_codex_communication(self):
        claude = ClaudeCodeAdapter(self.tmp_dir)
        codex = CodexCliAdapter(self.tmp_dir)

        # Codex claims backend
        claim = codex.claim("src/api", mode="exclusive", lease_duration_ms=10000)
        self.assertEqual(claim.owner_agent, "codex-cli")

        # Codex sends to Claude
        codex.send("claude-code", "api.spec.ready", {"version": "2.0", "port": 8080})

        # Claude receives
        msgs = claude.receive(auto_acknowledge=True)
        self.assertEqual(len(msgs), 1)
        self.assertEqual(msgs[0].header.sender, "codex-cli")
        self.assertEqual(msgs[0].payload, {"version": "2.0", "port": 8080})

        codex.release_all()
        claude.destroy()
        codex.destroy()

    def test_gemini_cursor_ollama_broadcast(self):
        gemini = GeminiCliAdapter(self.tmp_dir)
        cursor = CursorComposerAdapter(self.tmp_dir)
        ollama = OllamaAdapter(self.tmp_dir)

        self.assertEqual(gemini.platform, "gemini-cli")
        self.assertEqual(cursor.platform, "cursor-composer")
        self.assertEqual(ollama.platform, "ollama-local")

        cursor.broadcast("scan.summary", {"findings": 0})

        g_msgs = gemini.receive()
        o_msgs = ollama.receive()

        self.assertEqual(len(g_msgs), 1)
        self.assertEqual(len(o_msgs), 1)

        gemini.destroy()
        cursor.destroy()
        ollama.destroy()


if __name__ == "__main__":
    unittest.main()
