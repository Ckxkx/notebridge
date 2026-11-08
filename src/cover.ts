import { Config, imageTarget } from './core';

export type CoverDestination='index'|'banner'|'both';
export function coverReference(path:string, config:Config):string {
 imageTarget(path,config);
 if(['[',']','|','#','?','%'].some(char=>path.includes(char))) throw new Error('图片路径包含暂不支持的特殊字符（[ ] | # ? %），请先重命名');
 return `[[${path}]]`;
}
export function applyCover(frontmatter:Record<string,unknown>, reference:string, destination:CoverDestination):void {
 if(destination==='index'||destination==='both')frontmatter.index_img=reference;
 if(destination==='banner'||destination==='both')frontmatter.banner_img=reference;
}
