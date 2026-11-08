import { requestUrl } from 'obsidian';
export interface Item { path:string; bytes:Uint8Array }
export interface Baseline { [path:string]:string }
export interface WorkflowStatus { state:'pending'|'running'|'success'|'failure'|'unknown'; url?:string; detail:string }
interface ShaObject { sha:string }
interface RefResponse { object:ShaObject }
interface CommitResponse extends ShaObject { tree:ShaObject }
export interface TreeEntry {path:string;type:string;sha:string}
interface TreeResponse { truncated:boolean; tree:TreeEntry[] }
interface WorkflowRun { id:number; head_sha:string; event:string; html_url?:string; status:string; conclusion:string|null }
interface RunsResponse { workflow_runs:WorkflowRun[] }
let lastWrite = 0;
let writeQueue:Promise<void> = Promise.resolve();
async function pacedWrite<T>(fn:()=>Promise<T>):Promise<T> {
 const previous=writeQueue; let release!:()=>void;
 writeQueue=new Promise<void>(resolve=>{release=resolve;});
 await previous;
 try { const delay=Math.max(0,1000-(Date.now()-lastWrite)); if(delay) await new Promise(resolve=>window.setTimeout(resolve,delay)); lastWrite=Date.now(); return await fn(); }
 finally { release(); }
}
export class Github {
 constructor(private repo:string, private branch:string, private token:string) {
  if(!/^[\w.-]+\/[\w.-]+$/.test(repo)||!branch.trim()) throw new Error('仓库或分支格式不正确');
 }
 private async call<T>(method:string,path:string,body?:unknown):Promise<T> {
  const send=(bypassCache=false)=>requestUrl({url:`https://api.github.com/repos/${this.repo}${path}${bypassCache?(path.includes('?')?'&':'?')+'_notebridge_retry='+Date.now()+'-'+Math.random().toString(36).slice(2):''}`,method,headers:{Authorization:`Bearer ${this.token}`,Accept:'application/vnd.github+json','X-GitHub-Api-Version':'2022-11-28',...(bypassCache?{'Cache-Control':'no-cache, no-store',Pragma:'no-cache'}:{})},body:body===undefined?undefined:JSON.stringify(body),contentType:'application/json',throw:false});
  let res:Awaited<ReturnType<typeof requestUrl>>;
  if(method==='GET'){
   try{res=await send();}catch(e){if(!String(e).includes('ERR_CACHE_READ_FAILURE'))throw e;try{res=await send(true);}catch(retryError){if(String(retryError).includes('ERR_CACHE_READ_FAILURE'))throw new Error('读取缓存失败，请重试；若仍失败，请重启 Obsidian（ERR_CACHE_READ_FAILURE）');throw retryError;}}
  }else res=await pacedWrite(()=>send());
  const json:unknown=res.json;
  if(res.status<200||res.status>=300) {const message=json && typeof json==='object' && 'message' in json && typeof json.message==='string'?json.message:'请求失败';throw new Error(`GitHub HTTP ${res.status}：${message}`);}
  return json as T;
 }
 async head():Promise<{sha:string;tree:string}> { const ref=await this.call<RefResponse>('GET','/git/ref/heads/'+this.branch.split('/').map(encodeURIComponent).join('/')); const c=await this.call<CommitResponse>('GET','/git/commits/'+ref.object.sha); return {sha:ref.object.sha,tree:c.tree.sha}; }
 async check():Promise<void> { await this.call('GET',''); await this.head(); }
 async workflowStatus(workflow:string,sha:string):Promise<WorkflowStatus> {
  if(!/^[\w.-]+\.ya?ml$/i.test(workflow) || !/^[a-f0-9]{40}$/i.test(sha)) throw new Error('工作流文件名或提交 SHA 无效');
  const data=await this.call<RunsResponse>('GET',`/actions/workflows/${encodeURIComponent(workflow)}/runs?head_sha=${encodeURIComponent(sha)}&event=push&per_page=100`);
  if(!Array.isArray(data.workflow_runs)) throw new Error('Actions 返回格式无效');
  const run=data.workflow_runs.filter(r=>r.head_sha===sha && r.event==='push').sort((a,b)=>b.id-a.id)[0];
  if(!run) return {state:'pending',detail:'尚未找到此提交的工作流'};
  const safeUrl=typeof run.html_url==='string' && run.html_url.startsWith(`https://github.com/${this.repo}/actions/runs/`) ? run.html_url : undefined;
  if(run.status!=='completed') return {state:'running',url:safeUrl,detail:`工作流 ${run.status}`};
  if(run.conclusion==='success') return {state:'success',url:safeUrl,detail:'工作流成功'};
  return {state:'failure',url:safeUrl,detail:`工作流结束：${run.conclusion||'未知结果'}`};
 }
 async treeEntries(tree:string):Promise<TreeEntry[]> { const t=await this.call<TreeResponse>('GET',`/git/trees/${tree}?recursive=1`); if(t.truncated!==false||!Array.isArray(t.tree)||!t.tree.every(x=>x&&typeof x.path==='string'&&typeof x.type==='string'&&typeof x.sha==='string')) throw new Error('远端目录树被截断或无效，已停止以防覆盖'); return t.tree; }
 async tree(tree:string):Promise<Map<string,string>> {const entries=await this.treeEntries(tree);return new Map(entries.map(x=>[x.path,x.type==='blob' ? x.sha : 'tree:'+x.sha]));}
 async blobText(sha:string):Promise<string>{
  if(!/^[a-f0-9]{40}$/i.test(sha))throw new Error('远端文件标识无效');
  const blob=await this.call<{encoding:string;content:string}>('GET','/git/blobs/'+sha);
  if(blob?.encoding!=='base64'||typeof blob.content!=='string')throw new Error('远端文件内容格式无效');
  try {const binary=atob(blob.content.replace(/\s/g,''));const bytes=Uint8Array.from(binary,c=>c.charCodeAt(0));if(await blobHash(bytes)!==sha.toLowerCase())throw new Error('内容哈希不匹配');return new TextDecoder('utf-8',{fatal:true}).decode(bytes);}
  catch{throw new Error('远端文章不是有效的 UTF-8 文本或内容不完整');}
 }
 async containsCommit(candidate:string,head:string):Promise<boolean>{
  if(!/^[a-f0-9]{40}$/i.test(candidate)||!/^[a-f0-9]{40}$/i.test(head))throw new Error('提交标识无效');
  if(candidate===head)return true;
  const result=await this.call<{status:string}>('GET',`/compare/${candidate}...${head}`);return result.status==='ahead'||result.status==='identical';
 }
 async withdraw(path:string,baseline:string,onPrepared?:(candidate:string,parent:string)=>Promise<void>):Promise<string> {
  if(!path || !/^[a-f0-9]{40}$/i.test(baseline)) throw new Error('没有可靠的受管文件基线，不能撤回');
  const head=await this.head(), tree=await this.tree(head.tree), remote=tree.get(path);
  if(remote!==baseline) throw new Error(`冲突：远端 ${path} 已更改或不存在，不能撤回`);
  const next=await this.call<ShaObject>('POST','/git/trees',{base_tree:head.tree,tree:[{path,mode:'100644',type:'blob',sha:null}]});
  const commit=await this.call<ShaObject>('POST','/git/commits',{message:'NoteBridge: 撤回文章',tree:next.sha,parents:[head.sha]});
  if(onPrepared)await onPrepared(commit.sha,head.sha);
  try { await this.call('PATCH','/git/refs/heads/'+this.branch.split('/').map(encodeURIComponent).join('/'),{sha:commit.sha,force:false}); return commit.sha; }
  catch(e) {
   const current=await this.head(); if(current.sha===commit.sha) return commit.sha;
   throw new Error(`撤回结果不确定或分支已变化，请检查提交 ${commit.sha} 后再操作。${String(e)}`);
  }
 }
 async publish(items:Item[],baseline:Baseline,onPrepared?:(candidate:string,parent:string,hashes:Baseline)=>Promise<void>):Promise<{sha:string|null; hashes:Baseline}> {
  const hashes:Baseline={}; for(const item of items) hashes[item.path]=await blobHash(item.bytes);
  for(let attempt=0;attempt<3;attempt++) {
   const head=await this.head(), tree=await this.tree(head.tree);
   for(const item of items) { const remote=tree.get(item.path), old=baseline[item.path];
    if(remote!==old && !(remote===undefined && old===undefined)) {
     const reason=!old?'本机没有此文件的发布基线，远端已有同名文件':!remote?'已记录的远端文件不存在':`远端文件与本机基线不一致（远端 ${remote.slice(0,12)}，基线 ${old.slice(0,12)}）`;
     throw new Error(`冲突：${item.path}：${reason}；为避免覆盖已停止。请核对仓库、分支及远端文件历史`);
    }
   }
   const changed=items.filter(x=>tree.get(x.path)!==hashes[x.path]); if(!changed.length) return {sha:null,hashes};
   const entries=[]; for(const item of changed) { const blob=await this.call<ShaObject>('POST','/git/blobs',{content:base64(item.bytes),encoding:'base64'}); entries.push({path:item.path,mode:'100644',type:'blob',sha:blob.sha}); }
   const next=await this.call<ShaObject>('POST','/git/trees',{base_tree:head.tree,tree:entries});
   const commit=await this.call<ShaObject>('POST','/git/commits',{message:'NoteBridge: 发布文章',tree:next.sha,parents:[head.sha]});
   if(onPrepared)await onPrepared(commit.sha,head.sha,hashes);
   try { await this.call('PATCH','/git/refs/heads/'+this.branch.split('/').map(encodeURIComponent).join('/'),{sha:commit.sha,force:false}); return {sha:commit.sha,hashes}; }
   catch(e) { // A timed-out update may already have succeeded. Never blindly retry before checking.
    const current=await this.head(); if(current.sha===commit.sha) return {sha:commit.sha,hashes};
    if(current.sha===head.sha) throw e;
    // If this commit is not the head, abort conservatively: it could be an ancestor.
    throw new Error(`更新分支结果不确定或分支已变化，请检查 ${commit.sha} 后重试。${String(e)}`);
   }
  }
  throw new Error('重试次数已用尽');
 }
}
function base64(bytes:Uint8Array):string { let s=''; for(let i=0;i<bytes.length;i+=0x8000) s+=String.fromCharCode(...bytes.subarray(i,i+0x8000)); return btoa(s); }
export async function blobHash(bytes:Uint8Array):Promise<string> { const prefix=new TextEncoder().encode(`blob ${bytes.length}\0`), data=new Uint8Array(prefix.length+bytes.length); data.set(prefix); data.set(bytes,prefix.length); const hash=await crypto.subtle.digest('SHA-1',data); return Array.from(new Uint8Array(hash),x=>x.toString(16).padStart(2,'0')).join(''); }
