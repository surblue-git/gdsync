const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const ts = require('typescript');
const { webcrypto } = require('node:crypto');
global.crypto = webcrypto;
global.window = { localStorage: { getItem: () => 'en' }, setTimeout: (...args) => { const timer = setTimeout(...args); timer.unref(); return timer; }, clearTimeout };

class TFile {
	constructor(path, text = '') { this.path = path; this.data = bytes(text); this.stat = { mtime: 1, size: this.data.byteLength }; }
	get name() { return this.path.split('/').pop(); }
	get extension() { return this.name.split('.').pop(); }
}
class TFolder { constructor(path) { this.path = path; this.children = []; } }
class FileView {}
const notices = [];
const obsidian = {
	TFile, TFolder, FileView, normalizePath: (p) => p.replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''),
	Notice: class { constructor(text) { notices.push(text); } hide() {} setMessage() {} },
	Platform: { isMobile: true }, moment: { locale: () => 'en' },
};
const originalLoad = Module._load;
Module._load = function(name, ...args) { return name === 'obsidian' ? obsidian : originalLoad.call(this, name, ...args); };
require.extensions['.ts'] = (mod, filename) => mod._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
	compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText, filename);

const { UploadQueue } = require('../src/upload-queue.ts');
const { SyncEngine } = require('../src/sync-engine.ts');
const { FileIndex } = require('../src/file-index.ts');
const { VaultOps, Suppressor } = require('../src/vault-ops.ts');
const { StatusDisplay } = require('../src/status.ts');
const { DEFAULT_SETTINGS, applySharedSettings } = require('../src/types.ts');
const { MountMigration } = require('../src/mount-migration.ts');
const { rewriteLink } = require('../src/link-rewrite.ts');
const paths = require('../src/sync-paths.ts');

function bytes(value) { return typeof value === 'string' ? new TextEncoder().encode(value).buffer : value.slice(0); }
function text(file) { return new TextDecoder().decode(file.data); }
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

