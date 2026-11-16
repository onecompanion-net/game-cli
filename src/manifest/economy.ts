/**
 * The shared fact vocabulary and the manifest's `economy` block (docs/economy-plan.md, sections 3 and 6b). Platform
 * stat keys mean the same thing in every game; anything else a game reports is a game key with the `g_` prefix.
 * That split is what makes games comparable. Runtime-agnostic, vendored by the game CLI.
 */
import { z } from 'zod';

/** How a stat adds up over many matches on a board: summed, or the best single value. */
export type Aggregate = 'sum' | 'min' | 'max';

export const PLATFORM_STATS = {
	/** Finishing position, 1 = best. */
	place: { agg: 'min', better: 'asc' },
	/** Opponents eliminated. */
	kills: { agg: 'sum', better: 'desc' },
	/** Times eliminated. */
	deaths: { agg: 'sum', better: 'asc' },
	assists: { agg: 'sum', better: 'desc' },
	/** Objective actions: captures, deliveries, beacons lit. */
	objectives: { agg: 'sum', better: 'desc' },
	/** Time to finish, lower is better. */
	duration_ms: { agg: 'min', better: 'asc' },
	distance_m: { agg: 'sum', better: 'desc' },
	/** Co-op waves or levels cleared. */
	waves: { agg: 'max', better: 'desc' }
} as const satisfies Record<string, { agg: Aggregate; better: 'asc' | 'desc' }>;

export type PlatformStat = keyof typeof PLATFORM_STATS;
export const PLATFORM_STAT_KEYS = Object.keys(PLATFORM_STATS) as PlatformStat[];

/** A game-specific key: `g_` + up to 22 lowercase letters, digits or underscores. Milestones use the same rule. */
export const GAME_KEY = /^g_[a-z0-9_]{1,22}$/;

export const isPlatformStat = (k: string): k is PlatformStat => Object.hasOwn(PLATFORM_STATS, k);
export const isGameKey = (k: string) => GAME_KEY.test(k);
/** Any key a result may carry and a rule or board may read. `score` is `MatchResult.score` itself. */
export const isStatKey = (k: string) => k === 'score' || isPlatformStat(k) || isGameKey(k);

export const aggregateOf = (k: string): Aggregate =>
	isPlatformStat(k) ? PLATFORM_STATS[k].agg : 'sum';

/** Merge one match's value into a running total by the key's aggregate. */
export function combine(agg: Aggregate, prev: number | undefined, next: number): number {
	if (prev === undefined) return next;
	if (agg === 'sum') return prev + next;
	return agg === 'min' ? Math.min(prev, next) : Math.max(prev, next);
}

/** Platform bound on numbers a game reports (the room clamps hosted results to it). */
export const STAT_LIMIT = 1_000_000;

export const clampStat = (v: unknown): number =>
	typeof v === 'number' && Number.isFinite(v)
		? Math.max(-STAT_LIMIT, Math.min(STAT_LIMIT, Math.round(v)))
		: 0;

/** Platform presets (section 6b): rulesets shipped by the platform that a studio picks and edits. */
export const PRESET_KEYS = [
	'arena',
	'racer',
	'coop',
	'party',
	'strategy',
	'idle',
	'solo',
	'rpg',
	'app'
] as const;
export type PresetKey = (typeof PRESET_KEYS)[number];

/** The preset a game gets when its manifest names none: by its first genre. */
export const PRESET_BY_GENRE: Record<string, PresetKey> = {
	action: 'arena',
	shooter: 'arena',
	idle: 'idle',
	rpg: 'rpg',
	sim: 'idle',
	app: 'app'
};

/** Config keys: dotted lowercase names, `player.max_hp`. */
export const CONFIG_KEY = /^[a-z][a-z0-9_]{0,31}(\.[a-z][a-z0-9_]{0,31}){0,3}$/;
const ATTR_KEY = /^[a-z][a-z0-9_]{0,23}$/;
/** Item kinds that can carry attributes. */
export const ATTRIBUTE_KINDS = [
	'character',
	'weapon',
	'ability',
	'vehicle',
	'card',
	'material',
	'consumable',
	'cosmetic'
] as const;

