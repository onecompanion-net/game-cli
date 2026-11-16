import { afterAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LOCALES } from './manifest/index.ts';
import { fakeJpeg, fakeWebp, LISTING, manifest } from './manifest/fixtures.ts';
import {
	economyCheck,
	economyPull,
	economyPush,
	ECONOMY_FILE,
	ECONOMY_LOCK,
	pack,
	upload
} from './index.ts';

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

describe('economy as code', () => {
	it('pulls with a lock, pushes with it, and surfaces a stale push as an error', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'oc-econ-'));
		const sent: { method: string; path: string; body?: unknown }[] = [];
		let stale = false;
		const fakeFetch = (async (url: URL, init: RequestInit) => {
			sent.push({
				method: init.method!,
				path: url.pathname,
				body: init.body ? JSON.parse(String(init.body)) : undefined
			});
			if (init.method === 'GET')
				return Response.json({ live: { version: 3, doc: { v: 1, defaults: false } }, draft: null });
			if (init.method === 'PUT')
				return stale
					? Response.json({ error: 'stale_base' }, { status: 409 })
					: Response.json({ state: 'draft', updatedAt: 99, basedOn: 3 });
			return Response.json({
				ok: false,
				issues: [{ path: 'rules.0.id', message: 'duplicate id' }]
			});
		}) as unknown as typeof fetch;
		const api = { url: 'http://x', token: 'tok', fetch: fakeFetch };
		expect(await economyPull(api, 'g1', dir)).toEqual({ from: 'live' });
		expect(JSON.parse(await readFile(join(dir, ECONOMY_FILE), 'utf8'))).toEqual({
			v: 1,
			defaults: false
		});
		await economyPush(api, 'g1', dir);
		expect(sent.at(-1)).toEqual({
			method: 'PUT',
			path: '/api/dev/games/g1/economy',
			body: { doc: { v: 1, defaults: false }, base: 3, draftAt: null }
		});
		expect(JSON.parse(await readFile(join(dir, ECONOMY_LOCK), 'utf8'))).toEqual({
			base: 3,
			draftAt: 99
		});
		const check = await economyCheck(api, 'g1', dir, 'validate');
		expect(check).toEqual({ ok: false, issues: [{ path: 'rules.0.id', message: 'duplicate id' }] });
		stale = true;
		await expect(economyPush(api, 'g1', dir)).rejects.toThrow(/409 stale_base/);
	});
});
