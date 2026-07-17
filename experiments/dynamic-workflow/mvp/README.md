# Dynamic Workflow MVP

This prototype turns `/workflow <description>` into a task-specific JavaScript harness:

1. A generic planner receives the task and the current runtime manifest.
2. The host validates and previews the generated program.
3. After approval, a no-network Docker sandbox executes six workflow primitives.
4. `agent()` calls cross JSONL RPC into `@openai/agents`; selected host capabilities perform controlled I/O.
5. Scripts, manifests, events, metrics, permission outcomes, and reports are stored under `.workflow/runs/`.

The public task interface is intentionally singular: descriptions enter through `/workflow` or its plan-only form `/plan`.

## Setup

```bash
cd workflow/mvp
npm install
cp .env.example .env
cp .workflow/config.example.json .workflow/config.json
```

Set the OpenAI-compatible Chat Completions provider:

```bash
OPENAI_BASE_URL=https://your-compatible-endpoint.example/v1
OPENAI_API_KEY=...
MODEL_NAME=...
```

Review `.workflow/config.json` before running. It controls the workspace root and every host-side write, shell, network, search, and MCP allowlist. Do not commit that file because it can identify local commands, servers, or credential environment variables.

## Interaction

`npm start` opens the REPL:

```text
/workflow <description> [--yes]  generate and run a workflow
/plan <description> [--yes]      generate and preview without running
/last                            show the last run
/runs                            list recent runs
/doctor                          check provider compatibility
/sandbox build                   build the Docker sandbox image
/help                            show help
/exit                            exit
```

One-shot tasks use exactly the same parser and service:

```bash
npm start -- /workflow "Research this repository and summarize its architecture" --yes
npm start -- /plan "Compare the test and production architecture"
```

`/plan` writes and validates the generated script but never constructs worker agents or launches Docker. Its optional `--yes` only permits configured MCP capability discovery; it never approves workflow execution. During a workflow run, the REPL waits for completion and does not accept another task.

## Runtime Manifest

The planner does not receive an imaginary universal toolset. Every prompt includes:

- the six primitive signatures and semantics;
- active capability IDs, risk classes, function tool names, and failed MCP connections;
- saved workflows found under `.workflow/workflows/`;
- workspace root and all execution budgets;
- a provider manifest fixed to Chat Completions compatibility.

Generated agents select tools with `capabilities`:

```javascript
const result = await agent('Inspect the package and test structure.', {
  label: 'repository-reader',
  capabilities: ['workspace.read'],
})
```

Omitting `capabilities` grants only the safe default `workspace.read`; passing `[]` creates a reasoning-only worker. Unknown or unavailable IDs fail closed when the agent starts.

## Capabilities

Built-in capabilities are host-side function tools:

- `workspace.read`: list, read, and literal-search files inside the configured root.
- `workspace.write`: create files and make unique exact-text replacements; disabled unless `enableWorkspaceWrite` is true.
- `shell.exec`: execute `command + args` without a shell, under a workspace-relative `cwd`, with exact command allowlisting, timeout, and output limits.
- `web.fetch`: HTTP(S) GET only, with domain allowlisting, redirect revalidation, content-type, timeout, and size limits.
- `web.search`: a pluggable server-side adapter enabled by `.workflow/config.json` or `WORKFLOW_WEB_SEARCH_URL`.
- `mcp.<id>`: filtered tools from configured stdio or Streamable HTTP MCP servers.

Path checks reject absolute paths, `..` escapes, and symlink traversal. Network redirects cannot leave the allowlist. Hosted web search, hosted shell, hosted MCP, tool search, and `deferLoading` are rejected because this runtime uses Chat Completions rather than the Responses API.

The complete shape is demonstrated in `.workflow/config.example.json`. A local MCP smoke server is available at `examples/mcp/echo-server.mjs`.

## Approval Model

Safety has two independent gates:

1. Configuration and path validation decide whether an action is eligible.
2. Approval decides whether an eligible `network`, `write`, `exec`, or `admin` action may run now.

Without `--yes`, a TTY asks before generated-code execution and each high-risk function or MCP tool call. Approval prompts are serialized during concurrent work. Non-TTY runs default to denial. `--yes` automatically approves only actions that already passed their capability allowlist and containment checks.

MCP stdio startup is itself an `exec` action and HTTP startup is a `network` action. A failed or denied server is recorded in the manifest and omitted from planner-visible capabilities. The service closes all connected servers after success or failure.

## Workflow Contract

The sandbox exports only:

- `agent(prompt, opts?)`
- `parallel(thunks)`
- `pipeline(items, ...stages)`
- `workflow(nameOrRef, args?)`
- `phase(title)`
- `log(message)`

JavaScript supplies values, functions, `if`, bounded `for...of`, and `return`. `parallel()` accepts lazy zero-argument thunks so the runtime owns task start and barrier semantics. `pipeline()` lets each item advance to its next stage without waiting for all items. Saved child workflows receive `args` and share the parent's capability registry, permission policy, agent concurrency, and call budgets.

Imports, `require`, `process`, `globalThis`, direct `fetch`, `eval`, `Function`, prototype/constructor access, `while`, `do...while`, and unbounded `for` loops are rejected before launch.

The Docker image runs as an unprivileged user with no network, a read-only filesystem, CPU/memory/process limits, and no credentials. The workflow program itself cannot access host files, commands, or network; only worker capabilities can do so.

## State and Artifacts

```text
.workflow/
  config.json                 # ignored; local capability configuration
  config.example.json         # committed example
  workflows/*.workflow.js     # committed saved workflows
  runs/<run-id>/
    request.json
    manifest.json
    workflow.generated.js
    status.json
    permissions.json
    events.jsonl              # executed runs
    metrics.json              # executed runs
    report.json               # result plus active/failed capabilities
```

## Examples and Verification

Natural-language examples live under `examples/descriptions/`:

- `repo-analysis.txt`
- `web-research.txt`
- `shell-diagnosis.txt`
- `mcp-lookup.txt`

Engineering checks:

```bash
npm run build
npm test
OPENAI_BASE_URL= OPENAI_API_KEY= MODEL_NAME= ./scripts/smoke-interaction.sh
```

The automated suite covers the invocation parser, generic service, planner manifest inputs, REPL, AST rules, sandbox RPC, nested workflows and shared budgets, repository/write/shell/web containment, permission serialization, and MCP list/filter/call/close behavior. With provider credentials set, `smoke-interaction.sh` also executes one-shot `/plan`, `/workflow --yes`, `/doctor`, and artifact checks. Set `WORKFLOW_SMOKE_BUILD_SANDBOX=1` to include `/sandbox build`.

## Provider Compatibility Matrix

The provider is constructed with:

```javascript
new OpenAIProvider({
  useResponses: false,
  strictFeatureValidation: true,
})
```

Plain text and local function tools are required. Native structured output is probed by `/doctor`, but workers do not assume `tools + json_schema` works reliably on every compatible gateway: they parse and repair text JSON first, then use a no-tool formatter fallback.

- Required and enabled: Chat Completions text generation and local function calling.
- Probed with fallback: native structured JSON.
- Implemented locally: workspace, write, shell, Web fetch/search, and MCP function tools.
- Rejected at registry construction: Responses-only hosted web, shell, MCP, tool search, and deferred loading.

## Deliberate Limits

This remains a single-machine development runtime. It does not implement the Claude Code monitoring dashboard, cross-process checkpoint/resume, hosted cloud tools, multi-tenant isolation, or actual IDE slash-command registration. `/workflow` here is a CLI/REPL interaction with the same conceptual shape, not an injected Cursor or Claude Code command.
