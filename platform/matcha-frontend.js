(function initMatchaFrontend(globalScope) {
  'use strict';

  const DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  const SMALL_UNITS = ['', '十', '百', '千'];
  const LARGE_UNITS = ['', '万', '亿', '兆'];
  const PUNCTUATION = new Map([
    ['。', '.'], ['．', '.'], ['｡', '.'],
    ['，', ','], ['、', ','],
    ['！', '!'], ['？', '?'],
    // ':' 是 tokens.txt 裡的真 token（id 3），模型會把它發成約 0.25 秒的
    // 聲音而不是停頓。時間的冒號在 normalizeFullWidth 折成半形後已被時間
    // 規則吃掉，能活到這張表的是散文冒號——讀成 '，' 的停頓才是它的意思。
    ['；', ';'], [':', ','],
    ['（', '('], ['）', ')'],
    ['「', ''], ['『', ''], ['《', ''],
    ['」', ''], ['』', ''], ['》', ''],
    ['“', ''], ['”', ''], ['‘', ''], ['’', ''], ['"', ''],
    ['—', '—'], ['–', '—'], ['…', '…'],
  ]);

  function parseTable(source) {
    return source
      .split(/\r?\n/u)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  function parseTokens(source) {
    const tokens = new Map();
    for (const line of parseTable(source)) {
      const separator = line.lastIndexOf(' ');
      if (separator < 1) continue;
      const id = Number(line.slice(separator + 1));
      if (Number.isFinite(id)) tokens.set(line.slice(0, separator), id);
    }
    return tokens;
  }

  function parseLexicon(source) {
    const lexicon = new Map();
    let maxKeyLength = 1;
    for (const line of parseTable(source)) {
      const separator = line.indexOf(' ');
      if (separator < 1) continue;
      const key = line.slice(0, separator);
      const phones = line.slice(separator + 1).trim().split(/\s+/u);
      if (!phones.length) continue;
      lexicon.set(key, phones);
      maxKeyLength = Math.max(maxKeyLength, key.length);
    }
    return {lexicon, maxKeyLength};
  }

  function enabledReviewPatterns(review, profileName, key) {
    const configured = review?.profiles?.[profileName]?.[key];
    return Array.isArray(configured) ? new Set(configured) : null;
  }

  function pronunciationOverridesFromReview(review, profileName = 'taiwan') {
    if (!review || !Array.isArray(review.entries)) return {};
    const enabled = enabledReviewPatterns(review, profileName, 'phraseOverrides');
    return Object.fromEntries(review.entries
      .filter((entry) => entry?.status !== 'pending'
        && entry?.implementation === 'phrase-override'
        && typeof entry.pattern === 'string'
        && Array.isArray(entry.target)
        && (enabled ? enabled.has(entry.pattern) : entry.status === 'confirmed'))
      .map((entry) => [entry.pattern, [...entry.target]]));
  }

  function contextualRulesFromReview(review, profileName = 'taiwan') {
    if (!review || !Array.isArray(review.entries)) return [];
    const enabled = enabledReviewPatterns(review, profileName, 'contextualRules');
    return review.entries
      .filter((entry) => entry?.status !== 'pending'
        && entry?.implementation === 'contextual-rule'
        && typeof entry.pattern === 'string'
        && Array.isArray(entry.target)
        && (typeof entry.previousCharacters === 'string'
          || typeof entry.followingCharacters === 'string')
        && (enabled ? enabled.has(entry.pattern) : entry.status === 'confirmed'))
      .map((entry) => ({
        pattern: entry.pattern,
        target: [...entry.target],
        previousCharacters: typeof entry.previousCharacters === 'string'
          ? new Set([...entry.previousCharacters]) : null,
        followingCharacters: typeof entry.followingCharacters === 'string'
          ? new Set([...entry.followingCharacters]) : null,
      }));
  }

  function sectionToChinese(section) {
    let output = '';
    let unitIndex = 0;
    let pendingZero = false;
    while (section > 0) {
      const digit = section % 10;
      if (digit === 0) {
        if (output) pendingZero = true;
      } else {
        const prefix = pendingZero ? '零' : '';
        output = `${DIGITS[digit]}${SMALL_UNITS[unitIndex]}${prefix}${output}`;
        pendingZero = false;
      }
      unitIndex += 1;
      section = Math.floor(section / 10);
    }
    return output;
  }

  function digitsToChinese(value) {
    return [...value].map((digit) => DIGITS[Number(digit)]).join('');
  }

  function integerToChinese(value) {
    const raw = String(value).replace(/^\+/u, '');
    if (!/^\d+$/u.test(raw)) return raw;
    if (raw.length > 12 || (raw.length > 1 && raw.startsWith('0'))) {
      return digitsToChinese(raw);
    }

    const groups = [];
    for (let end = raw.length; end > 0; end -= 4) {
      groups.unshift(Number(raw.slice(Math.max(0, end - 4), end)));
    }

    let output = '';
    let pendingZero = false;
    for (let index = 0; index < groups.length; index += 1) {
      const group = groups[index];
      const largeUnit = LARGE_UNITS[groups.length - index - 1];
      if (group === 0) {
        if (output) pendingZero = true;
        continue;
      }
      if (output && (pendingZero || group < 1000)) output += '零';
      output += sectionToChinese(group) + largeUnit;
      pendingZero = false;
    }
    return (output || '零').replace(/^一十/u, '十');
  }

  function numberToChinese(value) {
    const [integer, fraction] = String(value).split('.');
    const integerText = integerToChinese(integer);
    return fraction === undefined ? integerText : `${integerText}点${digitsToChinese(fraction)}`;
  }

  function normalizeFullWidth(value) {
    return value
      .replace(/[０-９]/gu, (character) => String.fromCharCode(character.charCodeAt(0) - 0xfee0))
      // 全形小數點跟著數字一起折疊：留著它，２５．５ 的整數與小數就會被
      // FST 當成兩個不相干的數各讀各的。
      .replace(/．/gu, '.')
      .replace(/％/gu, '%')
      .replace(/＋/gu, '+')
      .replace(/－/gu, '-')
      .replace(/：/gu, ':');
  }

  // 小說常用連字號或框線字元作為場景分隔。只有整行都是分隔符時才移除，
  // 避免誤傷句內破折號、負數與數值範圍。保留換行，讓前後段落仍形成句界。
  function normalizeLayoutSeparators(value) {
    return String(value).replace(/^[\s　]*[-－—–―─]{2,}[\s　]*$/gmu, '');
  }

  // 保留先行專案已驗證的臺灣格式修正：只重整 FST 已知會誤讀的外形，
  // 一般數字仍由 sherpa 原始 phone/date/number tables 決定讀法。
  function normalizeLocalForms(value) {
    return value
      .replace(/(\d{4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*[日号號]?/gu,
        (_, year, month, day) => `${year}年${Number(month)}月${Number(day)}日`)
      .replace(/(^|\D)(\d{4})([-/])(\d{1,2})\3(\d{1,2})(?!\d)/gu,
        (_, before, year, __, month, day) => `${before}${year}年${Number(month)}月${Number(day)}日`)
      .replace(/(^|\D)(\d{1,2}):([0-5]\d)(?!\d)/gu,
        (_, before, hour, minute) => `${before}${hour}点${minute === '00' ? '' : `${minute}分`}`)
      .replace(/(\d+(?:\.\d+)?)\s*%(?!\d)/gu, (_, number) => `百分之${number}`)
      .replace(/\((0\d{1,3})\)\s*(\d[\d-]*\d)/gu, (whole, area, rest) => {
        const digits = (area + rest).replace(/-/gu, '');
        return digits.length >= 7 ? digitsToChinese(digits) : whole;
      })
      .replace(/(^|[^\d.\-])(0[\d-]*\d)/gu, (whole, before, run) => {
        const digits = run.replace(/-/gu, '');
        return digits.length >= 7 ? `${before}${digitsToChinese(digits)}` : whole;
      });
  }

  function normalizeNumbers(value) {
    return normalizeFullWidth(value)
      .replace(/(\d{4})\s*[年\-/]\s*(\d{1,2})\s*[月\-/]\s*(\d{1,2})\s*[日号]?/gu,
        (_, year, month, day) => `${digitsToChinese(year)}年${integerToChinese(month)}月${integerToChinese(day)}日`)
      .replace(/(\d{1,2}):(\d{2})/gu,
        (_, hour, minute) => `${integerToChinese(hour)}点${minute === '00' ? '' : `${integerToChinese(minute)}分`}`)
      .replace(/(\d+(?:\.\d+)?)\s*%/gu, (_, number) => `百分之${numberToChinese(number)}`)
      .replace(/(-?)(\d+\.\d+)/gu,
        (_, sign, number) => `${sign ? '负' : ''}${numberToChinese(number)}`)
      .replace(/(-?)(\d+)/gu,
        (_, sign, number) => `${sign ? '负' : ''}${integerToChinese(number)}`);
  }

  function normalizePunctuation(value) {
    let output = '';
    for (const character of value.normalize('NFKC')) {
      output += PUNCTUATION.get(character) ?? character;
    }
    return output
      .replace(/[\r\n]+/gu, '.')
      .replace(/\s+/gu, ' ')
      .replace(/\.{2,}/gu, '.')
      .trim();
  }

  function createFrontend({
    lexiconText,
    lexiconSupplementText = '',
    tokensText,
    convertTraditional = (text) => text,
    pronunciationOverrides = {},
    contextualRules = [],
    ruleNormalizer = null,
  }) {
    const {lexicon, maxKeyLength: sourceMaxKeyLength} = parseLexicon(lexiconText);
    const tokens = parseTokens(tokensText);
    let maxKeyLength = sourceMaxKeyLength;
    let lexiconSupplementSize = 0;

    if (lexiconSupplementText) {
      // 補充詞條(繁體鏡像)不得覆寫主詞典既有條目;主詞典優先、
      // pronunciationOverrides 最後套用仍可蓋過補充詞條。
      const {lexicon: supplementLexicon} = parseLexicon(lexiconSupplementText);
      for (const [word, phones] of supplementLexicon) {
        if (lexicon.has(word)) continue;
        lexicon.set(word, phones);
        lexiconSupplementSize += 1;
        maxKeyLength = Math.max(maxKeyLength, word.length);
      }
    }

    for (const [word, phones] of Object.entries(pronunciationOverrides)) {
      const list = Array.isArray(phones) ? phones : String(phones).trim().split(/\s+/u);
      lexicon.set(word, list);
      maxKeyLength = Math.max(maxKeyLength, word.length);
    }

    function prepareText(text) {
      const source = normalizeFullWidth(normalizeLayoutSeparators(convertTraditional(String(text))));
      const normalized = ruleNormalizer
        ? normalizeNumbers(ruleNormalizer(normalizeLocalForms(source)))
        : normalizeNumbers(source);
      return normalizePunctuation(normalized);
    }

    function tokensFor(text, {allowUnknown = false} = {}) {
      const normalizedText = prepareText(text);
      const ids = [];
      const phones = [];
      const unknown = [];
      const lexiconMatches = [];
      const contextualMatches = [];
      const singleCharacterFallbacks = [];

      for (let offset = 0; offset < normalizedText.length;) {
        const character = normalizedText[offset];
        if (/\s/u.test(character)) {
          offset += 1;
          continue;
        }

        const punctuationId = tokens.get(character);
        if (PUNCTUATION.has(character) || '.,!?:;—…“”()"'.includes(character)) {
          if (Number.isFinite(punctuationId)) {
            ids.push(punctuationId);
            phones.push(character);
          }
          offset += 1;
          continue;
        }

        let match = null;
        const remaining = normalizedText.length - offset;
        for (let length = Math.min(maxKeyLength, remaining); length > 0; length -= 1) {
          const word = normalizedText.slice(offset, offset + length);
          const wordPhones = lexicon.get(word);
          if (wordPhones) {
            match = {word, phones: wordPhones};
            break;
          }
        }

        if (!match) {
          unknown.push({character, offset});
          offset += character.length;
          continue;
        }

        const contextualRule = [...match.word].length === 1
          ? contextualRules.find((rule) => rule.pattern === match.word
            && ((!rule.previousCharacters && !rule.followingCharacters)
              || rule.previousCharacters?.has(normalizedText[offset - 1] ?? '')
              || rule.followingCharacters?.has(normalizedText[offset + match.word.length] ?? '')))
          : null;
        const matchPhones = contextualRule?.target ?? match.phones;
        const traceEntry = {
          word: match.word,
          offset,
          phones: [...matchPhones],
        };
        lexiconMatches.push(traceEntry);
        if (contextualRule) contextualMatches.push(traceEntry);
        else if ([...match.word].length === 1) singleCharacterFallbacks.push(traceEntry);

        const missingPhones = matchPhones.filter((phone) => !tokens.has(phone));
        if (missingPhones.length) {
          unknown.push({word: match.word, offset, missingPhones});
        } else {
          for (const phone of matchPhones) {
            ids.push(tokens.get(phone));
            phones.push(phone);
          }
        }
        offset += match.word.length;
      }

      if (unknown.length && !allowUnknown) {
        const error = new Error(`Matcha 前端無法處理：${unknown.map((entry) => entry.word ?? entry.character).join('、')}`);
        error.unknown = unknown;
        throw error;
      }
      return {
        text: String(text),
        normalizedText,
        ids,
        phones,
        unknown,
        lexiconMatches,
        contextualMatches,
        singleCharacterFallbacks,
      };
    }

    return {
      prepareText,
      tokensFor,
      lexiconSize: lexicon.size,
      lexiconSupplementSize,
      tokenCount: tokens.size,
      ruleFstCount: ruleNormalizer ? 3 : 0,
    };
  }

  const api = {
    createFrontend,
    integerToChinese,
    normalizeFullWidth,
    normalizeLayoutSeparators,
    normalizeNumbers,
    normalizeLocalForms,
    normalizePunctuation,
    numberToChinese,
    parseLexicon,
    parseTokens,
    pronunciationOverridesFromReview,
    contextualRulesFromReview,
  };
  globalScope.MatchaFrontend = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof globalThis !== 'undefined' ? globalThis : self));
