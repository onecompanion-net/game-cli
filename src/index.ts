/**
 * The game CLI's library (docs/marketplace-plan.md, sections 2.5 and 4.5): build a game package's JS/TS source into
 * an upload bundle, validate it, and upload it. Bun only (it runs on the developer's machine and in CI).
 *
 * Bundle layout (what the platform stores and serves):
 *
 *   game.json                bundle manifest: entries point at built files
 *   files.json               path, bytes and SHA-256 of every file
 *   client/                  the built client: ES modules (entry + split chunks) and its static files
 *   server.js                the built server module, one file with no imports (realtime.kind "server")
 *   messages/<locale>.json   in-game text
 *   listing/<locale>.json    catalog text: the 12 launch locales required, the platform's others optional
 *   media/                   cover.webp, still-N.webp + still-N-thumb.webp, share.jpg
 *   source/                  the source the bundle was built from (for review; never served)
 */
import { mkdir, readdir, readFile, rm, stat, writeFile, copyFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import {
	extOf,
	parseManifest,
	roomKind,
	sha256Hex,
	thumbOf,
	validateBundle,
	type BundleFile,
	type BundleReport,
	type Issue,
	type Manifest,
	type ValidateOptions
} from './manifest/index.ts';

type BodyInit_ = NonNullable<RequestInit['body']>;

export class CliError extends Error {
	constructor(
		message: string,
		readonly issues: Issue[] = []
	) {
		super(message);
	}
}

export async function readSourceManifest(
	dir: string
): Promise<{ manifest: Manifest; raw: Record<string, unknown> }> {
	let raw: Record<string, unknown>;
	try {
		raw = JSON.parse(await readFile(join(dir, 'game.json'), 'utf8'));
	} catch {
		throw new CliError(`no readable game.json in ${dir}`);
	}
	const parsed = parseManifest(raw, 'source');
	if (!parsed.ok) throw new CliError('game.json is not valid', parsed.issues);
	return { manifest: parsed.manifest, raw };
}

async function walk(dir: string, skip: (rel: string) => boolean, root = dir): Promise<string[]> {
	const out: string[] = [];
	for (const e of await readdir(dir, { withFileTypes: true })) {
		const abs = join(dir, e.name);
		const rel = relative(root, abs).split(sep).join('/');
		if (skip(rel)) continue;
		if (e.isDirectory()) out.push(...(await walk(abs, skip, root)));
		else if (e.isFile()) out.push(rel);
	}
	return out;
}

const SOURCE_SKIP = /(^|\/)(node_modules|dist|bundle|\.[^/]+)(\/|$)|\.test\.[jt]sx?$/;

export interface PackResult {
	out: string;
	files: BundleFile[];
	manifest: Record<string, unknown>;
	report: BundleReport;
}

/**
 * Build and lay out the bundle in `out` (default `<dir>/bundle`), then validate it. `allowUntranslated` lists text
 * files still marked untranslated in the report instead of failing (`validate`; uploads always refuse them).
 */
export async function pack(
	dir: string,
	out = join(dir, 'bundle'),
	opts: ValidateOptions = {}
): Promise<PackResult> {
	dir = resolve(dir);
	out = resolve(out);
	const { manifest: m, raw } = await readSourceManifest(dir);
	await rm(out, { recursive: true, force: true });
	await mkdir(join(out, 'client'), { recursive: true });

	// Client: ES modules, split so dynamic imports stay lazy chunks; the entry is client/index.js.
	const client = await Bun.build({
		entrypoints: [join(dir, m.entry.client)],
		outdir: join(out, 'client'),
		target: 'browser',
		format: 'esm',
		splitting: true,
		minify: true,
		naming: { entry: 'index.[ext]', chunk: 'chunk-[hash].[ext]', asset: 'asset-[hash].[ext]' },
		define: { 'import.meta.env.DEV': 'false', 'process.env.NODE_ENV': '"production"' }
	});
	if (!client.success)
		throw new CliError(`client build failed:\n${client.logs.map(String).join('\n')}`);

	// Server: one self-contained module (no imports) that exports createGameModule.
	const kind = roomKind(m);
	if (kind === 'server') {
		if (!m.entry.server) throw new CliError('realtime.kind "server" needs entry.server');
		const server = await Bun.build({
			entrypoints: [join(dir, m.entry.server)],
			target: 'browser',
			format: 'esm',
			splitting: false,
			minify: true
		});
		if (!server.success || server.outputs.length !== 1)
			throw new CliError(`server build failed:\n${server.logs.map(String).join('\n')}`);
		await writeFile(join(out, 'server.js'), await server.outputs[0]!.text());
	}

	// Text and media, renamed into the bundle layout.
	const copy = async (from: string, to: string) => {
		await mkdir(dirname(join(out, to)), { recursive: true });
		await copyFile(join(dir, from), join(out, to));
	};
	for (const f of await readdir(join(dir, m.messages)))
		if (f.endsWith('.json')) await copy(join(m.messages, f), `messages/${f}`);
	if (m.listing)
		for (const f of await readdir(join(dir, m.listing)))
			if (f.endsWith('.json')) await copy(join(m.listing, f), `listing/${f}`);
	await copy(m.media.cover, `media/cover.${extOf(m.media.cover)}`);
	const stills: string[] = [];
	for (const [i, s] of m.media.stills.entries()) {
		const name = `media/still-${i + 1}.${extOf(s)}`;
		await copy(s, name);
		await copy(thumbOf(s), thumbOf(name)).catch(() => {
			throw new CliError(`missing thumbnail ${thumbOf(s)} (320×180 webp next to each still)`);
		});
		stills.push(name);
	}
	if (m.media.share) await copy(m.media.share, `media/share.${extOf(m.media.share)}`);

	// Source for review: everything but dependencies, build output, dotfiles and tests.
	for (const f of await walk(dir, (rel) => SOURCE_SKIP.test(rel) || rel === relative(dir, out)))
		if (/\.(ts|tsx|js|mjs|json|css|glsl|md)$/.test(f)) await copy(f, `source/${f}`);

	const bundleManifest = {
		...raw,
		entry: { client: 'client/index.js', ...(kind === 'server' ? { server: 'server.js' } : {}) },
		messages: 'messages',
		...(m.listing ? { listing: 'listing' } : {}),
		media: {
			cover: `media/cover.${extOf(m.media.cover)}`,
			stills,
			...(m.media.share ? { share: `media/share.${extOf(m.media.share)}` } : {})
		}
	};
	await writeFile(join(out, 'game.json'), `${JSON.stringify(bundleManifest, null, '\t')}\n`);

	const files = await listFiles(out);
	await writeFile(join(out, 'files.json'), `${JSON.stringify(files, null, '\t')}\n`);
	const report = await validateDir(out, bundleManifest, files, opts);
	return { out, files, manifest: bundleManifest, report };
}

export async function listFiles(out: string): Promise<BundleFile[]> {
	const paths = (await walk(out, (rel) => rel === 'files.json')).sort();
	return Promise.all(
		paths.map(async (path) => {
			const b = new Uint8Array(await readFile(join(out, path)));
			return { path, bytes: b.byteLength, sha256: await sha256Hex(b) };
		})
	);
}

export async function validateDir(
	out: string,
	manifest?: Record<string, unknown>,
	files?: BundleFile[],
	opts: ValidateOptions = {}
): Promise<BundleReport> {
	manifest ??= JSON.parse(await readFile(join(out, 'game.json'), 'utf8')) as Record<
		string,
		unknown
	>;
	files ??= await listFiles(out);
	return validateBundle(
		manifest,
		{ files, read: async (p) => new Uint8Array(await readFile(join(out, p))) },
		opts
	);
}

/* --------------------------------- upload --------------------------------- */

export interface Api {
	url: string;
	token: string;
	fetch?: typeof fetch;
}

async function call<T>(
	api: Api,
	method: string,
	path: string,
	body?: string | Uint8Array,
	type?: string
): Promise<T> {
	const res = await (api.fetch ?? fetch)(new URL(path, api.url), {
		method,
		headers: {
			authorization: `Bearer ${api.token}`,
			// Always typed: SvelteKit's CSRF check rejects an untyped POST that carries no Origin.
			'content-type': type ?? 'application/json'
		},
		...(body !== undefined ? { body: body as BodyInit_ } : {})
	});
	const text = await res.text();
	let json: T & { error?: string; issues?: Issue[] };
	try {
		json = text ? JSON.parse(text) : ({} as T);
	} catch {
		throw new CliError(`${method} ${path}: ${res.status} ${text.slice(0, 200)}`);
	}
	if (!res.ok) {
		const j = json as { error?: string; issues?: Issue[] };
		throw new CliError(
			`${method} ${path}: ${res.status} ${j.error ?? res.statusText}`,
			j.issues ?? []
		);
	}
	return json;
}

export interface Published {
	versionId: string;
	state: string;
	issues: Issue[];
}

/** Upload a packed bundle: create the version, send each file, finalise. Never unpacks archives server-side. */
export async function upload(
	api: Api,
	out: string,
	log: (s: string) => void = () => {}
): Promise<Published> {
	const manifest = JSON.parse(await readFile(join(out, 'game.json'), 'utf8')) as {
		id: string;
		version: string;
	};
	const files = JSON.parse(await readFile(join(out, 'files.json'), 'utf8')) as BundleFile[];
	const { versionId } = await call<{ versionId: string }>(
		api,
		'POST',
		`/api/dev/games/${manifest.id}/versions`,
		JSON.stringify({ manifest, files }),
		'application/json'
	);
	log(`version ${manifest.version} → ${versionId}`);
	let sent = 0;
	for (const f of files) {
		const body = await readFile(join(out, f.path));
		await call(
			api,
			'PUT',
			`/api/dev/versions/${versionId}/files?path=${encodeURIComponent(f.path)}`,
			body,
			'application/octet-stream'
		);
		sent += f.bytes;
		log(`  ${f.path} (${f.bytes} B)`);
	}
	log(`uploaded ${files.length} files, ${(sent / 1024).toFixed(0)} KB`);
	const fin = await call<{ state: string; issues?: Issue[] }>(
		api,
		'POST',
		`/api/dev/versions/${versionId}/finalise`
	);
	return { versionId, state: fin.state, issues: fin.issues ?? [] };
}

/** Release an approved version (studios choose their release time). */
export async function release(api: Api, versionId: string): Promise<{ state: string }> {
	return call(api, 'POST', `/api/dev/versions/${versionId}/publish`);
}

export async function versionStatus(api: Api, versionId: string): Promise<Record<string, unknown>> {
	return call(api, 'GET', `/api/dev/versions/${versionId}`);
}

export const exists = (p: string) =>
	stat(p).then(
		() => true,
		() => false
	);

/* --------------------------------- economy -------------------------------- */

/**
 * Scoring and economy as code (docs/economy-plan.md, section 6): `economy.json` next to game.json holds the
 * ruleset, and `economy.lock.json` the versions it was pulled at, so a push over a newer draft or publish is
 * refused instead of overwriting the console. Pushing makes a draft; an owner publishes it on /developers.
 */
export const ECONOMY_FILE = 'economy.json';
export const ECONOMY_LOCK = 'economy.lock.json';

export interface EconomyLock {
	/** The live version the file was based on (null: none published). */
	base: number | null;
	/** The draft's updatedAt when pulled or last pushed (null: no draft). */
	draftAt: number | null;
}

interface EconomyRemote {
	live: { version: number; doc: unknown } | null;
	draft: {
		state: string;
		basedOn: number | null;
		updatedAt: number;
		reviewNote: string | null;
		doc: unknown;
	} | null;
}

/** Write the draft (or else the live ruleset) and its lock into `dir`. */
export async function economyPull(
	api: Api,
	gameId: string,
	dir: string
): Promise<{ from: 'draft' | 'live' | 'none'; state?: string; reviewNote?: string | null }> {
	const r = await call<EconomyRemote>(api, 'GET', `/api/dev/games/${gameId}/economy`);
	const doc = r.draft?.doc ?? r.live?.doc ?? { v: 1 };
	const lock: EconomyLock = { base: r.live?.version ?? null, draftAt: r.draft?.updatedAt ?? null };
	await writeFile(join(dir, ECONOMY_FILE), `${JSON.stringify(doc, null, 2)}\n`);
	await writeFile(join(dir, ECONOMY_LOCK), `${JSON.stringify(lock, null, 2)}\n`);
	return r.draft
		? { from: 'draft', state: r.draft.state, reviewNote: r.draft.reviewNote }
		: { from: r.live ? 'live' : 'none' };
}

async function readEconomy(dir: string): Promise<{ doc: unknown; lock: EconomyLock }> {
	const path = join(dir, ECONOMY_FILE);
	if (!(await exists(path)))
		throw new CliError(`no ${ECONOMY_FILE} in ${dir}: run "economy pull" first`);
	let doc: unknown;
	try {
		doc = JSON.parse(await readFile(path, 'utf8'));
	} catch {
		throw new CliError(`${ECONOMY_FILE} is not valid JSON`);
	}
	const lockPath = join(dir, ECONOMY_LOCK);
	const lock = (await exists(lockPath))
		? (JSON.parse(await readFile(lockPath, 'utf8')) as EconomyLock)
		: { base: null, draftAt: null };
	return { doc, lock };
}

/** Check `economy.json` with the server's schema (the same one the console uses). */
export async function economyCheck(
	api: Api,
	gameId: string,
	dir: string,
	action: 'validate' | 'simulate'
): Promise<{ ok: boolean; issues: Issue[]; simulation?: Record<string, unknown> }> {
	const { doc } = await readEconomy(dir);
	const r = await call<{ ok: boolean; issues?: Issue[]; simulation?: Record<string, unknown> }>(
		api,
		'POST',
		`/api/dev/games/${gameId}/economy/${action}`,
		JSON.stringify({ doc })
	);
	return {
		ok: r.ok,
		issues: r.issues ?? [],
		...(r.simulation ? { simulation: r.simulation } : {})
	};
}

/** Save `economy.json` as the game's draft; refused (409) when the console moved on since the last pull. */
export async function economyPush(
	api: Api,
	gameId: string,
	dir: string
): Promise<{ updatedAt: number }> {
	const { doc, lock } = await readEconomy(dir);
	const r = await call<{ updatedAt: number; basedOn: number | null }>(
		api,
		'PUT',
		`/api/dev/games/${gameId}/economy`,
		JSON.stringify({ doc, base: lock.base, draftAt: lock.draftAt })
	);
	await writeFile(
		join(dir, ECONOMY_LOCK),
		`${JSON.stringify({ base: lock.base, draftAt: r.updatedAt }, null, 2)}\n`
	);
	return r;
}

/* --------------------------------- assets --------------------------------- */

const ASSET_EXTS = new Set([
	'png',
	'jpg',
	'jpeg',
	'webp',
	'avif',
	'glb',
	'ktx2',
	'ogg',
	'mp3',
	'woff2',
	'json'
]);

/**
 * Upload a folder into the game's asset library draft (docs/economy-plan.md, section 6c): every allowed file, at its
 * path relative to `folder` (under `prefix`). Files the library already has are stored once. Publishing the release is
 * an owner's click on /developers.
 */
export async function assetsPush(
	api: Api,
	gameId: string,
	folder: string,
	opts: { prefix?: string; licence: string; credit?: string },
	log: (line: string) => void = () => {}
): Promise<{ uploaded: number; skipped: string[] }> {
	const files: string[] = [];
	const walk = async (d: string) => {
		for (const e of await readdir(d, { withFileTypes: true })) {
			if (e.name.startsWith('.')) continue;
			const p = join(d, e.name);
			if (e.isDirectory()) await walk(p);
			else files.push(p);
		}
	};
	await walk(folder);
	const skipped: string[] = [];
	let uploaded = 0;
	for (const f of files.sort()) {
		const rel = relative(folder, f).split(sep).join('/');
		const ext = rel.split('.').pop()?.toLowerCase() ?? '';
		if (!ASSET_EXTS.has(ext)) {
			skipped.push(rel);
			continue;
		}
		const path = opts.prefix ? `${opts.prefix.replace(/\/+$/, '')}/${rel}` : rel;
		const q = new URLSearchParams({
			path,
			licence: opts.licence,
			...(opts.credit ? { credit: opts.credit } : {})
		});
		await call(
			api,
			'PUT',
			`/api/dev/games/${gameId}/assets?${q}`,
			await readFile(f),
			'application/octet-stream'
		);
		log(`  + ${path}`);
		uploaded++;
	}
	return { uploaded, skipped };
}

export async function assetsStatus(api: Api, gameId: string): Promise<Record<string, unknown>> {
	return call(api, 'GET', `/api/dev/games/${gameId}/assets`);
}
