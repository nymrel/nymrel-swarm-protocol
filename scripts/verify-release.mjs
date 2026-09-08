#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const EXPECTED = Object.freeze({
  npmName: '@nymrel/swarm-protocol',
  pythonName: 'nymrel-swarm-protocol',
  repository: 'https://github.com/nymrel/nymrel-swarm-protocol.git',
  repositoryPage: 'https://github.com/nymrel/nymrel-swarm-protocol',
  issues: 'https://github.com/nymrel/nymrel-swarm-protocol/issues',
  packageManager: 'npm@11.19.1',
  nodeRange: '>=22.22.2 <27',
  pythonRange: '>=3.11',
  pythonBuildBackend: 'setuptools.build_meta',
  pythonBuildRequirements: ['setuptools==84.0.0'],
  typescriptFiles: 'src/**/*.ts',
  pythonFiles: 'python/nymrel_swarm_protocol/*.py',
  setupShim: 'from setuptools import setup\n\nsetup()\n',
});

function fail(message) {
  throw new Error(`release verification failed: ${message}`);
}

function option(name, fallback) {
  const index = process.argv.indexOf(name);
  if (index === -1) return fallback;
  const value = process.argv[index + 1];
  if (!value || value.startsWith('--')) fail(`${name} requires a value`);
  return value;
}

function readText(root, file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

function tomlSection(toml, name) {
  const header = `[${name}]`;
  const lines = toml.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === header);
  if (start === -1) fail(`pyproject.toml is missing ${header}`);
  const body = [];
  for (const line of lines.slice(start + 1)) {
    if (/^\s*\[[^\]]+\]\s*$/.test(line)) break;
    body.push(line);
  }
  return body.join('\n');
}

function tomlString(section, key) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = section.match(new RegExp(`^${escapedKey}\\s*=\\s*"([^"]+)"\\s*$`, 'm'));
  if (!match) fail(`pyproject.toml is missing ${key}`);
  return match[1];
}

function tomlStringArray(section, key) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = section.match(new RegExp(`^${escapedKey}\\s*=\\s*(\\[[^\\n]*\\])\\s*$`, 'm'));
  if (!match) fail(`pyproject.toml is missing ${key}`);
  try {
    const values = JSON.parse(match[1]);
    if (!Array.isArray(values) || values.some((value) => typeof value !== 'string')) throw new Error('not strings');
    return values;
  } catch {
    fail(`pyproject.toml ${key} must be a one-line string array`);
  }
}

function expectEqual(actual, expected, label) {
  if (actual !== expected) {
    fail(`${label} must be ${JSON.stringify(expected)}, found ${JSON.stringify(actual)}`);
  }
}

function expectArrayEqual(actual, expected, label) {
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    fail(`${label} must be ${JSON.stringify(expected)}, found ${JSON.stringify(actual)}`);
  }
}

function main() {
  const root = path.resolve(option('--root', process.cwd()));
  const requestedTag = option('--tag', process.env.GITHUB_REF_NAME);
  const npmPackage = JSON.parse(readText(root, 'package.json'));
  const tag = requestedTag ?? `v${npmPackage.version}`;
  if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag)) {
    fail(`tag ${JSON.stringify(tag)} is not a stable vMAJOR.MINOR.PATCH release`);
  }
  const tagVersion = tag.slice(1);
  const pyproject = readText(root, 'pyproject.toml');
  const setupShim = readText(root, 'setup.py').replace(/\r\n/g, '\n');
  const pythonBuild = tomlSection(pyproject, 'build-system');
  const pythonProject = tomlSection(pyproject, 'project');
  const pythonUrls = tomlSection(pyproject, 'project.urls');
  const pythonName = tomlString(pythonProject, 'name');
  const pythonVersion = tomlString(pythonProject, 'version');
  const pythonRange = tomlString(pythonProject, 'requires-python');

  expectEqual(npmPackage.name, EXPECTED.npmName, 'npm package name');
  expectEqual(pythonName, EXPECTED.pythonName, 'Python package name');
  expectEqual(npmPackage.version, tagVersion, 'npm package version');
  expectEqual(pythonVersion, tagVersion, 'Python package version');
  expectEqual(npmPackage.repository?.url, EXPECTED.repository, 'npm repository URL');
  expectEqual(npmPackage.bugs?.url, EXPECTED.issues, 'npm issues URL');
  expectEqual(npmPackage.packageManager, EXPECTED.packageManager, 'npm package manager');
  expectEqual(npmPackage.engines?.node, EXPECTED.nodeRange, 'npm Node engine');
  expectEqual(npmPackage.devEngines?.runtime?.name, 'node', 'npm development runtime name');
  expectEqual(npmPackage.devEngines?.runtime?.version, EXPECTED.nodeRange, 'npm development runtime');
  expectEqual(npmPackage.devEngines?.runtime?.onFail, 'error', 'npm development runtime failure policy');
  expectEqual(npmPackage.devEngines?.packageManager?.name, 'npm', 'npm development package-manager name');
  expectEqual(npmPackage.devEngines?.packageManager?.version, '11.19.1', 'npm development package manager');
  expectEqual(npmPackage.devEngines?.packageManager?.onFail, 'error', 'npm development package-manager failure policy');
  expectEqual(npmPackage.sideEffects, false, 'npm sideEffects contract');
  expectEqual(npmPackage.exports?.['.']?.types, './dist/index.d.ts', 'npm root type export');
  expectEqual(npmPackage.exports?.['.']?.require, './dist/index.js', 'npm root CommonJS export');
  expectEqual(npmPackage.exports?.['.']?.default, './dist/index.js', 'npm root default export');
  expectEqual(setupShim, EXPECTED.setupShim, 'setup.py compatibility shim');
  expectEqual(pythonRange, EXPECTED.pythonRange, 'Python runtime requirement');
  expectEqual(tomlString(pythonBuild, 'build-backend'), EXPECTED.pythonBuildBackend, 'Python build backend');
  expectArrayEqual(tomlStringArray(pythonBuild, 'requires'), EXPECTED.pythonBuildRequirements, 'Python build requirements');
  if (!Array.isArray(npmPackage.files) || !npmPackage.files.includes(EXPECTED.typescriptFiles)) {
    fail(`npm files must include the bounded TypeScript source glob ${JSON.stringify(EXPECTED.typescriptFiles)}`);
  }
  if (npmPackage.files.includes('src')) {
    fail('npm files must not include the broad TypeScript source directory');
  }
  if (!Array.isArray(npmPackage.files) || !npmPackage.files.includes(EXPECTED.pythonFiles)) {
    fail(`npm files must include the bounded Python source glob ${JSON.stringify(EXPECTED.pythonFiles)}`);
  }
  if (npmPackage.files.includes('python')) {
    fail('npm files must not include the broad Python directory');
  }
  expectEqual(tomlString(pythonUrls, 'Repository'), EXPECTED.repositoryPage, 'Python repository URL');
  expectEqual(tomlString(pythonUrls, 'Issues'), EXPECTED.issues, 'Python issues URL');

  process.stdout.write(`${JSON.stringify({
    ok: true,
    tag,
    version: tagVersion,
    npm: npmPackage.name,
    python: pythonName,
    node: EXPECTED.nodeRange,
    pythonRuntime: pythonRange,
    repository: EXPECTED.repositoryPage,
  })}\n`);
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
