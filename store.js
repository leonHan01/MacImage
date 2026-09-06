const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const ratingModel = require('./rating-model');
const initializeStoreSchema = require('./store-schema');

const JSON_MIGRATION_META_KEY = 'json_config_migrated';
const IMAGE_METADATA_MIGRATION_META_KEY = 'image_metadata_tables_migrated_v1';
const IMAGE_METADATA_KEYS = ['pathToHash', 'imageTagsByHash', 'imageScoresByHash'];
const METADATA_QUERY_BATCH_SIZE = 500;

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
        initializeStoreSchema(this.db);

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
        this.migrateImageMetadataIfNeeded();
    }

    migrateImageMetadataIfNeeded() {
        if (this.getMeta(IMAGE_METADATA_MIGRATION_META_KEY)) {
            return;
        }

        const pathHashEntries = normalizePathHashEntries(this.data.pathToHash);
        const imageTagsByHash = isPlainObject(this.data.imageTagsByHash) ? this.data.imageTagsByHash : {};
        const imageScoresByHash = isPlainObject(this.data.imageScoresByHash) ? this.data.imageScoresByHash : {};
        const now = Date.now();

        this.runTransaction(() => {
            upsertPathHashes(this.db, pathHashEntries, now);
            insertLegacyImageTags(this.db, imageTagsByHash);
            upsertImageScores(this.db, Object.entries(imageScoresByHash), now);

            const deleteLegacyValue = this.db.prepare('DELETE FROM store_values WHERE key = ?');
            IMAGE_METADATA_KEYS.forEach(key => deleteLegacyValue.run(key));
            this.setMeta(IMAGE_METADATA_MIGRATION_META_KEY, '1');
        });

        IMAGE_METADATA_KEYS.forEach(key => delete this.data[key]);
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
            upsertStoreValues(this.db, serializedEntries, now);
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
        assertGenericStoreKey(key);
        const serialized = this.serializeValue(value);
        upsertStoreValues(this.db, [{ key, value: serialized }], Date.now());
        this.data[key] = value;
    }

    update(key, updater) {
        assertGenericStoreKey(key);
        if (typeof updater !== 'function') {
            throw new TypeError('Store updater must be a function');
        }

        const nextValue = updater(this.get(key));
        this.set(key, nextValue);
        return nextValue;
    }

    setMany(values) {
        if (!values || typeof values !== 'object' || Array.isArray(values)) {
            return;
        }

        const entries = Object.entries(values).map(([key, value]) => {
            assertGenericStoreKey(key);
            return {
                key,
                value: this.serializeValue(value)
            };
        });
        const now = Date.now();

        this.runTransaction(() => {
            upsertStoreValues(this.db, entries, now);
        });

        Object.assign(this.data, values);
    }

    getPathHash(imagePath) {
        if (typeof imagePath !== 'string' || !imagePath) return null;
        const row = this.db.prepare(`
            SELECT hash, size, mtime_ms AS mtimeMs
            FROM image_hashes
            WHERE path = ?
        `).get(imagePath);
        return row ? normalizeHashEntry(row) : null;
    }

    getPathHashesForDirectory(directory) {
        if (typeof directory !== 'string' || !directory) return {};
        const rows = this.db.prepare(`
            SELECT path, hash, size, mtime_ms AS mtimeMs
            FROM image_hashes
            WHERE directory = ?
        `).all(directory);
        return Object.fromEntries(rows.map(row => [row.path, normalizeHashEntry(row)]));
    }

    setPathHash(imagePath, value) {
        this.setPathHashes({ [imagePath]: value });
    }

    setPathHashes(values) {
        const entries = normalizePathHashEntries(values);
        if (entries.length === 0) return;

        const now = Date.now();
        this.runTransaction(() => {
            upsertPathHashes(this.db, entries, now);
        });
    }

    movePathHashes(moves) {
        const validMoves = (Array.isArray(moves) ? moves : []).filter(move => (
            move && typeof move.fromPath === 'string' && move.fromPath &&
            typeof move.toPath === 'string' && move.toPath
        ));
        if (validMoves.length === 0) return;

        const now = Date.now();
        this.runTransaction(() => {
            const select = this.db.prepare('SELECT hash, size, mtime_ms AS mtimeMs FROM image_hashes WHERE path = ?');
            const remove = this.db.prepare('DELETE FROM image_hashes WHERE path = ?');
            const insert = preparePathHashUpsert(this.db);
            validMoves.forEach(({ fromPath, toPath }) => {
                const entry = select.get(fromPath);
                if (!entry) return;
                remove.run(fromPath);
                writePathHash(insert, toPath, entry, now);
            });
        });
    }

    getImageTags(hash) {
        if (typeof hash !== 'string' || !hash) return [];
        return this.db.prepare(`
            SELECT tag FROM image_tags WHERE hash = ? ORDER BY tag
        `).all(hash).map(row => row.tag);
    }

    migrateImageMetadata(legacyHash, hash) {
        if (!/^[a-f0-9]{32}$/.test(legacyHash) || !/^[a-f0-9]{64}$/.test(hash)) return;
        if (this.db.prepare('SELECT 1 FROM image_hash_migrations WHERE hash = ?').get(hash)) return;

        // Keep the old records for files not encountered yet. Remember each
        // destination so opening a second copy cannot resurrect deleted tags.
        this.runTransaction(() => {
            this.db.prepare('INSERT INTO image_hash_migrations (hash, legacy_hash) VALUES (?, ?)')
                .run(hash, legacyHash);
            this.db.prepare(`
                INSERT OR IGNORE INTO image_tags (hash, tag)
                SELECT ?, tag FROM image_tags WHERE hash = ?
            `).run(hash, legacyHash);
            this.db.prepare(`
                INSERT OR IGNORE INTO image_scores (hash, rating, wins, matches, updated_at)
                SELECT ?, rating, wins, matches, updated_at FROM image_scores WHERE hash = ?
            `).run(hash, legacyHash);
        });
    }

    addImageTag(hash, tag) {
        if (typeof hash !== 'string' || !hash || typeof tag !== 'string' || !tag) {
            return this.getImageTags(hash);
        }
        this.db.prepare('INSERT OR IGNORE INTO image_tags (hash, tag) VALUES (?, ?)').run(hash, tag);
        return this.getImageTags(hash);
    }

    removeImageTag(hash, tag) {
        if (typeof hash === 'string' && hash && typeof tag === 'string' && tag) {
            this.db.prepare('DELETE FROM image_tags WHERE hash = ? AND tag = ?').run(hash, tag);
        }
        return this.getImageTags(hash);
    }

    removeTagFromAllImages(tag) {
        if (typeof tag !== 'string' || !tag) return 0;
        return Number(this.db.prepare('DELETE FROM image_tags WHERE tag = ?').run(tag).changes) || 0;
    }

    renameTagAcrossAllImages(currentTag, nextTag) {
        if (typeof currentTag !== 'string' || !currentTag || typeof nextTag !== 'string' || !nextTag) {
            return 0;
        }
        if (currentTag === nextTag) {
            return Number(this.db.prepare('SELECT COUNT(*) AS count FROM image_tags WHERE tag = ?').get(currentTag)?.count) || 0;
        }

        const affectedCount = Number(this.db.prepare('SELECT COUNT(*) AS count FROM image_tags WHERE tag = ?').get(currentTag)?.count) || 0;
        this.runTransaction(() => {
            this.db.prepare(`
                INSERT OR IGNORE INTO image_tags (hash, tag)
                SELECT hash, ? FROM image_tags WHERE tag = ?
            `).run(nextTag, currentTag);
            this.db.prepare('DELETE FROM image_tags WHERE tag = ?').run(currentTag);
        });
        return affectedCount;
    }

    getImageScore(hash) {
        if (typeof hash !== 'string' || !hash) return null;
        const row = this.db.prepare(`
            SELECT rating, wins, matches FROM image_scores WHERE hash = ?
        `).get(hash);
        return row ? ratingModel.normalize(row) : null;
    }

    getImageMetadata(hash) {
        return {
            tags: this.getImageTags(hash),
            score: this.getImageScore(hash)
        };
    }

    getImageMetadataForHashes(hashes) {
        const uniqueHashes = [...new Set((Array.isArray(hashes) ? hashes : [])
            .filter(hash => typeof hash === 'string' && hash))];
        const metadata = Object.fromEntries(uniqueHashes.map(hash => [hash, { tags: [], score: null }]));

        for (let offset = 0; offset < uniqueHashes.length; offset += METADATA_QUERY_BATCH_SIZE) {
            const chunk = uniqueHashes.slice(offset, offset + METADATA_QUERY_BATCH_SIZE);
            const placeholders = chunk.map(() => '?').join(', ');
            this.db.prepare(`
                SELECT hash, tag FROM image_tags
                WHERE hash IN (${placeholders})
                ORDER BY tag
            `).all(...chunk).forEach((row) => metadata[row.hash].tags.push(row.tag));
            this.db.prepare(`
                SELECT hash, rating, wins, matches FROM image_scores
                WHERE hash IN (${placeholders})
            `).all(...chunk).forEach((row) => {
                metadata[row.hash].score = ratingModel.normalize(row);
            });
        }
        return metadata;
    }

    setImageScores(values) {
        if (!isPlainObject(values)) return;
        const entries = Object.entries(values).filter(([hash]) => hash);
        if (entries.length === 0) return;
        const now = Date.now();
        this.runTransaction(() => {
            upsertImageScores(this.db, entries, now);
        });
    }

    replaceImageScores(values) {
        const nextScores = isPlainObject(values) ? values : {};
        this.runTransaction(() => {
            this.db.exec('DELETE FROM image_scores');
            const now = Date.now();
            upsertImageScores(this.db, Object.entries(nextScores), now);
            // Old backups use the prefix fingerprint. Full-hash records in
            // the same backup take precedence over their legacy counterparts.
            this.db.prepare(`
                INSERT OR IGNORE INTO image_scores (hash, rating, wins, matches, updated_at)
                SELECT migration.hash, score.rating, score.wins, score.matches, score.updated_at
                FROM image_hash_migrations AS migration
                JOIN image_scores AS score ON score.hash = migration.legacy_hash
            `).run();
        });
    }

    getAllImageScores() {
        const rows = this.db.prepare('SELECT hash, rating, wins, matches FROM image_scores').all();
        return Object.fromEntries(rows.map(row => [row.hash, ratingModel.normalize(row)]));
    }

    delete(key) {
        this.db.prepare('DELETE FROM store_values WHERE key = ?').run(key);
        delete this.data[key];
    }

    clear() {
        this.runTransaction(() => {
            this.db.exec(`
                DELETE FROM store_values;
                DELETE FROM image_hashes;
                DELETE FROM image_tags;
                DELETE FROM image_scores;
                DELETE FROM image_hash_migrations;
            `);
        });
        this.data = {};
    }

    close() {
        if (this.db) {
            this.db.close();
            this.db = null;
        }
    }
}

