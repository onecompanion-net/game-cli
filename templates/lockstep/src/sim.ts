/**
 * {{title}}'s simulation: each player commands their own unit. Click to send your unit somewhere; units collect
 * beacons for their player. Every client runs this same code on the same commands in the same order, so it must be
 * deterministic: integers only, the room's seed for randomness, no clocks, no Math.random(), no DOM.
 *
 * Commands (what a player sends; at most 256 bytes):
 *   [0x01][x u16][y u16]   move my unit to (x, y), in world units (0..WORLD)
 */
import { fnv1a, mulberry32, type Simulation } from './lockstep.ts';

/** Steps per second. Must equal realtime.tickRate in game.json. */
export const STEP_RATE = 15;
export const WORLD = 10_000;
export const BEACONS = 5;
const SPEED = 140; // world units per step
const PICKUP = 360; // pickup radius

export interface Unit {
	x: number;
	y: number;
	tx: number;
	ty: number;
	score: number;
}

export class Sim implements Simulation {
	units = new Map<number, Unit>(); // by room slot
	beacons: { x: number; y: number }[] = [];
	private rand: () => number = mulberry32(0);

	reset(seed: number): void {
		this.rand = mulberry32(seed);
		this.units.clear();
		this.beacons = Array.from({ length: BEACONS }, () => this.place());
	}

	update(): void {
		for (const slot of [...this.units.keys()].sort((a, b) => a - b)) {
			const u = this.units.get(slot)!;
			const dx = u.tx - u.x;
			const dy = u.ty - u.y;
			const d = isqrt(dx * dx + dy * dy); // not Math.hypot: its rounding may differ between browsers
			if (d <= SPEED) {
				u.x = u.tx;
				u.y = u.ty;
			} else {
				// Truncate to integers so every client lands on exactly the same position.
				u.x += Math.trunc((dx * SPEED) / d);
				u.y += Math.trunc((dy * SPEED) / d);
			}
			for (let i = 0; i < this.beacons.length; i++) {
				const b = this.beacons[i]!;
				if ((b.x - u.x) ** 2 + (b.y - u.y) ** 2 <= PICKUP * PICKUP) {
					u.score++;
					this.beacons[i] = this.place();
				}
			}
		}
	}

	apply(_step: number, slot: number, c: Uint8Array): void {
		if (c.length !== 5 || c[0] !== 0x01) return; // malformed: ignore
		const dv = new DataView(c.buffer, c.byteOffset, c.byteLength);
		const tx = Math.min(WORLD, dv.getUint16(1, true));
		const ty = Math.min(WORLD, dv.getUint16(3, true));
		let u = this.units.get(slot);
		if (!u) {
			// A player's unit appears with their first command, at a spot that depends only on their slot.
			const x = 1_000 + ((slot * 1_700) % 8_000);
			u = { x, y: WORLD / 2, tx: x, ty: WORLD / 2, score: 0 };
			this.units.set(slot, u);
		}
		u.tx = tx;
		u.ty = ty;
	}

	hash(): number {
		const values: number[] = [];
		for (const slot of [...this.units.keys()].sort((a, b) => a - b)) {
			const u = this.units.get(slot)!;
			values.push(slot, u.x, u.y, u.tx, u.ty, u.score);
		}
		for (const b of this.beacons) values.push(b.x, b.y);
		return fnv1a(values);
	}

	private place() {
		return {
			x: 500 + Math.floor(this.rand() * (WORLD - 1_000)),
			y: 500 + Math.floor(this.rand() * (WORLD - 1_000))
		};
	}
}

/** Integer square root (floor), the same on every engine. */
export function isqrt(n: number): number {
	if (n < 2) return n;
	let x = n;
	let y = Math.floor((x + 1) / 2);
	while (y < x) {
		x = y;
		y = Math.floor((x + Math.floor(n / x)) / 2);
	}
	return x;
}

/** A move command for `Sim.apply`. */
export function moveCommand(x: number, y: number): Uint8Array {
	const b = new Uint8Array(5);
	const dv = new DataView(b.buffer);
	b[0] = 0x01;
	dv.setUint16(1, Math.max(0, Math.min(WORLD, Math.round(x))), true);
	dv.setUint16(3, Math.max(0, Math.min(WORLD, Math.round(y))), true);
	return b;
}
