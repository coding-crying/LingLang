"""Disposable preview acceptance: boot, signup, session and volume continuity."""
import http.cookiejar,json,secrets,subprocess,sys,time,urllib.request,urllib.error
engine,image=sys.argv[1:3];port=14192 if engine=='docker' else 14193
name='linglang-release-check-'+engine;volume=name+'-data';base=f'http://127.0.0.1:{port}'
def cmd(*args):return subprocess.check_output([engine,*args],text=True).strip()
def start():cmd('run','-d','--name',name,'-p',f'127.0.0.1:{port}:3000','-v',volume+':/data',image)
def ready():
 for _ in range(120):
  try:
   if urllib.request.urlopen(base+'/login',timeout=2).status==200:return
  except Exception:pass
  time.sleep(1)
 raise RuntimeError('Dashboard readiness timeout')
jar=http.cookiejar.CookieJar();client=urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
def request(path,body=None):
 req=urllib.request.Request(base+path,data=json.dumps(body).encode() if body else None,headers={'Content-Type':'application/json'})
 try:
  with client.open(req,timeout=15) as r:return json.load(r)
 except urllib.error.HTTPError as e:raise RuntimeError(f'{path}: HTTP {e.code} '+e.read().decode()[:1000])
def secrets_hash():return cmd('exec',name,'python','-c',"import hashlib,pathlib; p=pathlib.Path('/data/secrets.json');assert p.stat().st_mode&0o777==0o600;print(hashlib.sha256(p.read_bytes()).hexdigest())")
try:
 start();ready();first=secrets_hash()
 result=request('/api/signup',{'username':'previewcheck','email':'previewcheck@example.invalid','password':secrets.token_urlsafe(24),'targetLanguage':'pt','nativeLanguage':'en'})
 assert result.get('success'),result
 user=request('/api/me');assert 'previewcheck' in json.dumps(user),user
 cmd('rm','-f',name);start();ready();assert secrets_hash()==first
 user=request('/api/me');assert 'previewcheck' in json.dumps(user),user
 print(engine+': fresh signup, authenticated API, persisted session/user and secrets after recreation PASS')
except Exception:
 try:print(cmd('logs','--tail','100',name))
 except Exception:pass
 raise
finally:
 subprocess.run([engine,'rm','-f',name],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 subprocess.run([engine,'volume','rm',volume],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
