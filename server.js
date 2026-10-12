// Bizilytics local server: node server.js  (no dependencies). Shared state, server-side roles, SSE live updates.
const http=require('http'),fs=require('fs'),path=require('path'),cr=require('crypto'),CT=require('./lib/content');
let PACK;try{PACK=CT.load()}catch(e){console.error('\nFATAL: replacement content failed validation; refusing to start.\n'+e.message+'\n');process.exit(1)}
const PORT=process.env.PORT||3000,DB=path.join(__dirname,'storage','db.json');
fs.mkdirSync(path.dirname(DB),{recursive:true});
const hash=(p,s)=>cr.scryptSync(p,s,32).toString('hex'),CH='ABCDEFGHJKMNPQRSTUVWXYZ23456789',rnd=n=>Array.from({length:n},()=>CH[cr.randomInt(CH.length)]).join('');
let db;
if(fs.existsSync(DB))db=JSON.parse(fs.readFileSync(DB,'utf8'));else{
 const pw=rnd(10),salt=rnd(8);db={org:{user:'organizer',salt,hash:hash(pw,salt)},teams:[],audit:[],nextTeam:1,
  settings:{published:false,tiebreak:'r3',open:{r1:false,r2:false,r3:false},final:{r1:false,r2:false,r3:false}},
  questions:PACK.r1.map(x=>({...x}))};
 console.log('\n=== FIRST RUN: organizer username "organizer", password "'+pw+'" (shown once) ===\n');save()}
const BK=path.join(path.dirname(DB),'backups');
function backup(tag){try{fs.mkdirSync(BK,{recursive:true});const f=path.join(BK,'db-'+new Date().toISOString().replace(/[:.]/g,'-')+'-'+tag+'.json');fs.copyFileSync(DB,f);JSON.parse(fs.readFileSync(f,'utf8'));const all=fs.readdirSync(BK).sort();while(all.length>30)fs.unlinkSync(path.join(BK,all.shift()));return path.basename(f)}catch(e){console.error('Backup failed:',e.message);return null}}
if((db.schema||1)<2){if(fs.existsSync(DB))backup('pre-migration-v1');db.teams.forEach(t=>{t.status=['pending','active','suspended','disqualified'].includes(t.status)?t.status:'active';t.lastLogin=t.lastLogin||null});db.settings=Object.assign({registration:true,teamLogin:true,negative:0,randomize:false,showOwnScore:true},db.settings);db.r1={status:'idle',order:[],idx:-1,qStart:0,dur:0,remain:0,revealed:[],seed:0};db.schema=2;fs.writeFileSync(DB+'.tmp',JSON.stringify(db));fs.renameSync(DB+'.tmp',DB)}
if((db.schema||1)<3){if(fs.existsSync(DB))backup('pre-migration-v2');const r=db.r1||{},f=db.settings.final||{};
 db.event={state:(r.status==='running'||r.status==='paused')?'r1_active':(r.status==='ended'||f.r1)?'r1_completed':'not_started',history:[],qualified:{r2:null,r3:null}};
 db.stage={r2:{contentId:null,prepMin:12,presMin:3,prepEndsAt:0,present:null,done:[]},r3:{contentId:null,prepMin:7,presMin:3,prepEndsAt:0,present:null,done:[]}};db.judge={r2:{},r3:{}};
 db.settings.rubric={r2:{analytical:40,clarity:30,relevance:30},r3:{creativity:25,practicality:25,data:25,communication:15,cross:10}};db.schema=3;fs.writeFileSync(DB+'.tmp',JSON.stringify(db));fs.renameSync(DB+'.tmp',DB)}
const ANS=()=>db.teams.some(t=>Object.keys(t.answers||{}).length||t.r1t);
function swapContent(why){ // replace the Round 1 bank with the validated pack. Only when no Round 1 data depends on the old question ids.
 if(db.r1.status!=='idle'||ANS()){db.settings.contentSwapPending=true;db.audit.unshift({at:new Date().toISOString(),by:'system',act:'content_swap_deferred',why,reason:'Round 1 has started or has saved answers'});console.warn('NOTICE: replacement quiz content NOT applied yet (Round 1 has data). Organizer: Controls -> Content.');return false}
 db.questions=PACK.r1.map(x=>({...x}));db.settings.contentSwapPending=false;
 for(const r of['r2','r3']){const st=db.stage[r];if(!PACK[r].some(x=>x.id===st.contentId)&&!st.prepEndsAt)st.contentId=null}
 if(!db.stage.r3.contentId&&!db.stage.r3.prepEndsAt)db.stage.r3.contentId=PACK.r3[0].id;
 db.audit.unshift({at:new Date().toISOString(),by:'system',act:'content_swap',why,counts:PACK.counts});return true}
