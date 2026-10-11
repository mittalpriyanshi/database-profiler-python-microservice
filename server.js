'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

const dotenv = require('dotenv');
const express = require('express');
const { Pool } = require('pg');
const WebSocket = require('ws');

const { loadConfig } = require('./config');
const { extractPrimaryTable, PostgresLogParser } = require('./log-parser');

dotenv.config({ quiet: true });

function errorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}

function createBroadcaster(wss) {
    return (message = 'issue_changed') => {
        const data = JSON.stringify({ message });
        for (const client of wss.clients) {
            if (client.readyState === WebSocket.OPEN) client.send(data);
        }
    };
}

function securityHeaders(_req, res, next) {
    res.set({
        'Content-Security-Policy': "default-src 'self'; connect-src 'self' ws: wss:; script-src 'self'; style-src 'self'; object-src 'none'",
        'X-Content-Type-Options': 'nosniff',
        'X-Frame-Options': 'DENY',
    });
    next();
}

function createApp({ pool, broadcast }) {
    const app = express();
    app.disable('x-powered-by');
    app.use(securityHeaders);

    app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
    app.get('/app.js', (_req, res) => res.sendFile(path.join(__dirname, 'app.js')));
    app.get('/styles.css', (_req, res) => res.sendFile(path.join(__dirname, 'styles.css')));

    app.get('/health', async (_req, res) => {
        try {
            await pool.query('SELECT 1');
            res.json({ status: 'ok' });
        } catch (error) {
            console.error('Database health check failed:', errorMessage(error));
            res.status(503).json({ status: 'unavailable' });
        }
    });

    app.get('/issues/next', async (_req, res) => {
        try {
            const result = await pool.query(
                `SELECT query_hash, query_text, execution_time_sec, summary,
                        recommendation, optimized_query, analysis_status, last_seen
                   FROM issues
                  WHERE status = 'unsolved'
                  ORDER BY last_seen DESC
                  LIMIT 1`,
            );
            res.set('Cache-Control', 'no-store');
            res.json(result.rows[0] || null);
        } catch (error) {
            console.error('Could not fetch the next issue:', errorMessage(error));
            res.status(500).json({ error: 'Could not fetch the next issue.' });
        }
    });

    app.post('/issues/:hash/solve', async (req, res) => {
        const { hash } = req.params;
        if (!/^[a-f0-9]{32}$/i.test(hash)) {
            return res.status(400).json({ error: 'Invalid issue hash.' });
        }

        try {
            const result = await pool.query(
                `UPDATE issues SET status = 'solved'
                  WHERE query_hash = $1
              RETURNING query_hash`,
                [hash],
            );
            if (result.rowCount === 0) return res.status(404).json({ error: 'Issue not found.' });
            broadcast();
            return res.json({ message: 'Issue marked as solved.' });
        } catch (error) {
            console.error('Could not solve issue:', errorMessage(error));
            return res.status(500).json({ error: 'Could not update the issue.' });
        }
    });

    return app;
}

async function getPrimaryTableSchema(pool, sql) {
    const reference = extractPrimaryTable(sql);
    if (!reference) return JSON.stringify({ table: null, columns: [] });

    try {
        let result;
        if (reference.schema) {
            result = await pool.query(
                `SELECT table_schema, table_name, column_name, data_type
                   FROM information_schema.columns
                  WHERE table_schema = $1 AND table_name = $2
                  ORDER BY ordinal_position`,
                [reference.schema, reference.table],
            );
        } else {
            result = await pool.query(
                `SELECT table_schema, table_name, column_name, data_type
                   FROM information_schema.columns
                  WHERE table_name = $1
                    AND table_schema = current_schema()
                  ORDER BY ordinal_position`,
                [reference.table],
            );
        }
        return JSON.stringify({ table: reference, columns: result.rows });
    } catch (error) {
        console.warn('Could not fetch table schema:', errorMessage(error));
        return JSON.stringify({ table: reference, columns: [] });
    }
}

