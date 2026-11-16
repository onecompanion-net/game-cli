import { describe, expect, it } from 'bun:test';
import { createGameModule } from './server.ts';
import type { GameContext, RoomEvent } from './server-contract.ts';
import { decodeSegments, encodeSegments, Run, TARGET, type Dir } from './sim.ts';

/** A bot that chases the lowest spark: plays a run and keeps its inputs. */
function play(seed: number): { run: Run; segments: [Dir, number][] } {
	const run = new Run(seed);
	const segments: [Dir, number][] = [];
	while (!run.done && run.steps < 20_000) {
		const s = [...run.sparks].sort((a, b) => b.y - a.y)[0];
		const dir: Dir = !s || Math.abs(s.x - run.x) < 20 ? 0 : s.x < run.x ? -1 : 1;
		const tail = segments.at(-1);
		if (tail && tail[0] === dir) tail[1]++;
		else segments.push([dir, 1]);
		run.step(dir);
	}
	return { run, segments };
}

describe('{{title}}', () => {
	it('replays the same inputs to the same time', () => {
		const { run, segments } = play(42);
		expect(run.done).toBe(true);
		expect(decodeSegments(encodeSegments(segments))).toEqual(segments);
	});

	it('counts a real run and refuses a forged one', () => {
		const events: RoomEvent[] = [];
		const out: Uint8Array[] = [];
		const ctx: GameContext = {
			sendTo: (_, d) => void out.push(d),
			broadcast: () => {},
			emit: (e) => void events.push(e),
			now: () => 0,
			random: () => 0.25
		};
		const m = createGameModule();
		m.init(ctx, { mode: 'trial', map: 'default', maxPlayers: 1, private: false });
		m.onJoin({ id: 'p1', displayName: 'A', locale: 'en', team: null });
		const seed = new DataView(out[0]!.buffer).getUint32(1, true);
		const { run, segments } = play(seed);
		const part = encodeSegments(segments);
		m.onInput('p1', new Uint8Array([2, ...part]));
		m.onInput('p1', new Uint8Array([3]));
		const end = events.find((e) => e.kind === 'end');
		expect(end && end.kind === 'end' && end.result.players[0]!.stats.duration_ms).toBe(run.ms);
		expect(run.caught).toBe(TARGET);

		// The same inputs against the next seed (or a made-up short run) do not count.
		m.onInput('p1', new Uint8Array([2, ...encodeSegments([[0, 10]])]));
		m.onInput('p1', new Uint8Array([3]));
		expect(events.filter((e) => e.kind === 'end')).toHaveLength(1);
		expect(out.at(-2)![1]).toBe(0);
	});
});
