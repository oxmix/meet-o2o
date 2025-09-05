const loc = window.location;
const SIGNALING_URL = (loc.protocol === 'https:' ? 'wss://' : 'ws://') + loc.host + '/ws';
const STUN_SERVERS = [
  ...(loc.host.startsWith('localhost') ? [{urls: 'stun:127.0.0.1:3478'}] : []),
  {urls: 'stun:stun.oxmix.net:13478'},
  {urls: 'stun:stun.cloudflare.com:3478'},
  {urls: 'stun:stun.l.google.com:19302'},
];

const createEl = document.querySelector('.create');
const createBtn = createEl.querySelector('.btn');
const joinEl = document.querySelector('.join');
const joinBtn = joinEl.querySelector('.btn');
const chatEl = document.querySelector('.chat');
const leaveBtn = document.querySelector('.top .leave-btn');
const shareScreen = document.querySelector('.share-screen');
const shareBtn = shareScreen.querySelector('.controls .share-btn');
const shareStopBtn = shareScreen.querySelector('.controls .share-stop-btn');
const localVideo = shareScreen.querySelector('video');
const remoteVideo = document.querySelector('.remote-screen');
const outboundEl = document.querySelector('.stats .outbound .vals');
const inboundEl = document.querySelector('.stats .inbound .vals');
const notifyMsg = document.querySelector('.notify');
const waitingPeer = document.querySelector('.waiting-peer');

const remoteAudio = document.createElement('audio');
remoteAudio.autoplay = true;
remoteAudio.playsInline = true;
remoteAudio.hidden = true;
chatEl.appendChild(remoteAudio);

/* state */
let ws;
let pc = null;
let videoTransceiver = null;
let localStream = new MediaStream();
let micStream = null;
let screenStream = null;
let room = null;
let isJoined = false;
let wsMessageQueue = [];

/* perfect negotiation flags */
let makingOffer = false;
let polite = true;
let ignoreOffer = false;

/* stats */
let statsTimer;
let prevOutbound = {};
let prevInbound = {};

let roomWidth = 1920;
let roomHeight = 1080;
let roomFps = 30;
let roomBitrate = 3110400;
let roomCodec = 'H264'

function calcBitrate() {
  roomBitrate = roomWidth * roomHeight * roomFps * .065
  let mb = roomBitrate / 1000 / 1000
  document.querySelector('.rec-bandwidth span').textContent = mb > 1
    ? Math.round(mb) + ' Mb/s'
    : Math.round(mb * 1000) + ' Kb/s'
}

document.querySelector('#select-resolution').addEventListener('change', (e) => {
  [roomWidth, roomHeight] = e.target.value.split('x').map(parseFloat)
  calcBitrate()
});
document.querySelector('#select-fps').addEventListener('change', (e) => {
  roomFps = +e.target.value
  calcBitrate()
});
document.querySelector('#select-codec').addEventListener('change', (e) => {
  roomCodec = e.target.value
  calcBitrate()
});

remoteVideo.addEventListener('dblclick', function () {
  if (!document.fullscreenElement) {
    remoteVideo.requestFullscreen().catch(err => {
      console.error('Error attempting to enable fullscreen:', err);
    });
  } else {
    document.exitFullscreen();
  }
});

window.addEventListener('pagehide', () => {
  if (!polite && room.length > 0) {
    navigator.sendBeacon('/leave', JSON.stringify({room}));
  }
});

function showNotify(message, cls) {
  notifyMsg.textContent = message;
  notifyMsg.classList.add('show', cls || 'error');
  setTimeout(() => {
    notifyMsg.classList.remove('show', cls || 'error');
  }, 5000);
}

window.onload = async () => {
  room = window.location.pathname.trim().slice(1);

  if (localStorage.getItem('room-created') === room) {
    localStorage.removeItem('room-created')
    history.replaceState(null, null, '/');
    location.href = '/'
    return
  }
  localStorage.removeItem('room-created')

  if (room.length === 16) {
    joinEl.classList.add('show')
  } else {
    createEl.classList.add('show')
  }
}

