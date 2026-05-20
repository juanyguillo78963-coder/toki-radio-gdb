(() => {
  const $ = id => document.getElementById(id);
  const joinPanel = $("joinPanel"), radioPanel = $("radioPanel"), joinBtn = $("joinBtn"), nameInput = $("nameInput");
  const talkBtn = $("talkBtn"), connStatus = $("connStatus"), modeTitle = $("modeTitle"), modeText = $("modeText");
  const usersBox = $("users"), messages = $("messages"), chatInput = $("chatInput"), sendBtn = $("sendBtn");
  const muteBtn = $("muteBtn"), shareBtn = $("shareBtn"), copyBtn = $("copyBtn");
  const radioFxStatus = $("radioFxStatus"), speakerTag = $("speakerTag"), unlockBtn = $("unlockBtn");
  let lockedByOther = false;
  let currentSpeakerName = null;
  let audioUnlocked = false;
  const pendingAudios = new Set();

  let socket = null;
  let localStream = null;
  let rawMicStream = null;
  let audioCtx = null;
  let fxDestination = null;
  let radioFxReady = false;
  let mutedOutput = false;
  let joined = false;
  let mySocketId = null;
  let currentName = "Oyente";
  const roomId = location.pathname.startsWith("/s/") ? decodeURIComponent(location.pathname.split("/s/")[1] || "gases-belen") : "gases-belen";
  const peers = new Map();
  const rtcConfig = { iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:global.stun.twilio.com:3478" }
  ], iceCandidatePoolSize: 6};


  async function unlockAudioOutput(){
    try{
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if(audioCtx.state === "suspended") await audioCtx.resume();
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      gain.gain.value = 0.00001;
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(); osc.stop(audioCtx.currentTime + 0.03);
      audioUnlocked = true;
      if(unlockBtn) unlockBtn.classList.add("hidden");
      for(const a of Array.from(pendingAudios)){
        try{ a.muted = mutedOutput; a.volume = 1; await a.play(); pendingAudios.delete(a); }catch{}
      }
      return true;
    }catch(e){
      audioUnlocked = false;
      if(unlockBtn) unlockBtn.classList.remove("hidden");
      return false;
    }
  }

  function showUnlockAudio(){
    if(unlockBtn) unlockBtn.classList.remove("hidden");
    setMainState("Toca activar sonido", "Algunos celulares bloquean el audio automático. Toca ACTIVAR SONIDO una vez y luego escucharás todos.");
  }

  function forceAudioPlay(audio){
    audio.autoplay = true;
    audio.playsInline = true;
    audio.controls = false;
    audio.muted = mutedOutput;
    audio.volume = 1;
    const p = audio.play();
    if(p && typeof p.catch === "function"){
      p.catch(() => { pendingAudios.add(audio); showUnlockAudio(); });
    }
  }


  function makeDistortionCurve(amount = 18){
    const n = 44100;
    const curve = new Float32Array(n);
    const deg = Math.PI / 180;
    for(let i = 0; i < n; i++){
      const x = (i * 2) / n - 1;
      curve[i] = ((3 + amount) * x * 20 * deg) / (Math.PI + amount * Math.abs(x));
    }
    return curve;
  }

  function makeNoiseBuffer(ctx, seconds = 0.22){
    const buffer = ctx.createBuffer(1, Math.max(1, ctx.sampleRate * seconds), ctx.sampleRate);
    const data = buffer.getChannelData(0);
    for(let i = 0; i < data.length; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / data.length);
    return buffer;
  }

  function playLocalBeep(freq = 880, duration = 0.08){
    try{
      if(!audioCtx) return;
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.type = "square";
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.0001, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.12, audioCtx.currentTime + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + duration);
      osc.connect(gain).connect(audioCtx.destination);
      osc.start(); osc.stop(audioCtx.currentTime + duration + 0.02);
    }catch{}
  }

  function injectRadioBurst(type = "start"){
    try{
      if(!audioCtx || !fxDestination) return;
      const now = audioCtx.currentTime;
      const noise = audioCtx.createBufferSource();
      const noiseGain = audioCtx.createGain();
      const bp = audioCtx.createBiquadFilter();
      bp.type = "bandpass"; bp.frequency.value = 1250; bp.Q.value = 0.8;
      noise.buffer = makeNoiseBuffer(audioCtx, type === "start" ? 0.24 : 0.18);
      noiseGain.gain.setValueAtTime(0.0001, now);
      noiseGain.gain.exponentialRampToValueAtTime(type === "start" ? 0.48 : 0.34, now + 0.015);
      noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + (type === "start" ? 0.22 : 0.16));
      noise.connect(bp).connect(noiseGain).connect(fxDestination);
      noise.start(now);

      const osc = audioCtx.createOscillator();
      const og = audioCtx.createGain();
      osc.type = "square"; osc.frequency.value = type === "start" ? 900 : 520;
      og.gain.setValueAtTime(0.0001, now);
      og.gain.exponentialRampToValueAtTime(0.24, now + 0.01);
      og.gain.exponentialRampToValueAtTime(0.0001, now + 0.09);
      osc.connect(og).connect(fxDestination);
      osc.start(now + 0.02); osc.stop(now + 0.11);
      playLocalBeep(type === "start" ? 980 : 520, 0.07);
    }catch(e){ console.warn("radio burst", e); }
  }

  async function buildRadioFxStream(rawStream){
    try{
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if(audioCtx.state === "suspended") await audioCtx.resume();
      const source = audioCtx.createMediaStreamSource(rawStream);
      const high = audioCtx.createBiquadFilter(); high.type = "highpass"; high.frequency.value = 360;
      const low = audioCtx.createBiquadFilter(); low.type = "lowpass"; low.frequency.value = 3100;
      const presence = audioCtx.createBiquadFilter(); presence.type = "peaking"; presence.frequency.value = 1350; presence.Q.value = 1.4; presence.gain.value = 10;
      const shaper = audioCtx.createWaveShaper(); shaper.curve = makeDistortionCurve(15); shaper.oversample = "2x";
      const comp = audioCtx.createDynamicsCompressor();
      comp.threshold.value = -42; comp.knee.value = 10; comp.ratio.value = 14; comp.attack.value = 0.003; comp.release.value = 0.12;
      const gain = audioCtx.createGain(); gain.gain.value = 2.65;
      const limiter = audioCtx.createDynamicsCompressor();
      limiter.threshold.value = -8; limiter.knee.value = 0; limiter.ratio.value = 20; limiter.attack.value = 0.001; limiter.release.value = 0.05;
      fxDestination = audioCtx.createMediaStreamDestination();
      source.connect(high).connect(low).connect(presence).connect(shaper).connect(comp).connect(gain).connect(limiter).connect(fxDestination);
      radioFxReady = true;
      if(radioFxStatus) radioFxStatus.textContent = "EFECTO RADIO: WALKIE-TALKIE ACTIVO";
      return fxDestination.stream;
    }catch(e){
      console.warn("No se pudo activar efecto radio", e);
      radioFxReady = false;
      if(radioFxStatus) radioFxStatus.textContent = "EFECTO RADIO: BÁSICO";
      return rawStream;
    }
  }

  function clean(s){ return String(s || "").replace(/[&<>"']/g, m => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[m])); }
  function addMessage(name, text, time = new Date().toLocaleTimeString("es-CO", {hour:"2-digit", minute:"2-digit"})){
    const el = document.createElement("div");
    el.className = "msg";
    el.innerHTML = `<b>${clean(name)}</b><span>${time}</span><p>${clean(text)}</p>`;
    messages.appendChild(el);
    messages.scrollTop = messages.scrollHeight;
  }
  function setMainState(title, text){ modeTitle.textContent = title; modeText.textContent = text; }
  function setStatus(text){ if(connStatus) connStatus.textContent = text; }
  function fail(text){
    joinBtn.disabled = false;
    joinBtn.textContent = "Intentar nuevamente";
    setStatus("Sin conexión");
    alert(text);
  }
  function closePeer(id){
    const item = peers.get(id);
    if(item?.pc) item.pc.close();
    peers.delete(id);
    const audio = $("audio-" + id); if(audio) audio.remove();
  }
  function resetPeers(){
    for(const id of Array.from(peers.keys())) closePeer(id);
  }
  function joinSocketRoom(){
    if(!socket?.connected || !joined) return;
    socket.emit("join-room", { roomId, name: currentName });
    setStatus("Conectado: sincronizando");
  }

  function getSocket(){
    if (socket?.connected) return Promise.resolve(socket);
    return new Promise((resolve, reject) => {
      if (typeof io !== "function") return reject(new Error("Socket.IO no cargó. Este sitio debe publicarse como servidor Node, no como hosting estático."));
      socket = io({ transports:["websocket", "polling"], timeout:12000, reconnection:true, reconnectionAttempts:Infinity, reconnectionDelay:800, reconnectionDelayMax:3500 });
      const timer = setTimeout(() => reject(new Error("No se pudo conectar al servidor de radio.")), 15000);
      socket.on("connect", () => { clearTimeout(timer); resolve(socket); });
      socket.on("connect_error", err => { console.warn("Socket error", err.message); });
      bindSocketEvents();
    });
  }

  let socketEventsBound = false;
  function bindSocketEvents(){
    if(socketEventsBound || !socket) return;
    socketEventsBound = true;

    socket.on("connect", () => {
      mySocketId = socket.id;
      if(joined){
        resetPeers();
        joinSocketRoom();
        addMessage("Sistema", "Conexión recuperada y sincronizada.");
      }
    });

    socket.on("joined", data => {
      mySocketId = data.id || socket.id;
      setStatus("Conectado: escuchando");
      if(Array.isArray(data.users)) renderUsers(data.users);
      if(data.speakerId && data.speakerId !== mySocketId){ lockedByOther = true; currentSpeakerName = data.speakerName || "Otro usuario"; setBusyUI(currentSpeakerName); }
    });

    socket.on("existing-peers", async list => {
      for(const p of list || []) if(p.id !== mySocketId && !peers.has(p.id)) await createPeer(p.id, true);
    });

    socket.on("peer-joined", async ({ id }) => {
      if(joined && id !== mySocketId && !peers.has(id)) await createPeer(id, false);
      setTimeout(() => socket.emit("request-sync"), 500);
    });

    socket.on("signal", async ({ from, data }) => {
      if(!from || from === mySocketId || !data) return;
      let item = peers.get(from);
      if(!item) item = await createPeer(from, false, true);
      const pc = item.pc;
      try{
        if(data.description){
          const offerCollision = data.description.type === "offer" && (item.makingOffer || pc.signalingState !== "stable");
          item.ignoreOffer = !item.polite && offerCollision;
          if(item.ignoreOffer) return;
          await pc.setRemoteDescription(data.description);
          if(data.description.type === "offer"){
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            socket.emit("signal", { to: from, data: { description: pc.localDescription } });
          }
        } else if(data.candidate){
          try{ await pc.addIceCandidate(data.candidate); }catch(e){ if(!item.ignoreOffer) console.warn(e); }
        }
      }catch(e){ console.warn("Signal error", e); }
    });

    socket.on("peer-left", ({ id }) => closePeer(id));
    
    socket.on("peer-speaking", ({ speaking, name }) => { if(speaking) setBusyUI(name || "Alguien"); });
    socket.on("talk-started", ({ id, name }) => {
      currentSpeakerName = name || "Alguien";
      lockedByOther = id !== mySocketId;
      if(lockedByOther) setBusyUI(currentSpeakerName);
      else if(speakerTag) speakerTag.textContent = "Canal libre";
    });
    socket.on("talk-ended", ({ id }) => {
      if(id !== mySocketId){ lockedByOther = false; currentSpeakerName = null; setMainState("Estás escuchando", "Turno libre. Mantén presionado HABLAR para transmitir."); }
    });
    socket.on("room-state", data => {
      if(Array.isArray(data.users)) renderUsers(data.users);
      lockedByOther = !!(data.speakerId && data.speakerId !== mySocketId);
      currentSpeakerName = data.speakerName || null;
      if(lockedByOther) setBusyUI(currentSpeakerName);
      else if(speakerTag) speakerTag.textContent = "Canal libre";
    });
    socket.on("chat", m => addMessage(m.name, m.text, m.time));
    socket.on("disconnect", () => { setStatus("Reconectando..."); resetPeers(); });
    socket.on("reconnect", () => joinSocketRoom());
  }

  function setBusyUI(name){
    setMainState(`${name || "Alguien"} está hablando`, "Audio entrando con efecto radio. Espera a que libere el turno.");
    if(speakerTag) speakerTag.textContent = `TRANSMITIENDO: ${name || "Alguien"}`;
    talkBtn.classList.add("busy");
    talkBtn.querySelector("b").textContent = "OCUPADO";
  }

  function renderUsers(users){
    users = Array.isArray(users) ? users : [];
    if(!users.length){ usersBox.innerHTML = '<div class="empty">Aún no hay oyentes.</div>'; return; }
    usersBox.innerHTML = users.map(u => `<div class="user ${u.speaking ? "speaking" : ""}">
      <div class="avatar">${clean((u.name || "O")[0].toUpperCase())}</div>
      <div><b>${clean(u.name)}${u.id === mySocketId ? " (tú)" : ""}</b><br><small>${u.speaking ? "Hablando ahora" : "Escuchando"}</small></div><i class="pulse"></i></div>`).join("");
  }

  async function start(){
    if(joined) return;
    joinBtn.disabled = true; joinBtn.textContent = "Conectando...";
    try{
      await unlockAudioOutput();
      await getSocket();
      rawMicStream = await navigator.mediaDevices.getUserMedia({ audio:{ echoCancellation:true, noiseSuppression:true, autoGainControl:true }, video:false });
      localStream = await buildRadioFxStream(rawMicStream);
      localStream.getAudioTracks().forEach(t => t.enabled = true);
      injectRadioBurst("end");
      setTimeout(() => localStream.getAudioTracks().forEach(t => t.enabled = false), 220);
      currentName = nameInput.value.trim() || "Oyente";
      joined = true;
      joinPanel.classList.add("hidden"); radioPanel.classList.remove("hidden");
      joinSocketRoom();
      addMessage("Sistema", "Conectado correctamente. Mantén presionado HABLAR para transmitir.");
      setInterval(() => { if(socket?.connected && joined) socket.emit("request-sync"); }, 2500);
    }catch(e){
      console.error(e);
      fail(e.message.includes("Socket.IO") ? "Esta versión debe estar montada como Web Service Node/Socket.IO." : "Activa el micrófono y entra desde HTTPS. Luego vuelve a intentar.");
    }
  }

  async function createPeer(peerId, initiator, politeOverride){
    const polite = politeOverride ?? (String(mySocketId || socket.id) > String(peerId));
    const item = { pc: new RTCPeerConnection(rtcConfig), makingOffer:false, ignoreOffer:false, polite };
    const pc = item.pc;
    peers.set(peerId, item);
    if(localStream) localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    pc.onicecandidate = e => { if(e.candidate) socket.emit("signal", { to: peerId, data: { candidate: e.candidate } }); };
    pc.ontrack = e => {
      let audio = $("audio-" + peerId);
      if(!audio){ audio = document.createElement("audio"); audio.id = "audio-" + peerId; audio.autoplay = true; audio.playsInline = true; document.body.appendChild(audio); }
      audio.srcObject = e.streams[0]; forceAudioPlay(audio);
    };
    pc.onconnectionstatechange = () => {
      if(["failed", "disconnected", "closed"].includes(pc.connectionState)) setTimeout(() => {
        const current = peers.get(peerId);
        if(current?.pc === pc && pc.connectionState !== "connected") closePeer(peerId);
      }, 5000);
    };
    if(initiator){
      try{
        item.makingOffer = true;
        const offer = await pc.createOffer({ offerToReceiveAudio:true });
        await pc.setLocalDescription(offer);
        socket.emit("signal", { to: peerId, data: { description: pc.localDescription } });
      } finally { item.makingOffer = false; }
    }
    return item;
  }

  function setSpeaking(on){
    if(!localStream || !joined || !socket?.connected) return;

    if(on){
      if(lockedByOther){
        setBusyUI(currentSpeakerName || "Otro usuario");
        return;
      }
      socket.timeout(2500).emit("request-talk", (err, res) => {
        if(err || !res?.ok){
          lockedByOther = !!res?.busy;
          currentSpeakerName = res?.speakerName || currentSpeakerName || "Otro usuario";
          setBusyUI(currentSpeakerName);
          return;
        }
        if(audioCtx?.state === "suspended") audioCtx.resume().catch(()=>{});
        localStream.getAudioTracks().forEach(t => t.enabled = true);
        injectRadioBurst("start");
        talkBtn.classList.remove("busy");
        talkBtn.classList.add("speaking");
        talkBtn.querySelector("b").textContent = "TRANSMITIENDO";
        setMainState("Te están escuchando", "Suelta el botón para liberar el turno.");
        socket.emit("speaking", true);
        if(speakerTag) speakerTag.textContent = "TÚ ESTÁS TRANSMITIENDO";
      });
      return;
    }

    localStream.getAudioTracks().forEach(t => t.enabled = true);
      injectRadioBurst("end");
      setTimeout(() => localStream.getAudioTracks().forEach(t => t.enabled = false), 220);
    talkBtn.classList.remove("speaking", "busy");
    talkBtn.querySelector("b").textContent = "HABLAR";
    setMainState("Estás escuchando", "Cuando alguien hable, lo escucharás automáticamente con efecto radio.");
    if(speakerTag) speakerTag.textContent = "Canal libre";
    socket.emit("speaking", false);
    socket.emit("release-talk");
  }

  if(unlockBtn) unlockBtn.addEventListener("click", unlockAudioOutput);
  document.addEventListener("visibilitychange", () => { if(!document.hidden && joined) { unlockAudioOutput(); joinSocketRoom(); } });
  joinBtn.addEventListener("click", start);
  ["mousedown","touchstart","pointerdown"].forEach(ev => talkBtn.addEventListener(ev, e => { e.preventDefault(); setSpeaking(true); }, {passive:false}));
  ["mouseup","mouseleave","touchend","touchcancel","pointerup","pointercancel"].forEach(ev => talkBtn.addEventListener(ev, e => { e.preventDefault(); setSpeaking(false); }, {passive:false}));
  window.addEventListener("keydown", e => { if(e.code === "Space" && !e.repeat && !["INPUT","TEXTAREA"].includes(document.activeElement.tagName)) setSpeaking(true); });
  window.addEventListener("keyup", e => { if(e.code === "Space" && !["INPUT","TEXTAREA"].includes(document.activeElement.tagName)) setSpeaking(false); });
  function sendChat(){ const text = chatInput.value.trim(); if(!text || !socket?.connected) return; socket.emit("chat", text); chatInput.value = ""; }
  sendBtn.onclick = sendChat; chatInput.addEventListener("keydown", e => { if(e.key === "Enter") sendChat(); });
  muteBtn.onclick = () => { mutedOutput = !mutedOutput; document.querySelectorAll("audio").forEach(a => { a.muted = mutedOutput; a.volume = 1; if(!mutedOutput) forceAudioPlay(a); }); muteBtn.textContent = mutedOutput ? "Activar salida" : "Silenciar salida"; };
  async function copyLink(){ const url = location.origin + "/s/" + roomId; await navigator.clipboard.writeText(url); addMessage("Sistema", "Enlace copiado."); }
  copyBtn.onclick = copyLink;
  shareBtn.onclick = async () => { const url = location.origin + "/s/" + roomId; if(navigator.share) await navigator.share({ title:"Radio Teléfono Gases de Belén", url }); else await copyLink(); };
})();
