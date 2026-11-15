#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const vm = require('vm');
const { spawnSync } = require('child_process');

const hash = (value) => crypto.createHash('sha256').update(value).digest('hex');
const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

function optionsFrom(args) {
  const options = {
    check: false,
    extensionsDir: path.join(os.homedir(), '.vscode/extensions'),
    backupDir: path.join(os.homedir(), '.codex-ui-backups'),
    code: '/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code',
  };
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--check') options.check = true;
    else if (['--extensions-dir', '--backup-dir', '--code'].includes(arg)) {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`Не задано значение ${arg}.`);
      options[{ '--extensions-dir': 'extensionsDir', '--backup-dir': 'backupDir', '--code': 'code' }[arg]] = path.resolve(value);
    } else throw new Error(`Неизвестный параметр: ${arg}`);
  }
  return options;
}

function registeredExtension(root, id) {
  const registry = path.join(root, 'extensions.json');
  const entries = fs.existsSync(registry) ? readJson(registry).filter((item) => item.identifier?.id === id) : [];
  if (entries.length !== 1) return null;
  const entry = entries[0];
  const location = entry.location?.path || path.join(root, entry.relativeLocation || '');
  return { entry, location };
}

function checkRelease(bundleDir) {
  const current = readJson(path.join(bundleDir, 'bundle.json'));
  if (!/^\d+\.\d+(?:\.\d+)?$/.test(current.release) || !/^\d+\.\d+\.\d+$/.test(current.uiVersion)) throw new Error('Некорректная версия комплекта.');
  const releaseDir = path.join(bundleDir, 'releases', current.release);
  const checksums = readJson(path.join(releaseDir, 'checksums.json'));
  for (const [relative, checksum] of Object.entries(checksums)) {
    const file = path.resolve(releaseDir, relative);
    if (!file.startsWith(`${releaseDir}${path.sep}`) || hash(fs.readFileSync(file)) !== checksum) {
      throw new Error(`Файл комплекта повреждён или изменён: ${relative}.`);
    }
  }
  const release = readJson(path.join(releaseDir, 'release.json'));
  if (release.uiVersion !== current.uiVersion || readJson(path.join(releaseDir, 'src/package.json')).version !== current.uiVersion) throw new Error('Версии комплекта не совпали.');
  return { releaseDir, release };
}

function companionMatches(root, releaseDir, release) {
  const installed = registeredExtension(root, release.uiId);
  if (!installed || installed.entry.version !== release.uiVersion) return false;
  const obsoletePath = path.join(root, '.obsolete');
  const obsolete = fs.existsSync(obsoletePath) ? readJson(obsoletePath) : {};
  if (obsolete[path.basename(installed.location)]) return false;
  try {
    for (const name of ['extension.js', 'account-view.js', 'patch-openai-extension.js', 'README.md']) {
      if (hash(fs.readFileSync(path.join(installed.location, name))) !== hash(fs.readFileSync(path.join(releaseDir, 'src', name)))) return false;
    }
    const actual = readJson(path.join(installed.location, 'package.json'));
    delete actual.__metadata;
    return JSON.stringify(actual) === JSON.stringify(readJson(path.join(releaseDir, 'src/package.json')));
  } catch {
    return false;
  }
}

function prepare(bundleDir, options) {
  const { releaseDir, release } = checkRelease(bundleDir);
  const native = registeredExtension(options.extensionsDir, release.nativeId);
  if (!native) throw new Error('Установленное расширение OpenAI Codex не найдено. Сначала установите его в VS Code.');
  const packagePath = path.join(native.location, 'package.json');
  const extensionPath = path.join(native.location, 'out/extension.js');
  const originalPackage = fs.readFileSync(packagePath);
  const originalExtension = fs.readFileSync(extensionPath);
  const manifest = JSON.parse(originalPackage.toString('utf8'));
  if (manifest.name !== 'chatgpt' || manifest.publisher !== 'openai' || manifest.version !== release.nativeVersion) {
    throw new Error(`Установлен Codex ${manifest.version}; комплект проверен с ${release.nativeVersion}. Нужна адаптация патча к новой версии. Исходники UI сохранены в ${path.join(releaseDir, 'src')}. Файлы не изменены.`);
  }
  if (!release.nativeSourceHashes.includes(hash(originalExtension))) {
    throw new Error('Файлы Codex отличаются от проверенных сборок. Патч не применён; сохранённый UI не повреждён.');
  }
  const patcher = require(path.join(releaseDir, 'src/patch-openai-extension.js'));
  const transformed = patcher.transformExtension(originalExtension.toString('utf8')).source;
  new vm.Script(transformed, { filename: extensionPath });
  const views = Object.values(manifest.contributes?.views || {}).flat().filter((view) => ['chatgpt.sidebarView', 'chatgpt.sidebarSecondaryView'].includes(view.id));
  if (views.length !== 2 || views.some((view) => typeof view.when !== 'string')) throw new Error('Структура панели Codex изменилась. Файлы не изменены.');
  for (const view of views) {
    if (!view.when.includes('!config.codexHistory.enabled')) view.when = `(${view.when}) && !config.codexHistory.enabled`;
  }
  const nextPackage = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const nextExtension = Buffer.from(transformed);
  const installCompanion = !companionMatches(options.extensionsDir, releaseDir, release);
  if (!options.check && installCompanion) fs.accessSync(options.code, fs.constants.X_OK);
  return {
    releaseDir, release, native, packagePath, extensionPath,
    originalPackage, originalExtension, nextPackage, nextExtension,
    installCompanion,
    patchEditor: !originalExtension.equals(nextExtension),
    patchSidebar: !originalPackage.equals(nextPackage),
  };
}

