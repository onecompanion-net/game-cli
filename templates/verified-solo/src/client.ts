/**
 * {{title}}: catch TARGET sparks as fast as you can. Online (the `trial` mode), the room deals a seed, you play
 * the run here with no lag, and the room replays your inputs to check the time before it reaches the board. Solo is
 * practice: the same run, never submitted.
 */
import type { GameHandle, MountOptions } from './contract.ts';
import { encodeSegments, FIELD, Run, STEP_RATE, TARGET, type Dir } from './sim.ts';

/** Inputs per message: three bytes a segment, well under the room's 1 KB frames. */
const SEGMENTS_PER_PART = 300;

export async function mount(host: HTMLElement, o: MountOptions): Promise<GameHandle> {
	const root = document.createElement('div');
	root.dir = o.dir ?? 'ltr';
	root.style.cssText =
		'position:absolute;inset:0;display:grid;place-items:center;background:#0b1020;color:#eef;font:16px system-ui;touch-action:none';
	const canvas = document.createElement('canvas');
	canvas.width = 600;
	canvas.height = 600;
	canvas.style.cssText = 'max-inline-size:100%;max-block-size:80vh';
	const status = document.createElement('p');
	status.setAttribute('role', 'status');
	root.append(canvas, status);
	host.append(root);
	const g = canvas.getContext('2d')!;
	const online = o.online;

	let run: Run | null = null;
	let segments: [Dir, number][] = [];
	let held: Dir = 0;
	let paused = false;
	let acc = 0;
	let last = performance.now();
	let message = o.t(online ? 'waiting' : 'practice');

	function start(seed: number) {
		run = new Run(seed);
		segments = [];
		acc = 0;
		last = performance.now();
		message = o.t('go', { target: TARGET });
	}
	if (!online) start((Math.random() * 0xffffffff) >>> 0 || 1);

	function record(dir: Dir) {
		const tail = segments.at(-1);
		if (tail && tail[0] === dir && tail[1] < 0xffff) tail[1]++;
		else segments.push([dir, 1]);
	}

	function finish(r: Run) {
		if (!online) {
			message = o.t('practice_done', { seconds: (r.ms / 1000).toFixed(2) });
			o.onEvent?.({ type: 'complete', seconds: Math.round(r.ms / 1000) });
			setTimeout(() => start((Math.random() * 0xffffffff) >>> 0 || 1), 2500);
			return;
		}
		message = o.t('checking');
		for (let i = 0; i < segments.length; i += SEGMENTS_PER_PART) {
			const part = encodeSegments(segments.slice(i, i + SEGMENTS_PER_PART));
			const b = new Uint8Array(part.length + 1);
			b[0] = 2;
			b.set(part, 1);
			online.send(b);
		}
		online.send(new Uint8Array([3]));
		run = null;
	}

	const keys = new Set<string>();
	const dirOf = (): Dir => {
		const l = keys.has('ArrowLeft') || keys.has('a');
		const r = keys.has('ArrowRight') || keys.has('d');
		return l === r ? 0 : l ? -1 : 1;
	};
	const down = (e: KeyboardEvent) => void (keys.add(e.key), (held = dirOf()));
	const up = (e: KeyboardEvent) => void (keys.delete(e.key), (held = dirOf()));
	const point = (e: PointerEvent) => {
		const r = canvas.getBoundingClientRect();
		held = e.clientX - r.left < r.width / 2 ? -1 : 1;
	};
	const release = () => void (held = 0);
	window.addEventListener('keydown', down);
	window.addEventListener('keyup', up);
	canvas.addEventListener('pointerdown', point);
	window.addEventListener('pointerup', release);

	let raf = 0;
	const frame = (now: number) => {
		raf = requestAnimationFrame(frame);
		const dt = Math.min(0.25, (now - last) / 1000);
		last = now;
		if (run && !paused) {
			acc += dt;
			while (acc >= 1 / STEP_RATE && run && !run.done) {
				acc -= 1 / STEP_RATE;
				record(held);
				run.step(held);
				if (run.done) finish(run);
			}
		}
		draw();
	};
	raf = requestAnimationFrame(frame);

	function draw() {
		const k = canvas.width / FIELD;
		g.fillStyle = '#0b1020';
		g.fillRect(0, 0, canvas.width, canvas.height);
		if (run) {
			g.fillStyle = '#ffd36a';
			for (const s of run.sparks) g.fillRect(s.x * k - 6, s.y * k - 6, 12, 12);
			g.fillStyle = '#6ad5ff';
			g.fillRect(run.x * k - 70 * k, 920 * k, 140 * k, 10);
			status.textContent = `${message} · ${o.t('progress', { caught: run.caught, target: TARGET, seconds: (run.ms / 1000).toFixed(1) })}`;
		} else status.textContent = message;
	}

	o.onEvent?.({ type: 'ready' });
	return {
		onMessage(bytes) {
			const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
			if (bytes[0] === 1 && bytes.length === 5) start(dv.getUint32(1, true));
			else if (bytes[0] === 4 && bytes.length === 6) {
				const ms = dv.getUint32(2, true);
				message = bytes[1]
					? o.t('verified', { seconds: (ms / 1000).toFixed(2) })
					: o.t('not_verified');
				if (bytes[1]) o.onEvent?.({ type: 'complete', seconds: Math.round(ms / 1000) });
			}
		},
		pause: () => void (paused = true),
		resume: () => {
			paused = false;
			last = performance.now();
		},
		dispose() {
			cancelAnimationFrame(raf);
			window.removeEventListener('keydown', down);
			window.removeEventListener('keyup', up);
			window.removeEventListener('pointerup', release);
			root.remove();
		}
	};
}
