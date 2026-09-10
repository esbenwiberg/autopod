import datetime,json,os,pathlib,subprocess,sys,urllib.request,urllib.parse
ORIGIN='https://autopod-daemon-ewi.swedencentral.cloudapp.azure.com'
STATE=pathlib.Path('/private/tmp/autopod-rollout-136/dispatch-retry-state.json')
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args,**kwargs):return None
_token=None
def api(path,method='GET',body=None):
 global _token
 if _token is None:
  p=subprocess.run(['ap','token'],capture_output=True,text=True,timeout=30);assert p.returncode==0
  _token=p.stdout.strip();assert _token.startswith('eyJ') and _token.count('.')==2
 req=urllib.request.Request(ORIGIN+path,data=None if body is None else json.dumps(body).encode(),headers={'Authorization':'Bearer '+_token,**({'Content-Type':'application/json'} if body is not None else {})},method=method)
 with urllib.request.build_opener(NoRedirect()).open(req,timeout=20) as res:
  raw=res.read(2*1024*1024+1);assert len(raw)<=2*1024*1024
  return json.loads(raw)
def save(v):
 fd=os.open(STATE,os.O_WRONLY|os.O_CREAT|os.O_TRUNC,0o600)
 with os.fdopen(fd,'w') as f:json.dump(v,f)
def subset(c):return {k:c.get(k) for k in ['activation','authorizedUntil','profileScope','decisionTarget','budgets']}
def main(mode):
 if mode=='inspect':
  assert not STATE.exists(),'state already exists'
  schedules=api('/scheduled-jobs');profiles=api('/profiles');p=api('/podsitter')['configuration']
  assert isinstance(schedules,list) and isinstance(profiles,list) and p
  state={'observedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'jobs':[{'id':j['id'],'nextRunAt':j['nextRunAt'],'catchupPending':j['catchupPending']} for j in schedules if j['enabled'] is True],'watchers':[j['name'] for j in profiles if j.get('issueWatcherEnabled') is True],'podsitter':{'enabled':p['enabled'],'generation':p['generation'],'settings':subset(p)},'operations':[]}
  assert len(state['jobs'])==1 and len(state['watchers'])==1 and p['enabled'] is True,'dispatch inventory changed'
  save(state);print(json.dumps({'status':'inspected','enabledSchedules':1,'enabledWatchers':1,'podsitterEnabled':True}))
 elif mode=='pause':
  s=json.loads(STATE.read_text());assert not s['operations'],'already attempted; inspect state'
  v=api('/maintenance/hosted-deploy-drain','POST',{'ttlSeconds':3600});assert v['active'];s['operations'].append('drain');save(s)
  p=api('/podsitter')['configuration'];assert subset(p)==s['podsitter']['settings'] and p['generation']==s['podsitter']['generation']
  s['pausedGeneration']=p['generation']+1;s['operations'].append('podsitter');save(s)
  p=api('/podsitter/disable','POST',{});assert p['enabled'] is False and subset(p)==s['podsitter']['settings'] and p['generation']==s['pausedGeneration']
  for name in s['watchers']:
   s['operations'].append('watcher:'+name);save(s)
   p=api('/profiles/'+urllib.parse.quote(name,safe=''),'PATCH',{'issueWatcherEnabled':False});assert p['issueWatcherEnabled'] is False
  for j in s['jobs']:
   s['operations'].append('job:'+j['id']);save(s)
   p=api('/scheduled-jobs/'+urllib.parse.quote(j['id'],safe=''),'PUT',{'enabled':False});assert p['enabled'] is False and p['nextRunAt']==j['nextRunAt'] and p['catchupPending']==j['catchupPending']
  print(json.dumps({'status':'paused','operations':len(s['operations']),'scheduleWindowPreserved':True,'podsitterBindingAndAuthorizationPreserved':True}))
 elif mode=='restore':
  s=json.loads(STATE.read_text())
  for j in s['jobs']:
   key='job:'+j['id']
   if key not in s['operations']:continue
   path='/scheduled-jobs/'+urllib.parse.quote(j['id'],safe='');p=api(path);assert p['enabled'] is False and p['nextRunAt']==j['nextRunAt']
   assert p['catchupPending']==j['catchupPending']
   assert p['catchupPending'] is True or datetime.datetime.fromisoformat(j['nextRunAt'].replace('Z','+00:00'))>datetime.datetime.now(datetime.timezone.utc),'schedule became overdue; retain disabled pending catchup reconciliation'
   p=api(path,'PUT',{'enabled':True});assert p['enabled'] is True and p['nextRunAt']==j['nextRunAt'];s['operations'].remove(key);save(s)
  for name in s['watchers']:
   key='watcher:'+name
   if key not in s['operations']:continue
   path='/profiles/'+urllib.parse.quote(name,safe='');p=api(path);assert p['issueWatcherEnabled'] is False
   p=api(path,'PATCH',{'issueWatcherEnabled':True});assert p['issueWatcherEnabled'] is True;s['operations'].remove(key);save(s)
  if 'podsitter' in s['operations']:
   p=api('/podsitter')['configuration'];assert p['enabled'] is False and p['generation']==s['pausedGeneration'] and subset(p)==s['podsitter']['settings']
   p=api('/podsitter/enable','POST',{});assert p['enabled'] is True and subset(p)==s['podsitter']['settings'];s['operations'].remove('podsitter');save(s)
  if 'drain' in s['operations']:
   p=api('/maintenance/hosted-deploy-drain','DELETE');assert p['active'] is None;s['operations'].remove('drain');save(s)
  print(json.dumps({'status':'restored','pendingOperations':len(s['operations'])}))
 else:raise ValueError('mode')
if __name__=='__main__':
 try:main(sys.argv[1])
 except Exception as e:print(json.dumps({'status':'incomplete','errorClass':type(e).__name__}));sys.exit(1)