createBtn.onclick = async () => {
  polite = false // создатель комнаты — инициатор (impolite)
  room = generateCode()
  localStorage.setItem('room-created', room)
  history.replaceState(null, '', `/${room}`)
  createEl.classList.remove('show')
  chatEl.classList.add('show')
  waitingPeer.classList.add('show')
  await connect()
}

joinBtn.onclick = async () => {
  polite = true // присоединившийся — polite
  joinEl.classList.remove('show')
  chatEl.classList.add('show')
  await connect()
}

async function connect() {
  leaveBtn.classList.add('show')
  await initMic()
  connectSignaling()
  createPeerConnection();
}

leaveBtn.onclick = () => {
  sendSignal({type: 'leave'})
  cleanup()
  history.replaceState(null, null, '/');
  location.href = '/'
}

function generateCode(length = 16) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  const array = new Uint8Array(length)
  window.crypto.getRandomValues(array)
  let code = '';
  for (let i = 0; i < length; i++) {
    code += chars[array[i] % chars.length]
  }
  return code
}

async function initMic() {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {echoCancellation: true, noiseSuppression: true, autoGainControl: true}
      // audio: true
    });
    micStream.getTracks().forEach(track => {
      localStream.addTrack(track);
      // если pc уже есть — добавляем в pc
      if (pc) {
        addTrackToPc(track);
      }
    });
    localVideo.srcObject = localStream;
    micEffect();
    console.log('initMic done, localStream tracks:', localStream.getTracks());
  } catch (e) {
    console.warn("mic capture failed", e);
    showNotify("Microphone access is required for this app. Please allow microphone access.");
  }
}