async function fixture(initial = {}, mode = 'subfolder') {
	const files = new Map(); const disk = new Map(); let plugin;
	const folder = (p) => {
		if (!p || files.has(p)) return;
		folder(path.posix.dirname(p) === '.' ? '' : path.posix.dirname(p));
		files.set(p, new TFolder(p));
	};
	const rebuild = () => {
		for (const f of files.values()) if (f instanceof TFolder) f.children = [...files.values()].filter(c => c.path !== f.path && path.posix.dirname(c.path) === f.path);
	};
	const put = (p, data) => { folder(path.posix.dirname(p) === '.' ? '' : path.posix.dirname(p)); const f = new TFile(p, data); files.set(p, f); rebuild(); return f; };
	for (const [p, data] of Object.entries(initial)) put(p, data);
	const adapter = {
		exists: async p => disk.has(p), read: async p => { if (!disk.has(p)) throw Error('Missing ' + p); return disk.get(p); },
		write: async (p, data) => { disk.set(p, data); },
		writeBinary: async (p, data) => { disk.set(p, bytes(data)); },
		readBinary: async p => bytes(disk.get(p)), mkdir: async p => { disk.set(p, ''); },
	};
	const vault = {
		adapter, configDir: '.obsidian',
		getFiles: () => [...files.values()].filter(f => f instanceof TFile),
		getMarkdownFiles: () => vault.getFiles().filter(f => f.extension === 'md'),
		getAbstractFileByPath: p => files.get(p) ?? null,
		readBinary: async f => bytes(f.data), read: async f => text(f),
		createFolder: async p => { folder(p); rebuild(); plugin?.ops.suppressor.consume(p); return files.get(p); },
		create: async (p, data) => { const f = put(p, data); if (plugin?.isActive()) plugin.engine.onCreate(f); return f; },
		createBinary: async (p, data) => vault.create(p, data),
		modifyBinary: async (f, data) => { f.data = bytes(data); f.stat = { mtime: f.stat.mtime + 1, size: data.byteLength }; if (plugin?.isActive()) plugin.engine.onModify(f); require('../src/attachment-links.ts').recordParsedText(f, text(f)); },
		process: async (f, fn) => { const value = fn(text(f)); await vault.modifyBinary(f, bytes(value)); return value; },
		rename: async (f, to) => {
			if (files.has(to)) throw Error('Destination exists');
			const old = f.path; files.delete(old); f.path = to; files.set(to, f); rebuild();
			if (plugin?.isActive()) plugin.engine.onRename(f, old);
		},
		delete: async f => { files.delete(f.path); rebuild(); },
	};
	const metadataCache = {
		getFileCache: f => {
			const embeds = [], links = [];
			for (const match of text(f).matchAll(/!?\[\[([^\]]+)\]\]/g)) {
				const original = match[0]; const link = match[1].split('|')[0];
				(original.startsWith('!') ? embeds : links).push({ link, original, position: { start: { offset: match.index }, end: { offset: match.index + original.length } } });
			}
			return { embeds, links };
		},
		getFirstLinkpathDest: (link, source) => {
			const p = link.split('#')[0];
			const candidates = [p, p + '.md', path.posix.normalize(path.posix.join(path.posix.dirname(source), p))];
			return candidates.map(p => files.get(p)).find(f => f instanceof TFile) ?? vault.getFiles().find(f => f.name === p) ?? null;
		},
	};
	const app = { vault, metadataCache, workspace: { iterateAllLeaves: () => {} }, fileManager: { trashFile: vault.delete } };
	plugin = { app, manifest: { dir: '.obsidian/plugins/gdsync' }, settings: { ...DEFAULT_SETTINGS, rootFolderId: 'root', tokens: {}, mountMode: mode }, saveSettings: async () => {} };
	plugin.index = new FileIndex(plugin); await plugin.index.load();
	plugin.ops = new VaultOps(app, new Suppressor());
	plugin.status = new StatusDisplay(plugin);
	let ids = 0;
	const drive = {
		generateId: async () => 'generated-' + ++ids,
		createFolder: async (_, __, id) => id,
		getMeta: async id => ({ id, mimeType: 'application/vnd.google-apps.folder', parents: [], name: 'root' }),
		getStartPageToken: async () => 'start', listAll: async () => [],
		listChanges: async () => ({ changes: [], newStartPageToken: 'next' }),
		upload: async p => ({ id: p.fileId ?? p.creationId ?? 'new', md5Checksum: 'uploaded', size: String(p.data.byteLength) }),
		download: async () => bytes('remote'), trash: async () => {}, patchMeta: async () => ({}),
	};
	plugin.engine = new SyncEngine(plugin, drive, plugin.index, plugin.ops, plugin.status);
	plugin.isActive = () => plugin.index.ready && !plugin.engine.migrating;
	plugin.index.data.rootFolderId = 'root';
	plugin.index.data.mountBase = plugin.engine.basePath();
	plugin.index.data.changesPageToken = 'old';
	const track = (p, overrides = {}) => {
		const f = files.get(plugin.engine.toVault(p));
		plugin.index.setFile(p, { fileId: 'id-' + p, hydrated: true, dirty: false, remoteMd5: 'base', hydratedMd5: 'base', remoteSize: f?.stat.size ?? 0,
			remoteModifiedTime: 0, lastAccess: 0, localMtime: f?.stat.mtime, localSize: f?.stat.size, ...overrides });
		return plugin.index.getFile(p);
	};
	return { ...plugin, plugin, files, disk, drive, track, put, close: () => plugin.engine.queue.clear() };
}

