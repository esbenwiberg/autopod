set -eu
python3 - <<'PY'
import json,subprocess
props=['MainPID','NRestarts','ExecMainCode','ExecMainStatus','ExecMainStartTimestamp','MemoryMax','MemoryCurrent','Result']
r=subprocess.run(['systemctl','show','autopod-daemon',*[x for p in props for x in ['-p',p]]],capture_output=True,text=True,timeout=10);out={'service':dict(x.split('=',1) for x in r.stdout.splitlines() if '=' in x)}
r=subprocess.run(['journalctl','-u','autopod-daemon','--since','2026-09-10 10:07:00 UTC','-n','220','--no-pager','-o','json'],capture_output=True,timeout=15);assert len(r.stdout)<1024**2
items=[]
for line in r.stdout.splitlines():
 try:e=json.loads(line);m=e.get('MESSAGE','');j=json.loads(m)
 except (ValueError,TypeError):
  if isinstance(m,str) and any(x in m for x in ['heap','memory','Main process exited','Failed with','Scheduled restart','Starting','Stopped','fatal']):items.append({'message':m[:250]})
  continue
 if isinstance(j,dict):
  if isinstance(j.get('err'),dict):
   er=j['err'];items.append({'msg':j.get('msg'),'type':er.get('type'),'code':er.get('code'),'message':str(er.get('message',''))[:350],'frames':str(er.get('stack','')).splitlines()[1:3]})
  elif any(x in str(j.get('msg','')) for x in ['shutdown','Shutting','starting','Started']):items.append({'message':j.get('msg')})
out['events']=items[-12:];text=json.dumps(out);assert len(text)<3500;print(text)
PY
