/**
 * {{title}}: a relay starter. Everyone in the room moves a light with their pointer and taps to send a ripple that
 * every player sees. The relay passes bytes between players; each client trusts its peers, so relay rooms are
 * unranked. Keep messages small, coalesce state (the latest position wins) and validate everything you receive.
 *
 * Wire format of this game's payloads (inside the relay's framing, see relay.ts):
 *   [0x01][x u16][y u16]   my light moved (x, y in 0..65535 across the play area)
 *   [0x02][x u16][y u16]   ripple at (x, y)
 */
import type { GameHandle, MountOptions } from './contract.ts';
import { fromRoom, rateLimited, toRoom, type Roster } from './relay.ts';

const SEND_EVERY_MS = 66; // about 15 position updates a second, well under the relay's 30
const COLORS = [
	'#ffcf5a',
	'#5ad1ff',
	'#ff6f91',
	'#8dff7a',
	'#c59bff',
	'#ff9a4d',
	'#5affd6',
	'#f2f2f2'
];

interface Light {
	x: number;
	y: number;
}
interface Ripple {
	x: number;
	y: number;
	age: number;
	slot: number;
}

export async function mount(host: HTMLElement, o: MountOptions): Promise<GameHandle> {
	const root = document.createElement('div');
	root.dir = o.dir ?? 'ltr';
	root.style.cssText =
		'position:absolute;inset:0;overflow:hidden;touch-action:none;user-select:none';
	const canvas = document.createElement('canvas');
	canvas.style.cssText = 'position:absolute;inset:0;inline-size:100%;block-size:100%';
	root.append(canvas);
	host.append(root);
	const ctx = canvas.getContext('2d')!;

	const resize = () => {
		canvas.width = Math.max(1, Math.round(root.clientWidth * devicePixelRatio));
		canvas.height = Math.max(1, Math.round(root.clientHeight * devicePixelRatio));
	};
	const ro = new ResizeObserver(resize);
	ro.observe(root);
	resize();

	let roster: Roster = { you: 0, host: 0, players: [] };
	const lights = new Map<number, Light>(); // by slot
	let ripples: Ripple[] = [];
	const me: Light = { x: 0.5, y: 0.5 };
	let dirty = false;
	const online = o.online; // absent in solo: never send then (sending in solo is a strike)
	const send = online ? rateLimited((b) => online.send(b)) : null;

	const encode = (type: number, x: number, y: number) => {
		const b = new Uint8Array(5);
		const dv = new DataView(b.buffer);
		b[0] = type;
		dv.setUint16(1, Math.round(clamp01(x) * 65535), true);
		dv.setUint16(3, Math.round(clamp01(y) * 65535), true);
		return b;
	};

	const toUnit = (e: PointerEvent) => {
		const r = canvas.getBoundingClientRect();
		return {
			x: clamp01((e.clientX - r.left) / r.width),
			y: clamp01((e.clientY - r.top) / r.height)
		};
	};
	const onMove = (e: PointerEvent) => {
		if (paused) return;
		Object.assign(me, toUnit(e));
		dirty = true;
	};
	const onDown = (e: PointerEvent) => {
		if (paused) return;
		const p = toUnit(e);
		ripples.push({ ...p, age: 0, slot: roster.you });
		send?.(toRoom(encode(0x02, p.x, p.y)));
	};
	canvas.addEventListener('pointermove', onMove);
	canvas.addEventListener('pointerdown', onDown);

	// Coalesced position updates: at most one per SEND_EVERY_MS, only when the light moved.
	const sender = setInterval(() => {
		if (!dirty || !send) return;
		dirty = false;
		send(toRoom(encode(0x01, me.x, me.y)));
	}, SEND_EVERY_MS);

	let paused = false;
	let last = performance.now();
	let raf = 0;
	let readySent = false;

	function draw(dt: number) {
		const w = canvas.width;
		const h = canvas.height;
		const px = devicePixelRatio;
		ctx.fillStyle = '#0d1117';
		ctx.fillRect(0, 0, w, h);
		for (const r of ripples) r.age += dt;
		ripples = ripples.filter((r) => r.age < 1.2);
		for (const r of ripples) {
			ctx.globalAlpha = 1 - r.age / 1.2;
			ctx.strokeStyle = COLORS[r.slot % COLORS.length]!;
			ctx.lineWidth = 3 * px;
			ctx.beginPath();
			ctx.arc(r.x * w, r.y * h, (10 + r.age * 120) * px, 0, Math.PI * 2);
			ctx.stroke();
		}
		ctx.globalAlpha = 1;
		const all: [number, Light][] = [...lights, [roster.you, me]];
		for (const [slot, l] of all) {
			ctx.fillStyle = COLORS[slot % COLORS.length]!;
			ctx.beginPath();
			ctx.arc(l.x * w, l.y * h, 14 * px, 0, Math.PI * 2);
			ctx.fill();
		}
		ctx.fillStyle = '#eef2f5';
		ctx.direction = o.dir ?? 'ltr';
		ctx.textAlign = 'center';
		ctx.font = `600 ${20 * px}px system-ui, sans-serif`;
		ctx.fillText(o.t('title'), w / 2, 40 * px);
		ctx.font = `${16 * px}px system-ui, sans-serif`;
		const count = Math.max(1, roster.players.length);
		ctx.fillText(o.online ? o.t('players', { count }) : o.t('hint_solo'), w / 2, 68 * px);
	}

	const frame = (now: number) => {
		const dt = Math.min(0.1, (now - last) / 1000);
		last = now;
		draw(paused ? 0 : dt);
		if (!readySent) {
			readySent = true;
			o.onEvent?.({ type: 'ready' });
			o.onEvent?.({ type: 'state', state: 'playing' });
		}
		raf = requestAnimationFrame(frame);
	};
	raf = requestAnimationFrame(frame);

	return {
		onMessage(bytes) {
			const msg = fromRoom(bytes);
			if (!msg) return; // malformed: drop, never throw
			if (msg.kind === 'roster') {
				roster = msg.roster;
				const present = new Set(roster.players.map((p) => p.slot));
				for (const slot of lights.keys()) if (!present.has(slot)) lights.delete(slot);
				dirty = true; // newcomers learn where we are
				return;
			}
			const p = msg.payload;
			if (p.length !== 5 || msg.from === roster.you) return;
			const dv = new DataView(p.buffer, p.byteOffset, p.byteLength);
			const x = dv.getUint16(1, true) / 65535;
			const y = dv.getUint16(3, true) / 65535;
			if (p[0] === 0x01) lights.set(msg.from, { x, y });
			else if (p[0] === 0x02) ripples.push({ x, y, age: 0, slot: msg.from });
		},
		pause() {
			paused = true;
		},
		resume() {
			paused = false;
			last = performance.now();
		},
		dispose() {
			cancelAnimationFrame(raf);
			clearInterval(sender);
			ro.disconnect();
			canvas.removeEventListener('pointermove', onMove);
			canvas.removeEventListener('pointerdown', onDown);
			root.remove();
		}
	};
}

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