// These writers share SQL and normalization; callers own the transaction so
// migrations and replacements commit their writes and deletions together.
function upsertStoreValues(db, entries, updatedAt) {
    const statement = db.prepare(`
        INSERT INTO store_values (key, value, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET
            value = excluded.value,
            updated_at = excluded.updated_at
    `);
    entries.forEach(({ key, value }) => statement.run(key, value, updatedAt));
}

function preparePathHashUpsert(db) {
    return db.prepare(`
        INSERT INTO image_hashes (path, directory, hash, size, mtime_ms, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(path) DO UPDATE SET
            directory = excluded.directory,
            hash = excluded.hash,
            size = excluded.size,
            mtime_ms = excluded.mtime_ms,
            updated_at = excluded.updated_at
    `);
}

function writePathHash(statement, imagePath, entry, updatedAt) {
    statement.run(imagePath, path.dirname(imagePath), entry.hash, entry.size, entry.mtimeMs, updatedAt);
}

function upsertPathHashes(db, entries, updatedAt) {
    const statement = preparePathHashUpsert(db);
    entries.forEach(({ imagePath, entry }) => writePathHash(statement, imagePath, entry, updatedAt));
}

function upsertImageScores(db, entries, updatedAt) {
    const statement = db.prepare(`
        INSERT INTO image_scores (hash, rating, wins, matches, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(hash) DO UPDATE SET
            rating = excluded.rating,
            wins = excluded.wins,
            matches = excluded.matches,
            updated_at = excluded.updated_at
    `);
    entries.forEach(([hash, value]) => {
        if (!hash) return;
        const score = ratingModel.normalize(value);
        statement.run(hash, score.rating, score.wins, score.matches, updatedAt);
    });
}

