import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import {readFile,mkdtemp,rm} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {ScreenLibrary} from "../lib/screen-library.mjs";

test("드래그로 선택한 250개 설계서만 통째로 순차 전송하고 완료 전에는 공개하지 않는다", async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),"stream-library-"));
  const library=new ScreenLibrary(dir);
  let session, received=0, pending=0, maximum=0, failure;
  const frames=Array.from({length:250},(_,i)=>({id:String(i),name:`화면 ${i}`,type:"FRAME",children:[],exportAsync:async()=>new Uint8Array([1])}));
  const excluded={id:"outside",name:"선택하지 않은 컴포넌트",type:"COMPONENT",children:[]};
  const child={id:"child",name:"설명",type:"TEXT",characters:"작성자만 삭제 가능"};
  frames[0].children.push(child);child.parent=frames[0];
  const page={id:"p",name:"페이지",type:"PAGE",children:[...frames,excluded],selection:[...frames,child],loadAsync:async()=>{}};
  const figma={fileKey:"file",showUI(){},on(){},currentPage:page,root:{name:"파일",children:[page]},getNodeByIdAsync:async()=>page,base64Encode:()=>"AQ==",ui:{postMessage(m){
    if(m.type==="sync-error") failure=new Error(m.message);
    if(!m.requestId) return;
    pending++;maximum=Math.max(maximum,pending);
    void (async()=>{
      try {
        if(m.type==="library-start") session=await library.begin("p",m.library);
        if(m.type==="library-screen") {
          await library.put("p",session.id,m.screen);received++;
          if(received===125) assert.equal((await library.listing("p")).screens.length,0);
        }
        if(m.type==="library-complete") await library.complete("p",session.id,m.captureFinishedAt);
        pending--;await figma.ui.onmessage({type:"sync-ack",requestId:m.requestId});
      } catch(e) {failure=e;await figma.ui.onmessage({type:"sync-cancel"});}
    })();
  }}};
  try {
    vm.runInNewContext(await readFile(new URL("../figma-plugin/code.js",import.meta.url),"utf8"),{figma,__html__:""});
    await figma.ui.onmessage({type:"sync-selection"});
    if(failure) throw failure;
    assert.equal(maximum,1);assert.equal(received,250);
    const result=await library.listing("p");
    assert.equal(result.screens.length,250);assert.equal(result.revision,1);
    assert.equal(result.scope.kind,"selection");
    assert.equal(result.screens.some(s=>s.id==="outside"||s.id==="child"),false);
    assert.equal((await library.asset("p","0")).node.children[0].text,"작성자만 삭제 가능");
    assert.equal((await library.scan("p",["0"],1)).scope.context,"선택한 설계서 내부의 설명 전체 (선택 밖 내용 제외)");
    assert.ok(Date.parse(result.captureFinishedAt)>=Date.parse(result.captureStartedAt));
  } finally {await rm(dir,{recursive:true,force:true});}
});

