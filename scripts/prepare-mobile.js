#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const SRC_CORE_DIR = path.join(ROOT_DIR, 'src', 'core');
const NODEJS_DIR = path.join(ROOT_DIR, 'nodejs');
const NODEJS_CORE_DIR = path.join(NODEJS_DIR, 'src', 'core');
const NODEJS_MODULES_DIR = path.join(NODEJS_DIR, 'node_modules');
const WWW_DIR = path.join(ROOT_DIR, 'www');
const ANDROID_MAIN_DIR = path.join(ROOT_DIR, 'android', 'app', 'src', 'main');
const ANDROID_RES_DIR = path.join(ANDROID_MAIN_DIR, 'res');
const ANDROID_BUILTIN_BRIDGE_DIR = path.join(ANDROID_MAIN_DIR, 'assets', 'builtin_modules', 'bridge');
const IOS_BRIDGE_INDEX_FILE = path.join(
  ROOT_DIR,
  'node_modules',
  '@capawesome',
  'capacitor-nodejs',
  'ios',
  'Plugin',
  'Assets',
  'builtin_modules',
  'bridge',
  'index.js'
);
const ANDROID_ICON_RES_DIR = path.join(ROOT_DIR, 'assets', 'icons', 'android', 'res');

const ROOT_PROD_DEPS = ['alexa-remote2'];
const FORBIDDEN_FILENAMES = new Set(['alexa-cookie.json', 'alexa-cookie.json.bak']);

function copyDirRecursive(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

function resolvePackageDir(pkgName, fromDir) {
  let cur = fromDir;
  while (true) {
    const candidate = path.join(cur, 'node_modules', pkgName);
    if (fs.existsSync(path.join(candidate, 'package.json'))) {
      return candidate;
    }
    const parent = path.dirname(cur);
    if (parent === cur || cur === ROOT_DIR) break;
    cur = parent;
  }
  const rootCandidate = path.join(ROOT_DIR, 'node_modules', pkgName);
  if (fs.existsSync(path.join(rootCandidate, 'package.json'))) {
    return rootCandidate;
  }
  return null;
}

function collectProdPackages(startNames) {
  const visited = new Map();
  const queue = startNames.map((name) => ({ name, fromDir: ROOT_DIR }));

  while (queue.length > 0) {
    const { name, fromDir } = queue.shift();
    if (name.startsWith('@capacitor/')) continue;
    const pkgDir = resolvePackageDir(name, fromDir);
    if (!pkgDir) continue;
    const realDir = fs.realpathSync(pkgDir);
    if (visited.has(name)) continue;

    const pkgJson = JSON.parse(fs.readFileSync(path.join(realDir, 'package.json'), 'utf8'));
    visited.set(name, realDir);

    const deps = pkgJson.dependencies && typeof pkgJson.dependencies === 'object'
      ? Object.keys(pkgJson.dependencies)
      : [];
    for (const dep of deps) {
      if (!visited.has(dep)) {
        queue.push({ name: dep, fromDir: realDir });
      }
    }
  }
  return visited;
}

function assertNoSecrets(dir) {
  if (!fs.existsSync(dir)) return;
  const found = [];
  function walk(cur) {
    const entries = fs.readdirSync(cur, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(cur, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (FORBIDDEN_FILENAMES.has(entry.name) || entry.name.endsWith('.bak')) {
        found.push(fullPath);
        fs.unlinkSync(fullPath);
      }
    }
  }
  walk(dir);
  if (found.length > 0) {
    throw new Error(`機密ファイルを検出したため削除して中断しました: ${found.join(', ')}`);
  }
}

function syncCoreFiles() {
  fs.rmSync(NODEJS_CORE_DIR, { recursive: true, force: true });
  fs.mkdirSync(NODEJS_CORE_DIR, { recursive: true });
  const files = fs.readdirSync(SRC_CORE_DIR).filter((f) => f.endsWith('.js'));
  for (const f of files) {
    fs.copyFileSync(path.join(SRC_CORE_DIR, f), path.join(NODEJS_CORE_DIR, f));
  }
  return files.length;
}

function syncNodeModules() {
  const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'package.json'), 'utf8'));
  const alexaVersion = (rootPkg.dependencies && rootPkg.dependencies['alexa-remote2']) || '^8.1.1';
  const mobilePkg = {
    name: 'alexa-alarm-mobile-backend',
    version: '1.0.0',
    private: true,
    main: 'index.js',
    dependencies: {
      'alexa-remote2': alexaVersion,
    },
  };
  fs.writeFileSync(path.join(NODEJS_DIR, 'package.json'), `${JSON.stringify(mobilePkg, null, 2)}\n`, 'utf8');

  fs.rmSync(NODEJS_MODULES_DIR, { recursive: true, force: true });
  fs.mkdirSync(NODEJS_MODULES_DIR, { recursive: true });

  const packages = collectProdPackages(ROOT_PROD_DEPS);
  for (const [pkgName, srcPath] of packages.entries()) {
    const destPath = path.join(NODEJS_MODULES_DIR, pkgName);
    copyDirRecursive(srcPath, destPath);
  }
  return packages.size;
}

