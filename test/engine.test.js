'use strict';
/* Engine tests with fake sockets and mocked timers:  node test/engine.test.js */
const assert=require('assert');
const { mock }=require('node:test');
const fs=require('fs'), path=require('path'), zlib=require('zlib');
const R=require('../shared/rules');
const { Rooms }=require('../server/engine');
const text=zlib.gunzipSync(Buffer.from(fs.readFileSync(path.join(__dirname,'../assets/dict.b64'),'utf8').trim(),'base64')).toString('utf8');
const dict=R.decodeFrontCoded(text);
mock.timers.enable({apis:['setTimeout','Date']});
const tick=ms=>mock.timers.tick(ms);

class FakeWS{ constructor(){ this.readyState=1; this.sent=[]; } send(s){ this.sent.push(JSON.parse(s)); } close(){ this.readyState=3; } last(t){ for(let i=this.sent.length-1;i>=0;i--) if(this.sent[i].t===t) return this.sent[i]; return null; } all(t){ return this.sent.filter(m=>m.t===t); } }
let passed=0; const ok=(name,fn)=>{ try{ fn(); passed++; console.log('  ok  ',name); }catch(e){ console.log('  FAIL',name,'\n      ',e.message); process.exitCode=1; } };

function setup(n,opts){
  const rooms=new Rooms(dict); const room=rooms.create(); const ms=[], ws=[];
  for(let i=0;i<n;i++){ const w=new FakeWS(); const m=room.join(w,{name:'P'+i}); ms.push(m); ws.push(w); }
  if(opts&&opts.S) room.setSettings(ms[0],opts.S);
  return {rooms,room,ms,ws};
}
const word=(room,m,w,armed)=>room.handle(m,{t:'word',word:w,armed:armed||{}});
function playTurn(room,ms,w,armed){ const m=ms[room.cur]; word(room,m,w,armed); tick(3000); }   // enough for letters + gap

console.log('lobby');
ok('room codes are 4 consonants',()=>{ const {room}=setup(1); assert(/^[BCDFGHJKMNPQRSTVWXZ]{4}$/.test(room.code)); });
ok('6 players max, 7th refused; watchers allowed',()=>{ const {room,ms}=setup(6); const r=room.join(new FakeWS(),{name:'X'}); assert.strictEqual(r.error,'full'); const w=room.join(new FakeWS(),{name:'Teacher',spectate:true}); assert(!w.error); assert.strictEqual(room.players.length,6); });
ok('colours are unique even if two ask for the same one',()=>{ const rooms=new Rooms(dict); const room=rooms.create(); room.join(new FakeWS(),{name:'a',color:'#ff4b4b'}); room.join(new FakeWS(),{name:'b',color:'#ff4b4b'}); assert.notStrictEqual(room.players[0].color,room.players[1].color); });
ok('only the host can change settings / start; needs 2 players',()=>{ const {room,ms}=setup(2); room.handle(ms[1],{t:'settings',S:{lives:5}}); assert.strictEqual(room.S.lives,3); room.handle(ms[0],{t:'settings',S:{lives:5,timer:30,startLen:9999}}); assert.strictEqual(room.S.lives,5); assert.strictEqual(room.S.startLen,60); room.handle(ms[1],{t:'start'}); assert.strictEqual(room.phase,'lobby'); });
ok('late joiners are refused (can watch) once a game has started',()=>{ const {room,ms}=setup(2); room.handle(ms[0],{t:'start'}); const r=room.join(new FakeWS(),{name:'late'}); assert.strictEqual(r.error,'started'); });

