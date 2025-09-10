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
const timer = document.querySelector('.top-left .timer')
const fpEl = document.querySelector('.top-left .fingerprint')
const leaveBtn = document.querySelector('.top-right .leave-btn')
const micBtnEl = document.querySelector('.top-right .mic-btn')
const micBtnLinks = micBtnEl.querySelectorAll('button')
const shareBlock = document.querySelector('.share')
const shareCam = shareBlock.querySelector('.share-cam')
const shareCamBtn = shareBlock.querySelector('.share-cam-btn')
const shareCamStopBtn = shareCam.querySelector('.controls .share-stop-btn')
const shareScreen = shareBlock.querySelector('.share-screen')
const shareScreenBtn = shareBlock.querySelector('.share-screen-btn')
const shareScreenStopBtn = shareScreen.querySelector('.controls .share-stop-btn')
const localCamVideo = shareCam.querySelector('video')
const localScreenVideo = shareScreen.querySelector('video')
const remoteSection = document.querySelector('.remote-section')
const remoteMiniVideo = remoteSection.querySelector('.remote-mini')
const remoteScreenVideo = remoteSection.querySelector('.remote-screen')
const statsEl = document.querySelector('.stats')
const statsLinks = statsEl.querySelectorAll('.link button')
const outboundMicEl = statsEl.querySelector('.out-mic .vals')
const inboundMicEl = statsEl.querySelector('.in-mic .vals')
const outboundCamEl = statsEl.querySelector('.out-cam .vals')
const inboundCamEl = statsEl.querySelector('.in-cam .vals')
const outboundScrEl = statsEl.querySelector('.out-screen .vals')
const inboundScrEl = statsEl.querySelector('.in-screen .vals')
const outboundScrAEl = statsEl.querySelector('.out-screen-a .vals')
const inboundScrAEl = statsEl.querySelector('.in-screen-a .vals')
const notifyMsg = document.querySelector('.notify');
const waitingPeer = document.querySelector('.waiting-peer');
const topWarn = document.querySelector('.top-warn')

/* state */
let ws;
let pc = null;
let micSender = null;
let micTransceiver = null;
let camTransceiver = null;
let screenTransceiver = null;
let screenAudioTransceiver = null;
let micStream = null;
let screenStream = null;
let camStream = null;
let trackCamVideo = new MediaStream();
let trackScreenVideo = new MediaStream();
let room = null;
let isJoined = false;
let wsMessageQueue = [];
const state = {
  type: 'state',
  micMute: false,
  cam: false,
  screen: false,
}
let stopEffectScreen = false

/* perfect negotiation flags */
let makingOffer = false;
let polite = true;
let ignoreOffer = false;

/* stats */
let statsTimer;
let prevStats = {};

/* quality */
let roomWidth = 1920
let roomHeight = 1080
let roomFps = 30
let roomBitrate = roomWidth * roomHeight * roomFps * .065
let roomCodec = 'VP9'

let elapsedSeconds = 0
const remoteAudio = new Audio()
remoteAudio.addEventListener('playing', () => {
  if (elapsedSeconds) {
    return
  }
  setInterval(() => {
    elapsedSeconds++;
    const h = Math.floor(elapsedSeconds / 3600).toString().padStart(2, '0')
    const m = Math.floor((elapsedSeconds % 3600) / 60).toString().padStart(2, '0')
    const s = Math.floor(elapsedSeconds % 60).toString().padStart(2, '0')
    timer.textContent = `${h}:${m}:${s}`
  }, 1000);
})
remoteAudio.autoplay = true
remoteAudio.playsInline = true

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

const unload = (e) => {
  if (!polite) {
    e.preventDefault()
  }
}
window.addEventListener('beforeunload', unload)

leaveBtn.addEventListener('click', () => {
  if (!confirm('Are you sure you want to leave?')) {
    return
  }
  window.removeEventListener('beforeunload', unload)
  sendSignal({type: 'leave'})
  cleanup()
  history.replaceState(null, null, '/')
  location.href = '/'
})

micBtnLinks.forEach(btn => {
  btn.addEventListener('click', () => {
    if (!micStream) {
      return
    }
    micBtnEl.classList.toggle('mute')
    state.micMute = micBtnEl.classList.contains('mute')
    sendSignal(state)
    micStream.getAudioTracks().forEach(track => track.enabled = !state.micMute)
  })
})

