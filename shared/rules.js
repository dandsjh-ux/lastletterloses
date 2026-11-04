/* Last Letter Loses - rules shared by the browser (local mode) and the Node server (online mode).
   Works as a CommonJS module and as a plain <script> (window.LLLRules). */
(function(root,factory){
  if(typeof module==='object'&&module.exports) module.exports=factory();
  else root.LLLRules=factory();
})(typeof self!=='undefined'?self:this,function(){
'use strict';

const COLORS=[
  {n:'Blue',h:'#2f9bff'},{n:'Yellow',h:'#ffd028'},{n:'Pink',h:'#ff4fb8'},{n:'Green',h:'#3fe04a'},
  {n:'Orange',h:'#ff8a1f'},{n:'Purple',h:'#b55cff'},{n:'Red',h:'#ff4b4b'},{n:'Cyan',h:'#27e0d0'}];
const DEFAULTS={lives:3,startLen:36,shrink:3,minLen:14,timer:45,minWord:3,dict:true,resetUsed:false,preview:true,shop:true,pts:1};
const TIMER_CHOICES=[0,10,15,20,30,45,60,90];

/* ---------- settings ---------- */
function sanitizeSettings(s,base){
  const o=Object.assign({},DEFAULTS,base||{});
  if(!s||typeof s!=='object') return o;
  const int=(v,a,b,d)=>{ v=Math.round(+v); return Number.isFinite(v)?Math.max(a,Math.min(b,v)):d; };
  o.lives=int(s.lives,1,10,o.lives); o.startLen=int(s.startLen,16,60,o.startLen); o.shrink=int(s.shrink,0,8,o.shrink);
  o.minLen=int(s.minLen,8,30,o.minLen); if(o.minLen>o.startLen) o.minLen=o.startLen;
  o.timer=TIMER_CHOICES.includes(+s.timer)?+s.timer:o.timer; o.minWord=int(s.minWord,2,5,o.minWord);
  if('dict' in s) o.dict=!!s.dict; if('resetUsed' in s) o.resetUsed=!!s.resetUsed; if('shop' in s) o.shop=!!s.shop;
  if([0.5,1,2].includes(+s.pts)) o.pts=+s.pts;
  return o;
}
function cellsForRound(S,r){ return Math.max(Math.min(S.minLen,S.startLen),S.startLen-(r-1)*S.shrink); }

/* ---------- word forms: repeats, plurals, conjugations ---------- */
const IRREG=[
 ['be','am','is','are','was','were','been','being'],['have','has','had','having'],['do','does','did','done','doing'],
 ['go','goes','went','gone','going'],['say','says','said','saying'],['see','sees','saw','seen','seeing'],
 ['eat','eats','ate','eaten','eating'],['take','takes','took','taken','taking'],['give','gives','gave','given','giving'],
 ['run','runs','ran','running'],['swim','swims','swam','swum','swimming'],['sing','sings','sang','sung','singing'],
 ['drink','drinks','drank','drunk','drinking'],['write','writes','wrote','written','writing'],['come','comes','came','coming'],
 ['make','makes','made','making'],['get','gets','got','gotten','getting'],['know','knows','knew','known','knowing'],
 ['grow','grows','grew','grown','growing'],['throw','throws','threw','thrown','throwing'],['fly','flies','flew','flown','flying'],
 ['draw','draws','drew','drawn','drawing'],['buy','buys','bought','buying'],['bring','brings','brought','bringing'],
 ['think','thinks','thought','thinking'],['catch','catches','caught','catching'],['teach','teaches','taught','teaching'],
 ['fight','fights','fought','fighting'],['leave','leaves','left','leaving'],['feel','feels','felt','feeling'],
 ['keep','keeps','kept','keeping'],['sleep','sleeps','slept','sleeping'],['sweep','sweeps','swept','sweeping'],
 ['build','builds','built','building'],['send','sends','sent','sending'],['spend','spends','spent','spending'],
 ['lend','lends','lent','lending'],['bend','bends','bent','bending'],['lose','loses','lost','losing'],
 ['find','finds','found','finding'],['hold','holds','held','holding'],['tell','tells','told','telling'],
 ['sell','sells','sold','selling'],['stand','stands','stood','standing'],['understand','understands','understood'],
 ['sit','sits','sat','sitting'],['win','wins','won','winning'],['begin','begins','began','begun','beginning'],
 ['break','breaks','broke','broken','breaking'],['choose','chooses','chose','chosen','choosing'],
 ['speak','speaks','spoke','spoken','speaking'],['steal','steals','stole','stolen','stealing'],
 ['wake','wakes','woke','woken','waking'],['wear','wears','wore','worn','wearing'],['tear','tears','tore','torn','tearing'],
 ['drive','drives','drove','driven','driving'],['ride','rides','rode','ridden','riding'],['rise','rises','rose','risen','rising'],
 ['shake','shakes','shook','shaken','shaking'],['fall','falls','fell','fallen','falling'],
 ['forget','forgets','forgot','forgotten','forgetting'],['hide','hides','hid','hidden','hiding'],
 ['bite','bites','bit','bitten','biting'],['blow','blows','blew','blown','blowing'],['hear','hears','heard','hearing'],
 ['meet','meets','met','meeting'],['pay','pays','paid','paying'],['lay','lays','laid','laying'],['lead','leads','led','leading'],
 ['feed','feeds','fed','feeding'],['dig','digs','dug','digging'],['hang','hangs','hung','hanging'],
 ['swing','swings','swung','swinging'],['stick','sticks','stuck','sticking'],['strike','strikes','struck','striking'],
 ['shoot','shoots','shot','shooting'],['use','uses','used','using'],['die','dies','died','dying'],['lie','lies','lied','lying'],
 ['tie','ties','tied','tying'],['child','children'],['man','men'],['woman','women'],['mouse','mice'],['foot','feet'],
 ['tooth','teeth'],['goose','geese'],['person','people'],['ox','oxen'],['fish','fishes'],['sheep']
];

const IRREG_MAP=new Map();
IRREG.forEach(g=>g.forEach(w=>IRREG_MAP.set(w,'~'+g[0])));
const CVC=/[^aeiou][aeiou][^aeiouwxy]$/;

/* Every "base form" a word could have. Two words clash when their sets overlap.
   `has(w)` says whether w is a real word (pass null when there is no dictionary). */
function candidates(w,has){
  const inDict=x=>!has||has(x);
  const set=new Set([w]);
  if(IRREG_MAP.has(w)) set.add(IRREG_MAP.get(w));
  const L=w.length, ends=s=>w.endsWith(s);
  const derived=[];
  if(ends('ies') && L>4){ derived.push(w.slice(0,-3)+'y'); derived.push(w.slice(0,-1)); }
  else if(ends('ves') && L>4){ derived.push(w.slice(0,-3)+'f'); derived.push(w.slice(0,-3)+'fe'); derived.push(w.slice(0,-1)); }
  else if(ends('es') && L>3){
    const st=w.slice(0,-2); if(/(s|x|z|ch|sh|o)$/.test(st)) derived.push(st);
    derived.push(w.slice(0,-1));
  } else if(ends('s') && !ends('ss') && !ends('us') && !ends('is') && L>3) derived.push(w.slice(0,-1));
  if(ends('ied') && L>=5) derived.push(w.slice(0,-3)+'y');
  else if(ends('ed') && L>=5){
    const st=w.slice(0,-2);
    if(st.length>3 && st[st.length-1]===st[st.length-2] && !/[lsfz]$/.test(st)) derived.push(st.slice(0,-1));
    else { derived.push(st); derived.push(st+'e'); }
  }
  if(ends('ing') && L>5){
    const st=w.slice(0,-3);
    if(st.length>3 && st[st.length-1]===st[st.length-2] && !/[lsfz]$/.test(st)) derived.push(st.slice(0,-1));
    else { derived.push(st); derived.push(st+'e'); }
  }
  let keep=derived.filter(d=>d.length>=3 && inDict(d));
  if(keep.length>1 && has){
    keep=keep.filter(d=>!(CVC.test(d) && d.length<=4 && keep.indexOf(d+'e')>=0));
  }
  keep.forEach(d=>set.add(d));
  return set;
}
/* `cand` is a function word -> Set of base forms (usually w=>candidates(w,has)) */
function makeUsed(cand){
  return {
    list:[], map:new Map(),
    clear(){ this.list=[]; this.map.clear(); },
    add(word,pi,round){ this.list.push({word,pi,round}); cand(word).forEach(c=>{ if(!this.map.has(c)) this.map.set(c,word); }); },
    conflict(word){ const cs=cand(word); for(const c of cs){ const u=this.map.get(c); if(u) return u; } return null; }
  };
}

/* Check what a player typed. o = {lead, minWord, used, dictHas (fn or null), override}.
   `raw` is the part typed after the shared first letter `lead`. */
function validateWord(raw,o){
  if(!raw) return {ok:false,msg:'Type a word first!'};
  if(!/^[a-z]+$/.test(raw)) return {ok:false,msg:'Letters only, please (a–z).'};
  const lead=o.lead||'';
  const full=lead+raw;
  if(full.length<o.minWord) return {ok:false,msg:'Words need at least '+o.minWord+' letters'+(lead?' (including the '+lead.toUpperCase()+')':'')+'.'};
  const u=o.used.conflict(full);
  if(u===full) return {ok:false,msg:'“'+full+'” has already been used!'};
  if(u && !o.override) return {ok:false,msg:'“'+full+'” is a form of the used word “'+u+'”.',canOverride:true};
  if(o.dictHas && !o.override && !o.dictHas(full)) return {ok:false,msg:'“'+full+'” isn’t in the dictionary. Check the spelling!',canOverride:true};
  return {ok:true,word:full};
}

/* Dictionary file format: front-coded lines (1 char = shared prefix length + 48, then the rest). */
function decodeFrontCoded(text){
  const set=new Set(); let prev='';
  const lines=text.split('\n');
  for(let i=0;i<lines.length;i++){
    const ln=lines[i]; if(!ln) continue;
    const n=ln.charCodeAt(0)-48; const w=prev.slice(0,n)+ln.slice(1); set.add(w); prev=w;
  }
  return set;
}

/* ---------- points & power-ups ---------- */
const SHRINK_W=0.6, JINX_W=1.4, PITY=8, EXTEND_BY=10, TIME_BY=10, SHOP_SECONDS=90;
const ITEMS=[
 {id:'time',  icon:'⏱️',name:'Extra Time',   kind:'now',    price:8,  max:3,desc:'+10 seconds on the clock for your turn.',needsTimer:true},
 {id:'shrink',icon:'🤏',name:'Shrink',       kind:'arm',    price:12, max:3,desc:'Your next word is written in skinny letters that take up 40% less space.'},
 {id:'double',icon:'✨',name:'Double Points',kind:'arm',    price:15, max:2,desc:'Your next word scores twice as many points.'},
 {id:'jinx',  icon:'😈',name:'Jinx',         kind:'arm',    price:22, max:2,desc:'The next player’s letters are extra wide (40% more space).'},
 {id:'extend',icon:'📏',name:'Extend',       kind:'now',    price:26, max:2,desc:'Add 10 more spaces to the bar for the rest of the round.'},
 {id:'shield',icon:'🛡️',name:'Shield',       kind:'passive',price:40, max:1,desc:'Blocks the next explosion that would cost you a heart.'},
 {id:'heart', icon:'💖',name:'Extra Heart',  kind:'heal',   price:60, max:0,desc:'Win back one lost heart.'},
 {id:'swap',  icon:'🔄',name:'Swap',         kind:'now',    price:90, max:1,desc:'Pass the bomb: your turn goes to the next player. Very powerful!'}
];
const ITEM={}; ITEMS.forEach(i=>ITEM[i.id]=i);
/* 3 letters = 1 point, then it doubles with every extra letter */
function wordPoints(n){ return n<3?1:Math.pow(2,Math.min(n,14)-3); }
function awardFor(S,n,dbl){ return Math.max(1,Math.round(wordPoints(n)*(dbl?2:1)*S.pts)); }
function turnScale(jinxed,shrunk){ return (jinxed?JINX_W:1)*(shrunk?SHRINK_W:1); }
function canBuy(S,p,it){
  if(it.kind==='heal') return p.lives>=p.max?{ok:false,why:'Hearts full'}:p.pts<it.price?{ok:false,why:'Need ⭐ '+(it.price-p.pts)+' more'}:{ok:true};
  if(it.needsTimer&&!S.timer) return {ok:false,why:'Timer is off'};
  if((p.inv[it.id]||0)>=it.max) return {ok:false,why:'Max held'};
  if(p.pts<it.price) return {ok:false,why:'Need ⭐ '+(it.price-p.pts)+' more'};
  return {ok:true};
}

/* ---------- glyph widths (measured from the embedded font) ---------- */
/* The bar's cells are evenly spaced, but each letter's ink is its real width. Only the very widest letters (m, w)
   reach the touch line when they sit in the last cell. */
const GLYPH_W={"a":0.6172,"b":0.6172,"c":0.5781,"d":0.6172,"e":0.5938,"f":0.3828,"g":0.6172,"h":0.5859,"i":0.2656,"j":0.3359,"k":0.5859,"l":0.2422,"m":0.9375,"n":0.5859,"o":0.6094,"p":0.6172,"q":0.6172,"r":0.3984,"s":0.5234,"t":0.4063,"u":0.5938,"v":0.6328,"w":0.8672,"x":0.6094,"y":0.6641,"z":0.4766};
const TOUCH_W=0.7617;
function glyphWidth(ch){ return GLYPH_W[ch]||0.6; }
/* A letter in a cell starting at x0 and cw units wide (cw<1 shrunk, cw>1 wide) hits the bomb when its ink crosses the touch line. */
function touchesAt(ch,x0,cw,cells){ return x0+cw/2+glyphWidth(ch)*cw/2 >= cells-0.5+TOUCH_W/2-1e-9; }

return {COLORS,DEFAULTS,TIMER_CHOICES,sanitizeSettings,cellsForRound,IRREG,candidates,makeUsed,validateWord,decodeFrontCoded,
  SHRINK_W,JINX_W,PITY,EXTEND_BY,TIME_BY,SHOP_SECONDS,ITEMS,ITEM,wordPoints,awardFor,turnScale,canBuy,GLYPH_W,TOUCH_W,glyphWidth,touchesAt};
});