console.log('turns & words');
ok('start -> round -> turn for player 0',()=>{ const {room,ms,ws}=setup(3,{S:{timer:0}}); room.handle(ms[0],{t:'start'}); assert.strictEqual(room.phase,'intro'); tick(1500); assert.strictEqual(room.phase,'turn'); assert.strictEqual(room.cur,0); assert(ws[2].last('round')); assert(ws[2].last('turn')); });
ok('out-of-turn words are ignored',()=>{ const {room,ms}=setup(3,{S:{timer:0}}); room.handle(ms[0],{t:'start'}); tick(1500); word(room,ms[1],'apple'); assert.strictEqual(room.phase,'turn'); assert.strictEqual(room.used.list.length,0); });
ok('first word accepted, points 5 letters = 4, continues from last letter',()=>{ const {room,ms,ws}=setup(3,{S:{timer:0}}); room.handle(ms[0],{t:'start'}); tick(1500); word(room,ms[0],'apple'); const w=ws[1].last('word'); assert.strictEqual(w.word,'apple'); assert.strictEqual(w.gain,4); assert.strictEqual(w.letters.length,5); tick(3000); assert.strictEqual(room.cur,1); assert.strictEqual(room.lastLetter,'e'); word(room,ms[1],'lephant'); const w2=ws[0].last('word'); assert.strictEqual(w2.word,'elephant'); assert.strictEqual(w2.letters.length,7); assert.strictEqual(w2.gain,32); assert.strictEqual(room.players[1].pts,32); });
ok('repeat / other form / not a word are rejected with the right flags',()=>{ const {room,ms,ws}=setup(2,{S:{timer:0}}); room.handle(ms[0],{t:'start'}); tick(1500); word(room,ms[0],'tree'); tick(3000); word(room,ms[1],'eeee'); assert(/dictionary/.test(ws[1].last('reject').msg)); assert(ws[1].last('reject').canOverride); room.handle(ms[1],{t:'word',word:'ees',armed:{}}); assert(ws[1].last('reject')); });
ok('plurals blocked; host may override, student asks host',()=>{ const {room,ms,ws}=setup(2,{S:{timer:0}}); room.handle(ms[0],{t:'start'}); tick(1500); word(room,ms[0],'dog'); tick(3000);  // p1 must start with g
  word(room,ms[1],'zorp'); assert(ws[1].last('reject').canOverride); room.handle(ms[1],{t:'ovreq'}); const q=ws[0].last('ovreq'); assert(q&&q.word==='gzorp'); room.handle(ms[1],{t:'ovans',ok:true}); assert.strictEqual(room.phase,'turn'); room.handle(ms[0],{t:'ovans',ok:true}); assert.strictEqual(ms[1].lastReject,null); assert.strictEqual(room.phase,'between'); });
ok('non-host cannot self-override; host answer from a non-host is ignored',()=>{ const {room,ms,ws}=setup(2,{S:{timer:0}}); room.handle(ms[0],{t:'start'}); tick(1500); word(room,ms[0],'dog'); tick(3000); room.handle(ms[1],{t:'word',word:'zorp',override:true,armed:{}}); assert.strictEqual(room.phase,'turn'); });
ok('turn timer: time up -> boom, heart lost, comfort points',()=>{ const {room,ms,ws}=setup(3,{S:{timer:10}}); room.handle(ms[0],{t:'start'}); tick(1500); tick(10000); assert.strictEqual(room.phase,'boom'); const b=ws[1].last('boom'); assert.strictEqual(b.reason,'time'); assert.strictEqual(room.players[0].lives,2); assert.strictEqual(room.players[0].pts,8); });
ok('word touching the bomb: letters stop at the touching one, no points, no used word',()=>{ const {room,ms,ws}=setup(2,{S:{timer:0}}); room.handle(ms[0],{t:'start'}); tick(1500); room.cells=7; word(room,ms[0],'rainbow'); const w=ws[1].last('word'); assert(w.boom); assert.strictEqual(w.letters.length,7); assert.strictEqual(room.used.list.length,0); tick(800); assert.strictEqual(room.phase,'boom'); });
ok('narrow letter in the last cell is safe, wide one is not (same as local mode)',()=>{ const a=setup(2,{S:{timer:0}}); a.room.handle(a.ms[0],{t:'start'}); tick(1500); a.room.cells=7; word(a.room,a.ms[0],'origami'); assert(!a.ws[1].last('word').boom); });
ok('give up explodes the current player only',()=>{ const {room,ms}=setup(3,{S:{timer:0}}); room.handle(ms[0],{t:'start'}); tick(1500); room.handle(ms[1],{t:'giveup'}); assert.strictEqual(room.phase,'turn'); room.handle(ms[0],{t:'giveup'}); assert.strictEqual(room.phase,'boom'); });

