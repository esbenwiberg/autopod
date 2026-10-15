import { usageSummary } from './usage.mjs';
import { checkKey } from './checks.mjs';
import { buildPresence } from './presence.mjs';

// Derived evidence only. No new source events and no claims about overall success.
export function buildRecapEvidence(timeline,actors){
  const byId=new Map(timeline.scenes.map(s=>[s.id,s])),runs=new Map();
  for(const s of timeline.scenes){
    if(s.activity==='check'&&s.event.kind==='action.start')runs.set(s.id,{id:s.id,actorId:s.event.actorId,teamId:s.event.teamId??null,label:s.event.data.commands?.join(' · ')??s.event.data.input?.command??s.text,status:'unconfirmed',sourceId:s.id,key:null});
    if(s.event.kind!=='action.result')continue;
    const ids=s.event.data.actionIds??s.event.causes??[],calls=ids.filter(id=>byId.get(id)?.event.kind==='action.start');
    for(const id of calls){const run=runs.get(id);if(!run)continue;
      const key=checkKey(s,byId);
      // A batch result cannot assign a successful exit to an individual check.
      run.status=calls.length===1&&key&&['completed','failed'].includes(s.status)?s.status:'unconfirmed';
      run.sourceId=s.id;run.key=key;
    }
  }
  const checks=[...runs.values()];
  for(const [i,run] of checks.entries())if(run.status==='failed')run.recoveredBy=checks.slice(i+1).find(next=>run.key&&next.key===run.key&&next.status==='completed'&&byId.get(next.sourceId).start>byId.get(run.sourceId).start)?.sourceId??null;
  const closed=new Set(actors.filter(a=>a.retired).map(a=>a.id));
  const pending=buildPresence(timeline,{includePending:true}).pending.filter(p=>!closed.has(p.actorId)).map(p=>({...p,teamId:timeline.actors.find(a=>a.id===p.actorId)?.teamId??null}));
  const prs=(timeline.celebrations??[]).map(c=>({...c.pr,sourceId:c.id,actorId:c.actorId,teamId:c.teamId}));
  return {checks,pending,prs};
}
export function recapSummary(timeline,team=null){
  const evidence=timeline.recap?.evidence;if(!evidence)return null;
  const filter=list=>list.filter(item=>!team||item.teamId===team),checks=filter(evidence.checks),pending=filter(evidence.pending),prs=filter(evidence.prs);
  const completed=checks.filter(c=>c.status==='completed').length,failed=checks.filter(c=>c.status==='failed').length,unconfirmed=checks.length-completed-failed,recovered=checks.filter(c=>c.recoveredBy).length;
  const input=pending.filter(p=>p.kind==='input').length,other=pending.length-input;
  const usage=usageSummary(timeline,team);
  return {usage,checks,pending,prs,completed,failed,unconfirmed,recovered,input,other,lines:[
    checks.length?`CHECK RUNS · ${completed} completed · ${failed} failed · ${unconfirmed} unconfirmed`:'CHECK RUNS · None recorded',
    failed?(recovered?`${recovered} failed run${recovered===1?' has':'s have'} a successful rerun recorded`:'No successful rerun recorded'):'No failed check runs recorded',
    prs.length?`HARBOR · ${prs.length} PR${prs.length===1?'':'s'} created`:'HARBOR · No PR creation recorded',
    input?`NOTICEBOARD · ${input} open input request${input===1?'':'s'}`:'NOTICEBOARD · No open input requests recorded',
    other?`${other} other tool / helper result${other===1?'':'s'} still unrecorded`:'No other tool / helper results pending',
    usage.line,
  ]};
}
