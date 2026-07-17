# References

Last reviewed: 2026-07-16.

## Claude Code Dynamic Workflows

- Claude Code workflows documentation: https://code.claude.com/docs/en/workflows
  - Official name: Dynamic workflows.
  - Runtime model: Claude writes a JavaScript orchestration script; the workflow runtime executes it outside the main conversation.
  - Core primitives: `agent()` spawns one subagent; `pipeline()` maps dynamic lists to subagent calls.
  - Key constraints: no direct filesystem or shell access from the workflow script, no mid-run user input, up to 16 concurrent agents, up to 1,000 agents per run, resume only within the same Claude Code session.
- Introducing Dynamic workflows in Claude Code: https://claude.com/blog/introducing-dynamic-workflows-in-claude-code
- A harness for every task: dynamic workflows in Claude Code: https://claude.com/blog/a-harness-for-every-task-dynamic-workflows-in-claude-code
  - The framing is "a custom harness on the fly": the model generates a task-specific control program rather than relying on the main conversation to coordinate every turn.
  - Useful patterns include fan-out/synthesis, claim verification, tournaments, rule checking, hypothesis testing, triage, model routing, and saved reusable workflows.

## Agent Harnesses And Context

- Building effective agents: https://www.anthropic.com/engineering/building-effective-agents
  - Start simple, add agentic complexity only when it improves outcomes, keep stopping conditions and ground-truth feedback loops explicit.
- Effective context engineering for AI agents: https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents
  - Subagent architectures help manage context by letting focused workers explore deeply and return condensed summaries.
- Effective harnesses for long-running agents: https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents
  - Long-running agents need incremental work, explicit artifacts, versioned state, and clean handoff points.
- Harness design for long-running application development: https://www.anthropic.com/engineering/harness-design-long-running-apps
  - Generator/evaluator loops make "done" testable and turn qualitative review into an explicit harness.
- Demystifying evals for AI agents: https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents
  - Evals measure the harness and model together; isolation and repeatability matter.

## OpenAI Agents SDK

- OpenAI Agents SDK documentation: https://openai.github.io/openai-agents-js/
- Models and providers: https://openai.github.io/openai-agents-js/guides/models/
  - `OpenAIProvider` supports `baseURL` for OpenAI-compatible endpoints.
  - `useResponses: false` selects Chat Completions for provider-resolved model names.
  - `strictFeatureValidation: true` rejects Responses-only features rather than silently ignoring them.
- Agents: https://openai.github.io/openai-agents-js/guides/agents/
- Running agents: https://developers.openai.com/api/docs/guides/agents/running-agents
  - A run is an application-level turn; the runner loops over model calls, tools, handoffs, approvals, and stopping conditions.
- Orchestration and handoffs: https://developers.openai.com/api/docs/guides/agents/orchestration
  - Handoffs transfer ownership to a specialist; agents-as-tools keep a manager agent in control.
- Tools: https://openai.github.io/openai-agents-js/guides/tools/
- Guardrails: https://openai.github.io/openai-agents-js/guides/guardrails/
- Sessions: https://openai.github.io/openai-agents-js/guides/sessions/
- Tracing: https://openai.github.io/openai-agents-js/guides/tracing/

## Workflow Runtimes And Trends

- Google ADK workflow agents: https://google.github.io/adk-docs/agents/workflow-agents/
  - Sequential, parallel, and loop workflow agents are deterministic orchestration templates.
  - ADK docs describe graph-based and dynamic workflows as the more flexible successor direction.
- Google ADK custom agents: https://google.github.io/adk-docs/agents/custom-agents/
  - Custom workflow agents implement arbitrary control flow, dynamic agent selection, state management, and external integrations.
- LangGraph overview: https://docs.langchain.com/oss/python/langgraph/overview
  - LangGraph positions itself as an orchestration runtime for durable execution, streaming, human-in-the-loop, and persistence.
- LangGraph checkpointers: https://docs.langchain.com/oss/javascript/langgraph/checkpointers
  - Checkpointers save graph state at super-step boundaries for persistence, recovery, human review, and time travel.
- AutoGen GraphFlow: https://microsoft.github.io/autogen/stable/user-guide/agentchat-user-guide/graph-flow.html
  - GraphFlow uses directed graphs to provide deterministic execution over multi-agent teams, including fan-out, conditional branching, joins, and loops.
- Temporal durable execution: https://temporal.io/blog/what-is-durable-execution
  - Durable execution persists application progress so workflows can survive process crashes and infrastructure failures.
- Temporal and AI agents: https://temporal.io/blog/durable-execution-meets-ai-why-temporal-is-the-perfect-foundation-for-ai
  - Dynamic and static agent workflows both eventually need durable state, retries, observability, and external failure handling in production.
- OpenAI Agents SDK + Temporal: https://temporal.io/blog/announcing-openai-agents-sdk-integration
  - Demonstrates a production direction: keep agent loops familiar while delegating crash recovery and progress persistence to a durable execution platform.

## Local Notes

- Existing local model configuration: `../glm.sh`.
  - It is a shell environment fragment for an internal OpenAI-compatible `/v1` endpoint.
  - It is not a public GLM SDK, website, CLI, or official API specification.
  - It contains a plaintext API key and should not be copied into examples or documentation.
