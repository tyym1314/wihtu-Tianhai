/** Offline diagnostic only. Never rewrites or changes the pass/fail of its source report. */
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {createNativeFetchEvidence} from '../deploy/native-browser-checks.mjs';

export function replayNativeFetchReport(report){
 const raw=report.network,probe=createNativeFetchEvidence(),frames=new Map(),frameUrls=new Map(),origin=new URL(report.origin).origin;
 for(const event of raw.fetch_observations){
  if(!frames.has(event.frame_id))frames.set(event.frame_id,{});
  if(event.kind==='document'){
   const values=frameUrls.get(event.frame_url)||new Set();values.add(event.frame_id);frameUrls.set(event.frame_url,values);
  }
  probe.receive(frames.get(event.frame_id),event);
 }
 const documents=new Map(raw.fetch_observations.filter(event=>event.kind==='document').map(event=>[event.document_id,event]));
 for(const record of raw.network_protocol_observations){
  if(record.document_id){
   const doc=documents.get(record.document_id);assert.ok(doc,'Missing document evidence');
   probe.receiveNetworkDocument(record.frame,doc);
  }
  const key=record.session_id?`${record.session_id}:${record.id}`:record.id;
  assert.equal(probe.network.has(key),false,'Duplicate CDP identity');probe.network.set(key,{...record});
 }
 const requests=report.requests.map(request=>{
  const frameIds=frameUrls.get(request.frame_url);
  assert.ok(frameIds?.size===1,'Replay cannot infer a unique original frame');
  return{request_id:`network-${request.id}`,frame_object:frames.get([...frameIds][0]),frame_url_raw:request.frame_url,full_url:request.url,method:request.method,type:request.type,network_started_at_ms:request.timing?.startTime,response_seen:Number.isInteger(request.status),redirected:false};
 });
 const failed=raw.network_observations.map(observation=>{
  const entry=requests.find(value=>value.request_id===observation.observation_id);assert.ok(entry);
  const source=report.requests.find(value=>`network-${value.id}`===observation.observation_id);
  assert.equal(source.transport_error,observation.error);
  assert.equal(entry.frame_object,frames.get(observation.frame_id));
  // These fields are attested by the original observer, session and exact owned-room path.
  assert.equal(observation.session_id,report.initial_session.session_id);
  assert.equal(observation.player_id,report.initial_session.external_user_id);
  const ownPath=`/api/pvp/rooms/${report.room.id}`;
  const starts=raw.fetch_observations.filter(event=>event.kind==='start'&&event.url===entry.full_url&&event.method===entry.method);
  assert.ok(starts.length&&starts.every(value=>value.body_present===false),'Missing no-body evidence');
  Object.assign(entry,{request_observed:true,owned_room_at_start:observation.path===ownPath&&entry.full_url===origin+ownPath,session_id:observation.session_id,player_id:observation.player_id,game_frame_request:observation.game_frame_request&&entry.frame_url_raw===`${origin}/play/${report.initial_session.game_id}`,body_present:false,query:new URL(entry.full_url).search,failure_error:observation.error});
  return{entry,observation};
 });
 const oldCandidateCounts=failed.map(({entry})=>{
  const related=raw.network_protocol_observations.filter(record=>record.type==='Fetch'&&record.url===entry.full_url&&record.method===entry.method&&frames.get(record.frame_id)===entry.frame_object);
  const previous=related.filter(record=>requests.filter(other=>other!==entry&&other.response_seen&&other.frame_object===entry.frame_object&&other.full_url===entry.full_url&&other.method===entry.method&&other.network_started_at_ms>0&&Math.abs(other.network_started_at_ms-record.started_at_ms)<=1&&related.filter(candidate=>Math.abs(candidate.started_at_ms-other.network_started_at_ms)<=1).length===1).length!==1);
  return{request_id:entry.request_id,related:related.length,previous_candidates:previous.length,previous_successful_candidates:previous.filter(record=>record.response_seen&&!record.error).length,explicit_failures:related.filter(record=>record.error).length};
 });
 probe.bindNetwork(requests,failed);
 return{schema:'native-fetch-offline-replay-v1',scope:'Offline association diagnostic; does not revalidate or change the original device report, pass/fail, cleanup or performance conclusions. Original CDP session IDs were not recorded; original frame/document identity is used, without inventing session IDs.',original_report_passed:report.passed,counts:{requests:requests.length,fetch_events:raw.fetch_observations.length,protocol_records:raw.network_protocol_observations.length,raw_failures:failed.length},previous_algorithm:oldCandidateCounts,probe_errors:[...probe.errors],associations:failed.map(({entry,observation})=>({observation_id:observation.observation_id,classification:probe.classify(entry,requests)})),unmatched_fetch_rejections:probe.unmatchedRejections(failed)};
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
 const [source,out]=process.argv.slice(2);assert.ok(source&&out,'Usage: node tests/native-fetch-cancellation-replay.mjs SOURCE_REPORT NEW_OUTPUT_JSON');
 const bytes=await fs.readFile(source),digest=value=>createHash('sha256').update(value).digest('hex');
 const result=replayNativeFetchReport(JSON.parse(bytes));
 result.source_sha256=digest(bytes);result.helper_sha256=digest(await fs.readFile(new URL('../deploy/native-browser-checks.mjs',import.meta.url)));
 assert.equal(digest(await fs.readFile(source)),result.source_sha256,'Source report changed while reading');
 await fs.writeFile(out,JSON.stringify(result,null,2)+'\n',{flag:'wx'});console.log(JSON.stringify({output:resolve(out),source_sha256:result.source_sha256,original_report_passed:result.original_report_passed,associations:result.associations,unmatched:result.unmatched_fetch_rejections.length}));
}
