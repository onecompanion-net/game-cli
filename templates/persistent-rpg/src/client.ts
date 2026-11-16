/**
 * {{title}}: the client. Draws the crypt from the room's snapshots, sends moves, and shows your bag. Trades go
 * through the platform (`o.trade`): offer your first item to another player, both confirm, and the platform moves
 * it. The client never decides what anyone owns.
 */
import type { GameHandle, MountOptions, TradeState } from './contract.ts';

const TILE = 40;
const dec = new TextDecoder();

interface World {
	depth: number;
	stairs: { x: number; y: number };
	heroes: { id: string; x: number; y: number; level: number }[];
	skeletons: { x: number; y: number; hp: number }[];
}
interface You {
	id: string;
	hp: number;
	level: number;
	xp: number;
	items: { id: string; base: string; quality: string; rolls: Record<string, number> }[];
}

export async function mount(host: HTMLElement, o: MountOptions): Promise<GameHandle> {
	const root = document.createElement('div');
	root.dir = o.dir ?? 'ltr';
	root.style.cssText =
		'position:absolute;inset:0;display:grid;place-items:center;background:#0d0b12;color:#eee;font:14px system-ui';
	const canvas = document.createElement('canvas');
	canvas.width = 16 * TILE;
	canvas.height = 10 * TILE;
	canvas.style.cssText = 'max-inline-size:100%;max-block-size:70vh;image-rendering:pixelated';
	const panel = document.createElement('div');
	panel.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;align-items:center;padding:8px';
	root.append(canvas, panel);
	host.append(root);
	const g = canvas.getContext('2d')!;

	let world: World | null = null;
	let you: You | null = null;
	let trade: TradeState | null = null;
	let paused = false;
	const online = o.online;

	const button = (label: string, onClick: () => void) => {
		const b = document.createElement('button');
		b.textContent = label;
		b.onclick = onClick;
		return b;
	};
	function renderPanel() {
		panel.replaceChildren();
		const stats = document.createElement('span');
		stats.textContent = you
			? o.t('stats', { level: you.level, hp: you.hp, items: you.items.length })
			: o.t('waiting');
		panel.append(stats);
		if (!you || !world || !o.trade) return;
		const other = world.heroes.find((h) => h.id !== you!.id);
		if (
			trade &&
			trade.state !== 'done' &&
			trade.state !== 'cancelled' &&
			trade.state !== 'failed'
		) {
			const t = o.trade;
			const w = trade.with;
			panel.append(
				document.createTextNode(
					o.t('trade_open', {
						mine: trade.mine.instances.length,
						theirs: trade.theirs.instances.length
					})
				),
				button(o.t('confirm'), () => t.confirm(w)),
				button(o.t('cancel'), () => t.cancel(w))
			);
		} else if (other && you.items.length) {
			const t = o.trade;
			const first = you.items[0]!;
			panel.append(
				button(o.t('offer', { item: o.t(`item_${first.base}`) }), () =>
					t.offer(other.id, { instances: [first.id], currencies: {} })
				)
			);
		}
		if (trade?.state === 'done') panel.append(document.createTextNode(o.t('trade_done')));
		if (trade?.state === 'failed') panel.append(document.createTextNode(o.t('trade_failed')));
	}

	const offTrade = o.trade?.on((s) => {
		trade = s;
		renderPanel();
	});

	function draw() {
		g.fillStyle = '#16121f';
		g.fillRect(0, 0, canvas.width, canvas.height);
		if (!world) return;
		g.fillStyle = '#2a2238';
		for (let x = 0; x < 16; x++)
			for (let y = 0; y < 10; y++)
				if (x === 0 || y === 0 || x === 15 || y === 9) g.fillRect(x * TILE, y * TILE, TILE, TILE);
		g.fillStyle = '#c9a64a';
		g.fillRect(world.stairs.x * TILE + 8, world.stairs.y * TILE + 8, TILE - 16, TILE - 16);
		g.fillStyle = '#d8d0c0';
		for (const s of world.skeletons)
			g.fillRect(s.x * TILE + 10, s.y * TILE + 10, TILE - 20, TILE - 20);
		for (const h of world.heroes) {
			g.fillStyle = h.id === you?.id ? '#5ad1ff' : '#ff6f91';
			g.beginPath();
			g.arc(h.x * TILE + TILE / 2, h.y * TILE + TILE / 2, TILE / 3, 0, Math.PI * 2);
			g.fill();
		}
	}

	const KEYS: Record<string, number> = {
		ArrowUp: 0,
		ArrowRight: 1,
		ArrowDown: 2,
		ArrowLeft: 3,
		w: 0,
		d: 1,
		s: 2,
		a: 3
	};
	const onKey = (e: KeyboardEvent) => {
		if (paused || !online) return;
		const dir = KEYS[e.key];
		if (dir !== undefined) {
			e.preventDefault();
			online.send(new Uint8Array([1, dir])); // arrow keys are physical: no flip in RTL
		} else if (e.key === 'p') online.send(new Uint8Array([2]));
	};
	window.addEventListener('keydown', onKey);

	let raf = 0;
	const loop = () => {
		draw();
		raf = requestAnimationFrame(loop);
	};
	raf = requestAnimationFrame(loop);
	renderPanel();
	o.onEvent?.({ type: 'ready' });

	return {
		onMessage(bytes) {
			if (bytes[0] === 16) world = JSON.parse(dec.decode(bytes.subarray(1))) as World;
			else if (bytes[0] === 17) {
				you = JSON.parse(dec.decode(bytes.subarray(1))) as You;
				renderPanel();
			}
		},
		pause: () => void (paused = true),
		resume: () => void (paused = false),
		dispose() {
			cancelAnimationFrame(raf);
			window.removeEventListener('keydown', onKey);
			offTrade?.();
			root.remove();
		}
	};
}
