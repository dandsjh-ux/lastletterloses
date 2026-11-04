'use strict';
/* Server-authoritative game engine for Last Letter Loses (online mode).
   One Room = one game. Players (seats, max 6) and spectators connect through WebSockets;
   the server validates every word, decides when letters touch the bomb, and runs all timers. */
const R=require('../shared/rules');

const MAX_PLAYERS=6, MAX_WATCHERS=20;
const CODE_CHARS='BCDFGHJKMNPQRSTVWXZ';            // no vowels => never spells a word
const rid=(n)=>{ let s=''; const c='abcdefghijklmnopqrstuvwxyz0123456789'; for(let i=0;i<n;i++) s+=c[Math.floor(Math.random()*c.length)]; return s; };
const clampStr=(s,n)=>String(s==null?'':s).replace(/[\u0000-\u001f<>&"']/g,'').trim().slice(0,n);

class Room{
  constructor(code,dict,onEmpty){
    this.code=code; this.dict=dict; this.onEmpty=onEmpty;
    this.has=w=>dict.has(w);
    this.cand=w=>R.candidates(w,this.has);
    this.S=R.sanitizeSettings({});
    this.members=new Map();          // token -> {id,token,ws,name,color,seat,connected,host}
    this.players=[];                 // seated players in turn order
    this.hostToken=null;
    this.phase='lobby';
    this.timers=new Set();
    this.created=Date.now();
    this.emptySince=null;
    this.resetGame();
  }

  /* ---------- plumbing ---------- */
  resetGame(){
    this.clearTimers();
    this.used=R.makeUsed(this.cand);
    this.cur=0; this.round=1; this.cells=36; this.chainLen=0; this.barX=0; this.letters=[]; this.lastLetter=null;
    this.deadline=null; this.turnTimer=null; this.shopEnd=null; this.pendingOverride=null; this.first=true;
  }
  after(ms,fn){ const t=setTimeout(()=>{ this.timers.delete(t); try{ fn(); }catch(e){ console.error('room timer error',e); } },ms); this.timers.add(t); return t; }
  clearTimers(){ this.timers.forEach(clearTimeout); this.timers.clear(); if(this.turnTimer){ clearTimeout(this.turnTimer); this.turnTimer=null; } }
  send(m,msg){ if(m.ws&&m.ws.readyState===1){ try{ m.ws.send(JSON.stringify(msg)); }catch(e){} } }
  broadcast(msg){ const s=JSON.stringify(msg); this.members.forEach(m=>{ if(m.ws&&m.ws.readyState===1){ try{ m.ws.send(s); }catch(e){} } }); }
  seatOf(m){ return m.seat; }
  host(){ return this.members.get(this.hostToken)||null; }
  isHost(m){ return !!m&&m.token===this.hostToken; }
  playerOf(m){ return m&&m.seat>=0?this.players[m.seat]:null; }
  pub(p){ const m=this.members.get(p.token); return {id:p.id,name:p.name,color:p.color,lives:p.lives,max:p.max,alive:p.alive,pts:p.pts,inv:p.inv,jinxed:p.jinxed,ready:p.ready,connected:!!(m&&m.connected)}; }
  pubPlayers(){ return this.players.map(p=>this.pub(p)); }
  nextAlive(i){ const n=this.players.length; for(let k=1;k<=n;k++){ const j=(i+k)%n; if(this.players[j].alive) return j; } return i; }
  aliveCount(){ return this.players.filter(p=>p.alive).length; }
  watchers(){ let n=0; this.members.forEach(m=>{ if(m.seat<0&&m.connected) n++; }); return n; }
  connectedCount(){ let n=0; this.members.forEach(m=>{ if(m.connected) n++; }); return n; }
  turnMs(){ return this.deadline?Math.max(0,this.deadline-Date.now()):0; }

  lobbyMsg(){ return {t:'lobby',code:this.code,phase:this.phase,players:this.pubPlayers(),S:this.S,hostId:(this.host()||{}).id||null,watchers:this.watchers()}; }
  snapshot(){
    return {t:'state',code:this.code,phase:this.phase,players:this.pubPlayers(),S:this.S,hostId:(this.host()||{}).id||null,watchers:this.watchers(),
      cur:this.cur,round:this.round,cells:this.cells,lastLetter:this.lastLetter,barX:this.barX,letters:this.letters,used:this.used.list,
      ms:this.turnMs(),timed:!!this.deadline,shopMs:this.shopEnd?Math.max(0,this.shopEnd-Date.now()):0,nextCells:R.cellsForRound(this.S,this.round)};
  }
  sendLobbyToAll(){ this.broadcast(this.lobbyMsg()); }

  /* ---------- membership ---------- */
  join(ws,o){
    const name=clampStr(o.name,14)||'Player';
    const spectate=!!o.spectate;
    // reconnect
    if(o.token&&this.members.has(o.token)){
      const m=this.members.get(o.token);
      if(m.ws&&m.ws!==ws){ try{ m.ws.close(4000,'replaced'); }catch(e){} }
      m.ws=ws; m.connected=true; this.emptySince=null;
      this.send(m,{t:'joined',code:this.code,token:m.token,id:m.id,rejoin:true});
      this.send(m,this.snapshot());
      this.broadcastPlayers();
      this.onReconnect(m);
      return m;
    }
    if(this.phase!=='lobby'&&!spectate) return {error:'started',msg:'That game has already started. You can watch it instead.'};
    if(spectate){ if(this.watchers()>=MAX_WATCHERS) return {error:'full',msg:'Too many watchers in that room.'}; }
    else if(this.players.length>=MAX_PLAYERS) return {error:'full',msg:'That room is full (6 players).'};
    const m={id:rid(6),token:rid(20),ws,name,color:null,seat:-1,connected:true};
    if(!spectate){
      m.color=this.freeColor(o.color);
      const p={id:m.id,token:m.token,name,color:m.color,lives:this.S.lives,max:this.S.lives,alive:true,pts:0,inv:{},jinxed:false,ready:false};
      this.players.push(p); m.seat=this.players.length-1;
    }
    this.members.set(m.token,m);
    if(!this.hostToken||(!this.host())) this.hostToken=m.token;
    this.emptySince=null;
    this.send(m,{t:'joined',code:this.code,token:m.token,id:m.id});
    if(this.phase==='lobby'){ this.sendLobbyToAll(); } else { this.send(m,this.snapshot()); this.broadcast(this.lobbyMsg()); }
    return m;
  }
  freeColor(want){
    const taken=new Set(this.players.map(p=>p.color));
    if(want&&R.COLORS.some(c=>c.h===want)&&!taken.has(want)) return want;
    const c=R.COLORS.find(c=>!taken.has(c.h)); return c?c.h:R.COLORS[0].h;
  }
  disconnect(m,ws){
    if(!m||m.ws!==ws) return;
    m.connected=false; m.ws=null;
    if(this.phase==='lobby'){
      this.sendLobbyToAll();
      this.after(8000,()=>{ if(!m.connected&&this.members.get(m.token)===m) this.removeMember(m); });   // brief wifi blips keep the seat
      return;
    }
    this.broadcastPlayers();
    if(this.isHost(m)) this.reassignHost();
    if(this.connectedCount()===0) this.emptySince=Date.now();
    this.onDisconnectedDuringGame(m);
  }
  broadcastPlayers(){ this.broadcast({t:'players',players:this.pubPlayers(),hostId:(this.host()||{}).id||null,watchers:this.watchers()}); }
  reassignHost(){
    let next=null;
    this.members.forEach(m=>{ if(!next&&m.connected&&m.token!==this.hostToken&&m.seat>=0) next=m; });
    this.members.forEach(m=>{ if(!next&&m.connected&&m.token!==this.hostToken) next=m; });
    if(next){ this.hostToken=next.token; this.broadcastPlayers(); }
  }
  removeMember(m){
    if(this.members.get(m.token)!==m) return;
    this.members.delete(m.token);
    if(m.seat>=0){
      this.players.splice(m.seat,1);
      this.members.forEach(x=>{ if(x.seat>m.seat) x.seat--; });
    }
    if(this.isHost(m)){ this.hostToken=null; this.reassignHost(); if(!this.hostToken){ const f=this.members.values().next().value; if(f) this.hostToken=f.token; } }
    if(this.members.size===0){ this.clearTimers(); this.onEmpty&&this.onEmpty(this); return; }
    this.sendLobbyToAll();
  }
  leave(m){
    if(this.phase==='lobby'){ const ws=m.ws; this.removeMember(m); if(ws){ try{ ws.close(1000,'left'); }catch(e){} } return; }
    // mid-game: a leaving player simply forfeits (their seat stays so turn order is unchanged)
    const p=this.playerOf(m);
    if(p&&p.alive){ p.lives=0; }
    m.connected=false; const ws=m.ws; m.ws=null; m.left=true;
    if(this.isHost(m)) this.reassignHost();
    this.broadcastPlayers();
    if(ws){ try{ ws.close(1000,'left'); }catch(e){} }
    if(p&&p.alive){
      if(this.phase==='turn'&&this.players[this.cur]===p) this.doBoom(this.cur,'giveup');
      else this.markOutLater(p);
    }
    if(this.connectedCount()===0) this.emptySince=Date.now();
  }
  markOutLater(p){ p.pendingOut=true; }
  onReconnect(m){
    const p=this.playerOf(m);
    if(p&&this.phase==='turn'&&this.players[this.cur]===p&&this.deadline){ /* keep the running clock */ }
  }
  onDisconnectedDuringGame(m){
    const p=this.playerOf(m); if(!p) return;
    if(this.phase==='turn'&&this.players[this.cur]===p) this.capTurn(20000);
    if(this.phase==='shop') this.checkShopReady();
  }
  /* a disconnected player gets at most `ms` more to come back before their turn blows up */
  capTurn(ms){
    if(this.phase!=='turn') return;
    if(!this.deadline||this.turnMs()>ms) this.setDeadline(ms);
  }
  setDeadline(ms){
    if(this.turnTimer) clearTimeout(this.turnTimer);
    this.deadline=Date.now()+ms;
    this.turnTimer=setTimeout(()=>{ this.turnTimer=null; if(this.phase==='turn') this.doBoom(this.cur,'time'); },ms);
    this.broadcast({t:'clock',ms:ms});
  }

  /* ---------- lobby actions ---------- */
  setSettings(m,s){ if(!this.isHost(m)||this.phase!=='lobby') return; this.S=R.sanitizeSettings(s,this.S); this.players.forEach(p=>{ p.lives=p.max=this.S.lives; }); this.sendLobbyToAll(); }
  setProfile(m,o){
    if(this.phase!=='lobby'||m.seat<0) return; const p=this.players[m.seat];
    if(o.name!=null){ p.name=m.name=clampStr(o.name,14)||p.name; }
    if(o.color&&R.COLORS.some(c=>c.h===o.color)&&!this.players.some(x=>x!==p&&x.color===o.color)){ p.color=m.color=o.color; }
    this.sendLobbyToAll();
  }
  kick(m,id){
    if(!this.isHost(m)||this.phase!=='lobby') return;
    let target=null; this.members.forEach(x=>{ if(x.id===id) target=x; });
    if(!target||target===m) return;
    const ws=target.ws; this.send(target,{t:'kicked'}); this.removeMember(target); if(ws){ try{ ws.close(1000,'kicked'); }catch(e){} }
  }
  start(m){
    if(!this.isHost(m)||this.phase!=='lobby') return;
    if(this.players.length<2){ this.send(m,{t:'err',msg:'You need at least 2 players.'}); return; }
    for(const x of [...this.members.values()]){ if(!x.connected) this.removeMember(x); }
    if(this.players.length<2){ this.send(m,{t:'err',msg:'You need at least 2 players.'}); this.sendLobbyToAll(); return; }
    this.resetGame();
    this.players.forEach(p=>{ p.lives=p.max=this.S.lives; p.alive=true; p.pts=0; p.inv={}; p.jinxed=false; p.ready=false; p.pendingOut=false; });
    this.round=1; this.cur=0; this.first=true;
    this.startRound();
  }
  again(m){
    if(!this.isHost(m)||this.phase!=='over') return;
    this.phase='lobby'; this.resetGame();
    // drop anyone who left or is gone
    for(const [tok,x] of [...this.members]){ if(x.left||(!x.connected&&x.seat>=0)) { this.members.delete(tok); } }
    this.players=this.players.filter(p=>this.members.has(p.token));
    this.players.forEach((p,i)=>{ const x=this.members.get(p.token); x.seat=i; p.lives=p.max=this.S.lives; p.alive=true; p.pts=0; p.inv={}; p.jinxed=false; p.ready=false; });
    if(!this.host()) this.reassignHost();
    this.sendLobbyToAll();
  }

  /* ---------- game flow ---------- */
  startRound(){
    this.phase='intro'; this.cells=R.cellsForRound(this.S,this.round); this.chainLen=0; this.barX=0; this.letters=[]; this.lastLetter=null;
    this.deadline=null; this.pendingOverride=null;
    this.players.forEach(p=>{ p.jinxed=false; });
    let usedReset=false;
    if(this.S.resetUsed&&!this.first){ this.used.clear(); usedReset=true; }
    const first=this.first; this.first=false;
    this.broadcast({t:'round',round:this.round,cells:this.cells,cur:this.cur,players:this.pubPlayers(),first:first,usedReset:usedReset});
    this.after(first?1500:1600,()=>this.beginTurn());
  }
  beginTurn(){
    if(!this.players[this.cur]||!this.players[this.cur].alive) this.cur=this.nextAlive(this.cur);
    this.phase='turn'; this.pendingOverride=null;
    const p=this.players[this.cur]; const m=this.members.get(p.token);
    if(this.turnTimer){ clearTimeout(this.turnTimer); this.turnTimer=null; }
    this.deadline=null;
    let ms=this.S.timer?this.S.timer*1000:0;
    if(!m||!m.connected){ ms=(m&&m.left)?1500:(ms?Math.min(ms,20000):20000); }
    if(ms){ this.deadline=Date.now()+ms; this.turnTimer=setTimeout(()=>{ this.turnTimer=null; if(this.phase==='turn') this.doBoom(this.cur,'time'); },ms); }
    this.broadcast({t:'turn',cur:this.cur,ms:ms,lastLetter:this.lastLetter,players:this.pubPlayers()});
  }
  stopTurnClock(){ if(this.turnTimer){ clearTimeout(this.turnTimer); this.turnTimer=null; } this.deadline=null; }

  /* A player submits a word. msg = {word, armed:{shrink,double,jinx}, override} */
  submitWord(m,msg,forcedOverride){
    if(this.phase!=='turn') return;
    const p=this.playerOf(m); if(!p||this.players[this.cur]!==p) return;
    const raw=String(msg.word||'').trim().toLowerCase().slice(0,30);
    const override=!!forcedOverride||(!!msg.override&&this.isHost(m));
    const v=R.validateWord(raw,{lead:this.lastLetter||'',minWord:this.S.minWord,used:this.used,dictHas:this.S.dict?this.has:null,override:override});
    if(!v.ok){
      m.lastReject={raw:raw,armed:msg.armed||{},msg:v.msg,canOverride:!!v.canOverride};
      this.send(m,{t:'reject',msg:v.msg,canOverride:!!v.canOverride,isHost:this.isHost(m)});
      return;
    }
    m.lastReject=null; this.pendingOverride=null;
    const armed=msg.armed||{};
    const shr=!!armed.shrink&&(p.inv.shrink||0)>0, dbl=!!armed.double&&(p.inv.double||0)>0, jx=!!armed.jinx&&(p.inv.jinx||0)>0;
    if(shr) p.inv.shrink--; if(dbl) p.inv.double--; if(jx) p.inv.jinx--;
    const cw=R.turnScale(p.jinxed,shr); p.jinxed=false;
    this.stopTurnClock(); this.phase='adding';
    const full=v.word, pi=this.cur;
    const newLetters=[]; let boom=false;
    for(let i=this.lastLetter?1:0;i<full.length;i++){
      const ch=full[i], x0=this.barX;
      newLetters.push({ch:ch,x0:x0,cw:cw}); this.letters.push({ch:ch,x0:x0,cw:cw,color:p.color});
      this.barX+=cw; this.chainLen++;
      if(R.touchesAt(ch,x0,cw,this.cells)){ boom=true; break; }
    }
    const step=full.length>10?55:80;
    const animMs=newLetters.length*step;
    if(boom){
      this.broadcast({t:'word',pi:pi,word:full,letters:newLetters,boom:true,cw:cw,players:this.pubPlayers()});
      this.after(animMs+150,()=>this.doBoom(pi,'touch'));
      return;
    }
    const gain=R.awardFor(this.S,full.length,dbl); p.pts+=gain;
    this.used.add(full,pi,this.round); this.lastLetter=full[full.length-1];
    this.cur=this.nextAlive(pi);
    let jinxed=-1; if(jx){ this.players[this.cur].jinxed=true; jinxed=this.cur; }
    this.broadcast({t:'word',pi:pi,word:full,letters:newLetters,boom:false,cw:cw,gain:gain,dbl:dbl,jinx:jinxed,players:this.pubPlayers(),used:{word:full,pi:pi,round:this.round}});
    this.phase='between';
    this.after(animMs+350+450+100,()=>this.beginTurn());
  }
  giveUp(m){ if(this.phase!=='turn') return; const p=this.playerOf(m); if(!p||this.players[this.cur]!==p) return; this.doBoom(this.cur,'giveup'); }
  use(m,id){
    if(this.phase!=='turn') return;
    const p=this.playerOf(m); if(!p||this.players[this.cur]!==p) return;
    const it=R.ITEM[id]; if(!it||it.kind!=='now'||(p.inv[id]||0)<=0) return;
    if(id==='time'){
      if(!this.S.timer||!this.deadline) return;
      p.inv.time--; this.setDeadline(this.turnMs()+R.TIME_BY*1000);
      this.broadcast({t:'pu',id:'time',pi:this.cur,ms:this.turnMs(),players:this.pubPlayers()});
    } else if(id==='extend'){
      p.inv.extend--; this.cells+=R.EXTEND_BY;
      this.broadcast({t:'pu',id:'extend',pi:this.cur,cells:this.cells,players:this.pubPlayers()});
    } else if(id==='swap'){
      p.inv.swap--; this.stopTurnClock(); this.phase='between';
      const from=this.cur; this.cur=this.nextAlive(this.cur);
      this.broadcast({t:'pu',id:'swap',pi:from,to:this.cur,players:this.pubPlayers()});
      this.after(1000,()=>this.beginTurn());
    }
  }
  doBoom(pi,reason){
    if(this.phase==='boom'||this.phase==='shop'||this.phase==='over') return;
    this.stopTurnClock(); this.phase='boom'; this.pendingOverride=null;
    const p=this.players[pi]; let shielded=false;
    if((p.inv.shield||0)>0){ p.inv.shield--; shielded=true; }
    else { p.lives=Math.max(0,p.lives-1); p.pts+=R.PITY; }
    this.broadcast({t:'boom',pi:pi,reason:reason,shielded:shielded,lives:p.lives,players:this.pubPlayers()});
    this.after(2400,()=>this.afterBoom(pi));
  }
  afterBoom(pi){
    const p=this.players[pi];
    if(p.lives<=0){
      p.alive=false;
      this.broadcast({t:'out',pi:pi,players:this.pubPlayers()});
      this.after(1800,()=>this.proceedAfterBoom(pi));
    } else this.proceedAfterBoom(pi);
  }
  proceedAfterBoom(pi){
    // anyone who left mid-round is out now
    this.players.forEach(p=>{ if(p.pendingOut){ p.pendingOut=false; p.alive=false; p.lives=0; } });
    const alive=this.players.filter(p=>p.alive);
    if(alive.length<=1){ this.over(alive[0]||this.players[pi]); return; }
    this.cur=this.nextAlive(pi); this.round++;
    if(this.S.shop) this.openShop(); else this.startRound();
  }
  over(winner){
    this.phase='over'; this.stopTurnClock();
    this.broadcast({t:'over',winner:this.players.indexOf(winner),players:this.pubPlayers(),round:this.round});
  }

  /* ---------- shop ---------- */
  openShop(){
    this.phase='shop'; this.players.forEach(p=>{ p.ready=false; });
    this.shopEnd=Date.now()+R.SHOP_SECONDS*1000;
    this.broadcast({t:'shop',round:this.round,nextCells:R.cellsForRound(this.S,this.round),players:this.pubPlayers(),ms:R.SHOP_SECONDS*1000});
    this.shopTimer=this.after(R.SHOP_SECONDS*1000,()=>this.closeShop());
  }
  buy(m,id){
    if(this.phase!=='shop') return;
    const p=this.playerOf(m); const it=R.ITEM[id]; if(!p||!it||!p.alive) return;
    if(!R.canBuy(this.S,p,it).ok){ this.send(m,{t:'players',players:this.pubPlayers()}); return; }
    p.pts-=it.price;
    if(id==='heart') p.lives=Math.min(p.max,p.lives+1); else p.inv[id]=(p.inv[id]||0)+1;
    p.ready=false;
    this.broadcast({t:'players',players:this.pubPlayers(),bought:{pi:m.seat,id:id}});
  }
  ready(m,force){
    if(this.phase!=='shop') return;
    if(force&&this.isHost(m)){ this.closeShop(); return; }
    const p=this.playerOf(m); if(!p) return;
    p.ready=!p.ready; this.broadcastPlayers(); this.checkShopReady();
  }
  checkShopReady(){
    if(this.phase!=='shop') return;
    const waiting=this.players.filter(p=>{ if(!p.alive) return false; const m=this.members.get(p.token); return m&&m.connected&&!p.ready; });
    if(waiting.length===0) this.after(500,()=>this.closeShop());
  }
  closeShop(){
    if(this.phase!=='shop') return;
    this.shopEnd=null; this.clearTimers();
    this.startRound();
  }

  /* ---------- override (teacher accepts a rejected word) ---------- */
  askOverride(m){
    if(this.phase!=='turn') return; const p=this.playerOf(m); if(!p||this.players[this.cur]!==p) return;
    const lr=m.lastReject; if(!lr||!lr.canOverride) return;
    const h=this.host(); if(!h||!h.connected){ this.send(m,{t:'err',msg:'The host isn’t here to approve it.'}); return; }
    this.pendingOverride={token:m.token,raw:lr.raw,armed:lr.armed};
    this.send(h,{t:'ovreq',pi:m.seat,word:(this.lastLetter||'')+lr.raw,msg:lr.msg});
    this.send(m,{t:'info',msg:'Asked the host to accept “'+(this.lastLetter||'')+lr.raw+'”…'});
  }
  answerOverride(m,ok){
    if(!this.isHost(m)||!this.pendingOverride) return;
    const po=this.pendingOverride; this.pendingOverride=null;
    const req=this.members.get(po.token); if(!req||this.phase!=='turn') return;
    if(ok) this.submitWord(req,{word:po.raw,armed:po.armed},true);
    else this.send(req,{t:'reject',msg:'The host said no to that word.',canOverride:false});
  }

  /* ---------- incoming messages ---------- */
  handle(m,msg){
    switch(msg.t){
      case 'settings': return this.setSettings(m,msg.S);
      case 'profile': return this.setProfile(m,msg);
      case 'kick': return this.kick(m,msg.id);
      case 'start': return this.start(m);
      case 'again': return this.again(m);
      case 'word': return this.submitWord(m,msg);
      case 'use': return this.use(m,msg.id);
      case 'giveup': return this.giveUp(m);
      case 'buy': return this.buy(m,msg.id);
      case 'ready': return this.ready(m,!!msg.force);
      case 'ovreq': return this.askOverride(m);
      case 'ovans': return this.answerOverride(m,!!msg.ok);
      case 'leave': return this.leave(m);
    }
  }
}

/* ---------- room registry ---------- */
class Rooms{
  constructor(dict){ this.dict=dict; this.rooms=new Map(); this.sweeper=setInterval(()=>this.sweep(),60000); if(this.sweeper.unref) this.sweeper.unref(); }
  newCode(){ for(let tries=0;tries<200;tries++){ let c=''; for(let i=0;i<4;i++) c+=CODE_CHARS[Math.floor(Math.random()*CODE_CHARS.length)]; if(!this.rooms.has(c)) return c; } return null; }
  create(){ const code=this.newCode(); if(!code) return null; const r=new Room(code,this.dict,(room)=>this.rooms.delete(room.code)); this.rooms.set(code,r); return r; }
  get(code){ return this.rooms.get(String(code||'').toUpperCase().replace(/[^A-Z]/g,'').slice(0,4))||null; }
  sweep(){
    const now=Date.now();
    for(const [code,r] of this.rooms){
      if(r.connectedCount()===0){ if(!r.emptySince) r.emptySince=now; if(now-r.emptySince>15*60*1000){ r.clearTimers(); this.rooms.delete(code); } }
      else r.emptySince=null;
    }
  }
  stats(){ let players=0; this.rooms.forEach(r=>{ players+=r.connectedCount(); }); return {rooms:this.rooms.size,connected:players}; }
}

module.exports={Room,Rooms,MAX_PLAYERS,MAX_WATCHERS};
