/**
 * Starting points and translation help (no network, no cost to anyone):
 *
 * - `init`: a new game from a template (solo, relay, lockstep, verified-solo or persistent-rpg) that passes
 *   `validate` as generated.
 * - `i18n`: writes the missing listing and in-game text files as copies of English marked `$untranslated`, and
 *   prints a prompt for the studio's own AI tool to translate them. Uploads refuse marked files, so nothing
 *   untranslated ever reaches players.
 */
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
	LIMITS,
	LISTING_LOCALES,
	LOCALES,
	UNTRANSLATED,
	type Locale
} from './manifest/index.ts';
import { CliError, exists, readSourceManifest } from './index.ts';

export const TEMPLATES = ['solo', 'relay', 'lockstep', 'verified-solo', 'persistent-rpg'] as const;
export type Template = (typeof TEMPLATES)[number];

const TEMPLATE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'templates');
const ID = /^[a-z][a-z0-9-]{2,31}$/;
const STUDIO = /^[a-z][a-z0-9-]{1,31}$/;
const TEXT_FILE = /\.(ts|json|html|md)$|(^|\/)gitignore$/;

export interface InitOptions {
	template: Template;
	id?: string;
	studio?: string;
	title?: string;
}

export interface InitResult {
	dir: string;
	files: string[];
	i18n: I18nResult;
}

/** What each template declares in game.json. */
const KIND: Record<
	Template,
	{ modes: string[]; players: { min: number; max: number }; realtime?: object }
> = {
	solo: { modes: ['solo'], players: { min: 1, max: 1 } },
	relay: {
		modes: ['solo', 'coop'],
		players: { min: 1, max: 8 },
		realtime: { kind: 'relay', tickRate: 0, snapshotRate: 0, protocol: 1 }
	},
	lockstep: {
		modes: ['solo', 'coop'],
		players: { min: 1, max: 4 },
		// tickRate is the step rate: keep it equal to STEP_RATE in src/sim.ts. snapshotRate is how often the room
		// sends ticks (0 would mean one a second: play would move in jerks).
		realtime: { kind: 'lockstep', tickRate: 15, snapshotRate: 15, protocol: 1 }
	},
	// A solo game made ranked by a tiny server module that replays each run (economy plan, section 6b).
	'verified-solo': {
		modes: ['solo', 'trial'],
		players: { min: 1, max: 1 },
		realtime: { kind: 'server', tickRate: 1, snapshotRate: 1, protocol: 1 }
	},
	// Level 5 (economy plan, section 6d): characters, loot and trades. Needs the studio's `server` and
	// `persistent` permissions, granted by OneCompanion staff.
	'persistent-rpg': {
		modes: ['coop'],
		players: { min: 1, max: 4 },
		realtime: { kind: 'server', tickRate: 10, snapshotRate: 10, protocol: 1 }
	}
};

const MODE_CARDS: Record<Template, Record<string, string>> = {
	solo: { solo: 'Catch as many sparks as you can in thirty seconds.' },
	relay: {
		solo: 'Try the controls on your own.',
		coop: 'Share the screen with friends: everyone moves a light.'
	},
	lockstep: {
		solo: 'Collect beacons with your own unit.',
		coop: 'Each player commands their own unit. Who collects the most?'
	},
	'verified-solo': {
		solo: 'Practise the run as often as you like.',
		trial: 'A timed run, checked by the server: the fastest verified times top the board.'
	},
	'persistent-rpg': { coop: 'Clear the crypt with friends, keep your loot, trade what you find.' }
};

