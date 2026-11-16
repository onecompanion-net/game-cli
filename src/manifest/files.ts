/** File types a bundle may contain, how to recognise them from their first bytes, and image dimensions. */

/** Extension → content type. Nothing else is stored or served (no HTML, SVG or source maps). */
export const CONTENT_TYPES: Readonly<Record<string, string>> = {
	js: 'text/javascript; charset=utf-8',
	json: 'application/json; charset=utf-8',
	wasm: 'application/wasm',
	webp: 'image/webp',
	png: 'image/png',
	jpg: 'image/jpeg',
	jpeg: 'image/jpeg',
	avif: 'image/avif',
	ktx2: 'image/ktx2',
	glb: 'model/gltf-binary',
	ogg: 'audio/ogg',
	mp3: 'audio/mpeg',
	woff2: 'font/woff2'
};

/** Source files travel with a version for review only; they are never served. */
export const SOURCE_TYPES: Readonly<Record<string, string>> = {
	ts: 'text/plain; charset=utf-8',
	tsx: 'text/plain; charset=utf-8',
	js: 'text/plain; charset=utf-8',
	mjs: 'text/plain; charset=utf-8',
	json: 'text/plain; charset=utf-8',
	css: 'text/plain; charset=utf-8',
	glsl: 'text/plain; charset=utf-8',
	md: 'text/plain; charset=utf-8'
};

export const extOf = (path: string) => (/\.([a-z0-9]+)$/i.exec(path)?.[1] ?? '').toLowerCase();

/** A path a bundle may hold: lowercase-safe characters, no dot segments, at most 6 levels. */
export function isSafePath(p: string): boolean {
	if (p.length > 200 || p.startsWith('/') || p.includes('\\') || p.includes('//')) return false;
	const segs = p.split('/');
	if (segs.length > 7) return false;
	return segs.every((s) => /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/.test(s) && s !== '.' && s !== '..');
}

const startsWith = (b: Uint8Array, sig: number[], at = 0) => sig.every((v, i) => b[at + i] === v);
const ascii = (b: Uint8Array, at: number, n: number) =>
	String.fromCharCode(...b.subarray(at, at + n));

/** Whether the first bytes match the extension. Text types must be UTF-8 and must not look like HTML. */
export function magicMatches(ext: string, b: Uint8Array): boolean {
	switch (ext) {
		case 'wasm':
			return startsWith(b, [0x00, 0x61, 0x73, 0x6d]);
		case 'webp':
			return ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP';
		case 'png':
			return startsWith(b, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
		case 'jpg':
		case 'jpeg':
			return startsWith(b, [0xff, 0xd8, 0xff]);
		case 'ogg':
			return ascii(b, 0, 4) === 'OggS';
		case 'mp3':
			return ascii(b, 0, 3) === 'ID3' || (b[0] === 0xff && (b[1]! & 0xe0) === 0xe0);
		case 'woff2':
			return ascii(b, 0, 4) === 'wOF2';
		case 'glb':
			return ascii(b, 0, 4) === 'glTF';
		case 'ktx2':
			return startsWith(
				b,
				[0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]
			);
		case 'avif':
			return ascii(b, 4, 4) === 'ftyp' && ['avif', 'avis'].includes(ascii(b, 8, 4));
		case 'js':
		case 'json': {
			let text: string;
			try {
				text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
					b.subarray(0, 4096)
				);
			} catch {
				// A multi-byte character cut at 4096 bytes is fine; anything else is not UTF-8.
				try {
					new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(b.subarray(0, 4093));
					return true;
				} catch {
					return false;
				}
			}
			return !/^\s*</.test(text);
		}
		default:
			return false;
	}
}

export interface Size {
	width: number;
	height: number;
}

