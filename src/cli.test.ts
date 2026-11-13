import { afterAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOCALES } from './manifest/index.ts';
import { fakeJpeg, fakeWebp, LISTING, manifest } from './manifest/fixtures.ts';
import { pack, upload } from './index.ts';

const root = await mkdtemp(join(tmpdir(), 'oc-cli-'));
afterAll(() => rm(root, { recursive: true, force: true }));

async function write(path: string, data: string | Uint8Array) {
	await mkdir(join(root, path, '..'), { recursive: true });
	await writeFile(join(root, path), data);
}

/** A source package as a developer writes it: TypeScript entries, art in its own folder. */
async function sourceGame(server: boolean) {
	await rm(root, { recursive: true, force: true });
	await write(
		'game.json',
		JSON.stringify(
			manifest({
				entry: { client: './src/client.ts', ...(server ? { server: './src/server.ts' } : {}) },
				realtime: server
					? { kind: 'server', tickRate: 20, snapshotRate: 10, protocol: 1 }
					: { kind: 'relay', tickRate: 0, snapshotRate: 0, protocol: 1 },
				locales: ['en'],
				messages: './messages',
				listing: './listing',
				media: {
					cover: './art/cover.webp',
					stills: ['./art/a.webp', './art/b.webp', './art/c.webp'],
					share: './art/share.jpg'
				}
			})
		)
	);
	await write('src/shared.ts', 'export const SPEED: number = 3;\n');
	await write(
		'src/client.ts',
		"import { SPEED } from './shared.ts';\nexport async function mount(host: HTMLElement) { host.dataset.speed = String(SPEED); const lazy = await import('./lazy.ts'); return lazy; }\n"
	);
	await write('src/lazy.ts', 'export const later = 42;\n');
	await write(
		'src/server.ts',
		"import { SPEED } from './shared.ts';\nexport function createGameModule() { return { speed: SPEED }; }\n"
	);
	await write('src/client.test.ts', 'not shipped\n');
	await write('messages/en.json', JSON.stringify({ hello: 'Hello' }));
	for (const l of LOCALES) await write(`listing/${l}.json`, JSON.stringify(LISTING));
	await write('art/cover.webp', fakeWebp(1280, 720));
	for (const s of ['a', 'b', 'c']) {
		await write(`art/${s}.webp`, fakeWebp(1280, 720));
		await write(`art/${s}-thumb.webp`, fakeWebp(320, 180));
	}
	await write('art/share.jpg', fakeJpeg(1200, 630));
}

describe('pack', () => {
	it('builds TypeScript into the bundle layout and validates it', async () => {
		await sourceGame(true);
		const r = await pack(root);
		expect(r.report.issues).toEqual([]);
		const paths = r.files.map((f) => f.path);
		expect(paths).toContain('client/index.js');
		expect(paths.some((p) => /^client\/chunk-.+\.js$/.test(p))).toBe(true); // the dynamic import stays lazy
		expect(paths).toContain('server.js');
		expect(paths).toContain('media/still-2-thumb.webp');
		expect(paths).toContain('source/src/client.ts');
		expect(paths).not.toContain('source/src/client.test.ts');
		const m = JSON.parse(await readFile(join(r.out, 'game.json'), 'utf8'));
		expect(m.entry).toEqual({ client: 'client/index.js', server: 'server.js' });
		const server = await readFile(join(r.out, 'server.js'), 'utf8');
		expect(server).toContain('createGameModule');
		expect(server).not.toMatch(/\bimport\b/);
	});

	it('leaves the server out of a relay game', async () => {
		await sourceGame(false);
		const r = await pack(root);
		expect(r.report.ok).toBe(true);
		expect(r.files.map((f) => f.path)).not.toContain('server.js');
	});
});

describe('upload', () => {
	it('creates a version, sends every file once, then finalises', async () => {
		await sourceGame(false);
		const r = await pack(root);
		const calls: string[] = [];
		const fakeFetch = (async (url: URL, init: RequestInit) => {
			calls.push(`${init.method} ${url.pathname}${url.search}`);
			expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok');
			if (url.pathname.endsWith('/versions'))
				return Response.json({ versionId: 'v1' }, { status: 201 });
			if (url.pathname.endsWith('/finalise'))
				return Response.json({ state: 'in_review', issues: [] });
			return new Response(null, { status: 204 });
		}) as unknown as typeof fetch;
		const p = await upload({ url: 'http://x', token: 'tok', fetch: fakeFetch }, r.out);
		expect(p).toEqual({ versionId: 'v1', state: 'in_review', issues: [] });
		expect(calls[0]).toBe('POST /api/dev/games/test-game/versions');
		expect(calls.filter((c) => c.startsWith('PUT /api/dev/versions/v1/files?path='))).toHaveLength(
			r.files.length
		);
		expect(calls.at(-1)).toBe('POST /api/dev/versions/v1/finalise');
	});
});
