export type MountMode = "subfolder" | "vaultRoot";

export function validPath(path: string, allowRoot = false): boolean {
	if (!path) return allowRoot;
	return !path.startsWith("/") && !path.includes("\\") && !path.includes(":") &&
		!/[\u0000-\u001f]/.test(path) &&
		path.split("/").every((p) => !!p && p !== "." && p !== "..");
}
export function mountBase(mode: MountMode, base: string): string {
	if (mode === "vaultRoot") return "";
	if (!validPath(base)) throw new Error("Invalid mirror folder");
	return base;
}
export function vaultPath(base: string, rel: string): string {
	if (!validPath(rel, true)) throw new Error("Invalid relative path");
	return base && rel ? `${base}/${rel}` : base || rel;
}
export function relativePath(base: string, path: string): string | null {
	if (!validPath(path, true)) return null;
	if (!base) return path;
	if (path === base) return "";
	return path.startsWith(base + "/") ? path.slice(base.length + 1) : null;
}
export function protectedPath(path: string, configDir: string): boolean {
	return path.split("/").some((p) => p.startsWith(".")) ||
		path === configDir || path.startsWith(configDir + "/");
}
