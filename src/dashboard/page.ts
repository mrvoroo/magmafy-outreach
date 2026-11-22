/** The dashboard is ONE self-contained page (no external libraries, no CDN): everything is drawn with safe DOM calls (textContent), RTL Arabic. */
export function loginHtml(withCrm = true, withToken = false): string {
  return `<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Magmafy outreach — دخول</title>
<style>body{font:16px system-ui,sans-serif;background:#0f1115;color:#eee;display:grid;place-items:center;height:100vh;margin:0}.f{background:#181b22;padding:28px;border-radius:12px;width:min(92vw,380px)}input,button{width:100%;padding:12px;margin-top:12px;border-radius:8px;border:1px solid #333;background:#0f1115;color:#eee;font-size:16px;box-sizing:border-box}button{background:#d4a017;color:#111;border:0;font-weight:700;cursor:pointer}#m{color:#e74c3c;min-height:22px;margin-top:10px;font-size:14px}.s{color:#8b93a5;font-size:14px}</style>
<div class="f"><h2>📊 لوحة نظام الـ Outreach</h2>
${withCrm ? `<div id="a"><p class="s">ادخل بنفس إيميل الأدمن بتاع الـ CRM، وهيجيلك كود على الإيميل.</p><input id="e" type="email" placeholder="إيميل الأدمن" autocomplete="email" autofocus><button id="b1">ابعت الكود</button></div>
<div id="c" style="display:none"><p class="s">اكتب الكود اللي وصلك على الإيميل.</p><input id="k" inputmode="numeric" maxlength="6" placeholder="------" autocomplete="one-time-code" style="text-align:center;letter-spacing:8px;font-size:22px"><button id="b2">دخول</button></div><div id="m"></div>` : ''}
${withToken ? `<form method="get" action="/" style="margin-top:18px"><p class="s">دخول طوارئ:</p><input name="t" type="password" placeholder="رمز الطوارئ"><button>دخول</button></form>` : ''}</div>
<script>
const $=s=>document.querySelector(s),m=t=>{$('#m').textContent=t||''};
async function post(u,b){const r=await fetch(u,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||'حصل خطأ');return j}
if($('#b1')){let email='';
$('#b1').onclick=async()=>{m('');email=$('#e').value.trim();if(!email)return;$('#b1').disabled=true;try{await post('/auth/request',{email});$('#a').style.display='none';$('#c').style.display='block';$('#k').focus()}catch(e){m(e.message)}$('#b1').disabled=false};
$('#e').onkeydown=e=>{if(e.key==='Enter')$('#b1').click()};
$('#b2').onclick=async()=>{m('');$('#b2').disabled=true;try{await post('/auth/verify',{email,code:$('#k').value.trim()});location.href='/'}catch(e){m(e.message)}$('#b2').disabled=false};
$('#k').onkeydown=e=>{if(e.key==='Enter')$('#b2').click()}}
</script></html>`;
}

