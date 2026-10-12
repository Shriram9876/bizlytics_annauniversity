// Run: node test-reset.js — content-pack loading, round-wise resets, event reset, content security.
// Starts temporary servers on COPIES of the project (never touches ./storage).
const {spawn,execSync}=require('child_process'),fs=require('fs'),os=require('os'),path=require('path'),vm=require('vm'),crypto=require('crypto');
let pass=0,fail=0;const ok=(c,m)=>{if(c){pass++;console.log('PASS',m)}else{fail++;console.log('FAIL',m)}};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let port=4100+(Math.random()*400|0);
function boot(dir,env){return new Promise(res=>{const P=port++,sv=spawn('node',['server.js'],{cwd:dir,env:{...process.env,PORT:P,...env}});let out='';sv.stdout.on('data',x=>out+=x);sv.stderr.on('data',x=>out+=x);sv.on('exit',c=>{out+='[exit '+c+']'});setTimeout(()=>res({P,sv,out:()=>out}),900)})}
const mk=()=>{const d=fs.mkdtempSync(path.join(os.tmpdir(),'bzr-'));execSync(`cp -r ${__dirname}/server.js ${__dirname}/lib ${__dirname}/content ${d}/`);return d};
const call=P=>async(m,u,b,t)=>{const r=await fetch(`http://localhost:${P}${u}`,{method:m,headers:{'Content-Type':'application/json',...(t?{Authorization:'Bearer '+t}:{})},body:b?JSON.stringify(b):undefined});const txt=await r.text();let j={};try{j=JSON.parse(txt)}catch(e){}return{s:r.status,j,txt,h:r.headers}};
let rq=0;const RID=()=>'req-'+Date.now()+'-'+(rq++)+'-'+crypto.randomBytes(3).toString('hex');
const LOADER=require('./lib/content');

