# Server code conventions

New code follows domain ownership; existing paths remain compatible until a domain is migrated deliberately. Moving files alone does not establish a boundary.

## Where code belongs

| Code | Location |
| --- | --- |
| Domain use cases, ports, command definitions and domain repositories | `src/modules/<domain>/` |
| Application construction, lifecycle and concrete dependency selection | `src/app/` |
| Request parsing, authentication adapters and HTTP response/error mapping | `src/http/` |
| Agent, kernel, process, sandbox and recovery mechanisms | `src/runtime/` |
| SQLite connection, worker protocol and migrations | `src/storage/sqlite/` |
| Cross-domain application errors | `src/modules/application-error.ts` |
| Browser/server request and response schemas | `packages/contracts/src/<domain>.ts` |

The current Memory implementation remains in `src/memory/`; its new command contract belongs to `modules/memory/`. Existing repository locations are listed individually in `scripts/architecture/boundary-baseline.json`. A new repository outside a domain module fails the boundary check. Infrastructure workers may import domain command contracts, but not application construction or HTTP adapters.

Keep kebab-case filenames and colocated tests. Internal objects use camelCase. Existing wire fields and persisted formats retain their names; convert at the transport boundary when needed. Contracts derive DTO types from schemas and export them through an export-only `index.ts`. The paired `.js` files are native Node source-loading adapters and must be retained when splitting modules.

## Who owns dependencies and state

Production application graphs are constructed in `createServerModules()`. Stateful dependencies used by a business service must be constructor parameters; inject the smallest required capability (`Pick<Repository, ...>` or a domain port). Do not import an exported default repository or event hub from a domain service.

Memory source validation and its scheduler use the same app-owned session repository; execution validation uses the app-owned execution repository. Replacing either dependency in a test changes all those paths. The Node session facade receives an explicitly constructed Agent Core service in production. Legacy standalone facade constructors create independent dependencies; they no longer attach themselves to global repository/hub instances.

The Agent Core session service owns the runtime and mutation maps. Startup, command, lifecycle, approval, query, resource and supervision operations receive named capability contexts. Same-capability implementation calls go directly to their functions, rather than passing through the public facade. Cross-capability hooks such as runtime attachment, reopening, recovery and verified retirement remain explicit ports; runtime hooks and shutdown flags retain live access so configuration changes cannot leave stale snapshots.

Do not add unused facade callbacks to `SessionContext`. A new capability must specify its state owner and the operations it actually needs. Do not construct a business service inside an HTTP handler; pass the app-owned use case to route registration.

## Types and failure propagation

`modules/memory/commands.ts` owns the Memory action/input/output mapping and action-specific runtime schemas. `MemoryService.command()` infers output from the action, requires identifiers and other mandatory inputs, and does not accept a caller-selected output type. Unknown commands and malformed IPC envelopes are rejected at the transport boundary and again in the worker before starting a transaction. Low-level transport result assertions stay at the IPC seam; business callers use the typed service.

Ordinary application failures use `ApplicationError(kind, code, message, details)`. Domain errors carry no HTTP status. Memory, MCP and Job specializations preserve meaningful codes; SQLite worker serialization preserves the domain category and code rather than turning them into a storage failure. SQLite transport failures remain `SqliteStateError`.

`http/application-error.ts` maps domain categories to status codes. Session delivery/permission workflows use a discriminated result union because rejection, acceptance and uncertain delivery are expected outcomes; their HTTP status mapping lives in `http/session-runtime-status.ts`. The application-use-case result carries a disposition or domain category, never a status number. Existing response envelopes and wire error codes remain compatible.

## Automated checks

Run `pnpm lint`, `pnpm typecheck` and the affected test suites. Root lint includes:

- `pnpm format:check`: pinned Prettier with one configuration. Untouched legacy formatting is temporarily allowed by exact content hash. New or edited files must pass formatting; `pnpm format` formats just those files. This avoids mixing a repository-wide whitespace rewrite with behavior changes. Pure formatting should be reviewed/committed independently when committing a larger migration.
- `pnpm check:boundaries`: AST-based import analysis for layer inversions, singleton imports and internally constructed service/repository dependencies in domain services, contracts importing their own barrel, new repositories in legacy locations and new runtime cycles. Type-only imports participate in layer checks but do not create runtime cycles. Existing exceptions are explicit; new violations and obsolete exceptions fail the check.

The gates have isolated fixture tests covering aliased imports, dynamic imports, type-only edges, cycles and formatting edits. The existing sandbox policy/profile cycle is recorded as two explicit edges; it is not permission to add another cycle. Baselines are migration inventories, not a reason to suppress a new violation. Reduce them as domains are migrated, and explain any deliberate new exception in review.
