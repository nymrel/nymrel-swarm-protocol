# Contributing to Nymrel Swarm Protocol

We welcome contributions from developers, researchers, and agentic systems engineers to make multi-agent coordination safer, faster, and truly zero-dependency!

## Philosophy & Core Rules

1. **Zero External Runtime Dependencies**: All core engines (fencing, claims, bus, envelopes, two-seat) MUST strictly use built-in standard libraries in Node.js and Python.
2. **Dual-Language Parity**: Any core feature added to TypeScript (`src/`) must have an identical 100% parity implementation in Python (`python/nymrel_swarm_protocol/`) and vice-versa.
3. **Cross-Platform Atomic Guarantees**: File locks and lease arbitrations must execute reliably across POSIX (Linux/macOS) and Windows.

## Development Workflow

### TypeScript / Node.js
```bash
# Install development dependencies
npm install

# Typecheck and build
npm run build
npm run typecheck

# Run test suite
npm test
```

### Python
```bash
# Install in editable mode
pip install -e .

# Run test suite
python -m unittest discover -s tests
```

## Submitting Pull Requests

1. Fork the repository.
2. Create a feature branch: `git checkout -b feature/my-cool-feature`.
3. Add unit & concurrency tests covering both TypeScript and Python.
4. Ensure all tests pass with 100% green execution.
5. Open a Pull Request with a clear description and test receipts.