function micEffect() {
  const audioCtx = new AudioContext();
  const source = audioCtx.createMediaStreamSource(micStream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;

  const dataArray = new Uint8Array(analyser.frequencyBinCount);
  source.connect(analyser);

  function update() {
    analyser.getByteTimeDomainData(dataArray);

    let sum = 0;
    for (let i = 0; i < dataArray.length; i++) {
      let v = (dataArray[i] - 128) / 128; // нормализуем в -1..1
      sum += v * v;
    }
    const rms = Math.sqrt(sum / dataArray.length); // громкость (0..1)

    let intensity = Math.min(50, rms * 200);
    if (intensity < 2) {
      intensity = 0
    }
    shareScreen.style.boxShadow = `0 0 ${intensity}px rgba(255, 255, 255, .5)`;

    requestAnimationFrame(update);
  }

  update();
}

shareStopBtn.onclick = stopScreenShare;
shareBtn.onclick = async () => {
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        width: {ideal: roomWidth},
        height: {ideal: roomHeight},
        frameRate: {ideal: roomFps}
      },
      audio: true
    });

    const screenVideoTrack = screenStream.getVideoTracks()[0];
    const screenAudioTrack = screenStream.getAudioTracks()[0];

    console.log('Got screen tracks:', !!screenVideoTrack, !!screenAudioTrack, screenVideoTrack?.id);

    screenVideoTrack.addEventListener('ended', stopScreenShare);

    console.log('get contentHint', screenVideoTrack.contentHint);
    screenVideoTrack.contentHint = 'motion'; // 'none' | 'motion' | 'detail' | 'text'
    console.log('after set contentHint', screenVideoTrack.contentHint);

    let vidSender = (videoTransceiver && videoTransceiver.sender)
      || pc.getSenders().find(s => s.track && s.track.kind === 'video');

    if (vidSender) {
      if (typeof vidSender.replaceTrack === 'function') {
        await vidSender.replaceTrack(screenVideoTrack);
      }
    } else {
      vidSender = pc.addTrack(screenVideoTrack, screenStream);
    }

    // set fps, bitrate
    if (vidSender) {
      const params = vidSender.getParameters();
      console.log("Get vidSender params:", params);
      if (!params.encodings) params.encodings = [{}];

      console.log('set maxBitrate:', roomBitrate, 'and maxFramerate:', roomFps)
      params.encodings[0].maxBitrate = roomBitrate;
      params.encodings[0].maxFramerate = roomFps;
      // limiter (1 = native), set 2 => (2K -> ~720p)
      params.encodings[0].scaleResolutionDownBy = 1;
      console.log('setParameters video track:', params);
      await vidSender.setParameters(params);
    }

    // Аналогично для аудио (если есть)
    if (screenAudioTrack) {
      let audSender = pc.getSenders().find(s =>
        s.track?.kind === 'audio' && s.track.id !== micStream?.getAudioTracks()[0]?.id);
      if (!audSender) {
        pc.addTrack(screenAudioTrack, screenStream);
        console.log('Added new audio sender for screen audio');
      } else if (typeof audSender.replaceTrack === 'function') {
        await audSender.replaceTrack(screenAudioTrack);
        console.log('Replaced existing audio sender track with screen audio');
      }
    }

    localVideo.srcObject = new MediaStream([
      ...(micStream ? micStream.getAudioTracks() : []),
      screenVideoTrack,
      ...(screenAudioTrack ? [screenAudioTrack] : [])
    ]);

    shareBtn.classList.add('hide');
    shareStopBtn.classList.remove('hide');

    // **Принудительный оффер после добавления трека**, чтобы polite peer передал экран
    if (pc) {
      try {
        makingOffer = true;
        const offer = await pc.createOffer();
        offer.sdp = preferCodec(offer.sdp);
        await pc.setLocalDescription(offer);
        sendSignal({type: 'offer', offer: pc.localDescription});
        console.log('Forced offer sent after screen track added');
      } catch (e) {
        console.error('Failed to create offer after screen share', e);
      } finally {
        makingOffer = false;
      }
    }

  } catch (err) {
    console.error('Failed to capture screen', err);
    showNotify('Failed to capture screen: ' + err.message);
    shareBtn.classList.remove('hide');
    shareStopBtn.classList.add('hide');
  }
}

function stopScreenShare() {
  if (!screenStream) return;

  const videoTrack = screenStream.getVideoTracks()[0];
  const audioTrack = screenStream.getAudioTracks()[0];

  // Try to restore previous video track: find sender for video and replace with original camera track if exists
  if (pc) {
    const videoSender = pc.getSenders().find(s => s.track && s.track.kind === 'video');
    const camTrack = micStream ? micStream.getVideoTracks && micStream.getVideoTracks()[0] : null;
    if (videoSender && typeof videoSender.replaceTrack === 'function') {
      try {
        // if you have a camera video track, use it; otherwise replace with null to stop
        videoSender.replaceTrack(camTrack || null);
        console.log('Replaced screen sender with camera/null');
      } catch (e) {
        console.warn('replaceTrack on stopScreenShare failed', e);
      }
    } else if (videoTrack) {
      // if there was an addTrack earlier, try to remove the sender by finding sender with same id
      const sender = pc.getSenders().find(s => s.track && s.track.id === videoTrack.id);
      if (sender) {
        try {
          if (typeof sender.replaceTrack === 'function') sender.replaceTrack(null);
          else pc.removeTrack(sender);
        } catch (e) {
          console.warn('removeTrack failed', e);
        }
      }
    }

  }

  // stop and clean local preview
  screenStream.getTracks().forEach(t => {
    try {
      t.stop();
    } catch (e) {
    }
  });
  screenStream = null;

  localVideo.srcObject = new MediaStream(micStream.getTracks());

  shareBtn.classList.remove("hide");
  shareStopBtn.classList.add("hide");
}

