/**
 * Economy work that needs no network (docs/economy-plan.md, sections 6b and 6d.8):
 *
 * - `economyInit`: a starter `economy.json` for a preset. The platform's preset still fills in everything the file
 *   leaves out; the starter only adds a currency and the rules a game of that kind usually wants.
 * - `lootSimulation`: what a loot table hands out over many kills, against the hourly caps per quality.
 * - `testServer`: runs the game's server module headless with fuzzed input and reports anything the platform would
 *   drop or refuse (stat keys and milestones the manifest does not declare, loot outside the tables, bad events).
 *
 * The server's schema stays the judge: `economy validate` checks the file against it before you push.
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
	DEFAULT_QUALITY_CAPS,
	isStatKey,
	persistentMode,
	PRESET_KEYS,
	presetFor,
	QUALITIES,
	type Manifest,
	type PresetKey,
	type Quality
} from './manifest/index.ts';
import { CliError, exists, readSourceManifest } from './index.ts';

const ECONOMY = 'economy.json';

/* ------------------------------- starters ------------------------------- */

/** Presets whose games report match results (server rooms); the others earn from what the platform sees. */
const MATCH_PRESETS: readonly PresetKey[] = ['arena', 'racer', 'coop', 'party', 'strategy', 'rpg'];

/** The starter ruleset for a preset. Pure: also used by tests to check every starter against the server schema. */
export function starterRuleset(preset: PresetKey): Record<string, unknown> {
	if (preset === 'app') return { v: 1, defaults: false };
	const coins = { id: 'coins', name: { en: 'Coins' }, daily_cap: 500 };
	const rules: Record<string, unknown>[] = [
		{
			id: 'daily_coins',
			trigger: 'first_play_today',
			effects: [{ type: 'currency', currency: 'coins', amount: { base: 20 } }],
			limits: { per_user: { day: 1 } }
		},
		{
			id: 'streak_coins',
			trigger: 'play_streak',
			when: [{ field: 'streak.days', op: 'gte', value: 3 }],
			effects: [{ type: 'currency', currency: 'coins', amount: { base: 30 } }],
			limits: { per_user: { day: 1 } }
		}
	];
	if (MATCH_PRESETS.includes(preset))
		rules.push(
			{
				id: 'match_coins',
				trigger: 'match_end',
				effects: [{ type: 'currency', currency: 'coins', amount: { base: 10 } }],
				limits: { per_user: { day: 20 } }
			},
			{
				id: 'win_coins',
				trigger: 'match_end',
				when: [{ field: 'result.win', op: 'eq', value: true }],
				effects: [{ type: 'currency', currency: 'coins', amount: { base: 25 } }],
				limits: { per_user: { day: 10 } }
			}
		);
	else
		rules.push({
			id: 'playtime_coins',
			trigger: 'playtime_minutes',
			effects: [{ type: 'currency', currency: 'coins', amount: { base: 5 } }],
			limits: { per_user: { day: 24 } }
		});
	const doc: Record<string, unknown> = { v: 1, currencies: [coins], rules };
	if (preset === 'rpg')
		Object.assign(doc, {
			items: [
				{ id: 'wanderer', kind: 'character', name: { en: 'Wanderer' } },
				{ id: 'short_sword', kind: 'weapon', name: { en: 'Short sword' } },
				{ id: 'potion', kind: 'consumable', name: { en: 'Potion' } }
			],
			affixes: [{ id: 'of_embers', applies_to: ['weapon'], attributes: { fire: [2, 8] } }],
			loot_tables: [
				{
					id: 'crypt',
					level: [1, 50],
					entries: [
						{ base: 'potion', qualities: ['normal'], weight: 70 },
						{ base: 'short_sword', qualities: ['magic'], weight: 30 }
					]
				}
			]
		});
	return doc;
}

