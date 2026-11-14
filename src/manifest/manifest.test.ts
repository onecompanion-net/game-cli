import { describe, expect, it } from 'bun:test';
import { validateBundle } from './bundle.ts';
import { bundle, fakeJpeg, fakeWebp, LISTING, manifest } from './fixtures.ts';
import { imageSize, isSafePath, magicMatches, resolveRelative, staticImports } from './files.ts';
import { formatIcu, icuArgs, parseIcu, translator } from './icu.ts';
import { compareSemver, parseManifest, roomKind } from './schema.ts';

describe('manifest', () => {
	it('accepts the starter-shaped source manifest and a full bundle manifest', () => {
		const source = manifest({
			entry: { client: './src/client/index.ts' },
			listing: undefined,
			rating: undefined
		});
		expect(parseManifest(source, 'source').ok).toBe(true);
		expect(parseManifest(manifest(), 'bundle').ok).toBe(true);
	});

	it('rejects what an upload must not carry', () => {
		const bad = (over: Record<string, unknown>, shape: 'source' | 'bundle' = 'bundle') => {
			const r = parseManifest(manifest(over), shape);
			return r.ok ? [] : r.issues.map((i) => i.path);
		};
		expect(bad({ id: 'Bad_Id' })).toContain('id');
		expect(bad({ version: '1.0' })).toContain('version');
		expect(bad({ capabilities: { network: ['https://evil.example'] } })).toContain(
			'capabilities.network'
		);
		expect(bad({ locales: ['vi'] })).toContain('locales');
		expect(bad({ entry: { client: '../escape.js' } })).toContain('entry.client');
		expect(bad({ entry: { client: 'client/index.ts' } })).toContain('entry.client');
		expect(bad({ rights: { ownsAllContent: false } })).toContain('rights.ownsAllContent');
		expect(bad({ players: { min: 1, max: 32 } })).toContain('players.max');
		expect(
			bad({ realtime: { kind: 'none', tickRate: 0, snapshotRate: 0, protocol: 1 } })
		).toContain('modes');
		expect(
			bad({ realtime: { kind: 'server', tickRate: 20, snapshotRate: 10, protocol: 1 } })
		).toContain('entry.server');
		expect(bad({ genres: ['racing'] })).toContain('genres.0');
	});

	it('infers the room kind', () => {
		expect(roomKind({ entry: { client: 'a.js', server: 'server.js' } })).toBe('server');
		expect(roomKind({ entry: { client: 'a.js' } })).toBe('none');
		expect(
			roomKind({
				entry: { client: 'a.js' },
				realtime: { kind: 'relay', tickRate: 0, snapshotRate: 0, protocol: 1 }
			})
		).toBe('relay');
	});

	it('orders versions by semver', () => {
		expect(compareSemver('1.0.10', '1.0.9')).toBe(1);
		expect(compareSemver('1.0.0-beta', '1.0.0')).toBe(-1);
		expect(compareSemver('2.0.0', '2.0.0')).toBe(0);
	});
});

describe('icu', () => {
	it('parses and formats arguments, plurals and selects', () => {
		const p = parseIcu(
			'{n, plural, =0 {none} one {# beacon} other {# beacons}} by {who, select, me {you} other {{who}}}'
		);
		expect(icuArgs(p)).toEqual(['n', 'who']);
		expect(formatIcu(p, { n: 0, who: 'me' })).toBe('none by you');
		expect(formatIcu(p, { n: 1, who: 'Ann' })).toBe('1 beacon by Ann');
		expect(formatIcu(p, { n: 1200, who: 'Ann' }, 'en')).toBe('1,200 beacons by Ann');
		expect(formatIcu(parseIcu("It''s '{literal}'"), {})).toBe("It's {literal}");
	});

	it('rejects markup and malformed messages', () => {
		for (const bad of [
			'<b>hi</b>',
			'{',
			'}',
			'{n, plural, one {x}}',
			'{n, number}',
			'{1bad}',
			'{n, plural, other {x}'
		])
			expect(() => parseIcu(bad)).toThrow();
	});

	it('builds a t that falls back to the key', () => {
		const t = translator({ hi: 'Hi {name}', broken: '{' }, 'en');
		expect(t('hi', { name: 'Ann' })).toBe('Hi Ann');
		expect(t('broken')).toBe('broken');
		expect(t('nope')).toBe('nope');
		expect(t('toString')).toBe('toString');
	});
});

