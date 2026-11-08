interface Edit { start:number; end:number; lines:string[]; side:'local'|'remote' }
export interface MergeResult { text:string; conflicts:number }

function edits(base:string[],next:string[],side:'local'|'remote'):Edit[]{
 if((base.length+1)*(next.length+1)>2_000_000)throw new Error('文章过长，无法安全自动合并；请手动处理');
 const width=next.length+1,dp=new Uint32Array((base.length+1)*width);
 for(let i=base.length-1;i>=0;i--)for(let j=next.length-1;j>=0;j--)dp[i*width+j]=base[i]===next[j]?1+dp[(i+1)*width+j+1]:Math.max(dp[(i+1)*width+j],dp[i*width+j+1]);
 const out:Edit[]=[];let i=0,j=0,start=-1,removed=0,added:string[]=[];
 const flush=()=>{if(start>=0){out.push({start,end:start+removed,lines:added,side});start=-1;removed=0;added=[];}};
 while(i<base.length||j<next.length){
  if(i<base.length&&j<next.length&&base[i]===next[j]){flush();i++;j++;continue;}
  if(start<0)start=i;
  if(j<next.length&&(i===base.length||dp[i*width+j+1]>dp[(i+1)*width+j]))added.push(next[j++]);
  else {i++;removed++;}
 }
 flush();return out;
}
function apply(base:string[],start:number,end:number,changes:Edit[]):string[]{
 const out:string[]=[];let pos=start;
 for(const e of changes){out.push(...base.slice(pos,e.start),...e.lines);pos=e.end;}
 out.push(...base.slice(pos,end));return out;
}
export function mergeThreeWay(baseText:string,localText:string,remoteText:string):MergeResult{
 const normalize=(s:string)=>s.replace(/\r\n/g,'\n');baseText=normalize(baseText);localText=normalize(localText);remoteText=normalize(remoteText);
 if(localText===remoteText)return {text:localText,conflicts:0};if(baseText===localText)return {text:remoteText,conflicts:0};if(baseText===remoteText)return {text:localText,conflicts:0};
 const lines=(s:string)=>s.split('\n');
 const base=lines(baseText),local=lines(localText),remote=lines(remoteText);
 const changes=[...edits(base,local,'local'),...edits(base,remote,'remote')].sort((a,b)=>a.start-b.start||a.end-b.end);
 const output:string[]=[];let pos=0,conflicts=0,index=0;
 while(index<changes.length){
  const first=changes[index++],group=[first];let end=first.end;
  while(index<changes.length&&(changes[index].start<end||(changes[index].start===end&&(first.start===end||changes[index].start===changes[index].end)))){const next=changes[index++];group.push(next);end=Math.max(end,next.end);}
  output.push(...base.slice(pos,first.start));
  const left=group.filter(e=>e.side==='local'),right=group.filter(e=>e.side==='remote');
  const l=apply(base,first.start,end,left),r=apply(base,first.start,end,right);
  if(!left.length)output.push(...r);else if(!right.length||JSON.stringify(l)===JSON.stringify(r))output.push(...l);
  else{conflicts++;output.push('<<<<<<< 本次上传副本',...l,'=======',...r,'>>>>>>> GitHub 远端版本');}
  pos=end;
 }
 output.push(...base.slice(pos));return {text:output.join('\n'),conflicts};
}
