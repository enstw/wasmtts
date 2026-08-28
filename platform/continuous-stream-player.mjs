// 已通過 iOS 鎖屏實測的播放 transport（隨 engine tarball 發布）。
// Producer 只負責逐段回傳可 append 的編碼音訊（matcha-producer.mjs 的
// createMatchaProducer 即是）；本模組維持單一 HTMLAudioElement、單一
// MediaSource timeline、有界 buffer 與事件驅動 refill。不強制需要 document；
// mediaSession 為 opt-in 選項。
//
// 下游實機紀錄要求的規矩（皆內建）：
// - currentSegment／onSegment：由 currentTime 反查目前單位（含 meta.start/end/tag），
//   host 據此同步書籤、高亮與翻頁。
// - seekToSegment／restartFrom：⏮⏭ 目標仍在 buffer 內就 seek，不在就以 producer
//   cursor 重建 timeline。
// - 看門狗心跳：每 heartbeatSeconds 一行 log；playing 但 currentTime 連續兩拍相同
//   （≈20 s）且 buffer ahead 充足 → 先推一下（micro-seek + play），再一拍仍卡 →
//   於目前單位重建。
// - 鎖屏 chain death：只有 pause() 才算使用者暫停；回到前景時若不是使用者暫停
//   就自動 resume；懸而未決的 play() promise 會在心跳中被點名。
// - Media Session：setMetadata 隨時可更新；handlers 可綁 previoustrack／nexttrack 等。
// - producer 用盡 ≠ 播完：producer 以數倍實時領先，回 null 時 element 還有整個 buffer
//   要唸；只 endOfStream() 一次並記 snapshot().drained，status 留給 element 的 ended 事件。
// - 跨章重建：段的 meta.index 是「當時那一章」的句序；restartFrom({tag, index}) 在
//   producer 已被 more() 換章時先 producer.restore(tag) 要回那章，沒有 restore 就明確
//   reject，絕不默默指到錯章的同序句。
// - segments()：timeline 上仍在 buffer 內的段（含前一章的），host 據此挑 ⏮ 目標直接
//   seek，不必重建。不放進 snapshot()：snapshot 會嵌進每一行 log 與 gate 結果。

const DEFAULT_MIME = 'audio/mpeg';
const doc = () => globalThis.document ?? null;
const visibility = () => doc()?.visibilityState ?? 'visible';
const now = () => (globalThis.performance?.now?.() ?? Date.now());

function bufferedEnd(sourceBuffer) {
  if (!sourceBuffer?.buffered.length) return 0;
  return sourceBuffer.buffered.end(sourceBuffer.buffered.length - 1);
}

function bufferedStart(sourceBuffer) {
  if (!sourceBuffer?.buffered.length) return 0;
  return sourceBuffer.buffered.start(0);
}

export function mediaSourceSupport(mimeType = DEFAULT_MIME) {
  const Source = globalThis.ManagedMediaSource ?? globalThis.MediaSource;
  return {
    Source,
    kind: globalThis.ManagedMediaSource ? 'ManagedMediaSource' : Source ? 'MediaSource' : '無',
    supported: !!Source?.isTypeSupported?.(mimeType),
    mimeType,
  };
}

function isMediaElement(audio) {
  const MediaElement = globalThis.HTMLMediaElement;
  if (MediaElement) return audio instanceof MediaElement;
  // 無 DOM 環境（測試）：鴨子型別即可。
  return typeof audio?.play === 'function' && typeof audio?.pause === 'function' && typeof audio?.addEventListener === 'function';
}

