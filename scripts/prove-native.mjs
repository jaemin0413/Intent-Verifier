import {readFile,writeFile} from 'node:fs/promises';
import {LocalAnalysisRuntime} from '../lib/codex.mjs';
import {ClaudeRuntime} from '../lib/ai-runtime.mjs';
import {verifyNativeJava} from '../lib/native-java-runner.mjs';
const state=JSON.parse(await readFile('.local/state.json','utf8'));
const feature=state.features.find(f=>f.id===(process.env.NATIVE_FEATURE_ID||'32b56aa7-2cbf-418b-9134-6b2aa7123d1e'));
if(!feature?.spec?.approval)throw new Error('저장된 승인 명세가 필요합니다.');
const backend=state.projects.find(p=>p.id===feature.projectId)?.backend;
// AI_PROVIDER=claude proves the same run through Claude Code; the default stays Codex.
const claude=process.env.AI_PROVIDER==='claude';
const runtime=claude?new ClaudeRuntime():new LocalAnalysisRuntime({timeout:600000});runtime.logDirectory='.local/diagnostics';
try{
  const report=await verifyNativeJava({spec:feature.spec,backend:backend.repository,controllerFolder:backend.controllerFolder,runtime,model:claude?process.env.AI_MODEL:state.settings.model,onProgress:stage=>console.log(new Date().toISOString(),stage)});
  await writeFile(claude?'output/native-java-proof-claude.json':'output/native-java-proof.json',JSON.stringify(report,null,2));
  console.log(JSON.stringify({id:report.id,counts:report.counts,originalUnchanged:report.originalUnchanged,files:report.generatedFiles,results:report.results.map(r=>({name:r.name,status:r.status,reason:r.reason}))},null,2));
  if(report.originalUnchanged!==true||report.counts.BLOCKED||!report.results.some(r=>r.evidence?.actionExecuted))process.exitCode=2;
}finally{runtime.close();}
