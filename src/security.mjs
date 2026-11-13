import { randomBytes, scrypt, timingSafeEqual, createHash, createHmac } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
export const token = () => randomBytes(32).toString('hex');
export const hash = value => createHash('sha256').update(value).digest('hex');
const passwordHashV2 = 'scrypt-v2';
const scryptOptions = Object.freeze({N:16384,r:8,p:5,maxmem:32*1024*1024});
const legacyScryptOptions = {...scryptOptions,p:1};
const passwordHashPattern = /^(scrypt-v2|scrypt):([a-f0-9]{32}):([a-f0-9]{128})$/;
export const passwordNeedsUpgrade = stored => typeof stored === 'string' && stored.startsWith('scrypt:');

export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) throw new Error('كلمة المرور من 12 إلى 256 حرفًا');
  const salt = randomBytes(16).toString('hex');
  const key = await scryptAsync(password, salt, 64, scryptOptions);
  return `${passwordHashV2}:${salt}:${key.toString('hex')}`;
}

export async function checkPassword(password, stored) {
  if (typeof password !== 'string' || password.length > 256) return false;
  const parsed = passwordHashPattern.exec(String(stored));
  if (!parsed) return false;
  const [,algorithm,salt,hex] = parsed;
  const key = await scryptAsync(password, salt, 64, algorithm===passwordHashV2?scryptOptions:legacyScryptOptions);
  return timingSafeEqual(Buffer.from(hex, 'hex'), key);
}
export function validSignature(raw, signature, secret) {
  if (!secret || !signature) return false;
  const expected = Buffer.from('sha256=' + createHmac('sha256', secret).update(raw).digest('hex'));
  const provided = Buffer.from(signature);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
export function normalizePhone(phone) {
  const value = String(phone || '').replace(/[\s()-]/g, '').replace(/^00/, '+');
  if (!/^\+[1-9]\d{6,14}$/.test(value)) {
    const error=new Error('اكتب الرقم الدولي، مثال: +201130343708');error.status=400;throw error;
  }
  return value;
}
export const windowOpen = (last, now = Date.now()) => last && now >= Date.parse(last) && now - Date.parse(last) < 86400000;
export function statusProgress(current, incoming) {
  const ranks = { queued: 0, unknown: 0, accepted: 1, sent: 2, delivered: 3, read: 4 };
  if (incoming === 'failed') return ['read', 'delivered'].includes(current) ? current : 'failed';
  if (!(incoming in ranks)) return current;
  return ranks[incoming] > (ranks[current] ?? -1) ? incoming : current;
}
