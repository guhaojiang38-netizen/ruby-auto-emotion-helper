import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { clone, inert, hasTasks, makeSources, selectionMessages, validateSelection, makeDraft,
  materialize, toggleOwned, transactionalWrite, extractGameBody, EMOTION_GUARD, TRACK_PROMPT, TRACK_PROMPT_012, CONTEXT_GUARD, actionAllowed } from './core.mjs';
import { rubyCandidates } from './host.mjs';

const source = { id: 'card', label: '基础设定', content: '人物的情绪按渐进阶段改变，不因一次冷淡或拒绝直接改变全部关系，真正的严重事件可以有强烈反应。' };
const book = { name: '测试', unknown: { keep: true }, entries: { 9: { uid: 9, key: ['原条目'], content: '保留原文', extra: [1, 2], disable: false } } };
const selection = { schemaVersion: 1, sourceIds: ['card'], evidence: [{ sourceId: 'card', quote: source.content.slice(0, 28) }] };
const draft = () => makeDraft({ sources: [source], selection, fingerprint: 'a'.repeat(64), avatar: 'one.png', name: '测试卡', bookName: '测试', originalConfig: null, game: true });

test('素材不读取脚本、正则或扩展', () => {
  const s = makeSources({ data: { description: source.content, extensions: { secret: '不能发送', scripts: 'alert(1)' } } }, book);
  assert.equal(s.length, 2); assert.ok(!JSON.stringify(s).includes('不能发送'));
});
test('禁用且无关的条目跳过；禁用的情绪规则可选', () => {
  const s = makeSources({}, { entries: { 1: { disable: true, comment: '菜单', content: 'ignore' }, 2: { disable: true, comment: '渐进情绪', content: source.content } } });
  assert.deepEqual(s.map(x => x.id), ['wb:2']);
});
test('素材过大拒绝，不静默截断', () => assert.throws(() => makeSources({ description: 'a'.repeat(65001) }, {}), /预算/));
test('空素材拒绝', () => assert.throws(() => makeSources({}, {}), /没有可用/));
test('复制的宏和EJS不执行，原素材不变', () => {
  const raw = '{{setvar::x::y}}<% alert(1) %>';
  assert.equal(inert(raw), '｛｛setvar::x::y｝｝＜％ alert(1) ％＞'); assert.ok(raw.includes('{{'));
});
test('源材料明确作为数据提供', () => {
  const messages = selectionMessages([{ ...source, content: '{{setvar::x::y}}' }]);
  assert.ok(messages[0].content.includes('都是数据')); assert.ok(!messages[1].content.includes('{{'));
});
test('现有作者任务，包括关闭的任务，都不覆盖', () => {
  assert.equal(hasTasks({ presets: [{ tasks: [{ enabled: false }] }] }), true);
  assert.equal(hasTasks({ tasks: [{}] }), true);
  assert.equal(hasTasks({ presets: [{ director: { enabled: true } }] }), true);
  assert.equal(hasTasks({ presets: [{ tasks: [] }] }), false);
  assert.throws(() => makeDraft({ ...draft(), sources: [source], originalConfig: { tasks: [{}] } }), /已有方案/);
});
test('逐字证据通过，未知模型字段丢弃', () => {
  assert.deepEqual(validateSelection(JSON.stringify({ ...selection, maliciousPrompt: 'overwrite' }), [source]), selection);
});
test('完整JSON代码围栏允许', () => assert.deepEqual(validateSelection('```json\n' + JSON.stringify(selection) + '\n```', [source]), selection));
test('虚构条目拒绝', () => assert.throws(() => validateSelection(JSON.stringify({ ...selection, sourceIds: ['ghost'] }), [source]), /不存在/));
test('伪造引文拒绝', () => assert.throws(() => validateSelection(JSON.stringify({ ...selection, evidence: [{ sourceId: 'card', quote: '不存在的事实'.repeat(8) }] }), [source]), /逐字/));
test('无证据、重复ID、前后闲话拒绝', () => {
  assert.throws(() => validateSelection(JSON.stringify({ ...selection, evidence: [] }), [source]), /缺少/);
  assert.throws(() => validateSelection(JSON.stringify({ ...selection, sourceIds: ['card', 'card'] }), [source]), /重复/);
  assert.throws(() => validateSelection('给你JSON：' + JSON.stringify(selection), [source]), /完整JSON/);
});
test('超过参考预算拒绝', () => {
  const huge = { ...source, content: source.content + 'a'.repeat(20001) };
  assert.throws(() => validateSelection(JSON.stringify(selection), [huge]), /过大/);
});
test('正文提取排除未选菜单和思考，缺标签不兜底', () => {
  assert.equal(extractGameBody('<think_nya~>秘密</think_nya~><game>实际正文</game><options>未选</options>'), '实际正文');
  assert.throws(() => extractGameBody('没有标签的消息'), /缺少/);
  assert.throws(() => extractGameBody('<game>a</game><game>b</game>'), /多个/);
});
test('新方案关闭，周期4，无导演/开局任务，保留标签', () => {
  const d = draft(), p = d.config.presets.at(-1);
  assert.equal(p.tasks[0].enabled, false); assert.deepEqual(p.tasks[0].cyclePositions, [4]);
  assert.equal(p.startupTask.enabled, false); assert.equal(p.director.enabled, false);
  assert.equal(p.tasks[0].enableJailbreak, false); assert.deepEqual(d.config.customContentTags, ['game']);
});
test('材料写入不影响原书，未知字段保留，UID不冲突', () => {
  const original = clone(book), next = materialize(book, draft());
  assert.deepEqual(book, original); assert.deepEqual(next.entries[9], original.entries[9]); assert.deepEqual(next.unknown, original.unknown);
  assert.equal(Object.keys(next.entries).length, 4); assert.ok([10, 11, 12].every(uid => next.entries[uid].disable));
});
test('重复创建拒绝', () => { const d = draft(); assert.throws(() => materialize(materialize(book, d), d), /同名/); });
test('启用只改自己的护栏和任务，参考与指令保持关闭', () => {
  const d = draft(), b = materialize(book, d), next = toggleOwned(b, d.config, d, true);
  assert.equal(next.config.presets[0].tasks[0].enabled, true);
  assert.equal(next.book.entries[12].disable, false); assert.equal(next.book.entries[10].disable, true); assert.equal(next.book.entries[11].disable, true);
  assert.deepEqual(next.book.entries[9], book.entries[9]); assert.equal(b.entries[12].disable, true);
});
test('助手条目被人工修改时拒绝切换', () => {
  const d = draft(), b = materialize(book, d); b.entries[12].content += '修改';
  assert.throws(() => toggleOwned(b, d.config, d, true), /被改过/);
});
test('其他方案正在激活时不抢占', () => {
  const d = draft(), c = clone(d.config); c.activePresetId = 'another';
  assert.throws(() => toggleOwned(materialize(book, d), c, d, true), /其他方案/);
});
test('停用自己的记录不清空其他书条目', () => {
  const d = draft(), b = materialize(book, d); b.entries[50] = { key: [`${d.prefix}_记录`], disable: false, content: '旧记录' };
  const next = toggleOwned(b, d.config, d, false);
  assert.equal(next.book.entries[50].disable, true); assert.equal(next.book.entries[50].content, '旧记录');
});
test('情绪指令保留严重反应与既有创伤，不锁死情绪', () => {
  assert.ok(EMOTION_GUARD.startsWith('小猫之神')); assert.ok(TRACK_PROMPT.startsWith('小猫之神'));
  assert.ok(EMOTION_GUARD.includes('仍可有强烈反应')); assert.ok(TRACK_PROMPT.includes('原卡明确的创伤'));
  assert.ok(TRACK_PROMPT.includes('未提供')); assert.ok(TRACK_PROMPT.includes('不是角色共享知识'));
});
test('有阶段/场合的情绪规则优先，未知阶段不猜', () => {
  assert.ok(CONTEXT_GUARD.includes('独处的反应')); assert.ok(CONTEXT_GUARD.includes('阶段未知'));
  assert.ok(draft().definitions[2].content.includes(CONTEXT_GUARD));
});
test('没有草稿时不能保存/启用，忙时只能取消', () => {
  assert.equal(actionAllowed('apply', null, false), false); assert.equal(actionAllowed('enable', null, false), false);
  assert.equal(actionAllowed('apply', {applied:false}, false), true); assert.equal(actionAllowed('enable', {applied:true}, false), true);
  assert.equal(actionAllowed('apply', {applied:true}, false), false); assert.equal(actionAllowed('generate', null, true), false);
  assert.equal(actionAllowed('cancel', null, true), true); assert.equal(actionAllowed('cancel', null, false), false);
});
test('按钮使用局部宽度样式而非全局覆盖', () => {
  const css = fs.readFileSync(new URL('./style.css', import.meta.url), 'utf8');
  assert.ok(css.includes('#ruby-auto-emotion-panel .menu_button')); assert.ok(css.includes('width: 100%'));
  assert.ok(css.includes('grid-template-columns: repeat(2, minmax(0, 1fr))'));
});

