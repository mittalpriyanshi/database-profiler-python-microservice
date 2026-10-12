# AI-Powered PostgreSQL Query Profiler

A full-stack database observability project built with a Node.js monitoring/API service, a Python FastAPI AI service, PostgreSQL, Gemini, REST APIs, and WebSockets.

The application polls PostgreSQL text logs for slow statements, stores issue state in PostgreSQL, asks Gemini for an explanation and optimized SQL, and sends WebSocket change notifications to a browser-based solved/unsolved queue. The browser then fetches the current issue through the REST API.

## Architecture

```text
PostgreSQL text logs
        |
        v
Node.js monitoring and API service (port 3000)
  |     |                         |
  |     +--> PostgreSQL state     +--> WebSocket dashboard
  |
  +--------> Python FastAPI AI service (port 8000)
                         |
                         +--> Gemini API
```

### Node.js service responsibilities

- Poll the newest PostgreSQL log and parse slow statements.
- Handle partial writes, multiline SQL, log rotation, and truncation.
- Deduplicate identical SQL text using an MD5 query fingerprint.
- Store `pending`, `complete`, or `failed` AI state in PostgreSQL.
- Maintain the user-facing `solved` or `unsolved` state.
- Expose REST endpoints and broadcast changes over WebSockets.
- Serve the browser dashboard.

### FastAPI service responsibilities

- Validate incoming query-analysis requests with Pydantic.
- Call Gemini asynchronously with a timeout.
- Require a structured summary, recommendation, and optimized query.
- Convert missing configuration, timeouts, invalid AI output, and upstream failures into clear HTTP errors.

The profiler never executes generated SQL or `CREATE INDEX` recommendations.

## Why the architecture is scalable

`Scalable` here describes the architecture, not a claim of unlimited production capacity:

- The FastAPI service is stateless and independently deployable, so AI analysis can run separately or behind multiple replicas.
- PostgreSQL holds shared issue state instead of process memory.
- The Node service uses a bounded PostgreSQL connection pool and asynchronous file, HTTP, and database operations.
- The Node and Python services communicate through a documented HTTP contract, so either implementation can evolve independently.
- WebSockets push changes instead of forcing every browser to poll continuously.

One Node monitor is intentionally responsible for one PostgreSQL log source. Monitoring multiple database hosts would require one collector per source or a centralized message queue; that is future work.

## Issue lifecycle

```text
Slow SQL detected
      |
      v
Saved as unsolved + pending
      |
      +--> Gemini succeeds --> complete --> DBA reviews --> solved
      |
      +--> Gemini fails ----> failed ----> remains visible
                                      (retried when the SQL appears again)
```

Saving the query before calling Gemini prevents a temporary AI outage from silently losing the database issue.

## Requirements

- Node.js 20 or later
- Python 3.11 or later
- PostgreSQL with readable text logs
- A Gemini API key

## Project structure

| File | Purpose |
| --- | --- |
| `server.js` | Node.js entry point, REST API, WebSocket server, PostgreSQL persistence, and log watcher |
| `config.js` | Environment-variable validation and defaults |
| `log-parser.js` | Incremental PostgreSQL text-log parser and primary-table extraction |
| `main.py` | FastAPI service that validates requests and calls Gemini |
| `schema.sql` | Idempotent `issues` table setup and upgrades |
| `index.html`, `app.js`, `styles.css` | Browser issue queue |
| `.env.example` | Safe configuration template; copy it to `.env` locally |

Generated folders such as `.venv`, `node_modules`, and `__pycache__` are intentionally excluded from Git.

## Setup on Windows Command Prompt

The commands below assume Command Prompt is open in the cloned project folder. If it is not, first run `cd /d "C:\path\to\db-profiler"` with your actual path.

```cmd
if not exist .env copy .env.example .env
notepad .env
npm ci
py -3.12 -m venv .venv
.venv\Scripts\python.exe -m pip install -r requirements.txt
"C:\Program Files\PostgreSQL\18\bin\createdb.exe" -U postgres -W MyCompany
"C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -d MyCompany -W -v ON_ERROR_STOP=1 -f schema.sql
```

Skip the `createdb` command if `MyCompany` already exists. If your installed PostgreSQL version is not 18, change both the executable path and `POSTGRES_VERSION`/`PG_LOG_DIRECTORY` in `.env`.

Set these PostgreSQL values in `postgresql.conf`, then restart the PostgreSQL service:

```conf
logging_collector = on
log_min_duration_statement = 1000
```

The Windows account running Node must also have read access to the directory configured by `PG_LOG_DIRECTORY`. Never commit `.env`; it contains the database password and Gemini API key.

