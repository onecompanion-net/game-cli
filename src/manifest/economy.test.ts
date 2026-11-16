import { describe, expect, it } from 'bun:test';
import {
	aggregateOf,
	clampStat,
	combine,
	isStatKey,
	ManifestEconomySchema,
	presetFor
} from './economy.ts';
import { manifest } from './fixtures.ts';
import { parseManifest } from './schema.ts';

describe('economy vocabulary', () => {
	it('knows platform keys, game keys and score; nothing else', () => {
		for (const k of ['score', 'place', 'kills', 'duration_ms', 'g_laps', 'g_a1_b2'])
			expect(isStatKey(k)).toBe(true);
		for (const k of ['laps', 'G_laps', 'g_', 'g_' + 'x'.repeat(23), 'g_bad-key', '__proto__'])
			expect(isStatKey(k)).toBe(false);
	});

	it('aggregates by key: sums, best places and times, highest waves', () => {
		expect(aggregateOf('kills')).toBe('sum');
		expect(aggregateOf('place')).toBe('min');
		expect(aggregateOf('duration_ms')).toBe('min');
		expect(aggregateOf('waves')).toBe('max');
		expect(aggregateOf('g_laps')).toBe('sum');
		expect(combine('min', undefined, 4)).toBe(4);
		expect(combine('min', 2, 4)).toBe(2);
		expect(clampStat(Number.NaN)).toBe(0);
		expect(clampStat(1e12)).toBe(1_000_000);
	});

	it('picks a preset: the manifest’s, else the first genre’s, else arena', () => {
		expect(presetFor({ economy: { preset: 'racer' }, genres: ['action'] })).toBe('racer');
		expect(presetFor({ genres: ['idle', 'action'] })).toBe('idle');
		expect(presetFor({ genres: [] })).toBe('arena');
	});
});

describe('manifest economy block', () => {
	it('is optional, and accepted with declared keys', () => {
		expect(parseManifest(manifest(), 'bundle').ok).toBe(true);
		const r = parseManifest(
			manifest({
				economy: {
					preset: 'racer',
					stats: ['place', 'duration_ms', 'g_wheelies'],
					milestones: ['g_first_lap'],
					slots: ['bike_skin']
				}
			}),
			'bundle'
		);
		expect(r.ok).toBe(true);
	});

	it('refuses unknown presets, unprefixed game keys, duplicates and extra fields', () => {
		const issues = (economy: unknown) => {
			const r = ManifestEconomySchema.safeParse(economy);
			return r.success ? [] : r.error.issues.map((i) => i.path.join('.'));
		};
		expect(issues({ preset: 'mmo' })).toContain('preset');
		expect(issues({ stats: ['laps'] })).toContain('stats.0');
		expect(issues({ milestones: ['boss'] })).toContain('milestones.0');
		expect(issues({ stats: ['kills', 'kills'] })).toContain('stats');
		expect(issues({ currency: 'gold' })).toEqual(['']);
	});

	it('accepts the new race and trial modes', () => {
		const r = parseManifest(
			manifest({
				modes: ['race', 'trial', 'solo'],
				realtime: { kind: 'server', tickRate: 20, snapshotRate: 10, protocol: 1 },
				entry: { client: 'client.js', server: 'server.js' }
			}),
			'bundle'
		);
		expect(r.ok).toBe(true);
	});
});

describe('manifest config and attributes', () => {
	it('declares typed config with valid defaults, and attributes per item kind', () => {
		const ok = ManifestEconomySchema.safeParse({
			config: {
				'player.max_hp': { type: 'int', min: 1, max: 10000, default: 100 },
				'spell.fireball': {
					type: 'object',
					fields: { cost: 'int', damage: 'int' },
					default: { cost: 30, damage: 40 }
				},
				difficulty: { type: 'enum', values: ['easy', 'hard'], default: 'easy' }
			},
			attributes: { character: { hp: 'int', class: ['mage', 'tank'] } }
		});
		expect(ok.success).toBe(true);
		const paths = (config: object) => {
			const r = ManifestEconomySchema.safeParse({ config });
			return r.success ? [] : r.error.issues.map((x) => x.path.join('.'));
		};
		expect(paths({ 'player.max_hp': { type: 'int', min: 1, default: 0 } })).toEqual([
			'config.player.max_hp.default'
		]);
		expect(paths({ 'Bad.Key': { type: 'bool', default: true } })).toEqual(['config.Bad.Key']);
	});

	it('checks values against declarations', async () => {
		const { checkConfigValue, checkAttribute } = await import('./economy.ts');
		expect(checkConfigValue({ type: 'int', min: 1, max: 5, default: 1 }, 6)).toBe('at most 5');
		expect(checkConfigValue({ type: 'float', default: 1 }, 1.5)).toBeNull();
		expect(checkConfigValue({ type: 'list', of: 'int', max: 2, default: [] }, [1, 2, 3])).toBe(
			'a list of at most 2'
		);
		expect(
			checkConfigValue({ type: 'object', fields: { a: 'int' }, default: { a: 1 } }, { a: 1, b: 2 })
		).toBe('has fields the game does not declare');
		expect(checkAttribute(['mage', 'tank'], 'mage')).toBe(true);
		expect(checkAttribute('int', 1.5)).toBe(false);
	});
});