test('root and subfolder paths reject traversal; connection codes do not remount existing targets', () => {
	assert.equal(paths.vaultPath('', 'A/image.png'), 'A/image.png');
	assert.equal(paths.relativePath('GDrive', 'GDrive/A.md'), 'A.md');
	assert.equal(paths.relativePath('GDrive', 'GDriveOther/A.md'), null);
	assert.throws(() => paths.vaultPath('', '../.obsidian/data.json'));
	assert.equal(paths.protectedPath('.obsidian-x/a', '.obsidian-x'), true);
	const target = { ...DEFAULT_SETTINGS, rootFolderId: 'existing' };
	applySharedSettings(target, { rootFolderId: 'other', baseFolder: 'other' });
	assert.equal(target.rootFolderId, 'existing'); assert.equal(target.baseFolder, 'GDrive');
});

test('drain waits for a new attempt of a previously completed path', async () => {
	const hold = deferred(); let calls = 0;
	const q = new UploadQueue(async () => { if (++calls === 2) await hold.promise; return true; }, () => 1);
	q.schedule('a', true); await tick();
	q.schedule('a', true); let finished = false;
	const drain = q.drainPending().then(() => { finished = true; });
	await tick(); assert.equal(calls, 2); assert.equal(finished, false);
	hold.resolve(); await drain; q.clear();
});

test('failed attempts settle the current drain without waiting through retry backoff', async () => {
	const q = new UploadQueue(async () => false, () => 10000);
	q.schedule('a', true); const drain = q.drainPending(); await tick(); await drain;
	assert.equal(q.has('a'), true); q.clear();
});

test('queue limits concurrent transfers and never runs the same path twice concurrently', async () => {
	const hold = deferred(); let active = 0, max = 0;
	const q = new UploadQueue(async () => { max = Math.max(max, ++active); await hold.promise; active--; return true; }, () => 1);
	for (let i = 0; i < 8; i++) q.schedule(String(i), true);
	await tick(); q.schedule('0', true); await tick(); assert.equal(max, 3);
	hold.resolve(); await q.drainPending(); q.clear(); assert.equal(max, 3);
});

test('an edit during remote metadata lookup remains dirty after the old bytes upload', async () => {
	const f = await fixture({ 'GDrive/a.md': 'old' });
	const entry = f.track('a.md', { dirty: true, revision: 1 });
	f.drive.getMeta = async () => { await f.app.vault.modifyBinary(f.files.get('GDrive/a.md'), bytes('new')); return { md5Checksum: 'base' }; };
	let uploaded;
	f.drive.upload = async p => { uploaded = new TextDecoder().decode(p.data); return { id: 'id-a.md', md5Checksum: 'old-hash' }; };
	await f.engine.performUpload('a.md');
	assert.equal(uploaded, 'old'); assert.equal(entry.dirty, true); assert.equal(text(f.files.get('GDrive/a.md')), 'new'); f.close();
});

test('download does not overwrite an edit made during the network request', async () => {
	const f = await fixture({ 'GDrive/a.md': 'local' }); const entry = f.track('a.md');
	f.drive.download = async () => { await f.app.vault.modifyBinary(f.files.get('GDrive/a.md'), bytes('edited')); return bytes('remote'); };
	assert.equal(await f.engine.downloadInto(f.files.get('GDrive/a.md'), entry), false);
	assert.equal(text(f.files.get('GDrive/a.md')), 'edited'); assert.equal(entry.dirty, true); f.close();
});

test('received changes are persisted before application and failures survive another pull', async () => {
	const f = await fixture();
	f.drive.listChanges = async () => ({ changes: [{ fileId: 'new', file: { id: 'new' } }], newStartPageToken: 'next' });
	let persisted;
	f.engine.applyChange = async () => { persisted = JSON.parse(f.disk.get('.obsidian/plugins/gdsync/index.json')); throw Error('disk full'); };
	await f.engine.pullChanges();
	assert.equal(persisted.changesPageToken, 'next'); assert.equal(persisted.incoming.length, 1);
	assert.equal(f.index.data.incoming.length, 1);
	f.drive.listChanges = async () => ({ changes: [], newStartPageToken: 'later' });
	f.engine.applyChange = async () => {};
	await f.engine.pullChanges(); assert.equal(f.index.data.incoming.length, 0); f.close();
});

