// Unit test for public/matcha-fst.js, the JS applier for sherpa's zh rule FSTs.
//
// The always-on half builds its own OpenFST archives in memory, so it needs no
// model files and stays in the `pnpm test` chain. Those fixtures are not
// decoration: the tie fixture pins the one behaviour that is easy to get
// subtly wrong. Several readings of a number cost exactly the same under these
// tables, and OpenFST's ShortestPath breaks that tie with an AutoQueue — a
// TopOrderQueue on an acyclic FST — so the winner is decided by DFS reverse
// postorder, not by discovery order. A plain Dijkstra picks the other path and
// turns "8.0" into 八.零, whose stray period becomes a sentence break in the
// reader. Both expected values below were produced by kaldifst itself.
//
// The second half replays a golden corpus through the real 212 KB tables, and
// runs only when MATCHA_FST_DIR points at a directory holding phone.fst,
// date.fst and number.fst. The goldens are kaldifst's own output, so the test
// stays network-free while still being a differential test against upstream.
//
//   pnpm test:matcha-fst
//   MATCHA_FST_DIR=platform/models/matcha-icefall-zh-en \
//     node platform/test-matcha-fst.mjs

import { readFileSync } from "node:fs";
import { join } from "node:path";
import "./matcha-fst.js";

const { readFst, applyFst, createNormalizer } = globalThis.MatchaFst;

const out = {};
const threw = (fn, match) => {
  try { fn(); return false; } catch (error) { return String(error.message).includes(match); }
};

// ---- fixture writer -------------------------------------------------------

// VectorFst on disk: magic, fsttype, arctype, version, flags, properties,
// start, numstates, numarcs; then per state a final weight (+Infinity when the
// state is not final), an arc count, and arcs of ilabel/olabel/weight/next.
function buildFst(start, states, {magic = 2125659606, fstType = "vector", arcType = "standard", flags = 0} = {}) {
  const parts = [];
  const i32 = (v) => { const b = Buffer.alloc(4); b.writeInt32LE(v); return b; };
  const i64 = (v) => { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt(v)); return b; };
  const f32 = (v) => { const b = Buffer.alloc(4); b.writeFloatLE(v); return b; };
  const str = (s) => Buffer.concat([i32(s.length), Buffer.from(s, "latin1")]);
  parts.push(i32(magic), str(fstType), str(arcType), i32(2), i32(flags), i64(0),
             i64(start), i64(states.length), i64(states.reduce((a, s) => a + s.arcs.length, 0)));
  for (const state of states) {
    parts.push(f32(state.final === null ? Infinity : state.final), i64(state.arcs.length));
    for (const [ilabel, olabel, weight, next] of state.arcs) {
      parts.push(i32(ilabel), i32(olabel), f32(weight), i32(next));
    }
  }
  return new Uint8Array(Buffer.concat(parts));
}

const ch = (c) => c.charCodeAt(0);
const EPS = 0;

// ---- header handling ------------------------------------------------------

out.magic = threw(() => readFst(buildFst(0, [{final: 0, arcs: []}], {magic: 1})), "bad magic")
  ? "ok (rejects a non-FST file)" : "FAIL";

out.fstType = threw(() => readFst(buildFst(0, [{final: 0, arcs: []}], {fstType: "const"})), "unsupported type")
  ? "ok (rejects a non-vector FST)" : "FAIL";

// Flags bits 0/1 mean symbol tables follow the header. Skipping them silently
// would misparse every byte of the body, so the reader has to refuse.
out.symbolTables = threw(() => readFst(buildFst(0, [{final: 0, arcs: []}], {flags: 1})), "symbol tables")
  ? "ok (rejects embedded symbol tables)" : "FAIL";

// ---- transduction ---------------------------------------------------------

// 'a' → "hi" via an output-epsilon arc, everything else identity. Also proves
// the start state is read from the header rather than assumed to be 0.
const rewrite = readFst(buildFst(1, [
  {final: 0, arcs: []},
  {final: 0, arcs: [[ch("a"), ch("h"), 0, 2], [ch("b"), ch("b"), 0, 1]]},
  {final: null, arcs: [[EPS, ch("i"), 0, 1]]},
]));
out.rewrite = applyFst(rewrite, "ab") === "hib" && applyFst(rewrite, "bb") === "bb"
  ? "ok (rule fires, epsilon input emits, start state honoured)"
  : `FAIL ${JSON.stringify([applyFst(rewrite, "ab"), applyFst(rewrite, "bb")])}`;

