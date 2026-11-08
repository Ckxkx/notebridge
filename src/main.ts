import { App, FuzzyMatch, FuzzySuggestModal, Modal, Notice, Platform, Plugin, PluginSettingTab, SecretComponent, Setting, TFile, TFolder } from 'obsidian';
import { Config, Plan, assertUploadSafe, cleanPath, ensureIdentity, isArticle, noteIdentity, prepare, within } from './core';
import { Github, Item, blobHash } from './github';
import { ArticleStatus, localLabel, remoteLabel, remoteStatus } from './dashboard';
import { applyCover, coverReference, CoverDestination } from './cover';
import { categoriesFromArticle, categoryPrefixes, CategoryPath } from './categories';
import { mergeRecords, Overlay, renameRecords, resolveRenamedPath, SyncState, WithdrawalEvent } from './sync';
import { mergeThreeWay } from './merge';
interface Settings extends Config { repo:string; branch:string; secret:string; site:string; workflow:string }
const defaults:Settings={root:'blog',posts:'source/_posts',images:'source/imgs',siteRoot:'/',imageUrl:'imgs',fields:['title','date','updated','tags','categories','permalink'],fluidImages:true,repo:'',branch:'main',secret:'',site:'',workflow:'pages.yml'};
type State = SyncState;
interface PendingOperation {version:1;scope:string;config:string;kind:'publish'|'withdraw';candidate:string;parent:string;expected:Record<string,string|null>;before:State;after:State}

