import json,pathlib,subprocess,base64,urllib.request,urllib.error,time,datetime
b=pathlib.Path('/private/tmp/autopod-durable-execution/docs/analysis/2026-09-07/execution');p=json.loads((b/'fixtures/canary-128-contract.json').read_text());j=json.loads(pathlib.Path('/private/tmp/autopod-canary-128-new-attempt-journal.json').read_text());out={'nonce':p['nonce'],'diskId':j['diskId'],'events':[]}
assert j['nonce']==p['nonce'] and j['diskId']=='2e5553f6-139b-4684-a2dd-2e18b1068164'
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args,**kwargs):return None
opener=urllib.request.build_opener(NoRedirect())
def event(kind,**fields):
 out['events'].append({'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'kind':kind,**fields});pathlib.Path('/private/tmp/autopod-canary-129-cleanup.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps({'kind':kind,**fields}),flush=True)
def req(method,suffix):
 request=urllib.request.Request(p['endpoint']+p['groupPath']+suffix+'?api-version='+p['apiVersion'],method=method,headers={'Authorization':'Bearer '+token})
 try:
  with opener.open(request,timeout=20) as r:raw=r.read(1048577);status=r.status
 except urllib.error.HTTPError as e:
  if e.code==404:return 404,{}
  raise ValueError('http_failure')
 assert len(raw)<=1048576
 return status,json.loads(raw) if raw else {}
def inventory(kind):
 status,body=req('GET','/'+kind);assert status==200
 if isinstance(body,list):items=body
 else:
  assert not body.get('nextLink');items=next(body[k] for k in ['value','items','diskImages'] if isinstance(body.get(k),list))
 assert len(items)<=100
 return items
def labels(x):return x.get('labels') or x.get('properties',{}).get('labels',{})
try:
 a=subprocess.run(['az','account','get-access-token','--resource','https://dynamicsessions.io/','--query','accessToken','-o','tsv'],capture_output=True,text=True,timeout=30);token=a.stdout.strip();assert a.returncode==0
 claims=json.loads(base64.urlsafe_b64decode(token.split('.')[1]+'==='));assert claims['oid']==p['principalId']
 for i in range(3):
  rows=inventory('sandboxes');matches=[x for x in rows if labels(x).get('acceptanceRun')==p['nonce']];assert not matches
  event('sandbox_nonce_absent',inventoryCount=len(rows))
  if i<2:time.sleep(10)
 out['sandboxRefusalReconciled']=True
 suffix='/diskimages/'+j['diskId'];status,disk=req('GET',suffix);assert status==200
 assert all(labels(disk).get(k)==v for k,v in p['importBody']['labels'].items())
 event('disk_owned_identity_verified')
 event('disk_delete_intent');status,_=req('DELETE',suffix);event('disk_delete_response',httpStatus=status);assert status in [200,202,204,404]
 for i in range(24):
  status,_=req('GET',suffix)
  if status==404:out['diskRemoved']=True;event('disk_absent_verified',httpStatus=status);break
  time.sleep(5)
 assert out.get('diskRemoved')
 rows=inventory('diskimages');assert all(labels(x).get('acceptanceRun')!=p['nonce'] for x in rows)
 out['result']='owned_disk_removed_sandbox_refused_no_resource_observed';event('final_inventory',diskCount=len(rows),sandboxCount=len(inventory('sandboxes')))
except Exception:out['result']='cleanup_unresolved';event('cleanup_unresolved')
pathlib.Path('/private/tmp/autopod-canary-129-cleanup.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps({'result':out['result']}))