function connectSignaling() {
  try {
    console.log('connectSignaling -> SIGNALING_URL =', SIGNALING_URL);
    ws = new WebSocket(SIGNALING_URL);

    ws.onopen = () => {
      console.log('WebSocket connected, state=', ws.readyState);
      // отправляем join (через sendSignal — теперь она умеет буферизовать/посылать)
      sendSignal({
        type: 'join', room, quality: !polite ? {
          width: roomWidth,
          height: roomHeight,
          fps: roomFps,
          bitrate: roomBitrate,
          codec: roomCodec,
        } : null
      });

      // если оффер уже создан локально (например, negotiationneeded сработал ДО открытия WS),
      // убедимся что он уйдёт
      if (pc && pc.localDescription && pc.localDescription.type === 'offer') {
        console.log('WS now open — flushing local offer');
        sendSignal({type: 'offer', offer: pc.localDescription});
      }

      // флаш очереди (вдобавок)
      flushQueue();

      shareBtn.classList.remove('hide');
      shareStopBtn.classList.add('hide');
    };

    ws.onmessage = async (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === "ready") {
        roomWidth = msg.quality.width
        roomHeight = msg.quality.height
        roomFps = msg.quality.fps
        roomBitrate = msg.quality.bitrate
        roomCodec = msg.quality.codec
        if (!polite) {
          // только impolite создаёт оффер
          const offer = await pc.createOffer();
          offer.sdp = preferCodec(offer.sdp);
          await pc.setLocalDescription(offer);
          sendSignal({type: "offer", room, offer});
        }
      }

      if (msg.type === 'error') {
        showNotify(msg.message || 'Server error');
        if (msg.fatal) {
          cleanup();
          setTimeout(() => {
            history.replaceState(null, null, '/');
            location.href = '/'
          }, 1000)
        }
        return;
      }

      if (msg.type === 'joined') {
        console.log('joined received; polite=', polite);
        isJoined = true;
        if (!pc) createPeerConnection();

        // если вы — создатель (impolite) и оффер ещё не создан/не отправлен, форсируем
        // (помогает, если negotiationneeded пропустился)
        try {
          if (!polite && pc && pc.signalingState === 'stable' && !makingOffer) {
            console.log('Forcing initial offer (creator/impolite)');
            makingOffer = true;
            const offer = await pc.createOffer();
            offer.sdp = preferCodec(offer.sdp);
            await pc.setLocalDescription(offer);
            sendSignal({type: 'offer', offer: pc.localDescription});
          }
        } catch (e) {
          console.error('force offer failed', e);
        } finally {
          makingOffer = false;
        }
      } else if (msg.type === 'offer') {
        try {
          if (!pc) createPeerConnection();

          const offerCollision = makingOffer || pc.signalingState !== 'stable';
          ignoreOffer = !polite && offerCollision;
          if (ignoreOffer) {
            console.log('Ignoring incoming offer due to collision (impolite).');
            return;
          }

          if (offerCollision) {
            try {
              await pc.setLocalDescription({type: 'rollback'});
              console.log('Performed local rollback before applying remote offer');
            } catch (rbErr) {
              console.warn('Rollback failed or not needed:', rbErr);
            }
          }

          await pc.setRemoteDescription(msg.offer);
          const answer = await pc.createAnswer();
          answer.sdp = preferCodec(answer.sdp);
          await pc.setLocalDescription(answer);
          sendSignal({type: 'answer', answer: pc.localDescription});
        } catch (e) {
          console.error('Error handling incoming offer', e);
          showNotify('Error handling offer: ' + e.message);
        }
      } else if (msg.type === 'answer') {
        try {
          await pc.setRemoteDescription(msg.answer);
        } catch (e) {
          console.warn('setRemoteDescription(answer) failed', e);
          showNotify('Error setting remote description: ' + e.message);
        }
      } else if (msg.type === 'candidate') {
        try {
          await pc.addIceCandidate(msg.candidate);
        } catch (e) {
          console.warn('addIceCandidate failed', e);
        }
      } else if (msg.type === 'leave' || msg.type === 'hangup') {
        cleanupPeer();
        history.replaceState(null, null, '/?peer=close');
        location.href = '/?peer=close';
      }
    };

    ws.onclose = (ev) => {
      console.log('WebSocket closed', ev && ev.code, ev && ev.reason);
      if (isJoined) {
        showNotify('Connection lost. Trying to reconnect...');
        setTimeout(connectSignaling, 2000);
      }
    };

    ws.onerror = (e) => {
      console.error('WS error', e);
      showNotify('WebSocket error: ' + (e && e.message));
    };
  } catch (e) {
    console.error('Failed to connect to signaling server', e);
    showNotify('Failed to connect to signaling server: ' + e.message);
  }
}

