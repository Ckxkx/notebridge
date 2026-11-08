const test=require('node:test'),assert=require('node:assert/strict');
const {mergeThreeWay}=require('./merge.cjs');
test('合并封面更新和正文独立修改，并忽略 CRLF 差异',()=>{
 const base='---\nindex_img: a.jpg\n---\n正文\n结尾\n';
 const local='---\nindex_img: a.jpg\n---\n正文更新\n结尾\n';
 const remote='---\r\nindex_img: a.webp\r\n---\r\n正文\r\n结尾\r\n';
 const result=mergeThreeWay(base,local,remote);assert.equal(result.conflicts,0);assert.equal(result.text,'---\nindex_img: a.webp\n---\n正文更新\n结尾\n');
});
test('同一行的不同修改产生冲突标记',()=>{const result=mergeThreeWay('one\ntwo\n','one\nlocal\n','one\nremote\n');assert.equal(result.conflicts,1);assert.match(result.text,/<<<<<<< 本次上传副本/);assert.match(result.text,/>>>>>>> GitHub 远端版本/);});
test('后续本地编辑继续保留上次合并的远端更改',()=>{const saved='封面.jpg\n正文\n结束',merged='封面.webp\n正文\n结束',edited='封面.jpg\n正文修改\n结束';const result=mergeThreeWay(saved,edited,merged);assert.equal(result.conflicts,0);assert.equal(result.text,'封面.webp\n正文修改\n结束');});
test('双方在同一位置插入不同内容不能静默合并',()=>{const r=mergeThreeWay('a\nb','a\nx\nb','a\ny\nb');assert.equal(r.conflicts,1);});
test('过大的文章拒绝高内存合并',()=>{assert.throws(()=>mergeThreeWay('a\n'.repeat(1500),'b\n'.repeat(1500),'c'),/过长/);});
test('长文章单边未变时直接合并不触发二次方内存限制',()=>{const base=Array.from({length:2500},(_,i)=>`line ${i}`).join('\n');const changed=base+'\nnew';assert.equal(mergeThreeWay(base,base,changed).text,changed);});