const Scalar = z.union([z.number(), z.string().max(200), z.boolean()]);
/** One declared config value: its type, bounds and default. */
export const ConfigDecl = z.discriminatedUnion('type', [
	z
		.object({
			type: z.literal('int'),
			min: z.number().int().optional(),
			max: z.number().int().optional(),
			default: z.number().int()
		})
		.strict(),
	z
		.object({
			type: z.literal('float'),
			min: z.number().optional(),
			max: z.number().optional(),
			default: z.number()
		})
		.strict(),
	z.object({ type: z.literal('bool'), default: z.boolean() }).strict(),
	z
		.object({
			type: z.literal('enum'),
			values: z.array(z.string().regex(ATTR_KEY)).min(1).max(50),
			default: z.string()
		})
		.strict(),
	z
		.object({
			type: z.literal('string'),
			max: z.number().int().min(1).max(200).default(64),
			default: z.string().max(200)
		})
		.strict(),
	z
		.object({
			type: z.literal('list'),
			of: z.enum(['int', 'float', 'string']),
			max: z.number().int().min(1).max(100).default(20),
			default: z.array(Scalar).max(100)
		})
		.strict(),
	z
		.object({
			type: z.literal('object'),
			fields: z
				.record(z.string().regex(ATTR_KEY), z.enum(['int', 'float', 'bool', 'string']))
				.refine((f) => Object.keys(f).length <= 20),
			default: z.record(z.string(), Scalar)
		})
		.strict()
]);
export type ConfigDecl = z.infer<typeof ConfigDecl>;
export type ConfigValue =
	number | string | boolean | (number | string)[] | Record<string, number | string | boolean>;

/** An attribute's type: a number, a flag, a short text, or one of a fixed list. */
const AttrType = z.union([
	z.enum(['int', 'float', 'bool', 'string']),
	z.array(z.string().regex(ATTR_KEY)).min(1).max(50)
]);
export type AttrType = z.infer<typeof AttrType>;

/** Whether a value fits a declaration (bounds included); the reason when it does not. */
export function checkConfigValue(d: ConfigDecl, v: unknown): string | null {
	const num = (x: unknown, int: boolean) =>
		typeof x === 'number' && Number.isFinite(x) && (!int || Number.isInteger(x));
	switch (d.type) {
		case 'int':
		case 'float':
			if (!num(v, d.type === 'int'))
				return `must be ${d.type === 'int' ? 'a whole number' : 'a number'}`;
			if (d.min !== undefined && (v as number) < d.min) return `at least ${d.min}`;
			if (d.max !== undefined && (v as number) > d.max) return `at most ${d.max}`;
			return null;
		case 'bool':
			return typeof v === 'boolean' ? null : 'must be true or false';
		case 'enum':
			return typeof v === 'string' && d.values.includes(v) ? null : `one of ${d.values.join(', ')}`;
		case 'string':
			return typeof v === 'string' && v.length <= d.max
				? null
				: `text of at most ${d.max} characters`;
		case 'list':
			if (!Array.isArray(v) || v.length > d.max) return `a list of at most ${d.max}`;
			return v.every((x) =>
				d.of === 'string' ? typeof x === 'string' && x.length <= 200 : num(x, d.of === 'int')
			)
				? null
				: `every entry must be ${d.of}`;
		case 'object': {
			if (!v || typeof v !== 'object' || Array.isArray(v)) return 'must be an object';
			for (const [k, t] of Object.entries(d.fields)) {
				const x = (v as Record<string, unknown>)[k];
				const ok =
					t === 'string'
						? typeof x === 'string'
						: t === 'bool'
							? typeof x === 'boolean'
							: num(x, t === 'int');
				if (!ok) return `${k} must be ${t}`;
			}
			return Object.keys(v).every((k) => k in d.fields)
				? null
				: 'has fields the game does not declare';
		}
	}
}

/** Whether an attribute value fits its type. */
export function checkAttribute(t: AttrType, v: unknown): boolean {
	if (Array.isArray(t)) return typeof v === 'string' && t.includes(v);
	if (t === 'bool') return typeof v === 'boolean';
	if (t === 'string') return typeof v === 'string' && v.length <= 200;
	return typeof v === 'number' && Number.isFinite(v) && (t === 'float' || Number.isInteger(v));
}

/** Item qualities of the persistent level (docs/economy-plan.md, section 6d.2). */
export const QUALITIES = ['normal', 'magic', 'rare', 'set', 'unique'] as const;
export type Quality = (typeof QUALITIES)[number];
/** Most instances of a quality one character may receive per hour, unless the ruleset sets its own. */
export const DEFAULT_QUALITY_CAPS: Readonly<Record<Quality, number>> = {
	normal: 600,
	magic: 200,
	rare: 40,
	set: 6,
	unique: 4
};

/** Equip slots a game renders (`bike_skin`, `helmet`): lowercase, 1–24 characters. */
const SLOT = /^[a-z][a-z0-9_]{0,23}$/;

