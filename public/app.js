$(document).ready(function(){
  // Connect to whatever host served this page — portable across dev, Docker,
  // and prod-behind-nginx. Override at runtime with window.OM_SERVER if needed.
  const SERVER = window.OM_SERVER || window.location.origin;
  const socket=io(SERVER,{reconnection:true,reconnectionAttempts:Infinity,reconnectionDelay:1000,reconnectionDelayMax:10000,timeout:20000});
  const localVideo=$("#localVideo")[0];
  let localStream=null,roomName=null,isOwner=false,currentMembers=[];
  const pcs={},config={iceServers:[{urls:"stun:stun.l.google.com:19302"}]};
  let audioMuted=false,videoHidden=false,pendingRoomName=null;
  let sessionToken=null;

  function saveSession(){if(roomName&&sessionToken)try{sessionStorage.setItem("om_session",JSON.stringify({token:sessionToken,room:roomName}))}catch(e){}}
  function loadSession(){try{const r=sessionStorage.getItem("om_session");return r?JSON.parse(r):null}catch(e){return null}}
  function clearSession(){try{sessionStorage.removeItem("om_session")}catch(e){}sessionToken=null}

  $("#hamburgerBtn").click(()=>$("#sidebar").addClass("open"));
  $("#sidebarClose").click(()=>$("#sidebar").removeClass("open"));
  function closeSidebar(){$("#sidebar").removeClass("open")}

  // ---- VIEWS ----
  function showView(v){
    $("#lobbyView,#waitingView").hide();
    $("#videoArea").removeClass("is-active");
    $("#controlBar").removeClass("visible");
    $("#shareLinkBtn").hide();
    $("#topbarBadge").hide();
    if(v==="lobby"){
      $("#lobbyView").show();$("#topbarTitle").text("Orange Meet");$("#createSection").show();
      cleanupScreenShare();closeYoutube();
    }else if(v==="waiting"){
      $("#waitingView").show();$("#topbarTitle").text("Joining…");$("#createSection").hide();
    }else if(v==="call"){
      $("#videoArea").addClass("is-active");
      $("#controlBar").addClass("visible");
      $("#topbarTitle").text(roomName||"In Call");
      $("#shareLinkBtn").show();
      $("#createSection").hide();
      updateVideoLayout();
    }
  }

  // Single source of truth for video layout (was duplicated as updateVideoGrid)
  // Cross-fades content area when entering/leaving theater (focus) mode.
  function updateVideoLayout(){
    const mediaActive = watchIsOpen || $("#youtubeArea").hasClass("active");
    const tileCount = $("#videoArea .video-wrap").length;
    const $main = $(".main");
    const wasFocus = $main.hasClass("focus-mode");
    const willFocus = !!mediaActive;
    const modeChanged = wasFocus !== willFocus;

    const apply = ()=>{
      $main.toggleClass("focus-mode", willFocus);
      if(willFocus){
        $("#videoArea").addClass("has-media").removeClass("two-videos");
      } else {
        $("#videoArea").removeClass("has-media").toggleClass("two-videos", tileCount > 1);
      }
    };

    if(modeChanged){
      const $ca = $(".content-area");
      $ca.addClass("is-switching");
      // Wait for fade-out, swap layout, fade back in
      setTimeout(()=>{
        apply();
        // Force reflow then drop the class on the next frame so the fade-in plays
        requestAnimationFrame(()=> requestAnimationFrame(()=> $ca.removeClass("is-switching")));
      }, 200);
    } else {
      apply();
    }
  }

  // ---- RECONNECT ----
  socket.on("disconnect",()=>{if(roomName)$("#reconnectBanner").addClass("active")});
  socket.on("connect",()=>{
    $("#reconnectBanner").removeClass("active");
    socket.emit("list-rooms");
    const saved=loadSession();
    if(saved&&saved.token&&saved.room&&!roomName){
      roomName=saved.room;
      startLocalStream().then(()=>socket.emit("reconnect-session",{token:saved.token,room:saved.room}));
    }else if(roomName){
      startLocalStream().then(()=>socket.emit("join",roomName));
    }else{checkUrlRoom()}
  });
  socket.on("reconnect-ok",({room,isOwner:o})=>{roomName=room;isOwner=o;showView("call");showInfoToast("Reconnected","Back in \""+room+"\"")});
  socket.on("reconnect-failed",()=>{clearSession();roomName=null;isOwner=false;showView("lobby")});
  socket.on("session-token",({token})=>{sessionToken=token;saveSession()});

  // ---- SHARE LINK ----
  $("#shareLinkBtn").click(()=>{
    if(!roomName)return;
    const u=location.origin+location.pathname+"?room="+encodeURIComponent(roomName);
    navigator.clipboard.writeText(u).then(()=>{
      $("#copyToast").addClass("show");setTimeout(()=>$("#copyToast").removeClass("show"),2000);
    }).catch(()=>showInfoToast("Copy this link", u));
  });
  function checkUrlRoom(){
    const p=new URLSearchParams(location.search);const r=p.get("room");
    if(r){history.replaceState({},"",location.pathname);joinRoom(r)}
  }

  // ---- CREATE ROOM ----
  $("#createBtn").click(()=>{const r=$("#roomInput").val().trim();if(!r)return;pendingRoomName=r;$("#passwordInput").val("");$("#passwordError").hide();$("#passwordModal").addClass("active");setTimeout(()=>$("#passwordInput").focus(),100)});
  $("#roomInput").keydown(e=>{if(e.key==="Enter")$("#createBtn").click()});
  $("#passwordCancel").click(()=>{$("#passwordModal").removeClass("active");pendingRoomName=null});
  $("#passwordConfirm").click(()=>{const pw=$("#passwordInput").val();if(!pw){$("#passwordError").text("Password required.").show();return}socket.emit("create-room",{room:pendingRoomName,password:pw})});
  $("#passwordInput").keydown(e=>{if(e.key==="Enter")$("#passwordConfirm").click()});
  socket.on("create-error",m=>$("#passwordError").text(m).show());
  socket.on("auto-join",r=>{$("#passwordModal").removeClass("active");$("#roomInput").val("");pendingRoomName=null;isOwner=true;joinRoom(r)});

  // ---- JOIN ----
  function joinRoom(r){if(roomName)return;roomName=r;closeSidebar();startLocalStream().then(()=>socket.emit("join",roomName))}
  socket.on("waiting-approval",()=>showView("waiting"));
  socket.on("join-rejected",()=>{cleanupAll();showView("lobby");showInfoToast("Denied","The host declined your request.")});
  socket.on("room-error",m=>{cleanupAll();showView("lobby");showInfoToast("Error",m)});
  $("#cancelJoinBtn").click(()=>{if(roomName)socket.emit("cancel-join",roomName);cleanupAll();showView("lobby")});

  // ---- JOIN REQUESTS ----
  socket.on("join-request",({room,userId})=>{
    const s=userId.slice(0,6);
    const t=$(`<div class="toast"><div class="toast-title">Join Request</div><div class="toast-sub">User ${s}… wants to join "${room}"</div><div class="toast-actions"><button class="toast-accept">Accept</button><button class="toast-reject">Deny</button></div></div>`);
    t.find(".toast-accept").click(()=>{socket.emit("accept-user",{room,userId});t.remove()});
    t.find(".toast-reject").click(()=>{socket.emit("reject-user",{room,userId});t.remove()});
    $("#toastContainer").append(t);setTimeout(()=>t.remove(),30000);
  });

  // ---- MEMBERS / KICK ----
  socket.on("member-list",({members,ownerId})=>{currentMembers=members;isOwner=ownerId===socket.id;updateKick()});
  function updateKick(){
    $(".video-kick-btn").remove();if(!isOwner)return;
    currentMembers.forEach(m=>{if(m.id!==socket.id){
      const w=$("#video-"+m.id).closest(".video-wrap");
      if(w.length&&!w.find(".video-kick-btn").length){
        const b=$('<button class="video-kick-btn">Kick</button>');
        b.click(()=>socket.emit("kick-user",{room:roomName,userId:m.id}));w.append(b);
      }
    }});
  }
  socket.on("kicked",()=>{clearSession();cleanupAll();showView("lobby");$("#kickedOverlay").addClass("active")});
  $("#kickedOkBtn").click(()=>{$("#kickedOverlay").removeClass("active");socket.emit("list-rooms")});

  // ---- LEAVE ----
  $("#leaveBtn").click(()=>{if(!roomName)return;socket.emit("leave",roomName);clearSession();cleanupAll();showView("lobby");socket.emit("list-rooms")});

  // ---- MUTE / CAMERA ----
  // The previous implementation used `track.enabled` which was unreliable —
  // some browsers (particularly iOS Safari) didn't restore the stream to
  // remotes after toggling off and on. This version actually stops/restarts
  // the device and uses RTCRtpSender.replaceTrack to swap the track on
  // existing peer connections. No SDP renegotiation needed.
  let micToggleBusy = false, camToggleBusy = false;

  // Find the sender on a peer connection that's bound to a given kind.
  // Works for senders whose track was nulled (toggle-off state) by falling
  // back to the transceiver's receiver track kind.
  function findSenderByKind(pc, kind){
    let s = pc.getSenders().find(x => x.track && x.track.kind === kind);
    if(s) return s;
    for(const tx of pc.getTransceivers()){
      if(tx.receiver && tx.receiver.track && tx.receiver.track.kind === kind){
        return tx.sender;
      }
    }
    return null;
  }

  function applyMuteUI(off){
    audioMuted = off;
    $("#muteBtn").toggleClass("active-off", off);
    $("#micOn").toggle(!off); $("#micOff").toggle(off);
    $("#localWrap").toggleClass("is-muted", off);
    // Belt-and-suspenders: explicit display so it works regardless of CSS
    // specificity. Solves the "red slash doesn't appear when alone" bug.
    $("#localWrap .video-mute-icon").css("display", off ? "flex" : "none");
  }
  function applyCamUI(off){
    videoHidden = off;
    $("#videoBtn").toggleClass("active-off", off);
    $("#camOn").toggle(!off); $("#camOff").toggle(off);
    $("#localWrap").toggleClass("is-cam-off", off);
  }

  async function toggleTrack(kind){
    if(!localStream) return;
    const isAudio = kind === "audio";
    if(isAudio ? micToggleBusy : camToggleBusy) return;
    if(isAudio) micToggleBusy = true; else camToggleBusy = true;

    const wasOff = isAudio ? audioMuted : videoHidden;
    const willBeOff = !wasOff;

    // Optimistic UI update — feels instant
    if(isAudio) applyMuteUI(willBeOff); else applyCamUI(willBeOff);

    try {
      if(willBeOff){
        // Turn OFF: stop the device, replaceTrack(null) on senders so we
        // actually stop sending data. Transceiver stays alive.
        const tracks = isAudio ? localStream.getAudioTracks() : localStream.getVideoTracks();
        for(const t of tracks){ try { t.stop(); } catch(e){} }
        await Promise.all(Object.values(pcs).map(async pc => {
          const s = findSenderByKind(pc, kind);
          if(s) await s.replaceTrack(null).catch(()=>{});
        }));
        for(const t of tracks) localStream.removeTrack(t);
      } else {
        // Turn ON: get a fresh track for this single kind, attach to senders
        const constraints = isAudio ? {audio:true} : {video:true};
        const fresh = await navigator.mediaDevices.getUserMedia(constraints);
        const newTrack = (isAudio ? fresh.getAudioTracks() : fresh.getVideoTracks())[0];
        if(!newTrack) throw new Error("No "+kind+" track returned");

        // Add to the local stream so the local <video> sees it
        localStream.addTrack(newTrack);
        if(!isAudio) localVideo.srcObject = localStream;

        // Wire to existing senders. Most cases hit the first branch.
        await Promise.all(Object.values(pcs).map(async pc => {
          const s = findSenderByKind(pc, kind);
          if(s){
            await s.replaceTrack(newTrack).catch(e => console.warn("replaceTrack "+kind+":", e));
          } else {
            // No transceiver for this kind — add one (rare; would need
            // renegotiation). makeOffer-on-next-event would handle it,
            // but for now log and continue.
            try { pc.addTrack(newTrack, localStream); } catch(e){ console.warn("addTrack "+kind+":", e); }
          }
        }));
      }

      socket.emit(isAudio ? "toggle-audio" : "toggle-video",
                  isAudio ? {muted: willBeOff} : {hidden: willBeOff});
      nudgeConnectionsAfterToggle();
    } catch(err){
      console.error(kind+" toggle error:", err);
      showInfoToast("Device error", err.message || ("Couldn't toggle "+kind));
      // Revert UI on failure
      if(isAudio) applyMuteUI(wasOff); else applyCamUI(wasOff);
    } finally {
      if(isAudio) micToggleBusy = false; else camToggleBusy = false;
    }
  }

  $("#muteBtn").click(()=> toggleTrack("audio"));
  $("#videoBtn").click(()=> toggleTrack("video"));

  // ---- MUTUAL EXCLUSION between YouTube and Screen Share ----
  // The two "theater-mode" features are kept fully independent: starting one
  // never closes the other. Instead, the entry points refuse to open when the
  // other is already in use and surface a toast.
  function isYouTubeActive(){ return $("#youtubeArea").hasClass("active"); }
  function isScreenShareActive(){
    // watchIsOpen covers the local sharer/host; the .visible check covers a
    // viewer who's receiving a remote share (panel can be closed but stream
    // still up briefly during teardown).
    return watchIsOpen || $("#screenVideo").hasClass("visible");
  }

  // ---- YOUTUBE ----
  // YT IFrame API state
  let ytPlayer = null;            // YT.Player instance
  let ytPlayerReady = false;
  let ytApiReady = false;
  let ytPendingVideoId = null;    // queued if API not ready when share arrives
  let ytApplyingRemote = false;   // set true while applying remote sync, prevents loops
  let ytApplyingTimer = null;
  let ytSeekPollTimer = null;
  let ytLastKnownTime = 0;        // last reported time
  let ytLastKnownAt = 0;           // wall-clock ms when ytLastKnownTime was sampled
  let ytLastBroadcastAt = 0;       // throttle outgoing seeks
  let ytPendingStartTime = 0;      // restore position on reconnect
  let ytPendingStartAction = "play";
  let ytPendingRemoteState = null; // queued peer sync that arrived before player was ready
  const YT_DRIFT_TOLERANCE = 2;    // seconds — only resync on bigger drift
  const YT_APPLY_COOLDOWN_MS = 500;
  const YT_BROADCAST_THROTTLE_MS = 250;
  const YT_BUFFER_GRACE_MS = 1500; // wait this long for buffering before forcing sync

  // ---- VOICE ACTIVITY DETECTION + YOUTUBE DUCKING ----
  const VAD_THRESHOLD      = 0.015; // RMS level considered "speaking"
  const VAD_POLL_MS        = 50;    // how often to check audio levels
  const DUCK_VOLUME        = 20;    // % to duck to while someone speaks
  const DUCK_RAMP_MS       = 200;   // ms to ramp down
  const RESTORE_RAMP_MS    = 1200;  // ms to ramp back up (slower = smoother)
  const SILENCE_HOLD_MS    = 1500;  // ms of silence before restoring
  let vadCtx         = null;        // shared AudioContext
  let vadNodes       = {};          // id -> { src, analyser }
  let vadPollTimer   = null;
  let ytNormalVolume = 100;         // restored-to volume (read from player on ready)
  let ytDucked       = false;
  let ytDuckCurrent  = 100;         // tracks the actual volume being animated
  let ytDuckRafId    = null;
  let ytLastSpeechAt = 0;

  function vadGetCtx(){
    if(!vadCtx) vadCtx = new (window.AudioContext||window.webkitAudioContext)();
    if(vadCtx.state === "suspended") vadCtx.resume();
    return vadCtx;
  }

  function vadAdd(id, stream){
    if(!stream || vadNodes[id]) return;
    const audioTracks = stream.getAudioTracks();
    if(!audioTracks.length) return;
    try{
      const ctx = vadGetCtx();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      analyser.smoothingTimeConstant = 0.5;
      src.connect(analyser);
      vadNodes[id] = { src, analyser };
    }catch(e){ console.warn("VAD setup failed for", id, e); }
  }

  function vadRemove(id){
    if(!vadNodes[id]) return;
    try{ vadNodes[id].src.disconnect(); }catch(e){}
    delete vadNodes[id];
  }

  function vadRmsLevel(analyser){
    const buf = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(buf);
    let sum = 0;
    for(let i=0; i<buf.length; i++){ const v=(buf[i]-128)/128; sum+=v*v; }
    return Math.sqrt(sum/buf.length);
  }

  function vadCheck(){
    if(!ytPlayerReady) return;
    let speaking = false;
    for(const id in vadNodes){
      if(vadRmsLevel(vadNodes[id].analyser) > VAD_THRESHOLD){ speaking=true; break; }
    }
    const now = Date.now();
    if(speaking){
      ytLastSpeechAt = now;
      if(!ytDucked) ytDuck();
    } else if(ytDucked && (now - ytLastSpeechAt) > SILENCE_HOLD_MS){
      ytRestore();
    }
  }

  function vadStartPoll(){ if(!vadPollTimer) vadPollTimer = setInterval(vadCheck, VAD_POLL_MS); }
  function vadStopPoll(){ if(vadPollTimer){ clearInterval(vadPollTimer); vadPollTimer=null; } }

  function vadStopAll(){
    vadStopPoll();
    for(const id in vadNodes) vadRemove(id);
  }

  function ytAnimateVolume(target, durationMs){
    if(ytDuckRafId){ cancelAnimationFrame(ytDuckRafId); ytDuckRafId=null; }
    const start = ytDuckCurrent;
    const t0 = performance.now();
    function step(now){
      const p = Math.min(1, (now-t0)/durationMs);
      // ease-in-out quad
      const e = p<0.5 ? 2*p*p : -1+(4-2*p)*p;
      ytDuckCurrent = start + (target-start)*e;
      try{ if(ytPlayerReady) ytPlayer.setVolume(Math.round(ytDuckCurrent)); }catch(_){}
      if(p<1){ ytDuckRafId = requestAnimationFrame(step); }
      else{ ytDuckCurrent=target; ytDuckRafId=null; }
    }
    ytDuckRafId = requestAnimationFrame(step);
  }

  function ytDuck(){
    ytDucked = true;
    ytAnimateVolume(DUCK_VOLUME, DUCK_RAMP_MS);
  }

  function ytRestore(){
    ytDucked = false;
    ytAnimateVolume(ytNormalVolume, RESTORE_RAMP_MS);
  }

  function ytResetDuck(){
    if(ytDuckRafId){ cancelAnimationFrame(ytDuckRafId); ytDuckRafId=null; }
    ytDucked=false; ytDuckCurrent=ytNormalVolume;
  }

  // YouTube IFrame API readiness — handshake with top-level shim
  function onYtApiReady(){
    ytApiReady = true;
    if(ytPendingVideoId){
      const id = ytPendingVideoId;
      ytPendingVideoId = null;
      createYtPlayer(id, ytPendingStartTime, ytPendingStartAction);
    }
  }
  if(window.__ytApiLoaded) onYtApiReady();
  else window.__ytReadyHandler = onYtApiReady;

  function createYtPlayer(videoId, startTime, startAction){
    destroyYtPlayer();
    ytPendingStartTime = startTime || 0;
    ytPendingStartAction = startAction || "play";

    if(!ytApiReady){
      ytPendingVideoId = videoId;
      return;
    }

    ytPlayer = new YT.Player("youtubeFrame", {
      videoId,
      playerVars: {
        autoplay: ytPendingStartAction === "play" ? 1 : 0,
        playsinline: 1,
        rel: 0,
        modestbranding: 1,
        enablejsapi: 1,
        origin: location.origin,
        start: Math.floor(ytPendingStartTime),
      },
      events: {
        onReady: onYtReady,
        onStateChange: onYtStateChange,
      },
    });
  }

  function destroyYtPlayer(){
    vadStopPoll();
    ytResetDuck();
    if(ytSeekPollTimer){ clearInterval(ytSeekPollTimer); ytSeekPollTimer = null; }
    if(ytApplyingTimer){ clearTimeout(ytApplyingTimer); ytApplyingTimer = null; }
    ytApplyingRemote = false;
    ytPlayerReady = false;
    ytPendingRemoteState = null;
    if(ytPlayer){
      try { ytPlayer.destroy(); } catch(e){}
      ytPlayer = null;
    }
    // Restore the placeholder div so a future createYtPlayer can target it
    const $c = $("#youtubeArea .youtube-container");
    if($c.length && !$c.find("#youtubeFrame").length){
      $c.append('<div id="youtubeFrame"></div>');
    }
  }

  function onYtReady(){
    ytPlayerReady = true;
    try{ ytNormalVolume = ytPlayer.getVolume() || 100; }catch(_){ ytNormalVolume=100; }
    ytDuckCurrent = ytNormalVolume;
    vadStartPoll();
    // If a peer pushed a more up-to-date state while the player was loading,
    // use that — it's fresher than the server-stored timestamp.
    if(ytPendingRemoteState){
      const s = ytPendingRemoteState;
      ytPendingRemoteState = null;
      applyRemoteYtState(s);
    } else {
      if(ytPendingStartTime > 0) ytPlayer.seekTo(ytPendingStartTime, true);
      if(ytPendingStartAction === "pause") ytPlayer.pauseVideo();
      ytLastKnownTime = ytPendingStartTime || safeGetTime();
      ytLastKnownAt = Date.now();
    }
    if(ytSeekPollTimer) clearInterval(ytSeekPollTimer);
    ytSeekPollTimer = setInterval(detectSeek, 500);
  }

  function safeGetTime(){
    try { return ytPlayer && typeof ytPlayer.getCurrentTime === "function" ? (ytPlayer.getCurrentTime() || 0) : 0; }
    catch(e){ return 0; }
  }
  function safeGetState(){
    try { return ytPlayer && typeof ytPlayer.getPlayerState === "function" ? ytPlayer.getPlayerState() : -1; }
    catch(e){ return -1; }
  }

  // YouTube state codes:
  //  -1 unstarted, 0 ended, 1 playing, 2 paused, 3 buffering, 5 cued
  function onYtStateChange(e){
    if(ytApplyingRemote) return; // ignore self-triggered changes during remote apply

    const state = e.data;
    const t = safeGetTime();

    if(state === YT.PlayerState.PLAYING){
      ytLastKnownTime = t; ytLastKnownAt = Date.now();
      broadcastYtState("play", t);
    } else if(state === YT.PlayerState.PAUSED){
      ytLastKnownTime = t; ytLastKnownAt = Date.now();
      broadcastYtState("pause", t);
    } else if(state === YT.PlayerState.ENDED){
      broadcastYtState("pause", t);
    }
    // BUFFERING (3) and CUED (5) we don't broadcast — they're transient
  }

  // Detect seek by comparing actual vs expected time
  function detectSeek(){
    if(!ytPlayerReady || ytApplyingRemote) {
      // Still update our reference so we don't think a remote-applied jump is a user seek
      ytLastKnownTime = safeGetTime();
      ytLastKnownAt = Date.now();
      return;
    }
    const state = safeGetState();
    const t = safeGetTime();
    const now = Date.now();

    if(state === YT.PlayerState.PLAYING){
      const elapsed = (now - ytLastKnownAt) / 1000;
      const expected = ytLastKnownTime + elapsed;
      const drift = Math.abs(t - expected);
      // If actual time has jumped >1.5s from expected, treat as a user seek.
      // (1.5 is below the 2s drift tolerance so we still notify, but above
      // normal playback variance.)
      if(drift > 1.5){
        if(now - ytLastBroadcastAt > YT_BROADCAST_THROTTLE_MS){
          broadcastYtState("seek", t);
        }
      }
    }
    ytLastKnownTime = t;
    ytLastKnownAt = now;
  }

  function broadcastYtState(action, currentTime){
    if(!roomName) return;
    ytLastBroadcastAt = Date.now();
    socket.emit("youtube-state", {
      room: roomName,
      action,                  // "play" | "pause" | "seek"
      currentTime,
      sentAt: Date.now(),
    });
  }

  // Apply incoming remote state. Sets ytApplyingRemote so the resulting
  // onStateChange doesn't re-broadcast.
  function applyRemoteYtState({action, currentTime, sentAt}){
    if(!ytPlayerReady){
      ytPendingRemoteState = {action, currentTime, sentAt};
      return;
    }
    ytApplyingRemote = true;
    if(ytApplyingTimer) clearTimeout(ytApplyingTimer);

    const state = safeGetState();
    const localTime = safeGetTime();

    // Compensate for network latency: if remote was playing, advance currentTime
    // by the time it took to arrive.
    let targetTime = currentTime;
    if(action === "play" && typeof sentAt === "number"){
      targetTime = currentTime + (Date.now() - sentAt) / 1000;
    }

    try {
      if(action === "pause"){
        if(state !== YT.PlayerState.PAUSED) ytPlayer.pauseVideo();
        if(Math.abs(localTime - targetTime) > YT_DRIFT_TOLERANCE) ytPlayer.seekTo(targetTime, true);
      } else if(action === "play"){
        if(Math.abs(localTime - targetTime) > YT_DRIFT_TOLERANCE) ytPlayer.seekTo(targetTime, true);
        if(state !== YT.PlayerState.PLAYING) ytPlayer.playVideo();
        // Buffering grace: if still buffering after grace period, that's fine,
        // YouTube keeps trying. We just don't keep poking.
      } else if(action === "seek"){
        // Always honor seeks (even tiny ones) — user explicitly scrubbed
        ytPlayer.seekTo(targetTime, true);
      }
    } catch(e){
      console.warn("YT remote apply error:", e);
    }

    // Reset reference so detectSeek doesn't false-positive after the seek
    ytLastKnownTime = targetTime;
    ytLastKnownAt = Date.now();

    ytApplyingTimer = setTimeout(()=>{ ytApplyingRemote = false; }, YT_APPLY_COOLDOWN_MS);
  }

  // ---- Modal and share handlers ----
  $("#ytShareBtn").click(()=>{
    if(isScreenShareActive()){
      showErrorToast("Already in use","Close screen sharing first to start a YouTube watch party.");
      return;
    }
    $("#ytModal").addClass("active");$("#ytUrlInput").val("").focus();$("#ytError").hide().text("");
  });
  $("#ytModalCancel").click(()=>$("#ytModal").removeClass("active"));
  $("#ytModalShare").click(()=>{
    const u = $("#ytUrlInput").val().trim(); if(!u) return;
    const v = extractYtId(u); if(!v){ $("#ytError").text("Enter a valid YouTube URL.").show(); return }
    // Re-check at submit time — guards against a peer starting a share between
    // modal-open and modal-submit.
    if(isScreenShareActive()){
      $("#ytModal").removeClass("active");
      showErrorToast("Already in use","Close screen sharing first to start a YouTube watch party.");
      return;
    }
    socket.emit("share-youtube",{room:roomName, videoId:v});
    $("#ytModal").removeClass("active");
  });
  $("#ytUrlInput").keydown(e=>{ if(e.key==="Enter") $("#ytModalShare").click() });

  // Incoming YouTube share. Independent of screen share: if a share is locally
  // in progress we ignore the event and surface a toast rather than stomping.
  socket.on("youtube-shared", ({videoId, currentTime, action})=>{
    if(isScreenShareActive()){
      showInfoToast("YouTube ignored","A screen share is active in this room.");
      return;
    }
    $("#youtubeArea").addClass("active");
    createYtPlayer(videoId, currentTime, action);
    updateVideoLayout();
  });

  function closeYoutube(){
    destroyYtPlayer();
    $("#youtubeArea").removeClass("active");
    $(".main").removeClass("cameras-shrunk");
  }
  $("#youtubeCloseBtn").click(()=> socket.emit("close-youtube", roomName));
  socket.on("youtube-closed", ()=>{ closeYoutube(); updateVideoLayout(); });

  // Receive remote play/pause/seek
  socket.on("youtube-state", (data)=> applyRemoteYtState(data));

  // Late-joiner catch-up: when a new user joins, if we have a YT player going,
  // push our current state to them so they sync up.
  function pushYtStateToNewUser(userId){
    if(!ytPlayerReady) return;
    const state = safeGetState();
    const action = (state === YT.PlayerState.PLAYING) ? "play" : "pause";
    socket.emit("youtube-state-to", {
      to: userId,
      action,
      currentTime: safeGetTime(),
      sentAt: Date.now(),
    });
  }
  socket.on("youtube-state-to", (data)=> applyRemoteYtState(data));

  function extractYtId(u){const ps=[/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,/^([a-zA-Z0-9_-]{11})$/];for(const p of ps){const m=u.match(p);if(m)return m[1]}return null}

  // ---- FOCUS TOGGLE (manual cameras-shrunk) ----
  // Only meaningful while in theater mode (YouTube or screen share active).
  // Shrinks the participant tile row to give media more space.
  function toggleFocus(){
    if(!$(".main").hasClass("focus-mode")) return;
    $(".main").toggleClass("cameras-shrunk");
  }
  $("#ytFocusBtn").click(toggleFocus);
  $("#watchFocusBtn").click(toggleFocus);

  // ==== WATCH TOGETHER (Screen Share via WebRTC) ====
  let screenStream = null;
  let screenPC = null;
  let isScreenSharer = false;
  let watchIsOpen = false;

  // Step 1: Open the watch panel (button in controls bar)
  $("#watchBtn").click(()=>{
    if(watchIsOpen){
      closeWatchPanel(true);
      return;
    }
    if(isYouTubeActive()){
      showErrorToast("Already in use","Close the YouTube player first to share your screen.");
      return;
    }
    // Open the panel, show the "Start Sharing" prompt
    openWatchPanel();
  });

  function openWatchPanel(){
    watchIsOpen = true;
    $("#watchArea").addClass("active");
    $("#watchBtn").addClass("active-on").removeClass("dark");
    // Show the prompt, hide everything else
    $("#watchPrompt").show();
    $("#watchViewerMsg").removeClass("visible");
    $("#screenVideo").removeClass("visible");
    $("#watchStatus").removeClass("visible");
    $("#watchError").hide();
    $("#watchTitle").text("Watch Together");
    updateVideoLayout();
  }

  function closeWatchPanel(broadcast){
    stopScreenShare(false); // stop stream if active, don't broadcast ss-stop twice
    watchIsOpen = false;
    $("#watchArea").removeClass("active");
    $("#watchBtn").removeClass("active-on").addClass("dark");
    $(".main").removeClass("cameras-shrunk");
    updateVideoLayout();
    if(broadcast && roomName) socket.emit("ss-stop",{room:roomName});
  }

  // Close button in the header
  $("#watchCloseBtn").click(()=> closeWatchPanel(true));

  // Step 2: User clicks "Share Screen" button inside the panel
  $("#shareStartBtn").click(async ()=>{
    $("#watchError").hide();

    // Re-check exclusion in case YouTube was opened while the prompt was up.
    if(isYouTubeActive()){
      $("#watchError").text("Close the YouTube player first to share your screen.").show();
      return;
    }

    // Check if getDisplayMedia is available
    if(!navigator.mediaDevices || !navigator.mediaDevices.getDisplayMedia){
      $("#watchError").text("Screen sharing is not supported in this browser. Please use Chrome, Edge, or Firefox on desktop.").show();
      return;
    }

    try{
      screenStream = await navigator.mediaDevices.getDisplayMedia({
        video:{ cursor:"always" },
        audio:true
      });
    }catch(e){
      if(e.name === "NotAllowedError"){
        $("#watchError").text("Screen sharing was cancelled. Click the button to try again.").show();
      }else{
        $("#watchError").text("Could not start screen sharing: " + e.message).show();
      }
      console.error("getDisplayMedia error:", e);
      return;
    }

    // Success — we have a screen stream
    isScreenSharer = true;

    // Show the video preview
    const vid = document.getElementById("screenVideo");
    vid.srcObject = screenStream;
    vid.muted = true;
    $("#watchPrompt").hide();
    $(vid).addClass("visible");
    $("#watchTitle").text("You are sharing");
    $("#watchStatus").addClass("visible");
    $("#watchStatusLabel").text("Sharing your screen");
    $("#watchStopInline").show().text("Stop");

    // When user stops via browser's native "Stop sharing" button
    screenStream.getVideoTracks()[0].onended = ()=> closeWatchPanel(true);

    // Notify other user and send them the offer
    socket.emit("ss-start",{room:roomName});
    currentMembers.forEach(m=>{
      if(m.id !== socket.id) createScreenOffer(m.id);
    });
  });

  // Stop inline button
  $("#watchStopInline").click(()=> closeWatchPanel(true));

  function stopScreenShare(broadcast){
    if(screenStream){
      screenStream.getTracks().forEach(t=>t.stop());
      screenStream = null;
    }
    if(screenPC){
      screenPC.close();
      screenPC = null;
    }
    const vid = document.getElementById("screenVideo");
    if(vid){vid.srcObject = null;$(vid).removeClass("visible")}
    isScreenSharer = false;
    $("#watchStatus").removeClass("visible");
    if(broadcast && roomName) socket.emit("ss-stop",{room:roomName});
  }

  // ---- Screen share WebRTC signaling ----
  function createScreenOffer(remoteId){
    if(screenPC){screenPC.close();screenPC=null}
    screenPC = new RTCPeerConnection(config);
    screenStream.getTracks().forEach(t=> screenPC.addTrack(t, screenStream));
    screenPC.onicecandidate = e=>{
      if(e.candidate) socket.emit("ss-ice",{to:remoteId,candidate:e.candidate});
    };
    screenPC.createOffer().then(o=>{
      screenPC.setLocalDescription(o);
      socket.emit("ss-offer",{to:remoteId,sdp:o});
    }).catch(err=> console.error("Screen offer error:", err));
  }

  // Receiving a screen share offer (I am the VIEWER). Independent of YouTube:
  // if a YT player is currently active locally, refuse the offer rather than
  // closing the player. The sharer should have been blocked client-side, but
  // this is belt-and-suspenders against races.
  socket.on("ss-offer",async({from,sdp})=>{
    if(isYouTubeActive()){
      showInfoToast("Share ignored","YouTube is active in this room.");
      return;
    }
    if(!watchIsOpen) openWatchPanel();

    // Hide the prompt, show the video
    $("#watchPrompt").hide();
    $("#watchViewerMsg").removeClass("visible");
    const vid = document.getElementById("screenVideo");

    if(screenPC){screenPC.close();screenPC=null}
    screenPC = new RTCPeerConnection(config);
    screenPC.ontrack = e=>{
      vid.srcObject = e.streams[0];
      $(vid).addClass("visible");
      $("#watchTitle").text("Watching together");
      $("#watchStatus").addClass("visible");
      $("#watchStatusLabel").text("Viewing shared screen");
      $("#watchStopInline").hide(); // viewer can't stop the share, only close
    };
    screenPC.onicecandidate = e=>{
      if(e.candidate) socket.emit("ss-ice",{to:from,candidate:e.candidate});
    };
    try{
      await screenPC.setRemoteDescription(new RTCSessionDescription(sdp));
      const answer = await screenPC.createAnswer();
      await screenPC.setLocalDescription(answer);
      socket.emit("ss-answer",{to:from,sdp:answer});
    }catch(err){
      console.error("Screen answer error:", err);
    }
  });

  socket.on("ss-answer",async({sdp})=>{
    if(screenPC){
      try{await screenPC.setRemoteDescription(new RTCSessionDescription(sdp))}
      catch(err){console.error("ss-answer error:",err)}
    }
  });

  socket.on("ss-ice",async({candidate})=>{
    if(screenPC && candidate){
      try{await screenPC.addIceCandidate(new RTCIceCandidate(candidate))}
      catch(err){console.error("ss-ice error:",err)}
    }
  });

  // Other user started sharing — show waiting state. Independent of YouTube:
  // ignore the event if YouTube is locally active.
  socket.on("ss-start",()=>{
    if(isYouTubeActive()){
      showInfoToast("Share ignored","YouTube is active in this room.");
      return;
    }
    if(!watchIsOpen) openWatchPanel();
    $("#watchPrompt").hide();
    $("#watchViewerMsg").addClass("visible");
  });

  // Other user stopped sharing (deliberate close, native stop, or server-side
  // disconnect cleanup). Tear down the viewer regardless of panel state so the
  // frozen frame can't linger.
  socket.on("ss-stop",()=>{
    if(screenPC){screenPC.close();screenPC=null}
    const vid = document.getElementById("screenVideo");
    if(vid){vid.srcObject=null;$(vid).removeClass("visible")}
    if(watchIsOpen){
      // Go back to prompt state so this user could share instead
      $("#watchPrompt").show();
      $("#watchViewerMsg").removeClass("visible");
      $("#watchStatus").removeClass("visible");
      $("#watchTitle").text("Watch Together");
    }
    showInfoToast("Share ended","Screen sharing has stopped.");
  });

  // If a new user joins while we're sharing, send them the offer
  function onUserJoinedScreenShare(userId){
    if(isScreenSharer && screenStream && screenStream.active){
      createScreenOffer(userId);
    }
  }

  function cleanupScreenShare(){
    stopScreenShare(false);
    watchIsOpen = false;
    $("#watchArea").removeClass("active");
    $("#watchBtn").removeClass("active-on").addClass("dark");
    $(".main").removeClass("cameras-shrunk");
  }

  // ---- WEBRTC ----
  // ICE restart / rebuild bookkeeping per remote peer
  const peerHealth = {}; // remoteId -> { iceRestartAttempts, rebuildTimer, lastRestartAt }
  const MAX_ICE_RESTARTS = 2;          // after this many, escalate to full rebuild
  const ICE_RESTART_COOLDOWN_MS = 4000; // don't spam restarts
  const RECONNECT_GRACE_MS = 2500;     // wait this long after disconnected before acting

  async function startLocalStream(){
    if(localStream) return;
    // Try video + audio
    try{
      localStream = await navigator.mediaDevices.getUserMedia({video:true, audio:true});
      localVideo.srcObject = localStream;
      vadAdd("local", localStream);
      return;
    }catch(e){ console.warn("getUserMedia(video+audio) failed:", e.message); }
    // Fallback: audio only
    try{
      localStream = await navigator.mediaDevices.getUserMedia({audio:true});
      localVideo.srcObject = localStream;
      videoHidden = true; applyCamUI(true);
      vadAdd("local", localStream);
      showInfoToast("Camera Unavailable","Joining with audio only.");
      return;
    }catch(e){ console.warn("getUserMedia(audio) failed:", e.message); }
    // Fallback: video only
    try{
      localStream = await navigator.mediaDevices.getUserMedia({video:true});
      localVideo.srcObject = localStream;
      audioMuted = true; applyMuteUI(true);
      showInfoToast("Mic Unavailable","Joining with video only.");
      return;
    }catch(e){ console.warn("getUserMedia(video) failed:", e.message); }
    // Last resort: empty stream
    localStream = new MediaStream();
    localVideo.srcObject = localStream;
    audioMuted = true; videoHidden = true;
    applyMuteUI(true); applyCamUI(true);
    showInfoToast("No Devices","Joined without camera or microphone.");
  }

  // Build the status cluster (label + mute icon) and cam-off overlay markup
  // used by both local and remote tiles.
  function buildStatusCluster(name){
    const initial = (name||"?")[0].toUpperCase();
    return `
      <div class="video-cam-off-overlay">
        <div class="cam-off-avatar">${initial}</div>
        <div class="cam-off-name">${name}</div>
      </div>
      <div class="video-status">
        <div class="video-label">${name}</div>
        <div class="video-mute-icon" title="Muted">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="1" y1="1" x2="23" y2="23"/><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"/><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"/><line x1="12" y1="19" x2="12" y2="23"/></svg>
        </div>
      </div>`;
  }

  function createRemoteVideo(id){
    if($("#video-"+id).length) return $("#video-"+id)[0];
    const w = $('<div class="video-wrap"></div>');
    const v = $("<video>").attr({id:"video-"+id, autoplay:true, playsinline:true})
                          .css({width:"100%", height:"100%", objectFit:"cover"});
    w.append(v).append(buildStatusCluster("Participant"));
    $("#videoArea").append(w);
    updateVideoLayout();
    setTimeout(()=>updateKick(), 200);
    return v[0];
  }
  function removeRemoteVideo(id){
    vadRemove(id);
    const v = $("#video-"+id);
    if(v.length) v.closest(".video-wrap").remove();
    updateVideoLayout();
  }

  function createPeer(rid){
    const pc = new RTCPeerConnection(config);
    pcs[rid] = pc;
    peerHealth[rid] = peerHealth[rid] || { iceRestartAttempts: 0, rebuildTimer: null, lastRestartAt: 0 };

    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));

    // Create the tile immediately so the participant is visible even when
    // one or both users have no camera/mic (empty stream → ontrack never fires).
    // Start with cam-off placeholder; remove it only when a real video track lands.
    const _rv = createRemoteVideo(rid);
    $(_rv).closest(".video-wrap").addClass("is-cam-off");

    pc.ontrack = e => {
      const rv = createRemoteVideo(rid);
      rv.srcObject = e.streams[0];
      if(e.track.kind === "video") $(rv).closest(".video-wrap").removeClass("is-cam-off");
      if(e.track.kind === "audio") vadAdd(rid, e.streams[0]);
    };
    pc.onicecandidate = e => { if(e.candidate) socket.emit("ice-candidate", {to: rid, candidate: e.candidate}) };

    // Watch BOTH connectionState and iceConnectionState — Safari/iOS fires
    // iceConnectionState reliably while connectionState can lag.
    pc.onconnectionstatechange = () => handlePeerStateChange(rid, pc.connectionState);
    pc.oniceconnectionstatechange = () => handlePeerStateChange(rid, pc.iceConnectionState);

    return pc;
  }

  function handlePeerStateChange(rid, state){
    const pc = pcs[rid];
    if(!pc) return;

    if(state === "connected" || state === "completed"){
      // Healthy — clear any pending recovery
      $("#reconnectBanner").removeClass("active");
      const h = peerHealth[rid];
      if(h){
        h.iceRestartAttempts = 0;
        if(h.rebuildTimer){ clearTimeout(h.rebuildTimer); h.rebuildTimer = null; }
      }
      return;
    }

    if(state === "closed"){
      removeRemoteVideo(rid);
      return;
    }

    if(state === "failed" || state === "disconnected"){
      // Show the reconnect banner; brief grace period before action
      if(roomName) $("#reconnectBanner").addClass("active");
      const h = peerHealth[rid];
      if(!h || h.rebuildTimer) return; // already scheduled

      const delay = state === "failed" ? 0 : RECONNECT_GRACE_MS;
      h.rebuildTimer = setTimeout(() => {
        h.rebuildTimer = null;
        // Only act if still unhealthy
        const cur = pc.connectionState;
        const ice = pc.iceConnectionState;
        if(cur === "connected" || cur === "completed" || ice === "connected" || ice === "completed") return;

        if(h.iceRestartAttempts < MAX_ICE_RESTARTS){
          attemptIceRestart(rid);
        } else {
          rebuildPeer(rid);
        }
      }, delay);
    }
  }

  async function attemptIceRestart(rid){
    const pc = pcs[rid];
    if(!pc) return;
    const h = peerHealth[rid];
    const now = Date.now();
    if(now - h.lastRestartAt < ICE_RESTART_COOLDOWN_MS) return;
    h.lastRestartAt = now;
    h.iceRestartAttempts++;
    try {
      console.log(`[reconnect] ICE restart for ${rid} (attempt ${h.iceRestartAttempts})`);
      const offer = await pc.createOffer({ iceRestart: true });
      await pc.setLocalDescription(offer);
      socket.emit("offer", { to: rid, sdp: offer });
    } catch (err) {
      console.error("ICE restart failed:", err);
      // Escalate immediately
      rebuildPeer(rid);
    }
  }

  async function rebuildPeer(rid){
    console.log(`[reconnect] Full rebuild for ${rid}`);
    const old = pcs[rid];
    if(old){ try { old.close(); } catch(e){} }
    delete pcs[rid];
    if(peerHealth[rid]) peerHealth[rid].iceRestartAttempts = 0;
    if(!localStream) return;
    try {
      await makeOffer(rid);
    } catch (err) {
      console.error("Rebuild failed:", err);
    }
  }

  // After toggling a track, give the connection a nudge — iOS Safari sometimes
  // drops ICE when tracks are disabled then re-enabled.
  function nudgeConnectionsAfterToggle(){
    Object.keys(pcs).forEach(rid => {
      const pc = pcs[rid];
      if(!pc) return;
      const cs = pc.connectionState, ics = pc.iceConnectionState;
      if(cs === "failed" || cs === "disconnected" || ics === "failed" || ics === "disconnected"){
        attemptIceRestart(rid);
      }
    });
  }

  async function makeOffer(r){const pc=createPeer(r);const o=await pc.createOffer();await pc.setLocalDescription(o);socket.emit("offer",{to:r,sdp:o})}
  async function handleOffer(f,s){
    // If we already have a peer for this id, this is likely an ICE-restart re-offer.
    let pc = pcs[f];
    if(!pc) pc = createPeer(f);
    await pc.setRemoteDescription(new RTCSessionDescription(s));
    const a = await pc.createAnswer();
    await pc.setLocalDescription(a);
    socket.emit("answer", {to: f, sdp: a});
  }
  async function handleAnswer(f,s){const pc=pcs[f];if(pc)await pc.setRemoteDescription(new RTCSessionDescription(s))}
  async function handleCandidate(f,c){const pc=pcs[f];if(pc&&c){try{await pc.addIceCandidate(new RTCIceCandidate(c))}catch(e){console.warn("addIceCandidate failed:",e)}}}
  function cleanupAll(){
    for(const id in pcs){pcs[id].close();removeRemoteVideo(id);delete pcs[id]}
    for(const id in peerHealth){
      if(peerHealth[id].rebuildTimer) clearTimeout(peerHealth[id].rebuildTimer);
      delete peerHealth[id];
    }
    vadStopAll(); vadRemove("local");
    if(localStream){localStream.getTracks().forEach(t=>t.stop());localStream=null;localVideo.srcObject=null}
    audioMuted=false;videoHidden=false;roomName=null;isOwner=false;
    $("#muteBtn").removeClass("active-off");$("#videoBtn").removeClass("active-off");
    $("#micOn").show();$("#micOff").hide();$("#camOn").show();$("#camOff").hide();
    $("#localWrap").removeClass("is-muted is-cam-off");
    $("#localWrap .video-mute-icon").css("display", "");
    $("#reconnectBanner").removeClass("active");
    closeYoutube();cleanupScreenShare();
  }

  // ---- SOCKET EVENTS ----
  socket.on("room-list",rooms=>{$("#activeList").empty();if(!rooms.length)$("#activeList").append('<div class="room-empty">No rooms — create one!</div>');else rooms.forEach(r=>{const b=$(`<button class="room-item" title="${r.name}"><span class="room-dot"></span><span class="room-name">${r.name}</span><span class="room-count">${r.count}/2</span></button>`);b.click(()=>joinRoom(r.name));$("#activeList").append(b)})});
  socket.on("users",async users=>{showView("call");$("#topbarBadge").show().text((users.length+1)+" in call");for(const id of users)await makeOffer(id)});
  socket.on("user-joined",id=>{
    updateKick();
    onUserJoinedScreenShare(id);
    pushYtStateToNewUser(id);
    // Tell new participant our current mute/cam state so their UI reflects it
    if(roomName){
      socket.emit("toggle-audio", {muted: audioMuted, to: id});
      socket.emit("toggle-video", {hidden: videoHidden, to: id});
    }
  });
  socket.on("room-count",c=>{if(roomName)$("#topbarBadge").show().text(c+" in call")});
  socket.on("user-left",id=>{removeRemoteVideo(id);if(pcs[id]){pcs[id].close();delete pcs[id]}});
  socket.on("offer",async({from,sdp})=>await handleOffer(from,sdp));
  socket.on("answer",async({from,sdp})=>await handleAnswer(from,sdp));
  socket.on("ice-candidate",async({from,candidate})=>handleCandidate(from,candidate));
  socket.on("user-video-toggle",({id,hidden})=>{
    const $w = $("#video-"+id).closest(".video-wrap");
    $w.toggleClass("is-cam-off", !!hidden);
  });
  socket.on("user-audio-toggle",({id,muted})=>{
    const $w = $("#video-"+id).closest(".video-wrap");
    $w.toggleClass("is-muted", !!muted);
  });
  socket.on("room-full",r=>{cleanupAll();showView("lobby");showInfoToast("Room full",`"${r}" has 2 participants.`);socket.emit("list-rooms")});
  socket.on("update-rooms",()=>socket.emit("list-rooms"));

  function showInfoToast(t,s){const el=$(`<div class="toast toast-info"><div class="toast-title">${t}</div><div class="toast-sub" style="margin-bottom:0">${s}</div></div>`);$("#toastContainer").append(el);setTimeout(()=>el.remove(),4000)}
  function showErrorToast(t,s){const el=$(`<div class="toast toast-error"><div class="toast-title">${t}</div><div class="toast-sub" style="margin-bottom:0">${s}</div></div>`);$("#toastContainer").append(el);setTimeout(()=>el.remove(),5000)}

  showView("lobby");
});
