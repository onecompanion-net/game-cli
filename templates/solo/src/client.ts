/**
 * {{title}}: a solo starter. Tap or click the sparks before they fade; your best score is saved.
 *
 * The rules every game follows on OneCompanion: draw only inside `host`, every string through `o.t`, saves through
 * `o.storage`, assets via `new URL(imported, import.meta.url)`, and `dispose()` undoes everything `mount()` did.
 * Replace the game; keep the shape.
 */
import type { GameHandle, MountOptions } from './contract.ts';

const SAVE_KEY = 'save';
const SAVE_VERSION = 1;
const ROUND_SECONDS = 30;

interface Spark {
	x: number;
	y: number;
	life: number;
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

	let save = { v: SAVE_VERSION, best: 0 };
	try {
		const raw = await o.storage?.get(SAVE_KEY);
		const parsed = raw ? (JSON.parse(raw) as Partial<typeof save>) : null;
		if (parsed?.v === SAVE_VERSION) save = { ...save, ...parsed };
	} catch {
		/* nothing saved, or an older format: start fresh */
	}
	const persist = () => void o.storage?.set(SAVE_KEY, JSON.stringify(save)).catch(() => {});

	const resize = () => {
		canvas.width = Math.max(1, Math.round(root.clientWidth * devicePixelRatio));
		canvas.height = Math.max(1, Math.round(root.clientHeight * devicePixelRatio));
	};
	const ro = new ResizeObserver(resize);
	ro.observe(root);
	resize();

	// Game state, in 0..1 coordinates so it does not depend on the screen size.
	let sparks: Spark[] = [];
	let score = 0;
	let left = 0;
	let playing = false;
	let spawn = 0;

	const start = () => {
		sparks = [];
		score = 0;
		left = ROUND_SECONDS;
		playing = true;
		o.onEvent?.({ type: 'state', state: 'playing' });
	};
	const finish = () => {
		playing = false;
		if (score > save.best) {
			save.best = score;
			persist();
		}
		o.onEvent?.({ type: 'complete', seconds: ROUND_SECONDS });
		o.onEvent?.({ type: 'state', state: 'menu' });
	};

	const onPointer = (e: PointerEvent) => {
		if (paused) return;
		if (!playing) return start();
		const r = canvas.getBoundingClientRect();
		const x = (e.clientX - r.left) / r.width;
		const y = (e.clientY - r.top) / r.height;
		const hit = sparks.findIndex((s) => Math.hypot((s.x - x) * r.width, (s.y - y) * r.height) < 36);
		if (hit >= 0) {
			sparks.splice(hit, 1);
			score++;
		}
	};
	canvas.addEventListener('pointerdown', onPointer);

	// Fixed-step update, drawn every animation frame.
	const STEP = 1 / 60;
	let paused = false;
	let acc = 0;
	let last = performance.now();
	let raf = 0;
	let readySent = false;

	function update(dt: number) {
		if (!playing) return;
		left -= dt;
		if (left <= 0) return finish();
		spawn -= dt;
		if (spawn <= 0) {
			spawn = 0.6;
			sparks.push({ x: 0.1 + Math.random() * 0.8, y: 0.2 + Math.random() * 0.65, life: 1.6 });
		}
		for (const s of sparks) s.life -= dt;
		sparks = sparks.filter((s) => s.life > 0);
	}

	function draw() {
		const w = canvas.width;
		const h = canvas.height;
		const px = devicePixelRatio;
		ctx.fillStyle = '#101418';
		ctx.fillRect(0, 0, w, h);
		for (const s of sparks) {
			ctx.globalAlpha = Math.min(1, s.life);
			ctx.fillStyle = '#ffcf5a';
			ctx.beginPath();
			ctx.arc(s.x * w, s.y * h, 18 * px, 0, Math.PI * 2);
			ctx.fill();
		}
		ctx.globalAlpha = 1;
		ctx.fillStyle = '#eef2f5';
		ctx.direction = o.dir ?? 'ltr';
		ctx.textAlign = 'center';
		ctx.font = `600 ${22 * px}px system-ui, sans-serif`;
		if (playing) {
			ctx.fillText(o.t('score', { count: score }), w / 2, 40 * px);
			ctx.fillText(o.t('time_left', { seconds: Math.ceil(left) }), w / 2, 72 * px);
		} else {
			ctx.fillText(o.t('title'), w / 2, h / 2 - 30 * px);
			ctx.font = `${17 * px}px system-ui, sans-serif`;
			ctx.fillText(o.t('hint'), w / 2, h / 2 + 4 * px);
			ctx.fillText(o.t('best', { count: save.best }), w / 2, h / 2 + 34 * px);
		}
	}

	const frame = (now: number) => {
		acc += Math.min(0.25, (now - last) / 1000);
		last = now;
		if (paused) acc = 0;
		while (acc >= STEP) {
			update(STEP);
			acc -= STEP;
		}
		draw();
		if (!readySent) {
			readySent = true;
			o.onEvent?.({ type: 'ready' }); // after the first frame is on screen
			o.onEvent?.({ type: 'state', state: 'menu' });
		}
		raf = requestAnimationFrame(frame);
	};
	raf = requestAnimationFrame(frame);

	return {
		onMessage() {
			/* solo: no room */
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
			ro.disconnect();
			canvas.removeEventListener('pointerdown', onPointer);
			root.remove();
		}
	};
}
