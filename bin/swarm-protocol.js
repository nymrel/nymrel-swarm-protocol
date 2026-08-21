#!/usr/bin/env node
/**
 * @nymrel/swarm-protocol - Executable CLI
 * Copyright (c) 2026 Nymrel / JalenBuilds LLC. Licensed under the MIT License.
 */

const path = require('node:path');
const fs = require('node:fs');

// Check if dist exists, otherwise fall back to registering TS or running dist
const distCli = path.join(__dirname, '..', 'dist', 'cli.js');

if (fs.existsSync(distCli)) {
  const { runCli } = require(distCli);
  runCli().catch((err) => {
    console.error(`[FATAL] ${err.stack || err.message}`);
    process.exit(1);
  });
} else {
  // If dist not built yet, we can build it on the fly or provide message
  try {
    const { execSync } = require('node:child_process');
    execSync('npm run build', { cwd: path.join(__dirname, '..'), stdio: 'inherit' });
    const { runCli } = require(distCli);
    runCli().catch((err) => {
      console.error(`[FATAL] ${err.stack || err.message}`);
      process.exit(1);
    });
  } catch (e) {
    console.error('Failed to auto-build @nymrel/swarm-protocol before execution:', e);
    process.exit(1);
  }
}
