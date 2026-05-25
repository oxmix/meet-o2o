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
const settingsBtn = document.querySelector('.top-right .settings-btn')
const settingsModal = document.querySelector('.settings-modal')
const settingsCard = settingsModal.querySelector('.settings-card')
const settingsCloseBtn = settingsModal.querySelector('.btn-close-settings')
const selMic = settingsModal.querySelector('.sel-mic')
const selSpeaker = settingsModal.querySelector('.sel-speaker')
const selCam = settingsModal.querySelector('.sel-cam')
const selScreenRes = settingsModal.querySelector('.sel-screen-res')
const selScreenFps = settingsModal.querySelector('.sel-screen-fps')
const selScreenCodec = settingsModal.querySelector('.sel-screen-codec')
const chatBox = document.querySelector('.chat-box')
const chatHeader = chatBox.querySelector('.chat-header')
const chatUnreadEl = chatBox.querySelector('.chat-unread')
const chatMessagesEl = chatBox.querySelector('.chat-messages')
const chatInput = chatBox.querySelector('textarea')

/* state */
let ws;
let wsReconnectTimeout = null
let wsConnecting = false
let wsMessageQueue = []
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
const state = {
  type: 'state',
  micMute: false,
  cam: false,
  screen: false,
}
let stopEffectScreen = false
let establishedVideoMd1 = false
let pendingRemoteCandidates = []
let lastNegotiationAt = 0
const negotiationDebounceMs = 800
let lastHexSdpLocal = null
let lastHexSdpRemote = null

/* perfect negotiation flags */
let makingOffer = false;
let polite = true;
let ignoreOffer = false;

/* stats */
let statsTimer;
let prevStats = {};

/* chat */
let chatChannel = null
let chatPendingOut = []
let chatUnread = 0

