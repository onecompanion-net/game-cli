/**
 * Preview tokens (docs/marketplace-plan.md, section 4.2): the sandbox serves an unpublished version only under a
 * short-lived token, minted by apps/web for the studio's members and by apps/admin for reviewers. HMAC-SHA256 over
 * `game:version:expiry` with PREVIEW_SECRET; the token is URL-safe and goes in the path (`/p/<token>/...`) so the
 * frame's relative module imports keep it without cookies.
 */

const enc = new TextEncoder();

async function hmac(secret: string, data: string): Promise<string> {
	const key = await crypto.subtle.importKey(
		'raw',
		enc.encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign']
	);
	const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(data)));
	return b64url(sig);
}

function b64url(b: Uint8Array): string {
	let s = '';
	for (const x of b) s += String.fromCharCode(x);
	return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/** A token for one version of one game, valid for `ttlS` seconds (default one hour). */
export async function signPreview(
	secret: string,
	gameId: string,
	versionId: string,
	now = Date.now(),
	ttlS = 3600
): Promise<string> {
	const exp = Math.floor(now / 1000) + ttlS;
	return `${exp.toString(36)}.${await hmac(secret, `${gameId}:${versionId}:${exp}`)}`;
}

export async function verifyPreview(
	secret: string,
	token: string,
	gameId: string,
	versionId: string,
	now = Date.now()
): Promise<boolean> {
	const m = /^([0-9a-z]{1,10})\.([A-Za-z0-9_-]{43})$/.exec(token);
	if (!m || !secret) return false;
	const exp = parseInt(m[1]!, 36);
	if (!Number.isFinite(exp) || exp * 1000 < now) return false;
	const expected = await hmac(secret, `${gameId}:${versionId}:${exp}`);
	// Constant-time compare.
	let diff = expected.length ^ m[2]!.length;
	for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ m[2]!.charCodeAt(i);
	return diff === 0;
}

/** What the sandbox reads per game (R2 `games/<id>/status.json`, written by apps/web, apps/admin and realtime). */
export interface SandboxStatus {
	/** Suspended games answer 451 to everything (the kill switch). */
	suspended: boolean;
	/** The published version, or null. */
	published: string | null;
	/** Versions served without a token: the published one and recently superseded ones (rooms still open). */
	served: string[];
}

export const EMPTY_STATUS: SandboxStatus = { suspended: false, published: null, served: [] };

/** Version ids are ULID-like: 26 characters of Crockford base32, lowercased. */
export const VERSION_ID = /^[0-9a-hjkmnp-tv-z]{26}$/;

const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz';

/** A new version id: 10 characters of time (ms) then 16 random, so ids sort by creation. */
export function newVersionId(now = Date.now()): string {
	let t = now;
	let time = '';
	for (let i = 0; i < 10; i++) {
		time = CROCKFORD[t % 32]! + time;
		t = Math.floor(t / 32);
	}
	const rnd = crypto.getRandomValues(new Uint8Array(16));
	return time + [...rnd].map((b) => CROCKFORD[b % 32]).join('');
}