function flushQueue() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  while (wsMessageQueue.length) {
    const m = wsMessageQueue.shift();
    try {
      ws.send(JSON.stringify(m));
      console.log('Flushed queued message', m.type);
    } catch (e) {
      console.error('Failed to flush queued message', e, m);
      wsMessageQueue.unshift(m);
      break;
    }
  }
}

function sendSignal(obj) {
  obj.room = room;
  try {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.warn('WS not OPEN, queueing', obj.type);
      wsMessageQueue.push(obj);
      return;
    }
    ws.send(JSON.stringify(obj));
    console.log('Signal sent', obj.type);
  } catch (e) {
    console.error('sendSignal failed, queueing', e, obj);
    wsMessageQueue.push(obj);
  }
}

function createPeerConnection() {
  try {
    pc = new RTCPeerConnection({iceServers: STUN_SERVERS});

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        sendSignal({type: 'candidate', candidate: e.candidate});
      }
    };

    pc.ontrack = (e) => {
      console.log('New track received', e.track.kind, 'id=', e.track.id,
        'readyState=', e.track.readyState, 'streams=', e.streams);
      try {
        if (e.track.kind === 'audio') {
          if (!remoteAudio.srcObject) remoteAudio.srcObject = new MediaStream();
          if (!remoteAudio.srcObject.getTracks().some(t => t.id === e.track.id)) {
            remoteAudio.srcObject.addTrack(e.track);
            console.log('Added audio track to remoteAudio, settings=', e.track.getSettings && e.track.getSettings());
          }
        } else if (e.track.kind === 'video') {
          if (!remoteVideo.srcObject) remoteVideo.srcObject = new MediaStream();
          if (!remoteVideo.srcObject.getTracks().some(t => t.id === e.track.id)) {
            remoteVideo.srcObject.addTrack(e.track);
            console.log('Added video track to remoteVideo, settings=', e.track.getSettings && e.track.getSettings());
          }
          // try to play
          remoteVideo.play().catch(err => console.warn('remoteVideo.play failed:', err));

          console.log('remote video track settings:', e.track.getSettings && e.track.getSettings());
          console.log('remote video track enabled:', e.track.enabled, 'muted:', e.track.muted);
        }
      } catch (err) {
        console.warn('ontrack handler error', err);
      }
    };

    pc.onconnectionstatechange = () => {
      console.log('Connection state:', pc.connectionState);
      if (pc.connectionState === 'connected') {
        startStats();
        showNotify('Connection established!', 'good');
        waitingPeer.style.display = 'none'
      } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        showNotify('Connection lost. Trying to reconnect...');
      }
    };

    pc.onnegotiationneeded = async () => {
      console.log('onnegotiationneeded fired, makingOffer=', makingOffer,
        'polite=', polite, 'signalingState=', pc.signalingState);
      try {
        if (makingOffer) return;
        if (polite) {
          // Полит корректно ждёт оффер — ничего не делаем
          console.log('Polite peer: skip negotiationneeded, wait for offer');
          return;
        }
        makingOffer = true;
        console.log('ImpOolite peer: creating offer');
        const offer = await pc.createOffer();
        offer.sdp = preferCodec(offer.sdp);
        await pc.setLocalDescription(offer);
        sendSignal({type: 'offer', offer: pc.localDescription});
        console.log('Offer sent by impolite peer');
      } catch (err) {
        console.error('negotiationneeded failed', err);
      } finally {
        makingOffer = false;
      }
    };

    // codec prefs для видео
    try {
      videoTransceiver = pc.addTransceiver('video', {
        direction: 'sendrecv',
        sendEncodings: [{maxBitrate: roomBitrate}]
      });
      const caps = RTCRtpSender.getCapabilities('video');
      if (caps && caps.codecs) {
        const h264 = caps.codecs.filter(c => /h264/i.test(c.mimeType));
        const others = caps.codecs.filter(c => !/h264/i.test(c.mimeType));
        if (h264.length) {
          videoTransceiver.setCodecPreferences([...h264, ...others]);
          console.log('Codec preferences set: H264 first');
        }
      }
    } catch (e) {
      console.warn('addTransceiver(video) failed', e);
    }

    // добавляем текущие локальные треки (аудио из initMic, видео если будет)
    localStream.getTracks().forEach(t => addTrackToPc(t));

    shareBtn.classList.remove('hide');
    shareStopBtn.classList.add('hide');
  } catch (e) {
    console.error('Failed to create peer connection', e);
    showNotify('Failed to create peer connection: ' + e.message);
  }
}