test("전송 실패는 ACK 없이 멈추며 같은 화면 재시도 후에만 완료 화면을 표시한다",async()=>{
  const html=await readFile(new URL("../figma-plugin/ui.html",import.meta.url),"utf8");
  const elements=new Map([...html.matchAll(/id="([^"]+)"/g)].map(m=>[m[1],{value:"",hidden:true,style:{},options:[],add(o){this.options.push(o);if(!this.value)this.value=o.value;}}]));
  const messages=[],uploads=[];let fail=false;
  const scope={document:{getElementById:id=>elements.get(id)},window:{},parent:{postMessage:m=>messages.push(m.pluginMessage)},URL,AbortSignal,Option:function(text,value){this.text=text;this.value=value;},fetch:async(url,options)=>{
    if(url.endsWith("/screen")){uploads.push(JSON.parse(options.body));if(fail)throw new Error("接続断");}
    const result=url.endsWith("/projects")?{projects:[{id:"project",name:"프로젝트"}],features:[]}:url.endsWith("/begin")?{id:"session"}:{};
    return {ok:true,json:async()=>result};
  }};
  vm.runInNewContext(html.match(/<script>([\s\S]*?)<\/script>/)[1],scope);
  const send=m=>scope.window.onmessage({data:{pluginMessage:m}});
  await send({type:"settings",settings:{token:"test",projectId:"project"},file:{fileId:"file"}});
  elements.get("sync").onclick();
  await send({type:"library-start",requestId:"1",library:{screenIds:["s"]}});
  fail=true;
  await send({type:"library-screen",requestId:"2",screen:{id:"s"}});
  assert.equal(messages.some(m=>m.type==="sync-ack"&&m.requestId==="2"),false);
  assert.equal(elements.get("sync-retry").hidden,false);
  assert.equal(elements.get("sync").disabled,true);
  fail=false;await elements.get("sync-retry").onclick();
  assert.deepEqual(uploads[0],uploads[1]);
  assert.equal(messages.filter(m=>m.type==="sync-ack"&&m.requestId==="2").length,1);
  await send({type:"library-complete",requestId:"3",captureFinishedAt:new Date().toISOString()});
  assert.match(elements.get("status").textContent,/1개 화면을 앱에 저장/);
  elements.get("open").onclick();
  assert.match(messages.at(-1).url,/#project=project&library=1$/);
  elements.get("sync").onclick();
  elements.get("sync-cancel").onclick();
  assert.equal(elements.get("sync").disabled,true);
  assert.equal(messages.at(-1).type,"sync-cancel");
  await send({type:"sync-error",message:"동기화를 중단했습니다."});
  assert.equal(elements.get("sync").disabled,false);
});

test("수집 중단은 다음 화면과 완료 전송을 막고 다시 시작할 수 있다",async()=>{
  const messages=[];let cancel=true;
  const page={id:"p",name:"페이지",type:"PAGE",children:[{id:"s",name:"화면",type:"FRAME",children:[],exportAsync:async()=>new Uint8Array([1])}],loadAsync:async()=>{}};
  const figma={fileKey:"file",showUI(){},on(){},root:{name:"파일"},getNodeByIdAsync:async()=>page,base64Encode:()=>"AQ==",ui:{postMessage(m){
    messages.push(m);
    if(m.requestId) queueMicrotask(()=>figma.ui.onmessage(cancel?{type:"sync-cancel"}:{type:"sync-ack",requestId:m.requestId}));
  }}};
  vm.runInNewContext(await readFile(new URL("../figma-plugin/code.js",import.meta.url),"utf8"),{figma,__html__:""});
  await figma.ui.onmessage({type:"sync-page",pageId:"p"});
  assert.equal(messages.some(m=>m.type==="library-screen"||m.type==="library-complete"),false);
  assert.match(messages.at(-1).message,/중단/);
  cancel=false;messages.length=0;
  await figma.ui.onmessage({type:"sync-page",pageId:"p"});
  assert.equal(messages.at(-1).type,"library-complete");
});

test("선택이 없거나 내보낼 수 없는 항목이면 페이지 전체 수집으로 바꾸지 않는다",async()=>{
  const messages=[];
  const page={id:"p",name:"페이지",selection:[],children:[],loadAsync:async()=>{}};
  const figma={fileKey:"file",currentPage:page,showUI(){},on(){},root:{name:"파일"},ui:{postMessage:m=>messages.push(m)}};
  vm.runInNewContext(await readFile(new URL("../figma-plugin/code.js",import.meta.url),"utf8"),{figma,__html__:""});
  await figma.ui.onmessage({type:"sync-selection"});
  assert.equal(messages.at(-1).type,"sync-error");
  assert.equal(messages.some(m=>m.type==="library-start"),false);
  messages.length=0;page.selection=[{id:"unsupported",type:"UNKNOWN"}];
  await figma.ui.onmessage({type:"sync-selection"});
  assert.equal(messages.at(-1).type,"sync-error");
  assert.equal(messages.some(m=>m.type==="library-screen"),false);
});