if((db.schema||1)<4){if(fs.existsSync(DB))backup('pre-migration-v3');swapContent('migration-v4');db.schema=4;fs.writeFileSync(DB+'.tmp',JSON.stringify(db));fs.renameSync(DB+'.tmp',DB)}
if(db.settings.r2DerivedCharts===undefined)db.settings.r2DerivedCharts=true;
if(db.settings.r1Mode===undefined)db.settings.r1Mode='self'; // v7: Round 1 self-paced by default; 'organizer' keeps the original organizer-paced flow
if(!db.stage.r3.sets)db.stage.r3.sets={}; // v7: per-team Final Round problem-set choice / organizer assignment
backup('startup');setInterval(()=>backup('auto'),10*60*1000).unref();
const safeEq=(a,b)=>{a=Buffer.from(String(a));b=Buffer.from(String(b));return a.length===b.length&&cr.timingSafeEqual(a,b)};
function save(){fs.writeFileSync(DB+'.tmp',JSON.stringify(db));fs.renameSync(DB+'.tmp',DB)}
const sess=new Map(),tickets=new Map(),fails=new Map(),clients=new Set();let ver=1;const TTL=+process.env.BZ_TTL_MS||8*3600e3;
const mkSess=o=>{const t=cr.randomBytes(32).toString('hex');sess.set(t,{...o,exp:Date.now()+TTL});return t};
const getU=t=>{const u=sess.get(t);if(u&&u.exp<Date.now()){sess.delete(t);return null}return u};
const revoke=id=>{for(const[k,v]of sess)if(v.team===id)sess.delete(k)};
const lockd=k=>{const f=fails.get(k);return f&&f.n>=5&&f.until>Date.now()};
const bad=k=>{const f=fails.get(k)||{n:0};if(f.until&&f.until<Date.now()){f.n=0;f.until=0}f.n++;if(f.n>=5)f.until=Date.now()+15*60e3;fails.set(k,f)};
const newCode=()=>{let c;do c=rnd(8);while(db.teams.some(t=>t.code===c));return c};
const newTeam=(b,st)=>({id:'T'+String(db.nextTeam++).padStart(3,'0'),name:b.name.trim(),inst:b.inst.trim(),members:b.members.map(x=>String(x).trim()).filter(Boolean),code:newCode(),status:st,lastLogin:null,created:new Date().toISOString(),r1:0,r2:0,r3:0,answers:{}});
const CONTENT={r2:PACK.r2,r3:PACK.r3};
const qstat=(r,id)=>{const q=db.event.qualified[r];return q==null?'pending':q.includes(id)?'qualified':'eliminated'};
// ---------- v7: Final Round problem sets. Priority: organizer assignment > team choice > default set (applied when preparation starts) ----------
const r3rec=id=>((db.stage.r3.sets||{})[id])||{};
function r3Eff(id){const st=db.stage.r3,rec=r3rec(id);if(rec.final)return{id:rec.final,source:rec.finalSource};if(rec.assigned)return{id:rec.assigned,source:'organizer'};if(rec.choice)return{id:rec.choice,source:'team'};if(st.prepEndsAt>0)return{id:st.contentId||CONTENT.r3[0].id,source:'default'};return{id:null,source:null}}
function r3Pick(id,eff){const rec=r3rec(id),locked=db.stage.r3.prepEndsAt>0;return{options:CONTENT.r3.map(x=>({id:x.id,title:x.title,summary:x.summary})),mine:eff.id,source:eff.source,assigned:!!rec.assigned,locked,canChoose:!locked&&!rec.assigned&&db.event.state==='r3_active'}}
function freezeR3(){const st=db.stage.r3,S3=(st.sets=st.sets||{});(db.event.qualified.r3||[]).forEach(id=>{const rec=S3[id]=S3[id]||{},eff=rec.assigned?{id:rec.assigned,source:'organizer'}:rec.choice?{id:rec.choice,source:'team'}:{id:st.contentId||CONTENT.r3[0].id,source:'default'};rec.final=eff.id;rec.finalSource=eff.source;rec.finalAt=new Date().toISOString()})}
function roundView(me){const e=db.event.state,r=e==='r2_active'?'r2':e==='r3_active'?'r3':null;if(!r||!me||qstat(r,me.id)!=='qualified')return null;const st=db.stage[r],eff=r==='r3'?r3Eff(me.id):null,c=CONTENT[r].find(x=>x.id===(r==='r3'?eff.id:st.contentId));if(!c&&r==='r2')return{key:r,content:null};
 const content=!c?null:r==='r2'?{id:c.id,title:c.title,brief:c.brief,tasks:c.tasks,dataset:c.dataset,charts:c.charts.filter(h=>!h.derived||db.settings.r2DerivedCharts!==false).map(({derived,...h})=>h),csv:true}:{id:c.id,title:c.title,background:c.background,problem:c.problem,facts:c.facts,constraints:c.constraints,challenge:c.challenge,deliverables:c.deliverables},pr=st.present;
 return{key:r,content,criteria:Object.keys(db.settings.rubric[r]).filter(k=>k!=='cross'),prepStarted:st.prepEndsAt>0,prepRemainingMs:Math.max(0,st.prepEndsAt-Date.now()),presMin:st.presMin,presenting:pr?{mine:pr.teamId===me.id,team:(db.teams.find(t=>t.id===pr.teamId)||{}).name,remainingMs:Math.max(0,pr.endsAt-Date.now())}:null,presented:st.done.includes(me.id),...(r==='r3'?{sets:r3Pick(me.id,eff)}:{})}}
const R=()=>db.r1,curQ=()=>R().idx>=0?db.questions.find(x=>x.id===R().order[R().idx]):null;
const remMs=()=>{const r=R();return r.status==='running'?Math.max(0,r.qStart+r.dur*1000-Date.now()):r.status==='paused'?r.remain:0};
const teamQ=t=>{const x=t&&t.r1t;return x&&!x.finishedAt?db.questions.find(z=>z.id===R().order[x.idx])||null:null};
const elapsedOf=x=>(R().status==='paused'?(R().pausedAt||Date.now()):Date.now())-x.startedAt-x.pausedMs;
function tFinish(t,why){const x=t.r1t;if(!x||x.finishedAt)return;const now=Date.now(),r=R();if(r.status==='paused')x.pausedMs+=now-(r.pausedAt||now);x.finishedAt=now;x.durationMs=Math.max(0,now-x.startedAt-x.pausedMs);x.status=why}
function endR1(){const r=R();if(!['running','paused'].includes(r.status))return;if(r.mode==='self')db.teams.forEach(t=>tFinish(t,'round_ended'));r.status='ended'}
const r1timing=()=>live().filter(t=>t.status==='active'||t.r1t).map(t=>{const x=t.r1t,a=Object.values(t.answers||{});return{id:t.id,name:t.name,state:!x?'not_started':x.finishedAt?x.status:'in_progress',startedAt:x?x.startedAt:null,finishedAt:x?x.finishedAt:null,durationMs:x&&x.finishedAt?x.durationMs:null,elapsedMs:x&&!x.finishedAt?elapsedOf(x):null,idx:x?x.idx:null,answered:a.length,correct:a.filter(z=>z.correct).length,score:t.r1||0}});
function r1self(me,r){const now=Date.now(),b={mode:'self',status:r.status,idx:-1,total:r.order.length,remainingMs:0,serverNow:now,current:null,myChoice:null,answered:false,reveal:null,myScore:db.settings.showOwnScore&&me?me.r1||0:null,self:null};if(!me)return b;const x=me.r1t;
 if(!x){b.self={phase:r.status==='running'||r.status==='paused'?'ready':'closed'};return b}
 const ans=Object.keys(me.answers||{}).length;if(x.finishedAt){b.self={phase:'finished',reason:x.status,startedAt:x.startedAt,finishedAt:x.finishedAt,durationMs:x.durationMs,answered:ans};return b}
 const q=teamQ(me);if(!q){b.self={phase:'closed'};return b}const a=(me.answers||{})[q.id],ref=r.status==='paused'?(r.pausedAt||now):now,rem=Math.max(0,x.qStart+q.time*1000-ref);
 Object.assign(b,{idx:x.idx,remainingMs:rem,current:{id:q.id,q:q.q,o:q.o,points:q.points},myChoice:a?a.choice:null,answered:!!a});b.self={phase:'question',startedAt:x.startedAt,elapsedMs:ref-x.startedAt-x.pausedMs,isLast:x.idx+1>=r.order.length,timedOut:rem===0&&!a};return b}
