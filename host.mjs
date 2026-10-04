import { clone, hasTasks, makeSources, selectionMessages, validateSelection,
  makeDraft, materialize, toggleOwned, transactionalWrite, extractGameBody } from './core.mjs';

// Only the already-installed, same-origin RUBY 1.8.0 is imported. No remote loader.
export function rubyCandidates(doc, origin, explicitFolder = '') {
  const names = new Set();
  if (explicitFolder) {
    if (!/^[\w.-]+$/.test(explicitFolder) || explicitFolder === '.' || explicitFolder === '..') throw new Error('RUBY目录名不合格。');
    names.add(explicitFolder);
  } else for (const script of doc.querySelectorAll('script[src]')) {
    const url = new URL(script.src, origin);
    const match = url.pathname.match(/^\/scripts\/extensions\/third-party\/([\w.-]+)\/index\.js$/);
    if (url.origin === origin && match) names.add(match[1]);
  }
  return [...names];
}

export function context() {
  const c = globalThis.SillyTavern?.getContext?.();
  const required = ['getRequestHeaders', 'saveWorldInfo', 'writeExtensionFieldBulk', 'getExtensionManifest', 'getCurrentChatId'];
  if (!c || required.some(k => typeof c[k] !== 'function') || c.constants?.unset === undefined) throw new Error('酒馆缺少测试版需要的API；目标版本是1.18.0，请先核对版本。');
  return c;
}

async function post(path, data) {
  const response = await fetch(path, { method: 'POST', headers: context().getRequestHeaders(), body: JSON.stringify(data), cache: 'no-store' });
  if (!response.ok) throw new Error('酒馆读写请求失败；没有继续下一步。');
  return response.json();
}
const readCard = avatar => post('/api/characters/get', { avatar_url: avatar });
const readBook = name => post('/api/worldinfo/get', { name });
const cardConfig = card => clone(card?.data?.extensions?.RubyAnalyzer ?? null);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
let mainGenerating = false;
export function markGenerating(value) { mainGenerating = !!value; }

async function sha(text) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function connect(folder = '') {
  const c = context();
  const found = [];
  for (const name of rubyCandidates(document, location.origin, folder)) {
    const manifest = c.getExtensionManifest(`third-party/${name}`);
    if (manifest?.display_name === 'RUBY Analyzer') found.push({ name, manifest });
  }
  if (found.length !== 1) throw new Error('没有唯一识别到已安装的RUBY；请填写它在third-party下的实际目录名。');
  const { name, manifest } = found[0];
  if (manifest.version !== '1.8.0') throw new Error('当前适配只核对过RUBY 1.8.0，其他版本先不要写入。');
  if (c.extensionSettings?.disabledExtensions?.some(n => n === name || n === `third-party/${name}`)) throw new Error('RUBY处于停用状态，请先在扩展管理器核对。');
  const base = new URL(`/scripts/extensions/third-party/${name}/src/`, location.origin);
  const [config, ai, worldbook, engine] = await Promise.all(['config.js', 'ai.js', 'worldbook.js', 'engine.js'].map(p => import(new URL(p, base).href)));
  if (typeof ai.callModel !== 'function' || typeof config.normalizePreset !== 'function' || typeof worldbook.getCharBookName !== 'function' || typeof engine.reinit !== 'function') throw new Error('RUBY模块形状与已核对版本不一致。');
  return { config, ai, worldbook, engine };
}

export function identity() {
  const c = context(), card = c.characters?.[c.characterId];
  if (c.groupId || !card?.avatar || !c.getCurrentChatId()) throw new Error('请打开单角色测试副本的聊天；群聊暂不支持。');
  return { avatar: card.avatar, name: card.name, chatId: c.getCurrentChatId() };
}

function assertIdentity(id, cancelled) {
  const now = identity();
  if (cancelled?.() || now.avatar !== id.avatar || now.chatId !== id.chatId) throw new Error('已取消或切换了卡片/聊天，本次不继续操作。');
}

function assertIdle(ruby) {
  if (mainGenerating || ruby.engine.getEngineState?.().running) throw new Error('正文或RUBY任务仍在运行，请等它结束再操作。');
}

