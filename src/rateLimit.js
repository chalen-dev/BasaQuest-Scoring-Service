// A small in-memory limit per signed-in user, so one account cannot spam the
// paid scoring call (Azure bills by the second). Counts reset when the service
// restarts, which is fine for a spending guard rather than an exact quota.
const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * 60_000;

/**
 * @param {{ perMinute: number, perDay: number }} limits
 */
export function createRateLimiter({ perMinute, perDay }) {
    /** @type {Map<string, number[]>} */
    const hits = new Map();
    return {
        /**
         * Counts one call for this user. Returns { ok: true } or
         * { ok: false, retryAfterSeconds } when a limit is reached.
         */
        take(userId, now = Date.now()) {
            const recent = (hits.get(userId) ?? []).filter((t) => now - t < DAY_MS);
            const inLastMinute = recent.filter((t) => now - t < MINUTE_MS);
            if (recent.length >= perDay) {
                const oldest = recent[0];
                hits.set(userId, recent);
                return { ok: false, retryAfterSeconds: Math.ceil((oldest + DAY_MS - now) / 1000), scope: 'day' };
            }
            if (inLastMinute.length >= perMinute) {
                hits.set(userId, recent);
                return { ok: false, retryAfterSeconds: Math.ceil((inLastMinute[0] + MINUTE_MS - now) / 1000), scope: 'minute' };
            }
            recent.push(now);
            hits.set(userId, recent);
            return { ok: true };
        },
    };
}
