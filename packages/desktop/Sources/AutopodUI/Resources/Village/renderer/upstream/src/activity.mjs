// Presentation vocabulary shared by browser playback and video export.
export const ACTIVITIES = {
  browser:  {station:'archive', label:'Using browser', glyph:'search', color:'#a4d8ef'},
  pr:       {station:'harbor', label:'Creating a PR', glyph:'flag', color:'#f3b3c5'},
  retire:   {station:'inn', label:'Session ended · heading to Inn', glyph:'box', color:'#d6bbdb'},
  read:     {station:'archive', label:'Reading', glyph:'book', color:'#a4d8ef'},
  search:   {station:'archive', label:'Investigating', glyph:'search', color:'#a4d8ef'},
  edit:     {station:'workshop', label:'Editing', glyph:'hammer', color:'#ffd18b'},
  create:   {station:'workshop', label:'Creating', glyph:'hammer', color:'#ffd18b'},
  command:  {station:'workshop', label:'Running command', glyph:'terminal', color:'#ffd18b'},
  unknown:  {station:'workshop', label:'Using a tool', glyph:'terminal', color:'#c8d0dd'},
  check:    {station:'checks', label:'Checking', glyph:'check', color:'#c9b2ed'},
  build:    {station:'checks', label:'Building', glyph:'blocks', color:'#c9b2ed'},
  review:   {station:'review', label:'Reviewing', glyph:'review', color:'#aee0c5'},
  plan:     {station:'review', label:'Planning', glyph:'review', color:'#aee0c5'},
  supply:   {station:'depot', label:'Getting supplies', glyph:'box', color:'#e6c190'},
  external: {station:'depot', label:'External request', glyph:'box', color:'#e6c190'},
  deploy:   {station:'harbor', label:'Publishing', glyph:'flag', color:'#f3b3c5'},
  delegate: {station:'guild', label:'Assigning a helper', glyph:'flag', color:'#ffe08b'},
  handoff:  {station:'guild', label:'Reporting back', glyph:'letter', color:'#ffe08b'},
  approval: {station:'noticeboard', label:'Needs your input', glyph:'question', color:'#eadbc0'},
  wait:     {station:'square', label:'Waiting', glyph:'wait', color:'#d2c7b4'},
};

export function presentation(event,byId=new Map()){
  const data=event.data;
  let activity=event.kind==='session.end'?'retire':data.activity;
  if(event.kind==='agent.spawn')activity='delegate';
  if(event.kind==='agent.message')activity='handoff';
  if(event.kind==='action.result'||event.kind==='action.poll'){
    const original=(data.actionIds??event.causes??[]).map(id=>byId.get(id)).find(s=>s?.event.kind==='action.start');
    if(original)activity=original.activity??original.event.data.activity;
  }
  const type=ACTIVITIES[activity]??ACTIVITIES.unknown;
  let label=type.label;
  if(event.kind==='message')label='Speaking';
  if(event.kind==='agent.spawn')label='Helper recruited';
  if(event.kind==='action.poll')label='Waiting for results';
  if(event.kind==='action.result')label=data.status==='failed'?'Action failed':data.status==='running'?'Still running':data.status==='completed'?'Action completed':'Result received';
  const station=data.waiting?.kind==='agents'?'courtyard':type.station;
  return {...type,station,activity:activity??'dialogue',label};
}