remoteScreenVideo.addEventListener('dblclick', function () {
  if (!document.fullscreenElement) {
    remoteSection.classList.add('full')
    remoteSection.requestFullscreen().catch(err => {
      console.error('Error attempting to enable fullscreen:', err)
    });
  } else {
    remoteSection.classList.remove('full')
    document.exitFullscreen()
  }
})

statsLinks.forEach(link => {
  link.addEventListener('click', () => statsEl.classList.toggle('hide'))
})

document.querySelectorAll('video').forEach(video => {
  video.addEventListener('contextmenu', e => e.preventDefault())
})

remoteMiniVideo.addEventListener('click', function () {
  const miniCam = remoteMiniVideo.srcObject?.getTracks()
    .some(t => t === camTransceiver?.sender.track)
  ;[remoteScreenVideo.srcObject, remoteMiniVideo.srcObject] =
    miniCam
      ? [remoteScreenVideo.srcObject, remoteMiniVideo.srcObject]
      : [remoteMiniVideo.srcObject, remoteScreenVideo.srcObject]
});

window.addEventListener('pagehide', () => {
  if (room.length > 0) {
    navigator.sendBeacon('/leave', JSON.stringify({
      room,
      type: !polite ? 'creator' : 'viewer'
    }));
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
    room = ''
    history.replaceState(null, null, '/');
    location.href = '/'
    return
  }
  localStorage.removeItem('room-created')

  if (room.length > 0 && window.location.search.length <= 0) {
    joinEl.classList.add('show')
  } else {
    createEl.classList.add('show')
  }
}

createBtn.onclick = async () => {
  polite = false // создатель — инициатор (impolite)
  room = generateName() + generateName()
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
  await createPeerConnection()
  await initMic()
  connectSignaling()
}

function log(...p) {
  console.log(...p)
}

function generateName() {
  const syllables = [
    'a', 'i', 'u', 'e', 'o',
    'ka', 'ki', 'ku', 'ke', 'ko',
    'sa', 'shi', 'su', 'se', 'so',
    'ta', 'chi', 'tsu', 'te', 'to',
    'na', 'ni', 'nu', 'ne', 'no',
    'ha', 'hi', 'fu', 'he', 'ho',
    'ma', 'mi', 'mu', 'me', 'mo',
    'ya', 'yu', 'yo',
    'ra', 'ri', 'ru', 're', 'ro',
    'wa', 'wo', 'n'
  ];
  const syllableCount = Math.floor(Math.random() * 2) + 2;
  let word = '';
  for (let i = 0; i < syllableCount; i++) {
    word += syllables[Math.floor(Math.random() * syllables.length)];
  }
  return word.charAt(0).toUpperCase() + word.slice(1);
}

async function initMic() {
  try {
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {echoCancellation: true, noiseSuppression: true, autoGainControl: true}
    });

    if (micStream) {
      const sender = micSender || micTransceiver.sender
      await sender.replaceTrack(micStream.getAudioTracks()[0]);
      await improveAudio(sender)
    }

    soundEffect(micStream, micBtnEl)
    soundEffect(micStream, shareCam)
    log('Mic capture ok, tracks:', micStream.getTracks());
  } catch (err) {
    console.warn('Mic capture failed:', err);
    showNotify('Microphone access is required for this app. Please allow microphone access');
  }
}

async function improveAudio(transceiver) {
  if (transceiver) {
    const params = transceiver.getParameters()
    if (!params.encodings) params.encodings = [{}]
    params.encodings[0].maxBitrate = 128000
    log('improveAudio ok, params:', params, 'transceiver:', transceiver)
    await transceiver.setParameters(params)
  } else {
    console.warn('improveAudio failed: not found transceiver')
  }
}

function soundEffect(stream, to) {
  const audioCtx = new AudioContext();
  const source = audioCtx.createMediaStreamSource(stream);
  const analyser = audioCtx.createAnalyser();
  analyser.fftSize = 512;

  const dataArray = new Uint8Array(analyser.frequencyBinCount);
  source.connect(analyser);

  function update() {
    if (stopEffectScreen) {
      to.style.boxShadow = 'none'
      return
    }
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
    to.style.boxShadow = `0 0 ${intensity}px rgba(255, 255, 255, .5)`;

    requestAnimationFrame(update)
  }

  update()
}

