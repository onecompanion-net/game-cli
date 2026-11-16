/**
 * Vendored from @onecompanion/room-runtime (progression.ts): keep it as is so your game earns XP and loot the same
 * way as every other game on the platform.
 *
 * Character progress for persistent games (docs/economy-plan.md, section 6d), the same in every game: XP and levels
 * on one curve, saves batched into `character` events, and loot as `grant` events with a unique `ref` each. Games
 * call it at their own moments (a beacon taken, a knock-out, a win); the platform checks and keeps everything.
 * Runtime-agnostic and deterministic: no clocks, no randomness of its own (pass `ctx.random`).
 *
 * In a room without characters (solo, tournaments, a game without the level) every call is a no-op, so games use
 * it unconditionally.
 */
import type {
	PlatformEvent,
	PlayerId,
	RoomCharacter,
	RoomEvent,
	RoomInstance,
	RoomPlayer
} from './server-contract.ts';

/** The shared level curve: level n needs 50·(n-1)² XP (1: 0, 2: 50, 3: 200, 10: 4050). */
export const levelForXp = (xp: number) => 1 + Math.floor(Math.sqrt(Math.max(0, xp) / 50));
/** Most XP one call may award (a module bug must not jump a character fifty levels). */
export const MAX_AWARD = 1000;

export interface LootItem {
	base: string;
	quality: 'normal' | 'magic' | 'rare' | 'set' | 'unique';
	affixes?: string[];
	rolls?: Record<string, number>;
	bound?: boolean;
}

interface Held {
	character: RoomCharacter;
	xp: number;
	level: number;
	state: Record<string, unknown>;
	items: RoomInstance[];
}

export interface Progression {
	/** Call from onJoin: remembers the player's character, if they brought one. */
	join(p: RoomPlayer): void;
	leave(id: PlayerId): void;
	/** The player has a character in this room. */
	has(id: PlayerId): boolean;
	level(id: PlayerId): number;
	items(id: PlayerId): readonly RoomInstance[];
	/** Add XP (and merge saved state fields); emits a save. Returns the new level, or null without a character. */
	award(id: PlayerId, xp: number, state?: Record<string, unknown>): number | null;
	/** Bump a numeric state field (`kills`, `beacons`) by `by`. */
	count(id: PlayerId, field: string, by?: number): void;
	/**
	 * Drop loot with probability `chance` from `table` at the character's level (clamped to the table by the
	 * platform's check). Returns the grant's ref, or null when nothing dropped.
	 */
	drop(id: PlayerId, table: string, item: LootItem, chance?: number): string | null;
	/** Pass the module's onPlatform events here so granted items are known to the room. */
	onPlatform(e: PlatformEvent): void;
}

export function createProgression(emit: (e: RoomEvent) => void, random: () => number): Progression {
	const held = new Map<PlayerId, Held>();
	let seq = 0;
	const save = (id: PlayerId, h: Held, keys: string[]) =>
		emit({
			kind: 'character',
			playerId: id,
			level: h.level,
			xp: h.xp,
			...(keys.length ? { state: Object.fromEntries(keys.map((k) => [k, h.state[k]])) } : {})
		});
	return {
		join(p) {
			const c = p.character;
			if (!c) return void held.delete(p.id);
			held.set(p.id, {
				character: c,
				xp: c.xp,
				level: c.level,
				state: { ...c.state },
				items: [...c.items]
			});
		},
		leave: (id) => void held.delete(id),
		has: (id) => held.has(id),
		level: (id) => held.get(id)?.level ?? 1,
		items: (id) => held.get(id)?.items ?? [],
		award(id, xp, state) {
			const h = held.get(id);
			if (!h) return null;
			h.xp += Math.max(0, Math.min(MAX_AWARD, Math.round(xp)));
			h.level = Math.max(h.level, levelForXp(h.xp));
			if (state) Object.assign(h.state, state);
			save(id, h, state ? Object.keys(state) : []);
			return h.level;
		},
		count(id, field, by = 1) {
			const h = held.get(id);
			if (!h) return;
			h.state[field] = (Number(h.state[field]) || 0) + by;
			save(id, h, [field]);
		},
		drop(id, table, item, chance = 1) {
			const h = held.get(id);
			if (!h || random() >= chance) return null;
			const ref = `drop-${++seq}-${Math.floor(random() * 1e9)}`;
			emit({
				kind: 'grant',
				playerId: id,
				ref,
				table,
				item: {
					base: item.base,
					quality: item.quality,
					level: h.level,
					...(item.affixes ? { affixes: item.affixes } : {}),
					...(item.rolls ? { rolls: item.rolls } : {}),
					...(item.bound ? { bound: true } : {})
				}
			});
			return ref;
		},
		onPlatform(e) {
			if (e.kind === 'granted') {
				if (e.item) held.get(e.playerId)?.items.push(e.item);
			} else if (e.kind === 'traded')
				for (const { id, to } of e.items) {
					const from = [...held.values()].find((h) => h.items.some((i) => i.id === id));
					const item = from?.items.find((i) => i.id === id);
					if (!from || !item) continue;
					from.items = from.items.filter((i) => i !== item);
					held.get(to)?.items.push(item);
				}
		}
	};
}
