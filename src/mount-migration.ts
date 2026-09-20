import { Platform, TFile } from "obsidian";
import type GdsyncPlugin from "./main";
import { freshLinkCache } from "./attachment-links";
import { rewriteLink } from "./link-rewrite";
import { protectedPath, relativePath, validPath } from "./sync-paths";

interface MigrationFile {
	from: string;
	to: string;
	backup: string;
	beforeHash: string;
	afterHash: string;
	/** Corrected text is persisted before any source path is moved. */
	text?: string;
}
interface MigrationJournal {
	version: 1;
	rootId: string;
	base: string;
	phase: "moving" | "committing" | "complete";
	files: MigrationFile[];
	folders: string[];
	warnings: string[];
}

export async function contentHash(data: ArrayBuffer): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", data);
	return Array.from(new Uint8Array(digest), (v) => v.toString(16).padStart(2, "0")).join("");
}

/** Local-only migration. Never translates local moves into remote rename/trash operations. */
export class MountMigration {
	constructor(private plugin: GdsyncPlugin) { }
	private get directory(): string { return `${this.plugin.manifest.dir}/migration-backup`; }
	private get journalPath(): string { return `${this.plugin.manifest.dir}/mount-migration.json`; }

	async pending(): Promise<boolean> {
		const journal = await this.load();
		return !!journal && journal.phase !== "complete";
	}

	private async load(): Promise<MigrationJournal | null> {
		const adapter = this.plugin.app.vault.adapter;
		let found = false;
		for (const path of [this.journalPath, this.journalPath + ".tmp"]) {
			if (!await adapter.exists(path)) continue;
			found = true;
			try {
				const journal = JSON.parse(await adapter.read(path)) as MigrationJournal;
				if (journal.version !== 1 || !Array.isArray(journal.files) || !Array.isArray(journal.folders) || !["moving", "committing", "complete"].includes(journal.phase)) throw new Error("Invalid journal");
				return journal;
			} catch (e) { console.error("gdsync: unreadable migration checkpoint", path, e); }
		}
		if (found) throw new Error("Migration journal is damaged; sync remains paused.");
		return null;
	}

	private async save(journal: MigrationJournal): Promise<void> {
		const adapter = this.plugin.app.vault.adapter;
		const text = JSON.stringify(journal);
		await adapter.write(this.journalPath + ".tmp", text);
		await adapter.write(this.journalPath, text);
	}