function validateAiResponse(value) {
    if (!value || typeof value !== 'object') throw new Error('AI service returned invalid JSON.');
    const summary = typeof value.summary === 'string' ? value.summary.trim() : '';
    const optimizedQuery = typeof value.optimized_query === 'string' ? value.optimized_query.trim() : '';
    const recommendation = Array.isArray(value.recommendation)
        ? value.recommendation.filter((item) => typeof item === 'string').join('\n').trim()
        : typeof value.recommendation === 'string' ? value.recommendation.trim() : '';
    if (!summary || !recommendation || !optimizedQuery) {
        throw new Error('AI service response is missing a required field.');
    }
    return { summary, recommendation, optimizedQuery };
}

async function requestAiAnalysis(config, payload) {
    const response = await fetch(config.aiServerUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(config.aiTimeoutMs),
    });
    if (!response.ok) throw new Error(`AI service returned HTTP ${response.status}.`);
    return validateAiResponse(await response.json());
}

async function processSlowQuery(entry, { pool, broadcast, config, analyze = requestAiAnalysis }) {
    const { durationMs, query } = entry;
    if (durationMs < config.slowQueryThresholdMs) return;
    if (!query || query.length > 100000) {
        console.warn('Skipped an empty or excessively large query.');
        return;
    }

    const queryHash = crypto.createHash('md5').update(query).digest('hex');
    try {
        const saved = await pool.query(
            `INSERT INTO issues
                (query_hash, query_text, status, execution_time_sec, summary,
                 recommendation, optimized_query, analysis_status)
             VALUES ($1, $2, 'unsolved', $3, 'Analysis is in progress.',
                     'Waiting for the AI service.', $2, 'pending')
             ON CONFLICT (query_hash) DO UPDATE SET
                 last_seen = CURRENT_TIMESTAMP,
                 status = 'unsolved',
                 execution_time_sec = GREATEST(issues.execution_time_sec, EXCLUDED.execution_time_sec),
                 analysis_status = CASE
                     WHEN issues.analysis_status = 'complete' THEN 'complete'
                     ELSE 'pending'
                 END,
                 analysis_error = CASE
                     WHEN issues.analysis_status = 'complete' THEN issues.analysis_error
                     ELSE NULL
                 END
             RETURNING analysis_status`,
            [queryHash, query, durationMs / 1000],
        );
        broadcast();

        // Completed queries are deduplicated. Failed or interrupted queries are
        // retried naturally if PostgreSQL logs the same slow statement again.
        if (saved.rows[0].analysis_status === 'complete') return;

        try {
            const tableSchema = await getPrimaryTableSchema(pool, query);
            const analysis = await analyze(config, {
                sql_query: query,
                execution_time_sec: durationMs / 1000,
                table_schema: tableSchema,
            });
            await pool.query(
                `UPDATE issues
                    SET summary = $2, recommendation = $3, optimized_query = $4,
                        analysis_status = 'complete', analysis_error = NULL
                  WHERE query_hash = $1`,
                [queryHash, analysis.summary, analysis.recommendation, analysis.optimizedQuery],
            );
        } catch (error) {
            console.error(`Analysis failed for query ${queryHash}:`, errorMessage(error));
            await pool.query(
                `UPDATE issues
                    SET summary = 'AI analysis is currently unavailable.',
                        recommendation = 'Check the FastAPI service and Gemini configuration. This query will be retried if it appears again.',
                        optimized_query = query_text,
                        analysis_status = 'failed',
                        analysis_error = $2
                  WHERE query_hash = $1`,
                [queryHash, errorMessage(error).slice(0, 1000)],
            );
        }
        broadcast();
    } catch (error) {
        console.error('Could not store or process a slow query:', errorMessage(error));
    }
}

class LogWatcher {
    constructor({ directory, pollIntervalMs, processExistingLogs, onEntry }) {
        this.directory = directory;
        this.pollIntervalMs = pollIntervalMs;
        this.processExistingLogs = processExistingLogs;
        this.onEntry = onEntry;
        this.parser = new PostgresLogParser();
        this.currentFile = null;
        this.offset = 0;
        this.polling = false;
        this.timer = null;
    }

    async newestFile() {
        const entries = await fs.promises.readdir(this.directory, { withFileTypes: true });
        const files = await Promise.all(entries.filter((entry) => entry.isFile()).map(async (entry) => {
            const fullPath = path.join(this.directory, entry.name);
            return { fullPath, stats: await fs.promises.stat(fullPath) };
        }));
        files.sort((a, b) => b.stats.mtimeMs - a.stats.mtimeMs);
        return files[0] || null;
    }