shareCamStopBtn.onclick = stopCamShare;
shareCamBtn.onclick = async () => {
  try {
    camStream = await navigator.mediaDevices.getUserMedia({
      video: {
        width: {ideal: 1280},
        height: {ideal: 720},
        frameRate: {ideal: 30}
      },
    });

    const camVideoTrack = camStream.getVideoTracks()[0];
    const camAudioTrack = camStream.getAudioTracks()[0];
    camVideoTrack._kind = 'camera'
    log('Got cam tracks:',
      'video:', !!camVideoTrack, 'audio:', !!camAudioTrack, 'video id:', camVideoTrack?.id);

    camVideoTrack.addEventListener('ended', stopCamShare);

    // for polite: find 1 mid - cam
    if (!camTransceiver) {
      camTransceiver = pc.getTransceivers().find(t => t.mid === '1')
      camTransceiver.direction = 'sendrecv'
    }
    await camTransceiver.sender.replaceTrack(camVideoTrack);

    localCamVideo.srcObject = new MediaStream([camVideoTrack]);

    shareCamBtn.classList.remove('show')
    shareCam.classList.add('show')

    // Принудительный оффер после добавления трека**, чтобы polite peer (viewer) передал экран
    await forceRenegotiation()

    state.cam = true
    sendSignal(state)
  } catch (err) {
    console.error('Failed to capture cam', err);
    showNotify('Failed to capture cam: ' + err.message);
    shareCamBtn.classList.add('show')
    shareCam.classList.remove('show')
  }
}

function stopCamShare() {
  if (!camStream) {
    shareCamBtn.classList.add('show')
    shareCam.classList.remove('show')
    return;
  }

  camTransceiver.sender.replaceTrack(null)
  camStream.getTracks().forEach(track => {
    track.stop()
  })
  camStream = null;
  localCamVideo.srcObject = null;

  shareCamBtn.classList.add('show')
  shareCam.classList.remove('show')
  state.cam = false
  sendSignal(state)
}

shareScreenStopBtn.onclick = stopScreenShare;
shareScreenBtn.onclick = async () => {
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        width: {ideal: roomWidth},
        height: {ideal: roomHeight},
        frameRate: {ideal: roomFps}
      },
      audio: {
        echoCancellation: false, // убрать подавление эха
        noiseSuppression: false, // убрать шумодав
        autoGainControl: false, // убрать автоподстройку громкости
        channelCount: 2,
        sampleRate: 48000,
        sampleSize: 16
      }
    });

    const screenVideoTrack = screenStream.getVideoTracks()[0];
    screenVideoTrack._kind = 'screen'
    let screenAudioTrack = screenStream.getAudioTracks()[0];

    log('Got screen tracks:',
      'video:', !!screenVideoTrack, 'audio:', !!screenAudioTrack, 'video id:', screenVideoTrack?.id);

    if (!!screenAudioTrack) {
      stopEffectScreen = false
      soundEffect(new MediaStream([screenAudioTrack]), shareScreen);
    }

    screenVideoTrack.addEventListener('ended', stopScreenShare);

    log('screenVideoTrack get contentHint', screenVideoTrack.contentHint)
    screenVideoTrack.contentHint = 'motion'; // 'none' | 'motion' | 'detail' | 'text'
    log('screenVideoTrack set contentHint', screenVideoTrack.contentHint)

    let vidSender = screenTransceiver?.sender
    // polite find 2 mid - screen video
    if (!vidSender) {
      screenTransceiver = pc.getTransceivers().find(t => t.mid === '2')
      screenTransceiver.direction = 'sendrecv'
      prefersVidCodec(screenTransceiver)
      vidSender = screenTransceiver.sender
    }
    await vidSender.replaceTrack(screenVideoTrack)

    // set fps, bitrate
    if (vidSender) {
      try {
        const params = vidSender.getParameters();
        if (!params.encodings.length) {
          params.encodings = [{}];
        }
        log('Set for screen maxBitrate:', roomBitrate, 'and maxFramerate:', roomFps)
        params.encodings[0].maxBitrate = roomBitrate;
        params.encodings[0].maxFramerate = roomFps;
        // limiter (1 = native), set 2 => (2K -> ~720p)
        params.encodings[0].scaleResolutionDownBy = 1;
        log('Get screen vidSender params:', params);
        await vidSender.setParameters(params);
      } catch (err) {
        log('Set screen vidSender params, err:', err);
      }
    }

    let audSender = screenAudioTransceiver?.sender
    // polite find 3 mid - screen audio
    if (!audSender) {
      screenAudioTransceiver = pc.getTransceivers().find(t => t.mid === '3')
      screenAudioTransceiver.direction = 'sendrecv'
      audSender = screenAudioTransceiver.sender
    }
    await audSender.replaceTrack(screenAudioTrack)

    log('Replaced existing audio sender track with screen audio');

    if (audSender) {
      try {
        const params = audSender.getParameters();
        if (!params.encodings) params.encodings = [{}];
        params.encodings[0].maxBitrate = 128000;
        log('Get screen audSender params:', params);
        await audSender.setParameters(params);
      } catch (err) {
        log('Set screen audSender params, err:', err);
      }
    }

    localScreenVideo.srcObject = new MediaStream([screenVideoTrack]);

    shareScreenBtn.classList.remove('show')
    shareScreen.classList.add('show')

    // Принудительный оффер после замена трека, чтобы polite peer (viewer) передал экран
    await forceRenegotiation()

    state.screen = true
    sendSignal(state)
  } catch (err) {
    console.error('Failed to capture screen', err);
    showNotify('Failed to capture screen: ' + err.message);
    shareScreenBtn.classList.add('show')
    shareScreen.classList.remove('show')
  }
}