test('full scan never turns an untracked local file into an empty stub', async () => {
	const f = await fixture({ 'GDrive/a.md': 'unsent local contents' });
	f.drive.listAll = async () => [{ id: 'remote-a', name: 'a.md', mimeType: 'text/markdown', parents: ['root'], size: '10', md5Checksum: 'remote-hash' }];
	await f.engine.fullScan();
	assert.equal(text(f.files.get('GDrive/a.md')), 'unsent local contents');
	assert.equal(f.index.getFile('a.md').dirty, true); assert.equal(f.index.getFile('a.md').hydrated, true); f.close();
});

test('concurrent uploads share one folder creation with a persisted ID', async () => {
	const f = await fixture(); let creates = 0;
	f.drive.createFolder = async (_, __, id) => { creates++; assert.equal(f.index.data.folderCreationIds.assets, id); return id; };
	const ids = await Promise.all([f.engine.ensureRemoteFolder('assets'), f.engine.ensureRemoteFolder('assets')]);
	assert.equal(creates, 1); assert.equal(ids[0], ids[1]); f.close();
});

test('outside attachments block note upload and diagnostic identifies the reference', async () => {
	const f = await fixture({ 'GDrive/a.md': '![[image.png]]', 'image.png': 'image' });
	f.track('a.md', { dirty: true }); let sends = 0;
	f.drive.upload = async () => { sends++; return {}; };
	assert.equal(await f.engine.performUpload('a.md'), false); assert.equal(sends, 0);
	assert.match((await f.engine.diagnoseAttachments()).join('\n'), /Outside sync scope/); f.close();
});

test('pending results never update the successful-sync timestamp', () => {
	const status = new StatusDisplay({}); status.beginSync();
	assert.match(status.endSync({ pending: 1, ops: 0, incoming: 0, failed: false }), /pending/);
	assert.equal(status.getSnapshot().lastSuccessAt, undefined);
	status.beginSync(); status.endSync({ pending: 0, ops: 0, incoming: 0, failed: false });
	assert.ok(status.getSnapshot().lastSuccessAt);
});

test('link rewriting preserves aliases, image sizes, fragments and Markdown titles', () => {
	assert.equal(rewriteLink('![[GDrive/assets/a.png#part|300]]', 'assets/a.png', 'Notes/a.md'), '![[assets/a.png#part|300]]');
	assert.equal(rewriteLink('[label](<GDrive/assets/a b.png#part> "title")', 'assets/a b.png', 'Notes/a.md'), '[label](<../assets/a%20b.png#part> "title")');
	assert.equal(rewriteLink('[[GDrive/a#Heading|Alias]]', 'a.md', 'b.md'), '[[a#Heading|Alias]]');
});

test('migration preserves image bytes, rewrites note links and retains backups', async () => {
	const f = await fixture({ 'GDrive/Notes/a.md': '![[GDrive/assets/a.png|300]]', 'GDrive/assets/a.png': 'image bytes' });
	f.track('Notes/a.md'); f.track('assets/a.png'); f.engine.migrating = true;
	const warnings = await new MountMigration(f.plugin).run();
	assert.deepEqual(warnings, []);
	assert.equal(text(f.files.get('Notes/a.md')), '![[assets/a.png|300]]');
	assert.equal(text(f.files.get('assets/a.png')), 'image bytes');
	assert.equal(f.settings.mountMode, 'vaultRoot'); assert.equal(f.index.data.mountBase, '');
	assert.equal(f.index.getFile('Notes/a.md').dirty, true);
	assert.ok(f.disk.has('.obsidian/plugins/gdsync/migration-backup/0.bin')); f.close();
});

test('migration refuses a destination collision before moving files', async () => {
	const f = await fixture({ 'GDrive/a.md': 'source', 'a.md': 'existing' }); f.track('a.md'); f.engine.migrating = true;
	await assert.rejects(new MountMigration(f.plugin).run(), /Destination already exists/);
	assert.equal(text(f.files.get('GDrive/a.md')), 'source'); assert.equal(text(f.files.get('a.md')), 'existing'); f.close();
});

