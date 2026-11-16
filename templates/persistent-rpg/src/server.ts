/**
 * {{title}}: a persistent-RPG starter (docs: https://onecompanion.net/developers/guide#persistent-games).
 * One class, one crypt, one loot table and trades. Walk into a skeleton to hit it; skeletons drop potions and
 * swords from the `crypt` loot table in economy.json. The stairs take you to the next room with your character.
 *
 * The module never saves anything itself. `progression.ts` (the same helper every OneCompanion game uses) reports
 * XP and levels as `character` events and loot as `grant` events; the platform checks each against your published
 * ruleset, keeps it, and shows the player their loot and level-ups.
 *
 * Wire format. Client → server: [1][dir 0-3] move, [2] drink a potion.
 * Server → client: [16][JSON world] to everyone, [17][JSON you] to one player.
 */
import { createProgression, type Progression } from './progression.ts';
import type {
	GameContext,
	GameModule,
	PlayerId,
	RoomPlayer,
	RoomSettings
} from './server-contract.ts';

export const W = 16;
export const H = 10;
const STAIRS = { x: W - 2, y: H - 2 };
const DIRS = [
	[0, -1],
	[1, 0],
	[0, 1],
	[-1, 0]
] as const;

interface Hero {
	x: number;
	y: number;
	hp: number;
	moveCooldown: number;
	/** Potions this room has seen used (the platform removes them; the bag here follows at once). */
	used: Set<string>;
}
interface Skeleton {
	x: number;
	y: number;
	hp: number;
}

const enc = new TextEncoder();
const frame = (tag: number, value: unknown) => {
	const body = enc.encode(JSON.stringify(value));
	const out = new Uint8Array(body.length + 1);
	out[0] = tag;
	out.set(body, 1);
	return out;
};

export function createGameModule(): GameModule {
	let ctx: GameContext;
	let progress: Progression;
	let depth = 1;
	const heroes = new Map<PlayerId, Hero>();
	let skeletons: Skeleton[] = [];
	let sinceSpawn = 0;

	const bag = (id: PlayerId) => progress.items(id).filter((i) => !heroes.get(id)?.used.has(i.id));
	const send = (id: PlayerId) => {
		const h = heroes.get(id);
		if (h) ctx.sendTo(id, frame(17, { id, hp: h.hp, level: progress.level(id), items: bag(id) }));
	};
	const free = (x: number, y: number) =>
		x > 0 && y > 0 && x < W - 1 && y < H - 1 && !skeletons.some((s) => s.x === x && s.y === y);

	function spawn() {
		for (let n = 0; n < 20; n++) {
			const x = 1 + Math.floor(ctx.random() * (W - 2));
			const y = 1 + Math.floor(ctx.random() * (H - 2));
			if (free(x, y) && ![...heroes.values()].some((h) => h.x === x && h.y === y))
				return void skeletons.push({ x, y, hp: 2 + depth });
		}
	}

	function kill(id: PlayerId) {
		progress.award(id, 10 * depth);
		progress.count(id, 'kills');
		// What can drop and the roll ranges are yours (economy.json); the platform refuses anything else.
		const fire = 2 + Math.floor(ctx.random() * 7);
		if (
			!progress.drop(
				id,
				'crypt',
				{ base: 'short_sword', quality: 'magic', affixes: ['of_embers'], rolls: { fire } },
				0.1
			)
		)
			progress.drop(id, 'crypt', { base: 'potion', quality: 'normal' }, 0.25);
	}

	function move(id: PlayerId, h: Hero, dir: number) {
		const d = DIRS[dir];
		if (!d || h.moveCooldown > 0) return;
		h.moveCooldown = 0.15;
		const x = h.x + d[0];
		const y = h.y + d[1];
		const foe = skeletons.find((s) => s.x === x && s.y === y);
		if (foe) {
			const sword = bag(id).some((i) => i.base === 'short_sword');
			foe.hp -= 1 + Math.floor(progress.level(id) / 3) + (sword ? 1 : 0);
			if (foe.hp <= 0) {
				skeletons = skeletons.filter((s) => s !== foe);
				kill(id);
			}
			return;
		}
		if (x <= 0 || y <= 0 || x >= W - 1 || y >= H - 1) return;
		h.x = x;
		h.y = y;
		if (x === STAIRS.x && y === STAIRS.y)
			ctx.emit({ kind: 'travel', playerIds: [id], map: `depth-${depth + 1}` });
	}

	return {
		config: {
			gameId: '{{id}}',
			maxPlayers: 4,
			tickRate: 10,
			snapshotRate: 10,
			teams: [],
			modes: ['coop']
		},
		init(c, s: RoomSettings) {
			ctx = c;
			progress = createProgression(
				(e) => ctx.emit(e),
				() => ctx.random()
			);
			depth = Math.max(1, Number(/^depth-(\d+)$/.exec(s.map)?.[1] ?? 1));
			for (let i = 0; i < 4; i++) spawn();
		},
		onJoin(p: RoomPlayer) {
			progress.join(p);
			heroes.set(p.id, { x: 1, y: 1 + heroes.size, hp: 10, moveCooldown: 0, used: new Set() });
			send(p.id);
		},
		onLeave(id) {
			progress.leave(id);
			heroes.delete(id);
		},
		onInput(id, data) {
			const h = heroes.get(id);
			if (!h || data.length < 1) return; // validate everything a client sends
			if (data[0] === 1 && data.length === 2) move(id, h, data[1]!);
			else if (data[0] === 2) {
				const potion = bag(id).find((i) => i.base === 'potion');
				if (!potion || h.hp >= 10) return;
				h.used.add(potion.id);
				h.hp = 10;
				ctx.emit({ kind: 'consume', playerId: id, instanceId: potion.id });
				send(id);
			}
		},
		tick(dt) {
			for (const h of heroes.values()) h.moveCooldown = Math.max(0, h.moveCooldown - dt);
			sinceSpawn += dt;
			if (sinceSpawn > 4 && skeletons.length < 6) {
				sinceSpawn = 0;
				spawn();
			}
		},
		snapshot() {
			ctx.broadcast(
				frame(16, {
					depth,
					stairs: STAIRS,
					heroes: [...heroes.keys()].map((id) => ({
						id,
						...heroes.get(id)!,
						used: undefined,
						level: progress.level(id)
					})),
					skeletons
				})
			);
		},
		isIdle: () => heroes.size === 0,
		onPlatform(e) {
			progress.onPlatform(e);
			if (e.kind === 'granted') send(e.playerId);
			else for (const p of e.players) send(p);
		},
		// A checkpoint every 30 s: if the room restarts, the skeletons are where they were.
		checkpoint: () => enc.encode(JSON.stringify({ skeletons })),
		restore(bytes) {
			skeletons = (JSON.parse(new TextDecoder().decode(bytes)) as { skeletons: Skeleton[] })
				.skeletons;
		}
	};
}
