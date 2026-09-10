import json,subprocess,urllib.request,urllib.error,time,datetime,base64,pathlib
p=json.loads(pathlib.Path('/private/tmp/autopod-durable-execution/docs/analysis/2026-09-07/execution/fixtures/canary-127-contract.json').read_text())
out={'nonce':p['nonce'],'mutations':False,'observations':[]}
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args,**kwargs):return None
try:
 a=subprocess.run(['az','account','get-access-token','--resource','https://dynamicsessions.io/','--query','accessToken','-o','tsv'],capture_output=True,text=True,timeout=30)
 token=a.stdout.strip();assert a.returncode==0
 claims=json.loads(base64.urlsafe_b64decode(token.split('.')[1]+'==='));assert claims['oid']==p['principalId']
 for tick in range(45):
  obs={'at':datetime.datetime.now(datetime.timezone.utc).isoformat()}
  for kind in ['diskimages','sandboxes']:
   url=p['endpoint']+p['groupPath']+'/'+kind+'?api-version='+p['apiVersion']
   req=urllib.request.Request(url,headers={'Authorization':'Bearer '+token})
   with urllib.request.build_opener(NoRedirect()).open(req,timeout=20) as response:
    raw=response.read(1048577);assert len(raw)<=1048576;assert response.status==200
   body=json.loads(raw)
   if isinstance(body,list):items=body
   else:
    assert not body.get('nextLink');items=next(body[k] for k in ['value','items','diskImages'] if isinstance(body.get(k),list))
   assert len(items)<=100
   matches=[x for x in items if (x.get('labels') or x.get('properties',{}).get('labels',{})).get('acceptanceRun')==p['nonce']]
   obs[kind]={'httpStatus':200,'total':len(items),'nonceMatches':len(matches),'matchingIds':[x.get('id') for x in matches]}
  out['observations'].append(obs)
  print(json.dumps(obs),flush=True)
  if any(obs[k]['nonceMatches']>0 for k in ['diskimages','sandboxes']):break
  if tick<44:time.sleep(10)
 out['nonceAbsentAllObservations']=all(o[k]['nonceMatches']==0 for o in out['observations'] for k in ['diskimages','sandboxes'])
 out['result']='timed_out_import_no_task_resource_observed' if out['nonceAbsentAllObservations'] else 'resource_requires_reconciliation'
except Exception:out['result']='incomplete'
pathlib.Path('/private/tmp/autopod-canary-128-reconciliation.json').write_text(json.dumps(out,indent=2)+'\n')
print(json.dumps({'result':out['result']}))
