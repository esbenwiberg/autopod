import datetime,json,pathlib,subprocess,time,urllib.error,urllib.request
ident='6f6f4df6-dbc0-46ef-a36f-c546776e0916'
url='https://management.northeurope.azuredevcompute.io/subscriptions/06bb959b-9458-41a6-bdf5-77cc12feaab9/resourceGroups/ewi-sandboxes/sandboxGroups/autopod-spike-neu/sandboxes/'+ident+'?api-version=2026-02-01-preview'
p=subprocess.run(['az','account','get-access-token','--resource','https://dynamicsessions.io/','-o','json'],capture_output=True,text=True,timeout=30);assert p.returncode==0;token=json.loads(p.stdout)['accessToken']
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args,**kwargs):return None
def req(method):
 try:
  with urllib.request.build_opener(NoRedirect()).open(urllib.request.Request(url,method=method,headers={'Authorization':'Bearer '+token}),timeout=15) as r:
   body=r.read(256*1024+1);assert len(body)<=256*1024;return r.status,json.loads(body) if body else None
 except urllib.error.HTTPError as e:return e.code,None
code,body=req('GET');out={'id':ident,'observedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'initialStatus':code,'scope':'exact sandbox only; shared image retained'}
if code==200:
 assert body['id']==ident and body['labels']['podId']=='useful-dormouse' and body['labels']['managedBy']=='autopod' and body['labels']['purpose']=='autopod-sandbox'
 out['ownershipMatched']=True;out['deleteStatus']=req('DELETE')[0];assert out['deleteStatus'] in [200,202,204,404]
 for i in range(20):
  code,_=req('GET')
  if code==404:break
  time.sleep(2)
 out['finalStatus']=code;assert code==404;out['status']='deletion_verified'
else:out['status']='absence_at_checked_path' if code==404 else 'unavailable'
pathlib.Path('/private/tmp/autopod-rollout-133/canary-cleanup.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out))
