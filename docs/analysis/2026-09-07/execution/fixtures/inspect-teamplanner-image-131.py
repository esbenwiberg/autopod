import json,pathlib,subprocess,urllib.request,urllib.error,base64,hashlib,re,datetime
reg='ewiautopodacr.azurecr.io';repo='autopod/teamplanner-pr-read';digest='sha256:96c67cb1ca0aa2a23851a4178a31743b61398167dad1e28f0c538f519a795d7c'
out={'observedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'manifestDigest':digest,'registryMutations':False,'sandboxOperations':False}
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args,**kwargs):return None
op=urllib.request.build_opener(NoRedirect())
def request(path,data=None,token=None):
 from urllib.parse import urlencode
 headers={'Accept':'application/vnd.docker.distribution.manifest.v2+json'}
 if token:headers['Authorization']='Bearer '+token
 if data is not None:headers['Content-Type']='application/x-www-form-urlencoded';data=urlencode(data).encode()
 q=urllib.request.Request('https://'+reg+path,data=data,headers=headers)
 try:
  with op.open(q,timeout=20) as r:raw=r.read(65537);assert r.status==200
 except urllib.error.HTTPError as e:
  if e.code not in [302,307] or not path.startswith('/v2/'+repo+'/blobs/'):raise
  from urllib.parse import urlsplit
  location=e.headers.get('Location','');u=urlsplit(location)
  assert len(location)<=8192 and u.scheme=='https' and u.hostname and u.hostname.endswith('.blob.core.windows.net') and not u.username and not u.password and u.port in [None,443]
  # The registry delegates this single blob read via SAS; do not forward ACR auth.
  with op.open(urllib.request.Request(location),timeout=20) as r:raw=r.read(65537);assert r.status==200
 assert len(raw)<=65536
 return raw
try:
 a=subprocess.run(['az','account','get-access-token','--resource','https://containerregistry.azure.net/','--query','accessToken','-o','tsv'],capture_output=True,text=True,timeout=30);assert a.returncode==0;aad=a.stdout.strip();claims=json.loads(base64.urlsafe_b64decode(aad.split('.')[1]+'==='));assert claims['oid']=='cef0aeed-b5d3-442e-b5d7-85e0526bd5e7'
 refresh=json.loads(request('/oauth2/exchange',{'grant_type':'access_token','service':reg,'access_token':aad}))['refresh_token']
 scoped=json.loads(request('/oauth2/token',{'grant_type':'refresh_token','service':reg,'scope':'repository:'+repo+':pull','refresh_token':refresh}))['access_token']
 raw=request('/v2/'+repo+'/manifests/'+digest,token=scoped);assert hashlib.sha256(raw).hexdigest()==digest[7:];manifest=json.loads(raw);out['compressedLayerBytes']=sum(v['size'] for v in manifest['layers']);digest=manifest['config']['digest'];out['configDigest']=digest;raw=request('/v2/'+repo+'/blobs/'+digest,token=scoped);assert hashlib.sha256(raw).hexdigest()==digest[7:];data=json.loads(raw);cfg=data['config'];out['configHashVerified']=True
 for key in ['User','WorkingDir']:
  value=cfg.get(key);out[key]=value if isinstance(value,str) and re.fullmatch(r'[A-Za-z0-9_./:-]{0,1024}',value) else None
 path=next((v[5:] for v in cfg.get('Env',[]) if v.startswith('PATH=')),None);out['PATH']=path if isinstance(path,str) and re.fullmatch(r'[A-Za-z0-9_./:-]{1,2048}',path) else None
 out['architecture']=data.get('architecture') if data.get('architecture') in ['amd64','arm64'] else None
 history=data.get('history',[]);out['historyEntryCount']=len(history);out['historyMentionsNodeInstall']=any(re.search(r'install.{0,80}node|node.{0,80}install',v.get('created_by',''),re.I) for v in history);out['historyMentionsDotnet']=any('dotnet' in v.get('created_by','').lower() for v in history)
 out['status']='allowlisted_config_observed'
except urllib.error.HTTPError as e:out.update(status='http_refused',httpStatus=e.code)
except Exception:out['status']='incomplete'
pathlib.Path('/private/tmp/autopod-teamplanner-image-131.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out,indent=2))
