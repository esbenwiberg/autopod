import importlib.util,json,pathlib
s=importlib.util.spec_from_file_location('d','/private/tmp/autopod-rollout-136/dispatch-retry.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
e=m.api('/pods/pregnant-hyena/events?limit=120');assert isinstance(e,list)
out=[]
for row in e:
 d={k:row[k] for k in ['eventId','type','timestamp','tool','message','costUsd','usage'] if k in row}
 if row.get('tool')=='mcp__escalation__report_task_summary':
  for k in ['input','output','toolInput','toolOutput','success']:
   if k in row:d[k]=row[k]
 if row.get('type')=='task_summary':
  for k in ['actualSummary','how','deviations','summary']:
   if k in row:d[k]=row[k]
 out.append(d)
p=pathlib.Path('/private/tmp/autopod-rollout-136/canary-events.json');p.write_text(json.dumps(out,indent=2)+'\n');print(json.dumps({'events':len(e),'types':list(set(x.get('type') for x in e)),'toolNames':list(set(x.get('tool') for x in e if x.get('tool')))}))
