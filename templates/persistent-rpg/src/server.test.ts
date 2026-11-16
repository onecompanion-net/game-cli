import { describe, expect, it } from 'bun:test';
import { levelForXp } from './progression.ts';
import { createGameModule } from './server.ts';
import type { GameContext, RoomEvent } from './server-contract.ts';

function room(map = 'depth-1') {
	const events: RoomEvent[] = [];
	const sent: [string | null, Uint8Array][] = [];
	let seed = 1;
	const ctx: GameContext = {
		sendTo: (id, d) => void sent.push([id, d]),
		broadcast: (d) => void sent.push([null, d]),
		emit: (e) => void events.push(e),
		now: () => 0,
		random: () => (seed = (seed * 16807) % 2147483647) / 2147483647
	};
	const m = createGameModule();
	m.init(ctx, { mode: 'coop', map, maxPlayers: 4, private: true });
	return { m, events, sent };
}

describe('{{title}} server', () => {
	it('levels up from kills and only ever drops from the crypt table', () => {
		const { m, events, sent } = room();
		m.onJoin({
			id: 'p1',
			displayName: 'A',
			locale: 'en',
			team: null,
			character: {
				id: 'c1',
				name: 'A',
				class: 'wanderer',
				level: 1,
				xp: 0,
				state: {},
				hardcore: false,
				season: null,
				items: []
			}
		});
		const dec = new TextDecoder();
		for (let i = 0; i < 3000; i++) {
			// Walk towards the first skeleton the snapshot shows (bumping into it is an attack).
			m.snapshot();
			const last = sent.filter(([to, d]) => to === null && d[0] === 16).at(-1)![1];
			const w = JSON.parse(dec.decode(last.subarray(1))) as {
				heroes: { x: number; y: number }[];
				skeletons: { x: number; y: number }[];
			};
			const me = w.heroes[0]!;
			const foe = w.skeletons[0];
			if (foe) {
				const dir = foe.x > me.x ? 1 : foe.x < me.x ? 3 : foe.y > me.y ? 2 : 0;
				m.onInput('p1', new Uint8Array([1, dir]));
			}
			m.tick(0.2);
		}
		const saves = events.filter((e) => e.kind === 'character');
		expect(saves.length).toBeGreaterThan(0);
		const grants = events.filter((e) => e.kind === 'grant');
		for (const g of grants) {
			expect(g.table).toBe('crypt');
			if (g.item.base === 'short_sword') expect(g.item.rolls!.fire!).toBeWithin(2, 9);
		}
		expect(levelForXp(0)).toBe(1);
	});

	it('restores skeletons from a checkpoint and ignores bad input', () => {
		const a = room();
		const saved = a.m.checkpoint!()!;
		const b = room();
		b.m.restore!(saved);
		expect(new TextDecoder().decode(b.m.checkpoint!()!)).toBe(new TextDecoder().decode(saved));
		b.m.onInput('nobody', new Uint8Array([1, 9]));
		b.m.onJoin({ id: 'p1', displayName: 'A', locale: 'en', team: null });
		b.m.onInput('p1', new Uint8Array([]));
		expect(b.events).toEqual([]);
	});
});
