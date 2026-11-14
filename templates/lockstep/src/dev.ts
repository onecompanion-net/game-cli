/**
 * Local dev host (`bun run dev`). It does what the platform does for your game, in a few lines: mounts it with your
 * messages and saved data. Not uploaded: the CLI builds only entry.client.
 *
 *   http://localhost:5191/             solo
 *   &lang=vi                           another locale        &dir=rtl   right-to-left layout
 *   &remount=1                         mount, dispose and mount again (checks dispose())
 *
 * Bun is the dev server even if you use npm for packages.
 */
import en from '../messages/en.json';
import { mount } from './client.ts';
import type { GameHandle, GameStorage, MountOptions } from './contract.ts';

// Add the locales you ship: import vi from '../messages/vi.json';
const tables: Record<string, Record<string, string>> = { en };

const q = new URLSearchParams(location.search);
const locale = q.get('lang') ?? 'en';
const table: Record<string, string> = tables[locale] ?? en;
const pr = new Intl.PluralRules(locale);

/** A small formatter for `{name}`, plural and select (the platform uses its full ICU subset). */
function t(key: string, params: Readonly<Record<string, string | number>> = {}): string {
	const src = table[key] ?? en[key as keyof typeof en] ?? key;
	return src
		.replace(
			/\{(\w+), (plural|select), ((?:[=\w-]+ \{[^}]*\}\s*)+)\}/g,
			(_m, k: string, type: string, cases: string) => {
				const v = params[k];
				const map = Object.fromEntries(
					[...cases.matchAll(/([=\w-]+) \{([^}]*)\}/g)].map((m) => [m[1], m[2]])
				);
				if (type === 'select') return map[String(v)] ?? map.other ?? '';
				const n = Number(v ?? 0);
				return (map[`=${n}`] ?? map[pr.select(n)] ?? map.other ?? '').replace(/#/g, String(n));
			}
		)
		.replace(/\{(\w+)\}/g, (_m, k: string) => String(params[k] ?? ''));
}

/**
 * No fake room here: a lockstep room orders every player's commands, which the platform does. Without
 * options.online the game runs its own local room (src/client.ts), so solo and the simulation work as on the
 * platform. Test real rooms with a studio preview on the platform.
 */
const online: MountOptions['online'] = undefined;
let deliver: (b: Uint8Array) => void = () => {};

/** On the platform, saved data is kept by the platform; here, this page's localStorage stands in for it. */
const ns = 'oc-dev:';
const storage: GameStorage = {
	get: async (k) => localStorage.getItem(ns + k),
	set: async (k, v) => localStorage.setItem(ns + k, v),
	delete: async (k) => localStorage.removeItem(ns + k),
	keys: async () =>
		Object.keys(localStorage)
			.filter((k) => k.startsWith(ns))
			.map((k) => k.slice(ns.length))
};

const options: MountOptions = {
	t,
	locale,
	dir: q.get('dir') === 'rtl' ? 'rtl' : 'ltr',
	...(online ? { online } : {}),
	storage,
	onEvent: (e) => console.info('[game event]', e)
};
const host = document.getElementById('host')!;
document.documentElement.dir = options.dir!;
document.documentElement.lang = locale;

let handle: GameHandle = await mount(host, options);
if (q.get('remount') === '1') {
	handle.dispose();
	console.info('[dev] disposed; host children left behind:', host.childElementCount);
	handle = await mount(host, options);
}
deliver = (b) => handle.onMessage(b);
document.addEventListener('visibilitychange', () =>
	document.hidden ? handle.pause() : handle.resume()
);
