import {readdir,readFile,realpath} from "node:fs/promises";
import path from "node:path";
import {digest,ensure} from "./domain.mjs";

// Read declarations only for AI discovery; service implementations are not input to Expected.
function closing(text,start,left="(",right=")") {
  let depth=0,quote=false,escaped=false;
  for(let i=start;i<text.length;i++) {
    const c=text[i];if(quote){if(escaped)escaped=false;else if(c==="\\")escaped=true;else if(c==='"')quote=false;continue;}
    if(c==='"'){quote=true;continue;}if(c===left)depth++;if(c===right && --depth===0)return i;
  }return -1;
}
function annotation(source,index,name) {
  let at=index+name.length;while(/\s/.test(source[at]||"") && at<source.length)at++;
  if(source[at]!=="(")return {args:"",end:at};
  const end=closing(source,at);return {args:source.slice(at+1,end),end:end+1};
}
const paths=args=>{
  const named=args.match(/(?:value|path)\s*=\s*/);
  const tail=(named?args.slice(named.index+named[0].length):args).trim();
  const part=tail.startsWith('{')?tail.slice(0,closing(tail,0,'{','}')+1):tail.startsWith('"')?tail.match(/^"(?:\\.|[^"\\])*"/)?.[0]||'""':'""';
  return [...part.matchAll(/"([^"]*)"/g)].map(m=>m[1]);
};
// Annotation arguments may contain commas, nested annotations and regex parentheses.
function annotations(text) {
  const found=[];let clean="",last=0;
  const re=/@[\w.]+/g;
  for(let m;(m=re.exec(text));){const a=annotation(text,m.index,m[0]);found.push({name:m[0].slice(1).split('.').at(-1),args:a.args});clean+=text.slice(last,m.index)+" ";last=a.end;re.lastIndex=a.end;}
  return {items:found,clean:clean+text.slice(last)};
}
function parts(text) {
  const out=[];let start=0,depth=0,quoted=false,escaped=false;
  for(let i=0;i<text.length;i++){const c=text[i];if(quoted){if(escaped)escaped=false;else if(c==='\\')escaped=true;else if(c==='"')quoted=false;continue;}if(c==='"'){quoted=true;continue;}if('(<[{'.includes(c))depth++;if(')>]}'.includes(c))depth--;if(c===','&&depth===0){out.push(text.slice(start,i));start=i+1;}}
  out.push(text.slice(start));return out;
}
function parameter(text) {
  const a=annotations(text),m=a.clean.trim().match(/^(?:final\s+)?([\w.<>,?\[\]\s]+?)\s+(\w+)$/);
  return m?{type:m[1].trim(),name:m[2],annotations:a.items}:null;
}
export function parseDto(source,name) {
  const fields=[];const record=source.match(/\brecord\s+\w+(?:\s*<[^>]+>)?\s*\(/);
  if(record){const start=record.index+record[0].length-1;for(const text of parts(source.slice(start+1,closing(source,start)))){const p=parameter(text);if(p)fields.push(p);}}
  else {let last=0;for(const m of source.matchAll(/\bprivate\s+(?!static)(?:final\s+)?((?:@\w+(?:\([^)]*\))?|[\w<>?,. \[\]])+)\s+(\w+)\s*(?:=[^;]*)?;/g)){const prefix=source.slice(last,m.index);fields.push({type:m[1].replace(/@\w+(?:\([^)]*\))?\s*/g,'').trim(),name:m[2],annotations:annotations(prefix.slice(Math.max(prefix.lastIndexOf(';'),prefix.lastIndexOf('}'))+1)).items});last=m.index+m[0].length;}
   // Lombok DTOs may leave their fields package-private.
   if(!fields.length)for(const m of source.matchAll(/^\s*(?:final\s+)?([A-Z][\w<>?,. \[\]]*?)\s+(\w+)\s*(?:=[^;]*)?;\s*$/gm))fields.push({type:m[1].trim(),name:m[2],annotations:[]});}
  return {name,fields,enumValues:/\benum\s/.test(source)?[...source.matchAll(/^\s*([A-Z][A-Za-z0-9_]+)\s*(?:\(|[,;]|$)/gm)].map(m=>m[1]):[]};
}
// DTOs are often grouped as static classes inside one wrapper, e.g. TeamRequest.CreateReq.
// shortcut: one nesting level only; a class nested deeper merges into its parent, split it if a project needs that.
export function dtoShapes(source,name) {
  source=source.replace(/"(?:\\.|[^"\\])*"|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,m=>m.startsWith('"')?m:" ");
  const nested=[],cuts=[];
  for(const m of source.matchAll(/\b(static\s+(?:final\s+)?class|record|(?:static\s+)?enum)\s+(\w+)/g)) {
    if(m[2]===name||cuts.some(([a,b])=>m.index>a&&m.index<b))continue;
    const pair=m[1]==="record"?["(",")"]:["{","}"];
    let end=closing(source,source.indexOf(pair[0],m.index),...pair);if(end<0)continue;
    if(m[1]==="record"&&/^\s*\{/.test(source.slice(end+1)))end=closing(source,source.indexOf("{",end),"{","}");
    const segment=source.slice(m.index,end+1);
    nested.push({...parseDto(segment,name+"."+m[2]),parameters:(segment.match(/\b(?:class|record)\s+\w+\s*<([^>]+)>/)?.[1]||"").split(",").map(t=>t.trim()).filter(Boolean)});
    cuts.push([m.index,end+1]);
  }
  const outer=parseDto(cuts.reduceRight((s,[a,b])=>s.slice(0,a)+s.slice(b),source),name);
  return outer.fields.length||outer.enumValues.length||!nested.length?[outer,...nested]:nested;
}
export function externalApiReason(e) {
  return /oauth/i.test(`${e.controller||''} ${e.path}`)?"외부 로그인 연결이 필요한 API는 이번 검사에서 제외합니다.":null;
}
export function parseController(source,file) {
  // Preserve annotation strings while dropping comments, so commented mappings are not offered.
  source=source.replace(/"(?:\\.|[^"\\])*"|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g,m=>m.startsWith('"')?m:" ");
  const declaration=source.match(/\b(?:class|interface)\s+(\w+)/);if(!declaration || !/@(?:RestController|Controller)\b/.test(source))return [];
  const prefix=source.slice(0,declaration.index),baseMatch=prefix.match(/@RequestMapping\b/);
  const bases=baseMatch?paths(annotation(prefix,baseMatch.index,"@RequestMapping").args):[""];
  const result=[];
  const mapping=/@(Get|Post|Put|Patch|Delete|Request)Mapping\b/g;mapping.lastIndex=declaration.index;
  for(let m; (m=mapping.exec(source));) {
    const a=annotation(source,m.index,m[0]);mapping.lastIndex=a.end;
    const following=source.slice(a.end),signature=following.match(/\bpublic\s+([\w<>,.?\[\]\s]+?)\s+(\w+)\s*\(/);
    if(!signature)continue;
    const start=a.end+signature.index,open=start+signature[0].length-1,end=closing(source,open);
    if(end<0)continue;
    const args=source.slice(open+1,end),between=source.slice(a.end,start);
    const methods=m[1]==="Request"?[...a.args.matchAll(/RequestMethod\.(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)/g)].map(x=>x[1]):[m[1].toUpperCase()];
    const parsed=parts(args).map(parameter).filter(Boolean),params=[];
    for(const p of parsed) {const bind=p.annotations.find(a=>['PathVariable','RequestParam'].includes(a.name));if(!bind)continue;
      const named=bind.args.match(/(?:name|value)\s*=\s*"([^"]+)"|^\s*"([^"]+)"/);
      params.push({in:bind.name==='PathVariable'?'path':'query',name:named?.[1]||named?.[2]||p.name,type:p.type,required:!/(required\s*=\s*false|defaultValue\s*=)/.test(bind.args),defaultValue:bind.args.match(/defaultValue\s*=\s*"([^"]*)"/)?.[1]||""});
    }
    const body=parsed.find(p=>p.annotations.some(a=>a.name==='RequestBody'));
    for(const base of bases)for(const route of paths(a.args))for(const method of methods) {
      const url=("/"+base+"/"+route).replace(/\/+/g,"/").replace(/\/$/,"") || "/";
      if(!url.startsWith("/"))continue;
      result.push({id:digest({file,method,url,handler:signature[2]}).slice(0,20),method,path:url,controller:declaration[1],handler:signature[2],file,summary:between.match(/summary\s*=\s*"([^"]*)"/)?.[1] || signature[2],description:between.match(/description\s*=\s*"([^"]*)"/)?.[1] || "",parameters:params,authentication:/@AuthUser|\bPrincipal\b|@AuthenticationPrincipal/.test(args)?"authenticated":"unknown",requestType:body?.type||null,requestValidation:body?.annotations.filter(a=>['Valid','Validated'].includes(a.name))||[],responseType:signature[1].trim(),declaration:source.slice(m.index,end+1)});
    }
  }
  return result;
}
export async function discoverControllers(repository,folder="src/main/java") {
  const root=await realpath(repository),scope=await realpath(path.resolve(root,folder));
  ensure(scope===root||scope.startsWith(root+path.sep),"컨트롤러 폴더는 백엔드 프로젝트 안에서 선택해 주세요.");
  const files=[];
  async function visit(dir){for(const e of await readdir(dir,{withFileTypes:true})) {
    if(e.isSymbolicLink())continue;if(e.name.startsWith(".")||["build","target","node_modules"].includes(e.name))continue;
    const full=path.join(dir,e.name);if(e.isDirectory())await visit(full);else if(e.name.endsWith(".java")){ensure(files.length<3000,"선택 폴더에 Java 파일이 너무 많습니다. 범위를 좁혀 주세요.");files.push(full);}
  }}await visit(scope);
  const endpoints=[],sources=[];
  for(const file of files) {
    const source=await readFile(file,"utf8");
    // Teams name these Resource, Api or Endpoint too; the annotation is what matters.
    if(!/@(?:RestController|Controller)\b/.test(source))continue;
    ensure(source.length<200000,"컨트롤러 파일이 너무 큽니다.");
    const relative=path.relative(root,file).replaceAll("\\","/");
    endpoints.push(...parseController(source,relative));sources.push({file:relative,digest:digest(source)});
  }
  ensure(endpoints.length<=500,"API가 너무 많습니다. 컨트롤러 폴더를 좁혀 주세요.");
  if(scope!==path.join(root,"src/main/java")) {const previous=[...files];files.length=0;try{await visit(path.join(root,"src/main/java"));}catch(e){if(e.code!=="ENOENT")throw e;files.push(...previous);}}
  // Shapes and enum options improve request examples without including service logic.
  const shapes=[],pending=new Set(files);
  let used=endpoints.map(e=>e.requestType+" "+e.responseType+" "+e.parameters.map(p=>p.type).join(" ")).join(" ");
  // A DTO's own field types count too: an enum used only inside a nested DTO still needs its values.
  for(let grew=true;grew;) {
    grew=false;
    for(const file of pending) {
      const name=path.basename(file,".java");if(!new RegExp(`\\b${name}\\b`).test(used))continue;
      pending.delete(file);grew=true;
      const source=await readFile(file,"utf8");
      sources.push({file:path.relative(root,file).replaceAll("\\","/"),digest:digest(source)});
      const found=dtoShapes(source,name);
      shapes.push(...found);used+=" "+found.flatMap(s=>s.fields.map(f=>f.type)).join(" ");
    }
  }
  return {repository:root,folder,pathDigest:digest({root,scope}),digest:digest(sources),sources,endpoints,shapes,scannedAt:new Date().toISOString()};
}
