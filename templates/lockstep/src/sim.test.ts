import { describe, expect, it } from 'bun:test';
import { moveCommand, Sim, WORLD } from './sim.ts';

/** Run a simulation over a command log, the way every client in a room does. */
function run(
	seed: number,
	log: { step: number; slot: number; x: number; y: number }[],
	steps: number
) {
	const sim = new Sim();
	sim.reset(seed);
	for (let s = 1; s <= steps; s++) {
		sim.update();
		for (const c of log.filter((c) => c.step === s)) sim.apply(s, c.slot, moveCommand(c.x, c.y));
	}
	return sim;
}

describe('sim', () => {
	const log = [
		{ step: 1, slot: 0, x: 9_000, y: 9_000 },
		{ step: 1, slot: 2, x: 500, y: 800 },
		{ step: 40, slot: 0, x: 100, y: 5_000 },
		{ step: 90, slot: 2, x: WORLD, y: WORLD }
	];

	it('is deterministic: same seed and commands give the same state', () => {
		expect(run(7, log, 300).hash()).toBe(run(7, log, 300).hash());
		expect(run(7, log, 300).hash()).not.toBe(run(8, log, 300).hash());
	});

	it('gives each player their own unit, moving only on their commands', () => {
		const sim = run(7, log, 300);
		expect([...sim.units.keys()]).toEqual([0, 2]);
		expect(sim.units.get(2)).toMatchObject({ x: WORLD, y: WORLD });
	});

	it('ignores malformed commands', () => {
		const sim = new Sim();
		sim.reset(1);
		sim.apply(1, 0, new Uint8Array([0x09, 1, 2, 3, 4]));
		sim.apply(1, 0, new Uint8Array([0x01]));
		expect(sim.units.size).toBe(0);
	});
});
