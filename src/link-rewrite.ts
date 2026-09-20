function relativeTarget(source: string, destination: string): string {
	const from = source.split("/").slice(0, -1);
	const to = destination.split("/");
	while (from.length && to.length && from[0] === to[0]) { from.shift(); to.shift(); }
	return "../".repeat(from.length) + to.join("/");
}

/** Rewrite only a parser-identified link's destination, preserving label/title/fragment. */
export function rewriteLink(original: string, destination: string, source: string): string {
	const wikiStart = original.startsWith("![[") ? 3 : original.startsWith("[[") ? 2 : -1;
	if (wikiStart >= 0) {
		const end = original.indexOf("]]", wikiStart);
		if (end < 0) throw new Error("Unsupported wikilink");
		const inner = original.slice(wikiStart, end);
		const cut = inner.search(/[|#]/);
		const path = cut < 0 ? inner : inner.slice(0, cut);
		const target = destination.endsWith(".md") && !path.endsWith(".md") ? destination.slice(0, -3) : destination;
		return original.slice(0, wikiStart) + target + (cut < 0 ? "" : inner.slice(cut)) + original.slice(end);
	}
	const open = original.indexOf("](");
	if (open < 0) throw new Error("Unsupported link syntax");
	let start = open + 2;
	while (/\s/.test(original[start] ?? "") && start < original.length) start++;
	const angled = original[start] === "<";
	if (angled) start++;
	let end = start, depth = 0;
	for (; end < original.length; end++) {
		const ch = original[end];
		if (ch === "\\") { end++; continue; }
		if (angled) { if (ch === ">") break; continue; }
		if (ch === "(") depth++;
		else if (ch === ")") { if (!depth) break; depth--; }
		else if (/\s/.test(ch) && !depth) break;
	}
	if (end === original.length) throw new Error("Unsupported Markdown destination");
	const oldTarget = original.slice(start, end);
	const fragment = oldTarget.includes("#") ? oldTarget.slice(oldTarget.indexOf("#")) : "";
	const target = relativeTarget(source, destination).split("/").map(encodeURIComponent).join("/")
		.replace(/\(/g, "%28").replace(/\)/g, "%29");
	return original.slice(0, start) + target + fragment + original.slice(end);
}