function r1view(me){const r=R();if(r.mode==='self')return r1self(me,r);const q=curQ(),lv=q&&(r.status==='running'||r.status==='paused'),rv=q&&r.revealed.includes(q.id),a=me&&q?(me.answers||{})[q.id]:null;
 return{mode:r.mode||(r.status==='idle'?db.settings.r1Mode:'organizer'),status:r.status,idx:r.idx,total:r.order.length,remainingMs:remMs(),serverNow:Date.now(),current:lv||rv?{id:q.id,q:q.q,o:q.o,points:q.points}:null,myChoice:a?a.choice:null,answered:!!a,reveal:rv?{answer:q.a,explanation:q.e}:null,myScore:db.settings.showOwnScore&&me?me.r1||0:null}}
const r1org=()=>({...r1view(null),order:R().order,answerKey:curQ()?{answer:curQ().a,explanation:curQ().e}:null});
// ---------- RESETS (authoritative, server-side) ----------
const ORD=['not_started','r1_active','r1_completed','r2_active','r2_completed','r3_active','completed'],LAST={r1:1,r2:3,r3:5},SCOPES=['workflow','competition'];
const freshR1=()=>({status:'idle',order:[],idx:-1,qStart:0,dur:0,remain:0,revealed:[],seed:0,mode:null,pausedAt:0,startedAt:0});
const countR=r=>db.teams.filter(t=>r==='r1'?Object.keys(t.answers||{}).length||t.r1||t.r1t:t[r]).length+(r==='r1'?0:Object.keys(db.judge[r]||{}).length);
function resetStage(r,reassign){const st=db.stage[r];st.prepEndsAt=0;st.present=null;st.done=[];if(r==='r2'&&reassign)st.contentId=null;if(r==='r3'){st.contentId=CONTENT.r3[0].id;Object.values(st.sets||{}).forEach(x=>{x.final=null;x.finalSource=null;x.finalAt=null})}}
function clearScores(r){if(r==='r1')db.teams.forEach(t=>{t.answers={};t.r1=0;delete t.r1t});else{db.judge[r]={};db.teams.forEach(t=>{t[r]=0})}}
function resetRound(r,scope,o){const E=db.event,n=r[1];
 if(ORD.indexOf(E.state)>LAST[r])return{err:'Round '+n+' is already completed and its scores are locked. Round resets are only available while the round is active or not yet started. Use Reset Entire Event to start over.'};
 const bk=backup('pre-reset-'+r+'-'+scope);if(!bk)return{err:'Safety backup failed; nothing was reset.'};
 const before={records:countR(r)};
 if(r==='r1')db.r1=freshR1();else resetStage(r,!!o.reassign);
 if(scope==='competition')clearScores(r);
 logA('organizer','reset_round',{round:r,scope,reassign:!!o.reassign,event:E.state,backup:bk,requestId:o.requestId||null,recordsBefore:before.records});return{ok:true,backup:bk,round:r,scope,clearedRecords:scope==='competition'?before.records:0}}
function resetEvent(scope,o){const E=db.event,S_=db.settings,from=E.state,bk=backup('pre-reset-event-'+scope);if(!bk)return{err:'Safety backup failed; nothing was reset.'};
 db.r1=freshR1();resetStage('r2',false);resetStage('r3');db.stage.r3.sets={};E.state='not_started';E.qualified={r2:null,r3:null};E.history.push({at:new Date().toISOString(),action:'event-reset-'+scope,from,to:'not_started'});
 S_.open={r1:false,r2:false,r3:false};S_.final={r1:false,r2:false,r3:false};S_.published=false;
 if(scope==='competition'){['r1','r2','r3'].forEach(clearScores)}
 logA('organizer','reset_event',{scope,event:from,backup:bk,requestId:o.requestId||null,teams:db.teams.length});return{ok:true,backup:bk,scope,teamsPreserved:db.teams.length}}
const seenReq=new Map();
function resetApi(res,p,b){const er=(c,m)=>J(res,c,{error:m}),rid=String(b.requestId||'');
 if(rid.length<8||rid.length>80)return er(400,'requestId (8-80 chars) is required so duplicate clicks are ignored.');
 const hit=seenReq.get(rid);if(hit)return J(res,200,{...hit,duplicate:true});
 if(!SCOPES.includes(b.scope))return er(400,'scope must be "workflow" or "competition".');
 const m=p.match(/^\/api\/reset\/round\/(r[123])$/);let out;
 if(m){const r=m[1];if(b.scope==='workflow'?b.confirm!==true:b.confirmText!=='RESET ROUND '+r[1])return er(400,b.scope==='workflow'?'Confirmation required.':'Type RESET ROUND '+r[1]+' to confirm clearing saved scores/submissions.');out=resetRound(r,b.scope,{reassign:b.reassign===true,requestId:rid})}
 else{if(b.confirmText!=='RESET EVENT')return er(400,'Type RESET EVENT to confirm.');out=resetEvent(b.scope,{requestId:rid})}
 if(out.err)return er(409,out.err);
 seenReq.set(rid,out);if(seenReq.size>200)seenReq.delete(seenReq.keys().next().value);push();return J(res,200,out)}
const push=()=>{ver++;save();clients.forEach(c=>c.res.write('data: '+ver+'\n\n'))};
const live=()=>db.teams.filter(t=>!t.archived),T=t=>(t.r1||0)+(t.r2||0)+(t.r3||0);
const pub=(t,all)=>{const f=db.settings.final,v=k=>all||f[k]?t[k]||0:null;return{id:t.id,name:t.name,inst:t.inst,status:all?t.status:undefined,r1:v('r1'),r2:v('r2'),r3:v('r3'),total:['r1','r2','r3'].reduce((s,k)=>s+(v(k)||0),0),provisional:all?!(f.r1&&f.r2&&f.r3):!(f.r1&&f.r2&&f.r3)}};
function board(all){const tb=db.settings.tiebreak,rows=live().filter(t=>all||t.status==='active').map(t=>({...pub(t,all),_t:t[tb]||0}));
 rows.sort((a,b)=>b.total-a.total||(tb==='none'?0:b._t-a._t)||a.name.localeCompare(b.name));
 rows.forEach((r,i)=>{const p=rows[i-1];r.rank=p&&p.total===r.total&&(tb==='none'||p._t===r._t)?p.rank:i+1;r.tied=rows.some((o,j)=>j!==i&&o.total===r.total&&(tb==='none'||o._t===r._t))});rows.forEach(r=>delete r._t);return rows}