function stopScreenShare() {
  if (!screenStream) {
    shareScreenBtn.classList.add('show')
    shareScreen.classList.remove('show')
    stopEffectScreen = true
    return;
  }

  screenTransceiver.sender.replaceTrack(null)
  screenStream.getTracks().forEach(track => {
    track.stop()
  })
  screenStream = null;
  localScreenVideo.srcObject = null;

  shareScreenBtn.classList.add('show')
  shareScreen.classList.remove('show')
  stopEffectScreen = true
  state.screen = false
  sendSignal(state)
}

const fpEmojis = [
  '🍎', '🍊', '🍋', '🍉', '🍇', '🍓', '🍒', '🥝',
  '🥑', '🍍', '🥥', '🍌', '🥕', '🌽', '🥔', '🍆',
  '🐶', '🐱', '🐭', '🐰', '🦊', '🐻', '🐼', '🐨',
  '🦁', '🐯', '🐮', '🐷', '🐸', '🐵', '🐔', '🐧'
]

function showFingerprint(sdp) {
  let fingerprint = sdp.match(/a=fingerprint:sha-256\s*([0-9A-Fa-f:]+)/i)
  if (!fingerprint || !fingerprint[1]) {
    console.error('err fingerprint:', fingerprint)
    return
  }
  const hex = fingerprint[1].replace(/:/g, '')
  const buf = new Uint8Array(hex.match(/.{2}/g).map(b => parseInt(b, 16)))
  fpEl.textContent = ''
  for (let i = 0; i < 3; i++) {
    fpEl.textContent += fpEmojis[buf[i] % fpEmojis.length]
  }
  fpEl.classList.remove('hide')
}

