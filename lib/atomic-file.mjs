import {rename} from "node:fs/promises";

// Windows readers or scanners may briefly prevent replacement. Never delete the old file.
export async function replaceFile(temp,target,{move=rename,wait=ms=>new Promise(r=>setTimeout(r,ms))}={}) {
  for(let attempt=0;;attempt++) {
    try {return await move(temp,target);}
    catch(error) {
      if(!["EPERM","EACCES","EBUSY"].includes(error.code)||attempt>=8) throw error;
      await wait(Math.min(25 * 2 ** attempt,400));
    }
  }
}
