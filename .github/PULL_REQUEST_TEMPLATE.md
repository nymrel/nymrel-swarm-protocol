## Summary

<!-- One or two sentences: what does this PR do and why? -->

Closes #<!-- issue number -->

## Changes

- <!-- bullet list of the meaningful changes -->

## Validation

<!-- Confirm each check ran locally before opening this PR -->

- [ ] `npm install --global npm@12.0.2 --ignore-scripts --no-audit --no-fund` (activates the pinned npm before any repo command)
- [ ] `npm ci --ignore-scripts --no-audit --no-fund` succeeds
- [ ] `npm run check` passes (build + TypeScript suite + release verify)
- [ ] `npm run audit` and `npm run audit:prod` pass
- [ ] Python parity suite passes: `python -m unittest discover -s tests -p 'test_*.py'`
- [ ] Docs updated where behavior changed
