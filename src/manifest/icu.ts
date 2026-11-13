/**
 * The ICU MessageFormat subset hosted games may use in `messages/<locale>.json`: plain text, `{arg}`, and
 * `{arg, plural, ...}` / `{arg, select, ...}` with `=N`, `zero|one|two|few|many|other` and `#`. No markup, no
 * nested formatters beyond these. Upload validation parses every value; the frame's `t` formats with it.
 * Runtime-agnostic and dependency-free (it is bundled into the sandbox bridge).
 */

export type Part =
	| string
	| { arg: string }
	| { arg: string; type: 'plural' | 'select'; cases: Record<string, Part[]> }
	| { pound: true };

export class IcuError extends Error {}

const NAME = /^[A-Za-z_][A-Za-z0-9_]{0,31}$/;
const MAX_LEN = 2000;

/** Parse one message. Throws IcuError with a short reason. */
export function parseIcu(src: string): Part[] {
	if (src.length > MAX_LEN) throw new IcuError('too long');
	if (/[<>]/.test(src)) throw new IcuError('markup is not allowed');
	let i = 0;
	function text(inPlural: boolean, depth: number): Part[] {
		const out: Part[] = [];
		let buf = '';
		const flush = () => {
			if (buf) out.push(buf);
			buf = '';
		};
		while (i < src.length) {
			const c = src[i]!;
			if (c === "'") {
				// '' is a literal quote; '{...}' quotes syntax characters.
				if (src[i + 1] === "'") {
					buf += "'";
					i += 2;
					continue;
				}
				const end = src.indexOf("'", i + 1);
				if (end > i + 1 && /[{}#]/.test(src[i + 1]!)) {
					buf += src.slice(i + 1, end);
					i = end + 1;
					continue;
				}
				buf += c;
				i++;
				continue;
			}
			if (c === '}') {
				if (depth === 0) throw new IcuError('unbalanced }');
				break;
			}
			if (c === '#' && inPlural) {
				flush();
				out.push({ pound: true });
				i++;
				continue;
			}
			if (c === '{') {
				flush();
				i++;
				out.push(placeholder(depth + 1));
				continue;
			}
			buf += c;
			i++;
		}
		flush();
		return out;
	}
	function word(): string {
		while (src[i] === ' ') i++;
		const start = i;
		while (i < src.length && /[^\s,{}]/.test(src[i]!)) i++;
		const w = src.slice(start, i);
		while (src[i] === ' ') i++;
		return w;
	}
	function placeholder(depth: number): Part {
		if (depth > 4) throw new IcuError('nested too deeply');
		const arg = word();
		if (!NAME.test(arg)) throw new IcuError(`bad argument name "${arg}"`);
		if (src[i] === '}') {
			i++;
			return { arg };
		}
		if (src[i] !== ',') throw new IcuError(`expected , or } after ${arg}`);
		i++;
		const type = word();
		if (type !== 'plural' && type !== 'select') throw new IcuError(`unsupported format "${type}"`);
		if (src[i] !== ',') throw new IcuError(`expected , after ${type}`);
		i++;
		const cases: Record<string, Part[]> = {};
		for (;;) {
			const key = word();
			if (!key) break;
			const valid =
				type === 'plural' ? /^(=\d+|zero|one|two|few|many|other)$/ : /^[A-Za-z0-9_-]{1,32}$/;
			if (!valid.test(key)) throw new IcuError(`bad ${type} case "${key}"`);
			if (src[i] !== '{') throw new IcuError(`expected { after ${key}`);
			i++;
			cases[key] = text(type === 'plural', depth);
			if (src[i] !== '}') throw new IcuError('unclosed case');
			i++;
		}
		if (!cases.other) throw new IcuError(`${type} needs an "other" case`);
		while (src[i] === ' ') i++;
		if (src[i] !== '}') throw new IcuError(`unclosed {${arg}`);
		i++;
		return { arg, type, cases };
	}
	const parts = text(false, 0);
	if (i < src.length) throw new IcuError('unbalanced }');
	return parts;
}

/** The argument names a message uses, sorted (for key parity checks across locales). */
export function icuArgs(parts: Part[]): string[] {
	const names = new Set<string>();
	const walk = (ps: Part[]) => {
		for (const p of ps) {
			if (typeof p === 'string' || 'pound' in p) continue;
			names.add(p.arg);
			if ('cases' in p) for (const c of Object.values(p.cases)) walk(c);
		}
	};
	walk(parts);
	return [...names].sort();
}

export type Params = Readonly<Record<string, string | number>>;

/** Format parsed parts for a locale. Missing params render as empty strings. */
export function formatIcu(parts: Part[], params: Params = {}, locale = 'en'): string {
	let rules: Intl.PluralRules | null = null;
	const plural = (n: number) => (rules ??= new Intl.PluralRules(locale)).select(n);
	const num = (n: number) => new Intl.NumberFormat(locale).format(n);
	const run = (ps: Part[], pound: number | null): string => {
		let out = '';
		for (const p of ps) {
			if (typeof p === 'string') out += p;
			else if ('pound' in p) out += pound === null ? '#' : num(pound);
			else if (!('cases' in p)) {
				const v = params[p.arg];
				out += v === undefined ? '' : typeof v === 'number' ? num(v) : v;
			} else if (p.type === 'plural') {
				const n = Number(params[p.arg] ?? 0);
				const c = p.cases[`=${n}`] ?? p.cases[plural(n)] ?? p.cases.other!;
				out += run(c, n);
			} else {
				const c = p.cases[String(params[p.arg] ?? '')] ?? p.cases.other!;
				out += run(c, pound);
			}
		}
		return out;
	};
	return run(parts, null);
}

/** A `t` over a whole message table. Unknown or unparsable keys render as the key. */
export function translator(table: Readonly<Record<string, string>>, locale: string) {
	const cache = new Map<string, Part[] | null>();
	return (key: string, params?: Params): string => {
		if (!Object.prototype.hasOwnProperty.call(table, key)) return key;
		let parts = cache.get(key);
		if (parts === undefined) {
			try {
				parts = parseIcu(table[key]!);
			} catch {
				parts = null;
			}
			cache.set(key, parts);
		}
		return parts ? formatIcu(parts, params, locale) : key;
	};
}