/** Write a starter `economy.json` for the game's preset (or `preset`). Never overwrites one. */
export async function economyInit(
	dir: string,
	preset?: string
): Promise<{ preset: PresetKey; path: string }> {
	dir = resolve(dir);
	const { manifest } = await readSourceManifest(dir);
	if (preset !== undefined && !(PRESET_KEYS as readonly string[]).includes(preset))
		throw new CliError(`--preset must be one of ${PRESET_KEYS.join(', ')}`);
	const key =
		(preset as PresetKey | undefined) ??
		presetFor({
			economy: manifest.economy?.preset ? { preset: manifest.economy.preset } : {},
			genres: manifest.genres
		});
	const path = join(dir, ECONOMY);
	if (await exists(path))
		throw new CliError(`${ECONOMY} already exists: edit it, or delete it to start again`);
	await writeFile(path, `${JSON.stringify(starterRuleset(key), null, 2)}\n`);
	return { preset: key, path };
}

/* ------------------------------- loot simulator ------------------------------- */

interface LootDoc {
	loot_tables?: {
		id: string;
		level?: [number, number];
		entries: { base: string; qualities: Quality[]; weight: number }[];
	}[];
	quality_caps?: Partial<Record<Quality, number>>;
}

export interface LootReport {
	table: string;
	kills: number;
	/** Expected instances per base and quality over `kills`. */
	expected: { base: string; quality: Quality; count: number }[];
	/** Per quality: expected per hour at `killsPerHour`, the cap, and whether drops would be refused. */
	perHour: { quality: Quality; expected: number; cap: number; overCap: boolean }[];
	warnings: string[];
}

/**
 * Expected drops from one table: each kill drops with `dropChance`, an entry is picked by weight, and a quality evenly
 * from the entry's list (your code decides the real odds; this shows what the table and caps allow).
 */
export function lootSimulation(
	doc: unknown,
	q: { table: string; kills: number; dropChance: number; killsPerHour: number; level?: number }
): LootReport {
	const d = (doc ?? {}) as LootDoc;
	const t = d.loot_tables?.find((x) => x.id === q.table);
	if (!t)
		throw new CliError(
			`no loot table "${q.table}" in ${ECONOMY} (tables: ${(d.loot_tables ?? []).map((x) => x.id).join(', ') || 'none'})`
		);
	if (!(q.kills > 0) || !(q.dropChance >= 0 && q.dropChance <= 1) || !(q.killsPerHour > 0))
		throw new CliError(
			'--kills and --kills-per-hour must be positive, --drop-chance between 0 and 1'
		);
	const warnings: string[] = [];
	if (q.level !== undefined && t.level && (q.level < t.level[0] || q.level > t.level[1]))
		warnings.push(
			`level ${q.level} is outside the table's levels ${t.level[0]}-${t.level[1]}: every drop would be refused`
		);
	const total = t.entries.reduce((n, e) => n + e.weight, 0);
	const share = new Map<string, { base: string; quality: Quality; p: number }>();
	for (const e of t.entries)
		for (const quality of e.qualities) {
			const p = (e.weight / total) * (1 / e.qualities.length);
			const k = `${e.base}:${quality}`;
			const prev = share.get(k);
			share.set(k, { base: e.base, quality, p: (prev?.p ?? 0) + p });
		}
	const expected = [...share.values()].map((s) => ({
		base: s.base,
		quality: s.quality,
		count: round(q.kills * q.dropChance * s.p)
	}));
	const perHour = QUALITIES.flatMap((quality) => {
		const p = [...share.values()].filter((s) => s.quality === quality).reduce((n, s) => n + s.p, 0);
		if (!p) return [];
		const exp = round(q.killsPerHour * q.dropChance * p);
		const cap = d.quality_caps?.[quality] ?? DEFAULT_QUALITY_CAPS[quality];
		return [{ quality, expected: exp, cap, overCap: exp > cap }];
	});
	for (const h of perHour)
		if (h.overCap)
			warnings.push(
				`${h.quality}: about ${h.expected} an hour, over the cap of ${h.cap}; drops past it are refused (raise quality_caps.${h.quality} or drop less)`
			);
	return { table: t.id, kills: q.kills, expected, perHour, warnings };
}

const round = (n: number) => Math.round(n * 100) / 100;

/* ------------------------------- headless test ------------------------------- */

export interface TestReport {
	ticks: number;
	events: Record<string, number>;
	problems: string[];
}

