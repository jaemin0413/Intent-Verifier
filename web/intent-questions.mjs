// Keep source indices stable so hiding UI-only questions never reassigns answers.
export function backendQuestions(analysis) {
  return (analysis?.questions || []).flatMap((text,index)=>{
    const scope=analysis.questionScopes?.[index];
    const presentation=/안내\s*문구|오류\s*문구|어떤\s*화면|화면.*이동|어떤\s*안내.*다음\s*행동|색상|애니메이션|모션|버튼.*(위치|색)|하나만\s*보여|모두\s*보여/.test(text);
    const technicalOnly=/HTTP|상태\s*코드|status\s*code/i.test(text)&&!(/권한|누가|소유|삭제|보존|숨기|인증|중복|상태\s*전이/.test(text));
    if(technicalOnly)return [];
    if(scope==="frontend" || scope==="mixed" || presentation) return [];
    return [{index,text}];
  });
}
