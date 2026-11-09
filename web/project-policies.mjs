import {backendQuestions} from './intent-questions.mjs';
const normalize=s=>s.trim().replace(/\s+/g,' ');
// Offer exact-question matches only. Applying a saved answer always requires a click.
export function projectPolicies(features,current,question){
 const candidates=[];
 for(const feature of features){
  if(feature.id===current.id||feature.projectId!==current.projectId||feature.status!=='READY'||feature.sourceReviewRequired||feature.spec?.approval?.status!=='APPROVED')continue;
  for(const {index,text} of backendQuestions(feature.analysis)){
   const value=feature.answers?.extraAnswers?.[index]?.trim();
   if(value&&normalize(text)===normalize(question))candidates.push({value,featureId:feature.id,featureName:feature.name,version:feature.spec.version});
  }
 }
 return [...new Map(candidates.map(c=>[c.value,c])).values()];
}

// One place for the whole team: every decided policy, and where two approvals disagree.
export function teamPolicies(features,projectId){
 const groups=new Map();
 for(const feature of features){
  if(feature.projectId!==projectId||feature.status!=='READY'||feature.spec?.approval?.status!=='APPROVED')continue;
  for(const {index,text} of backendQuestions(feature.analysis)){
   const value=feature.answers?.extraAnswers?.[index]?.trim();
   if(!value)continue;
   const key=normalize(text),group=groups.get(key)||{question:text,answers:new Map()};
   const sources=group.answers.get(value)||[];
   sources.push({featureId:feature.id,featureName:feature.name,version:feature.spec.version});
   group.answers.set(value,sources);groups.set(key,group);
  }
 }
 return [...groups.values()].map(g=>({question:g.question,conflict:g.answers.size>1,answers:[...g.answers].map(([value,sources])=>({value,sources}))})).sort((a,b)=>b.conflict-a.conflict);
}
// What a teammate needs to trust before reading further.
export function interpretationStatus(feature){
 if(feature.status==='READY'&&feature.spec?.approval?.status==='APPROVED')return {kind:'APPROVED',version:feature.spec.version,by:feature.approvedBy?.name||null,at:feature.approvedBy?.at||null};
 if(feature.history?.some?.(s=>s.approval?.status==='APPROVED'))return {kind:'CHANGING'};
 return {kind:'CANDIDATE'};
}
