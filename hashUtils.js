const crypto = require('crypto');
const fs = require('fs');

const HASH_CHUNK_SIZE = 64 * 1024;

function calculateFileHash(filePath) {
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
        const bytesRead = fs.readSync(fd, buffer, 0, HASH_CHUNK_SIZE, 0);
        
        const hash = crypto.createHash('md5');
        hash.update(buffer.slice(0, bytesRead));
        return hash.digest('hex');
    } finally {
        fs.closeSync(fd);
    }
}

module.exports = {
    calculateFileHash,
    calculateFileHashSync
};
