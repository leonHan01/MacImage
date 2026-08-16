const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const JSON_MIGRATION_META_KEY = 'json_config_migrated';

class Store {
    constructor(filePath, options = {}) {
        this.filePath = filePath;
        this.legacyFilePath = options.legacyFilePath || `${filePath}.json`;
        this.backupFilePath = options.backupFilePath || `${this.legacyFilePath}.pre-sqlite.bak`;
        this.data = {};
        this.db = null;

        this.open();
    }

    open() {
        const dir = path.dirname(this.filePath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }

        this.db = new DatabaseSync(this.filePath);
        this.db.exec(`
            PRAGMA journal_mode = WAL;
            PRAGMA synchronous = NORMAL;

            CREATE TABLE IF NOT EXISTS store_meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS store_values (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL,
                updated_at INTEGER NOT NULL
            );
        `);

        this.load();
    }

    load() {
        this.data = {};

        const rows = this.db.prepare('SELECT key, value FROM store_values').all();
        rows.forEach((row) => {
            try {
                this.data[row.key] = JSON.parse(row.value);
            } catch (error) {
                console.error(`Error loading SQLite store key "${row.key}":`, error);
            }
        });

        this.migrateLegacyJsonIfNeeded();
    }

    migrateLegacyJsonIfNeeded() {
        if (this.getMeta(JSON_MIGRATION_META_KEY)) {
            return;
        }

        // Never overwrite an existing SQLite store with an older JSON file.
        // This also makes recovery safe if the process stopped after the data
        // transaction completed but before the migration marker was written.
        if (this.hasValues()) {
            this.setMeta(JSON_MIGRATION_META_KEY, '1');
            return;
        }

        if (!fs.existsSync(this.legacyFilePath)) {
            this.setMeta(JSON_MIGRATION_META_KEY, '1');
            return;
        }

        let legacyData;
        try {
            const content = fs.readFileSync(this.legacyFilePath, 'utf-8');
            legacyData = JSON.parse(content);
        } catch (error) {
            console.error('Error loading legacy JSON store; SQLite migration skipped:', error);
            return;
        }

        if (!legacyData || typeof legacyData !== 'object' || Array.isArray(legacyData)) {
            console.error('Legacy JSON store has an invalid structure; SQLite migration skipped.');
            return;
        }

        try {
            this.backupLegacyJson();
            this.replaceAll(legacyData);
            this.setMeta(JSON_MIGRATION_META_KEY, '1');
            console.log(`Migrated legacy JSON store to SQLite: ${this.filePath}`);
        } catch (error) {
            console.error('Error migrating legacy JSON store to SQLite:', error);
        }
    }

    hasValues() {
        return Boolean(this.db.prepare('SELECT 1 FROM store_values LIMIT 1').get());
    }

    backupLegacyJson() {
        if (!fs.existsSync(this.backupFilePath)) {
            fs.copyFileSync(this.legacyFilePath, this.backupFilePath);
        }
    }

    getMeta(key) {
        const row = this.db.prepare('SELECT value FROM store_meta WHERE key = ?').get(key);
        return row ? row.value : null;
    }

    setMeta(key, value) {
        this.db.prepare(`
            INSERT INTO store_meta (key, value)
            VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value
        `).run(key, value);
    }

    runTransaction(callback) {
        this.db.exec('BEGIN IMMEDIATE');
        try {
            const result = callback();
            this.db.exec('COMMIT');
            return result;
        } catch (error) {
            try {
                this.db.exec('ROLLBACK');
            } catch (rollbackError) {
                console.error('Error rolling back SQLite transaction:', rollbackError);
            }
            throw error;
        }
    }

    serializeValue(value) {
        const serialized = JSON.stringify(value);
        if (serialized === undefined) {
            throw new TypeError('Store values must be JSON-serializable');
        }
        return serialized;
    }

    replaceAll(values) {
        const entries = Object.entries(values);
        const serializedEntries = entries.map(([key, value]) => ({
            key,
            value: this.serializeValue(value)
        }));
        const now = Date.now();

        this.runTransaction(() => {
            this.db.exec('DELETE FROM store_values');
            const statement = this.db.prepare(`
                INSERT INTO store_values (key, value, updated_at)
                VALUES (?, ?, ?)
            `);
            serializedEntries.forEach(({ key, value }) => statement.run(key, value, now));
        });

        this.data = { ...values };
    }

    save() {
        this.replaceAll(this.data);
    }

    get(key) {
        return this.data[key];
    }

    set(key, value) {
        const serialized = this.serializeValue(value);
        this.db.prepare(`
            INSERT INTO store_values (key, value, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET
                value = excluded.value,
                updated_at = excluded.updated_at
        `).run(key, serialized, Date.now());
        this.data[key] = value;
    }

    setMany(values) {
        if (!values || typeof values !== 'object' || Array.isArray(values)) {
            return;
        }

        const entries = Object.entries(values).map(([key, value]) => ({
            key,
            value: this.serializeValue(value)
        }));
        const now = Date.now();

        this.runTransaction(() => {
            const statement = this.db.prepare(`
                INSERT INTO store_values (key, value, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(key) DO UPDATE SET
                    value = excluded.value,
                    updated_at = excluded.updated_at
            `);
            entries.forEach(({ key, value }) => statement.run(key, value, now));
        });

        Object.assign(this.data, values);
    }

    delete(key) {
        this.db.prepare('DELETE FROM store_values WHERE key = ?').run(key);
        delete this.data[key];
    }

    clear() {
        this.db.exec('DELETE FROM store_values');
        this.data = {};
    }

    close() {
        if (this.db) {
            this.db.close();
            this.db = null;
        }
    }
}

module.exports = Store;
