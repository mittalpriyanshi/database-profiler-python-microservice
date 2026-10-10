'use strict';

const path = require('path');

function numberSetting(env, name, fallback, minimum = 0) {
    const value = Number(env[name] ?? fallback);
    if (!Number.isFinite(value) || value < minimum) {
        throw new Error(`${name} must be a number greater than or equal to ${minimum}.`);
    }
    return value;
}

function loadConfig(env = process.env) {
    const password = env.DB_PASSWORD || env.PASSWORD;
    if (!password) throw new Error('DB_PASSWORD is missing from .env.');

    const postgresVersion = env.POSTGRES_VERSION || '18';
    const defaultLogDirectory = path.join(
        env.ProgramFiles || 'C:\\Program Files',
        'PostgreSQL',
        postgresVersion,
        'data',
        'log',
    );

    return {
        host: env.HOST || '127.0.0.1',
        port: numberSetting(env, 'PORT', 3000, 1),
        database: {
            host: env.DB_HOST || '127.0.0.1',
            port: numberSetting(env, 'DB_PORT', 5432, 1),
            database: env.DB_NAME || 'MyCompany',
            user: env.DB_USER || 'postgres',
            password,
            max: 5,
        },
        logDirectory: path.resolve(
            env.PG_LOG_DIRECTORY || env.POSTGRES_LOG_DIR || defaultLogDirectory,
        ),
        slowQueryThresholdMs: numberSetting(env, 'SLOW_QUERY_THRESHOLD_MS', 1000),
        pollIntervalMs: numberSetting(env, 'LOG_POLL_INTERVAL_MS', 2000, 250),
        processExistingLogs: /^true$/i.test(env.PROCESS_EXISTING_LOGS || 'false'),
        aiServerUrl: env.AI_SERVER_URL || 'http://127.0.0.1:8000/analyze-query-gemini',
        aiTimeoutMs: numberSetting(env, 'AI_TIMEOUT_MS', 45000, 1000),
    };
}

module.exports = { loadConfig, numberSetting };