test('migration resumes after a move succeeds but the text write fails', async () => {
	const f = await fixture({ 'GDrive/a.md': '![[GDrive/p.png]]', 'GDrive/p.png': 'image' }); f.track('a.md'); f.track('p.png'); f.engine.migrating = true;
	const process = f.app.vault.process;
	f.app.vault.process = async () => { throw Error('interrupted'); };
	await assert.rejects(new MountMigration(f.plugin).run(), /interrupted/);
	assert.equal(await new MountMigration(f.plugin).pending(), true);
	f.app.vault.process = process;
	await new MountMigration(f.plugin).run();
	assert.equal(text(f.files.get('a.md')), '![[p.png]]');
	assert.equal(await new MountMigration(f.plugin).pending(), false); f.close();
});

test('index checkpoints are serialized, with the newest mutation saved last', async () => {
	const f = await fixture(); const hold = deferred(); const originalWrite = f.app.vault.adapter.write; let writes = 0;
	f.app.vault.adapter.write = async (p, value) => { if (p.endsWith('/index.json') && ++writes === 1) await hold.promise; return originalWrite(p, value); };
	f.index.data.lastFullScan = 1; f.index.markDirty(); const first = f.index.flush();
	await tick(); f.index.data.lastFullScan = 2; f.index.markDirty(); const second = f.index.flush();
	await tick(); assert.equal(writes, 1); hold.resolve(); await Promise.all([first, second]);
	assert.equal(JSON.parse(f.disk.get('.obsidian/plugins/gdsync/index.json')).lastFullScan, 2); f.close();
});

test('root sync uploads a new attachment before its referring note and reports success', async () => {
	const f = await fixture({ 'Notes/a.md': '![[assets/p.png]]', 'assets/p.png': 'new picture' }, 'vaultRoot');
	const sent = [];
	f.drive.upload = async p => { sent.push(p.name); return { id: p.creationId, md5Checksum: 'uploaded', size: String(p.data.byteLength) }; };
	await f.engine.syncNow({ awaitUploads: true });
	assert.deepEqual(sent, ['p.png', 'a.md']);
	assert.equal(f.index.dirtyPaths().length, 0);
	assert.ok(f.status.getSnapshot().lastSuccessAt); f.close();
});

test('offline sync finishes promptly with dirty state, not a success timestamp', async () => {
	const f = await fixture({ 'a.md': 'offline note' }, 'vaultRoot'); f.track('a.md', { dirty: true });
	f.drive.listChanges = async () => { throw new (require('../src/drive-client.ts').NetworkError)('offline'); };
	await f.engine.syncNow({ notify: true });
	assert.equal(f.index.getFile('a.md').dirty, true);
	assert.equal(f.status.getSnapshot().lastSuccessAt, undefined);
	assert.match(f.status.getSnapshot().lastSummary, /pending/); f.close();
});

test('rescheduled and overlapping drains wait for the replacement attempt', async () => {
	const hold = deferred(); const q = new UploadQueue(async () => { await hold.promise; return true; }, () => 10000);
	q.schedule('a'); let firstDone = false, secondDone = false;
	const first = q.drainPending().then(() => { firstDone = true; });
	q.schedule('a', true);
	const second = q.drainPending().then(() => { secondDone = true; });
	await tick(); assert.equal(firstDone, false); assert.equal(secondDone, false);
	hold.resolve(); await Promise.all([first, second]); q.clear();
});

test('clear settles pending drains without executing cancelled work', async () => {
	let calls = 0; const q = new UploadQueue(async () => { calls++; return true; }, () => 10000);
	q.schedule('a'); const drain = q.drainPending(); q.clear(); await drain; assert.equal(calls, 0);
});

