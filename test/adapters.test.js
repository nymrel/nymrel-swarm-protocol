const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const {
  ClaudeCodeAdapter,
  CodexCliAdapter,
  GeminiCliAdapter,
  CursorComposerAdapter,
  OllamaAdapter,
} = require('../dist/adapters/adapters');

describe('Autonomous Agent Adapters', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'swarm-adapters-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('Claude and Codex adapters communicate and exchange claims', async () => {
    const claude = new ClaudeCodeAdapter(tmpDir);
    const codex = new CodexCliAdapter(tmpDir);

    // Codex claims backend
    const claim = await codex.claim('src/api', 'exclusive', 10000);
    assert.equal(claim.owner_agent, 'codex-cli');

    // Codex sends message to Claude
    await codex.send('claude-code', 'api.spec.ready', { version: '2.0', port: 8080 });

    // Claude receives message
    const msgs = await claude.receive({ autoAcknowledge: true });
    assert.equal(msgs.length, 1);
    assert.equal(msgs[0].header.sender, 'codex-cli');
    assert.deepEqual(msgs[0].payload, { version: '2.0', port: 8080 });

    // Release and destroy
    await codex.releaseAll();
    claude.destroy();
    codex.destroy();
  });

  test('Gemini, Cursor, and Ollama adapters initialize correctly', async () => {
    const gemini = new GeminiCliAdapter(tmpDir);
    const cursor = new CursorComposerAdapter(tmpDir);
    const ollama = new OllamaAdapter(tmpDir);

    assert.equal(gemini.platform, 'gemini-cli');
    assert.equal(cursor.platform, 'cursor-composer');
    assert.equal(ollama.platform, 'ollama-local');

    // Broadcast from cursor
    await cursor.broadcast('scan.summary', { findings: 0 });

    const geminiMsgs = await gemini.receive();
    const ollamaMsgs = await ollama.receive();

    assert.equal(geminiMsgs.length, 1);
    assert.equal(ollamaMsgs.length, 1);

    gemini.destroy();
    cursor.destroy();
    ollama.destroy();
  });
});