/** Write a new game into `dir` (which must not exist or be empty). */
export async function init(dir: string, o: InitOptions): Promise<InitResult> {
	if (!TEMPLATES.includes(o.template))
		throw new CliError(`unknown template "${o.template}": use ${TEMPLATES.join(', ')}`);
	dir = resolve(dir);
	if ((await exists(dir)) && (await readdir(dir)).length)
		throw new CliError(`${dir} is not empty: init writes a new game into an empty folder`);
	const id = o.id ?? slug(basename(dir));
	if (!ID.test(id))
		throw new CliError(
			`game id "${id}": lowercase letters, digits and dashes, 3-32 characters, starting with a letter (--id)`
		);
	const studio = o.studio ?? 'your-studio';
	if (!STUDIO.test(studio)) throw new CliError(`studio handle "${studio}" is not valid (--studio)`);
	const title = (o.title ?? titleOf(id)).trim().slice(0, 40);
	const fill = (s: string) =>
		s.replaceAll('{{title}}', title).replaceAll('{{id}}', id).replaceAll('{{studio}}', studio);

	const files: string[] = [];
	const put = async (rel: string, data: string | Uint8Array) => {
		await mkdir(dirname(join(dir, rel)), { recursive: true });
		await writeFile(join(dir, rel), data);
		if (!files.includes(rel)) files.push(rel);
	};
	// The base, then the template's own files on top.
	for (const layer of ['base', o.template]) {
		const from = join(TEMPLATE_DIR, layer);
		for (const rel of await walkFiles(from)) {
			const out = rel === 'gitignore' ? '.gitignore' : rel;
			const bytes = await readFile(join(from, rel));
			await put(out, TEXT_FILE.test(rel) ? fill(bytes.toString('utf8')) : bytes);
		}
	}

	const k = KIND[o.template];
	const manifest = {
		$comment:
			'The id is your game URL and can never be reused: choose it before the first upload. Guide: https://onecompanion.net/developers/guide',
		manifest: 1,
		id,
		title,
		version: '0.1.0',
		studio,
		genres: ['action'],
		players: k.players,
		modes: k.modes,
		entry: {
			client: './src/client.ts',
			...(o.template === 'persistent-rpg' || o.template === 'verified-solo'
				? { server: './src/server.ts' }
				: {})
		},
		...(k.realtime ? { realtime: k.realtime } : {}),
		...(o.template === 'verified-solo'
			? { economy: { preset: 'solo', stats: ['duration_ms'], milestones: ['g_full_run'] } }
			: {}),
		...(o.template === 'persistent-rpg'
			? {
					economy: {
						preset: 'coop',
						persistent: {
							slots: 3,
							character: { kills: 'int' },
							locations: ['bag', 'stash'],
							bag_capacity: 60,
							stash_capacity: 120,
							hardcore: true,
							modes: ['coop']
						}
					}
				}
			: {}),
		locales: ['en'],
		messages: './messages',
		listing: './listing',
		media: {
			cover: './art/cover.webp',
			stills: ['./art/still-a.webp', './art/still-b.webp', './art/still-c.webp'],
			share: './art/share.jpg'
		},
		budgets: { clientGzipKB: 200 },
		capabilities: {
			pointerLock: false,
			fullscreen: false,
			gamepad: false,
			audio: false,
			network: []
		},
		rating: { level: 'everyone', descriptors: [] },
		rights: { ownsAllContent: true, thirdParty: [] }
	};
	await put('game.json', json(manifest));
	await put(
		'listing/en.json',
		json({
			tagline: `${title}: replace this with one line that sells the game.`,
			pitch: 'Two sentences on what players do and why it is fun.',
			about: [
				'How to play, in a short paragraph.',
				'What makes it worth coming back to (up to four paragraphs).'
			],
			seoTitle: `${title}: play free in your browser`.slice(0, LIMITS.text.seoTitle),
			seoDescription: `Play ${title} free in your browser on OneCompanion.`.slice(
				0,
				LIMITS.text.seoDescription
			),
			coverAlt: `The ${title} cover`.slice(0, LIMITS.text.coverAlt),
			play: 'Play now',
			modes: MODE_CARDS[o.template]
		})
	);
	await put(
		'package.json',
		json({
			name: id,
			version: '0.1.0',
			private: true,
			type: 'module',
			scripts: {
				dev: 'bun --port 5191 ./index.html',
				check: 'tsc -p .',
				test: 'bun test',
				validate: 'onecompanion-game validate .',
				i18n: 'onecompanion-game i18n .',
				'publish:game': 'onecompanion-game publish .'
			},
			devDependencies: {
				'@onecompanion/game-cli': 'github:onecompanion-net/game-cli',
				'@types/bun': '^1.4.4',
				typescript: '^6.0.3'
			}
		})
	);
	await put('README.md', readme(title, o.template));

	// Listing stubs for the required locales, so `validate` passes from the first run.
	const i18nResult = await i18n(dir);
	return { dir, files: [...files, ...i18nResult.created].sort(), i18n: i18nResult };
}