export function dashboardHtml(): string {
  return `<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Magmafy outreach</title>
<style>
:root{--bg:#0f1115;--card:#181b22;--line:#262b36;--ink:#eceff4;--mut:#8b93a5;--gold:#d4a017;--ok:#2ecc71;--bad:#e74c3c;--warn:#f39c12;--blue:#4c9ffe}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Tahoma,sans-serif}
header{position:sticky;top:0;z-index:5;background:#0b0d11;border-bottom:1px solid var(--line);padding:10px 16px;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
h1{font-size:17px;margin:0}.pill{padding:3px 10px;border-radius:99px;font-size:13px;background:var(--line)}.ok{background:#12351f;color:var(--ok)}.bad{background:#3a1616;color:var(--bad)}.warn{background:#3a2a10;color:var(--warn)}
nav{display:flex;gap:4px;overflow:auto;padding:8px 16px;border-bottom:1px solid var(--line);background:#0b0d11}nav button{background:none;border:0;color:var(--mut);padding:8px 14px;border-radius:8px;cursor:pointer;font-size:15px;white-space:nowrap}nav button.on{background:var(--card);color:var(--gold);font-weight:700}
main{padding:16px;max-width:1200px;margin:auto}.grid{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(170px,1fr))}.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px;margin-bottom:12px}
.k{color:var(--mut);font-size:13px}.v{font-size:26px;font-weight:700}.sub{font-size:12px;color:var(--mut)}h2{font-size:16px;margin:0 0 10px}
table{width:100%;border-collapse:collapse}td,th{padding:7px 8px;border-bottom:1px solid var(--line);text-align:start;vertical-align:top;font-size:14px}th{color:var(--mut);font-weight:500}
.bar{height:10px;background:var(--line);border-radius:6px;overflow:hidden;min-width:60px}.bar>i{display:block;height:100%;background:var(--gold)}.bar.g>i{background:var(--ok)}.bar.r>i{background:var(--bad)}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}button.a{background:var(--card);color:var(--ink);border:1px solid var(--line);padding:8px 12px;border-radius:8px;cursor:pointer}button.a:hover{border-color:var(--gold)}button.a.d{border-color:var(--bad);color:var(--bad)}
input,select{background:#0f1115;color:var(--ink);border:1px solid var(--line);border-radius:8px;padding:8px}.msg{max-width:78%;padding:10px 12px;border-radius:12px;margin:6px 0;white-space:pre-wrap;word-break:break-word}.out{background:#1d2a44;margin-inline-start:auto}.in{background:#233323}
.tag{font-size:11px;padding:1px 8px;border-radius:99px;background:var(--line);color:var(--mut);margin-inline-end:4px}.positive{color:var(--ok)}.negative{color:var(--bad)}.neutral{color:var(--warn)}
.ins li{margin:6px 0}small.m{color:var(--mut)}a.l{color:var(--blue);cursor:pointer;text-decoration:underline}.live{display:inline-block;width:9px;height:9px;border-radius:50%;background:var(--ok);margin-inline-end:6px;animation:p 1.4s infinite}@keyframes p{50%{opacity:.3}}
.cols{display:grid;gap:12px;grid-template-columns:repeat(auto-fit,minmax(340px,1fr))}.spark{display:flex;gap:3px;align-items:flex-end;height:90px}.spark div{flex:1;background:var(--gold);min-height:2px;border-radius:3px 3px 0 0;position:relative}.spark div.r{background:var(--blue)}
</style>
<header><h1>📊 Magmafy outreach</h1><span id="live" class="pill"><span class="live"></span>مباشر</span><span id="state" class="pill"></span><span id="mode" class="pill"></span><span id="wa" class="pill"></span><span class="pill" id="clock"></span>
<span style="margin-inline-start:auto;display:flex;gap:8px;align-items:center"><a href="/auth/logout" style="color:#8b93a5;font-size:13px">خروج</a><select id="range"><option value="1">اليوم</option><option value="7">7 أيام</option><option value="30" selected>30 يوم</option><option value="all">كل الفترة</option></select></span></header>
<nav id="tabs"></nav><main id="main">جارِ التحميل…</main>
<script>
const TABS=[['overview','نظرة عامة'],['funnel','التقدم'],['results','النتائج'],['reasons','الأسباب والتحليل'],['quality','جودة الرسائل'],['chats','المحادثات'],['control','التحكم']];
let tab=localStorage.getItem('tab')||'overview',openLead=null,timer=null,chatFilter={q:'',status:''};
const $=s=>document.querySelector(s);
function h(t,a,...c){const e=document.createElement(t);for(const k in(a||{})){if(k==='class')e.className=a[k];else if(k.startsWith('on'))e.addEventListener(k.slice(2),a[k]);else if(a[k]!=null)e.setAttribute(k,a[k])}for(const x of c.flat()){if(x==null||x===false)continue;e.append(x.nodeType?x:document.createTextNode(String(x)))}return e}
const api=async(p,o)=>{const r=await fetch(p,o);if(r.status===401){location.reload();return null}return r.json()};
const range=()=>$('#range').value;const pct=n=>(n==null?'—':n+'%');const fmtT=iso=>iso?new Date(iso).toLocaleTimeString('ar-SA-u-nu-latn',{hour:'2-digit',minute:'2-digit'}):'—';const fmtD=iso=>iso?new Date(iso).toLocaleString('ar-SA-u-nu-latn',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}):'—';
const STATUS_AR={discovered:'مكتشف',enriched:'مُثرى',qualified:'مؤهل',needs_review:'يحتاج مراجعة',too_big:'كبير جدًا',rejected:'مرفوض',message_ready:'رسالة جاهزة',scheduled:'مجدول',sending:'جارِ الإرسال',first_message_sent:'اتبعتله أول رسالة',followup_1_sent:'متابعة 1',followup_2_sent:'متابعة 2',followup_3_sent:'المتابعة الأخيرة',no_reply_closed:'قفل: لا رد',replied:'ردّ',call_booked:'مكالمة محجوزة',later:'لاحقًا',declined:'رفض',has_agency:'عنده شركة',opted_out:'طلب عدم التواصل',wrong_contact:'رقم غلط',parked:'موقوف'};
const KIND_AR={first:'الرسالة الأولى',followup1:'متابعة 1',followup2:'متابعة 2',followup3:'المتابعة الأخيرة',reply:'رد منا',inbound:'رد العميل'};
const bar=(p,c)=>h('div',{class:'bar '+(c||'')},h('i',{style:'width:'+Math.min(100,p||0)+'%'}));
const stat=(k,v,s,cls)=>h('div',{class:'card'},h('div',{class:'k'},k),h('div',{class:'v '+(cls||'')},v),s?h('div',{class:'sub'},s):null);
function table(head,rows){return h('table',{},h('tr',{},head.map(x=>h('th',{},x))),rows.map(r=>h('tr',{},r.map(c=>h('td',{},c)))))}
function rateTable(arr,label){return h('div',{class:'card'},h('h2',{},label),arr.length?table(['','أُرسل','نسبة الرد','إيجابي','رفض'],arr.map(x=>[x.key,x.sent,[pct(x.replyRate),bar(x.replyRate)],h('span',{class:'positive'},pct(x.positiveRate)),h('span',{class:'negative'},pct(x.negativeRate))])):h('small',{class:'m'},'لا بيانات بعد'))}

async function renderOverview(){const [o,s]=await Promise.all([api('/api/overview'),api('/api/series?days=14')]);if(!o)return;const t=o.today,c=t.caps;
 const st=$('#state');st.textContent=o.state.paused?'⏸ متوقف: '+(o.state.reason||''):'▶️ شغّال';st.className='pill '+(o.state.paused?'bad':'ok');$('#mode').textContent='الوضع: '+o.state.mode;$('#wa').textContent='واتساب: '+o.state.wa;$('#wa').className='pill '+(o.state.wa==='open'?'ok':'warn');
 const m=h('div',{},
  o.state.breaker?h('div',{class:'card',style:'border-color:var(--bad)'},h('b',{},'🛑 قاطع الأمان اشتغل: '),o.state.breaker.reason,' — ',o.state.breaker.detail||''):null,
  h('div',{class:'grid'},stat('رسائل جديدة اليوم',t.sentNew+' / '+c.newCap,'متابعات: '+t.sentFollow+' / '+c.followCap),stat('متبقي في خطة اليوم',t.left,'يوم الإحماء رقم '+o.state.warmupDay),stat('ردود تنتظرك',o.replies.pending,'ردود النهارده: '+o.replies.todayIn,o.replies.pending?'warn':''),stat('ليدز جاهزة',o.pool.ready,'= '+o.pool.days+' يوم'+(o.pool.low?' ⚠️ قليل':''),o.pool.low?'warn':''),stat('طابور الـ CRM',o.crm.pending,o.crm.dead?'فشل نهائي: '+o.crm.dead:'سليم',o.crm.dead?'bad':''),stat('مصروف اليوم','$'+(o.spend.google+o.spend.ai).toFixed(2),'Google $'+o.spend.google.toFixed(2)+' · AI $'+o.spend.ai.toFixed(2))),
  h('div',{class:'cols'},h('div',{class:'card'},h('h2',{},'خطة اليوم '+t.planned.length),t.planned.length?table(['الوقت','العميل','النوع','الحالة',''],t.planned.map(i=>[fmtT(i.at),h('a',{class:'l',onclick:()=>{openLead=i.leadId;go('chats')}},i.lead),KIND_AR[i.kind]||i.kind,{planned:'مجدول',sent:'اتبعت ✅',dryrun:'تجريبي',skipped:'اتخطّى',sending:'جارِ…',review:'مراجعة',assisted:'بانتظارك'}[i.state]||i.state,i.state==='planned'?h('button',{class:'a',onclick:()=>act('/api/skip?id='+i.id)},'تخطّي'):''])):h('small',{class:'m'},(t.notes||[]).join(' · ')||'لا إرسال مخطط اليوم')),
   h('div',{class:'card'},h('h2',{},'آخر 14 يوم'),h('div',{class:'spark'},s.map(d=>h('div',{title:d.day+' — أُرسل '+d.sent+' · ردود '+d.replies,style:'height:'+Math.max(2,Math.min(100,(d.sent/Math.max(1,...s.map(x=>x.sent)))*100))+'%'}))),h('div',{class:'sub'},'العمود = رسائل جديدة؛ ردود الأسبوع: '+s.slice(-7).reduce((n,d)=>n+d.replies,0))),
  ),
  h('div',{class:'card'},h('h2',{},'صحة الرقم'),h('div',{class:'row'},h('span',{class:'pill'},'فشل متتالي: '+o.health.failureStreak),h('span',{class:'pill'},'أرقام بدون واتساب متتالية: '+o.health.notOnWaStreak),h('span',{class:'pill'},'انقطاعات آخر ساعة: '+o.health.reconnects1h),h('span',{class:'pill'},'آخر إرسال: '+fmtD(o.lastSentAt)))));
 setMain(m)}

async function renderFunnel(){const f=await api('/api/funnel?days='+range());const mx=Math.max(1,...f.map(x=>x.n));
 setMain(h('div',{},h('div',{class:'card'},h('h2',{},'من اكتشاف الليد لحد المكالمة'),table(['المرحلة','العدد','% من اللي قبلها','% من المُرسَل إليهم',''],f.map(x=>[x.label,h('b',{},x.n),pct(x.pctOfPrev),x.pctOfSent==null?'—':pct(x.pctOfSent),bar(x.n/mx*100)])))))}

async function renderResults(){const r=await api('/api/results?days='+range());const s=await api('/api/series?days=30');
 setMain(h('div',{},h('div',{class:'grid'},stat('رسائل أولى مُرسَلة',r.sent,'متابعات: '+r.followupsSent),stat('نسبة الرد',pct(r.replyRate),r.replied+' ردّوا'),stat('ردود إيجابية',pct(r.positiveRate),r.positive+' ليد','positive'),stat('رفض / سلبي',pct(r.negativeRate),r.negative+' ليد','negative'),stat('طلبوا عدم التواصل',pct(r.optOutRate),r.optOut+' ليد','negative'),stat('تجاهل (خلّصوا التسلسل بدون رد)',pct(r.ignoredRate),r.ignored+' ليد'),stat('لسه في الانتظار',r.waiting,'ماردّوش لسه ولا خلّص التسلسل'),stat('مكالمات محجوزة',r.booked,pct(r.bookedRate)+' من المُرسَل','positive'),stat('متوسط زمن ردّك',r.medianResponseMin==null?'—':r.medianResponseMin+' د','من وصول الرد لحد ردّنا'),stat('فشل / مراجعة إرسال',r.failures,'أرقام بدون واتساب: '+r.notOnWhatsapp,r.failures?'warn':'')),
  h('div',{class:'card'},h('h2',{},'آخر 30 يوم: المُرسَل مقابل الردود'),h('div',{class:'spark'},s.map(d=>h('div',{title:d.day+' أُرسل '+d.sent,style:'height:'+Math.max(2,Math.min(100,(d.sent/Math.max(1,...s.map(x=>x.sent)))*100))+'%'}))),h('div',{class:'spark',style:'margin-top:6px;height:50px'},s.map(d=>h('div',{class:'r',title:d.day+' ردود '+d.replies+' (إيجابي '+d.positive+' · رفض '+d.negative+')',style:'height:'+Math.max(2,Math.min(100,(d.replies/Math.max(1,...s.map(x=>x.replies)))*100))+'%'}))),h('div',{class:'sub'},'الذهبي: رسائل جديدة · الأزرق: ردود'))))}

async function renderReasons(){const r=await api('/api/reasons?days='+range());
 setMain(h('div',{},h('div',{class:'card'},h('h2',{},'قراءة سريعة للأرقام'),h('ul',{class:'ins'},r.insights.map(x=>h('li',{},x)))),
  h('div',{class:'card'},h('h2',{},'أنواع الردود ('+r.total+')'),r.categories.length?table(['النوع','العدد','%','',' أمثلة من كلامهم'],r.categories.map(c=>[h('span',{class:c.tone},c.label),c.n,pct(c.pct),bar(c.pct,c.tone==='positive'?'g':c.tone==='negative'?'r':''),h('small',{class:'m'},c.examples.map(e=>'«'+e.slice(0,70)+'»').join('  '))])):h('small',{class:'m'},'لا ردود بعد')),
  h('div',{class:'cols'},rateTable(r.byVariant,'حسب نسخة الرسالة'),rateTable(r.byCity,'حسب المدينة'),rateTable(r.bySegment,'حسب النشاط'),rateTable(r.byWindow,'حسب وقت الإرسال')),
  h('div',{class:'card'},h('h2',{},'طلبات عدم التواصل: السبب بكلامهم'),r.optOuts.length?table(['العميل','قال','نسخة','مدينة','وقت'],r.optOuts.map(o=>[o.lead,'«'+o.text+'»',o.variant||'—',o.city||'—',fmtD(o.at)])):h('small',{class:'m'},'لا يوجد'))))}

async function renderQuality(){const q=await api('/api/quality?days='+range());
 setMain(h('div',{},q.note?h('div',{class:'card warn'},q.note):null,h('div',{class:'grid'},stat('رسائل مُقيَّمة',q.total),stat('نجاح الفحوصات الآلية',q.avgChecks==null?'—':q.avgChecks+'%'),stat('موافقة المحكّم (AI)',pct(q.judgePassRate)),stat('متوسط عدد الكلمات',q.avgWords==null?'—':q.avgWords,'الحد: أقل من 40')),
  h('div',{class:'cols'},rateTable(q.byVariant,'النسخة'),rateTable(q.byEvidence,'نوع الدليل في الجملة الشخصية'),rateTable(q.byOpening,'الافتتاحية'),rateTable(q.byQuestion,'السؤال الختامي')),
  h('div',{class:'cols'},h('div',{class:'card'},h('h2',{},'جمل جابت ردود إيجابية'),q.bestLines.length?q.bestLines.map(x=>h('p',{},'«'+x.line+'» ',h('small',{class:'m'},x.lead+' · '+(x.variant||'')))):h('small',{class:'m'},'—')),h('div',{class:'card'},h('h2',{},'جمل جابت رفض'),q.worstLines.length?q.worstLines.map(x=>h('p',{},'«'+x.line+'» ',h('small',{class:'m'},x.lead+' · '+(x.variant||'')))):h('small',{class:'m'},'—'))),
  h('div',{class:'card'},h('h2',{},'آخر الرسائل المُرسَلة وتقييم كل واحدة'),table(['العميل','النسخة','الرسالة','فحوصات','محكّم','النتيجة'],q.recent.map(m=>[h('a',{class:'l',onclick:()=>{openLead=m.leadId;go('chats')}},m.lead),m.variant||'—',h('small',{},m.text.slice(0,120)),m.checksPassed+'/'+m.checksTotal,m.judgePass==null?'—':m.judgePass?'✅':'❌',{no_reply:'بدون رد',positive:'إيجابي ✅',negative:'سلبي ❌',neutral:'رد محايد'}[m.outcome]])))))}

async function renderChats(){if(openLead)return renderLead(openLead);const qs=new URLSearchParams({q:chatFilter.q,status:chatFilter.status});const d=await api('/api/leads?'+qs);
 const sel=h('select',{onchange:e=>{chatFilter.status=e.target.value;renderChats()}},h('option',{value:''},'كل الحالات'),d.statuses.map(s=>h('option',{value:s.status,selected:s.status===chatFilter.status?'':null},(STATUS_AR[s.status]||s.status)+' ('+s.n+')')));
 const q=h('input',{placeholder:'ابحث بالاسم / الرقم / المدينة',value:chatFilter.q,onchange:e=>{chatFilter.q=e.target.value;renderChats()}});
 setMain(h('div',{},h('div',{class:'row card'},q,sel,h('small',{class:'m'},d.total+' عميل')),h('div',{class:'card'},table(['العميل','الحالة','مدينة','نسخة','أُرسل/ردود','آخر رد','آخر نشاط'],d.rows.map(r=>[h('a',{class:'l',onclick:()=>{openLead=r.id;renderChats()}},r.name),STATUS_AR[r.status]||r.status,r.city||'—',r.variant||'—',r.sent_n+' / '+r.in_n,r.last_reply||'—',fmtD(r.last_at)])))))}
async function renderLead(id){const c=await api('/api/lead/'+encodeURIComponent(id));if(!c){openLead=null;return renderChats()}const l=c.lead;
 setMain(h('div',{},h('button',{class:'a',onclick:()=>{openLead=null;renderChats()}},'← رجوع للقائمة'),
  h('div',{class:'card',style:'margin-top:10px'},h('h2',{},l.name),h('div',{class:'row'},h('span',{class:'pill'},STATUS_AR[l.status]||l.status),h('span',{class:'pill'},'تصنيف '+(l.tier||'—')+' · '+(l.score??'—')),h('span',{class:'pill'},'نسخة '+(l.variant||'—')),l.dnc?h('span',{class:'pill bad'},'ممنوع التواصل'):null,h('small',{class:'m'},[l.city,l.phone,l.owner&&('المالك: '+l.owner),l.website].filter(Boolean).join(' · '))),l.note?h('div',{class:'sub'},'ملاحظة: '+l.note):null,
   h('div',{class:'row',style:'margin-top:8px'},!l.dnc?h('button',{class:'a d',onclick:()=>confirm('منع التواصل نهائيًا؟')&&act('/api/dnc?lead='+l.id).then(()=>renderLead(id))},'منع التواصل نهائيًا'):null)),
  h('div',{class:'cols'},h('div',{class:'card'},h('h2',{},'المحادثة الكاملة'),c.messages.length?c.messages.map(m=>h('div',{class:'msg '+(m.dir==='out'?'out':'in')},h('div',{},h('span',{class:'tag'},KIND_AR[m.kind]||m.kind),h('span',{class:'tag'},m.state),m.delivery?h('span',{class:'tag'},m.delivery):null,m.variant?h('span',{class:'tag'},'نسخة '+m.variant):null),h('div',{},m.text),m.line?h('div',{class:'sub'},'الجملة الشخصية: '+m.line):null,m.checks?h('div',{class:'sub'},'فحوصات '+m.checks.passed+'/'+m.checks.total+(m.judge==null?'':m.judge?' · محكّم ✅':' · محكّم ❌')):null,m.reply?h('div',{class:'sub'},'التصنيف: '+m.reply.label+' ('+Math.round(m.reply.confidence*100)+'%)'+(m.reply.needsEyes?' ⚠️':'')):null,m.reply&&m.reply.suggested?h('div',{class:'sub'},'الرد المقترح: '+m.reply.suggested):null,m.failure?h('div',{class:'sub negative'},'سبب فشل: '+m.failure):null,h('div',{class:'sub'},fmtD(m.at)))):h('small',{class:'m'},'لا رسائل بعد')),
   h('div',{},h('div',{class:'card'},h('h2',{},'الأدلة اللي اتبنت عليها الرسالة'),c.evidence.length?c.evidence.map(e=>h('p',{},h('span',{class:'tag'},e.type),e.snippet,h('small',{class:'m'},' — '+e.source))):h('small',{class:'m'},'لا أدلة')),h('div',{class:'card'},h('h2',{},'سجل الحالة'),table(['الوقت','الحدث',''],c.history.slice(-40).map(e=>[fmtD(e.at),e.type==='status'?(STATUS_AR[e.data.from]||e.data.from)+' ← '+(STATUS_AR[e.data.to]||e.data.to):e.type,e.actor])))))))}

async function renderControl(){const [o,s,r]=await Promise.all([api('/api/overview'),api('/api/settings'),api('/api/replies')]);
 setMain(h('div',{},h('div',{class:'card'},h('h2',{},'التحكم'),h('div',{class:'row'},o.state.paused?h('button',{class:'a',onclick:()=>act('/api/resume')},'▶️ استئناف'):h('button',{class:'a d',onclick:()=>act('/api/pause')},'⏸ إيقاف فوري'),['off','assisted','auto'].map(m=>h('button',{class:'a',style:o.state.mode===m?'border-color:var(--gold)':'',onclick:()=>confirm('تغيير وضع الإرسال إلى '+m+'؟')&&act('/api/mode?m='+m)},m)),h('small',{class:'m'},'الوضع الفعلي يحتاج SEND_ENABLED=true على السيرفر'))),
  h('div',{class:'card'},h('h2',{},'ردود تنتظر ('+r.length+')'),r.length?table(['العميل','النوع','الرد','',''],r.map(x=>[h('a',{class:'l',onclick:()=>{openLead=x.lead_id;go('chats')}},x.lead),x.category,'«'+x.text+'»',x.suggested?h('small',{class:'m'},'مقترح: '+x.suggested):'',h('button',{class:'a',onclick:()=>act('/api/handled?id='+x.message_id)},'تمّ')])):h('small',{class:'m'},'لا شيء')),
  h('div',{class:'card'},h('h2',{},'الإعدادات الحالية (للقراءة)'),h('pre',{style:'white-space:pre-wrap;direction:ltr;font-size:12px;color:var(--mut)'},JSON.stringify(s,null,1)))))}

async function act(p){await api(p,{method:'POST'});refresh()}
function setMain(n){const m=$('#main');m.replaceChildren(n)}
const R={overview:renderOverview,funnel:renderFunnel,results:renderResults,reasons:renderReasons,quality:renderQuality,chats:renderChats,control:renderControl};
function go(t){tab=t;localStorage.setItem('tab',t);drawTabs();refresh()}
function drawTabs(){$('#tabs').replaceChildren(...TABS.map(([k,l])=>h('button',{class:k===tab?'on':'',onclick:()=>{openLead=null;go(k)}},l)))}
let busy=false,again=false;async function refresh(){if(busy){again=true;return}busy=true;try{await R[tab]()}catch(e){setMain(h('div',{class:'card bad'},'تعذّر التحميل: '+e.message))}busy=false;if(again){again=false;refresh()}}
$('#range').addEventListener('change',refresh);setInterval(()=>{$('#clock').textContent=new Date().toLocaleTimeString('ar-SA-u-nu-latn')},1000);
try{const es=new EventSource('/api/stream');let deb;es.onmessage=()=>{clearTimeout(deb);deb=setTimeout(refresh,300)};es.onerror=()=>{$('#live').className='pill warn'};es.onopen=()=>{$('#live').className='pill ok'}}catch(e){}
setInterval(refresh,30000);drawTabs();refresh();
</script></html>`;
}
