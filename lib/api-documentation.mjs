// Declaration metadata may describe bindings, never the intended business result.
export function requestDocumentation(endpoint, shapes = []) {
  const parameters = endpoint.parameters || [];
  const shape = shapes.find(s => s.name === endpoint.requestType);
  const field = p => ({key:p.name,type:p.type,description:p.required === true ? '필수' : p.required === false ? '선택' : ''});
  return {origin:'CONTROLLER_DECLARATION',request:{
    headers:[...(endpoint.requestType ? [{key:'Content-Type',type:'String',description:'application/json'}] : []),...(endpoint.authentication === 'authenticated' ? [{key:'Authorization',type:'String',description:'인증 필요'}] : [])],
    pathParameters:parameters.filter(p=>p.in==='path').map(field),
    queryParameters:parameters.filter(p=>p.in==='query').map(field),
    body:endpoint.requestType ? {type:endpoint.requestType,fields:shape ? shape.fields.map(field) : null} : null,
  }};
}
export function supportedDocumentation(value){
 if(value===undefined)return true;
 const only=(v,keys)=>v&&Object.keys(v).every(k=>keys.includes(k));
 const fields=v=>v===null||Array.isArray(v)&&v.every(f=>only(f,['key','type','description'])&&['key','type','description'].every(k=>typeof f[k]==='string'));
 return only(value,['origin','request','reason'])&&['CONTROLLER_DECLARATION','AI_PROPOSAL'].includes(value.origin)&&(value.reason===undefined||typeof value.reason==='string')&&only(value.request,['headers','pathParameters','queryParameters','body'])&&['headers','pathParameters','queryParameters'].every(k=>fields(value.request[k]))&&(value.request.body===null||only(value.request.body,['type','fields'])&&typeof value.request.body.type==='string'&&fields(value.request.body.fields));
}
