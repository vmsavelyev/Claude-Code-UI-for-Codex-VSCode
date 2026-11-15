'use strict';

const { randomBytes } = require('crypto');

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}

function plural(value, forms) {
  return forms[{ one: 0, few: 1, many: 2, other: 2 }[new Intl.PluralRules('ru').select(value)]];
}

function periodLabel(minutes) {
  if (!Number.isFinite(minutes) || minutes <= 0) return 'Текущий период';
  if (minutes % 1440 === 0) {
    const days = minutes / 1440;
    return `За ${days} ${plural(days, ['день', 'дня', 'дней'])}`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `За ${hours} ${plural(hours, ['час', 'часа', 'часов'])}`;
  }
  return `За ${minutes} ${plural(minutes, ['минуту', 'минуты', 'минут'])}`;
}

function resetLabel(unixSeconds, now) {
  if (!Number.isFinite(unixSeconds) || unixSeconds <= 0) return { label: 'Время сброса недоступно', iso: null };
  const date = new Date(unixSeconds * 1000);
  if (!Number.isFinite(date.getTime())) return { label: 'Время сброса недоступно', iso: null };
  const time = date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
  if (date.getTime() <= now.getTime()) return { label: 'Обновление лимита…', iso: date.toISOString() };
  const tomorrow = new Date(now);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const day = date.toDateString() === now.toDateString() ? 'сегодня'
    : date.toDateString() === tomorrow.toDateString() ? 'завтра'
      : date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' }).replace(/\.$/, '');
  return { label: `Сброс ${day}, ${time}`, iso: date.toISOString() };
}

const userIcon = '<svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="8" r="3.25"/><path d="M5.75 20v-1.75a6.25 6.25 0 0 1 12.5 0V20"/></svg>';
const usageIcon = '<svg viewBox="0 0 20 20" fill="none" aria-hidden="true"><path d="M3 13.5V17m4.7-8V17m4.6-12.5V17M17 2v15"/></svg>';

function renderWindow(window, now) {
  const used = typeof window.usedPercent === 'number' && Number.isFinite(window.usedPercent)
    ? Math.round(Math.max(0, Math.min(100, window.usedPercent)) * 10) / 10 : null;
  const remaining = used === null ? null : Math.round((100 - used) * 10) / 10;
  const format = (value) => value.toLocaleString('ru-RU', { maximumFractionDigits: 1 });
  const tone = used >= 95 ? 'danger' : used >= 80 ? 'warning' : 'normal';
  const reset = resetLabel(window.resetsAt, now);
  const remainingLabel = used === null ? 'Нет данных об использовании' : used === 100 ? 'Лимит исчерпан' : `Осталось ${format(remaining)}%`;
  const aria = used === null ? 'Данные об использовании недоступны' : `Использовано ${format(used)}%, осталось ${format(remaining)}%`;
  const resetHtml = reset.iso ? `<time datetime="${reset.iso}">${escapeHtml(reset.label)}</time>` : escapeHtml(reset.label);
  return `<article class="usage-window ${tone}">
    <div class="window-heading"><h3>${escapeHtml(periodLabel(window.windowDurationMins))}</h3><span class="window-caption">использовано</span></div>
    <div class="metric">${used === null ? '—' : `${format(used)}<span class="percent">%</span>`}</div>
    <div class="progress" role="progressbar" aria-label="${escapeHtml(aria)}"${used === null ? '' : ` aria-valuemin="0" aria-valuemax="100" aria-valuenow="${used}"`}><svg class="progress-fill" aria-hidden="true"><rect width="${used ?? 0}%" height="100%" rx="2.5"/></svg></div>
    <div class="window-footer"><span class="remaining">${escapeHtml(remainingLabel)}</span><span class="reset">${resetHtml}</span></div>
  </article>`;
}

function renderUsage(limits, now) {
  const byId = limits?.rateLimitsByLimitId;
  const buckets = byId && Object.keys(byId).length ? Object.entries(byId) : [['codex', limits?.rateLimits]];
  const sections = buckets.filter(([, bucket]) => bucket).map(([id, bucket]) => {
    const rawName = bucket.limitName || bucket.limitId || id;
    const name = /^codex$/i.test(rawName) ? 'Codex' : rawName;
    const windows = [bucket.primary, bucket.secondary].filter(Boolean);
    return `<section class="usage-section" aria-label="${escapeHtml(`Использование ${name}`)}">
      <div class="section-heading">${usageIcon}<h2>Использование ${escapeHtml(name)}</h2></div>
      ${windows.length ? `<div class="windows">${windows.map((window) => renderWindow(window, now)).join('')}</div>` : '<p class="notice">Сведения о периодах лимита пока недоступны.</p>'}
    </section>`;
  });
  return sections.length ? sections.join('') : '<p class="notice">Сведения о лимитах пока недоступны.</p>';
}

