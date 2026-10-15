// Provider counters are evidence, never estimates from dialogue length.
const fields=['input','output','cacheRead','cacheWrite','reasoning','total'];
const count=n=>Number.isSafeInteger(n)&&n>=0?n:null;
const sum=values=>values.every(n=>n!==null)&&Number.isSafeInteger(values.reduce((a,b)=>a+b,0))?values.reduce((a,b)=>a+b,0):null;
const empty=()=>Object.fromEntries(fields.map(k=>[k,null]));
const source=(row,sessionId)=>({file:row.file,line:row.line,sessionId});
function codexCounts(raw){
  if(!raw||typeof raw!=='object')return null;
  const c={input:count(raw.input_tokens),output:count(raw.output_tokens),cacheRead:count(raw.cached_input_tokens),cacheWrite:count(raw.cache_write_input_tokens),reasoning:count(raw.reasoning_output_tokens),total:count(raw.total_tokens)};
  c.total??=sum([c.input,c.output]);return fields.some(k=>c[k]!==null)?c:null;
}
export function codexUsage(sessions,{from=null,to=null}={}){
  return [...sessions].sort((a,b)=>a.meta.id.localeCompare(b.meta.id)).map(s=>{
    let baseline=null,last=null,previous=null,invalid=false;const notes=[];
    const start=s.records.find(r=>r.record.type==='session_meta'&&r.record.payload?.id===s.meta.id)?.record.timestamp??s.meta.createdAt;
    // New Codex logs explicitly identify the thread owning each cumulative counter.
    const scoped=s.records.some(({record:r})=>r.type==='token_usage_record'&&r.payload?.thread_id===s.meta.id&&(!to||!r.timestamp||r.timestamp<=to)&&codexCounts(r.payload.thread_token_usage));
    for(const row of [...s.records].sort((a,b)=>a.line-b.line)){
      const r=row.record;if(scoped?(r.type!=='token_usage_record'||r.payload?.thread_id!==s.meta.id):(r.type!=='event_msg'||r.payload?.type!=='token_count'))continue;
      if(to&&r.timestamp&&r.timestamp>to)continue;
      const counts=codexCounts(scoped?r.payload.thread_token_usage:r.payload.info?.total_token_usage);if(!counts)continue;
      const entry={source:source(row,s.meta.id),counts};
      if(!scoped&&s.meta.parentId&&Number.isFinite(r.ordinal)&&r.ordinal<s.meta.startOrdinal||from&&r.timestamp&&r.timestamp<from){baseline=entry;continue;}
      const prior=previous??baseline;
      if(prior&&fields.some(k=>counts[k]!==null&&prior.counts[k]!==null&&counts[k]<prior.counts[k]))invalid=true;
      previous=entry;last=entry;
    }
    let counts=last?{...last.counts}:empty();
    if(last&&baseline)for(const k of fields)counts[k]=counts[k]===null||baseline.counts[k]===null?null:counts[k]-baseline.counts[k];
    if(last&&((from&&(!start||from>start)&&!baseline)||(!scoped&&s.meta.parentId&&s.meta.startOrdinal>0&&!baseline))){invalid=true;notes.push('No cumulative baseline for this excerpt or inherited history.');}
    if(invalid){counts=empty();notes.push('Usage cannot be totaled reliably from these cumulative counters.');}
    if(!last)notes.push('No cumulative token usage recorded.');
    return {actorId:s.meta.actorId,provider:'codex',scope:baseline?'excerpt delta':scoped?'thread counters':'session counters',counts,partial:invalid||!last||counts.total===null,notes,records:[baseline,last].filter(Boolean)};
  });
}
function claudeCounts(raw){
  const cacheRead=count(raw.cache_read_input_tokens),cacheWrite=count(raw.cache_creation_input_tokens),input=sum([count(raw.input_tokens),cacheRead,cacheWrite]),output=count(raw.output_tokens);
  return {input,output,cacheRead,cacheWrite,reasoning:null,total:sum([input,output])};
}
export function claudeUsage(sessions){
  const root=sessions.find(s=>!s.meta.isHelper),rootIds=new Set(root.records.map(r=>r.record.uuid).filter(Boolean)),rootMessages=new Set(root.records.filter(r=>r.record.type==='assistant').map(r=>r.record.message?.id).filter(Boolean));
  return [...sessions].sort((a,b)=>a.meta.id.localeCompare(b.meta.id)).map(s=>{
    const messages=new Map(),notes=[];
    for(const row of [...s.records].sort((a,b)=>a.line-b.line)){
      const r=row.record;if(r.type!=='assistant'||r.isMeta===true||s.meta.isHelper&&(rootIds.has(r.uuid)||rootMessages.has(r.message?.id)))continue;
      const id=r.message?.id??r.uuid;if(!id){notes.push('A message without an ID could not be counted.');continue;}
      if(!messages.has(id))messages.set(id,{raw:{},records:[]});const item=messages.get(id),usage=r.message?.usage;
      if(!usage||typeof usage!=='object')continue;
      const raw=Object.fromEntries(['input_tokens','output_tokens','cache_read_input_tokens','cache_creation_input_tokens'].map(k=>[k,count(usage[k])]).filter(([,v])=>v!==null));
      if(!Object.keys(raw).length)continue;
      // One API message can occur as several content blocks or streaming snapshots.
      // Per-field maxima preserve final output without adding repeated snapshots.
      let changed=false;for(const [k,v] of Object.entries(raw))if(item.raw[k]===undefined||v>item.raw[k]){item.raw[k]=v;changed=true;}
      if(changed)item.records.push({source:source(row,s.meta.id),counts:claudeCounts(raw),raw});
    }
    const items=[...messages.values()],known=items.filter(i=>Object.keys(i.raw).length),parts=known.map(i=>claudeCounts(i.raw));
    const counts=Object.fromEntries(fields.map(k=>[k,parts.length?sum(parts.map(c=>c[k])):null]));
    const partial=known.length<items.length||!known.length||counts.total===null||notes.length>0;
    if(known.length<items.length)notes.push(`${items.length-known.length} assistant messages have no usage counters.`);
    if(!known.length)notes.push('No message token usage recorded.');
    return {actorId:s.meta.isHelper?`/agent/${s.meta.agentId}`:'/root',provider:'claude',scope:'recorded messages',counts,partial,notes,records:known.flatMap(i=>i.records)};
  });
}
const display=n=>n===null?'not recorded':n.toLocaleString('en-US');
export function usageSummary(timeline,team=null){
  const actors=timeline.actors.filter(a=>a.role!=='user'&&(!team||a.teamId===team));
  const entries=actors.map(a=>({actorId:a.id,name:a.name,...(timeline.usage??[]).find(u=>u.actorId===a.id),teamId:a.teamId??null}));
  const recorded=entries.filter(e=>e.counts?.total!==null&&e.counts?.total!==undefined);
  const totals=Object.fromEntries(fields.map(k=>[k,recorded.length?sum(recorded.map(e=>e.counts[k])):null]));
  const partial=recorded.length<entries.length||entries.some(e=>e.partial);
  const hasCounters=entries.some(e=>e.counts&&fields.some(k=>e.counts[k]!==null));
  const line=recorded.length?`TOKENS · ${display(totals.total)}${partial?' recorded · partial':' recorded'}`:hasCounters?'TOKENS · Partial counters only':'TOKENS · Not recorded';
  return {entries,totals,partial,recordedAgents:recorded.length,agentCount:entries.length,line,detail:`Input ${display(totals.input)} · Output ${display(totals.output)}`};
}
export function usageDetails(entry){
  const c=entry.counts??empty();return `Input ${display(c.input)} · Output ${display(c.output)} · Cache read ${display(c.cacheRead)} · Cache write ${display(c.cacheWrite)} · Reasoning ${display(c.reasoning)}`;
}
