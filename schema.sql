CREATE TABLE IF NOT EXISTS issues (
    query_hash VARCHAR(64) PRIMARY KEY,
    query_text TEXT NOT NULL,
    status VARCHAR(20) NOT NULL DEFAULT 'unsolved'
        CHECK (status IN ('unsolved', 'solved')),
    execution_time_sec DOUBLE PRECISION NOT NULL
        CHECK (execution_time_sec >= 0),
    summary TEXT NOT NULL,
    recommendation TEXT NOT NULL,
    optimized_query TEXT NOT NULL,
    analysis_status VARCHAR(20) NOT NULL DEFAULT 'pending'
        CHECK (analysis_status IN ('pending', 'complete', 'failed')),
    analysis_error TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Safe upgrades for a database created by the original project.
ALTER TABLE issues ALTER COLUMN query_hash TYPE VARCHAR(64);
ALTER TABLE issues ADD COLUMN IF NOT EXISTS analysis_status VARCHAR(20) NOT NULL DEFAULT 'complete';
ALTER TABLE issues ADD COLUMN IF NOT EXISTS analysis_error TEXT;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE issues ADD COLUMN IF NOT EXISTS last_seen TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'issues'::regclass
           AND conname = 'issues_analysis_status_check'
    ) THEN
        ALTER TABLE issues ADD CONSTRAINT issues_analysis_status_check
            CHECK (analysis_status IN ('pending', 'complete', 'failed'));
    END IF;
END $$;

CREATE INDEX IF NOT EXISTS issues_status_last_seen_idx
    ON issues (status, last_seen DESC);
