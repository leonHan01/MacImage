const crypto = require('crypto');
const fs = require('fs');

const HASH_CHUNK_SIZE = 64 * 1024;

function calculateFileHash(filePath) {
    return calculateFullFileHash(filePath);
}

// Only used to carry metadata forward from the former 64KB fingerprint.
function calculateLegacyFileHash(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('md5');
        const stream = fs.createReadStream(filePath, { 
            start: 0, 
            end: HASH_CHUNK_SIZE - 1 
        });
        
        stream.on('data', (chunk) => {
            hash.update(chunk);
        });
        
        stream.on('end', () => {
            resolve(hash.digest('hex'));
        });
        
        stream.on('error', (err) => {
            reject(err);
        });
    });
}

function calculateFileHashSync(filePath) {
    const fd = fs.openSync(filePath, 'r');
    try {
        const buffer = Buffer.alloc(HASH_CHUNK_SIZE);
        const hash = crypto.createHash('sha256');
        let bytesRead;
        while ((bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
            hash.update(buffer.subarray(0, bytesRead));
        }
        return hash.digest('hex');
    } finally {
        fs.closeSync(fd);
    }
}

function calculateLegacyFileHashSync(filePath) {
    const fd = fs.openSync(filePath, 'r');
    try {
        const buffer = Buffer.alloc(HASH_CHUNK_SIZE);
        const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
        return crypto.createHash('md5').update(buffer.subarray(0, bytesRead)).digest('hex');
    } finally {
        fs.closeSync(fd);
    }
}

function calculateFullFileHash(filePath) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        const stream = fs.createReadStream(filePath);

        stream.on('data', (chunk) => {
            hash.update(chunk);
        });

        stream.on('end', () => {
            resolve(hash.digest('hex'));
        });

        stream.on('error', reject);
    });
}

module.exports = {
    calculateFileHash,
    calculateFileHashSync,
    calculateFullFileHash,
    calculateLegacyFileHash,
    calculateLegacyFileHashSync
};