function addTrackToPc(track) {
  try {
    console.log('addTrackToPc called for', track.kind, track.id);
    if (!pc) {
      console.warn('no pc yet, will add later');
      return;
    }
    if (pc.getSenders().some(s => s.track && s.track.id === track.id)) {
      console.log('track already added', track.id);
      return;
    }
    pc.addTrack(track, localStream);
    console.log('added track to pc', track.kind, track.id,
      'senders:', pc.getSenders().map(s => s.track?.id));
  } catch (e) {
    console.warn('addTrackToPc failed', e);
  }
}

function cleanupPeer() {
  if (statsTimer) {
    clearInterval(statsTimer);
    statsTimer = null;
  }
  if (pc) {
    try {
      pc.close();
    } catch (e) {
    }
    pc = null;
  }
  remoteVideo.srcObject = null;
  prevOutbound = {};
}

function cleanup() {
  cleanupPeer();
  if (ws) try {
    ws.close();
  } catch (e) {
  }
  ws = null;
  isJoined = false;
  leaveBtn.classList.remove('show');
  shareBtn.classList.remove('hide');
  shareStopBtn.classList.add('hide');
}

function preferCodec(sdp) {
  if (!sdp) return sdp;
  const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
  const sections = sdp.split(eol);
  const mIndex = sections.findIndex(l => l.startsWith('m=video'));
  if (mIndex === -1) return sdp;
  const rtpmapRegex = new RegExp('a=rtpmap:(\\d+) ' + roomCodec + '/', 'i');
  let preferredPayloads = [];
  for (const line of sections) {
    const m = line.match(rtpmapRegex);
    if (m) preferredPayloads.push(m[1]);
  }
  if (preferredPayloads.length === 0) return sdp;
  const mLineParts = sections[mIndex].split(' ');
  const header = mLineParts.slice(0, 3);
  const payloads = mLineParts.slice(3);
  const remaining = payloads.filter(p => !preferredPayloads.includes(p));
  const newPayloads = preferredPayloads.concat(remaining);
  sections[mIndex] = header.concat(newPayloads).join(' ');
  return sections.join(eol);
}

