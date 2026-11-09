const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function questionChoices({suggestions=[],policies=[],previous='',value='',custom=false}){
 const proposed=Array.isArray(suggestions)?suggestions:suggestions.choices||[];
 const limit=suggestions.clarity==='clear'?1:2;
 const saved=!custom&&value?value:previous;
 const values=[...new Set([saved,...proposed.slice(0,limit),...(!proposed.length?policies.map(p=>p.value).slice(0,2):[])].filter(Boolean))].slice(0,3);
 return values.map(v=>({value:v,source:v===saved?'저장된 답변':proposed.includes(v)?(suggestions.clarity==='clear'?'원문에 명시':v===proposed[0]?'AI 추천':'다른 제안'):'승인된 답변',quote:suggestions.clarity==='clear'&&proposed.includes(v)?suggestions.quote:''}));
}
export function renderQuestion({index,text,choices,value='',custom=false,customText=''}){
 const option=(v,label,checked,detail='')=>`<label class="choice answer-choice"><input type="radio" name="option-${index}" value="${esc(v)}" ${checked?'checked':''}><span>${label}${detail?`<small>${esc(detail)}</small>`:''}</span></label>`;
 const cards=choices.map((c,i)=>option(c.value,`<strong>${i+1}안</strong> ${esc(c.value)}`,!custom&&value===c.value,c.source));
 const saved=!custom&&value&&choices[0]?.value===value;
 return `<fieldset class="extra-question"><legend>${esc(text)}</legend><div class="answer-options">${saved?cards[0]+(cards.length>1?`<details><summary>다른 제안 보기</summary>${cards.slice(1).join('')}</details>`:''):cards.join('')}${choices[0]?.quote?`<p class="hint">원문: ${esc(choices[0].quote)}</p>`:''}${option('__custom','직접 입력',custom)}<textarea class="custom-answer" name="custom-${index}" aria-label="${esc(text)} 직접 입력" ${custom?'':'hidden'} placeholder="원하는 동작을 직접 적어 주세요" rows="3">${esc(customText)}</textarea>${option('','아직 결정하지 않음',!custom&&!value)}</div></fieldset>`;
}
