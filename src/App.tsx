// ─────────────────────────────────────────────────────────────────────────────
// Quran Page Processor  — Complete Edition v6
// npm install svgo
// ─────────────────────────────────────────────────────────────────────────────

import { useState, useCallback, useRef, useEffect } from "react";
import { optimize } from "svgo";

// ══════════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ══════════════════════════════════════════════════════════════════════════════

const STORAGE_KEY = "qproc_v9";

// ── External APIs ─────────────────────────────────────────────────────────────
// Quran.com API v4 — tafsir, translations, metadata (no auth needed for basic reads)
const QURAN_API     = "https://api.quran.com/api/v4";
// EveryAyah.com — Warsh audio MP3s by ayah
// Format: https://everyayah.com/data/{reciter}/{surah3digit}{ayah3digit}.mp3
const WARSH_RECITERS: Record<string, { name: string; path: string }> = {
  warsh_husary:  { name: "ورش — الحصري",          path: "Husary_Warsh_128kbps"  },
  warsh_mushary: { name: "ورش — المشاري",          path: "Minshawy_Warsh_128kbps"},
  warsh_ayyoub:  { name: "ورش — أيوب",            path: "Ayyoub_Warsh_128kbps"  },
  warsh_absawi:  { name: "ورش — الأبصيري",        path: "Absawi_Warsh_128kbps"  },
};
const DEFAULT_WARSH = "warsh_husary";
// Tafsir IDs from Quran.com API (Arabic tafsirs)
const TAFSIR_SOURCES: Record<string, { name: string; id: number }> = {
  ibn_kathir:   { name: "ابن كثير",           id: 169 },
  jalalayn:     { name: "الجلالين",            id: 74  },
  tabari:       { name: "الطبري",              id: 91  },
  saadi:        { name: "السعدي",              id: 93  },
  muyassar:     { name: "الميسر",              id: 16  },
  baghawy:      { name: "البغوي",              id: 101 },
};
const DEFAULT_TAFSIR = "ibn_kathir";

// Hizb markers — fraction = what fraction of ONE hizb this mark represents
// 60 hizbs total, each hizb = 4 ربع = 8 ثمن
const HIZB_MARKERS: Record<string, { label: string; fraction: number; symbol: string }> = {
  "ثُمُنٌ": { label: "ثمن", fraction: 0.125, symbol: "⅛" },
  "ثمن":   { label: "ثمن", fraction: 0.125, symbol: "⅛" },
  "®":     { label: "ثمن", fraction: 0.125, symbol: "⅛" },
  "رُبْعٌ": { label: "ربع", fraction: 0.25,  symbol: "¼" },
  "ربع":   { label: "ربع", fraction: 0.25,  symbol: "¼" },
  "©":     { label: "ربع", fraction: 0.25,  symbol: "¼" },
  "نِصْفٌ": { label: "نصف", fraction: 0.5,   symbol: "½" },
  "نصف":   { label: "نصف", fraction: 0.5,   symbol: "½" },
  "¥":     { label: "نصف", fraction: 0.5,   symbol: "½" },
  "حِزْبٌ": { label: "حزب", fraction: 1,     symbol: "◉" },
  "حزب":   { label: "حزب", fraction: 1,     symbol: "◉" },
  "¤":     { label: "حزب", fraction: 1,     symbol: "◉" },
};

// ══════════════════════════════════════════════════════════════════════════════
// TYPES
// ══════════════════════════════════════════════════════════════════════════════

interface HizbMark {
  label: string;        // "ثمن"|"ربع"|"نصف"|"حزب"
  fraction: number;     // 0.125|0.25|0.5|1
  symbol: string;       // "⅛"|"¼"|"½"|"◉"
  hizbIndex: number;    // which hizb (1–60)
  hizbFraction: number; // cumulative (0–60)
  // Human-readable position label e.g. "hizb_3_ثمن_1" or "hizb_3_ربع_2"
  positionId: string;
}

interface WordToken {
  dataTxt: string;        // original from source — as-is font/encoding (display/TSX)
  searchTxtAuto: string;  // auto-normalized (no diacritics, unified alef/ya)
  searchTxtManual: string;// reserved for future word-level override
  classList: string[];
  wid: number | null;
  aid: number | null;
  atid: number | null;
  isAyahMarker: boolean;
  ayahNumber: number | null;
  surahNumber: number;
  hizbMark: HizbMark | null;
  svgRaw: string;
  svgCompressed: string;
}

interface LineToken { words: WordToken[] }

interface AyahGroup {
  aid: number;            // global Quran ayah sequence (from aid_N class)
  ayahNum: number;        // per-surah ayah number (from an_N class, standard numbering)
  surahNumber: number;
  words: WordToken[];
  isComplete: boolean;
  continuesFromPrev: boolean;
  copyTxt: string;
}

interface SurahSegment {
  surahNumber: number;
  surahTitle: string | null;
  ayahs: AyahGroup[];
}

interface ParsedPage {
  pageNumber: number;
  surahNumbers: number[];
  segments: SurahSegment[];
  lines: LineToken[];
  originalBytes: number;
  compressedBytes: number;
  hizbMarks: HizbMark[];
  // Hizb position at START of page (before any marks on it)
  hizbAtStart: number;
}

interface HistoryEntry {
  id: string;
  pageNumber: number;
  surahNumbers: number[];
  label: string;
  parsed: ParsedPage;
  tsx: string;
  savedAt: number;
  // Per-ayah text overrides keyed "surahNum:ayahNum"
  searchOverrides: Record<string, string>;  // searchDataManual
  copyOverrides:   Record<string, string>;  // copyData — clean copy text (user-supplied from Quran source)
}

interface WordOffset { x: number; y: number }
type OffsetMap      = Record<string, WordOffset>;
type ColorMap       = Record<string, string>;

interface Annotation {
  id: string;
  type: "tafsir" | "riwaya";
  targetType: "word" | "ayah" | "surah";
  targetKey: string;
  title: string;
  body: string;
  source: string;
}
type AnnotationStore = Record<string, Record<string, Annotation>>;

// Batch import queue item
interface ImportItem {
  id: string;
  file: File;
  filename: string;
  pageNumber: number;   // parsed from filename or set manually
  surahInput: string;   // "1" or "2,3"
  html: string;         // loaded content
  status: "pending" | "processing" | "done" | "error";
  error?: string;
}

type Step     = "idle" | "parsing" | "compressing" | "generating" | "done" | "error";
type MainView = "processor" | "import" | "history" | "previewer" | "manager";

interface AppState {
  history:          HistoryEntry[];
  allOffsets:       Record<string, OffsetMap>;
  allColors:        Record<string, ColorMap>;
  annotations:      AnnotationStore;
  lineGap:          number;
  hizbCursor:       number;
  lastPageNumber:   number;
  svgoFloatPrec:    number;
  svgoMultipass:    boolean;
}

// ══════════════════════════════════════════════════════════════════════════════
// ARABIC NORMALIZATION
// ══════════════════════════════════════════════════════════════════════════════

function normalizeArabic(text: string): string {
  if (!text) return "";
  let s = text;
  s = s.replace(/[\u064B-\u065F]/g, "");   // tashkeel
  s = s.replace(/\u0640/g, "");             // tatweel
  s = s.replace(/\u0670/g, "");             // superscript alef
  s = s.replace(/[\u06D6-\u06DC\u06DF-\u06E4\u06E7\u06E8\u06EA-\u06ED]/g, "");
  s = s.replace(/[\u06DD\u06DE]/g, "");     // pause marks
  s = s.replace(/[\u0622\u0623\u0625\u0671]/g, "\u0627"); // alef variants → ا
  s = s.replace(/\u0649/g, "\u064A");       // ى → ي
  s = s.replace(/\u0629/g, "\u0647");       // ة → ه
  s = s.replace(/[^\u0600-\u06FF\s\(\)]/g, "");
  return s.replace(/\s+/g, " ").trim();
}

// ══════════════════════════════════════════════════════════════════════════════
// HIZB DETECTION
// ══════════════════════════════════════════════════════════════════════════════

function detectHizbMark(dataTxt: string): { label: string; fraction: number; symbol: string } | null {
  const stripped = dataTxt.replace(/[\u064B-\u065F\u0640\u0670]/g, "").trim();
  for (const [key, val] of Object.entries(HIZB_MARKERS)) {
    if (stripped.includes(key)) return val;
  }
  if (dataTxt.includes("\u06DE")) return { label: "حزب", fraction: 1,    symbol: "◉" };
  if (dataTxt.includes("\u06DD")) return { label: "ربع", fraction: 0.25, symbol: "¼" };
  return null;
}

/**
 * Build a human-readable position ID for a hizb mark.
 *
 * The Quran has 60 hizbs.  Each hizb = 8 eighths (ثمن).
 * hizbFraction is the CUMULATIVE count after this mark:
 *   0.125 = end of 1st eighth of hizb 1   → "hizb_1_ثمن_1"
 *   0.250 = end of 1st quarter of hizb 1  → "hizb_1_ربع_2"
 *   0.500 = half of hizb 1                → "hizb_1_نصف_4"
 *   1.000 = end of hizb 1                 → "hizb_1_حزب"
 *   1.125 = 1st eighth of hizb 2          → "hizb_2_ثمن_1"
 *   1.625 = 5th eighth of hizb 2          → "hizb_2_ثمن_5"
 *
 * Formula:
 *   totalEighths = round(hizbFraction / 0.125)
 *   hizbN        = ceil(totalEighths / 8)   — which hizb (1-based)
 *   posInHizb    = ((totalEighths - 1) % 8) + 1   — position within hizb (1–8)
 *
 * Position labels within a hizb:
 *   1 → ثمن_1   2 → ربع_2   3 → ثمن_3   4 → نصف_4
 *   5 → ثمن_5   6 → ربع_6   7 → ثمن_7   8 → حزب
 */
function buildPositionId(label: string, hizbFraction: number): string {
  // Total eighths from start of Quran (1-indexed after the mark is applied)
  const totalEighths = Math.round(hizbFraction / 0.125);
  if (totalEighths === 0) return "hizb_start";

  // Which hizb this falls in (1-based)
  const hizbN = Math.ceil(totalEighths / 8);

  // Position within that hizb (1 = first eighth, 8 = end of hizb)
  const posInHizb = ((totalEighths - 1) % 8) + 1;

  // Named position
  const POSITION_NAMES: Record<number, string> = {
    1: "ثمن_1",
    2: "ربع_2",
    3: "ثمن_3",
    4: "نصف_4",
    5: "ثمن_5",
    6: "ربع_6",
    7: "ثمن_7",
    8: "حزب",
  };

  const posName = POSITION_NAMES[posInHizb] ?? `pos_${posInHizb}`;
  return `hizb_${hizbN}_${posName}`;
}

// Quick test: buildPositionId("ثمن", 1.625) → hizb_2_ثمن_5 ✓
// buildPositionId("حزب", 3.0) → hizb_3_حزب ✓
// buildPositionId("ربع", 0.25) → hizb_1_ربع_2 ✓

// ══════════════════════════════════════════════════════════════════════════════
// SVGO
// ══════════════════════════════════════════════════════════════════════════════

function compressWithSvgo(svg: string, fp: number, mp: boolean): string {
  try {
    const r = optimize(svg, {
      multipass: mp,
      plugins: [{ name: "preset-default", params: { overrides: {
        removeViewBox: false,
        convertPathData: { floatPrecision: fp },
        convertTransform: { floatPrecision: fp },
        cleanupNumericValues: { floatPrecision: fp },
      }}}],
    });
    return r.data;
  } catch { return svg; }
}

// ══════════════════════════════════════════════════════════════════════════════
// INPUT SANITIZER
// ══════════════════════════════════════════════════════════════════════════════

