/**
 * `game.json`, manifest version 1 (docs/marketplace-plan.md, section 2.1). Runtime-agnostic: used by the CLI (Bun),
 * the web app and admin (Workers) and realtime.
 *
 * Two shapes share one schema. A *source* manifest is what a developer writes (entry points may be `.ts` source,
 * listing, rating and rights optional). A *bundle* manifest is what the CLI uploads: entry points are built `.js`
 * files inside the bundle and every field a listing needs is present. `parseManifest(json, 'bundle')` enforces the
 * second.
 */
import { z } from 'zod';
import { ManifestEconomySchema } from './economy.ts';
import { isSafePath } from './files.ts';

/**
 * Locales a bundle must ship store listing text for (decision D3): the platform's launch set. Locales added later
 * (LOCALES below) are optional in a bundle, so a game that passed review keeps passing; the store shows the English
 * listing where a game has none.
 */
export const LISTING_LOCALES = [
	'en',
	'vi',
	'zh-hans',
	'hi',
	'es',
	'fr',
	'ar',
	'bn',
	'pt-br',
	'ru',
	'ur',
	'id'
] as const;
/** The platform's locales (apps/web/project.inlang/settings.json). `en` is the source locale. */
export const LOCALES = [
	...LISTING_LOCALES,
	'ja',
	'ko',
	'de',
	'tr',
	'th',
	'fil',
	'it',
	'pl'
] as const;
export type Locale = (typeof LOCALES)[number];

/** Keys of the platform's GENRES and MODES (apps/web/src/lib/games/catalog.ts; a web test keeps them equal). */
export const GENRE_KEYS = ['action', 'shooter', 'idle', 'rpg', 'sim', 'app'] as const;
export const MODE_KEYS = ['tdm', 'ffa', 'coop', 'race', 'trial', 'solo'] as const;

/**
 * How a hosted game's rooms run (section 4.4 and 5):
 * - `none`: solo only, no rooms.
 * - `relay`: a platform module relays bytes between players (client-authoritative, unranked).
 * - `lockstep`: a platform module orders commands by step (client-authoritative, unranked).
 * - `server`: the game's own `server.js` runs in an isolate the room calls (step 3).
 */
export const ROOM_KINDS = ['none', 'relay', 'lockstep', 'server'] as const;
export type RoomKind = (typeof ROOM_KINDS)[number];

export const RATINGS = ['everyone', 'teen', 'mature'] as const;

/** Bundle limits (section 2.1 and 5.3). */
export const LIMITS = {
	maxPlayersHosted: 16,
	maxTickRate: 30,
	clientGzipKB: 450,
	bundleBytes: 25 * 1024 * 1024,
	fileBytes: 10 * 1024 * 1024,
	serverBytes: 1024 * 1024,
	maxFiles: 400,
	stills: { min: 3, max: 8 },
	text: {
		tagline: 120,
		pitch: 240,
		about: 600,
		aboutParagraphs: 4,
		seoTitle: 70,
		seoDescription: 170,
		coverAlt: 160,
		play: 24,
		modeCard: 160
	}
} as const;

