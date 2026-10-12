# Browser check of the v7 screens (needs: pip install playwright && playwright install chromium). Run: python3 ui-smoke-v7.py
import subprocess,os,re,time,shutil,tempfile,json,urllib.request,sys
from playwright.sync_api import sync_playwright
H=os.path.dirname(os.path.abspath(__file__));d=tempfile.mkdtemp()
for x in('content','lib'):shutil.copytree(H+'/'+x,d+'/'+x)
for f in('server.js','live.html','live.js','styles.css'):shutil.copy(H+'/'+f,d+'/'+f)
P='3982';sv=subprocess.Popen(['node','server.js'],cwd=d,env={**os.environ,'PORT':P},stdout=subprocess.PIPE,text=True);time.sleep(1.3)
pw=re.search(r'password "(\w+)"',sv.stdout.readline()+sv.stdout.readline()+sv.stdout.readline()).group(1)
U='http://localhost:'+P;errs=[];fails=0
SHOTS=os.environ.get('SHOTS','/tmp/shots');os.makedirs(SHOTS,exist_ok=True)
def ok(c,m):
    global fails;print('PASS' if c else 'FAIL',m);fails+=0 if c else 1
def api(m,u,b=None,t=None):
    r=urllib.request.Request(U+u,method=m,data=json.dumps(b).encode() if b is not None else None,headers={'Content-Type':'application/json',**({'Authorization':'Bearer '+t} if t else {})})
    try:return json.loads(urllib.request.urlopen(r).read() or b'{}')
    except urllib.error.HTTPError as e:return {'_err':e.code,**json.loads(e.read() or b'{}')}
