import {apiDocuments,plannedDocument} from './notion-api-documents.mjs';
import {isApproved,ensure} from './domain.mjs';
import {publicationKey} from './notion-template.mjs';
import {NotionDatabase} from './notion-database.mjs';
import {prepareDocumentation,enrichDocumentation,DOCUMENTATION_VERSION} from './notion-documentation.mjs';
import {canPublishAutomatically} from './notion-publication-policy.mjs';

// Pages written in the earlier single-list layout are left where they are, never reused.
export const NOTION_LAYOUT=':api-domain-v2';
// One approved version per project destination. Verification is independent of publishing.
export class NotionPublisher {
  constructor(store,fetchImpl=fetch,{runtime,checkouts}={}){this.store=store;this.fetchImpl=fetchImpl;this.runtime=runtime;this.checkouts=checkouts;this.inFlight=new Map();}
  async publish(id,{automatic=false,report,runtime=this.runtime}={}) {
    const state=await this.store.load(),feature=state.features.find(f=>f.id===id);
    ensure(isApproved(feature?.spec),'기획을 먼저 확정해 주세요.');
    if(automatic && !canPublishAutomatically(feature,report,state.runs))return null;
    const destination=state.projects.find(p=>p.id===feature.projectId)?.notion;
    const secrets=await this.store.secrets();
    if(automatic&&(feature.demo||!destination?.parentId||!secrets.notionToken))return null;
    ensure(destination?.parentId,'프로젝트 설정에 명세서를 저장할 노션 페이지 링크를 입력해 주세요.');
    ensure(secrets.notionToken,'프로젝트 설정에 노션 API 키를 입력해 주세요.');
    const key=publicationKey(feature.spec,destination)+NOTION_LAYOUT,lock=feature.projectId+':'+destination.parentId;
    const project=state.projects.find(p=>p.id===feature.projectId),backend=project?.backend;
    const detailed=Boolean(runtime&&backend?.repository&&feature.spec.contract.kind==='controller-api-v1'&&feature.spec.contract.endpoints.every(e=>e.documentation?.origin!=='AI_PROPOSAL'));
    if(this.inFlight.has(lock)){await this.inFlight.get(lock).catch(()=>{});return this.publish(id,{automatic,report,runtime});}
    const registered=state.notionApiRegistry?.[lock+NOTION_LAYOUT];
    const cached=feature.publications?.[key];
    const currentPages=cached?.pages?.every(p=>Object.values(registered?.pages||{}).some(r=>r.id===p.id&&r.contentDigest===p.contentDigest&&!r.revision));
    if(cached?.indexLayout&&currentPages&&(!detailed||cached.documentationVersion===DOCUMENTATION_VERSION)){
      const published=feature.publications[key];
      if(feature.notionPublication?.key!==key || feature.notionPublication?.status!=='DONE')await this.store.mutate(s=>{const f=s.features.find(f=>f.id===id);if(f)f.notionPublication={key,digest:feature.spec.approval.digest,parentId:destination.parentId,status:'DONE',url:published.url};});
      return published;
    }
    const task=(async()=>{
      const update=async status=>this.store.mutate(s=>{const f=s.features.find(f=>f.id===id);if(f)f.notionPublication={key,digest:feature.spec.approval.digest,parentId:destination.parentId,...status};});
      await update({status:'RUNNING'});
      try {
        let documentation;
        if(detailed){
          const prepared=this.checkouts?await this.checkouts.withCode(project,feature.backendBranch,code=>prepareDocumentation(feature,{...backend,repository:code})):await prepareDocumentation(feature,backend);
          documentation=feature.notionDocumentation?.[key];
          if(documentation?.inputDigest!==prepared.inputDigest){
            documentation=await enrichDocumentation(prepared,{runtime,model:state.settings.model||undefined});
            await this.store.mutate(s=>{const f=s.features.find(f=>f.id===id);if(f)f.notionDocumentation={...f.notionDocumentation,[key]:documentation};});
          }
        }
        const fresh=await this.store.load();
        const latestFeature=fresh.features.find(f=>f.id===id);
        ensure(latestFeature?.spec?.approval?.digest===feature.spec.approval.digest,'작성 중 승인 기준이 바뀌었습니다. 최신 기준으로 다시 작성해 주세요.');
        const registryKey=lock+NOTION_LAYOUT;
        const registry=fresh.notionApiRegistry?.[registryKey]||{};
        const progress=structuredClone(latestFeature.notionDrafts?.[key]||{});
        progress.pages||={};
        // Migrate only tool-owned checkpoints from the same project/destination.
        const oldDrafts=fresh.features.filter(f=>f.projectId===feature.projectId).flatMap(f=>Object.entries(f.notionDrafts||{}).filter(([k,d])=>k.endsWith(NOTION_LAYOUT)&&(d.parentId===destination.parentId||f.notionPublication?.key===k&&f.notionPublication.parentId===destination.parentId||f.id===id&&feature.notionPublication?.key===k&&feature.notionPublication.parentId===destination.parentId)).map(([,d])=>d));
        const planned=(latestFeature.plannedApis||[]).map(plannedDocument),listed=[...apiDocuments(feature.spec),...planned];
        const documentKeys=new Set(listed.map(doc=>doc.key));
        for(const doc of listed){
          const previous=registry.pages?.[doc.key]||progress.pages[doc.key]||oldDrafts.map(d=>d.pages?.[doc.key]).filter(Boolean).at(-1);
          if(previous)progress.pages[doc.key]=structuredClone(previous);
        }
        progress.pages=Object.fromEntries(Object.entries(progress.pages).filter(([k])=>documentKeys.has(k)));
        progress.parentId=destination.parentId;
        progress.destinations={...structuredClone(registry.destinations||{}),...progress.destinations};
        if(!latestFeature.notionDrafts?.[key])delete progress.indexLayout;
        if(automatic){const latest=await this.store.load();if(!canPublishAutomatically(latest.features.find(f=>f.id===id),report,latest.runs)){await update({status:'SKIPPED',message:'검사 기준이나 결과가 바뀌어 자동 작성을 중단했습니다.'});return null;}}
        const checkpoint=async value=>this.store.mutate(s=>{const f=s.features.find(f=>f.id===id);if(f)f.notionDrafts={...f.notionDrafts,[key]:structuredClone(value)};s.notionApiRegistry||={};const previous=s.notionApiRegistry[registryKey]||{};s.notionApiRegistry[registryKey]={...previous,destinations:{...previous.destinations,...structuredClone(value.destinations)},pages:{...previous.pages,...structuredClone(value.pages)}};});
        const labels=Object.fromEntries((feature.apiCandidates||[]).map(e=>[e.id,e.label||e.summary]));
        const published=await new NotionDatabase(secrets.notionToken,this.fetchImpl).publish(feature.spec,{parentId:destination.parentId,progress,checkpoint,labels,documents:documentation?.docs,planned});
        if(documentation)published.documentationVersion=documentation.version;
        published.revision={approvalDigest:feature.spec.approval.digest,featureVersion:feature.spec.version,at:new Date().toISOString()};
        await this.store.mutate(s=>{const f=s.features.find(f=>f.id===id);if(f){f.publications={...f.publications,[key]:published};f.notionPublication={key,digest:feature.spec.approval.digest,parentId:destination.parentId,status:'DONE',url:published.url};}});
        return published;
      }catch(error){await update({status:'ERROR',message:error.message});throw error;}
    })();
    this.inFlight.set(lock,task);
    try{return await task;}finally{this.inFlight.delete(lock);}
  }
  automatic(id,report,runtime){return this.publish(id,{automatic:true,report,...(runtime?{runtime}:{})}).catch(()=>null);}
}