const ID = /^[a-z][a-z0-9-]{2,31}$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;
/** Relative path inside the package: no `..`, no absolute paths, no backslashes. */
const RelPath = z
	.string()
	.min(1)
	.max(200)
	.transform((p) => p.replace(/^\.\//, ''))
	.refine(
		(p) => !p.startsWith('/') && !p.includes('\\') && !p.split('/').includes('..'),
		'path must stay inside the package'
	);

export const ManifestSchema = z
	.object({
		$schema: z.string().optional(),
		$comment: z.string().optional(),
		manifest: z.literal(1),
		id: z
			.string()
			.regex(ID, 'lowercase letters, digits and dashes, 3-32 characters, starting with a letter'),
		title: z.string().trim().min(1).max(40),
		version: z.string().regex(SEMVER, 'semver, e.g. 1.0.0'),
		studio: z.string().regex(/^[a-z][a-z0-9-]{1,31}$/),
		kind: z.literal('game').optional(),
		genres: z.array(z.enum(GENRE_KEYS)).min(1).max(3),
		players: z.object({ min: z.number().int().min(1), max: z.number().int().min(1).max(64) }),
		modes: z.array(z.enum(MODE_KEYS)).min(1),
		entry: z.object({ client: RelPath, server: RelPath.optional() }),
		realtime: z
			.object({
				kind: z.enum(ROOM_KINDS).optional(),
				tickRate: z.number().int().min(0).max(LIMITS.maxTickRate),
				snapshotRate: z.number().int().min(0).max(LIMITS.maxTickRate),
				protocol: z.number().int().min(1)
			})
			.optional(),
		/** Scoring and economy hints (docs/economy-plan.md, section 6b). Optional: a game without it gets a preset. */
		economy: ManifestEconomySchema.optional(),
		/**
		 * Asset library paths this version's code needs (docs/economy-plan.md, section 6c). A version is refused when
		 * the live asset release lacks one, and an asset release is refused when it drops one the live version needs.
		 */
		assets: z
			.object({
				required: z
					.array(z.string().max(200).refine(isSafePath, { message: 'a safe relative path' }))
					.max(500)
					.default([])
			})
			.strict()
			.optional(),
		locales: z.array(z.enum(LOCALES)).min(1),
		messages: RelPath,
		listing: RelPath.optional(),
		media: z.object({
			cover: RelPath,
			stills: z.array(RelPath).max(LIMITS.stills.max),
			share: RelPath.optional()
		}),
		budgets: z.object({
			clientGzipKB: z.number().positive().max(LIMITS.clientGzipKB),
			gpuMemoryMB: z.number().positive().optional()
		}),
		capabilities: z.object({
			pointerLock: z.boolean().default(false),
			fullscreen: z.boolean().default(false),
			gamepad: z.boolean().default(false),
			audio: z.boolean().default(false),
			network: z
				.array(z.string())
				.max(0, 'games have no network access of their own: use online.send')
		}),
		rating: z
			.object({
				level: z.enum(RATINGS),
				descriptors: z.array(z.string().max(40)).max(8).default([])
			})
			.optional(),
		rights: z
			.object({
				ownsAllContent: z.literal(true, {
					error: 'you must own or license everything in the bundle'
				}),
				thirdParty: z
					.array(
						z.object({
							name: z.string().max(80),
							licence: z.string().max(40),
							url: z.string().url().max(200)
						})
					)
					.max(50)
					.default([])
			})
			.optional()
	})
	.superRefine((m, ctx) => {
		const issue = (path: (string | number)[], message: string) =>
			ctx.addIssue({ code: 'custom', path, message });
		if (m.players.min > m.players.max) issue(['players'], 'min must not exceed max');
		if (!m.locales.includes('en')) issue(['locales'], 'must include en');
		if (m.realtime && m.realtime.snapshotRate > m.realtime.tickRate && m.realtime.tickRate > 0)
			issue(['realtime', 'snapshotRate'], 'must not exceed tickRate');
		const kind = roomKind(m as Manifest);
		const roomModes = m.modes.filter((x) => x !== 'solo');
		if (kind === 'none' && roomModes.length)
			issue(['modes'], 'room modes need realtime.kind relay, lockstep or server');
		if (kind !== 'none' && !roomModes.length)
			issue(['modes'], 'a game with rooms needs a room mode (coop, ffa, tdm, race or trial)');
		if (kind === 'server' && !m.entry.server)
			issue(['entry', 'server'], 'realtime.kind server needs entry.server');
		if (kind === 'lockstep' && !m.realtime?.tickRate)
			issue(['realtime', 'tickRate'], 'lockstep needs a step rate');
	});

export type Manifest = z.infer<typeof ManifestSchema>;

/** A source manifest's room kind: explicit, else `server` when it has a server entry, else `none`. */
export function roomKind(m: Pick<Manifest, 'realtime' | 'entry'>): RoomKind {
	return m.realtime?.kind ?? (m.entry.server ? 'server' : 'none');
}

export interface Issue {
	path: string;
	message: string;
}

export type Parsed = { ok: true; manifest: Manifest } | { ok: false; issues: Issue[] };

/** Parse and check a manifest. `bundle` adds what an uploaded bundle must carry (built entries, listing, rating, rights). */
export function parseManifest(json: unknown, shape: 'source' | 'bundle' = 'source'): Parsed {
	const r = ManifestSchema.safeParse(json);
	if (!r.success)
		return {
			ok: false,
			issues: r.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message }))
		};
	const m = r.data;
	if (shape === 'bundle') {
		const issues: Issue[] = [];
		if (!m.entry.client.endsWith('.js'))
			issues.push({ path: 'entry.client', message: 'must be a built .js file' });
		if (m.entry.server && m.entry.server !== 'server.js')
			issues.push({ path: 'entry.server', message: 'must be server.js at the bundle root' });
		if (!m.listing) issues.push({ path: 'listing', message: 'required for upload' });
		if (!m.rating) issues.push({ path: 'rating', message: 'required for upload' });
		if (!m.rights) issues.push({ path: 'rights', message: 'required for upload' });
		if (!m.media.share) issues.push({ path: 'media.share', message: 'required for upload' });
		if (m.media.stills.length < LIMITS.stills.min)
			issues.push({ path: 'media.stills', message: `at least ${LIMITS.stills.min}` });
		if (m.players.max > LIMITS.maxPlayersHosted)
			issues.push({
				path: 'players.max',
				message: `at most ${LIMITS.maxPlayersHosted} for hosted games`
			});
		if (issues.length) return { ok: false, issues };
	}
	return { ok: true, manifest: m };
}

