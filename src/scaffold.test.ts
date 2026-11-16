import { afterAll, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { LISTING_LOCALES } from './manifest/index.ts';
import { pack } from './index.ts';
import { i18n, init, TEMPLATES } from './scaffold.ts';

const root = await mkdtemp(join(tmpdir(), 'oc-scaffold-'));
afterAll(() => rm(root, { recursive: true, force: true }));
const readJson = async (p: string) =>
	JSON.parse(await readFile(p, 'utf8')) as Record<string, unknown>;
/** A file as a translator leaves it: the marker removed. */
const translated = async (p: string) => {
	const o = await readJson(p);
	delete o.$untranslated;
	return o;
};

describe('init', () => {
	for (const template of TEMPLATES)
		it(`writes a ${template} game that validates as generated`, async () => {
			const dir = join(root, `game-${template}`);
			const r = await init(dir, { template, studio: 'acme' });
			expect(r.files).toContain('game.json');
			expect(r.files).toContain('.gitignore');
			const m = await readJson(join(dir, 'game.json'));
			expect(m).toMatchObject({
				id: `game-${template}`,
				title: `Game ${template
					.split('-')
					.map((w) => w[0]!.toUpperCase() + w.slice(1))
					.join(' ')}`,
				studio: 'acme'
			});
			expect((await readFile(join(dir, 'src/client.ts'), 'utf8')).includes('{{')).toBe(false);
			// A lockstep room sends ticks every step, not once a second.
			if (template === 'lockstep')
				expect(m.realtime).toMatchObject({ tickRate: 15, snapshotRate: 15 });
			const lenient = await pack(dir, undefined, { allowUntranslated: true });
			expect(lenient.report.issues).toEqual([]);
			// Uploads refuse the English copies until they are translated.
			expect(lenient.report.untranslated).toHaveLength(LISTING_LOCALES.length - 1);
			expect((await pack(dir)).report.ok).toBe(false);
			// The generated TypeScript type-checks with the game's own tsconfig.
			const types = dirname(dirname(Bun.resolveSync('@types/bun/package.json', import.meta.dir)));
			await symlink(dirname(types), join(dir, 'node_modules'));
			const tsc = Bun.spawnSync(
				['bun', Bun.resolveSync('typescript/bin/tsc', import.meta.dir), '-p', dir],
				{ stdout: 'pipe' }
			);
			expect(tsc.stdout.toString()).toBe('');
			expect(tsc.exitCode).toBe(0);
			await rm(join(dir, 'node_modules'));
		}, 30_000);

	it('refuses a folder that is not empty and a bad id', async () => {
		const dir = join(root, 'game-solo');
		await expect(init(dir, { template: 'solo' })).rejects.toThrow('not empty');
		await expect(init(join(root, 'x'), { template: 'solo', id: '9lives' })).rejects.toThrow(
			'game id'
		);
	});
});

describe('i18n', () => {
	it('adds languages as marked copies, never overwrites translations, and syncs new keys', async () => {
		const dir = join(root, 'game-relay');
		// A translator finished French: it is no longer marked.
		const fr = join(dir, 'listing/fr.json');
		await writeFile(fr, JSON.stringify({ ...(await translated(fr)), tagline: 'Un jeu.' }));

		const r = await i18n(dir, { locales: ['vi'] });
		expect((await readJson(join(dir, 'game.json'))).locales).toEqual(['en', 'vi']);
		expect(r.created).toEqual(['messages/vi.json']);
		expect(r.untranslated.map((f) => f.path)).not.toContain('listing/fr.json');
		expect(r.untranslated.map((f) => f.path)).toContain('messages/vi.json');
		expect(r.prompt).toContain('messages/vi.json: Vietnamese (vi)');
		expect((await readJson(fr)).tagline).toBe('Un jeu.');

		// English gains a key: translated files get only that key, marked with it.
		const en = join(dir, 'messages/en.json');
		await writeFile(en, JSON.stringify({ ...(await readJson(en)), bye: 'Goodbye' }));
		const vi = join(dir, 'messages/vi.json');
		await writeFile(vi, JSON.stringify({ ...(await translated(vi)), title: 'Trò chơi' }));
		const again = await i18n(dir);
		expect(again.created).toEqual(['messages/vi.json']);
		const synced = await readJson(vi);
		expect(synced).toMatchObject({ $untranslated: ['bye'], bye: 'Goodbye', title: 'Trò chơi' });
		expect(again.untranslated.find((f) => f.path === 'messages/vi.json')?.keys).toEqual(['bye']);
	});

	it('rejects unknown locales', async () => {
		await expect(i18n(join(root, 'game-relay'), { locales: ['xx'] })).rejects.toThrow(
			'unknown locale'
		);
	});
});
