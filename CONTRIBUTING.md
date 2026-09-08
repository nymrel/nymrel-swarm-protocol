# Contributing to Nymrel Swarm Protocol

We welcome contributions from developers, researchers, and agentic systems engineers to make multi-agent coordination safer, faster, and truly zero-dependency!

## Philosophy & Core Rules

1. **Zero External Runtime Dependencies**: All core engines (fencing, claims, bus, envelopes, two-seat) MUST strictly use built-in standard libraries in Node.js and Python.
2. **Dual-Language Parity**: Any core feature added to TypeScript (`src/`) must have an identical 100% parity implementation in Python (`python/nymrel_swarm_protocol/`) and vice-versa.
3. **Cross-Platform Atomic Guarantees**: File locks and lease arbitrations must execute reliably across POSIX (Linux/macOS) and Windows.

## Development Workflow

### TypeScript / Node.js

The repository defaults to Node.js 24. On Node.js 22 or 24, activate the
reviewed npm CLI with Corepack. Node.js 26 is supported but does not bundle
Corepack; before entering the checkout, run
`npm install --global npm@11.19.1 --ignore-scripts --no-audit --no-fund`.

```bash
# Node.js 22/24 bootstrap. Node.js 26 uses the external-checkout bootstrap above.
corepack enable npm
npm --version # must print 11.19.1
npm ci --ignore-scripts --no-audit --no-fund

# Run the complete source, package, release, and dependency gates.
npm run check
npm run audit
npm run audit:prod
```

### Python
```bash
# Use a maintained Python 3.11 through 3.14 interpreter.
python -m pip install --disable-pip-version-check --no-deps -e .

# Run test suite
python -m unittest discover -s tests -p 'test_*.py'
```

## Submitting Pull Requests

1. Fork the repository.
2. Create a feature branch: `git checkout -b feature/my-cool-feature`.
3. Add unit & concurrency tests covering both TypeScript and Python.
4. Run the complete Node and Python gates above and keep generated `dist/` byte-current.
5. Open a Pull Request with a clear description and test receipts.
