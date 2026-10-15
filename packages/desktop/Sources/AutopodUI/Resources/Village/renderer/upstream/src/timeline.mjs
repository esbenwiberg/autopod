import { buildRecapEvidence } from './recap.mjs';
import { createdPr } from './milestones.mjs';
import { assignCast, matchesFocus, shareUserState } from './cast.mjs';
import { dialogueCue, DIALOGUE_VERSION } from './dialogue.mjs';
import { buildPresence, presenceAt } from './presence.mjs';
import { buildInterludes, interludeAt } from './rest.mjs';
import { STATION_NAMES } from './world.mjs';
import { presentation } from './activity.mjs';
import { LOCATIONS, stationRoute, stationSeat } from './world.mjs';
export { LOCATIONS } from './world.mjs';

const order=(a,b)=>a<b?-1:a>b?1:0;
const copy=p=>[...p];

function confirmedPublication(scene,byId){
  if(scene.event.kind!=='action.result'||scene.activity!=='deploy'||scene.status!=='completed')return false;
  const originals=(scene.event.data.actionIds??scene.event.causes??[]).map(id=>byId.get(id)).filter(s=>s?.event.kind==='action.start');
  if(originals.length!==1)return false;
  const data=originals[0].event.data,commands=data.commands??(data.tool==='Bash'?[data.input?.command]:[]);
  // A mixed orchestration batch cannot attribute an exit code to publication.
  return commands.length===1&&(data.operations?.length??1)===1&&typeof commands[0]==='string'&&!/--dry-run|--help/.test(commands[0]);
}

function topological(events) {
  const ids=new Set(events.map(e=>e.id)), pending=new Map(), followers=new Map(), previous=new Map();
  events.forEach((e,index)=>{
    const deps=new Set([...e.causes,...(e.after??[])].filter(id=>ids.has(id)));
    if(previous.has(e.actorId))deps.add(previous.get(e.actorId));
    previous.set(e.actorId,e.id);pending.set(e.id,{event:e,index,deps});
    for(const id of deps){if(!followers.has(id))followers.set(id,[]);followers.get(id).push(e.id);}
  });
  const ready=[...pending.values()].filter(x=>!x.deps.size), output=[];
  while(ready.length){ready.sort((a,b)=>a.index-b.index);const next=ready.shift();output.push(next.event);pending.delete(next.event.id);
    for(const id of followers.get(next.event.id)??[]){const item=pending.get(id);if(item){item.deps.delete(next.event.id);if(!item.deps.size)ready.push(item);}}
  }
  if(pending.size)throw new Error('Cyclic event dependencies prevent a faithful replay.');
  return output;
}

