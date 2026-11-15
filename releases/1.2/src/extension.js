'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');
const { EventEmitter } = require('events');
const { AccountViewProvider } = require('./account-view');

const EXTENSION_VERSION = '1.2.0';
const OPENAI_EXTENSION_ID = 'openai.chatgpt';
const CUSTOM_EDITOR_VIEW_TYPE = 'chatgpt.conversationEditor';
const CODEX_URI_SCHEME = 'openai-codex';
const CODEX_URI_AUTHORITY = 'route';
const PAGE_SIZE = 200;

function cleanLabel(value, fallback = 'Без названия') {
  const text = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return text || fallback;
}

function normalizePath(value) {
  if (!value) return '';
  let normalized = path.normalize(value).normalize('NFC');
  if (process.platform === 'win32') normalized = normalized.toLocaleLowerCase('en-US');
  return normalized.replace(/[\\/]+$/, '');
}

function isPathInside(candidate, root) {
  const current = normalizePath(candidate);
  const parent = normalizePath(root);
  if (!current || !parent) return false;
  if (current === parent) return true;
  const relative = path.relative(parent, current);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function formatDate(unixSeconds) {
  if (!Number.isFinite(unixSeconds)) return '';
  return new Date(unixSeconds * 1000).toLocaleString(undefined, {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function threadTitle(thread) {
  return cleanLabel(thread?.name || thread?.preview);
}

function normalizeSearchText(value) {
  return value.normalize('NFC').replace(/\s+/g, ' ').trim().toLowerCase();
}

function activityKind(status) {
  if (status?.type !== 'active') return 'idle';
  const flags = Array.isArray(status.activeFlags) ? status.activeFlags : [];
  return flags.includes('waitingOnApproval') || flags.includes('waitingOnUserInput') ? 'action' : 'working';
}

function findCodexBinary(extensionPath) {
  const binRoot = path.join(extensionPath, 'bin');
  const platformHints = process.platform === 'darwin'
    ? ['macos-aarch64', 'macos-x86_64']
    : process.platform === 'win32'
      ? ['windows-x86_64', 'windows-aarch64']
      : ['linux-x86_64', 'linux-aarch64'];
  const preferred = process.arch === 'arm64' ? platformHints.filter((entry) => entry.includes('aarch64')) : platformHints.filter((entry) => entry.includes('x86_64'));
  const candidates = [...preferred, ...platformHints];
  for (const directory of candidates) {
    const candidate = path.join(binRoot, directory, process.platform === 'win32' ? 'codex.exe' : 'codex');
    if (fs.existsSync(candidate)) return candidate;
  }
  if (fs.existsSync(binRoot)) {
    for (const directory of fs.readdirSync(binRoot)) {
      const candidate = path.join(binRoot, directory, process.platform === 'win32' ? 'codex.exe' : 'codex');
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  throw new Error('Не найден исполняемый файл Codex в установленном расширении OpenAI.');
}

class CodexRpcClient extends EventEmitter {
  constructor(binaryPath, output) {
    super();
    this.binaryPath = binaryPath;
    this.output = output;
    this.child = null;
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map();
    this.startPromise = null;
    this.disposed = false;
  }

  async start() {
    if (this.disposed) throw new Error('Соединение Codex закрыто.');
    if (this.child) return;
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.startProcess().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  async startProcess() {
    const child = spawn(this.binaryPath, ['app-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    this.buffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => this.handleStdout(chunk));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', () => {
      this.output.appendLine(`${new Date().toISOString()} app-server: получено диагностическое сообщение stderr`);
    });
    child.on('error', (error) => this.handleExit(error));
    child.on('exit', (code, signal) => this.handleExit(new Error(`app-server завершён: code=${code}, signal=${signal}`)));
    await this.rawRequest('initialize', {
      clientInfo: {
        name: 'codex_history_ui',
        title: 'Codex History UI',
        version: EXTENSION_VERSION,
      },
      capabilities: {
        experimentalApi: true,
      },
    }, 15000);
    this.send({ method: 'initialized', params: {} });
    this.output.appendLine(`${new Date().toISOString()} app-server: соединение инициализировано`);
  }

  handleStdout(chunk) {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.output.appendLine(`${new Date().toISOString()} app-server: некорректное JSON-сообщение`);
        continue;
      }
      if (message.id != null && (Object.prototype.hasOwnProperty.call(message, 'result') || message.error)) {
        const entry = this.pending.get(message.id);
        if (!entry) continue;
        this.pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error) entry.reject(new Error(message.error.message || 'Ошибка Codex app-server'));
        else entry.resolve(message.result);
        continue;
      }
      if (message.id != null && message.method) {
        this.send({ id: message.id, error: { code: -32601, message: 'Метод не поддерживается интерфейсом истории.' } });
        continue;
      }
      if (message.method) this.emit('notification', message.method, message.params || {});
    }
  }

  handleExit(error) {
    if (!this.child) return;
    this.child = null;
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
    if (!this.disposed) this.emit('disconnect', error);
  }

  send(message) {
    if (!this.child?.stdin?.writable) throw new Error('Codex app-server недоступен.');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  rawRequest(method, params = {}, timeoutMs = 15000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`Таймаут ${method}`);
        error.code = 'CODEX_RPC_TIMEOUT';
        reject(error);
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.send({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  async request(method, params = {}, timeoutMs = 15000) {
    await this.start();
    return this.rawRequest(method, params, timeoutMs);
  }

  dispose() {
    this.disposed = true;
    const child = this.child;
    this.child = null;
    if (child) child.kill();
    for (const entry of this.pending.values()) {
      clearTimeout(entry.timer);
      entry.reject(new Error('Расширение выгружено.'));
    }
    this.pending.clear();
    this.removeAllListeners();
  }
}

class RequestDiagnostics {
  constructor(client, output) {
    this.client = client;
    this.output = output;
    this.states = new Map();
    this.currentThreadId = null;
    this.statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 80);
    this.statusBar.command = 'codexHistory.showRequestStatus';
    this.timer = setInterval(() => this.checkStalledRequest(), 5000);
  }

  setCurrentThread(threadId) {
    this.currentThreadId = threadId || null;
    this.updateStatusBar();
  }

  observe(thread, source = 'poll') {
    if (!thread?.id || !thread.status) return;
    const previous = this.states.get(thread.id);
    const kind = activityKind(thread.status);
    const flags = Array.isArray(thread.status.activeFlags) ? [...thread.status.activeFlags].sort() : [];
    const signature = `${thread.status.type}:${flags.join(',')}:${thread.updatedAt || ''}`;
    if (previous?.signature === signature) return;
    const now = Date.now();
    const state = {
      signature,
      status: thread.status,
      phase: kind === 'action' ? 'waitingAction' : kind === 'working' ? 'receivingEvents' : 'inactive',
      lastEventAt: now,
      lastProbeAt: previous?.lastProbeAt || 0,
      lastProbe: previous?.lastProbe || null,
      probeInFlight: false,
      wasActive: kind !== 'idle' || previous?.wasActive || false,
    };
    this.states.set(thread.id, state);
    this.log({
      threadId: thread.id,
      eventType: 'thread-status',
      source,
      statusType: thread.status.type,
      activeFlags: flags,
    });
    if (thread.id === this.currentThreadId) this.updateStatusBar();
  }

  async checkStalledRequest() {
    const threadId = this.currentThreadId;
    if (!threadId) return;
    const state = this.states.get(threadId);
    if (!state || state.phase === 'inactive' || state.probeInFlight) return;
    const now = Date.now();
    if (now - state.lastEventAt < 30000 || now - state.lastProbeAt < 30000) return;
    state.probeInFlight = true;
    state.lastProbeAt = now;
    this.updateStatusBar();
    try {
      await this.client.request('thread/read', { threadId, includeTurns: false }, 5000);
      state.lastProbe = { result: 'responsive', at: Date.now() };
      this.log({ threadId, eventType: 'metadata-probe', result: 'responsive' });
    } catch (error) {
      const result = error?.code === 'CODEX_RPC_TIMEOUT' ? 'timeout' : 'error';
      state.lastProbe = { result, at: Date.now() };
      this.log({ threadId, eventType: 'metadata-probe', result });
    } finally {
      state.probeInFlight = false;
      this.updateStatusBar();
    }
  }

  updateStatusBar() {
    const state = this.currentThreadId ? this.states.get(this.currentThreadId) : null;
    if (!state || state.phase === 'inactive') {
      this.statusBar.hide();
      return;
    }
    if (state.phase === 'waitingAction') {
      this.statusBar.text = '$(question) Codex: требуется действие';
      this.statusBar.tooltip = 'Codex ожидает подтверждение или ответ пользователя. Нажмите для диагностики.';
      this.statusBar.color = new vscode.ThemeColor('codexHistory.actionForeground');
    } else if (state.probeInFlight) {
      this.statusBar.text = '$(pulse) Codex: проверяю локальный процесс';
      this.statusBar.tooltip = 'Нет новых событий не менее 30 секунд. Выполняется проверка метаданных без вызова модели.';
      this.statusBar.color = new vscode.ThemeColor('codexHistory.activeForeground');
    } else {
      this.statusBar.text = '$(pulse) Codex: поступают события выполнения';
      this.statusBar.tooltip = 'Запрос активен по метаданным Codex. Нажмите для диагностики.';
      this.statusBar.color = new vscode.ThemeColor('codexHistory.activeForeground');
    }
    this.statusBar.show();
  }

  showStatus() {
    const threadId = this.currentThreadId;
    if (!threadId) {
      vscode.window.showInformationMessage('Нет активного чата Codex для диагностики.');
      return;
    }
    const state = this.states.get(threadId);
    if (!state || state.phase === 'inactive') {
      vscode.window.showInformationMessage('Для текущего чата нет отслеживаемого активного запроса. Отслеживание начинается после загрузки этого расширения.');
      return;
    }
    const quietSeconds = Math.max(0, Math.floor((Date.now() - state.lastEventAt) / 1000));
    const probe = state.lastProbe ? `${state.lastProbe.result} (${new Date(state.lastProbe.at).toLocaleTimeString()})` : 'ещё не выполнялась';
    this.output.appendLine(`${new Date().toISOString()} current-request ${JSON.stringify({ threadId, phase: state.phase, quietSeconds, lastProbe: probe })}`);
    this.output.show(true);
    vscode.window.showInformationMessage(`Фаза: ${state.phase}. Без новых событий: ${quietSeconds} сек. Последняя проверка: ${probe}.`);
  }

  log(event) {
    this.output.appendLine(`${new Date().toISOString()} ${JSON.stringify(event)}`);
  }

  dispose() {
    clearInterval(this.timer);
    this.statusBar.dispose();
  }
}

class HistoryProvider {
  constructor(client, context, diagnostics) {
    this.client = client;
    this.context = context;
    this.diagnostics = diagnostics;
    this.emitter = new vscode.EventEmitter();
    this.onDidChangeTreeData = this.emitter.event;
    this.loading = false;
    this.error = null;
    this.openThreadId = null;
    this.runtimeStatuses = new Map();
    this.activeThreads = [];
    this.archivedThreads = [];
    this.sections = [];
    this.searchQuery = '';
    this.searchResults = [];
    this.epoch = 0;
    this.searchEpoch = 0;
    this.refreshTimer = null;
    this.visible = false;
  }

  setOpenThread(threadId) {
    const next = threadId || null;
    if (next === this.openThreadId) return;
    this.openThreadId = next;
    this.emitter.fire();
  }

  threadStatus(thread) {
    return this.runtimeStatuses.get(thread.id) || thread.status;
  }

  updateRuntimeStatus(threadId, status, source = 'event') {
    if (!threadId || !status?.type) return;
    const previous = this.runtimeStatuses.get(threadId);
    if (previous && JSON.stringify(previous) === JSON.stringify(status)) return;
    this.runtimeStatuses.set(threadId, status);
    this.diagnostics.observe({ id: threadId, status }, source);
    this.emitter.fire();
  }

  get scope() {
    return vscode.workspace.getConfiguration('codexHistory').get('scope', 'currentProject');
  }

  get workspaceRoots() {
    return (vscode.workspace.workspaceFolders || []).map((folder) => folder.uri.fsPath);
  }

  get currentScopeKey() {
    const roots = this.workspaceRoots.map(normalizePath).sort();
    return roots.length ? `workspace:${roots.join('|')}` : 'workspace:global';
  }

  matchesScope(thread) {
    if (this.scope === 'allProjects') return true;
    const roots = this.workspaceRoots;
    if (!roots.length) return true;
    return roots.some((root) => isPathInside(thread.cwd, root));
  }

  setVisible(visible) {
    this.visible = visible;
    this.restartRefreshTimer();
    if (visible) this.refresh({ quiet: true });
  }

  restartRefreshTimer() {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.refreshTimer = null;
    if (!this.visible) return;
    const seconds = Math.max(5, vscode.workspace.getConfiguration('codexHistory').get('activityRefreshIntervalSeconds', 5));
    this.refreshTimer = setInterval(() => this.refresh({ quiet: true, stateDbOnly: true }), seconds * 1000);
  }

  async listAll(archived, stateDbOnly) {
    const data = [];
    let cursor = null;
    do {
      const result = await this.client.request('thread/list', {
        archived,
        cursor,
        limit: PAGE_SIZE,
        sortKey: 'recency_at',
        sortDirection: 'desc',
        currentAccountOnly: true,
        useStateDbOnly: stateDbOnly,
      }, 30000);
      data.push(...(result.data || []));
      cursor = result.nextCursor || null;
    } while (cursor);
    return data;
  }

  async listSections() {
    const data = [];
    let cursor = null;
    do {
      const result = await this.client.request('threadSection/list', { cursor, limit: PAGE_SIZE });
      data.push(...(result.data || []));
      cursor = result.nextCursor || null;
    } while (cursor);
    return data;
  }

  async refresh({ quiet = false, stateDbOnly = false } = {}) {
    const epoch = ++this.epoch;
    if (this.searchQuery) ++this.searchEpoch;
    if (!quiet) {
      this.loading = true;
      this.error = null;
      this.emitter.fire();
    }
    try {
      const [activeThreads, archivedThreads, sections] = await Promise.all([
        this.listAll(false, stateDbOnly),
        this.listAll(true, stateDbOnly),
        this.listSections(),
      ]);
      if (epoch !== this.epoch) return;
      this.activeThreads = activeThreads;
      this.archivedThreads = archivedThreads;
      this.sections = sections;
      this.loading = false;
      this.error = null;
      for (const thread of activeThreads) this.diagnostics.observe({ ...thread, status: this.threadStatus(thread) }, stateDbOnly ? 'reconcile' : 'refresh');
      if (this.searchQuery) await this.runSearch(this.searchQuery, { useLoadedThreads: true });
      this.emitter.fire();
    } catch (error) {
      if (epoch !== this.epoch) return;
      this.loading = false;
      this.error = error;
      this.emitter.fire();
      if (!quiet) vscode.window.showErrorMessage(`Не удалось обновить историю Codex: ${error.message}`);
    }
  }

  async searchAll(query, archived) {
    const data = [];
    let cursor = null;
    do {
      const result = await this.client.request('thread/search', {
        searchTerm: query,
        archived,
        cursor,
        limit: PAGE_SIZE,
        sortKey: 'recency_at',
        sortDirection: 'desc',
        currentAccountOnly: true,
      }, 30000);
      data.push(...(result.data || []));
      cursor = result.nextCursor || null;
    } while (cursor);
    return data;
  }

  async runSearch(query, options = {}) {
    const normalized = query.trim();
    if (!normalized) return this.clearSearch();
    const epoch = ++this.searchEpoch;
    if (this.searchQuery !== normalized) this.searchResults = [];
    this.searchQuery = normalized;
    vscode.commands.executeCommand('setContext', 'codexHistory.searchActive', true);
    this.loading = true;
    this.emitter.fire();
    try {
      const [active, archived, activeThreads, archivedThreads] = await Promise.all([
        this.searchAll(normalized, false),
        this.searchAll(normalized, true),
        options.useLoadedThreads ? this.activeThreads : this.listAll(false, false),
        options.useLoadedThreads ? this.archivedThreads : this.listAll(true, false),
      ]);
      if (epoch !== this.searchEpoch) return;
      const needle = normalizeSearchText(normalized);
      const results = new Map();
      for (const [threads, isArchived, matchTitle] of [
        [activeThreads, false, true], [archivedThreads, true, true],
        [active, false, false], [archived, true, false],
      ]) {
        for (const thread of threads) {
          if ((!matchTitle || normalizeSearchText(threadTitle(thread)).includes(needle)) && this.matchesScope(thread) && !results.has(thread.id)) {
            results.set(thread.id, { ...thread, __archived: isArchived });
          }
        }
      }
      this.searchResults = [...results.values()];
      this.loading = false;
      this.error = null;
      this.emitter.fire();
    } catch (error) {
      if (epoch !== this.searchEpoch) return;
      this.loading = false;
      this.error = error;
      this.emitter.fire();
      vscode.window.showErrorMessage(`Поиск Codex завершился ошибкой: ${error.message}`);
    }
  }

  clearSearch() {
    ++this.searchEpoch;
    this.searchQuery = '';
    this.searchResults = [];
    this.loading = false;
    vscode.commands.executeCommand('setContext', 'codexHistory.searchActive', false);
    this.emitter.fire();
  }

  groupScopes() {
    return this.context.globalState.get('codexHistory.groupScopes', {});
  }

  async setGroupScope(sectionId, scopeKey) {
    const scopes = { ...this.groupScopes(), [sectionId]: scopeKey };
    await this.context.globalState.update('codexHistory.groupScopes', scopes);
  }

  filteredActive() {
    return this.activeThreads.filter((thread) => this.matchesScope(thread));
  }

  filteredArchived() {
    return this.archivedThreads.filter((thread) => this.matchesScope(thread));
  }

  visibleSections(threads) {
    if (this.scope === 'allProjects') return this.sections;
    const populated = new Set(threads.map((thread) => thread.section?.id).filter(Boolean));
    const scopes = this.groupScopes();
    return this.sections.filter((section) => populated.has(section.id) || scopes[section.id] === this.currentScopeKey);
  }

  getTreeItem(element) {
    if (element.kind === 'message') {
      const item = new vscode.TreeItem(element.label, vscode.TreeItemCollapsibleState.None);
      item.iconPath = new vscode.ThemeIcon(element.error ? 'error' : element.loading ? 'loading~spin' : 'info');
      return item;
    }
    if (element.kind === 'group') return this.groupItem(element);
    if (element.kind === 'archiveRoot') {
      const item = new vscode.TreeItem(`Архив (${element.threads.length})`, vscode.TreeItemCollapsibleState.Collapsed);
      item.id = 'codexHistory:archive';
      item.contextValue = 'codexHistory.archiveRoot';
      item.iconPath = new vscode.ThemeIcon('archive');
      item.tooltip = 'Архивные чаты текущей области истории';
      return item;
    }
    if (element.kind === 'ungrouped') {
      const item = new vscode.TreeItem(`Без группы (${element.threads.length})`, vscode.TreeItemCollapsibleState.Expanded);
      item.id = 'codexHistory:ungrouped';
      item.contextValue = 'codexHistory.ungrouped';
      item.iconPath = new vscode.ThemeIcon('inbox');
      return item;
    }
    if (element.kind === 'searchHeader') {
      const item = new vscode.TreeItem(`Результаты: ${element.query} (${element.threads.length})`, vscode.TreeItemCollapsibleState.Expanded);
      item.id = `codexHistory:search:${element.query}`;
      item.iconPath = new vscode.ThemeIcon('search');
      return item;
    }
    if (element.kind === 'chat') return this.chatItem(element);
    return new vscode.TreeItem(cleanLabel(element.label));
  }

  groupItem(element) {
    const activity = element.threads.map((thread) => activityKind(this.threadStatus(thread)));
    const action = activity.includes('action');
    const working = !action && activity.includes('working');
    const item = new vscode.TreeItem(`${element.section.name} (${element.threads.length})`, vscode.TreeItemCollapsibleState.Collapsed);
    item.id = `codexHistory:group:${element.section.id}`;
    item.contextValue = 'codexHistory.group';
    item.iconPath = new vscode.ThemeIcon(
      action || working ? 'circle-filled' : 'folder',
      action ? new vscode.ThemeColor('codexHistory.actionForeground') : working ? new vscode.ThemeColor('codexHistory.activeForeground') : undefined,
    );
    item.tooltip = action
      ? `${element.section.name}: один или несколько чатов ожидают действия пользователя`
      : working
        ? `${element.section.name}: один или несколько чатов выполняются`
        : `${element.section.name}: ${element.threads.length} чатов`;
    item.accessibilityInformation = { label: item.tooltip, role: 'treeitem' };
    return item;
  }

  chatItem(element) {
    const thread = element.thread;
    const archived = Boolean(element.archived);
    const kind = activityKind(this.threadStatus(thread));
    const opened = thread.id === this.openThreadId;
    const item = new vscode.TreeItem(threadTitle(thread), vscode.TreeItemCollapsibleState.None);
    item.id = `codexHistory:${archived ? 'archived' : 'active'}:${thread.id}`;
    item.contextValue = archived ? 'codexHistory.archivedChat' : 'codexHistory.chat';
    item.description = archived && thread.section?.name ? `${thread.section.name} · ${formatDate(thread.recencyAt || thread.updatedAt)}` : formatDate(thread.recencyAt || thread.updatedAt);
    item.command = { command: 'codexHistory.openChat', title: 'Открыть чат', arguments: [element] };
    if (kind === 'action') {
      item.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('codexHistory.actionForeground'));
      item.tooltip = `${threadTitle(thread)} — требуется подтверждение или ответ пользователя`;
    } else if (kind === 'working') {
      item.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('codexHistory.activeForeground'));
      item.tooltip = `${threadTitle(thread)} — Codex выполняет запрос`;
    } else if (opened) {
      item.iconPath = new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('codexHistory.openForeground'));
      item.tooltip = `${threadTitle(thread)} — открыт в активной вкладке`;
    } else {
      item.iconPath = new vscode.ThemeIcon(archived ? 'archive' : 'comment-discussion');
      item.tooltip = `${threadTitle(thread)}\n${thread.cwd || ''}`.trim();
    }
    item.accessibilityInformation = { label: item.tooltip, role: 'treeitem' };
    return item;
  }

  getChildren(element) {
    if (!element) {
      if (this.loading && !this.activeThreads.length && !this.archivedThreads.length) return [{ kind: 'message', label: 'Загрузка истории…', loading: true }];
      if (this.error && !this.activeThreads.length && !this.archivedThreads.length) return [{ kind: 'message', label: `История недоступна: ${this.error.message}`, error: true }];
      if (this.searchQuery) return [{ kind: 'searchHeader', query: this.searchQuery, threads: this.searchResults }];
      const active = this.filteredActive();
      const sections = this.visibleSections(active);
      const roots = sections.map((section) => ({ kind: 'group', section, threads: active.filter((thread) => thread.section?.id === section.id) }));
      roots.push({ kind: 'ungrouped', threads: active.filter((thread) => !thread.section) });
      roots.push({ kind: 'archiveRoot', threads: this.filteredArchived() });
      if (this.error) roots.unshift({ kind: 'message', label: `Показаны сохранённые данные: ${this.error.message}`, error: true });
      return roots;
    }
    if (element.kind === 'group' || element.kind === 'ungrouped') return element.threads.map((thread) => ({ kind: 'chat', thread, archived: false }));
    if (element.kind === 'archiveRoot') return element.threads.map((thread) => ({ kind: 'chat', thread, archived: true }));
    if (element.kind === 'searchHeader') return element.threads.map((thread) => ({ kind: 'chat', thread, archived: Boolean(thread.__archived) }));
    return [];
  }

  dispose() {
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    this.emitter.dispose();
  }
}

class AccountProvider {
  constructor(client) {
    this.client = client;
    this.emitter = new vscode.EventEmitter();
    this.onDidChange = this.emitter.event;
    this.account = null;
    this.limits = null;
    this.loading = false;
    this.error = null;
    this.stale = false;
    this.updatedAt = null;
    this.epoch = 0;
    this.visible = false;
    this.timer = null;
  }

  setVisible(visible) {
    this.visible = visible;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (visible) {
      this.refresh(true);
      this.timer = setInterval(() => this.refresh(true), 60000);
    }
  }

  async refresh(quiet = false) {
    const epoch = ++this.epoch;
    if (!quiet || (!this.account && !this.limits)) {
      this.loading = true;
      this.emitter.fire();
    }
    try {
      const account = await this.client.request('account/read', { refreshToken: false });
      let limits = null;
      if (account.account?.type === 'chatgpt') limits = await this.client.request('account/rateLimits/read', {});
      if (epoch !== this.epoch) return;
      const previousType = this.account?.account?.type;
      const previousIdentity = this.account?.account?.email || null;
      const nextIdentity = account.account?.email || null;
      if (previousType && (previousType !== account.account?.type || previousIdentity !== nextIdentity)) this.limits = null;
      this.account = account;
      this.limits = limits;
      this.loading = false;
      this.error = null;
      this.stale = false;
      this.updatedAt = Date.now();
      this.emitter.fire();
    } catch (error) {
      if (epoch !== this.epoch) return;
      this.loading = false;
      this.error = error;
      this.stale = Boolean(this.account || this.limits);
      this.emitter.fire();
      if (!quiet) vscode.window.showErrorMessage(`Не удалось обновить аккаунт Codex: ${error.message}`);
    }
  }

  dispose() {
    if (this.timer) clearInterval(this.timer);
    this.emitter.dispose();
  }
}

function codexUri(route) {
  return vscode.Uri.from({ scheme: CODEX_URI_SCHEME, authority: CODEX_URI_AUTHORITY, path: route });
}

function parseCodexThreadId(uri) {
  if (!uri || uri.scheme !== CODEX_URI_SCHEME || uri.authority !== CODEX_URI_AUTHORITY) return null;
  const parts = uri.path.split('/').filter(Boolean);
  return parts[0] === 'local' && parts[1] ? parts[1] : null;
}

function uriFromTab(tab) {
  const input = tab?.input;
  if (input instanceof vscode.TabInputCustom || input instanceof vscode.TabInputText) return input.uri;
  return null;
}

async function activateCodexEditor(uri, options = {}) {
  await vscode.commands.executeCommand('vscode.openWith', uri, CUSTOM_EDITOR_VIEW_TYPE, {
    viewColumn: options.viewColumn || vscode.ViewColumn.Active,
    preserveFocus: Boolean(options.preserveFocus),
    preview: Boolean(options.preview),
  });
}

function selectedChatNodes(item, views) {
  const nodes = [];
  if (item?.kind === 'chat') nodes.push(item);
  for (const view of views) {
    for (const selected of view.selection || []) if (selected?.kind === 'chat') nodes.push(selected);
  }
  const unique = new Map(nodes.map((node) => [node.thread.id, node]));
  return [...unique.values()];
}

async function activate(context) {
  const openaiExtension = vscode.extensions.getExtension(OPENAI_EXTENSION_ID);
  if (!openaiExtension) {
    vscode.window.showErrorMessage('Для Codex History UI требуется установленное расширение OpenAI Codex.');
    return;
  }
  const output = vscode.window.createOutputChannel('Codex: состояние запросов');
  const binary = findCodexBinary(openaiExtension.extensionPath);
  const client = new CodexRpcClient(binary, output);
  const diagnostics = new RequestDiagnostics(client, output);
  const history = new HistoryProvider(client, context, diagnostics);
  const titleEvent = 'slava.codex.threadTitle.v1';
  const titles = process[Symbol.for(titleEvent)] = new Map();
  context.subscriptions.push(history.onDidChangeTreeData(() => {
    for (const thread of [...history.activeThreads, ...history.archivedThreads]) {
      const title = thread.name || thread.preview;
      if (thread.id && title && titles.get(thread.id) !== title) {
        titles.set(thread.id, title);
        process.emit(titleEvent, { threadId: thread.id, title });
      }
    }
  }));
  const account = new AccountProvider(client);
  const accountViewProvider = new AccountViewProvider(account);
  const historyViews = [];
  const resolvedRestoredTabs = new Set();
  const tabBridgeKey = 'slava.codex.tabThreads.v1';
  const savedTabThreads = context.workspaceState.get(tabBridgeKey, {});
  const tabThreads = process[Symbol.for(tabBridgeKey)] = new Map(Object.entries(savedTabThreads));
  const persistTabThread = ({ uri, threadId }) => {
    if (typeof uri !== 'string' || typeof threadId !== 'string') return;
    tabThreads.set(uri, threadId);
    context.workspaceState.update(tabBridgeKey, Object.fromEntries(tabThreads));
    resolveActiveRestoredTab();
    scheduleRefresh();
  };
  process.on(tabBridgeKey, persistTabThread);
  context.subscriptions.push({ dispose: () => process.off(tabBridgeKey, persistTabThread) });
  let refreshDebounce = null;

  for (const id of ['codexHistory.historyPrimary', 'codexHistory.historySecondary']) {
    const view = vscode.window.createTreeView(id, { treeDataProvider: history, canSelectMany: true, showCollapseAll: true });
    historyViews.push(view);
    view.onDidChangeVisibility(() => history.setVisible(historyViews.some((candidate) => candidate.visible)));
    context.subscriptions.push(view);
  }
  for (const id of ['codexHistory.accountPrimary', 'codexHistory.accountSecondary']) {
    context.subscriptions.push(vscode.window.registerWebviewViewProvider(id, accountViewProvider));
  }

  const scheduleRefresh = () => {
    if (refreshDebounce) clearTimeout(refreshDebounce);
    refreshDebounce = setTimeout(() => history.refresh({ quiet: true, stateDbOnly: true }), 250);
  };
  const metadataEvent = 'slava.codex.threadMetadata.v1';
  process.on(metadataEvent, scheduleRefresh);
  context.subscriptions.push({ dispose: () => process.off(metadataEvent, scheduleRefresh) });

  const nativeActivityEvent = 'slava.codex.threadStatus.v1';
  const onNativeActivity = ({ threadId, status }) => history.updateRuntimeStatus(threadId, status, 'editor-event');
  process.on(nativeActivityEvent, onNativeActivity);
  context.subscriptions.push({ dispose: () => process.off(nativeActivityEvent, onNativeActivity) });
  const nativeSnapshot = process[Symbol.for(nativeActivityEvent)];
  if (nativeSnapshot && typeof nativeSnapshot[Symbol.iterator] === 'function') {
    for (const [threadId, status] of nativeSnapshot) history.updateRuntimeStatus(threadId, status, 'editor-snapshot');
  }

  client.on('notification', (method, params) => {
    if (method === 'thread/status/changed') {
      if (!process[Symbol.for(nativeActivityEvent)]?.has(params.threadId)) history.updateRuntimeStatus(params.threadId, params.status);
      return;
    }
    if (method === 'account/rateLimits/updated' || method === 'account/updated') {
      if (account.visible) account.refresh(true);
      return;
    }
    if (/^thread\/(name\/updated|archived|unarchived|section\/changed|started|closed)$/.test(method)) scheduleRefresh();
  });
  client.on('disconnect', () => {
    history.error = new Error('Локальный Codex временно недоступен.');
    history.emitter.fire();
  });

  const resolveActiveRestoredTab = async () => {
    const tab = vscode.window.tabGroups.activeTabGroup.activeTab;
    const uri = uriFromTab(tab);
    const threadId = parseCodexThreadId(uri) || (uri && tabThreads.get(uri.toString()));
    diagnostics.setCurrentThread(threadId);
    history.setOpenThread(threadId);
    if (!uri || uri.scheme !== CODEX_URI_SCHEME || resolvedRestoredTabs.has(uri.toString())) return;
    resolvedRestoredTabs.add(uri.toString());
    try {
      await activateCodexEditor(uri, { preserveFocus: true, preview: tab?.isPreview });
    } catch (error) {
      output.appendLine(`${new Date().toISOString()} restored-tab-activation error=${error.name || 'Error'}`);
    }
  };

  const register = (command, handler) => context.subscriptions.push(vscode.commands.registerCommand(command, handler));
  register('codexHistory.newChat', async () => {
    const uri = codexUri('/extension/panel/new').with({ query: `codexUiTab=${randomUUID()}` });
    resolvedRestoredTabs.add(uri.toString());
    await activateCodexEditor(uri, { preview: false });
  });
  register('codexHistory.refresh', () => history.refresh());
  register('codexHistory.refreshAccount', () => account.refresh(false));
  register('codexHistory.clearSearch', () => history.clearSearch());
  register('codexHistory.search', async () => {
    const query = await vscode.window.showInputBox({
      title: 'Поиск по всей истории Codex',
      prompt: 'Поиск выполняется по названиям и содержимому активных и архивных чатов.',
      value: history.searchQuery,
      valueSelection: [0, history.searchQuery.length],
    });
    if (query !== undefined) await history.runSearch(query);
  });
  register('codexHistory.toggleScope', async () => {
    const configuration = vscode.workspace.getConfiguration('codexHistory');
    const next = history.scope === 'currentProject' ? 'allProjects' : 'currentProject';
    await configuration.update('scope', next, vscode.ConfigurationTarget.Workspace);
    vscode.window.setStatusBarMessage(next === 'currentProject' ? 'Codex: история текущего проекта' : 'Codex: история всех проектов', 2500);
    await history.refresh();
  });
  register('codexHistory.createGroup', async () => {
    const name = await vscode.window.showInputBox({
      title: 'Создать группу чатов Codex',
      prompt: history.scope === 'currentProject' ? 'Группа будет показана в текущем проекте.' : 'Группа будет доступна в общей истории.',
      validateInput: (value) => value.trim() ? null : 'Название не может быть пустым.',
    });
    if (name === undefined) return;
    const result = await client.request('threadSection/create', { name: name.trim() });
    if (result?.section?.id) await history.setGroupScope(result.section.id, history.scope === 'currentProject' ? history.currentScopeKey : 'allProjects');
    await history.refresh();
  });
  register('codexHistory.renameGroup', async (item) => {
    const section = item?.section;
    if (!section) return;
    const name = await vscode.window.showInputBox({
      title: 'Переименовать группу',
      value: section.name,
      valueSelection: [0, section.name.length],
      validateInput: (value) => value.trim() ? null : 'Название не может быть пустым.',
    });
    if (name === undefined || name.trim() === section.name) return;
    await client.request('threadSection/update', { sectionId: section.id, name: name.trim() });
    await history.refresh();
  });
  register('codexHistory.deleteGroup', async (item) => {
    const section = item?.section;
    if (!section) return;
    const answer = await vscode.window.showWarningMessage(
      `Удалить группу «${section.name}»? Чаты останутся в разделе «Без группы».`,
      { modal: true },
      'Удалить группу',
    );
    if (answer !== 'Удалить группу') return;
    await client.request('threadSection/delete', { sectionId: section.id });
    await history.refresh();
  });
  register('codexHistory.renameChat', async (item) => {
    const thread = item?.thread;
    if (!thread) return;
    const current = threadTitle(thread);
    const name = await vscode.window.showInputBox({
      title: 'Переименовать чат',
      value: current,
      valueSelection: [0, current.length],
      validateInput: (value) => value.trim() ? null : 'Название не может быть пустым.',
    });
    if (name === undefined || name.trim() === current) return;
    try {
      await client.request('thread/name/set', { threadId: thread.id, name: name.trim() });
      await history.refresh({ quiet: true, stateDbOnly: true });
    } catch (error) {
      vscode.window.showErrorMessage(`Не удалось переименовать чат. Прежнее название сохранено: ${error.message}`);
    }
  });
  register('codexHistory.moveChats', async (item) => {
    const nodes = selectedChatNodes(item, historyViews).filter((node) => !node.archived);
    if (!nodes.length) return;
    const picks = [
      { label: 'Без группы', description: 'Убрать из текущей группы', sectionId: null },
      ...history.sections.map((section) => ({ label: section.name, sectionId: section.id })),
    ];
    const destination = await vscode.window.showQuickPick(picks, { title: `Переместить чаты (${nodes.length})`, placeHolder: 'Выберите группу' });
    if (!destination) return;
    for (const node of nodes) await client.request('thread/section/move', { threadId: node.thread.id, sectionId: destination.sectionId });
    if (destination.sectionId && history.scope === 'currentProject') await history.setGroupScope(destination.sectionId, history.currentScopeKey);
    await history.refresh();
  });
  register('codexHistory.archiveChats', async (item) => {
    const nodes = selectedChatNodes(item, historyViews).filter((node) => !node.archived);
    for (const node of nodes) await client.request('thread/archive', { threadId: node.thread.id });
    await history.refresh();
  });
  register('codexHistory.restoreChats', async (item) => {
    const nodes = selectedChatNodes(item, historyViews).filter((node) => node.archived);
    for (const node of nodes) await client.request('thread/unarchive', { threadId: node.thread.id });
    await history.refresh();
  });
  register('codexHistory.openChat', async (item) => {
    const thread = item?.thread;
    if (!thread) return;
    if (item.archived) {
      const answer = await vscode.window.showInformationMessage('Для продолжения архивный чат нужно восстановить.', 'Восстановить и открыть');
      if (answer !== 'Восстановить и открыть') return;
      await client.request('thread/unarchive', { threadId: thread.id });
      item.archived = false;
      await history.refresh({ quiet: true, stateDbOnly: true });
    }
    const uri = codexUri(`/local/${thread.id}`);
    resolvedRestoredTabs.add(uri.toString());
    diagnostics.setCurrentThread(thread.id);
    await activateCodexEditor(uri, { preview: false });
  });
  register('codexHistory.showRequestStatus', () => diagnostics.showStatus());

  context.subscriptions.push(vscode.window.tabGroups.onDidChangeTabs(resolveActiveRestoredTab));
  context.subscriptions.push(vscode.window.tabGroups.onDidChangeTabs((event) => {
    let changed = false;
    for (const tab of event.closed) {
      const uri = uriFromTab(tab);
      if (uri && tabThreads.delete(uri.toString())) changed = true;
    }
    if (changed) context.workspaceState.update(tabBridgeKey, Object.fromEntries(tabThreads));
  }));
  context.subscriptions.push(vscode.window.tabGroups.onDidChangeTabGroups(resolveActiveRestoredTab));
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((event) => {
    if (event.affectsConfiguration('codexHistory.scope') || event.affectsConfiguration('codexHistory.enabled')) history.refresh({ quiet: true });
    if (event.affectsConfiguration('codexHistory.activityRefreshIntervalSeconds')) history.restartRefreshTimer();
  }));
  context.subscriptions.push({ dispose: () => {
    if (refreshDebounce) clearTimeout(refreshDebounce);
    history.dispose();
    accountViewProvider.dispose();
    account.dispose();
    diagnostics.dispose();
    client.dispose();
    output.dispose();
  } });

  vscode.commands.executeCommand('setContext', 'codexHistory.searchActive', false);
  resolveActiveRestoredTab();
  history.refresh({ quiet: true });
  account.refresh(true);
}

function deactivate() {}

module.exports = { activate, deactivate };
