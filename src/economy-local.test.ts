import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	economyInit,
	lootSimulation,
	runHeadless,
	starterRuleset,
	testServer
} from './economy-local.ts';
import { init } from './scaffold.ts';

const root = await mkdtemp(join(tmpdir(), 'oc-econ-'));
afterAll(() => rm(root, { recursive: true, force: true }));

describe('economy init', () => {
	it('writes the preset starter once', async () => {
		const dir = join(root, 'game-relay');
		await init(dir, { template: 'relay', studio: 'acme' });
		const r = await economyInit(dir, 'party');
		expect(r.preset).toBe('party');
		const doc = JSON.parse(await readFile(r.path, 'utf8'));
		expect(doc.rules.map((x: { id: string }) => x.id)).toContain('match_coins');
		await expect(economyInit(dir)).rejects.toThrow('already exists');
		await expect(economyInit(join(root, 'game-relay'), 'mmo')).rejects.toThrow('--preset');
	});

	it('gives client-authoritative presets no match rules', () => {
		const ids = (starterRuleset('solo').rules as { id: string }[]).map((x) => x.id);
		expect(ids).not.toContain('match_coins');
		expect(ids).toContain('playtime_coins');
	});
});

describe('loot simulation', () => {
	const doc = starterRuleset('rpg');
	it('splits drops by weight and flags hourly caps', () => {
		const r = lootSimulation(doc, {
			table: 'crypt',
			kills: 1000,
			dropChance: 0.5,
			killsPerHour: 3000
		});
		expect(r.expected).toEqual([
			{ base: 'potion', quality: 'normal', count: 350 },
			{ base: 'short_sword', quality: 'magic', count: 150 }
		]);
		expect(r.perHour.find((h) => h.quality === 'normal')).toMatchObject({
			expected: 1050,
			cap: 600,
			overCap: true
		});
		expect(r.warnings).toHaveLength(2); // normal 1050 > 600 and magic 450 > 200 an hour
		expect(() =>
			lootSimulation(doc, { table: 'nope', kills: 1, dropChance: 1, killsPerHour: 1 })
		).toThrow('crypt');
		expect(
			lootSimulation(doc, {
				table: 'crypt',
				kills: 10,
				dropChance: 0.1,
				killsPerHour: 10,
				level: 99
			}).warnings[0]
		).toContain('outside');
	});
});

// Only in the monorepo: the exported game-cli repo has no packages/room-runtime to compare with.
const platformHelper = new URL('../../room-runtime/src/progression.ts', import.meta.url);
const inMonorepo = await Bun.file(platformHelper).exists();

describe('vendored progression', () => {
	it.skipIf(!inMonorepo)('is the platform helper unchanged', async () => {
		const strip = (s: string) =>
			s
				.replace(/^\/\*\*\n \* Vendored[\s\S]*?\*\n/, '/**\n')
				.replace("from './server-contract.ts'", "from './module.ts'");
		const here = new URL('../templates/persistent-rpg/src/progression.ts', import.meta.url);
		expect(strip(await Bun.file(here).text())).toBe(await Bun.file(platformHelper).text());
	});
});

describe('template contract', () => {
	const sdk = new URL('../../platform-sdk/src/game.ts', import.meta.url);
	it.skipIf(!inMonorepo)('is the platform SDK contract unchanged', async () => {
		const body = (s: string) => s.slice(s.indexOf('export type Translate'));
		const here = new URL('../templates/base/src/contract.ts', import.meta.url);
		expect(body(await Bun.file(here).text())).toBe(body(await Bun.file(sdk).text()));
	});
});

describe('headless test', () => {
	it('passes the persistent-rpg template as generated', async () => {
		const dir = join(root, 'game-rpg');
		await init(dir, { template: 'persistent-rpg', studio: 'acme' });
		const r = await testServer(dir, { seconds: 30 });
		expect(r.problems).toEqual([]);
		expect(r.ticks).toBe(300);
	}, 30_000);

	it('reports undeclared keys, unknown tables, crashes and rooms that never idle', () => {
		const r = runHeadless(
			() => {
				let ctx: { emit(e: unknown): void };
				return {
					config: { tickRate: 10, maxPlayers: 2, modes: ['coop'] },
					init: (c) => void (ctx = c as typeof ctx),
					onJoin() {},
					onLeave() {},
					onInput(id, d) {
						if (d[0] === 7) throw new Error('boom');
						ctx.emit({ kind: 'milestone', playerId: id, key: 'g_secret' });
						ctx.emit({
							kind: 'grant',
							playerId: id,
							ref: 'x',
							table: 'nowhere',
							item: { base: 'a', quality: 'rare', level: 1 }
						});
					},
					tick() {},
					snapshot() {},
					isIdle: () => false
				};
			},
			{ modes: ['coop'], economy: { milestones: [] } as never },
			null,
			{ seconds: 5 }
		);
		expect(r.problems).toContain('milestone "g_secret" is not in game.json economy.milestones');
		expect(r.problems).toContain('grant events need economy.persistent in game.json');
		expect(r.problems).toContain(
			'grant from loot table "nowhere", which economy.json does not have'
		);
		expect(r.problems).toContain('onInput threw: boom');
		expect(r.problems).toContain(
			'isIdle() is false after everyone left: the room would keep ticking'
		);
	});
});
