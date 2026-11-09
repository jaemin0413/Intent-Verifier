const only=(o,keys)=>o&&Object.keys(o).every(k=>keys.includes(k));
const name=v=>typeof v==='string'&&/^[A-Za-z][\w]*$/.test(v);
const fail=msg=>{throw Error(msg);};
export function validateGraph(graph){
 if(!only(graph,['nodes','auth','idLinks'])||!Array.isArray(graph.nodes)||!graph.nodes.length||graph.nodes.length>100)fail('H2 데이터 관계 정의를 확인해 주세요.');
 const aliases=new Set();
 for(const n of graph.nodes){
  if(!only(n,['alias','entity','factory','arguments','fields','relations'])||!name(n.alias)||aliases.has(n.alias)||!name(n.entity)||typeof n.factory!=='string'||(n.factory&&!name(n.factory))||!Array.isArray(n.arguments)||!Array.isArray(n.fields)||!Array.isArray(n.relations))fail(`H2 데이터 생성 정의를 확인해 주세요: ${n.alias||'이름 없음'} (${n.entity||'엔티티 없음'}). alias/entity는 영문 식별자, factory는 문자열, arguments/fields/relations는 배열이어야 합니다.`);
  for(const a of n.arguments)if(!only(a,['kind','value'])||!['literal','ref','password'].includes(a.kind)||(a.kind==='ref'&&!aliases.has(a.value)))fail('데이터를 저장하는 순서와 관계 참조를 확인해 주세요.');
  for(const f of n.fields)if(!only(f,['field','value'])||!name(f.field)||['id','class'].includes(f.field))fail('생성 ID는 DB에서 받아야 합니다.');
  for(const r of n.relations)if(!only(r,['field','alias'])||!name(r.field)||!aliases.has(r.alias))fail('먼저 저장한 데이터에 관계를 연결해 주세요.');
  aliases.add(n.alias);
 }
 if(graph.idLinks!==undefined&&(!Array.isArray(graph.idLinks)||graph.idLinks.length>100||graph.idLinks.some(l=>!only(l,['alias','field','target'])||!aliases.has(l.alias)||!aliases.has(l.target)||!name(l.field)||['id','class'].includes(l.field.toLowerCase()))))fail('생성된 ID의 후속 연결을 확인해 주세요.');
 if(graph.auth!==null&&(!only(graph.auth,['alias','method','provider'])||!aliases.has(graph.auth.alias)||!name(graph.auth.method)||!name(graph.auth.provider)))fail('H2 계정의 인증 연결을 확인해 주세요.');
 const linkedFields=new Set();
 for(const link of graph.idLinks||[]){
  const key=link.alias+'.'+link.field,node=graph.nodes.find(n=>n.alias===link.alias);
  if(linkedFields.has(key)||node.fields.some(f=>f.field===link.field)||node.relations.some(r=>r.field===link.field))fail('생성 ID 연결 필드는 중복 지정할 수 없습니다.');
  linkedFields.add(key);
 }
 return graph;
}
export function graphSupported(graph){try{validateGraph(graph);return true;}catch{return false;}}
