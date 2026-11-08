// Diagnostic reproductions for the current 0.1.1 source. No network or Vault writes.
// Run `npm test` first to refresh test/*.cjs, then run this file with Node.
// Assertions describe observed defects, not desired behavior after a fix.
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const Module = require('node:module');
const { prepare } = require('../../../test/core.cjs');
const { mergeRecords, renameRecords } = require('../../../test/sync.cjs');
const { stringify } = require('yaml');
const results = [];
const config = { root: 'blog', posts: 'source/_posts', images: 'source/imgs', siteRoot: '/', imageUrl: 'imgs', fields: ['title', 'date'], fluidImages: true };
const date = '2026-11-01T00:00:00.000Z';
const id = '0123456789abcdef0123456789abcdef';
const source = 'blog/a.md', target = 'source/_posts/a.md';
const hash = text => { const bytes = Buffer.from(text); return createHash('sha1').update(Buffer.from(`blob ${bytes.length}\0`)).update(bytes).digest('hex'); };
const record = (name, observed) => results.push({ name, observed });

const bom = prepare(source, '\uFEFF---\ndraft: true\nprivate: PRIVATE_METADATA\n---\nbody', config, date, () => null);
assert.ok(bom);
assert.ok(bom.content.includes('private: PRIVATE_METADATA'));
record('BOM at converter boundary', 'Draft is not skipped; original private frontmatter remains in the body. Device-level BOM handling was not tested.');

const comments = prepare(source, 'Visible\n%%HIDDEN_COMMENT%%\nEnd', config, date, () => null);
assert.ok(comments.content.includes('%%HIDDEN_COMMENT%%'));
const renderer = require('../../../site-typing-preview/node_modules/hexo-renderer-marked/lib/renderer');
const html = renderer.call({ config: { marked: {}, post_asset_folder: false }, execFilterSync() {} }, { text: 'Visible\n%%HIDDEN_COMMENT%%\nEnd' }, {});
assert.ok(html.includes('%%HIDDEN_COMMENT%%'));
record('Obsidian comments', 'Hidden comment survives conversion and appears as text with the locally installed Hexo renderer.');

const link = prepare(source, '[Another note](other.md)', config, date, () => null);
assert.ok(link.content.includes('[Another note](other.md)'));
record('Markdown note links', 'Relative .md destination is passed through without validation or website URL conversion.');

const old = { version: 1, dates: { [source]: date }, targets: { [source]: target }, baselines: { [target]: 'a'.repeat(40) } };
const withdrawn = structuredClone(old);
delete withdrawn.targets[source];
delete withdrawn.baselines[target];
assert.throws(() => mergeRecords([withdrawn, old], new Map()), /同步记录与 GitHub 不一致/);
record('Withdrawal with stale device record', 'Removed target returns during union merge, then missing remote file blocks synchronization.');

const renamed = renameRecords(old, source, 'blog/b.md', false);
assert.throws(() => renameRecords(renamed, 'blog/b.md', source, false), /重命名后的路径与已有记录冲突/);
record('Rename back', 'a.md -> b.md -> a.md is rejected by the permanent rename mapping.');

let opened = [], notices = [];
class Plugin { constructor(app) { this.app = app; } async loadData() { return null; } addSettingTab() {} addStatusBarItem() { return { setText() {}, setAttribute() {} }; } addCommand(c) { (this.commands ??= []).push(c); } addRibbonIcon() {} registerEvent() {} }
class Modal { constructor(app) { this.app = app; } open() { opened.push(this); } }
class FuzzySuggestModal extends Modal { setPlaceholder() {} }
class TFile {}
class TFolder {}
class Notice { constructor(message) { notices.push(String(message)); } }
const originalLoad = Module._load;
Module._load = function (name, ...args) {
  if (name === 'obsidian') return { Plugin, Modal, FuzzySuggestModal, TFile, TFolder, Notice, PluginSettingTab: class {}, Setting: class {}, SecretComponent: class {}, Platform: { isMobile: false }, requestUrl() { throw new Error('Network forbidden in this diagnostic'); } };
  return originalLoad.call(this, name, ...args);
};
global.window = global;
const NoteBridge = require('../../../test/main.cjs').default;
Module._load = originalLoad;

function device(initial) {
  const file = new TFile(); file.path = source; file.name = 'a.md';
  let body = initial;
  const storage = new Map();
  const app = {
    vault: { getName: () => 'review-fixture', on: () => ({}), getMarkdownFiles: () => [file], getAbstractFileByPath: path => path === source ? file : null, read: async () => body },
    workspace: { on: () => ({}) }, metadataCache: { getFirstLinkpathDest: () => null },
    loadLocalStorage: key => storage.get(key) ?? null,
    saveLocalStorage: (key, value) => storage.set(key, structuredClone(value)),
    fileManager: { processFrontMatter: async (_file, update) => { const fm = {}; update(fm); body = `---\n${stringify(fm)}---\n${body}`; } }
  };
  return { app, file, get body() { return body; }, set body(text) { body = text; } };
}

(async () => {
  const d = device(`---\nnotebridge_id: ${id}\n---\nA\nB\nC`);
  const p = new NoteBridge(d.app); await p.onload();
  const base = prepare(source, d.body, p.settings, date, () => null, target).content;
  const merged = base.replace('\nB\n', '\nREMOTE_B\n');
  p.saveState({ version: 1, dates: { [source]: date }, targets: { [source]: target }, baselines: { [target]: hash(merged) }, articleIds: { [id]: source }, overlays: { [target]: { base, merged, hash: hash(merged) } } });
  const snap = await p.snapshot(d.file);
  assert.equal(snap.problems.length, 0);
  assert.equal(snap.plans[0].content, merged);
  p.commands.find(c => c.id === 'article-status').callback();
  const dashboard = opened.at(-1);
  dashboard.info = { setText() {} }; dashboard.list = { empty() {} }; dashboard.render = () => {};
  await dashboard.scan();
  assert.equal(dashboard.rows[0].local, 'modified');
  record('Overlay status inconsistency', 'Publisher produces the unchanged merged version, but dashboard labels the article modified.');

  d.body = d.body.replace('\nB\n', '\nLOCAL_B\n');
  const conflictSnap = await p.snapshot(d.file);
  assert.match(conflictSnap.problems.join('\n'), /先前保留的远端修改冲突/);
  opened = []; notices = [];
  await p.resolveConflict(d.file);
  assert.equal(opened.length, 0);
  assert.match(notices.join('\n'), /先前保留的远端修改冲突/);
  record('Overlay conflict recovery', 'Both normal preview and the conflict command stop before opening an editable merge dialog.');
  p.onunload();

  const d2 = device('Original text');
  const p2 = new NoteBridge(d2.app); await p2.onload();
  const addIdentity = d2.app.fileManager.processFrontMatter;
  d2.app.fileManager.processFrontMatter = async (...args) => { await addIdentity(...args); d2.body += '\nConcurrent edit'; };
  const first = await p2.snapshot(d2.file);
  assert.match(first.problems.join('\n'), /添加标识时发生变化/);
  assert.ok(d2.body.includes('notebridge_id:'));
  assert.equal(Object.keys(p2.state().articleIds || {}).length, 0);
  const second = await p2.snapshot(d2.file);
  assert.match(second.problems.join('\n'), /本机没有对应记录/);
  record('Interrupted identity registration', 'Concurrent edit during first ID insertion leaves a note ID without a corresponding record; next preview blocks.');
  p2.onunload();
  console.log(JSON.stringify({ reproduced: results.length, results }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
