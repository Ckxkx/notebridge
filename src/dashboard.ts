export type LocalStatus = 'unrecorded'|'withdrawn'|'unchanged'|'modified'|'paused'|'missing'|'unknown';
export type RemoteStatus = 'unchecked'|'matches'|'changed'|'missing'|'unrecorded'|'candidate_exists'|'candidate_missing';
export interface ArticleStatus { source:string; target?:string; candidate?:string; local:LocalStatus; remote:RemoteStatus; detail?:string }
export function remoteStatus(target:string|undefined, baseline:string|undefined, tree:Map<string,string>, candidate?:string):RemoteStatus {
 if(!target && candidate) return tree.has(candidate)?'candidate_exists':'candidate_missing';
 if(!target || !baseline) return 'unrecorded';
 const actual=tree.get(target);
 if(actual===undefined) return 'missing';
 return actual===baseline ? 'matches' : 'changed';
}
export function localLabel(state:LocalStatus):string {
 return {unrecorded:'⚪ 无本机发布记录',withdrawn:'⏸ 已撤回，需手动允许重新发布',unchanged:'🟢 与上次提交一致',modified:'🟠 本地有待同步更改',paused:'⏸ 已暂停发布',missing:'🗑 本地文件已删除',unknown:'⚠ 无法判断本地变化'}[state];
}
export function remoteLabel(state:RemoteStatus):string {
 return {unchecked:'线上未核验',matches:'GitHub 文件与记录一致',changed:'GitHub 文件已变更',missing:'GitHub 文件不存在',unrecorded:'线上状态未知',candidate_exists:'远端目标路径已有文件或目录，归属未知',candidate_missing:'远端目标路径未发现文件'}[state];
}