/** -1, 0 or 1. Pre-release versions sort before their release; pre-release tags compare as strings. */
export function compareSemver(a: string, b: string): number {
	const split = (v: string) => {
		const [core, pre] = v.split('-', 2) as [string, string | undefined];
		return { nums: core.split('.').map(Number), pre };
	};
	const x = split(a);
	const y = split(b);
	for (let i = 0; i < 3; i++) if (x.nums[i] !== y.nums[i]) return x.nums[i]! < y.nums[i]! ? -1 : 1;
	if (x.pre === y.pre) return 0;
	if (x.pre === undefined) return 1;
	if (y.pre === undefined) return -1;
	return x.pre < y.pre ? -1 : 1;
}

const ModeCard = z.string().trim().min(1).max(LIMITS.text.modeCard).optional();

/** The listing file shape (`listing/<locale>.json`). */
export const ListingSchema = z.object({
	tagline: z.string().trim().min(1).max(LIMITS.text.tagline),
	pitch: z.string().trim().min(1).max(LIMITS.text.pitch),
	about: z
		.array(z.string().trim().min(1).max(LIMITS.text.about))
		.min(1)
		.max(LIMITS.text.aboutParagraphs),
	seoTitle: z.string().trim().min(1).max(LIMITS.text.seoTitle),
	seoDescription: z.string().trim().min(1).max(LIMITS.text.seoDescription),
	coverAlt: z.string().trim().min(1).max(LIMITS.text.coverAlt),
	/** The main play button's label (default "Play now"). */
	play: z.string().trim().min(1).max(LIMITS.text.play).optional(),
	/** One line per mode for the mode cards on the game page (default: the platform's generic line). */
	modes: z
		.object({
			tdm: ModeCard,
			ffa: ModeCard,
			coop: ModeCard,
			race: ModeCard,
			trial: ModeCard,
			solo: ModeCard
		})
		.strict()
		.optional()
});

/**
 * A text file (`messages/<locale>.json` or `listing/<locale>.json`) carrying this key at the top is a copy of
 * English waiting for translation (`onecompanion-game i18n` writes them). Uploads refuse such files.
 */
export const UNTRANSLATED = '$untranslated';
export type Listing = z.infer<typeof ListingSchema>;
