import MarkdownIt from 'markdown-it';
import { Config, coverImageUrl, imageTarget, visibleArticleBody } from './core';

export type CoverDestination='index'|'banner'|'both';
export interface ArticleCoverImage { url:string; alt:string }
const coverMarkdown=new MarkdownIt();
coverMarkdown.normalizeLink=url=>url;

export function coverLinkReference(input:string):string {
 const text=input.trim();
 if(!text.startsWith('!['))return coverImageUrl(text);
 const tokens=coverMarkdown.parseInline(text,{})[0]?.children;
 if(tokens?.length!==1||tokens[0].type!=='image')throw new Error('请粘贴单个图片链接或 Markdown 图片');
 const src=tokens[0].attrGet('src');
 return coverImageUrl(typeof src==='string'?src:'');
}
export function articleCoverImages(text:string):ArticleCoverImage[] {
 const found=new Map<string,ArticleCoverImage>();
 for(const block of coverMarkdown.parse(visibleArticleBody(text),{})){
  if(block.type!=='inline')continue;
  for(const token of block.children??[]){
   if(token.type!=='image')continue;
   const src=token.attrGet('src');
   if(typeof src!=='string'||!/^https?:\/\//i.test(src))continue;
   let url:string;
   try{url=coverImageUrl(src);}catch{continue;}
   if(!found.has(url))found.set(url,{url,alt:token.content.trim()});
  }
 }
 return [...found.values()];
}
export function coverReference(path:string, config:Config):string {
 imageTarget(path,config);
 if(['[',']','|','#','?','%'].some(char=>path.includes(char))) throw new Error('图片路径包含暂不支持的特殊字符（[ ] | # ? %），请先重命名');
 return `[[${path}]]`;
}
export function applyCover(frontmatter:Record<string,unknown>, reference:string, destination:CoverDestination):void {
 if(destination==='index'||destination==='both')frontmatter.index_img=reference;
 if(destination==='banner'||destination==='both')frontmatter.banner_img=reference;
}
