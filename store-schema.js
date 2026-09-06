function initializeStoreSchema(db) {
    db.exec(`
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

        CREATE TABLE IF NOT EXISTS image_hashes (
            path TEXT PRIMARY KEY,
            directory TEXT NOT NULL,
            hash TEXT NOT NULL,
            size INTEGER,
            mtime_ms REAL,
            updated_at INTEGER NOT NULL
        );

        CREATE INDEX IF NOT EXISTS image_hashes_directory_idx
            ON image_hashes(directory);
        CREATE INDEX IF NOT EXISTS image_hashes_hash_idx
            ON image_hashes(hash);

        CREATE TABLE IF NOT EXISTS image_tags (
            hash TEXT NOT NULL,
            tag TEXT NOT NULL,
            PRIMARY KEY (hash, tag)
        );

        CREATE INDEX IF NOT EXISTS image_tags_tag_idx
            ON image_tags(tag);

        CREATE TABLE IF NOT EXISTS image_scores (
            hash TEXT PRIMARY KEY,
            rating INTEGER NOT NULL,
            wins INTEGER NOT NULL,
            matches INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS image_hash_migrations (
            hash TEXT PRIMARY KEY,
            legacy_hash TEXT NOT NULL
        );
    `);
}

module.exports = initializeStoreSchema;