export const PersistentSchema = z
	.object({
		/** Character slots per account. */
		slots: z.number().int().min(1).max(24).default(3),
		/** Fields of a character's saved state the server module writes (`skills: 'object'`), 64 KB in all. */
		character: z
			.record(
				z.string().regex(ATTR_KEY),
				z.enum(['int', 'float', 'bool', 'string', 'object', 'list'])
			)
			.refine((r) => Object.keys(r).length <= 40, { message: 'at most 40 fields' })
			.default({}),
		/** Where instances can be (`bag`, `equipped:head`, `stash:0`…): the first part before `:`. */
		locations: z.array(z.string().regex(ATTR_KEY)).min(1).max(16).default(['bag', 'stash']),
		/** Instances one character can hold, and the account's shared stash. */
		bag_capacity: z.number().int().min(1).max(400).default(100),
		stash_capacity: z.number().int().min(0).max(2000).default(200),
		hardcore: z.boolean().default(false),
		/** Room modes that carry characters (absent: every room mode). Solo never does; other modes stay open to guests. */
		modes: z
			.array(z.enum(['tdm', 'ffa', 'coop', 'race', 'trial']))
			.min(1)
			.optional()
	})
	.strict();
export type PersistentDecl = z.infer<typeof PersistentSchema>;
/** Whether rooms of `mode` carry characters under this declaration. */
export const persistentMode = (
	decl: Pick<PersistentDecl, 'modes'> | null | undefined,
	mode: string
) => !!decl && mode !== 'solo' && (!decl.modes || (decl.modes as readonly string[]).includes(mode));
/** The class a character gets when the game's ruleset defines none (so a game never locks players out). */
export const DEFAULT_CLASS = 'default';

export const ManifestEconomySchema = z
	.object({
		preset: z.enum(PRESET_KEYS).optional(),
		/** Stat keys the server module reports in `MatchResult.players[].stats`. */
		stats: z
			.array(
				z.string().refine((k) => isPlatformStat(k) || isGameKey(k), {
					message: 'a platform stat key (place, kills, …) or a g_ game key'
				})
			)
			.max(24)
			.default([]),
		/** Milestone keys the server module emits with `{ kind: 'milestone' }`. */
		milestones: z
			.array(z.string().regex(GAME_KEY, 'g_ followed by lowercase letters, digits or _'))
			.max(64)
			.default([]),
		/** Equip slots the game renders, for cosmetic items. */
		slots: z.array(z.string().regex(SLOT)).max(16).default([]),
		/**
		 * An unverified best-score board for games whose results come from the player's browser (room kinds none,
		 * relay, lockstep): fed by the client's `complete` event, labelled unverified, never used for rewards or
		 * tournaments. `by`: the event's `score` (higher is better) or its time (`duration_ms`, lower is better).
		 */
		/**
		 * Tunable values the game reads (docs/economy-plan.md, section 6c): health, mana, costs, timers. The studio sets
		 * them on /developers; the game gets them as `options.config` (client) and `settings.config` (server).
		 */
		config: z
			.record(z.string().regex(CONFIG_KEY), ConfigDecl)
			.refine((r) => Object.keys(r).length <= 300, {
				message: 'at most 300 keys'
			})
			.default({}),
		/** Attributes per item kind (`character: { hp: 'int', class: ['mage', 'tank'] }`), for catalog entries. */
		attributes: z
			.partialRecord(z.enum(ATTRIBUTE_KINDS), z.record(z.string().regex(ATTR_KEY), AttrType))
			.default({}),
		/**
		 * Level 5, the persistent RPG level (docs/economy-plan.md, section 6d): characters only the game's server writes,
		 * item instances with rolled stats, trusted loot. `server` games only, and only for studios staff allow.
		 */
		persistent: PersistentSchema.optional(),
		casual: z
			.object({
				by: z.enum(['score', 'duration_ms']),
				order: z.enum(['desc', 'asc']).optional()
			})
			.strict()
			.optional()
	})
	.strict()
	.superRefine((e, ctx) => {
		for (const [field, list] of [
			['stats', e.stats],
			['milestones', e.milestones],
			['slots', e.slots]
		] as const)
			if (new Set(list).size !== list.length)
				ctx.addIssue({ code: 'custom', path: [field], message: 'duplicate keys' });
		for (const [k, d] of Object.entries(e.config)) {
			const why = checkConfigValue(d, d.default);
			if (why) ctx.addIssue({ code: 'custom', path: ['config', k, 'default'], message: why });
		}
	});

export type ManifestEconomy = z.infer<typeof ManifestEconomySchema>;

/** The preset a game starts from: its manifest's, else its first genre's, else arena. */
export const presetFor = (m: { economy?: { preset?: PresetKey }; genres?: readonly string[] }) =>
	m.economy?.preset ?? PRESET_BY_GENRE[m.genres?.[0] ?? ''] ?? 'arena';
