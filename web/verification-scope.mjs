// Missing tests inside the selected backend scope prevent complete verification.
export function frontendOnly(c){
  if(c.scope)return c.scope==='frontend';
  // Older proposals stored these two UI-only exclusions without a scope field.
  // Deliberately narrow: mixed/unknown/backend policies stay in the denominator.
  return /^(?:이미지 블러 처리는 프런트엔드 표현이므로 API 응답만으로 검증하지 않음|빈 카드와 첫 드랍 유도 문구의 실제 표시 및 문구 일치는 프런트엔드 책임이므로 검증하지 않음)[.]?$/.test(c.description||'');
}
export function backendCoverage(report) {
  const scopes=new Map((report?.coverage||[]).flatMap(r=>(r.conditions||[]).filter(c=>c.scope).map(c=>[c.id,c.scope])));
  const isFrontend=c=>{
    if(frontendOnly(c))return true;
    // Legacy case notes may duplicate an explicitly classified source condition.
    // Only an exact, single condition reference is safe to inherit; mixed notes remain.
    const match=String(c.description||'').match(/^(c-\d+):/);
    return !c.scope&&match&&!String(c.description).slice(match[0].length).match(/\bc-\d+\b/)&&scopes.get('condition-'+match[1])==='frontend';
  };
  return (report?.coverage||[]).map(r=>{
    if(!Array.isArray(r.conditions))return r;
    const conditions=r.conditions.filter(c=>!isFrontend(c));
    return {...r,conditions,totalConditions:conditions.length,verifiedConditions:conditions.filter(c=>c.verified).length};
  }).filter(r=>r.totalConditions>0);
}
export function incompleteBackend(report) {
  const rows=backendCoverage(report);
  return !rows.length||rows.some(c=>c.verifiedConditions<c.totalConditions);
}