function connectSignaling() {
  try {
    log('connectSignaling -> SIGNALING_URL =', SIGNALING_URL);
    ws = new WebSocket(SIGNALING_URL);

    ws.onopen = () => {
      log('WebSocket connected, state=', ws.readyState);

      sendSignal({
        type: 'join', room, quality: !polite ? {
          width: roomWidth,
          height: roomHeight,
          fps: roomFps,
          bitrate: roomBitrate,
          codec: roomCodec,
        } : null
      });
    };

    ws.onmessage = async (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === 'ready') {
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
          showFingerprint(pc.localDescription && pc.localDescription.sdp)
          sendSignal({type: 'offer', room, offer});
        }
      }

      if (msg.type === 'error') {
        if (msg.text) {
          msg.text = 'Error: ' + msg.text
        }
        showNotify(msg.text || 'Server error')
        cleanup();
        setTimeout(() => {
          history.replaceState(null, null, '/');
          location.href = '/'
        }, 3000)
        return
      }

      if (msg.type === 'peer-replaced') {
        log('Peer replaced (server), performing full restart as if first connect');
        fullRestartAsIfFirstConnect().catch(e => {
          console.error('fullRestartAsIfFirstConnect failed', e);
          // fallback: если что-то пошло не так — пересоздадим PC стандартно
          recreatePeerConnectionAndRenegotiate();
        });
        return;
      }

      if (msg.type === 'joined') {
        log('joined received; polite=', polite);
        isJoined = true;
        return
      }

      if (msg.type === 'state') {
        log('State received:', msg)
        if (msg.cam && !msg.screen) {
          remoteMiniVideo.classList.remove('show')
          remoteMiniVideo.srcObject = null
          remoteScreenVideo.classList.add('show')
          remoteScreenVideo.srcObject = trackCamVideo
        }
        if (msg.cam && msg.screen) {
          remoteMiniVideo.classList.add('show')
          remoteMiniVideo.srcObject = trackCamVideo
          remoteScreenVideo.classList.add('show')
          remoteScreenVideo.srcObject = trackScreenVideo
        }
        if (!msg.cam && msg.screen) {
          remoteMiniVideo.classList.remove('show')
          remoteMiniVideo.srcObject = null
          remoteScreenVideo.classList.add('show')
          remoteScreenVideo.srcObject = trackScreenVideo
        }
        if (!msg.cam && !msg.screen) {
          remoteMiniVideo.classList.remove('show')
          remoteMiniVideo.srcObject = null
          remoteScreenVideo.classList.remove('show')
          remoteScreenVideo.srcObject = null
        }
        if (msg.micMute) {
          topWarn.classList.add('show')
        } else {
          topWarn.classList.remove('show')
        }
      }

      if (msg.type === 'offer') {
        try {
          if (!pc) await createPeerConnection();

          // might from pc.remoteDescription.sdp after await pc.setRemoteDescription(msg.offer)
          showFingerprint(msg.offer && msg.offer.sdp)

          const offerCollision = makingOffer || pc.signalingState !== 'stable';
          ignoreOffer = !polite && offerCollision;
          if (ignoreOffer) {
            log('Ignoring incoming offer due to collision (impolite).');
            return;
          }

          if (offerCollision) {
            try {
              await pc.setLocalDescription({type: 'rollback'});
              log('Performed local rollback before applying remote offer');
            } catch (rbErr) {
              console.warn('Rollback failed or not needed:', rbErr);
            }
          }

          await pc.setRemoteDescription(msg.offer);

          // Простая версия: сразу создаём answer если состояние это позволяет
          if (pc.signalingState === 'have-remote-offer') {
            const answer = await pc.createAnswer();
            answer.sdp = preferCodec(answer.sdp);
            await pc.setLocalDescription(answer);
            sendSignal({type: 'answer', answer: pc.localDescription});
          }
        } catch (e) {
          console.error('Error handling incoming offer', e);
          showNotify('Error handling offer: ' + e.message);
        }
        return;
      }

      if (msg.type === 'answer') {
        try {
          await pc.setRemoteDescription(msg.answer);
        } catch (e) {
          console.warn('setRemoteDescription(answer) failed', e);
          const text = (e && e.message) ? e.message.toLowerCase() : '';
          if (text.includes('ice') || text.includes('restart')) {
            log('Detected ICE mismatch — recreating PeerConnection');
            // проще: пересоздаём и инициируем пересогласование
            if (!polite) {
              await recreatePeerConnectionAndRenegotiate();
            }
          } else {
            showNotify('Error setting remote description: ' + e.message);
          }
        }
        return;
      }

      if (msg.type === 'candidate') {
        try {
          if (!pc || !pc.remoteDescription || !pc.remoteDescription.type) {
            // отбрасываем кандидата
            console.warn('Dropping remote candidate: no remoteDescription yet', msg.candidate);
          } else {
            try {
              await pc.addIceCandidate(msg.candidate);
            } catch (err) {
              console.warn('addIceCandidate failed', err);
            }
          }
        } catch (e) {
          console.warn('candidate handling failed', e);
        }
        return;
      }

      if (msg.type === 'leave' || msg.type === 'hangup') {
        window.removeEventListener('beforeunload', unload)
        cleanupPeer();
        history.replaceState(null, null, '/?peer=close');
        location.href = '/?peer=close';
      }
    };

    ws.onclose = (ev) => {
      log('WebSocket closed', ev && ev.code, ev && ev.reason);
      if (isJoined) {
        showNotify('Connection lost. Trying to reconnect...');
        setTimeout(connectSignaling, 2000);
      }

      cleanupPeer();

      setTimeout(() => {
        connectSignaling();
      }, 2000);
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

async function fullRestartAsIfFirstConnect() {
  log('fullRestartAsIfFirstConnect: start');

  // close old pc
  cleanupPeer();
  flushQueue();

  // crate new pc
  await createPeerConnection();

  if (polite) {
    log('Viewer (polite): waiting for new offer after restart');
    return;
  }

  // create offer
  try {
    makingOffer = true;
    const offer = await pc.createOffer();
    offer.sdp = preferCodec(offer.sdp);
    await pc.setLocalDescription(offer);
    sendSignal({type: 'offer', offer: pc.localDescription});
    log('Creator: new offer sent after restart');
  } catch (err) {
    console.error('Creator fullRestart: failed to create/send offer', err);
  } finally {
    makingOffer = false;
  }
}

function flushQueue() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  while (wsMessageQueue.length) {
    const m = wsMessageQueue.shift();
    try {
      ws.send(JSON.stringify(m));
      log('Flushed queued message', m.type);
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
    log('Signal sent', obj.type);
  } catch (e) {
    console.error('sendSignal failed, queueing', e, obj);
    wsMessageQueue.push(obj);
  }
}

async function createPeerConnection() {
  try {
    pc = new RTCPeerConnection({iceServers: STUN_SERVERS});

    // ICE
    pc.onicecandidate = e => {
      if (e.candidate) sendSignal({type: 'candidate', candidate: e.candidate});
    };

    // Tracks received from remote peer
    pc.ontrack = (e) => {
      log('New track received:', e.track.kind, 'mid:', e.transceiver.mid, 'data:', e)
      try {
        if (e.track.kind === 'audio') {
          if (!remoteAudio.srcObject) remoteAudio.srcObject = new MediaStream()
          if (!remoteAudio.srcObject.getTracks().some(t => t.id === e.track.id)) {
            remoteAudio.srcObject.addTrack(e.track)
            log('Added audio track to remoteAudio:', e.track)
          }
        }

        if (e.track.kind === 'video' && e.transceiver.mid === '1') { // 1 - cam
          if (!remoteMiniVideo.srcObject) {
            remoteMiniVideo.srcObject = new MediaStream()
          }
          if (!remoteMiniVideo.srcObject.getTracks().some(t => t.id === e.track.id)) {
            remoteMiniVideo.srcObject.addTrack(e.track)
            trackCamVideo.addTrack(e.track)
            log('Added video screen track:', e.track)
          }
          remoteMiniVideo.addEventListener('canplay', (e) => {
            e.target.classList.add('show');
            e.target.play().catch(err => console.warn('remoteMiniVideo.play failed:', err));
          })
        }

        if (e.track.kind === 'video' && e.transceiver.mid === '2') { // 2 - screen
          if (!remoteScreenVideo.srcObject) {
            remoteScreenVideo.srcObject = new MediaStream()
          }
          if (!remoteScreenVideo.srcObject.getTracks().some(t => t.id === e.track.id)) {
            remoteScreenVideo.srcObject.addTrack(e.track)
            trackScreenVideo.addTrack(e.track)
            log('Added video cam track:', e.track)
          }
          remoteScreenVideo.addEventListener('canplay', (e) => {
            e.target.classList.add('show');
            e.target.play().catch(err => console.warn('remoteScreenVideo.play failed:', err));
          })
        }
      } catch (err) {
        console.warn('ontrack handler error', err);
      }
    };

    pc.onconnectionstatechange = () => {
      log('Connection state:', pc.connectionState);
      if (pc.connectionState === 'connected') {
        startStats();
        showNotify('Connection established!', 'good');
        waitingPeer.classList.remove('show')
      } else if (pc.connectionState === 'disconnected' || pc.connectionState === 'failed') {
        if (!polite) {
          waitingPeer.classList.add('show')
        }
        showNotify('Connection lost!');
      }
    };

    pc.onnegotiationneeded = async () => {
      if (makingOffer) return;
      try {
        makingOffer = true;
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        sendSignal({type: 'offer', offer: pc.localDescription});
      } catch (err) {
        console.error('negotiationneeded error', err);
      } finally {
        makingOffer = false;
      }
    };

    try {

      if (!polite) {
        micTransceiver = pc.addTransceiver('audio', {
          direction: 'sendrecv',
          sendEncodings: [{maxBitrate: 128000}]
        });
        camTransceiver = pc.addTransceiver('video', {
          direction: 'sendrecv',
        });
        screenTransceiver = pc.addTransceiver('video', {
          direction: 'sendrecv',
          sendEncodings: [{maxBitrate: roomBitrate}]
        });
        prefersVidCodec(screenTransceiver)
        screenAudioTransceiver = pc.addTransceiver('audio', {
          direction: 'sendrecv',
          sendEncodings: [{maxBitrate: 128000}]
        });
      } else {
        // add (fill recvonly -> sendrecv) track viewer => creator
        const micStream = new MediaStream([createSilentAudioTrack()]);
        micSender = pc.addTrack(micStream.getAudioTracks()[0], micStream);
        const params = micSender.getParameters();
        if (!params.encodings) params.encodings = [{}];
        params.encodings[0].maxBitrate = 128000;
        await micSender.setParameters(params);
      }

    } catch (err) {
      console.error('pc.addTransceiver err:', err);
    }
  } catch (err) {
    console.error('Failed to create peer connection', err);
    showNotify('Failed to create peer connection: ' + err.message);
  }
}

function prefersVidCodec(transceiver) {
  const caps = RTCRtpSender.getCapabilities('video');
  if (caps && caps.codecs) {
    log('Available codecs:', caps.codecs)
    const prefer = caps.codecs.filter(c =>
      (new RegExp(roomCodec, 'i')).test(c.mimeType));
    const others = caps.codecs.filter(c =>
      !(new RegExp(roomCodec, 'i')).test(c.mimeType));
    if (prefer.length) {
      transceiver.setCodecPreferences([...prefer, ...others]);
      log(`Codec preferences set: ${roomCodec} first:`, prefer);
    }
  }
}

function createSilentAudioTrack() {
  const ctx = new AudioContext();
  const oscillator = ctx.createOscillator();
  const dst = oscillator.connect(ctx.createMediaStreamDestination());
  oscillator.start();
  const track = dst.stream.getAudioTracks()[0];
  track.enabled = false;
  return track;
}

async function forceRenegotiation() {
  if (!pc) return;
  try {
    makingOffer = true;
    const offer = await pc.createOffer();
    offer.sdp = preferCodec(offer.sdp);
    await pc.setLocalDescription(offer);
    sendSignal({type: 'offer', offer: pc.localDescription});
    log('Forced offer sent (renegotiation)');
  } catch (err) {
    console.error('forceRenegotiation failed', err);
  } finally {
    makingOffer = false;
  }
}

async function recreatePeerConnectionAndRenegotiate() {
  log('Recreating PeerConnection...');
  cleanupPeer();
  await createPeerConnection();

  if (!polite) {
    try {
      makingOffer = true;
      const offer = await pc.createOffer();
      offer.sdp = preferCodec(offer.sdp);
      await pc.setLocalDescription(offer);
      sendSignal({type: 'offer', offer: pc.localDescription});
    } catch (err) {
      console.error('Failed to create offer after recreation:', err);
    } finally {
      makingOffer = false;
    }
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
  remoteScreenVideo.srcObject = null;
  prevStats = {};
  makingOffer = false;
}

function cleanup() {
  cleanupPeer();
  if (ws) try {
    ws.close();
  } catch (e) {
  }
  ws = null;
  isJoined = false;
  shareScreenBtn.classList.add('show')
  shareScreen.classList.remove('show')
  shareCamBtn.classList.add('show')
  shareCam.classList.remove('show')
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
    const mLines = [
      {
        mid: '0', // micro
        type: 'outbound-rtp',
        kind: 'audio',
        entity: 'microphone',
        data: '',
        container: outboundMicEl
      }, {
        mid: '1', // cam
        type: 'outbound-rtp',
        kind: 'video',
        entity: 'camera',
        data: '',
        container: outboundCamEl
      }, {
        mid: '2', // screen
        type: 'outbound-rtp',
        kind: 'video',
        entity: 'screen',
        data: '',
        container: outboundScrEl
      }, {
        mid: '3', // screen audio
        type: 'outbound-rtp',
        kind: 'audio',
        entity: 'screen-audio',
        data: '',
        container: outboundScrAEl
      }, {
        mid: '0', // micro
        type: 'inbound-rtp',
        kind: 'audio',
        entity: 'microphone',
        data: '',
        container: inboundMicEl
      }, {
        mid: '1', // cam
        type: 'inbound-rtp',
        kind: 'video',
        entity: 'camera',
        data: '',
        container: inboundCamEl
      }, {
        mid: '2', // screen
        type: 'inbound-rtp',
        kind: 'video',
        entity: 'screen',
        data: '',
        container: inboundScrEl
      }, {
        mid: '3', // screen audio
        type: 'inbound-rtp',
        kind: 'audio',
        entity: 'screen-audio',
        data: '',
        container: inboundScrAEl
      },
    ]

    const now = performance.now()

    let codecsAudio = []
    let codecsVideo = []
    stats.forEach(report => {
      if (report.type === 'codec' && report.mimeType) {
        let codec = report.mimeType.replace('audio/', '')
          .replace('video/', '').toUpperCase()
        if (report.mimeType.startsWith('audio/') && !codecsAudio.includes(codec)) {
          codecsAudio.push(codec)
        }
        if (report.mimeType.startsWith('video/') && !codecsVideo.includes(codec)) {
          codecsVideo.push(codec)
        }
      }
    })

    for (let m in mLines) {
      let line = mLines[m]
      stats.forEach(report => {
        const bytes = report.bytesSent || report.bytesReceived
        if (line.type === report.type && line.kind === report.kind && line.mid === report.mid && bytes > 0) {
          const id = report.id || report.ssrc || 'out-v-' + report.mid;
          const prev = prevStats[id] || {bytes: bytes || 0, timestamp: now};
          const deltaBytes = (bytes || 0) - (prev.bytes || 0);
          const deltaTime = (now - (prev.timestamp || now)) / 1000 || 1;
          const kbps = Math.round((deltaBytes * 8) / 1000 / deltaTime);
          prevStats[id] = {bytes: bytes || 0, timestamp: now};

          mLines[m].data += `<span>${kbps} Kbps</span>`;
          mLines[m].data += `<span>${line.type === 'inbound-rtp'
            ? 'Received'
            : 'Sent'}` + ` ${Math.round((bytes || 0) * 8 / 1000 / 1000)} MB</span>`;
          mLines[m].data += `<span>${line.type === 'inbound-rtp'
            ? report.packetsReceived
            : report.packetsSent} packets</span>`;

          if (line.kind === 'video') {
            if (report?.frameWidth > 0 && report?.frameHeight > 0) {
              mLines[m].data += `<span>${report.frameWidth}x${report.frameHeight}</span>`;
            }
            mLines[m].data += `<span>${Math.round(report.framesPerSecond || 0)} FPS</span>`;
            if (codecsVideo.length > 0) {
              mLines[m].data += codecsVideo.map(e => `<span>${e}</span>`).join('')
            }
          } else {
            if (codecsAudio.length > 0) {
              mLines[m].data += codecsAudio.map(e => `<span>${e}</span>`).join('')
            }
          }
        }
      })
    }

    mLines.forEach(m => {
      m.container.innerHTML = m.data
      if (m.data.length > 0) {
        m.container.parentNode.classList.add('show')
      } else {
        m.container.parentNode.classList.remove('show')
      }
    })
  }, 1000);
}