    async poll() {
        if (this.polling) return;
        this.polling = true;
        try {
            const newest = await this.newestFile();
            if (!newest) return;

            if (!this.currentFile) {
                this.currentFile = newest.fullPath;
                this.offset = this.processExistingLogs ? 0 : newest.stats.size;
                console.log(`Monitoring PostgreSQL log: ${this.currentFile}`);
            } else if (this.currentFile !== newest.fullPath) {
                this.currentFile = newest.fullPath;
                this.offset = 0;
                this.parser.reset();
                console.log(`PostgreSQL log rotated to: ${this.currentFile}`);
            } else if (newest.stats.size < this.offset) {
                this.offset = 0;
                this.parser.reset();
                console.log('PostgreSQL log was truncated; monitoring restarted at the beginning.');
            }

            const handle = await fs.promises.open(this.currentFile, 'r');
            try {
                while (this.offset < newest.stats.size) {
                    const length = Math.min(1024 * 1024, newest.stats.size - this.offset);
                    const buffer = Buffer.allocUnsafe(length);
                    const { bytesRead } = await handle.read(buffer, 0, length, this.offset);
                    if (!bytesRead) break;
                    this.offset += bytesRead;
                    const entries = this.parser.push(buffer.subarray(0, bytesRead).toString('utf8'));
                    for (const entry of entries) await this.onEntry(entry);
                }
            } finally {
                await handle.close();
            }
        } catch (error) {
            console.error('Could not read PostgreSQL logs:', errorMessage(error));
        } finally {
            this.polling = false;
        }
    }

    start() {
        if (this.timer) return;
        void this.poll();
        this.timer = setInterval(() => void this.poll(), this.pollIntervalMs);
    }

    stop() {
        clearInterval(this.timer);
        this.timer = null;
    }
}

async function verifyStartup(pool, config) {
    await pool.query('SELECT analysis_status FROM issues LIMIT 0');
    await fs.promises.access(config.logDirectory, fs.constants.R_OK);
    const stats = await fs.promises.stat(config.logDirectory);
    if (!stats.isDirectory()) throw new Error('PG_LOG_DIRECTORY is not a directory.');
}

async function start() {
    let config;
    try {
        config = loadConfig();
    } catch (error) {
        console.error('Configuration error:', errorMessage(error));
        process.exitCode = 1;
        return;
    }

    const pool = new Pool(config.database);
    try {
        await verifyStartup(pool, config);
    } catch (error) {
        console.error('Startup check failed:', errorMessage(error));
        console.error('Check PostgreSQL, run schema.sql, and verify log-directory permissions.');
        await pool.end();
        process.exitCode = 1;
        return;
    }

    const baseApp = express();
    const server = http.createServer(baseApp);
    const wss = new WebSocket.Server({ server, maxPayload: 16384 });
    const broadcast = createBroadcaster(wss);
    baseApp.use(createApp({ pool, broadcast }));

    const watcher = new LogWatcher({
        directory: config.logDirectory,
        pollIntervalMs: config.pollIntervalMs,
        processExistingLogs: config.processExistingLogs,
        onEntry: (entry) => processSlowQuery(entry, { pool, broadcast, config }),
    });

    server.listen(config.port, config.host, () => {
        console.log(`DB Profiler is running at http://${config.host}:${config.port}`);
        watcher.start();
    });

    let closing = false;
    const shutdown = async () => {
        if (closing) return;
        closing = true;
        watcher.stop();
        for (const socket of wss.clients) socket.close();
        await new Promise((resolve) => server.close(resolve));
        await pool.end();
    };
    process.on('SIGINT', () => void shutdown());
    process.on('SIGTERM', () => void shutdown());

    return { server, pool, watcher, shutdown };
}

if (require.main === module) void start();

module.exports = {
    LogWatcher,
    createApp,
    getPrimaryTableSchema,
    processSlowQuery,
    requestAiAnalysis,
    validateAiResponse,
    verifyStartup,
};