function unescapeInput(raw: string): string {
  if (!raw.includes("\\")) return raw;
  return raw
    .replace(/\\"/g, '"').replace(/\\'/g, "'")
    .replace(/\\n/g, "\n").replace(/\\r/g, "\r")
    .replace(/\\t/g, "\t").replace(/\\\//g, "/")
    .replace(/\\\\/g, "\\");
}

function cleanSvg(svg: string): string {
  let s = unescapeInput(svg).trim();
  if (!s.startsWith("<svg")) { const i = s.indexOf("<svg"); if (i !== -1) s = s.slice(i); else return svg; }
  return s;
}

// ══════════════════════════════════════════════════════════════════════════════
// PARSER
// ══════════════════════════════════════════════════════════════════════════════

function parseQuranHtml(
  rawHtml: string,
  pageNumber: number,
  surahNumbers: number[],
  hizbCursorIn: number,
): { result: Omit<ParsedPage, "originalBytes" | "compressedBytes">; hizbCursorOut: number } {
  const html = unescapeInput(rawHtml);
  const container = document.createElement("div");
  container.innerHTML = html;
  const page = container.querySelector(".page") ?? container;

  let surahPointer = 0;
  const currentSurahNum = () => surahNumbers[Math.min(surahPointer, surahNumbers.length - 1)];

  const lines: LineToken[] = [];
  let currentLine: WordToken[] = [];
  const segmentMap = new Map<number, { surahTitle: string | null; ayahWords: Map<number, WordToken[]> }>();
  const ensureSegment = (sn: number) => {
    if (!segmentMap.has(sn)) segmentMap.set(sn, { surahTitle: null, ayahWords: new Map() });
    return segmentMap.get(sn)!;
  };

  let hizbCursor = hizbCursorIn;
  const hizbMarks: HizbMark[] = [];

  for (const el of Array.from(page.children) as HTMLElement[]) {
    const cls = Array.from(el.classList);

    if (cls.includes("suraTitle")) {
      ensureSegment(currentSurahNum()).surahTitle = el.getAttribute("data-txt") ?? null;
      surahPointer = Math.min(surahPointer + 1, surahNumbers.length - 1);
      continue;
    }

    if (cls.includes("classLineEnd") || cls.includes("lastWordInLine") || cls.includes("lastWordInPage")) {
      if (currentLine.length > 0) { lines.push({ words: [...currentLine] }); currentLine = []; }
      continue;
    }

    if (cls.includes("word")) {
      const dataTxt = el.getAttribute("data-txt") ?? "";
      if (!dataTxt && (cls.includes("lastWordInPage") || cls.includes("lastWordInLine"))) continue;

      const widMatch  = cls.find((c) => c.startsWith("wid_"));
      const aidMatch  = cls.find((c) => c.startsWith("aid_"));
      const atidMatch = cls.find((c) => c.startsWith("atid_"));
      const anMatch   = cls.find((c) => c.startsWith("an_"));

      const wid          = widMatch  ? parseInt(widMatch.split("_")[1])  : null;
      const aid          = aidMatch  ? parseInt(aidMatch.split("_")[1])  : null;
      const atid         = atidMatch ? parseInt(atidMatch.split("_")[1]) : null;
      const isAyahMarker = cls.includes("aya");
      const ayahNumber   = anMatch   ? parseInt(anMatch.split("_")[1])   : null;
      const sn           = currentSurahNum();

      const hizbDef = detectHizbMark(dataTxt);
      let hizbMark: HizbMark | null = null;
      if (hizbDef) {
        hizbCursor += hizbDef.fraction;
        hizbMark = {
          ...hizbDef,
          hizbIndex:    Math.ceil(hizbCursor),
          hizbFraction: hizbCursor,
          positionId:   buildPositionId(hizbDef.label, hizbCursor),
        };
        hizbMarks.push(hizbMark);
      }

      const svgEl  = el.querySelector("svg");
      const svgRaw = svgEl ? cleanSvg(svgEl.outerHTML) : "";

      const word: WordToken = {
        dataTxt,
        searchTxtAuto:   normalizeArabic(dataTxt),
        searchTxtManual: "",
        classList: cls, wid, aid, atid,
        isAyahMarker, ayahNumber, surahNumber: sn,
        hizbMark, svgRaw, svgCompressed: "",
      };

      currentLine.push(word);
      if (aid !== null) {
        const seg = ensureSegment(sn);
        if (!seg.ayahWords.has(aid)) seg.ayahWords.set(aid, []);
        seg.ayahWords.get(aid)!.push(word);
      }
    }
  }

  if (currentLine.length > 0) lines.push({ words: [...currentLine] });

  const segments: SurahSegment[] = [];
  for (const sn of surahNumbers) {
    const seg = segmentMap.get(sn);
    if (!seg) continue;
    const ayahs: AyahGroup[] = [];
    for (const aid of Array.from(seg.ayahWords.keys()).sort((a, b) => a - b)) {
      const words = seg.ayahWords.get(aid)!;
      const hasMarker = words.some((w) => w.isAyahMarker);
      const continuesFromPrev =
        ayahs.length === 0 && !words[0].isAyahMarker &&
        !words.some((w) => w.ayahNumber !== null && w.ayahNumber === aid);
      // Get the per-surah ayah number from the ayah marker word (an_N class)
      const markerWord = words.find((w) => w.isAyahMarker && w.ayahNumber !== null);
      // Fallback: if no marker found yet (continues from prev page), 
      // use sequential position within this page's segment
      const ayahNum = markerWord?.ayahNumber ?? aid;
      ayahs.push({ aid, ayahNum, surahNumber: sn, words, isComplete: hasMarker, continuesFromPrev });
    }
    segments.push({ surahNumber: sn, surahTitle: seg.surahTitle, ayahs });
  }

  return {
    result: { pageNumber, surahNumbers, segments, lines, hizbMarks, hizbAtStart: hizbCursorIn },
    hizbCursorOut: hizbCursor,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// TSX GENERATOR
// ══════════════════════════════════════════════════════════════════════════════

function generateTsx(
  parsed: ParsedPage,
  searchOverrides: Record<string, string> = {},
  copyOverrides: Record<string, string> = {},
  entryAnnotations: Record<string, Annotation> = {},
  lineGap: number = 4,
): string {
  const { pageNumber, surahNumbers, segments, lines, hizbMarks, hizbAtStart } = parsed;

  const linesCode = lines.map((line, li) => {
    const wordsCode = line.words.map((w) => {
      const uid = w.wid !== null ? `word_${w.wid}_page_${pageNumber}` : `word_p${pageNumber}_l${li}`;
      const hizbStr = w.hizbMark
        ? `, hizbMark: { label: ${JSON.stringify(w.hizbMark.label)}, fraction: ${w.hizbMark.fraction}, symbol: ${JSON.stringify(w.hizbMark.symbol)}, hizbIndex: ${w.hizbMark.hizbIndex}, hizbFraction: ${w.hizbMark.hizbFraction}, positionId: ${JSON.stringify(w.hizbMark.positionId)} }`
        : "";
      const wordAnns   = Object.values(entryAnnotations).filter((a) => a.targetKey === uid);
      const tafsirStr  = wordAnns.filter((a) => a.type === "tafsir").length > 0
        ? `, tafsir: ${JSON.stringify(wordAnns.filter((a) => a.type === "tafsir").map((a) => ({ title: a.title, body: a.body, source: a.source })))}`
        : "";
      const riwayaStr  = wordAnns.filter((a) => a.type === "riwaya").length > 0
        ? `, riwaya: ${JSON.stringify(wordAnns.filter((a) => a.type === "riwaya").map((a) => ({ title: a.title, body: a.body, source: a.source })))}`
        : "";
      return [
        `    {`,
        `      id: ${JSON.stringify(uid)},`,
        `      dataTxt: ${JSON.stringify(w.dataTxt)},`,
        `      searchTxtAuto: ${JSON.stringify(w.searchTxtAuto)},`,
        `      searchTxtManual: ${JSON.stringify(w.searchTxtManual)},`,
        `      ayahId: ${w.aid ?? "null"}, surahNumber: ${w.surahNumber},`,
        `      isAyahMarker: ${w.isAyahMarker}, ayahNumber: ${w.ayahNumber ?? "null"}${hizbStr}${tafsirStr}${riwayaStr},`,
        `      svg: ${JSON.stringify(w.svgCompressed || w.svgRaw)},`,
        `    }`,
      ].join("\n");
    }).join(",\n");
    return `  {\n    lineIndex: ${li + 1}, pageNumber: ${pageNumber},\n    words: [\n${wordsCode}\n    ]\n  }`;
  }).join(",\n");

  const segmentsCode = segments.map((seg) => {
    const ayahsCode = seg.ayahs.map((a) => {
      const textDataAuto     = a.words.filter((w) => !w.isAyahMarker).map((w) => w.dataTxt).filter(Boolean).join(" ");
      const searchDataAuto   = a.words.filter((w) => !w.isAyahMarker).map((w) => w.searchTxtAuto).filter(Boolean).join(" ");
      // Use per-surah ayahNum (standard numbering) as the match key
      // This matches the (1),(2)... numbers in clean text input
      const overrideKey      = `${seg.surahNumber}:${a.ayahNum}`;
      const searchDataManual = searchOverrides[overrideKey] ?? "";
      const copyDataManual   = (copyOverrides ?? {})[overrideKey] ?? "";
      const ayahKey  = `ayah_${seg.surahNumber}_${a.aid}`;
      const ayahAnns = Object.values(entryAnnotations).filter((ann) => ann.targetKey === ayahKey);
      const tafsirStr = ayahAnns.filter((a) => a.type === "tafsir").length > 0
        ? `,\n      tafsir: ${JSON.stringify(ayahAnns.filter((a) => a.type === "tafsir").map((a) => ({ title: a.title, body: a.body, source: a.source })))}`
        : "";
      const riwayaStr = ayahAnns.filter((a) => a.type === "riwaya").length > 0
        ? `,\n      riwaya: ${JSON.stringify(ayahAnns.filter((a) => a.type === "riwaya").map((a) => ({ title: a.title, body: a.body, source: a.source })))}`
        : "";
      return [
        `    {`,
        `      ayahId: ${a.aid}, ayahNum: ${a.ayahNum}, surahNumber: ${seg.surahNumber}, pageNumber: ${pageNumber},`,
        `      isComplete: ${a.isComplete}, continuesFromPrev: ${a.continuesFromPrev},`,
        `      textData: ${JSON.stringify(textDataAuto)},`,
        `      searchDataAuto: ${JSON.stringify(searchDataAuto)},`,
        `      searchDataManual: ${JSON.stringify(searchDataManual)},`,
        `      copyData: ${JSON.stringify(copyDataManual)}${tafsirStr}${riwayaStr},`,
        `    }`,
      ].join("\n");
    }).join(",\n");
    const surahKey   = `surah_${seg.surahNumber}`;
    const surahAnns  = Object.values(entryAnnotations).filter((ann) => ann.targetKey === surahKey);
    const surahAnnStr = surahAnns.length > 0
      ? `, surahAnnotations: ${JSON.stringify(surahAnns.map((a) => ({ type: a.type, title: a.title, body: a.body, source: a.source })))}`
      : "";
    return `  {\n    surahNumber: ${seg.surahNumber}, surahTitle: ${JSON.stringify(seg.surahTitle)}${surahAnnStr},\n    ayahs: [\n${ayahsCode}\n    ]\n  }`;
  }).join(",\n");

  const hizbCode = hizbMarks.map((h) =>
    `  { label: ${JSON.stringify(h.label)}, symbol: ${JSON.stringify(h.symbol)}, fraction: ${h.fraction}, hizbIndex: ${h.hizbIndex}, hizbFraction: ${h.hizbFraction}, positionId: ${JSON.stringify(h.positionId)} }`
  ).join(",\n");

  return `// AUTO-GENERATED — Page ${pageNumber} | Surah ${surahNumbers.join(", ")}
// hizbAtStart: ${hizbAtStart.toFixed(3)} | hizbAtEnd: ${hizbMarks.length > 0 ? hizbMarks[hizbMarks.length-1].hizbFraction.toFixed(3) : hizbAtStart.toFixed(3)}
// lineGap: ${lineGap}px
// Compressed with SVGO

import React from "react";

export const PAGE_NUMBER    = ${pageNumber};
export const SURAH_NUMBERS  = [${surahNumbers.join(", ")}];
export const HIZB_AT_START  = ${hizbAtStart};
export const LINE_GAP_PX    = ${lineGap};

export interface WordData {
  id: string;
  dataTxt: string;
  searchTxtAuto: string;
  searchTxtManual: string;
  ayahId: number | null;
  surahNumber: number;
  isAyahMarker?: boolean;
  ayahNumber?: number | null;
  hizbMark?: { label: string; symbol: string; fraction: number; hizbIndex: number; hizbFraction: number; positionId: string } | null;
  tafsir?: { title: string; body: string; source: string }[];
  riwaya?: { title: string; body: string; source: string }[];
  svg: string;
}

export interface AyahData {
  ayahId: number;
  surahNumber: number;
  pageNumber: number;
  isComplete: boolean;
  continuesFromPrev: boolean;
  textData: string;          // as-is from source (display)
  searchDataAuto: string;    // auto-normalized for search
  searchDataManual: string;  // user override for search
  copyData: string;          // clean copy text (from Quran source, for clipboard/docx/pdf)
  tafsir?: { title: string; body: string; source: string }[];
  riwaya?: { title: string; body: string; source: string }[];
}

export interface SegmentData { surahNumber: number; surahTitle: string | null; ayahs: AyahData[]; surahAnnotations?: any[] }
export interface LineData    { lineIndex: number; pageNumber: number; words: WordData[] }
export interface HizbData    { label: string; symbol: string; fraction: number; hizbIndex: number; hizbFraction: number; positionId: string }

export const lines: LineData[] = [
${linesCode}
];

export const segments: SegmentData[] = [
${segmentsCode}
];

// Hizb / partition marks on this page
export const hizbMarks: HizbData[] = [
${hizbCode}
];

function Word({ id, dataTxt, isAyahMarker, ayahNumber, hizbMark, tafsir, riwaya, svg }: WordData) {
  return (
    <div
      id={id}
      className={[
        "qword",
        isAyahMarker ? "qword--ayah-marker" : "",
        hizbMark ? \`qword--hizb-\${hizbMark.label}\` : "",
        tafsir?.length ? "qword--has-tafsir" : "",
        riwaya?.length ? "qword--has-riwaya" : "",
      ].filter(Boolean).join(" ")}
      data-txt={dataTxt}
      data-ayah-number={ayahNumber ?? undefined}
      data-hizb-pos={hizbMark?.positionId}
      data-has-tafsir={tafsir?.length ? "true" : undefined}
      data-has-riwaya={riwaya?.length ? "true" : undefined}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

function Line({ lineIndex, pageNumber, words }: LineData) {
  return (
    <div className="qline" data-line={lineIndex} data-page={pageNumber}
      style={{ marginBottom: LINE_GAP_PX }}>
      {words.map((w) => <Word key={w.id} {...w} />)}
    </div>
  );
}

export function Page${pageNumber}() {
  return (
    <div className="qpage" id={\`page_${pageNumber}\`} data-page={${pageNumber}} data-hizb-start="${hizbAtStart}">
      {segments.map((seg) =>
        seg.surahTitle
          ? <div key={seg.surahNumber} className="qsurah-title" data-surah={seg.surahNumber}>{seg.surahTitle}</div>
          : null
      )}
      {lines.map((l) => <Line key={\`line-\${l.lineIndex}\`} {...l} />)}
    </div>
  );
}

export default Page${pageNumber};
`;
}

// ══════════════════════════════════════════════════════════════════════════════
// MUSHAF MANAGER GENERATOR
// ══════════════════════════════════════════════════════════════════════════════

function generateMushafManager(entries: HistoryEntry[], allOffsets: Record<string, OffsetMap>, globalLineGap: number): string {
  const sorted = [...entries].sort((a, b) => a.pageNumber - b.pageNumber);
  const imports = sorted.map((e) =>
    `import { lines as p${e.pageNumber}Lines, segments as p${e.pageNumber}Segs, hizbMarks as p${e.pageNumber}Hizb, HIZB_AT_START as h${e.pageNumber}, LINE_GAP_PX as g${e.pageNumber} } from "./pages/Page${e.pageNumber}";`
  ).join("\n");
  const pagesArray = sorted.map((e) =>
    `  { pageNumber: ${e.pageNumber}, surahNumbers: [${e.surahNumbers.join(", ")}], label: ${JSON.stringify(e.label)}, lines: p${e.pageNumber}Lines, segments: p${e.pageNumber}Segs, hizbMarks: p${e.pageNumber}Hizb, hizbAtStart: h${e.pageNumber}, lineGap: g${e.pageNumber} }`
  ).join(",\n");
  const offsetsObj = sorted.map((e) => {
    const om = allOffsets[e.id] ?? {};
    const f  = Object.fromEntries(Object.entries(om).filter(([, v]) => v.x !== 0 || v.y !== 0));
    return `  ${e.pageNumber}: ${JSON.stringify(f)}`;
  }).join(",\n");

  return `// AUTO-GENERATED — MushafManager
// Pages: ${sorted.map((e) => e.pageNumber).join(", ")}
// Global lineGap: ${globalLineGap}px

import React, { useState, useEffect } from "react";
${imports}

export interface MushafPage {
  pageNumber: number; surahNumbers: number[]; label: string;
  lines: any[]; segments: any[]; hizbMarks: any[];
  hizbAtStart: number; lineGap: number;
}

export const MUSHAF_PAGES: MushafPage[] = [
${pagesArray}
];

const WORD_OFFSETS: Record<number, Record<string, { x: number; y: number }>> = {
${offsetsObj}
};

export function MushafManager() {
  const [idx, setIdx] = useState(0);
  const page = MUSHAF_PAGES[idx];

  useEffect(() => {
    if (!page) return;
    const offsets = WORD_OFFSETS[page.pageNumber] ?? {};
    for (const line of page.lines) {
      for (const w of line.words) {
        const el = document.getElementById(w.id);
        if (!el) continue;
        if (offsets[w.id]) {
          const { x, y } = offsets[w.id];
          const vb = el.querySelector("svg")?.getAttribute("viewBox");
          let vbW = 1000; let vbH = 2300;
          if (vb) { const p = vb.trim().split(/[\\s,]+/).map(Number); if (p.length >= 4) { vbW = Math.abs(p[2]); vbH = Math.abs(p[3]); } }
          el.style.position = "relative";
          el.style.transform = \`translate(\${(x/vbW*100).toFixed(4)}%, \${(y/vbH*100).toFixed(4)}%)\`;
        } else { el.style.position = ""; el.style.transform = ""; }
      }
    }
  }, [idx]);

  if (!page) return <div>No pages.</div>;
  const go = (i: number) => setIdx(Math.max(0, Math.min(MUSHAF_PAGES.length - 1, i)));

  return (
    <div className="mushaf-manager">
      <nav className="mushaf-nav">
        <button onClick={() => go(idx - 1)} disabled={idx === 0}>◀</button>
        <span>P{page.pageNumber} | Surah {page.surahNumbers.join(",")} | Hizb {page.hizbAtStart.toFixed(2)}</span>
        <button onClick={() => go(idx + 1)} disabled={idx === MUSHAF_PAGES.length - 1}>▶</button>
      </nav>
      {page.hizbMarks.length > 0 && (
        <div className="mushaf-hizb-bar">
          {page.hizbMarks.map((h: any, i: number) => (
            <span key={i} title={\`\${h.positionId}\`}>{h.symbol} {h.label}</span>
          ))}
        </div>
      )}
      <div className="mushaf-page" data-page={page.pageNumber}>
        {page.segments.map((seg: any) =>
          seg.surahTitle ? <div key={seg.surahNumber} className="qsurah-title">{seg.surahTitle}</div> : null
        )}
        {page.lines.map((line: any) => (
          <div key={line.lineIndex} className="qline" style={{ marginBottom: page.lineGap }}>
            {line.words.map((w: any) => (
              <div key={w.id} id={w.id}
                className={["qword", w.isAyahMarker ? "qword--ayah-marker" : "", w.tafsir?.length ? "qword--has-tafsir" : "", w.riwaya?.length ? "qword--has-riwaya" : ""].filter(Boolean).join(" ")}
                data-txt={w.dataTxt} data-hizb-pos={w.hizbMark?.positionId}
                dangerouslySetInnerHTML={{ __html: w.svg }}
              />
            ))}
          </div>
        ))}
      </div>
      <div className="mushaf-jump">
        {MUSHAF_PAGES.map((p, i) => (
          <button key={p.pageNumber} onClick={() => setIdx(i)} className={i === idx ? "active" : ""}>{p.pageNumber}</button>
        ))}
      </div>
    </div>
  );
}
export default MushafManager;
`;
}

// ══════════════════════════════════════════════════════════════════════════════
// CSS GENERATOR
// ══════════════════════════════════════════════════════════════════════════════

interface WordMeta {
  wordId: string; dataTxt: string; svg: string;
  vbW: number; vbH: number; displayW: number;
  surahNumber: number; aid: number | null;
  isAyahMarker: boolean; hizbMark: HizbMark | null;
}

function buildWordMetas(parsed: ParsedPage, displayH: number) {
  const allWords = parsed.lines.flatMap((l) => l.words).filter((w) => w.svgCompressed || w.svgRaw);
  const metas: WordMeta[] = allWords.map((w) => {
    const svg = w.svgCompressed || w.svgRaw;
    const vbMatch = svg.match(/viewBox="([^"]+)"/);
    let vbW = 100; let vbH = 2300;
    if (vbMatch) {
      const parts = vbMatch[1].trim().split(/[\s,]+/).map(Number);
      if (parts.length >= 4) { vbW = Math.abs(parts[2]); vbH = Math.abs(parts[3]); }
    }
    const uid = w.wid !== null ? `word_${w.wid}_page_${parsed.pageNumber}` : `word_unk`;
    return { wordId: uid, dataTxt: w.dataTxt, svg, vbW, vbH, displayW: Math.max(4, Math.round(displayH * (vbW / vbH))), surahNumber: w.surahNumber, aid: w.aid, isAyahMarker: w.isAyahMarker, hizbMark: w.hizbMark };
  });
  const lineGroups: WordMeta[][] = [];
  let idx2 = 0;
  for (const line of parsed.lines) {
    const count = line.words.filter((w) => w.svgCompressed || w.svgRaw).length;
    lineGroups.push(metas.slice(idx2, idx2 + count));
    idx2 += count;
  }
  return { metas, lineGroups };
}

function generateOffsetCss(offsets: OffsetMap, pageNumber: number, surahNumbers: number[], lineGroups: WordMeta[][], lineGap: number): string {
  const entries = Object.entries(offsets).filter(([, o]) => o.x !== 0 || o.y !== 0);
  const wm = new Map<string, { vbW: number; vbH: number }>();
  for (const g of lineGroups) for (const m of g) wm.set(m.wordId, { vbW: m.vbW, vbH: m.vbH });

  const header = `/* Page ${pageNumber} | Surah ${surahNumbers.join(",")} | lineGap: ${lineGap}px */\n\n.qpage[data-page="${pageNumber}"] .qword { position: relative; }\n.qpage[data-page="${pageNumber}"] .qline { margin-bottom: ${lineGap}px; }\n\n`;
  if (entries.length === 0) return header + `/* No word offsets */\n`;

  const rules = entries.map(([wid, offset]) => {
    const m = wm.get(wid);
    const xPct = m ? ((offset.x / m.vbW) * 100).toFixed(4) : "0";
    const yPct = m ? ((offset.y / m.vbH) * 100).toFixed(4) : "0";
    return `/* ${wid} Δx:${offset.x.toFixed(1)} Δy:${offset.y.toFixed(1)} */\n#${wid} { transform: translate(${xPct}%, ${yPct}%); }`;
  }).join("\n\n");
  return header + rules + "\n";
}

// ══════════════════════════════════════════════════════════════════════════════
// LOCAL STORAGE  — fixed: serialize carefully, never save mid-load
// ══════════════════════════════════════════════════════════════════════════════

function defaultState(): AppState {
  return { history: [], allOffsets: {}, allColors: {}, annotations: {}, lineGap: 4, hizbCursor: 0, lastPageNumber: 1, svgoFloatPrec: 3, svgoMultipass: true };
}

function loadAppState(): AppState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const p = JSON.parse(raw) as Partial<AppState>;
    const d = defaultState();
    return {
      history:        Array.isArray(p.history)     ? p.history        : d.history,
      allOffsets:     p.allOffsets  ?? d.allOffsets,
      allColors:      p.allColors   ?? d.allColors,
      annotations:    p.annotations ?? d.annotations,
      lineGap:        typeof p.lineGap === "number"     ? p.lineGap     : d.lineGap,
      hizbCursor:     typeof p.hizbCursor === "number"  ? p.hizbCursor  : d.hizbCursor,
      lastPageNumber: typeof p.lastPageNumber === "number" ? p.lastPageNumber : d.lastPageNumber,
      svgoFloatPrec:  typeof p.svgoFloatPrec === "number" ? p.svgoFloatPrec  : d.svgoFloatPrec,
      svgoMultipass:  typeof p.svgoMultipass === "boolean" ? p.svgoMultipass : d.svgoMultipass,
    };
  } catch { return defaultState(); }
}

