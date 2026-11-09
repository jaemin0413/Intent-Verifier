import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

export function publicOrigin(value) {
  if (!value) return null;
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash)
    throw new Error('PUBLIC_ORIGIN은 경로가 없는 HTTPS 주소여야 합니다.');
  return url.origin;
}

export async function accessKey(directory, provided) {
  if (provided) {
    if (!/^[a-f0-9]{64}$/.test(provided)) throw new Error('APP_LINK_KEY는 64자리 16진수여야 합니다.');
    return provided;
  }
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, 'link-key');
  try {
    await writeFile(file, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const key = (await readFile(file, 'utf8')).trim();
  if (!/^[a-f0-9]{64}$/.test(key)) throw new Error('저장된 접근 키가 올바르지 않습니다.');
  return key;
}

export function keyMatches(actual, expected) {
  if (typeof actual !== 'string' || !/^[a-f0-9]{64}$/.test(actual)) return false;
  return timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'));
}

export function shareUrl(origin, key) {
  return `${origin}/#access=${key}`;
}