/** Width and height from a WebP, PNG or JPEG header, or null. */
export function imageSize(ext: string, b: Uint8Array): Size | null {
	const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
	try {
		if (ext === 'png') return { width: dv.getUint32(16), height: dv.getUint32(20) };
		if (ext === 'webp') {
			const chunk = ascii(b, 12, 4);
			if (chunk === 'VP8 ')
				return { width: dv.getUint16(26, true) & 0x3fff, height: dv.getUint16(28, true) & 0x3fff };
			if (chunk === 'VP8L') {
				const bits = dv.getUint32(21, true);
				return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
			}
			if (chunk === 'VP8X') {
				const w = b[24]! | (b[25]! << 8) | (b[26]! << 16);
				const h = b[27]! | (b[28]! << 8) | (b[29]! << 16);
				return { width: w + 1, height: h + 1 };
			}
			return null;
		}
		if (ext === 'jpg' || ext === 'jpeg') {
			let i = 2;
			while (i + 9 < b.length) {
				if (b[i] !== 0xff) return null;
				const marker = b[i + 1]!;
				const len = dv.getUint16(i + 2);
				// SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC).
				if (
					marker >= 0xc0 &&
					marker <= 0xcf &&
					marker !== 0xc4 &&
					marker !== 0xc8 &&
					marker !== 0xcc
				)
					return { height: dv.getUint16(i + 5), width: dv.getUint16(i + 7) };
				i += 2 + len;
			}
		}
	} catch {
		return null;
	}
	return null;
}

/** Lowercase hex SHA-256 (WebCrypto: Workers, Bun and browsers). */
export async function sha256Hex(b: Uint8Array): Promise<string> {
	const d = await crypto.subtle.digest('SHA-256', b as Uint8Array<ArrayBuffer>);
	return [...new Uint8Array(d)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** Gzipped size in bytes (CompressionStream: Workers, Bun and browsers). */
export async function gzipSize(b: Uint8Array): Promise<number> {
	const stream = new Blob([b as Uint8Array<ArrayBuffer>])
		.stream()
		.pipeThrough(new CompressionStream('gzip'));
	let n = 0;
	const reader = stream.getReader();
	for (;;) {
		const { done, value } = await reader.read();
		if (done) return n;
		n += value.byteLength;
	}
}

/**
 * Static imports of a built ES module (`import x from './a.js'`, `import './a.js'`, `export * from './a.js'`).
 * Dynamic `import()` is excluded on purpose: lazy chunks do not count against the entry budget.
 */
export function staticImports(code: string): string[] {
	const out = new Set<string>();
	const re = /(?:^|[;\n}\s])(?:import|export)\s*(?:[\w*{}\s,$]+\s*from\s*)?["']([^"']+)["']/g;
	for (const m of code.matchAll(re)) out.add(m[1]!);
	return [...out];
}

/** Resolve a relative specifier against the importing file's path. Null for bare or absolute specifiers. */
export function resolveRelative(from: string, spec: string): string | null {
	if (!spec.startsWith('./') && !spec.startsWith('../')) return null;
	const parts = from.split('/').slice(0, -1);
	for (const seg of spec.split('/')) {
		if (seg === '.' || seg === '') continue;
		if (seg === '..') {
			if (!parts.length) return null;
			parts.pop();
		} else parts.push(seg);
	}
	return parts.join('/');
}

/**
 * A binary glTF must carry everything it needs (docs/economy-plan.md, section 6c): no buffer or image may point at
 * another file or a `data:` URI, so a model can never reach outside its own bytes. Returns problems, or [] when fine.
 */
export function glbProblems(b: Uint8Array): string[] {
	if (b.length < 20 || ascii(b, 0, 4) !== 'glTF') return ['not a binary glTF'];
	const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
	if (dv.getUint32(4, true) !== 2) return ['only glTF 2.0 is supported'];
	if (dv.getUint32(8, true) !== b.length) return ['the header length does not match the file'];
	const jsonLength = dv.getUint32(12, true);
	if (dv.getUint32(16, true) !== 0x4e4f534a || 20 + jsonLength > b.length)
		return ['the first chunk must be the JSON chunk'];
	let gltf: { buffers?: { uri?: unknown }[]; images?: { uri?: unknown }[] };
	try {
		gltf = JSON.parse(
			new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
				b.subarray(20, 20 + jsonLength)
			)
		);
	} catch {
		return ['the JSON chunk is not valid JSON'];
	}
	const out: string[] = [];
	(gltf.buffers ?? []).forEach((x, i) => {
		if (x?.uri !== undefined) out.push(`buffers[${i}] points at a file or data URI: embed it`);
	});
	(gltf.images ?? []).forEach((x, i) => {
		if (x?.uri !== undefined) out.push(`images[${i}] points at a file or data URI: embed it`);
	});
	return out;
}
