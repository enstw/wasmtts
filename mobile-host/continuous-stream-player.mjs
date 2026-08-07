// 從 bookworm 已通過 iOS 鎖屏實測的播放路徑抽出的通用 transport。
// Producer 只負責逐段回傳可 append 的編碼音訊；本模組維持單一
// HTMLAudioElement、單一 MediaSource timeline、有界 buffer 與事件驅動 refill。

const DEFAULT_MIME = 'audio/mpeg';

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

export function createContinuousStreamPlayer({
  audio,
  producer,
  mimeType = DEFAULT_MIME,
  targetAheadSeconds = 90,
  inactiveAheadSeconds = 45,
  retainBehindSeconds = 30,
  trimStepSeconds = 60,
  onUpdate = () => {},
  onLog = () => {},
}) {
  if (!(audio instanceof HTMLMediaElement)) throw new TypeError('audio 必須是 HTMLMediaElement');
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
    };
  }

  function snapshot() {
    const ahead = Math.max(0, bufferedEnd(state.sourceBuffer) - audio.currentTime);
    const producerSeconds = state.stats.producerWallMs / 1000;
    const rtf = state.stats.appendedAudioSeconds > 0
      ? producerSeconds / state.stats.appendedAudioSeconds
      : null;
    return {
      active: state.active,
      status: state.status,
      sourceKind: capability.kind,
      mimeType,
      supported: capability.supported,
      visibility: document.visibilityState,
      currentTime: audio.currentTime || 0,
      bufferAheadSeconds: ahead,
      bufferStart: bufferedStart(state.sourceBuffer),
      bufferEnd: bufferedEnd(state.sourceBuffer),
      queuedSegments: Math.max(0, state.segments.length),
      producing: state.producing,
      lastTrigger: state.lastTrigger,
      elapsedSeconds: state.stats.startedAt ? (performance.now() - state.stats.startedAt) / 1000 : 0,
      rtf,
      realtimeMultiplier: rtf > 0 ? 1 / rtf : null,
      ...state.stats,
    };
  }

  function update() {
    onUpdate(snapshot());
  }

  function log(message, detail = {}) {
    onLog({ at: performance.now(), message, detail, snapshot: snapshot() });
  }

  function setStatus(status) {
    state.status = status;
    update();
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
    if (!state.active || !state.sourceBuffer || state.sourceBuffer.updating || state.producing) {
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
    const started = performance.now();
    update();
    try {
      const unit = await producer.next({
        index: state.nextIndex,
        signal: state.abortController.signal,
        snapshot: snapshot(),
      });
      if (!state.active || generation !== state.generation) return;
      if (unit === null) {
        if (state.source.readyState === 'open') state.source.endOfStream();
        setStatus('ended');
        log('producer 已結束');
        return;
      }
      if (!(unit.buffer instanceof ArrayBuffer)) throw new TypeError('producer 必須回傳 ArrayBuffer');
      const producerWallMs = performance.now() - started;
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
    }
    update();
    feed('updateend');
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
    state.stats.startedAt = performance.now();
    state.waiting = false;
    state.hasPlayed = false;
    state.status = 'opening';

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
    const playPromise = audio.play();
    log('唯一一次初始 play() 已呼叫');
    update();
    return playPromise;
  }

  function stop({ preserveStatus = false } = {}) {
    state.active = false;
    state.generation += 1;
    state.abortController?.abort();
    state.abortController = null;
    state.producing = false;
    state.pendingAppend = null;
    state.sourceBuffer = null;
    state.source = null;
    state.segments = [];
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
    state.objectUrl = '';
    if (!preserveStatus) state.status = 'stopped';
    update();
  }

  function pause() {
    audio.pause();
    setStatus('paused');
    log('使用者暫停');
  }

  function resume() {
    const promise = audio.play();
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
    if (state.active && state.status !== 'opening' && state.status !== 'buffering') setStatus('paused');
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
    update();
  });
  audio.addEventListener('ended', () => {
    setStatus('ended');
    log('media element ended');
  });
  audio.addEventListener('error', () => {
    setStatus('error');
    log('media element error', { code: audio.error?.code, message: audio.error?.message });
  });
  document.addEventListener('visibilitychange', () => {
    log(`visibility=${document.visibilityState}`);
    feed('visibilitychange');
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
  };
}
