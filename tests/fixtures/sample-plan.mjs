// A small controller-api-v1 plan produced from fixed AI replies, for tests that need an approvable spec.
import {proposeIntentApis} from '../../lib/intent-api-plan.mjs';
import {planInputDigest} from '../../lib/domain.mjs';
import {replaceDraft} from '../../lib/store.mjs';

export const sampleReplies=()=>[
  {endpoints:[{method:'GET',path:'/api/items/{id}',summary:'자료 조회',reason:'기본 경로',authenticated:false,parameters:[{name:'id',type:'long',in:'path',required:true}],bodyFields:[]}]},
  {conditions:[{id:'c-1',description:'자료 이름을 반환한다',kind:'shape',scope:'backend',findingIndices:[0],answerIndices:[]}]},
  {cases:[{endpointId:'intent-api-1',name:'자료 조회',conditionIds:['c-1'],findingIndices:[0],answerIndices:[],fixtureProfile:'none',fixtureGraphJson:'null',givenDescription:'',givenFacts:[],statusOrigin:'ai_default',statusReason:'조회 성공 기본값',database:[],auth:'anonymous',pathValues:[{name:'id',value:'1'}],query:[],bodyJson:'null',status:200,checks:[{pointer:'/name',operator:'type',valueJson:'"string"'}],notCovered:[]}],skippedEndpoints:[],excluded:[]},
];
export const sampleFinding={text:'자료 조회',quote:'자료 조회',nodeIds:[]};
export async function samplePlan(feature,answers={}){
  const replies=sampleReplies();
  return (await proposeIntentApis(feature,answers,{runtime:{analyze:async()=>({result:replies.shift(),evidence:{model:'fixed'}})}})).spec;
}
// Puts a planned, approvable draft on a stored feature the way the planning route does.
export async function planStoredFeature(store,id,answers={extraAnswers:[]}){
  const feature=(await store.load()).features.find(f=>f.id===id);
  const planned={...structuredClone(feature),analysis:{...feature.analysis,findings:feature.analysis?.findings?.length?feature.analysis.findings:[sampleFinding]}};
  const spec=await samplePlan(planned,answers);
  await store.mutate(s=>{const f=s.features.find(f=>f.id===id);f.analysis=planned.analysis;f.answers=answers;replaceDraft(f,spec);f.planStatus='DONE';f.planInputDigest=planInputDigest(f,answers);});
  return (await store.load()).features.find(f=>f.id===id).spec;
}
