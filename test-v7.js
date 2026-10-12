// Run: node test-v7.js — checks the four v7 changes over real HTTP against temporary server copies:
//  1 Round 1 self-paced timing, 2 Round 2/3 score visibility, 3 three Final Round problem sets, 4 organizer assignment + priority rules.
const {spawn,execSync}=require('child_process'),fs=require('fs'),os=require('os'),path=require('path');
let pass=0,fail=0;const ok=(c,m)=>{if(c){pass++;console.log('PASS',m)}else{fail++;console.log('FAIL',m)}};
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function boot(dir){return new Promise(res=>{const P=3800+(Math.random()*90|0),sv=spawn('node',['server.js'],{cwd:dir,env:{...process.env,PORT:P}});let out='';sv.stdout.on('data',x=>out+=x);sv.stderr.on('data',x=>out+=x);setTimeout(()=>res({P,sv,out:()=>out}),900)})}
const mk=()=>{const d=fs.mkdtempSync(path.join(os.tmpdir(),'biz7-'));execSync(`cp -r ${__dirname}/server.js ${__dirname}/lib ${__dirname}/content ${d}/`);return d};
const call=P=>async(m,u,b,t)=>{const r=await fetch(`http://localhost:${P}${u}`,{method:m,headers:{'Content-Type':'application/json',...(t?{Authorization:'Bearer '+t}:{})},body:b?JSON.stringify(b):undefined});const ct=r.headers.get('content-type')||'';return{s:r.status,j:ct.includes('json')?await r.json().catch(()=>({})):{},t:ct.includes('json')?'':await r.text()}};
(async()=>{let S;try{
 const d=mk();S=await boot(d);let api=call(S.P);const pw=S.out().match(/password "(\w+)"/)[1];
 const O0=(await api('POST','/api/login',{role:'organizer',username:'organizer',password:pw})).j.token;let O=O0;
 const names=['Alpha','Bravo','Charlie','=Delta'],codes={},ids={};
 for(let i=0;i<4;i++){const r=await api('POST','/api/signup',{name:names[i],inst:'ABC',members:['a','b'],declare:true});codes[names[i]]=r.j.code;ids[names[i]]=r.j.teamId;await api('POST','/api/teams/'+r.j.teamId+'/status',{status:'active'},O)}
 const tl=async n=>(await api('POST','/api/login',{role:'team',name:n,code:codes[n]})).j.token;
 let TA=await tl('Alpha'),TB=await tl('Bravo'),TC=await tl('Charlie'),TD=await tl('=Delta');
 const org=async()=>(await api('GET','/api/state',null,O)).j, me=async t=>(await api('GET','/api/state',null,t)).j;
 const QS=(await org()).questions,key=id=>QS.find(q=>q.id===id);
 // ================= 1. ROUND 1 SELF-PACED =================
 let st=await org();ok(st.settings.r1Mode==='self','Round 1 defaults to self-paced mode');
 ok((await api('POST','/api/settings',{r1Mode:'bogus'},O)).s===400,'invalid pacing mode rejected');
 ok((await api('POST','/api/settings',{r1Mode:'self'},TA)).s===403,'team cannot change pacing mode');
 await api('PUT','/api/questions/IS-01',{time:2},O);
 await api('POST','/api/event/start',{from:'not_started'},O);
 ok((await api('POST','/api/r1/start',{},O)).s===200,'organizer starts self-paced Round 1');
 ok((await api('POST','/api/settings',{r1Mode:'organizer'},O)).s===409,'pacing mode locked once Round 1 started');
 let a=await me(TA);ok(a.r1.mode==='self'&&a.r1.self.phase==='ready'&&a.r1.current===null&&!/"q":/.test(JSON.stringify(a.r1)),'before Begin the team sees no question text');
 ok((await api('POST','/api/submit',{qid:'IS-01',choice:0},TA)).s===409,'cannot answer before Begin');
 ok((await api('POST','/api/r1/advance',{qid:'IS-01'},TA)).s===409,'cannot advance before Begin');
 ok((await api('POST','/api/r1/begin',{},O)).s===403,'organizer token cannot use the team Begin endpoint');
 const b1=await api('POST','/api/r1/begin',{startedAt:1,durationMs:5},TA);ok(b1.s===200&&b1.j.started===true,'team begins Round 1');
 const sA1=(await org()).teams.find(t=>t.id===ids.Alpha).r1t;ok(sA1&&sA1.startedAt>1e12&&sA1.durationMs===null,'start time recorded by the server; client-supplied times ignored');
 await sleep(30);const b2=await api('POST','/api/r1/begin',{},TA);ok(b2.j.duplicate===true&&(await org()).teams.find(t=>t.id===ids.Alpha).r1t.startedAt===sA1.startedAt,'double Begin does not reset the start time');
 a=await me(TA);ok(a.r1.current.id==='IS-01'&&a.r1.idx===0&&a.r1.remainingMs>0,'team A sees the first question with a timer');
 let expected=0;{const k=key('IS-01'),ch=k.a;const s1=await api('POST','/api/submit',{qid:'IS-01',choice:ch},TA);ok(s1.j.accepted===true,'answer accepted');expected+=k.points;
  const s2=await api('POST','/api/submit',{qid:'IS-01',choice:(ch+1)%4},TA);ok(s2.j.duplicate===true&&(await me(TA)).r1.myScore===k.points,'duplicate submission not double counted (self-paced)');
  ok((await api('POST','/api/r1/advance',{qid:'IS-02'},TA)).j.duplicate===true&&(await me(TA)).r1.idx===0,'advance with a stale question id changes nothing')}
 ok((await api('POST','/api/r1/next',{},O)).s===409&&(await api('POST','/api/r1/reveal',{},O)).s===409,'organizer Next/Reveal not applicable in self-paced mode');
 // team B starts independently and lets IS-01 expire
 await api('POST','/api/r1/begin',{},TB);let bb=await me(TB);ok(bb.r1.current.id==='IS-01'&&(await me(TA)).r1.current.id==='IS-01','each team has its own position');
 ok((await api('POST','/api/r1/advance',{qid:'IS-01'},TB)).s===409,'cannot move on without answering or skipping while time remains');
 await sleep(2300);ok((await api('POST','/api/submit',{qid:'IS-01',choice:key('IS-01').a},TB)).s===409,'late answer rejected by the server clock');
 bb=await me(TB);ok(bb.r1.self.timedOut===true&&bb.r1.remainingMs===0,'expired question is flagged');
 ok((await api('POST','/api/r1/advance',{qid:'IS-01'},TB)).s===200&&(await me(TB)).r1.idx===1,'after the time limit the team can move on without skipping');
 // team A full run: answer correct on even idx, wrong on odd, move on itself
 let fin;for(let i=0;i<30;i++){const cur=(await me(TA)).r1.current;if(!cur)break;const k=key(cur.id),right=i%2===0,ch=right?k.a:(k.a+1)%4;
  if(i>0){await api('POST','/api/submit',{qid:cur.id,choice:ch},TA);if(right)expected+=k.points}
  if(i===1){const wrongQ=QS.find(q=>q.id!==cur.id);ok((await api('POST','/api/submit',{qid:wrongQ.id,choice:0},TA)).s===409,'cannot answer a question that is not your current one')}
  fin=await api('POST','/api/r1/advance',{qid:cur.id},TA);if(fin.j.finished)break}
 ok(fin.j.finished===true,'team finishes after the last question by clicking Next/Finish');
 a=await me(TA);const x=(await org()).teams.find(t=>t.id===ids.Alpha).r1t;
 ok(a.r1.self.phase==='finished'&&a.r1.self.durationMs===x.durationMs&&x.finishedAt>=x.startedAt&&x.durationMs===x.finishedAt-x.startedAt-x.pausedMs&&x.status==='completed','completion time and total duration saved and shown');
 ok(a.r1.myScore===expected&&(await org()).teams.find(t=>t.id===ids.Alpha).r1===expected,'Round 1 score correct for self-paced answers ('+expected+')');
 ok((await api('POST','/api/r1/advance',{qid:'IS-30'},TA)).j.duplicate===true&&(await api('POST','/api/submit',{qid:'IS-30',choice:0},TA)).s===409,'no changes or answers after finishing');
 // pause / resume on team B
 const rem1=(await me(TB)).r1.remainingMs;await api('POST','/api/r1/pause',{},O);await sleep(1300);const bp=await me(TB);
 ok(bp.r1.status==='paused'&&Math.abs(bp.r1.remainingMs-rem1)<400,'pause freezes team timers');
 ok((await api('POST','/api/submit',{qid:'IS-02',choice:0},TB)).s===409&&(await api('POST','/api/r1/advance',{qid:'IS-02',skip:true},TB)).s===409,'no answers or moving on while paused');
 await api('POST','/api/r1/resume',{},O);const xb=(await org()).teams.find(t=>t.id===ids.Bravo).r1t;ok(xb.pausedMs>=1200,'pause time recorded and excluded from duration');
 ok((await api('POST','/api/r1/advance',{qid:'IS-02',skip:true},TB)).s===200,'team can skip a question explicitly');
 // organizer review + CSV
 st=await org();const tm=st.r1timing;const ta=tm.find(r=>r.id===ids.Alpha),tb=tm.find(r=>r.id===ids.Bravo),tc=tm.find(r=>r.id===ids.Charlie);
 ok(ta.state==='completed'&&ta.durationMs===x.durationMs&&tb.state==='in_progress'&&tb.elapsedMs>0&&tc.state==='not_started','organizer sees completed / in-progress / not-started teams with timing');
 ok((await api('GET','/api/r1/timing.csv',null,TA)).s===403,'timing export is organizer-only');
 const csv=await api('GET','/api/r1/timing.csv',null,O);ok(csv.s===200&&/Duration \(seconds\)/.test(csv.t)&&csv.t.includes('Alpha,ABC,completed')&&csv.t.includes("'=Delta"),'timing CSV exports rows and neutralises spreadsheet formulas');
 // persistence across refresh / logout / restart
 await api('POST','/api/logout',{},TA);TA=await tl('Alpha');ok((await me(TA)).r1.self.durationMs===x.durationMs,'timing survives logout and login');
 S.sv.kill();await sleep(400);S=await boot(d);api=call(S.P);O=(await api('POST','/api/login',{role:'organizer',username:'organizer',password:pw})).j.token;TA=await tl('Alpha');TB=await tl('Bravo');TC=await tl('Charlie');TD=await tl('=Delta');
 const x2=(await org()).teams.find(t=>t.id===ids.Alpha).r1t;ok(x2.startedAt===x.startedAt&&x2.finishedAt===x.finishedAt&&x2.durationMs===x.durationMs&&(await org()).teams.find(t=>t.id===ids.Alpha).r1===expected,'timing and score survive a server restart');
 ok((await me(TB)).r1.current.id==='IS-03','in-progress team resumes at the same question after restart');
 // round ends -> unfinished teams are closed with a duration; not-started team stays not started
 ok((await api('POST','/api/event/complete-r1',{from:'r1_active',confirm:true},O)).s===200,'organizer completes Round 1');
 const xb2=(await org()).teams.find(t=>t.id===ids.Bravo).r1t;ok(xb2.status==='round_ended'&&xb2.durationMs>0&&xb2.finishedAt>0,'team still in progress is closed automatically with its duration');
 ok((await api('POST','/api/r1/begin',{},TC)).s===409,'a team that never started cannot begin after the round closed');
 ok((await org()).r1timing.find(r=>r.id===ids.Charlie).state==='not_started','team that never started has no timing');
 ok((await api('POST','/api/r1/advance',{qid:'IS-03'},TB)).j.duplicate===true,'closed team cannot move on');
 // ================= 2. ROUND 2 & 3 SCORE VISIBILITY =================
 ok((await api('POST','/api/event/qualify',{round:'r2',teamIds:[ids.Alpha,ids.Bravo,ids.Charlie]},O)).s===200,'Round 2 qualifiers confirmed');
 await api('POST','/api/stage/r2/config',{contentId:'DD-01',prepMin:12},O);
 ok((await api('POST','/api/event/start-r2',{from:'r1_completed'},O)).s===200,'Round 2 started');
 const js=(r,team,judge,scores,cross)=>api('POST','/api/judge',{round:r,teamId:ids[team],judge,scores,cross},O);
 ok((await js('r2','Alpha','J1',{analytical:30,clarity:20,relevance:''})).s===400&&(await js('r2','Alpha','J1',{analytical:30,clarity:20})).s===400,'judge sheet with a blank or missing criterion is rejected (no silent zero)');
 ok((await org()).teams.find(t=>t.id===ids.Alpha).r2===0,'rejected sheet saved nothing');
 ok((await js('r2','Alpha','J1',{analytical:30,clarity:20,relevance:20})).j.mean===70,'judge 1 sheet saved');
 ok((await js('r2','Alpha','J2',{analytical:40,clarity:30,relevance:30})).j.mean===85,'Round 2 score is the mean of judge totals (85)');
 ok((await js('r2','Alpha','J1',{analytical:30,clarity:20,relevance:20})).j.mean===85,'re-saving a judge sheet replaces it (no double count)');
 ok((await js('r2','Bravo','J1',{analytical:24,clarity:18,relevance:18})).j.mean===60,'second team scored');
 ok((await js('r2','Alpha','J1',{analytical:41,clarity:0,relevance:0})).s===400,'score above the criterion maximum rejected');
 ok((await js('r2','Charlie','J1',{analytical:1,clarity:1,relevance:1})).s===200,'third qualified team scored');
 let sa=await me(TA);ok(sa.me.scores.r2===null&&sa.me.scores.r3===null,'Round 2 score is not shown while the round is still active');
 ok((await api('POST','/api/judge',{round:'r2',teamId:ids.Alpha,judge:'X',scores:{analytical:40,clarity:30,relevance:30}},TA)).s===403&&(await api('POST','/api/scores',{teamId:ids.Alpha,round:'r2',score:100,reason:'x'},TA)).s===403,'teams cannot write judge sheets or change scores');
 ok((await api('POST','/api/event/complete-r2',{from:'r2_active',confirm:true},O)).s===200,'Round 2 completed');
 sa=await me(TA);let sb=await me(TB);ok(sa.me.scores.r2===85&&sa.me.scoreInfo.r2===2&&sb.me.scores.r2===60&&sb.me.scoreInfo.r2===1,'after completion each team sees its own Round 2 score and judge count');
 ok((await me(TD)).me.stage.r2==='eliminated'&&(await me(TD)).me.scores.r2===0,'team that did not qualify is told it did not take part');
 ok((await js('r2','Alpha','J3',{analytical:1,clarity:1,relevance:1})).s===409&&(await api('POST','/api/scores',{teamId:ids.Alpha,round:'r2',score:1,reason:'x'},O)).s===409,'completed round: scores locked even for the organizer');
 await api('POST','/api/settings',{showOwnScore:false},O);ok((await me(TA)).me.scores.r2===null,'organizer "teams see own score" switch is respected');await api('POST','/api/settings',{showOwnScore:true},O);
 // ================= 3 & 4. FINAL ROUND PROBLEM SETS =================
 ok((await api('POST','/api/event/qualify',{round:'r3',teamIds:[ids.Alpha,ids.Bravo]},O)).s===200,'finalists confirmed');
 st=await org();ok(st.r3Sets.options.length===3&&st.r3Sets.options.map(o=>o.id).join()==='R3-01,R3-02,R3-03'&&Object.keys(st.r3Sets.guides).length===3,'three problem sets available; organizer guides for all three');
 ok((await api('POST','/api/stage/r3/assign',{teamId:ids.Alpha,setId:'R3-03'},TA)).s===403,'team cannot assign sets');
 ok((await api('POST','/api/stage/r3/assign',{teamId:ids.Alpha,setId:'R3-03'},O)).s===200,'organizer can assign before the final round starts');
 ok((await api('POST','/api/stage/r3/assign',{teamId:ids.Charlie,setId:'R3-01'},O)).s===400,'cannot assign a team that is not a finalist');
 ok((await api('POST','/api/stage/r3/assign',{teamId:ids.Bravo,setId:'R3-99'},O)).s===400,'unknown set rejected');
 ok((await api('POST','/api/stage/r3/assign',{teamId:ids.Alpha,setId:null},O)).s===200,'assignment can be cleared');
 await api('POST','/api/stage/r3/config',{contentId:'R3-01',prepMin:7},O);
 ok((await api('POST','/api/event/start-r3',{from:'r2_completed'},O)).s===200,'final round started');
 let ra=(await me(TA)).round;const rj=JSON.stringify(ra);
 ok(ra.content===null&&ra.sets.options.length===3&&ra.sets.canChoose===true&&ra.sets.mine===null,'finalist sees the three sets and must choose (no content yet)');
 ok(!/Meals prepared|marketplace where|CampusCart is a student/.test(rj)&&!/facts|deliverables/.test(rj),'unchosen problem sets are not revealed in full');
 ok(!/cross_questions|reasoning_examples|response_indicators/.test(JSON.stringify(await me(TA))),'participants never receive judging guides');
 ok((await api('POST','/api/round/choose',{setId:'R3-02'},TC)).s===409,'a non-finalist cannot choose');
 ok((await api('POST','/api/round/choose',{setId:'R3-77'},TA)).s===400,'unknown set rejected for teams');
 ok((await api('POST','/api/round/choose',{setId:'R3-02'},TA)).s===200,'team A chooses set 2');
 ok((await api('POST','/api/round/choose',{setId:'R3-02'},TA)).j.duplicate===true,'repeating the same choice is harmless');
 ra=(await me(TA)).round;ok(ra.content.id==='R3-02'&&/ThriftLoop/.test(ra.content.title)&&ra.content.facts.length===15&&ra.sets.source==='team'&&!/Meals prepared per day/.test(JSON.stringify(ra)),'chosen set shown in full; other sets stay hidden');
 ok((await api('POST','/api/round/choose',{setId:'R3-03'},TA)).s===200&&(await me(TA)).round.content.id==='R3-03','team can switch before preparation starts');
 // organizer assignment overrides the team choice
 ok((await api('POST','/api/stage/r3/assign',{teamId:ids.Alpha,setId:'R3-01'},O)).s===200,'organizer assigns set 1 to team A');
 ra=(await me(TA)).round;ok(ra.content.id==='R3-01'&&ra.sets.source==='organizer'&&ra.sets.assigned===true&&ra.sets.canChoose===false,'assignment overrides the team choice');
 ok((await api('POST','/api/round/choose',{setId:'R3-02'},TA)).s===409,'team cannot override an organizer assignment');
 st=await org();ok(st.r3Sets.teams[ids.Alpha].choice==='R3-03'&&st.r3Sets.teams[ids.Alpha].assigned==='R3-01'&&st.r3Sets.teams[ids.Alpha].eff.source==='organizer','organizer sees the team choice and the assignment separately');
 await api('POST','/api/stage/r3/assign',{teamId:ids.Alpha,setId:null},O);ok((await me(TA)).round.content.id==='R3-03','clearing the assignment falls back to the team choice');
 await api('POST','/api/stage/r3/assign',{teamId:ids.Alpha,setId:'R3-01'},O);
 // prep start locks everything; team B never chose -> default
 ok((await api('POST','/api/stage/r3/prep-start',{},O)).s===200,'preparation timer started');
 ok((await api('POST','/api/stage/r3/assign',{teamId:ids.Alpha,setId:'R3-02'},O)).s===409&&(await api('POST','/api/round/choose',{setId:'R3-02'},TB)).s===409,'sets are locked once preparation starts (organizer and teams)');
 const rb=(await me(TB)).round;ra=(await me(TA)).round;ok(rb.content.id==='R3-01'&&rb.sets.source==='default'&&rb.sets.locked===true&&ra.content.id==='R3-01'&&ra.sets.source==='organizer','team without a choice gets the default; assigned team keeps its set');
 const jr=(team,jn,sc)=>api('POST','/api/judge',{round:'r3',teamId:ids[team],judge:jn,scores:sc,cross:'q'},O);
 ok((await jr('Alpha','J1',{creativity:20,practicality:20,data:20,communication:10,cross:8})).j.mean===78,'final round scored for team A');
 ok((await jr('Bravo','J1',{creativity:10,practicality:10,data:10,communication:5,cross:5})).j.mean===40,'final round scored for team B');
 sa=await me(TA);ok(sa.me.scores.r3===null,'Round 3 score hidden while the final round is active');
 ok((await api('POST','/api/event/finish',{from:'r3_active',confirm:true},O)).s===200,'event finished');
 sa=await me(TA);sb=await me(TB);ok(sa.me.scores.r3===78&&sa.me.scoreInfo.r3===1&&sb.me.scores.r3===40&&sa.me.scores.r2===85,'teams see their Round 2 and Round 3 scores after completion');
 const au=(await org()).audit;ok(au.some(e=>e.act==='r3_assign')&&au.some(e=>e.act==='r3_choose'),'choices and assignments are audit-logged');
 // persistence
 S.sv.kill();await sleep(400);S=await boot(d);api=call(S.P);O=(await api('POST','/api/login',{role:'organizer',username:'organizer',password:pw})).j.token;TA=await tl('Alpha');TB=await tl('Bravo');
 sa=await me(TA);sb=await me(TB);ok(sa.me.scores.r2===85&&sa.me.scores.r3===78&&sb.me.scores.r3===40&&sa.r1.self.durationMs===x.durationMs,'scores and timing persist after restart and re-login');
 const st2=await org();ok(st2.stage.r3.sets[ids.Alpha].final==='R3-01'&&st2.stage.r3.sets[ids.Alpha].finalSource==='organizer'&&st2.stage.r3.sets[ids.Bravo].finalSource==='default','locked set records persist');
 // resets keep working
 const rs=await api('POST','/api/reset/event',{requestId:'req-v7-reset-1',scope:'workflow',confirmText:'RESET EVENT'},O);ok(rs.s===200,'event workflow reset still works');
 const st3=await org();ok(Object.keys(st3.stage.r3.sets).length===0&&st3.teams.find(t=>t.id===ids.Alpha).r1===expected&&!!st3.teams.find(t=>t.id===ids.Alpha).r1t,'event reset clears Final Round picks but keeps scores and Round 1 timing');
 const rc=await api('POST','/api/reset/event',{requestId:'req-v7-reset-2',scope:'competition',confirmText:'RESET EVENT'},O);const st4=await org();ok(rc.s===200&&!st4.teams.some(t=>t.r1t)&&st4.teams.every(t=>t.r1===0&&t.r2===0&&t.r3===0),'competition reset clears timing and scores');
 // legacy organizer-paced mode still works on a fresh round
 ok((await api('POST','/api/settings',{r1Mode:'organizer'},O)).s===200,'organizer-paced mode can be selected again');
 await api('POST','/api/event/start',{from:'not_started'},O);const lr=await api('POST','/api/r1/start',{},O);ok(lr.s===200&&lr.j.mode==='organizer'&&lr.j.idx===0,'organizer-paced Round 1 still works');
 ok((await api('POST','/api/r1/begin',{},TA)).s===409&&(await api('POST','/api/r1/next',{},O)).s===200,'self-paced endpoints are refused in organizer-paced mode; Next works');
}catch(e){console.log('ERROR',e);fail++}finally{try{S&&S.sv.kill()}catch(_){}}
console.log('\nRESULT: '+pass+' passed, '+fail+' failed');process.exit(fail?1:0)})();