// Debounced save — avoid hammering localStorage on rapid state changes
let _saveTimer: ReturnType<typeof setTimeout> | null = null;
function saveAppState(state: AppState) {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { console.warn("localStorage save failed:", e); }
  }, 300);
}

// ══════════════════════════════════════════════════════════════════════════════
// SVG COLOR INJECTION  (preview only)
// ══════════════════════════════════════════════════════════════════════════════

function injectSvgColor(svg: string, color: string): string {
  if (!color || !svg) return svg;
  const style = `<style>path,circle,ellipse,rect,polygon,polyline{fill:${color}!important}</style>`;
  return svg.replace(/(<svg[^>]*>)/, `$1${style}`);
}

// ══════════════════════════════════════════════════════════════════════════════
// BATCH IMPORT HELPER
// ══════════════════════════════════════════════════════════════════════════════

function guessPageNumber(filename: string): number {
  // Match: page_2, page2, p2, 002, page_002, etc.
  const m = filename.match(/(?:page[_\-\s]?)?(\d+)/i);
  return m ? parseInt(m[1]) : 0;
}

// ══════════════════════════════════════════════════════════════════════════════
// PROCESS ONE PAGE  (reusable for batch and single)
// ══════════════════════════════════════════════════════════════════════════════

async function processOnePage(
  html: string,
  pageNumber: number,
  surahNumbers: number[],
  hizbCursor: number,
  fp: number,
  mp: boolean,
  onProgress?: (done: number, total: number) => void,
): Promise<{ entry: Omit<HistoryEntry, "searchOverrides">; hizbCursorOut: number }> {
  const tick = () => new Promise<void>((r) => setTimeout(r, 0));

  const { result: base, hizbCursorOut } = parseQuranHtml(html, pageNumber, surahNumbers, hizbCursor);
  const allWords = base.lines.flatMap((l) => l.words).filter((w) => w.svgRaw);

  const cache = new Map<string, string>();
  let origBytes = 0; let compBytes = 0; let done = 0;

  for (let i = 0; i < allWords.length; i += 5) {
    const batch = allWords.slice(i, i + 5);
    for (const word of batch) {
      origBytes += new Blob([word.svgRaw]).size;
      if (cache.has(word.svgRaw)) { word.svgCompressed = cache.get(word.svgRaw)!; }
      else { word.svgCompressed = compressWithSvgo(word.svgRaw, fp, mp); cache.set(word.svgRaw, word.svgCompressed); }
      compBytes += new Blob([word.svgCompressed]).size;
      done++;
    }
    onProgress?.(done, allWords.length);
    await tick();
  }

  const parsed: ParsedPage = { ...base, originalBytes: origBytes, compressedBytes: compBytes };
  const tsx = generateTsx(parsed, {}, {}, {});
  const label = `Page ${pageNumber} — Surah ${surahNumbers.join(", ")}`;

  return {
    entry: { id: `p${pageNumber}_${Date.now()}`, pageNumber, surahNumbers, label, parsed, tsx, savedAt: Date.now() },
    hizbCursorOut,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// QURAN.COM API  — Tafsir fetcher
// ══════════════════════════════════════════════════════════════════════════════

// CORS proxy — wraps any URL so it can be fetched from localhost/dev
// Uses allorigins.win which mirrors the response with CORS headers
function corsProxy(url: string): string {
  return `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`;
}

async function fetchTafsirPage(surah: number, tafsirId: number, startAyah: number, endAyah: number): Promise<Record<number, string>> {
  // Quran.com v4: GET /tafsirs/{id}/ayahs?chapter_number={surah}
  // This endpoint returns all tafsir ayahs for a surah
  const directUrl = `${QURAN_API}/tafsirs/${tafsirId}?chapter_number=${surah}`;
  
  // Try direct first (works if deployed on quran.com-compatible origin)
  // Fall back to CORS proxy
  let data: any = null;
  
  // Try direct
  try {
    const r = await fetch(directUrl, { headers: { Accept: "application/json" } });
    if (r.ok) data = await r.json();
  } catch { /* fall through to proxy */ }
  
  // Try proxy
  if (!data) {
    const r = await fetch(corsProxy(directUrl));
    if (!r.ok) throw new Error(`Failed to fetch tafsir (${r.status})`);
    const text = await r.text();
    data = JSON.parse(text);
  }
  
  // Response shape: { tafsirs: [{ verse_key: "2:1", text: "..." }] }
  const tafsirs: Array<{ verse_key: string; text: string }> = data?.tafsirs ?? data?.data ?? [];
  const result: Record<number, string> = {};
  for (const item of tafsirs) {
    const parts = (item.verse_key ?? "").split(":");
    const ayahNum = parseInt(parts[1] ?? "0");
    if (!isNaN(ayahNum) && ayahNum >= startAyah && ayahNum <= endAyah) {
      result[ayahNum] = (item.text ?? "").replace(/<[^>]*>/g, "").trim();
    }
  }
  return result;
}

// EveryAyah.com audio URL builder — direct URL works fine in browser (no CORS issue for audio tags)
function warshAudioUrl(surah: number, ayah: number, reciter: string = DEFAULT_WARSH): string {
  const path = WARSH_RECITERS[reciter]?.path ?? WARSH_RECITERS[DEFAULT_WARSH].path;
  const s = String(surah).padStart(3, "0");
  const a = String(ayah).padStart(3, "0");
  return `https://everyayah.com/data/${path}/${s}${a}.mp3`;
}

// ══════════════════════════════════════════════════════════════════════════════
// TAFSIR & AUDIO PANEL
// ══════════════════════════════════════════════════════════════════════════════

function TafsirAudioPanel({
  activeEntry,
  onAnnotationSave,
  currentAnns,
  onCopyOverrideSave,
}: {
  activeEntry: HistoryEntry;
  onAnnotationSave: (a: Annotation) => void;
  currentAnns: Record<string, Annotation>;
  onCopyOverrideSave: (entryId: string, overrides: Record<string, string>) => void;
}) {
  const [tafsirSource, setTafsirSource] = useState(DEFAULT_TAFSIR);
  const [warshReciter, setWarshReciter] = useState(DEFAULT_WARSH);
  const [fetchedTafsirs, setFetchedTafsirs] = useState<Record<string, string>>({});
  const [loadingTafsir, setLoadingTafsir] = useState(false);
  const [tafsirError, setTafsirError] = useState<string | null>(null);
  const [playingKey, setPlayingKey] = useState<string | null>(null);
  const [copyEdits, setCopyEdits] = useState<Record<string, string>>(activeEntry.copyOverrides ?? {});

  // Sync when activeEntry changes
  useEffect(() => { setCopyEdits(activeEntry.copyOverrides ?? {}); }, [activeEntry.id]);

  // Build ayah list from active entry
  const ayahs = activeEntry.parsed.segments.flatMap((seg) =>
    seg.ayahs.map((a) => ({
      surahNumber: seg.surahNumber,
      aid: a.aid,
      ayahNum: a.ayahNum,   // per-surah standard number — used for copyData key
      textData: a.words.filter((w) => !w.isAyahMarker).map((w) => w.dataTxt).join(" ")
    }))
  );

  const fetchAllTafsir = async () => {
    setLoadingTafsir(true);
    setTafsirError(null);
    const tafsirId = TAFSIR_SOURCES[tafsirSource].id;
    try {
      const result: Record<string, string> = {};
      // Group by surah for efficient fetching
      const bySurah: Record<number, number[]> = {};
      for (const a of ayahs) { if (!bySurah[a.surahNumber]) bySurah[a.surahNumber] = []; bySurah[a.surahNumber].push(a.ayahNum); }
      for (const [surahStr, ayahNums] of Object.entries(bySurah)) {
        const surah = parseInt(surahStr);
        const aids = ayahNums;
        const min = Math.min(...aids); const max = Math.max(...aids);
        const fetched = await fetchTafsirPage(surah, tafsirId, min, max);
        for (const [ayahNum, text] of Object.entries(fetched)) {
          result[`${surah}:${ayahNum}`] = text;  // key = surah:ayahNum (per-surah standard)
        }
      }
      setFetchedTafsirs(result);
    } catch (e: any) { setTafsirError(e.message); }
    setLoadingTafsir(false);
  };

  const saveAllTafsirAsAnnotations = () => {
    const srcName = TAFSIR_SOURCES[tafsirSource].name;
    for (const [key, text] of Object.entries(fetchedTafsirs)) {
      if (!text) continue;
      const [surahStr, ayahStr] = key.split(":");
      const annId = `api_tafsir_${key}_${tafsirSource}_${Date.now()}`;
      onAnnotationSave({
        id: annId,
        type: "tafsir",
        targetType: "ayah",
        targetKey: `ayah_${surahStr}_${ayahStr}`, // ayahStr is already per-surah from API
        title: srcName,
        body: text,
        source: `Quran.com API — ${srcName}`,
      });
    }
  };

  const audioElRef = useRef<HTMLAudioElement | null>(null);

  const playAudio = (surah: number, ayah: number) => {
    const key = `${surah}:${ayah}`;
    // Stop previous
    if (audioElRef.current) {
      audioElRef.current.pause();
      audioElRef.current.currentTime = 0;
    }
    if (playingKey === key) { setPlayingKey(null); return; }
    
    const url = warshAudioUrl(surah, ayah, warshReciter);
    const audio = audioElRef.current ?? new Audio();
    audio.src = url;
    audio.onended = () => setPlayingKey(null);
    audio.onerror = () => {
      setTafsirError(`تعذّر تشغيل الصوت للآية ${surah}:${ayah} — قد يكون الملف غير موجود على everyayah.com لهذا القارئ`);
      setPlayingKey(null);
    };
    audioElRef.current = audio;
    
    audio.play()
      .then(() => { setPlayingKey(key); setTafsirError(null); })
      .catch((err) => {
        setTafsirError(`خطأ في تشغيل الصوت: ${err.message}`);
        setPlayingKey(null);
      });
  };

  // Parse a full-page clean text (with ayah numbers) for this single page
  const [singlePageText, setSinglePageText] = useState("");

  const applySinglePageText = () => {
    if (!singlePageText.trim()) return;

    // (N) is an END-marker: text BEFORE (1) = ayah 1, text between (1)&(2) = ayah 2
    const normalized = singlePageText
      .replace(/\r\n|\r|\n/g, " ").replace(/\s+/g, " ").trim();

    const parts = normalized.split(/\s*\((\d+)\)\s*/);
    // parts[0]=ayah1text, parts[1]="1", parts[2]=ayah2text, parts[3]="2", ...

    const segs = activeEntry.parsed.segments;
    let surahIdx = 0;
    let currentSurah = segs[surahIdx]?.surahNumber ?? 1;
    let lastMarkerNum = 0;
    const newEdits: Record<string, string> = {};

    for (let i = 0; i < parts.length; i += 2) {
      const ayahText  = parts[i].trim();
      const markerStr = parts[i + 1];
      const markerNum = markerStr !== undefined ? parseInt(markerStr) : null;

      // Surah change when number resets to 1 after higher
      if (markerNum === 1 && lastMarkerNum > 1) {
        surahIdx = Math.min(surahIdx + 1, segs.length - 1);
        currentSurah = segs[surahIdx]?.surahNumber ?? currentSurah;
      }

      if (markerNum !== null && ayahText) {
        const key = `${currentSurah}:${markerNum}`;
        newEdits[key] = newEdits[key] ? `${newEdits[key]} ${ayahText}` : ayahText;
      }

      if (markerNum !== null) lastMarkerNum = markerNum;
    }

    setCopyEdits((prev) => ({ ...prev, ...newEdits }));
    onCopyOverrideSave(activeEntry.id, newEdits);
    setSinglePageText("");
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
      {/* Single-page clean text paste */}
      <div style={{ background: "#0f1117", border: "1px solid #1e2332", borderRadius: 8, padding: "10px 12px" }}>
        <div style={{ fontSize: 10, color: "#c9a96e", fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 6 }}>
          📋 لصق نص copyData لهذه الصفحة
        </div>
        <div style={{ fontSize: 10, color: "#6b7280", marginBottom: 6, direction: "rtl", lineHeight: 1.6 }}>
          الصق النص النظيف لهذه الصفحة فقط مع أرقام الآيات بين قوسين (1) (2) ...<br />
          سيتم التقسيم والمطابقة تلقائياً مع كل آية.
        </div>
        <textarea
          style={{ ...S.input, width: "100%", height: 80, resize: "vertical", direction: "rtl", fontFamily: "serif", fontSize: 13, boxSizing: "border-box" as const }}
          value={singlePageText}
          onChange={(e) => setSinglePageText(e.target.value)}
          placeholder={"بِسۡمِ ٱللَّهِ... (1) ٱلۡحَمۡدُ لِلَّهِ... (2) ..."}
        />
        <button
          style={{ ...S.exportBtn, marginTop: 6 }}
          onClick={applySinglePageText}
          disabled={!singlePageText.trim()}
        >
          ✅ تطبيق ومطابقة الآيات
        </button>
      </div>

      {/* Controls */}
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", alignItems: "flex-end" }}>
        <div>
          <div style={{ fontSize: 10, color: "#6b7280", marginBottom: 4 }}>📖 Tafsir source</div>
          <select style={S.input} value={tafsirSource} onChange={(e) => setTafsirSource(e.target.value)}>
            {Object.entries(TAFSIR_SOURCES).map(([k, v]) => <option key={k} value={k}>{v.name}</option>)}
          </select>
        </div>
        <div>
          <div style={{ fontSize: 10, color: "#6b7280", marginBottom: 4 }}>🎧 Warsh reciter</div>
          <select style={S.input} value={warshReciter} onChange={(e) => setWarshReciter(e.target.value)}>
            {Object.entries(WARSH_RECITERS).map(([k, v]) => <option key={k} value={k}>{v.name}</option>)}
          </select>
        </div>
        <button style={{ ...S.exportBtn, alignSelf: "flex-end" }}
          onClick={fetchAllTafsir} disabled={loadingTafsir}>
          {loadingTafsir ? "⏳ Fetching..." : "⬇️ Fetch Tafsir (Quran.com)"}
        </button>
        {Object.keys(fetchedTafsirs).length > 0 && (
          <button style={{ ...S.exportBtn, alignSelf: "flex-end", background: "linear-gradient(135deg,#10b981,#059669)" }}
            onClick={saveAllTafsirAsAnnotations}>
            💾 Save all as annotations
          </button>
        )}
      </div>

      {tafsirError && (
        <div style={S.errBanner}>
          ❌ {tafsirError}
          <br />
          <span style={{ fontSize: 10, color: "#f8717199" }}>
            إذا كانت المشكلة في التفسير: يتم استخدام CORS proxy تلقائياً (allorigins.win).
            إذا استمرت المشكلة تأكد من اتصال الإنترنت.
          </span>
        </div>
      )}

      {/* Info note */}
      <div style={{ fontSize: 10, color: "#4b5563", lineHeight: 1.7, background: "#0f1117", border: "1px solid #1e2332", borderRadius: 6, padding: "8px 10px" }}>
        <b style={{ color: "#9ca3af" }}>📖 التفسير:</b> يُجلب من Quran.com API v4 عبر CORS proxy — يدعم:{" "}
        {Object.values(TAFSIR_SOURCES).map((v) => v.name).join(" · ")}
        <br />
        <b style={{ color: "#9ca3af" }}>🎧 الصوت (ورش):</b> مباشر من everyayah.com —{" "}
        {Object.values(WARSH_RECITERS).map((v) => v.name).join(" · ")}
      </div>

      {/* Per-ayah table */}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {ayahs.map((a) => {
          const key = `${a.surahNumber}:${a.ayahNum}`;  // per-surah standard number
          const tafsirText = fetchedTafsirs[`${a.surahNumber}:${a.ayahNum}`] ?? "";
          const isPlaying  = playingKey === key;
          // copyData key uses per-surah ayahNum to match the (N) markers in clean text
          const copyKey  = `${a.surahNumber}:${a.ayahNum}`;
          const copyText = copyEdits[copyKey] ?? activeEntry.copyOverrides?.[copyKey] ?? "";
          const existingAnns = Object.values(currentAnns).filter((ann) => ann.targetKey === `ayah_${a.surahNumber}_${a.ayahNum}`);

          return (
            <div key={key} style={{ background: "#0f1117", border: "1px solid #1e2332", borderRadius: 8, padding: "10px 12px" }}>
              {/* Header row */}
              <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 6 }}>
                <span style={{ ...S.historyPageBadge, fontSize: 12 }}>{a.surahNumber}:{a.ayahNum}</span>
                <div style={{ flex: 1, fontSize: 13, color: "#e8e6e0", fontFamily: "serif", direction: "rtl", lineHeight: 1.7 }}>
                  {a.textData.slice(0, 120)}{a.textData.length > 120 ? "…" : ""}
                </div>
                {/* Audio play button */}
                <button
                  style={{ ...S.actBtn, background: isPlaying ? "#c9a96e22" : "#1e2332", color: isPlaying ? "#c9a96e" : "#9ca3af", minWidth: 36 }}
                  onClick={() => playAudio(a.surahNumber, a.ayahNum)}
                  title={`Play ${WARSH_RECITERS[warshReciter].name}`}>
                  {isPlaying ? "⏸" : "▶"}
                </button>
              </div>

              {/* Copy text field */}
              <div style={{ marginBottom: tafsirText ? 8 : 0 }}>
                <div style={{ fontSize: 10, color: "#6b7280", marginBottom: 3 }}>
                  📋 copyData — نص النسخ النظيف (للحافظة / DOCX / PDF)
                </div>
                <textarea
                  style={{ ...S.input, width: "100%", height: 52, resize: "vertical", direction: "rtl", fontFamily: "serif", fontSize: 13, boxSizing: "border-box" as const }}
                  value={copyText}
                  onChange={(e) => setCopyEdits((prev) => ({ ...prev, [copyKey]: e.target.value }))}
                  placeholder="الصق نص الآية النظيف هنا (بدون رقم الآية)..."
                />
                {copyEdits[copyKey] !== undefined && copyEdits[copyKey] !== (activeEntry.copyOverrides?.[copyKey] ?? "") && (
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 3 }}>
                    <span style={{ fontSize: 9, color: "#c9a96e" }}>⚠️ Unsaved</span>
                    <button style={{ ...S.actBtn, fontSize: 9, padding: "1px 6px", color: "#c9a96e" }}
                      onClick={() => { onCopyOverrideSave(activeEntry.id, { [copyKey]: copyEdits[copyKey] }); }}>
                      💾 Save
                    </button>
                  </div>
                )}
              </div>

              {/* Tafsir text */}
              {tafsirText && (
                <div style={{ marginTop: 6, background: "#0a0c10", border: "1px solid #10b98130", borderRadius: 6, padding: "8px 10px" }}>
                  <div style={{ fontSize: 10, color: "#10b981", marginBottom: 4, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <span>{TAFSIR_SOURCES[tafsirSource]?.name}</span>
                    <span style={{ color: "#4b5563" }}>{tafsirText.length} حرف</span>
                  </div>
                  <div style={{ fontSize: 12, color: "#d1d5db", direction: "rtl", lineHeight: 2, fontFamily: "serif", maxHeight: 130, overflow: "auto" }}>
                    {tafsirText.slice(0, 400)}{tafsirText.length > 400 ? "…" : ""}
                  </div>
                </div>
              )}

              {/* Existing annotations */}
              {existingAnns.length > 0 && (
                <div style={{ marginTop: 6, display: "flex", gap: 4, flexWrap: "wrap" }}>
                  {existingAnns.map((ann) => (
                    <span key={ann.id} style={{ fontSize: 9, background: ann.type === "tafsir" ? "#10b98120" : "#a855f720", border: `1px solid ${ann.type === "tafsir" ? "#10b98140" : "#a855f740"}`, color: ann.type === "tafsir" ? "#10b981" : "#a855f7", borderRadius: 3, padding: "1px 5px" }}>
                      {ann.type === "tafsir" ? "📖" : "📜"} {ann.title}
                    </span>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>


    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// PREVIEWER COMPONENT
// ══════════════════════════════════════════════════════════════════════════════

function SvgChainPreviewer({
  parsed, selectedWordId, onSelectWord,
  offsets, onOffsetChange,
  colors, onColorChange,
  annotations, onAnnotationSave, onAnnotationDelete,
  lineGap, onLineGapChange,
}: {
  parsed: ParsedPage;
  selectedWordId: string | null;
  onSelectWord: (id: string | null) => void;
  offsets: OffsetMap;
  onOffsetChange: (wordId: string, delta: WordOffset) => void;
  colors: ColorMap;
  onColorChange: (wordId: string, color: string) => void;
  annotations: Record<string, Annotation>;
  onAnnotationSave: (a: Annotation) => void;
  onAnnotationDelete: (id: string) => void;
  lineGap: number;
  onLineGapChange: (v: number) => void;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [containerW, setContainerW] = useState(800);
  const [editMode, setEditMode]     = useState(false);
  const [editTool, setEditTool]     = useState<"offset" | "color" | "tafsir" | "riwaya">("offset");
  const [step, setStep]             = useState(10);
  const [showGrid, setShowGrid]     = useState(false);
  const [copiedCss, setCopiedCss]   = useState(false);
  const [svgColor, setSvgColor]     = useState("#ffffff");
  const [annTarget, setAnnTarget]   = useState<{ key: string; type: "word"|"ayah"|"surah"; label: string } | null>(null);
  const [annTitle, setAnnTitle]     = useState("");
  const [annBody, setAnnBody]       = useState("");
  const [annSource, setAnnSource]   = useState("");

  useEffect(() => {
    const obs = new ResizeObserver(([e]) => setContainerW(e.contentRect.width));
    if (containerRef.current) obs.observe(containerRef.current);
    return () => obs.disconnect();
  }, []);

  useEffect(() => {
    if (!editMode || editTool !== "offset" || !selectedWordId) return;
    const handler = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).tagName === "INPUT" || (e.target as HTMLElement).tagName === "TEXTAREA") return;
      const map: Record<string, WordOffset> = { ArrowLeft: { x: -step, y: 0 }, ArrowRight: { x: step, y: 0 }, ArrowUp: { x: 0, y: -step }, ArrowDown: { x: 0, y: step } };
      if (map[e.key]) { e.preventDefault(); onOffsetChange(selectedWordId, map[e.key]); }
      if (e.key === "Escape") onSelectWord(null);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [editMode, editTool, selectedWordId, step, onOffsetChange, onSelectWord]);

  const DISPLAY_H = Math.max(28, Math.round(containerW * 0.10));
  const { lineGroups } = buildWordMetas(parsed, DISPLAY_H);
  const cssText    = generateOffsetCss(offsets, parsed.pageNumber, parsed.surahNumbers, lineGroups, lineGap);
  const hasOffsets = Object.values(offsets).some((o) => o.x !== 0 || o.y !== 0);
  const selOffset  = selectedWordId ? (offsets[selectedWordId] ?? { x: 0, y: 0 }) : null;
  const selColor   = selectedWordId ? (colors[selectedWordId] ?? "") : "";

  const resetSel = () => { if (!selectedWordId) return; const cur = offsets[selectedWordId] ?? { x: 0, y: 0 }; onOffsetChange(selectedWordId, { x: -cur.x, y: -cur.y }); };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>

      {/* Toolbar */}
      <div style={{ display: "flex", gap: 6, alignItems: "center", flexWrap: "wrap" }}>
        <button style={{ ...SP.btn, ...(editMode ? SP.btnOn : {}) }}
          onClick={() => { setEditMode(!editMode); if (editMode) onSelectWord(null); }}>
          {editMode ? "✏️ Edit ON" : "✏️ Edit"}
        </button>

        {editMode && (
          <>
            <div style={SP.toolGroup}>
              {(["offset","color","tafsir","riwaya"] as const).map((t) => (
                <button key={t} style={{ ...SP.btn, ...(editTool === t ? SP.btnOn : {}), borderRadius: 0, borderRight: "1px solid #2a2f3e" }}
                  onClick={() => setEditTool(t)}>
                  {t === "offset" ? "⬡ Offset" : t === "color" ? "🎨 Color" : t === "tafsir" ? "📖 تفسير" : "📜 رواية"}
                </button>
              ))}
            </div>

            {editTool === "offset" && (
              <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <span style={SP.dim}>Step:</span>
                {[1, 5, 10, 20, 50].map((s) => (
                  <button key={s} style={{ ...SP.smallBtn, ...(step === s ? SP.btnOn : {}) }} onClick={() => setStep(s)}>{s}</button>
                ))}
              </div>
            )}

            {editTool === "color" && (
              <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                <span style={SP.dim}>Fill:</span>
                <input type="color" value={svgColor}
                  onChange={(e) => { setSvgColor(e.target.value); if (selectedWordId) onColorChange(selectedWordId, e.target.value); }}
                  style={{ width: 30, height: 24, border: "none", padding: 0, cursor: "pointer", background: "none" }} />
                {["#ffffff","#f59e0b","#ef4444","#3b82f6","#10b981","#a855f7"].map((c) => (
                  <button key={c} style={{ width: 18, height: 18, background: c, border: `2px solid ${svgColor === c ? "#c9a96e" : "#2a2f3e"}`, borderRadius: 3, cursor: "pointer" }}
                    onClick={() => { setSvgColor(c); if (selectedWordId) onColorChange(selectedWordId, c); }} />
                ))}
                {Object.keys(colors).length > 0 && <button style={SP.btn} onClick={() => { for (const id of Object.keys(colors)) onColorChange(id, ""); }}>↺ All</button>}
              </div>
            )}

            <button style={{ ...SP.btn, ...(showGrid ? SP.btnOn : {}) }} onClick={() => setShowGrid(!showGrid)}>▦</button>

            {/* Line gap — allow negative */}
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span style={SP.dim}>Gap:</span>
              <input type="number" min={-30} max={50} value={lineGap}
                onChange={(e) => onLineGapChange(parseInt(e.target.value) || 0)}
                style={{ ...SP.numInput, width: 54 }} />
              <span style={SP.dim}>px</span>
            </div>
          </>
        )}

        <div style={{ flex: 1 }} />
        {hasOffsets && (
          <>
            <button style={SP.btn} onClick={() => { for (const [id, o] of Object.entries(offsets)) if (o.x !== 0 || o.y !== 0) onOffsetChange(id, { x: -o.x, y: -o.y }); }}>↺ Offsets</button>
            <button style={{ ...SP.btn, ...SP.btnGold }} onClick={() => { navigator.clipboard.writeText(cssText).then(() => { setCopiedCss(true); setTimeout(() => setCopiedCss(false), 2000); }); }}>
              {copiedCss ? "✅" : "📋 CSS"}
            </button>
            <button style={{ ...SP.btn, ...SP.btnGold }} onClick={() => dl(cssText, `page${parsed.pageNumber}_offsets.css`)}>💾 CSS</button>
          </>
        )}
      </div>

      {/* Canvas */}
      <div ref={containerRef} style={{ width: "100%", background: "#08090d", borderRadius: 8, padding: "10px 8px", border: "1px solid #1e2332", position: "relative", overflow: "visible" }}>
        {showGrid && (
          <div style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 0, backgroundImage: "linear-gradient(rgba(255,255,255,.02) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.02) 1px,transparent 1px)", backgroundSize: `${DISPLAY_H}px ${DISPLAY_H}px` }} />
        )}

        {lineGroups.map((group, li) => (
          <div key={li} style={{ display: "flex", flexDirection: "row-reverse", justifyContent: "center", alignItems: "flex-end", marginBottom: lineGap, height: DISPLAY_H, position: "relative", zIndex: 1 }}>
            {group.map((m, wi) => {
              const offset = offsets[m.wordId] ?? { x: 0, y: 0 };
              const wColor = colors[m.wordId] ?? "";
              const isSel  = m.wordId === selectedWordId;
              const hasOff = offset.x !== 0 || offset.y !== 0;
              const hasTafsir = Object.values(annotations).some((a) => a.type === "tafsir" && a.targetKey === m.wordId);
              const hasRiwaya = Object.values(annotations).some((a) => a.type === "riwaya" && a.targetKey === m.wordId);
              const ayahKey   = m.aid !== null ? `ayah_${m.surahNumber}_${m.aid}` : null;
              const hasTafsirAyah = ayahKey ? Object.values(annotations).some((a) => a.type === "tafsir" && a.targetKey === ayahKey) : false;

              const pxX = (offset.x / m.vbH) * DISPLAY_H;
              const pxY = (offset.y / m.vbH) * DISPLAY_H;
              const svgToRender = wColor ? injectSvgColor(m.svg, wColor) : m.svg;

              const outline = isSel ? "2px solid #c9a96e"
                : hasTafsir ? "2px solid #10b98188"
                : hasRiwaya ? "2px solid #a855f788"
                : hasTafsirAyah ? "1px dashed #3b82f660"
                : hasOff ? "1px dashed #3b82f640"
                : "none";

              return (
                <div key={wi}
                  title={`${m.dataTxt}${m.hizbMark ? ` [${m.hizbMark.positionId}]` : ""}${hasTafsir ? " 📖" : ""}${hasRiwaya ? " 📜" : ""}`}
                  onClick={() => {
                    const newSel = isSel ? null : m.wordId;
                    onSelectWord(newSel);
                    if (editTool === "color" && newSel) { onColorChange(newSel, svgColor); return; }
                    if ((editTool === "tafsir" || editTool === "riwaya") && newSel) {
                      setAnnTarget({ key: newSel, type: "word", label: m.dataTxt });
                      setAnnTitle(""); setAnnBody(""); setAnnSource("");
                    }
                  }}
                  style={{ width: m.displayW, height: DISPLAY_H, flexShrink: 0, cursor: editMode ? "pointer" : "default", position: "relative", zIndex: isSel ? 10 : 1, transform: `translate(${pxX}px,${pxY}px)`, outline, outlineOffset: -1, borderRadius: 2, background: isSel ? "#c9a96e10" : "transparent" }}>
                  {(hasTafsir || hasRiwaya) && (
                    <div style={{ position: "absolute", top: 1, right: 1, display: "flex", gap: 1, zIndex: 20, pointerEvents: "none" }}>
                      {hasTafsir && <div style={{ width: 4, height: 4, borderRadius: "50%", background: "#10b981" }} />}
                      {hasRiwaya && <div style={{ width: 4, height: 4, borderRadius: "50%", background: "#a855f7" }} />}
                    </div>
                  )}
                  {m.hizbMark && (
                    <div style={{ position: "absolute", bottom: 0, left: 0, fontSize: 7, color: "#c9a96e", background: "#c9a96e22", borderRadius: 2, padding: "0 2px", pointerEvents: "none", zIndex: 20 }}>
                      {m.hizbMark.symbol}
                    </div>
                  )}
                  <div dangerouslySetInnerHTML={{ __html: svgToRender }} style={{ width: "100%", height: "100%" }} />
                </div>
              );
            })}
          </div>
        ))}

        {parsed.hizbMarks.length > 0 && (
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap", marginTop: 6 }}>
            {parsed.hizbMarks.map((h, i) => (
              <div key={i} style={{ background: "#c9a96e22", border: "1px solid #c9a96e44", color: "#c9a96e", borderRadius: 4, padding: "2px 7px", fontSize: 10, fontWeight: 700 }}
                title={h.positionId}>{h.symbol} {h.label} <span style={{ opacity: 0.6, fontSize: 9 }}>({h.positionId})</span></div>
            ))}
          </div>
        )}
      </div>

      {/* Offset edit panel */}
      {editMode && editTool === "offset" && selectedWordId && selOffset && (
        <div style={SP.panel}>
          <div style={SP.panelHd}>
            <code style={{ color: "#7dd3fc", fontSize: 11 }}>{selectedWordId}</code>
            <button style={SP.btn} onClick={resetSel}>↺ Reset</button>
          </div>
          <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
            <div style={{ display: "flex", flexDirection: "column", gap: 4, alignItems: "center" }}>
              <span style={SP.dim}>Position (↑↓←→)</span>
              <div style={SP.arrowGrid}>
                <div /><button style={SP.arrowBtn} onClick={() => onOffsetChange(selectedWordId, { x: 0, y: -step })}>▲</button><div />
                <button style={SP.arrowBtn} onClick={() => onOffsetChange(selectedWordId, { x: -step, y: 0 })}>◀</button>
                <button style={{ ...SP.arrowBtn, color: "#4b5563" }} onClick={resetSel}>⊙</button>
                <button style={SP.arrowBtn} onClick={() => onOffsetChange(selectedWordId, { x: step, y: 0 })}>▶</button>
                <div /><button style={SP.arrowBtn} onClick={() => onOffsetChange(selectedWordId, { x: 0, y: step })}>▼</button><div />
              </div>
            </div>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              <span style={SP.dim}>Fine (vb units)</span>
              {(["x","y"] as const).map((ax) => (
                <div key={ax} style={{ display: "flex", gap: 5, alignItems: "center" }}>
                  <label style={{ ...SP.dim, width: 12 }}>{ax.toUpperCase()}</label>
                  <input type="number" style={SP.numInput} value={selOffset[ax]}
                    onChange={(e) => { const v = parseFloat(e.target.value) || 0; onOffsetChange(selectedWordId, ax === "x" ? { x: v - selOffset.x, y: 0 } : { x: 0, y: v - selOffset.y }); }} />
                </div>
              ))}
              <span style={{ ...SP.dim, fontSize: 9 }}>CSS: translate({((selOffset.x / 1000)*100).toFixed(3)}%, {((selOffset.y / 2300)*100).toFixed(3)}%)</span>
            </div>
          </div>
        </div>
      )}

      {/* Color edit panel */}
      {editMode && editTool === "color" && selectedWordId && (
        <div style={SP.panel}>
          <div style={SP.panelHd}>
            <code style={{ color: "#7dd3fc", fontSize: 11 }}>{selectedWordId}</code>
            {selColor && <button style={SP.btn} onClick={() => onColorChange(selectedWordId, "")}>↺ Clear</button>}
          </div>
          <div style={{ fontSize: 11, color: "#9ca3af" }}>
            SVG fill: {selColor ? <span style={{ background: selColor, color: "#000", borderRadius: 4, padding: "1px 8px" }}>{selColor}</span> : <span style={{ color: "#4b5563" }}>default</span>}
            <span style={{ color: "#4b5563", marginLeft: 8, fontSize: 10 }}>Preview only — not in TSX</span>
          </div>
        </div>
      )}

      {/* Tafsir/Riwaya panel */}
      {editMode && (editTool === "tafsir" || editTool === "riwaya") && (
        <div style={SP.panel}>
          <div style={SP.panelHd}>
            <span style={{ color: "#9ca3af", fontSize: 11 }}>{editTool === "tafsir" ? "📖 تفسير" : "📜 رواية"} — اختر هدفاً:</span>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
            {selectedWordId && (
              <button style={{ ...SP.btn, ...(annTarget?.type === "word" ? SP.btnOn : {}) }}
                onClick={() => setAnnTarget({ key: selectedWordId, type: "word", label: annTarget?.label ?? "كلمة" })}>
                🔤 كلمة
              </button>
            )}
            {parsed.segments.flatMap((seg) => seg.ayahs).slice(0, 20).map((a) => {
              const key = `ayah_${a.surahNumber}_${a.aid}`;
              return <button key={key} style={{ ...SP.btn, ...(annTarget?.key === key ? SP.btnOn : {}) }}
                onClick={() => setAnnTarget({ key, type: "ayah", label: `${a.surahNumber}:${a.ayahNum}` })}>
                {a.surahNumber}:{a.ayahNum}
              </button>;
            })}
            {parsed.segments.map((seg) => {
              const key = `surah_${seg.surahNumber}`;
              return <button key={key} style={{ ...SP.btn, ...(annTarget?.key === key ? SP.btnOn : {}) }}
                onClick={() => setAnnTarget({ key, type: "surah", label: `سورة ${seg.surahNumber}` })}>
                سورة {seg.surahNumber}
              </button>;
            })}
          </div>
          {annTarget && (
            <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
              <div style={{ fontSize: 11, color: "#c9a96e" }}>→ {annTarget.label} ({annTarget.type})</div>
              <div style={{ display: "flex", gap: 8 }}>
                <input style={{ ...SP.numInput, flex: 1 }} value={annTitle} onChange={(e) => setAnnTitle(e.target.value)} placeholder={editTool === "tafsir" ? "ابن كثير..." : "ورش عن نافع..."} />
                <input style={{ ...SP.numInput, flex: 1 }} value={annSource} onChange={(e) => setAnnSource(e.target.value)} placeholder="المرجع..." />
              </div>
              <textarea style={{ ...SP.numInput, height: 70, resize: "vertical", direction: "rtl" }}
                value={annBody} onChange={(e) => setAnnBody(e.target.value)} placeholder="النص هنا..." />
              <div style={{ display: "flex", gap: 6 }}>
                <button style={{ ...SP.btn, ...SP.btnGold }}
                  onClick={() => {
                    if (!annBody.trim()) return;
                    onAnnotationSave({ id: `ann_${annTarget.key}_${editTool}_${Date.now()}`, type: editTool as "tafsir"|"riwaya", targetType: annTarget.type, targetKey: annTarget.key, title: annTitle, body: annBody, source: annSource });
                    setAnnTitle(""); setAnnBody(""); setAnnSource("");
                  }}>💾 حفظ</button>
                <button style={SP.btn} onClick={() => { setAnnTitle(""); setAnnBody(""); setAnnSource(""); }}>✕</button>
              </div>
              {(() => {
                const ex = Object.values(annotations).filter((a) => a.targetKey === annTarget.key && a.type === editTool);
                return ex.length > 0 ? (
                  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
                    {ex.map((a) => (
                      <div key={a.id} style={{ background: "#0a0c10", border: "1px solid #1e2332", borderRadius: 6, padding: "6px 10px" }}>
                        <div style={{ display: "flex", justifyContent: "space-between" }}>
                          <span style={{ fontSize: 11, color: "#c9a96e" }}>{a.title}</span>
                          <button style={{ ...SP.btn, color: "#f87171", fontSize: 10 }} onClick={() => onAnnotationDelete(a.id)}>🗑️</button>
                        </div>
                        <div style={{ fontSize: 12, color: "#e8e6e0", direction: "rtl", lineHeight: 1.6 }}>{a.body}</div>
                      </div>
                    ))}
                  </div>
                ) : null;
              })()}
            </div>
          )}
        </div>
      )}

      {hasOffsets && <pre style={SP.cssPre}>{cssText}</pre>}
    </div>
  );
}

const SP: Record<string, React.CSSProperties> = {
  btn:      { padding: "4px 9px", background: "#1e2332", border: "1px solid #2a2f3e", borderRadius: 5, color: "#9ca3af", fontSize: 11, fontFamily: "inherit", cursor: "pointer" },
  btnOn:    { background: "#c9a96e22", border: "1px solid #c9a96e55", color: "#c9a96e" },
  btnGold:  { background: "#c9a96e22", color: "#c9a96e", border: "1px solid #c9a96e44" },
  toolGroup:{ display: "flex", border: "1px solid #2a2f3e", borderRadius: 5, overflow: "hidden" },
  smallBtn: { padding: "2px 6px", background: "#1e2332", border: "none", borderRight: "1px solid #2a2f3e", color: "#6b7280", fontSize: 11, fontFamily: "inherit", cursor: "pointer" },
  dim:      { fontSize: 10, color: "#6b7280" } as React.CSSProperties,
  panel:    { background: "#0f1117", border: "1px solid #1e2332", borderRadius: 8, padding: "12px 14px", display: "flex", flexDirection: "column", gap: 10 },
  panelHd:  { display: "flex", justifyContent: "space-between", alignItems: "center" },
  arrowGrid:{ display: "grid", gridTemplateColumns: "repeat(3,32px)", gridTemplateRows: "repeat(3,32px)", gap: 3 },
  arrowBtn: { background: "#1e2332", border: "1px solid #2a2f3e", borderRadius: 5, color: "#9ca3af", fontSize: 14, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" },
  numInput: { background: "#0a0c10", border: "1px solid #2a2f3e", borderRadius: 5, color: "#e8e6e0", padding: "4px 7px", fontSize: 12, fontFamily: "inherit", outline: "none", width: 80 } as React.CSSProperties,
  cssPre:   { background: "#0a0c10", border: "1px solid #1e2332", borderRadius: 7, padding: 10, fontSize: 10, lineHeight: 1.5, overflowX: "auto", maxHeight: 220, overflowY: "auto", color: "#9ca3af", margin: 0, whiteSpace: "pre" },
};

// ══════════════════════════════════════════════════════════════════════════════
// BATCH IMPORT VIEW
// ══════════════════════════════════════════════════════════════════════════════

function BatchImportView({
  onImportDone,
  hizbCursor,
  onHizbCursorUpdate,
  floatPrecision,
  multipass,
}: {
  onImportDone: (entries: HistoryEntry[], newHizbCursor: number) => void;
  hizbCursor: number;
  onHizbCursorUpdate: (v: number) => void;
  floatPrecision: number;
  multipass: boolean;
}) {
  const [items, setItems]         = useState<ImportItem[]>([]);
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress]   = useState({ current: 0, total: 0, svgDone: 0, svgTotal: 0 });
  const [quranText, setQuranText] = useState("");
  const [quranTextLabel, setQuranTextLabel] = useState("Quran text (for searchDataManual)");
  const fileRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);

  const addFiles = (files: FileList | null) => {
    if (!files) return;
    const newItems: ImportItem[] = [];
    for (const file of Array.from(files)) {
      if (!file.name.endsWith(".html") && !file.name.endsWith(".htm")) continue;
      const id = `import_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      const guessedPage = guessPageNumber(file.name);
      newItems.push({ id, file, filename: file.name, pageNumber: guessedPage || items.length + newItems.length + 1, surahInput: "", html: "", status: "pending" });
    }
    // Load HTML for each
    newItems.forEach((item) => {
      const reader = new FileReader();
      reader.onload = (e) => setItems((prev) => prev.map((p) => p.id === item.id ? { ...p, html: e.target?.result as string ?? "" } : p));
      reader.readAsText(item.file);
    });
    setItems((prev) => [...prev, ...newItems].sort((a, b) => a.pageNumber - b.pageNumber));
  };

  const updateItem = (id: string, patch: Partial<ImportItem>) => setItems((prev) => prev.map((it) => it.id === id ? { ...it, ...patch } : it));
  const removeItem = (id: string) => setItems((prev) => prev.filter((it) => it.id !== id));

  // When user edits surahInput for a row, propagate to all SUBSEQUENT rows that haven't been manually set
  // We track which rows were manually edited with a Set
  const [manualSurahIds, setManualSurahIds] = useState<Set<string>>(new Set());

  const updateSurahInput = (id: string, val: string) => {
    setManualSurahIds((prev) => new Set([...prev, id]));
    setItems((prev) => {
      const idx = prev.findIndex((it) => it.id === id);
      if (idx === -1) return prev;
      return prev.map((it, i) => {
        if (i === idx) return { ...it, surahInput: val };
        // Propagate forward only to rows not manually set
        if (i > idx && !manualSurahIds.has(it.id)) return { ...it, surahInput: val };
        return it;
      });
    });
  };

  // Drag-sort
  const handleDragStart = (id: string) => setDraggingId(id);
  const handleDragOver  = (e: React.DragEvent, id: string) => { e.preventDefault(); setDragOverId(id); };
  const handleDrop      = (targetId: string) => {
    if (!draggingId || draggingId === targetId) return;
    setItems((prev) => {
      const arr = [...prev];
      const fromIdx = arr.findIndex((it) => it.id === draggingId);
      const toIdx   = arr.findIndex((it) => it.id === targetId);
      const [moved] = arr.splice(fromIdx, 1);
      arr.splice(toIdx, 0, moved);
      return arr;
    });
    setDraggingId(null); setDragOverId(null);
  };

  // ── Parse clean Quran text into { "surah:ayah" → cleanText } map ─────────
  // Input format: text with ayah numbers in parentheses like (1) (2) etc.
  // Surah boundaries are detected by ayah number resetting to (1) after a
  // basmalah line OR after a number sequence resets.
  // We track current surah from the surahInput fields of the items in order.
  // ── Parse clean Quran text → { "surah:ayah" → cleanText } ────────────────
  //
  // FORMAT: (N) is an END-marker that comes AFTER the ayah text:
  //   "بِسۡمِ ٱللَّهِ... (1) ٱلۡحَمۡدُ لِلَّهِ... (2)"
  //   ayah 1 = text BEFORE marker (1)
  //   ayah 2 = text BETWEEN marker (1) and (2)
  //
  // SURAH CHANGE: when ayah number resets to 1 after being > 1.
  // NO BASMALAH prefix for new surahs (except surah 1).
  // CONTINUING AYAHS: text before the first marker on a page = end of
  //   previous ayah (no end-marker yet) — we skip storing it here
  //   since we don't know its ayah number. The per-ayah copy fields
  //   handle incomplete ayahs via the APIs tab.
  //
  const buildCopyMap = (
    rawText: string,
    orderedItems: ImportItem[],
  ): Record<string, string> => {
    if (!rawText.trim()) return {};

    const map: Record<string, string> = {};

    const normalized = rawText
      .replace(/\r\n|\r|\n/g, " ").replace(/\s+/g, " ").trim();

    // Split on (N) end-of-ayah markers — capture group keeps numbers
    // Result: [text_ayah1, "1", text_ayah2, "2", ..., possible_trailing_text]
    const parts = normalized.split(/\s*\((\d+)\)\s*/);

    // Build ordered surah sequence from import items
    const surahSequence: number[] = [];
    for (const item of orderedItems) {
      if (!item.surahInput) continue;
      const nums = item.surahInput.split(",")
        .map((s) => parseInt(s.trim()))
        .filter((n) => !isNaN(n) && n >= 1 && n <= 114);
      for (const n of nums) {
        if (!surahSequence.length || surahSequence[surahSequence.length - 1] !== n)
          surahSequence.push(n);
      }
    }
    let surahSeqIdx = 0;
    let currentSurah = surahSequence[0] ?? 1;
    let lastMarkerNum = 0;

    // parts[0] = text of ayah 1, parts[1] = "1", parts[2] = text of ayah 2 ...
    for (let i = 0; i < parts.length; i += 2) {
      const ayahText  = parts[i].trim();
      const markerStr = parts[i + 1];
      const markerNum = markerStr !== undefined ? parseInt(markerStr) : null;

      // Surah change: ayah number reset 1→ after non-1 number
      if (markerNum === 1 && lastMarkerNum > 1) {
        surahSeqIdx = Math.min(surahSeqIdx + 1, surahSequence.length - 1);
        currentSurah = surahSequence[surahSeqIdx];
      }

      // Only store if we have both text and a marker number
      // (last chunk with no marker = incomplete ayah continuing to next page — skip)
      if (markerNum !== null && ayahText) {
        const key = `${currentSurah}:${markerNum}`;
        map[key] = map[key] ? `${map[key]} ${ayahText}` : ayahText;
      }

      if (markerNum !== null) lastMarkerNum = markerNum;
    }

    return map;
  };

  const processAll = async () => {
    const ready = items.filter((it) => it.html && it.surahInput && it.pageNumber > 0);
    if (ready.length === 0) return;
    setIsProcessing(true);
    setProgress({ current: 0, total: ready.length, svgDone: 0, svgTotal: 0 });

    // Parse ALL the clean text ONCE into a global map: "surah:ayah" → cleanText
    // This is continuous across all pages — we look up each ayah by its key
    const globalCopyMap = buildCopyMap(quranText, ready);
    const totalMapped = Object.keys(globalCopyMap).length;

    const entries: HistoryEntry[] = [];
    let cursor = hizbCursor;

    for (let i = 0; i < ready.length; i++) {
      const it = ready[i];
      const surahNums = it.surahInput.split(",").map((s) => parseInt(s.trim())).filter((n) => !isNaN(n) && n >= 1 && n <= 114);
      if (surahNums.length === 0) { updateItem(it.id, { status: "error", error: "No valid surah numbers" }); continue; }
      updateItem(it.id, { status: "processing" });
      try {
        const { entry, hizbCursorOut } = await processOnePage(
          it.html, it.pageNumber, surahNums, cursor, floatPrecision, multipass,
          (done, total) => setProgress({ current: i, total: ready.length, svgDone: done, svgTotal: total }),
        );
        cursor = hizbCursorOut;

        // Look up copyData for each ayah on this page from the global map
        const copyOvr: Record<string, string> = {};
        if (Object.keys(globalCopyMap).length > 0) {
          for (const seg of entry.parsed.segments) {
            for (const a of seg.ayahs) {
              // Use ayahNum (per-surah standard number) to match clean text (N) markers
              const lookupKey = `${seg.surahNumber}:${a.ayahNum}`;
              // Store under the same key so generateTsx can find it
              if (globalCopyMap[lookupKey]) copyOvr[lookupKey] = globalCopyMap[lookupKey];
            }
          }
        }

        entries.push({ ...entry, searchOverrides: {}, copyOverrides: copyOvr });
        updateItem(it.id, { status: "done" });
      } catch (e: any) {
        updateItem(it.id, { status: "error", error: e.message });
      }
      setProgress((p) => ({ ...p, current: i + 1 }));
    }

    onHizbCursorUpdate(cursor);
    onImportDone(entries, cursor);
    setIsProcessing(false);
  };

  const statusColor: Record<ImportItem["status"], string> = {
    pending: "#6b7280", processing: "#c9a96e", done: "#4ade80", error: "#f87171"
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <button style={S.exportBtn} onClick={() => fileRef.current?.click()}>📄 Select Files</button>
        <button style={S.exportBtn} onClick={() => folderRef.current?.click()}>📁 Select Folder</button>
        <span style={{ fontSize: 11, color: "#6b7280" }}>{items.length} file(s) queued</span>
        <div style={{ flex: 1 }} />
        {items.length > 0 && !isProcessing && (
          <button style={{ ...S.btn, background: "linear-gradient(135deg,#c9a96e,#a07840)", color: "#0f1117", fontWeight: 700 }}
            onClick={processAll}>
            ⚡ Process All ({items.filter((it) => it.html && it.surahInput && it.pageNumber > 0).length})
          </button>
        )}
      </div>
      <input ref={fileRef} type="file" accept=".html,.htm" multiple style={{ display: "none" }}
        onChange={(e) => addFiles(e.target.files)} />
      <input ref={folderRef} type="file" accept=".html,.htm" multiple style={{ display: "none" }}
        // @ts-ignore
        webkitdirectory="" onChange={(e) => addFiles(e.target.files)} />

      {/* Progress */}
      {isProcessing && (
        <div style={{ background: "#0f1117", border: "1px solid #1e2332", borderRadius: 8, padding: "10px 14px" }}>
          <div style={{ fontSize: 12, color: "#c9a96e", marginBottom: 6 }}>Processing page {progress.current + 1} / {progress.total}... SVGs: {progress.svgDone}/{progress.svgTotal}</div>
          <div style={S.pTrack}><div style={{ ...S.pFill, width: `${progress.total ? (progress.current / progress.total) * 100 : 0}%` }} /></div>
        </div>
      )}

      {/* File list */}
      {items.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <div style={{ display: "grid", gridTemplateColumns: "24px 1fr 80px 140px 80px 32px", gap: 6, padding: "4px 8px", fontSize: 10, color: "#4b5563", textTransform: "uppercase" }}>
            <div /><div>File</div><div>Page #</div><div>Surah(s)</div><div>Status</div><div />
          </div>
          {items.map((it) => (
            <div key={it.id}
              draggable onDragStart={() => handleDragStart(it.id)} onDragOver={(e) => handleDragOver(e, it.id)} onDrop={() => handleDrop(it.id)}
              style={{ display: "grid", gridTemplateColumns: "24px 1fr 80px 140px 80px 32px", gap: 6, alignItems: "center", background: dragOverId === it.id ? "#c9a96e10" : "#0f1117", border: `1px solid ${dragOverId === it.id ? "#c9a96e44" : "#1e2332"}`, borderRadius: 7, padding: "6px 8px", cursor: "grab" }}>
              <div style={{ fontSize: 14, color: "#4b5563", textAlign: "center" }}>⠿</div>
              <div style={{ fontSize: 11, color: "#e8e6e0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={it.filename}>{it.filename}</div>
              <input type="number" min={1} value={it.pageNumber}
                onChange={(e) => updateItem(it.id, { pageNumber: parseInt(e.target.value) || 0 })}
                style={{ ...S.input, padding: "3px 6px", fontSize: 12, textAlign: "center" }} />
              <input type="text" value={it.surahInput} placeholder="e.g. 2 or 2,3"
                onChange={(e) => updateSurahInput(it.id, e.target.value)}
                style={{ ...S.input, padding: "3px 6px", fontSize: 12 }} />
              <div style={{ fontSize: 10, fontWeight: 700, color: statusColor[it.status] }}>
                {it.status === "error" ? `❌ ${it.error?.slice(0, 20)}` : it.status.toUpperCase()}
              </div>
              <button style={{ ...S.miniBtn, color: "#f87171" }} onClick={() => removeItem(it.id)}>✕</button>
            </div>
          ))}
        </div>
      )}

      {/* Quran clean copy text — feeds copyData per ayah by ayah-number matching */}
      <div style={S.card}>
        <div style={S.cardTitle}>📋 نص القرآن لحقل copyData</div>
        <div style={{ fontSize: 11, color: "#9ca3af", marginBottom: 8, lineHeight: 1.8, direction: "rtl" }}>
          الصق نص القرآن الكريم الكامل (أو حتى نهاية آخر صفحة مختارة).<br />
          <b style={{ color: "#e8e6e0" }}>التنسيق المطلوب:</b> النص مع أرقام الآيات بين قوسين مثل <code style={S.ic}>(1)</code> <code style={S.ic}>(2)</code> ...<br />
          المطابقة تتم <b>بالآية رقم</b> وليس بعدد الكلمات — النتيجة تُخزَّن في <code style={S.ic}>copyData</code> لكل آية.<br />
          <span style={{ color: "#c9a96e" }}>يستمر التعيين عبر جميع الصفحات تلقائياً — لا تعيد اللصق من البداية.</span>
        </div>
        <textarea style={{ ...S.textarea, height: 140, direction: "rtl", fontFamily: "serif", fontSize: 13 }}
          value={quranText} onChange={(e) => setQuranText(e.target.value)}
          placeholder={"بِسۡمِ ٱللَّهِ ٱلرَّحۡمَٰنِ ٱلرَّحِيمِ (1) ٱلۡحَمۡدُ لِلَّهِ رَبِّ ٱلۡعَٰلَمِينَ (2)..."} />
        {quranText.trim() && (() => {
          const count = (quranText.match(/\(\d+\)/g) ?? []).length;
          return (
            <div style={{ fontSize: 10, color: count > 0 ? "#4ade80" : "#f87171", marginTop: 4 }}>
              {count > 0
                ? `✅ تم اكتشاف ${count} رقم آية — سيتم المطابقة تلقائياً عند المعالجة`
                : "⚠️ لم يتم اكتشاف أرقام آيات — تأكد من وجود (1) (2) ... في النص"}
            </div>
          );
        })()}
      </div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// HISTORY PANEL
// ══════════════════════════════════════════════════════════════════════════════

function HistoryPanel({ history, selectedId, onSelect, onRemove, onRename, onExportManager }: {
  history: HistoryEntry[]; selectedId: string | null;
  onSelect: (e: HistoryEntry) => void; onRemove: (id: string) => void;
  onRename: (id: string, label: string) => void; onExportManager: () => void;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editVal,   setEditVal]   = useState("");
  const sorted = [...history].sort((a, b) => a.pageNumber - b.pageNumber);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={S.cardTitle}>📚 History ({history.length} pages)</div>
        <button style={S.exportBtn} onClick={onExportManager} disabled={history.length === 0}>📦 MushafManager.tsx</button>
      </div>
      {history.length === 0 && <div style={{ color: "#4b5563", textAlign: "center", padding: "30px 0", fontSize: 12 }}>No pages yet.</div>}
      {sorted.map((e) => (
        <div key={e.id} style={{ ...S.historyItem, ...(selectedId === e.id ? S.historyItemSel : {}) }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flex: 1, minWidth: 0 }}>
            <div style={S.historyPageBadge}>P{e.pageNumber}</div>
            <div style={{ flex: 1, minWidth: 0 }}>
              {editingId === e.id ? (
                <input style={{ ...S.input, padding: "2px 6px", fontSize: 12 }} value={editVal} autoFocus
                  onChange={(ev) => setEditVal(ev.target.value)}
                  onBlur={() => { onRename(e.id, editVal); setEditingId(null); }}
                  onKeyDown={(ev) => { if (ev.key === "Enter") { onRename(e.id, editVal); setEditingId(null); } if (ev.key === "Escape") setEditingId(null); }} />
              ) : (
                <div style={{ fontSize: 12, color: "#e8e6e0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", cursor: "text" }}
                  onDoubleClick={() => { setEditingId(e.id); setEditVal(e.label); }}>{e.label}</div>
              )}
              <div style={{ fontSize: 10, color: "#4b5563", marginTop: 2 }}>
                Surah {e.surahNumbers.join(",")} &middot; {e.parsed.lines.length} lines &middot; {kb(e.parsed.compressedBytes)} KB
                {e.parsed.hizbMarks.map((h, i) => <span key={i} style={{ color: "#c9a96e", marginLeft: 4 }}>{h.symbol}</span>)}
              </div>
            </div>
          </div>
          <div style={{ display: "flex", gap: 4 }}>
            <button style={S.miniBtn} onClick={() => onSelect(e)}>👁️</button>
            <button style={S.miniBtn} onClick={() => { setEditingId(e.id); setEditVal(e.label); }}>✏️</button>
            <button style={{ ...S.miniBtn, color: "#f87171" }} onClick={() => onRemove(e.id)}>🗑️</button>
          </div>
        </div>
      ))}
      {history.length > 0 && (
        <div style={{ marginTop: 6 }}>
          <div style={{ fontSize: 10, color: "#4b5563", marginBottom: 5, textTransform: "uppercase", letterSpacing: "0.05em" }}>Surah coverage</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 3 }}>
            {Array.from(new Set(history.flatMap((e) => e.surahNumbers))).sort((a, b) => a - b).map((sn) => (
              <span key={sn} style={{ background: "#c9a96e22", border: "1px solid #c9a96e44", color: "#c9a96e", borderRadius: 4, padding: "2px 6px", fontSize: 10 }}>{sn}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN APP
// ══════════════════════════════════════════════════════════════════════════════

export default function QuranProcessor() {
  // ── Persisted state loaded from localStorage ONCE
  const [ready,        setReady]        = useState(false);
  const [history,      setHistory]      = useState<HistoryEntry[]>([]);
  const [allOffsets,   setAllOffsets]   = useState<Record<string, OffsetMap>>({});
  const [allColors,    setAllColors]    = useState<Record<string, ColorMap>>({});
  const [annotations,  setAnnotations]  = useState<AnnotationStore>({});
  const [lineGap,      setLineGap]      = useState(4);
  const [hizbCursor,   setHizbCursor]   = useState(0);
  const [svgoFP,       setSvgoFP]       = useState(3);
  const [svgoMP,       setSvgoMP]       = useState(true);

  // Load once on mount
  useEffect(() => {
    const s = loadAppState();
    setHistory(s.history);
    setAllOffsets(s.allOffsets);
    setAllColors(s.allColors);
    setAnnotations(s.annotations);
    setLineGap(s.lineGap);
    setHizbCursor(s.hizbCursor);
    setSvgoFP(s.svgoFloatPrec);
    setSvgoMP(s.svgoMultipass);
    // Set page number after load
    setPageNumber(s.lastPageNumber || 1);
    setReady(true);
  }, []);

  // Save on every change — but only after initial load
  useEffect(() => {
    if (!ready) return;
    saveAppState({ history, allOffsets, allColors, annotations, lineGap, hizbCursor, lastPageNumber: pageNumber, svgoFloatPrec: svgoFP, svgoMultipass: svgoMP });
  });

  // ── Single-page processor state
  const [html,       setHtml]       = useState("");
  const [pageNumber, setPageNumber] = useState(1);
  const [surahInput, setSurahInput] = useState("1");
  const [step,       setStep]       = useState<Step>("idle");
  const [compProg,   setCompProg]   = useState({ done: 0, total: 0 });
  const [error,      setError]      = useState<string | null>(null);
  const [isDragging, setDrag]       = useState(false);
  const fileRef2 = useRef<HTMLInputElement>(null);

  // ── UI
  const [activeEntry,    setActiveEntry]    = useState<HistoryEntry | null>(null);
  const [outputTab,      setOutputTab]      = useState<"tsx" | "summary" | "preview" | "apis">("tsx");
  const [view,           setView]           = useState<MainView>("processor");
  const [selectedWordId, setSelectedWordId] = useState<string | null>(null);
  const [copied,         setCopied]         = useState(false);

  const currentOffsets: OffsetMap             = activeEntry ? (allOffsets[activeEntry.id] ?? {})    : {};
  const currentColors:  ColorMap              = activeEntry ? (allColors[activeEntry.id]  ?? {})    : {};
  const currentAnns:    Record<string,Annotation> = activeEntry ? (annotations[activeEntry.id] ?? {}) : {};

  const handleOffsetChange = useCallback((wordId: string, delta: WordOffset) => {
    if (!activeEntry) return;
    setAllOffsets((prev) => {
      const ex  = prev[activeEntry.id] ?? {};
      const cur = ex[wordId] ?? { x: 0, y: 0 };
      return { ...prev, [activeEntry.id]: { ...ex, [wordId]: { x: cur.x + delta.x, y: cur.y + delta.y } } };
    });
  }, [activeEntry]);

  const handleColorChange = useCallback((wordId: string, color: string) => {
    if (!activeEntry) return;
    setAllColors((prev) => {
      const ex = { ...(prev[activeEntry.id] ?? {}) };
      if (!color) delete ex[wordId]; else ex[wordId] = color;
      return { ...prev, [activeEntry.id]: ex };
    });
  }, [activeEntry]);

  const handleAnnSave = useCallback((a: Annotation) => {
    if (!activeEntry) return;
    setAnnotations((prev) => ({ ...prev, [activeEntry.id]: { ...(prev[activeEntry.id] ?? {}), [a.id]: a } }));
  }, [activeEntry]);

  const handleAnnDelete = useCallback((annId: string) => {
    if (!activeEntry) return;
    setAnnotations((prev) => { const ex = { ...(prev[activeEntry.id] ?? {}) }; delete ex[annId]; return { ...prev, [activeEntry.id]: ex }; });
  }, [activeEntry]);

  // Copy text overrides handler
  const handleCopyOverrideSave = useCallback((entryId: string, overrides: Record<string, string>) => {
    setHistory((prev) => prev.map((e) => e.id === entryId ? { ...e, copyOverrides: { ...(e.copyOverrides ?? {}), ...overrides } } : e));
    if (activeEntry?.id === entryId) {
      setActiveEntry((prev) => prev ? { ...prev, copyOverrides: { ...(prev.copyOverrides ?? {}), ...overrides } } : prev);
    }
  }, [activeEntry]);

  const looksEscaped = html.includes('\\"') || /\\n/.test(html);
  const surahNumbers = surahInput.split(",").map((s) => parseInt(s.trim())).filter((n) => !isNaN(n) && n >= 1 && n <= 114);

  const process = useCallback(async () => {
    if (!html.trim() || surahNumbers.length === 0) return;
    setError(null);
    try {
      setStep("parsing"); await tick();
      const { entry, hizbCursorOut } = await processOnePage(
        html, pageNumber, surahNumbers, hizbCursor, svgoFP, svgoMP,
        (done, total) => { setStep("compressing"); setCompProg({ done, total }); },
      );
      setHizbCursor(hizbCursorOut);
      const full: HistoryEntry = { ...entry, searchOverrides: {}, copyOverrides: {} };
      setHistory((prev) => { const i = prev.findIndex((e) => e.pageNumber === pageNumber); if (i !== -1) { const n = [...prev]; n[i] = full; return n; } return [...prev, full]; });
      setActiveEntry(full);
      setOutputTab("tsx");
      setStep("done");
      setPageNumber((p) => p + 1);
      setHtml("");
    } catch (e: any) { setError(e.message ?? "Error"); setStep("error"); }
  }, [html, pageNumber, surahNumbers, hizbCursor, svgoFP, svgoMP]);

  const handleBatchDone = (entries: HistoryEntry[], newCursor: number) => {
    setHizbCursor(newCursor);
    setHistory((prev) => {
      let next = [...prev];
      for (const e of entries) {
        const i = next.findIndex((x) => x.pageNumber === e.pageNumber);
        if (i !== -1) next[i] = e; else next.push(e);
      }
      return next.sort((a, b) => a.pageNumber - b.pageNumber);
    });
    if (entries.length > 0) { setActiveEntry(entries[entries.length - 1]); setView("history"); }
  };

  const copy = () => {
    if (!activeEntry) return;
    const tsx = generateTsx(activeEntry.parsed, activeEntry.searchOverrides, activeEntry.copyOverrides ?? {}, currentAnns, lineGap);
    navigator.clipboard.writeText(tsx).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); });
  };
  const download = () => {
    if (!activeEntry) return;
    dl(generateTsx(activeEntry.parsed, activeEntry.searchOverrides, activeEntry.copyOverrides ?? {}, currentAnns, lineGap), `page${activeEntry.pageNumber}.tsx`);
  };
  const exportManager = () => {
    if (history.length === 0) return;
    dl(generateMushafManager(history, allOffsets, lineGap), "MushafManager.tsx");
  };
  const removeEntry = (id: string) => { setHistory((prev) => prev.filter((e) => e.id !== id)); if (activeEntry?.id === id) setActiveEntry(null); };
  const renameEntry = (id: string, label: string) => {
    setHistory((prev) => prev.map((e) => e.id === id ? { ...e, label } : e));
    setActiveEntry((prev) => prev?.id === id ? { ...prev!, label } : prev);
  };
  const clearAll = () => {
    if (!confirm("Clear everything?")) return;
    const d = defaultState();
    setHistory([]); setAllOffsets({}); setAllColors({}); setAnnotations({});
    setLineGap(d.lineGap); setHizbCursor(0); setActiveEntry(null);
    localStorage.removeItem(STORAGE_KEY);
  };

  const isRunning  = step !== "idle" && step !== "done" && step !== "error";
  const canProcess = !!html.trim() && surahNumbers.length > 0 && !isRunning;
  const totalWords = activeEntry?.parsed.lines.reduce((s, l) => s + l.words.length, 0) ?? 0;
  const savings    = activeEntry ? Math.round((1 - activeEntry.parsed.compressedBytes / activeEntry.parsed.originalBytes) * 100) : 0;
  const hizbPct    = Math.min((hizbCursor / 60) * 100, 100);

  if (!ready) return <div style={{ minHeight: "100vh", background: "#0f1117", display: "flex", alignItems: "center", justifyContent: "center", color: "#c9a96e", fontSize: 18 }}>﷽ Loading...</div>;

  return (
    <div style={S.root}>
      {/* HEADER */}
      <header style={S.header}>
        <div style={S.hInner}>
          <div style={S.logo}>
            <span style={S.logoAr}>﷽</span>
            <div><div style={S.logoTitle}>Quran Processor</div><div style={S.logoSub}>Extract · Compress · Annotate · Export</div></div>
          </div>

          {/* Hizb bar */}
          <div style={{ flex: 1, maxWidth: 280, padding: "0 16px" }}>
            <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: "#6b7280", marginBottom: 3 }}>
              <span>Hizb</span><span style={{ color: "#c9a96e" }}>{hizbCursor.toFixed(2)} / 60</span>
            </div>
            <div style={{ height: 5, background: "#1e2332", borderRadius: 4, overflow: "hidden" }}>
              <div style={{ height: "100%", width: `${hizbPct}%`, background: "linear-gradient(90deg,#c9a96e,#a07840)", borderRadius: 4 }} />
            </div>
            <div style={{ fontSize: 9, color: "#4b5563", marginTop: 2 }}>{history.length} pages · {604 - history.length} left</div>
          </div>

          <nav style={S.nav}>
            {([["processor","⚙️ Process"],["import","📦 Import"],["history","📚 History"],["previewer","🔍 Preview"],["manager","📋 Manager"]] as [MainView,string][]).map(([v,l]) => (
              <button key={v} style={{ ...S.navBtn, ...(view === v ? S.navBtnOn : {}) }} onClick={() => setView(v)}>
                {l}{v === "history" && history.length > 0 ? <span style={S.navBadge}>{history.length}</span> : null}
              </button>
            ))}
          </nav>
        </div>
      </header>

      {/* PROCESSOR */}
      {view === "processor" && (
        <main style={S.main}>
          <aside style={S.left}>
            <section style={S.card}>
              <div style={S.cardTitle}>⚙️ Config</div>
              <Field label="Page Number"><input style={S.input} type="number" min={1} value={pageNumber} onChange={(e) => setPageNumber(parseInt(e.target.value) || 1)} /></Field>
              <Field label="Surah(s) — comma separated">
                <input style={S.input} value={surahInput} onChange={(e) => setSurahInput(e.target.value)} placeholder="1  or  2,3  or  18" />
                {surahNumbers.length > 1 && <div style={{ fontSize: 10, color: "#c9a96e", marginTop: 2 }}>Multi: {surahNumbers.join(" + ")}</div>}
              </Field>
            </section>

            <section style={S.card}>
              <div style={S.cardTitle}>🗜️ SVGO</div>
              <Field label={`Float Precision: ${svgoFP}`}>
                <input style={{ ...S.input, padding: "3px 0", cursor: "pointer" }} type="range" min={0} max={8} step={1} value={svgoFP} onChange={(e) => setSvgoFP(parseInt(e.target.value))} />
              </Field>
              <div style={S.row}>
                <span style={S.label}>Multipass</span>
                <button style={{ ...S.toggle, ...(svgoMP ? S.toggleOn : {}) }} onClick={() => setSvgoMP(!svgoMP)}>{svgoMP ? "ON" : "OFF"}</button>
              </div>
            </section>

            <section style={S.card}>
              <div style={S.cardTitle}>📿 Hizb</div>
              <div style={{ fontSize: 11, color: "#9ca3af" }}>Position: <span style={{ color: "#c9a96e" }}>{hizbCursor.toFixed(3)}</span></div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 3, marginTop: 6 }}>
                {[...history].sort((a, b) => a.pageNumber - b.pageNumber).flatMap((e) => e.parsed.hizbMarks).map((h, i) => (
                  <span key={i} style={{ background: "#c9a96e22", border: "1px solid #c9a96e33", color: "#c9a96e", borderRadius: 3, padding: "1px 5px", fontSize: 9 }} title={h.positionId}>{h.symbol} {h.positionId.split("_").slice(1).join("_")}</span>
                ))}
              </div>
              <button style={{ ...S.toggle, marginTop: 8, fontSize: 10 }} onClick={() => { if (confirm("Reset hizb to 0?")) setHizbCursor(0); }}>↺ Reset hizb</button>
            </section>

            {history.length > 0 && (
              <section style={S.card}>
                <div style={S.cardTitle}>🕐 Recent</div>
                {[...history].sort((a, b) => b.savedAt - a.savedAt).slice(0, 5).map((e) => (
                  <div key={e.id} style={{ ...S.recentItem, ...(activeEntry?.id === e.id ? S.recentItemOn : {}) }}
                    onClick={() => { setActiveEntry(e); setOutputTab("tsx"); }}>
                    <span style={S.historyPageBadge}>P{e.pageNumber}</span>
                    <span style={{ fontSize: 11, flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.label}</span>
                  </div>
                ))}
              </section>
            )}
            <button style={{ ...S.toggle, fontSize: 10, color: "#f87171", border: "1px solid #f8717130" }} onClick={clearAll}>🗑️ Clear all</button>
          </aside>

          <div style={S.right}>
            <section style={S.card}>
              <div style={S.cardTitle}>📥 Input</div>
              <div style={{ ...S.drop, ...(isDragging ? S.dropOn : {}) }}
                onDragOver={(e) => { e.preventDefault(); setDrag(true); }} onDragLeave={() => setDrag(false)}
                onDrop={(e) => { e.preventDefault(); setDrag(false); const f = e.dataTransfer.files[0]; if (f) { const r = new FileReader(); r.onload = (ev) => setHtml(ev.target?.result as string); r.readAsText(f); } }}
                onClick={() => fileRef2.current?.click()}>
                <input ref={fileRef2} type="file" accept=".html,.htm" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; if (f) { const r = new FileReader(); r.onload = (ev) => setHtml(ev.target?.result as string); r.readAsText(f); } }} />
                <div style={{ fontSize: 20 }}>📄</div><div style={{ fontSize: 11, color: "#6b7280", marginTop: 3 }}>Drop .html or click</div>
              </div>
              <div style={S.orDiv}>— or paste —</div>
              <textarea style={S.textarea} placeholder={"Paste Quran page HTML here..."} value={html} onChange={(e) => setHtml(e.target.value)} spellCheck={false} />
              {looksEscaped && <div style={S.infoBanner}>🔄 Escaped chars detected — auto-unescape on process.</div>}
              {error && <div style={S.errBanner}>❌ {error}</div>}
              {isRunning && (
                <div style={{ marginTop: 8 }}>
                  <div style={S.progressLabel}>{step === "compressing" ? `🗜️ SVGs: ${compProg.done}/${compProg.total}` : "⚙️ Parsing..."}</div>
                  {step === "compressing" && <div style={S.pTrack}><div style={{ ...S.pFill, width: `${compProg.total ? (compProg.done / compProg.total) * 100 : 0}%` }} /></div>}
                </div>
              )}
              <button style={{ ...S.btn, ...(!canProcess ? S.btnOff : {}) }} onClick={process} disabled={!canProcess}>
                {isRunning ? "Processing..." : "⚡ Process"}
              </button>
            </section>

            {activeEntry && (
              <section style={S.card}>
                <div style={S.stats}>
                  {([["Lines", activeEntry.parsed.lines.length], ["Words", totalWords], ["SVGs", totalWords], ["Ayahs", activeEntry.parsed.segments.reduce((s, sg) => s + sg.ayahs.length, 0)], ["Hizb✓", activeEntry.parsed.hizbMarks.length]] as [string,number][]).map(([l, v]) => (
                    <div key={l} style={S.stat}><span style={S.statN}>{v}</span><span style={S.statL}>{l}</span></div>
                  ))}
                </div>
                <div style={S.compressionBar}>
                  <span style={{ color: "#6b7280" }}>SVG: </span>
                  <span style={{ color: "#f87171" }}>{kb(activeEntry.parsed.originalBytes)} KB</span>
                  <span style={{ color: "#6b7280" }}> → </span>
                  <span style={{ color: "#4ade80" }}>{kb(activeEntry.parsed.compressedBytes)} KB</span>
                  <span style={{ color: "#c9a96e", marginLeft: 8, fontWeight: 700 }}>↓ {savings}%</span>
                </div>
                <div style={S.tabs}>
                  {(["tsx","summary","preview","apis"] as const).map((t) => (
                    <button key={t} style={{ ...S.tab, ...(outputTab === t ? S.tabOn : {}) }} onClick={() => setOutputTab(t)}>
                      {t === "tsx" ? "📄 TSX" : t === "summary" ? "📊 Summary" : t === "preview" ? "🔍 Preview" : "🌐 APIs"}
                    </button>
                  ))}
                  <div style={{ flex: 1 }} />
                  <button style={S.actBtn} onClick={copy}>{copied ? "✅" : "📋"}</button>
                  <button style={S.actBtn} onClick={download}>💾</button>
                </div>
                {outputTab === "tsx" && <pre style={S.pre}>{generateTsx(activeEntry.parsed, activeEntry.searchOverrides, activeEntry.copyOverrides ?? {}, currentAnns, lineGap)}</pre>}
                {outputTab === "summary" && (
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {activeEntry.parsed.hizbMarks.length > 0 && (
                      <div style={{ background: "#c9a96e10", border: "1px solid #c9a96e30", borderRadius: 6, padding: "8px 12px" }}>
                        <div style={{ fontSize: 11, color: "#c9a96e", fontWeight: 700, marginBottom: 4 }}>📿 Hizb marks</div>
                        {activeEntry.parsed.hizbMarks.map((h, i) => (
                          <div key={i} style={{ fontSize: 11, color: "#e8e6e0" }}>{h.symbol} {h.label} — <code style={S.ic}>{h.positionId}</code> (fraction {h.hizbFraction.toFixed(3)})</div>
                        ))}
                      </div>
                    )}
                    {activeEntry.parsed.segments.map((seg) => (
                      <div key={seg.surahNumber}>
                        <div style={S.secHd}>Surah {seg.surahNumber}{seg.surahTitle ? ` — ${seg.surahTitle}` : ""}</div>
                        {seg.ayahs.map((a) => (
                          <div key={a.aid} style={S.ayahRow}>
                            <div style={S.ayahId}>
                              {seg.surahNumber}:{a.ayahNum}
                              {!a.isComplete && <span style={S.tagOrange}>→ next page</span>}
                              {a.continuesFromPrev && <span style={S.tagPurple}>← prev page</span>}
                            </div>
                            <div style={{ fontSize: 13, fontFamily: "serif", direction: "rtl", lineHeight: 1.8, color: "#e8e6e0" }}>
                              {a.words.filter((w) => !w.isAyahMarker).map((w) => w.dataTxt).filter(Boolean).join(" ")}
                            </div>
                            <div style={{ fontSize: 10, color: "#4b5563", marginTop: 3, direction: "rtl" }}>
                              🔍auto: {a.words.filter((w) => !w.isAyahMarker).map((w) => w.searchTxtAuto).filter(Boolean).join(" ")}
                            </div>
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                )}
                {outputTab === "preview" && (
                  <SvgChainPreviewer
                    parsed={activeEntry.parsed} selectedWordId={selectedWordId} onSelectWord={setSelectedWordId}
                    offsets={currentOffsets} onOffsetChange={handleOffsetChange}
                    colors={currentColors} onColorChange={handleColorChange}
                    annotations={currentAnns} onAnnotationSave={handleAnnSave} onAnnotationDelete={handleAnnDelete}
                    lineGap={lineGap} onLineGapChange={setLineGap}
                  />
                )}
                {outputTab === "apis" && (
                  <TafsirAudioPanel
                    activeEntry={activeEntry}
                    onAnnotationSave={handleAnnSave}
                    currentAnns={currentAnns}
                    onCopyOverrideSave={handleCopyOverrideSave}
                  />
                )}
              </section>
            )}
          </div>
        </main>
      )}

      {/* BATCH IMPORT */}
      {view === "import" && (
        <main style={{ ...S.main, display: "block" }}>
          <section style={S.card}>
            <div style={S.cardTitle}>📦 Batch Import</div>
            <BatchImportView
              onImportDone={handleBatchDone}
              hizbCursor={hizbCursor}
              onHizbCursorUpdate={setHizbCursor}
              floatPrecision={svgoFP}
              multipass={svgoMP}
            />
          </section>
        </main>
      )}

      {/* HISTORY */}
      {view === "history" && (
        <main style={{ ...S.main, display: "block", maxWidth: 860 }}>
          <section style={S.card}>
            <HistoryPanel history={history} selectedId={activeEntry?.id ?? null}
              onSelect={(e) => { setActiveEntry(e); setView("processor"); setOutputTab("tsx"); }}
              onRemove={removeEntry} onRename={renameEntry} onExportManager={exportManager} />
          </section>
        </main>
      )}

      {/* PREVIEWER */}
      {view === "previewer" && (
        <main style={{ ...S.main, display: "block" }}>
          <section style={S.card}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
              <div style={S.cardTitle}>🔍 Previewer & Editor</div>
              {history.length > 1 && (
                <select style={{ ...S.input, width: "auto", minWidth: 220 }} value={activeEntry?.id ?? ""}
                  onChange={(e) => { const f = history.find((h) => h.id === e.target.value); if (f) setActiveEntry(f); }}>
                  {[...history].sort((a, b) => a.pageNumber - b.pageNumber).map((e) => <option key={e.id} value={e.id}>{e.label}</option>)}
                </select>
              )}
            </div>
            {!activeEntry ? <div style={{ color: "#4b5563", textAlign: "center", padding: "30px 0" }}>Process a page first.</div> : (
              <SvgChainPreviewer
                parsed={activeEntry.parsed} selectedWordId={selectedWordId} onSelectWord={setSelectedWordId}
                offsets={currentOffsets} onOffsetChange={handleOffsetChange}
                colors={currentColors} onColorChange={handleColorChange}
                annotations={currentAnns} onAnnotationSave={handleAnnSave} onAnnotationDelete={handleAnnDelete}
                lineGap={lineGap} onLineGapChange={setLineGap}
              />
            )}
          </section>
        </main>
      )}

      {/* MANAGER */}
      {view === "manager" && (
        <main style={{ ...S.main, display: "block", maxWidth: 1000 }}>
          <section style={S.card}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
              <div style={S.cardTitle}>📋 Manager</div>
              <div style={{ display: "flex", gap: 8 }}>
                {Object.values(allOffsets).some((om) => Object.values(om).some((o) => o.x !== 0 || o.y !== 0)) && (
                  <button style={S.exportBtn} onClick={() => {
                    const all = history.map((e) => { const { lineGroups } = buildWordMetas(e.parsed, 60); return generateOffsetCss(allOffsets[e.id] ?? {}, e.pageNumber, e.surahNumbers, lineGroups, lineGap); }).join("\n\n");
                    dl(all, "mushaf_offsets.css");
                  }}>💾 All CSS</button>
                )}
                <button style={S.exportBtn} onClick={exportManager} disabled={history.length === 0}>📦 MushafManager.tsx</button>
              </div>
            </div>
            {history.length === 0 ? <div style={{ color: "#4b5563", textAlign: "center", padding: "30px 0" }}>No pages yet.</div> : (
              <>
                <div style={{ display: "flex", flexDirection: "column", gap: 5, marginBottom: 14 }}>
                  {[...history].sort((a, b) => a.pageNumber - b.pageNumber).map((e) => {
                    const po = allOffsets[e.id] ?? {};
                    const oc = Object.values(po).filter((o) => o.x !== 0 || o.y !== 0).length;
                    const ac = Object.values(annotations[e.id] ?? {}).length;
                    const { lineGroups } = buildWordMetas(e.parsed, 60);
                    const css = generateOffsetCss(po, e.pageNumber, e.surahNumbers, lineGroups, lineGap);
                    return (
                      <div key={e.id} style={{ display: "flex", alignItems: "center", gap: 10, background: "#0f1117", border: "1px solid #1e2332", borderRadius: 8, padding: "8px 12px" }}>
                        <div style={{ ...S.historyPageBadge, fontSize: 13, minWidth: 34 }}>P{e.pageNumber}</div>
                        <div style={{ flex: 1 }}>
                          <div style={{ fontSize: 12, color: "#e8e6e0" }}>{e.label}</div>
                          <div style={{ fontSize: 10, color: "#4b5563", display: "flex", gap: 8, flexWrap: "wrap", marginTop: 2 }}>
                            <span>Surah {e.surahNumbers.join(",")}</span>
                            <span>{e.parsed.lines.length}L</span>
                            <span>{kb(e.parsed.compressedBytes)}KB</span>
                            {oc > 0 && <span style={{ color: "#c9a96e" }}>{oc} offsets</span>}
                            {ac > 0 && <span style={{ color: "#10b981" }}>{ac} ann.</span>}
                            {e.parsed.hizbMarks.map((h, i) => <span key={i} style={{ color: "#c9a96e" }}>{h.symbol}{h.positionId.split("_")[3] ?? ""}</span>)}
                          </div>
                        </div>
                        <div style={{ display: "flex", gap: 5 }}>
                          <button style={S.actBtn} onClick={() => { setActiveEntry(e); setView("previewer"); }}>🔍</button>
                          {oc > 0 && <button style={{ ...S.actBtn, color: "#c9a96e" }} onClick={() => dl(css, `page${e.pageNumber}_offsets.css`)}>CSS</button>}
                          <button style={S.actBtn} onClick={() => dl(generateTsx(e.parsed, e.searchOverrides, e.copyOverrides ?? {}, annotations[e.id] ?? {}, lineGap), `page${e.pageNumber}.tsx`)}>TSX</button>
                        </div>
                      </div>
                    );
                  })}
                </div>
                <pre style={{ ...S.pre, maxHeight: 320 }}>{generateMushafManager(history, allOffsets, lineGap)}</pre>
              </>
            )}
          </section>
        </main>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════════════════════

const tick = () => new Promise<void>((r) => setTimeout(r, 0));
const kb   = (b: number) => (b / 1024).toFixed(2);
const dl   = (text: string, name: string) => { const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([text], { type: "text/plain" })); a.download = name; a.click(); };
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 10 }}><label style={S.label}>{label}</label>{children}</div>;
}

// ══════════════════════════════════════════════════════════════════════════════
// STYLES
// ══════════════════════════════════════════════════════════════════════════════

const S: Record<string, React.CSSProperties> = {
  root:            { minHeight: "100vh", background: "#0f1117", color: "#e8e6e0", fontFamily: "'JetBrains Mono','Fira Code',monospace", fontSize: 13 },
  header:          { background: "linear-gradient(135deg,#1a1f2e,#12151f)", borderBottom: "1px solid #2a2f3e", padding: "11px 20px", position: "sticky", top: 0, zIndex: 100 },
  hInner:          { display: "flex", alignItems: "center", justifyContent: "space-between", maxWidth: 1400, margin: "0 auto", gap: 14 },
  logo:            { display: "flex", alignItems: "center", gap: 10, flexShrink: 0 },
  logoAr:          { fontSize: 24, fontFamily: "serif", color: "#c9a96e" },
  logoTitle:       { fontSize: 13, fontWeight: 700, color: "#f0ece4" },
  logoSub:         { fontSize: 9, color: "#6b7280", marginTop: 1 },
  nav:             { display: "flex", gap: 3, flexShrink: 0 },
  navBtn:          { padding: "5px 9px", background: "transparent", border: "1px solid #2a2f3e", borderRadius: 5, color: "#6b7280", fontSize: 11, fontFamily: "inherit", cursor: "pointer", display: "flex", alignItems: "center", gap: 4 },
  navBtnOn:        { background: "#c9a96e22", border: "1px solid #c9a96e55", color: "#c9a96e" },
  navBadge:        { background: "#c9a96e", color: "#0f1117", borderRadius: 10, padding: "0 5px", fontSize: 9, fontWeight: 700 },
  main:            { display: "flex", gap: 16, maxWidth: 1400, margin: "0 auto", padding: "16px 20px", alignItems: "flex-start" },
  left:            { width: 240, flexShrink: 0, display: "flex", flexDirection: "column", gap: 10 },
  right:           { flex: 1, display: "flex", flexDirection: "column", gap: 10, minWidth: 0 },
  card:            { background: "#151820", border: "1px solid #1e2332", borderRadius: 10, padding: 14 },
  cardTitle:       { fontSize: 10, fontWeight: 700, color: "#c9a96e", letterSpacing: "0.08em", marginBottom: 10, textTransform: "uppercase" },
  label:           { fontSize: 10, color: "#6b7280" },
  input:           { background: "#0f1117", border: "1px solid #2a2f3e", borderRadius: 5, color: "#e8e6e0", padding: "5px 9px", fontSize: 12, fontFamily: "inherit", outline: "none", width: "100%", boxSizing: "border-box" },
  row:             { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 },
  toggle:          { background: "#1e2332", border: "1px solid #2a2f3e", borderRadius: 4, color: "#6b7280", padding: "3px 12px", fontSize: 11, fontFamily: "inherit", cursor: "pointer" },
  toggleOn:        { background: "#c9a96e22", border: "1px solid #c9a96e55", color: "#c9a96e" },
  ic:              { background: "#0f1117", border: "1px solid #2a2f3e", borderRadius: 3, padding: "0 4px", color: "#7dd3fc", fontSize: 10 },
  drop:            { border: "2px dashed #2a2f3e", borderRadius: 7, padding: "12px", textAlign: "center", cursor: "pointer", marginBottom: 8, transition: "all .2s" },
  dropOn:          { borderColor: "#c9a96e", background: "#c9a96e08" },
  orDiv:           { textAlign: "center", color: "#3a3f4e", fontSize: 10, margin: "4px 0" },
  textarea:        { width: "100%", height: 110, background: "#0f1117", border: "1px solid #2a2f3e", borderRadius: 7, color: "#e8e6e0", padding: 9, fontSize: 11, fontFamily: "inherit", resize: "vertical", outline: "none", boxSizing: "border-box", lineHeight: 1.4 },
  infoBanner:      { background: "#3b82f610", border: "1px solid #3b82f630", borderRadius: 5, padding: "5px 9px", fontSize: 10, color: "#60a5fa", marginTop: 6 },
  errBanner:       { background: "#ef444410", border: "1px solid #ef444430", borderRadius: 5, padding: "5px 9px", fontSize: 10, color: "#f87171", marginTop: 6 },
  progressLabel:   { fontSize: 10, color: "#9ca3af", marginBottom: 3 },
  pTrack:          { height: 4, background: "#1e2332", borderRadius: 4, overflow: "hidden" },
  pFill:           { height: "100%", background: "#c9a96e", borderRadius: 4, transition: "width 0.1s" },
  btn:             { width: "100%", marginTop: 8, padding: 10, background: "linear-gradient(135deg,#c9a96e,#a07840)", border: "none", borderRadius: 7, color: "#0f1117", fontSize: 12, fontWeight: 700, fontFamily: "inherit", cursor: "pointer" },
  btnOff:          { opacity: 0.4, cursor: "not-allowed" },
  stats:           { display: "flex", marginBottom: 8, background: "#0f1117", borderRadius: 7, overflow: "hidden", border: "1px solid #1e2332" },
  stat:            { flex: 1, display: "flex", flexDirection: "column", alignItems: "center", padding: "6px 3px", borderRight: "1px solid #1e2332" },
  statN:           { fontSize: 14, fontWeight: 700, color: "#c9a96e" },
  statL:           { fontSize: 8, color: "#6b7280", marginTop: 1, textTransform: "uppercase" },
  compressionBar:  { background: "#0f1117", border: "1px solid #1e2332", borderRadius: 5, padding: "5px 10px", fontSize: 11, marginBottom: 8, display: "flex", gap: 3, alignItems: "center" },
  tabs:            { display: "flex", gap: 4, marginBottom: 8, alignItems: "center", borderBottom: "1px solid #1e2332", paddingBottom: 7 },
  tab:             { padding: "3px 9px", background: "transparent", border: "1px solid #2a2f3e", borderRadius: 5, color: "#6b7280", fontSize: 11, fontFamily: "inherit", cursor: "pointer" },
  tabOn:           { background: "#c9a96e22", border: "1px solid #c9a96e44", color: "#c9a96e" },
  actBtn:          { padding: "3px 9px", background: "#1e2332", border: "1px solid #2a2f3e", borderRadius: 5, color: "#9ca3af", fontSize: 11, fontFamily: "inherit", cursor: "pointer" },
  exportBtn:       { padding: "5px 12px", background: "linear-gradient(135deg,#c9a96e,#a07840)", border: "none", borderRadius: 5, color: "#0f1117", fontSize: 11, fontWeight: 700, fontFamily: "inherit", cursor: "pointer" },
  pre:             { background: "#0a0c10", border: "1px solid #1e2332", borderRadius: 7, padding: 12, fontSize: 10, lineHeight: 1.5, overflowX: "auto", maxHeight: 560, overflowY: "auto", color: "#9ca3af", margin: 0, whiteSpace: "pre" },
  secHd:           { fontSize: 10, fontWeight: 700, color: "#c9a96e", textTransform: "uppercase", letterSpacing: "0.06em", padding: "7px 0 3px", borderTop: "1px solid #1e2332", marginTop: 4 },
  ayahRow:         { background: "#0f1117", border: "1px solid #1e2332", borderRadius: 5, padding: "6px 10px", marginBottom: 4 },
  ayahId:          { fontSize: 11, color: "#c9a96e", fontWeight: 700, display: "flex", gap: 7, alignItems: "center", marginBottom: 3 },
  tagOrange:       { background: "#f9731622", border: "1px solid #f9731644", color: "#fb923c", borderRadius: 3, padding: "0 5px", fontSize: 9 },
  tagPurple:       { background: "#6366f122", border: "1px solid #6366f144", color: "#818cf8", borderRadius: 3, padding: "0 5px", fontSize: 9 },
  historyItem:     { display: "flex", alignItems: "center", gap: 8, background: "#0f1117", border: "1px solid #1e2332", borderRadius: 7, padding: "6px 9px" },
  historyItemSel:  { border: "1px solid #c9a96e55", background: "#c9a96e08" },
  historyPageBadge:{ background: "#c9a96e22", color: "#c9a96e", border: "1px solid #c9a96e44", borderRadius: 3, padding: "1px 6px", fontSize: 10, fontWeight: 700, flexShrink: 0 },
  miniBtn:         { padding: "2px 6px", background: "#1e2332", border: "1px solid #2a2f3e", borderRadius: 3, color: "#9ca3af", fontSize: 11, fontFamily: "inherit", cursor: "pointer" },
  recentItem:      { display: "flex", alignItems: "center", gap: 7, padding: "3px 5px", borderRadius: 5, cursor: "pointer", marginBottom: 2 },
  recentItemOn:    { background: "#c9a96e10" },
};