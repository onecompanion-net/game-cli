/**
 * {{title}}'s verifier: the smallest server module that makes a solo game ranked. It plays nothing live. It deals
 * each run a seed, takes the run's inputs when the player finishes, replays them with the same code the client
 * ran (sim.ts), and reports the checked time as a MatchResult. A run that does not replay to a finish never counts.
 *
 * Wire format. Server → client: [1][seed u32] a new run, [4][ok u8][ms u32] the verdict.
 * Client → server: [2][segments…] part of the run's inputs (any number of parts), [3] the run is over.
 */
import type { GameContext, GameModule, PlayerId } from './server-contract.ts';
import { decodeSegments, replay, TARGET, type Dir } from './sim.ts';

/** Most inputs one run may send: the client coalesces held keys, so a real run is far smaller. */
const MAX_SEGMENTS = 4000;

interface Pending {
	seed: number;
	segments: [Dir, number][];
	bad: boolean;
}

export function createGameModule(): GameModule {
	let ctx: GameContext;
	const runs = new Map<PlayerId, Pending>();

	function deal(id: PlayerId) {
		const seed = Math.floor(ctx.random() * 0xffffffff) >>> 0 || 1;
		runs.set(id, { seed, segments: [], bad: false });
		const b = new Uint8Array(5);
		b[0] = 1;
		new DataView(b.buffer).setUint32(1, seed, true);
		ctx.sendTo(id, b);
	}

	function verdict(id: PlayerId, ok: boolean, ms: number) {
		const b = new Uint8Array(6);
		b[0] = 4;
		b[1] = ok ? 1 : 0;
		new DataView(b.buffer).setUint32(2, ms, true);
		ctx.sendTo(id, b);
	}

	return {
		config: {
			gameId: '{{id}}',
			maxPlayers: 1,
			tickRate: 1,
			snapshotRate: 1,
			teams: [],
			modes: ['trial']
		},
		init(c) {
			ctx = c;
		},
		onJoin(p) {
			deal(p.id);
		},
		onLeave(id) {
			runs.delete(id);
		},
		onInput(id, data) {
			const run = runs.get(id);
			if (!run || data.length < 1) return;
			if (data[0] === 2) {
				const part = decodeSegments(data.subarray(1));
				if (!part || run.segments.length + part.length > MAX_SEGMENTS) run.bad = true;
				else run.segments.push(...part);
				return;
			}
			if (data[0] !== 3) return;
			const done = run.bad ? null : replay(run.seed, run.segments);
			if (done && done.done) {
				ctx.emit({
					kind: 'end',
					result: {
						winnerTeam: null,
						players: [
							{ playerId: id, team: null, score: done.caught, stats: { duration_ms: done.ms } }
						]
					}
				});
				ctx.emit({ kind: 'milestone', playerId: id, key: 'g_full_run', value: TARGET });
				verdict(id, true, done.ms);
			} else verdict(id, false, 0);
			deal(id); // the next run gets a new seed
		},
		tick() {},
		snapshot() {},
		isIdle: () => runs.size === 0
	};
}
