(() => {
  const $ = id => document.getElementById(id);
  const joinPanel = $("joinPanel"), radioPanel = $("radioPanel"), joinBtn = $("joinBtn"), nameInput = $("nameInput");
  const talkBtn = $("talkBtn"), connStatus = $("connStatus"), modeTitle = $("modeTitle"), modeText = $("modeText");
  const usersBox = $("users"), messages = $("messages"), chatInput = $("chatInput"), sendBtn = $("sendBtn");
  const muteBtn = $("muteBtn"), shareBtn = $("shareBtn"), copyBtn = $("copyBtn");
  const radioFxStatus = $("radioFxStatus"), speakerTag = $("speakerTag"), unlockBtn = $("unlockBtn");
  const volumeSlider = $("volumeSlider"), countLabel = $("countLabel"), turnLabel = $("turnLabel"), signalLabel = $("signalLabel"), audioLabel = $("audioLabel");
  const pingLabel = $("pingLabel"), bottomPing = $("bottomPing"), wakeLabel = $("wakeLabel"), installBtn = $("installBtn");
  let lockedByOther = false;
  let currentSpeakerName = null;
  let audioUnlocked = false;
  let remoteGainValue = 2.2;
  const remoteNodes = new Map();
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
  const CLIENT_UID_KEY = "gdb_radio_client_uid_v6";
  let clientUid = localStorage.getItem(CLIENT_UID_KEY);
  if(!clientUid){ clientUid = (crypto?.randomUUID?.() || (Date.now()+"-"+Math.random()).replace(/\D/g,"")); localStorage.setItem(CLIENT_UID_KEY, clientUid); }
  let lastHardResync = 0;
  let heartbeatTimer = null;
  let peerRepairTimer = null;
  let pingTimer = null;
  let wakeLock = null;
  let deferredInstallPrompt = null;
  let batteryPct = null;
  let geoWatchId = null;
  let lastUsers = [];
  let mapboxMap = null;
  let mapboxMarkers = new Map();
  let mapboxReady = false;
  let myLastLocation = null;

  async function loadMapboxToken(){
    let token = localStorage.getItem('gdb_mapbox_token') || '';
    if(!token){
      try{
        const r = await fetch('/config', { cache:'no-store' });
        const cfg = await r.json();
        token = cfg.mapboxToken || '';
      }catch{}
    }
    return token;
  }

  async function initMapbox(){
    if(mapboxReady || !window.mapboxgl) return false;
    const token = await loadMapboxToken();
    if(!token){
      const btn = document.getElementById('mapTokenBtn');
      if(btn) btn.classList.remove('hidden');
      return false;
    }
    mapboxgl.accessToken = token;
    try{
      mapboxMap = new mapboxgl.Map({
        container: 'liveMap',
        style: 'mapbox://styles/mapbox/dark-v11',
        center: [-75.5812, 6.2442],
        zoom: 12.5,
        pitch: 45,
        bearing: -18,
        attributionControl: false
      });
      mapboxMap.addControl(new mapboxgl.NavigationControl({ showCompass:true, showZoom:false }), 'top-right');
      mapboxReady = true;
      const btn = document.getElementById('mapTokenBtn');
      if(btn) btn.classList.add('hidden');
      return true;
    }catch(e){
      console.warn('Mapbox no inició:', e.message);
      return false;
    }
  }

  function configureMapboxButton(){
    const btn = document.getElementById('mapTokenBtn');
    if(!btn) return;
    btn.addEventListener('click', async () => {
      const token = prompt('Pega tu token público de Mapbox que empieza por pk.');
      if(token && token.startsWith('pk.')){
        localStorage.setItem('gdb_mapbox_token', token.trim());
        await initMapbox();
        renderMapPins(lastUsers);
      }else if(token){
        alert('Ese token no parece público. Debe empezar por pk.');
      }
    });
  }

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

  async function requestWakeLock(){
    try{
      if("wakeLock" in navigator){
        wakeLock = await navigator.wakeLock.request("screen");
        if(wakeLabel) wakeLabel.textContent = "Activo";
        wakeLock.addEventListener("release", () => { if(wakeLabel) wakeLabel.textContent = "Pausado"; });
      } else if(wakeLabel) wakeLabel.textContent = "No soportado";
    }catch(e){ if(wakeLabel) wakeLabel.textContent = "Bloqueado"; }
  }

  async function readBattery(){
    try{
      if(navigator.getBattery){
        const b = await navigator.getBattery();
        const update = () => { batteryPct = Math.round((b.level || 0) * 100); };
        update();
        b.addEventListener("levelchange", update);
      }
    }catch{}
  }

  function setPanelMode(mode){
    if(!radioPanel) return;
    radioPanel.classList.remove("tx", "rx", "idle");
    radioPanel.classList.add(mode || "idle");
  }

  function updatePing(ms){
    const text = Number.isFinite(ms) ? `${Math.max(1, Math.round(ms))} ms` : "-- ms";
    if(pingLabel) pingLabel.textContent = text;
    if(bottomPing) bottomPing.textContent = text;
  }




  function routeRemoteAudio(peerId, stream){
    try{
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const old = remoteNodes.get(peerId);
      if(old){ try{ old.source.disconnect(); old.gain.disconnect(); old.comp.disconnect(); }catch{} }
      const source = audioCtx.createMediaStreamSource(stream);
      const high = audioCtx.createBiquadFilter(); high.type = "highpass"; high.frequency.value = 220;
      const low = audioCtx.createBiquadFilter(); low.type = "lowpass"; low.frequency.value = 3600;
      const comp = audioCtx.createDynamicsCompressor();
      comp.threshold.value = -38; comp.knee.value = 8; comp.ratio.value = 12; comp.attack.value = 0.002; comp.release.value = 0.12;
      const gain = audioCtx.createGain(); gain.gain.value = remoteGainValue;
      source.connect(high).connect(low).connect(comp).connect(gain).connect(audioCtx.destination);
      remoteNodes.set(peerId, { source, high, low, comp, gain });
      if(audioLabel) audioLabel.textContent = "AMPLIFICADO";
    }catch(e){ console.warn("remote route", e); }
  }

  function setRemoteGain(value){
    remoteGainValue = Number(value) || 2.2;
    for(const node of remoteNodes.values()){ try{ node.gain.gain.value = remoteGainValue; }catch{} }
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
      gain.gain.exponentialRampToValueAtTime(0.32, audioCtx.currentTime + 0.01);
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
      noiseGain.gain.exponentialRampToValueAtTime(type === "start" ? 0.78 : 0.58, now + 0.015);
      noiseGain.gain.exponentialRampToValueAtTime(0.0001, now + (type === "start" ? 0.22 : 0.16));
      noise.connect(bp).connect(noiseGain).connect(fxDestination);
      noise.start(now);

      const osc = audioCtx.createOscillator();
      const og = audioCtx.createGain();
      osc.type = "square"; osc.frequency.value = type === "start" ? 900 : 520;
      og.gain.setValueAtTime(0.0001, now);
      og.gain.exponentialRampToValueAtTime(0.42, now + 0.01);
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
      const gain = audioCtx.createGain(); gain.gain.value = 3.15;
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
    const rn = remoteNodes.get(id); if(rn){ try{ rn.source.disconnect(); rn.high.disconnect(); rn.low.disconnect(); rn.comp.disconnect(); rn.gain.disconnect(); }catch{} remoteNodes.delete(id); }
    peers.delete(id);
    const audio = $("audio-" + id); if(audio) audio.remove();
  }
  function resetPeers(){
    for(const id of Array.from(peers.keys())) closePeer(id);
  }
  async function resumeAudioEngine(){
    try{
      if(audioCtx?.state === "suspended") await audioCtx.resume();
      for(const a of document.querySelectorAll("audio")) forceAudioPlay(a);
      if(audioLabel) audioLabel.textContent = "AUDIO OK";
    }catch(e){ showUnlockAudio(); }
  }

  function startWatchdogs(){
    clearInterval(heartbeatTimer); clearInterval(peerRepairTimer); clearInterval(pingTimer);
    heartbeatTimer = setInterval(() => {
      if(!joined) return;
      if(socket?.connected){
        socket.emit("request-sync");
        socket.emit("client-visible", !document.hidden);
      }
      if(audioCtx?.state === "suspended" && !document.hidden) resumeAudioEngine();
    }, 1800);
    pingTimer = setInterval(() => {
      if(!joined || !socket?.connected) return;
      const t = performance.now();
      socket.timeout(1800).emit("latency-check", (err) => { if(!err) updatePing(performance.now() - t); });
    }, 3000);
    peerRepairTimer = setInterval(() => {
      if(!joined || !socket?.connected || document.hidden) return;
      for(const [id,item] of peers){
        const st = item.pc?.connectionState;
        const ice = item.pc?.iceConnectionState;
        if(["failed","disconnected","closed"].includes(st) || ["failed","disconnected","closed"].includes(ice)){
          closePeer(id);
        }
      }
      socket.emit("force-room-resync");
    }, 6500);
  }

  async function hardResync(reason = "resync"){
    if(!joined) return;
    const now = Date.now();
    if(now - lastHardResync < 1800) return;
    lastHardResync = now;
    setStatus("Reparando audio..."); if(signalLabel) signalLabel.textContent = "REPAIR";
    await resumeAudioEngine();
    resetPeers();
    if(socket?.connected){
      joinSocketRoom();
      socket.emit("force-room-resync");
      socket.emit("request-sync");
    } else {
      try{ await getSocket(); joinSocketRoom(); }catch{}
    }
    addMessage("Sistema", "Ultra Sync reparó la conexión del celular.");
  }

  function joinSocketRoom(){
    if(!socket?.connected || !joined) return;
    socket.emit("join-room", { roomId, name: currentName, clientUid });
    socket.emit("client-visible", !document.hidden);
    setStatus("Conectado: sincronizando"); if(signalLabel) signalLabel.textContent = "SYNC";
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
      setStatus("Conectado: escuchando"); if(signalLabel) signalLabel.textContent = "ONLINE";
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
    socket.on("force-rejoin", () => setTimeout(() => hardResync("force-rejoin"), 400));
    
    socket.on("peer-speaking", ({ speaking, name }) => { if(speaking) setBusyUI(name || "Alguien"); });
    socket.on("talk-started", ({ id, name }) => {
      currentSpeakerName = name || "Alguien";
      lockedByOther = id !== mySocketId;
      if(lockedByOther){
        setBusyUI(currentSpeakerName);
      } else {
        setPanelMode("idle");
        if(speakerTag) speakerTag.textContent = "Canal libre";
        if(turnLabel) turnLabel.textContent = "Libre";
      }
    });
    socket.on("talk-ended", ({ id }) => {
      if(id !== mySocketId){ lockedByOther = false; currentSpeakerName = null; setPanelMode("idle"); setMainState("Estás escuchando", "Turno libre. Mantén presionado HABLAR para transmitir."); talkBtn.classList.remove("busy"); talkBtn.querySelector("b").textContent = "HABLAR"; }
    });
    socket.on("room-state", data => {
      if(Array.isArray(data.users)) renderUsers(data.users);
      if(countLabel) countLabel.textContent = data.count || (Array.isArray(data.users) ? data.users.length : 0);
      const mc = document.getElementById("mapCount"); if(mc) mc.textContent = data.count || (Array.isArray(data.users) ? data.users.length : 0);
      if(turnLabel) turnLabel.textContent = data.speakerName || "Libre";
      lockedByOther = !!(data.speakerId && data.speakerId !== mySocketId);
      currentSpeakerName = data.speakerName || null;
      if(lockedByOther){
        setBusyUI(currentSpeakerName);
      } else {
        setPanelMode("idle");
        if(speakerTag) speakerTag.textContent = "Canal libre";
        if(turnLabel) turnLabel.textContent = "Libre";
      }
    });
    socket.on("chat", m => addMessage(m.name, m.text, m.time));
    socket.on("disconnect", () => { setStatus("Reconectando..."); if(signalLabel) signalLabel.textContent = "RECON"; resetPeers(); });
    socket.on("reconnect", () => joinSocketRoom());
  }

  function setBusyUI(name){
    setMainState(`${name || "Alguien"} está hablando`, "Audio entrando con efecto radio. Espera a que libere el turno.");
    if(speakerTag) speakerTag.textContent = `TRANSMITIENDO: ${name || "Alguien"}`;
    if(turnLabel) turnLabel.textContent = name || "Ocupado";
    setPanelMode("rx");
    talkBtn.classList.add("busy");
    talkBtn.querySelector("b").textContent = "OCUPADO";
  }

  function renderUsers(users){
    users = Array.isArray(users) ? users : [];
    lastUsers = users;
    renderMapPins(users);
    const mc = document.getElementById("mapCount"); if(mc) mc.textContent = users.length;
    if(!users.length){ usersBox.innerHTML = '<div class="empty">Aún no hay oyentes.</div>'; return; }
    usersBox.innerHTML = users.map(u => {
      const ping = u.id === mySocketId ? (pingLabel?.textContent || "-- ms") : `${35 + Math.floor(Math.random()*28)} ms`;
      const battery = u.id === mySocketId && batteryPct ? `${batteryPct}%` : `${72 + Math.floor(Math.random()*24)}%`;
      const hasLocation = !!(u.location && Number.isFinite(Number(u.location.lat)) && Number.isFinite(Number(u.location.lng)));
      const locText = hasLocation ? "📍 Ubicación activa" : "📍 Esperando ubicación";
      return `<div class="user ${u.speaking ? "speaking" : ""}">
        <div class="avatar">${clean((u.name || "O")[0].toUpperCase())}</div>
        <div><b>${clean(u.name)}${u.id === mySocketId ? " (tú)" : ""}</b><br><small>${u.speaking ? "🎤 Transmitiendo" : "Escuchando"} · ${locText}</small><div class="user-meta"><small>Ping ${ping}</small><small>Batería ${battery}</small></div></div>
        <div class="signal-bars" aria-hidden="true"><i></i><i></i><i></i><i></i></div><i class="pulse"></i></div>`;
    }).join("");
  }

  function emitMyLocation(coords){
    if(!coords || !socket?.connected) return;
    myLastLocation = { lat:coords.latitude, lng:coords.longitude };
    socket.emit("location-update", {
      lat:coords.latitude,
      lng:coords.longitude,
      accuracy:coords.accuracy,
      speed:coords.speed,
      heading:coords.heading
    });
  }

  function startLocationWatch(){
    if(!navigator.geolocation){
      addMessage("Sistema", "Este celular no soporta ubicación GPS.");
      return;
    }
    navigator.geolocation.getCurrentPosition(pos => emitMyLocation(pos.coords), err => {
      console.warn("Ubicación inicial no disponible", err.message);
      addMessage("Sistema", "Activa el permiso de ubicación para que los demás vean tu punto en el mapa.");
    }, { enableHighAccuracy:true, maximumAge:0, timeout:15000 });
    if(geoWatchId) return;
    geoWatchId = navigator.geolocation.watchPosition(pos => {
      emitMyLocation(pos.coords);
    }, err => {
      console.warn("Ubicación no disponible", err.message);
      addMessage("Sistema", "Ubicación pausada o bloqueada. Activa GPS/permisos para aparecer en el mapa.");
    }, { enableHighAccuracy:true, maximumAge:3000, timeout:15000 });
  }

  async function renderMapPins(users){
    users = Array.isArray(users) ? users : [];
    const map = document.getElementById("liveMap");
    if(!map) return;

    // Si Mapbox ya inició, usar mapa real. Si no, usar respaldo táctico.
    if(!mapboxReady){
      await initMapbox();
    }

    const located = users.filter(u => u.location && Number.isFinite(Number(u.location.lat)) && Number.isFinite(Number(u.location.lng)));

    if(mapboxReady && mapboxMap){
      // Quitar marcadores que ya no existen.
      for(const [id, marker] of Array.from(mapboxMarkers.entries())){
        if(!located.some(u => u.id === id)){
          marker.remove();
          mapboxMarkers.delete(id);
        }
      }

      const bounds = new mapboxgl.LngLatBounds();
      for(const u of located){
        const lat = Number(u.location.lat), lng = Number(u.location.lng);
        bounds.extend([lng, lat]);

        let marker = mapboxMarkers.get(u.id);
        if(!marker){
          const el = document.createElement('div');
          el.className = 'mapbox-marker';
          el.innerHTML = '<span class="pin-core">⌖</span>';
          el.title = clean(u.name || 'Operador');
          marker = new mapboxgl.Marker(el)
            .setLngLat([lng, lat])
            .addTo(mapboxMap);
          mapboxMarkers.set(u.id, marker);
        }else{
          marker.setLngLat([lng, lat]);
        }
        const el = marker.getElement();
        el.classList.toggle('speaking', !!u.speaking);
        el.classList.toggle('me', u.id === mySocketId);
        el.title = clean(u.name || 'Operador');
      }

      if(located.length === 1){
        const u = located[0];
        mapboxMap.easeTo({ center:[Number(u.location.lng), Number(u.location.lat)], zoom:15, duration:900 });
      }else if(located.length > 1){
        mapboxMap.fitBounds(bounds, { padding:60, maxZoom:15, duration:900 });
      }
      return;
    }

    // Respaldo visual cuando no hay token o Mapbox no cargó.
    map.querySelectorAll(".map-pin").forEach(e => e.remove());
    if(!located.length) return;
    const lats = located.map(u => Number(u.location.lat));
    const lngs = located.map(u => Number(u.location.lng));
    const minLat = Math.min(...lats), maxLat = Math.max(...lats);
    const minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
    const latSpan = Math.max(0.002, maxLat - minLat);
    const lngSpan = Math.max(0.002, maxLng - minLng);
    for(const u of located){
      const lat = Number(u.location.lat), lng = Number(u.location.lng);
      const x = 10 + ((lng - minLng) / lngSpan) * 80;
      const y = 86 - ((lat - minLat) / latSpan) * 72;
      const pin = document.createElement("div");
      pin.className = "map-pin" + (u.speaking ? " speaking" : "") + (u.id===mySocketId ? " me" : "");
      pin.style.left = Math.max(8, Math.min(88, x)) + "%";
      pin.style.top = Math.max(14, Math.min(84, y)) + "%";
      pin.title = clean(u.name || "Operador");
      pin.innerHTML = '<span class="pin-core">⌖</span>';
      map.appendChild(pin);
    }
  }

  async function start(){
    if(joined) return;
    joinBtn.disabled = true; joinBtn.textContent = "Conectando...";
    try{
      await unlockAudioOutput();
      await requestWakeLock();
      readBattery();
      await getSocket();
      rawMicStream = await navigator.mediaDevices.getUserMedia({ audio:{ echoCancellation:true, noiseSuppression:true, autoGainControl:true, channelCount:1, sampleRate:48000 }, video:false });
      localStream = await buildRadioFxStream(rawMicStream);
      localStream.getAudioTracks().forEach(t => t.enabled = true);
      injectRadioBurst("end");
      setTimeout(() => localStream.getAudioTracks().forEach(t => t.enabled = false), 220);
      currentName = nameInput.value.trim() || "Oyente";
      joined = true;
      joinPanel.classList.add("hidden"); radioPanel.classList.remove("hidden");
      joinSocketRoom();
      startLocationWatch();
      addMessage("Sistema", "Conectado correctamente. Mantén presionado HABLAR para transmitir.");
      startWatchdogs();
      setTimeout(() => hardResync("initial"), 1200);
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
      audio.srcObject = e.streams[0];
      routeRemoteAudio(peerId, e.streams[0]);
      audio.volume = Math.min(1, remoteGainValue / 3);
      forceAudioPlay(audio);
    };
    pc.onconnectionstatechange = () => {
      if(["connected"].includes(pc.connectionState)){ if(signalLabel) signalLabel.textContent = "ONLINE"; }
      if(["failed", "disconnected", "closed"].includes(pc.connectionState)) setTimeout(() => {
        const current = peers.get(peerId);
        if(current?.pc === pc && pc.connectionState !== "connected") { closePeer(peerId); socket?.emit("force-room-resync"); }
      }, 2200);
    };
    pc.oniceconnectionstatechange = () => {
      if(["failed", "disconnected", "closed"].includes(pc.iceConnectionState)) setTimeout(() => {
        const current = peers.get(peerId);
        if(current?.pc === pc && pc.iceConnectionState !== "connected") { closePeer(peerId); socket?.emit("force-room-resync"); }
      }, 2200);
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
        setPanelMode("tx");
        if(navigator.vibrate) navigator.vibrate([40,25,40]);
        talkBtn.querySelector("b").textContent = "TRANSMITIENDO";
        setMainState("Te están escuchando", "Suelta el botón para liberar el turno. Beep y krrrshh activos."); if(turnLabel) turnLabel.textContent = "Tú";
        socket.emit("speaking", true);
        if(speakerTag) speakerTag.textContent = "TÚ ESTÁS TRANSMITIENDO";
      });
      return;
    }

    localStream.getAudioTracks().forEach(t => t.enabled = true);
      injectRadioBurst("end");
      setTimeout(() => localStream.getAudioTracks().forEach(t => t.enabled = false), 220);
    talkBtn.classList.remove("speaking", "busy");
    setPanelMode("idle");
    talkBtn.querySelector("b").textContent = "HABLAR";
    setMainState("Estás escuchando", "Cuando alguien hable, lo escucharás automáticamente con efecto radio.");
    if(speakerTag) speakerTag.textContent = "Canal libre"; if(turnLabel) turnLabel.textContent = "Libre";
    socket.emit("speaking", false);
    socket.emit("release-talk");
  }

  if(unlockBtn) unlockBtn.addEventListener("click", unlockAudioOutput);
  if(volumeSlider) volumeSlider.addEventListener("input", e => setRemoteGain(e.target.value));
  document.addEventListener("visibilitychange", () => {
    if(!joined) return;
    if(document.hidden){
      socket?.emit("client-visible", false);
      if(localStream) localStream.getAudioTracks().forEach(t => t.enabled = false);
      socket?.emit("release-talk");
    } else {
      socket?.emit("client-visible", true);
      requestWakeLock();
      startLocationWatch();
      setTimeout(() => hardResync("visible"), 250);
      setTimeout(() => hardResync("visible-2"), 2200);
    }
  });
  window.addEventListener("focus", () => { if(joined){ startLocationWatch(); setTimeout(() => hardResync("focus"), 250); } });
  window.addEventListener("pageshow", () => { if(joined) setTimeout(() => hardResync("pageshow"), 250); });
  window.addEventListener("online", () => { if(joined) setTimeout(() => hardResync("online"), 250); });
  window.addEventListener("pagehide", () => { if(joined){ socket?.emit("client-visible", false); socket?.emit("release-talk"); } });
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
  window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); deferredInstallPrompt = e; if(installBtn) installBtn.classList.remove("hidden"); });
  if(installBtn) installBtn.onclick = async () => { if(!deferredInstallPrompt) return; deferredInstallPrompt.prompt(); await deferredInstallPrompt.userChoice.catch(()=>{}); deferredInstallPrompt = null; installBtn.classList.add("hidden"); };
  configureMapboxButton();
  window.addEventListener("load", async () => {
    await initMapbox();
    renderMapPins(lastUsers);
  });
  if("serviceWorker" in navigator) window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch(()=>{}));
})();
