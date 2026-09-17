const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const projectDirectory = path.join(__dirname, '..');

function createEventTarget() {
    const listeners = new Map();
    return {
        listeners,
        addEventListener(type, callback) {
            assert.equal(typeof callback, 'function', `Missing ${type} event handler`);
            if (!listeners.has(type)) listeners.set(type, []);
            listeners.get(type).push(callback);
        }
    };
}

// Startup needs named nodes, simple class selectors and generated settings
// buttons. This fixture deliberately provides no layout or browser APIs.
function createStartupDocument(html) {
    const elements = [];
    const document = {
        ...createEventTarget(),
        getElementById: id => elements.find(element => element.id === id) || null,
        querySelector: selector => document.querySelectorAll(selector)[0] || null,
        querySelectorAll(selector) {
            assert.match(selector, /^\.[\w-]+$/, `Unsupported startup selector: ${selector}`);
            return elements.filter(element => element.classList.contains(selector.slice(1)));
        }
    };

    function addElements(markup) {
        for (const [, tagName, sourceAttributes] of markup.matchAll(/<([a-z][\w-]*)\b([^>]*)>/gi)) {
            const attributes = Object.fromEntries(
                [...sourceAttributes.matchAll(/([\w-]+)="([^"]*)"/g)]
                    .map(([, name, value]) => [name, value])
            );
            const classes = new Set((attributes.class || '').split(/\s+/).filter(Boolean));
            let innerHTML = '';
            let value = attributes.value || '';
            const element = {
                ...createEventTarget(),
                id: attributes.id || '',
                tagName: tagName.toUpperCase(),
                dataset: Object.fromEntries(Object.entries(attributes)
                    .filter(([name]) => name.startsWith('data-'))
                    .map(([name, value]) => [name.slice(5), value])),
                get value() { return value; },
                set value(nextValue) { value = String(nextValue); },
                style: {},
                textContent: '',
                classList: {
                    contains: name => classes.has(name),
                    toggle(name, force = !classes.has(name)) {
                        if (force) classes.add(name);
                        else classes.delete(name);
                        return force;
                    },
                    add: (...names) => names.forEach(name => classes.add(name)),
                    remove: (...names) => names.forEach(name => classes.delete(name))
                },
                setAttribute: (name, value) => { attributes[name] = String(value); },
                getAttribute: name => attributes[name] ?? null,
                querySelector: document.querySelector,
                get innerHTML() { return innerHTML; },
                set innerHTML(value) {
                    innerHTML = String(value);
                    addElements(innerHTML);
                }
            };
            elements.push(element);
            if (tagName.toLowerCase() === 'body') document.body = element;
        }
    }

    addElements(html);
    return document;
}

function createGate() {
    let release;
    const promise = new Promise(resolve => { release = resolve; });
    return { promise, release };
}

const nextTurn = () => new Promise(resolve => setImmediate(resolve));

