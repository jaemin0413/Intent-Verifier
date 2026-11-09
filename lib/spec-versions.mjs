import {digest} from './domain.mjs';
const plain=value=>{const copy=structuredClone(value);delete copy.version;delete copy.requirementVersion;delete copy.contractVersion;delete copy.approvalStatus;return copy;};
const next=(value,previous)=>previous?(digest(plain(value))===digest(plain(previous))?previous.version:previous.version+1):1;
export function versionDraft(draft,previous){
 draft.version=(previous?.version||0)+1;
 for(const r of draft.requirements){r.version=next(r,previous?.requirements.find(old=>old.id===r.id));if(r.approvalStatus!=='REJECTED')r.approvalStatus='PENDING';}
 draft.contract.version=next(draft.contract,previous?.contract);
 for(const s of draft.scenarios){const old=previous?.scenarios.find(o=>o.id===s.id);s.requirementVersion=draft.requirements.find(r=>r.conditions.some(c=>c.id===s.conditionId)).version;s.contractVersion=draft.contract.version;s.version=next(s,old);if(old&&(old.requirementVersion!==s.requirementVersion||old.contractVersion!==s.contractVersion))s.version=Math.max(s.version,old.version+1);}
 return draft;
}
