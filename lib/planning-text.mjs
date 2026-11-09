// Compare explanatory text, never the rendered image, geometry or Figma node IDs.
// Named description regions include short rules; ordinary UI labels are excluded.
export function planningText(nodes) {
  const result=[];
  const region=/^(description|설명|정책|기획 설명|기능 설명|명세|주석|annotation)(\s|$)/i;
  function visit(n,inDescription=false,inComponent=false) {
    const description=inDescription || region.test(n.name||'');
    const component=inComponent || ['COMPONENT','COMPONENT_SET','INSTANCE'].includes(n.type);
    const text=String(n.text ?? n.characters ?? '').normalize('NFC').replace(/\s+/gu,' ').trim();
    const sentence=text.length>=20 && /\s/.test(text);
    const rule=text.length>=6 && /\s/.test(text) && /가능|불가|허용|금지|제한|해야|저장|삭제|유지|초기화|만료|권한|정렬|최대|최소/.test(text);
    if(text && (description || (!component && (sentence || rule))))result.push(text);
    for(const c of n.children||[])visit(c,description,component);
  }
  nodes.forEach(n=>visit(n));
  return [...new Set(result)].sort();
}

export function sameText(before,after) {
  const collect=nodes=>{
    const values=[];
    function visit(n){const text=String(n.text??n.characters??'').normalize('NFC').replace(/\s+/gu,' ').trim();if(text)values.push(text);for(const c of n.children||[])visit(c);}
    nodes.forEach(visit);return JSON.stringify([...new Set(values)].sort());
  };
  return collect(before)===collect(after);
}
