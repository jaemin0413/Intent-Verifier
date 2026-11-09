// This policy is part of the approved snapshot, never inferred from a test result.
// Success, rejection and server error never match each other; inside one family the AI's code is only a default.
export function equivalentStatus(expected,actual){
  const family=Math.floor(expected/100);
  return expected===actual || [2,4].includes(family)&&family===Math.floor(actual/100);
}
export function validStatusPolicy(policy){
  return policy && ['figma','user_answer','ai_default'].includes(policy.origin) && ['strict','equivalent'].includes(policy.mode) && typeof policy.reason==='string' && policy.reason.trim() &&
    (policy.mode==='strict'||policy.origin==='ai_default') && Object.keys(policy).every(k=>['origin','mode','reason'].includes(k));
}
export function statusDifference(expected,actual,inputRejected=false){
  if(expected.status===actual)return null;
  if(expected.statusPolicy?.mode==='equivalent'&&!inputRejected&&equivalentStatus(expected.status,actual))return {kind:'TECHNICAL_DIFFERENCE',expected:expected.status,actual,origin:expected.statusPolicy.origin,reason:expected.statusPolicy.reason};
  return null;
}