interface Module {
	config: { tickRate: number; maxPlayers: number; modes: string[] };
	init(ctx: unknown, settings: unknown): void;
	onJoin(p: unknown): void;
	onLeave(id: string): void;
	onInput(id: string, data: Uint8Array): void;
	tick(dt: number): void;
	snapshot(): void;
	isIdle(): boolean;
	onPlatform?(e: unknown): void;
	checkpoint?(): Uint8Array | null;
	restore?(b: Uint8Array): void;
}

/**
 * Run the server module headless: players join, send random bytes, tick and leave, with a seeded random. Reports what
 * the platform would refuse. Fuzzed input must never crash the module: validate everything a client sends.
 */
export async function testServer(
	dir: string,
	o: { seconds?: number; players?: number } = {}
): Promise<TestReport> {
	dir = resolve(dir);
	const { manifest } = await readSourceManifest(dir);
	if (!manifest.entry.server)
		throw new CliError('game.json has no entry.server: test runs the server module');
	const economyPath = join(dir, ECONOMY);
	const doc = (await exists(economyPath))
		? (JSON.parse(await readFile(economyPath, 'utf8')) as LootDoc)
		: null;

	const tmp = await mkdtemp(join(tmpdir(), 'oc-test-'));
	let mod: { createGameModule?: () => Module };
	try {
		const built = await Bun.build({
			entrypoints: [join(dir, manifest.entry.server)],
			target: 'browser',
			format: 'esm'
		});
		if (!built.success || built.outputs.length !== 1)
			throw new CliError(`server build failed:\n${built.logs.map(String).join('\n')}`);
		const file = join(tmp, 'server.js');
		await writeFile(file, await built.outputs[0]!.text());
		mod = (await import(pathToFileURL(file).href)) as typeof mod;
	} finally {
		await rm(tmp, { recursive: true, force: true });
	}
	if (typeof mod.createGameModule !== 'function')
		throw new CliError('the server entry does not export createGameModule');

	return runHeadless(mod.createGameModule, manifest, doc, o);
}

