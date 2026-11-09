import {StringDecoder} from "node:string_decoder";

// JSON-RPC stdio is delimited by LF. U+2028/U+2029 are valid JSON string
// characters, but node:readline treats them as line endings and corrupts results.
export function readJsonLines(stream,onMessage,onError) {
  const decoder=new StringDecoder("utf8");
  let pending="",failed=false;
  const parse=line=>{if(!line.trim())return;try{onMessage(JSON.parse(line));}catch(error){failed=true;onError(error);}};
  const consume=text=>{
    if(failed)return;
    pending+=text;
    let end;
    while(!failed&&(end=pending.indexOf("\n"))>=0){const line=pending.slice(0,end);pending=pending.slice(end+1);parse(line);}
    if(pending.length>16*1024*1024){failed=true;onError(new Error("Codex JSON message exceeds transport limit"));}
  };
  stream.on("data",chunk=>consume(decoder.write(chunk)));
  stream.on("end",()=>{consume(decoder.end());if(!failed&&pending)parse(pending);});
  stream.on("error",onError);
}
