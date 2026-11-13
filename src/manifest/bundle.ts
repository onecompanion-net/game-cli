/**
 * Bundle validation (docs/marketplace-plan.md, section 4.5): every check that is cheap and deterministic. The CLI
 * runs it on the packed directory before upload; the web app runs it again at finalise against the stored files.
 * Static analysis of the JavaScript is deliberately not attempted: the sandbox is what contains the code.
 */
import { icuArgs, IcuError, parseIcu } from './icu.ts';
import {
	CONTENT_TYPES,
	extOf,
	gzipSize,
	imageSize,
	isSafePath,
	magicMatches,
	resolveRelative,
	staticImports
} from './files.ts';
import {
	LIMITS,
	ListingSchema,
	LOCALES,
	parseManifest,
	roomKind,
	type Issue,
	type Manifest,
	type RoomKind
} from './schema.ts';

export interface BundleFile {
	/** Path inside the bundle, e.g. `client/index.js`. */
	path: string;
	bytes: number;
	sha256: string;
}

export interface BundleContext {
	/** The uploaded file list (paths, sizes, hashes). Source files (`source/...`) are allowed and never served. */
	files: readonly BundleFile[];
	/** Read one listed file's bytes. */
	read(path: string): Promise<Uint8Array>;
	/** Room kinds this studio may use (staff set it per studio). */
	allowedKinds?: readonly RoomKind[];
}

export interface BundleReport {
	ok: boolean;
	issues: Issue[];
	manifest: Manifest | null;
	clientGzipBytes: number;
	totalBytes: number;
	/** Listing texts by locale (when they parsed). */
	listing: Record<string, unknown>;
}

/** Media sizes the catalog uses (section 2.1). */
export const MEDIA = {
	cover: { width: 1280, height: 720, ext: 'webp' },
	still: { width: 1280, height: 720, ext: 'webp' },
	thumb: { width: 320, height: 180, ext: 'webp' },
	share: { width: 1200, height: 630, ext: 'jpg' }
} as const;

/** `media/still-1.webp` → `media/still-1-thumb.webp`. */
export const thumbOf = (still: string) => still.replace(/\.webp$/, '-thumb.webp');