function syncAndroidIcons() {
  if (!fs.existsSync(ANDROID_RES_DIR) || !fs.existsSync(ANDROID_ICON_RES_DIR)) {
    return 0;
  }

  // Remove Capacitor template adaptive icon XMLs so mipmap-*/ic_launcher.png takes effect on API 26+
  fs.rmSync(path.join(ANDROID_RES_DIR, 'mipmap-anydpi-v26'), { recursive: true, force: true });
  fs.rmSync(path.join(ANDROID_RES_DIR, 'drawable', 'ic_launcher_background.xml'), { force: true });
  fs.rmSync(path.join(ANDROID_RES_DIR, 'drawable-v24', 'ic_launcher_foreground.xml'), { force: true });

  const existingResEntries = fs.readdirSync(ANDROID_RES_DIR, { withFileTypes: true });
  for (const entry of existingResEntries) {
    if (entry.isDirectory() && entry.name.startsWith('mipmap-')) {
      fs.rmSync(path.join(ANDROID_RES_DIR, entry.name, 'ic_launcher_foreground.png'), { force: true });
    }
  }

  let copied = 0;
  const mipmaps = fs.readdirSync(ANDROID_ICON_RES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith('mipmap-'));
  for (const dir of mipmaps) {
    const srcIcon = path.join(ANDROID_ICON_RES_DIR, dir.name, 'ic_launcher.png');
    if (!fs.existsSync(srcIcon)) continue;
    const destDir = path.join(ANDROID_RES_DIR, dir.name);
    fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(srcIcon, path.join(destDir, 'ic_launcher.png'));
    fs.copyFileSync(srcIcon, path.join(destDir, 'ic_launcher_round.png'));
    copied += 2;
  }
  return copied;
}

function syncWwwNodejs() {
  const wwwNodejsDir = path.join(WWW_DIR, 'nodejs');
  fs.rmSync(wwwNodejsDir, { recursive: true, force: true });
  fs.mkdirSync(wwwNodejsDir, { recursive: true });

  for (const fileName of ['index.js', 'server.js', 'package.json']) {
    const srcFile = path.join(NODEJS_DIR, fileName);
    if (fs.existsSync(srcFile)) {
      fs.copyFileSync(srcFile, path.join(wwwNodejsDir, fileName));
    }
  }
  if (fs.existsSync(NODEJS_CORE_DIR)) {
    copyDirRecursive(NODEJS_CORE_DIR, path.join(wwwNodejsDir, 'src', 'core'));
  }
  if (fs.existsSync(NODEJS_MODULES_DIR)) {
    copyDirRecursive(NODEJS_MODULES_DIR, path.join(wwwNodejsDir, 'node_modules'));
  }
}

function syncBuiltinModules() {
  if (!fs.existsSync(IOS_BRIDGE_INDEX_FILE)) {
    throw new Error(`bridge/index.js が見つかりません: ${IOS_BRIDGE_INDEX_FILE}`);
  }
  const bridgeIndexSrc = fs.readFileSync(IOS_BRIDGE_INDEX_FILE, 'utf8');
  const bridgePkgJson = `${JSON.stringify({
    name: 'bridge',
    version: '1.0.0',
    main: 'index.js',
  }, null, 2)}\n`;

  const targets = [path.join(NODEJS_MODULES_DIR, 'bridge')];
  if (fs.existsSync(ANDROID_MAIN_DIR)) {
    targets.push(ANDROID_BUILTIN_BRIDGE_DIR);
  }

  for (const targetDir of targets) {
    fs.rmSync(targetDir, { recursive: true, force: true });
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(path.join(targetDir, 'package.json'), bridgePkgJson, 'utf8');
    fs.writeFileSync(path.join(targetDir, 'index.js'), bridgeIndexSrc, 'utf8');
  }
  return targets.length;
}

function runPrepare() {
  const coreCount = syncCoreFiles();
  const pkgCount = syncNodeModules();
  const bridgeCount = syncBuiltinModules();
  syncWwwNodejs();
  const iconCount = syncAndroidIcons();
  assertNoSecrets(NODEJS_DIR);
  assertNoSecrets(WWW_DIR);
  console.log(`[prepare-mobile] core=${coreCount} files, node_modules=${pkgCount} packages, bridge=${bridgeCount}, icons=${iconCount} files`);
  return { coreCount, pkgCount, bridgeCount, iconCount };
}

if (require.main === module) {
  runPrepare();
}

module.exports = {
  assertNoSecrets,
  collectProdPackages,
  runPrepare,
};
