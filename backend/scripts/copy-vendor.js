// Copies the browser libraries into frontend/vendor The pages used to load these...
const fs     = require('fs');
const path   = require('path');
const crypto = require('crypto');

const BACKEND = path.resolve(__dirname, '..');
const OUT_DIR = path.resolve(BACKEND, '../frontend/vendor');

const LIBS = [
    { pkg: '@zxing/library', file: 'umd/index.min.js',               as: 'zxing-library.min.js',  usedBy: 'POS: camera barcode scanner' },
    { pkg: '@zxing/browser', file: 'umd/zxing-browser.min.js',       as: 'zxing-browser.min.js',  usedBy: 'POS: camera barcode scanner' },
    { pkg: 'jsbarcode',      file: 'dist/JsBarcode.all.min.js',      as: 'JsBarcode.all.min.js',  usedBy: 'Inventory: barcode image' },
    { pkg: 'chart.js',       file: 'dist/chart.umd.js',              as: 'chart.umd.js',          usedBy: 'Dashboard and Forecasting charts' }
];

const LICENSE_NAMES = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license'];

function fail(message) {
    console.error('\n' + message + '\n');
    process.exit(1);
}

fs.mkdirSync(path.join(OUT_DIR, 'licenses'), { recursive: true });

const lines = [
    'Browser libraries hosted by PharmaTrack (copied by backend/scripts/copy-vendor.js).',
    'Do not edit these files by hand: change the version with npm and run "npm run vendor".',
    ''
];

for (const lib of LIBS) {
    const pkgDir = path.join(BACKEND, 'node_modules', ...lib.pkg.split('/'));
    const source = path.join(pkgDir, lib.file);
    if (!fs.existsSync(source)) {
        fail(`Cannot find ${lib.pkg} (${lib.file}). Run "npm install" in the backend folder first.`);
    }

    const version = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8')).version;
    const data    = fs.readFileSync(source);
    const sha384  = crypto.createHash('sha384').update(data).digest('base64');

    fs.writeFileSync(path.join(OUT_DIR, lib.as), data);

    const licenseFile = LICENSE_NAMES.map(n => path.join(pkgDir, n)).find(p => fs.existsSync(p));
    const licenseName = 'licenses/' + lib.as.replace(/\.js$/, '') + '.LICENSE.txt';
    if (licenseFile) {
        fs.copyFileSync(licenseFile, path.join(OUT_DIR, licenseName));
    } else {
        // some packages do not ship their LICENSE file
        const meta   = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
        const author = typeof meta.author === 'string' ? meta.author : ((meta.author && meta.author.name) || '');
        fs.writeFileSync(path.join(OUT_DIR, licenseName), [
            `${meta.name} ${meta.version}`,
            `License: ${meta.license || '(not stated in the package)'}`,
            author ? `Author: ${author}` : '',
            meta.homepage ? `Home: ${meta.homepage}` : '',
            '',
            '(This package does not include a LICENSE file; the details above come from its package.json.)',
            ''
        ].join('\n'));
    }

    console.log(`  ${lib.as.padEnd(24)} ${lib.pkg}@${version}  (${(data.length / 1024).toFixed(0)} KB)`);
    lines.push(`${lib.as}`,
               `  package : ${lib.pkg}@${version}`,
               `  file    : ${lib.file}`,
               `  used by : ${lib.usedBy}`,
               `  sha384  : ${sha384}`,
               `  license : ${licenseName}`,
               '');
}

fs.writeFileSync(path.join(OUT_DIR, 'VERSIONS.txt'), lines.join('\n'));
console.log(`\nDone. Files are in ${OUT_DIR}\nVersions and hashes saved to vendor/VERSIONS.txt`);