/* quality */
let roomWidth = 1920
let roomHeight = 1080
let roomFps = 30
let roomBitrate = roomWidth * roomHeight * roomFps * .065
let roomCodec = 'VP9'
const qRes = localStorage.getItem('q-res')
if (qRes) {
  const qxRes = qRes.split('x')
  if (qxRes.length > 1) {
    roomWidth = parseInt(qxRes[0])
    roomHeight = parseInt(qxRes[1])
    document.querySelector('#select-resolution').value = qRes
  }
}
const qFps = localStorage.getItem('q-fps')
if (qFps) {
  document.querySelector('#select-fps').value = roomFps = parseInt(qFps)

  roomBitrate = roomWidth * roomHeight * roomFps * .065
}
const qCodec = localStorage.getItem('q-codec')
if (qCodec) {
  document.querySelector('#select-codec').value = roomCodec = qCodec
}
if (qRes || qFps || qCodec) {
  calcBitrate()
}

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
  localStorage.setItem('q-res', e.target.value)
  ;[roomWidth, roomHeight] = e.target.value.split('x').map(parseFloat)
  calcBitrate()
});
document.querySelector('#select-fps').addEventListener('change', (e) => {
  roomFps = +e.target.value
  localStorage.setItem('q-fps', roomFps)
  calcBitrate()
});
document.querySelector('#select-codec').addEventListener('change', (e) => {
  roomCodec = e.target.value
  localStorage.setItem('q-codec', roomCodec)
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

function showNotify(message, cls, closeAfter) {
  closeAfter = closeAfter || 5000
  notifyMsg.textContent = message;
  notifyMsg.classList.add('show', cls || 'error');
  setTimeout(() => {
    notifyMsg.classList.remove('show', cls || 'error');
  }, closeAfter);
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
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    log('connect: signaling already connecting/open — skip duplicate connect()')
  }

  makingOffer = false
  ignoreOffer = false
  isJoined = false
  establishedVideoMd1 = false

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

let micDeviceId = localStorage.getItem('dev-mic') || ''
let camDeviceId = localStorage.getItem('dev-cam') || ''
let speakerDeviceId = localStorage.getItem('dev-speaker') || ''

async function initMic() {
  try {
    const audioCons = {echoCancellation: true, noiseSuppression: true, autoGainControl: true}
    if (micDeviceId) audioCons.deviceId = {ideal: micDeviceId}
    micStream = await navigator.mediaDevices.getUserMedia({audio: audioCons});

    if (micStream) {
      const sender = micSender || micTransceiver.sender
      await sender.replaceTrack(micStream.getAudioTracks()[0]);
      await improveAudio(sender)
    }

    soundEffect(micStream, micBtnEl)
    soundEffect(micStream, shareCam)
    log('Mic capture ok, tracks:', micStream.getTracks());
  } catch (err) {
    if (err.message.includes('The request is not allowed by the user agent or the platform')) {
      console.warn('Mic capture failed:', err)
      showNotify('Microphone access is required for this app. Please allow microphone access')
    } else {
      showNotify(err, false, 60000)
    }
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
    if (stopEffectScreen && to.classList.contains('share-cam')) {
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
      applyVideoCodecPreferences()
      vidSender = screenTransceiver.sender
    }
    await vidSender.replaceTrack(screenVideoTrack)

    // set fps, bitrate, resolution
    await applyScreenQuality()

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

function extractFingerprintHexFromSdp(sdp) {
  if (!sdp) return null
  const m = sdp.match(/a=fingerprint:sha-256\s*([0-9A-Fa-f:]+)/i)
  if (!m || !m[1]) return null
  return m[1].replace(/:/g, '').toLowerCase()
}

function hexToBytes(hex) {
  if (!hex) return null
  const pairs = hex.match(/.{1,2}/g)
  if (!pairs) return null
  return new Uint8Array(pairs.map(p => parseInt(p, 16)))
}

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('')
}

function xorBytes(a, b) {
  const len = Math.max(a.length, b.length)
  const out = new Uint8Array(len)
  for (let i = 0; i < len; i++) {
    const av = a[i] || 0
    const bv = b[i] || 0
    out[i] = av ^ bv
  }
  return out
}

function emojisFromHex(hex, count = 3) {
  const bytes = hexToBytes(hex)
  if (!bytes) return ''
  let s = ''
  for (let i = 0; i < count; i++) {
    const b = bytes[i] ?? 0
    s += fpEmojis[b % fpEmojis.length]
  }
  return s
}

function showFingerprint(localHex, remoteHex) {
  lastHexSdpLocal = localHex
  lastHexSdpRemote = remoteHex

  if (localHex && remoteHex) {
    const L = hexToBytes(localHex)
    const R = hexToBytes(remoteHex)
    const comb = xorBytes(L, R)
    const combHex = bytesToHex(comb)
    fpEl.textContent = emojisFromHex(combHex, 3)
    fpEl.classList.remove('hide')
    return
  }
  if (localHex) {
    fpEl.textContent = emojisFromHex(localHex, 3)
    fpEl.classList.remove('hide')
    return
  }
  if (remoteHex) {
    fpEl.textContent = emojisFromHex(remoteHex, 3)
    fpEl.classList.remove('hide')
    return
  }
  fpEl.classList.add('hide')
}

function connectSignaling() {
  try {
    log('connectSignaling -> SIGNALING_URL =', SIGNALING_URL);
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      log('WS already connecting/open, skip connectSignaling')
      return;
    }
    wsConnecting = true
    ws = new WebSocket(SIGNALING_URL);

    ws.onopen = () => {
      wsConnecting = false
      flushQueue()
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
          await forceRenegotiation()
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
        log('Peer replaced (server) — performing soft restart (reconnect signaling)')
        cleanupPeer()
        await connect()
        try {
          await restoreLocalSenders()
          log('restoreLocalSenders completed')
        } catch (err) {
          console.warn('restoreLocalSenders failed, err:', err)
        }
        sendSignal(state)
        return
      }

      if (msg.type === 'joined') {
        log('joined received; polite=', polite);
        isJoined = true;
        return
      }

      if (msg.type === 'state') {
        log('State received:', msg)

        if (msg.cam && !msg.screen) {
          // might track video md1 received after state signal
          const delay = establishedVideoMd1 ? 1 : 1000

          setTimeout(() => {
            remoteMiniVideo.classList.remove('show')
            remoteMiniVideo.srcObject = null
            remoteScreenVideo.classList.add('show')
            remoteScreenVideo.srcObject = trackCamVideo
          }, delay)
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

          const offerCollision = makingOffer || pc.signalingState !== 'stable';
          ignoreOffer = !polite && offerCollision;
          if (ignoreOffer) {
            log('Ignoring incoming offer due to collision (impolite).');
            return;
          }

          if (offerCollision) {
            await pc.setLocalDescription({type: 'rollback'})
            log('Performed local rollback before applying remote offer');
          }

          await setRemoteDescriptionWithDiagnostics(msg.offer, 'offer')

          await flushPendingRemoteCandidates()

          // Простая версия: сразу создаём answer если состояние это позволяет
          if (pc.signalingState === 'have-remote-offer') {
            if (polite) {
              const remoteCodec = getPreferredVideoCodecFromSdp(msg.offer?.sdp)
              if (remoteCodec && remoteCodec !== roomCodec) {
                log(`Polite: adopting codec from offer: ${roomCodec} -> ${remoteCodec}`)
                roomCodec = remoteCodec
                localStorage.setItem('q-codec', roomCodec)
                if (selScreenCodec) selScreenCodec.value = roomCodec
              }
            }
            applyVideoCodecPreferences()
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);

            // remote hex might from pc.remoteDescription.sdp after await pc.setRemoteDescription(msg.offer) but not on way
            showFingerprint(
              extractFingerprintHexFromSdp(pc.localDescription?.sdp) || null,
              extractFingerprintHexFromSdp(msg.offer?.sdp) || null
            )

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
          if (!pc || pc.connectionState === 'closed') {
            console.warn('Dropping answer: no active pc');
            return;
          }
          if (pc.remoteDescription && pc.remoteDescription.sdp === msg.answer.sdp) {
            log('Duplicate answer, skipping')
            return;
          }
          if (pc.signalingState !== 'have-local-offer') {
            console.warn('Skipping unexpected answer in state', pc.signalingState)
            if (!polite) {
              await restartConnection()
            }
            return;
          }
          await setRemoteDescriptionWithDiagnostics(msg.answer, 'answer');

          showFingerprint(
            extractFingerprintHexFromSdp(msg.answer?.sdp) || null,
            extractFingerprintHexFromSdp(pc.localDescription?.sdp) || null
          );

          await flushPendingRemoteCandidates();
        } catch (e) {
          console.warn('setRemoteDescription(answer) failed', e);
          const text = (e && e.message) ? e.message.toLowerCase() : '';
          if (text.includes('ice') || text.includes('restart') || text.includes('unknown ufrag')) {
            log('Detected ICE mismatch — recreating PeerConnection');
            if (!polite) {
              await restartConnection()
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
            // буферизуем кандидат пока нет remoteDescription
            console.warn('Buffering remote candidate: no remoteDescription yet', msg.candidate);
            pendingRemoteCandidates.push(msg.candidate);
          } else {
            try {
              await pc.addIceCandidate(msg.candidate);
            } catch (err) {
              console.warn('addIceCandidate failed', err);
              // если Unknown ufrag — кандидат старый, можно проигнорировать
              const text = (err && err.message) ? err.message.toLowerCase() : '';
              if (text.includes('unknown ufrag')) {
                console.warn('Dropping candidate with unknown ufrag');
              } else {
                console.error(text)
              }
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
      wsConnecting = false
      log('WebSocket closed', ev && ev.code, ev && ev.reason)

      cleanupPeer()

      if (wsReconnectTimeout) {
        clearTimeout(wsReconnectTimeout)
      }
      wsReconnectTimeout = setTimeout(() => {
        if (!ws || ws.readyState === WebSocket.CLOSED) {
          connectSignaling()
        } else {
          log('ws.onclose: socket already connecting/open, skip reconnect')
        }
      }, 2000)

      if (!document.hidden) {
        showNotify('Connection lost. Reconnecting...')
      }

      try {
        ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null
      } catch (e) {
      }
    }

    ws.onerror = (e) => {
      console.error('WS error', e);
      showNotify('WebSocket error: ' + (e && e.message));
    };
  } catch (e) {
    console.error('Failed to connect to signaling server', e);
    showNotify('Failed to connect to signaling server: ' + e.message);
  }
}

async function restartConnection() {
  log('restartConnection')

  cleanupPeer()

  wsMessageQueue = []
  log('restartConnection: wsMessageQueue cleared')

  pendingRemoteCandidates = []

  await createPeerConnection()

  try {
    await restoreLocalSenders()
    log('restartConnection: restoreLocalSenders completed')
  } catch (e) {
    console.warn('restartConnection: restoreLocalSenders failed', e)
  }

  if (polite) {
    log('restartConnection: polite viewer — waiting for new offer')
    return
  }

  try {
    await forceRenegotiation()
    log('restartConnection: forceRenegotiation done')
  } catch (e) {
    console.error('restartConnection: forceRenegotiation failed', e)
  }
}

function flushQueue() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  // удалить старые офферы кроме последнего
  let lastOfferIndex = -1
  for (let i = wsMessageQueue.length - 1; i >= 0; i--) {
    if (wsMessageQueue[i].type === 'offer') {
      lastOfferIndex = i
      break
    }
  }
  if (lastOfferIndex >= 0) {
    wsMessageQueue = wsMessageQueue.filter((m, i) => {
      return !(m.type === 'offer' && i !== lastOfferIndex)
    })
  }

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
  obj.room = room
  try {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      console.warn('WS not OPEN, queueing', obj.type)
      wsMessageQueue.push(obj)
      if (wsMessageQueue.length > 200) {
        wsMessageQueue = wsMessageQueue.slice(-200)
      }
      return
    }
    ws.send(JSON.stringify(obj))
    log('Signal sent', obj.type)
  } catch (e) {
    console.error('sendSignal failed, queueing', e, obj)
    wsMessageQueue.push(obj)
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
          const aStream = remoteAudio.srcObject instanceof MediaStream
            ? remoteAudio.srcObject : new MediaStream()
          if (!aStream.getTracks().some(t => t.id === e.track.id)) {
            aStream.addTrack(e.track)
          }
          // re-assign forces Chrome to bind the new track to the element
          remoteAudio.srcObject = aStream
          remoteAudio.play().catch(err => console.warn('remoteAudio.play failed:', err))
          log('Added audio track to remoteAudio:', e.track)
        }

        if (e.track.kind === 'video' && e.transceiver.mid === '1') { // 1 - cam
          establishedVideoMd1 = true

          // rebuild stream around the fresh track — addTrack on an already-bound
          // MediaStream is not always picked up by Chrome after renegotiation
          trackCamVideo = new MediaStream([e.track])
          if (remoteMiniVideo.srcObject) {
            remoteMiniVideo.srcObject = trackCamVideo
          }
          if (remoteScreenVideo.srcObject && !state.screen) {
            // big view was holding cam (cam-only state) — refresh it
            remoteScreenVideo.srcObject = trackCamVideo
          }
          remoteMiniVideo.addEventListener('canplay', function onCanPlay(ev) {
            ev.target.removeEventListener('canplay', onCanPlay)
            ev.target.classList.add('show')
            ev.target.play().catch(err => console.warn('remoteMiniVideo.play failed:', err))
          })
          log('Bound cam video track:', e.track)
        }

        if (e.track.kind === 'video' && e.transceiver.mid === '2') { // 2 - screen
          trackScreenVideo = new MediaStream([e.track])
          // if big view was already attached (state arrived first), re-bind so
          // Chrome actually starts decoding the new track
          if (remoteScreenVideo.srcObject) {
            remoteScreenVideo.srcObject = trackScreenVideo
          }
          remoteScreenVideo.addEventListener('canplay', function onCanPlay(ev) {
            ev.target.removeEventListener('canplay', onCanPlay)
            ev.target.classList.add('show')
            ev.target.play().catch(err => console.warn('remoteScreenVideo.play failed:', err))
          })
          log('Bound screen video track:', e.track)
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
          forceRenegotiation()
        }
        showNotify('Connection lost!');
      }
    };

    pc.ondatachannel = (e) => {
      if (e.channel.label === 'chat') {
        chatChannel = e.channel
        setupChatChannel(chatChannel)
      }
    };

    pc.onnegotiationneeded = async () => {
      if (makingOffer) {
        console.warn('Event pc.onnegotiationneeded err: already making')
        return
      }
      if (ignoreOffer) {
        console.warn('Ignoring negotiationneeded due to ignoreOffer')
        return
      }

      // try to fix: waiting stable
      if (!pc || pc.signalingState !== 'stable') {
        log('negotiationneeded ignored: signalingState=', pc?.signalingState);
        return;
      }

      const now = Date.now()
      if (now - lastNegotiationAt < negotiationDebounceMs) {
        console.warn('Debounced frequent negotiationneeded')
        return
      }
      lastNegotiationAt = now

      if (!ws || ws.readyState !== WebSocket.OPEN) {
        console.warn('WS not open — delaying negotiationneeded')
        setTimeout(() => {
          try {
            if (pc && !makingOffer) pc.onnegotiationneeded?.()
          } catch (e) {
          }
        }, 500)
        return
      }

      log('Event pc.onnegotiationneeded')
      await forceRenegotiation()
    }

    try {

      if (!polite) {
        chatChannel = pc.createDataChannel('chat', {ordered: true})
        setupChatChannel(chatChannel)

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
        applyVideoCodecPreferences()
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

function isVideoTransceiver(transceiver) {
  return transceiver?.receiver?.track?.kind === 'video'
    || transceiver?.sender?.track?.kind === 'video'
}

function codecMimeMatches(codec, preferredCodec) {
  return codec?.mimeType?.toLowerCase() === `video/${preferredCodec}`.toLowerCase()
}

function applyVideoCodecPreferences() {
  if (!pc || typeof RTCRtpSender === 'undefined' || typeof RTCRtpSender.getCapabilities !== 'function') return

  const caps = RTCRtpSender.getCapabilities('video');
  if (!caps?.codecs?.length) return

  const prefer = caps.codecs.filter(c => codecMimeMatches(c, roomCodec));
  if (!prefer.length) {
    console.warn(`Codec ${roomCodec} is not available for video`, caps.codecs);
    return
  }

  const others = caps.codecs.filter(c => !codecMimeMatches(c, roomCodec));
  const preferredCodecs = [...prefer, ...others];
  const transceivers = pc.getTransceivers().filter(isVideoTransceiver);

  for (const transceiver of transceivers) {
    try {
      transceiver.setCodecPreferences(preferredCodecs);
      log(`Codec preferences set for video transceiver ${transceiver.mid ?? '(pending)'}: ${roomCodec} first`, prefer);
    } catch (err) {
      console.warn('setCodecPreferences failed', err, {
        codec: roomCodec,
        mid: transceiver.mid,
      });
    }
  }
}

async function applyScreenQuality() {
  const track = screenStream?.getVideoTracks()[0]
  const sender = screenTransceiver?.sender
  if (!track || !sender) return

  try {
    await track.applyConstraints({
      width: {ideal: roomWidth},
      height: {ideal: roomHeight},
      frameRate: {ideal: roomFps},
    })
  } catch (err) {
    log('screen track.applyConstraints failed (will fall back to scaleResolutionDownBy):', err)
  }

  const settings = track.getSettings?.() || {}
  const actualW = settings.width || roomWidth
  const actualH = settings.height || roomHeight
  const scale = Math.max(actualW / roomWidth, actualH / roomHeight, 1)

  try {
    const params = sender.getParameters()
    if (!params.encodings?.length) params.encodings = [{}]
    params.encodings[0].maxBitrate = roomBitrate
    params.encodings[0].maxFramerate = roomFps
    params.encodings[0].scaleResolutionDownBy = scale
    log('applyScreenQuality:', {
      target: `${roomWidth}x${roomHeight}@${roomFps}`,
      actual: `${actualW}x${actualH}`,
      scaleResolutionDownBy: scale,
      maxBitrate: roomBitrate,
    })
    await sender.setParameters(params)
  } catch (err) {
    console.warn('applyScreenQuality setParameters err:', err)
  }
}

async function setRemoteDescriptionWithDiagnostics(description, kind) {
  try {
    await pc.setRemoteDescription(description)
  } catch (err) {
    console.warn(`setRemoteDescription(${kind}) failed; SDP diagnostics:`, summarizeSdpCodecs(description?.sdp));
    throw err
  }
}

function getPreferredVideoCodecFromSdp(sdp) {
  if (!sdp) return null
  const eol = sdp.includes('\r\n') ? '\r\n' : '\n'
  const lines = sdp.split(eol)
  const mIdx = lines.findIndex(l => l.startsWith('m=video'))
  if (mIdx === -1) return null
  const parts = lines[mIdx].split(' ')
  const firstPt = parts[3]
  if (!firstPt) return null
  const rtpmap = lines.find(l => l.startsWith(`a=rtpmap:${firstPt} `))
  if (!rtpmap) return null
  const m = rtpmap.match(/^a=rtpmap:\d+\s+([^/]+)\//)
  return m ? m[1].toUpperCase() : null
}

function summarizeSdpCodecs(sdp) {
  if (!sdp) return null

  const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
  return sdp
    .split(eol)
    .filter(line =>
      line.startsWith('m=video')
      || line.startsWith('a=mid:')
      || line.startsWith('a=rtpmap:')
      || line.startsWith('a=fmtp:')
    )
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
  if (!pc) {
    console.error('forceRenegotiation err pc:', pc)
    return
  }
  try {
    makingOffer = true
    applyVideoCodecPreferences()
    const offer = await pc.createOffer()
    if (pc.signalingState !== 'stable') {
      log('negotiation race detected: abort local offer');
      return;
    }
    await pc.setLocalDescription(offer)
    sendSignal({type: 'offer', offer: pc.localDescription});
    log('Forced offer sent (renegotiation)')
  } catch (err) {
    console.error('forceRenegotiation failed', err)
  } finally {
    makingOffer = false
  }
}

async function restoreLocalSenders() {
  // try mic
  try {
    const micTrack = micStream?.getAudioTracks()[0] ?? null;
    if (micTrack) {
      if (micTransceiver && micTransceiver.sender) {
        await micTransceiver.sender.replaceTrack(micTrack);
        micTransceiver.direction = 'sendrecv';
        log('Restored mic via transceiver.sender.replaceTrack()');
      }
    }
  } catch (err) {
    console.warn('restoreLocalSenders: mic restore failed', err);
  }

  // try cam
  try {
    const camTrack = camStream?.getVideoTracks()[0] ?? null;
    if (camTrack) {
      if (camTransceiver && camTransceiver.sender) {
        await camTransceiver.sender.replaceTrack(camTrack);
        log('Restored cam via transceiver.sender.replaceTrack()');
      }
    }
  } catch (err) {
    console.warn('restoreLocalSenders: cam restore failed', err);
  }

  // try screen
  try {
    const screenVideo = screenStream?.getVideoTracks()[0] ?? null;
    if (screenVideo) {
      if (screenTransceiver && screenTransceiver.sender) {
        await screenTransceiver.sender.replaceTrack(screenVideo);
        log('Restored screen video via transceiver.sender.replaceTrack()');
      }
    }
    const screenAudio = screenStream?.getAudioTracks()[0] ?? null;
    if (screenAudio) {
      if (screenAudioTransceiver && screenAudioTransceiver.sender) {
        await screenAudioTransceiver.sender.replaceTrack(screenAudio);
        log('Restored screen audio via transceiver.sender.replaceTrack()');
      }
    }
  } catch (err) {
    console.warn('restoreLocalSenders: screen restore failed', err);
  }
}

async function flushPendingRemoteCandidates() {
  if (!pendingRemoteCandidates.length || !pc || !pc.remoteDescription || !pc.remoteDescription.type) return;
  const list = pendingRemoteCandidates.splice(0); // забираем все
  for (const c of list) {
    try {
      await pc.addIceCandidate(c);
    } catch (err) {
      console.warn('flush addIceCandidate failed', err);
    }
  }
}

function stopAndNullStream(ref) {
  if (!ref) return;
  try {
    ref.getTracks().forEach(t => {
      try {
        t.stop();
      } catch (e) {
      }
    });
  } catch (e) {
  }
}

function cleanupPeer() {
  if (statsTimer) {
    clearInterval(statsTimer)
    statsTimer = null
  }

  // close pc and remove refs
  if (pc) {
    try {
      pc.ontrack = null
      pc.onicecandidate = null
      pc.onconnectionstatechange = null
      pc.onnegotiationneeded = null
      pc.close()
    } catch (e) {
    }
  }
  pc = null

  // clear transceiver / sender refs so они не используются повторно
  micSender = null
  micTransceiver = null
  camTransceiver = null
  screenTransceiver = null
  screenAudioTransceiver = null

  try {
    chatChannel?.close()
  } catch (e) {
  }
  chatChannel = null

  // clear media elements / remote tracks containers
  try {
    remoteScreenVideo.srcObject = null
  } catch (e) {
  }
  try {
    remoteMiniVideo.srcObject = null
  } catch (e) {
  }
  try {
    remoteAudio.srcObject = null
  } catch (e) {
  }

  prevStats = {}
  makingOffer = false
  ignoreOffer = false
  establishedVideoMd1 = false

  // clear candidate buffer
  pendingRemoteCandidates = []
}

function cleanup() {
  cleanupPeer()

  stopAndNullStream(micStream)
  stopAndNullStream(camStream)
  stopAndNullStream(screenStream)
  micStream = camStream = screenStream = null

  if (ws) {
    try {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null
      ws.close()
    } catch (e) {
    }
  }
  ws = null
  wsMessageQueue = []
  isJoined = false

  shareScreenBtn.classList.add('show')
  shareScreen.classList.remove('show')
  shareCamBtn.classList.add('show')
  shareCam.classList.remove('show')
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

async function getIceTransportInfo(pc) {
  if (!pc) throw new Error('pc is required')
  const stats = await pc.getStats()
  let selectedPair = null

  stats.forEach(report => {
    if (report.type === 'candidate-pair' && (report.selected || report.nominated || report.state === 'succeeded')) {
      // prefer explicit selected, else nominated/succeeded
      if (!selectedPair) selectedPair = report
      else {
        // prefer report.selected first
        if (report.selected && !selectedPair.selected) selectedPair = report
      }
    }
  })

  if (!selectedPair) {
    let best = null
    stats.forEach(report => {
      if (report.type === 'candidate-pair' && report.state === 'succeeded') {
        const score = (report.bytesSent || 0) + (report.bytesReceived || 0)
        if (!best || score > ((best.bytesSent || 0) + (best.bytesReceived || 0))) best = report
      }
    })
    selectedPair = best
  }

  if (!selectedPair) return {ok: false, reason: 'no candidate-pair found'}

  const localId = selectedPair.localCandidateId || selectedPair.localCandidateId
  const remoteId = selectedPair.remoteCandidateId || selectedPair.remoteCandidateId

  let local = null, remote = null
  stats.forEach(r => {
    if (!local && (r.type === 'local-candidate' || r.type === 'localcandidate')) {
      if (r.id === localId || r.localCandidateId === localId) local = r
    }
    if (!remote && (r.type === 'remote-candidate' || r.type === 'remotecandidate')) {
      if (r.id === remoteId || r.remoteCandidateId === remoteId) remote = r
    }
  })

  // some browsers report candidate entries with slightly different field names
  const getType = c => c?.candidateType || c?.type || c?.candidate?.type || null

  const localType = getType(local) || 'unknown'
  const remoteType = getType(remote) || 'unknown'

  // map to human conclusion
  let via = 'unknown'
  if (localType === 'relay' || remoteType === 'relay') via = 'TURN (relayed)'
  else if (localType === 'srflx' || remoteType === 'srflx') via = 'STUN (server-reflexive — P2P)'
  else if (localType === 'host' && remoteType === 'host') via = 'direct (host — LAN)'
  else if (localType === 'prflx' || remoteType === 'prflx') via = 'peer-reflexive (P2P)'
  // return richer info
  return {
    ok: true,
    pair: {
      id: selectedPair.id,
      state: selectedPair.state,
      nominated: !!selectedPair.nominated,
      selected: !!selectedPair.selected,
      bytesSent: selectedPair.bytesSent,
      bytesReceived: selectedPair.bytesReceived,
      protocol: selectedPair.protocol || null,
    },
    local: local ? {
      id: local.id,
      ip: local.ip || local.address || local.candidate?.ip || null,
      port: local.port || local.portNumber || local.candidate?.port || null,
      type: localType,
      address: local.address || local.ip || null,
      candidate: local.candidate || null
    } : null,
    remote: remote ? {
      id: remote.id,
      ip: remote.ip || remote.address || remote.candidate?.ip || null,
      port: remote.port || remote.portNumber || remote.candidate?.port || null,
      type: remoteType,
      address: remote.address || remote.ip || null,
      candidate: remote.candidate || null
    } : null,
    conclusion: via
  }
}

function info() {
  log('pc.getSenders()')
  console.table(pc.getSenders().map((s, i) => ({
    i,
    trackId: s.track?.id ?? null,
    kind: s.track?.kind ?? null,
    readyState: s.track?.readyState ?? null,
    trackLabel: s.track?.label ?? null,
    params: JSON.stringify(s.getParameters())
  })))

  log('pc.getReceivers()')
  console.table(pc.getReceivers().map((r, i) => ({
    i,
    trackId: r.track?.id ?? null,
    kind: r.track?.kind ?? null,
    readyState: r.track?.readyState ?? null,
    trackLabel: r.track?.label ?? null,
    params: JSON.stringify(r.getParameters())
  })))

  log('pc.getTransceivers()')
  console.table(pc.getTransceivers().map((t, i) => ({
    i,
    mid: t.mid ?? null,
    direction: t.direction,
    senderTrack: t.sender?.track?.id ?? null,
    receiverTrack: t.receiver?.track?.id ?? null,
  })))

  getIceTransportInfo(pc).then(log).catch(console.error)
}

/* Settings: live device switching without renegotiation */
settingsBtn.addEventListener('click', async () => {
  syncScreenQualitySelects()
  await refreshDeviceSelects()
  settingsModal.classList.add('show')
})
settingsCloseBtn.addEventListener('click', () => settingsModal.classList.remove('show'))
settingsModal.addEventListener('click', (e) => {
  if (e.target === settingsModal) settingsModal.classList.remove('show')
})
settingsCard.addEventListener('click', (e) => e.stopPropagation())

if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
  navigator.mediaDevices.addEventListener('devicechange', () => {
    if (settingsModal.classList.contains('show')) refreshDeviceSelects()
  })
}

async function refreshDeviceSelects() {
  let devices = []
  try {
    devices = await navigator.mediaDevices.enumerateDevices()
  } catch (err) {
    console.warn('enumerateDevices failed', err)
    return
  }

  const fill = (sel, kind, currentId, fallbackLabel) => {
    while (sel.firstChild) sel.removeChild(sel.firstChild)
    const items = devices.filter(d => d.kind === kind && d.deviceId)
    if (!items.length) {
      const o = document.createElement('option')
      o.value = ''
      o.textContent = '(no devices)'
      sel.appendChild(o)
      sel.disabled = true
      return
    }
    sel.disabled = false
    items.forEach((d, i) => {
      const o = document.createElement('option')
      o.value = d.deviceId
      o.textContent = d.label || `${fallbackLabel} ${i + 1}`
      sel.appendChild(o)
    })
    if (currentId && items.some(d => d.deviceId === currentId)) {
      sel.value = currentId
    }
  }

  const curMicId = micStream?.getAudioTracks()[0]?.getSettings?.().deviceId || micDeviceId
  const curCamId = camStream?.getVideoTracks()[0]?.getSettings?.().deviceId || camDeviceId
  fill(selMic, 'audioinput', curMicId, 'Microphone')
  fill(selSpeaker, 'audiooutput', speakerDeviceId, 'Speaker')
  fill(selCam, 'videoinput', curCamId, 'Camera')

  if (typeof remoteAudio.setSinkId !== 'function') {
    selSpeaker.disabled = true
    selSpeaker.title = 'Output device selection not supported in this browser'
  }
  if (!camStream) {
    selCam.title = 'Camera selection will apply when you start sharing'
  } else {
    selCam.removeAttribute('title')
  }
}

selMic.addEventListener('change', async () => {
  const id = selMic.value
  if (!id) return
  micDeviceId = id
  localStorage.setItem('dev-mic', id)
  try {
    const newStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: {exact: id},
        echoCancellation: true, noiseSuppression: true, autoGainControl: true
      }
    })
    const newTrack = newStream.getAudioTracks()[0]
    newTrack.enabled = !state.micMute
    const sender = micSender || micTransceiver?.sender
    if (sender) await sender.replaceTrack(newTrack)
    try {
      micStream?.getTracks().forEach(t => t.stop())
    } catch (e) {
    }
    micStream = newStream
    log('Mic switched to', id)
  } catch (err) {
    console.error('Mic switch failed', err)
    showNotify('Failed to switch microphone: ' + err.message)
  }
})

selSpeaker.addEventListener('change', async () => {
  const id = selSpeaker.value
  speakerDeviceId = id
  localStorage.setItem('dev-speaker', id)
  if (typeof remoteAudio.setSinkId !== 'function') {
    showNotify('Output device selection not supported here')
    return
  }
  try {
    await remoteAudio.setSinkId(id)
    log('Speaker switched to', id)
  } catch (err) {
    console.error('Speaker switch failed', err)
    showNotify('Failed to switch speaker: ' + err.message)
  }
})

selCam.addEventListener('change', async () => {
  const id = selCam.value
  if (!id) return
  camDeviceId = id
  localStorage.setItem('dev-cam', id)
  if (!camStream) {
    log('Cam not active — saved selection will apply on next start')
    return
  }
  try {
    const newStream = await navigator.mediaDevices.getUserMedia({
      video: {
        deviceId: {exact: id},
        width: {ideal: 1280}, height: {ideal: 720}, frameRate: {ideal: 30}
      }
    })
    const newTrack = newStream.getVideoTracks()[0]
    newTrack._kind = 'camera'
    newTrack.addEventListener('ended', stopCamShare)
    if (camTransceiver?.sender) await camTransceiver.sender.replaceTrack(newTrack)
    localCamVideo.srcObject = new MediaStream([newTrack])
    try {
      camStream?.getTracks().forEach(t => t.stop())
    } catch (e) {
    }
    camStream = newStream
    log('Camera switched to', id)
  } catch (err) {
    console.error('Camera switch failed', err)
    showNotify('Failed to switch camera: ' + err.message)
  }
})

function syncScreenQualitySelects() {
  selScreenRes.value = `${roomWidth}x${roomHeight}`
  selScreenFps.value = String(roomFps)
  selScreenCodec.value = roomCodec
  selScreenCodec.disabled = polite
  selScreenCodec.title = polite
    ? 'Only the room creator can change codec (renegotiation is initiated by them)'
    : ''
}

selScreenRes.addEventListener('change', async (e) => {
  ;[roomWidth, roomHeight] = e.target.value.split('x').map(parseFloat)
  localStorage.setItem('q-res', e.target.value)
  calcBitrate()
  await applyScreenQuality()
})

selScreenFps.addEventListener('change', async (e) => {
  roomFps = +e.target.value
  localStorage.setItem('q-fps', roomFps)
  calcBitrate()
  await applyScreenQuality()
})

selScreenCodec.addEventListener('change', async (e) => {
  roomCodec = e.target.value
  localStorage.setItem('q-codec', roomCodec)
  calcBitrate()
  if (polite) {
    showNotify('Codec change has effect only on next connection (you are not the room creator).')
    return
  }
  applyVideoCodecPreferences()
  await forceRenegotiation()
})

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

/* chat */
function setupChatChannel(ch) {
  ch.onopen = () => {
    log('chat channel open')
    if (chatPendingOut.length) {
      for (const m of chatPendingOut) {
        try {
          ch.send(m)
        } catch (e) {
          console.warn('chat send queued failed', e);
          break
        }
      }
      chatPendingOut = []
    }
  }
  ch.onclose = () => log('chat channel closed')
  ch.onerror = (e) => console.warn('chat channel error', e)
  ch.onmessage = (e) => {
    if (typeof e.data !== 'string') return
    appendChatMessage('peer', e.data)
    if (chatBox.classList.contains('collapsed')) {
      chatUnread++
      chatUnreadEl.textContent = chatUnread
      chatUnreadEl.classList.add('show')
    }
  }
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]))
}

