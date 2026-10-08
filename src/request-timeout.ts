/** Bound reads only. A timed-out write must not be retried while its outcome is unknown. */
export async function readWithTimeout<T>(work: Promise<T>, label: string, ms = 60000): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([work, new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error(`${label}: response timed out (${Math.round(ms / 1000)}s)`)), ms);
		})]);
	} finally { if (timer !== undefined) clearTimeout(timer); }
}
