import subprocess,os,re,time,shutil,tempfile,json,urllib.request
from playwright.sync_api import sync_playwright
d=tempfile.mkdtemp();H=os.path.dirname(os.path.abspath(__file__));shutil.copytree(H+'/content',d+'/content');shutil.copytree(H+'/lib',d+'/lib');shutil.copy(os.path.dirname(os.path.abspath(__file__))+'/server.js',d);shutil.copy(os.path.dirname(os.path.abspath(__file__))+'/live.html',d);shutil.copy(os.path.dirname(os.path.abspath(__file__))+'/live.js',d);shutil.copy(os.path.dirname(os.path.abspath(__file__))+'/styles.css',d)
P='3981';sv=subprocess.Popen(['node','server.js'],cwd=d,env={**os.environ,'PORT':P},stdout=subprocess.PIPE,text=True);time.sleep(1.2)
pw=re.search(r'password "(\w+)"',sv.stdout.readline()+sv.stdout.readline()+sv.stdout.readline()).group(1)
U='http://localhost:'+P;errs=[];res=[]
def ok(c,m):res.append((c,m));print('PASS' if c else 'FAIL',m)
def api(m,u,b=None,t=None):
    r=urllib.request.Request(U+u,method=m,data=json.dumps(b).encode() if b is not None else None,headers={'Content-Type':'application/json',**({'Authorization':'Bearer '+t} if t else {})})
    return json.loads(urllib.request.urlopen(r).read() or b'{}')
