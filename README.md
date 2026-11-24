# SwarmForge AI

SwarmForge AI is a local-first, provider-powered software development workspace. It coordinates exactly ten named agents (one orchestrator and nine specialists), persists projects/runs/tasks/artifacts in SQLite, and provides a live dashboard for plans, task state, agent reports, files, logs, and delivery status.

## Architecture

- **Web:** React + TypeScript + Vite dashboard.
- **API/orchestration:** Node.js + Express, dependency-aware scheduler (independent tasks run in batches of up to three), OpenAI-compatible `/chat/completions` provider abstraction.
- **Persistence:** SQLite via better-sqlite3 (`data/swarmforge.sqlite`, configurable with `SWARMFORGE_DATA_DIR`).
- **Workspace:** generated project artifacts stored as database-backed files, protected by relative path validation and no-overwrite conflict checks.
- **Agents:** Orchestrator, Product Analyst, UI/UX Designer, Frontend Developer, Backend Developer, Database Engineer, Security & Authentication Engineer, QA & Testing Engineer, DevOps & Build Engineer, Code Reviewer.

## Run locally

Requirements: Node.js 20+ and npm.

```bash
npm install
npm run dev
```

Open the Vite URL (normally http://localhost:5173). The API runs on http://localhost:3001. Production-style local run: `npm run build && npm start`, then open http://localhost:3001.

Create a project, open **Settings**, enter an OpenAI-compatible base URL, model name and API key, then start the AI team. The key is held in server memory only (not stored in SQLite or logs) and is cleared when the API process restarts. The configured endpoint must implement `POST /chat/completions` and return a compatible chat completion response. Provider/model failures are reported in the run/agent logs. Provider usage is not currently persisted or cost-estimated.

Optional environment variables: `PORT` (default 3001), `SWARMFORGE_DATA_DIR` (default `./data`). Do not commit provider credentials.

## Workflow and status

The orchestrator requests an architecture plan, then creates nine specialist tasks with explicit dependency edges. Ready tasks execute concurrently in groups of up to three. Every model response must conform to a structured JSON report; malformed responses fail instead of being represented as successful. Agent status, task status, outputs, errors, and event messages are persisted and displayed from real API execution. Generated files are rejected if paths are unsafe, oversized, or would overwrite different existing workspace content.

Run `npm test` for platform unit tests; `npm run build` type-checks and builds the UI.

## Safety boundaries and limitations

- **No generated project code is executed.** The server intentionally has no shell/command execution facility; QA can generate test files and a test plan, but this release cannot run project tests or claim a build/startup passed. The report states this explicitly. To enable execution safely, add a separately deployed disposable container/VM runner with resource/network limits, approval gates, and secret isolation—not host shell execution.
- External deployments are not implemented and must be added behind explicit user approval.
- Projects are local to one server instance. Authentication/multi-tenant isolation, collaboration, Git operations, editing/patch approvals, and a container sandbox are not implemented. Do not expose the unauthenticated API to an untrusted network.
- Provider keys are process-memory-only and lost on restart. Browser configuration sends a key to the local API over HTTP in dev; use TLS and authenticated access if exposing the service outside a trusted local machine.
- Generated outputs are model-produced and require human review. The reviewer agent's report is advisory, not a cryptographic or formal correctness guarantee. Failed review/test tasks are visible; this initial workflow does not automatically retry repair tasks.
- The UI displays artifacts read-only. File writes are exclusively agent-generated and conflict-protected.

## API overview

`GET /api/health`, `GET /api/agents`, `GET|PUT /api/config`, `GET|POST /api/projects`, `GET /api/projects/:id`, `POST /api/projects/:id/runs`, `GET /api/runs/:id`, `POST /api/runs/:id/cancel`, and `GET /api/projects/:id/files`.