describe('files', () => {
	it('reads image sizes from headers', () => {
		expect(imageSize('webp', fakeWebp(1280, 720))).toEqual({ width: 1280, height: 720 });
		expect(imageSize('jpg', fakeJpeg(1200, 630))).toEqual({ width: 1200, height: 630 });
	});

	it('checks first bytes and paths', () => {
		const enc = (s: string) => new TextEncoder().encode(s);
		expect(magicMatches('js', enc('export const a = 1;'))).toBe(true);
		expect(magicMatches('js', enc('<!doctype html><script>'))).toBe(false);
		expect(magicMatches('webp', enc('GIF89a'))).toBe(false);
		expect(isSafePath('client/a.js')).toBe(true);
		for (const p of ['../a.js', '/a.js', 'a\\b.js', 'client/../a.js', '.hidden', 'a//b.js'])
			expect(isSafePath(p)).toBe(false);
	});

	it('follows static imports only', () => {
		const code = `import a from './a.js';\nimport './b.js';\nexport * from "../c.js";\nconst d = import('./lazy.js');`;
		expect(staticImports(code)).toEqual(['./a.js', './b.js', '../c.js']);
		expect(resolveRelative('client/x/y.js', '../z.js')).toBe('client/z.js');
		expect(resolveRelative('client/y.js', 'three')).toBeNull();
	});
});