function atomicWrite(file, bytes) {
  const temporary = `${file}.codex-ui-${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, bytes, { mode: fs.statSync(file).mode });
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

function restore(bundleDir, options) {
  const plan = prepare(bundleDir, options);
  const summary = {
    uiVersion: plan.release.uiVersion,
    codexVersion: plan.release.nativeVersion,
    installCompanion: plan.installCompanion,
    restoreEditorPatch: plan.patchEditor,
    restoreSidebar: plan.patchSidebar,
  };
  console.log(JSON.stringify(summary, null, 2));
  if (options.check) {
    console.log('Проверка завершена. Файлы не изменены.');
    return { ...summary, changed: false };
  }
  if (!plan.installCompanion && !plan.patchEditor && !plan.patchSidebar) {
    console.log('Сборка UI уже установлена и соответствует сохранённой версии.');
    return { ...summary, changed: false };
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(options.backupDir, `ui-restore-${stamp}`);
  fs.mkdirSync(path.join(backup, 'native/out'), { recursive: true });
  fs.writeFileSync(path.join(backup, 'native/package.json'), plan.originalPackage);
  fs.writeFileSync(path.join(backup, 'native/out/extension.js'), plan.originalExtension);
  for (const name of ['extensions.json', '.obsolete']) {
    const file = path.join(options.extensionsDir, name);
    if (fs.existsSync(file)) fs.copyFileSync(file, path.join(backup, name));
  }
  const previousCompanion = registeredExtension(options.extensionsDir, plan.release.uiId);
  if (previousCompanion && fs.existsSync(previousCompanion.location)) fs.cpSync(previousCompanion.location, path.join(backup, 'companion'), { recursive: true });
  fs.writeFileSync(path.join(backup, 'restore.json'), `${JSON.stringify({ ...summary, nativeTarget: plan.native.location }, null, 2)}\n`);
  if (plan.installCompanion) {
    const result = spawnSync(options.code, ['--extensions-dir', options.extensionsDir, '--install-extension', path.join(plan.releaseDir, plan.release.vsix), '--force'], { encoding: 'utf8', shell: false });
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.status !== 0 || result.error) throw new Error(`VS Code не установил надстройку. Патч редактора не изменён. Резервная копия: ${backup}`);
    if (!companionMatches(options.extensionsDir, plan.releaseDir, plan.release)) throw new Error(`Проверка установки надстройки не прошла. Патч редактора не изменён. Копия: ${backup}`);
  }
  if (!fs.readFileSync(plan.extensionPath).equals(plan.originalExtension) || !fs.readFileSync(plan.packagePath).equals(plan.originalPackage)) {
    throw new Error('Codex изменился во время установки, возможно из-за обновления. Патч редактора не применён. Запустите восстановление ещё раз.');
  }
  try {
    if (plan.patchEditor) atomicWrite(plan.extensionPath, plan.nextExtension);
    if (plan.patchSidebar) atomicWrite(plan.packagePath, plan.nextPackage);
  } catch (error) {
    atomicWrite(plan.extensionPath, plan.originalExtension);
    atomicWrite(plan.packagePath, plan.originalPackage);
    throw error;
  }
  if (!fs.readFileSync(plan.extensionPath).equals(plan.nextExtension) || !fs.readFileSync(plan.packagePath).equals(plan.nextPackage)) throw new Error(`Проверка патча не прошла. Резервная копия: ${backup}`);
  console.log(`Сборка восстановлена. Резервная копия: ${backup}`);
  console.log('В VS Code выполните Cmd+Shift+P → Developer: Reload Window.');
  return { ...summary, changed: true, backupDir: backup };
}

if (require.main === module) {
  try {
    restore(__dirname, optionsFrom(process.argv.slice(2)));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { restore, prepare, optionsFrom };
