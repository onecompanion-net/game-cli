/** Test fixtures: a minimal valid bundle built in memory (tiny but correctly sized image headers). */
import { sha256Hex } from './files.ts';
import { LISTING_LOCALES } from './schema.ts';
import type { BundleContext } from './bundle.ts';

/** A VP8X WebP header claiming the given size (enough for header checks, not a decodable image). */
export function fakeWebp(width: number, height: number): Uint8Array {
	const b = new Uint8Array(30);
	b.set(
		[...'RIFF'].map((c) => c.charCodeAt(0)),
		0
	);
	b.set(
		[...'WEBP'].map((c) => c.charCodeAt(0)),
		8
	);
	b.set(
		[...'VP8X'].map((c) => c.charCodeAt(0)),
		12
	);
	const w = width - 1;
	const h = height - 1;
	b.set(
		[w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff, h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff],
		24
	);
	return b;
}

/** A JPEG with one SOF0 segment of the given size. */
export function fakeJpeg(width: number, height: number): Uint8Array {
	return new Uint8Array([
		0xff,
		0xd8,
		0xff,
		0xe0,
		0x00,
		0x04,
		0x00,
		0x00,
		0xff,
		0xc0,
		0x00,
		0x11,
		0x08,
		height >> 8,
		height & 0xff,
		width >> 8,
		width & 0xff,
		0x03,
		0,
		0,
		0,
		0,
		0,
		0
	]);
}

export const LISTING = {
	tagline: 'A small test game.',
	pitch: 'Tests the bundle validator.',
	about: ['Made for tests.'],
	seoTitle: 'Test game',
	seoDescription: 'A game used by tests.',
	coverAlt: 'A grey test card'
};

export function manifest(over: Record<string, unknown> = {}) {
	return {
		manifest: 1,
		id: 'test-game',
		title: 'Test Game',
		version: '1.0.0',
		studio: 'acme',
		genres: ['action'],
		players: { min: 1, max: 4 },
		modes: ['solo', 'coop'],
		entry: { client: 'client/index.js' },
		realtime: { kind: 'relay', tickRate: 0, snapshotRate: 0, protocol: 1 },
		locales: ['en', 'vi'],
		messages: 'messages',
		listing: 'listing',
		media: {
			cover: 'media/cover.webp',
			stills: ['media/still-1.webp', 'media/still-2.webp', 'media/still-3.webp'],
			share: 'media/share.jpg'
		},
		budgets: { clientGzipKB: 100 },
		capabilities: {
			pointerLock: false,
			fullscreen: true,
			gamepad: false,
			audio: true,
			network: []
		},
		rating: { level: 'everyone', descriptors: [] },
		rights: { ownsAllContent: true, thirdParty: [] },
		...over
	};
}

const enc = (s: string) => new TextEncoder().encode(s);

/** A complete, valid bundle; `edit` may add, replace or delete (undefined) files. */
export async function bundle(
	m: Record<string, unknown> = manifest(),
	edit: Record<string, Uint8Array | string | undefined> = {}
): Promise<{
	manifest: Record<string, unknown>;
	ctx: BundleContext;
	contents: Map<string, Uint8Array>;
}> {
	const files: Record<string, Uint8Array | string | undefined> = {
		'game.json': JSON.stringify(m),
		'client/index.js':
			"import { draw } from './draw.js';\nexport async function mount(host) { draw(host); }\n",
		'client/draw.js': 'export const draw = (h) => h;\n',
		'client/lazy.js': 'export const big = 1;\n',
		'messages/en.json': JSON.stringify({
			hello: 'Hello {name}',
			count: '{n, plural, one {# point} other {# points}}'
		}),
		'messages/vi.json': JSON.stringify({
			hello: 'Xin chào {name}',
			count: '{n, plural, other {# điểm}}'
		}),
		'media/cover.webp': fakeWebp(1280, 720),
		'media/share.jpg': fakeJpeg(1200, 630),
		// The required listings only, as a game built before the newer locales would ship.
		...Object.fromEntries(
			LISTING_LOCALES.map((l) => [`listing/${l}.json`, JSON.stringify(LISTING)])
		),
		...Object.fromEntries(
			[1, 2, 3].flatMap((i) => [
				[`media/still-${i}.webp`, fakeWebp(1280, 720)],
				[`media/still-${i}-thumb.webp`, fakeWebp(320, 180)]
			])
		),
		...edit
	};
	const contents = new Map<string, Uint8Array>();
	for (const [p, v] of Object.entries(files))
		if (v !== undefined) contents.set(p, typeof v === 'string' ? enc(v) : v);
	const list = await Promise.all(
		[...contents].map(async ([path, b]) => ({
			path,
			bytes: b.byteLength,
			sha256: await sha256Hex(b)
		}))
	);
	return {
		manifest: m,
		contents,
		ctx: { files: list, read: async (p) => contents.get(p) ?? new Uint8Array() }
	};
}

/** A binary glTF with the given JSON chunk (and an empty BIN chunk). */
export function fakeGlb(json: object): Uint8Array {
	let text = JSON.stringify(json);
	while (text.length % 4) text += ' ';
	const body = new TextEncoder().encode(text);
	const out = new Uint8Array(12 + 8 + body.length + 8);
	const dv = new DataView(out.buffer);
	out.set(
		[...'glTF'].map((c) => c.charCodeAt(0)),
		0
	);
	dv.setUint32(4, 2, true);
	dv.setUint32(8, out.length, true);
	dv.setUint32(12, body.length, true);
	dv.setUint32(16, 0x4e4f534a, true);
	out.set(body, 20);
	dv.setUint32(20 + body.length, 0, true);
	dv.setUint32(24 + body.length, 0x004e4942, true);
	return out;
}