/* ---------------------------------- i18n ---------------------------------- */

export interface I18nOptions {
	/**
	 * Locales to add. `undefined`: the listing's required locales plus every locale game.json declares. `all`: every
	 * platform locale, in-game text included (added to game.json `locales`). A list: those, in-game text included.
	 */
	locales?: 'all' | readonly string[];
}

export interface I18nResult {
	/** Files written (new stubs, or existing files that gained English copies of new keys). */
	created: string[];
	/** Every text file still marked untranslated, with the keys to translate (`null`: the whole file). */
	untranslated: { path: string; locale: Locale; keys: string[] | null }[];
	/** A prompt for the studio's AI tool, or `null` when nothing is left to translate. */
	prompt: string | null;
}

/**
 * Bring the game's text files up to date with English. Never overwrites a translation: missing files become marked
 * copies of en, and existing files only gain the keys en has and they lack (marked with those keys).
 */
export async function i18n(dir: string, o: I18nOptions = {}): Promise<I18nResult> {
	dir = resolve(dir);
	const { manifest: m, raw } = await readSourceManifest(dir);
	if (!m.listing)
		throw new CliError('game.json has no "listing" folder: add "listing": "./listing"');
	const extra: Locale[] =
		o.locales === 'all'
			? [...LOCALES]
			: (o.locales ?? []).map((l) => {
					if (!(LOCALES as readonly string[]).includes(l))
						throw new CliError(`unknown locale "${l}": use one of ${LOCALES.join(', ')}`);
					return l as Locale;
				});

	// New in-game locales go into game.json first, so the bundle checks them.
	const gameLocales = [...new Set<Locale>([...m.locales, ...extra])];
	if (gameLocales.length !== m.locales.length) {
		raw.locales = LOCALES.filter((l) => gameLocales.includes(l));
		await writeFile(join(dir, 'game.json'), json(raw));
	}
	const listingLocales = LOCALES.filter(
		(l) => (LISTING_LOCALES as readonly string[]).includes(l) || gameLocales.includes(l)
	);

	const created: string[] = [];
	const sync = async (folder: string, locales: readonly Locale[]) => {
		const en = await readJsonFile(join(dir, folder, 'en.json'));
		if (!en) throw new CliError(`${join(folder, 'en.json')} is missing: English is the source`);
		const english = withoutMarker(en);
		for (const loc of locales) {
			if (loc === 'en') continue;
			const path = join(dir, folder, `${loc}.json`);
			const have = await readJsonFile(path);
			if (!have) {
				await writeFile(path, json({ [UNTRANSLATED]: true, ...english }));
				created.push(rel(dir, path));
				continue;
			}
			// Keys en gained since this file was translated (top level: listing fields or message keys).
			const missing = Object.keys(english).filter((k) => !(k in have));
			if (!missing.length) continue;
			const marker = have[UNTRANSLATED];
			const keys =
				marker === true
					? true
					: [...new Set([...(Array.isArray(marker) ? (marker as string[]) : []), ...missing])];
			const next: Record<string, unknown> = { [UNTRANSLATED]: keys, ...withoutMarker(have) };
			for (const k of missing) next[k] = english[k];
			await writeFile(path, json(next));
			created.push(rel(dir, path));
		}
	};
	await sync(m.listing, listingLocales);
	await sync(m.messages, gameLocales);

	const untranslated: I18nResult['untranslated'] = [];
	for (const folder of [m.listing, m.messages]) {
		for (const loc of LOCALES) {
			if (loc === 'en') continue;
			const path = join(dir, folder, `${loc}.json`);
			const have = await readJsonFile(path);
			if (!have || !(UNTRANSLATED in have)) continue;
			const marker = have[UNTRANSLATED];
			untranslated.push({
				path: rel(dir, path),
				locale: loc,
				keys: Array.isArray(marker) ? (marker as string[]) : null
			});
		}
	}
	return { created, untranslated, prompt: untranslated.length ? prompt(untranslated) : null };
}

