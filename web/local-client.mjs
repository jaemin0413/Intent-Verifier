// Retry only a request the server explicitly rejected before dispatching its action.
export function localClient(fetchImpl=fetch){
 let token,refreshing;
 const linkKey=()=>{
  const hash=typeof location==='undefined'?'':new URLSearchParams(location.hash.slice(1)).get('access');
  if(hash){try{sessionStorage.setItem('app-access',hash);}catch{}return hash;}
  try{return sessionStorage.getItem('app-access')||'';}catch{return '';}
 };
 const connect=async()=>{
  if(!refreshing)refreshing=(async()=>{const key=linkKey();const r=await fetchImpl('/api/session',{cache:'no-store',headers:key?{'X-App-Key':key}:{}});if(r.status===403)throw Error('접속 링크가 올바르지 않습니다. 공유받은 링크를 다시 열어 주세요.');if(!r.ok)throw Error('앱 연결을 다시 확인하지 못했어요. 잠시 후 다시 눌러 주세요.');const data=await r.json();if(!data.token)throw Error('앱 연결 정보를 받지 못했어요.');token=data.token;})().finally(()=>{refreshing=null;});
  await refreshing;
 };
 const request=async(route,options={})=>{
  try{
   if(!token)await connect();
   const used=token;
   const send=()=>fetchImpl(route,{...options,headers:{...options.headers,'X-Local-Token':token}});
   let r=await send();
   if(r.status===401&&(await r.clone().json().catch(()=>({}))).code==='LOCAL_SESSION_EXPIRED'){
    if(token===used)await connect();
    r=await send();
   }
   return r;
  }catch(e){if(e instanceof TypeError)throw Object.assign(new Error('앱 서버에 연결할 수 없어요. 주소와 서버 실행 상태를 확인한 뒤 다시 눌러 주세요.'),{code:'LOCAL_SERVICE_UNAVAILABLE'});throw e;}
 };
 return {connect,request};
}