const mine=u=>u.role==='team'?db.teams.find(t=>t.id===u.team&&!t.archived&&t.status==='active'):null;
function state(u){const s=db.settings,o={ver,role:u.role,settings:u.role==='organizer'?{...s}:(({rubric,...x})=>x)(s),teamList:live().filter(t=>t.status==='active').map(t=>({id:t.id,name:t.name,inst:t.inst})),board:s.published||u.role==='organizer'?board(u.role==='organizer'):null,published:s.published};
 if(u.role==='organizer'){o.event=db.event;o.stage=db.stage;o.judge=db.judge;o.rubric=db.settings.rubric;o.contentOpts={r2:CONTENT.r2.map(x=>({id:x.id,title:x.title})),r3:CONTENT.r3.map(x=>({id:x.id,title:x.title}))};const asg=r=>{const c=CONTENT[r].find(x=>x.id===db.stage[r].contentId);return c?{id:c.id,title:c.title,guide:PACK.guides[r][c.id]||null}:null};o.assigned={r2:asg('r2'),r3:asg('r3')};o.r3Sets={options:CONTENT.r3.map(x=>({id:x.id,title:x.title,summary:x.summary})),guides:PACK.guides.r3,teams:Object.fromEntries((db.event.qualified.r3||[]).map(id=>[id,{choice:r3rec(id).choice||null,assigned:r3rec(id).assigned||null,eff:r3Eff(id)}]))};o.r1timing=r1timing();o.content=PACK.counts;o.r1=r1org();o.teams=db.teams;o.audit=db.audit;o.questions=db.questions}
 else{const m=mine(u);o.me=m?{id:m.id,name:m.name,inst:m.inst,members:m.members,code:m.code,status:m.status,r1:db.settings.showOwnScore?m.r1:null}:null;o.r1=r1view(m);o.event={state:db.event.state};o.round=roundView(m);if(o.me){o.me.stage={r2:qstat('r2',m.id),r3:qstat('r3',m.id)};o.me.scores={r2:db.settings.final.r2&&db.settings.showOwnScore?m.r2:null,r3:db.settings.final.r3&&db.settings.showOwnScore?m.r3:null};o.me.scoreInfo={r2:Object.keys(db.judge.r2[m.id]||{}).length,r3:Object.keys(db.judge.r3[m.id]||{}).length}}}return o}
const val=b=>{const n=(b.name||'').trim(),i=(b.inst||'').trim(),m=(b.members||[]).map(x=>String(x).trim()).filter(Boolean);
 if(!n||!i)return'Team name and institution are required.';if(n.length>80||i.length>120||m.some(x=>x.length>80))return'Name or institution too long.';if(m.length<2||m.length>3)return'Teams need 2–3 members.';return null};
