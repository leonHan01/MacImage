const fs = require('fs');
const path = require('path');

class Store {
    constructor(filePath) {
        this.filePath = filePath;
        this.data = this.load();
    }

    load() {
        try {
            if (fs.existsSync(this.filePath)) {
                const content = fs.readFileSync(this.filePath, 'utf-8');
                return JSON.parse(content);
            }
        } catch (error) {
            console.error('Error loading store:', error);
        }
        return {};
    }

    save() {
        try {
            const dir = path.dirname(this.filePath);
            if (!fs.existsSync(dir)) {
                fs.mkdirSync(dir, { recursive: true });
            }
            fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8');
        } catch (error) {
            console.error('Error saving store:', error);
        }
    }

    get(key) {
        return this.data[key];
    }

    set(key, value) {
        this.data[key] = value;
        this.save();
    }

    delete(key) {
        delete this.data[key];
        this.save();
    }

    clear() {
        this.data = {};
        this.save();
    }
}

module.exports = Store;
