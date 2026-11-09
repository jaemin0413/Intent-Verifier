// Reads a team's Notion functional spec as plain text nodes, so the AI reads it next to the Figma screens.
import {digest,ensure} from './domain.mjs';
import {notionDestination} from './notion-destination.mjs';
import {NotionDatabase} from './notion-database.mjs';

export const MAX_DOCUMENTS=5;
export const parseDocumentUrl=url=>notionDestination(url).parentId;
const plain=rich=>(rich||[]).map(t=>t.plain_text??t.text?.content??'').join('');
function blockText(b){
  const v=b[b.type]||{};
  if(b.type==='table_row')return (v.cells||[]).map(c=>plain(c)).join(' | ');
  if(b.type==='child_page'||b.type==='child_database')return v.title||'';
  if(b.type==='to_do')return (v.checked?'[완료] ':'[ ] ')+plain(v.rich_text);
  if(b.type==='equation')return v.expression||'';
  return plain(v.rich_text);
}
function propertyText(p){
  const v=p[p.type];
  if(p.type==='title'||p.type==='rich_text')return plain(v);
  if(p.type==='select'||p.type==='status')return v?.name||'';
  if(p.type==='multi_select')return v.map(x=>x.name).join(', ');
  if(['number','url','email','phone_number'].includes(p.type))return v==null?'':String(v);
  if(p.type==='checkbox')return v?'예':'아니오';
  if(p.type==='date')return v?[v.start,v.end].filter(Boolean).join(' ~ '):'';
  return '';
}
const rowText=page=>Object.entries(page.properties||{}).sort(([,a],[,b])=>(b.type==='title')-(a.type==='title')).map(([name,p])=>{const t=propertyText(p);return t&&p.type!=='title'?`${name}: ${t}`:t;}).filter(Boolean).join(' / ');
// One page body plus one level of child pages; a database's rows count as that level.
export async function readNotionDocument(pageId,{token,fetchImpl=fetch,limit=400}={}){
  ensure(token,'기능명세서를 읽으려면 프로젝트 설정에 Notion API 키가 필요합니다.');
  const api=new NotionDatabase(token,fetchImpl);
  const page=await api.request('pages/'+pageId);
  const title=plain(Object.values(page.properties||{}).find(p=>p.type==='title')?.title)||'Notion 문서';
  const texts=[];let count=0,truncated=false;
  async function rows(databaseId,parentNodeId,depth){
    const nodes=[];
    for(const source of (await api.request('databases/'+databaseId)).data_sources||[]) for(const page of await api.list('data_sources/'+source.id+'/query','POST')){
      if(count>=limit){truncated=true;return nodes;}
      count++;
      const id='notion:'+page.id.replaceAll('-',''),text=rowText(page).replace(/\s+/g,' ').trim();
      if(text)texts.push(text);
      nodes.push({id,parentId:parentNodeId,type:'DOCUMENT_PAGE',name:'데이터베이스 행',...(text?{text}:{}),children:await children(page.id,id,depth+1,1)});
    }
    return nodes;
  }
  async function children(parentId,parentNodeId,depth,pageDepth){
    const nodes=[];
    for(const b of await api.list('blocks/'+parentId+'/children')){
      if(count>=limit){truncated=true;break;}
      count++;
      const id='notion:'+b.id.replaceAll('-',''),text=blockText(b).replace(/\s+/g,' ').trim();
      const node={id,parentId:parentNodeId,type:b.type==='child_page'?'DOCUMENT_PAGE':'DOCUMENT_BLOCK',name:b.type==='child_page'?'하위 페이지: '+text:b.type==='child_database'?'데이터베이스(제목만): '+text:b.type};
      if(text){node.text=text;texts.push(text);}
      if(b.type==='child_page'){if(pageDepth<1)node.children=await children(b.id,id,depth+1,pageDepth+1);}
      else if(b.type==='child_database'&&pageDepth<1){
        // A linked view or an unshared database cannot be read; it stays listed by title for the AI to flag.
        try{node.children=await rows(b.id,id,depth+1);node.name='데이터베이스: '+text;}catch{}
      }
      else if(b.has_children&&b.type!=='child_database'&&depth<20)node.children=await children(b.id,id,depth+1,pageDepth);
      nodes.push(node);
    }
    return nodes;
  }
  const rootId='notion-doc-'+pageId;
  const node={id:rootId,name:'Notion 기능명세서: '+title,type:'DOCUMENT',children:await children(pageId,rootId,0,0)};
  return {id:pageId,url:'https://www.notion.so/'+pageId,title,node,blockCount:count,truncated,digest:digest(texts),fetchedAt:new Date().toISOString(),lastEditedAt:page.last_edited_time};
}
export async function readDocuments(urls,options){
  const ids=[...new Set((urls||[]).map(u=>String(u).trim()).filter(Boolean).map(parseDocumentUrl))];
  ensure(ids.length<=MAX_DOCUMENTS,`기능명세서는 최대 ${MAX_DOCUMENTS}개까지 연결할 수 있습니다.`);
  return Promise.all(ids.map(id=>readNotionDocument(id,options)));
}
// The document text joins the Figma nodes, so the same-source check and every AI step see it.
export function attachDocuments(scan,documents){
  scan.nodes=[...scan.nodes.filter(n=>n.type!=='DOCUMENT'),...documents.map(d=>d.node)];
  scan.documents=documents.map(({node,...meta})=>meta);
  return scan;
}