test('a rename during upload cannot resurrect the old index path', async () => {
	const f = await fixture({ 'GDrive/a.md': 'note' }); f.track('a.md', { dirty: true });
	f.drive.getMeta = async () => ({ md5Checksum: 'base' });
	f.drive.upload = async () => { await f.app.vault.rename(f.files.get('GDrive/a.md'), 'GDrive/b.md'); return { id: 'id-a.md', md5Checksum: 'sent' }; };
	await f.engine.performUpload('a.md');
	assert.equal(f.index.getFile('a.md'), undefined); assert.equal(f.index.getFile('b.md').fileId, 'id-a.md');
	await f.engine.flushPendingOps(); f.close();
});

test('a newly created remote file deleted locally during upload is queued for trash', async () => {
	const f = await fixture({ 'GDrive/a.md': 'note' }); f.track('a.md', { dirty: true, fileId: '' });
	const trashed = [];
	f.drive.trash = async id => { trashed.push(id); };
	f.drive.upload = async p => { const file = f.files.get('GDrive/a.md'); f.engine.onDelete(file); await f.app.vault.delete(file); return { id: p.creationId, md5Checksum: 'sent' }; };
	await f.engine.performUpload('a.md'); await f.engine.flushPendingOps();
	assert.equal(f.index.getFile('a.md'), undefined); assert.equal(trashed.length, 1); f.close();
});

test('child-before-parent changes resolve ancestry instead of discarding the child', async () => {
	const f = await fixture();
	f.drive.getMeta = async id => id === 'parent'
		? { id, name: 'assets', mimeType: 'application/vnd.google-apps.folder', parents: ['root'] } : {};
	f.drive.listChanges = async () => ({ changes: [{ fileId: 'photo', removed: false, file: { id: 'photo', name: 'p.png', mimeType: 'image/png', parents: ['parent'] } }], newStartPageToken: 'next' });
	await f.engine.pullChanges();
	assert.equal(f.index.getFolderId('assets'), 'parent'); assert.equal(f.index.getFile('assets/p.png').fileId, 'photo');
	assert.equal(f.index.data.incoming.length, 0); f.close();
});

test('remote folder removal preserves unindexed local files in that folder', async () => {
	const f = await fixture({ 'GDrive/assets/known.png': 'known', 'GDrive/assets/private.txt': 'private' });
	f.track('assets/known.png'); f.index.setFolder('assets', 'folder');
	await f.engine.removeRemoteFolderLocally('assets');
	assert.equal(text(f.files.get('GDrive/assets/private.txt')), 'private'); assert.ok(f.files.get('GDrive/assets')); f.close();
});

test('cache eviction updates its local fingerprint so the empty stub is not reuploaded', async () => {
	const f = await fixture({ 'GDrive/a.md': 'cached' }); f.track('a.md');
	await f.engine.evictCache(); assert.equal(text(f.files.get('GDrive/a.md')), '');
	await f.engine.reconcileLocal(); assert.equal(f.index.getFile('a.md').dirty, false); assert.equal(f.index.getFile('a.md').hydrated, false); f.close();
});

test('corrupt index recovers the durable incoming queue from the temporary checkpoint', async () => {
	const f = await fixture(); const saved = { ...f.index.data, incoming: [{ fileId: 'pending', removed: true }] };
	f.disk.set('.obsidian/plugins/gdsync/index.json', '{');
	f.disk.set('.obsidian/plugins/gdsync/index.json.tmp', JSON.stringify(saved));
	const index = new FileIndex(f.plugin); await index.load();
	assert.equal(index.data.incoming[0].fileId, 'pending'); assert.equal(index.ready, true);
	assert.equal(f.disk.get('.obsidian/plugins/gdsync/index.json.corrupt'), '{'); f.close();
});

test('damaged checkpoints never silently reset to an empty writable index', async () => {
	const f = await fixture(); f.disk.set('.obsidian/plugins/gdsync/index.json', '{');
	const index = new FileIndex(f.plugin); await assert.rejects(index.load(), /could not be recovered/);
	assert.equal(index.ready, false); f.close();
});