async function snapshot(ruby, id, cancelled) {
  assertIdentity(id, cancelled); assertIdle(ruby);
  const bookName = await ruby.worldbook.getCharBookName();
  assertIdentity(id, cancelled);
  if (!bookName) throw new Error('这张卡没有主世界书；测试版不会替你自动绑定或创建它。');
  const shared = context().characters.filter(c => c.avatar !== id.avatar && c.data?.extensions?.world === bookName);
  if (shared.length) throw new Error('主世界书被其他卡共用；请先复制并给测试卡单独绑定，避免影响其他卡。');
  const card = await readCard(id.avatar), book = await readBook(bookName);
  const sources = makeSources(card, book);
  const fingerprint = await sha(JSON.stringify({ avatar: id.avatar, bookName, sources }));
  assertIdentity(id, cancelled);
  return { id, bookName, book, rawConfig: cardConfig(card), sources, fingerprint };
}

export async function generate(ruby, { game, cancelled, progress }) {
  const id = identity(), captured = await snapshot(ruby, id, cancelled);
  const legacy = context().extensionSettings?.RubyAnalyzer?.characterConfigs?.[id.avatar];
  if (hasTasks(captured.rawConfig) || hasTasks(legacy)) throw new Error('这张卡已有卡内或旧版本地任务，已跳过；不会改作者方案。');
  // One logical model call. RUBY itself can retry network transport internally.
  progress?.(`准备发送 ${captured.sources.length} 项设定，共 ${captured.sources.reduce((n, s) => n + s.content.length, 0)} 字符；只选参考，不续写。`);
  let text;
  try {
    text = await ruby.ai.callModel({ apiCfg: ruby.config.getApiConfig(), genParams: { temperature: 0.2, max_tokens: 1600 },
      messages: selectionMessages(captured.sources), taskLabel: '自动补方案·选择情绪参考' });
  } catch { throw new Error('参考选择调用失败；没有保存或写卡。停止按钮不能保证撤销已经发出的模型请求。'); }
  assertIdentity(id, cancelled);
  const selection = validateSelection(text, captured.sources);
  const fresh = await snapshot(ruby, id, cancelled);
  if (fresh.fingerprint !== captured.fingerprint || !same(fresh.rawConfig, captured.rawConfig) || !same(fresh.book, captured.book)) throw new Error('生成期间素材或方案有变化，请重新生成。');
  const draft = makeDraft({ ...captured, avatar: id.avatar, name: id.name, originalConfig: captured.rawConfig, selection, game });
  // Normalize only the new owned scheme, not any unrelated saved fields.
  const index = draft.config.presets.findIndex(p => p.id === draft.presetId);
  draft.config.presets[index] = ruby.config.normalizePreset(draft.config.presets[index]);
  const state = { draft, id, expectedBook: captured.book, applied: false };
  await storeState(id.avatar, state);
  return state;
}

function ports(state, cancelled) {
  const assertContext = () => assertIdentity(state.id, cancelled);
  return {
    assertContext,
    readBook: () => readBook(state.draft.bookName),
    writeBook: b => context().saveWorldInfo(state.draft.bookName, clone(b), true),
    readConfig: async () => cardConfig(await readCard(state.id.avatar)),
    writeConfig: async raw => {
      const result = await context().writeExtensionFieldBulk([state.id.avatar], 'RubyAnalyzer', raw === null ? context().constants.unset : clone(raw));
      if (!result?.updated?.includes(state.id.avatar) || result.failed?.length) throw new Error('单卡方案保存没有得到成功回执。');
    },
  };
}