function startStats() {
  if (statsTimer) {
    clearInterval(statsTimer);
  }
  statsTimer = setInterval(async () => {
    if (!pc) return;
    const stats = await pc.getStats();
    let outbound = '';
    let inbound = '';
    const now = performance.now();

    let codecs = '';
    stats.forEach(report => {
      if (report.type === 'codec' && report.mimeType) {
        codecs += `<span>${report.mimeType.replace('video/', '')
          .replace('audio/', '').toUpperCase()}</span>`;
      }
    });

    stats.forEach(report => {
      if (report.type === 'outbound-rtp' && (report.kind === 'video' || report.mediaType === 'video')) {
        if (report.bytesReceived <= 0) {
          return
        }
        const id = report.id || report.ssrc || 'out-v';
        const prev = prevOutbound[id] || {bytesSent: report.bytesSent || 0, timestamp: now};
        const deltaBytes = (report.bytesSent || 0) - (prev.bytesSent || 0);
        const deltaTime = (now - (prev.timestamp || now)) / 1000 || 1;
        const kbps = Math.round((deltaBytes * 8) / 1000 / deltaTime);
        prevOutbound[id] = {bytesSent: report.bytesSent || 0, timestamp: now};

        const track = pc.getSenders().find(s => s.track && s.track.kind === 'video')?.track;
        const settings = track?.getSettings ? track.getSettings() : null;

        outbound += `<span>${kbps} Kbps</span>`;
        outbound += `<span>Sent ${Math.round((report.bytesSent || 0) * 8 / 1000 / 1000)} MB</span>`;
        outbound += `<span>${report.packetsSent} packets</span>`;
        if (settings) {
          outbound += `<span>${settings.width || 0}x${settings.height || 0}</span>`;
        }
        outbound += `<span>${Math.round(report.framesPerSecond || 0)} FPS</span>`;
        outbound += codecs
      }

      if (report.type === 'inbound-rtp' && report.kind === 'video') {
        if (report.bytesReceived <= 0) {
          return
        }
        const id = report.id || report.ssrc || 'out-v';
        const prev = prevInbound[id] || {bytesReceived: report.bytesReceived || 0, timestamp: now};
        const deltaBytes = (report.bytesReceived || 0) - (prev.bytesReceived || 0);
        const deltaTime = (now - (prev.timestamp || now)) / 1000 || 1;
        const kbps = Math.round((deltaBytes * 8) / 1000 / deltaTime);
        prevInbound[id] = {bytesReceived: report.bytesReceived || 0, timestamp: now};


        const receiver = pc.getReceivers().find(s =>
          s.track && s.track.id === report.trackIdentifier);
        const track = receiver?.track;
        const settings = track?.getSettings ? track.getSettings() : null;

        inbound += `<span>${kbps} Kbps</span>`;
        inbound += `<span>Received ${Math.round((report.bytesReceived || 0) * 8 / 1000 / 1000)} MB</span>`;
        inbound += `<span>${report.packetsReceived} packets</span>`;
        if (settings) {
          inbound += `<span>${settings.width || 0}x${settings.height || 0}</span>`;
        }
        inbound += `<span>${Math.round(report.framesPerSecond || 0)} FPS</span>`;
        inbound += codecs
      }
    });

    outboundEl.innerHTML = outbound
    if (outbound.length > 0) {
      outboundEl.parentNode.classList.add('show')
    }
    inboundEl.innerHTML = inbound
    if (inbound.length > 0) {
      inboundEl.parentNode.classList.add('show')
    }
  }, 1000);
}

function testSenderVideoParams() {
  try {
    const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video')
    if (sender) {
      const params = sender.getParameters()
      console.log(`sender params: ${JSON.stringify(params, null, 2)}`)
    }
  } catch (err) {
    console.error(`sender params err:`, err)
  }
}

function testStun() {
  (function (servers) {
    servers.forEach(stun => {
      console.log('test stun:', stun.urls)

      const pc = new RTCPeerConnection({
        iceServers: [{urls: stun.urls}]
      })

      pc.createDataChannel("test")
      pc.createOffer().then(o => pc.setLocalDescription(o))

      pc.onicecandidate = e => {
        if (e.candidate) {
          console.log(stun.urls, 'candidate:', e.candidate.candidate)
        }
      }
    })
  })(STUN_SERVERS)
}