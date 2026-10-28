# Agent runtime

Use `index.ts` from components. The root `event-fold.ts`, `recovery.ts` and
`listener.ts` retain their existing APIs; implementations live in the following
folders:

- `folding/`: pure event reducers, revision/sequence handling, history windows and artifact anchoring.
- `recovery/`: authoritative state, connection/restore recovery, gap repair, settled history and late-stream monitoring.
- `actions/`: connection, prompt/abort, pagination, model/interaction commands and session management.
- `listening/`: one subscription, ordered event effects, watchdog, title generation and run invalidation.

`store.ts` composes the action groups and binds `store-access.ts`. Internal
effects use that imperative port; they do not import the store composition root
or public facade. Folding never accesses the store or performs I/O. Keep
single-flight maps and timers with their owning protocol.

See [the architecture and ownership guide](../../../../docs/frontend-agent-runtime.md)
for the dependency graph, dispatch order, cache lifetimes and validation commands.
