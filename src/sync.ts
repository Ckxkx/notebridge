import { Baseline } from './github';

export interface Overlay { base:string; merged:string; hash:string }
export interface IdentityAlias { canonical:string; source:string; discardedDate?:string }
export interface WithdrawalEvent { source:string; target:string; baseline:string; commit:string; articleId?:string }
export interface SyncState { version:1; dates:Record<string,string>; baselines:Baseline; targets:Record<string,string>; targetOverrides?:Record<string,string>; assetSources?:Record<string,string>; overlays?:Record<string,Overlay>; renames?:Record<string,string>; articleIds?:Record<string,string>; identityAliases?:Record<string,IdentityAlias>; retiredSources?:Record<string,string>; withdrawals?:Record<string,WithdrawalEvent>; withdrawalReleases?:Record<string,string>; commit?:string }

export function resolveRenamedPath(path:string,renames:Record<string,string>):string{
 const seen=new Set<string>();let current=path;
 while(Object.prototype.hasOwnProperty.call(renames,current)){if(seen.has(current))throw new Error(`重命名记录存在循环：${path}`);seen.add(current);current=renames[current];if(!current)throw new Error(`重命名记录无效：${path}`);}
 return current;
}
export function renameRecords(state:SyncState,oldPath:string,newPath:string,isFolder:boolean):SyncState {
 const match=(path:string)=>path===oldPath||(isFolder&&path.startsWith(oldPath+'/'));
 const sources=new Set([...Object.keys(state.dates),...Object.keys(state.targets),...Object.keys(state.targetOverrides||{}),...Object.values(state.articleIds||{})].filter(match));
 if(!sources.size)return state;
 const next:SyncState={...state,dates:{...state.dates},targets:{...state.targets},targetOverrides:{...state.targetOverrides},renames:{...state.renames},articleIds:{...state.articleIds}};
 for(const source of sources){
  const target=newPath+source.slice(oldPath.length);
  if(!target||target===source||Object.prototype.hasOwnProperty.call(next.renames!,target))throw new Error(`重命名后的路径与已有记录冲突：${target}`);
  if(next.renames![source]&&next.renames![source]!==target)throw new Error(`重命名记录冲突：${source}`);
  for(const key of ['dates','targets','targetOverrides'] as const){const map=next[key]!;if(Object.prototype.hasOwnProperty.call(map,target))throw new Error(`重命名后的路径已有记录：${target}`);}
  for(const key of ['dates','targets','targetOverrides'] as const){const map=next[key]!;if(Object.prototype.hasOwnProperty.call(map,source)){map[target]=map[source];delete map[source];}}
  next.renames![source]=target;resolveRenamedPath(source,next.renames!);
  for(const [id,identityPath] of Object.entries(next.articleIds!))if(identityPath===source)next.articleIds![id]=target;
 }
 return next;
}