const styles = `
  :root {
    color-scheme: light dark;
    --background: var(--vscode-sideBar-background, #191919);
    --text: var(--vscode-foreground, #e6e2dc);
    --muted: var(--vscode-descriptionForeground, #a5a19b);
    --surface: color-mix(in srgb, var(--text) 3%, var(--background));
    --border: color-mix(in srgb, var(--text) 11%, var(--background));
    --track: color-mix(in srgb, var(--text) 10%, var(--background));
    --accent: #d99a7e;
    --warning: #e3b269;
    --danger: var(--vscode-errorForeground, #ef8e85);
  }
  body.vscode-light { color-scheme: light; --accent: #a65336; --warning: #946b1c; }
  body.vscode-dark { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; padding: 14px 14px 10px; background: var(--background); color: var(--text); font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif); font-size: var(--vscode-font-size, 13px); line-height: 1.5; }
  p, h1, h2, h3 { margin: 0; }
  .account-panel { max-width: 720px; margin: 0 auto; }
  .identity { display: flex; align-items: center; gap: 11px; padding: 3px 1px 20px; min-width: 0; }
  .avatar { width: 37px; height: 37px; flex: 0 0 37px; display: grid; place-items: center; border-radius: 11px; color: var(--accent); background: color-mix(in srgb, var(--accent) 11%, var(--background)); border: 1px solid color-mix(in srgb, var(--accent) 19%, var(--background)); }
  .avatar svg { width: 23px; height: 23px; stroke: currentColor; stroke-width: 1.5; stroke-linecap: round; }
  .identity-copy { min-width: 0; flex: 1; }
  .eyebrow { color: var(--muted); font-size: 11px; margin-bottom: 2px; }
  .email { display: block; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 13px; font-weight: 550; letter-spacing: -.1px; }
  .plan { align-self: center; flex-shrink: 0; border: 1px solid color-mix(in srgb, var(--accent) 23%, var(--background)); border-radius: 6px; padding: 2px 7px; color: var(--accent); background: color-mix(in srgb, var(--accent) 8%, var(--background)); font-size: 10px; font-weight: 650; line-height: 1.6; letter-spacing: .35px; text-transform: uppercase; max-width: 100px; overflow-wrap: anywhere; }
  .workspace { color: var(--muted); font-size: 11px; overflow-wrap: anywhere; margin-top: 2px; }
  .usage-section + .usage-section { margin-top: 18px; }
  .section-heading { display: flex; align-items: center; gap: 7px; margin: 0 1px 9px; }
  .section-heading svg { width: 14px; height: 14px; flex-shrink: 0; stroke: var(--muted); stroke-width: 1.4; stroke-linecap: round; }
  h2 { font-size: 11px; font-weight: 550; color: var(--muted); letter-spacing: .1px; overflow-wrap: anywhere; }
  .windows { display: grid; gap: 9px; }
  .usage-window { padding: 13px 14px 12px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); --fill: var(--accent); min-width: 0; }
  .usage-window.warning { --fill: var(--warning); }
  .usage-window.danger { --fill: var(--danger); }
  .window-heading { display: flex; align-items: baseline; justify-content: space-between; gap: 8px; }
  h3 { font-size: 12px; font-weight: 550; }
  .window-caption { font-size: 10px; color: var(--muted); }
  .metric { font-size: 27px; font-weight: 450; font-variant-numeric: tabular-nums; letter-spacing: -.9px; line-height: 1.25; margin: 5px 0 11px; }
  .percent { font-size: 17px; letter-spacing: -.3px; margin-left: 2px; color: var(--muted); }
  .progress { height: 5px; border-radius: 8px; background: var(--track); overflow: hidden; }
  .progress-fill { display: block; width: 100%; height: 100%; }
  .progress-fill rect { fill: var(--fill); }
  .window-footer { display: flex; justify-content: space-between; align-items: baseline; gap: 5px 12px; flex-wrap: wrap; margin-top: 9px; font-size: 10px; }
  .remaining { color: var(--text); font-weight: 500; }
  .reset { color: var(--muted); }
  .danger .remaining { color: var(--danger); }
  .status { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 10px; margin: 11px 2px 0; }
  .status-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--muted); opacity: .7; flex-shrink: 0; }
  .notice { padding: 13px 14px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }
  .notice strong { display: block; color: var(--text); font-size: 13px; font-weight: 550; margin-bottom: 4px; }
  .notice + .usage-section, .notice + .identity { margin-top: 12px; }
  .stale { border-left: 2px solid var(--warning); margin-bottom: 12px; }
  .loading { padding: 5px 0; }
  .skeleton { display: block; height: 12px; border-radius: 5px; background: var(--track); margin: 8px 0; animation: pulse 1.8s ease-in-out infinite; }
  .skeleton.short { width: 46%; }
  .skeleton.identity-line { width: 70%; margin-bottom: 25px; }
  .skeleton.track { height: 5px; margin: 14px 0 9px; }
  .loading .usage-window + .usage-window { margin-top: 9px; }
  @keyframes pulse { 50% { opacity: .4; } }
  @media (prefers-reduced-motion: reduce) { .skeleton { animation: none; } }
  @media (min-width: 540px) { .windows:has(.usage-window:nth-child(2)) { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
  @media (max-width: 270px) { body { padding: 12px 9px; } .avatar { display: none; } .identity { gap: 7px; } .usage-window { padding: 11px; } .window-caption { display: none; } }
  body.vscode-high-contrast, body.vscode-high-contrast-light { --border: var(--vscode-contrastBorder, var(--text)); --accent: var(--vscode-textLink-foreground, var(--text)); --surface: var(--background); }
`;

