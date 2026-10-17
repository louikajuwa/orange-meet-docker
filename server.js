const express = require("express");
const http = require("http");
const https = require("https");
const { URL } = require("url");
const zlib = require("zlib");
const { Server } = require("socket.io");
const crypto = require("crypto");

const app = express();

if (process.env.NODE_ENV !== "production") {
  const livereload = require("livereload");
  const connectLR = require("connect-livereload");
  const lrServer = livereload.createServer({ exts: ["html", "css", "js"], delay: 150 });
  lrServer.watch(__dirname + "/public");
  app.use(connectLR());
}

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

const MAX_ROOMS = 10;
const MAX_MEMBERS = 2;
const CREATE_PASSWORD = "REMOVED";

app.use(express.static(__dirname + "/public"));

// ==============================================================
//  PROXY — /api/proxy?url=...
//  Strips X-Frame-Options / CSP so external sites load in iframe
//  Route is /api/proxy so Nginx can forward /api/* to Node.js
// ==============================================================
app.options("/api/proxy", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.sendStatus(204);
});

app.get("/api/proxy", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");

  const target = req.query.url;
  if (!target) return res.status(400).send("Missing ?url=");

  let parsed;
  try { parsed = new URL(target); } catch { return res.status(400).send("Invalid URL"); }

  const client = parsed.protocol === "https:" ? https : http;

  const proxyReq = client.get(target, {
    headers: {
      "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
      "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8",
      "Accept-Language": "en-US,en;q=0.5",
      "Accept-Encoding": "gzip, deflate",
      "Referer": parsed.origin + "/",
    },
    timeout: 15000,
  }, (upstream) => {
    // Follow redirects
    if ([301, 302, 307, 308].includes(upstream.statusCode) && upstream.headers.location) {
      let loc = upstream.headers.location;
      if (loc.startsWith("/")) loc = parsed.origin + loc;
      else if (loc.startsWith("//")) loc = parsed.protocol + loc;
      return res.redirect("/api/proxy?url=" + encodeURIComponent(loc));
    }

    // Strip frame-blocking headers
    const blocked = new Set([
      "x-frame-options", "content-security-policy",
      "content-security-policy-report-only", "set-cookie",
      "content-length", "content-encoding", "transfer-encoding",
    ]);
    for (const [key, val] of Object.entries(upstream.headers)) {
      if (!blocked.has(key.toLowerCase())) {
        try { res.setHeader(key, val); } catch {}
      }
    }

    const ct = (upstream.headers["content-type"] || "").toLowerCase();
    const isHtml = ct.includes("text/html");

    if (!isHtml) {
      const enc = (upstream.headers["content-encoding"] || "").toLowerCase();
      res.status(upstream.statusCode);
      if (enc === "gzip") upstream.pipe(zlib.createGunzip()).pipe(res);
      else if (enc === "deflate") upstream.pipe(zlib.createInflate()).pipe(res);
      else upstream.pipe(res);
      return;
    }

    // HTML — decompress, inject <base> + click interceptor
    const chunks = [];
    const enc = (upstream.headers["content-encoding"] || "").toLowerCase();
    let stream = upstream;
    if (enc === "gzip") stream = upstream.pipe(zlib.createGunzip());
    else if (enc === "deflate") stream = upstream.pipe(zlib.createInflate());

    stream.on("data", (c) => chunks.push(c));
    stream.on("error", () => res.status(502).send("Decompression error"));
    stream.on("end", () => {
      let html = Buffer.concat(chunks).toString("utf-8");
      const origin = parsed.origin;

      const baseTag = `<base href="${origin}${parsed.pathname.replace(/\/[^/]*$/, '/')}">`;
      if (/<head[^>]*>/i.test(html)) html = html.replace(/<head[^>]*>/i, "$&" + baseTag);
      else html = baseTag + html;

      const interceptScript = `
<script>
(function(){
  var PX='/api/proxy?url=';
  var O='${origin}';
  function px(h){
    if(!h||h.startsWith('javascript:')||h.startsWith('#')||h.startsWith('data:')||h.startsWith('blob:'))return h;
    if(h.includes('/api/proxy?url='))return h;
    try{var u=new URL(h,O);return PX+encodeURIComponent(u.href)}catch(e){return h}
  }
  // --- Link click interception ---
  document.addEventListener('click',function(e){
    var a=e.target.closest('a');if(!a||!a.href)return;
    var hr=a.getAttribute('href');
    if(!hr||hr.startsWith('#')||hr.startsWith('javascript:'))return;
    e.preventDefault();e.stopPropagation();
    try{window.parent.postMessage({type:'proxy-navigate',url:a.href},'*')}catch(ex){}
    window.location.href=px(a.href);
  },true);
  document.addEventListener('submit',function(e){
    var f=e.target;if(f.method&&f.method.toLowerCase()==='post')return;
    var act=f.action||window.location.href;e.preventDefault();
    var p=new URLSearchParams(new FormData(f)).toString();
    var u=act+(act.includes('?')?'&':'?')+p;
    window.location.href=px(u);
  },true);
  var oo=window.open;
  window.open=function(u){if(u){window.location.href=px(u);return window}return oo.apply(this,arguments)};

  // --- Scroll sync: send scroll position to parent ---
  var _scrollTimer=null;
  var _ignoreScroll=false;
  window.addEventListener('scroll',function(){
    if(_ignoreScroll)return;
    clearTimeout(_scrollTimer);
    _scrollTimer=setTimeout(function(){
      try{
        var sx=window.scrollX||window.pageXOffset||0;
        var sy=window.scrollY||window.pageYOffset||0;
        var mh=Math.max(document.body.scrollHeight,document.documentElement.scrollHeight,1);
        var mw=Math.max(document.body.scrollWidth,document.documentElement.scrollWidth,1);
        window.parent.postMessage({
          type:'proxy-scroll',
          scrollX:sx,scrollY:sy,
          ratioX:sx/mw,ratioY:sy/mh,
          maxW:mw,maxH:mh
        },'*');
      }catch(ex){}
    },80);
  },true);

  // --- Receive scroll from parent (other user) ---
  window.addEventListener('message',function(e){
    if(!e.data)return;
    if(e.data.type==='set-scroll'){
      _ignoreScroll=true;
      var mh=Math.max(document.body.scrollHeight,document.documentElement.scrollHeight,1);
      var mw=Math.max(document.body.scrollWidth,document.documentElement.scrollWidth,1);
      var sx=e.data.ratioX*mw;
      var sy=e.data.ratioY*mh;
      window.scrollTo(sx,sy);
      setTimeout(function(){_ignoreScroll=false},200);
    }
    if(e.data.type==='set-video-state'){
      var vids=document.querySelectorAll('video');
      vids.forEach(function(v){
        if(v.duration>1){
          if(Math.abs(v.currentTime-e.data.currentTime)>2)v.currentTime=e.data.currentTime;
          if(e.data.paused&&!v.paused)v.pause();
          if(!e.data.paused&&v.paused)v.play().catch(function(){});
        }
      });
    }
  });

  // --- Video player sync: detect play/pause/seek on <video> elements ---
  function hookVideos(){
    var vids=document.querySelectorAll('video');
    vids.forEach(function(v){
      if(v._watchHooked)return;
      v._watchHooked=true;
      var send=function(evt){
        try{
          window.parent.postMessage({
            type:'proxy-video-state',
            currentTime:v.currentTime,
            paused:v.paused,
            event:evt
          },'*');
        }catch(ex){}
      };
      v.addEventListener('play',function(){send('play')});
      v.addEventListener('pause',function(){send('pause')});
      v.addEventListener('seeked',function(){send('seeked')});
      // Periodic time sync every 5 seconds during playback
      setInterval(function(){
        if(!v.paused&&v.duration>1)send('timeupdate');
      },5000);
    });
  }
  // Hook existing and future video elements
  hookVideos();
  var obs=new MutationObserver(function(){hookVideos()});
  obs.observe(document.body||document.documentElement,{childList:true,subtree:true});
})();
</script>`;
      if (/<\/body>/i.test(html)) html = html.replace(/<\/body>/i, interceptScript + "$&");
      else html += interceptScript;

      res.status(upstream.statusCode).type("text/html").send(html);
    });
  });

  proxyReq.on("error", (err) => {
    console.error("Proxy error:", err.message);
    res.status(502).send("Could not load page: " + err.message);
  });
  proxyReq.on("timeout", () => { proxyReq.destroy(); res.status(504).send("Timeout"); });
});