(async()=>{try{
 // ===== A. LOADER: real pack validates; tampered packs are rejected (fail closed) =====
 const P0=LOADER.load();
 ok(P0.r1.length===30&&new Set(P0.r1.map(q=>q.id)).size===30&&P0.r1.every(q=>q.round===1&&q.o.length===4&&q.a>=0&&q.a<4),'loader: exactly 30 unique Round 1 questions, 4 options each, valid answer index');
 ok(P0.r2.map(c=>c.id).join()==='DD-01,DD-02,DD-03,DD-04,DD-05,DD-06'&&P0.r3.length===3&&P0.r3.map(x=>x.id).join()==='R3-01,R3-02,R3-03','loader: six Round 2 cases DD-01..DD-06 and three Round 3 problem sets');
 const col=(id,k)=>P0.r2.find(c=>c.id===id).dataset.rows.map(r=>r[k]);
 const ch=(id,i)=>P0.r2.find(c=>c.id===id).charts[i];
 ok(JSON.stringify(ch('DD-02',0).series[0].values)==='[240,300,75]'&&JSON.stringify(ch('DD-02',0).labels)==='["Campus creators","Search ads","Social display"]','charts: DD-02 registrations chart uses DD-02 data and labels');
 ok(JSON.stringify(ch('DD-02',1).series[0].values)==='[50,50,106.67]'&&ch('DD-02',1).derived===true,'charts: DD-02 cost-per-registration resolved via explicit alias to the derived array');
 ok(P0.r2.every(c=>c.charts.every(h=>h.series.every(s=>s.values.length===c.dataset.rows.length&&h.labels.length===s.values.length))),'charts: every series length matches its own case dataset');
 ok(JSON.stringify(ch('DD-03',0).labels[0])==='"Breakfast – Sandwich"'&&ch('DD-04',0).type==='line'&&ch('DD-04',0).series.length===5,'charts: DD-03 composite labels, DD-04 five-series line chart');
 ok(JSON.stringify(ch('DD-01',1).series.map(s=>s.name))==='["current_stock_units","average_weekly_sales"]'&&JSON.stringify(ch('DD-01',1).series[1].values)==='[30,50,8,6,40]','charts: DD-01 stock vs weekly sales with correct derived values');
 ok(P0.r1.every(q=>!/Synopsys|Ansys|JioHotstar/.test(q.q+q.o.join())),'no legacy quiz questions in the active bank');
 const tamper=(name,fn)=>{const d=mk();fn(d);let r='';try{execSync(`node -e "require('./lib/content').load()"`,{cwd:d,stdio:'pipe'});r='LOADED'}catch(e){r=String(e.stderr)}return{name,rejected:r!=='LOADED',msg:r}};
 const J=(d,f,fnj)=>{const p=path.join(d,'content',f),o=JSON.parse(fs.readFileSync(p,'utf8').replace(/^\uFEFF/,''));fnj(o);fs.writeFileSync(p,JSON.stringify(o))};
 const T=[
  tamper('answer key points to a missing option',d=>J(d,'organizer/answer_key_and_guides.json',o=>{o.round1AnswerKey['IS-05'].correctOption='Z'})),
  tamper('only 29 Round 1 questions',d=>J(d,'participant/question_bank.json',o=>{o.rounds[0].questions.pop()})),
  tamper('duplicate question id',d=>J(d,'participant/question_bank.json',o=>{o.rounds[0].questions[1].id='IS-01'})),
  tamper('derived value contradicts source data',d=>J(d,'charts/chart_manifest.json',o=>{o.cases[1].derivedData.cost_per_registration_inr[0]=99;})),
  tamper('another case dataset attached (CSV swap)',d=>fs.copyFileSync(d+'/content/datasets/dd-02_dataset.csv',d+'/content/datasets/dd-03_dataset.csv')),
  tamper('chart references an unknown series',d=>J(d,'participant/question_bank.json',o=>{o.rounds[1].cases[0].chartSpecifications[0].series='nope'}))];
 T.forEach(t=>ok(t.rejected,'loader rejects: '+t.name));

 // ===== B. SERVER: fresh install =====
 const d=mk();let S=await boot(d,{});let api=call(S.P);
 const pw=(S.out().match(/password "(\w+)"/)||[])[1];ok(!!pw,'server starts with validated content');
 const O=(await api('POST','/api/login',{role:'organizer',username:'organizer',password:pw})).j.token;
 const org=async()=>(await api('GET','/api/state',null,O)).j;
 let st=await org();
 ok(st.questions.length===30&&st.questions.every(q=>q.round===1)&&st.content.r1===30&&st.content.r2===6&&st.content.r3===3,'organizer state: 30 Round 1 questions, 6 cases, 3 problem sets');
 ok(JSON.stringify(st.contentOpts.r2.map(x=>x.id))==='["DD-01","DD-02","DD-03","DD-04","DD-05","DD-06"]'&&st.contentOpts.r3.map(x=>x.id).join()==='R3-01,R3-02,R3-03'&&st.stage.r3.contentId==='R3-01','round routing: R2 options are only the six cases; R3 options are only the three problem sets (R3-01 is the default)');
 ok(st.questions[0].a===1&&st.questions[0].id==='IS-01'&&st.questions[0].e.length>10,'organizer sees answer key mapped to option index (IS-01 -> B)');
 // teams
 const addT=async(n)=>{const r=await api('POST','/api/teams',{name:n,inst:'Inst',members:['a','b']},O);return r.j};
 const tA=await addT('Alpha'),tB=await addT('Beta'),tC=await addT('Gamma');
 const tl=async t=>(await api('POST','/api/login',{role:'team',name:t.name,code:t.code})).j.token;
 const TA=await tl(tA),TB=await tl(tB),TC=await tl(tC);
 // static / API leakage
 for(const u of['/content/organizer/answer_key_and_guides.json','/content/participant/question_bank.json','/content/datasets/dd-01_chart_ready.csv','/lib/content.js','/legacy_backup/questions.js','/storage/db.json','/server.js','/content/charts/chart_manifest.json'])
  ok((await fetch(`http://localhost:${S.P}${u}`)).status===404,'not publicly served: '+u);

 // ===== C. Round 1 live, answers, cross-round data =====
 await api('POST','/api/event/start',{from:'not_started'},O);
 await api('POST','/api/settings',{r1Mode:'organizer'},O); // legacy organizer-paced mode (self-paced mode is covered by test-v7.js)
 ok((await api('POST','/api/r1/start',{},O)).s===200,'Round 1 starts with the 30-question pack');
 let ps=(await api('GET','/api/state',null,TA)).j;
 ok(ps.r1.total===30&&ps.r1.current.id==='IS-01'&&ps.r1.current.o.length===4,'participant sees IS-01 with four options');
 const expl=st.questions.map(q=>q.e).filter(e=>e.length>25),pj=JSON.stringify(ps);
 ok(!expl.some(e=>pj.includes(e))&&!/"a":|answerKey|correctOption/.test(pj),'participant payload contains no answer key or explanation (before reveal)');
 ok((await api('POST','/api/submit',{qid:'IS-01',choice:1},TA)).j.accepted===true,'correct answer accepted and scored');
 await api('POST','/api/submit',{qid:'IS-01',choice:0},TB);
 // manual scores in other rounds + R2/R3 stage config to prove isolation
 await api('POST','/api/scores',{teamId:tA.id,round:'r2',score:55,reason:'seed'},O);await api('POST','/api/scores',{teamId:tA.id,round:'r3',score:44,reason:'seed'},O);
 await api('POST','/api/stage/r2/config',{contentId:'DD-02',prepMin:12,presMin:3},O);
 const snap=async()=>{const s=await org();return JSON.stringify({teams:s.teams.map(t=>({id:t.id,n:t.name,c:t.code,st:t.status,r1:t.r1,r2:t.r2,r3:t.r3,a:t.answers})),stage:s.stage,judge:s.judge,ev:s.event.state})};
 const part=(s,keys)=>{const o=JSON.parse(s);return JSON.stringify({teams:o.teams.map(t=>Object.fromEntries(keys.map(k=>[k,t[k]]))),stage:o.stage,judge:o.judge})};
 const RR=(r,b)=>api('POST','/api/reset/round/'+r,{requestId:RID(),...b},O),RE=b=>api('POST','/api/reset/event',{requestId:RID(),...b},O);

 // ---- validation / authorization of the reset API
 ok((await api('POST','/api/reset/round/r1',{requestId:RID(),scope:'workflow',confirm:true},TA)).s===403,'team cannot call reset endpoints');
 ok((await api('POST','/api/reset/round/r1',{requestId:RID(),scope:'workflow',confirm:true})).s===401,'unauthenticated reset rejected');
 ok((await api('POST','/api/reset/round/r1',{scope:'workflow',confirm:true},O)).s===400,'reset without requestId rejected');
 ok((await RR('r1',{scope:'workflow'})).s===400&&(await RR('r1',{scope:'bogus',confirm:true})).s===400&&(await RR('r9',{scope:'workflow',confirm:true})).s===404,'reset needs confirm + valid scope + valid round');
 ok((await RR('r1',{scope:'competition',confirmText:'yes'})).s===400,'competition reset needs the typed phrase');

 // ---- Reset Round 1 (workflow): restores initial state, keeps saved answers/scores, other rounds untouched
 let before=await snap();
 const w1=await RR('r1',{scope:'workflow',confirm:true});
 st=await org();
 ok(w1.s===200&&w1.j.ok&&st.r1.status==='idle'&&st.r1.idx===-1&&st.r1.total===0&&st.event.state==='r1_active','R1 workflow reset: timer/index/status restored to initial, event stays in Round 1');
 ok(part(await snap(),['id','r2','r3','st','c'])===part(before,['id','r2','r3','st','c'])&&st.teams.find(t=>t.id===tA.id).r1===1&&Object.keys(st.teams.find(t=>t.id===tA.id).answers).length===1,'R1 workflow reset: saved scores/answers kept; Round 2/3 scores, stage and judge data untouched; teams intact');
 ok((await api('POST','/api/r1/start',{},O)).s===409,'R1 cannot restart over saved answers (explicit error, no silent duplicates)');
 // ---- Reset Round 1 (competition)
 const c1=await RR('r1',{scope:'competition',confirmText:'RESET ROUND 1'});st=await org();
 ok(c1.s===200&&st.teams.every(t=>t.r1===0&&Object.keys(t.answers).length===0)&&st.teams.find(t=>t.id===tA.id).r2===55&&st.teams.find(t=>t.id===tA.id).r3===44&&st.stage.r2.contentId==='DD-02'&&st.teams.length===3,'R1 competition reset: answers+scores cleared; R2/R3 scores and case assignment untouched; teams kept');
 ok(fs.readdirSync(path.join(d,'storage/backups')).some(f=>f.includes('pre-reset-r1-competition')),'safety backup written before reset');
 const rs=await api('POST','/api/r1/start',{},O);ok(rs.s===200&&rs.j.status==='running'&&rs.j.idx===0,'Round 1 can be re-run from question 1 after reset');
 // idempotency
 const rid=RID(),i1=await api('POST','/api/reset/round/r1',{requestId:rid,scope:'competition',confirmText:'RESET ROUND 1'},O);
 await api('POST','/api/scores',{teamId:tB.id,round:'r1',score:7,reason:'after reset'},O);
 const i2=await api('POST','/api/reset/round/r1',{requestId:rid,scope:'competition',confirmText:'RESET ROUND 1'},O);st=await org();
 ok(i1.s===200&&i2.s===200&&i2.j.duplicate===true&&st.teams.find(t=>t.id===tB.id).r1===7,'duplicate request (same requestId) is ignored, not re-executed');
 // legacy endpoint still works through the same guarded implementation
 ok((await api('POST','/api/r1/reset',{},O)).s===409&&(await api('POST','/api/r1/reset',{confirm:true},O)).s===200,'legacy /api/r1/reset still requires confirmation and works');
 await api('POST','/api/scores',{teamId:tA.id,round:'r1',score:2,reason:'seed r1'},O);await api('POST','/api/scores',{teamId:tB.id,round:'r1',score:1,reason:'seed r1'},O);

 // ===== D. advance to Round 2 =====
 await api('POST','/api/r1/start',{},O);
 ok((await api('POST','/api/event/complete-r1',{from:'r1_active',confirm:true},O)).s===200,'Round 1 completed');
 ok((await RR('r1',{scope:'workflow',confirm:true})).s===409,'completed round cannot be reset (scores are locked) - explicit message');
 await api('POST','/api/event/qualify',{round:'r2',teamIds:[tA.id,tB.id]},O);
 ok((await api('POST','/api/event/start-r2',{from:'r1_completed'},O)).s===200,'Round 2 starts');
 let pa=(await api('GET','/api/state',null,TA)).j;
 const r2c=pa.round&&pa.round.content,r2j=JSON.stringify(pa);
 ok(r2c&&r2c.id==='DD-02'&&r2c.dataset.rows.length===3&&r2c.charts.length===2&&r2c.tasks.length>0&&r2c.brief.constraints.length>0,'qualified team sees DD-02 brief, tasks, constraints, dataset and two charts');
 ok(!/expectedFindings|commonErrors|suggestedKPIs|proposedScoringRubric|alternativeApproaches|"derived"/.test(r2j)&&!r2j.includes('revenue_inr'),'participant payload has no organizer guide and no chart-ready derived columns');
 ok(r2c.charts[0].series[0].values.join()==='240,300,75'&&r2c.charts[1].series[0].values.join()==='50,50,106.67','participant charts carry only DD-02 data');
 const ds=await call(S.P)('GET','/api/round/dataset',null,TA);
 ok(ds.s===200&&ds.h.get('content-type').includes('text/csv')&&ds.txt.split('\n')[0].replace(/^\uFEFF/,'').trim()==='campaign,spend_inr,impressions,clicks,registrations'&&!ds.txt.includes('cost_per_registration'),'dataset download returns the source CSV for the assigned case only (no derived columns)');
 ok((await api('GET','/api/round/dataset',null,TC)).s===403&&(await api('GET','/api/round/dataset',null,O)).s===403,'dataset download refused for non-qualifiers and organizers-as-team');
 await api('POST','/api/settings',{r2DerivedCharts:false},O);pa=(await api('GET','/api/state',null,TA)).j;
 ok(pa.round.content.charts.length===1&&pa.round.content.charts[0].series[0].name==='registrations','organizer toggle hides charts that display calculated values');
 await api('POST','/api/settings',{r2DerivedCharts:true},O);
 const og=(await org()).assigned.r2;ok(og.id==='DD-02'&&og.guide&&og.guide.expectedFindings,'organizer sees the DD-02 solution guide');
 // stage activity
 await api('POST','/api/stage/r2/prep-start',{},O);await api('POST','/api/stage/r2/present',{teamId:tA.id},O);await api('POST','/api/stage/r2/present-end',{},O);
 await api('POST','/api/judge',{round:'r2',teamId:tA.id,judge:'J1',scores:{analytical:30,clarity:20,relevance:20}},O);
 await api('POST','/api/judge',{round:'r2',teamId:tB.id,judge:'J1',scores:{analytical:10,clarity:10,relevance:10}},O);
 await api('POST','/api/scores',{teamId:tA.id,round:'r3',score:44,reason:'seed r3'},O);
 st=await org();ok(st.stage.r2.prepEndsAt>0&&st.stage.r2.done.length===1&&st.teams.find(t=>t.id===tA.id).r2===70,'Round 2 has timers, a completed presentation and judge scores before reset');
 before=await snap();
 // ---- Reset Round 2 (workflow, assignment preserved)
 const w2=await RR('r2',{scope:'workflow',confirm:true});st=await org();
 ok(w2.s===200&&st.stage.r2.prepEndsAt===0&&st.stage.r2.present===null&&st.stage.r2.done.length===0&&st.stage.r2.contentId==='DD-02'&&st.stage.r2.prepMin===12&&st.event.state==='r2_active','R2 workflow reset: timers/presentation/done-list cleared; case assignment and timing config preserved');
 ok(st.teams.find(t=>t.id===tA.id).r2===70&&Object.keys(st.judge.r2).length===2&&JSON.parse(before).teams.every((t,i)=>t.r1===st.teams[i].r1&&t.r3===st.teams[i].r3&&JSON.stringify(t.a)===JSON.stringify(st.teams[i].answers))&&st.event.qualified.r2.length===2,'R2 workflow reset: judge scores kept; Round 1 and Round 3 data and qualifiers untouched');
 pa=(await api('GET','/api/state',null,TA)).j;ok(pa.round.content.id==='DD-02'&&pa.round.prepStarted===false&&pa.round.presenting===null&&pa.round.presented===false,'participant screen reflects the reset immediately (case kept, prep not started)');
 ok((await api('POST','/api/stage/r2/prep-start',{},O)).s===200,'prep timer can be started again after reset');
 // ---- Reset Round 2 (competition + reassign)
 const c2=await RR('r2',{scope:'competition',confirmText:'RESET ROUND 2',reassign:true});st=await org();
 ok(c2.s===200&&st.stage.r2.contentId===null&&Object.keys(st.judge.r2).length===0&&st.teams.every(t=>t.r2===0)&&st.teams.find(t=>t.id===tA.id).r1===2&&st.teams.find(t=>t.id===tA.id).r3===44&&st.teams.length===3,'R2 competition reset (+reassign): R2 scores/judge sheets/case cleared; R1 and R3 scores untouched; teams kept');
 await api('POST','/api/stage/r2/config',{contentId:'DD-04'},O);
 await api('POST','/api/judge',{round:'r2',teamId:tA.id,judge:'J1',scores:{analytical:30,clarity:20,relevance:20}},O);
 ok((await api('POST','/api/event/complete-r2',{from:'r2_active',confirm:true},O)).s===200&&(await RR('r2',{scope:'workflow',confirm:true})).s===409,'completed Round 2 cannot be reset');
 // ===== E. Round 3 =====
 await api('POST','/api/event/qualify',{round:'r3',teamIds:[tA.id]},O);
 ok((await api('POST','/api/event/start-r3',{from:'r2_completed'},O)).s===200,'Round 3 starts with the auto-assigned scenario');
 ok((await api('POST','/api/round/choose',{setId:'R3-01'},TA)).s===200,'finalist chooses a problem set');
 pa=(await api('GET','/api/state',null,TA)).j;const r3c=pa.round.content,r3j=JSON.stringify(pa);
 ok(r3c.id==='R3-01'&&r3c.facts.length===9&&r3c.constraints.length===4&&r3c.deliverables.length===7&&/CampusCart/.test(r3c.background)&&!/cross_questions|possible_solutions|response_indicators|reasoning_examples|proposedScoring/.test(r3j),'finalist sees the full scenario (facts, constraints, 7 deliverables); no judging material');
 ok((await api('GET','/api/round/dataset',null,TA)).s===403,'no dataset download in Round 3');
 ok((await org()).assigned.r3.guide.cross_questions.length===5,'organizer sees the Round 3 judging guide');
 await api('POST','/api/stage/r3/prep-start',{},O);await api('POST','/api/stage/r3/present',{teamId:tA.id},O);
 await api('POST','/api/judge',{round:'r3',teamId:tA.id,judge:'J1',scores:{creativity:20,practicality:20,data:20,communication:10,cross:8},cross:'q'},O);
 before=await snap();
 const w3=await RR('r3',{scope:'workflow',confirm:true});st=await org();
 ok(w3.s===200&&st.stage.r3.prepEndsAt===0&&st.stage.r3.present===null&&st.stage.r3.done.length===0&&st.stage.r3.contentId==='R3-01'&&st.event.state==='r3_active','R3 workflow reset: timers/pitch cleared, official scenario reloaded');
 {const B=JSON.parse(before),N=JSON.parse(await snap()),pick=o=>JSON.stringify({t:o.teams.map(t=>[t.id,t.r1,t.r2,t.st,t.c,t.a]),s2:o.stage.r2,j2:o.judge.r2});ok(pick(B)===pick(N)&&st.teams.find(t=>t.id===tA.id).r3===78&&Object.keys(st.judge.r3).length===1,'R3 workflow reset: R3 judge scores kept; Round 1 and Round 2 scores, stage and judge data untouched')}
 const c3=await RR('r3',{scope:'competition',confirmText:'RESET ROUND 3'});st=await org();
 ok(c3.s===200&&st.teams.every(t=>t.r3===0)&&Object.keys(st.judge.r3).length===0&&st.teams.find(t=>t.id===tA.id).r2===70&&st.teams.find(t=>t.id===tA.id).r1===2,'R3 competition reset: only Round 3 scores/judge sheets cleared');
 await api('POST','/api/judge',{round:'r3',teamId:tA.id,judge:'J1',scores:{creativity:20,practicality:20,data:20,communication:10,cross:8}},O);

 // ===== F. Event reset =====
 await api('POST','/api/scores',{teamId:tC.id,round:'r3',score:5,reason:'x'},O);
 ok((await RE({scope:'workflow'})).s===400&&(await RE({scope:'workflow',confirmText:'reset event'})).s===400&&(await RE({scope:'both',confirmText:'RESET EVENT'})).s===400,'event reset needs the exact phrase RESET EVENT and an explicit scope');
 ok((await api('POST','/api/reset/event',{requestId:RID(),scope:'workflow',confirmText:'RESET EVENT'},TA)).s===403,'team cannot reset the event');
 const prevT=st.teams.map(t=>({id:t.id,c:t.code,s:t.status,n:t.name})),nQ=st.questions.length;
 const e1=await RE({scope:'workflow',confirmText:'RESET EVENT'});st=await org();
 ok(e1.s===200&&st.event.state==='not_started'&&st.event.qualified.r2===null&&st.event.qualified.r3===null&&st.r1.status==='idle'&&st.stage.r2.prepEndsAt===0&&st.stage.r3.done.length===0&&!st.settings.open.r1&&!st.settings.final.r1&&!st.settings.final.r3&&st.settings.published===false,'event workflow reset: all rounds, timers, qualifiers, open/final flags restored to initial');
 ok(st.teams.find(t=>t.id===tA.id).r1===2&&st.teams.find(t=>t.id===tA.id).r2===70&&st.teams.find(t=>t.id===tA.id).r3===78&&Object.keys(st.judge.r3).length===1,'event workflow reset: scores, answers and judge sheets preserved');
 ok(JSON.stringify(st.teams.map(t=>({id:t.id,c:t.code,s:t.status,n:t.name})))===JSON.stringify(prevT)&&st.questions.length===nQ&&st.contentOpts.r2.length===6,'event workflow reset: teams, codes, question bank and content intact');
 ok((await api('GET','/api/state',null,TA)).s===200&&(await api('GET','/api/state',null,TC)).j.round===null,'event reset: team sessions survive; participants see no stale round');
 const e2=await RE({scope:'competition',confirmText:'RESET EVENT'});st=await org();
 ok(e2.s===200&&st.teams.every(t=>t.r1===0&&t.r2===0&&t.r3===0&&Object.keys(t.answers).length===0)&&Object.keys(st.judge.r2).length+Object.keys(st.judge.r3).length===0,'event competition reset: all scores, answers and judge sheets cleared');
 ok(st.teams.length===3&&JSON.stringify(st.teams.map(t=>({id:t.id,c:t.code,s:t.status,n:t.name})))===JSON.stringify(prevT)&&(await tl(tA))&&st.questions.length===30&&st.org===undefined,'event competition reset: teams, registrations and content preserved; team codes still valid');
 ok(st.audit.some(a=>a.act==='reset_event'&&a.scope==='workflow'&&a.by==='organizer'&&a.event==='r3_active'&&a.at&&a.backup)&&st.audit.some(a=>a.act==='reset_event'&&a.scope==='competition'&&a.event==='not_started')&&st.audit.some(a=>a.act==='reset_round'&&a.round==='r2'&&a.scope==='workflow'),'reset actions are audit-logged (who, scope, round, prior event state, time, backup)');
 ok(fs.readdirSync(path.join(d,'storage/backups')).some(f=>f.includes('pre-reset-event-competition')),'event reset writes a safety backup first');
 // full flow works again after reset
 ok((await api('POST','/api/event/start',{from:'not_started'},O)).s===200&&(await api('POST','/api/r1/start',{},O)).j.idx===0,'Round 1 -> start works again after an event reset');
 // restart persistence
 S.sv.kill();await sleep(300);S=await boot(d,{});api=call(S.P);
 const O2=(await api('POST','/api/login',{role:'organizer',username:'organizer',password:pw})).j.token;const s2=(await api('GET','/api/state',null,O2)).j;
 ok(s2.event.state==='r1_active'&&s2.questions.length===30&&s2.teams.length===3,'after restart the authoritative state is unchanged');
 S.sv.kill();

 // ===== G. Migration of an EXISTING database: old quiz data present -> swap deferred, then applied after explicit reset =====
 const d2=mk();let M=await boot(d2,{});const mpw=M.out().match(/password "(\w+)"/)[1];M.sv.kill();await sleep(300);
 const dbp=d2+'/storage/db.json',db=JSON.parse(fs.readFileSync(dbp,'utf8'));const w={};vm.runInNewContext(fs.readFileSync(__dirname+'/legacy_backup/questions.js','utf8'),{window:w});
 db.schema=3;db.questions=w.QUESTIONS.map((q,i)=>({id:'q'+(i+1),round:1,points:10,time:30,...q}));
 db.teams.push({id:'T001',name:'Old',inst:'X',members:['a','b'],code:'ABCD2345',status:'active',created:'2026-01-01T00:00:00Z',r1:10,r2:0,r3:0,answers:{q1:{choice:0,correct:true,delta:10,at:'x'}},lastLogin:null});db.nextTeam=2;
 db.r1={status:'ended',order:['q1'],idx:0,qStart:0,dur:30,remain:0,revealed:[],seed:1};db.stage.r3.contentId='p1';db.stage.r2.contentId='c1';delete db.settings.contentSwapPending;
 fs.writeFileSync(dbp,JSON.stringify(db));
 M=await boot(d2,{});const ma=call(M.P),MO=(await ma('POST','/api/login',{role:'organizer',username:'organizer',password:mpw})).j.token;let ms=(await ma('GET','/api/state',null,MO)).j;
 ok(ms.questions.length===5&&ms.settings.contentSwapPending===true&&ms.teams[0].r1===10&&Object.keys(ms.teams[0].answers).length===1,'existing DB with Round 1 data: legacy bank NOT silently replaced (scores/answers kept), swap flagged pending');
 ok(fs.readdirSync(d2+'/storage/backups').some(f=>f.includes('pre-migration-v3')),'pre-migration backup created');
 ok((await ma('POST','/api/content/reload',{confirm:true},MO)).s===409,'content reload refused while Round 1 data exists');
 const rr=await ma('POST','/api/reset/round/r1',{requestId:RID(),scope:'competition',confirmText:'RESET ROUND 1'},MO);
 ok(rr.s===200,'organizer clears Round 1 explicitly');
 const rl=await ma('POST','/api/content/reload',{confirm:true},MO);ms=(await ma('GET','/api/state',null,MO)).j;
 ok(rl.s===200&&ms.questions.length===30&&ms.settings.contentSwapPending===false&&ms.stage.r3.contentId==='R3-01'&&ms.stage.r2.contentId===null,'after explicit reset the reload installs the 30-question pack and remaps stale legacy case/scenario ids');
 M.sv.kill();

 // ===== H. Corrupt content: server refuses to start =====
 const d3=mk();J(d3,'participant/question_bank.json',o=>{o.rounds[0].questions.pop()});const B=await boot(d3,{});
 ok(/FATAL/.test(B.out())&&/exit/.test(B.out()),'server refuses to start on invalid content (fail closed)');B.sv.kill();
 console.log(`\nRESULT: ${pass} passed, ${fail} failed`);process.exit(fail?1:0)}catch(e){console.log('ERROR',e);process.exit(1)}})();
