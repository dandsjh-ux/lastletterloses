'use strict';
/* Last Letter Loses - web server (static files + WebSocket game rooms). Only dependency: ws. */
const http=require('http'), fs=require('fs'), path=require('path'), zlib=require('zlib');
const { WebSocketServer }=require('ws');
const R=require('./shared/rules');
const { Rooms }=require('./server/engine');

const PORT=process.env.PORT||3000;
const PUBLIC=path.join(__dirname,'public');

/* ---------- dictionary (same ENABLE word list the browser uses) ---------- */
function loadDictionary(){
  const b64=fs.readFileSync(path.join(__dirname,'assets','dict.b64'),'utf8').trim();
  const text=zlib.gunzipSync(Buffer.from(b64,'base64')).toString('utf8');
  return R.decodeFrontCoded(text);
}
const dict=loadDictionary();
console.log('dictionary loaded:',dict.size,'words');
const rooms=new Rooms(dict);

/* ---------- static files ---------- */
const MIME={'.html':'text/html; charset=utf-8','.js':'application/javascript; charset=utf-8','.css':'text/css; charset=utf-8','.png':'image/png','.svg':'image/svg+xml','.ico':'image/x-icon','.json':'application/json','.woff':'font/woff','.woff2':'font/woff2','.txt':'text/plain; charset=utf-8'};
const cache=new Map();
function sendFile(req,res,file){
  fs.stat(file,(err,st)=>{
    if(err||!st.isFile()){ res.writeHead(404,{'content-type':'text/plain'}); return res.end('Not found'); }
    const ext=path.extname(file).toLowerCase(); const type=MIME[ext]||'application/octet-stream';
    const key=file+':'+st.mtimeMs;
    let ent=cache.get(key);
    const send=(e)=>{
      const h={'content-type':type,'cache-control':ext==='.html'?'no-cache':'public, max-age=3600','x-content-type-options':'nosniff'};
      const ae=String(req.headers['accept-encoding']||'');
      if(e.gz&&/\bgzip\b/.test(ae)){ h['content-encoding']='gzip'; h['vary']='accept-encoding'; res.writeHead(200,h); res.end(req.method==='HEAD'?undefined:e.gz); }
      else { res.writeHead(200,h); res.end(req.method==='HEAD'?undefined:e.raw); }
    };
    if(ent) return send(ent);
    fs.readFile(file,(e2,raw)=>{
      if(e2){ res.writeHead(500); return res.end('Error'); }
      ent={raw:raw,gz:/^\.(html|js|css|svg|json|txt)$/.test(ext)?zlib.gzipSync(raw,{level:9}):null};
      cache.clear(); cache.set(key,ent); send(ent);
    });
  });
}
const server=http.createServer((req,res)=>{
  let url; try{ url=new URL(req.url,'http://x'); }catch(e){ res.writeHead(400); return res.end(); }
  if(req.method!=='GET'&&req.method!=='HEAD'){ res.writeHead(405); return res.end(); }
  if(url.pathname==='/healthz'){ res.writeHead(200,{'content-type':'application/json'}); return res.end(JSON.stringify(Object.assign({ok:true},rooms.stats()))); }
  let p=decodeURIComponent(url.pathname); if(p.endsWith('/')) p+='index.html';
  const file=path.normalize(path.join(PUBLIC,p));
  if(!file.startsWith(PUBLIC+path.sep)){ res.writeHead(403); return res.end(); }
  sendFile(req,res,file);
});

/* ---------- websockets ---------- */
const wss=new WebSocketServer({noServer:true,maxPayload:8*1024});
server.on('upgrade',(req,socket,head)=>{
  let url; try{ url=new URL(req.url,'http://x'); }catch(e){ return socket.destroy(); }
  if(url.pathname!=='/ws') return socket.destroy();
  wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws,req));
});
function heartbeat(){ this.isAlive=true; }
wss.on('connection',(ws,req)=>{
  ws.isAlive=true; ws.on('pong',heartbeat);
  let room=null, member=null, msgCount=0, windowStart=Date.now();
  const err=(code,msg)=>{ try{ ws.send(JSON.stringify({t:'err',code:code,msg:msg})); }catch(e){} };
  ws.on('message',(data)=>{
    const now=Date.now(); if(now-windowStart>1000){ windowStart=now; msgCount=0; } if(++msgCount>40) return;   // flood guard
    let msg; try{ msg=JSON.parse(data.toString()); }catch(e){ return; }
    if(!msg||typeof msg.t!=='string') return;
    if(msg.t==='ping'){ try{ ws.send('{"t":"pong"}'); }catch(e){} return; }
    if(!room){
      if(msg.t==='create'){
        const r=rooms.create(); if(!r) return err('busy','The server is busy, try again in a moment.');
        const res=r.join(ws,{name:msg.name,color:msg.color,spectate:!!msg.spectate});
        if(res.error) return err(res.error,res.msg);
        room=r; member=res;
      } else if(msg.t==='join'||msg.t==='rejoin'){
        const r=rooms.get(msg.code); if(!r) return err('noroom','No room with that code. Check it and try again.');
        const res=r.join(ws,{name:msg.name,color:msg.color,token:msg.token,spectate:!!msg.spectate});
        if(res.error) return err(res.error,res.msg);
        room=r; member=res;
      }
      return;
    }
    try{ room.handle(member,msg); }catch(e){ console.error('handler error',e); }
  });
  ws.on('close',()=>{ if(room&&member) room.disconnect(member,ws); });
  ws.on('error',()=>{});
});
setInterval(()=>{ wss.clients.forEach(ws=>{ if(ws.isAlive===false) return ws.terminate(); ws.isAlive=false; try{ ws.ping(); }catch(e){} }); },25000).unref();

server.listen(PORT,'0.0.0.0',()=>console.log('Last Letter Loses listening on',PORT));
function shutdown(){ console.log('shutting down'); wss.clients.forEach(c=>{ try{ c.close(1001,'server restarting'); }catch(e){} }); server.close(()=>process.exit(0)); setTimeout(()=>process.exit(0),3000).unref(); }
process.on('SIGTERM',shutdown); process.on('SIGINT',shutdown);
