import * as host from './host.mjs';

let panel, output, preview, folder, game, busy = false, epoch = 0, state = null;
let listeners = [], buttons = [];
const el = (tag, text) => { const n = document.createElement(tag); if (text) n.textContent = text; return n; };
function say(text) { if (output) output.textContent = text; }
function show() {
  if (!preview) return;
  preview.textContent = state ? `卡片：${state.draft.name}\n主世界书：${state.draft.bookName}\n参考：${state.draft.selection.sourceIds.join('、')}\n状态：${state.applied ? '已保存，启用状态请看RUBY面板' : '仅本地草稿，尚未写卡'}\n\n常驻正文护栏：\n${state.draft.definitions[2].content}\n\n分析指令：\n${state.draft.definitions[1].content}` : '尚未生成草稿。';
}
function lock(value) { busy = value; for (const b of buttons) b.disabled = value; if (folder) folder.disabled = value; if (game) game.disabled = value; }
async function work(action) {
  if (busy) return;
  const captured = epoch;
  lock(true);
  try { await action(() => captured !== epoch); }
  catch (error) { say(error?.message || '操作失败，没有继续。'); }
  finally { lock(false); show(); }
}
function download(value) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
  const a = el('a'); a.href = url; a.download = 'RUBY自动助手-私人备份.json'; document.body.append(a); a.click(); a.remove();
  // A next-turn cleanup is sufficient; no persistent URL or timer.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
function mount() {
  if (panel) return;
  const parent = document.querySelector('#extensions_settings2');
  if (!parent) return;
  panel = el('details'); panel.id = 'ruby-auto-emotion-panel';
  panel.append(el('summary', 'RUBY 自动补方案 · 渐进情绪（测试）'));
  panel.append(el('p', '独立助手，不是RUBY官方功能。已有作者任务会跳过；生成只存本地，保存方案后仍关闭。建议先用角色卡及主世界书的独立副本。'));
  const label = el('label', 'RUBY实际目录名（识别不到时填写）：');
  folder = el('input'); folder.placeholder = '例如 RUBY'; label.append(folder); panel.append(label);
  const tagLabel = el('label', ' 使用小猫正文 <game> 标签（没有该格式的卡不要勾）');
  game = el('input'); game.type = 'checkbox'; tagLabel.prepend(game); panel.append(tagLabel);
  output = el('p', '未调用模型、未写入。'); output.setAttribute('role', 'status'); output.setAttribute('aria-live', 'polite');
  preview = el('pre'); preview.style.whiteSpace = 'pre-wrap'; preview.style.maxHeight = '22rem'; preview.style.overflow = 'auto';
  const add = (text, action) => { const b = el('button', text); b.type = 'button'; b.className = 'menu_button'; b.addEventListener('click', () => work(action)); panel.append(b); buttons.push(b); };
  add('自动选参考并生成草稿', async cancelled => {
    if (!window.confirm('会把当前卡的基础设定和主世界书候选素材发送到RUBY现有模型连接。可能计费；只有一次逻辑调用，RUBY自身可能重试。生成不写卡。继续吗？')) return;
    const ruby = await host.connect(folder.value.trim());
    state = await host.generate(ruby, { game: game.checked, cancelled, progress: say });
    say('草稿已存本地，请检查下面规则。没有写卡或启用。');
  });
  add('读取这张卡的已有草稿', async () => { state = await host.restore(); game.checked = state.draft.game; say('已读取本地草稿，切换动作前仍会核对当前卡。'); });
  add('保存关闭状态的方案', async cancelled => {
    if (!state) throw new Error('请先生成或读取草稿。');
    if (!window.confirm(`目标：${state.draft.name}；主世界书：${state.draft.bookName}。将新增三个关闭条目及一个关闭的卡内RUBY方案，先保存本地备份。原正文不改。确认这是测试副本并保存吗？`)) return;
    await host.apply(await host.connect(folder.value.trim()), state, cancelled);
    say('方案已写入并核验，任务和正文护栏仍关闭。');
  });
  add('启用这一份方案', async cancelled => {
    if (!window.confirm('启用后正文会收到情绪护栏；RUBY每4条AI回复运行一次分析，使用现有模型连接，可能计费。旧楼层不会重写。继续吗？')) return;
    await host.toggle(await host.connect(folder.value.trim()), state, true, cancelled); say('已启用并核对文件保存；真实情绪表现还需要试玩。');
  });
  add('停用这一份方案', async cancelled => { await host.toggle(await host.connect(folder.value.trim()), state, false, cancelled); say('本助手任务、护栏和当前聊天中的同名分析输出已停用；其他聊天的历史记录需要各自检查。'); });
  add('导出本地草稿及备份', async () => { download(await host.backupExport()); say('私人备份已导出，可能包含卡片世界书，不要公开上传。'); });
  const stop = el('button', '取消等待/丢弃结果'); stop.type = 'button'; stop.className = 'menu_button';
  stop.addEventListener('click', () => { epoch++; say('已请求取消后续动作。已发出的模型请求可能继续计费；写入若已开始会按条件回退，请等操作结束。'); }); panel.append(stop);
  panel.append(output, preview); parent.append(panel); show();
}

export function onActivate() {
  if (listeners.length || panel) return;
  const c = globalThis.SillyTavern?.getContext?.();
  if (!c?.eventSource || !c.eventTypes) return;
  const bind = (event, fn) => { if (event) { c.eventSource.on(event, fn); listeners.push([c.eventSource, event, fn]); } };
  bind(c.eventTypes.APP_READY, mount);
  bind(c.eventTypes.GENERATION_STARTED, () => host.markGenerating(true));
  bind(c.eventTypes.GENERATION_ENDED, () => host.markGenerating(false));
  bind(c.eventTypes.GENERATION_STOPPED, () => host.markGenerating(false));
  bind(c.eventTypes.CHAT_CHANGED, () => { epoch++; state = null; say('聊天已切换，旧草稿不会自动应用，请重新读取当前卡草稿。'); show(); });
  mount();
}
export function onDisable() {
  epoch++;
  host.markGenerating(false);
  for (const [source, event, fn] of listeners) source.removeListener(event, fn);
  listeners = []; buttons = []; panel?.remove(); panel = output = preview = folder = game = null; state = null;
  // Deliberately does not mutate cards/books or cancel another plugin's model call.
}
