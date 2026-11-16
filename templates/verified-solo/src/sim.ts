/**
 * {{title}}'s run, shared by the client and the server. The client plays it for real; the server replays the
 * same inputs from the same seed to check the time before it counts. So it must be deterministic: integers only,
 * the seed for randomness, no clocks, no Math.random(), no DOM.
 *
 * Catch TARGET falling sparks with your paddle as fast as you can.
 */

/** Steps per second (client and server agree; the run's time is steps / STEP_RATE). */
export const STEP_RATE = 20;
export const FIELD = 1000;
export const TARGET = 15;
/** A run longer than this is not checked (and cannot be submitted). */
export const MAX_STEPS = STEP_RATE * 180;
const SPEED = 25;
const FALL = 14;
const CATCH_Y = 920;
const CATCH_X = 70;

/** -1 left, 0 still, 1 right. */
export type Dir = -1 | 0 | 1;

export function mulberry32(seed: number) {
	let a = seed >>> 0;
	return () => {
		a = (a + 0x6d2b79f5) >>> 0;
		let t = a;
		t = Math.imul(t ^ (t >>> 15), t | 1);
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

export class Run {
	x = FIELD / 2;
	sparks: { x: number; y: number }[] = [];
	caught = 0;
	steps = 0;
	private rand: () => number;

	constructor(readonly seed: number) {
		this.rand = mulberry32(seed);
	}

	get done(): boolean {
		return this.caught >= TARGET;
	}

	step(dir: Dir): void {
		if (this.done || this.steps >= MAX_STEPS) return;
		this.steps++;
		this.x = Math.max(0, Math.min(FIELD, this.x + dir * SPEED));
		if (this.steps % 12 === 1)
			this.sparks.push({ x: 40 + Math.floor(this.rand() * (FIELD - 80)), y: 0 });
		const kept: { x: number; y: number }[] = [];
		for (const s of this.sparks) {
			s.y += FALL;
			if (s.y >= CATCH_Y && s.y < CATCH_Y + FALL && Math.abs(s.x - this.x) <= CATCH_X)
				this.caught++;
			else if (s.y < FIELD) kept.push(s);
		}
		this.sparks = kept;
	}

	/** The run's time, as the board shows it. */
	get ms(): number {
		return Math.round((this.steps * 1000) / STEP_RATE);
	}
}

/** Inputs as segments: [dir + 1 (u8), steps (u16)], three bytes each. */
export function encodeSegments(segments: readonly [Dir, number][]): Uint8Array {
	const out = new Uint8Array(segments.length * 3);
	segments.forEach(([dir, n], i) => {
		out[i * 3] = dir + 1;
		out[i * 3 + 1] = n & 0xff;
		out[i * 3 + 2] = n >>> 8;
	});
	return out;
}

export function decodeSegments(bytes: Uint8Array): [Dir, number][] | null {
	if (bytes.length % 3) return null;
	const out: [Dir, number][] = [];
	for (let i = 0; i < bytes.length; i += 3) {
		const d = bytes[i]! - 1;
		const n = bytes[i + 1]! | (bytes[i + 2]! << 8);
		if ((d !== -1 && d !== 0 && d !== 1) || n < 1) return null;
		out.push([d as Dir, n]);
	}
	return out;
}

/** Replay segments from a seed: the run, or null when it is too long. */
export function replay(seed: number, segments: readonly [Dir, number][]): Run | null {
	const run = new Run(seed);
	for (const [dir, n] of segments) {
		if (run.steps + n > MAX_STEPS) return null;
		for (let i = 0; i < n; i++) run.step(dir);
	}
	return run;
}
