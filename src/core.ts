import MarkdownIt from 'markdown-it';
import { parseDocument, stringify } from 'yaml';

export interface Config { root: string; posts: string; images: string; siteRoot: string; imageUrl: string; fields: string[]; fluidImages?: boolean }
export interface Asset { source: string; target: string }
export interface Plan { source: string; target: string; content: string; assets: Asset[]; warnings: string[] }
const md = new MarkdownIt();
export function cleanPath(s: string): string {
  const parts: string[] = [];
  for (const part of s.replace(/\\/g, '/').split('/')) {
    if (!part || part === '.') continue;
    if (part === '..') { if (!parts.length) throw new Error('路径越界'); parts.pop(); } else parts.push(part);
  }
  return parts.join('/');
}
export function within(path: string, root: string): boolean { const p=cleanPath(path), r=cleanPath(root); return !!r && p.startsWith(r+'/'); }
export function isArticle(path: string, root: string): boolean {
  if (!within(path,root) || !/\.md$/i.test(path)) return false;
  return !cleanPath(path).slice(cleanPath(root).length+1).split('/').slice(0,-1).some(p=>p.toLowerCase()==='imgs');
}
export function imageTarget(path: string, c: Config): string {
  if (!within(path,c.root)) throw new Error(`图片不在发布根目录：${path}`);
  const parts=cleanPath(path).slice(cleanPath(c.root).length+1).split('/');
  const i=parts.lastIndexOf('imgs');
  if (i<0 || i===parts.length-1 || !/\.(png|jpe?g|gif|webp|svg|avif)$/i.test(path)) throw new Error(`图片不在 imgs 目录或类型不允许：${path}`);
  return cleanPath([c.images,...parts.slice(0,i),...parts.slice(i+1)].join('/'));
}
function url(path:string, root:string):string { return '/' + [cleanPath(root),...cleanPath(path).split('/')].filter(Boolean).map(encodeURIComponent).join('/'); }
function frontmatter(text:string):{fm:Record<string,unknown>;body:string} {
 const input=text.replace(/^\uFEFF/,'');
 if(!/^---[ \t]*\r?\n/.test(input))return {fm:{},body:input};
 const match=/^---[ \t]*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(input);
 if(!match)throw new Error('frontmatter 没有结束标记');
 const doc=parseDocument(match[1],{uniqueKeys:true});if(doc.errors.length)throw new Error('无效 YAML：'+doc.errors.map(e=>e.message).join('; '));
 const value:unknown=doc.toJS();if(value!==null&&(typeof value!=='object'||Array.isArray(value)))throw new Error('frontmatter 必须是映射');
 return {fm:value as Record<string,unknown>||{},body:input.slice(match[0].length)};
}
export function noteIdentity(text:string):string|undefined {
 const id=frontmatter(text).fm.notebridge_id;if(id===undefined)return undefined;
 if(typeof id!=='string'||!/^[a-f0-9]{32}$/.test(id))throw new Error('notebridge_id 无效，请检查文章属性');return id;
}
export function ensureIdentity(text:string,candidate:string):{text:string;id:string;created:boolean}{
 if(!/^[a-f0-9]{32}$/.test(candidate))throw new Error('文章标识格式无效');
 const existing=noteIdentity(text);if(existing)return {text,id:existing,created:false};
 const bom=text.startsWith('\uFEFF')?'\uFEFF':'',input=bom?text.slice(1):text,newline=input.includes('\r\n')?'\r\n':'\n';
 const opening=/^---[ \t]*\r?\n/.exec(input);
 return {text:opening?bom+opening[0]+`notebridge_id: "${candidate}"`+newline+input.slice(opening[0].length):bom+'---'+newline+`notebridge_id: "${candidate}"`+newline+'---'+newline+input,id:candidate,created:true};
}
// Remove hidden content before collecting image dependencies. Code examples stay intact.
function stripComments(body:string):{body:string;warnings:string[]} {
 const protectedLines=new Set<number>();
 for(const token of md.parse(body,{}))if((token.type==='fence'||token.type==='code_block')&&token.map)for(let i=token.map[0];i<token.map[1];i++)protectedLines.add(i);
 let active:''|'obsidian'|'html'='',obsidian=0,html=0;const output:string[]=[];
 for(const [lineNo,line] of body.split('\n').entries()){
  if(!active&&protectedLines.has(lineNo)){output.push(line);continue;}
  let result='',i=0;
  while(i<line.length){
   if(active){const end=active==='obsidian'?'%%':'-->',pos=line.indexOf(end,i);if(pos<0){i=line.length;break;}i=pos+end.length;active='';continue;}
   if(line[i]==='`'){let n=1;while(line[i+n]==='`')n++;const ticks='`'.repeat(n),end=line.indexOf(ticks,i+n);if(end<0)throw new Error(`第 ${lineNo+1} 行含无法安全解析的代码标记`);result+=line.slice(i,end+n);i=end+n;continue;}
   if(line[i]==='\\'&&i+1<line.length){result+=line.slice(i,i+2);i+=2;continue;}
   if(line.startsWith('%%',i)){active='obsidian';obsidian++;i+=2;continue;}
   const excerpt=/^<!--\s*more\s*-->/i.exec(line.slice(i));if(excerpt){result+=excerpt[0];i+=excerpt[0].length;continue;}
   if(line.startsWith('<!--',i)){active='html';html++;i+=4;continue;}
   result+=line[i++];
  }
  output.push(result);
 }
 if(active)throw new Error(`${active==='obsidian'?'Obsidian':'HTML'} 注释未闭合，已停止发布`);
 const warnings:string[]=[];if(obsidian)warnings.push(`已从上传副本移除 ${obsidian} 处 Obsidian 注释`);if(html)warnings.push(`已从上传副本移除 ${html} 处 HTML 注释`);
 return {body:output.join('\n'),warnings};
}
export function assertUploadSafe(text:string):void {
 const parsed=frontmatter(text);for(const key of ['notebridge_id','draft','publish','published'])if(Object.prototype.hasOwnProperty.call(parsed.fm,key))throw new Error(`上传副本含内部字段 ${key}，请先移除`);
 if(stripComments(parsed.body).warnings.length)throw new Error('合并后的上传副本含隐藏注释，请先移除后重新预览');
}
export function prepare(source:string, text:string, c:Config, date:string, resolve:(link:string,source:string)=>string|null, targetOverride?:string):Plan | null {
  if (!isArticle(source,c.root)) throw new Error('文件不属于发布范围');
  const parsed=frontmatter(text),fm=parsed.fm;
  if (fm.draft===true || fm.publish===false || fm.published===false) return null;
  const out:Record<string,unknown>={}; for (const k of c.fields) if (!['draft','publish','published','index_img','banner_img','notebridge_id'].includes(k) && Object.prototype.hasOwnProperty.call(fm,k)) out[k]=fm[k];
  out.title ??= source.split('/').pop()!.replace(/\.md$/i,''); out.date ??= date;
  // Images in metadata require the same dependency handling; do not silently publish them.
  for (const key of ['cover','banner','thumbnail']) if (key in out) throw new Error(`暂不支持公开字段 ${key} 中的图片，请移除或关闭该字段`);
  const assets:Asset[]=[];
  const imageUrl=(reference:string):string=>{
    if(/^https?:\/\//i.test(reference))return reference;
    let ref=reference;
    try { ref=decodeURIComponent(ref.replace(/^<|>$/g,'')); } catch { throw new Error(`图片路径编码无效：${ref}`); }
    if (/^[a-z][a-z0-9+.-]*:/i.test(ref)||ref.startsWith('/')||/[#?]/.test(ref)) throw new Error(`不支持该本地图片路径：${ref}；请使用 imgs 内的相对路径或 HTTP(S) 链接`);
    const found=resolve(ref,source); if(!found) throw new Error(`等待附件或无法解析图片：${ref}`);
    const dest=imageTarget(found,c);assets.push({source:found,target:dest});
    return url(dest.replace(cleanPath(c.images)+'/',cleanPath(c.imageUrl)+'/'),c.siteRoot);
  };
  if(c.fluidImages){
    for(const key of ['index_img','banner_img']) if(Object.prototype.hasOwnProperty.call(fm,key)){
      const value=fm[key];
      if(value===null||value===''){out[key]=value;continue;}
      if(typeof value!=='string')throw new Error(`${key} 必须是图片路径字符串；Obsidian 链接请用引号包裹`);
      let ref=value.trim();if(!ref){out[key]='';continue;}
      const wiki=/^!?\[\[(.+?)\]\]$/.exec(ref);
      if(wiki){if(wiki[1].includes('|'))throw new Error(`${key} 不支持别名或尺寸，请只填写图片路径`);if(wiki[1].includes('[')||wiki[1].includes(']'))throw new Error(`${key} 图片链接格式不支持`);ref=wiki[1].trim();}
      else if(ref.includes('[')||ref.includes(']'))throw new Error(`${key} 图片链接格式不支持`);
      try{out[key]=imageUrl(ref);}catch(e){throw new Error(`${key}：${e instanceof Error?e.message:String(e)}`);}
    }
  }
  const cleaned=stripComments(parsed.body),body=cleaned.body;
  const protectedLines=new Set<number>();
  for (const t of md.parse(body,{})) if ((t.type==='fence'||t.type==='code_block') && t.map) for(let i=t.map[0];i<t.map[1];i++) protectedLines.add(i);
  const lines=body.split('\n');
  for(let n=0;n<lines.length;n++) {
    if(protectedLines.has(n)) continue;
    // Mask inline code, preserving offsets; unsupported unmatched backticks stop the article.
    const line=lines[n]; let masked=line.replace(/(`+)([\s\S]*?)\1/g, m=>' '.repeat(m.length));
    if(masked.includes('`')) throw new Error(`第 ${n+1} 行含无法安全解析的代码标记`);
    if(/(?<!!)\[[^\]]+\]\([^)]*\.md(?:[?#][^)]*)?\)/i.test(masked)&&!cleaned.warnings.includes('文章含相对 Markdown 笔记链接，请确认网站路径可用'))cleaned.warnings.push('文章含相对 Markdown 笔记链接，请确认网站路径可用');
    if (/<\s*(img|picture|source)\b/i.test(masked)) throw new Error(`第 ${n+1} 行的 HTML 图片暂不支持`);
    const re=/!\[\[([^\]\n]+)\]\]|!\[([^\]\n]*)\]\(([^\s()]+)(?:\s+"[^"]*")?\)/g;
    const changes:{start:number;end:number;value:string}[]=[]; let m:RegExpExecArray|null;
    while((m=re.exec(masked))) {
      let slashCount=0;for(let i=m.index-1;i>=0&&masked[i]==='\\';i--)slashCount++;
      if(slashCount%2===1)continue;
      const wiki=m[1]!==undefined; let ref=wiki?m[1].split('|')[0]:m[3];
      if (/^https?:\/\//i.test(ref)) continue;
      const converted=imageUrl(ref);
      const alt=wiki?(m[1].split('|')[1]||'').replace(/^\d+(?:x\d+)?$/,''):m[2];
      changes.push({start:m.index,end:m.index+m[0].length,value:`![${alt}](${converted})`});
    }
    // Reject constructs not handled by this deliberately conservative converter.
    const residue=masked.replace(re,'');
    if (/!\[|\[\[|!\[\[|\]\s*\[[^\]]*\]/.test(residue)) throw new Error(`第 ${n+1} 行含未支持的图片、文章链接或引用式链接`);
    for(const ch of changes.reverse()) lines[n]=lines[n].slice(0,ch.start)+ch.value+lines[n].slice(ch.end);
  }
  const relative=cleanPath(source).slice(cleanPath(c.root).length+1);
  return {source,target:targetOverride||cleanPath(c.posts+'/'+relative),content:'---\n'+stringify(out)+'---\n'+lines.join('\n'),assets,warnings:cleaned.warnings};
}
