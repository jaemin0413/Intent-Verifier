import test from "node:test";
import assert from "node:assert/strict";
import {PassThrough} from "node:stream";
import {readJsonLines} from "../lib/json-lines.mjs";
import {replaceFile} from "../lib/atomic-file.mjs";

test("Codex 완료 JSON 안의 Unicode 줄바꿈과 잘린 한글 바이트를 원문 그대로 읽는다",()=>{
  const stream=new PassThrough(),messages=[],errors=[];
  readJsonLines(stream,m=>messages.push(m),e=>errors.push(e));
  const text='설계서 첫 줄\u2028둘째 줄\u2029셋째 줄\n이스케이프 줄바꿈';
  const original=[{method:"item/completed",params:{item:{type:"agentMessage",text:JSON.stringify({quote:text})}}},{method:"turn/completed",params:{turn:{status:"completed"}}}];
  const bytes=Buffer.from(original.map(JSON.stringify).join("\r\n")+"\n");
  for(let i=0;i<bytes.length;i+=7)stream.write(bytes.subarray(i,i+7));
  assert.deepEqual(messages,original);assert.deepEqual(errors,[]);stream.end();
});

test("손상된 RPC는 무한 대기 대신 오류를 전달한다",()=>{
  const stream=new PassThrough(),errors=[];
  readJsonLines(stream,()=>assert.fail("invalid message"),e=>errors.push(e));
  stream.write('{broken}\n');assert.equal(errors.length,1);stream.end();
});

test("Windows 일시 잠금은 기존 완료본을 유지한 채 교체를 재시도한다",async()=>{
  let old="previous",attempts=0;const waits=[];
  await replaceFile("temp","index",{move:async()=>{assert.equal(old,"previous");if(++attempts<3)throw Object.assign(new Error("locked"),{code:"EPERM"});old="complete";},wait:async ms=>waits.push(ms)});
  assert.equal(old,"complete");assert.equal(attempts,3);assert.deepEqual(waits,[25,50]);
  await assert.rejects(replaceFile("temp","index",{move:async()=>{throw Object.assign(new Error("missing"),{code:"ENOENT"});},wait:()=>assert.fail("not retryable")}),{code:"ENOENT"});
});
