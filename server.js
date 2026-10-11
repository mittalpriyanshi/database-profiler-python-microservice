'use strict';

const dotenv = require('dotenv');
const express = require('express');
const { Pool } = require('pg');

const { loadConfig } = require('./config');

dotenv.config({ quiet: true });

function createApp({ pool, broadcast }) {
    const app = express();

    app.get('/health', async (_req, res) => {
        try {
            await pool.query('SELECT 1');
            res.json({ status: 'ok' });
        } catch {
            res.status(503).json({
                status: 'unavailable',
            });
        }
    });

    app.get('/issues/next', async (_req, res) => {
        try {
            const result = await pool.query(`
                SELECT query_hash,
                       query_text,
                       execution_time_sec,
                       summary,
                       recommendation,
                       optimized_query,
                       analysis_status,
                       last_seen
                  FROM issues
                 WHERE status = 'unsolved'
                 ORDER BY last_seen DESC
                 LIMIT 1
            `);

            res.json(result.rows[0] || null);
        } catch {
            res.status(500).json({
                error: 'Could not fetch the next issue.',
            });
        }
    });

    app.post('/issues/:hash/solve', async (req, res) => {
        const { hash } = req.params;

        if (!/^[a-f0-9]{32}$/i.test(hash)) {
            return res.status(400).json({
                error: 'Invalid issue hash.',
            });
        }

        const result = await pool.query(
            `UPDATE issues
                SET status = 'solved'
              WHERE query_hash = $1
          RETURNING query_hash`,
            [hash],
        );

        if (result.rowCount === 0) {
            return res.status(404).json({
                error: 'Issue not found.',
            });
        }

        broadcast();
        return res.json({
            message: 'Issue marked as solved.',
        });
    });

    return app;
}

async function start() {
    let config;

    try {
        config = loadConfig();
    } catch (error) {
        console.error('Configuration error:', error.message);
        process.exitCode = 1;
        return;
    }

    const pool = new Pool(config.database);
    const app = express();

    app.get('/health', async (_req, res) => {
        try {
            await pool.query('SELECT 1');
            res.json({ status: 'ok' });
        } catch (error) {
            res.status(503).json({
                status: 'unavailable',
            });
        }
    });

    app.listen(config.port, config.host, () => {
        console.log(
            `Server running at http://${config.host}:${config.port}`,
        );
    });
}

void start();