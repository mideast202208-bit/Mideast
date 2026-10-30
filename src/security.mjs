import { randomBytes, scrypt, timingSafeEqual, createHash, createHmac } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
export const token = () => randomBytes(32).toString('hex');
export const hash = value => createHash('sha256').update(value).digest('hex');
export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length < 12 || password.length > 256) throw new Error('كلمة المرور من 12 إلى 256 حرفًا');
  const salt = randomBytes(16).toString('hex');
  const key = await scryptAsync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt:${salt}:${key.toString('hex')}`;
}
export async function checkPassword(password, stored) {
  if (typeof password !== 'string' || password.length > 256) return false;
  const [algorithm, salt, hex] = String(stored).split(':');
  if (algorithm !== 'scrypt' || !salt || !hex) return false;
  const key = await scryptAsync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  const expected = Buffer.from(hex, 'hex');
  return expected.length === key.length && timingSafeEqual(expected, key);
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