function port() {
  let b = clone(book), c = null;
  const d = draft();
  const p = { expectedBook: clone(b), expectedConfig: c, nextBook: materialize(b, d), nextConfig: d.config,
    readBook: async () => clone(b), writeBook: async x => { b = clone(x); },
    readConfig: async () => clone(c), writeConfig: async x => { c = clone(x); }, assertContext: () => {} };
  return { p, get: () => ({ book: b, config: c }), changeBook: x => { b = clone(x); }, changeConfig: x => { c = clone(x); } };
}
test('成功写入后复读核验', async () => { const x = port(); await transactionalWrite(x.p); assert.deepEqual(x.get().config, x.p.nextConfig); });
test('预览后变化时零写入', async () => {
  const x = port(); x.changeBook({ ...book, external: true });
  await assert.rejects(transactionalWrite(x.p), /发生变化/); assert.equal(x.get().config, null); assert.equal(x.get().book.external, true);
});
test('第二步失败时回退第一步', async () => {
  const x = port(); x.p.writeConfig = async () => { throw new Error('模拟失败'); };
  await assert.rejects(transactionalWrite(x.p), /条件回退/); assert.deepEqual(x.get().book, book);
});
test('服务器写完再报错，仍可条件回退', async () => {
  const x = port(), original = x.p.writeBook; let first = true;
  x.p.writeBook = async b => { await original(b); if (first) { first = false; throw new Error('回包中断'); } };
  await assert.rejects(transactionalWrite(x.p), /条件回退/); assert.deepEqual(x.get().book, book);
});
test('第二步已写但回包中断，条件回退两步', async () => {
  const x = port(), original = x.p.writeConfig; let first = true;
  x.p.writeConfig = async c => { await original(c); if (first) { first = false; throw new Error('回包中断'); } };
  await assert.rejects(transactionalWrite(x.p), /条件回退/); assert.deepEqual(x.get().book, book); assert.equal(x.get().config, null);
});
test('并发外部修改不能被回退覆盖', async () => {
  const x = port(); x.p.writeConfig = async () => { x.changeBook({ ...x.p.nextBook, foreign: true }); throw new Error('写入失败'); };
  await assert.rejects(transactionalWrite(x.p), /不覆盖并发/); assert.equal(x.get().book.foreign, true);
});
test('换卡发生在写书后，不写到新卡', async () => {
  const x = port(); let checks = 0;
  x.p.assertContext = () => { if (++checks >= 3) throw new Error('切换了卡'); };
  await assert.rejects(transactionalWrite(x.p), /条件回退/); assert.equal(x.get().config, null); assert.deepEqual(x.get().book, book);
});
test('回退本身失败时不谎报成功', async () => {
  const x = port(), original = x.p.writeBook; let count = 0;
  x.p.writeBook = async b => { if (++count > 1) throw new Error('不能回退'); await original(b); };
  x.p.writeConfig = async () => { throw new Error('失败'); };
  await assert.rejects(transactionalWrite(x.p), /回退未完成/);
});
test('仅识别同源安全RUBY路径，不导入远程脚本', () => {
  const doc = { querySelectorAll: () => [{ src: 'http://localhost/scripts/extensions/third-party/RUBY/index.js' }, { src: 'https://evil.test/scripts/extensions/third-party/evil/index.js' }] };
  assert.deepEqual(rubyCandidates(doc, 'http://localhost'), ['RUBY']);
  assert.throws(() => rubyCandidates(doc, 'http://localhost', '../evil'), /不合格/);
});
test('入口不使用卡片HTML执行，不连接安装端点', () => {
  const sourceText = fs.readFileSync(new URL('./index.js', import.meta.url), 'utf8') + fs.readFileSync(new URL('./host.mjs', import.meta.url), 'utf8');
  assert.ok(!sourceText.includes('innerHTML')); assert.ok(!sourceText.includes('/api/extensions/install'));
  assert.ok(!sourceText.includes('eval(')); assert.ok(!sourceText.includes('new Function('));
});