// An output epsilon is a deletion, not a NUL in the string.
const deleter = readFst(buildFst(0, [
  {final: 0, arcs: [[ch("a"), EPS, 0, 0], [ch("b"), ch("b"), 0, 0]]},
]));
out.epsilonOutput = deleter && applyFst(deleter, "aabab") === "bb"
  ? "ok (output epsilon deletes)" : `FAIL ${JSON.stringify(applyFst(deleter, "aabab"))}`;

// Weights have to decide between competing readings.
const weighted = readFst(buildFst(0, [
  {final: null, arcs: [[ch("a"), ch("x"), 3, 1], [ch("a"), ch("y"), 1, 1]]},
  {final: 0, arcs: []},
]));
out.weights = applyFst(weighted, "a") === "y"
  ? "ok (cheaper arc wins)" : `FAIL ${JSON.stringify(applyFst(weighted, "a"))}`;

// THE TIE. Both readings of "ab" cost 0: x·y through state 1, z·w through
// state 2. kaldifst returns "zw" — reverse postorder reaches state 2's
// contribution to the shared final state first, and the parent pointer is only
// replaced on a STRICT improvement, so state 1 cannot take it back. Discovery
// order would say "xy". If this line flips, the applier stopped agreeing with
// OpenFST even though the cost it found is still right.
const tie = readFst(buildFst(0, [
  {final: null, arcs: [[ch("a"), ch("x"), 0, 1], [ch("a"), ch("z"), 0, 2]]},
  {final: null, arcs: [[ch("b"), ch("y"), 0, 3]]},
  {final: null, arcs: [[ch("b"), ch("w"), 0, 3]]},
  {final: 0, arcs: []},
]));
out.tieBreak = applyFst(tie, "ab") === "zw"
  ? "ok (OpenFST tie-break: reverse postorder, strict improvement)"
  : `FAIL ${JSON.stringify(applyFst(tie, "ab"))} — expected "zw" (kaldifst)`;

// ---- passthrough and refusal ----------------------------------------------

// No path consuming the whole input means the rule does not apply; the text
// has to survive intact rather than come back truncated or empty.
const partial = readFst(buildFst(0, [
  {final: null, arcs: [[ch("a"), ch("A"), 0, 1]]},
  {final: 0, arcs: []},
]));
out.noPath = applyFst(partial, "a") === "A" && applyFst(partial, "ab") === "ab" && applyFst(partial, "") === ""
  ? "ok (unmatched text passes through)"
  : `FAIL ${JSON.stringify([applyFst(partial, "a"), applyFst(partial, "ab")])}`;

// The search holds every reachable (position, state) pair, so a pathological
// line of digits would cost a phone hundreds of MB. Past the cap the text
// passes through and the JS number rules read it instead.
const identity = readFst(buildFst(0, [
  {final: 0, arcs: [[ch("a"), ch("b"), 0, 0]]},
]));
out.inputCap = applyFst(identity, "a".repeat(1024)) === "b".repeat(1024)
  && applyFst(identity, "a".repeat(1025)) === "a".repeat(1025)
  ? "ok (1024-byte cap, passthrough above it)" : "FAIL";

// Reverse postorder is only a topological order on a DAG. Byte arcs always
// advance, so the only way to cycle is through input epsilons — refuse such a
// table loudly instead of returning a quietly worse answer.
out.epsilonCycle = threw(() => readFst(buildFst(0, [
  {final: 0, arcs: [[EPS, EPS, 0, 1]]},
  {final: null, arcs: [[EPS, EPS, 0, 0]]},
])), "epsilon cycle")
  ? "ok (rejects an input-epsilon cycle)" : "FAIL";

// Arcs are binary-searched by input label, so an unsorted table must be sorted
// on load rather than silently half-searched.
const unsorted = readFst(buildFst(0, [
  {final: 0, arcs: [[ch("c"), ch("C"), 0, 0], [ch("a"), ch("A"), 0, 0], [ch("b"), ch("B"), 0, 0]]},
]));
out.arcSort = applyFst(unsorted, "abc") === "ABC"
  ? "ok (unsorted arcs sorted on load)" : `FAIL ${JSON.stringify(applyFst(unsorted, "abc"))}`;