## Run

Command Prompt 1 - Python AI microservice:

```cmd
.venv\Scripts\python.exe -m uvicorn main:app --host 127.0.0.1 --port 8000
```

FastAPI exposes health at `http://127.0.0.1:8000/` and interactive API documentation at `http://127.0.0.1:8000/docs`.

Command Prompt 2 - Node monitor, REST API, WebSocket, and dashboard:

```cmd
npm start
```

Open `http://127.0.0.1:3000`. Do not open `index.html` directly.

## REST and WebSocket interface

| Interface | Purpose |
| --- | --- |
| `GET /health` | Verifies Node can query PostgreSQL |
| `GET /issues/next` | Returns the newest unsolved issue |
| `POST /issues/:hash/solve` | Persists the solved state |
| `POST http://127.0.0.1:8000/analyze-query-gemini` | Validates and analyzes a slow query |
| WebSocket message `issue_changed` | Tells browsers to fetch the current issue through REST |

## Configuration

| Setting | Default | Purpose |
| --- | --- | --- |
| `HOST` / `PORT` | `127.0.0.1` / `3000` | Node listener |
| `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` | `127.0.0.1`, `5432`, `MyCompany`, `postgres`, required | Database connection |
| `PG_LOG_DIRECTORY` | PostgreSQL 18 Windows log path | Log source |
| `SLOW_QUERY_THRESHOLD_MS` | `1000` | Minimum duration to analyze |
| `LOG_POLL_INTERVAL_MS` | `2000` | Log polling interval |
| `PROCESS_EXISTING_LOGS` | `false` | Whether startup processes the current historical log |
| `AI_SERVER_URL` | local port 8000 | FastAPI endpoint |
| `AI_TIMEOUT_MS` | `45000` | Node-to-FastAPI timeout |
| `GOOGLE_API_KEY` | required | Gemini credential |
| `GEMINI_MODEL` | `gemini-3.5-flash` | Gemini model |
| `GEMINI_TIMEOUT_SECONDS` | `40` | FastAPI-to-Gemini timeout |

`POSTGRES_LOG_DIR` and `PASSWORD` remain accepted for compatibility with the older JavaScript version, but `PG_LOG_DIRECTORY` and `DB_PASSWORD` are preferred.

## Quick checks

```cmd
npm run check
.venv\Scripts\python.exe -c "import main; print('FastAPI imports OK')"
```

`npm run check` performs JavaScript syntax checks. The Python command verifies that the FastAPI module and its installed dependencies import correctly. This repository currently does not include an automated test suite.

## End-to-end demonstration

```cmd
curl.exe http://127.0.0.1:8000/
curl.exe http://127.0.0.1:3000/health
"C:\Program Files\PostgreSQL\18\bin\psql.exe" -U postgres -d MyCompany -W -c "SELECT pg_sleep(1.2);"
```

The query should appear as `pending`, then become `complete` or visibly `failed`. Marking it solved persists the state and displays the next unsolved issue.

## Troubleshooting

- **Python imports are underlined in the editor:** select `.venv\Scripts\python.exe` as the workspace interpreter.
- **Node reports a log-directory permission error:** grant your Windows account read access to `PG_LOG_DIRECTORY`, then restart Node.
- **Node reports a schema/startup error:** confirm PostgreSQL is running and rerun `schema.sql` against the database named in `.env`.
- **An issue remains `failed`:** confirm FastAPI is running on port 8000, `GOOGLE_API_KEY` is valid, and `GEMINI_MODEL` is available to that key. The query remains stored and is retried when PostgreSQL logs the same SQL again.
- **No query appears:** verify `logging_collector`, `log_min_duration_statement`, `PG_LOG_DIRECTORY`, and `SLOW_QUERY_THRESHOLD_MS`. With the default settings, the logged duration must be at least 1000 ms.

## Deliberate boundaries and future improvements

- The prototype reads PostgreSQL text logs containing `duration: ... ms statement:`. JSON/CSV logs and prepared-statement `execute ...:` entries are future formats.
- Analysis uses SQL text and primary-table column metadata. Multi-table joins, existing-index analysis, `EXPLAIN (ANALYZE, BUFFERS)`, statistics, locks, and wait events are future enrichment.
- Failed analysis is retried when the same slow SQL appears again; a scheduled retry queue is future work.
- Authentication, TLS, centralized metrics, formal migrations, and multi-host collectors are required before shared production deployment.
- SQL and schema metadata are sent to Gemini and must comply with the organization's data-handling policy.
