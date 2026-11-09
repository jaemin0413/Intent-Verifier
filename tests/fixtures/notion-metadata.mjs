export const indexProperties=title=>({[title]:{id:'title',type:'title'},METHOD:{id:'method',type:'select'},URL:{id:'url',type:'rich_text'},상태:{id:'status',type:'select'},'백엔드 담당':{id:'be',type:'people'},'프론트 담당':{id:'fe',type:'people'},텍스트:{id:'note',type:'rich_text'}});
const fieldProperties={key:{id:'key',type:'title'},type:{id:'type',type:'select',select:{options:[]}},description:{id:'description',type:'rich_text'}};
export function indexResponse(url,options,title='title'){
 const route=url.split('/v1/')[1].split('?')[0],body=options.body?JSON.parse(options.body):null;
 let data;
 if(route==='views')data=options.method==='GET'?{results:[{id:'view'}]}:{id:'view'};
 if(route.startsWith('views/'))data={id:'view'};
 if(route.startsWith('pages/')&&options.method==='PATCH')data={id:route.slice(6)};
 // Field tables live inside each API page and stay apart from the API list, so row counts mean API rows.
 if(route==='databases'&&options.method==='POST'&&!/ API$/.test(body.title[0].text.content))data={id:'field-db',data_sources:[{id:'field-ds'}]};
 if(route==='databases/field-db')data={id:'field-db',data_sources:[{id:'field-ds'}]};
 if(route==='data_sources/field-ds')data={id:'field-ds',properties:fieldProperties};
 if(route.endsWith('/query'))data={results:[]};
 if(route==='pages'&&options.method==='POST'&&body.parent.data_source_id==='field-ds')data={id:'field-row'};
 if(data)return {ok:true,json:async()=>data};
}