export function compileTimeline(conversation,{seed='village-1'}={}) {
  const sourceEvents=topological(conversation.events),byId=new Map(),actorEnd=new Map(),positions=new Map(),stations=new Map();
  const spawnEvents=new Map(sourceEvents.filter(e=>e.kind==='agent.spawn').map(e=>[e.data.childId,e.id]));
  const birth=new Map(conversation.actors.map(a=>[a.id,a.role==='helper'?Infinity:0]));
  const seenPrs=new Set();
  let helperIndex=0;
  const actors=assignCast(conversation.actors,conversation.sessionId??sourceEvents[0]?.source?.sessionId??'session').map(a=>{const slot=a.role==='helper'?helperIndex++:null;return {...a,skin:a.skin??(a.role==='user'?'user':a.role==='lead'?'lead':`helper${1+(slot%3)}`),slot};});
  const actorMeta=new Map(actors.map(a=>[a.id,a]));
  // Only visitors to a destination reserve space there. Stable IDs break ties.
  const visitors=new Map(Object.keys(LOCATIONS).map(k=>[k,new Set()]));
  for(const e of sourceEvents){const p=presentation(e),station=e.kind==='message'?'square':e.kind==='agent.message'?'guild':p.station;visitors.get(station).add(e.actorId);}
  for(const a of actors)visitors.get(a.role==='helper'?'guild':'square').add(a.id);
  const seats=new Map([...visitors].map(([k,set])=>[k,[...set].sort((a,b)=>
    (k==='square'?Number(actorMeta.get(b).role==='user')-Number(actorMeta.get(a).role==='user'):0)||order(a,b))]));
  const seat=(station,id)=>stationSeat(station,Math.max(0,seats.get(station).indexOf(id)),Math.max(1,seats.get(station).length));
  for(const a of actors){a.homeStation=a.role==='helper'?'guild':'square';a.startPosition=seat(a.homeStation,a.id);}
  const clocks=new Map(),scenes=[];
  for(const e of sourceEvents){
    const meta=actorMeta.get(e.actorId),team=meta?.teamId??'session';
    const clock=clocks.get(team)??{base:0,lastRecorded:null};clocks.set(team,clock);
    const recorded=e.timestamp?Date.parse(e.timestamp):null;
    if(clock.lastRecorded!==null&&Number.isFinite(recorded))clock.base+=Math.min(2.5,Math.max(.08,Math.log1p(Math.max(0,recorded-clock.lastRecorded)/1000)*.28));
    if(Number.isFinite(recorded))clock.lastRecorded=Math.max(clock.lastRecorded??recorded,recorded);
    const tiny=e.kind==='action.poll'||e.kind==='action.result',p=presentation(e,byId);
    const spawn=byId.get(spawnEvents.get(e.actorId));
    const dependencyTime=Math.max(0,...e.causes.map(id=>byId.get(id)?.start??0),...(e.after??[]).map(id=>byId.get(id)?.end??0),spawn?.end??0);
    const start=Math.max(clock.base,actorEnd.get(e.actorId)??0,dependencyTime+.02);
    const fromStation=stations.get(e.actorId)??meta.homeStation,from=positions.get(e.actorId)??meta.startPosition;
    const station=tiny?fromStation:e.kind==='message'?'square':p.station;
    const target=seat(station,e.actorId);
    let path;
    if(station===fromStation)path=[copy(from)];
    else path=[copy(from),...stationRoute(fromStation,station),copy(target)].filter((v,i,all)=>!i||Math.hypot(v[0]-all[i-1][0],v[1]-all[i-1][1])>.002);
    const length=path.slice(1).reduce((n,b,i)=>n+Math.hypot(b[0]-path[i][0],b[1]-path[i][1]),0);
    const travel=path.length>1?Math.max(.65,length*4.5):0;
    const text=e.data.text??e.data.summary??e.kind,cue=dialogueCue(text,e.kind);
    let pullRequest=createdPr(e,byId);if(pullRequest){if(seenPrs.has(pullRequest.url))pullRequest=null;else seenPrs.add(pullRequest.url);}
    const hold=pullRequest?9:tiny?(e.data.status==='failed'?2.8:e.data.evidence?.length?2.2:e.kind==='action.poll'?.65:1.1):Math.min(9,Math.max(e.data.waiting?6:cue?4.2:2.5,text.length/45));
    const end=start+travel+hold;
    const scene={id:e.id,event:e,start,end,travel,path,station,activity:p.activity,activityLabel:pullRequest?'PR created':p.label,text,status:e.data.status??'active',dialogueCue:cue,pullRequest};
    scenes.push(scene);byId.set(e.id,scene);actorEnd.set(e.actorId,end);positions.set(e.actorId,path.at(-1));stations.set(e.actorId,station);
    if(e.kind==='agent.spawn')birth.set(e.data.childId,start+travel+.15);
    if(!Number.isFinite(birth.get(e.actorId)))birth.set(e.actorId,start);
  }
  scenes.sort((a,b)=>a.start-b.start||order(a.id,b.id));
  for(const a of actors)a.appearsAt=Number.isFinite(birth.get(a.id))?birth.get(a.id):0;
  const eventDuration=Math.max(1,...scenes.map(s=>s.end));
  const timeline={schemaVersion:1,compilerVersion:'village-11',performanceVersion:'acting-1',dialogueVersion:DIALOGUE_VERSION,assetVersion:'village-4',seed,title:conversation.title,provider:conversation.provider??null,sessionId:conversation.sessionId??null,teams:conversation.teams??[],sourceHash:conversation.contentHash,usage:conversation.usage??[],actors,scenes,eventDuration,duration:eventDuration+10,warnings:conversation.warnings,stats:conversation.stats};
  timeline.presence=buildPresence(timeline);
  timeline.interludes=buildInterludes(timeline);
  timeline.celebrations=scenes.filter(s=>s.pullRequest).map(s=>({id:s.id,actorId:s.event.actorId,teamId:s.event.teamId??null,start:s.start+.3,end:s.end,pr:s.pullRequest}));
  timeline.departures=scenes.filter(s=>confirmedPublication(s,byId)).map(s=>({id:s.id,actorId:s.event.actorId,teamId:s.event.teamId??null,start:s.start+.3,end:s.start+7.3})).concat(timeline.celebrations);
  timeline.retirements=[];
  for(const s of scenes.filter(s=>s.event.kind==='session.end')){
    const owner=actorMeta.get(s.event.actorId),at=sceneAt(timeline,Math.max(0,s.start-.00001));
    for(const a of at.actors.filter(a=>a.role!=='user'&&(owner.role==='lead'?a.teamId===owner.teamId:a.id===owner.id))){
      const station=interludeAt(timeline,a.id,s.start)?.station??a.scene?.station??a.homeStation;
      const path=[a.position,...stationRoute(station,'inn'),LOCATIONS.inn];
      const travel=Math.max(.65,path.slice(1).reduce((n,p,i)=>n+Math.hypot(p[0]-path[i][0],p[1]-path[i][1]),0)*4.5);
      const resume=scenes.find(next=>next.event.actorId===a.id&&next.start>s.start&&next.event.kind!=='session.end');
      timeline.retirements.push({id:s.id,actorId:a.id,teamId:a.teamId??null,start:s.start,end:s.start+travel,travel,path,resumeAt:resume?.start??null});
      timeline.duration=Math.max(timeline.duration,s.start+travel+3);
    }
  }
  if(scenes.length){
    const start=timeline.duration,snapshot=sceneAt(timeline,start);
    const available=snapshot.actors.filter(a=>a.role!=='user'&&!a.retired&&!a.missingTranscript&&['idle','finished'].includes(a.presence.kind)).sort((a,b)=>order(a.id,b.id));
    // Reserve existing trainer seats, then assign stable gathering spots.
    const offset=actors.filter(a=>a.role==='user').length;
    const walks=available.map((a,i)=>{
      const station=interludeAt(timeline,a.id,start)?.station??a.scene?.station??a.homeStation;
      const path=[a.position,...stationRoute(station,'square'),stationSeat('square',i+offset,available.length+offset)];
      const travel=path.slice(1).reduce((n,p,j)=>n+Math.hypot(p[0]-path[j][0],p[1]-path[j][1]),0)*4.5;
      return {actorId:a.id,path,travel};
    });
    const cardAt=start+Math.max(0,...walks.map(w=>w.travel)),end=cardAt+10;
    timeline.recap={start,cardAt,end,walks,evidence:buildRecapEvidence(timeline,snapshot.actors)};
    timeline.duration=end;
    for(const track of Object.values(timeline.interludes))for(const rest of track)if(rest.returnAt===null)rest.end=end;
  }
  return timeline;
}

