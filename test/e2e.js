/* Browser end-to-end test: node test/e2e.js   (needs playwright + ws on NODE_PATH, chrome at /usr/bin/google-chrome) */
const { chromium } = require('/opt/npm-tools/node_modules/playwright');
const { spawn } = require('child_process');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const PORT=3917, URL='http://localhost:'+PORT+'/?view=dom';
(async()=>{
  const srv=spawn('node',['server.js'],{env:Object.assign({},process.env,{PORT:String(PORT),NODE_PATH:'/opt/npm-tools/node_modules'}),cwd:__dirname+'/..'});
  srv.stdout.on('data',d=>process.stdout.write('[srv] '+d)); srv.stderr.on('data',d=>process.stdout.write('[srv-err] '+d));
  await sleep(1500);
  const browser=await chromium.launch({executablePath:'/usr/bin/google-chrome',args:['--no-sandbox','--disable-gpu']});
  const errors=[];
  const mk=async(name)=>{
    const ctx=await browser.newContext({viewport:{width:1280,height:800}}); const page=await ctx.newPage();
    page.on('pageerror',e=>errors.push(name+' PAGEERROR '+e.message)); page.on('console',m=>{ if(m.type()==='error'&&!/ERR_|Failed to load resource|three|THREE/.test(m.text())) errors.push(name+' console: '+m.text()); });
    await page.route(/^https?:\/\/(?!localhost)/,r=>r.abort());
    await page.goto(URL); await page.waitForFunction(()=>window.__LLL&&document.querySelector('#start').textContent!=='Loading…',null,{timeout:30000});
    return {ctx,page,name};
  };
  const T=await mk('teacher'), A=await mk('Ann'), B=await mk('Bob'), C=await mk('Cleo');
  const st=(c)=>c.page.evaluate(()=>{const G=__LLL.G;return {phase:G.phase,cur:G.cur,me:__LLL.NET.me,host:__LLL.NET.isHost,round:G.round,cells:G.cells,last:G.lastLetter,barX:+G.barX.toFixed(1),pts:G.players.map(p=>p.pts),lives:G.players.map(p=>p.lives),n:G.players.length,timed:G.timed}});
  const phase=(c,p,t=20000)=>c.page.waitForFunction(x=>window.__LLL.G.phase===x,p,{timeout:t});
  const say=(...a)=>console.log(...a);

  // --- teacher creates a watch-only room
  await T.page.click('#modeOnline'); await T.page.check('#nSpec'); await T.page.fill('#nName','Mr Teacher'); await T.page.click('#nCreate');
  await T.page.waitForSelector('.roomcode'); const code=await T.page.$eval('.roomcode',e=>e.innerText.trim()); say('room code',code);
  // --- students join (one through the ?room= link)
  for(const [c,col] of [[A,2],[B,1]]){ await c.page.click('#modeOnline'); await c.page.fill('#nName',c.name); await c.page.fill('#nCode',code); await c.page.click('#nJoin'); await c.page.waitForSelector('.roomcode'); }
  await C.page.goto('http://localhost:'+PORT+'/?view=dom&room='+code); await C.page.waitForFunction(()=>window.__LLL&&document.querySelector('#start').textContent!=='Loading…');
  say('prefilled code on link join:',await C.page.$eval('#nCode',e=>e.value)); await C.page.fill('#nName','Cleo'); await C.page.click('#nJoin'); await C.page.waitForSelector('.roomcode');
  await sleep(400);
  say('lobby list (teacher):',await T.page.$$eval('#nList li',l=>l.map(x=>x.innerText.replace(/\n+/g,' '))));
  say('settings locked for student:',await A.page.$eval('#sTimer',e=>e.disabled),'| teacher can edit:',!(await T.page.$eval('#sTimer',e=>e.disabled)));
  await T.page.selectOption('#sTimer','0'); await T.page.click('#lm'); await sleep(500);
  say('student sees timer/hearts from host:',await A.page.$eval('#sTimer',e=>e.value),await A.page.evaluate(()=>__LLL.S.lives));
  await T.page.screenshot({path:'/tmp/e2e_lobby_teacher.png'}); await A.page.screenshot({path:'/tmp/e2e_lobby_student.png'});
  say('start disabled for student?',await A.page.$('#nStart')===null);
  await T.page.click('#nStart');
  for(const c of [T,A,B,C]) await phase(c,'turn');
  say('after start',JSON.stringify(await st(A)),JSON.stringify(await st(T)));
  say('input enabled  Ann/Bob/Cleo:',await A.page.$eval('#word',e=>!e.disabled),await B.page.$eval('#word',e=>!e.disabled),await C.page.$eval('#word',e=>!e.disabled),'| teacher input row hidden:',await T.page.$eval('#inputZone .inrow',e=>getComputedStyle(e).display));
  say('prompts:',await A.page.$eval('#prompt',e=>e.innerText),'|',await B.page.$eval('#prompt',e=>e.innerText));
  await A.page.screenshot({path:'/tmp/e2e_game_ann.png'}); await B.page.screenshot({path:'/tmp/e2e_game_bob.png'}); await T.page.screenshot({path:'/tmp/e2e_game_teacher.png'});

  // --- Ann plays apple; everyone sees it
  await A.page.fill('#word','apple'); await A.page.press('#word','Enter'); await sleep(2500);
  for(const c of [T,B,C]) await phase(c,'turn');
  say('letters on bar (teacher/bob):',await T.page.$$eval('#fb .fc',l=>l.map(x=>x.innerText).join('')),await B.page.$$eval('#fb .fc',l=>l.map(x=>x.innerText).join('')),'pts',JSON.stringify((await st(B)).pts),'cur',(await st(B)).cur,'last',(await st(B)).last);
  // wrong player typing does nothing; Bob continues
  await B.page.fill('#word','lephant'); await B.page.press('#word','Enter'); await sleep(3200);
  say('bar after Bob:',await T.page.$$eval('#fb .fc',l=>l.map(x=>x.innerText).join('')),JSON.stringify((await st(C)).pts));
  // dictionary rejection + student asks the teacher
  await C.page.fill('#word','zorp'); await C.page.press('#word','Enter'); await sleep(300);
  say('Cleo reject msg:',await C.page.$eval('#msg',e=>e.innerText.replace(/\n/g,' | ')));
  await C.page.click('#msg button'); await sleep(400);
  say('teacher modal:',await T.page.$eval('.overlay .mcard',e=>e.innerText.replace(/\n+/g,' | ')));
  await T.page.click('.overlay .btn:not(.red)'); await sleep(3000);
  say('after teacher accepted:',await T.page.$$eval('#fb .fc',l=>l.map(x=>x.innerText).join('')),JSON.stringify((await st(A)).pts));
  // Ann plays 'pe' + ... last letter is p -> Ann: 'pen'
  await A.page.fill('#word','en'); await A.page.press('#word','Enter'); await sleep(2500);
  // Bob gives up -> boom for all
  await phase(B,'turn'); await B.page.click('#giveUp'); await sleep(600);
  say('boom toast:',await A.page.$eval('#toast',e=>e.innerText.replace(/\n/g,' ')),'| phase',(await st(A)).phase);
  for(const c of [T,A,B,C]) await phase(c,'shop',8000);
  say('shop (Bob view):',(await B.page.$eval('#shop .sub',e=>e.innerText)));
  await B.page.screenshot({path:'/tmp/e2e_shop_bob.png'}); await T.page.screenshot({path:'/tmp/e2e_shop_teacher.png'});
  const pts=(await st(B)).pts; say('points',JSON.stringify(pts));
  // Ann (most points) buys something; shield costs 40 - see what's affordable
  const aff=await A.page.$$eval('.buy',b=>b.filter(x=>!x.disabled).map(x=>x.dataset.id)); say('Ann can afford',aff.join(','));
  if(aff.length){ await A.page.click('.buy[data-id="'+aff[0]+'"]'); await sleep(300); say('Ann bought',aff[0],'->',JSON.stringify((await st(A)).pts),await A.page.evaluate(()=>JSON.stringify(__LLL.G.players[__LLL.NET.me].inv))); }
  // reconnect: Bob reloads the page mid-shop
  await B.page.reload(); await B.page.waitForFunction(()=>window.__LLL&&document.querySelector('#shop'),null,{timeout:15000}); say('Bob reloaded back into shop; me=',(await st(B)).me,'host?',(await st(B)).host);
  // ready up everyone; teacher forces start
  await A.page.click('#shopGo'); await C.page.click('#shopGo'); await B.page.click('#shopGo'); await sleep(1800);
  for(const c of [T,A,B,C]) await phase(c,'turn',8000);
  say('round 2:',JSON.stringify(await st(A)),'shop gone?',await A.page.$('#shop')===null);
  // play until someone is out: everybody gives up repeatedly
  const t0=Date.now(); while(Date.now()-t0<150000){ const s=await st(T); if(s.phase==='over') break; if(s.phase==='turn'){ const who=[A,B,C][s.cur]; if(who&&who.page) await who.page.click('#giveUp').catch(()=>{}); await sleep(300); } else if(s.phase==='shop'){ await T.page.click('#shopGo'); await sleep(300); } else await sleep(400); }
  say('final',JSON.stringify(await st(T)));
  await phase(T,'over',5000); say('win overlay (teacher):',await T.page.$eval('#win',e=>e.innerText.replace(/\n+/g,' | ')));
  await T.page.screenshot({path:'/tmp/e2e_win.png'});
  await T.page.click('#again'); await sleep(600);
  for(const c of [T,A,B,C]) await c.page.waitForSelector('.roomcode',{timeout:5000});
  say('back in lobby, players',(await st(T)).n,'| setup visible for student:',await A.page.$eval('#setup',e=>!e.classList.contains('hidden')));
  say('ERRORS',JSON.stringify(errors));
  await browser.close(); srv.kill(); process.exit(0);
})().catch(e=>{ console.error('FAIL',e); process.exit(1); });