// Simple health check endpoint Nginx can test
app.get("/api/health", (req, res) => res.json({ ok: true }));

// ==============================================================
//  SOCKET.IO — rooms, signaling, watch-together, reconnect
// ==============================================================
let rooms = {};
const sessions = {}; // token -> { socketId, oldSocketId, room }

io.on("connection", (socket) => {
  console.log("✅ Connected:", socket.id);

  // --- Reconnect ---
  socket.on("reconnect-session", ({ token, room }) => {
    if (!token || !room || !rooms[room]) return socket.emit("reconnect-failed");
    const sess = sessions[token];
    if (!sess || sess.room !== room) return socket.emit("reconnect-failed");
    const rd = rooms[room];
    const previousId = sess.oldSocketId;

    // Tell other room members the old socket id is gone so they clean up
    // the stale peer connection + tile. Without this, they end up with two
    // tiles for the same person after the new id joins.
    if (previousId && previousId !== socket.id && rd.members.includes(previousId)) {
      socket.to(room).emit("user-left", previousId);
    }

    rd.members = rd.members.filter(id => id !== previousId);
    if (rd.owner === previousId) rd.owner = socket.id;
    if (rd.members.length >= MAX_MEMBERS) return socket.emit("reconnect-failed");

    // Update session bookkeeping for any future reconnect cycle
    sess.socketId = socket.id;
    sess.oldSocketId = socket.id;

    addMember(socket, room);
    socket.emit("reconnect-ok", { room, isOwner: rd.owner === socket.id });
    console.log(`🔄 ${socket.id} reconnected to ${room} (was ${previousId})`);
  });

  // --- Create Room ---
  socket.on("create-room", ({ room, password }) => {
    if (password !== CREATE_PASSWORD) return socket.emit("create-error", "Wrong password.");
    if (rooms[room]) return socket.emit("create-error", "Room already exists!");
    if (Object.keys(rooms).length >= MAX_ROOMS)
      return socket.emit("create-error", `Room limit reached (${MAX_ROOMS} max).`);
    rooms[room] = { owner: socket.id, members: [], pending: [], youtube: null };
    io.emit("update-rooms");
    socket.emit("auto-join", room);
  });

  socket.on("list-rooms", () => {
    socket.emit("room-list", Object.entries(rooms).map(([n, d]) => ({ name: n, count: d.members.length })));
  });

  // --- Join ---
  socket.on("join", (room) => {
    if (!rooms[room]) return socket.emit("room-error", "Room does not exist.");
    const rd = rooms[room];
    if (rd.owner === socket.id) return addMember(socket, room);
    if (rd.members.length >= MAX_MEMBERS) return socket.emit("room-full", room);
    if (rd.members.includes(socket.id)) return;
    if (!rd.pending.includes(socket.id)) rd.pending.push(socket.id);
    socket.data.pendingRoom = room;
    socket.emit("waiting-approval", room);
    io.to(rd.owner).emit("join-request", { room, userId: socket.id });
  });

  socket.on("accept-user", ({ room, userId }) => {
    if (!rooms[room] || rooms[room].owner !== socket.id) return;
    const rd = rooms[room];
    rd.pending = rd.pending.filter(id => id !== userId);
    if (rd.members.length >= MAX_MEMBERS) return io.to(userId).emit("room-full", room);
    const ts = io.sockets.sockets.get(userId);
    if (ts) { io.to(userId).emit("join-accepted", room); addMember(ts, room); }
  });
  socket.on("reject-user", ({ room, userId }) => {
    if (!rooms[room] || rooms[room].owner !== socket.id) return;
    rooms[room].pending = rooms[room].pending.filter(id => id !== userId);
    io.to(userId).emit("join-rejected", room);
  });
  socket.on("kick-user", ({ room, userId }) => {
    if (!rooms[room] || rooms[room].owner !== socket.id) return;
    const ts = io.sockets.sockets.get(userId);
    if (ts) { io.to(userId).emit("kicked", room); removeMember(ts, room); }
  });

  // --- YouTube ---
  socket.on("share-youtube", ({ room, videoId }) => {
    if (!room || !rooms[room]) return;
    rooms[room].youtube = { videoId, currentTime: 0, action: "play", updatedAt: Date.now() };
    io.to(room).emit("youtube-shared", { videoId });
  });
  socket.on("close-youtube", (room) => {
    if (!room || !rooms[room]) return;
    rooms[room].youtube = null; io.to(room).emit("youtube-closed");
  });

  // YouTube playback sync — relay play/pause/seek to other room members.
  // Payload: { room, action: "play"|"pause"|"seek", currentTime, sentAt }
  socket.on("youtube-state", (data) => {
    if (!data || !data.room || !rooms[data.room]) return;
    const rd = rooms[data.room];
    if (rd.youtube && typeof rd.youtube === "object") {
      rd.youtube.currentTime = data.currentTime;
      rd.youtube.updatedAt = Date.now();
      // "seek" is not a play/pause state — only update action for play/pause
      // so reconnecting users always receive a valid autoplay/pause instruction.
      if (data.action === "play" || data.action === "pause") {
        rd.youtube.action = data.action;
      }
    }
    socket.to(data.room).emit("youtube-state", {
      action: data.action,
      currentTime: data.currentTime,
      sentAt: data.sentAt,
      from: socket.id,
    });
  });

  // Late-joiner catch-up — directed at a single socket id.
  // Payload: { to, action, currentTime, sentAt }
  socket.on("youtube-state-to", ({ to, action, currentTime, sentAt }) => {
    if (!to) return;
    io.to(to).emit("youtube-state-to", {
      action, currentTime, sentAt, from: socket.id,
    });
  });

  // --- Watch Together (Screen Share signaling) ---
  // Track the active sharer per room so we can notify viewers when the sharer
  // disconnects abruptly (tab close, network loss) without a deliberate ss-stop.
  socket.on("ss-start", (data) => {
    const room = socket.data.room;
    if (!room) return;
    if (rooms[room]) rooms[room].sharer = socket.id;
    socket.to(room).emit("ss-start", data);
  });
  socket.on("ss-stop", (data) => {
    const room = socket.data.room;
    if (!room) return;
    if (rooms[room] && rooms[room].sharer === socket.id) rooms[room].sharer = null;
    socket.to(room).emit("ss-stop", data);
  });
  socket.on("ss-offer", ({ to, sdp }) => {
    io.to(to).emit("ss-offer", { from: socket.id, sdp });
  });
  socket.on("ss-answer", ({ to, sdp }) => {
    io.to(to).emit("ss-answer", { from: socket.id, sdp });
  });
  socket.on("ss-ice", ({ to, candidate }) => {
    io.to(to).emit("ss-ice", { from: socket.id, candidate });
  });

  // --- Signaling ---
  // Toggle events relay to the room by default. If `to` is provided, send only
  // to that socket (used to catch up newly joined participants).
  socket.on("toggle-video", (data) => {
    const payload = { id: socket.id, hidden: !!(data && data.hidden) };
    if (data && data.to) io.to(data.to).emit("user-video-toggle", payload);
    else { const r = socket.data.room; if (r) socket.to(r).emit("user-video-toggle", payload); }
  });
  socket.on("toggle-audio", (data) => {
    const payload = { id: socket.id, muted: !!(data && data.muted) };
    if (data && data.to) io.to(data.to).emit("user-audio-toggle", payload);
    else { const r = socket.data.room; if (r) socket.to(r).emit("user-audio-toggle", payload); }
  });
  socket.on("offer", ({ to, sdp }) => io.to(to).emit("offer", { from: socket.id, sdp }));
  socket.on("answer", ({ to, sdp }) => io.to(to).emit("answer", { from: socket.id, sdp }));
  socket.on("ice-candidate", ({ to, candidate }) => io.to(to).emit("ice-candidate", { from: socket.id, candidate }));

  socket.on("leave", (room) => removeMember(socket, room || socket.data.room));
  socket.on("cancel-join", (room) => {
    if (!rooms[room]) return;
    rooms[room].pending = rooms[room].pending.filter(id => id !== socket.id);
    delete socket.data.pendingRoom;
  });

  socket.on("disconnect", () => {
    const room = socket.data.room;
    const sid = socket.id;
    // Grace period for reconnects
    setTimeout(() => {
      let reconnected = false;
      for (const [, s] of Object.entries(sessions)) {
        if (s.oldSocketId === sid && s.socketId !== sid) { reconnected = true; break; }
      }
      if (!reconnected && room && rooms[room] && rooms[room].members.includes(sid)) {
        removeMember(socket, room);
      }
    }, 15000);
    for (const [, rd] of Object.entries(rooms)) rd.pending = rd.pending.filter(id => id !== socket.id);
    console.log(`⚠️ ${socket.id} disconnected (15s grace)`);
  });

  function addMember(sock, room) {
    if (!rooms[room]) return;
    const rd = rooms[room];
    if (!rd.members.includes(sock.id)) rd.members.push(sock.id);
    sock.join(room); sock.data.room = room; delete sock.data.pendingRoom;
    sock.emit("users", rd.members.filter(id => id !== sock.id));
    sock.to(room).emit("user-joined", sock.id);
    io.to(room).emit("room-count", rd.members.length);
    io.to(room).emit("member-list", {
      members: rd.members.map(id => ({ id, isOwner: id === rd.owner })),
      ownerId: rd.owner,
    });
    if (rd.youtube) {
      const yt = rd.youtube;
      let currentTime = yt.currentTime;
      if (yt.action === "play") currentTime += (Date.now() - yt.updatedAt) / 1000;
      sock.emit("youtube-shared", { videoId: yt.videoId, currentTime, action: yt.action });
    }
    // Screen share state is handled client-side via user-joined event
    // Session token
    const token = crypto.randomBytes(16).toString("hex");
    sessions[token] = { socketId: sock.id, oldSocketId: sock.id, room };
    sock.emit("session-token", { token, room });
    setTimeout(() => { delete sessions[token]; }, 3600000);
    io.emit("update-rooms");
  }

  function removeMember(sock, room) {
    if (!room || !rooms[room]) return;
    const rd = rooms[room];
    if (!rd.members.includes(sock.id)) return;
    rd.members = rd.members.filter(id => id !== sock.id);
    // If the departing member was actively sharing their screen, notify viewers
    // so they can tear down the dead RTCPeerConnection and clear the frozen
    // frame. Covers tab close, network loss, kick, and explicit leave.
    if (rd.sharer === sock.id) {
      rd.sharer = null;
      sock.to(room).emit("ss-stop", {});
    }
    sock.leave(room); sock.to(room).emit("user-left", sock.id);
    if (rd.members.length > 0) {
      io.to(room).emit("room-count", rd.members.length);
      io.to(room).emit("member-list", {
        members: rd.members.map(id => ({ id, isOwner: id === rd.owner })),
        ownerId: rd.owner,
      });
    }
    if (sock.data.room === room) delete sock.data.room;
    if (rd.members.length === 0) {
      rd.pending.forEach(pid => io.to(pid).emit("join-rejected", room));
      delete rooms[room];
    }
    io.emit("update-rooms");
  }
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => console.log(`🚀 Orange Meet on :${PORT}`));