function along(path,p) {
  if(path.length===1)return {position:copy(path[0]),direction:0};
  const lengths=path.slice(1).map((b,i)=>Math.hypot(b[0]-path[i][0],b[1]-path[i][1]));
  let d=lengths.reduce((a,b)=>a+b,0)*Math.min(1,Math.max(0,p));
  for(let i=0;i<lengths.length;i++){
    if(d<=lengths[i]||i===lengths.length-1){const a=path[i],b=path[i+1],f=lengths[i]?Math.min(1,d/lengths[i]):1,dx=b[0]-a[0],dy=b[1]-a[1];
      return {position:[a[0]+dx*f,a[1]+dy*f],direction:Math.abs(dx)>Math.abs(dy)?dx>0?2:1:dy>0?0:3};}
    d-=lengths[i];
  }
}

export function sceneAt(timeline,time,{focus=null,team=null}={}) {
  const t=Math.max(0,Math.min(timeline.duration,Number.isFinite(time)?time:0));
  const latest=new Map();let current=null;
  for(const s of timeline.scenes){if(s.start>t)break;latest.set(s.event.actorId,s);if((!focus||matchesFocus(timeline,s.event.actorId,focus))&&(!team||s.event.teamId===team))current=s;}
  const actors=timeline.actors.filter(a=>a.appearsAt<=t&&(!team||a.teamId===team)).map(a=>{
    const s=latest.get(a.id);let position=a.startPosition??(a.role==='user'?[0.50,0.86]:a.role==='helper'?[0.25,0.36]:[0.5,0.57]),direction=0,moving=false;
    if(s){const progress=s.travel?(t-s.start)/s.travel:1;({position,direction}=along(s.path,progress));moving=progress<1;}
    const rest=interludeAt(timeline,a.id,t);let presence=presenceAt(timeline,a.id,t);
    const retirement=(timeline.retirements??[]).findLast(r=>r.actorId===a.id&&r.start<=t&&(r.resumeAt===null||t<r.resumeAt));
    if(rest){const returning=rest.returnAt!==null&&t>=rest.returnAt,progress=rest.travel?(t-(returning?rest.returnAt:rest.start))/rest.travel:1;
      ({position,direction}=along(returning?[...rest.path].reverse():rest.path,progress));moving=progress<1;}
    if(retirement){({position,direction}=along(retirement.path,(t-retirement.start)/retirement.travel));moving=t<retirement.end;presence={kind:'closed',label:moving?'Session ended · heading to Inn':'At the Inn · session ended',targetIds:[],sourceId:retirement.id,basis:'Explicit session-end record'};}
    const gathering=t>=timeline.recap?.start?timeline.recap.walks.find(w=>w.actorId===a.id):null;
    if(gathering){({position,direction}=along(gathering.path,gathering.travel?(t-timeline.recap.start)/gathering.travel:1));moving=t<timeline.recap.start+gathering.travel;}
    const celebration=(timeline.celebrations??[]).find(c=>c.start<=t&&c.end>t&&(c.teamId??null)===(a.teamId??null));
    const active=s&&t<s.end;
    const cheering=!retirement&&a.role!=='user'&&!moving&&(a.id===celebration?.actorId||!active)?celebration:null;
    const special=['input','agents','closed'].includes(presence.kind)||(!active&&presence.kind!=='idle')||s?.status==='running';
    const label=special?presence.label:active?s.activityLabel??'Working':a.role==='user'?'You':a.missingTranscript?'Transcript not supplied':presence.label;
    return {...a,gathering:!!gathering,retired:!!retirement&&t>=retirement.end,celebration:cheering,position,direction,moving,scene:s??null,presence,resting:!!rest&&!retirement&&!cheering&&!gathering,leisure:retirement||gathering?null:rest?.leisure??null,restStartedAt:rest?rest.start+rest.travel:null,activityLabel:gathering?(moving?'Gathering in the square':'At the quest recap'):cheering?`Cheering · PR #${cheering.pr.number}`:moving&&!special?`Going to ${STATION_NAMES[rest?.station??s?.station]??'the village'}`:label,state:special?presence.kind:moving?'traveling':active?(s.status==='failed'?'failed':s.event.kind.includes('message')?'speaking':'working'):'idle',frame:Math.floor(t*8)};
  });
  return {time:t,actors:shareUserState(timeline,actors,focus),current,active:timeline.scenes.filter(s=>s.start<=t&&s.end>t&&(!team||s.event.teamId===team))};
}
