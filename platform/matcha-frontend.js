(function initMatchaFrontend(globalScope) {
  'use strict';

  const DIGITS = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九'];
  const SMALL_UNITS = ['', '十', '百', '千'];
  const LARGE_UNITS = ['', '万', '亿', '兆'];
  const PUNCTUATION = new Map([
    ['。', '.'], ['．', '.'], ['｡', '.'],
    ['，', ','], ['、', ','],
    ['！', '!'], ['？', '?'],
    ['；', ';'], ['：', ':'],
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
      .replace(/[０-９]/gu, (character) => String(character.charCodeAt(0) - 0xfee0))
      .replace(/％/gu, '%')
      .replace(/＋/gu, '+')
      .replace(/－/gu, '-')
      .replace(/：/gu, ':');
  }

  // 保留 Bookworm 已驗證的臺灣格式修正：只重整 FST 已知會誤讀的外形，
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
    tokensText,
    convertTraditional = (text) => text,
    pronunciationOverrides = {},
    ruleNormalizer = null,
  }) {
    const {lexicon, maxKeyLength: sourceMaxKeyLength} = parseLexicon(lexiconText);
    const tokens = parseTokens(tokensText);
    let maxKeyLength = sourceMaxKeyLength;

    for (const [word, phones] of Object.entries(pronunciationOverrides)) {
      const list = Array.isArray(phones) ? phones : String(phones).trim().split(/\s+/u);
      lexicon.set(word, list);
      maxKeyLength = Math.max(maxKeyLength, word.length);
    }

    function prepareText(text) {
      const source = normalizeFullWidth(convertTraditional(String(text)));
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

        const missingPhones = match.phones.filter((phone) => !tokens.has(phone));
        if (missingPhones.length) {
          unknown.push({word: match.word, offset, missingPhones});
        } else {
          for (const phone of match.phones) {
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
      return {text: String(text), normalizedText, ids, phones, unknown};
    }

    return {
      prepareText,
      tokensFor,
      lexiconSize: lexicon.size,
      tokenCount: tokens.size,
      ruleFstCount: ruleNormalizer ? 3 : 0,
    };
  }

  const api = {
    createFrontend,
    integerToChinese,
    normalizeNumbers,
    normalizeLocalForms,
    normalizePunctuation,
    numberToChinese,
    parseLexicon,
    parseTokens,
  };
  globalScope.MatchaFrontend = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof globalThis !== 'undefined' ? globalThis : self));
