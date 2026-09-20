import { App, TFile } from "obsidian";

const parsedText = new WeakMap<TFile, string | null>();
export function invalidateLinkCache(file: TFile): void { if (file.extension === "md") parsedText.set(file, null); }
export function recordParsedText(file: TFile, text: string): void { if (file.extension === "md") parsedText.set(file, text); }

export interface AttachmentReference {
	link: string;
	file: TFile | null;
}

/** Only local attachments are upload dependencies; note links can be cyclic. */
export function attachmentReferences(app: App, source: TFile): AttachmentReference[] {
	const cache = app.metadataCache.getFileCache(source);
	const refs = [...(cache?.embeds ?? []), ...(cache?.links ?? [])];
	const found = new Map<string, AttachmentReference>();
	for (const ref of refs) {
		if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(ref.link)) continue;
		const file = app.metadataCache.getFirstLinkpathDest(ref.link, source.path);
		const path = ref.link.split("#")[0];
		if (file?.extension === "md" || (!file && !/\.[a-z0-9]{1,10}$/i.test(path))) continue;
		found.set(file?.path ?? ref.link, { link: ref.link, file });
	}
	return [...found.values()];
}

/** Reject stale metadata before making a dependency or migration decision. */
export function freshLinkCache(app: App, source: TFile, text: string): boolean {
	if (parsedText.has(source) && parsedText.get(source) !== text) return false;
	const cache = app.metadataCache.getFileCache(source);
	if (!cache) return false;
	return [...(cache.embeds ?? []), ...(cache.links ?? [])].every((ref) =>
		text.slice(ref.position.start.offset, ref.position.end.offset) === ref.original);
}
