# External runtime composition

This offline example supplies an external runtime descriptor and test adapters
to the ordinary Forge engine, commits local artifacts, and verifies them
without loading an adapter-specific parser. The runtime is an in-memory test
double, not a process sandbox or a production runtime implementation.

From the repository root:

```sh
pnpm build
node examples/external-runtime/run.mjs
```

No Docker, credentials, or model calls are needed. Each invocation writes a
new result under `results/external-runtime/runs/` and prints its verified
location and runtime identity. The public test helpers supply a minimal plan
and scripted agent; normal embedding hosts load a dataset and experiment and
resolve a plan through the standard planning API.

A real adapter implements the same public command, workspace, state,
finalization, quiescence, and cleanup capabilities. Its pure `preflight` must
validate its complete configuration and requirements before allocation. The
public engine continues to own the evaluation lifecycle.