// Never choose a winner by timestamp: sync providers and device clocks can lag.
export function mergeRecords(states:SyncState[], remote:Map<string,string>, unresolved?:{path:string;baseline:string}):SyncState {
 const result:SyncState={version:1,dates:{},baselines:{},targets:{},targetOverrides:{},assetSources:{},renames:{},articleIds:{},retiredSources:{}};
 for(const state of states)for(const [source,target] of Object.entries(state.retiredSources||{})){const old=result.retiredSources![source];if(old&&old!==target)throw new Error(`设备间旧关联记录冲突：${source}`);result.retiredSources![source]=target;}
 for(const state of states)for(const [oldPath,newPath] of Object.entries(state.renames||{})){
  const prev=result.renames![oldPath];if(prev&&prev!==newPath)throw new Error(`设备间重命名记录冲突：${oldPath}`);result.renames![oldPath]=newPath;
 }
 for(const oldPath of Object.keys(result.renames!))resolveRenamedPath(oldPath,result.renames!);
 result.withdrawals={};result.withdrawalReleases={};
 for(const state of states){
  for(const [id,event] of Object.entries(state.withdrawals||{})){const old=result.withdrawals[id];if(!/^[a-f0-9]{32}$/.test(id)||!event||typeof event.source!=='string'||!event.source||typeof event.target!=='string'||!event.target||!/^[a-f0-9]{40}$/.test(event.baseline)||!/^[a-f0-9]{40}$/.test(event.commit)||(event.articleId!==undefined&&!/^[a-f0-9]{32}$/.test(event.articleId)))throw new Error('撤回记录无效');if(old&&JSON.stringify(old)!==JSON.stringify(event))throw new Error('设备间撤回记录冲突');result.withdrawals[id]=event;}
  for(const [id,value] of Object.entries(state.withdrawalReleases||{})){if(!/^[a-f0-9]{32}$/.test(id)||value!=='released')throw new Error('重新发布记录无效');result.withdrawalReleases[id]=value;}
 }
 for(const id of Object.keys(result.withdrawalReleases))if(!result.withdrawals[id])throw new Error('重新发布记录缺少对应撤回事件，请等待同步');
 const activeWithdrawals=Object.entries(result.withdrawals).filter(([id])=>!result.withdrawalReleases![id]).map(([,event])=>event);
 for(const event of activeWithdrawals){if(remote.has(event.target))throw new Error(`已撤回文章的远端目标再次出现：${event.target}；请核对后处理`);}
 result.identityAliases={};
 for(const state of states)for(const [oldId,alias] of Object.entries(state.identityAliases||{})){
  if(!/^[a-f0-9]{32}$/.test(oldId)||!alias||!/^[a-f0-9]{32}$/.test(alias.canonical)||oldId===alias.canonical||typeof alias.source!=='string'||!alias.source||(alias.discardedDate!==undefined&&(typeof alias.discardedDate!=='string'||!alias.discardedDate)))throw new Error('文章标识修复记录无效');
  const prior=result.identityAliases[oldId];if(prior&&(prior.canonical!==alias.canonical||prior.source!==alias.source||prior.discardedDate!==alias.discardedDate))throw new Error('文章标识修复记录冲突');result.identityAliases[oldId]=alias;
 }
 for(const [id,alias] of Object.entries(result.identityAliases))if(result.identityAliases[alias.canonical])throw new Error(`文章标识修复链尚不能自动合并：${id}`);
 for(const state of states)for(const [id,source] of Object.entries(state.articleIds||{})){
  if(result.retiredSources![source])continue;
  if(!/^[a-f0-9]{32}$/.test(id))throw new Error('文章标识格式无效');const alias:IdentityAlias|undefined=result.identityAliases[id];const path=resolveRenamedPath(source,result.renames!);if(alias&&path!==resolveRenamedPath(alias.source,result.renames!))throw new Error(`待清理标识已关联另一篇文章：${id}`);const canonical=alias?.canonical||id,old=result.articleIds![canonical];
  if(old&&old!==path)throw new Error(`同一文章标识指向多个路径：${old} / ${path}`);result.articleIds![canonical]=path;
 }
 const idsByPath=new Map<string,string>();for(const [id,path] of Object.entries(result.articleIds!)){if(idsByPath.has(path)&&idsByPath.get(path)!==id)throw new Error(`文章路径对应多个标识：${path}`);idsByPath.set(path,id);}
 for(const key of ['dates','targets','targetOverrides','assetSources'] as const){
  const dest=result[key]!;
  for(const state of states)for(const [original,value] of Object.entries(state[key]||{})){
   if(key==='dates'){const matched=Object.entries(result.identityAliases).find(([oldId,alias])=>state.articleIds?.[oldId]===original&&resolveRenamedPath(alias.source,result.renames!)===resolveRenamedPath(original,result.renames!));if(matched&&matched[1].discardedDate===value){if(state.targets[original])throw new Error(`旧标识已有发布记录，不能自动丢弃日期：${original}`);continue;}}
   if(key==='targets'){const withdrawal=activeWithdrawals.find(e=>resolveRenamedPath(e.source,result.renames!)===resolveRenamedPath(original,result.renames!));if(withdrawal){if(value!==withdrawal.target)throw new Error(`已撤回文章的目标记录冲突：${original}`);continue;}}
   if(key!=='assetSources'&&result.retiredSources![original]){if(key==='targets'&&value!==result.retiredSources![original])throw new Error(`已清理的路径存在另一篇发布记录：${original}`);continue;}
   const path=key==='assetSources'?original:resolveRenamedPath(original,result.renames!);
   if(Object.prototype.hasOwnProperty.call(dest,path)&&dest[path]!==value)throw new Error(`设备间记录冲突（${key}：${path}），请先核对两端记录`);
   dest[path]=value;
  }
 }
 const owners=new Map<string,string>();
 for(const [source,target] of Object.entries(result.targets)){
  if(owners.has(target)&&owners.get(target)!==source)throw new Error(`多篇文章指向同一远端路径：${target}`);
  owners.set(target,source);
 }
 const candidates=new Map<string,Set<string>>();
 const retiredTargets=new Set(Object.values(result.retiredSources!));const retainedTargets=new Set(Object.values(result.targets));
 for(const state of states)for(const [path,hash] of Object.entries(state.baselines)){
  if(activeWithdrawals.some(e=>e.target===path)&&!retainedTargets.has(path)&&!result.assetSources?.[path])continue;
  if(retiredTargets.has(path)&&!retainedTargets.has(path)&&!result.assetSources?.[path])continue;
  if(!/^[a-f0-9]{40}$/i.test(hash))throw new Error(`发布基线无效：${path}`);
  if(!candidates.has(path))candidates.set(path,new Set());candidates.get(path)!.add(hash.toLowerCase());
 }
 for(const [path,hashes] of candidates){
  const actual=remote.get(path);
  if(!actual&&Object.entries(result.withdrawals).some(([id,event])=>event.target===path&&!!result.withdrawalReleases![id])&&!activeWithdrawals.some(e=>e.target===path))continue;
  if(!actual||!hashes.has(actual.toLowerCase())){
   if(unresolved?.path!==path||!hashes.has(unresolved.baseline.toLowerCase()))throw new Error(`同步记录与 GitHub 不一致：${path}；请先核对远端和同步记录`);
   result.baselines[path]=unresolved.baseline;
  }else result.baselines[path]=actual;
 }
 result.overlays={};
 for(const state of states)for(const [path,overlay] of Object.entries(state.overlays||{})){
  if(overlay.hash!==result.baselines[path])continue;
  const existing=result.overlays[path];if(existing&&JSON.stringify(existing)!==JSON.stringify(overlay))throw new Error(`设备间合并记录冲突：${path}`);
  result.overlays[path]=overlay;
 }
 for(const target of Object.values(result.targets))if(!result.baselines[target]&&!( !remote.has(target)&&Object.entries(result.withdrawals).some(([id,event])=>event.target===target&&!!result.withdrawalReleases![id])&&!activeWithdrawals.some(e=>e.target===target)))throw new Error(`文章缺少可信发布基线：${target}`);
 // A commit is only used for status display, never as an ownership proof.
 result.commit=states[0]?.commit;
 return result;
}
