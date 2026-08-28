/* global MatchaFrontend, MatchaKaldifst, MatchaSynthesis, MatchaTaiwanProfile */

// wasmtts engine 入口:把文字前端(編譯後 lexicon ＋ runtime profile)、
// kaldifst text-normalizer 與 Matcha + Vocos 合成一次組好。消費端只提供
// 資產 bytes、ORT 與 kaldifst module factory;沒有任何「可漏傳就靜默降級」
// 的 optional 字典參數 —— lexicon、tokens、profile 缺一即 throw。
//
// 載入順序(importScripts 或 <script>):matcha-frontend.js →
// matcha-taiwan-profile.js → kaldifst-normalizer.js → matcha-synthesis.js →
// matcha-engine.js;Node 端以 require 取得各 api 後由 options 注入。

(function initMatchaEngine(globalScope) {
  'use strict';

  function resolve(name, provided) {
    const api = provided ?? globalScope[name];
    if (!api) throw new Error(`MatchaEngine 需要先載入 ${name}`);
    return api;
  }

  function requireText(name, value) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new TypeError(`MatchaEngine.create 需要 ${name}(非空字串)`);
    }
    return value;
  }

  // waveform gate:NaN／Infinity、peak 0 或 RMS 0 都是無聲或數值爆掉,播放端
  // 無法與停頓區分,在這裡一處拒絕,不讓各 caller 各自複製檢查。
  function assertAudible(result) {
    const {waveform} = result;
    if (waveform.finiteSamples !== waveform.samples || waveform.peak === 0 || waveform.rms === 0) {
      const error = new Error(`waveform not audible (finite ${waveform.finiteSamples}/${waveform.samples}, peak ${waveform.peak}, rms ${waveform.rms})`);
      error.waveform = waveform;
      error.code = 'inaudible'; // 單句層級:producer 跳過該句,不是引擎壞掉
      throw error;
    }
    return result;
  }

  function normalizeOverrides(overrides, tokens) {
    if (!overrides || typeof overrides !== 'object') throw new TypeError('pronunciationOverrides 必須是 {詞: "p1 p2" | ["p1", "p2"]}');
    const normalized = {};
    for (const [word, value] of Object.entries(overrides)) {
      const phones = Array.isArray(value) ? value.map(String) : String(value).trim().split(/\s+/u);
      if (!word.trim() || !phones.length || phones.some((phone) => !phone)) {
        throw new TypeError(`pronunciationOverrides[${JSON.stringify(word)}] 讀音為空`);
      }
      if ([...word].length !== phones.length) {
        throw new TypeError(`pronunciationOverrides[${JSON.stringify(word)}] 字數 ${[...word].length} 與 phone 數 ${phones.length} 不符`);
      }
      for (const phone of phones) {
        if (!tokens.has(phone)) throw new TypeError(`pronunciationOverrides[${JSON.stringify(word)}] 的 ${phone} 不在 tokens.txt`);
      }
      normalized[word] = phones;
    }
    return normalized;
  }

  async function create({
    lexiconText,
    tokensText,
    profile,
    fstBuffers,
    kaldifstModuleFactory,
    wasmUrl,
    ORT,
    acousticModel,
    vocoderModel,
    synthesis = {},
    pronunciationOverrides = {},
    frontendApi = null,
    profileApi = null,
    kaldifstApi = null,
    synthesisApi = null,
  }) {
    const frontendLib = resolve('MatchaFrontend', frontendApi);
    const profileLib = resolve('MatchaTaiwanProfile', profileApi);
    const kaldifstLib = resolve('MatchaKaldifst', kaldifstApi);
    const synthesisLib = resolve('MatchaSynthesis', synthesisApi);

    requireText('lexiconText', lexiconText);
    requireText('tokensText', tokensText);
    if (!profile || typeof profile !== 'object' || !profile.profiles) {
      throw new TypeError('MatchaEngine.create 需要 profile(matcha-profile.runtime.json 的物件)');
    }
    if (!Array.isArray(fstBuffers) || !fstBuffers.length) {
      throw new TypeError('MatchaEngine.create 需要 fstBuffers(phone/date/number FST bytes,順序固定)');
    }
    if (!acousticModel || !vocoderModel) {
      throw new TypeError('MatchaEngine.create 需要 acousticModel 與 vocoderModel');
    }

    const ruleNormalizer = await kaldifstLib.createNormalizer({
      moduleFactory: kaldifstModuleFactory,
      wasmUrl,
      fstBuffers,
    });
    // phrase overrides 已烘進編譯後 lexicon;createConfig 再套一次是冪等的,
    // contextual rules 則只有 runtime 能套。
    const profileConfig = profileLib.createConfig(profile, frontendLib);
    // 本地暫存層:下游聽出來、尚未進 review 的讀音;整詞 longest-match、最後套用,
    // phone 必須存在於 tokens,否則在這裡 throw 而不是合成時默默丟字。
    const localOverrides = normalizeOverrides(pronunciationOverrides, frontendLib.parseTokens(tokensText));
    const frontend = frontendLib.createFrontend({
      lexiconText,
      tokensText,
      ruleNormalizer,
      contextualRules: profileConfig.contextualRules,
      pronunciationOverrides: {...profileConfig.pronunciationOverrides, ...localOverrides},
    });

    const engine = synthesisLib.createEngine({ORT, ...synthesis});
    const session = await engine.init({acousticModel, vocoderModel});

    async function synthesize(text, options = {}) {
      const started = performance.now();
      const tokenized = frontend.tokensFor(text, {allowUnknown: options.allowUnknown ?? true});
      const frontendMs = performance.now() - started;
      if (!tokenized.ids.length) {
        return {text, tokenized, empty: true, frontendMs};
      }
      const result = assertAudible(await engine.synthesize(tokenized.ids, options));
      return {...result, text, tokenized, empty: false, frontendMs};
    }

    return {
      frontend,
      ruleNormalizer,
      session,
      tokensFor: (text, options) => frontend.tokensFor(text, options),
      synthesizeIds: (ids, options) => engine.synthesize(ids, options).then(assertAudible),
      synthesize,
      assertAudible,
      info: {
        lexiconSize: frontend.lexiconSize,
        tokenCount: frontend.tokenCount,
        ruleFstCount: frontend.ruleFstCount,
        contextualRules: profileConfig.contextualRules.map((rule) => rule.pattern),
        localOverrides: Object.keys(localOverrides),
        profileSchemaVersion: profile.schemaVersion,
        synthesis: {
          noiseScale: synthesis.noiseScale ?? 1,
          lengthScale: synthesis.lengthScale ?? 1,
          silenceScale: synthesis.silenceScale ?? synthesisLib.DEFAULT_SILENCE_SCALE,
        },
      },
      dispose() {
        ruleNormalizer.dispose();
      },
    };
  }

  const api = {create, assertAudible};
  globalScope.MatchaEngine = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof globalThis !== 'undefined' ? globalThis : self));
