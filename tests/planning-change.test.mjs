import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';
import {ScreenLibrary} from '../lib/screen-library.mjs';
import {suggestChoices} from '../lib/intent-options.mjs';
import {questionChoices} from '../web/question-choices.mjs';
import {nextAction} from '../web/workflow.mjs';

test('이미지·배치·이름·수집 범위는 무시하고 완료된 설명 문구 변경만 감지한다',async()=>{
 const dir=await mkdtemp(path.join(os.tmpdir(),'planning-change-')),lib=new ScreenLibrary(dir);
 const note=text=>({id:'note',name:'설명',type:'TEXT',text});
 const screen={id:'s',name:'설계서',pageId:'p',node:{id:'s',name:'설계서',type:'FRAME',children:[note('작성자만 삭제 가능')]}};
 async function sync(value,selection=false,ids=['s']){const job=await lib.begin('p',{fileId:'f',pages:[{id:'p',name:'page'}],screenIds:ids,contexts:[{pageId:'p',nodes:selection?[]:[note('주변 기획')]}],scope:{kind:selection?'selection':'page'}});if(ids.length)await lib.put('p',job.id,value);return job;}
 try{
  let j=await sync(screen);await lib.complete('p',j.id);const scan=await lib.scan('p',['s'],1);
  const cosmetic=structuredClone(screen);cosmetic.name='이름 변경';cosmetic.image={nodeId:'s',dataUrl:'data:image/png;base64,AQ=='};cosmetic.node.x=100;
  cosmetic.node.children.push({id:'button',name:'버튼',type:'INSTANCE',children:[{id:'label',name:'Text',type:'TEXT',text:'새 컴포넌트 레이블'}]});
  j=await sync(cosmetic,true);await lib.complete('p',j.id);assert.equal(await lib.changed('p',scan.library),false);
  const changed=structuredClone(cosmetic);changed.node.children[0].text='관리자도 삭제 가능';
  j=await sync(changed,true);assert.equal(await lib.changed('p',scan.library),false);await lib.complete('p',j.id);assert.equal(await lib.changed('p',scan.library),true);
  j=await sync({...cosmetic,node:{...cosmetic.node,children:[note('작성자만\n삭제 가능')]}},true);await lib.complete('p',j.id);assert.equal(await lib.changed('p',scan.library),false);
  j=await sync(screen,true,[]);await lib.complete('p',j.id);assert.equal(await lib.changed('p',scan.library),false);
 }finally{await rm(dir,{recursive:true,force:true});}
});

test('명확한 원문은 근거가 있는 1안, 모호한 질문은 2안이며 기존 답변을 보존한다',async()=>{
 const feature={scan:{nodes:[{id:'t',name:'설명',type:'TEXT',text:'30일 동안 자동 로그인 유지'}],images:[]},analysis:{questions:['유지 기간?'],questionScopes:['backend'],summary:'자동 로그인'}};
 const call=item=>suggestChoices(feature,{runtime:{analyze:async()=>({result:{questions:[{index:0,...item}]}})}});
 const clear=await call({clarity:'clear',quote:'30일 동안 자동 로그인 유지',choices:['30일']});assert.equal(clear[0].choices.length,1);
 await assert.rejects(call({clarity:'clear',quote:'없는 근거',choices:['7일']}),/근거/);
 const ambiguous=await call({clarity:'ambiguous',quote:'',choices:['7일','30일']});assert.equal(ambiguous[0].choices.length,2);
 assert.equal(questionChoices({suggestions:clear[0]}).length,1);
 assert.equal(questionChoices({suggestions:ambiguous[0],value:'90일',retained:['1일','3일','100일']}).length,3);
 assert.equal(nextAction({status:'READY',sourceReviewRequired:true},{}),'다시 검사하기');
});