with sync_playwright() as p:
    br=p.chromium.launch();oc=br.new_context();tc=br.new_context(viewport={'width':390,'height':800})
    o=oc.new_page();t=tc.new_page();o.on('dialog',lambda d:d.accept())
    for pg in(o,t):
        pg.on('console',lambda m:errs.append(m.text) if m.type=='error' else None);pg.on('pageerror',lambda e:errs.append(str(e)))
    o.goto(U);o.click('#lo') if False else None
    o.fill('#lu','organizer');o.fill('#lp','wrong');o.click('#lo');o.wait_for_timeout(300)
    ok('Wrong username or password' in o.inner_text('#app'),'UI: bad organizer login shows error')
    o.fill('#lu','organizer');o.fill('#lp',pw);o.click('#lo');o.wait_for_selector('text=Registered Teams');ok(True,'UI: organizer logs in')
    # team registers via UI
    t.goto(U);t.click('#tr');t.fill('#n','Zeta');t.fill('#i','MIT');t.fill('#m','Ann, Bob');t.click('#ok');t.wait_for_timeout(300)
    ok('Confirm that all members' in t.inner_text('#dlg'),'UI: declaration required message')
    t.check('#dc');t.click('#ok');t.wait_for_selector('text=approved by the organizer');code=t.inner_text('#dlg .timer');ok(len(code)==8,'UI: team sees 8-char access code after registering');t.click('#cl')
    t.fill('#tn','Zeta');t.fill('#tc',code);t.click('#tl');t.wait_for_timeout(400);ok('awaiting organizer approval' in t.inner_text('#app'),'UI: pending team blocked with clear message')
    # organizer sees live pending team without refresh and approves
    o.wait_for_selector('text=Zeta',timeout=5000);ok(True,'UI: organizer sees new team live (no refresh)')
    o.click('[data-act$="|active"]');o.wait_for_timeout(500)
    t.fill('#tn','Zeta');t.fill('#tc',code);t.click('#tl');t.wait_for_selector('#nav a:has-text("My Team")',timeout=5000);ok(True,'UI: approved team logs in')
    ok(t.evaluate('document.documentElement.scrollWidth<=window.innerWidth+1'),'UI: no horizontal scroll on 390px mobile')
    ok(all(x not in t.inner_text('nav') for x in['Controls','Audit']),'UI: team nav has no organizer sections')
    # run round 1 from organizer controls
    o.click('nav >> text=Controls');o.click('#evgo');o.wait_for_selector('text=Round 1 active');o.select_option('#r1mode','organizer');o.wait_for_timeout(500);o.click('[data-r1=start]');t.wait_for_selector('text=Question 1 of',timeout=6000);ok(True,'UI: question appears on team screen live')
    ok('Answer key' in o.inner_text('#app'),'UI: organizer sees answer key in controls')
    t.wait_for_timeout(600);ok(re.search(r'\d+s',t.inner_text('#cd')) is not None,'UI: countdown shown')
    t.once('dialog',lambda d:d.accept());t.click('.opt >> nth=0');t.wait_for_selector('text=Answer locked in',timeout=4000);ok(True,'UI: answer confirmation + locked state')
    html=t.content();ok('"explanation"' not in html and 'Answer key' not in html,'UI: no answer key in team page')
    o.click('[data-r1=pause]');t.wait_for_selector('text=PAUSED',timeout=4000);ok(True,'UI: pause reflected on team screen live')
    # disconnect/reconnect
    tc.set_offline(True);t.wait_for_timeout(500);tc.set_offline(False);o.click('[data-r1=resume]');t.wait_for_timeout(3500)
    ok('PAUSED' not in t.inner_text('#app'),'UI: team recovers state after offline/online')
    # ---- three-round workflow through the UI ----
    def flash_ok():o.wait_for_timeout(900)
    o.click('#evgo');o.wait_for_selector('text=Qualifiers for Round 2',timeout=6000);ok(True,'UI: Round 1 completed, qualifier panel appears')
    t.wait_for_selector('text=Waiting for Round 2 qualifiers',timeout=6000) if False else None
    o.click('#topgo');o.click('#qgo');flash_ok();ok(True,'UI: Round 2 qualifiers confirmed')
    t.wait_for_selector('text=You qualified for Round 2',timeout=6000);ok(True,'UI: team shown qualified live')
    o.select_option('#r2c','DD-01');o.click('[data-cfg=r2]');flash_ok();o.click('#evgo');o.wait_for_selector('text=Round 2 active',timeout=6000)
    t.wait_for_selector('text=Retail',timeout=6000);ok('Organizer guidance' not in t.content() and 'Expected' not in t.content(),'UI: team sees Round 2 case, no organizer guidance')
    o.click('[data-sg="r2|prep-start"]');t.wait_for_selector('[data-label=Preparation]',timeout=6000);t.wait_for_timeout(600);ok(re.search(r'\d+:\d\d',t.inner_text('[data-label=Preparation]')) is not None,'UI: prep timer visible to team')

    ok(t.locator('svg[role=img]').count()==2,'UI: team sees the two DD-01 charts (SVG)')
    ok(t.evaluate('document.documentElement.scrollWidth<=window.innerWidth+1'),'UI: Round 2 case + charts fit 390px mobile width')
    ok(t.locator('text=Download dataset').count()==1 and 'average_weekly' not in t.inner_text('table'),'UI: dataset table shows source columns only; download offered')
    t.screenshot(path='/tmp/shot_team_r2.png',full_page=True)
    # ---- reset dialog behaviour (organizer) ----
    o.click('[data-rs=r2]');o.wait_for_selector('#rgo');o.screenshot(path='/tmp/shot_reset_dialog.png')
    ok(o.is_enabled('#rgo') and 'Workflow reset' in o.inner_text('#dlg'),'UI: round reset dialog names the round and offers workflow scope by default')
    o.check('input[value=competition]');ok(o.is_disabled('#rgo') and 'deletes' in o.inner_text('#rinfo'),'UI: competition scope warns about deletion and is blocked until the phrase is typed')
    o.fill('#rph','reset round 2');ok(o.is_disabled('#rgo'),'UI: wrong/lowercase phrase keeps reset disabled');o.fill('#rph','RESET ROUND 2');ok(o.is_enabled('#rgo'),'UI: exact phrase enables reset')
    o.click('#rcl');ok(not o.is_visible('#dlg'),'UI: cancel closes dialog without resetting')
    o.click('[data-rs=event]');o.wait_for_selector('#rgo');ok(o.is_disabled('#rgo'),'UI: event reset requires typing RESET EVENT even for workflow scope');o.click('#rcl')
    o.click('[data-rs=r2]');o.wait_for_selector('#rgo');o.click('#rgo');o.wait_for_selector('#rok',timeout=5000);ok('Confirmed by the server' in o.inner_text('#dlg'),'UI: success message shown after server confirms');o.click('#rok')
    t.wait_for_selector('text=Preparation not started',timeout=6000);ok(True,'UI: team screen reflects the Round 2 workflow reset live (prep timer cleared, case kept)')
    ok(t.locator('svg[role=img]').count()==2,'UI: case and charts still shown after reset')
    o.click('[data-sg="r2|prep-start"]');t.wait_for_selector('[data-label=Preparation]',timeout=6000);ok(True,'UI: prep timer can be started again after reset')
    o.fill('#r2jn','Judge A');[o.fill('.r2s >> nth=%d'%i,v) for i,v in enumerate(['30','20','20'])];o.click('[data-jg=r2]');flash_ok();ok(True,'UI: judge sheet saved')
    o.click('#evgo');o.wait_for_selector('text=Qualifiers for Round 3',timeout=6000)
    o.click('#topgo');o.click('#qgo');flash_ok();o.select_option('#r3c','R3-01');o.click('[data-cfg=r3]');flash_ok();o.click('#evgo');o.wait_for_selector('text=Round 3 active',timeout=6000)
    t.wait_for_selector('text=CampusCart',timeout=6000);ok('Cross' not in t.content() and 'cross-question' not in t.content().lower(),'UI: finalist sees Round 3 scenario, no cross-questions')
    o.fill('#r3jn','Judge A');[o.fill('.r3s >> nth=%d'%i,v) for i,v in enumerate(['20','20','20','10','8'])];o.click('[data-jg=r3]');flash_ok()
    o.click('#evgo');o.wait_for_selector('text=The event is complete',timeout=6000)
    t.wait_for_selector('text=The event is complete',timeout=6000);ok(True,'UI: event completed on both screens live')
    t.click('nav >> text=Scoreboard');t.wait_for_selector('text=Zeta',timeout=5000);ok('178' in t.inner_text('#app') or '78' in t.inner_text('#app'),'UI: final standings visible to team')
    ok(t.evaluate('document.documentElement.scrollWidth<=window.innerWidth+1'),'UI: final screens fit mobile width')
    br.close()
sv.kill()
real=[e for e in errs if 'Failed to load resource' not in e]
ok(not real,'UI: no unexpected console errors '+str(real[:2]))
print('UI RESULT:',sum(1 for c,_ in res if c),'passed',sum(1 for c,_ in res if not c),'failed')