test('index scripts initialize settings and event subscriptions before announcing renderer readiness', async () => {
    const html = fs.readFileSync(path.join(projectDirectory, 'index.html'), 'utf8');
    const document = createStartupDocument(html);
    const calls = [];
    const errors = [];
    const subscriptions = new Map();
    const settingsGate = createGate();
    const recentFilesGate = createGate();
    const animationFrames = [];
    const savedStorage = new Map([
        ['macimage:viewMode', 'grid'],
        ['macimage:sidebarCollapsed', 'true'],
        ['macimage:smallImageThresholdKb', '256']
    ]);

    const subscribe = name => callback => {
        assert.equal(typeof callback, 'function');
        subscriptions.set(name, callback);
        calls.push(name);
    };
    const readSetting = (name, value) => async () => {
        calls.push(name);
        return value;
    };
    const electronAPI = {
        onDirectoryImageMetadata: subscribe('onDirectoryImageMetadata'),
        onServerImageDownloadProgress: subscribe('onServerImageDownloadProgress'),
        onOpenFolder: subscribe('onOpenFolder'),
        onOpenImageFile: subscribe('onOpenImageFile'),
        onTrashFolderChanged: subscribe('onTrashFolderChanged'),
        onUndoDelete: subscribe('onUndoDelete'),
        async getCategories() {
            calls.push('getCategories');
            await settingsGate.promise;
            return null;
        },
        getTags: readSetting('getTags', null),
        saveCategories: readSetting('saveCategories', true),
        saveTags: readSetting('saveTags', true),
        getTrashFolder: readSetting('getTrashFolder', '/trash'),
        getServerDownloadFolder: readSetting('getServerDownloadFolder', '/downloads'),
        getServerDownloadConcurrency: readSetting('getServerDownloadConcurrency', 3),
        getQuickOpenFolders: readSetting('getQuickOpenFolders', [{ name: 'Saved photos', path: '/photos' }]),
        async getRecentOpenFiles() {
            calls.push('getRecentOpenFiles');
            await recentFilesGate.promise;
            return [{ name: 'one.jpg', path: '/photos/one.jpg', folderPath: '/photos', openedAt: 1 }];
        },
        getTrashInfo: readSetting('getTrashInfo', { path: '/trash', count: 0, size: 0 }),
        async rendererReady() {
            calls.push('rendererReady');
            assert.match(document.getElementById('quickFolderSelect').innerHTML, /Saved photos/);
            assert.match(document.getElementById('quickFolderSelect').innerHTML, /one\.jpg/);
            assert.match(document.getElementById('tagFilter').innerHTML, /红心/);
            assert.equal(document.getElementById('openCurrentFolderBtn').disabled, true);
            return true;
        }
    };
    const context = vm.createContext({
        ...createEventTarget(),
        document,
        electronAPI,
        console: { error: (...args) => errors.push(args.map(String).join(' ')) },
        localStorage: {
            getItem: key => savedStorage.get(key) ?? null,
            setItem: (key, value) => savedStorage.set(key, String(value))
        },
        requestAnimationFrame: callback => animationFrames.push(callback)
    });
    context.window = context;

    const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"[^>]*>\s*<\/script>/g)]
        .map(([, source]) => source);
    assert.ok(scripts.length > 0, 'The entry page must load renderer scripts');
    for (const script of scripts) {
        vm.runInContext(fs.readFileSync(path.join(projectDirectory, script), 'utf8'), context, { filename: script });
    }
    await nextTurn();

    assert.deepEqual(errors, []);
    assert.deepEqual([...subscriptions.keys()].sort(), [
        'onDirectoryImageMetadata', 'onOpenFolder', 'onOpenImageFile',
        'onServerImageDownloadProgress', 'onTrashFolderChanged', 'onUndoDelete'
    ]);
    assert.equal(calls.includes('getCategories'), true);
    assert.equal(calls.includes('getTags'), true);
    assert.equal(calls.includes('rendererReady'), false, 'Readiness must await saved settings');

    settingsGate.release();
    await nextTurn();
    assert.deepEqual(errors, []);
    assert.equal(calls.includes('getRecentOpenFiles'), true);
    assert.equal(calls.includes('rendererReady'), false, 'Readiness must await recent-file loading');

    recentFilesGate.release();
    await nextTurn();
    for (const callback of animationFrames) callback();
    assert.deepEqual(errors, []);
    assert.equal(calls.filter(name => name === 'rendererReady').length, 1);
    assert.equal(calls.at(-1), 'rendererReady');
    assert.equal(document.querySelector('.app-container').classList.contains('sidebar-hidden'), true);
    assert.equal(document.querySelectorAll('.view-mode-btn')
        .find(button => button.dataset.view === 'grid').classList.contains('active'), true);
    assert.equal(document.getElementById('serverDownloadConcurrencyInput').value, '3');
    assert.equal(vm.runInContext('smallImageThresholdKb', context), 256);
});
