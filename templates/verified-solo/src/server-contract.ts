/**
 * The OneCompanion game contract (server half): the types the platform calls `server.ts` with. Types only: the
 * module imports nothing and runs in an isolate with no network, no storage and no clock of its own.
 */
export type PlayerId = string;

export interface RoomPlayer {
	readonly id: PlayerId;
	readonly displayName: string;
	readonly locale: string;
	readonly team: number | null;
}

export interface MatchResult {
	winnerTeam: number | null;
	players: {
		playerId: PlayerId;
		team: number | null;
		score: number;
		stats: Record<string, number>;
	}[];
}

export type RoomEvent =
	| { kind: 'notice'; key: string; params?: Record<string, string | number> }
	| { kind: 'end'; result: MatchResult }
	| { kind: 'milestone'; playerId: PlayerId; key: string; value?: number };

export interface GameContext {
	sendTo(id: PlayerId, data: Uint8Array): void;
	broadcast(data: Uint8Array): void;
	emit(event: RoomEvent): void;
	now(): number;
	/** Seeded per room: use it instead of Math.random. */
	random(): number;
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
	init(
		ctx: GameContext,
		settings: { mode: string; map: string; maxPlayers: number; private: boolean }
	): void;
	onJoin(p: RoomPlayer): void;
	onLeave(id: PlayerId): void;
	onInput(id: PlayerId, data: Uint8Array): void;
	tick(dt: number): void;
	snapshot(): void;
	isIdle(): boolean;
}
