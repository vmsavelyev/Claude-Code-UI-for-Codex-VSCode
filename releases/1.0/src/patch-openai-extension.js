'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const SUPPORTED_VERSION = '26.1111.21308';
const SUPPORTED_EXTENSION_SHA256 = 'aa93a1b5aaa79746f3b583133355c659a0f059ff98d1956adf9da0e4afbcf817';
const SUPPORTED_UI_PATCH_SHA256 = '1a22dcb75c6efdfa7fcd44745902c405e9902b25f210cf0893c03a8eb9a3d767';
const PATCH_MARKER = 'codex_ui_patch_v1';
const ACTIVITY_MARKER = 'codex_ui_activity_v1';

function sha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function replaceOnce(source, pattern, replacement, label) {
  const matches = source.match(pattern);
  if (!matches || matches.length !== 1) throw new Error(`Не найден ожидаемый фрагмент «${label}». Патч остановлен без изменений.`);
  return source.replace(pattern, replacement);
}

function publishNativeActivity(message) {
  if (message?.method !== 'thread/status/changed') return;
  const { threadId, status } = message.params || {};
  if (typeof threadId !== 'string' || !threadId || !['active', 'idle', 'notLoaded', 'systemError'].includes(status?.type)) return;
  const safeStatus = { type: status.type };
  if (status.type === 'active') safeStatus.activeFlags = Array.isArray(status.activeFlags)
    ? status.activeFlags.filter((flag) => flag === 'waitingOnApproval' || flag === 'waitingOnUserInput') : [];
  const key = Symbol.for('slava.codex.threadStatus.v1');
  const snapshot = process[key] || (process[key] = new Map());
  snapshot.set(threadId, safeStatus);
  process.emit('slava.codex.threadStatus.v1', { threadId, status: safeStatus });
}