const dup=(n,id)=>db.teams.some(t=>!t.archived&&t.id!==id&&t.name.toLowerCase()===n.trim().toLowerCase());
const logA=(who,act,d)=>db.audit.unshift({at:new Date().toISOString(),by:who,act,...d});
const J=(res,c,o)=>{res.writeHead(c,{'Content-Type':'application/json'});res.end(JSON.stringify(o))};
const MIME={'.html':'text/html','.js':'text/javascript','.css':'text/css','.csv':'text/csv','.pdf':'application/pdf'};
http.createServer((req,res)=>{const url=new URL(req.url,'http://x');const p=url.pathname;
 if(!p.startsWith('/api/')){let f=p==='/'?'/live.html':p;f=path.normalize(f);
  if(f.includes('..')||/^[\\/](data|storage|content|lib|legacy_backup|backups)([\\/]|$)|server\.js|test\.js|\.md$/.test(f)||!MIME[path.extname(f)]){res.writeHead(404);return res.end('Not found')}
  return fs.readFile(path.join(__dirname,f),(e,d)=>{if(e){res.writeHead(404);return res.end('Not found')}res.writeHead(200,{'Content-Type':MIME[path.extname(f)]});res.end(d)})}
 let body='';req.on('data',c=>{body+=c;if(body.length>1e6)req.destroy()});req.on('end',()=>{try{(()=>{let b={};try{b=body?JSON.parse(body):{}}catch(e){return J(res,400,{error:'Bad JSON'})}
  const tok=(req.headers.authorization||'').replace('Bearer ',''),u=getU(tok);
  if(p==='/api/login'&&req.method==='POST'){const id=String((b.role==='organizer'?b.username:b.name)||'').toLowerCase().slice(0,60),k=req.socket.remoteAddress+'|'+b.role+'|'+id;
   if(lockd(k))return J(res,429,{error:'Too many failed attempts. Try again in 15 minutes.'});
   if(b.role==='organizer'){if(b.username===db.org.user&&safeEq(hash(String(b.password||''),db.org.salt),db.org.hash)){fails.delete(k);logA('organizer','login',{});save();return J(res,200,{token:mkSess({role:'organizer'}),role:'organizer'})}bad(k);return J(res,401,{error:'Wrong username or password.'})}
   const t=live().find(x=>x.name.toLowerCase()===String(b.name||'').trim().toLowerCase());
   if(t&&safeEq(t.code,String(b.code||'').trim().toUpperCase())){fails.delete(k);if(!db.settings.teamLogin)return J(res,403,{error:'Team login is currently disabled by the organizer.'});if(t.status!=='active')return J(res,403,{error:{pending:'Registration is awaiting organizer approval.',suspended:'This team is suspended.',disqualified:'This team has been disqualified.'}[t.status]||'Access not allowed.'});t.lastLogin=new Date().toISOString();save();return J(res,200,{token:mkSess({role:'team',team:t.id}),role:'team'})}
   bad(k);return J(res,401,{error:'Team name or code is incorrect.'})}
  if(p==='/api/signup'&&req.method==='POST'){if(!db.settings.registration)return J(res,403,{error:'Registration is closed.'});const e=val(b)||(dup(b.name,0)?'Team name already taken.':null);if(e)return J(res,400,{error:e});if(b.declare!==true)return J(res,400,{error:'Confirm that all members belong to the same institution.'});
   const t=newTeam(b,'pending');db.teams.push(t);logA('team:'+t.id,'signup',{team:t.id});push();return J(res,200,{pending:true,code:t.code,teamId:t.id})}
  if(p==='/api/events'){const tn=url.searchParams.get('ticket'),tk=tickets.get(tn);tickets.delete(tn);if(!tk||tk.exp<Date.now()||!getU(tk.tok))return J(res,401,{error:'Stream ticket invalid.'});res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-cache',Connection:'keep-alive'});res.write('data: '+ver+'\n\n');const c={res};clients.add(c);res.on('close',()=>clients.delete(c));return}
  if(!u)return J(res,401,{error:'Please log in.'});
  if(p==='/api/logout'){sess.delete(tok);return J(res,200,{ok:true})}
  if(p==='/api/stream-ticket'){const tk=cr.randomBytes(16).toString('hex');tickets.set(tk,{tok,exp:Date.now()+30000});return J(res,200,{ticket:tk})}
  if(p==='/api/state')return J(res,200,state(u));
  if(p==='/api/round/dataset'&&req.method==='GET'){if(u.role!=='team')return J(res,403,{error:'Teams only.'});const t=mine(u),st=db.stage.r2;if(!t||db.event.state!=='r2_active'||qstat('r2',t.id)!=='qualified'||!PACK.csv[st.contentId])return J(res,403,{error:'No dataset is available to your team right now.'});
   res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="'+st.contentId.toLowerCase()+'_dataset.csv"','Cache-Control':'no-store'});return res.end(PACK.csv[st.contentId])}
  if(p==='/api/submit'&&req.method==='POST'){if(u.role!=='team')return J(res,403,{error:'Teams only.'});const t=mine(u);if(!t)return J(res,403,{error:'Team not active.'});const r=R(),self=r.mode==='self',q=self?teamQ(t):curQ(),ch=Number(b.choice);
   if(db.settings.final.r1||!db.settings.open.r1||r.status!=='running'||!q)return J(res,409,{error:'Round 1 is not accepting answers right now.'});
   if(b.qid!==q.id)return J(res,409,{error:'That question is no longer active.'});
   if(Date.now()>(self?t.r1t.qStart:r.qStart)+(self?q.time:r.dur)*1000||(!self&&r.revealed.includes(q.id)))return J(res,409,{error:'Time is up for this question.'});
   if(!Number.isInteger(ch)||ch<0||ch>3)return J(res,400,{error:'Choose one of the options.'});
   t.answers=t.answers||{};if(t.answers[q.id])return J(res,200,{duplicate:true,score:db.settings.showOwnScore?t.r1:null});
   const ok=ch===q.a,delta=ok?q.points:-(+db.settings.negative||0);t.answers[q.id]={choice:ch,correct:ok,delta,at:new Date().toISOString(),...(self?{ms:Date.now()-t.r1t.qStart}:{})};t.r1=(t.r1||0)+delta;push();return J(res,200,{accepted:true,score:db.settings.showOwnScore?t.r1:null})}
  if(p==='/api/r1/begin'&&req.method==='POST'){if(u.role!=='team')return J(res,403,{error:'Teams only.'});const t=mine(u);if(!t)return J(res,403,{error:'Team not active.'});const r=R();
   if(r.mode!=='self')return J(res,409,{error:'Round 1 is not self-paced.'});if(t.r1t)return J(res,200,{duplicate:true});
   if(db.settings.final.r1||!db.settings.open.r1||r.status!=='running')return J(res,409,{error:r.status==='paused'?'Round 1 is paused. Try again when it resumes.':'Round 1 is not open for starting right now.'});
   const now=Date.now();t.r1t={startedAt:now,finishedAt:null,durationMs:null,idx:0,qStart:now,pausedMs:0,status:'in_progress'};logA('team:'+t.id,'r1_begin',{team:t.id});push();return J(res,200,{started:true})}
  if(p==='/api/r1/advance'&&req.method==='POST'){if(u.role!=='team')return J(res,403,{error:'Teams only.'});const t=mine(u);if(!t)return J(res,403,{error:'Team not active.'});const r=R(),x=t.r1t;
   if(r.mode!=='self')return J(res,409,{error:'Round 1 is not self-paced.'});if(!x)return J(res,409,{error:'Begin Round 1 first.'});if(x.finishedAt)return J(res,200,{duplicate:true,finished:true});
   if(db.settings.final.r1||r.status!=='running')return J(res,409,{error:r.status==='paused'?'Round 1 is paused.':'Round 1 is not running.'});
   const q=teamQ(t);if(!q||b.qid!==q.id)return J(res,200,{duplicate:true}); // stale or double click: no change
   const answered=!!(t.answers||{})[q.id],expired=Date.now()>x.qStart+q.time*1000;if(!answered&&!expired&&b.skip!==true)return J(res,409,{error:'Answer the question (or choose Skip) before moving on.'});
   if(x.idx+1>=r.order.length){tFinish(t,'completed');logA('team:'+t.id,'r1_finish',{team:t.id,durationMs:x.durationMs})}else{x.idx++;x.qStart=Date.now()}
   push();return J(res,200,{ok:true,finished:!!x.finishedAt})}
  if(p==='/api/round/choose'&&req.method==='POST'){if(u.role!=='team')return J(res,403,{error:'Teams only.'});const t=mine(u);if(!t)return J(res,403,{error:'Team not active.'});const st=db.stage.r3;
   if(db.event.state!=='r3_active'||qstat('r3',t.id)!=='qualified')return J(res,409,{error:'Problem sets can only be chosen by finalists while the final round is active.'});
   if(st.prepEndsAt>0)return J(res,409,{error:'Preparation has started; problem sets are locked.'});
   if(r3rec(t.id).assigned)return J(res,409,{error:'The organizer has assigned your problem set; it cannot be changed.'});
   if(!CONTENT.r3.some(x=>x.id===b.setId))return J(res,400,{error:'Unknown problem set.'});
   if(r3rec(t.id).choice===b.setId)return J(res,200,{duplicate:true,choice:b.setId});
   const S3=(st.sets=st.sets||{}),rec=S3[t.id]=S3[t.id]||{},prev=rec.choice||null;rec.choice=b.setId;rec.choiceAt=new Date().toISOString();logA('team:'+t.id,'r3_choose',{team:t.id,prev,next:b.setId});push();return J(res,200,{ok:true,choice:b.setId})}
  if(u.role!=='organizer')return J(res,403,{error:'Organizer only.'});
  if(p==='/api/r1/timing.csv'&&req.method==='GET'){const cell=v=>{let s=String(v==null?'':v);if(/^[=+\-@\t\r]/.test(s))s="'"+s;return /[",\n\r]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s},mmss=ms=>ms==null?'':Math.floor(ms/60000)+':'+String(Math.floor(ms/1000)%60).padStart(2,'0');
   const rows=[['Team ID','Team','Institution','Status','Started (UTC)','Finished (UTC)','Duration (mm:ss)','Duration (seconds)','Answered','Correct','Round 1 score']].concat(r1timing().map(x=>{const t=db.teams.find(z=>z.id===x.id);return[x.id,x.name,t.inst,x.state,x.startedAt?new Date(x.startedAt).toISOString():'',x.finishedAt?new Date(x.finishedAt).toISOString():'',mmss(x.durationMs),x.durationMs==null?'':Math.round(x.durationMs/1000),x.answered,x.correct,x.score]}));
   res.writeHead(200,{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="round1_timing.csv"','Cache-Control':'no-store'});return res.end('\ufeff'+rows.map(r=>r.map(cell).join(',')).join('\r\n')+'\r\n')}
  if(req.method==='POST'&&/^\/api\/reset\/(event|round\/r[123])$/.test(p))return resetApi(res,p,b);
  if(p==='/api/content/reload'&&req.method==='POST'){if(b.confirm!==true)return J(res,400,{error:'Confirmation required.'});backup('pre-content-reload');if(!swapContent('organizer'))return J(res,409,{error:'Round 1 has started or has saved answers. Reset Round 1 (competition scope) first.'});logA('organizer','content_reload',{});push();return J(res,200,{ok:true,counts:PACK.counts})}
  const TR={start:['not_started','r1_active','Event already started or finished.'],'complete-r1':['r1_active','r1_completed','Round 1 is not active.'],'start-r2':['r1_completed','r2_active','Round 2 cannot start until Round 1 is completed.'],'complete-r2':['r2_active','r2_completed','Round 2 is not active.'],'start-r3':['r2_completed','r3_active','Round 3 cannot start until Round 2 is completed.'],finish:['r3_active','completed','Round 3 is not active.']};
  const em=p.match(/^\/api\/event\/([\w-]+)$/),E=db.event,sg=r=>db.stage[r],S_=db.settings;
  if(em&&req.method==='POST'&&TR[em[1]]){const a=em[1],[from,to,msg]=TR[a],er=m=>J(res,409,{error:m});
   if(b.from&&b.from!==E.state)return er('The event state has changed (now "'+E.state+'"). Refresh and try again.');
   if(E.state!==from)return er(msg+' Current state: '+E.state+'.');
   if(/^complete|finish/.test(a)&&b.confirm!==true)return er('Confirmation required for this irreversible action.');
   if(a==='start-r2'&&!(E.qualified.r2&&E.qualified.r2.length))return er('Confirm the Round 2 qualifiers first.');
   if(a==='start-r3'&&!(E.qualified.r3&&E.qualified.r3.length))return er('Confirm the Round 3 finalists first.');
   if((a==='start-r2'&&!sg('r2').contentId)||(a==='start-r3'&&!sg('r3').contentId))return er('Assign a case/scenario before starting.');
   if(a==='start')S_.open.r1=true;
   if(a==='complete-r1'){endR1();S_.open.r1=false;S_.final.r1=true}
   if(a==='start-r2')S_.open.r2=true;
   if(a==='complete-r2'){sg('r2').present=null;S_.open.r2=false;S_.final.r2=true}
   if(a==='start-r3')S_.open.r3=true;
   if(a==='finish'){sg('r3').present=null;S_.open.r3=false;S_.final.r3=true;S_.published=true}
   E.state=to;E.history.push({at:new Date().toISOString(),action:a,from,to});logA('organizer','event_'+a,{from,to});push();return J(res,200,{state:E.state})}
  if(p==='/api/event/qualify'&&req.method==='POST'){const r=b.round,need={r2:'r1_completed',r3:'r2_completed'}[r];if(!need)return J(res,400,{error:'round must be r2 or r3.'});if(E.state!==need)return J(res,409,{error:'Qualifiers for '+r.toUpperCase()+' can only be set while the event is "'+need+'" (now "'+E.state+'").'});
   const ids=[...new Set(Array.isArray(b.teamIds)?b.teamIds:[])];if(!ids.length)return J(res,400,{error:'Select at least one team.'});const ok=ids.every(id=>{const t=db.teams.find(x=>x.id===id);return t&&!t.archived&&t.status==='active'&&(r==='r2'||(E.qualified.r2||[]).includes(id))});if(!ok)return J(res,400,{error:'Every selected team must be active'+(r==='r3'?' and a Round 2 qualifier':'')+'.'});
   E.qualified[r]=ids;logA('organizer','qualify_'+r,{teams:ids});push();return J(res,200,{qualified:ids})}
  const gm=p.match(/^\/api\/stage\/(r2|r3)\/(config|prep-start|present|present-end)$/);
  if(gm&&req.method==='POST'){const r=gm[1],st=sg(r),act=gm[2],er=m=>J(res,409,{error:m}),on=E.state===r+'_active';
   if(act==='config'){if(on&&st.prepEndsAt)return er('Preparation already started; settings are locked.');if(b.contentId!==undefined){if(!CONTENT[r].some(x=>x.id===b.contentId))return J(res,400,{error:'Unknown case/scenario.'});st.contentId=b.contentId}
    const lim=r==='r2'?[10,15]:[5,10];if(b.prepMin!==undefined){const v=+b.prepMin;if(!Number.isInteger(v)||v<lim[0]||v>lim[1])return J(res,400,{error:'Preparation time must be '+lim[0]+'–'+lim[1]+' minutes (rulebook).'});st.prepMin=v}
    if(b.presMin!==undefined){const v=+b.presMin,okp=r==='r2'?(v===0||(v>=2&&v<=3)):v===3;if(!okp)return J(res,400,{error:r==='r2'?'Presentation must be 0 (none) or 2–3 minutes.':'Round 3 presentations are 3 minutes.'});st.presMin=v}
    logA('organizer','stage_config_'+r,{contentId:st.contentId,prepMin:st.prepMin,presMin:st.presMin});push();return J(res,200,st)}
   if(!on)return er('Round '+r[1]+' is not active.');
   if(act==='prep-start'){if(st.prepEndsAt)return er('Preparation timer already started.');st.prepEndsAt=Date.now()+st.prepMin*60000;if(r==='r3')freezeR3()}
   else if(act==='present'){if(st.present)return er('Another presentation is in progress.');if(!st.presMin)return er('Presentations are disabled for this round.');const t=db.teams.find(x=>x.id===b.teamId);if(!t||qstat(r,t.id)!=='qualified')return J(res,400,{error:'Team is not a qualifier for this round.'});if(st.done.includes(t.id)&&!b.again)return er('That team has already presented.');st.present={teamId:t.id,endsAt:Date.now()+st.presMin*60000}}
   else{if(!st.present)return er('No presentation in progress.');if(!st.done.includes(st.present.teamId))st.done.push(st.present.teamId);st.present=null}
   logA('organizer','stage_'+act+'_'+r,{team:b.teamId||null});push();return J(res,200,st)}
  if(p==='/api/stage/r3/assign'&&req.method==='POST'){const st=sg('r3'),t=db.teams.find(x=>x.id===b.teamId),er=m=>J(res,409,{error:m});
   if(!['r2_completed','r3_active'].includes(E.state))return er('Problem sets can be assigned after finalists are confirmed and before preparation starts.');
   if(!t||qstat('r3',t.id)!=='qualified')return J(res,400,{error:'Team is not a confirmed finalist.'});
   if(st.prepEndsAt>0)return er('Preparation has started; problem sets are locked.');
   const clr=b.setId===null||b.setId==='';if(!clr&&!CONTENT.r3.some(x=>x.id===b.setId))return J(res,400,{error:'Unknown problem set.'});
   const S3=(st.sets=st.sets||{}),rec=S3[t.id]=S3[t.id]||{},prev=rec.assigned||null;rec.assigned=clr?null:b.setId;rec.assignedAt=clr?null:new Date().toISOString();
   logA('organizer','r3_assign',{team:t.id,prev,next:rec.assigned,teamChoice:rec.choice||null});push();return J(res,200,{team:t.id,assigned:rec.assigned,effective:r3Eff(t.id)})}
  if(p==='/api/judge'&&req.method==='POST'){const r=b.round,t=db.teams.find(x=>x.id===b.teamId),rub=S_.rubric[r],jn=String(b.judge||'').trim();
   if(!rub)return J(res,400,{error:'round must be r2 or r3.'});if(E.state!==r+'_active'||S_.final[r])return J(res,409,{error:'Judge scores can only be recorded while Round '+r[1]+' is active.'});
   if(!t||qstat(r,t.id)!=='qualified')return J(res,400,{error:'Team is not a qualifier for this round.'});if(!jn||jn.length>40)return J(res,400,{error:'Judge name is required (max 40 chars).'});
   const sc={};for(const k of Object.keys(rub)){const raw=b.scores&&b.scores[k],v=Number(raw);if(raw===undefined||raw===null||String(raw).trim()===''||!Number.isFinite(v)||v<0||v>rub[k])return J(res,400,{error:'Score for "'+k+'" must be 0–'+rub[k]+'.'});sc[k]=v}
   const J_=db.judge[r][t.id]=db.judge[r][t.id]||{};J_[jn]={scores:sc,total:Object.values(sc).reduce((x,y)=>x+y,0),cross:String(b.cross||'').slice(0,300),at:new Date().toISOString()};
   const all=Object.values(J_);t[r]=Math.round(all.reduce((x,y)=>x+y.total,0)/all.length*100)/100;logA('organizer','judge_score',{team:t.id,round:r,judge:jn,total:J_[jn].total,mean:t[r]});push();return J(res,200,{mean:t[r],judges:all.length})}
  if(p==='/api/rubric'&&req.method==='POST'){const r=b.round,rub=S_.rubric[r];if(!rub)return J(res,400,{error:'round must be r2 or r3.'});if(Object.keys(db.judge[r]).length)return J(res,409,{error:'Cannot change weights after judge scores exist.'});
   const w={};for(const k of Object.keys(rub)){const v=Number(b.weights&&b.weights[k]);if(!Number.isFinite(v)||v<0||v>100)return J(res,400,{error:'Weight for "'+k+'" must be 0–100.'});w[k]=v}S_.rubric[r]=w;logA('organizer','rubric_'+r,{weights:w});push();return J(res,200,w)}
  const rm=p.match(/^\/api\/r1\/(start|next|pause|resume|end|reveal|reset)$/);
  if(rm&&req.method==='POST'){const a=rm[1],r=R(),er=m=>J(res,409,{error:m});
   if(a==='start'){if(db.event.state!=='r1_active')return er('Start the event first (Event controls).');if(r.status!=='idle')return er('Round 1 already started. Reset to rerun.');if(!db.settings.open.r1||db.settings.final.r1)return er('Open Round 1 (and do not finalize it) first.');if(ANS())return er('Round 1 already has saved answers. Use Reset Round 1 with the "Competition reset" scope to clear them before running it again.');
    const qs=db.questions.filter(x=>x.round===1&&x.enabled!==false).sort((x,y)=>(x.order??1e6)-(y.order??1e6));if(!qs.length)return er('No enabled questions.');
    r.seed=cr.randomInt(1,2**31-1);if(db.settings.randomize){let z=r.seed;const rn=()=>{z=(z*1664525+1013904223)>>>0;return z/2**32};for(let i=qs.length-1;i>0;i--){const j=Math.floor(rn()*(i+1));[qs[i],qs[j]]=[qs[j],qs[i]]}}
    const md=db.settings.r1Mode==='organizer'?'organizer':'self';Object.assign(r,{status:'running',order:qs.map(x=>x.id),idx:md==='self'?-1:0,revealed:[],mode:md,pausedAt:0});if(md==='self'){r.qStart=0;r.dur=0;r.startedAt=Date.now()}else{r.qStart=Date.now();r.dur=curQ().time}}
   else if(a==='next'){if(r.mode==='self')return er('Round 1 is self-paced: teams move to the next question themselves.');if(!['running','paused'].includes(r.status))return er('Round 1 is not running.');if(r.idx+1>=r.order.length)r.status='ended';else{r.idx++;r.status='running';r.qStart=Date.now();r.dur=curQ().time}}
   else if(a==='pause'){if(r.status!=='running')return er('Not running.');r.remain=remMs();r.pausedAt=Date.now();r.status='paused'}
   else if(a==='resume'){if(r.status!=='paused')return er('Not paused.');if(r.mode==='self'){const dl=Date.now()-(r.pausedAt||Date.now());db.teams.forEach(t=>{const x=t.r1t;if(x&&!x.finishedAt){x.qStart+=dl;x.pausedMs+=dl}})}else r.qStart=Date.now()+r.remain-r.dur*1000;r.status='running';r.pausedAt=0}
   else if(a==='end'){if(!['running','paused'].includes(r.status))return er('Not running.');endR1()}
   else if(a==='reveal'){if(r.mode==='self')return er('Answers are not revealed question-by-question in self-paced mode.');const q=curQ();if(!q)return er('No active question.');if(!r.revealed.includes(q.id))r.revealed.push(q.id)}
   else{if(b.confirm!==true)return er('Confirmation required: this clears all Round 1 answers and scores.');const x=resetRound('r1','competition',{});if(x.err)return er(x.err)}
   logA('organizer','r1_'+a,{idx:R().idx});push();return J(res,200,r1org())}
  const sm=p.match(/^\/api\/teams\/([^/]+)\/(status|reset-code|revoke)$/);
  if(sm&&req.method==='POST'){const t=db.teams.find(x=>x.id===sm[1]);if(!t)return J(res,404,{error:'Team not found.'});
   if(sm[2]==='status'){if(!['active','pending','suspended','disqualified'].includes(b.status))return J(res,400,{error:'Bad status.'});if(['suspended','disqualified'].includes(b.status)&&!String(b.reason||'').trim())return J(res,400,{error:'A reason is required.'});if(b.status==='active'&&dup(t.name,t.id))return J(res,409,{error:'Name used by another active team.'});const prev=t.status;t.status=b.status;if(b.status!=='active')revoke(t.id);logA('organizer','team_status',{team:t.id,prev,next:b.status,reason:String(b.reason||'').trim()})}
   else if(sm[2]==='reset-code'){t.code=newCode();revoke(t.id);logA('organizer','code_reset',{team:t.id});push();return J(res,200,{code:t.code})}
   else{revoke(t.id);logA('organizer','sessions_revoked',{team:t.id})}
   push();return J(res,200,{ok:true,status:t.status})}
  if(p==='/api/org/credentials'&&req.method==='POST'){const k='cred|'+req.socket.remoteAddress;if(lockd(k))return J(res,429,{error:'Too many attempts.'});if(!safeEq(hash(String(b.current||''),db.org.salt),db.org.hash)){bad(k);return J(res,401,{error:'Current password is incorrect.'})}
   const nu=String(b.newUser||db.org.user).trim(),np=String(b.newPassword||'');if(nu.length<3||nu.length>40)return J(res,400,{error:'Username must be 3–40 characters.'});if(np&&np.length<10)return J(res,400,{error:'New password must be at least 10 characters.'});
   backup('pre-credential-change');fails.delete(k);db.org.user=nu;if(np){db.org.salt=rnd(12);db.org.hash=hash(np,db.org.salt)}for(const[kk,v]of sess)if(v.role==='organizer'&&kk!==tok)sess.delete(kk);logA('organizer','credentials_changed',{});save();return J(res,200,{ok:true})}
  if(p==='/api/backup'&&req.method==='POST'){const f=backup('manual');return f?J(res,200,{file:f}):J(res,500,{error:'Backup failed; see server log.'})}
  const m=p.match(/^\/api\/(teams|questions)(?:\/([^/]+?))?(\/restore)?$/);
  if(m&&m[1]==='teams'){const id=m[2];
   if(req.method==='POST'&&!id){const e=val(b)||(dup(b.name,0)?'Team name already taken.':null);if(e)return J(res,400,{error:e});const t=newTeam(b,'active');db.teams.push(t);logA('organizer','team_add',{team:t.id});push();return J(res,200,t)}
   const t=db.teams.find(x=>x.id===id);if(!t)return J(res,404,{error:'Team not found.'});
   if(req.method==='PUT'){const e=val(b)||(dup(b.name,id)?'Team name already taken.':null);if(e)return J(res,400,{error:e});Object.assign(t,{name:b.name.trim(),inst:b.inst.trim(),members:b.members.map(x=>String(x).trim()).filter(Boolean)});logA('organizer','team_edit',{team:id});push();return J(res,200,t)}
   if(req.method==='DELETE'){t.archived=true;logA('organizer','team_archive',{team:id});push();return J(res,200,{archived:true})}
   if(req.method==='POST'&&m[3]){if(dup(t.name,id))return J(res,409,{error:'Name now used by another team.'});t.archived=false;logA('organizer','team_restore',{team:id});push();return J(res,200,t)}}
  if(m&&m[1]==='questions'){const id=m[2],chk=q=>!q.q||!Array.isArray(q.o)||q.o.length!==4||q.o.some(x=>!String(x).trim())||!(q.a>=0&&q.a<4)?'Question needs text, four options and a valid answer (0–3).':null;
   if(req.method==='POST'){const e=chk(b);if(e)return J(res,400,{error:e});const q={...b,id:'q'+Date.now(),round:1,points:+b.points||10,time:+b.time||30};db.questions.push(q);logA('organizer','q_add',{q:q.id});push();return J(res,200,q)}
   const i=db.questions.findIndex(x=>x.id===id);if(i<0)return J(res,404,{error:'Not found.'});if(['running','paused'].includes(R().status)&&R().order.includes(id))return J(res,409,{error:'This question is part of the live round and cannot be changed now.'});
   if(req.method==='PUT'){const q={...db.questions[i],...b,id};const e=chk(q);if(e)return J(res,400,{error:e});db.questions[i]=q;logA('organizer','q_edit',{q:id});push();return J(res,200,q)}
   if(req.method==='DELETE'){db.questions.splice(i,1);logA('organizer','q_delete',{q:id});push();return J(res,200,{deleted:true})}}
  if(p==='/api/scores'&&req.method==='POST'){const t=db.teams.find(x=>x.id===b.teamId);const k=b.round;if(!t||!['r1','r2','r3'].includes(k))return J(res,400,{error:'Bad team or round.'});
   if(db.settings.final[k])return J(res,409,{error:'Round is finalized; un-finalize first.'});if(!Number.isFinite(+b.score)||!String(b.reason||'').trim())return J(res,400,{error:'Numeric score and a reason are required.'});
   const prev=t[k]||0;t[k]=+b.score;logA('organizer','score',{team:t.id,round:k,prev,next:t[k],reason:b.reason.trim()});push();return J(res,200,{prev,next:t[k]})}
  if(p==='/api/settings'&&req.method==='POST'){const s=db.settings;if(b.open||b.final)return J(res,409,{error:'Round open/finalized status is controlled only by the Event controls (start / complete round).'});if(typeof b.published==='boolean')s.published=b.published;['registration','teamLogin','randomize','showOwnScore','r2DerivedCharts'].forEach(k=>{if(typeof b[k]==='boolean'){if(k==='randomize'&&R().status!=='idle')return;s[k]=b[k]}});if(b.r1Mode!==undefined){if(!['self','organizer'].includes(b.r1Mode))return J(res,400,{error:'r1Mode must be "self" or "organizer".'});if(R().status!=='idle')return J(res,409,{error:'The Round 1 pacing mode can only be changed before Round 1 starts.'});s.r1Mode=b.r1Mode}if(b.negative!==undefined&&R().status==='idle'&&+b.negative>=0&&+b.negative<=100)s.negative=+b.negative;if(['r1','r2','r3','none'].includes(b.tiebreak))s.tiebreak=b.tiebreak;
   ['open','final'].forEach(g=>b[g]&&Object.keys(b[g]).forEach(k=>{if(k in s[g])s[g][k]=!!b[g][k]}));logA('organizer','settings',{change:b});push();return J(res,200,s)}
  J(res,404,{error:'Unknown endpoint'})})()}catch(e){console.error(e.message);if(!res.headersSent)J(res,500,{error:'Server error.'})}})}).listen(PORT,process.env.HOST||'0.0.0.0',()=>console.log('Bizilytics running: http://localhost:'+PORT+'  (LAN: http://<this-computer-IP>:'+PORT+')'));