export function createContinuousStreamPlayer({
  audio,
  producer,
  mimeType = DEFAULT_MIME,
  targetAheadSeconds = 90,
  inactiveAheadSeconds = 45,
  retainBehindSeconds = 30,
  trimStepSeconds = 60,
  heartbeatSeconds = 10,
  stallBeats = 1, // 連續幾拍 currentTime 未動就推一下(基準拍不算);再一拍仍未動就重建
  stallAheadSeconds = 2,
  autoResumeOnVisible = true,
  mediaSession = null,
  onUpdate = () => {},
  onLog = () => {},
  onSegment = () => {},
  onStall = () => {},
  timers = {setInterval: (...args) => globalThis.setInterval(...args), clearInterval: (...args) => globalThis.clearInterval(...args)},
}) {
  if (!isMediaElement(audio)) throw new TypeError('audio 必須是 HTMLMediaElement');
  if (typeof producer?.next !== 'function') throw new TypeError('producer.next 必須是函式');

  const capability = mediaSourceSupport(mimeType);
  const state = {
    active: false,
    generation: 0,
    source: null,
    sourceBuffer: null,
    objectUrl: '',
    abortController: null,
    producing: false,
    pendingAppend: null,
    nextIndex: 0,
    segments: [],
    waiting: false,
    hasPlayed: false,
    userPaused: false,
    pendingPlay: null,
    drained: false,
    currentSegmentIndex: null,
    heartbeat: null,
    lastBeatTime: -1,
    stuckBeats: 0,
    status: capability.supported ? 'idle' : 'unsupported',
    lastTrigger: '',
    stats: freshStats(),
  };

  function freshStats() {
    return {
      startedAt: 0,
      appendCount: 0,
      appendedAudioSeconds: 0,
      producerWallMs: 0,
      bytes: 0,
      underflows: 0,
      appendErrors: 0,
      producerErrors: 0,
      trims: 0,
      trimmedSeconds: 0,
      stalls: 0,
      nudges: 0,
      rebuilds: 0,
      autoResumes: 0,
    };
  }

  function publicSegment(segment) {
    return {index: segment.index, start: segment.start, end: segment.end, meta: segment.meta};
  }

  // buffer 內（尚未裁掉）的段，依 timeline 順序；跨章的段也在，⏮ 回前一章可直接 seek。
  function listSegments() {
    return state.segments.map(publicSegment);
  }

  // 由 currentTime 反查目前單位；播到最後一段之後仍回最後一段。
  function currentSegment() {
    const time = audio.currentTime || 0;
    let found = null;
    for (const segment of state.segments) {
      if (time >= segment.start && time < segment.end) return segment;
      if (segment.end <= time) found = segment;
    }
    return found;
  }

  function snapshot() {
    const ahead = Math.max(0, bufferedEnd(state.sourceBuffer) - audio.currentTime);
    const producerSeconds = state.stats.producerWallMs / 1000;
    const rtf = state.stats.appendedAudioSeconds > 0
      ? producerSeconds / state.stats.appendedAudioSeconds
      : null;
    const segment = currentSegment();
    return {
      active: state.active,
      status: state.status,
      sourceKind: capability.kind,
      mimeType,
      supported: capability.supported,
      visibility: visibility(),
      currentTime: audio.currentTime || 0,
      bufferAheadSeconds: ahead,
      bufferStart: bufferedStart(state.sourceBuffer),
      bufferEnd: bufferedEnd(state.sourceBuffer),
      queuedSegments: Math.max(0, state.segments.length),
      producing: state.producing,
      lastTrigger: state.lastTrigger,
      elapsedSeconds: state.stats.startedAt ? (now() - state.stats.startedAt) / 1000 : 0,
      rtf,
      realtimeMultiplier: rtf > 0 ? 1 / rtf : null,
      userPaused: state.userPaused,
      pendingPlay: Boolean(state.pendingPlay),
      drained: state.drained,
      currentSegment: segment ? {index: segment.index, start: segment.start, end: segment.end, meta: segment.meta} : null,
      ...state.stats,
    };
  }

  function update() {
    onUpdate(snapshot());
  }

  function log(message, detail = {}) {
    onLog({ at: now(), message, detail, snapshot: snapshot() });
  }

  function setStatus(status) {
    state.status = status;
    update();
  }

  function notifySegmentChange() {
    const segment = currentSegment();
    const index = segment?.index ?? null;
    if (index === state.currentSegmentIndex) return;
    state.currentSegmentIndex = index;
    if (segment) {
      try {
        onSegment({index: segment.index, start: segment.start, end: segment.end, meta: segment.meta});
      } catch {
        // host 回呼失敗不得影響播放。
      }
    }
  }

  function trimPlayedAudio() {
    const sourceBuffer = state.sourceBuffer;
    if (!sourceBuffer || sourceBuffer.updating || !sourceBuffer.buffered.length) return false;
    const start = sourceBuffer.buffered.start(0);
    const cut = audio.currentTime - retainBehindSeconds;
    if (cut - start < trimStepSeconds) return false;
    try {
      sourceBuffer.remove(start, cut);
      state.stats.trims += 1;
      state.stats.trimmedSeconds += Math.max(0, cut - start);
      state.segments = state.segments.filter((segment) => segment.end > cut);
      log('裁切已播放音訊', { start, cut });
      return true;
    } catch (error) {
      log('裁切失敗，等待下一次事件重試', { error: error?.name ?? String(error) });
      return false;
    }
  }

  async function feed(trigger = 'manual') {
    const generation = state.generation;
    state.lastTrigger = trigger;
    if (!state.active || !state.sourceBuffer || state.sourceBuffer.updating || state.producing || state.drained) {
      update();
      return;
    }
    if (trimPlayedAudio()) return;

    const ahead = bufferedEnd(state.sourceBuffer) - audio.currentTime;
    const desiredAhead = state.source?.streaming === false
      ? Math.min(targetAheadSeconds, inactiveAheadSeconds)
      : targetAheadSeconds;
    if (ahead >= desiredAhead) {
      update();
      return;
    }

    state.producing = true;
    const started = now();
    update();
    try {
      const unit = await producer.next({
        index: state.nextIndex,
        signal: state.abortController.signal,
        snapshot: snapshot(),
      });
      if (!state.active || generation !== state.generation) return;
      if (unit === null) {
        // producer 用盡 ≠ 播完：只 endOfStream 一次、記 drained，之後每個 timeupdate 不再問
        // producer；status 交給 element 的 ended 事件。一個單位都沒有時 element 永遠不會
        // ended，才直接標 ended。
        state.drained = true;
        if (state.source.readyState === 'open') state.source.endOfStream();
        log('producer 已用盡，等 element 播完', {appended: state.stats.appendCount});
        if (state.stats.appendCount === 0 && !state.pendingAppend) setStatus('ended');
        else update();
        return;
      }
      if (!(unit.buffer instanceof ArrayBuffer)) throw new TypeError('producer 必須回傳 ArrayBuffer');
      const producerWallMs = now() - started;
      state.pendingAppend = {
        index: state.nextIndex,
        meta: unit.meta ?? {},
        producerWallMs,
        bytes: unit.buffer.byteLength,
        previousEnd: bufferedEnd(state.sourceBuffer),
      };
      state.nextIndex += 1;
      state.sourceBuffer.appendBuffer(unit.buffer);
      log('append 開始', {
        index: state.pendingAppend.index,
        bytes: state.pendingAppend.bytes,
        producerWallMs,
        trigger,
      });
    } catch (error) {
      if (error?.name === 'AbortError') return;
      state.stats.producerErrors += 1;
      setStatus('error');
      log('producer 或 append 失敗', { error: error?.message ?? String(error), trigger });
    } finally {
      if (generation === state.generation) {
        state.producing = false;
        update();
      }
    }
  }

  function onUpdateEnd(generation) {
    if (!state.active || generation !== state.generation) return;
    if (state.pendingAppend) {
      const pending = state.pendingAppend;
      state.pendingAppend = null;
      const end = bufferedEnd(state.sourceBuffer);
      const start = pending.previousEnd;
      const audioSeconds = Math.max(0, end - start);
      state.segments.push({
        index: pending.index,
        start,
        end,
        meta: pending.meta,
      });
      state.stats.appendCount += 1;
      state.stats.appendedAudioSeconds += audioSeconds;
      state.stats.producerWallMs += pending.producerWallMs;
      state.stats.bytes += pending.bytes;
      log('append 完成', { index: pending.index, audioSeconds, start, end, meta: pending.meta });
      notifySegmentChange();
    }
    update();
    feed('updateend');
  }

  // 記錄懸而未決的 play()：鎖屏可能讓它既不 resolve 也不 reject。
  function trackPlay(promise, label) {
    state.pendingPlay = {label, since: now()};
    const clear = () => {
      state.pendingPlay = null;
    };
    Promise.resolve(promise).then(clear, clear);
    return promise;
  }

  function start() {
    if (!capability.supported) {
      setStatus('unsupported');
      return Promise.reject(new Error(`${capability.kind} 不支援 ${mimeType}`));
    }
    stop({ preserveStatus: true });
    state.active = true;
    state.generation += 1;
    const generation = state.generation;
    state.abortController = new AbortController();
    state.nextIndex = 0;
    state.segments = [];
    state.stats = freshStats();
    state.stats.startedAt = now();
    state.waiting = false;
    state.hasPlayed = false;
    state.userPaused = false;
    state.drained = false;
    state.currentSegmentIndex = null;
    state.lastBeatTime = -1;
    state.stuckBeats = 0;
    state.status = 'opening';

    // WebKit 在 iPhone 上只有提供 AirPlay 替代來源或明確停用 remote
    // playback 時才會開啟 ManagedMediaSource。
    audio.disableRemotePlayback = true;

    const source = new capability.Source();
    state.source = source;
    const objectUrl = URL.createObjectURL(source);
    state.objectUrl = objectUrl;

    source.addEventListener('sourceopen', () => {
      if (!state.active || generation !== state.generation) return;
      URL.revokeObjectURL(objectUrl);
      state.objectUrl = '';
      try {
        const sourceBuffer = source.addSourceBuffer(mimeType);
        sourceBuffer.mode = 'sequence';
        sourceBuffer.addEventListener('updateend', () => onUpdateEnd(generation));
        sourceBuffer.addEventListener('error', () => {
          state.stats.appendErrors += 1;
          setStatus('error');
          log('SourceBuffer error');
        });
        state.sourceBuffer = sourceBuffer;
        setStatus('buffering');
        log('media source 已開啟', { kind: capability.kind, mimeType });
        feed('sourceopen');
      } catch (error) {
        setStatus('error');
        log('建立 SourceBuffer 失敗', { error: error?.message ?? String(error) });
      }
    }, { once: true });
    source.addEventListener('startstreaming', () => {
      log('ManagedMediaSource startstreaming');
      feed('startstreaming');
    });
    source.addEventListener('endstreaming', () => log('ManagedMediaSource endstreaming'));
    source.addEventListener('sourceended', () => log('media source ended'));
    source.addEventListener('sourceclose', () => log('media source closed'));

    audio.src = objectUrl;
    const playPromise = trackPlay(audio.play(), 'start');
    log('唯一一次初始 play() 已呼叫', {disableRemotePlayback: audio.disableRemotePlayback});
    installMediaSession();
    startHeartbeat();
    update();
    return playPromise;
  }

  // ---- 看門狗心跳 ----
  function startHeartbeat() {
    stopHeartbeat();
    if (!(heartbeatSeconds > 0)) return;
    state.heartbeat = timers.setInterval(() => heartbeat('timer'), heartbeatSeconds * 1000);
  }

  function stopHeartbeat() {
    if (state.heartbeat !== null) timers.clearInterval(state.heartbeat);
    state.heartbeat = null;
  }

  // 一拍：log 一行心跳；偵測卡死 → 推一下 → 重建。公開給測試與 host 手動觸發。
  function heartbeat(trigger = 'manual') {
    if (!state.active) return null;
    const snap = snapshot();
    const detail = {
      trigger,
      visibility: snap.visibility,
      status: snap.status,
      playhead: Number(snap.currentTime.toFixed(1)),
      ahead: Number(snap.bufferAheadSeconds.toFixed(1)),
      appends: snap.appendCount,
      underflows: snap.underflows,
      segment: snap.currentSegment?.index ?? null,
      drained: state.drained,
      pendingPlay: state.pendingPlay ? Number(((now() - state.pendingPlay.since) / 1000).toFixed(1)) : null,
    };
    log('♥ heartbeat', detail);

    // 實機紀錄：鎖屏 pause/resume 後 element 自稱 playing、currentTime 凍結、
    // buffer 還有 90 s，可以持續數分鐘。ran-dry 不算（沒有 ahead）、暫停不算。
    const time = audio.currentTime || 0;
    const stuck = state.status === 'playing' && !audio.paused && state.lastBeatTime >= 0
      && Math.abs(time - state.lastBeatTime) < 0.05 && snap.bufferAheadSeconds > stallAheadSeconds;
    let action = null;
    if (stuck) {
      state.stuckBeats += 1;
      if (state.stuckBeats < stallBeats) {
        action = 'watch';
      } else if (state.stuckBeats === stallBeats) {
        action = 'nudge';
        state.stats.stalls += 1;
        state.stats.nudges += 1;
        log('卡死 — 推一下', {playhead: time, ahead: detail.ahead});
        try {
          audio.currentTime = time + 0.01;
          trackPlay(audio.play(), 'nudge').catch?.(() => {});
        } catch (error) {
          log('推一下失敗', {error: error?.message ?? String(error)});
        }
        safeCall(onStall, {phase: 'nudge', playhead: time, ahead: detail.ahead});
      } else {
        action = 'rebuild';
        state.stats.rebuilds += 1;
        state.stuckBeats = 0;
        const segment = currentSegment();
        log('卡死未解 — 重建', {playhead: time, segment: segment?.index ?? null});
        safeCall(onStall, {phase: 'rebuild', playhead: time, segment: segment ? {index: segment.index, meta: segment.meta} : null});
        restartFrom({tag: segment?.meta?.tag, index: segment?.meta?.index ?? segment?.index ?? 0})
          .catch((error) => log('重建失敗', {error: error?.message ?? String(error)}));
      }
    } else {
      state.stuckBeats = 0;
    }
    state.lastBeatTime = time;
    return {stuck, action};
  }

  function safeCall(callback, payload) {
    try {
      callback(payload);
    } catch {
      // host 回呼失敗不得影響播放。
    }
  }

  // ---- ⏮⏭ ----
  // 目標段仍在 buffer 內就 seek；不在就以 producer cursor 重建 timeline。
  function seekToSegment(index, {producerIndex} = {}) {
    const segment = state.segments.find((entry) => entry.index === index);
    const inBuffer = segment && state.sourceBuffer
      && segment.start >= bufferedStart(state.sourceBuffer) - 0.01 && segment.start < bufferedEnd(state.sourceBuffer);
    if (inBuffer) {
      audio.currentTime = segment.start + 0.01;
      log('seek 到 buffer 內的段', {index, time: segment.start});
      trackPlay(audio.play(), 'seek').catch?.(() => {});
      notifySegmentChange();
      return Promise.resolve({mode: 'seek', index});
    }
    // 段還記得自己是哪一章的第幾句；host 明確給 producerIndex 時由 host 負責章別。
    const cursor = producerIndex ?? (segment ? {tag: segment.meta?.tag, index: segment.meta?.index ?? segment.index} : index);
    return restartFrom(cursor).then(() => ({mode: 'rebuild', index, cursor}));
  }

  // producer 目前在哪一章（matcha-producer.mjs 有 tag getter；自訂 producer 沒有就不查）。
  function producerTag() {
    if ('tag' in producer) return producer.tag;
    return producer.segments?.[0]?.tag;
  }

  // 以 producer cursor 重建：需要 producer.setCursor（matcha-producer.mjs 有）。
  // cursor 可為句序（數字）或 {tag, index}：段的 index 是「當時那一章」的句序，producer
  // 若已被 more() 換到別章，先 producer.restore(tag) 要回那章；沒有 restore 就 reject
  // 讓 host 自己重建（此時不動現有播放）。
  async function restartFrom(cursor) {
    if (typeof producer.setCursor !== 'function') throw new TypeError('producer 沒有 setCursor，無法重建');
    const target = cursor !== null && typeof cursor === 'object' ? cursor : {index: cursor};
    const index = Number.isFinite(target.index) ? target.index : 0;
    const currentTag = producerTag();
    const crossTag = target.tag !== undefined && currentTag !== undefined && target.tag !== currentTag;
    if (crossTag && typeof producer.restore !== 'function') {
      throw new Error(`producer 已在 tag=${JSON.stringify(currentTag)}，目標段屬於 tag=${JSON.stringify(target.tag)}；producer 沒有 restore(tag)，請 host 自行重建`);
    }
    const preservedStats = {...state.stats};
    stop({ preserveStatus: true });
    if (crossTag) {
      log('重建前先要回目標章', {from: currentTag, to: target.tag});
      await producer.restore(target.tag);
    }
    producer.setCursor(index);
    log('重建 timeline', {cursor: index, tag: target.tag});
    const promise = start();
    // 重建不歸零看門狗計數：它們是同一場播放的診斷。
    state.stats.stalls = preservedStats.stalls;
    state.stats.nudges = preservedStats.nudges;
    state.stats.rebuilds = preservedStats.rebuilds;
    state.stats.autoResumes = preservedStats.autoResumes;
    return promise;
  }

  // ---- Media Session ----
  // 鎖屏／耳機控制：opt-in，metadata 與 handlers 由呼叫端提供內容，播放動作
  // 一律走同一個 media element 的 resume／pause，不建立新 element。
  const installedActions = new Set();

  function installMediaSession() {
    const session = globalThis.navigator?.mediaSession;
    if (!mediaSession || !session) return;
    try {
      if (mediaSession.metadata) setMetadata(mediaSession.metadata);
      const handlers = {
        play: () => resume().catch(() => {}),
        pause: () => pause(),
        ...(mediaSession.handlers ?? {}),
      };
      for (const [action, handler] of Object.entries(handlers)) {
        if (typeof handler !== 'function') continue;
        try {
          session.setActionHandler(action, handler);
          installedActions.add(action);
        } catch {
          // 不支援的動作型別忽略。
        }
      }
    } catch (error) {
      log('Media Session 設定失敗', { error: error?.message ?? String(error) });
    }
  }

  function setMetadata(metadata) {
    const session = globalThis.navigator?.mediaSession;
    if (!session) return false;
    try {
      session.metadata = typeof MediaMetadata === 'function' ? new MediaMetadata(metadata) : metadata;
      return true;
    } catch (error) {
      log('Media Session metadata 失敗', { error: error?.message ?? String(error) });
      return false;
    }
  }

  function clearMediaSession() {
    const session = globalThis.navigator?.mediaSession;
    if (!session) return;
    for (const action of installedActions) {
      try {
        session.setActionHandler(action, null);
      } catch {
        // 不支援的動作型別忽略。
      }
    }
    installedActions.clear();
  }

  function stop({ preserveStatus = false } = {}) {
    stopHeartbeat();
    clearMediaSession();
    state.active = false;
    state.generation += 1;
    state.abortController?.abort();
    state.abortController = null;
    state.producing = false;
    state.pendingAppend = null;
    state.pendingPlay = null;
    state.sourceBuffer = null;
    state.source = null;
    state.segments = [];
    state.currentSegmentIndex = null;
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
    state.objectUrl = '';
    if (!preserveStatus) state.status = 'stopped';
    update();
  }

  // 只有這裡算「使用者暫停」；系統（鎖屏、耳機拔除）造成的 pause 是 suspended。
  function pause() {
    state.userPaused = true;
    audio.pause();
    setStatus('paused');
    log('使用者暫停');
  }

  function resume() {
    state.userPaused = false;
    const promise = trackPlay(audio.play(), 'resume');
    log('既有 media element 恢復 play()');
    return promise;
  }

  audio.addEventListener('playing', () => {
    state.hasPlayed = true;
    state.waiting = false;
    setStatus('playing');
    log('開始／恢復播放');
    feed('playing');
  });
  audio.addEventListener('pause', () => {
    if (audio.ended) return; // 播完的 pause 緊接著 ended 事件，不是 suspended
    if (state.active && state.status !== 'opening' && state.status !== 'buffering' && state.status !== 'ended') {
      setStatus(state.userPaused ? 'paused' : 'suspended');
      if (!state.userPaused) log('非使用者暫停（鎖屏／系統）', {visibility: visibility()});
    }
  });
  audio.addEventListener('waiting', () => {
    if (state.active && state.hasPlayed && !state.waiting) {
      state.waiting = true;
      state.stats.underflows += 1;
      log('buffer underflow／waiting');
    }
    feed('waiting');
  });
  audio.addEventListener('stalled', () => {
    log('media stalled');
    feed('stalled');
  });
  audio.addEventListener('timeupdate', () => {
    trimPlayedAudio();
    feed('timeupdate');
    notifySegmentChange();
    update();
  });
  audio.addEventListener('ended', () => {
    setStatus('ended');
    log('media element ended', {drained: state.drained});
  });
  audio.addEventListener('error', () => {
    setStatus('error');
    log('media element error', { code: audio.error?.code, message: audio.error?.message });
  });
  doc()?.addEventListener('visibilitychange', () => {
    log(`visibility=${visibility()}`);
    feed('visibilitychange');
    // 鎖屏 chain death：play() 可能永不 settle；回到前景若不是使用者主動暫停就踢一下。
    if (visibility() === 'visible' && autoResumeOnVisible && state.active && !state.userPaused
      && audio.paused && !audio.ended && !['ended', 'error', 'stopped', 'opening'].includes(state.status)) {
      state.stats.autoResumes += 1;
      log('visible 恢復踢');
      resume().catch(() => {});
    }
  });

  update();
  return {
    audio,
    capability,
    start,
    stop,
    pause,
    resume,
    kick: feed,
    snapshot,
    currentSegment: () => {
      const segment = currentSegment();
      return segment ? publicSegment(segment) : null;
    },
    segments: listSegments,
    seekToSegment,
    restartFrom,
    setMetadata,
    heartbeat,
  };
}