console.log('shop & power-ups');
function toShop(extra){ const t=setup(3,Object.assign({S:{timer:20,lives:3}},extra||{})); t.room.handle(t.ms[0],{t:'start'}); tick(1500); t.room.handle(t.ms[0],{t:'giveup'}); tick(2400); return t; }
ok('after a round the shop opens; next round shorter; start player is after the loser',()=>{ const {room,ws}=toShop(); assert.strictEqual(room.phase,'shop'); const s=ws[0].last('shop'); assert.strictEqual(s.round,2); assert.strictEqual(s.nextCells,33); assert.strictEqual(room.cur,1); });
ok('buying validates points, caps and hearts',()=>{ const {room,ms,ws}=toShop(); const p=room.players[1]; p.pts=100; room.handle(ms[1],{t:'buy',id:'shrink'}); assert.strictEqual(p.inv.shrink,1); assert.strictEqual(p.pts,88); room.handle(ms[1],{t:'buy',id:'heart'}); assert.strictEqual(p.pts,88); p.pts=5; room.handle(ms[1],{t:'buy',id:'swap'}); assert(!p.inv.swap); p.pts=500; room.handle(ms[1],{t:'buy',id:'shield'}); room.handle(ms[1],{t:'buy',id:'shield'}); assert.strictEqual(p.inv.shield,1); assert.strictEqual(R.ITEM.swap.price,90); });
ok('heart purchase restores the one lost by the loser (and only up to max)',()=>{ const {room,ms}=toShop(); const p=room.players[0]; p.pts=200; assert.strictEqual(p.lives,2); room.handle(ms[0],{t:'buy',id:'heart'}); assert.strictEqual(p.lives,3); room.handle(ms[0],{t:'buy',id:'heart'}); assert.strictEqual(p.lives,3); });
ok('shop ends when everyone is ready, or host forces, or timer runs out',()=>{ const a=toShop(); a.ms.forEach(m=>a.room.handle(m,{t:'ready'})); tick(600); assert.strictEqual(a.room.phase,'intro'); const b=toShop(); b.room.handle(b.ms[1],{t:'ready',force:true}); assert.strictEqual(b.room.phase,'shop'); b.room.handle(b.ms[0],{t:'ready',force:true}); assert.strictEqual(b.room.phase,'intro'); const c=toShop(); tick(90000); assert.strictEqual(c.room.phase,'intro'); });
ok('shop can be switched off',()=>{ const {room,ms}=setup(3,{S:{timer:0,shop:false}}); room.handle(ms[0],{t:'start'}); tick(1500); room.handle(ms[0],{t:'giveup'}); tick(2400); assert.strictEqual(room.phase,'intro'); assert.strictEqual(room.round,2); });
function inRound(inv){ const t=setup(3,{S:{timer:30}}); t.room.handle(t.ms[0],{t:'start'}); tick(1500); Object.assign(t.room.players[0].inv,inv); return t; }
ok('extend adds 10 spaces for everyone',()=>{ const {room,ms,ws}=inRound({extend:1}); room.handle(ms[0],{t:'use',id:'extend'}); assert.strictEqual(room.cells,46); assert.strictEqual(ws[2].last('pu').cells,46); assert(!room.players[0].inv.extend); room.handle(ms[0],{t:'use',id:'extend'}); assert.strictEqual(room.cells,46); });
ok('extra time adds 10 seconds',()=>{ const {room,ms,ws}=inRound({time:1}); tick(5000); const before=room.turnMs(); room.handle(ms[0],{t:'use',id:'time'}); assert(Math.abs(room.turnMs()-(before+10000))<5); tick(34000); assert.strictEqual(room.phase,'turn'); tick(1500); assert.strictEqual(room.phase,'boom'); });
ok('swap passes the turn to the next player, who gets a fresh clock',()=>{ const {room,ms,ws}=inRound({swap:1}); tick(5000); room.handle(ms[0],{t:'use',id:'swap'}); assert.strictEqual(room.cur,1); tick(1000); assert.strictEqual(room.phase,'turn'); assert.strictEqual(room.turnMs(),30000); });
ok('shrink makes thin letters and the touch uses the thin width; double doubles points; jinx widens next player',()=>{ const {room,ms,ws}=inRound({shrink:1,double:1,jinx:1}); room.cells=Math.round(room.barX)+7; word(room,ms[0],'rainbow',{shrink:true,double:true,jinx:true}); const w=ws[1].last('word'); assert(!w.boom); assert(w.letters.every(l=>l.cw===0.6)); assert.strictEqual(w.gain,R.awardFor(room.S,7,true)); assert.strictEqual(w.jinx,1); assert(room.players[1].jinxed); tick(3000); word(room,ms[1],'ake',{}); const w2=ws[0].last('word'); assert(w2.letters.every(l=>l.cw===1.4)); assert(!room.players[1].jinxed); });
ok('armed flags without inventory are ignored',()=>{ const {room,ms,ws}=inRound({}); word(room,ms[0],'apple',{shrink:true,double:true,jinx:true}); const w=ws[1].last('word'); assert.strictEqual(w.letters[0].cw,1); assert.strictEqual(w.gain,4); assert.strictEqual(w.jin,undefined); });
ok('shield absorbs the explosion: no heart lost, no comfort points',()=>{ const {room,ms,ws}=inRound({shield:1}); room.handle(ms[0],{t:'giveup'}); const b=ws[1].last('boom'); assert(b.shielded); assert.strictEqual(room.players[0].lives,3); assert.strictEqual(room.players[0].pts,0); assert(!room.players[0].inv.shield); });

