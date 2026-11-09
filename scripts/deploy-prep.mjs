import path from 'node:path';
import { root } from './setup.mjs';
import { accessKey, publicOrigin, shareUrl } from '../lib/deployment.mjs';
import { buildRemotePlugin } from '../lib/plugin-build.mjs';

const origin = publicOrigin(process.env.PUBLIC_ORIGIN);
if (!origin) throw new Error('PUBLIC_ORIGIN을 HTTPS 도메인으로 설정해 주세요.');
const data = path.resolve(process.env.APP_DATA_DIR || path.join(root, '.local'));
const key = await accessKey(data, process.env.APP_LINK_KEY);
const manifest = await buildRemotePlugin({origin,key,outputDirectory:path.join(data,'figma-plugin')});
console.log(`접속 링크: ${shareUrl(origin,key)}`);
console.log(`Figma 플러그인 manifest: ${manifest}`);
console.log(`영구 데이터: ${data}`);