function renderAccountHtml(state, nonce, now = new Date()) {
  const account = state.account?.account;
  let content;
  if (!account && state.loading) {
    content = '<div class="loading" role="status" aria-label="Загрузка аккаунта"><span class="skeleton identity-line"></span><div class="usage-window"><span class="skeleton short"></span><span class="skeleton"></span><span class="skeleton track"></span></div><div class="usage-window"><span class="skeleton short"></span><span class="skeleton"></span><span class="skeleton track"></span></div></div>';
  } else if (!account) {
    content = state.error
      ? '<div class="notice" role="status"><strong>Не удалось загрузить аккаунт</strong>Попробуйте обновить данные кнопкой в заголовке панели.</div>'
      : '<div class="notice" role="status"><strong>Войдите в Codex</strong>После входа здесь появятся аккаунт и лимиты подписки.</div>';
  } else {
    const identity = account.email || account.workspaceName || (account.type === 'apiKey' ? 'API key' : 'Аккаунт Codex');
    const plan = account.planType || (account.type === 'apiKey' ? 'API' : null);
    const workspace = account.workspaceName && account.workspaceName !== identity ? `<p class="workspace">${escapeHtml(account.workspaceName)}</p>` : '';
    content = `${state.stale ? '<div class="notice stale" role="status">Не удалось обновить данные. Показаны последние полученные значения.</div>' : ''}
      <header class="identity"><div class="avatar">${userIcon}</div><div class="identity-copy"><p class="eyebrow">Текущий аккаунт</p><span class="email" title="${escapeHtml(identity)}">${escapeHtml(identity)}</span>${workspace}</div>${plan ? `<span class="plan">${escapeHtml(plan)}</span>` : ''}</header>
      ${account.type !== 'chatgpt' ? '<p class="notice">Для этого способа входа лимиты подписки недоступны.</p>' : renderUsage(state.limits, now)}`;
    if (state.updatedAt || state.loading) {
      const updated = state.updatedAt ? new Date(state.updatedAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : null;
      const status = state.loading ? 'Обновление…' : state.stale ? `Последнее обновление в ${updated}` : `Обновлено в ${updated}`;
      content += `<footer class="status" role="status"><span class="status-dot" aria-hidden="true"></span>${escapeHtml(status)}</footer>`;
    }
  }
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'nonce-${nonce}'; base-uri 'none'; form-action 'none'"><title>Аккаунт и лимиты Codex</title><style nonce="${nonce}">${styles}</style></head><body><main class="account-panel">${content}</main></body></html>`;
}

class AccountViewProvider {
  constructor(account) {
    this.account = account;
    this.views = new Set();
    this.changeSubscription = account.onDidChange(() => {
      for (const entry of this.views) if (entry.view.visible) this.render(entry);
    });
  }

  resolveWebviewView(view) {
    view.webview.options = { enableScripts: false, localResourceRoots: [] };
    const entry = { view, nonce: randomBytes(18).toString('hex') };
    this.views.add(entry);
    entry.visibility = view.onDidChangeVisibility(() => {
      if (view.visible) this.render(entry);
      this.syncVisibility();
    });
    entry.disposal = view.onDidDispose(() => {
      entry.visibility.dispose();
      this.views.delete(entry);
      this.syncVisibility();
    });
    this.render(entry);
    this.syncVisibility();
  }

  render(entry) {
    entry.view.webview.html = renderAccountHtml(this.account, entry.nonce);
  }

  syncVisibility() {
    const visible = [...this.views].some((entry) => entry.view.visible);
    if (visible !== this.account.visible) this.account.setVisible(visible);
  }

  dispose() {
    this.changeSubscription.dispose();
    for (const entry of this.views) {
      entry.visibility.dispose();
      entry.disposal.dispose();
    }
    this.views.clear();
    this.account.setVisible(false);
  }
}

module.exports = { AccountViewProvider, renderAccountHtml };