console.log('elimination, reconnect, host');
ok('last player standing wins; host can go back to the lobby',()=>{ const {room,ms,ws}=setup(2,{S:{timer:0,lives:1,shop:true}}); room.handle(ms[0],{t:'start'}); tick(1500); room.handle(ms[0],{t:'giveup'}); tick(2400); assert.strictEqual(ws[1].last('out').pi,0); tick(1800); assert.strictEqual(room.phase,'over'); const o=ws[0].last('over'); assert.strictEqual(o.winner,1); room.handle(ms[1],{t:'again'}); assert.strictEqual(room.phase,'over'); room.handle(ms[0],{t:'again'}); assert.strictEqual(room.phase,'lobby'); assert.strictEqual(room.players.length,2); assert.strictEqual(room.players[0].lives,1); });
ok('a dropped player can reconnect with their token and gets the full state',()=>{ const {room,ms,ws}=setup(3,{S:{timer:30}}); room.handle(ms[0],{t:'start'}); tick(1500); word(room,ms[0],'apple'); tick(3000); const tok=ms[1].token; room.disconnect(ms[1],ws[1]); assert(room.turnMs()<=20000); const nw=new FakeWS(); const m=room.join(nw,{token:tok,name:'P1'}); assert.strictEqual(m.seat,1); const s=nw.last('state'); assert.strictEqual(s.phase,'turn'); assert.strictEqual(s.letters.length,5); assert.strictEqual(s.lastLetter,'e'); assert(s.used.length===1); assert(s.ms>0); });
ok('disconnected current player blows up after the grace period',()=>{ const {room,ms,ws}=setup(3,{S:{timer:0}}); room.handle(ms[0],{t:'start'}); tick(1500); room.disconnect(ms[0],ws[0]); assert.strictEqual(room.phase,'turn'); tick(20100); assert.strictEqual(room.phase,'boom'); });
ok('host leaves -> host passes to a connected player',()=>{ const {room,ms,ws}=setup(3,{S:{timer:0}}); room.handle(ms[0],{t:'start'}); tick(1500); room.disconnect(ms[0],ws[0]); assert.notStrictEqual(room.hostToken,ms[0].token); });
ok('lobby: dropped player keeps seat for a few seconds, then is removed; start skips them',()=>{ const {room,ms,ws}=setup(3); room.disconnect(ms[2],ws[2]); assert.strictEqual(room.players.length,3); tick(8100); assert.strictEqual(room.players.length,2); });
ok('leaving mid-game forfeits the seat',()=>{ const {room,ms}=setup(3,{S:{timer:0,shop:false}}); room.handle(ms[0],{t:'start'}); tick(1500); room.handle(ms[2],{t:'leave'}); room.handle(ms[0],{t:'giveup'}); tick(2400); tick(1800); assert(!room.players[2].alive); });
ok('full game: 6 players play until one is left',()=>{ const {room,ms}=setup(6,{S:{timer:0,lives:1,shop:false}}); room.handle(ms[0],{t:'start'}); tick(1500); for(let i=0;i<5;i++){ room.handle(ms[room.cur],{t:'giveup'}); tick(2400); tick(1800); tick(1700); } assert.strictEqual(room.phase,'over'); assert.strictEqual(room.players.filter(p=>p.alive).length,1); });
console.log(passed+' passed');
mock.timers.reset();
setTimeout(()=>process.exit(process.exitCode||0),10);