function testParams() {
  try {
    const sender = pc.getSenders().find(s => s.track && s.track.kind === 'video')
    if (sender) {
      const params = sender.getParameters()
      log(`sender params: ${JSON.stringify(params, null, 2)}`)
    }
  } catch (err) {
    console.error(`sender params err:`, err)
  }

  console.table(pc.getReceivers().map((r, i) => ({
    i,
    trackId: r.track?.id ?? null,
    kind: r.track?.kind ?? null,
    readyState: r.track?.readyState ?? null,
    trackLabel: r.track?.label ?? null
  })));

  console.table(pc.getTransceivers().map((t, i) => ({
    i,
    mid: t.mid ?? null,
    direction: t.direction,
    senderTrack: t.sender?.track?.id ?? null,
    receiverTrack: t.receiver?.track?.id ?? null
  })));
}

function testStun() {
  (function (servers) {
    servers.forEach(stun => {
      log('test stun:', stun.urls)

      const pc = new RTCPeerConnection({
        iceServers: [{urls: stun.urls}]
      })

      pc.createDataChannel('test')
      pc.createOffer().then(o => pc.setLocalDescription(o))

      pc.onicecandidate = e => {
        if (e.candidate) {
          log(stun.urls, 'candidate:', e.candidate.candidate)
        }
      }
    })
  })(STUN_SERVERS)
}