export async function apply(ruby, state, cancelled) {
  if (!state || state.applied) throw new Error('没有待应用草稿，或这份方案已经保存。');
  assertIdle(ruby);
  const now = await snapshot(ruby, state.id, cancelled);
  if (now.fingerprint !== state.draft.fingerprint) throw new Error('素材改变，请重新生成。');
  const nextBook = materialize(state.expectedBook, state.draft);
  // Persistent local backup precedes all server writes. No credentials are captured.
  await storeBackup(state.id.avatar, { time: new Date().toISOString(), bookName: state.draft.bookName,
    book: state.expectedBook, config: state.draft.originalConfig, avatar: state.id.avatar });
  await transactionalWrite({ ...ports(state, cancelled), expectedBook: state.expectedBook,
    expectedConfig: state.draft.originalConfig, nextBook, nextConfig: state.draft.config });
  state.applied = true;
  ruby.engine.reinit();
  try { await storeState(state.id.avatar, state); }
  catch { throw new Error('方案已写入并核验，但本地状态保存失败；不要重复生成，请检查导出的备份和RUBY面板。'); }
}

export async function toggle(ruby, state, enabled, cancelled) {
  if (!state?.applied) throw new Error('请先保存关闭状态的方案。');
  assertIdle(ruby);
  const now = await snapshot(ruby, state.id, cancelled);
  if (now.fingerprint !== state.draft.fingerprint) throw new Error('原卡素材有变化，请先人工核对；本次不切换。');
  if (enabled && state.draft.game) {
    const latest = [...(context().chat || [])].reverse().find(m => !m.is_user && !m.is_system);
    if (latest) extractGameBody(latest.mes);
  }
  const next = toggleOwned(now.book, now.rawConfig, state.draft, enabled);
  await storeBackup(state.id.avatar, { time: new Date().toISOString(), bookName: now.bookName,
    book: now.book, config: now.rawConfig, avatar: state.id.avatar });
  await transactionalWrite({ ...ports(state, cancelled), expectedBook: now.book,
    expectedConfig: now.rawConfig, nextBook: next.book, nextConfig: next.config });
  ruby.engine.reinit();
  if (!enabled) {
    // Output lives in the current CHAT book, not in the primary character book.
    const chatBookName = await ruby.worldbook.getExistingChatBookName();
    assertIdentity(state.id, cancelled);
    if (chatBookName) {
      const old = await readBook(chatBookName), after = clone(old);
      for (const e of Object.values(after.entries || {})) if (e.key?.includes(`${state.draft.prefix}_记录`)) e.disable = true;
      if (!same(old, after)) {
        await storeBackup(`${state.id.avatar}:chat`, { bookName: chatBookName, book: old, time: new Date().toISOString() });
        assertIdentity(state.id, cancelled);
        if (!same(await readBook(chatBookName), old)) throw new Error('任务已停用，但聊天书出现并发修改，旧记录请手动关闭。');
        await context().saveWorldInfo(chatBookName, after, true);
        if (!same(await readBook(chatBookName), after)) throw new Error('任务已停用，但旧聊天记录关闭未通过核验，请手动检查。');
      }
    }
  }
}

// Own IndexedDB, not RUBY settings. State and backups are private local data.
async function dbAction(mode, action) {
  const db = await new Promise((resolve, reject) => {
    const request = indexedDB.open('ruby-auto-emotion-helper', 1);
    request.onupgradeneeded = () => request.result.createObjectStore('data');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('本地草稿/备份数据库不可用，已停止。'));
  });
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction('data', mode), request = action(tx.objectStore('data'));
      tx.oncomplete = () => resolve(request.result);
      tx.onabort = tx.onerror = () => reject(new Error('本地草稿/备份保存失败，已停止。'));
    });
  } finally { db.close(); }
}
const storeState = (avatar, state) => dbAction('readwrite', s => s.put(clone(state), `state:${avatar}`));
const storeBackup = (avatar, backup) => dbAction('readwrite', s => s.put(clone(backup), `backup:${avatar}:${Date.now()}`));
export async function restore() {
  const id = identity(), state = await dbAction('readonly', s => s.get(`state:${id.avatar}`));
  if (!state || state.draft?.owner !== 'ruby-auto-emotion-v1' || state.draft?.avatar !== id.avatar) throw new Error('这张卡没有本助手保存的草稿。');
  // A saved scheme is card-level, but every action captures the currently opened chat again.
  state.id = id;
  return state;
}

export async function backupExport() {
  return dbAction('readonly', s => s.getAll());
}