interface Snapshot { overlayConflict?:{base:string;remote:string;merged:string;conflicts:number}; plans:Plan[]; items:Item[]; problems:string[]; scope:string; config:string; assetOwners:Record<string,string>; stateAtPreview?:string; preparedContents?:Record<string,string>; sourceHashes?:Record<string,string>; resolution?:{path:string;oldBaseline:string;remoteSha:string} }
function stringMap(value:unknown):value is Record<string,string>{return !!value&&typeof value==='object'&&!Array.isArray(value)&&Object.values(value).every(v=>typeof v==='string');}
function validState(value:unknown):value is State{
 if(!value||typeof value!=='object')return false;const v=value as Record<string,unknown>;
 const withdrawals=v.withdrawals;const validWithdrawals=withdrawals===undefined||(!!withdrawals&&typeof withdrawals==='object'&&!Array.isArray(withdrawals)&&Object.entries(withdrawals as Record<string,unknown>).every(([id,value])=>{if(!/^[a-f0-9]{32}$/.test(id)||!value||typeof value!=='object'||Array.isArray(value))return false;const e=value as Record<string,unknown>;return typeof e.source==='string'&&!!e.source&&typeof e.target==='string'&&!!e.target&&typeof e.baseline==='string'&&/^[a-f0-9]{40}$/.test(e.baseline)&&typeof e.commit==='string'&&/^[a-f0-9]{40}$/.test(e.commit)&&(e.articleId===undefined||(typeof e.articleId==='string'&&/^[a-f0-9]{32}$/.test(e.articleId)));}));
 const aliases=v.identityAliases;const validAliases=aliases===undefined||(!!aliases&&typeof aliases==='object'&&!Array.isArray(aliases)&&Object.entries(aliases as Record<string,unknown>).every(([id,value])=>{if(!/^[a-f0-9]{32}$/.test(id)||!value||typeof value!=='object'||Array.isArray(value))return false;const a=value as Record<string,unknown>;return typeof a.canonical==='string'&&/^[a-f0-9]{32}$/.test(a.canonical)&&a.canonical!==id&&typeof a.source==='string'&&!!a.source&&(a.discardedDate===undefined||(typeof a.discardedDate==='string'&&!!a.discardedDate));}));
 const releases=v.withdrawalReleases;const validReleases=releases===undefined||(stringMap(releases)&&Object.entries(releases).every(([id,value])=>/^[a-f0-9]{32}$/.test(id)&&value==='released'));
 const overlays=v.overlays;const validOverlays=overlays===undefined||(!!overlays&&typeof overlays==='object'&&!Array.isArray(overlays)&&Object.values(overlays as Record<string,unknown>).every(x=>{if(!x||typeof x!=='object'||Array.isArray(x))return false;const o=x as Record<string,unknown>;return typeof o.base==='string'&&typeof o.merged==='string'&&typeof o.hash==='string'&&/^[a-f0-9]{40}$/.test(o.hash);}));
 return v.version===1&&stringMap(v.dates)&&stringMap(v.baselines)&&stringMap(v.targets)&&(v.targetOverrides===undefined||stringMap(v.targetOverrides))&&(v.assetSources===undefined||stringMap(v.assetSources))&&(v.renames===undefined||stringMap(v.renames))&&(v.articleIds===undefined||stringMap(v.articleIds))&&(v.retiredSources===undefined||stringMap(v.retiredSources))&&validOverlays&&validWithdrawals&&validReleases&&validAliases&&(v.commit===undefined||typeof v.commit==='string');
}
async function prepareWithOverlay(content:string,overlay:Overlay|undefined,baseline:string|undefined){
 if(!overlay)return {text:content,conflicts:0};
 if(overlay.hash!==baseline||await blobHash(new TextEncoder().encode(overlay.merged))!==overlay.hash)throw new Error('合并记录与发布基线不一致，请先核对记录');
 return mergeThreeWay(overlay.base,content,overlay.merged);
}
export default class NoteBridge extends Plugin {
 settings:Settings=defaults; busy=false; status!:HTMLElement; last='尚未检查'; private monitorTimer:number|undefined; private deletionTimer:number|undefined; private deleted=new Set<string>(); private deletionScope=''; private generation=0; private stopped=false; private runUrl?:string; private renameQueue:Promise<void>=Promise.resolve(); private renameGeneration=0; private categoryCache=new Map<string,CategoryPath[]>();
 async onload() {
  const saved:unknown=await this.loadData();this.settings={...defaults,...(saved&&typeof saved==='object'&&!Array.isArray(saved)?saved as Partial<Settings>:{})};
  this.addSettingTab(new SettingsTab(this.app,this));
  this.status=Platform.isMobile ? document.createElement('span') : this.addStatusBarItem(); this.setStatus('就绪（手动发布）');
  this.addCommand({id:'repair',name:'检查并修复发布问题',callback:()=>void this.repair(this.app.workspace.getActiveFile()||undefined)});
  this.addCommand({id:'recover-shared',name:'恢复本机损坏的同步记录',callback:()=>void this.recoverSharedRecord()});
  this.addCommand({id:'recover-operation',name:'核对并恢复中断的提交记录',callback:()=>void this.recoverOperation()});
  this.addCommand({id:'control-center',name:'打开操作中心',callback:()=>this.openControlCenter()});
  this.addCommand({id:'preview',name:'预览发布范围',callback:()=>void this.preview(false)});
  this.addCommand({id:'publish',name:'同步全部变化',callback:()=>void this.preview(true)});
  this.addCommand({id:'publish-current',name:'发布当前文章',callback:()=>{const f=this.app.workspace.getActiveFile(); if(f) void this.preview(true,f); else new Notice('请先打开文章');}});
  this.addCommand({id:'resolve-conflict',name:'比较并合并当前文章的发布冲突',callback:()=>{const f=this.app.workspace.getActiveFile();if(f)void this.resolveConflict(f);else new Notice('请先打开冲突文章');}});
  this.addCommand({id:'review-missing-remote',name:'核对远端已删除的旧发布记录',callback:()=>void this.reviewMissingRemote()});
  this.addCommand({id:'review-duplicate',name:'核对当前文章的旧重复发布记录',callback:()=>{const f=this.app.workspace.getActiveFile();if(f)void this.reviewDuplicates(f);else new Notice('请先打开要保留的文章');}});
  this.addCommand({id:'test-connection',name:'测试 GitHub 连接',callback:()=>void this.test()});
  this.addCommand({id:'deployment-status',name:'查看最近提交的工作流状态',callback:()=>void this.showDeployment()});
  this.addCommand({id:'republish-withdrawn',name:'重新发布已撤回的当前文章',callback:()=>{const f=this.app.workspace.getActiveFile();if(f)void this.prepareRepublish(f);else new Notice('请先打开已撤回的文章');}});
  this.addCommand({id:'withdraw',name:'撤回已发布文章',callback:()=>this.openWithdraw()});
  this.addCommand({id:'article-status',name:'查看文章发布状态',callback:()=>new ArticleStatusModal(this.app,this).open()});
  this.addCommand({id:'select-cover',name:'为当前文章选择封面',callback:()=>{const f=this.app.workspace.getActiveFile();if(f)this.openCoverPicker(f);else new Notice('请先打开一篇文章');}});
  this.addCommand({id:'choose-category',name:'选择仓库分类和文章目录',callback:()=>{const f=this.app.workspace.getActiveFile();if(f)this.openCategoryPicker(f);else new Notice('请先打开一篇文章');}});
  this.addRibbonIcon('list-checks','NoteBridge：操作中心',()=>this.openControlCenter());
  this.registerEvent(this.app.vault.on('delete',file=>this.onLocalDelete(file.path,file instanceof TFolder)));
  this.registerEvent(this.app.vault.on('rename',(file,oldPath)=>{const newPath=file.path,isFolder=file instanceof TFolder,scope=this.key();this.renameGeneration++;const schedule=()=>{if(this.stopped)return;if(this.busy){window.setTimeout(schedule,25);return;}this.renameQueue=this.renameQueue.then(()=>this.onLocalRename(oldPath,newPath,isFolder,scope)).catch(e=>{new Notice(`无法保存重命名记录：${String(e)}；请勿发布，先检查发布记录`,15000);});};schedule();}));
  this.registerEvent(this.app.workspace.on('file-menu',(menu,file)=>{ if(file instanceof TFile && isArticle(file.path,this.settings.root)) { menu.addItem(item=>item.setTitle('NoteBridge：预览并发布').setIcon('upload').onClick(()=>void this.preview(true,file)));menu.addItem(item=>item.setTitle('NoteBridge：操作中心').setIcon('list-checks').onClick(()=>this.openControlCenter(file))); } }));
  try { const sha=this.state().commit; if(sha) this.monitor(sha); await this.initializeSharedState();if(this.pendingOperation())new Notice('发现未完成的发布记录，请在操作中心核对恢复',15000); } catch(e) { this.setStatus('管理记录异常');new Notice(`同步记录未写入：${String(e)}`,10000); }
 }
 async onExternalSettingsChange(){
  const saved:unknown=await this.loadData();
  if(this.stopped)return;
  this.settings={...defaults,...(saved&&typeof saved==='object'&&!Array.isArray(saved)?saved as Partial<Settings>:{})};
  this.generation++;if(this.monitorTimer!==undefined)window.clearTimeout(this.monitorTimer);
  this.runUrl=undefined;this.setStatus('设置已从同步文件更新');
 }
 onunload(){ this.stopped=true; this.generation++; if(this.monitorTimer!==undefined) window.clearTimeout(this.monitorTimer); if(this.deletionTimer!==undefined) window.clearTimeout(this.deletionTimer); this.deleted.clear(); }
 setStatus(s:string){this.last=s;this.status.setText('NoteBridge：'+s);}
 key(){return 'notebridge-state:'+this.app.vault.getName()+':'+this.settings.repo+':'+this.settings.branch;}
 configKey(){return JSON.stringify(this.settings);}
 state():State { const raw:unknown=this.app.loadLocalStorage(this.key()); if(raw===null) return {version:1,dates:{},baselines:{},targets:{}}; if(!validState(raw)) throw new Error('本机管理记录损坏；已停止操作，请恢复记录'); return raw; }
 saveState(s:State){this.app.saveLocalStorage(this.key(),s);}
 private operationKey(){return 'notebridge-operation:'+this.key();}
 pendingOperation():PendingOperation|undefined{
  const raw:unknown=this.app.loadLocalStorage(this.operationKey());if(raw===null||raw===undefined)return undefined;
  if(!raw||typeof raw!=='object'||Array.isArray(raw))throw new Error('待恢复操作记录损坏，请先备份并检查本机数据');
  const p=raw as Partial<PendingOperation>;if(p.version!==1||typeof p.scope!=='string'||typeof p.config!=='string'||!['publish','withdraw'].includes(String(p.kind))||typeof p.candidate!=='string'||!/^[a-f0-9]{40}$/.test(p.candidate)||typeof p.parent!=='string'||!/^[a-f0-9]{40}$/.test(p.parent)||!p.expected||typeof p.expected!=='object'||Array.isArray(p.expected)||!Object.values(p.expected).every(v=>v===null||(typeof v==='string'&&/^[a-f0-9]{40}$/.test(v)))||!validState(p.before)||!validState(p.after)||p.after.commit!==p.candidate)throw new Error('待恢复操作记录无效，请先备份并检查本机数据');
  return p as PendingOperation;
 }
 private ensureNoPending(){if(this.pendingOperation())throw new Error('存在尚未核对的提交，请先在操作中心运行“核对并恢复中断的提交记录”');}
 private saveOperation(p:PendingOperation){this.app.saveLocalStorage(this.operationKey(),p);if(JSON.stringify(this.pendingOperation())!==JSON.stringify(p))throw new Error('提交恢复记录未能持久保存，已停止更新分支');}
 private clearOperation(){this.app.saveLocalStorage(this.operationKey(),null);}
 async recoverOperation(internal=false){
  if(this.busy&&!internal){new Notice('已有任务正在运行');return;}if(!internal)this.busy=true;
  try{
   const pending=this.pendingOperation();if(!pending){if(!internal)new Notice('没有待恢复的提交记录');return;}
   if(pending.scope!==this.key()||pending.config!==this.configKey())throw new Error('仓库、分支或设置已改变，请切回原配置后核对');
   const before=JSON.stringify(pending.before),after=JSON.stringify(pending.after),current=JSON.stringify(this.state());if(current!==before&&current!==after)throw new Error('本机发布记录已变化，不能自动恢复；请先备份记录并人工核对');
   const client=this.github(),head=await client.head();if(!await client.containsCommit(pending.candidate,head.sha))throw new Error(`尚不能确认提交 ${pending.candidate.slice(0,12)} 已进入分支；请到 GitHub 核对，暂不要重试或删除记录`);
   const tree=await client.tree(head.tree);for(const [path,expected] of Object.entries(pending.expected)){const actual=tree.get(path);if(expected===null?actual!==undefined:actual!==expected)throw new Error(`远端文件在提交后发生变化：${path}；请人工核对`);}
   if(pending.scope!==this.key()||pending.config!==this.configKey()||![before,after].includes(JSON.stringify(this.state())))throw new Error('设置或记录已改变，请重新核对');
   this.app.saveLocalStorage(pending.scope,pending.after);await this.writeSharedState();this.clearOperation();this.setStatus('已恢复提交记录');if(!internal)new Notice(`已核对并恢复提交 ${pending.candidate.slice(0,7)} 的记录；请等待各设备同步`,15000);
  }catch(e){if(internal)throw e;new Notice(`无法自动恢复：${String(e)}`,18000);}finally{if(!internal)this.busy=false;}
 }
 private sharedProfile(){return JSON.stringify({repo:this.settings.repo.toLowerCase(),branch:this.settings.branch,root:cleanPath(this.settings.root),posts:cleanPath(this.settings.posts),images:cleanPath(this.settings.images)});}
 private async sharedPath(){
  const profile=this.sharedProfile(),bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(profile));
  const hash=Array.from(new Uint8Array(bytes),x=>x.toString(16).padStart(2,'0')).join('');
  const deviceKey='notebridge-device:'+this.app.vault.getName();let device:unknown=this.app.loadLocalStorage(deviceKey);
  if(typeof device!=='string'||!/^[a-f0-9]{32}$/.test(device)){const random=crypto.getRandomValues(new Uint8Array(16));device=Array.from(random,x=>x.toString(16).padStart(2,'0')).join('');this.app.saveLocalStorage(deviceKey,device);}
  return {profile,prefix:`${hash}-`,path:`NoteBridge同步记录/${hash}-${String(device)}.json`};
 }
 private async sharedChecksum(profile:string,state:State){const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify({profile,state})));return Array.from(new Uint8Array(bytes),x=>x.toString(16).padStart(2,'0')).join('');}
 private async parseSharedRecord(raw:string,profile:string,path:string):Promise<State>{
  let data:unknown;try{data=JSON.parse(raw);}catch{throw new Error(`无法读取同步记录：${path}`);}
  if(!data||typeof data!=='object'||Array.isArray(data))throw new Error(`同步记录格式无效：${path}`);
  const record=data as Record<string,unknown>;if(record.version!==1||record.profile!==profile||!validState(record.state))throw new Error(`同步记录格式或配置不匹配：${path}`);
  if(record.checksum!==undefined&&(typeof record.checksum!=='string'||record.checksum!==await this.sharedChecksum(profile,record.state)))throw new Error(`同步记录校验失败：${path}；请保留原文件并检查备份`);
  return record.state;
 }
 async recoverSharedRecord(internal=false){
  if(this.busy&&!internal){new Notice('已有任务正在运行');return;}if(!internal)this.busy=true;
  try{
   const adapter=this.app.vault.adapter;if(!adapter)throw new Error('当前仓库不支持读取同步文件');const scope=this.key(),profile=this.sharedProfile(),location=await this.sharedPath();
   if(!await adapter.exists(location.path)||!await adapter.exists(location.path+'.backup'))throw new Error('没有找到本机同步记录或有效备份；请检查同步文件');
   const damaged=await adapter.read(location.path);let isValid=false;try{await this.parseSharedRecord(damaged,profile,location.path);isValid=true;}catch{/* only explicit recovery may replace a damaged record */}if(isValid)throw new Error('当前同步记录有效，不需要恢复');
   const backup=await adapter.read(location.path+'.backup'),backupState=await this.parseSharedRecord(backup,profile,location.path+'.backup'),local=JSON.stringify(this.state());if(JSON.stringify(backupState)!==local)throw new Error('备份与本机当前记录不同，不能自动选择；请先保留文件并人工核对');
   const preserved=location.path+'.damaged';if(await adapter.exists(preserved))throw new Error('已有损坏文件备份，请先人工处理以免覆盖');
   if(scope!==this.key()||profile!==this.sharedProfile()||JSON.stringify(this.state())!==local||await adapter.read(location.path)!==damaged)throw new Error('设置或记录发生变化，请重新核对');
   await adapter.write(preserved,damaged);if(await adapter.read(preserved)!==damaged)throw new Error('无法完整保存损坏文件，已停止');
   await adapter.write(location.path,backup);const restored=await adapter.read(location.path);await this.parseSharedRecord(restored,profile,location.path);if(restored!==backup)throw new Error('恢复后文件被修改，请检查同步');
   if(!internal)new Notice('已恢复本机同步记录并保留损坏文件；请等待同步后再操作',15000);
  }catch(e){if(internal)throw e;new Notice(`无法自动恢复同步记录：${String(e)}`,18000);}finally{if(!internal)this.busy=false;}
 }
 private async initializeSharedState(){
  if(!this.settings.repo||!this.settings.branch||!this.app.vault.adapter)return;
  const location=await this.sharedPath();if(!await this.app.vault.adapter.exists(location.path))await this.writeSharedState();
 }
 async writeSharedState(){
  if(!this.settings.repo||!this.settings.branch||!this.app.vault.adapter)return;
  const scope=this.key(),profile=this.sharedProfile(),state=this.state(),location=await this.sharedPath(),adapter=this.app.vault.adapter;
  if(scope!==this.key()||profile!==this.sharedProfile())throw new Error('设置已改变，请重新同步');
  if(!await adapter.exists('NoteBridge同步记录'))await adapter.mkdir('NoteBridge同步记录');
  const checksum=await this.sharedChecksum(location.profile,state),record=JSON.stringify({version:1,profile:location.profile,state,checksum},null,2);
  if(await adapter.exists(location.path)){const previous=await adapter.read(location.path);await this.parseSharedRecord(previous,location.profile,location.path);await adapter.write(location.path+'.backup',previous);}
  await adapter.write(location.path,record);const written=await adapter.read(location.path);await this.parseSharedRecord(written,location.profile,location.path);if(written!==record)throw new Error('同步记录写入后内容变化，请检查同步状态');
 }
 async syncRecords(unresolved?:{path:string;baseline:string},force=false){
  this.ensureNoPending();
  if(!this.settings.repo||!this.settings.branch||!this.app.vault.adapter)return;
  const scope=this.key(),config=this.configKey(),location=await this.sharedPath(),adapter=this.app.vault.adapter;
  if(!await adapter.exists('NoteBridge同步记录')){await this.writeSharedState();return;}
  const files=(await adapter.list('NoteBridge同步记录')).files.filter(p=>p.startsWith('NoteBridge同步记录/'+location.prefix)&&p.endsWith('.json'));
  if(!files.length){await this.writeSharedState();return;}
  const states:State[]=[this.state()];
  for(const path of files)states.push(await this.parseSharedRecord(await adapter.read(path),location.profile,path));
  if(!force&&states.slice(1).every(s=>JSON.stringify(s)===JSON.stringify(states[0])))return;
  const client=this.github(),head=await client.head(),tree=await client.tree(head.tree),merged=mergeRecords(states,tree,unresolved);
  if(scope!==this.key()||config!==this.configKey())throw new Error('设置已改变，请重新同步');
  this.saveState(merged);await this.writeSharedState();
 }
 async repairMatchingArticle(file:TFile):Promise<boolean>{
  const scope=this.key(),config=this.configKey(),initial=this.state(),target=initial.targets[file.path],baseline=target&&initial.baselines[target];
  if(!target||!baseline||initial.overlays?.[target]||Object.values(initial.targets).filter(x=>x===target).length!==1)return false;
  await this.syncRecords({path:target,baseline},true);const state=this.state(),date=state.dates[file.path],ids=Object.entries(state.articleIds||{}).filter(([,path])=>path===file.path);
  if(state.targets[file.path]!==target||state.baselines[target]!==baseline||state.overlays?.[target]||!date||ids.length!==1)return false;
  const original=await this.app.vault.read(file),id=noteIdentity(original);if(id!==ids[0][0])return false;
  for(const other of this.app.vault.getMarkdownFiles()){if(other.path!==file.path&&isArticle(other.path,this.settings.root)&&noteIdentity(await this.app.vault.read(other))===id)return false;}
  const plan=prepare(file.path,original,this.settings,date,(ref,src)=>this.app.metadataCache.getFirstLinkpathDest(ref,src)?.path||null,target);if(!plan)return false;
  const hash=await blobHash(new TextEncoder().encode(plan.content)),before=JSON.stringify(state),client=this.github(),head=await client.head(),tree=await client.tree(head.tree);if(tree.get(target)!==hash)return false;
  if(this.stopped||scope!==this.key()||config!==this.configKey()||before!==JSON.stringify(this.state())||this.app.vault.getAbstractFileByPath(file.path)!==file||await this.app.vault.read(file)!==original)return false;
  const fresh=await client.head(),latest=await client.tree(fresh.tree);if(latest.get(target)!==hash||scope!==this.key()||config!==this.configKey()||before!==JSON.stringify(this.state())||await this.app.vault.read(file)!==original)return false;
  state.baselines[target]=hash;this.saveState(state);await this.writeSharedState();await this.syncRecords(undefined,true);return true;
 }
 async repair(file?:TFile,returnHome=false){
  if(this.busy){new Notice('已有任务正在运行');if(returnHome)this.openControlCenter(file);return;}this.busy=true;let affected=file;
  try{
   const adapter=this.app.vault.adapter;if(adapter&&this.settings.repo&&this.settings.branch){const location=await this.sharedPath();if(await adapter.exists(location.path)){let damaged=false;const raw=await adapter.read(location.path);try{await this.parseSharedRecord(raw,location.profile,location.path);}catch{damaged=true;}if(damaged){await this.recoverSharedRecord(true);try{await this.parseSharedRecord(await adapter.read(location.path),location.profile,location.path);}catch{throw new Error('本机同步文件损坏且无法安全自动恢复，请保留文件并检查备份');}}}}
   if(this.pendingOperation()){await this.recoverOperation(true);if(this.pendingOperation())throw new Error('上次提交的结果尚无法确认，请查看刚才的提示');}
   this.setStatus('正在检查');await this.renameQueue;
   try{await this.syncRecords(undefined,true);}catch(e){
    const state=this.state(),entry=Object.entries(state.targets).find(([,target])=>String(e).includes(`同步记录与 GitHub 不一致：${target}；`));
    const candidate=entry&&this.app.vault.getAbstractFileByPath(entry[0]);if(candidate instanceof TFile)affected=candidate;
    if(!(candidate instanceof TFile)||!await this.repairMatchingArticle(candidate))throw e;
   }
   if(affected){const state=this.state(),target=state.targets[affected.path],date=state.dates[affected.path],overlay=target&&state.overlays?.[target];if(target&&date&&overlay){const text=await this.app.vault.read(affected),plan=prepare(affected.path,text,this.settings,date,(ref,src)=>this.app.metadataCache.getFirstLinkpathDest(ref,src)?.path||null,target);if(plan&&(await prepareWithOverlay(plan.content,overlay,state.baselines[target])).conflicts)throw new Error(`文章存在需要选择的合并冲突：${target}`);}}
   this.setStatus('检查完成');new Notice('检查完成，可以继续使用。',10000);if(returnHome)this.openControlCenter(affected);
  }catch(e){this.setStatus('需要处理');const state=(()=>{try{return this.state();}catch{return undefined;}})(),target=affected&&state?.targets[affected.path],message=String(e),needsComparison=!!(affected&&target&&(message.includes(`同步记录与 GitHub 不一致：${target}`)||message.includes(`文章存在需要选择的合并冲突：${target}`)));new RepairResultModal(this.app,this,affected,needsComparison,message).open();}finally{this.busy=false;}
 }
 github(){ const token=this.app.secretStorage?.getSecret(this.settings.secret); if(!token) throw new Error('请先在设置中选择本机 SecretStorage 凭据'); return new Github(this.settings.repo,this.settings.branch,token); }
 openControlCenter(file?:TFile){new ControlCenterModal(this.app,this,file).open();}
 async test(returnHome=false,file?:TFile){try{await this.github().check();new Notice('仓库和分支连接成功（只读）');}catch(e){new Notice(String(e),10000);}finally{if(returnHome)this.openControlCenter(file);}}
 openCategoryPicker(file:TFile){if(!isArticle(file.path,this.settings.root)){new Notice('请先打开发布根目录中的文章');return;}new CategoryModal(this.app,this,file,this.key(),this.configKey()).open();}
 async readCatalog(active:()=>boolean,progress:(message:string)=>void):Promise<{categories:CategoryPath[];directories:string[];skipped:number;head:string}>{
  const client=this.github(),head=await client.head(),entries=await client.treeEntries(head.tree),root=cleanPath(this.settings.posts);
  if(!root)throw new Error('请先配置文章目标目录');
  const directories=[root,...entries.filter(e=>e.type==='tree'&&within(e.path,root)).map(e=>e.path)].sort((a,b)=>a.localeCompare(b,'zh-CN'));
  const posts=entries.filter(e=>e.type==='blob'&&within(e.path,root)&&/\.md$/i.test(e.path));
  const paths:CategoryPath[]=[];let skipped=0;
  for(let i=0;i<posts.length;i++){
   if(!active())throw new Error('读取已取消');progress(`正在读取仓库文章分类：${i+1}/${posts.length}`);
   try{let cached=this.categoryCache.get(posts[i].sha);if(!cached){const content=await client.blobText(posts[i].sha);cached=categoriesFromArticle(content);if(this.categoryCache.size>=1000)this.categoryCache.clear();this.categoryCache.set(posts[i].sha,cached);}paths.push(...cached);}catch(e){const message=e instanceof Error?e.message:String(e);if(/frontmatter|分类必须|UTF-8/.test(message))skipped++;else throw e;}
  }
  if(!active())throw new Error('读取已取消');
  return {categories:categoryPrefixes(paths),directories:[...new Set(directories)],skipped,head:head.sha};
 }
 async saveOrganization(file:TFile,scope:string,config:string,category:CategoryPath|undefined,directory:string|undefined,knownDirs:string[]){
  if(this.busy){new Notice('已有任务正在运行');return false;}this.busy=true;
  try{
   await this.syncRecords();
   if(this.stopped||scope!==this.key()||config!==this.configKey())throw new Error('仓库或设置已改变，请重新读取');
   if(this.app.vault.getAbstractFileByPath(file.path)!==file||!isArticle(file.path,this.settings.root))throw new Error('文章已不存在或不在发布目录内');
   if(!category&&!directory)throw new Error('请先选择分类或文章目录');
   const source=file.path,state=this.state();
   if(category&&!this.settings.fields.includes('categories'))throw new Error('请先在公开 frontmatter 字段中添加 categories');
   if(directory){if(state.targets[source])throw new Error('已发布文章的远端路径已固定，不能直接更改目录');if(!knownDirs.includes(directory)||!(directory===cleanPath(this.settings.posts)||within(directory,this.settings.posts)))throw new Error('目标目录不在本次读取的仓库范围内');}
   if(category){await this.app.fileManager.processFrontMatter(file,(value:unknown)=>{if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('文章属性格式无效');(value as Record<string,unknown>).categories=[...category];});}
   if(directory){if(this.stopped||scope!==this.key()||config!==this.configKey()||this.app.vault.getAbstractFileByPath(source)!==file)throw new Error('文章属性可能已保存，但仓库设置或文章路径发生改变，目录未保存');const latest=this.state();if(latest.targets[source])throw new Error('文章属性可能已保存，但文章已发布，目录未改变');latest.targetOverrides={...latest.targetOverrides,[source]:cleanPath(directory+'/'+file.name)};this.saveState(latest);await this.writeSharedState();}
   if(!this.stopped)new Notice('已保存选择；请预览并手动发布，尚未修改 GitHub',10000);return true;
  }catch(e){if(!this.stopped)new Notice(`保存失败：${String(e)}`,12000);return false;}finally{this.busy=false;}
 }
 openCoverPicker(file:TFile){
  if(!isArticle(file.path,this.settings.root)){new Notice('请在发布根目录内打开文章');return;}
  if(!this.settings.fluidImages){new Notice('请先在 NoteBridge 设置中开启 Fluid 文章封面和头图');return;}
  new CoverModal(this.app,this,file).open();
 }
 async saveCover(file:TFile,image:TFile,destination:CoverDestination){
  try {
   if(this.stopped)throw new Error('插件已停用');
   if(!this.settings.fluidImages)throw new Error('请先开启 Fluid 文章封面和头图');
   if(this.app.vault.getAbstractFileByPath(file.path)!==file||!isArticle(file.path,this.settings.root))throw new Error('文章已不存在或不在发布目录内');
   if(this.app.vault.getAbstractFileByPath(image.path)!==image)throw new Error('图片已不存在，请重新选择');
   const reference=coverReference(image.path,this.settings);
   await this.app.fileManager.processFrontMatter(file,(fm:unknown)=>{if(!fm||typeof fm!=='object'||Array.isArray(fm))throw new Error('文章属性格式无效');applyCover(fm as Record<string,unknown>,reference,destination);});
   if(!this.stopped)new Notice('封面已写入本地文章属性；请预览并发布以更新网站',8000);return true;
  }catch(e){if(!this.stopped)new Notice(`无法设置封面：${String(e)}`,10000);return false;}
 }
 monitor(sha:string) {
  const generation=++this.generation, scope=this.key(), workflow=this.settings.workflow;
  if(this.monitorTimer!==undefined) window.clearTimeout(this.monitorTimer);
  const started=Date.now(); this.runUrl=undefined;
  const poll=async()=>{
   if(this.stopped || generation!==this.generation || scope!==this.key() || workflow!==this.settings.workflow) return;
   try {
    const result=await this.github().workflowStatus(workflow,sha);
    if(this.stopped || generation!==this.generation || scope!==this.key() || workflow!==this.settings.workflow) return;
    this.runUrl=result.url;
    this.setStatus(`${sha.slice(0,7)}：${result.detail}`);
    if((result.state==='pending'||result.state==='running') && Date.now()-started<600000) this.monitorTimer=window.setTimeout(()=>void poll(),15000);
    else if((result.state==='pending'||result.state==='running')) this.setStatus(`${sha.slice(0,7)}：已提交 GitHub，工作流状态待确认`);
   } catch(e) {
    if(!this.stopped && generation===this.generation && scope===this.key()){this.setStatus(`${sha.slice(0,7)}：查询失败，使用“查看最近提交的工作流状态”查看原因`);this.status.setAttribute('title',String(e));}
   }
  };
  void poll();
 }
 async showDeployment(){
  try {const sha=this.state().commit;if(!sha){new Notice('本机没有已记录的提交');return;}const result=await this.github().workflowStatus(this.settings.workflow,sha);this.runUrl=result.url;this.setStatus(`${sha.slice(0,7)}：${result.detail}`);new DeploymentModal(this.app,this,sha,result.detail,result.url).open();}
  catch(e){new Notice(`已提交 GitHub，部署状态未知：${String(e)}。请检查工作流文件名和 Actions 读取权限。`,12000);}
 }
 async onLocalRename(oldPath:string,newPath:string,isFolder:boolean,scope:string){
  if(this.stopped||scope!==this.key())return;
  if(!isFolder&&!/\.md$/i.test(oldPath))return;
  if(!within(oldPath,this.settings.root)||!within(newPath,this.settings.root))return;
  const state=this.state(),next=renameRecords(state,oldPath,newPath,isFolder);
  if(JSON.stringify(state)===JSON.stringify(next))return;
  this.saveState(next);await this.writeSharedState();
  new Notice('已保留文章原有的发布路径；下次发布会更新原文章',8000);
 }
 async reviewMissingRemote(){
  if(this.busy){new Notice('已有任务正在运行');return;}this.busy=true;
  try{
   await this.renameQueue;const scope=this.key(),config=this.configKey(),state=this.state(),client=this.github(),head=await client.head(),tree=await client.tree(head.tree);
   if(scope!==this.key()||config!==this.configKey())throw new Error('设置已改变，请重新核对');
   const records=Object.entries(state.targets).filter(([source,target])=>!this.app.vault.getAbstractFileByPath(source)&&!tree.has(target)&&/^[a-f0-9]{40}$/i.test(state.baselines[target]||'')).map(([source,target])=>({source,target,baseline:state.baselines[target]}));
   if(!records.length)throw new Error('没有发现本地和远端均缺失且有基线的发布记录；请先等待所有设备同步');
   new MissingRemoteListModal(this.app,this,scope,config,records).open();
  }catch(e){new Notice(`无法核对已删除记录：${String(e)}`,15000);}finally{this.busy=false;}
 }
 async inspectMissingRemote(scope:string,config:string,record:MissingRemoteRecord){
  if(this.busy){new Notice('已有任务正在运行');return;}this.busy=true;
  try{
   if(scope!==this.key()||config!==this.configKey())throw new Error('设置已改变，请重新核对');
   const state=this.state();if(state.targets[record.source]!==record.target||state.baselines[record.target]!==record.baseline||this.app.vault.getAbstractFileByPath(record.source))throw new Error('文章或记录已改变，请重新核对');
   const client=this.github(),head=await client.head(),tree=await client.tree(head.tree);if(tree.has(record.target))throw new Error('远端文件已存在，不能清理');
   const text=await client.blobText(record.baseline);if(scope!==this.key()||config!==this.configKey())throw new Error('设置已改变，请重新核对');
   new MissingRemoteConfirmModal(this.app,this,scope,config,record,text).open();
  }catch(e){new Notice(`无法读取旧记录：${String(e)}`,15000);}finally{this.busy=false;}
 }
 async retireMissingRemote(scope:string,config:string,record:MissingRemoteRecord){
  if(this.busy){new Notice('已有任务正在运行');return;}this.busy=true;
  try{
   if(scope!==this.key()||config!==this.configKey())throw new Error('设置已改变，请重新核对');
   await this.syncRecords({path:record.target,baseline:record.baseline});
   if(scope!==this.key()||config!==this.configKey())throw new Error('设置已改变，请重新核对');
   const state=this.state();
   if(state.retiredSources?.[record.source]===record.target&&!state.targets[record.source]){new Notice('该旧关联已通过同步清理；请等待所有设备同步',12000);return;}
   if(state.targets[record.source]!==record.target||state.baselines[record.target]!==record.baseline||this.app.vault.getAbstractFileByPath(record.source)||state.renames?.[record.source])throw new Error('文章或记录已变化，请重新核对');
   if(Object.entries(state.targets).some(([source,target])=>source!==record.source&&target===record.target)||state.assetSources?.[record.target])throw new Error('旧目标被其他记录共用，不能清理');
   const before=JSON.stringify(state),client=this.github(),head=await client.head(),tree=await client.tree(head.tree);
   if(tree.has(record.target))throw new Error('远端文件已恢复，请重新核对');
   if(scope!==this.key()||config!==this.configKey()||before!==JSON.stringify(this.state())||this.app.vault.getAbstractFileByPath(record.source))throw new Error('文章、记录或设置已改变，请重新核对');
   delete state.targets[record.source];delete state.dates[record.source];if(state.targetOverrides)delete state.targetOverrides[record.source];delete state.baselines[record.target];if(state.overlays)delete state.overlays[record.target];if(state.articleIds)for(const [id,source] of Object.entries(state.articleIds))if(source===record.source)delete state.articleIds[id];state.retiredSources={...state.retiredSources,[record.source]:record.target};this.app.saveLocalStorage(scope,state);
   try{await this.writeSharedState();new Notice('已清理旧关联，未修改 GitHub；请等待所有设备同步',15000);}catch(e){new Notice(`本机已清理旧关联，但同步记录写入失败：${String(e)}；请先修复同步`,15000);}
  }catch(e){new Notice(`未清理旧关联：${String(e)}`,15000);}finally{this.busy=false;}
 }
 async reviewDuplicates(file:TFile){
  if(this.busy){new Notice('已有任务正在运行');return;}this.busy=true;
  try{await this.renameQueue;await this.syncRecords();const state=this.state(),scope=this.key(),config=this.configKey(),currentTarget=state.targets[file.path];
   if(!currentTarget||!state.baselines[currentTarget])throw new Error('当前文章没有已发布记录，请先核对两端同步状态');
   const candidates=Object.entries(state.targets).filter(([source,target])=>source!==file.path&&target!==currentTarget&&!this.app.vault.getAbstractFileByPath(source)&&!!state.baselines[target]&&!state.renames?.[source]);
   if(!candidates.length)throw new Error('没有找到可核对的本机缺失旧记录；请确认坚果云已完成同步');
   new DuplicateListModal(this.app,this,file,scope,config,currentTarget,candidates).open();
  }catch(e){new Notice(`无法核对旧记录：${String(e)}`,12000);}finally{this.busy=false;}
 }
 async inspectDuplicate(file:TFile,scope:string,config:string,oldSource:string,oldTarget:string,currentTarget:string){
  if(this.busy){new Notice('已有任务正在运行');return;}this.busy=true;
  try{if(scope!==this.key()||config!==this.configKey())throw new Error('设置已改变，请重新核对');const state=this.state();
   if(state.targets[file.path]!==currentTarget||state.targets[oldSource]!==oldTarget||this.app.vault.getAbstractFileByPath(oldSource)||this.app.vault.getAbstractFileByPath(file.path)!==file)throw new Error('文章或记录已改变，请重新核对');
   const oldSha=state.baselines[oldTarget],currentSha=state.baselines[currentTarget];if(!oldSha||!currentSha)throw new Error('缺少可靠基线');
   const client=this.github(),head=await client.head(),tree=await client.tree(head.tree);if(tree.get(oldTarget)!==oldSha||tree.get(currentTarget)!==currentSha)throw new Error('GitHub 文章已变化，请先核对冲突，不会清理记录');
   const [oldText,currentText]=await Promise.all([client.blobText(oldSha),client.blobText(currentSha)]);if(scope!==this.key()||config!==this.configKey())throw new Error('设置已改变，请重新核对');
   new RetireDuplicateModal(this.app,this,file,scope,config,oldSource,oldTarget,oldSha,currentTarget,currentSha,oldText,currentText).open();
  }catch(e){new Notice(`无法读取旧文章：${String(e)}`,15000);}finally{this.busy=false;}
 }
 async retireDuplicate(file:TFile,scope:string,config:string,oldSource:string,oldTarget:string,oldSha:string,currentTarget:string,currentSha:string){
  if(this.busy){new Notice('已有任务正在运行');return;}this.busy=true;
  try{await this.syncRecords();if(scope!==this.key()||config!==this.configKey())throw new Error('设置已改变，请重新核对');const state=this.state();
   if(this.app.vault.getAbstractFileByPath(file.path)!==file||this.app.vault.getAbstractFileByPath(oldSource)||state.targets[file.path]!==currentTarget||state.targets[oldSource]!==oldTarget||state.baselines[oldTarget]!==oldSha||state.baselines[currentTarget]!==currentSha||state.renames?.[oldSource])throw new Error('文章或记录已变化，请重新核对');
   if(Object.entries(state.targets).some(([source,target])=>source!==oldSource&&target===oldTarget)||state.assetSources?.[oldTarget])throw new Error('旧目标被其他记录共用，不能清理');
   const stateBefore=JSON.stringify(state),client=this.github(),head=await client.head(),tree=await client.tree(head.tree);if(tree.get(oldTarget)!==oldSha||tree.get(currentTarget)!==currentSha)throw new Error('GitHub 文章已变化，请重新核对');
   if(scope!==this.key()||config!==this.configKey()||stateBefore!==JSON.stringify(this.state())||this.app.vault.getAbstractFileByPath(oldSource)||this.app.vault.getAbstractFileByPath(file.path)!==file)throw new Error('文章、记录或设置已改变，请重新核对');
   delete state.targets[oldSource];delete state.dates[oldSource];if(state.targetOverrides)delete state.targetOverrides[oldSource];delete state.baselines[oldTarget];if(state.overlays)delete state.overlays[oldTarget];if(state.articleIds)for(const [id,source] of Object.entries(state.articleIds))if(source===oldSource)delete state.articleIds[id];state.retiredSources={...state.retiredSources,[oldSource]:oldTarget};this.app.saveLocalStorage(scope,state);
   try{await this.writeSharedState();new Notice('已清理旧发布关联，未修改 GitHub；请等待各设备同步',12000);}catch(e){new Notice(`本机已清理旧关联，但同步记录写入失败：${String(e)}；请先修复同步`,15000);}
  }catch(e){new Notice(`未清理旧关联：${String(e)}`,15000);}finally{this.busy=false;}
 }
 onLocalDelete(path:string,isFolder:boolean){
  try {
   const scope=this.key(), state=this.state();
   if(this.deletionScope!==scope){this.deleted.clear();this.deletionScope=scope;}
   for(const source of Object.keys(state.targets)) if(source===path || (isFolder && source.startsWith(path+'/'))) this.deleted.add(source);
   if(!this.deleted.size)return;
   if(this.deletionTimer!==undefined) window.clearTimeout(this.deletionTimer);
   this.deletionTimer=window.setTimeout(()=>{
    this.deletionTimer=undefined;
    if(this.stopped || scope!==this.key()){this.deleted.clear();return;}
    try {
     const current=this.state();const records=[...this.deleted].filter(source=>!this.app.vault.getAbstractFileByPath(source) && !!current.targets[source]).map(source=>({source,target:current.targets[source],exists:false}));this.deleted.clear();
     if(records.length===1)new WithdrawConfirmModal(this.app,this,scope,records[0],true).open();
     else if(records.length>1)new WithdrawListModal(this.app,this,scope,records,true).open();
    }catch(e){this.deleted.clear();new Notice(`无法检查发布记录：${String(e)}`,10000);}
   },500);
  }catch(e){new Notice(`无法检查发布记录：${String(e)}`,10000);}
 }
 openWithdraw(source?:string){
  try {const state=this.state(), scope=this.key();const records=Object.entries(state.targets).filter(([src])=>!source||src===source).map(([src,target])=>({source:src,target,exists:!!this.app.vault.getAbstractFileByPath(src)}));
   if(!records.length){new Notice('本机没有这篇文章的发布记录；无法安全撤回');return;}
   new WithdrawListModal(this.app,this,scope,records).open();
  } catch(e){new Notice(String(e),10000);}
 }
 async withdraw(scope:string,source:string,target:string){
  if(this.busy){new Notice('已有任务正在运行');return;}
  if(scope!==this.key()){new Notice('仓库或分支已改变，请重新打开撤回列表');return;}
  this.busy=true;this.setStatus('正在撤回');
  try {
   await this.syncRecords();
   const state=this.state();
   if(state.targets[source]!==target || Object.entries(state.targets).some(([s,t])=>s!==source && t===target)) throw new Error('发布映射已改变或目标被多篇文章共用，不能撤回');
   const baseline=state.baselines[target]; if(!baseline) throw new Error('本机缺少远端基线，不能撤回');
   const client=this.github(),config=this.configKey(),before=JSON.parse(JSON.stringify(state)) as State,eventId=Array.from(crypto.getRandomValues(new Uint8Array(16)),x=>x.toString(16).padStart(2,'0')).join(''),articleId=Object.entries(state.articleIds||{}).find(([,path])=>path===source)?.[0];
   const afterFor=(sha:string):State=>{const next=JSON.parse(JSON.stringify(before)) as State;next.withdrawals={...next.withdrawals,[eventId]:{source,target,baseline,commit:sha,...(articleId?{articleId}:{})}};delete next.targets[source];delete next.baselines[target];if(next.overlays)delete next.overlays[target];next.commit=sha;return next;};
   const sha=await client.withdraw(target,baseline,async(candidate,parent)=>{if(scope!==this.key()||config!==this.configKey()||JSON.stringify(this.state())!==JSON.stringify(before))throw new Error('设置或记录已变化，请重新撤回');this.saveOperation({version:1,scope,config,kind:'withdraw',candidate,parent,expected:{[target]:null},before,after:afterFor(candidate)});});
   this.app.saveLocalStorage(scope,afterFor(sha));
   try{await this.writeSharedState();this.clearOperation();}catch(e){new Notice(`GitHub 已提交撤回，但同步记录写入失败：${String(e)}。请使用中断恢复并先修复同步。`,15000);}
   if(!this.stopped && scope===this.key()){this.setStatus('已提交撤回，正在查询工作流');this.monitor(sha);new Notice(`已提交撤回 ${sha.slice(0,7)}；网站更新取决于工作流`,10000);}
  } catch(e){if(!this.stopped){this.setStatus('撤回失败或冲突');new Notice(String(e),15000);}}finally{this.busy=false;}
 }
 async prepareRepublish(file:TFile){
  if(this.busy){new Notice('已有任务正在运行');return;}this.busy=true;
  try{await this.renameQueue;await this.syncRecords();const state=this.state(),scope=this.key(),config=this.configKey();const events=Object.entries(state.withdrawals||{}).filter(([id,event])=>!state.withdrawalReleases?.[id]&&resolveRenamedPath(event.source,state.renames||{})===file.path);
   if(events.length!==1)throw new Error(events.length?'该文章有多个未解决的撤回事件，请先核对记录':'当前文章没有已同步的撤回记录');
   const [eventId,event]=events[0];if(this.app.vault.getAbstractFileByPath(file.path)!==file)throw new Error('本地文章已变化');new RepublishConfirmModal(this.app,this,file,scope,config,eventId,event).open();
  }catch(e){new Notice(`无法准备重新发布：${String(e)}`,15000);}finally{this.busy=false;}
 }
 async confirmRepublish(file:TFile,scope:string,config:string,eventId:string,event:WithdrawalEvent){
  if(this.busy){new Notice('已有任务正在运行');return;}this.busy=true;
  try{await this.syncRecords();if(scope!==this.key()||config!==this.configKey())throw new Error('设置已改变，请重新操作');const state=this.state(),current=state.withdrawals?.[eventId];
   if(!current||JSON.stringify(current)!==JSON.stringify(event)||state.withdrawalReleases?.[eventId]||resolveRenamedPath(event.source,state.renames||{})!==file.path||this.app.vault.getAbstractFileByPath(file.path)!==file)throw new Error('撤回记录或文章已改变，请重新操作');
   const active=Object.entries(state.withdrawals||{}).filter(([id,e])=>!state.withdrawalReleases?.[id]&&resolveRenamedPath(e.source,state.renames||{})===file.path);if(active.length!==1)throw new Error('存在其他未解决撤回记录');
   if(state.targets[file.path]||Object.entries(state.targets).some(([src,target])=>src!==file.path&&target===event.target)||state.assetSources?.[event.target])throw new Error('文章目标已有其他记录，请先核对');
   const before=JSON.stringify(state),client=this.github(),head=await client.head(),tree=await client.tree(head.tree);if(tree.has(event.target))throw new Error('远端目标已存在，不能自动重新发布');
   if(scope!==this.key()||config!==this.configKey()||before!==JSON.stringify(this.state())||this.app.vault.getAbstractFileByPath(file.path)!==file)throw new Error('文章或记录已改变，请重新操作');
   state.withdrawalReleases={...state.withdrawalReleases,[eventId]:'released'};state.targets[file.path]=event.target;this.app.saveLocalStorage(scope,state);await this.writeSharedState();new Notice('已允许重新发布；请等待同步完成后重新预览并确认提交',15000);
  }catch(e){new Notice(`无法允许重新发布：${String(e)}`,15000);}finally{this.busy=false;}
 }
 async snapshot(only?:TFile,allowOverlayConflict=false):Promise<Snapshot>{
  const scope=this.key(), config=this.configKey(),renameGeneration=this.renameGeneration;let state=this.state();let overlayConflict:Snapshot['overlayConflict'];const plans:Plan[]=[],problems:string[]=[],preparedContents:Record<string,string>={},sourceHashes:Record<string,string>={};
  const allFiles=typeof this.app.vault.getMarkdownFiles==='function'?this.app.vault.getMarkdownFiles().filter(f=>isArticle(f.path,this.settings.root)):(only?[only]:[]),files=only?[only]:allFiles;
  const noteIds=new Map<string,string>();
  for(const f of allFiles){const content=await this.app.vault.read(f),id=noteIdentity(content);if(!id)continue;const prior=noteIds.get(id);if(prior&&prior!==f.path)throw new Error(`两篇笔记使用了相同的 NoteBridge 标识：${prior} / ${f.path}；请先核对副本`);noteIds.set(id,f.path);}
  for(const [id,source] of noteIds){const old=state.articleIds?.[id];if(old&&old!==source){if(this.app.vault.getAbstractFileByPath(old))throw new Error(`同一文章标识的旧路径仍存在：${old}；请先核对`);state=renameRecords(state,old,source,false);if(scope!==this.key()||config!==this.configKey()||renameGeneration!==this.renameGeneration)throw new Error('设置或文章路径已改变，请重新预览');this.app.saveLocalStorage(scope,state);}}
  for(const file of files) { try {
   if(!isArticle(file.path,this.settings.root)) throw new Error('文件不属于发布范围');
   if(Object.entries(state.withdrawals||{}).some(([id,event])=>!state.withdrawalReleases?.[id]&&resolveRenamedPath(event.source,state.renames||{})===file.path))throw new Error('文章已撤回；如需重新发布，请先运行重新发布已撤回的当前文章');
   if(state.renames?.[file.path]||state.retiredSources?.[file.path])throw new Error('此路径曾被重命名或清理，不能自动识别为新文章；请先核对发布记录');
   if(!state.targets[file.path]){const missing=Object.entries(state.targets).filter(([source,target])=>source!==file.path&&within(source,this.settings.root)&&/^[a-f0-9]{40}$/i.test(state.baselines[target]||'')&&!this.app.vault.getAbstractFileByPath(source)).map(([source])=>source);if(missing.length)throw new Error(`存在已发布但本机缺失的文章，可能发生离线重命名或同步未完成：${missing.join('、')}；为避免重复发布已停止，请先核对`);}
   let content=await this.app.vault.read(file);let id=noteIdentity(content);
   // Persist the first preparation date locally, independent of filesystem creation time.
   if(scope!==this.key()||config!==this.configKey()||renameGeneration!==this.renameGeneration)throw new Error('设置或文章路径已改变，请重新预览');
   if(!state.dates[file.path]) {state.dates[file.path]=new Date().toISOString();this.app.saveLocalStorage(scope,state);}
   const target=state.targets[file.path]||state.targetOverrides?.[file.path];
   if(target&&(!within(target,this.settings.posts)||cleanPath(target)!==target||!target.toLowerCase().endsWith('.md')))throw new Error('文章目标路径不在配置的远端文章目录内');
   const plan=prepare(file.path,content,this.settings,state.dates[file.path],(ref,src)=>this.app.metadataCache.getFirstLinkpathDest(ref,src)?.path||null,target);
   if(plan){
    const knownId=Object.entries(state.articleIds||{}).find(([,source])=>source===file.path)?.[0];
    if(id&&knownId&&id!==knownId)throw new Error('文章标识与发布记录不一致，请先核对');
    const journalKey='notebridge-identity-pending:'+scope+':'+file.path;const pending:unknown=this.app.loadLocalStorage(journalKey);const pendingIdentity=pending&&typeof pending==='object'&&!Array.isArray(pending)?pending as {source?:unknown;id?:unknown}:undefined;
    if(id&&!state.articleIds?.[id]){if(pendingIdentity?.source!==file.path||pendingIdentity.id!==id)throw new Error('文章已有 NoteBridge 标识，但本机没有对应记录；请等待同步记录完成后再发布');state.articleIds={...state.articleIds,[id]:file.path};this.app.saveLocalStorage(scope,state);this.app.saveLocalStorage(journalKey,null);}
    if(id&&state.articleIds?.[id]&&state.articleIds[id]!==file.path)throw new Error('文章标识与其他文章的发布记录冲突');
    if(!id){if(knownId)throw new Error('已发布文章的 NoteBridge 标识缺失，请先恢复标识');
     let candidate:string;do{candidate=Array.from(crypto.getRandomValues(new Uint8Array(16)),x=>x.toString(16).padStart(2,'0')).join('');}while(noteIds.has(candidate)||state.articleIds?.[candidate]);
     if(this.stopped||scope!==this.key()||config!==this.configKey()||renameGeneration!==this.renameGeneration||this.app.vault.getAbstractFileByPath(file.path)!==file)throw new Error('文章或设置已改变，请重新预览');
     this.app.saveLocalStorage(journalKey,{source:file.path,id:candidate});
     let writtenId='',created=false;
     await this.app.vault.process(file,current=>{const result=ensureIdentity(current,candidate);writtenId=result.id;created=result.created;return result.text;});
     content=await this.app.vault.read(file);id=noteIdentity(content);if(!id||id!==writtenId)throw new Error('文章标识在写入后发生变化，请重新预览');
     if(!created){this.app.saveLocalStorage(journalKey,null);if(state.articleIds?.[id]!==file.path)throw new Error('检测到已有文章标识；请等待另一设备的发布记录同步后重新预览');}
     const prior=noteIds.get(id);if(prior&&prior!==file.path)throw new Error(`两篇笔记使用了相同的 NoteBridge 标识：${prior} / ${file.path}；请先核对副本`);
     state.articleIds={...state.articleIds,[id]:file.path};this.app.saveLocalStorage(scope,state);this.app.saveLocalStorage(journalKey,null);
     const after=prepare(file.path,content,this.settings,state.dates[file.path],(ref,src)=>this.app.metadataCache.getFirstLinkpathDest(ref,src)?.path||null,target);if(!after||after.content!==plan.content)throw new Error('文章在添加标识时发生变化，请重新预览');noteIds.set(id,file.path);
    }
    if(this.stopped||scope!==this.key()||config!==this.configKey()||renameGeneration!==this.renameGeneration||this.app.vault.getAbstractFileByPath(file.path)!==file)throw new Error('文章或设置已改变，请重新预览');
    state.articleIds={...state.articleIds,[id]:file.path};this.app.saveLocalStorage(scope,state);sourceHashes[file.path]=await blobHash(new TextEncoder().encode(content));
    preparedContents[plan.target]=plan.content;const overlay=state.overlays?.[plan.target],merged=await prepareWithOverlay(plan.content,overlay,state.baselines[plan.target]);if(merged.conflicts){if(!allowOverlayConflict||!only||!overlay)throw new Error('本地修改与先前保留的远端修改冲突，请运行比较并合并当前文章的发布冲突');overlayConflict={base:overlay.base,remote:overlay.merged,merged:merged.text,conflicts:merged.conflicts};}else{plan.content=merged.text;assertUploadSafe(plan.content);}plans.push(plan);
   }
  }catch(e){problems.push(`${file.path}：${String(e)}`);} }
  const map=new Map<string,Item>(), origins=new Map<string,string>(), assetOwners:Record<string,string>={},assetBytes=new Map<string,Uint8Array>();
  for(const p of plans){
   const add=(path:string,bytes:Uint8Array,source:string)=>{const existing=origins.get(path);if(existing && existing!==source) throw new Error(`目标路径冲突：${path}（${existing} / ${source}）`);origins.set(path,source);map.set(path,{path,bytes});};
   try {add(p.target,new TextEncoder().encode(p.content),p.source);for(const a of p.assets){const f=this.app.vault.getAbstractFileByPath(a.source);if(!(f instanceof TFile)) throw new Error(`等待附件：${a.source}`);let bytes=assetBytes.get(a.source);if(!bytes){bytes=new Uint8Array(await this.app.vault.readBinary(f));assetBytes.set(a.source,bytes);}add(a.target,bytes,a.source);assetOwners[a.target]=a.source;}} catch(e){problems.push(`${p.source}：${String(e)}`);}
  }
  if(scope!==this.key()||config!==this.configKey()||renameGeneration!==this.renameGeneration)throw new Error('设置或文章路径已改变，请重新预览');
  return {plans,items:[...map.values()],problems,scope,config,assetOwners,preparedContents,sourceHashes,stateAtPreview:JSON.stringify(state),overlayConflict};
 }
 async resolveConflict(file:TFile){
  if(this.busy){new Notice('已有任务正在运行');return;}this.busy=true;
  try{
   const initial=this.state(),target=initial.targets[file.path],oldBaseline=target&&initial.baselines[target];
   if(!target||!oldBaseline||!/^[a-f0-9]{40}$/.test(oldBaseline))throw new Error('当前文章没有可靠的已发布路径和基线，不能自动接管远端文件');
   await this.syncRecords({path:target,baseline:oldBaseline});const state=this.state();
   if(state.targets[file.path]!==target||state.baselines[target]!==oldBaseline)throw new Error('发布记录已变化，请重新打开冲突比较');
   const snap=await this.snapshot(file,true);if(snap.problems.length||snap.plans.length!==1)throw new Error(snap.problems.join('；')||'文章不能发布');
   const client=this.github(),head=await client.head(),tree=await client.tree(head.tree),remoteSha=tree.get(target);
   if(!remoteSha||! /^[a-f0-9]{40}$/.test(remoteSha))throw new Error('远端文章不存在或不是文件，不能自动合并');
   if(snap.overlayConflict){if(remoteSha!==oldBaseline)throw new Error('远端也发生变化，请先核对远端内容，不能同时自动处理两种冲突');const conflict=snap.overlayConflict;snap.resolution={path:target,oldBaseline,remoteSha};new ConflictModal(this.app,this,snap,conflict.base,conflict.remote,conflict.merged,conflict.conflicts).open();return;}
   if(remoteSha===oldBaseline)throw new Error('远端文章与基线一致，可直接预览发布');
   const [base,remote]=await Promise.all([client.blobText(oldBaseline),client.blobText(remoteSha)]);
   if(snap.scope!==this.key()||snap.config!==this.configKey()||snap.stateAtPreview!==JSON.stringify(this.state()))throw new Error('设置或记录已变化，请重新比较');
   const result=mergeThreeWay(base,snap.plans[0].content,remote);snap.resolution={path:target,oldBaseline,remoteSha};
   new ConflictModal(this.app,this,snap,base,remote,result.text,result.conflicts).open();
  }catch(e){new Notice(`无法比较冲突：${String(e)}`,15000);}finally{this.busy=false;}
 }
 async applyConflict(snap:Snapshot,text:string){
  try{
   if(/^(?:<<<<<<< |=======\s*$|>>>>>>> )/m.test(text))throw new Error('请先处理并移除所有冲突标记');
   if(!snap.resolution||snap.plans.length!==1)throw new Error('冲突预览无效');assertUploadSafe(text);
   if(snap.scope!==this.key()||snap.config!==this.configKey()||snap.stateAtPreview!==JSON.stringify(this.state()))throw new Error('设置或记录已变化，请重新比较');
   const path=snap.resolution.path,plan=snap.plans[0];if(plan.target!==path)throw new Error('文章目标已变化');
   const updated={...snap,plans:[{...plan,content:text}],items:snap.items.map(item=>item.path===path?{...item,bytes:new TextEncoder().encode(text)}:item)};
   new PreviewModal(this.app,this,updated,true).open();
  }catch(e){new Notice(`无法确认合并：${String(e)}`,12000);}
 }
 async preview(publish:boolean,only?:TFile){
  if(this.busy){new Notice('已有任务正在运行');return;} this.busy=true; this.setStatus('准备中');
  try {await this.renameQueue;await this.syncRecords();const snap=await this.snapshot(only);await this.writeSharedState();new PreviewModal(this.app,this,snap,publish).open();this.setStatus(`${snap.plans.length} 篇待检查`);}catch(e){this.setStatus('失败');new Notice(`${String(e)}；文章冲突可打开文章后运行“比较并合并当前文章的发布冲突”`,12000);if(only)try{const target=this.state().targets[only.path];if(target&&String(e).includes(`同步记录与 GitHub 不一致：${target}`))window.setTimeout(()=>{if(!this.stopped)void this.resolveConflict(only);},0);}catch{/* 状态损坏时保持原错误 */}}finally{this.busy=false;}
 }
 async submit(snap:Snapshot){
  if(this.busy){new Notice('已有任务正在运行');return;} if(snap.problems.length){new Notice('存在错误，不能发布');return;} if(!snap.items.length){new Notice('没有可发布的文章');return;}
  if(this.stopped||snap.scope!==this.key()||snap.config!==this.configKey()){new Notice('发布设置已改变，请重新预览');return;}
  this.busy=true;this.setStatus('上传中');
  try {
   await this.renameQueue;const resolution=snap.resolution;await this.syncRecords(resolution?{path:resolution.path,baseline:resolution.oldBaseline}:undefined);const state=this.state(), client=this.github(), newOwners:Record<string,string>={};
   if(snap.stateAtPreview!==undefined&&snap.stateAtPreview!==JSON.stringify(state))throw new Error('设备间发布记录已变化，请重新预览文章，避免覆盖较新版本');
   for(const p of snap.plans){
    assertUploadSafe(p.content);const articleItem=snap.items.find(item=>item.path===p.target);if(!articleItem||new TextDecoder('utf-8',{fatal:true}).decode(articleItem.bytes)!==p.content)throw new Error('文章上传快照不一致，请重新预览');
    const selected=state.targets[p.source]||state.targetOverrides?.[p.source];if(selected&&selected!==p.target)throw new Error(`文章目标路径已改变：${p.source}，请重新预览`);
    if(state.assetSources?.[p.target])throw new Error(`文章目标与已管理图片冲突：${p.target}`);
    if(Object.entries(state.targets).some(([source,target])=>source!==p.source && target===p.target))throw new Error(`文章目标已由另一篇文章使用：${p.target}`);
    if(state.baselines[p.target]&&!Object.values(state.targets).includes(p.target))throw new Error(`目标 ${p.target} 存在旧基线但缺少文章映射，不能安全接管`);
   }
   for(const [path,source] of Object.entries(snap.assetOwners)){
    const old=state.assetSources?.[path], baseline=state.baselines[path];
    if(Object.values(state.targets).includes(path))throw new Error(`图片目标路径与已管理文章冲突：${path}`);
    if(old && old!==source)throw new Error(`图片目标冲突：${path} 已由 ${old} 使用，不能被 ${source} 覆盖`);
    const item=snap.items.find(x=>x.path===path);if(!item)throw new Error(`缺少图片快照：${path}`);
    if(!old && baseline && await blobHash(item.bytes)!==baseline)throw new Error(`图片 ${path} 的旧记录没有来源信息，无法安全覆盖；请更换图片名称或路径`);
    if(!old&&!baseline)newOwners[path]=source;
   }
   if(this.stopped||snap.scope!==this.key()||snap.config!==this.configKey())throw new Error('发布设置已改变，请重新预览');
   const baseline={...state.baselines};if(resolution){if(snap.plans.length!==1||snap.plans[0].target!==resolution.path||state.baselines[resolution.path]!==resolution.oldBaseline||!/^[a-f0-9]{40}$/.test(resolution.remoteSha))throw new Error('冲突比较已失效，请重新比较');const source=snap.plans[0].source,sourceHash=snap.sourceHashes?.[source];if(sourceHash){const current=this.app.vault.getAbstractFileByPath(source);if(!(current instanceof TFile)||await blobHash(new TextEncoder().encode(await this.app.vault.read(current)))!==sourceHash)throw new Error('本地文章在比较后已变化，请重新比较');}baseline[resolution.path]=resolution.remoteSha;}
   if(this.stopped||snap.scope!==this.key()||snap.config!==this.configKey())throw new Error('发布设置已改变，请重新预览');
   const before=JSON.parse(JSON.stringify(state)) as State,config=this.configKey();
   const stateAfter=(hashes:Record<string,string>,sha:string|null):State=>{const next=JSON.parse(JSON.stringify(before)) as State,managed={...hashes};Object.assign(next.baselines,managed);next.assetSources={...next.assetSources,...newOwners};next.overlays={...next.overlays};for(const p of snap.plans){next.targets[p.source]=p.target;const original=snap.preparedContents?.[p.target];if(original!==undefined&&(resolution?.path===p.target||next.overlays[p.target])){if(original===p.content)delete next.overlays[p.target];else next.overlays[p.target]={base:original,merged:p.content,hash:hashes[p.target]};}}if(sha)next.commit=sha;return next;};
   const result=await client.publish(snap.items,baseline,async(candidate,parent,hashes)=>{if(snap.scope!==this.key()||config!==this.configKey()||JSON.stringify(this.state())!==JSON.stringify(before))throw new Error('设置或记录已变化，请重新预览');this.saveOperation({version:1,scope:snap.scope,config,kind:'publish',candidate,parent,expected:{...hashes},before,after:stateAfter(hashes,candidate)});});
   const next=stateAfter(result.hashes,result.sha);this.app.saveLocalStorage(snap.scope,next);try{await this.writeSharedState();this.clearOperation();}catch(e){new Notice(`GitHub 已提交，但同步记录写入失败：${String(e)}。请使用中断恢复并先修复同步。`,15000);}if(!this.stopped&&snap.scope===this.key()){this.setStatus(result.sha?'已提交 GitHub，正在查询工作流':'没有变化，正在查询上次工作流');new Notice(result.sha?`已提交 ${result.sha.slice(0,7)}，正在查询工作流`:'没有变化，无需提交；正在查询上次工作流',10000);if(next.commit)this.monitor(next.commit);else this.setStatus('没有变化');}}
  catch(e){if(!this.stopped){this.setStatus('失败或冲突');new Notice(`${String(e)}；文章冲突可运行“比较并合并当前文章的发布冲突”`,15000);if(snap.plans.length===1&&!snap.resolution){const plan=snap.plans[0],message=String(e),file=this.app.vault.getAbstractFileByPath(plan.source);if(file instanceof TFile&&(message.includes(`冲突：${plan.target}：`)||message.includes(`同步记录与 GitHub 不一致：${plan.target}`)))window.setTimeout(()=>{if(!this.stopped)void this.resolveConflict(file);},0);}}}finally{this.busy=false;}
 }
}
function addHomeButton(modal:Modal,plugin:NoteBridge,file?:TFile){
 new Setting(modal.contentEl).addButton(b=>b.setButtonText('返回主页').onClick(()=>{modal.close();plugin.openControlCenter(file);}));
}
class ControlCenterModal extends Modal {
 constructor(app:App,private plugin:NoteBridge,private selected?:TFile){super(app);}
 onOpen(){
  const el=this.contentEl,active=this.selected||this.app.workspace.getActiveFile();
  const valid=active instanceof TFile&&isArticle(active.path,this.plugin.settings.root)?active:undefined;
  el.createEl('h2',{text:'NoteBridge 操作中心'});
  el.createEl('p',{text:valid?`当前文章：${valid.path}`:'请先打开发布目录内的文章，或从文章菜单打开操作中心。'});
  const action=(title:string,description:string,label:string,run:()=>void,needsFile=false)=>new Setting(el).setName(title).setDesc(description).addButton(b=>b.setButtonText(label).setDisabled(needsFile&&!valid).onClick(()=>{this.close();run();}));
  el.createEl('h3',{text:'日常发布'});
  action('预览并发布当前文章','检查上传内容与图片，确认后提交。','打开',()=>{if(valid)void this.plugin.preview(true,valid);},true);
  action('文章封面和头图','选择本地图片并写入文章属性。','选择',()=>{if(valid)this.plugin.openCoverPicker(valid);},true);
  action('分类和文章目录','从网站现有分类与目录中选择。','选择',()=>{if(valid)this.plugin.openCategoryPicker(valid);},true);
  action('发布问题','遇到问题时点这里，插件会自动检查并修复。','一键修复',()=>void this.plugin.repair(valid,true));
  action('文章发布状态','查看本地变化及只读核验 GitHub。','查看',()=>new ArticleStatusModal(this.app,this.plugin).open());
  el.createEl('h3',{text:'批量与部署'});
  action('预览发布范围','检查发布目录内所有可发布文章。','预览',()=>void this.plugin.preview(false));
  action('同步全部变化','预览所有文章，确认后提交。','打开',()=>void this.plugin.preview(true));
  action('工作流状态','查看最近提交的部署工作流。','查看',()=>void this.plugin.showDeployment());
  action('测试 GitHub 连接','只读检查仓库和分支。','测试',()=>void this.plugin.test(true,valid));
  const actionIn=(parent:HTMLElement,title:string,description:string,label:string,run:()=>void,disabled=false)=>new Setting(parent).setName(title).setDesc(description).addButton(b=>b.setButtonText(label).setDisabled(disabled).onClick(()=>{this.close();run();}));
  const advanced=el.createEl('details');advanced.createEl('summary',{text:'文章管理'});
  actionIn(advanced,'撤回已发布文章','选择文章，核对后撤回线上版本。','查看',()=>this.plugin.openWithdraw());
  actionIn(advanced,'重新发布已撤回文章','允许当前文章重新进入发布流程。','处理',()=>{if(valid)void this.plugin.prepareRepublish(valid);},!valid);
 }
 onClose(){this.contentEl.empty();}
}
class RepairResultModal extends Modal {
 constructor(app:App,private plugin:NoteBridge,private file:TFile|undefined,private compare:boolean,private detail:string){super(app);}
 onOpen(){const el=this.contentEl;el.createEl('h2',{text:'需要进一步处理'});el.createEl('p',{text:this.compare?'这篇文章有不同版本，请选择要保留的内容。':'这次无法安全自动修复。请确认网络、账号权限和坚果云同步状态后重试；如果仍有问题，可查看下面的详细信息。'});const details=el.createEl('details');details.createEl('summary',{text:'查看详细信息'});details.createEl('pre',{text:this.detail});addHomeButton(this,this.plugin,this.file);if(this.compare&&this.file)new Setting(el).addButton(b=>b.setButtonText('查看并选择').setCta().onClick(()=>{const file=this.file;this.close();if(file)void this.plugin.resolveConflict(file);}));}
 onClose(){this.contentEl.empty();}
}
class RepublishConfirmModal extends Modal {
 constructor(app:App,private plugin:NoteBridge,private file:TFile,private recordScope:string,private config:string,private eventId:string,private event:WithdrawalEvent){super(app);}
 onOpen(){const el=this.contentEl;el.createEl('h2',{text:'允许重新发布已撤回的文章'});el.createEl('p',{text:`文章：${this.file.path}；原远端路径：${this.event.target}。此操作只解除撤回状态，不会立即发布；接下来仍需预览并确认提交。请先确认其他设备同步完成。`});addHomeButton(this,this.plugin,this.file);new Setting(el).addButton(b=>b.setButtonText('取消').onClick(()=>this.close())).addButton(b=>b.setButtonText('允许重新发布').setCta().onClick(()=>{this.close();void this.plugin.confirmRepublish(this.file,this.recordScope,this.config,this.eventId,this.event);}));}
 onClose(){this.contentEl.empty();}
}
interface MissingRemoteRecord {source:string;target:string;baseline:string}
class MissingRemoteListModal extends Modal {
 constructor(app:App,private plugin:NoteBridge,private recordScope:string,private config:string,private records:MissingRemoteRecord[]){super(app);}
 onOpen(){this.contentEl.createEl('h2',{text:'核对远端已删除的旧发布记录'});this.contentEl.createEl('p',{text:'以下记录的原本地路径和远端文件均不存在。请先确认同步完成，并确认不是笔记改名或尚未同步；清理关联不会恢复或删除文件。'});addHomeButton(this,this.plugin);for(const record of this.records)new Setting(this.contentEl).setName(record.source).setDesc(`远端：${record.target}`).addButton(b=>b.setButtonText('核对').onClick(()=>{this.close();void this.plugin.inspectMissingRemote(this.recordScope,this.config,record);}));}
 onClose(){this.contentEl.empty();}
}
class MissingRemoteConfirmModal extends Modal {
 constructor(app:App,private plugin:NoteBridge,private recordScope:string,private config:string,private record:MissingRemoteRecord,private text:string){super(app);}
 onOpen(){const el=this.contentEl;el.createEl('h2',{text:'确认清理旧发布关联'});el.createEl('p',{text:`旧本地路径：${this.record.source}；已不存在的远端路径：${this.record.target}`});el.createEl('p',{text:'请阅读上次发布内容，确认这条关联确实不再需要，且不是尚未同步的改名文章。清理不会修改 GitHub 或笔记，之后仍需等待同步。'});const d=el.createEl('details');d.createEl('summary',{text:'查看上次发布的文章内容'});d.createEl('pre',{text:this.text});addHomeButton(this,this.plugin);new Setting(el).addButton(b=>b.setButtonText('取消').onClick(()=>this.close())).addButton(b=>b.setButtonText('确认清理旧关联').setWarning().onClick(()=>{this.close();void this.plugin.retireMissingRemote(this.recordScope,this.config,this.record);}));}
 onClose(){this.contentEl.empty();}
}
interface WithdrawRecord {source:string;target:string;exists:boolean}
class DuplicateListModal extends Modal{
 constructor(app:App,private plugin:NoteBridge,private file:TFile,private recordScope:string,private config:string,private currentTarget:string,private candidates:[string,string][]){super(app);}
 onOpen(){const el=this.contentEl;el.createEl('h2',{text:'核对旧重复发布记录'});el.createEl('p',{text:`当前文章：${this.file.path}；保留的远端目标：${this.currentTarget}。以下只是本机缺失的旧记录，不代表它们一定是重复文章。`});addHomeButton(this,this.plugin,this.file);
  for(const [source,target] of this.candidates)new Setting(el).setName(source).setDesc(target).addButton(b=>b.setButtonText('比较').onClick(()=>{this.close();void this.plugin.inspectDuplicate(this.file,this.recordScope,this.config,source,target,this.currentTarget);}));
 }
 onClose(){this.contentEl.empty();}
}
class RetireDuplicateModal extends Modal{
 constructor(app:App,private plugin:NoteBridge,private file:TFile,private recordScope:string,private config:string,private oldSource:string,private oldTarget:string,private oldSha:string,private currentTarget:string,private currentSha:string,private oldText:string,private currentText:string){super(app);}
 onOpen(){const el=this.contentEl;el.createEl('h2',{text:'确认两条记录是否为同一篇文章'});el.createEl('p',{text:`保留 ${this.currentTarget}；清理本机缺失笔记 ${this.oldSource} 到 ${this.oldTarget} 的旧关联。操作不会删除或修改 GitHub 文件；请确认确实是同一篇文章。`});
  for(const [label,text] of [['旧远端文章',this.oldText],['保留的远端文章',this.currentText]]){const d=el.createEl('details');d.createEl('summary',{text:label});d.createEl('pre',{text});}
  addHomeButton(this,this.plugin,this.file);new Setting(el).addButton(b=>b.setButtonText('取消').onClick(()=>this.close())).addButton(b=>b.setButtonText('确认清理旧关联').setCta().onClick(()=>{this.close();void this.plugin.retireDuplicate(this.file,this.recordScope,this.config,this.oldSource,this.oldTarget,this.oldSha,this.currentTarget,this.currentSha);}));
 }
 onClose(){this.contentEl.empty();}
}
class ConflictModal extends Modal {
 constructor(app:App,private plugin:NoteBridge,private snap:Snapshot,private base:string,private remote:string,private merged:string,private conflicts:number){super(app);}
 onOpen(){const el=this.contentEl;el.createEl('h2',{text:'比较并合并文章冲突'});
  el.createEl('p',{text:`目标：${this.snap.resolution?.path||''}。检测到 ${this.conflicts} 处重叠修改；请检查合并结果。下面的内容是网站上传副本，不会直接覆盖本地笔记。`});
  el.createEl('p',{text:'远端变更会保存在发布记录中，供下次发布时重新合并；请确保坚果云同步 NoteBridge同步记录 文件夹。自行编辑上传副本中的图片链接不会自动上传新图片。'});
  for(const [label,content] of [['上次发布的版本',this.base],['本次准备上传的版本',this.snap.plans[0].content],['GitHub 当前版本',this.remote]]){const d=el.createEl('details');d.createEl('summary',{text:label});d.createEl('pre',{text:content});}
  el.createEl('h3',{text:'合并结果（可编辑）'});const area=el.createEl('textarea',{cls:'notebridge-merge-editor',attr:{'aria-label':'合并结果',rows:'18'}});area.value=this.merged;
  el.createEl('p',{text:'请检查全部内容并处理所有冲突标记。确认后还会显示发布预览；最终提交前会再次检查远端文件。'});
  const source=this.snap.plans.length===1?this.app.vault.getAbstractFileByPath(this.snap.plans[0].source):undefined;addHomeButton(this,this.plugin,source instanceof TFile?source:undefined);new Setting(el).addButton(b=>b.setButtonText('取消').onClick(()=>this.close())).addButton(b=>b.setButtonText('检查并进入发布预览').setCta().onClick(()=>{const text=area.value;if(/^(?:<<<<<<< |=======\s*$|>>>>>>> )/m.test(text)){new Notice('请先处理并移除所有冲突标记',10000);return;}this.close();void this.plugin.applyConflict(this.snap,text);}));
 }
 onClose(){this.contentEl.empty();}
}
interface Catalog {categories:CategoryPath[];directories:string[];skipped:number;head:string}
class CategoryModal extends Modal {
 private closed=false;private revision=0;private catalog?:Catalog;private category?:CategoryPath;private directory?:string;private status!:HTMLElement;private choice!:HTMLElement;private folder!:HTMLElement;
 constructor(app:App,private plugin:NoteBridge,private file:TFile,private recordScope:string,private config:string){super(app);}
 onOpen(){const el=this.contentEl;el.createEl('h2',{text:'选择仓库分类和文章目录'});el.createEl('p',{text:`文章：${this.file.path}；仓库：${this.plugin.settings.repo} / ${this.plugin.settings.branch}`});
  el.createEl('p',{text:'网页分类来自已有文章的 categories 属性；仓库目录决定 Markdown 文件保存的位置，两者可以分别选择。保存只修改本地属性和本机映射，不会立即上传。'});
  this.status=el.createEl('p',{text:'正在只读获取仓库内容…'});this.choice=el.createEl('p',{text:'网页分类：不更改'});this.folder=el.createEl('p',{text:'仓库目录：不更改（保留默认映射）'});
  void this.app.vault.cachedRead(this.file).then(text=>{if(this.closed||this.category)return;try{const current=categoriesFromArticle(text,true);this.choice.setText('网页分类：不更改；当前 '+(current.map(path=>path.join(' › ')).join('、')||'未设置'));}catch{this.choice.setText('网页分类：不更改；当前文章属性无法解析');}}).catch(()=>{if(!this.closed&&!this.category)this.choice.setText('网页分类：不更改；无法读取当前文章');});
  new Setting(el).addButton(b=>b.setButtonText('选择已有分类').onClick(()=>{if(!this.catalog){new Notice('请等待仓库读取完成');return;}if(!this.catalog.categories.length){new Notice('仓库已有文章中没有可识别的分类');return;}new CategorySuggestModal(this.app,this.catalog.categories,path=>{this.category=path;this.choice.setText('网页分类：'+path.join(' › ')+'（会替换原有分类）');}).open();})).addButton(b=>b.setButtonText('选择仓库目录').onClick(()=>{if(!this.catalog){new Notice('请等待仓库读取完成');return;}try{if(this.plugin.state().targets[this.file.path]){new Notice('已发布文章的远端路径已固定，不能直接更改目录');return;}}catch(e){new Notice(String(e),10000);return;}new DirectorySuggestModal(this.app,this.catalog.directories,path=>{this.directory=path;this.folder.setText('仓库目录：'+path);}).open();}));
  addHomeButton(this,this.plugin,this.file);new Setting(el).addButton(b=>b.setButtonText('重新读取').onClick(()=>{this.catalog=undefined;this.status.setText('正在读取仓库…');void this.load();})).addButton(b=>b.setButtonText('取消').onClick(()=>this.close())).addButton(b=>b.setButtonText('保存选择').setCta().onClick(()=>{if(!this.catalog){new Notice('仓库读取尚未完成');return;}if(!this.category&&!this.directory){new Notice('请先选择分类或仓库目录');return;}const dirs=this.catalog.directories;this.close();void this.plugin.saveOrganization(this.file,this.recordScope,this.config,this.category,this.directory,dirs).then(ok=>{if(ok)this.plugin.openControlCenter(this.file);});}));
  void this.load();
 }
 private async load(){const version=++this.revision,active=()=>!this.closed&&version===this.revision&&this.recordScope===this.plugin.key()&&this.config===this.plugin.configKey();
  try{const data=await this.plugin.readCatalog(active,message=>{if(active())this.status.setText(message);});if(!active())return;this.catalog=data;this.status.setText(`已读取提交 ${data.head.slice(0,7)}：${data.categories.length} 个分类、${data.directories.length} 个目录${data.skipped?`；${data.skipped} 篇文章未能解析，分类列表可能不完整`:''}。分类仅来自仓库现有文章。`);}
  catch(e){if(active()){const message=String(e);this.status.setText(message.includes('ERR_CACHE_READ_FAILURE')?'缓存读取失败，请点击重新读取；如果仍失败，请重启 Obsidian。':`读取失败：${message}`);}}
 }
 onClose(){this.closed=true;this.revision++;this.contentEl.empty();}
}
class CategorySuggestModal extends FuzzySuggestModal<CategoryPath>{
 constructor(app:App,private paths:CategoryPath[],private select:(p:CategoryPath)=>void){super(app);this.setPlaceholder('搜索分类名称');}
 getItems(){return this.paths;}getItemText(path:CategoryPath){return path.join(' › ');}onChooseItem(path:CategoryPath){this.select(path);}
}
class DirectorySuggestModal extends FuzzySuggestModal<string>{
 constructor(app:App,private paths:string[],private select:(p:string)=>void){super(app);this.setPlaceholder('搜索仓库文章目录');}
 getItems(){return this.paths;}getItemText(path:string){return path;}onChooseItem(path:string){this.select(path);}
}
class CoverModal extends Modal {
 private closed=false;private selected?:TFile; private destination:CoverDestination='index'; private label!:HTMLElement; private preview!:HTMLElement;
 constructor(app:App,private plugin:NoteBridge,private file:TFile){super(app);}
 onOpen(){
  const el=this.contentEl;el.createEl('h2',{text:'选择文章封面'});
  el.createEl('p',{text:`文章：${this.file.path}`});
  el.createEl('p',{text:'从发布目录内的 imgs 文件夹选择图片。保存会修改这篇本地文章的属性，替换所选位置原有的图片；不会立即上传。'});
  new Setting(el).setName('设置位置').addDropdown(d=>d.addOption('index','首页文章封面').addOption('banner','文章页头图').addOption('both','封面和头图都使用').setValue(this.destination).onChange(v=>{if(v==='index'||v==='banner'||v==='both')this.destination=v;}));
  this.label=el.createEl('p',{text:'尚未选择图片'});
  this.preview=el.createDiv();
  new Setting(el).addButton(b=>b.setButtonText('选择图片').onClick(()=>{
   const files=this.app.vault.getFiles().filter(f=>{try{coverReference(f.path,this.plugin.settings);return true;}catch{return false;}});
   if(!files.length){new Notice('没有可用图片，请先把图片放入发布目录内的 imgs 文件夹');return;}
   new CoverImageSuggestModal(this.app,files,image=>{this.selected=image;this.label.setText(`已选择：${image.path}`);this.preview.empty();const img=this.preview.createEl('img',{cls:'notebridge-cover-preview',attr:{src:this.app.vault.getResourcePath(image),alt:'所选封面的预览'}});img.onerror=()=>{if(this.selected!==image||!this.preview.contains(img))return;this.preview.empty();this.preview.createEl('p',{text:'无法加载图片预览，请检查图片文件。'});};}).open();
  })).addButton(b=>b.setButtonText('返回主页').onClick(()=>{this.close();this.plugin.openControlCenter(this.file);})).addButton(b=>b.setButtonText('保存并返回').setCta().onClick(()=>{if(!this.selected){new Notice('请先选择图片');return;}const image=this.selected;void this.plugin.saveCover(this.file,image,this.destination).then(ok=>{if(ok&&!this.closed){this.close();this.plugin.openControlCenter(this.file);}});}));
 }
 onClose(){this.closed=true;this.contentEl.empty();}
}
class CoverImageSuggestModal extends FuzzySuggestModal<TFile> {
 constructor(app:App,private files:TFile[],private select:(file:TFile)=>void){super(app);this.setPlaceholder('搜索图片名称或路径');}
 getItems():TFile[]{return this.files;}
 getItemText(file:TFile):string{return file.path;}
 renderSuggestion(match:FuzzyMatch<TFile>,el:HTMLElement):void{
  const row=el.createDiv({cls:'notebridge-cover-row'});
  const img=row.createEl('img',{cls:'notebridge-cover-thumbnail',attr:{src:this.app.vault.getResourcePath(match.item),alt:'',loading:'lazy'}});img.onerror=()=>{img.addClass('notebridge-preview-unavailable');};
  row.createSpan({cls:'notebridge-cover-path',text:match.item.path});
 }
 onChooseItem(file:TFile):void{this.select(file);}
}
class ArticleStatusModal extends Modal {
 private rows:ArticleStatus[]=[]; private list!:HTMLElement; private info!:HTMLElement; private query=''; private filter='all'; private closed=false; private scanning=false; private revision=0; private stateScope=''; private remoteNote='本机检查结果；线上状态需手动核验。';
 constructor(app:App,private plugin:NoteBridge){super(app);}
 onOpen(){
  const el=this.contentEl;el.createEl('h2',{text:'文章发布状态'});
  el.createEl('p',{text:'本机记录和 GitHub 文件状态分开显示。GitHub 文件存在不代表网站已部署；请查看最近提交的工作流状态。'});
  new Setting(el).setName('搜索文章').addText(t=>t.setPlaceholder('输入文件名或路径').onChange(v=>{this.query=v.trim().toLowerCase();this.render();}));
  new Setting(el).setName('筛选本地状态').addDropdown(d=>d.addOption('all','全部').addOption('unrecorded','无发布记录').addOption('withdrawn','已撤回').addOption('unchanged','与上次提交一致').addOption('modified','待同步').addOption('paused','已暂停').addOption('missing','本地已删除').addOption('unknown','无法判断').onChange(v=>{this.filter=v;this.render();}));
  new Setting(el).addButton(b=>b.setButtonText('刷新本地状态').onClick(()=>void this.scan())).addButton(b=>b.setButtonText('只读核验 GitHub').onClick(()=>void this.checkRemote()));
  new Setting(el).addButton(b=>b.setButtonText('返回主页').onClick(()=>{this.close();this.plugin.openControlCenter();}));
  this.info=el.createEl('p');this.list=el.createDiv();void this.scan();
 }
 async scan(){
  const version=++this.revision;this.stateScope=this.plugin.key();const rows:ArticleStatus[]=[];this.scanning=true;this.info.setText('正在检查本地文章…');
  try {
   const state=this.plugin.state(), cfg={...this.plugin.settings,fields:[...this.plugin.settings.fields]};
   const files=this.app.vault.getMarkdownFiles().filter(f=>isArticle(f.path,cfg.root));
   const seen=new Set(files.map(f=>f.path));
   for(const file of files){
    if(this.closed||version!==this.revision||this.stateScope!==this.plugin.key())return;
    const target=state.targets[file.path]; const candidate=target?undefined:cleanPath(cfg.posts+'/'+cleanPath(file.path).slice(cleanPath(cfg.root).length+1));const row:ArticleStatus={source:file.path,target,candidate,local:'unrecorded',remote:'unchecked'};
    if(!target&&Object.entries(state.withdrawals||{}).some(([id,event])=>!state.withdrawalReleases?.[id]&&resolveRenamedPath(event.source,state.renames||{})===file.path))row.local='withdrawn';
    if(target){
     try {
      const old=state.baselines[target], date=state.dates[file.path];if(!old||!date)throw new Error('缺少本机基线或首次发布日期');
      const source=await this.app.vault.read(file);
      const plan=prepare(file.path,source,cfg,date,(ref,src)=>this.app.metadataCache.getFirstLinkpathDest(ref,src)?.path||null,target);
      if(!plan)row.local='paused';
      else {
       const prepared=await prepareWithOverlay(plan.content,state.overlays?.[target],old);if(prepared.conflicts)throw new Error('本地修改与先前保留的远端修改冲突，请运行比较并合并当前文章的发布冲突');
       let changed=await blobHash(new TextEncoder().encode(prepared.text))!==old;
       for(const asset of plan.assets){const f=this.app.vault.getAbstractFileByPath(asset.source);if(!(f instanceof TFile))throw new Error(`等待附件：${asset.source}`);const hash=await blobHash(new Uint8Array(await this.app.vault.readBinary(f)));if(!state.baselines[asset.target]||state.baselines[asset.target]!==hash)changed=true;}
       row.local=changed?'modified':'unchanged';
      }
     }catch(e){row.local='unknown';row.detail=String(e);}
    }
    rows.push(row);if(rows.length%25===0)this.info.setText(`正在检查本地文章：${rows.length}/${files.length}`);
   }
   for(const [source,target] of Object.entries(state.targets))if(!seen.has(source))rows.push({source,target,local:'missing',remote:'unchecked'});
   if(this.closed||version!==this.revision||this.stateScope!==this.plugin.key())return;
   rows.sort((a,b)=>a.source.localeCompare(b.source,'zh-CN'));this.rows=rows;this.remoteNote='本机检查结果；线上状态需手动核验。';this.render();
  }catch(e){if(!this.closed && version===this.revision)this.info.setText(`读取状态失败：${String(e)}`);}
  finally{if(version===this.revision)this.scanning=false;}
 }
 async checkRemote(){
  if(this.closed)return;if(this.scanning){new Notice('本地检查尚未完成');return;}const version=++this.revision,scope=this.stateScope;
  if(!scope||scope!==this.plugin.key()){this.info.setText('仓库或分支已改变，请先刷新本地状态。');return;}
  this.info.setText('正在只读核验 GitHub…');
  try {
   const state=this.plugin.state(), client=this.plugin.github(), head=await client.head(),tree=await client.tree(head.tree);
   if(this.closed||version!==this.revision||scope!==this.plugin.key())return;
   for(const row of this.rows)row.remote=remoteStatus(row.target,row.target?state.baselines[row.target]:undefined,tree,row.candidate);
   this.render(`已只读核验分支 ${this.plugin.settings.branch}，提交 ${head.sha.slice(0,7)}；仅核验文章文件。`);
  }catch(e){if(!this.closed && version===this.revision){for(const row of this.rows)row.remote='unchecked';this.render(`GitHub 核验失败：${String(e)}`);}}
 }
 render(note?:string){
  if(!this.list||!this.info)return;
  const rows=this.rows.filter(r=>(this.filter==='all'||r.local===this.filter)&&(!this.query||r.source.toLowerCase().includes(this.query)||(r.target||'').toLowerCase().includes(this.query)));
  const visible=rows.slice(0,200);if(note)this.remoteNote=note;this.info.setText(`${this.remoteNote} 匹配 ${rows.length} / ${this.rows.length} 篇${rows.length>visible.length?'，仅显示前 200 篇，请搜索或筛选':''}。`);this.list.empty();
  for(const row of visible){
   const setting=new Setting(this.list).setName(row.source).setDesc(`${localLabel(row.local)} · ${remoteLabel(row.remote)}${row.target||row.candidate?' · '+(row.target||row.candidate):''}${row.detail?' · '+row.detail:''}`);
   const f=this.app.vault.getAbstractFileByPath(row.source);if(f instanceof TFile)setting.addButton(b=>b.setButtonText('打开').onClick(()=>{this.close();void this.app.workspace.getLeaf(false).openFile(f);}));
  }
 }
 onClose(){this.closed=true;this.revision++;this.contentEl.empty();}
}
class WithdrawListModal extends Modal {
 constructor(app:App,private plugin:NoteBridge,private recordScope:string,private records:WithdrawRecord[],private fromDelete=false){super(app);}
 onOpen(){this.contentEl.createEl('h2',{text:this.fromDelete?'检测到已发布的本地文章被删除':'撤回已发布文章'});this.contentEl.createEl('p',{text:this.fromDelete?'可能由本地操作或同步引起。线上文件仍保留；选择文章后可以单独确认撤回。':'以下是本机记录的文章；已删除的本地文章也可以在这里找到。'});addHomeButton(this,this.plugin);for(const r of this.records)new Setting(this.contentEl).setName(r.source+(r.exists?'':'（本地已不存在）')).setDesc(`远端：${r.target}`).addButton(b=>b.setButtonText('选择撤回').onClick(()=>{this.close();new WithdrawConfirmModal(this.app,this.plugin,this.recordScope,r,this.fromDelete).open();}));}
 onClose(){this.contentEl.empty();}
}
class WithdrawConfirmModal extends Modal {
 constructor(app:App,private plugin:NoteBridge,private recordScope:string,private record:WithdrawRecord,private fromDelete=false){super(app);}
 onOpen(){const el=this.contentEl;el.createEl('h2',{text:this.fromDelete?'本地文章已删除，要撤回线上版本吗？':'确认撤回发布'});el.createEl('p',{text:`本地文章：${this.record.source}`});el.createEl('p',{text:`仓库：${this.plugin.settings.repo}，分支：${this.plugin.settings.branch}`});el.createEl('p',{text:`将从远端删除：${this.record.target}`});el.createEl('p',{text:'取消将保留线上版本。远端图片保留；此操作创建新的 Git 提交，旧内容仍在 Git 历史中。网站更新取决于工作流。'});const source=this.app.vault.getAbstractFileByPath(this.record.source);addHomeButton(this,this.plugin,source instanceof TFile?source:undefined);new Setting(el).addButton(b=>b.setButtonText('保留线上版本').onClick(()=>this.close())).addButton(b=>b.setButtonText('确认撤回').setWarning().onClick(()=>{this.close();if(this.fromDelete && this.app.vault.getAbstractFileByPath(this.record.source)){new Notice('本地文件已恢复，请重新确认撤回');return;}void this.plugin.withdraw(this.recordScope,this.record.source,this.record.target);}));}
 onClose(){this.contentEl.empty();}
}
class DeploymentModal extends Modal {
 constructor(app:App,private plugin:NoteBridge,private sha:string,private detail:string,private url?:string){super(app);}
 onOpen(){this.contentEl.createEl('h2',{text:'最近提交的工作流'});this.contentEl.createEl('p',{text:`提交：${this.sha}`});this.contentEl.createEl('p',{text:this.detail});if(this.url){const a=this.contentEl.createEl('a',{text:'在 GitHub 查看工作流',href:this.url});a.setAttr('target','_blank');a.setAttr('rel','noopener noreferrer');}this.contentEl.createEl('p',{text:'工作流成功仅表明该工作流运行成功；请确认它实际包含部署步骤。'});addHomeButton(this,this.plugin);}
 onClose(){this.contentEl.empty();}
}
class PreviewModal extends Modal {
 constructor(app:App,private plugin:NoteBridge,private snap:Snapshot,private publish:boolean){super(app);}
 onOpen(){const el=this.contentEl;el.createEl('h2',{text:'NoteBridge 发布预览'});el.createEl('p',{text:'此批次是打开预览时的快照。只提交列出的文件；不会自动删除远端文件。'});const articlePaths=new Set(this.snap.plans.map(p=>p.target)),imageItems=this.snap.items.filter(item=>!!this.snap.assetOwners[item.path]),totalBytes=this.snap.items.reduce((sum,item)=>sum+item.bytes.byteLength,0);let added=0,updated=0;try{const state=this.plugin.state();for(const p of this.snap.plans){if(state.targets[p.source])updated++;else added++;}}catch{/* retain a useful size summary when state is unavailable */}el.createEl('p',{text:`文章 ${articlePaths.size} 篇（已有记录 ${updated}，待首次发布 ${added}）；图片 ${imageItems.length} 个；快照合计 ${(totalBytes/1048576).toFixed(2)} MiB。内容无变化时不会生成新提交。`});if(imageItems.some(item=>item.bytes.byteLength>10*1048576)||totalBytes>25*1048576)el.createEl('p',{text:'本次图片或总大小较大，手机上传可能较慢；请检查原图后再确认。',cls:'mod-warning'});
  for(const p of this.snap.plans){for(const warning of p.warnings)el.createEl('p',{text:warning,cls:'mod-warning'});el.createEl('h4',{text:`${p.source} → ${p.target}`});el.createEl('p',{text:'图片：'+(p.assets.map(a=>`${a.source} → ${a.target}`).join('、')||'无')});const details=el.createEl('details');details.createEl('summary',{text:'查看上传副本'});details.createEl('pre',{text:p.content});}
  for(const e of this.snap.problems)el.createEl('p',{text:e,cls:'mod-warning'});
  if(this.publish && this.snap.problems.length && this.snap.plans.some(plan=>!this.snap.problems.some(problem=>problem.startsWith(plan.source+'：'))))new Setting(el).setName('单独处理可用文章').setDesc('选择一篇没有预览错误的文章，重新生成单篇预览；仍会执行全部安全检查。').addButton(b=>b.setButtonText('选择文章').onClick(()=>{this.close();new PublishableArticleModal(this.app,this.plugin,this.snap.plans.filter(plan=>!this.snap.problems.some(problem=>problem.startsWith(plan.source+'：')))).open();}));
  new Setting(el).addButton(b=>b.setButtonText('返回主页').onClick(()=>{const source=this.snap.plans.length===1?this.app.vault.getAbstractFileByPath(this.snap.plans[0].source):undefined;this.close();this.plugin.openControlCenter(source instanceof TFile?source:undefined);}));
  if(this.publish && !this.snap.problems.length && this.snap.items.length)new Setting(el).addButton(b=>b.setButtonText('确认提交此快照').setCta().onClick(()=>{this.close();void this.plugin.submit(this.snap);}));
 }
 onClose(){this.contentEl.empty();}
}
class PublishableArticleModal extends FuzzySuggestModal<Plan>{
 constructor(app:App,private plugin:NoteBridge,private plans:Plan[]){super(app);this.setPlaceholder('选择要重新预览的文章');}
 getItems(){return this.plans;}getItemText(plan:Plan){return plan.source;}
 onChooseItem(plan:Plan){const file=this.app.vault.getAbstractFileByPath(plan.source);if(!(file instanceof TFile)){new Notice('文章已不存在，请重新预览');return;}void this.plugin.preview(true,file);}
}
class SettingsTab extends PluginSettingTab {
 constructor(app:App,private plugin:NoteBridge){super(app,plugin);}
 display(){const el=this.containerEl;el.empty();
 type TextKey='repo'|'branch'|'root'|'posts'|'images'|'siteRoot'|'imageUrl'|'site'|'workflow';
 const field=(name:string,key:TextKey,desc='')=>new Setting(el).setName(name).setDesc(desc).addText(t=>t.setValue(this.plugin.settings[key]).onChange(async v=>{this.plugin.settings[key]=v.trim();await this.plugin.saveData(this.plugin.settings);}));
 field('GitHub 仓库','repo','格式：所有者/仓库');field('源码分支','branch');field('发布根目录','root');field('文章目标目录','posts');field('图片目标目录','images');field('站点 root','siteRoot','例如 / 或 /blog/');field('图片公开 URL 路径','imageUrl','相对于站点 root，例如 imgs');field('站点地址','site','预留设置，当前版本尚不使用该地址');
 field('部署工作流文件名','workflow','例如 pages.yml；查询需要 Actions 读取权限');
 new Setting(el).setName('公开 frontmatter 字段').setDesc('逗号分隔；控制字段始终移除').addText(t=>t.setValue(this.plugin.settings.fields.join(',')).onChange(async v=>{this.plugin.settings.fields=v.split(',').map(x=>x.trim()).filter(Boolean);await this.plugin.saveData(this.plugin.settings);}));
 new Setting(el).setName('Fluid 文章封面和头图').setDesc('开启后公开并处理 index_img（首页封面）和 banner_img（文章页头图）；本地图片必须位于发布目录内的 imgs 文件夹。').addToggle(t=>t.setValue(!!this.plugin.settings.fluidImages).onChange(async v=>{this.plugin.settings.fluidImages=v;await this.plugin.saveData(this.plugin.settings);}));
 new Setting(el).setName('GitHub 凭据').setDesc('仅保存密钥引用；需要目标仓库 Contents 读写权限').addComponent(c=>new SecretComponent(this.app,c).setValue(this.plugin.settings.secret).onChange(async v=>{this.plugin.settings.secret=v || '';await this.plugin.saveData(this.plugin.settings);}));
 new Setting(el).setName('测试连接').addButton(b=>b.setButtonText('只读检查').onClick(()=>void this.plugin.test()));
 el.createEl('p',{text:'当前开发版本支持手动发布、显式撤回及工作流状态查询；自动发布尚未实现。请先阅读 README。'});
 }
}
