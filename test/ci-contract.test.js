const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');
const workflow = read('.github/workflows/publish.yml');
const packageJson = JSON.parse(read('package.json'));
const pyproject = read('pyproject.toml');

function job(name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = workflow.match(new RegExp(`(?:^|\\n)  ${escaped}:\\r?\\n[\\s\\S]*?(?=\\r?\\n  [a-zA-Z0-9_-]+:\\r?\\n|$)`));
  assert.ok(match, `workflow is missing job ${name}`);
  return match[0];
}

function actionReferences(document) {
  return [...document.matchAll(/uses:\s+([^@\s]+)@([^\s#]+)/g)].map((match) => ({
    action: match[1],
    reference: match[2],
  }));
}

test('runtime support includes only maintained Node and Python boundaries', () => {
  for (const version of ['22.x', '24.x', '26.x']) assert.ok(workflow.includes(`node-version: ${version}`));
  for (const version of ["'3.11'", "'3.12'", "'3.13'", "'3.14'"]) assert.ok(workflow.includes(`python-version: ${version}`));
  for (const unsupported of ['node-version: 18', 'node-version: 20', "python-version: '3.9'", "python-version: '3.10'"]) {
    assert.equal(workflow.includes(unsupported), false, `workflow retains unsupported runtime ${unsupported}`);
  }
  assert.equal(packageJson.engines.node, '>=22.22.2 <27');
  assert.equal(packageJson.devEngines.runtime.version, '>=22.22.2 <27');
  assert.equal(packageJson.devEngines.packageManager.version, '11.19.1');
  assert.match(pyproject, /^requires-python = ">=3\.11"$/m);
  assert.match(pyproject, /^requires = \["setuptools==84\.0\.0"\]$/m);
});

test('every Node job activates exact npm before repository package commands', () => {
  const install = 'npm install --global npm@11.19.1 --ignore-scripts --no-audit --no-fund';
  const contracts = [
    ['test-node', 'npm ci --ignore-scripts --no-audit --no-fund'],
    ['security', 'npm ci --ignore-scripts --no-audit --no-fund'],
    ['build-release', 'npm ci --ignore-scripts --no-audit --no-fund'],
    ['publish-npm', 'npm publish'],
  ];

  assert.equal(/^\s*cache:\s*npm\s*$/m.test(workflow), false);
  assert.equal((workflow.match(/package-manager-cache:\s*false/g) ?? []).length, contracts.length);
  assert.equal((workflow.match(/npm install --global npm@11\.19\.1/g) ?? []).length, contracts.length);
  for (const [name, firstPackageCommand] of contracts) {
    const body = job(name);
    assert.ok(body.indexOf('actions/setup-node@') < body.indexOf(install), `${name} installs npm before Node`);
    assert.ok(body.indexOf(install) < body.indexOf(firstPackageCommand), `${name} evaluates the repository before exact npm`);
    assert.ok(body.includes('working-directory: ${{ runner.temp }}'), `${name} bootstraps npm inside the repository`);
  }
});

test('release artifacts are built once, attested, and reused by both trusted publishers', () => {
  const buildRelease = job('build-release');
  const attestation = job('attest-release');
  const npmPublish = job('publish-npm');
  const pypiPublish = job('publish-pypi');
  const consumerManifest = buildRelease.indexOf('nymrel-swarm-consumer');
  const consumerInstall = buildRelease.indexOf('npm install --ignore-scripts --no-audit --no-fund --prefix');

  assert.ok(consumerManifest >= 0, 'clean-room npm acceptance needs an explicit consumer manifest');
  assert.ok(consumerManifest < consumerInstall, 'clean-room npm acceptance installs only after creating its manifest');
  assert.ok(attestation.includes('actions/attest-build-provenance@4d101475d8b20a2381f78447822ac1eab6504dd8'));
  assert.ok(attestation.includes('attestations: write # Create provenance'));
  assert.ok(attestation.includes('id-token: write # Exchange the workflow identity'));
  assert.ok(npmPublish.includes('needs: [build-release, attest-release]'));
  assert.ok(pypiPublish.includes('needs: [build-release, attest-release]'));
  assert.equal((workflow.match(/actions\/upload-artifact@/g) ?? []).length, 1);
  assert.equal(workflow.includes('NPM_TOKEN'), false);
  assert.equal(workflow.includes('skip-existing'), false);
});

test('workflow execution is immutable, least privilege, and fail closed', () => {
  const references = actionReferences(workflow);
  for (const { action, reference } of references) {
    assert.match(reference, /^[0-9a-f]{40}$/, `${action} is not pinned to a full commit SHA`);
  }
  assert.deepEqual(new Set(references.map(({ action }) => action)), new Set([
    'actions/checkout',
    'actions/setup-node',
    'actions/setup-python',
    'actions/upload-artifact',
    'actions/download-artifact',
    'actions/attest-build-provenance',
    'zizmorcore/zizmor-action',
    'pypa/gh-action-pypi-publish',
  ]));
  assert.ok(workflow.includes('npm run audit'));
  assert.ok(workflow.includes('npm run audit:prod'));
  assert.ok(workflow.includes('zizmorcore/zizmor-action@3dc1ecc9bcb9e94e9b2c709687979e1298497054'));
  assert.equal(/^\s*cache:\s*(?:npm|pip)\s*$/m.test(workflow), false);
  assert.equal(/continue-on-error|\|\|\s*true|\|\|\s*echo/.test(workflow), false);
});