describe('validateBundle', () => {
	it('passes a complete bundle and measures the entry graph without lazy chunks', async () => {
		const b = await bundle();
		const r = await validateBundle(b.manifest, b.ctx);
		expect(r.issues).toEqual([]);
		expect(r.ok).toBe(true);
		expect(r.clientGzipBytes).toBeGreaterThan(0);
		expect(Object.keys(r.listing)).toHaveLength(12);
	});

	it('reports each kind of problem', async () => {
		const html = await bundle(manifest(), { 'client/page.html': '<html></html>' });
		expect((await validateBundle(html.manifest, html.ctx)).issues.map((i) => i.path)).toContain(
			'client/page.html'
		);

		const disguised = await bundle(manifest(), { 'client/draw.js': '<script>alert(1)</script>' });
		expect(
			(await validateBundle(disguised.manifest, disguised.ctx)).issues.some((i) =>
				i.message.includes('look like')
			)
		).toBe(true);

		const keys = await bundle(manifest(), {
			'messages/vi.json': JSON.stringify({ hello: 'Chào {who}' })
		});
		const ki = (await validateBundle(keys.manifest, keys.ctx)).issues.map((i) => i.message);
		expect(ki).toContain('missing key count');
		expect(ki.some((m) => m.includes('differ from en'))).toBe(true);

		const media = await bundle(manifest(), {
			'media/cover.webp': fakeWebp(640, 360),
			'media/still-2-thumb.webp': undefined
		});
		const mi = (await validateBundle(media.manifest, media.ctx)).issues;
		expect(mi.some((i) => i.message.includes('640×360'))).toBe(true);
		expect(mi.map((i) => i.path)).toContain('media/still-2-thumb.webp');

		const listing = await bundle(manifest(), { 'listing/ar.json': undefined });
		expect(
			(await validateBundle(listing.manifest, listing.ctx)).issues.map((i) => i.path)
		).toContain('listing/ar.json');

		// A newer platform locale is optional, but checked like the others when it is there.
		const extra = await bundle(manifest(), { 'listing/ja.json': JSON.stringify({ tagline: 1 }) });
		expect((await validateBundle(extra.manifest, extra.ctx)).issues.map((i) => i.path)).toContain(
			'listing/ja.json'
		);

		const bare = await bundle(manifest(), {
			'client/draw.js': "import * as THREE from 'three';\nexport const draw = 1;"
		});
		expect(
			(await validateBundle(bare.manifest, bare.ctx)).issues.some((i) =>
				i.message.includes('only relative imports')
			)
		).toBe(true);

		const budget = await bundle(manifest({ budgets: { clientGzipKB: 0.01 } }));
		expect(
			(await validateBundle(budget.manifest, budget.ctx)).issues.some((i) =>
				i.message.includes('over its budget')
			)
		).toBe(true);

		const kind = await bundle();
		expect((await validateBundle(kind.manifest, { ...kind.ctx, allowedKinds: ['none'] })).ok).toBe(
			false
		);
	});

	it('refuses untranslated copies unless asked to only list them', async () => {
		const marked = (o: Record<string, unknown>) => JSON.stringify({ $untranslated: true, ...o });
		const b = await bundle(manifest(), {
			'listing/fr.json': marked(LISTING),
			'messages/vi.json': marked({ hello: 'Hello {name}', count: '{n, plural, other {# points}}' })
		});
		const strict = await validateBundle(b.manifest, b.ctx);
		expect(strict.ok).toBe(false);
		expect(strict.untranslated.sort()).toEqual(['listing/fr.json', 'messages/vi.json']);
		expect(strict.issues.map((i) => i.path).sort()).toEqual([
			'listing/fr.json',
			'messages/vi.json'
		]);
		const lenient = await validateBundle(b.manifest, b.ctx, { allowUntranslated: true });
		expect(lenient.issues).toEqual([]);
		expect(lenient.untranslated).toHaveLength(2);
	});

	it('checks the optional play label and mode cards', async () => {
		const good = await bundle(manifest(), {
			'listing/en.json': JSON.stringify({
				...LISTING,
				play: 'Defend the hill',
				modes: { coop: 'Hold the hill with friends.', solo: 'Practise alone.' }
			})
		});
		const r = await validateBundle(good.manifest, good.ctx);
		expect(r.issues).toEqual([]);
		expect((r.listing.en as { modes: unknown }).modes).toEqual({
			coop: 'Hold the hill with friends.',
			solo: 'Practise alone.'
		});
		const bad = await bundle(manifest(), {
			'listing/en.json': JSON.stringify({ ...LISTING, modes: { tdm: 'Teams.', solo: '<b>x</b>' } })
		});
		const bi = (await validateBundle(bad.manifest, bad.ctx)).issues.map((i) => i.message);
		expect(bi).toContain('markup is not allowed');
		const unknown = await bundle(manifest(), {
			'listing/en.json': JSON.stringify({ ...LISTING, modes: { tdm: 'Teams.' } })
		});
		expect(
			(await validateBundle(unknown.manifest, unknown.ctx)).issues.map((i) => i.message)
		).toContain('modes.tdm: the game has no tdm mode');
	});

	it('checks a server module', async () => {
		const m = manifest({
			entry: { client: 'client/index.js', server: 'server.js' },
			realtime: { kind: 'server', tickRate: 20, snapshotRate: 10, protocol: 1 }
		});
		const good = await bundle(m, {
			'server.js': 'export function createGameModule() { return {}; }'
		});
		expect((await validateBundle(good.manifest, good.ctx)).issues).toEqual([]);
		const imports = await bundle(m, {
			'server.js': "import x from './x.js';\nexport function createGameModule() {}"
		});
		expect(
			(await validateBundle(imports.manifest, imports.ctx)).issues.some((i) =>
				i.message.includes('no imports')
			)
		).toBe(true);
		const missing = await bundle(m, { 'server.js': 'export const other = 1;' });
		expect(
			(await validateBundle(missing.manifest, missing.ctx)).issues.some((i) =>
				i.message.includes('createGameModule')
			)
		).toBe(true);
	});
});
