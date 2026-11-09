import {readFile,writeFile,mkdir,readdir,unlink,lstat} from 'node:fs/promises';
import path from 'node:path';
import {digest} from './domain.mjs';

// Retire only byte-identical files owned by an older run of this same feature.
// Their artifacts and verdicts stay intact; a user edit prevents removal.
async function retireFiles(files,backend,outputRoot,name,retired){
  for(const f of files||[]){
   if(!/^src\/test\/(?:java\/intent\/generated|resources\/intent-generated)\/[\w/.-]+$/.test(f.relative)||f.relative.split('/').includes('..'))continue;
   const target=path.resolve(backend,f.relative);if(target!==path.resolve(f.path))continue;
   try{
    let cursor=path.resolve(backend);let linked=false;for(const p of path.relative(cursor,target).split(path.sep)){cursor=path.join(cursor,p);if((await lstat(cursor)).isSymbolicLink()){linked=true;break;}}if(linked)continue;
    const source=await readFile(target,'utf8');if(digest(source)!==f.digest)continue;
    const artifact=path.join(outputRoot,name,'generated',f.relative);await mkdir(path.dirname(artifact),{recursive:true});
    try{await writeFile(artifact,source,{flag:'wx'});}catch(e){if(e.code!=='EEXIST')throw e;if(digest(await readFile(artifact,'utf8'))!==f.digest)continue;}
    await unlink(target);retired.push({path:target,sourceRunId:name,artifact});
   }catch(e){if(e.code!=='ENOENT')throw e;}
  }
}
export async function retirePreviousNativeTests(report,outputRoot){
 if(report.counts.BLOCKED||!report.originalUnchanged||!report.results.some(r=>r.evidence?.actionExecuted))return [];
 const retired=[];
 for(const name of await readdir(outputRoot)){
  if(name===report.id||!/^\d+-native-[\w-]+$/.test(name))continue;
  let old;try{old=JSON.parse(await readFile(path.join(outputRoot,name,'report.json'),'utf8'));}catch{continue;}
  if(old.runtime!=='project-java'||old.backend!==report.backend||old.featureId!==report.featureId)continue;
  await retireFiles(old.generatedFiles,report.backend,outputRoot,name,retired);
 }
 return retired;
}
// Files of a run that never reached a request (broken compile, crash, restart) can block
// every later build of the whole test tree, whichever feature they belonged to.
export async function retireFailedNativeTests(backend,outputRoot,currentId){
 const retired=[];
 for(const name of await readdir(outputRoot)){
  if(name===currentId||!/^\d+-native-[\w-]+$/.test(name))continue;
  const report=await readFile(path.join(outputRoot,name,'report.json'),'utf8').then(JSON.parse).catch(()=>null);
  if(report?.results?.some(r=>r.evidence?.actionExecuted))continue;
  const files=report?.generatedFiles||await readFile(path.join(outputRoot,name,'generated-files.json'),'utf8').then(JSON.parse).catch(()=>[]);
  // retireFiles keeps only paths under this backend whose bytes still match, so user edits stay.
  await retireFiles(files,backend,outputRoot,name,retired);
 }
 return retired;
}
