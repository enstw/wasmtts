// OpenFST rule-FST applier in plain JS, so the offline engine can run sherpa's
// zh text-normalization tables (phone.fst, date.fst, number.fst) without the
// 512 MiB sherpa-onnx WASM bundle they normally ship inside. The three tables
// are 212 KB on disk and byte-identical across every sherpa zh voice pack.
//
// This reproduces kaldifst's TextNormalizer::Normalize: encode the input as
// UTF-8 bytes, compose that linear FSA with the rule transducer, take the
// tropical shortest path, then emit the output labels as bytes and drop the
// epsilons. (kaldifst's remove_output_zero flag is exactly that epsilon drop —
// with it off, the NUL bytes show up in the returned string.)
//
// Composition is never materialised. With a fixed input the composed state is
// just (ruleState, bytePosition), and a byte-consuming arc only ever moves one
// position forward, so the composed graph is a DAG whose arcs we can enumerate
// on the fly from the rule table.
//
// The search is deliberately not a plain Dijkstra. These tables leave several
// readings of a long digit run at exactly equal cost, so which one you get is
// decided by the tie-break, and OpenFST's is a specific one: ShortestPath uses
// AutoQueue, which on an acyclic FST is a TopOrderQueue, so states relax in DFS
// reverse postorder and a parent pointer is overwritten only on a strict
// improvement. Doing the same here is what makes the output byte-identical to
// kaldifst rather than merely equally-weighted — a plain Dijkstra disagreed on
// 33 of 2,547 corpus cases, including "8.0" (八点零 vs 八.零, where the stray
// period would have become a sentence break downstream).
//
// IIFE global with a CommonJS tail, matching matcha-frontend.js: importScripts
// in the synth worker sets self.MatchaFst, and node's ESM loader sets
// globalThis.MatchaFst so the tests can import it without a build step.
(function initMatchaFst(globalScope) {
  'use strict';

  // fst::kFstMagicNumber. Anything else is not an OpenFST archive.
  const MAGIC = 2125659606;

  function readHeader(view, cursor) {
    const int32 = () => {
      const value = view.getInt32(cursor.offset, true);
      cursor.offset += 4;
      return value;
    };
    const int64 = () => {
      const value = Number(view.getBigInt64(cursor.offset, true));
      cursor.offset += 8;
      return value;
    };
    const string = () => {
      const length = int32();
      let text = '';
      for (let index = 0; index < length; index += 1) {
        text += String.fromCharCode(view.getUint8(cursor.offset + index));
      }
      cursor.offset += length;
      return text;
    };

    if (int32() !== MAGIC) throw new Error('FST: bad magic number');
    const fstType = string();
    const arcType = string();
    const version = int32();
    const flags = int32();
    int64();                                   // properties, recomputed on load
    const start = int64();
    const numStates = int64();
    int64();                                   // numArcs, zero in these tables
    return {fstType, arcType, version, flags, start, numStates};
  }

  // VectorFst body, per state: final weight (float32 tropical, +Infinity when
  // the state is not final), arc count (int64), then arcs of (ilabel, olabel,
  // weight, nextstate). Flattened into typed arrays because the search touches
  // arcs far more often than states.
  function readFst(source) {
    const bytes = source instanceof Uint8Array ? source : new Uint8Array(source);
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const cursor = {offset: 0};
    const header = readHeader(view, cursor);

    if (header.fstType !== 'vector') throw new Error(`FST: unsupported type ${header.fstType}`);
    if (header.arcType !== 'standard') throw new Error(`FST: unsupported arc type ${header.arcType}`);
    // Bits 0 and 1 mean the header is followed by input/output symbol tables.
    // These tables carry none — the labels are raw UTF-8 byte values — and a
    // reader that silently skipped them would misparse the body.
    if (header.flags & 3) throw new Error('FST: embedded symbol tables are not supported');

    const numStates = header.numStates;
    const finalWeight = new Float32Array(numStates);
    const arcOffset = new Int32Array(numStates + 1);

    // First pass: count arcs so the flat arrays can be sized exactly.
    const bodyStart = cursor.offset;
    let totalArcs = 0;
    for (let state = 0; state < numStates; state += 1) {
      cursor.offset += 4;
      const count = Number(view.getBigInt64(cursor.offset, true));
      cursor.offset += 8 + count * 16;
      arcOffset[state + 1] = (totalArcs += count);
    }

    const arcInput = new Int32Array(totalArcs);
    const arcOutput = new Int32Array(totalArcs);
    const arcWeight = new Float32Array(totalArcs);
    const arcTarget = new Int32Array(totalArcs);
    const epsilonEnd = new Int32Array(numStates);

    cursor.offset = bodyStart;
    let arc = 0;
    for (let state = 0; state < numStates; state += 1) {
      finalWeight[state] = view.getFloat32(cursor.offset, true);
      cursor.offset += 4;
      const count = Number(view.getBigInt64(cursor.offset, true));
      cursor.offset += 8;
      for (let index = 0; index < count; index += 1, arc += 1) {
        arcInput[arc] = view.getInt32(cursor.offset, true);
        arcOutput[arc] = view.getInt32(cursor.offset + 4, true);
        arcWeight[arc] = view.getFloat32(cursor.offset + 8, true);
        arcTarget[arc] = view.getInt32(cursor.offset + 12, true);
        cursor.offset += 16;
      }
      // The search binary-searches arcs by input label. These tables ship
      // ilabel-sorted, but sorting an already-sorted slice is cheap insurance
      // against a table that is not.
      sortArcRange(arcOffset[state], arcOffset[state + 1], arcInput, arcOutput, arcWeight, arcTarget);
      let end = arcOffset[state];
      while (end < arcOffset[state + 1] && arcInput[end] === 0) end += 1;
      epsilonEnd[state] = end;
    }

    const fst = {
      start: header.start,
      numStates,
      finalWeight,
      arcOffset,
      epsilonEnd,
      arcInput,
      arcOutput,
      arcWeight,
      arcTarget,
    };
    // Reverse postorder is only a topological order on a DAG. Byte arcs always
    // advance the position, so the composed graph can only cycle through
    // input-epsilon arcs; none of sherpa's tables has such a cycle, and a table
    // that did would need a different search rather than a silently worse
    // answer.
    if (hasEpsilonCycle(fst)) throw new Error('FST: input-epsilon cycle is not supported');
    return fst;
  }

  function sortArcRange(from, to, input, output, weight, target) {
    for (let i = from + 1; i < to; i += 1) {
      const il = input[i], ol = output[i], w = weight[i], t = target[i];
      if (input[i - 1] <= il) continue;
      let j = i - 1;
      while (j >= from && input[j] > il) {
        input[j + 1] = input[j];
        output[j + 1] = output[j];
        weight[j + 1] = weight[j];
        target[j + 1] = target[j];
        j -= 1;
      }
      input[j + 1] = il;
      output[j + 1] = ol;
      weight[j + 1] = w;
      target[j + 1] = t;
    }
  }

  function hasEpsilonCycle(fst) {
    const color = new Uint8Array(fst.numStates);        // 0 unseen, 1 open, 2 done
    const stack = [];
    for (let root = 0; root < fst.numStates; root += 1) {
      if (color[root]) continue;
      stack.push(root, fst.arcOffset[root]);
      color[root] = 1;
      while (stack.length) {
        const arc = stack.pop();
        const state = stack.pop();
        if (arc < fst.epsilonEnd[state]) {
          stack.push(state, arc + 1);
          const target = fst.arcTarget[arc];
          if (color[target] === 1) return true;
          if (color[target] === 0) {
            color[target] = 1;
            stack.push(target, fst.arcOffset[target]);
          }
        } else {
          color[state] = 2;
        }
      }
    }
    return false;
  }

  // Index of the first arc of `state` whose input label is >= `label`.
  function lowerBound(fst, state, label) {
    let low = fst.arcOffset[state];
    let high = fst.arcOffset[state + 1];
    while (low < high) {
      const mid = (low + high) >> 1;
      if (fst.arcInput[mid] < label) low = mid + 1;
      else high = mid;
    }
    return low;
  }

  const encoder = new TextEncoder();
  const decoder = new TextDecoder();

  // The search holds every reachable (position, state) pair, so its cost grows
  // with the input — about 19 KB and 7 µs per byte on a run of pure digits,
  // which is the worst case these tables have. The engine hands us one sentence
  // at a time (~72 chars, so ~216 bytes of Chinese), and this cap sits ~5x above
  // that: a pathological line of thousands of digits passes through untouched
  // and is read by the JS number rules instead of costing a phone 150 MB.
  const MAX_INPUT_BYTES = 1024;

  // Shortest path through (ruleState, bytePosition). Returns the output bytes,
  // or null when no path reaches a final state having consumed every input
  // byte — callers treat that as "this rule does not apply" and pass the text
  // through untouched, which is what an empty composition amounts to upstream.
  function transduce(fst, input) {
    const length = input.length;
    const width = fst.numStates;
    const startKey = fst.start;                        // position 0

    // Composition order at (position, state): the rule's input-epsilon arcs
    // first, then its arcs matching the current byte. Held as two ranges so
    // neither the DFS nor the relaxation has to allocate an arc list.
    const byteFrom = [];
    const byteTo = [];
    // Fills the byte range for a freshly pushed frame and returns the arc it
    // should start on: the first epsilon arc if the state has any, otherwise
    // straight into the byte range.
    function openFrame(position, state, frame) {
      // Past the last byte there are no matching arcs; anchoring the empty
      // range at the end of the state's arcs keeps it outside the epsilon
      // range too, so the frame simply runs out.
      let from = fst.arcOffset[state + 1];
      let to = from;
      if (position < length) {
        const byte = input[position];
        from = lowerBound(fst, state, byte);
        to = from;
        while (to < fst.arcOffset[state + 1] && fst.arcInput[to] === byte) to += 1;
      }
      byteFrom[frame] = from;
      byteTo[frame] = to;
      return fst.arcOffset[state] < fst.epsilonEnd[state] ? fst.arcOffset[state] : from;
    }

    // Iterative DFS collecting reverse postorder.
    const seen = new Set([startKey]);
    const order = [];
    const stackKey = [startKey];
    const stackPos = [0];
    const stackState = [fst.start];
    const stackArc = [0];
    stackArc[0] = openFrame(0, fst.start, 0);

    while (stackKey.length) {
      const frame = stackKey.length - 1;
      const state = stackState[frame];
      const position = stackPos[frame];
      let arc = stackArc[frame];
      let nextArc = -1;
      let nextPosition = position;
      if (arc < fst.epsilonEnd[state]) {
        nextArc = arc;
        arc += 1;
        stackArc[frame] = arc < fst.epsilonEnd[state] ? arc : byteFrom[frame];
      } else if (arc < byteTo[frame]) {
        nextArc = arc;
        nextPosition = position + 1;
        stackArc[frame] = arc + 1;
      }
      if (nextArc < 0) {
        order.push(stackKey[frame]);
        stackKey.pop();
        stackPos.pop();
        stackState.pop();
        stackArc.pop();
        byteFrom.pop();
        byteTo.pop();
        continue;
      }
      const target = fst.arcTarget[nextArc];
      const key = nextPosition * width + target;
      if (seen.has(key)) continue;
      seen.add(key);
      const child = stackKey.length;
      stackKey.push(key);
      stackPos.push(nextPosition);
      stackState.push(target);
      stackArc.push(0);
      stackArc[child] = openFrame(nextPosition, target, child);
    }

    // Relax in topological order. A parent is replaced only on a strict
    // improvement, which is what decides equal-cost readings.
    const distance = new Map([[startKey, 0]]);
    const parent = new Map();
    const parentLabel = new Map();
    let bestCost = Infinity;
    let bestKey = -1;

    for (let index = order.length - 1; index >= 0; index -= 1) {
      const key = order[index];
      const cost = distance.get(key);
      if (cost === undefined) continue;
      const position = Math.floor(key / width);
      const state = key - position * width;
      if (position === length) {
        const total = cost + fst.finalWeight[state];
        if (total < bestCost) {
          bestCost = total;
          bestKey = key;
        }
      }
      const relax = (arc, target) => {
        const candidate = cost + fst.arcWeight[arc];
        const known = distance.get(target);
        if (known !== undefined && known <= candidate) return;
        distance.set(target, candidate);
        parent.set(target, key);
        parentLabel.set(target, fst.arcOutput[arc]);
      };
      for (let arc = fst.arcOffset[state]; arc < fst.epsilonEnd[state]; arc += 1) {
        relax(arc, position * width + fst.arcTarget[arc]);
      }
      if (position < length) {
        const byte = input[position];
        for (let arc = lowerBound(fst, state, byte);
             arc < fst.arcOffset[state + 1] && fst.arcInput[arc] === byte;
             arc += 1) {
          relax(arc, (position + 1) * width + fst.arcTarget[arc]);
        }
      }
    }

    if (bestKey < 0) return null;

    const reversed = [];
    for (let key = bestKey; key !== startKey;) {
      const previous = parent.get(key);
      if (previous === undefined) return null;
      const label = parentLabel.get(key);
      if (label !== 0) reversed.push(label);
      key = previous;
    }
    reversed.reverse();
    return Uint8Array.from(reversed);
  }

  function applyFst(fst, text) {
    if (!text) return text;
    const input = encoder.encode(text);
    if (input.length > MAX_INPUT_BYTES) return text;
    const output = transduce(fst, input);
    return output === null ? text : decoder.decode(output);
  }

  // sherpa applies its rule FSTs in sequence, each over the previous output.
  // Order is load-bearing and follows the tested browser config: phone, then
  // date, then number (sherpa-onnx-tts.js sets
  // './phone-zh.fst,./date-zh.fst,./number-zh.fst').
  function createNormalizer(tables) {
    const chain = tables.map((table) => (table && table.arcInput ? table : readFst(table)));
    return function normalize(text) {
      let output = String(text);
      for (const fst of chain) output = applyFst(fst, output);
      return output;
    };
  }

  const api = {readFst, applyFst, createNormalizer};
  globalScope.MatchaFst = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
}(typeof globalThis !== 'undefined' ? globalThis : self));
