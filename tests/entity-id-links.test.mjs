import test from 'node:test';
import assert from 'node:assert/strict';
import {validateGraph} from '../lib/entity-graph.mjs';
const graph=()=>({auth:null,nodes:['tribe','chat'].map(alias=>({alias,entity:alias==='tribe'?'Tribe':'Chat',factory:'of',arguments:[],fields:[],relations:[]})),idLinks:[{alias:'tribe',field:'lastChatId',target:'chat'}]});
test('generated ID links accept existing persisted aliases without hardcoded IDs',()=>assert.equal(validateGraph(graph()).idLinks[0].target,'chat'));
test('generated ID links reject missing targets, ID overwrite and conflicting Given fields',()=>{
 for(const edit of [g=>g.idLinks[0].target='missing',g=>g.idLinks[0].field='id',g=>g.idLinks.push({...g.idLinks[0]}),g=>g.nodes[0].fields.push({field:'lastChatId',value:42})]){const g=graph();edit(g);assert.throws(()=>validateGraph(g));}
});