// Optional compatibility check against the inspected local upstream checkout.
test('叙事隔离保留机器字段与故事内真实名称，提示词保持小猫单行', async () => {
  const {guardText,NARRATIVE_BOUNDARY} = await import('./core.mjs');
  assert.ok(NARRATIVE_BOUNDARY.includes('剧情摘要')); assert.ok(NARRATIVE_BOUNDARY.includes('变量键、阶段值、JSONPatch和状态栏照旧保留'));
  assert.ok(NARRATIVE_BOUNDARY.includes('人物知道的名称仍可正常说'));
  assert.ok(!/[\r\n]/.test(guardText())); assert.ok(!/[\r\n]/.test(TRACK_PROMPT));
});
test('轻调情绪不抹除旧愧疚，选项保留数量与神人操作并约束道具', async () => {
  const {EMOTION_RECOVERY,CONTINUITY_GUARD} = await import('./core.mjs');
  assert.ok(EMOTION_RECOVERY.includes('短暂放松也不等于和好')); assert.ok(EMOTION_RECOVERY.includes('不强迫快乐'));
  assert.ok(CONTINUITY_GUARD.includes('检查漏买不等于已经买齐')); assert.ok(CONTINUITY_GUARD.includes('现有选项数量和神人操作'));
  assert.ok(TRACK_PROMPT.includes('不把计划、检查或未选选项记成完成'));
});
function legacyRuleFixture() {
  const d = draft(); d.rulesRevision = '0.1.2'; d.definitions[1].content = TRACK_PROMPT_012;
  const b = materialize(book,d), c = clone(d.config); c.presets[0].tasks[0].enabled = true;
  Object.values(b.entries).find(e=>e.constant).disable = false;
  return {d,b,c};
}
test('同步只更新自有两段文字，保留原书、参考、开关与任务配置', async () => {
  const {refreshOwnedRules,guardText} = await import('./core.mjs');
  const {d,b,c} = legacyRuleFixture(), before = clone({d,b,c});
  const next = refreshOwnedRules(b,c,d);
  assert.deepEqual({d,b,c},before); assert.deepEqual(next.book.entries[9],b.entries[9]);
  for(const [uid,e] of Object.entries(b.entries)) {
    const got=next.book.entries[uid]; assert.equal(got.disable,e.disable); assert.equal(got.key[0],e.key[0]);
    if(e.key[0]?.endsWith('_参考')) assert.deepEqual(got,e);
  }
  assert.equal(next.draft.definitions[2].content,guardText()); assert.equal(c.presets[0].tasks[0].enabled,true);
  assert.equal(actionAllowed('refresh',null,false),false); assert.equal(actionAllowed('refresh',{applied:true},false),true);
});
test('离线已升级时可以同步旧草稿，重复同步不增加条目', async () => {
  const {refreshOwnedRules} = await import('./core.mjs'); const {d,b,c}=legacyRuleFixture();
  const next=refreshOwnedRules(b,c,d), adopted=refreshOwnedRules(next.book,c,d);
  assert.deepEqual(adopted,next); assert.deepEqual(refreshOwnedRules(next.book,c,next.draft),next);
});
test('同步拒绝人工修改过的助手条目和改写过的任务键', async () => {
  const {refreshOwnedRules} = await import('./core.mjs'); const {d,b,c}=legacyRuleFixture();
  const changed=clone(b); Object.values(changed.entries).find(e=>e.constant).content='人工改过';
  assert.throws(()=>refreshOwnedRules(changed,c,d),/人工改过/);
  const config=clone(c); config.presets[0].tasks[0].outputKey='其他任务输出';
  assert.throws(()=>refreshOwnedRules(b,config,d),/任务已被修改/);
});
test('同步拒绝所有权不符，不覆盖作者条目', async () => {
  const {refreshOwnedRules} = await import('./core.mjs'); const {d,b,c}=legacyRuleFixture();
  const changed=clone(b); Object.values(changed.entries).find(e=>e.constant).rubyAutoOwner='author';
  assert.throws(()=>refreshOwnedRules(changed,c,d),/数量不符/);
});
test('本地匹配选真实阶段与场合依据，不把运行脚本作为人设', async () => {
  const {localSelection} = await import('./core.mjs');
  const sources = [{id:'a',label:'规则/行为演变',content:'阶段必须渐进，情绪不可提前跳变。'.repeat(3)},
    {id:'b',label:'角色/三面性',content:'工作场合保持克制，独处可以难过，不强迫人物冷静。'},
    {id:'c',label:'Scripts/变量结构.js',content:'人物情绪阶段情绪崩溃'.repeat(8)}];
  const s = localSelection(sources); assert.deepEqual(s.sourceIds,['a','b']);
  assert.doesNotThrow(()=>validateSelection(JSON.stringify(s),sources));
  assert.throws(()=>localSelection([sources[2]]),/没有识别/);
});
test('酒馆预组装提示词不算真实生成，不占用助手', async () => {
  const {isLiveGenerationEvent} = await import('./core.mjs');
  assert.equal(isLiveGenerationEvent(true), false);
  assert.equal(isLiveGenerationEvent(false), true);
  assert.equal(isLiveGenerationEvent(undefined), true);
});
test('仅原样作者首楼允许无game，生成消息不能借此绕过', async () => {
  const {assertGameReady} = await import('./core.mjs');
  const greeting = '原样开场白';
  assert.equal(assertGameReady([{mes:greeting}], greeting), 'exact-author-greeting');
  assert.throws(() => assertGameReady([{mes:'生成的无标签回复'}], greeting), /缺少/);
  assert.throws(() => assertGameReady([{mes:greeting},{is_user:true,mes:'你好'},{mes:greeting}], greeting), /缺少/);
  assert.throws(() => assertGameReady([{mes:greeting}], null), /缺少/);
  assert.equal(assertGameReady([{mes:'<game>实际正文</game>'}], greeting), 'game-body');
});
const rubyPath = process.env.RFA_RUBY_SOURCE;
if (rubyPath) test('真实RUBY标准化保留本助手关键字段', async () => {
  const cfg = await import(pathToFileURL(`${rubyPath}/src/config.js`).href);
  const normalized = cfg.normalizeConfigData(draft().config), p = normalized.presets.find(p => p.id === draft().presetId);
  assert.ok(p); assert.equal(p.tasks[0].enabled, false); assert.deepEqual(p.tasks[0].cyclePositions, [4]);
  assert.deepEqual(p.tasks[0].useReferences, ['rfa_card_reference']); assert.deepEqual(p.tasks[0].useOutputs, ['task_1_Output']);
  assert.deepEqual(normalized.customContentTags, ['game']); assert.equal(p.startupTask.enabled, false); assert.equal(p.director.enabled, false);
});

