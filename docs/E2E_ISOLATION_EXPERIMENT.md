# E2E Isolation Experiment

This is an opt-in experiment for running a small workflow-oriented E2E lane
beside the legacy serial lane. It does not change `npm run test:e2e`,
Playwright worker defaults, or the milestone gate.

## Isolated workflow lane

These specs clean up only their own `createTestRun()` fixtures and do not call
the broad demo-workspace stale cleanup during normal execution:

```bash
time npx playwright test \
  tests/e2e/update-record-workflows.spec.ts \
  tests/e2e/workflow-multiple-actions.spec.ts \
  tests/e2e/record-updated-transition-conditions.spec.ts \
  --workers=1
```

## Legacy serial lane

Run the remaining E2E specs serially, excluding the isolated workflow lane:

```bash
LEGACY_SPECS=$(find tests/e2e -name '*.spec.ts' \
  ! -name 'update-record-workflows.spec.ts' \
  ! -name 'workflow-multiple-actions.spec.ts' \
  ! -name 'record-updated-transition-conditions.spec.ts' \
  | sort)
time npx playwright test $LEGACY_SPECS --workers=1
```

## Manual concurrent experiment

Use three terminals. Terminal S owns the shared server. Terminal A owns global
setup and auth storage. Terminal B reuses both. In concurrent mode, stale
cleanup is skipped inside lane invocations; run stale recovery separately
before the experiment if needed.

Terminal S:

```bash
npm run build -- --webpack
npm run start:e2e
```

Start Terminal A after Terminal S is serving `http://localhost:3100`.

Terminal A:

```bash
LEGACY_SPECS=$(find tests/e2e -name '*.spec.ts' \
  ! -name 'update-record-workflows.spec.ts' \
  ! -name 'workflow-multiple-actions.spec.ts' \
  ! -name 'record-updated-transition-conditions.spec.ts' \
  | sort)
time env E2E_SKIP_WEB_SERVER=1 E2E_SKIP_STALE_CLEANUP=1 E2E_KEEP_GLOBAL_SETUP=1 \
  npx playwright test $LEGACY_SPECS --workers=1
```

Start Terminal B after Terminal A has completed global setup and begun running
tests.

Terminal B:

```bash
time env E2E_SKIP_GLOBAL_SETUP=1 E2E_SKIP_WEB_SERVER=1 npx playwright test \
  tests/e2e/update-record-workflows.spec.ts \
  tests/e2e/workflow-multiple-actions.spec.ts \
  tests/e2e/record-updated-transition-conditions.spec.ts \
  --workers=1
```

Each lane remains internally serial. The legacy lane still exercises the
current shared-demo cleanup behavior; the isolated workflow lane does not.