test('a conflict is preserved locally before attempting to upload its copy', async () => {
	const f = await fixture({ 'GDrive/a.md': 'local version' }); const entry = f.track('a.md', { dirty: true, revision: 1 });
	f.drive.getMeta = async () => ({ md5Checksum: 'other-version', size: '6' });
	f.drive.upload = async p => {
		const copy = f.files.get('GDrive/' + p.name); assert.equal(text(copy), 'local version');
		throw Error('upload interrupted');
	};
	await f.engine.performUpload('a.md');
	assert.equal(text(f.files.get('GDrive/a.md')), 'local version');
	assert.ok(entry.conflictCopy); assert.equal(f.index.getFile(entry.conflictCopy.rel).dirty, true); f.close();
});

test('Drive retries a creation using the same ID and recovers a 409 without a second POST', async () => {
	const { DriveClient } = require('../src/drive-client.ts'); const requests = [];
	obsidian.requestUrl = async p => {
		requests.push(p);
		return p.method === 'POST' ? { status: 409, json: { error: { message: 'exists' } }, text: '' }
			: { status: 200, json: { id: 'reserved', md5Checksum: 'existing' } };
	};
	const drive = new DriveClient({ getAccessToken: async () => 'test' });
	const result = await drive.upload({ creationId: 'reserved', name: 'a.png', mimeType: 'image/png', data: bytes('picture') });
	assert.equal(result.id, 'reserved'); assert.equal(result.gdsyncRecovered, true);
	assert.equal(requests.filter(p => p.method === 'POST').length, 1);
	assert.match(new TextDecoder().decode(requests[0].body), /"id":"reserved"/);
});

test('concurrent activity survives cycle completion and handles duplicate display names', () => {
	const status = new StatusDisplay({}); const first = status.uploadStarting('image.png'); const second = status.uploadStarting('image.png');
	status.beginSync(); status.endSync({ pending: 1, ops: 0, incoming: 0, failed: false });
	status.uploadFinished(first, true); assert.equal(status.getSnapshot().phase, 'uploading');
	status.uploadFinished(second, true); assert.equal(status.getSnapshot().phase, 'idle');
});

test('a note waits for metadata for its latest edit before checking attachments', async () => {
	const f = await fixture({ 'GDrive/a.md': 'new text' }); f.track('a.md', { dirty: true });
	const { invalidateLinkCache, recordParsedText } = require('../src/attachment-links.ts');
	const file = f.files.get('GDrive/a.md'); invalidateLinkCache(file);
	let sends = 0;
	f.drive.getMeta = async () => ({ md5Checksum: 'base' });
	f.drive.upload = async () => { sends++; return { id: 'id-a.md', md5Checksum: 'uploaded' }; };
	assert.equal(await f.engine.performUpload('a.md'), false); assert.equal(sends, 0);
	recordParsedText(file, 'new text'); await f.engine.performUpload('a.md'); assert.equal(sends, 1); f.close();
});

test('migration does not overwrite an edit arriving between validation and process', async () => {
	const f = await fixture({ 'GDrive/a.md': '![[GDrive/p.png]]', 'GDrive/p.png': 'image' });
	f.track('a.md'); f.track('p.png'); f.engine.migrating = true;
	const read = f.app.vault.read;
	f.app.vault.read = async file => { await f.app.vault.modifyBinary(file, bytes('new user edit')); return read(file); };
	await assert.rejects(new MountMigration(f.plugin).run(), /Edited during migration/);
	assert.equal(text(f.files.get('a.md')), 'new user edit'); assert.equal(await new MountMigration(f.plugin).pending(), true); f.close();
});

test('failed incoming file creation remains durable even when the full scan advances its cursor', async () => {
	const f = await fixture();
	f.drive.listAll = async () => [{ id: 'a', name: 'a.md', mimeType: 'text/markdown', parents: ['root'] }];
	f.ops.createStub = async () => { throw Error('disk full'); };
	await f.engine.fullScan();
	assert.equal(f.index.data.changesPageToken, 'start');
	assert.equal(f.index.data.incoming[0].fileId, 'a'); f.close();
});
