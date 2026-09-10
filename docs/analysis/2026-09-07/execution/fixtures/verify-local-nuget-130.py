import os,subprocess,json,pathlib,datetime
root=pathlib.Path('/private/tmp/autopod-nuget-130');env={'PATH':os.environ['PATH'],'HOME':str(root),'TMPDIR':'/private/tmp','DOTNET_CLI_HOME':str(root),'DOTNET_CLI_TELEMETRY_OPTOUT':'1','DOTNET_SKIP_FIRST_TIME_EXPERIENCE':'1','NUGET_PACKAGES':str(root/'packages')}
def run(args,seconds=15):
 p=subprocess.run(['dotnet',*args],cwd=root,env=env,capture_output=True,text=True,timeout=seconds);assert len(p.stdout.encode())+len(p.stderr.encode())<65536;return p
out={'observedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'scope':'local macOS SDK/public NuGet only; not teamplanner image/private feed acceptance','modelCalls':0,'sandboxCreates':0}
try:
 v=run(['--version']);out['sdkVersion']=v.stdout.strip();old=run(['nuget','search','__autopod_auth_probe__']);out['legacyCommandExit']=old.returncode
 h=run(['package','search','--help']);out['supportedHelp']=h.returncode==0 and all(f in h.stdout for f in ['--configfile','--take','--format'])
 l=run(['nuget','list','source','--configfile',str(root/'NuGet.Config')]);out['explicitPublicSourceListed']=l.returncode==0 and 'https://api.nuget.org/v3/index.json' in l.stdout
 s=run(['package','search','__autopod_auth_probe__','--configfile',str(root/'NuGet.Config'),'--take','1','--format','json'],60);out['searchExit']=s.returncode
 try:report=json.loads(s.stdout);out['validSearchResult']=isinstance(report.get('problems'),list) and not report['problems'] and isinstance(report.get('searchResult'),list)
 except Exception:out['validSearchResult']=False
 out['passed']=out['legacyCommandExit']!=0 and out['supportedHelp'] and out['explicitPublicSourceListed'] and s.returncode==0 and out['validSearchResult']
except Exception:out['passed']=False;out['incomplete']=True
(root/'result.json').write_text(json.dumps(out,indent=2)+'\n');print(json.dumps(out,indent=2))
