"""Single-container supervisor. External databases must be provisioned separately."""
import json
import os
from pathlib import Path
import secrets
import signal
import subprocess
import time

KEYS=('LINGLANG_VOICE_SERVICE_TOKEN','LINGLANG_VOICE_TICKET_SECRET','API_KEY_ENCRYPTION_SECRET')
def persistent_secrets(root, env):
    root.mkdir(parents=True,exist_ok=True)
    path=root/'secrets.json'
    if not path.exists():
        values={key:env.get(key) or secrets.token_hex(32) for key in KEYS}
        fd=os.open(path,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o600)
        with os.fdopen(fd,'w') as out:json.dump(values,out)
    values=json.loads(path.read_text())
    if any(not isinstance(values.get(k),str) or len(values[k])<32 for k in KEYS):
        raise ValueError('Invalid persistent secrets; refusing to overwrite')
    if any(env.get(k) and env[k]!=values[k] for k in KEYS):
        raise ValueError('Configured secrets differ from volume; explicit rotation required')
    return values

def main():
    env=dict(os.environ)
    root=Path('/data');env.update(persistent_secrets(root,env))
    appdata=root/'app';appdata.mkdir(exist_ok=True);os.chown(appdata,10001,10001)
    children=[]
    def start(command,cwd=None):
        process=subprocess.Popen(command,cwd=cwd,env=env,start_new_session=True)
        children.append(process);return process
    def stop(*_):raise KeyboardInterrupt
    signal.signal(signal.SIGTERM,stop);signal.signal(signal.SIGINT,stop)
    try:
        if not env.get('DATABASE_URL'):
            import pwd
            pguser=pwd.getpwnam('postgres')
            pg=root/'postgres';pg.mkdir(exist_ok=True);os.chown(pg,pguser.pw_uid,pguser.pw_gid);pg.chmod(0o700)
            if not (pg/'PG_VERSION').exists():
                subprocess.run(['gosu','postgres','initdb','-D',str(pg),'--auth-local=trust','--auth-host=trust'],check=True,env=env)
            start(['gosu','postgres','postgres','-D',str(pg),'-h','127.0.0.1','-p','5432'])
            for _ in range(120):
                if children[-1].poll() is not None:raise RuntimeError('Embedded PostgreSQL exited')
                if subprocess.run(['pg_isready','-h','127.0.0.1','-U','postgres'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0:break
                time.sleep(0.25)
            else:raise RuntimeError('Embedded PostgreSQL startup timed out')
            env['DATABASE_URL']='postgresql://postgres@127.0.0.1:5432/postgres'
            marker=root/'schema-initialized'
            if not marker.exists():
                # Only the owned embedded database is bootstrapped. Schema SQL
                # is transactional. A crash before marker creation deliberately
                # fails closed on restart instead of replaying against user data.
                exists=subprocess.check_output(['psql',env['DATABASE_URL'],'-Atc',"SELECT to_regclass('public.users') IS NOT NULL"],env=env,text=True).strip()
                if exists=='t':raise RuntimeError('Unmarked nonempty database; inspect before migration')
                files=sorted(Path('/opt/initial-schema').glob('*.sql'))
                if not files:raise RuntimeError('Initial schema missing')
                sql='CREATE EXTENSION IF NOT EXISTS vector;\n'+ '\n'.join(p.read_text() for p in files)
                sql+='\n'+Path('/app/agents/src/lib/pipecat-session-schema.sql').read_text()
                sql+='\n'+'\n'.join(p.read_text() for p in sorted(Path('/app/deploy/all-in-one/schema').glob('*.sql')))
                subprocess.run(['psql',env['DATABASE_URL'],'-v','ON_ERROR_STOP=1','--single-transaction'],input=sql,text=True,env=env,check=True)
                marker.touch()
        env['LINGLANG_INTERNAL_URL']='http://127.0.0.1:3000'
        env['LINGLANG_VOICE_RUNNER_URL']='http://127.0.0.1:7860'
        env['DASHBOARD_PORT']='3000'
        data=Path('/app/agents/data')
        if not data.exists():data.symlink_to(appdata,target_is_directory=True)
        start(['gosu','linglang','pnpm','dashboard'],cwd='/app/agents')
        start(['gosu','linglang','python','-m','product_bot','--transport','webrtc','--host','127.0.0.1','--port','7860'],cwd='/app/voice-py')
        while True:
            if any(p.poll() is not None for p in children):raise RuntimeError('A required service exited')
            time.sleep(0.5)
    except KeyboardInterrupt:
        pass
    finally:
        for p in reversed(children):
            if p.poll() is None:os.killpg(p.pid,signal.SIGTERM)
        for p in reversed(children):
            try:p.wait(timeout=15)
            except subprocess.TimeoutExpired:os.killpg(p.pid,signal.SIGKILL);p.wait()

if __name__=='__main__':main()
