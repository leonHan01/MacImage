const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const projectRoot = path.resolve(__dirname, '..');
const destinationDir = path.join(projectRoot, 'dist');
const temporaryOutputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'macimage-build-'));
const electronBuilderCli = require.resolve('electron-builder/out/cli/cli.js');

try {
    const result = spawnSync(process.execPath, [
        electronBuilderCli,
        '--mac',
        'dmg',
        `--config.directories.output=${temporaryOutputDir}`
    ], {
        cwd: projectRoot,
        env: process.env,
        stdio: 'inherit'
    });

    if (result.error) throw result.error;
    if (result.status !== 0) {
        throw new Error(`electron-builder exited with status ${result.status}`);
    }

    const artifacts = fs.readdirSync(temporaryOutputDir)
        .filter(fileName => fileName.endsWith('.dmg') || fileName.endsWith('.dmg.blockmap'));
    if (!artifacts.some(fileName => fileName.endsWith('.dmg'))) {
        throw new Error('electron-builder did not produce a DMG artifact');
    }

    fs.mkdirSync(destinationDir, { recursive: true });
    artifacts.forEach((fileName) => {
        const destinationPath = path.join(destinationDir, fileName);
        fs.copyFileSync(path.join(temporaryOutputDir, fileName), destinationPath);
        console.log(`Copied ${destinationPath}`);
    });
} finally {
    fs.rmSync(temporaryOutputDir, { recursive: true, force: true });
}