	private async prepare(): Promise<MigrationJournal> {
		const { app, engine, index, settings } = this.plugin;
		const base = engine.basePath();
		if (!base) throw new Error("Already at vault root");
		const files = app.vault.getFiles().filter((f) => relativePath(base, f.path));
		const paths = new Map<string, string>();
		for (const file of files) {
			const rel = relativePath(base, file.path)!;
			if (!validPath(rel) || protectedPath(rel, app.vault.configDir)) throw new Error(`Protected path: ${file.path}`);
			if (app.vault.getAbstractFileByPath(rel)) throw new Error(`Destination already exists: ${rel}`);
			const folded = rel.normalize("NFC").toLowerCase();
			if ([...paths.values()].some((p) => p.normalize("NFC").toLowerCase() === folded)) throw new Error(`Path collision: ${rel}`);
			// Parent directories may already exist, but never merge with an unrelated file.
			for (let p = rel.lastIndexOf("/"); p >= 0; p = rel.lastIndexOf("/", p - 1)) {
				if (app.vault.getAbstractFileByPath(rel.slice(0, p)) instanceof TFile) throw new Error(`Parent is a file: ${rel}`);
			}
			paths.set(file.path, rel);
		}
		if (!await app.vault.adapter.exists(this.directory)) await app.vault.adapter.mkdir(this.directory);
		await app.vault.adapter.write(`${this.directory}/index-before.json`, JSON.stringify(index.data));
		const journal: MigrationJournal = { version: 1, rootId: settings.rootFolderId, base, phase: "moving", files: [], folders: Object.keys(index.data.folders), warnings: [] };
		for (const file of files) {
			const to = paths.get(file.path)!;
			const data = await app.vault.readBinary(file);
			let text: string | undefined;
			if (file.extension === "md") {
				if (index.getFile(to) && !index.getFile(to)!.hydrated) throw new Error(`Download note before migrating: ${file.path}`);
				const before = new TextDecoder().decode(data);
				if (!freshLinkCache(app, file, before)) throw new Error(`Wait for Obsidian to index: ${file.path}`);
				const cache = app.metadataCache.getFileCache(file)!;
				for (const ref of cache.frontmatterLinks ?? []) journal.warnings.push(`${file.path} (frontmatter): ${ref.link}`);
				const refs = [...(cache.embeds ?? []), ...(cache.links ?? [])].sort((a, b) => b.position.start.offset - a.position.start.offset);
				text = before;
				for (const ref of refs) {
					if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref.link)) continue;
					const dest = app.metadataCache.getFirstLinkpathDest(ref.link, file.path);
					if (!dest) {
						// Vault-absolute links already broken by the old mount can still be exact.
						const raw = ref.link.split("#")[0];
						const exact = app.vault.getAbstractFileByPath(`${base}/${raw}`) ?? app.vault.getAbstractFileByPath(`${base}/${raw}.md`);
						if (!(exact instanceof TFile)) { journal.warnings.push(`${file.path}: ${ref.link}`); continue; }
						const target = paths.get(exact.path);
						if (!target) { journal.warnings.push(`${file.path}: ${ref.link}`); continue; }
						text = text.slice(0, ref.position.start.offset) + rewriteLink(ref.original, target, to) + text.slice(ref.position.end.offset);
						continue;
					}
					const destination = paths.get(dest.path) ?? dest.path;
					text = text.slice(0, ref.position.start.offset) + rewriteLink(ref.original, destination, to) + text.slice(ref.position.end.offset);
				}
			} else if (file.extension === "canvas") {
				if (index.getFile(to) && !index.getFile(to)!.hydrated) throw new Error(`Download canvas before migrating: ${file.path}`);
				const canvas = JSON.parse(new TextDecoder().decode(data));
				for (const node of canvas.nodes ?? []) {
					if (node.type === "file" && typeof node.file === "string") node.file = paths.get(node.file) ?? node.file;
				}
				text = JSON.stringify(canvas, null, "\t");
			}
			const backup = `${this.directory}/${journal.files.length}.bin`;
			await app.vault.adapter.writeBinary(backup, data);
			const beforeHash = await contentHash(data);
			const afterHash = text === undefined ? beforeHash : await contentHash(new TextEncoder().encode(text).buffer);
			journal.files.push({ from: file.path, to, backup, beforeHash, afterHash, text });
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		await this.save(journal);
		return journal;
	}

	async run(): Promise<string[]> {
		const { app, engine, index, settings } = this.plugin;
		const adapter = app.vault.adapter;
		const journal = await this.load() ?? await this.prepare();
		if (journal.version !== 1 || journal.rootId !== settings.rootFolderId) throw new Error("Migration target mismatch");
		if (journal.phase === "complete") return journal.warnings;
		if (Platform.isAndroidApp && !await adapter.exists(".nomedia")) await adapter.write(".nomedia", "");
		for (const folder of journal.folders) {
			if (!folder) continue;
			if (!validPath(folder) || protectedPath(folder, app.vault.configDir)) throw new Error("Protected migration folder");
			if (app.vault.getAbstractFileByPath(folder) instanceof TFile) throw new Error(`Folder destination is a file: ${folder}`);
			await this.plugin.ops.ensureFolder(folder);
		}
		for (const item of journal.files) {
			if (!validPath(item.from) || !validPath(item.to) || protectedPath(item.to, app.vault.configDir)) throw new Error("Invalid migration path");
			let file = app.vault.getAbstractFileByPath(item.from);
			const dest = app.vault.getAbstractFileByPath(item.to);
			if (file && dest) throw new Error(`Both source and destination exist: ${item.to}`);
			if (file instanceof TFile) {
				if (await contentHash(await app.vault.readBinary(file)) !== item.beforeHash) throw new Error(`Edited during migration; preserved: ${item.from}`);
				const parent = item.to.split("/").slice(0, -1).join("/");
				await this.plugin.ops.ensureFolder(parent);
				await app.vault.rename(file, item.to);
			} else file = dest;
			if (!(file instanceof TFile)) throw new Error(`Missing migration file: ${item.to}`);
			const actual = await contentHash(await app.vault.readBinary(file));
			if (actual !== item.beforeHash && actual !== item.afterHash) throw new Error(`Edited during migration; preserved: ${item.to}`);
			if (item.text !== undefined && actual !== item.afterHash) {
				const expected = await app.vault.read(file);
				if (await contentHash(new TextEncoder().encode(expected).buffer) !== item.beforeHash) throw new Error(`Edited during migration; preserved: ${item.to}`);
				await app.vault.process(file, (current) => {
					if (current !== expected) throw new Error(`Edited during migration: ${item.to}`);
					return item.text!;
				});
			}
			if (await contentHash(await app.vault.readBinary(file)) !== item.afterHash) throw new Error(`Verification failed: ${item.to}`);
			const entry = index.getFile(item.to);
			if (entry) {
				if (item.beforeHash !== item.afterHash) { entry.dirty = true; entry.revision = (entry.revision ?? 0) + 1; }
				entry.localMtime = file.stat.mtime;
				entry.localSize = file.stat.size;
				index.markDirty();
			}
			await new Promise((resolve) => setTimeout(resolve, 0));
		}
		for (const item of journal.files) {
			const file = app.vault.getAbstractFileByPath(item.to);
			if (!(file instanceof TFile) || await contentHash(await app.vault.readBinary(file)) !== item.afterHash) {
				throw new Error(`Edited before migration commit; preserved: ${item.to}`);
			}
		}
		journal.phase = "committing";
		await this.save(journal);
		settings.mountMode = "vaultRoot";
		index.data.mountBase = "";
		index.markDirty();
		await index.flush();
		await this.plugin.saveSettings();
		// Empty old directories are local cleanup only; never delete user contents.
		const oldFolders = [...journal.folders.map((p) => `${journal.base}/${p}`), journal.base].sort((a, b) => b.length - a.length);
		for (const path of oldFolders) {
			const folder = this.plugin.ops.getFolder(path);
			if (folder?.children.length === 0) await app.vault.delete(folder);
		}
		journal.phase = "complete";
		await this.save(journal);
		return journal.warnings;
	}
}
