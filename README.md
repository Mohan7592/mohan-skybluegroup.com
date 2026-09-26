# Pitch Intelligence Workspace

Pitch Intelligence is a source-aware out-of-home (OOH) media planning workspace. It combines brand and campaign research, a synced bus-shelter catalogue, project locations, shelter proximity, source-route recommendations, and a reviewable media plan. Brand Market scopes research; Campaign Geography independently scopes planning. Recommendations are planning evidence, not availability, audience-reach, or booking guarantees.

## Repository contents

| Path | Purpose |
| --- | --- |
| `artifacts/pitch-intelligence` | React/Vite frontend |
| `artifacts/api-server` | Express API, import tools and planning services |
| `lib/api-spec`, `lib/api-client-react`, `lib/api-zod` | OpenAPI contract and generated client/validators |
| `lib/db` | PostgreSQL schema and Drizzle configuration |
| `artifacts/mockup-sandbox` | Isolated component preview tooling |

Uploaded files, private inventory and passenger sources, client assets, screenshots, exports, reports, credentials, and local database contents are **not** in this repository. A new clone starts with an empty database; it does not include the current workspace's projects or 862-shelter inventory.

## Prerequisites and environment

- Node.js 24 and pnpm 10 (the project requires pnpm).
- PostgreSQL and a database connection available to the API as `DATABASE_URL`.
- For Replit, attach a database and use the registered API and web artifact workflows. The artifact router supplies service ports, the web `BASE_PATH`, and same-origin `/api` routing.
- Outside Replit, supply your own same-origin reverse proxy: send `/api/*` to the API server and other requests to the Vite server. Running Vite directly on its own port without that proxy serves the UI but will not route API requests to the backend.

`.env.example` lists **names only**; set actual values in your local environment or Replit Secrets, never in Git. Do not commit a populated `.env`. Required for a database-backed API: `DATABASE_URL`. `PORT` is set separately for each service, and `BASE_PATH` is required by the web Vite config. `SESSION_SECRET` is server-side session configuration. `NODE_ENV` and `LOG_LEVEL` are optional runtime settings.

Optional integrations:

| Variables | Used for |
| --- | --- |
| `SHELTER_MASTER_SHEET_ID`, `INVENTORY_SYNC_INTERVAL_MINUTES` | Google Sheets shelter inventory sync and its schedule |
| `BUS_ROUTES_MASTER_SHEET_ID`, `BUS_ROUTES_SYNC_INTERVAL_MINUTES` | Source route-variant sync and its schedule |
| `PRIVATE_OBJECT_DIR`, `DEFAULT_OBJECT_STORAGE_BUCKET_ID`, `PUBLIC_OBJECT_SEARCH_PATHS` | Private application object storage, including passenger imports where configured |
| `AI_INTEGRATIONS_OPENAI_BASE_URL`, `AI_INTEGRATIONS_OPENAI_API_KEY` | Replit-managed AI integration when available; not a substitute for a configured live research provider |

Google Sheets access must be configured separately through the appropriate integration. Spreadsheet IDs and connection credentials belong in the environment, not the repository. This application does not include the source spreadsheets.

## Database and first run

From the repository root:

```bash
pnpm install --frozen-lockfile
pnpm --filter @workspace/api-spec run codegen
pnpm --filter @workspace/db run push
pnpm run typecheck
```

The schema command applies the current Drizzle schema to the configured **development** database; review its proposed changes before accepting them. Existing project data is not shipped, and setup does not import source data. Schema and source migrations live under `lib/db` and `artifacts/api-server/src/cli`; do not run maintenance or import commands against production without reviewing them separately.

Replit starts the registered `artifacts/api-server: API Server` and `artifacts/pitch-intelligence: web` workflows. For direct local processes, run these in separate shells (the port numbers are non-secret local examples):

```bash
PORT=8080 pnpm --filter @workspace/api-server run dev
PORT=5173 BASE_PATH=/ pnpm --filter @workspace/pitch-intelligence run dev
```

For standalone local browser access, route both services through one origin. For example, with Caddy installed separately, save this as a local `Caddyfile` and run `caddy run --config Caddyfile`, then open `http://localhost:3000`:

```caddyfile
:3000 {
  handle /api/* {
    reverse_proxy localhost:8080
  }
  handle {
    reverse_proxy localhost:5173
  }
}
```

The API responds under `/api`. `pnpm run build` performs workspace typechecks and builds. `pnpm --filter @workspace/api-server run start` starts the built API.

## Inventory sync and imports

With authorized Google Sheets access and `SHELTER_MASTER_SHEET_ID` configured, the API schedules shelter sync; `INVENTORY_SYNC_INTERVAL_MINUTES` controls the interval (zero disables scheduling). Trigger a reviewed manual sync with `POST /api/inventory/sync`. Read `GET /api/inventory/sync/status`, `/history`, `/health`, and `/conflicts` for source freshness, reconciliation and exceptions. These endpoints are relative to `/api/inventory/sync`. Source files and imported catalogue records are not committed.

Set `BUS_ROUTES_MASTER_SHEET_ID` to sync route **source variants** with `POST /api/inventory/bus-routes/sync`. This is a route-reference import, not a fleet availability or reservation feed. Route recommendations require approved strategy and positive campaign-geography evidence; routes without verified overlap are conservatively excluded. The inventory UI/API also supports reviewed spreadsheet preview and import (`POST /api/inventory/imports/preview`, then `/api/inventory/imports`).

## Passenger import

Keep raw RTA passenger CSVs outside the clone and Git. The passenger-journeys flag is mandatory. First run the import as a dry run from a private file path:

```bash
node --experimental-strip-types artifacts/api-server/src/cli/import-passenger-metrics.mjs --file <private-csv-path> --passenger-journeys --dry-run
```

After reviewing mapping and rejected rows, replace `--dry-run` with `--commit` to write to the configured database/private storage. The importer checks source identity and rejects invalid or duplicate imports; source files are not part of this repository. Passenger metrics are context for a matched source route variant, not guaranteed campaign reach.

## Research providers

Research claims must have source provenance and review status. The current research interface includes persisted illustrative/fixture data, while live research depends on external provider configuration. The standalone clone does **not** automatically provide a web crawler or turn on live research merely because AI environment variables exist; an explicit provider/connector is required for live refresh. Keep provider credentials in the environment. Treat sample/AI-interpreted claims as unverified until independently sourced and approved.

## Checks

```bash
pnpm run typecheck
pnpm run build
node --experimental-strip-types --test artifacts/api-server/src/lib/*.test.mjs
node --test artifacts/pitch-intelligence/src/lib/shelter-network.test.ts
```

There is no root `test` script; the commands above run the checked-in test modules. This source repository is reproducible with the listed tools and a configured development database, but reproducing live inventory, passenger data, and provider-backed research also requires separately authorized external sources. Project routes currently lack production-grade user authorization; do not expose private client data through a public deployment without adding access controls.