function insertLegacyImageTags(db, tagsByHash) {
    const statement = db.prepare('INSERT OR IGNORE INTO image_tags (hash, tag) VALUES (?, ?)');
    Object.entries(tagsByHash).forEach(([hash, tags]) => {
        if (!hash || !Array.isArray(tags)) return;
        tags.forEach(tag => {
            if (typeof tag === 'string' && tag) statement.run(hash, tag);
        });
    });
}

function normalizePathHashEntries(values) {
    if (!isPlainObject(values)) return [];
    return Object.entries(values)
        .map(([imagePath, value]) => ({ imagePath, entry: normalizeHashEntry(value) }))
        .filter(({ imagePath, entry }) => imagePath && entry);
}

function isPlainObject(value) {
    return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function assertGenericStoreKey(key) {
    if (IMAGE_METADATA_KEYS.includes(key)) {
        throw new Error(`Image metadata key "${key}" must use the normalized metadata APIs`);
    }
}

function normalizeHashEntry(value) {
    if (typeof value === 'string' && value) {
        return { hash: value, size: null, mtimeMs: null };
    }
    if (!isPlainObject(value) || typeof value.hash !== 'string' || !value.hash) {
        return null;
    }
    return {
        hash: value.hash,
        size: Number.isFinite(value.size) ? value.size : null,
        mtimeMs: Number.isFinite(value.mtimeMs) ? value.mtimeMs : null
    };
}

module.exports = Store;