/** The prompt a studio pastes into its own AI tool (English: read by a coding tool, next to an English guide). */
export function prompt(files: I18nResult['untranslated']): string {
	const names = new Intl.DisplayNames(['en'], { type: 'language' });
	const list = files
		.map(
			(f) =>
				`- ${f.path}: ${names.of(f.locale) ?? f.locale} (${f.locale})${f.keys ? `, only the keys ${f.keys.join(', ')}` : ''}`
		)
		.join('\n');
	const t = LIMITS.text;
	return `Translate my game's text for OneCompanion. Each file below is a copy of English marked with "${UNTRANSLATED}". Translate it into the language named, from the English file next to it (en.json), and write natural text a player of that language would expect, not a word-for-word translation.

${list}

Rules:
- Keep every key exactly as it is. Translate only the values.
- In-game messages (messages/) use ICU syntax: keep {placeholders} unchanged, and keep plural and select blocks intact. Use the plural categories the language needs (for example one/few/many/other in Russian and Polish, just other in Japanese), always including other.
- Store listings (listing/) have length limits: tagline ${t.tagline} characters, pitch ${t.pitch}, each about paragraph ${t.about}, seoTitle ${t.seoTitle}, seoDescription ${t.seoDescription}, coverAlt ${t.coverAlt}, play ${t.play}, each mode line ${t.modeCard}.
- No HTML or markup. Keep the game's title untranslated unless I say otherwise.
- When a file is done, delete its "${UNTRANSLATED}" line. Leave a file marked if you are unsure, and tell me which.
- Then run "onecompanion-game validate ." (or the validate script) and fix anything it reports.`;
}

/* --------------------------------- helpers -------------------------------- */

async function walkFiles(dir: string, root = dir): Promise<string[]> {
	const out: string[] = [];
	for (const e of await readdir(dir, { withFileTypes: true })) {
		const abs = join(dir, e.name);
		if (e.isDirectory()) out.push(...(await walkFiles(abs, root)));
		else if (e.isFile()) out.push(rel(root, abs));
	}
	return out;
}

async function readJsonFile(path: string): Promise<Record<string, unknown> | null> {
	try {
		const v = JSON.parse(await readFile(path, 'utf8')) as unknown;
		return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

const withoutMarker = (o: Record<string, unknown>) => {
	const copy = { ...o };
	delete copy[UNTRANSLATED];
	return copy;
};
const rel = (root: string, path: string) => relative(root, path).split(sep).join('/');
const json = (v: unknown) => `${JSON.stringify(v, null, '\t')}\n`;
const slug = (s: string) =>
	s
		.toLowerCase()
		.replace(/[^a-z0-9-]+/g, '-')
		.replace(/^[^a-z]+|-+$/g, '')
		.slice(0, 32);
const titleOf = (id: string) =>
	id
		.split('-')
		.filter(Boolean)
		.map((w) => w[0]!.toUpperCase() + w.slice(1))
		.join(' ');

function readme(title: string, template: Template): string {
	const kind = {
		solo: 'a solo game (no rooms)',
		relay: 'a relay game: the room passes bytes between players',
		lockstep:
			'a lockstep game: the room orders every command and each player commands their own unit',
		'verified-solo':
			'a ranked solo game: the client plays each run, and src/server.ts replays its inputs with the same code (src/sim.ts) before the time counts. Your studio needs the `server` permission: ask us',
		'persistent-rpg':
			'a persistent RPG: characters the platform keeps, loot from your loot tables, and trades. src/server.ts runs on the platform; economy.json holds the classes, items, affixes and loot tables (push it with `onecompanion-game economy push`). Your studio needs the `server` and `persistent` permissions: ask us'
	}[template];
	return `# ${title}

A OneCompanion game, started from the \`${template}\` template: ${kind}.

    bun install
    bun run dev          # http://localhost:5191 (add ?lang=vi or &dir=rtl to test text and layout)
    bun run validate     # build the upload bundle and check it
    bun run i18n         # add missing languages and print a prompt for your AI tool to translate them
    bun run publish:game # upload for review (needs ONECOMPANION_TOKEN; tokens are made on your studio page)

Before the first upload: choose the game id in game.json (it becomes the URL and can never be reused), set your
studio handle, replace the placeholder art in art/ (same sizes), and write listing/en.json.

The developer guide is the contract: https://onecompanion.net/developers/guide
`;
}
