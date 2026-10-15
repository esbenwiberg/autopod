// Recorded reasons for inactivity. Silence is never treated as an input request
// or a finished task. These tracks contain derived UI state, not new log events.
export const PRESENCE_STYLES={
  closed:{label:'Session ended',color:'#d6bbdb',symbol:'☾',rank:6},
  input:{label:'Needs your input',color:'#ffd478',symbol:'!',rank:0},
  agents:{label:'Waiting for agents',color:'#93d5f5',symbol:'…',rank:1},
  running:{label:'Tool still running',color:'#99d8ce',symbol:'◷',rank:2},
  result:{label:'Awaiting tool result',color:'#b8cbdd',symbol:'◷',rank:3},
  finished:{label:'Turn finished',color:'#a9dda0',symbol:'✓',rank:4},
  idle:{label:'Idle · reason unrecorded',color:'#b8bac5',symbol:'z',rank:5},
};
const idle=()=>({kind:'idle',label:PRESENCE_STYLES.idle.label,targetIds:[],sourceId:null,basis:'No explicit waiting or completion event'});
export function buildPresence(timeline,{includePending=false}={}){
  const actors=new Map(timeline.actors.map(a=>[a.id,a])),pending=new Map(timeline.actors.map(a=>[a.id,new Map()])),finished=new Map(),tracks=Object.fromEntries(timeline.actors.map(a=>[a.id,[]]));
  const markers=timeline.scenes.flatMap(s=>[{at:s.start,scene:s,end:false},...((s.event.data.phase==='final'||s.event.data.turnEnd)?[{at:s.end,scene:s,end:true}]:[])]).sort((a,b)=>a.at-b.at||Number(a.end)-Number(b.end)||a.scene.id.localeCompare(b.scene.id));
  function snapshot(id,at){
    const candidates=[...pending.get(id).values()].sort((a,b)=>PRESENCE_STYLES[a.kind].rank-PRESENCE_STYLES[b.kind].rank||a.sourceId.localeCompare(b.sourceId));
    const state=candidates[0]??finished.get(id)??idle();
    const last=tracks[id].at(-1);if(last&&JSON.stringify(last.value)===JSON.stringify(state))return;
    tracks[id].push({at,value:{...state,targetIds:[...(state.targetIds??[])]}});
  }
  for(const {at,scene:s,end} of markers){
    const e=s.event,a=actors.get(e.actorId),own=pending.get(a.id),data=e.data;
    if(end){finished.set(a.id,{kind:'finished',label:'Turn finished',targetIds:[],sourceId:s.id,basis:'Recorded final response / end_turn marker'});snapshot(a.id,at);continue;}
    finished.delete(a.id);
    if(a.role==='user')for(const [id,map] of pending){
      for(const [key,wait] of map)if(wait.kind==='input'&&wait.async&&wait.sessionId===e.source.sessionId&&actors.get(id).teamId===a.teamId)map.delete(key);
      if(actors.get(id).teamId===a.teamId)finished.delete(id);
      snapshot(id,at);
    }
    if(e.kind==='action.start'&&data.callId){
      const wait=data.waiting;
      const kind=wait?.kind==='input'||s.activity==='approval'?'input':wait?.kind==='agents'?'agents':'result';
      const targetIds=(wait?.actorIds??[]).filter(id=>actors.has(id));
      const names=targetIds.map(id=>actors.get(id).name);
      const label=kind==='agents'?(names.length?`Waiting for ${names.join(', ')}`:'Waiting for agents'):PRESENCE_STYLES[kind].label;
      own.set(s.id,{kind,label,targetIds,sourceId:s.id,basis:kind==='result'?'Tool call has no recorded result yet':'Explicit waiting tool call',async:wait?.async===true,sessionId:e.source.sessionId,station:s.station,activity:s.activity});
    }
    if(e.kind==='action.result')for(const id of data.actionIds??e.causes??[]){
      const prior=own.get(id);if(!prior)continue;
      if(data.status==='running')own.set(id,{...prior,kind:prior.kind==='input'||prior.kind==='agents'?prior.kind:'running',label:prior.kind==='input'||prior.kind==='agents'?prior.label:'Tool still running',sourceId:s.id,basis:'Recorded running result'});
      else if(!(prior.kind==='input'&&prior.async&&data.status!=='failed'))own.delete(id);
    }
    snapshot(a.id,at);
  }
  return includePending?{tracks,pending:[...pending].flatMap(([actorId,map])=>[...map.values()].map(wait=>({...wait,actorId})))}:tracks;
}
export function presenceAt(timeline,actorId,time){
  const track=timeline.presence?.[actorId]??[];
  let low=0,high=track.length;while(low<high){const mid=(low+high)>>1;if(track[mid].at<=time)low=mid+1;else high=mid;}
  return low?track[low-1].value:idle();
}
export function presencePriority(actor){return actor.presence?.kind==='input'?0:actor.presence?.kind==='agents'?1:2;}
