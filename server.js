'use strict';

const dotenv = require('dotenv');
const express = require('express');
const { Pool } = require('pg');

const { loadConfig } = require('./config');

dotenv.config({ quiet: true });

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