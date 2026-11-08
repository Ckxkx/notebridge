const test=require('node:test');
const assert=require('node:assert/strict');
const {mergeRecords,renameRecords}=require('./sync.cjs');
const state=(dates={},targets={},baselines={},extra={})=>({version:1,dates,targets,baselines,...extra});
const a='a'.repeat(40),b='b'.repeat(40),path='source/_posts/a.md';
test('采用 GitHub 当前基线而不是较旧设备的记录',()=>{
 const old=state({'blog/a.md':'2026-01-01'},{'blog/a.md':path},{[path]:a});
 const newer=state({'blog/a.md':'2026-01-01'},{'blog/a.md':path},{[path]:b});
 assert.equal(mergeRecords([old,newer],new Map([[path,b]])).baselines[path],b);
});
test('远端修改尚未同步记录时拒绝采用不可信基线',()=>{
 const old=state({}, {'blog/a.md':path},{[path]:a});
 assert.throws(()=>mergeRecords([old],new Map([[path,b]])),/GitHub 不一致/);
 assert.throws(()=>mergeRecords([old],new Map()),/GitHub 不一致/);
});
test('设备的路径或日期不一致时拒绝猜测',()=>{
 assert.throws(()=>mergeRecords([state({'blog/a.md':'date1'}),state({'blog/a.md':'date2'})],new Map()),/记录冲突/);
 assert.throws(()=>mergeRecords([state({}, {'blog/a.md':'x'}),state({}, {'blog/a.md':'y'})],new Map()),/记录冲突/);
});
test('拒绝两个本地文章共用一个远端路径',()=>{
 assert.throws(()=>mergeRecords([state({}, {'blog/a.md':path,'blog/b.md':path},{[path]:a})],new Map([[path,a]])),/同一远端路径/);
});
test('为指定文章保留旧基线供冲突预览，其他未知改动仍拒绝',()=>{
 const original=state({}, {'blog/a.md':path},{[path]:a});
 assert.equal(mergeRecords([original],new Map([[path,b]]),{path,baseline:a}).baselines[path],a);
 assert.throws(()=>mergeRecords([original],new Map([[path,b]]),{path,baseline:'c'.repeat(40)}),/GitHub 不一致/);
});
test('跨设备合并只保留与当前基线对应的已确认合并记录',()=>{
 const prior={base:'old local',merged:'old output',hash:a},latest={base:'new local',merged:'new output',hash:b};
 const one=state({}, {'blog/a.md':path},{[path]:a},{overlays:{[path]:prior}});
 const two=state({}, {'blog/a.md':path},{[path]:b},{overlays:{[path]:latest}});
 assert.deepEqual(mergeRecords([one,two],new Map([[path,b]])).overlays[path],latest);
});
test('已发布文章改名后保留远端路径、日期和基线',()=>{
 const source='blog/旧名.md',next='blog/新名.md',original=state({[source]:'2026-01-01'},{[source]:path},{[path]:a},{targetOverrides:{[source]:path}});
 const renamed=renameRecords(original,source,next,false);
 assert.equal(renamed.targets[next],path);assert.equal(renamed.dates[next],'2026-01-01');assert.equal(renamed.baselines[path],a);assert.equal(renamed.renames[source],next);assert.equal(renamed.targets[source],undefined);assert.equal(original.targets[source],path);
});
test('跨设备同步时旧路径映射归并到新路径',()=>{
 const source='blog/旧名.md',next='blog/新名.md',old=state({[source]:'date'},{[source]:path},{[path]:a});const renamed=renameRecords(old,source,next,false);
 const merged=mergeRecords([old,renamed],new Map([[path,a]]));assert.deepEqual(merged.targets,{[next]:path});assert.equal(merged.renames[source],next);
});
test('文件夹改名保留子文章目标，不修改相邻路径',()=>{
 const old=state({}, {'blog/目录/a.md':path,'blog/目录外/b.md':'b.md'},{[path]:a});
 const renamed=renameRecords(old,'blog/目录','blog/新目录',true);assert.equal(renamed.targets['blog/新目录/a.md'],path);assert.equal(renamed.targets['blog/目录外/b.md'],'b.md');
});
test('目标路径已有记录或两台设备改名不一致时拒绝猜测',()=>{
 const source='blog/旧.md',old=state({[source]:'d','blog/已有.md':'x'},{[source]:path},{[path]:a});assert.throws(()=>renameRecords(old,source,'blog/已有.md',false),/已有记录/);
 const one=renameRecords(old,source,'blog/新甲.md',false),two=renameRecords(old,source,'blog/新乙.md',false);assert.throws(()=>mergeRecords([one,two],new Map([[path,a]])),/重命名记录冲突/);
});
test('确认清理旧关联后，同步旧设备快照不会恢复旧记录',()=>{
 const old='blog/旧.md',current='blog/新.md',oldTarget='source/_posts/old.md',newTarget='source/_posts/new.md';
 const stale=state({[old]:'old-date',[current]:'new-date'},{[old]:oldTarget,[current]:newTarget},{[oldTarget]:a,[newTarget]:b});
 const cleaned=state({[current]:'new-date'},{[current]:newTarget},{[newTarget]:b},{retiredSources:{[old]:oldTarget}});
 const merged=mergeRecords([cleaned,stale],new Map([[newTarget,b]]));assert.deepEqual(merged.targets,{[current]:newTarget});assert.equal(merged.baselines[oldTarget],undefined);assert.equal(merged.retiredSources[old],oldTarget);
});
test('旧路径被另一条不同记录使用时停止清理合并',()=>{const old='blog/旧.md',retired=state({}, {}, {},{retiredSources:{[old]:'old.md'}}),stale=state({}, {[old]:'other.md'},{'other.md':a});assert.throws(()=>mergeRecords([retired,stale],new Map([['other.md',a]])),/另一篇发布记录/);});
test('撤回事件压住离线旧快照，其他文章仍可同步',()=>{const source='blog/a.md',target='source/_posts/a.md',other='source/_posts/b.md',id='1'.repeat(32),event={source,target,baseline:a,commit:'c'.repeat(40),articleId:'2'.repeat(32)};const old=state({[source]:'date'},{[source]:target,'blog/b.md':other},{[target]:a,[other]:b},{articleIds:{['2'.repeat(32)]:source}}),withdrawn=state({[source]:'date'},{'blog/b.md':other},{[other]:b},{articleIds:{['2'.repeat(32)]:source},withdrawals:{[id]:event}});const merged=mergeRecords([withdrawn,old],new Map([[other,b]]));assert.equal(merged.targets[source],undefined);assert.equal(merged.baselines[target],undefined);assert.deepEqual(merged.withdrawals[id],event);assert.equal(merged.targets['blog/b.md'],other);assert.deepEqual(mergeRecords([merged,old],new Map([[other,b]])).withdrawals,merged.withdrawals);});
test('撤回后远端出现文件时停止，不能静默丢弃归属',()=>{const id='1'.repeat(32),event={source:'blog/a.md',target:path,baseline:a,commit:'c'.repeat(40)},x=state({}, {}, {},{withdrawals:{[id]:event}});assert.throws(()=>mergeRecords([x],new Map([[path,a]])),/远端目标再次出现/);});
test('显式允许重新发布后旧快照不会把过时基线恢复',()=>{const source='blog/a.md',id='1'.repeat(32),event={source,target:path,baseline:a,commit:'c'.repeat(40)},old=state({}, {[source]:path},{[path]:a}),released=state({}, {[source]:path},{},{withdrawals:{[id]:event},withdrawalReleases:{[id]:'released'}}),merged=mergeRecords([released,old],new Map());assert.equal(merged.targets[source],path);assert.equal(merged.baselines[path],undefined);const published=state({}, {[source]:path},{[path]:b},{withdrawals:{[id]:event},withdrawalReleases:{[id]:'released'}});assert.equal(mergeRecords([published,old],new Map([[path,b]])).baselines[path],b);});
test('重新发布记录缺少撤回事件时拒绝合并',()=>{assert.throws(()=>mergeRecords([state({}, {}, {},{withdrawalReleases:{['1'.repeat(32)]:'released'}})],new Map()),/缺少对应撤回事件/);});
test('确认后的标识修复合并两设备旧记录，不恢复废弃编号',()=>{const source='blog/a.md',target='source/_posts/a.md',old='1'.repeat(32),kept='2'.repeat(32),one=state({}, {}, {},{articleIds:{[old]:source}}),two=state({[source]:'date'},{[source]:target},{[target]:a},{articleIds:{[kept]:source}}),fix=state({}, {}, {},{identityAliases:{[old]:{canonical:kept,source}}});const merged=mergeRecords([one,two,fix],new Map([[target,a]]));assert.deepEqual(merged.articleIds,{[kept]:source});assert.equal(merged.targets[source],target);assert.deepEqual(merged.identityAliases[old],{canonical:kept,source});assert.deepEqual(mergeRecords([merged,one,two],new Map([[target,a]])).articleIds,{[kept]:source});});
test('标识被用于其他文章时拒绝应用修复映射',()=>{const old='1'.repeat(32),kept='2'.repeat(32),fix=state({}, {}, {},{identityAliases:{[old]:{canonical:kept,source:'blog/a.md'}}}),other=state({}, {}, {},{articleIds:{[old]:'blog/b.md'}});assert.throws(()=>mergeRecords([fix,other],new Map()),/另一篇文章/);});
test('确认丢弃未发布设备的首次预览日期，保留已发布日期',()=>{const source='blog/a.md',target='source/_posts/a.md',old='1'.repeat(32),kept='2'.repeat(32),one=state({[source]:'old'}, {}, {},{articleIds:{[old]:source}}),two=state({[source]:'published'},{[source]:target},{[target]:a},{articleIds:{[kept]:source}}),fix=state({}, {}, {},{identityAliases:{[old]:{canonical:kept,source,discardedDate:'old'}}});assert.equal(mergeRecords([one,two,fix],new Map([[target,a]])).dates[source],'published');one.targets[source]=target;one.baselines[target]=a;assert.throws(()=>mergeRecords([one,two,fix],new Map([[target,a]])),/已有发布记录/);});
