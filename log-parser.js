'use strict';

const { Parser } = require('node-sql-parser');

const ENTRY_PATTERN = /duration:\s*([0-9]+(?:\.[0-9]+)?)\s*ms\s+statement:\s*(.*)$/i;
const NEW_RECORD_PATTERN = /^\s*(?:\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}|(?:LOG|ERROR|WARNING|FATAL|DETAIL|HINT|STATEMENT):)/i;

class PostgresLogParser {
    constructor() {
        this.partialLine = '';
        this.currentEntry = null;
    }

    push(chunk, { flush = true } = {}) {
        const lines = (this.partialLine + chunk).split(/\r?\n/);
        this.partialLine = lines.pop() || '';
        const entries = [];

        for (const line of lines) {
            const match = line.match(ENTRY_PATTERN);
            if (match) {
                this.finishEntry(entries);
                this.currentEntry = { durationMs: Number(match[1]), queryLines: [match[2]] };
            } else if (this.currentEntry) {
                if (NEW_RECORD_PATTERN.test(line)) this.finishEntry(entries);
                else this.currentEntry.queryLines.push(line);
            }
        }

        if (flush && !this.partialLine) this.finishEntry(entries);
        return entries;
    }

    finishEntry(entries) {
        if (!this.currentEntry) return;
        const query = this.currentEntry.queryLines.join('\n').trim();
        if (query) entries.push({ durationMs: this.currentEntry.durationMs, query });
        this.currentEntry = null;
    }

    reset() {
        this.partialLine = '';
        this.currentEntry = null;
    }
}

function extractPrimaryTable(sql) {
    try {
        const [firstTable] = new Parser().tableList(sql, { database: 'Postgresql' });
        if (!firstTable) return null;
        const [, rawSchema, table] = firstTable.split('::');
        if (!table || table === 'null') return null;
        return {
            schema: rawSchema && rawSchema !== 'null' ? rawSchema : null,
            table,
        };
    } catch {
        return null;
    }
}

module.exports = { PostgresLogParser, extractPrimaryTable };
