/**
 * {{title}}: a lockstep starter where each player commands their own unit (src/sim.ts). In a room, the platform
 * orders every command and the simulation runs the same on every client; solo, this file runs a small local room
 * that does the same thing, so there is one code path. Lockstep rooms are client-authoritative, so they are unranked.
 */
import type { GameHandle, MountOptions } from './contract.ts';
import { LockstepClient } from './lockstep.ts';
import type { Roster } from './relay.ts';
import { moveCommand, Sim, STEP_RATE, WORLD } from './sim.ts';

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

	const sim = new Sim();
	let roster: Roster = { you: 0, host: 0, players: [] };
	let desynced = false;

	// Solo: a local room. It starts the simulation, ticks the step counter and stamps our commands, exactly as the
	// platform's room does, so the game cannot tell the difference.
	const local = !o.online;
	let localStep = 0;
	const localStart = performance.now();
	let pausedFor = 0;
	const send = (b: Uint8Array) => {
		if (!local) return o.online!.send(b);
		if (b[0] !== 0x01) return; // fingerprints have no one to compare with
		const out = new Uint8Array(b.length + 5);
		const dv = new DataView(out.buffer);
		out[0] = 0x01;
		dv.setUint32(1, localStep + 1, true);
		out[5] = 0; // slot 0: the only player
		out.set(b.subarray(1), 6);
		queueMicrotask(() => client.receive(out));
	};

	const client = new LockstepClient({
		sim,
		send,
		stepRate: STEP_RATE,
		onRoster: (r) => (roster = r),
		onDesync: () => (desynced = true)
	});

	if (local) {
		const start = new Uint8Array(13);
		const dv = new DataView(start.buffer);
		start[0] = 0x04;
		dv.setUint32(1, (Math.random() * 2 ** 32) >>> 0, true); // solo: any seed will do
		client.receive(start);
	}

	const onDown = (e: PointerEvent) => {
		if (paused || !client.started) return;
		const r = canvas.getBoundingClientRect();
		const s = Math.min(r.width, r.height);
		const ox = (r.width - s) / 2;
		const oy = (r.height - s) / 2;
		const x = ((e.clientX - r.left - ox) / s) * WORLD;
		const y = ((e.clientY - r.top - oy) / s) * WORLD;
		client.command(moveCommand(x, y));
	};
	canvas.addEventListener('pointerdown', onDown);

	let paused = false;
	let raf = 0;
	let readySent = false;

	function draw() {
		const w = canvas.width;
		const h = canvas.height;
		const px = devicePixelRatio;
		const s = Math.min(w, h);
		const ox = (w - s) / 2;
		const oy = (h - s) / 2;
		const at = (v: number) => (v / WORLD) * s;
		ctx.fillStyle = '#0b0f14';
		ctx.fillRect(0, 0, w, h);
		ctx.strokeStyle = '#26303a';
		ctx.lineWidth = 2 * px;
		ctx.strokeRect(ox, oy, s, s);
		ctx.fillStyle = '#ffffff';
		for (const b of sim.beacons) {
			ctx.beginPath();
			ctx.arc(ox + at(b.x), oy + at(b.y), 6 * px, 0, Math.PI * 2);
			ctx.fill();
		}
		const you = local ? 0 : roster.you;
		for (const [slot, u] of sim.units) {
			ctx.fillStyle = COLORS[slot % COLORS.length]!;
			ctx.beginPath();
			ctx.arc(ox + at(u.x), oy + at(u.y), (slot === you ? 14 : 11) * px, 0, Math.PI * 2);
			ctx.fill();
		}
		ctx.fillStyle = '#eef2f5';
		ctx.direction = o.dir ?? 'ltr';
		ctx.textAlign = 'center';
		ctx.font = `600 ${20 * px}px system-ui, sans-serif`;
		const mine = sim.units.get(you);
		ctx.fillText(mine ? o.t('score', { count: mine.score }) : o.t('hint'), w / 2, oy + 36 * px);
		if (desynced) ctx.fillText(o.t('desync'), w / 2, oy + 68 * px);
	}

	const frame = (now: number) => {
		if (local && !paused) {
			localStep = Math.floor(((now - localStart - pausedFor) / 1000) * STEP_RATE);
			const tick = new Uint8Array(5);
			new DataView(tick.buffer).setUint32(1, localStep, true);
			tick[0] = 0x03;
			client.receive(tick);
		}
		client.advance();
		draw();
		if (!readySent) {
			readySent = true;
			o.onEvent?.({ type: 'ready' });
			o.onEvent?.({ type: 'state', state: 'playing' });
		}
		raf = requestAnimationFrame(frame);
	};
	raf = requestAnimationFrame(frame);

	let pausedAt = 0;
	return {
		onMessage(bytes) {
			if (!local) client.receive(bytes); // never throws on malformed input
		},
		pause() {
			paused = true;
			pausedAt = performance.now();
		},
		resume() {
			if (paused) pausedFor += performance.now() - pausedAt;
			paused = false;
		},
		dispose() {
			cancelAnimationFrame(raf);
			ro.disconnect();
			canvas.removeEventListener('pointerdown', onDown);
			root.remove();
		}
	};
}
