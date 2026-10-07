// Storage adapter. Works with whichever Redis you connect on Vercel:
//
//   * Upstash for Redis (Vercel Marketplace) -> KV_REST_API_URL + KV_REST_API_TOKEN
//     (or UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN). Uses the HTTP client.
//   * Redis / Redis Cloud (Vercel Marketplace) or any other Redis -> REDIS_URL
//     (or KV_URL). Uses the standard `redis` TCP client.
//   * Nothing configured, running locally -> an in-memory store, so
//     `npm run dev` works without any setup (games vanish on restart).
//
// Only three operations are needed: get, set-if-absent, and compare-and-set.
// Compare-and-set is a tiny Lua script, so two requests can never both
// overwrite the same game at once.

const CAS_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('SET', KEYS[1], ARGV[2], 'EX', tonumber(ARGV[3]))
  return 1
end
return 0`;

const env = process.env;
const restUrl = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
const restToken = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
const tcpUrl = env.REDIS_URL || env.KV_URL;

let storePromise = null;
export function getStore() {
  if (!storePromise) storePromise = makeStore().catch(err => { storePromise = null; throw err; });
  return storePromise;
}

async function makeStore() {
  if (restUrl && restToken) return upstashStore();
  if (tcpUrl) return tcpStore();
  if (env.VERCEL) {
    throw Object.assign(new Error(
      'No Redis database is connected. In Vercel, open your project → Storage, add a Redis database, connect it to this project, then redeploy.'
    ), { status: 503 });
  }
  return memoryStore();
}

async function upstashStore() {
  const { Redis } = await import('@upstash/redis');
  // automaticDeserialization:false -> we always get back the exact JSON string we stored,
  // which the compare-and-set relies on.
  const redis = new Redis({ url: restUrl, token: restToken, automaticDeserialization: false });
  return {
    kind: 'upstash',
    get: k => redis.get(k),
    setNX: async (k, v, ttl) => (await redis.set(k, v, { nx: true, ex: ttl })) === 'OK',
    cas: async (k, oldV, newV, ttl) => Number(await redis.eval(CAS_SCRIPT, [k], [oldV, newV, String(ttl)])) === 1,
  };
}

let tcpClient = null;
async function tcpStore() {
  const { createClient } = await import('redis');
  if (!tcpClient) {
    tcpClient = createClient({ url: tcpUrl, socket: { connectTimeout: 8000 } });
    tcpClient.on('error', err => console.error('[redis]', err.message));
  }
  if (!tcpClient.isOpen) await tcpClient.connect();
  const c = tcpClient;
  return {
    kind: 'redis',
    get: k => c.get(k),
    setNX: async (k, v, ttl) => (await c.set(k, v, { NX: true, EX: ttl })) === 'OK',
    cas: async (k, oldV, newV, ttl) =>
      Number(await c.eval(CAS_SCRIPT, { keys: [k], arguments: [oldV, newV, String(ttl)] })) === 1,
  };
}

function memoryStore() {
  console.warn('[store] No Redis configured — using an in-memory store (local development only).');
  const m = globalThis.__hexbpMem || (globalThis.__hexbpMem = new Map());
  return {
    kind: 'memory',
    get: async k => (m.has(k) ? m.get(k) : null),
    setNX: async (k, v) => { if (m.has(k)) return false; m.set(k, v); return true; },
    cas: async (k, oldV, newV) => { if (m.get(k) !== oldV) return false; m.set(k, newV); return true; },
  };
}