try:
    O=api('POST','/api/login',{'role':'organizer','username':'organizer','password':pw})['token']
    codes={};ids={}
    for n in('Alpha','Bravo'):
        r=api('POST','/api/signup',{'name':n,'inst':'ABC','members':['a','b'],'declare':True});codes[n]=r['code'];ids[n]=r['teamId'];api('POST','/api/teams/'+r['teamId']+'/status',{'status':'active'},O)
    TOK={n:api('POST','/api/login',{'role':'team','name':n,'code':codes[n]})['token'] for n in codes}
    QS=api('GET','/api/state',None,O)['questions'];key={q['id']:q for q in QS}
    api('POST','/api/event/start',{'from':'not_started'},O);api('POST','/api/r1/start',{},O)
    with sync_playwright() as p:
        br=p.chromium.launch();oc=br.new_context(viewport={'width':1200,'height':900});tc=br.new_context(viewport={'width':390,'height':800})
        o=oc.new_page();t=tc.new_page()
        for pg in(o,t):
            pg.on('dialog',lambda dl:dl.accept());pg.on('console',lambda m:errs.append(m.text) if m.type=='error' else None);pg.on('pageerror',lambda e:errs.append(str(e)))
        o.goto(U);o.fill('#lu','organizer');o.fill('#lp',pw);o.click('#lo');o.wait_for_selector('text=Registered Teams')
        t.goto(U);t.fill('#tn','Alpha');t.fill('#tc',codes['Alpha']);t.click('#tl');t.wait_for_selector('#nav a:has-text("My Team")')
        t.click('#nav a:has-text("My Team")')
        # ---- 1. self-paced Round 1 in the browser
        t.wait_for_selector('#r1begin');ok('Begin Round 1' in t.inner_text('#app') and 'Question 1' not in t.inner_text('#app'),'UI: team sees Begin Round 1, no question yet')
        t.screenshot(path=SHOTS+'/1_ready.png',full_page=True);t.click('#r1begin');t.wait_for_selector('button.opt')
        t.wait_for_function("document.querySelector('[data-up]')&&/Elapsed/.test(document.querySelector('[data-up]').textContent)");ok('question 1 of 30' in t.inner_text('#app').lower() and 'elapsed' in t.inner_text('#app').lower(),'UI: first question and elapsed timer shown')
        ok(t.is_visible('#r1adv') and 'Skip' in t.inner_text('#r1adv'),'UI: Skip offered before answering')
        t.click('button.opt >> nth=0');t.wait_for_selector('text=Answer locked in')
        ok('Next question' in t.inner_text('#r1adv'),'UI: after answering the team can move on itself')
        t.screenshot(path=SHOTS+'/2_question.png',full_page=True);t.click('#r1adv');t.wait_for_selector('text=Question 2 of 30');ok(True,'UI: Next question works without the organizer')
        t.click('#r1adv');t.wait_for_selector('text=Question 3 of 30');ok(True,'UI: Skip moves to the next question')
        # organizer sees live timing
        o.click('#nav a:has-text("Controls")');o.wait_for_selector('text=Round 1 timing');ok('In progress' in o.inner_text('#app') and 'Not started' in o.inner_text('#app'),'UI: organizer timing table shows in-progress and not-started teams')
        ok('Next question' not in o.inner_text('#app').split('Event settings')[0].split('Round 1 live control')[1],'UI: organizer Next/Reveal hidden in self-paced mode')
        o.screenshot(path=SHOTS+'/3_org_timing.png',full_page=True)
        with o.expect_download() as dl:o.click('#tcsv')
        ok(dl.value.suggested_filename=='round1_timing.csv','UI: timing CSV downloads')
        # finish the remaining questions through the API, then look at the team screen
        tokA=TOK['Alpha']
        while True:
            s=api('GET','/api/state',None,tokA)['r1']
            if not s.get('current'):break
            c=s['current'];api('POST','/api/submit',{'qid':c['id'],'choice':key[c['id']]['a']},tokA);r=api('POST','/api/r1/advance',{'qid':c['id']},tokA)
            if r.get('finished'):break
        t.wait_for_selector('text=Round 1 complete',timeout=6000);ok('Total time' in t.inner_text('#app'),'UI: finished card shows start, finish and total time');t.screenshot(path=SHOTS+'/4_finished.png',full_page=True)
        # ---- 2. Round 2 score visible after completion
        api('POST','/api/event/complete-r1',{'from':'r1_active','confirm':True},O)
        api('POST','/api/event/qualify',{'round':'r2','teamIds':[ids['Alpha'],ids['Bravo']]},O);api('POST','/api/stage/r2/config',{'contentId':'DD-01','prepMin':12},O);api('POST','/api/event/start-r2',{'from':'r1_completed'},O)
        for j,sc in(('J1',{'analytical':30,'clarity':20,'relevance':20}),('J2',{'analytical':40,'clarity':30,'relevance':30})):api('POST','/api/judge',{'round':'r2','teamId':ids['Alpha'],'judge':j,'scores':sc},O)
        t.wait_for_timeout(600);ok('Round 2 score' in t.inner_text('#app') and 'in progress' in t.inner_text('#app'),'UI: score shows "in progress" while Round 2 is active')
        api('POST','/api/event/complete-r2',{'from':'r2_active','confirm':True},O);t.wait_for_selector('text=Round 2 score: 85',timeout=6000);ok(True,'UI: Round 2 score 85 appears live after completion')
        t.screenshot(path=SHOTS+'/5_scores.png',full_page=True)
        # ---- 3/4. Final Round picker + organizer assignment
        api('POST','/api/event/qualify',{'round':'r3','teamIds':[ids['Alpha'],ids['Bravo']]},O);api('POST','/api/event/start-r3',{'from':'r2_completed'},O)
        t.wait_for_selector('[data-pick]',timeout=6000);ok(t.locator('[data-pick]').count()==3,'UI: finalist sees three problem sets to choose from')
        ok('key facts' not in t.inner_text('#app').lower(),'UI: problem details hidden until a set is chosen');t.screenshot(path=SHOTS+'/6_picker.png',full_page=True)
        t.click('[data-pick="R3-02"]');t.wait_for_function("/key facts/i.test(document.getElementById('app').innerText)",timeout=6000);ok('your set' in t.inner_text('#app').lower() and 'key facts' in t.inner_text('#app').lower(),'UI: chosen set shown in full with "Your set" marker');t.screenshot(path=SHOTS+'/7_chosen.png',full_page=True)
        o.click('#nav a:has-text("Controls")');o.wait_for_selector('[data-asg]',timeout=6000);ok(o.locator('[data-asg]').count()==2,'UI: organizer sees one assignment control per finalist')
        o.select_option('[data-asg="%s"]'%ids['Alpha'],'R3-03');t.wait_for_selector('text=Time is up',timeout=1) if False else None
        t.wait_for_selector('text=The organizer assigned your problem set',timeout=6000);ok('TiffinTrail' in t.inner_text('#app') and t.locator('[data-pick]').count()==0,'UI: assignment overrides choice live; team can no longer switch')
        o.screenshot(path=SHOTS+'/8_org_assign.png',full_page=True);t.screenshot(path=SHOTS+'/9_assigned.png',full_page=True)
        o.click('[data-sg="r3|prep-start"]');o.wait_for_selector('text=problem sets are locked',timeout=6000);ok(o.locator('[data-asg][disabled]').count()==2,'UI: assignment controls lock when preparation starts')
        tb=api('GET','/api/state',None,TOK['Bravo'])['round'];ok(tb['sets']['locked'] and tb['sets']['source']=='default' and tb['content']['id']=='R3-01','API: team that never chose gets the default set at preparation start')
        ok(t.evaluate('document.documentElement.scrollWidth<=window.innerWidth+1'),'UI: no horizontal scroll on 390px mobile (final round)')
        br.close()
    real=[e for e in errs if 'favicon' not in e and '409' not in e and '403' not in e];ok(not real,'UI: no unexpected console/page errors '+str(real[:3]))
finally:
    sv.kill()
print('\nRESULT:',('ALL PASSED' if not fails else str(fails)+' FAILED'));sys.exit(1 if fails else 0)