test('空origin使用已核对的主文档URL，仍拒绝异源和无效基准', () => {
  const doc = {baseURI:'http://localhost:8000/', querySelectorAll:() => [
    {src:'/scripts/extensions/third-party/RUBY/index.js'},
    {src:'https://foreign.test/scripts/extensions/third-party/other/index.js'},
    {src:'http://['},
  ]};
  assert.deepEqual(rubyCandidates(doc,'null'),['RUBY']);
  assert.throws(()=>rubyCandidates({...doc,baseURI:'about:srcdoc'},'null'),/基准无效/);
  assert.throws(()=>rubyCandidates({...doc,baseURI:'https://foreign.test/'},'http://localhost:8000'),/来源不一致/);
});

test('配置未变时不写配置；切卡仍条件恢复原书', async () => {
  const x=port(); x.p.nextConfig=null;
  let writes=0,checks=0;
  x.p.writeConfig=async()=>{writes++;throw new Error('切卡后不可写配置');};
  x.p.assertContext=()=>{if(++checks>=3)throw new Error('切换了卡');};
  await assert.rejects(transactionalWrite(x.p),/条件回退/);
  assert.equal(writes,0); assert.deepEqual(x.get().book,book); assert.equal(x.get().config,null);
});

test('只更新世界书时零配置写入，同时检测配置并发变化', async () => {
  const x=port(); x.p.nextConfig=null; let writes=0;
  x.p.writeConfig=async()=>{writes++;};
  await transactionalWrite(x.p); assert.equal(writes,0);
  const y=port(); y.p.nextConfig=null;
  const write=y.p.writeBook;
  y.p.writeBook=async b=>{await write(b);y.changeConfig({foreign:true});};
  await assert.rejects(transactionalWrite(y.p),/不覆盖并发/);
  assert.deepEqual(y.get().config,{foreign:true});
});

