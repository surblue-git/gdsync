/**
 * MD5 is used only to compare local bytes with Google Drive's md5Checksum.
 * It is not used for authentication or any other security decision.
 */
export function md5Hex(data: ArrayBuffer): string {
	const input = new Uint8Array(data);
	const paddedLength = (((input.length + 8) >>> 6) + 1) * 64;
	const padded = new Uint8Array(paddedLength);
	padded.set(input);
	padded[input.length] = 0x80;
	const view = new DataView(padded.buffer);
	const bitLength = input.length * 8;
	view.setUint32(paddedLength - 8, bitLength >>> 0, true);
	view.setUint32(paddedLength - 4, Math.floor(bitLength / 0x100000000), true);

	let a0 = 0x67452301;
	let b0 = 0xefcdab89;
	let c0 = 0x98badcfe;
	let d0 = 0x10325476;
	const shifts = [
		7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22, 7, 12, 17, 22,
		5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20, 5, 9, 14, 20,
		4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23, 4, 11, 16, 23,
		6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21, 6, 10, 15, 21,
	];
	const constants = Array.from({ length: 64 }, (_, i) =>
		Math.floor(Math.abs(Math.sin(i + 1)) * 0x100000000) >>> 0
	);

	for (let offset = 0; offset < paddedLength; offset += 64) {
		let a = a0;
		let b = b0;
		let c = c0;
		let d = d0;
		for (let i = 0; i < 64; i++) {
			let f: number;
			let g: number;
			if (i < 16) {
				f = (b & c) | (~b & d);
				g = i;
			} else if (i < 32) {
				f = (d & b) | (~d & c);
				g = (5 * i + 1) % 16;
			} else if (i < 48) {
				f = b ^ c ^ d;
				g = (3 * i + 5) % 16;
			} else {
				f = c ^ (b | ~d);
				g = (7 * i) % 16;
			}
			const sum = (a + f + constants[i] + view.getUint32(offset + g * 4, true)) | 0;
			const rotated = (sum << shifts[i]) | (sum >>> (32 - shifts[i]));
			const next = (b + rotated) | 0;
			a = d;
			d = c;
			c = b;
			b = next;
		}
		a0 = (a0 + a) | 0;
		b0 = (b0 + b) | 0;
		c0 = (c0 + c) | 0;
		d0 = (d0 + d) | 0;
	}

	return [a0, b0, c0, d0].map((word) => {
		let out = "";
		for (let i = 0; i < 4; i++) out += ((word >>> (i * 8)) & 0xff).toString(16).padStart(2, "0");
		return out;
	}).join("");
}