function renderMessageHtml(text) {
  const urlRe = /(https?:\/\/[^\s<>"']+)/g
  let html = ''
  let last = 0
  let m
  while ((m = urlRe.exec(text)) !== null) {
    let url = m[0]
    // strip trailing punctuation
    let trail = ''
    while (url.length && '.,;:!?)]}'.includes(url[url.length - 1])) {
      trail = url[url.length - 1] + trail
      url = url.slice(0, -1)
    }
    html += escapeHtml(text.slice(last, m.index))
    html += `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(url)}</a>`
    html += escapeHtml(trail)
    last = m.index + m[0].length
  }
  html += escapeHtml(text.slice(last))
  return html.replace(/\n/g, '<br>')
}

function appendChatMessage(who, text) {
  const div = document.createElement('div')
  div.className = 'msg ' + (who === 'me' ? 'me' : who === 'sys' ? 'sys' : 'peer')
  if (who === 'sys') {
    div.innerHTML = escapeHtml(text)
  } else {
    const label = document.createElement('span')
    label.className = 'who'
    label.textContent = who === 'me' ? 'You:' : 'Peer:'
    const body = document.createElement('span')
    body.innerHTML = renderMessageHtml(text)
    div.appendChild(label)
    div.appendChild(body)
  }
  chatMessagesEl.appendChild(div)
  chatMessagesEl.scrollTop = chatMessagesEl.scrollHeight
}

function sendChatMessage(text) {
  text = text.replace(/\s+$/, '')
  if (!text) return
  if (text.length > 4000) text = text.slice(0, 4000)
  appendChatMessage('me', text)
  if (chatChannel && chatChannel.readyState === 'open') {
    try {
      chatChannel.send(text)
    } catch (e) {
      console.warn('chat send failed, queue', e)
      chatPendingOut.push(text)
    }
  } else {
    chatPendingOut.push(text)
    if (chatPendingOut.length > 100) chatPendingOut = chatPendingOut.slice(-100)
  }
}

function openChat() {
  chatBox.classList.remove('collapsed')
  chatUnread = 0
  chatUnreadEl.classList.remove('show')
}

function closeChat() {
  chatBox.classList.add('collapsed')
}

chatHeader.addEventListener('click', (e) => {
  if (e.target === chatInput) return
  if (chatBox.classList.contains('collapsed')) openChat()
  else closeChat()
})

chatInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    const v = chatInput.value
    chatInput.value = ''
    chatInput.style.height = ''
    sendChatMessage(v)
  }
})

chatInput.addEventListener('input', () => {
  chatInput.style.height = '0px'
  chatInput.style.height = Math.min(80, Math.max(36, chatInput.scrollHeight)) + 'px'
})
