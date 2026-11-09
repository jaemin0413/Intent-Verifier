import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from '../server.mjs';
import { buildRemotePlugin } from '../lib/plugin-build.mjs';
import { accessKey, publicOrigin } from '../lib/deployment.mjs';

const origin='https://plans.example.test';
test('HTTPS 링크 세션은 키·Host·Origin으로 제한되고 재시작 후 프로젝트와 키가 유지된다',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'remote-app-'));
  let server,port;
  const start=async()=>{({server}=await createServer({directory,publicUrl:origin,runtime:{close(){}}}));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));port=server.address().port;};
  const send=(route,headers={},options={})=>new Promise((resolve,reject)=>{
    const req=http.request({hostname:'127.0.0.1',port,path:route,method:options.method||'GET',headers:{Host:'plans.example.test',...headers}},res=>{
      const chunks=[];res.on('data',chunk=>chunks.push(chunk));res.on('end',()=>resolve(new Response(Buffer.concat(chunks),{status:res.statusCode,headers:res.headers})));
    });req.on('error',reject);req.end(options.body);
  });
  try{
    await start();
    const key=await accessKey(directory);
    const missing=await send('/api/session');assert.equal(missing.status,403,await missing.text());
    assert.equal((await send('/api/session',{'X-App-Key':'0'.repeat(64)})).status,403);
    assert.equal((await send('/api/session',{Host:'evil.example.test','X-App-Key':key})).status,400);
    assert.equal((await send('/api/session',{'X-App-Key':key,Origin:'https://evil.example.test'})).status,400);
    const session=await send('/api/session',{'X-App-Key':key,Origin:origin});
    assert.equal(session.status,200);const {token}=await session.json();
    assert.equal((await send('/api/projects',{}, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:'금지'})})).status,401);
    const created=await send('/api/projects',{'X-Local-Token':token,'Content-Type':'application/json',Origin:origin},{method:'POST',body:JSON.stringify({name:'재시작 보존'})});
    assert.equal(created.status,201);
    assert.equal((await send('/api/plugin/pair/start',{'Content-Type':'application/json'},{method:'POST',body:'{}'})).status,403);
    await new Promise(resolve=>server.close(resolve));await start();
    assert.equal(await accessKey(directory),key);
    const newSession=await send('/api/session',{'X-App-Key':key});
    const nextToken=(await newSession.json()).token;
    assert.notEqual(nextToken,token);
    const state=await send('/api/state',{'X-Local-Token':nextToken});
    assert.equal(state.status,200);
    assert.ok((await state.json()).projects.some(p=>p.name==='재시작 보존'));
  }finally{if(server?.listening)await new Promise(resolve=>server.close(resolve));await rm(directory,{recursive:true,force:true});}
});

test('배포 플러그인은 실제 HTTPS 도메인만 허용하고 링크 접근 키를 전달한다',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'remote-plugin-'));
  const key='a'.repeat(64);
  try{
    const manifestPath=await buildRemotePlugin({origin,key,outputDirectory:directory});
    const manifest=JSON.parse(await readFile(manifestPath,'utf8'));
    assert.deepEqual(manifest.networkAccess.allowedDomains,[origin]);
    assert.equal(manifest.networkAccess.devAllowedDomains,undefined);
    const html=await readFile(path.join(directory,'ui.html'),'utf8');
    assert.ok(html.includes(`const configuredOrigin = "${origin}";`));
    const script=html.match(/<script>([\s\S]*?)<\/script>/)[1];
    const elements=new Map([...html.matchAll(/id="([\w-]+)"/g)].map(([,id])=>[id,{value:'',style:{},options:[],add(x){this.options.push(x);},hidden:false}]));
    const calls=[],messages=[];
    const scope={document:{getElementById:id=>elements.get(id)},window:{},parent:{postMessage:m=>messages.push(m)},URL,URLSearchParams,AbortSignal,
      Option:function(text,value){this.text=text;this.value=value;},setTimeout(){},clearTimeout(){},fetch:async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>({id:'pair',claim:'claim'})};}};
    vm.runInNewContext(script,scope);
    await scope.window.onmessage({data:{pluginMessage:{type:'settings',settings:{},file:{fileId:'file',fileName:'기획'}}}});
    assert.equal(calls[0].url,origin+'/api/plugin/pair/start');
    assert.equal(calls[0].options.headers['X-App-Key'],key);
    const opened=messages.find(m=>m.pluginMessage.type==='open').pluginMessage.url;
    const url=new URL(opened);assert.equal(url.origin,origin);
    assert.equal(new URLSearchParams(url.hash.slice(1)).get('access'),key);
    assert.equal(new URLSearchParams(url.hash.slice(1)).get('pair'),'pair');
    assert.throws(()=>publicOrigin('http://plans.example.test'));
  }finally{await rm(directory,{recursive:true,force:true});}
});