/** The headless run itself (separate so tests can pass a module directly). */
export function runHeadless(
	factory: () => Module,
	manifest: Pick<Manifest, 'economy' | 'modes'>,
	doc: LootDoc | null,
	o: { seconds?: number; players?: number } = {}
): TestReport {
	const problems = new Set<string>();
	const counts: Record<string, number> = {};
	const stats = new Set(manifest.economy?.stats ?? []);
	const milestones = new Set(manifest.economy?.milestones ?? []);
	const mode = manifest.modes.find((x) => x !== 'solo') ?? 'solo';
	// Characters only in the modes that carry them, as on the platform.
	const persistent = persistentMode(manifest.economy?.persistent, mode)
		? manifest.economy?.persistent
		: undefined;
	const fields = new Set(Object.keys(persistent?.character ?? {}));
	let seed = 0x2f6b;
	const random = () => {
		seed ^= seed << 13;
		seed ^= seed >>> 17;
		seed ^= seed << 5;
		seed >>>= 0;
		return seed / 0x1_0000_0000;
	};
	let now = 1_700_000_000_000;
	const present = new Set<string>();
	const m = factory();
	const check = (e: Record<string, unknown>) => {
		const kind = String(e?.kind);
		counts[kind] = (counts[kind] ?? 0) + 1;
		const who = e.playerId as string | undefined;
		if (who !== undefined && !present.has(who))
			problems.add(`${kind} event for a player who is not in the room`);
		if (kind === 'end') {
			const players =
				(e.result as { players?: { stats?: Record<string, unknown> }[] })?.players ?? [];
			for (const p of players)
				for (const k of Object.keys(p.stats ?? {})) {
					if (!isStatKey(k))
						problems.add(`stat "${k}" is not a platform key or g_ key: the platform drops it`);
					else if (k.startsWith('g_') && !stats.has(k))
						problems.add(`stat "${k}" is not in game.json economy.stats`);
				}
		} else if (kind === 'milestone') {
			const key = String(e.key);
			if (!/^g_[a-z0-9_]{1,22}$/.test(key)) problems.add(`milestone "${key}" is not a g_ key`);
			else if (!milestones.has(key))
				problems.add(`milestone "${key}" is not in game.json economy.milestones`);
		} else if (
			kind === 'character' ||
			kind === 'grant' ||
			kind === 'consume' ||
			kind === 'travel'
		) {
			if (!persistent) problems.add(`${kind} events need economy.persistent in game.json`);
			if (kind === 'character')
				for (const k of Object.keys((e.state as object) ?? {}))
					if (!fields.has(k))
						problems.add(`character field "${k}" is not in economy.persistent.character`);
			if (kind === 'grant') {
				const item = (e.item ?? {}) as { base?: string; quality?: Quality };
				const t = doc?.loot_tables?.find((x) => x.id === e.table);
				if (!t)
					problems.add(
						`grant from loot table "${String(e.table)}", which economy.json does not have`
					);
				else if (
					!t.entries.some((x) => x.base === item.base && x.qualities.includes(item.quality!))
				)
					problems.add(`grant of ${item.quality} ${item.base}, which table "${t.id}" cannot drop`);
				if (typeof e.ref !== 'string' || !e.ref)
					problems.add('grant without a ref: retries would not be safe');
				m.onPlatform?.({ kind: 'granted', playerId: who, ref: e.ref, item: null, error: 'test' });
			}
		} else if (kind !== 'notice') problems.add(`unknown event kind "${kind}"`);
	};
	const ctx = {
		sendTo: () => {},
		broadcast: () => {},
		emit: (e: Record<string, unknown>) => check(e),
		now: () => now,
		random
	};
	const guard = (what: string, f: () => void) => {
		try {
			f();
		} catch (err) {
			problems.add(`${what} threw: ${err instanceof Error ? err.message : String(err)}`);
		}
	};
	guard('init', () =>
		m.init(ctx, { mode, map: 'default', maxPlayers: m.config.maxPlayers, private: false })
	);
	const players = Math.max(1, Math.min(o.players ?? 2, m.config.maxPlayers));
	const character = (i: number) =>
		persistent
			? {
					id: `char-${i}`,
					name: `Tester ${i}`,
					class: 'tester',
					level: 1,
					xp: 0,
					state: {},
					hardcore: false,
					season: null,
					items: []
				}
			: undefined;
	const join = (i: number) => {
		const id = `p${i}`;
		present.add(id);
		guard('onJoin', () =>
			m.onJoin({
				id,
				displayName: `Tester ${i}`,
				locale: 'en',
				team: null,
				...(persistent ? { character: character(i) } : {})
			})
		);
	};
	for (let i = 1; i <= players; i++) join(i);
	const rate = Math.max(1, m.config.tickRate || 10);
	const ticks = Math.round((o.seconds ?? 60) * rate);
	for (let t = 0; t < ticks; t++) {
		now += 1000 / rate;
		for (const id of present) {
			const len = 1 + Math.floor(random() * 8);
			const bytes = new Uint8Array(len).map(() => Math.floor(random() * 256));
			guard('onInput', () => m.onInput(id, bytes));
		}
		guard('tick', () => m.tick(1 / rate));
		if (t % 3 === 0) guard('snapshot', () => m.snapshot());
		// Someone leaves and comes back now and then.
		if (t > 0 && t % (rate * 15) === 0 && present.size > 1) {
			guard('onLeave', () => m.onLeave('p1'));
			present.delete('p1');
			join(1);
		}
	}
	if (m.checkpoint) {
		let bytes: Uint8Array | null = null;
		guard('checkpoint', () => void (bytes = m.checkpoint!()));
		if (bytes && (bytes as Uint8Array).byteLength > 256 * 1024)
			problems.add('checkpoint is over 256 KB: it would not be kept');
		if (bytes && m.restore) guard('restore', () => factory().restore!(bytes!));
	}
	for (const id of [...present]) guard('onLeave', () => m.onLeave(id));
	if (!m.isIdle())
		problems.add('isIdle() is false after everyone left: the room would keep ticking');
	return { ticks, events: counts, problems: [...problems] };
}
