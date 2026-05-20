(() => {
  const $ = id => document.getElementById(id);
  const joinPanel = $("joinPanel"), radioPanel = $("radioPanel"), joinBtn = $("joinBtn"), nameInput = $("nameInput");
  const talkBtn = $("talkBtn"), connStatus = $("connStatus"), modeTitle = $("modeTitle"), modeText = $("modeText");
  const usersBox = $("users"), messages = $("messages"), chatInput = $("chatInput"), sendBtn = $("sendBtn");
  const muteBtn = $("muteBtn"), shareBtn = $("shareBtn"), copyBtn = $("copyBtn");

  let socket = null;
  let localStream = null;
  let mutedOutput = false;
  let joined = false;
  const roomId = location.pathname.startsWith("/s/") ? decodeURIComponent(location.pathname.split("/s/")[1] || "gases-belen") : "gases-belen";
  const peers = new Map();
  const rtcConfig = { iceServers: [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:global.stun.twilio.com:3478" }
  ]};

  function clean(s){ return String(s || "").replace(/[&<>"']/g, m => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[m])); }
  function addMessage(name, text, time = new Date().toLocaleTimeString("es-CO", {hour:"2-digit", minute:"2-digit"})){
    const el = document.createElement("div");
    el.className = "msg";
    el.innerHTML = `<b>${clean(name)}</b><span>${time}</span><p>${clean(text)}</p>`;
    messages.appendChild(el);
    messages.scrollTop = messages.scrollHeight;
  }
  function setMainState(title, text){ modeTitle.textContent = title; modeText.textContent = text; }
  function fail(text){
    joinBtn.disabled = false;
    joinBtn.textContent = "Intentar nuevamente";
    connStatus && (connStatus.textContent = "Sin conexión");
    alert(text);
  }
  function getSocket(){
    if (socket?.connected) return Promise.resolve(socket);
    return new Promise((resolve, reject) => {
      if (typeof io !== "function") return reject(new Error("Socket.IO no cargó. Este sitio debe publicarse como servidor Node, no como hosting estático."));
      socket = io({ transports:["websocket", "polling"], timeout:9000, reconnection:true, reconnectionAttempts:10 });
      const timer = setTimeout(() => reject(new Error("No se pudo conectar al servidor de radio.")), 10000);
      socket.on("connect", () => { clearTimeout(timer); resolve(socket); });
      socket.on("connect_error", err => { console.warn("Socket error", err.message); });
      bindSocketEvents();
    });
  }
  let socketEventsBound = false;
  function bindSocketEvents(){
    if(socketEventsBound || !socket) return;
    socketEventsBound = true;
    socket.on("existing-peers", async list => { for(const p of list) if(!peers.has(p.id)) await createPeer(p.id, true); });
    socket.on("peer-joined", async ({ id }) => { if(joined && !peers.has(id)) await createPeer(id, false); });
    socket.on("signal", async ({ from, data }) => {
      let pc = peers.get(from);
      if(!pc) pc = await createPeer(from, false);
      if(data.description){
        await pc.setRemoteDescription(data.description);
        if(data.description.type === "offer"){
          const answer = await pc.createAnswer();
          await pc.setLocalDescription(answer);
          socket.emit("signal", { to: from, data: { description: pc.localDescription } });
        }
      } else if(data.candidate){
        try{ await pc.addIceCandidate(data.candidate); }catch(_){ }
      }
    });
    socket.on("peer-left", ({ id }) => {
      const pc = peers.get(id); if(pc) pc.close(); peers.delete(id);
      const audio = $("audio-" + id); if(audio) audio.remove();
    });
    socket.on("room-users", users => {
      if(!users.length){ usersBox.innerHTML = '<div class="empty">Aún no hay oyentes.</div>'; return; }
      usersBox.innerHTML = users.map(u => `<div class="user ${u.speaking ? "speaking" : ""}">
        <div class="avatar">${clean((u.name || "O")[0].toUpperCase())}</div>
        <div><b>${clean(u.name)}</b><br><small>${u.speaking ? "Hablando ahora" : "Escuchando"}</small></div><i class="pulse"></i></div>`).join("");
    });
    socket.on("peer-speaking", ({ speaking }) => setMainState(speaking ? "Alguien está hablando" : "Estás escuchando", speaking ? "Escuchas el audio en vivo automáticamente." : "Cuando alguien hable, lo escucharás automáticamente."));
    socket.on("chat", m => addMessage(m.name, m.text, m.time));
    socket.on("disconnect", () => { connStatus.textContent = "Reconectando..."; });
    socket.on("connect", () => { if(joined) connStatus.textContent = "Conectado: escuchando"; });
  }

  async function start(){
    if(joined) return;
    joinBtn.disabled = true; joinBtn.textContent = "Conectando...";
    try{
      await getSocket();
      localStream = await navigator.mediaDevices.getUserMedia({ audio:{ echoCancellation:true, noiseSuppression:true, autoGainControl:true }, video:false });
      localStream.getAudioTracks().forEach(t => t.enabled = false);
      joined = true;
      joinPanel.classList.add("hidden"); radioPanel.classList.remove("hidden");
      connStatus.textContent = "Conectado: escuchando";
      socket.emit("join-room", { roomId, name: nameInput.value.trim() || "Oyente" });
      addMessage("Sistema", "Conectado correctamente. Mantén presionado HABLAR para transmitir.");
    }catch(e){
      console.error(e);
      fail(e.message.includes("Socket.IO") ? "El botón no entra porque esta versión está montada en hosting estático. Súbela como servidor Node/Socket.IO para que funcione la radio en vivo." : "Activa el micrófono y entra desde HTTPS. Luego vuelve a intentar.");
    }
  }

  async function createPeer(peerId, initiator){
    const pc = new RTCPeerConnection(rtcConfig);
    peers.set(peerId, pc);
    if(localStream) localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    pc.onicecandidate = e => { if(e.candidate) socket.emit("signal", { to: peerId, data: { candidate: e.candidate } }); };
    pc.ontrack = e => {
      let audio = $("audio-" + peerId);
      if(!audio){ audio = document.createElement("audio"); audio.id = "audio-" + peerId; audio.autoplay = true; audio.playsInline = true; document.body.appendChild(audio); }
      audio.srcObject = e.streams[0]; audio.muted = mutedOutput; audio.play().catch(()=>{});
    };
    if(initiator){ const offer = await pc.createOffer(); await pc.setLocalDescription(offer); socket.emit("signal", { to: peerId, data: { description: pc.localDescription } }); }
    return pc;
  }
  function setSpeaking(on){
    if(!localStream || !joined) return;
    localStream.getAudioTracks().forEach(t => t.enabled = on);
    talkBtn.classList.toggle("speaking", on);
    talkBtn.querySelector("b").textContent = on ? "TRANSMITIENDO" : "HABLAR";
    setMainState(on ? "Te están escuchando" : "Estás escuchando", on ? "Suelta el botón para dejar de transmitir." : "Cuando alguien hable, lo escucharás automáticamente.");
    socket.emit("speaking", on);
  }
  joinBtn.addEventListener("click", start);
  ["mousedown","touchstart","pointerdown"].forEach(ev => talkBtn.addEventListener(ev, e => { e.preventDefault(); setSpeaking(true); }, {passive:false}));
  ["mouseup","mouseleave","touchend","touchcancel","pointerup","pointercancel"].forEach(ev => talkBtn.addEventListener(ev, e => { e.preventDefault(); setSpeaking(false); }, {passive:false}));
  window.addEventListener("keydown", e => { if(e.code === "Space" && !e.repeat && !["INPUT","TEXTAREA"].includes(document.activeElement.tagName)) setSpeaking(true); });
  window.addEventListener("keyup", e => { if(e.code === "Space" && !["INPUT","TEXTAREA"].includes(document.activeElement.tagName)) setSpeaking(false); });
  function sendChat(){ const text = chatInput.value.trim(); if(!text || !socket?.connected) return; socket.emit("chat", text); chatInput.value = ""; }
  sendBtn.onclick = sendChat; chatInput.addEventListener("keydown", e => { if(e.key === "Enter") sendChat(); });
  muteBtn.onclick = () => { mutedOutput = !mutedOutput; document.querySelectorAll("audio").forEach(a => a.muted = mutedOutput); muteBtn.textContent = mutedOutput ? "Activar salida" : "Silenciar salida"; };
  async function copyLink(){ const url = location.origin + "/s/" + roomId; await navigator.clipboard.writeText(url); addMessage("Sistema", "Enlace copiado."); }
  copyBtn.onclick = copyLink;
  shareBtn.onclick = async () => { const url = location.origin + "/s/" + roomId; if(navigator.share) await navigator.share({ title:"Radio Teléfono Gases de Belén", url }); else await copyLink(); };
})();