function transformActivityBridge(source) {
  if (source.includes(ACTIVITY_MARKER)) return { source, alreadyPatched: true };
  const patched = replaceOnce(source, /routeIncomingMessage\(e,r=e\)\{/, `routeIncomingMessage(e,r=e){/* ${ACTIVITY_MARKER} */try{(${publishNativeActivity.toString()})(e)}catch{}`, 'события состояния из основного процесса Codex');
  return { source: patched, alreadyPatched: false };
}

function transformExtension(source) {
  if (source.includes(PATCH_MARKER)) return transformActivityBridge(source);

  let patched = source;
  patched = replaceOnce(
    patched,
    /async resolveCustomEditor\(e,r,n\)\{let o=gL\(e\.uri\);[\s\S]*?\}registerOnDidDisposeForWebviewPanel/,
    `async resolveCustomEditor(e,r,n){let o=gL(e.uri);if(o==null)throw new Error(\`Invalid Codex conversation URI: \${e.uri.toString()}\`);let{conversationId:i}=o;r.title=h4e(null),r.iconPath={light:ze.Uri.joinPath(this.extensionUri,"resources","blossom-black.svg"),dark:ze.Uri.joinPath(this.extensionUri,"resources","blossom-white.svg")},this.editorPanels.set(r,{ready:!1,pendingMessages:[],initialRoute:i==null||o.path.startsWith("/local/")?o.path:\`/local/\${i}\`}),i!=null&&this.registerOnDidDisposeForWebviewPanel(r,i),await this.initializeWebview(r.webview,"panel",r.onDidDispose,()=>{this.onPanelReady(r)}),i!=null&&(this.conversationSummaryProvider.getConversationSummary(i).then(({summary:s})=>{this.isPanelAlive(r)&&(r.title=h4e(s.preview),this.chatSessionItemProvider?.registerPendingConversation({conversationId:i,resource:e.uri,label:s.preview??void 0,modelProvider:s.modelProvider},{markInProgress:!1,onlyIfMissing:!0}))},s=>{this.logger.error("Error fetching conversation summary",{safe:{error:s,patch:"${PATCH_MARKER}"},sensitive:{}})}),this.previewLoader.fetchConversationPreviews().then(s=>{let a=s.get(i);this.isPanelAlive(r)&&(r.title=h4e(a))}))}registerOnDidDisposeForWebviewPanel`,
    'немедленный запуск редактора без ожидания заголовка',
  );

  patched = replaceOnce(
    patched,
    /async ensureRestoredConversationTabsResolved\(\)\{for\(let e of ze\.window\.tabGroups\.all\)for\(let r of e\.tabs\)\{let n=r\.input,o=null;n instanceof ze\.TabInputCustom\|\|n instanceof ze\.TabInputText\?o=n\.uri:o=null,o\?\.scheme===Av&&ze\.commands\.executeCommand\("vscode\.openWith",o,t\.customEditorViewType,\{preserveFocus:!0,preview:r\.isPreview\}\)\}\}/,
    `async ensureRestoredConversationTabsResolved(){this.logger.info("Deferred restored Codex tabs",{safe:{patch:"${PATCH_MARKER}"},sensitive:{}})}`,
    'ленивая загрузка восстановленных вкладок',
  );

  patched = replaceOnce(
    patched,
    /let s=new E2\(l=>\{this\.logger\.error\("Webview renderer did not become ready",\{safe:\{stage:"renderer",reason:"renderer_ready_timeout",role:r,extensionVersion:this\.extensionVersion,\.\.\.l\},sensitive:\{\}\}\),e\.html=`<!doctype html>[\s\S]*?`,ze\.window\.showErrorMessage\("Codex could not start its user interface\."\)\}\);this\.registerClientCoordinationForWebview/,
    `let retryTimer=null,retryAttempted=!1,s=new E2(l=>{this.logger.warning("Webview renderer is still loading",{safe:{stage:"renderer",reason:"renderer_ready_slow",role:r,extensionVersion:this.extensionVersion,patch:"${PATCH_MARKER}",...l},sensitive:{}});let c=()=>{if(retryAttempted||s.receivedWebviewMessage||s.disposed)return;retryAttempted=!0,retryTimer!=null&&(clearTimeout(retryTimer),retryTimer=null),this.logger.warning("Retrying slow Codex webview once",{safe:{role:r,patch:"${PATCH_MARKER}"},sensitive:{}});let l=e.html;e.html=l};ze.window.showWarningMessage("Codex загружается дольше 30 секунд.","Повторить загрузку").then(l=>{l==="Повторить загрузку"&&c()}),retryTimer=setTimeout(c,3e4)});this.registerClientCoordinationForWebview`,
    'предупреждение и ограниченный повтор медленной загрузки',
  );

  patched = replaceOnce(
    patched,
    /let a=e\.onDidReceiveMessage\(l=>\{if\(s\.markMessageReceived\(\),l\.type===/,
    'let a=e.onDidReceiveMessage(l=>{if(s.markMessageReceived(),retryTimer!=null&&(clearTimeout(retryTimer),retryTimer=null),l.type===',
    'отмена повтора после первого сообщения webview',
  );

  patched = replaceOnce(
    patched,
    /this\.subscriptions\.push\(a,n\(\(\)=>\{s\.dispose\(\),this\.chunkedMessageSender\.dispose\(e\)\}\)\),e\.html=/,
    'this.subscriptions.push(a,n(()=>{retryTimer!=null&&(clearTimeout(retryTimer),retryTimer=null),s.dispose(),this.chunkedMessageSender.dispose(e)})),e.html=',
    'очистка таймера при закрытии webview',
  );

  return transformActivityBridge(patched);
}

function createBackup(extensionDir, extensionSource, packageSource) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupDir = path.join(os.homedir(), '.codex-ui-backups', `openai.chatgpt-${SUPPORTED_VERSION}-${timestamp}`);
  fs.mkdirSync(path.join(backupDir, 'out'), { recursive: true });
  fs.writeFileSync(path.join(backupDir, 'out', 'extension.js'), extensionSource);
  fs.writeFileSync(path.join(backupDir, 'package.json'), packageSource);
  fs.writeFileSync(path.join(backupDir, 'backup.json'), `${JSON.stringify({
    sourceExtension: extensionDir,
    version: SUPPORTED_VERSION,
    extensionSha256: sha256(extensionSource),
    createdAt: new Date().toISOString(),
  }, null, 2)}\n`);
  return backupDir;
}

function applyPatch(extensionDir, options = {}) {
  const packagePath = path.join(extensionDir, 'package.json');
  const extensionPath = path.join(extensionDir, 'out', 'extension.js');
  const packageSource = fs.readFileSync(packagePath);
  const manifest = JSON.parse(packageSource.toString('utf8'));
  if (manifest.name !== 'chatgpt' || manifest.publisher !== 'openai') throw new Error('Выбранный каталог не является расширением openai.chatgpt.');
  if (manifest.version !== SUPPORTED_VERSION) throw new Error(`Версия ${manifest.version} не поддерживается. Ожидалась ${SUPPORTED_VERSION}; файлы не изменены.`);
  const extensionSource = fs.readFileSync(extensionPath);
  const sourceText = extensionSource.toString('utf8');
  if (![SUPPORTED_EXTENSION_SHA256, SUPPORTED_UI_PATCH_SHA256].includes(sha256(extensionSource))) {
    throw new Error('Контрольная сумма extension.js не совпала с поддерживаемой сборкой; файлы не изменены.');
  }
  const transformed = transformExtension(sourceText);
  if (options.checkOnly) return { status: transformed.alreadyPatched ? 'already-patched' : 'compatible', backupDir: null };
  if (transformed.alreadyPatched) return { status: 'already-patched', backupDir: null };
  const backupDir = createBackup(extensionDir, extensionSource, packageSource);
  const temporaryPath = `${extensionPath}.codex-ui-tmp`;
  fs.writeFileSync(temporaryPath, transformed.source);
  fs.renameSync(temporaryPath, extensionPath);
  return { status: 'patched', backupDir };
}

function restoreBackup(backupDir) {
  const metadata = JSON.parse(fs.readFileSync(path.join(backupDir, 'backup.json'), 'utf8'));
  if (metadata.version !== SUPPORTED_VERSION) throw new Error('Версия резервной копии не поддерживается этим восстановителем.');
  const target = metadata.sourceExtension;
  fs.copyFileSync(path.join(backupDir, 'out', 'extension.js'), path.join(target, 'out', 'extension.js'));
  fs.copyFileSync(path.join(backupDir, 'package.json'), path.join(target, 'package.json'));
  return target;
}

if (require.main === module) {
  const [command, target] = process.argv.slice(2);
  try {
    if (command === 'check' && target) console.log(JSON.stringify(applyPatch(target, { checkOnly: true }), null, 2));
    else if (command === 'apply' && target) console.log(JSON.stringify(applyPatch(target), null, 2));
    else if (command === 'restore' && target) console.log(JSON.stringify({ status: 'restored', target: restoreBackup(target) }, null, 2));
    else throw new Error('Использование: node patch-openai-extension.js check|apply <каталог расширения> или restore <каталог резервной копии>');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

module.exports = { applyPatch, restoreBackup, transformExtension, publishNativeActivity, SUPPORTED_VERSION, PATCH_MARKER, ACTIVITY_MARKER };
