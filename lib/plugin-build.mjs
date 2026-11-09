import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { root } from '../scripts/setup.mjs';
import { publicOrigin } from './deployment.mjs';

export async function buildRemotePlugin({ origin, key, outputDirectory }) {
  origin = publicOrigin(origin);
  if (!origin || !/^[a-f0-9]{64}$/.test(key)) throw new Error('HTTPS 주소와 접근 키가 필요합니다.');
  const source = path.join(root, 'figma-plugin');
  const output = path.resolve(outputDirectory);
  await mkdir(output, { recursive: true });
  const manifest = JSON.parse(await readFile(path.join(source, 'manifest.json'), 'utf8'));
  manifest.name = '기획 가져오기';
  manifest.networkAccess = { allowedDomains: [origin] };
  const ui = (await readFile(path.join(source, 'ui.html'), 'utf8'))
    .replace('const configuredOrigin = "http://localhost:4318";', `const configuredOrigin = ${JSON.stringify(origin)};`)
    .replace('const configuredAccess = "";', `const configuredAccess = ${JSON.stringify(key)};`);
  await writeFile(path.join(output, 'manifest.json'), JSON.stringify(manifest, null, 2));
  await writeFile(path.join(output, 'ui.html'), ui, { mode: 0o600 });
  await writeFile(path.join(output, 'code.js'), await readFile(path.join(source, 'code.js')));
  return path.join(output, 'manifest.json');
}