test('草稿和书一起被手改也不冒认成已知版本', async () => {
  const {refreshOwnedRules}=await import('./core.mjs'); const {d,b,c}=legacyRuleFixture();
  d.definitions[1].content='人工分析规则'; b.entries[11].content='人工分析规则';
  assert.throws(()=>refreshOwnedRules(b,c,d),/已知版本/);
});

test('同步拒绝改键和重复条目，启停拒绝多余自有条目与改输出键', async () => {
  const {refreshOwnedRules}=await import('./core.mjs'); const {d,b,c}=legacyRuleFixture();
  const extra=clone(b); extra.entries[60]=clone(b.entries[11]);
  assert.throws(()=>refreshOwnedRules(extra,c,d),/数量不符/);
  assert.throws(()=>toggleOwned(extra,c,d,true),/数量不符/);
  const keyed=clone(b); keyed.entries[11].key.push('别名');
  assert.throws(()=>refreshOwnedRules(keyed,c,d),/人工改过/);
  const changed=clone(c); changed.presets[0].tasks[0].outputKey='foreign';
  assert.throws(()=>toggleOwned(b,changed,d,true),/已被修改/);
});

test('已核对0.1.1旧草稿可迁移，含世界书已更新0.1.2的组合', async () => {
  const old={TRACK_PROMPT:TRACK_PROMPT_012.split(' 接续记录用具体反应')[0],EMOTION_GUARD,CONTEXT_GUARD};
  const {refreshOwnedRules,guardText}=await import('./core.mjs'); const {d,b,c}=legacyRuleFixture();
  d.definitions[1].content=old.TRACK_PROMPT;
  d.definitions[2].content=`${old.EMOTION_GUARD}\n${old.CONTEXT_GUARD}`;
  assert.equal(refreshOwnedRules(b,c,d).draft.rulesRevision,'0.1.3');
  b.entries[11].content=d.definitions[1].content; b.entries[12].content=d.definitions[2].content;
  assert.equal(refreshOwnedRules(b,c,d).book.entries[12].content,guardText());
});

test('RUBY任务运行中，同步在任何宿主读取前停止', async () => {
  const {refreshRules}=await import('./host.mjs');
  await assert.rejects(refreshRules({engine:{getEngineState:()=>({running:true})}},{applied:true}),/仍在运行/);
});