// ---- golden corpus against the real tables --------------------------------

// Every expected value here is kaldifst's own output for the same input,
// through the same chain sherpa configures: phone, then date, then number
// (sherpa-onnx-tts.js: './phone-zh.fst,./date-zh.fst,./number-zh.fst').
//
// Some of these are upstream's answer, not the answer bookworm wants to speak:
// a Taiwan 10-digit mobile becomes one huge integer, "%" survives to be dropped
// as an unknown glyph, and "14:30" keeps a colon that reads as a pause. They are
// pinned as upstream behaviour so this file tests the applier against what
// sherpa does, and normalizeLocalForms in matcha-frontend.js reframes the input
// so those three never reach the tables in that shape. If a line here changes,
// the applier drifted; if the reading changes, look there instead.
const GOLDEN = [
  ["第12章开始于2026年8月7日14:30。请拨打110或者18920260807。她说：“我们还有25.5%的路没走完。”巷口堆着一袋垃圾。",
   "第十二章开始于二零二六年八月七日十四:三十。请拨打幺幺零或者幺八九二零二六零八零七。她说：“我们还有二十五点五%的路没走完。”巷口堆着一袋垃圾。"],
  ["2026年8月7日", "二零二六年八月七日"],
  ["2026年", "二零二六年"],
  ["8月7日", "八月七日"],
  ["第3章", "第三章"],
  ["他有100元", "他有一百元"],
  ["3.14", "三点一四"],
  ["1.5倍", "一点五倍"],
  ["下午3點", "下午三點"],
  ["0", "零"],
  ["1", "一"],
  ["10", "十"],
  ["100", "一百"],
  ["101", "一百零一"],
  ["1010", "一千零一十"],
  ["10000000", "一千万"],
  ["1234567890", "十二亿三千四百五十六万七千八百九十"],
  ["13812345678", "幺三八一二三四五六七八"],
  ["110", "幺幺零"],
  ["abc", "abc"],
  ["你好，世界。", "你好，世界。"],
  ["我 有 100 元", "我 有 一百 元"],
  ["你好🙂123", "你好🙂一百二十三"],
  // equal-cost readings — these are the cases the tie-break decides
  ["8.0", "八点零"],
  ["6990700860661", "六千九百九十七亿零八十六万零六百六十一"],
  // upstream behaviour bookworm overrides in the frontend, pinned here as-is
  ["14:30", "十四:三十"],
  ["25.5%", "二十五点五%"],
  ["100%", "一百%"],
  ["0912345678", "零九亿一千二百三十四万五千六百七十八"],
  ["02-2345-6789", "零二-二千三百四十五-六千七百八十九"],
  ["2026-08-07", "二千零二十六-零八-零七"],
  ["他看著窗外，銀行的會計今天很乾淨，2026年8月7日14:30，25.5%，0912345678。",
   "他看著窗外，銀行的會計今天很乾淨，二零二六年八月七日十四:三十，二十五点五%，零九亿一千二百三十四万五千六百七十八。"],
];

const dir = process.env.MATCHA_FST_DIR;
if (!dir) {
  out.golden = `skipped (${GOLDEN.length} cases; set MATCHA_FST_DIR to the sherpa table directory)`;
} else {
  const normalize = createNormalizer(
    ["phone", "date", "number"].map((name) => readFileSync(join(dir, `${name}-zh.fst`))));
  const drift = GOLDEN.filter(([input, want]) => normalize(input) !== want)
    .map(([input, want]) => `${JSON.stringify(input)}: ${JSON.stringify(normalize(input))} ≠ ${JSON.stringify(want)}`);
  out.golden = drift.length === 0
    ? `ok (${GOLDEN.length} cases match kaldifst)`
    : `FAIL\n    ${drift.join("\n    ")}`;
}

console.log(JSON.stringify(out, null, 2));
if (Object.values(out).some((v) => String(v).startsWith("FAIL"))) process.exit(1);

export {GOLDEN};