export async function validateBundle(
	manifestJson: unknown,
	ctx: BundleContext
): Promise<BundleReport> {
	const issues: Issue[] = [];
	const add = (path: string, message: string) => issues.push({ path, message });
	const report = (manifest: Manifest | null, clientGzipBytes = 0): BundleReport => ({
		ok: issues.length === 0,
		issues,
		manifest,
		clientGzipBytes,
		totalBytes,
		listing
	});
	const listing: Record<string, unknown> = {};
	const byPath = new Map(ctx.files.map((f) => [f.path, f]));
	const totalBytes = ctx.files.reduce((n, f) => n + f.bytes, 0);

	// 1. Manifest.
	const parsed = parseManifest(manifestJson, 'bundle');
	if (!parsed.ok) {
		issues.push(...parsed.issues.map((i) => ({ path: `game.json:${i.path}`, message: i.message })));
		return report(null);
	}
	const m = parsed.manifest;
	const kind = roomKind(m);
	if (ctx.allowedKinds && !ctx.allowedKinds.includes(kind))
		add('game.json:realtime.kind', `"${kind}" is not enabled for this studio`);

	// 2. Files: safe paths, allowed types, sizes, first bytes.
	if (ctx.files.length > LIMITS.maxFiles) add('files', `at most ${LIMITS.maxFiles} files`);
	if (totalBytes > LIMITS.bundleBytes)
		add('files', `bundle is ${mb(totalBytes)}, the limit is ${mb(LIMITS.bundleBytes)}`);
	for (const f of ctx.files) {
		if (!isSafePath(f.path)) {
			add(f.path, 'unsafe path');
			continue;
		}
		if (f.bytes > LIMITS.fileBytes)
			add(f.path, `file is ${mb(f.bytes)}, the limit is ${mb(LIMITS.fileBytes)}`);
		if (f.path.startsWith('source/')) continue;
		const ext = extOf(f.path);
		if (!CONTENT_TYPES[ext]) {
			add(f.path, `.${ext || '(none)'} files are not allowed`);
			continue;
		}
		if (f.path === 'game.json') continue;
		const head = (await ctx.read(f.path)).subarray(0, 4096);
		if (!magicMatches(ext, head)) add(f.path, `content does not look like .${ext}`);
	}
	const need = (path: string, why: string) => {
		if (!byPath.has(path)) add(path, `missing (${why})`);
		return byPath.has(path);
	};
	need('game.json', 'manifest');

	// 3. Budgets: the client entry and everything it imports statically, gzipped; the server module.
	let clientGzipBytes = 0;
	if (need(m.entry.client, 'entry.client')) {
		const seen = new Set<string>();
		const queue = [m.entry.client];
		while (queue.length) {
			const path = queue.shift()!;
			if (seen.has(path)) continue;
			seen.add(path);
			if (!byPath.has(path)) {
				add(path, `imported by the client entry but not in the bundle`);
				continue;
			}
			const code = await ctx.read(path);
			clientGzipBytes += await gzipSize(code);
			for (const spec of staticImports(new TextDecoder().decode(code))) {
				const target = resolveRelative(path, spec);
				if (target === null)
					add(path, `imports "${spec}": only relative imports inside the bundle work`);
				else if (extOf(target) === 'js') queue.push(target);
			}
		}
		const kb = clientGzipBytes / 1024;
		if (kb > m.budgets.clientGzipKB)
			add(
				m.entry.client,
				`client entry is ${kb.toFixed(0)} KB gzip, over its budget of ${m.budgets.clientGzipKB} KB`
			);
	}
	if (kind === 'server' && need('server.js', 'entry.server')) {
		const f = byPath.get('server.js')!;
		if (f.bytes > LIMITS.serverBytes)
			add('server.js', `server.js is ${mb(f.bytes)}, the limit is ${mb(LIMITS.serverBytes)}`);
		const code = new TextDecoder().decode(await ctx.read('server.js'));
		if (staticImports(code).length > 0)
			add('server.js', 'must be one self-contained module with no imports');
		if (/\bimport\s*\(/.test(code)) add('server.js', 'must not use dynamic import()');
		if (
			!/export\s*(?:function\s+createGameModule|\{[^}]*\bcreateGameModule\b[^}]*\}|const\s+createGameModule)/.test(
				code
			)
		)
			add('server.js', 'must export createGameModule');
	} else if (byPath.has('server.js') && kind !== 'server')
		add('server.js', 'present but realtime.kind is not "server"');

	// 4. In-game messages: en present, same keys and arguments in every declared locale, valid ICU, no markup.
	const tables: Record<string, Record<string, string>> = {};
	for (const loc of m.locales) {
		const path = `${m.messages}/${loc}.json`;
		if (!need(path, `messages for ${loc}`)) continue;
		const json = await readJson(ctx, path, add);
		if (!json || typeof json !== 'object' || Array.isArray(json)) {
			if (json !== undefined) add(path, 'must be an object of key → message');
			continue;
		}
		const table: Record<string, string> = {};
		for (const [k, v] of Object.entries(json as Record<string, unknown>)) {
			if (k === '$schema') continue;
			if (!/^[a-z][a-z0-9_]{0,63}$/.test(k))
				add(path, `key "${k}": lowercase letters, digits and _ only`);
			if (typeof v !== 'string') add(path, `${k}: must be a string`);
			else table[k] = v;
		}
		tables[loc] = table;
	}
	const en = tables.en;
	if (en) {
		const enArgs = new Map<string, string>();
		for (const [k, v] of Object.entries(en)) {
			try {
				enArgs.set(k, icuArgs(parseIcu(v)).join(','));
			} catch (e) {
				add(
					`${m.messages}/en.json`,
					`${k}: ${e instanceof IcuError ? e.message : 'invalid message'}`
				);
			}
		}
		for (const [loc, table] of Object.entries(tables)) {
			if (loc === 'en') continue;
			const path = `${m.messages}/${loc}.json`;
			for (const k of Object.keys(en)) if (!(k in table)) add(path, `missing key ${k}`);
			for (const [k, v] of Object.entries(table)) {
				if (!(k in en)) {
					add(path, `key ${k} is not in en.json`);
					continue;
				}
				try {
					const args = icuArgs(parseIcu(v)).join(',');
					if (enArgs.has(k) && args !== enArgs.get(k))
						add(path, `${k}: arguments {${args}} differ from en {${enArgs.get(k)}}`);
				} catch (e) {
					add(path, `${k}: ${e instanceof IcuError ? e.message : 'invalid message'}`);
				}
			}
		}
	}

	// 5. Listing: all 12 platform locales (decision D3), within length limits.
	for (const loc of LOCALES) {
		const path = `${m.listing}/${loc}.json`;
		if (!need(path, `listing text for ${loc}`)) continue;
		const json = await readJson(ctx, path, add);
		if (json === undefined) continue;
		const r = ListingSchema.safeParse(json);
		if (!r.success)
			for (const i of r.error.issues) add(path, `${i.path.join('.') || 'listing'}: ${i.message}`);
		else if (
			Object.values(r.data)
				.flat()
				.some((s) => /[<>]/.test(s))
		)
			add(path, 'markup is not allowed');
		else listing[loc] = r.data;
	}

	// 6. Media: formats and exact sizes from the image headers.
	const image = async (
		path: string,
		spec: { width: number; height: number; ext: string },
		what: string
	) => {
		if (extOf(path) !== spec.ext) return add(path, `${what} must be .${spec.ext}`);
		if (!need(path, what)) return;
		const size = imageSize(spec.ext, await ctx.read(path));
		if (!size) add(path, `${what}: unreadable image header`);
		else if (size.width !== spec.width || size.height !== spec.height)
			add(path, `${what} is ${size.width}×${size.height}, must be ${spec.width}×${spec.height}`);
	};
	await image(m.media.cover, MEDIA.cover, 'cover');
	for (const s of m.media.stills) {
		await image(s, MEDIA.still, 'still');
		await image(thumbOf(s), MEDIA.thumb, 'still thumbnail');
	}
	if (m.media.share) await image(m.media.share, MEDIA.share, 'share image');

	return report(m, clientGzipBytes);
}

async function readJson(
	ctx: BundleContext,
	path: string,
	add: (p: string, m: string) => void
): Promise<unknown> {
	try {
		return JSON.parse(new TextDecoder().decode(await ctx.read(path)));
	} catch {
		add(path, 'not valid JSON');
		return undefined;
	}
}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
