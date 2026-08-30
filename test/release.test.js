const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const verifier = path.resolve(__dirname, '..', 'scripts', 'verify-release.mjs');
const repository = 'https://github.com/nymrel/nymrel-swarm-protocol';

function fixture(overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nymrel-release-'));
  const npmPackage = {
    name: '@nymrel/swarm-protocol',
    version: '1.0.0',
    repository: { url: `${repository}.git` },
    bugs: { url: `${repository}/issues` },
    files: ['src/**/*.ts', 'python/nymrel_swarm_protocol/*.py'],
    packageManager: 'npm@11.19.1',
    engines: { node: '>=22.22.2 <27' },
    devEngines: {
      runtime: { name: 'node', version: '>=22.22.2 <27', onFail: 'error' },
      packageManager: { name: 'npm', version: '11.19.1', onFail: 'error' },
    },
    sideEffects: false,
    exports: {
      '.': {
        types: './dist/index.d.ts',
        require: './dist/index.js',
        default: './dist/index.js',
      },
    },
    ...overrides.npm,
  };
  const python = {
    name: 'nymrel-swarm-protocol',
    version: '1.0.0',
    repository,
    issues: `${repository}/issues`,
    requiresPython: '>=3.11',
    buildBackend: 'setuptools.build_meta',
    buildRequirements: ['setuptools==84.0.0'],
    ...overrides.python,
  };

  fs.writeFileSync(path.join(root, 'package.json'), `${JSON.stringify(npmPackage, null, 2)}\n`);
  fs.writeFileSync(path.join(root, 'pyproject.toml'), [
    '[build-system]',
    `requires = ${JSON.stringify(python.buildRequirements)}`,
    `build-backend = "${python.buildBackend}"`,
    '',
    '[project]',
    `name = "${python.name}"`,
    `version = "${python.version}"`,
    `requires-python = "${python.requiresPython}"`,
    '',
    '[project.urls]',
    `Repository = "${python.repository}"`,
    `Issues = "${python.issues}"`,
    '',
  ].join('\n'));
  fs.writeFileSync(
    path.join(root, 'setup.py'),
    overrides.setup ?? 'from setuptools import setup\n\nsetup()\n',
  );
  return root;
}

function verify(root, tag) {
  return spawnSync(process.execPath, [verifier, '--root', root, '--tag', tag], {
    encoding: 'utf8',
  });
}

function withFixture(overrides, callback) {
  const root = fixture(overrides);
  try {
    callback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

describe('release verification', () => {
  test('accepts exact dual-package version and repository parity', () => {
    withFixture({}, (root) => {
      const result = verify(root, 'v1.0.0');
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(JSON.parse(result.stdout), {
        ok: true,
        tag: 'v1.0.0',
        version: '1.0.0',
        npm: '@nymrel/swarm-protocol',
        python: 'nymrel-swarm-protocol',
        node: '>=22.22.2 <27',
        pythonRuntime: '>=3.11',
        repository,
      });
    });
  });

  test('rejects npm and Python version drift', () => {
    withFixture({ python: { version: '1.0.1' } }, (root) => {
      const result = verify(root, 'v1.0.0');
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Python package version/);
    });
  });

  test('rejects repository identity drift', () => {
    withFixture({ npm: { repository: { url: 'https://github.com/nymrel/swarm-protocol.git' } } }, (root) => {
      const result = verify(root, 'v1.0.0');
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /npm repository URL/);
    });
  });

  test('rejects end-of-life Node support and development-toolchain drift', () => {
    withFixture({ npm: { engines: { node: '>=18.0.0' } } }, (root) => {
      const result = verify(root, 'v1.0.0');
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /npm Node engine/);
    });

    withFixture({ npm: { devEngines: { runtime: { name: 'node', version: '>=22.22.2 <27', onFail: 'warn' } } } }, (root) => {
      const result = verify(root, 'v1.0.0');
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /development runtime failure policy/);
    });
  });

  test('rejects an end-of-life Python floor or mutable build backend', () => {
    withFixture({ python: { requiresPython: '>=3.9' } }, (root) => {
      const result = verify(root, 'v1.0.0');
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Python runtime requirement/);
    });

    withFixture({ python: { buildRequirements: ['setuptools>=77.0.0', 'wheel>=0.45.0'] } }, (root) => {
      const result = verify(root, 'v1.0.0');
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /Python build requirements/);
    });
  });

  test('rejects a package root that bypasses the reviewed distribution boundary', () => {
    withFixture({ npm: { exports: { '.': { default: './src/index.ts' } } } }, (root) => {
      const result = verify(root, 'v1.0.0');
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /npm root type export/);
    });
  });

  test('rejects a broad Python package manifest', () => {
    withFixture({ npm: { files: ['src/**/*.ts', 'python'] } }, (root) => {
      const result = verify(root, 'v1.0.0');
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /bounded Python source glob/);
    });
  });

  test('rejects a broad TypeScript package manifest', () => {
    withFixture({ npm: { files: ['src', 'python/nymrel_swarm_protocol/*.py'] } }, (root) => {
      const result = verify(root, 'v1.0.0');
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /bounded TypeScript source glob/);
    });
  });

  test('rejects duplicated legacy setup metadata', () => {
    withFixture({ setup: 'from setuptools import setup\n\nsetup(version="1.0.0")\n' }, (root) => {
      const result = verify(root, 'v1.0.0');
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /setup\.py compatibility shim/);
    });
  });

  for (const tag of ['1.0.0', 'v1.0', 'v01.0.0', 'v1.0.0-beta.1']) {
    test(`rejects non-stable release tag ${tag}`, () => {
      withFixture({}, (root) => {
        const result = verify(root, tag);
        assert.notEqual(result.status, 0);
        assert.match(result.stderr, /stable vMAJOR\.MINOR\.PATCH/);
      });
    });
  }
});
