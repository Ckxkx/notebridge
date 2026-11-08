import { parseDocument } from 'yaml';

export type CategoryPath=string[];
export function categoriesFromArticle(text:string,includeUnpublished=false):CategoryPath[]{
 const source=text.replace(/^\uFEFF/,'');
 if(!/^---\s*\r?\n/.test(source))return [];
 const header=/^---\s*\r?\n([\s\S]*?)\r?\n(?:---|\.\.\.)\s*(?:\r?\n|$)/.exec(source);
 if(!header)throw new Error('frontmatter 未结束');
 const doc=parseDocument(header[1],{uniqueKeys:true});if(doc.errors.length)throw new Error('frontmatter YAML 无效');
 const data:unknown=doc.toJS();if(data===null)return [];
 if(!data||typeof data!=='object'||Array.isArray(data))throw new Error('frontmatter 不是映射');
 const fm=data as Record<string,unknown>;if(fm.published===false&&!includeUnpublished)return [];
 const value=fm.categories??fm.category;if(value===undefined||value===null||value==='')return [];
 const path=(entry:unknown):string[]=>{const raw=Array.isArray(entry)?entry:[entry];if(!raw.length||!raw.every(v=>typeof v==='string'&&v.trim().length>0))throw new Error('分类必须是非空字符串或字符串数组');return (raw as string[]).map(s=>s.trim());};
 if(!Array.isArray(value))return [path(value)];
 if(!value.length)return [];
 if(value.some(Array.isArray))return value.map(path);
 return [path(value)];
}
export function categoryPrefixes(paths:CategoryPath[]):CategoryPath[]{
 const unique=new Map<string,CategoryPath>();for(const path of paths)for(let n=1;n<=path.length;n++){const p=path.slice(0,n);unique.set(JSON.stringify(p),p);}
 return [...unique.values()].sort((a,b)=>a.join(' / ').localeCompare(b.join(' / '),'zh-CN'));
}
