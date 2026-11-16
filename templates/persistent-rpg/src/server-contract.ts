/**
 * The OneCompanion game contract (server half, level 5): the types the platform calls `server.ts` with. Types only:
 * the module imports nothing and runs in an isolate with no network and no storage. The platform owns characters
 * and items: the module reports what happened, the platform checks it against your ruleset and saves it.
 */
export type PlayerId = string;

export interface RoomInstance {
	readonly id: string;
	readonly base: string;
	readonly quality: string;
	readonly level: number;
	readonly affixes: readonly string[];
	readonly rolls: Readonly<Record<string, number>>;
	readonly bound: boolean;
	readonly location: string;
}

export interface RoomCharacter {
	readonly id: string;
	readonly name: string;
	readonly class: string;
	readonly level: number;
	readonly xp: number;
	readonly state: Readonly<Record<string, unknown>>;
	readonly hardcore: boolean;
	readonly season: string | null;
	readonly items: readonly RoomInstance[];
}

export interface RoomPlayer {
	readonly id: PlayerId;
	readonly displayName: string;
	readonly locale: string;
	readonly team: number | null;
	/** Always present in a persistent game's room: nobody joins without a character. */
	readonly character?: RoomCharacter;
}

export type RoomEvent =
	| { kind: 'notice'; key: string; params?: Record<string, string | number> }
	| {
			kind: 'character';
			playerId: PlayerId;
			level?: number;
			xp?: number;
			state?: Record<string, unknown>;
			dead?: boolean;
	  }
	| {
			kind: 'grant';
			playerId: PlayerId;
			ref: string;
			table: string;
			item: {
				base: string;
				quality: string;
				level: number;
				affixes?: string[];
				rolls?: Record<string, number>;
				bound?: boolean;
			};
	  }
	| { kind: 'consume'; playerId: PlayerId; instanceId: string }
	| { kind: 'travel'; playerIds: PlayerId[]; map: string; mode?: string };

export type PlatformEvent =
	| { kind: 'granted'; playerId: PlayerId; ref: string; item: RoomInstance | null; error?: string }
	| {
			kind: 'traded';
			players: readonly [PlayerId, PlayerId];
			items: readonly { id: string; to: PlayerId }[];
	  };

export interface GameContext {
	sendTo(id: PlayerId, data: Uint8Array): void;
	broadcast(data: Uint8Array): void;
	emit(event: RoomEvent): void;
	now(): number;
	/** Seeded per room: use it instead of Math.random so a room replays the same. */
	random(): number;
}

export interface RoomSettings {
	mode: string;
	map: string;
	maxPlayers: number;
	private: boolean;
	config?: Record<string, unknown>;
}

export interface GameModule {
	readonly config: {
		gameId: string;
		maxPlayers: number;
		tickRate: number;
		snapshotRate: number;
		teams: number[];
		modes: string[];
	};
	init(ctx: GameContext, settings: RoomSettings): void;
	onJoin(p: RoomPlayer): void;
	onLeave(id: PlayerId): void;
	onInput(id: PlayerId, data: Uint8Array): void;
	tick(dt: number): void;
	snapshot(): void;
	isIdle(): boolean;
	onPlatform?(event: PlatformEvent): void;
	checkpoint?(): Uint8Array | null;
	restore?(bytes: Uint8Array): void;
}
