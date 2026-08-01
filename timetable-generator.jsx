import React, { useState, useEffect, useMemo, useCallback, useRef } from "react";
import {
  Clock, Calendar, BookOpen, FlaskConical, Users, SlidersHorizontal,
  Sparkles, RefreshCw, Download, Printer, Copy, FileJson, Save, FolderOpen,
  Plus, Trash2, Lock, Unlock, Check, AlertTriangle, BarChart3, Wand2,
  Undo2, Redo2, Loader2, ShieldCheck, ArrowDown, GraduationCap, Info,
  User, Timer, CalendarClock, ListChecks, Palette, Sunrise, MapPin,
  Sun, Moon,
} from "lucide-react";
import * as XLSX from "xlsx";

/* ============================================================================
   NOTE ON THIS PASS
   This is a UI/layout redesign only. Every piece of application logic below —
   state shape, the scheduling engine, validation math, export behaviour,
   history/lock handling — is unchanged from the previous version. Only the
   page structure (single scrolling page instead of a wizard) and the visual
   theme (light blue/green glassmorphism instead of dark purple) changed.
   Framer Motion isn't available in this runtime, so entrance/hover motion is
   done with plain CSS transitions and keyframes instead — same visual intent.
============================================================================ */

const ALL_DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const DAY_SHORT = { Monday: "Mon", Tuesday: "Tue", Wednesday: "Wed", Thursday: "Thu", Friday: "Fri", Saturday: "Sat" };

const SUBJECT_PALETTE = [
  "#2563EB", "#16A34A", "#0EA5E9", "#10B981", "#3B82F6",
  "#22C55E", "#0891B2", "#059669", "#1D4ED8", "#15803D",
];

const DEFAULT_ADVANCED = {
  noSameConsecutive: true,
  avoidFirst: false,
  avoidLast: false,
  distributeEvenly: true,
  preferMorningLabs: true,
  noEmptySlots: false,
};

function uid(prefix) {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}`;
}

/* ============================================================================
   TIME HELPERS (unchanged)
============================================================================ */
function timeToMinutes(t) {
  if (!t) return 0;
  const [h, m] = t.split(":").map(Number);
  return h * 60 + m;
}

/* ============================================================================
   SCHEDULING ENGINE (unchanged) — backtracking + randomization + CSP.
   Labs are placed first (need consecutive blocks), then theory subjects with
   a fairness pass, then a relaxation pass so subjects blocked only by the
   even-distribution rule still get placed.
============================================================================ */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function shuffle(arr, rand) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function generateTimetable(cfg, seed, lockedCells = {}) {
  const rand = mulberry32(seed);
  const { days, periodsPerDay, subjects, labs, faculty, advanced } = cfg;
  const P = periodsPerDay;
  const half = Math.ceil(P / 2);

  const grid = {};
  days.forEach((d) => { grid[d] = new Array(P + 1).fill(null); });

  Object.entries(lockedCells).forEach(([key, entry]) => {
    const [day, p] = key.split("|");
    if (grid[day]) grid[day][Number(p)] = entry;
  });

  const facultyMap = {};
  faculty.forEach((f) => { facultyMap[f.name] = f; });

  const facultyDailyCount = {};
  const facultyBusy = {};
  days.forEach((d) => {
    for (let p = 1; p <= P; p++) {
      const e = grid[d][p];
      if (e && e.faculty) {
        facultyDailyCount[e.faculty] = facultyDailyCount[e.faculty] || {};
        facultyDailyCount[e.faculty][d] = (facultyDailyCount[e.faculty][d] || 0) + 1;
        facultyBusy[e.faculty] = facultyBusy[e.faculty] || {};
        facultyBusy[e.faculty][`${d}|${p}`] = true;
      }
    }
  });

  const unplaced = [];

  function facultyOK(fname, day, period) {
    const f = facultyMap[fname];
    if (f) {
      if (f.unavailableDays && f.unavailableDays.includes(day)) return false;
      const maxDay = f.maxPerDay || 8;
      const used = (facultyDailyCount[fname] && facultyDailyCount[fname][day]) || 0;
      if (used >= maxDay) return false;
    }
    if (facultyBusy[fname] && facultyBusy[fname][`${day}|${period}`]) return false;
    return true;
  }
  function bookFaculty(fname, day, period) {
    facultyDailyCount[fname] = facultyDailyCount[fname] || {};
    facultyDailyCount[fname][day] = (facultyDailyCount[fname][day] || 0) + 1;
    facultyBusy[fname] = facultyBusy[fname] || {};
    facultyBusy[fname][`${day}|${period}`] = true;
  }
  function isEdgeBlocked(period) {
    if (advanced.avoidFirst && period === 1) return true;
    if (advanced.avoidLast && period === P) return true;
    return false;
  }

  // ---- 1. Labs (consecutive blocks) ----
  const labOrder = shuffle(labs, rand);
  labOrder.forEach((lab) => {
    const sessionsTarget = lab.sessionsPerWeek;
    let placed = 0;
    const dayPref = lab.preferredDays && lab.preferredDays.length ? lab.preferredDays : days;
    for (let attempt = 0; attempt < sessionsTarget; attempt++) {
      const dayCandidates = shuffle(days, rand).sort((a, b) => {
        const aPref = dayPref.includes(a) ? 0 : 1;
        const bPref = dayPref.includes(b) ? 0 : 1;
        return aPref - bPref;
      });
      let done = false;
      for (const day of dayCandidates) {
        const startCandidates = [];
        for (let s = 1; s + lab.consecutivePeriods - 1 <= P; s++) startCandidates.push(s);
        const ordered = advanced.preferMorningLabs
          ? startCandidates.sort((a, b) => a - b)
          : shuffle(startCandidates, rand);
        for (const start of ordered) {
          let ok = true;
          for (let k = 0; k < lab.consecutivePeriods; k++) {
            const p = start + k;
            if (grid[day][p] !== null) { ok = false; break; }
            if (isEdgeBlocked(p)) { ok = false; break; }
            if (!facultyOK(lab.faculty, day, p)) { ok = false; break; }
          }
          if (!ok) continue;
          for (let k = 0; k < lab.consecutivePeriods; k++) {
            const p = start + k;
            grid[day][p] = {
              kind: "lab", refId: lab.id, name: lab.name, faculty: lab.faculty,
              room: lab.room, color: lab.color, block: `${lab.id}-${attempt}`,
            };
            bookFaculty(lab.faculty, day, p);
          }
          placed++; done = true;
          break;
        }
        if (done) break;
      }
    }
    if (placed < sessionsTarget) unplaced.push({ type: "lab", name: lab.name, missing: sessionsTarget - placed });
  });

  // ---- 2. Theory subjects ----
  const subjectState = subjects.map((s) => ({ ...s, remaining: s.periodsPerWeek, dayCount: {} }));
  const priorityWeight = { High: 0, Medium: 1, Low: 2 };
  let pending = shuffle(subjectState, rand).sort((a, b) => (priorityWeight[a.priority] ?? 1) - (priorityWeight[b.priority] ?? 1));

  let guard = 0;
  const maxGuard = subjects.length * P * days.length * 4 + 500;
  while (pending.some((s) => s.remaining > 0) && guard < maxGuard) {
    guard++;
    for (const s of pending) {
      if (s.remaining <= 0) continue;
      const fairShare = Math.ceil(s.periodsPerWeek / days.length);
      const dayOrder = shuffle(days, rand).sort((a, b) => (s.dayCount[a] || 0) - (s.dayCount[b] || 0));
      let placedThisPass = false;
      for (const day of dayOrder) {
        if ((s.dayCount[day] || 0) >= fairShare && advanced.distributeEvenly) continue;
        const periodOrder = shuffle(Array.from({ length: P }, (_, i) => i + 1), rand).sort((a, b) => {
          if (s.preferredSession === "Any") return 0;
          const aScore = s.preferredSession === "Morning" ? (a <= half ? 0 : 1) : a > half ? 0 : 1;
          const bScore = s.preferredSession === "Morning" ? (b <= half ? 0 : 1) : b > half ? 0 : 1;
          return aScore - bScore;
        });
        for (const p of periodOrder) {
          if (grid[day][p] !== null) continue;
          if (isEdgeBlocked(p)) continue;
          if (!facultyOK(s.faculty, day, p)) continue;
          if (s.avoidConsecutive || advanced.noSameConsecutive) {
            const prevIsSame = grid[day][p - 1] && grid[day][p - 1].refId === s.id;
            const nextIsSame = grid[day][p + 1] && grid[day][p + 1].refId === s.id;
            if (prevIsSame || nextIsSame) continue;
          }
          grid[day][p] = { kind: "theory", refId: s.id, name: s.name, faculty: s.faculty, color: s.color };
          bookFaculty(s.faculty, day, p);
          s.dayCount[day] = (s.dayCount[day] || 0) + 1;
          s.remaining--;
          placedThisPass = true;
          break;
        }
        if (placedThisPass) break;
      }
    }
  }

  // ---- 2b. Relaxation pass ----
  let guard2 = 0;
  const maxGuard2 = subjects.length * P * days.length * 4 + 500;
  while (pending.some((s) => s.remaining > 0) && guard2 < maxGuard2) {
    guard2++;
    let anyPlaced = false;
    for (const s of pending) {
      if (s.remaining <= 0) continue;
      const dayOrder = shuffle(days, rand).sort((a, b) => (s.dayCount[a] || 0) - (s.dayCount[b] || 0));
      let placedThisPass = false;
      for (const day of dayOrder) {
        const periodOrder = shuffle(Array.from({ length: P }, (_, i) => i + 1), rand);
        for (const p of periodOrder) {
          if (grid[day][p] !== null) continue;
          if (isEdgeBlocked(p)) continue;
          if (!facultyOK(s.faculty, day, p)) continue;
          if (s.avoidConsecutive || advanced.noSameConsecutive) {
            const prevIsSame = grid[day][p - 1] && grid[day][p - 1].refId === s.id;
            const nextIsSame = grid[day][p + 1] && grid[day][p + 1].refId === s.id;
            if (prevIsSame || nextIsSame) continue;
          }
          grid[day][p] = { kind: "theory", refId: s.id, name: s.name, faculty: s.faculty, color: s.color };
          bookFaculty(s.faculty, day, p);
          s.dayCount[day] = (s.dayCount[day] || 0) + 1;
          s.remaining--;
          placedThisPass = true; anyPlaced = true;
          break;
        }
        if (placedThisPass) break;
      }
    }
    if (!anyPlaced) break;
  }

  pending.forEach((s) => { if (s.remaining > 0) unplaced.push({ type: "subject", name: s.name, missing: s.remaining }); });

  // ---- 3. Optional backfill of empty slots ----
  if (advanced.noEmptySlots) {
    const fillable = subjects.filter((s) => s.priority !== "High");
    days.forEach((day) => {
      for (let p = 1; p <= P; p++) {
        if (grid[day][p] !== null) continue;
        const candidate = shuffle(fillable.length ? fillable : subjects, rand)[0];
        if (!candidate) continue;
        if (!facultyOK(candidate.faculty, day, p)) continue;
        grid[day][p] = { kind: "theory", refId: candidate.id, name: candidate.name, faculty: candidate.faculty, color: candidate.color, filler: true };
        bookFaculty(candidate.faculty, day, p);
      }
    });
  }

  let totalSlots = days.length * P;
  let filled = 0;
  days.forEach((d) => { for (let p = 1; p <= P; p++) if (grid[d][p]) filled++; });

  const facultyLoad = {};
  faculty.forEach((f) => {
    let count = 0;
    days.forEach((d) => { for (let p = 1; p <= P; p++) if (grid[d][p] && grid[d][p].faculty === f.name) count++; });
    const cap = (f.maxPerDay || 8) * days.length;
    facultyLoad[f.name] = { count, cap, pct: cap ? Math.round((count / cap) * 100) : 0 };
  });

  const roomLoad = {};
  labs.forEach((lab) => {
    if (!lab.room) return;
    roomLoad[lab.room] = roomLoad[lab.room] || 0;
    days.forEach((d) => { for (let p = 1; p <= P; p++) if (grid[d][p] && grid[d][p].room === lab.room) roomLoad[lab.room]++; });
  });

  return {
    grid, unplaced,
    stats: {
      totalSlots, filled, free: totalSlots - filled,
      busyPct: totalSlots ? Math.round((filled / totalSlots) * 100) : 0,
      facultyLoad, roomLoad,
    },
  };
}

function buildDaySequence(periodsPerDay, breaks) {
  const seq = [];
  const sortedBreaks = [...breaks].sort((a, b) => a.afterPeriod - b.afterPeriod);
  for (let p = 1; p <= periodsPerDay; p++) {
    seq.push({ type: "period", index: p });
    const brk = sortedBreaks.find((b) => b.afterPeriod === p);
    if (brk) seq.push({ type: "break", name: brk.name, duration: brk.duration });
  }
  return seq;
}

/* ============================================================================
   THEME SYSTEM
   Light + dark palettes expressed as CSS custom properties, scoped under a
   [data-theme] attribute on the app root. Every shared UI primitive below
   reads these variables via Tailwind's bracket syntax (e.g. bg-[var(--card-bg)])
   instead of hardcoded slate/white classes, so one toggle re-themes everything.
============================================================================ */
const ThemeContext = React.createContext({ theme: "light", toggleTheme: () => {} });
function useTheme() {
  return React.useContext(ThemeContext);
}

function ThemeStyles() {
  return (
    <style>{`
      [data-theme="light"] {
        --page-bg-1: #EAF7FF; --page-bg-2: #F1FFF6; --page-bg-3: #E6FBFF;
        --blob-a: rgba(147,197,253,0.30); --blob-b: rgba(110,231,183,0.28); --blob-c: rgba(165,243,252,0.32);
        --card-bg: rgba(255,255,255,0.55); --card-border: rgba(255,255,255,0.7); --card-shadow: rgba(37,99,235,0.10);
        --header-bg: rgba(255,255,255,0.62); --header-border: rgba(255,255,255,0.7);
        --text-primary: #1E293B; --text-secondary: #64748B; --text-tertiary: #94A3B8;
        --nav-text: #475569; --nav-hover-bg: #EFF6FF; --nav-hover-text: #2563EB;
        --input-bg: rgba(255,255,255,0.72); --input-border: #E2E8F0; --input-text: #1E293B;
        --input-placeholder: #94A3B8; --input-focus-border: #60A5FA; --input-focus-ring: rgba(191,219,254,0.55);
        --surface-muted: #F8FAFC; --surface-muted-border: #E2E8F0;
        --surface-blue: rgba(239,246,255,0.75); --surface-emerald: rgba(236,253,245,0.75);
        --surface-cyan: rgba(236,254,255,0.75); --surface-amber: #FFFBEB; --surface-rose: #FFF1F2;
        --accent-blue-text: #1D4ED8; --accent-emerald-text: #047857; --accent-cyan-text: #0E7490;
        --accent-amber-text: #B45309; --accent-amber-border: #FDE68A;
        --accent-rose-text: #E11D48; --accent-rose-border: #FECDD3; --accent-emerald-border: #A7F3D0;
        --toggle-off-bg: #CBD5E1; --track-bg: #F1F5F9;
        --divider: #F1F5F9; --dashed-border: #E2E8F0; --tooltip-bg: #FFFFFF;
        --row-alt: rgba(255,255,255,0.4); --row-base: rgba(255,255,255,0.12); --thead-bg: rgba(255,255,255,0.95);
        --scrollbar-track: rgba(148,163,184,0.15); --scrollbar-thumb: rgba(100,116,139,0.35);
        color-scheme: light;
      }
      [data-theme="dark"] {
        --page-bg-1: #0F172A; --page-bg-2: #111827; --page-bg-3: #0B1220;
        --blob-a: rgba(37,99,235,0.28); --blob-b: rgba(16,185,129,0.22); --blob-c: rgba(8,145,178,0.24);
        --card-bg: rgba(30,41,59,0.55); --card-border: rgba(148,163,184,0.16); --card-shadow: rgba(16,185,129,0.14);
        --header-bg: rgba(15,23,42,0.72); --header-border: rgba(148,163,184,0.14);
        --text-primary: #F1F5F9; --text-secondary: #94A3B8; --text-tertiary: #64748B;
        --nav-text: #CBD5E1; --nav-hover-bg: rgba(37,99,235,0.18); --nav-hover-text: #7DD3FC;
        --input-bg: rgba(15,23,42,0.55); --input-border: rgba(148,163,184,0.22); --input-text: #F1F5F9;
        --input-placeholder: #64748B; --input-focus-border: #38BDF8; --input-focus-ring: rgba(56,189,248,0.25);
        --surface-muted: rgba(30,41,59,0.55); --surface-muted-border: rgba(148,163,184,0.16);
        --surface-blue: rgba(37,99,235,0.14); --surface-emerald: rgba(16,185,129,0.14);
        --surface-cyan: rgba(6,182,212,0.14); --surface-amber: rgba(217,119,6,0.14); --surface-rose: rgba(225,29,72,0.14);
        --accent-blue-text: #7DD3FC; --accent-emerald-text: #6EE7B7; --accent-cyan-text: #67E8F9;
        --accent-amber-text: #FCD34D; --accent-amber-border: rgba(217,119,6,0.35);
        --accent-rose-text: #FDA4AF; --accent-rose-border: rgba(225,29,72,0.35); --accent-emerald-border: rgba(16,185,129,0.35);
        --toggle-off-bg: #334155; --track-bg: rgba(30,41,59,0.7);
        --divider: rgba(148,163,184,0.14); --dashed-border: rgba(148,163,184,0.28); --tooltip-bg: #1E293B;
        --row-alt: rgba(255,255,255,0.035); --row-base: rgba(255,255,255,0.015); --thead-bg: rgba(15,23,42,0.92);
        --scrollbar-track: rgba(148,163,184,0.08); --scrollbar-thumb: rgba(148,163,184,0.3);
        color-scheme: dark;
      }
      .tt-app, .tt-app *, .tt-app *::before, .tt-app *::after {
        transition: background-color 0.35s ease, border-color 0.35s ease, color 0.35s ease, box-shadow 0.35s ease;
      }
      .tt-app .t-primary { color: var(--text-primary) !important; }
      .tt-app .t-secondary { color: var(--text-secondary) !important; }
      .tt-app .t-tertiary { color: var(--text-tertiary) !important; }
      .tt-app .surface-muted { background-color: var(--surface-muted) !important; border-color: var(--surface-muted-border) !important; }
      .tt-app .surface-card2 { background-color: var(--input-bg) !important; border-color: var(--input-border) !important; }
      .tt-app .surface-blue { background-color: var(--surface-blue) !important; }
      .tt-app .surface-emerald { background-color: var(--surface-emerald) !important; }
      .tt-app .surface-cyan { background-color: var(--surface-cyan) !important; }
      .tt-app .surface-amber { background-color: var(--surface-amber) !important; border-color: var(--accent-amber-border) !important; }
      .tt-app .surface-rose { background-color: var(--surface-rose) !important; border-color: var(--accent-rose-border) !important; }
      .tt-app .text-accent-blue { color: var(--accent-blue-text) !important; }
      .tt-app .text-accent-emerald { color: var(--accent-emerald-text) !important; }
      .tt-app .text-accent-cyan { color: var(--accent-cyan-text) !important; }
      .tt-app .text-accent-amber { color: var(--accent-amber-text) !important; }
      .tt-app .text-accent-rose { color: var(--accent-rose-text) !important; }
      .tt-app .border-themed { border-color: var(--input-border) !important; }
      .tt-app .divider-themed { border-color: var(--divider) !important; }
      .tt-app .row-alt { background-color: var(--row-alt) !important; }
      .tt-app .row-base { background-color: var(--row-base) !important; }
      .tt-app .thead-themed { background-color: var(--thead-bg) !important; }
      .tt-app .header-themed { background-color: var(--header-bg) !important; border-color: var(--header-border) !important; }
      .tt-app .tooltip-themed { background-color: var(--tooltip-bg) !important; border-color: var(--input-border) !important; }
      .tt-app .nav-link { color: var(--nav-text) !important; }
      .tt-app .nav-link:hover { background-color: var(--nav-hover-bg) !important; color: var(--nav-hover-text) !important; }
      .tt-app .tt-field::placeholder { color: var(--input-placeholder); }
      .tt-app .tt-field:focus { border-color: var(--input-focus-border); box-shadow: 0 0 0 4px var(--input-focus-ring); }
      .tt-app ::-webkit-scrollbar { width: 8px; height: 8px; }
      .tt-app ::-webkit-scrollbar-track { background: var(--scrollbar-track); border-radius: 8px; }
      .tt-app ::-webkit-scrollbar-thumb { background: var(--scrollbar-thumb); border-radius: 8px; }
      @media (prefers-reduced-motion: reduce) {
        .tt-app, .tt-app *, .tt-app *::before, .tt-app *::after { transition-duration: 0.001ms !important; }
      }
    `}</style>
  );
}

function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const dark = theme === "dark";
  return (
    <button
      onClick={toggleTheme}
      aria-label={dark ? "Switch to light mode" : "Switch to dark mode"}
      title={dark ? "Switch to light mode" : "Switch to dark mode"}
      className="relative flex h-10 w-[76px] shrink-0 items-center rounded-full border p-1 transition-all duration-300"
      style={{
        borderColor: "var(--card-border)",
        background: dark
          ? "linear-gradient(90deg, #1E293B, #0F172A)"
          : "linear-gradient(90deg, #DBEAFE, #D1FAE5)",
      }}
    >
      <span
        className="absolute top-1 flex h-8 w-8 items-center justify-center rounded-full bg-gradient-to-br from-blue-500 to-emerald-500 shadow-md transition-transform duration-300 ease-out"
        style={{ transform: dark ? "translateX(38px) rotate(360deg)" : "translateX(2px) rotate(0deg)" }}
      >
        {dark ? <Moon size={15} className="text-white" /> : <Sun size={15} className="text-white" />}
      </span>
      <span className="absolute left-2.5 text-[10px] font-semibold" style={{ color: dark ? "transparent" : "var(--accent-amber-text)" }}>
        <Sun size={13} />
      </span>
      <span className="absolute right-2.5 text-[10px] font-semibold" style={{ color: dark ? "#CBD5E1" : "transparent" }}>
        <Moon size={13} />
      </span>
    </button>
  );
}

/* ============================================================================
   UI PRIMITIVES — light blue/green glassmorphism
============================================================================ */

function AnimatedCard({ children, className = "", delay = 0, id }) {
  const [shown, setShown] = useState(false);
  useEffect(() => { const t = setTimeout(() => setShown(true), delay); return () => clearTimeout(t); }, [delay]);
  return (
    <section
      id={id}
      className={`rounded-3xl border backdrop-blur-xl
      transition-all duration-700 ease-out ${shown ? "opacity-100 translate-y-0" : "opacity-0 translate-y-4"} ${className}`}
      style={{
        borderColor: "var(--card-border)",
        backgroundColor: "var(--card-bg)",
        boxShadow: `0 8px 30px var(--card-shadow)`,
      }}
    >
      {children}
    </section>
  );
}

function SectionHeading({ icon: Icon, title, hint }) {
  return (
    <div className="mb-4 flex items-start gap-3">
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-blue-500 to-emerald-500 text-white shadow-md shadow-blue-500/20">
        <Icon size={17} />
      </div>
      <div>
        <h3 className="font-heading text-[17px] font-bold" style={{ color: "var(--text-primary)" }}>{title}</h3>
        {hint && <p className="text-[12.5px] mt-0.5" style={{ color: "var(--text-secondary)" }}>{hint}</p>}
      </div>
    </div>
  );
}

function PrimaryButton({ children, onClick, disabled, className = "", icon: Icon }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center justify-center gap-2 rounded-xl px-5 py-2.5 font-semibold text-white transition-all duration-200
      bg-gradient-to-r from-blue-600 to-emerald-500 hover:shadow-lg hover:shadow-emerald-500/30 hover:scale-[1.02] active:scale-[0.98]
      disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:scale-100 ${className}`}
    >
      {Icon && <Icon size={17} />}
      {children}
    </button>
  );
}

function GhostButton({ children, onClick, disabled, className = "", icon: Icon }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`inline-flex items-center justify-center gap-2 rounded-xl px-4 py-2.5 font-medium
      border hover:shadow-sm transition-all duration-150
      disabled:opacity-30 disabled:cursor-not-allowed ${className}`}
      style={{ color: "var(--text-primary)", borderColor: "var(--input-border)", backgroundColor: "var(--input-bg)" }}
    >
      {Icon && <Icon size={16} />}
      {children}
    </button>
  );
}

/* Small hover/focus tooltip for "what does this field mean" moments. */
function InfoTip({ text }) {
  return (
    <span tabIndex={0} className="group relative inline-flex items-center outline-none">
      <Info size={13} className="hover:text-blue-500 cursor-help" style={{ color: "var(--text-tertiary)" }} />
      <span
        className="pointer-events-none absolute left-1/2 top-full z-30 mt-2 w-52 -translate-x-1/2 rounded-xl border p-2.5 text-[11.5px] leading-snug opacity-0 shadow-xl transition-opacity duration-150 group-hover:opacity-100 group-focus:opacity-100"
        style={{ borderColor: "var(--input-border)", backgroundColor: "var(--tooltip-bg)", color: "var(--text-secondary)" }}
      >
        {text}
      </span>
    </span>
  );
}

/* One line of plain-language guidance under a field, so nobody has to guess what to type. */
function HelperText({ children }) {
  return <p className="mt-1.5 text-[11.5px] leading-snug" style={{ color: "var(--text-secondary)" }}>{children}</p>;
}

function FieldLabel({ icon: Icon, children, tooltip, required }) {
  return (
    <label className="mb-1.5 flex items-center gap-1.5 text-[13px] font-semibold" style={{ color: "var(--text-primary)" }}>
      {Icon && <Icon size={13} className="text-blue-500" />}
      {children}
      {required && <span className="text-rose-400">*</span>}
      {tooltip && <InfoTip text={tooltip} />}
    </label>
  );
}

function TextInput(props) {
  return (
    <input
      {...props}
      className={`tt-field w-full rounded-xl border px-3.5 py-2.5 shadow-sm outline-none transition-all ${props.className || ""}`}
      style={{ borderColor: "var(--input-border)", backgroundColor: "var(--input-bg)", color: "var(--input-text)" }}
    />
  );
}

function SelectInput({ children, ...props }) {
  return (
    <select
      {...props}
      className="tt-field w-full rounded-xl border px-3.5 py-2.5 shadow-sm outline-none transition-all"
      style={{ borderColor: "var(--input-border)", backgroundColor: "var(--input-bg)", color: "var(--input-text)" }}
    >
      {children}
    </select>
  );
}

function ToggleRow({ label, hint, tooltip, checked, onChange }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-2xl border px-4 py-3.5" style={{ borderColor: "var(--input-border)", backgroundColor: "var(--input-bg)" }}>
      <div>
        <div className="flex items-center gap-1.5 text-sm font-medium" style={{ color: "var(--text-primary)" }}>
          {label}
          {tooltip && <InfoTip text={tooltip} />}
        </div>
        {hint && <div className="text-xs mt-0.5" style={{ color: "var(--text-secondary)" }}>{hint}</div>}
      </div>
      <button
        onClick={() => onChange(!checked)}
        aria-label={label}
        className="relative h-6 w-11 shrink-0 rounded-full transition-colors"
        style={{ background: checked ? "linear-gradient(90deg,#3B82F6,#10B981)" : "var(--toggle-off-bg)" }}
      >
        <span className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${checked ? "translate-x-5" : "translate-x-0.5"}`} />
      </button>
    </div>
  );
}

function DayChip({ day, active, onClick, disabled }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={`rounded-xl px-3.5 py-2 text-sm font-medium border transition-all duration-150
      ${active
          ? "border-transparent bg-gradient-to-r from-blue-500 to-emerald-500 text-white shadow-sm shadow-blue-400/30"
          : ""}
      ${disabled ? "opacity-30 cursor-not-allowed" : ""}`}
      style={active ? undefined : { borderColor: "var(--input-border)", backgroundColor: "var(--input-bg)", color: "var(--text-secondary)" }}
    >
      {day}
    </button>
  );
}

function LogoMark({ size = 28 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" fill="none">
      <path d="M2 20H10L14 8L20 32L24 14L28 20H38" stroke="url(#pulseGradLight)" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <defs>
        <linearGradient id="pulseGradLight" x1="0" y1="0" x2="40" y2="0">
          <stop offset="0%" stopColor="#2563EB" />
          <stop offset="50%" stopColor="#0EA5E9" />
          <stop offset="100%" stopColor="#16A34A" />
        </linearGradient>
      </defs>
    </svg>
  );
}

function Background() {
  return (
    <div
      className="fixed inset-0 -z-10 overflow-hidden transition-colors duration-500"
      style={{ background: `linear-gradient(135deg, var(--page-bg-1), var(--page-bg-2) 55%, var(--page-bg-3))` }}
    >
      <div className="absolute -top-32 -left-32 h-[440px] w-[440px] rounded-full blur-[110px] animate-[floatA_20s_ease-in-out_infinite]" style={{ backgroundColor: "var(--blob-a)" }} />
      <div className="absolute top-1/4 -right-24 h-[420px] w-[420px] rounded-full blur-[110px] animate-[floatB_24s_ease-in-out_infinite]" style={{ backgroundColor: "var(--blob-b)" }} />
      <div className="absolute bottom-0 left-1/3 h-[380px] w-[380px] rounded-full blur-[110px] animate-[floatC_18s_ease-in-out_infinite]" style={{ backgroundColor: "var(--blob-c)" }} />
      <style>{`
        @keyframes floatA { 0%,100%{transform:translate(0,0)} 50%{transform:translate(30px,40px)} }
        @keyframes floatB { 0%,100%{transform:translate(0,0)} 50%{transform:translate(-40px,30px)} }
        @keyframes floatC { 0%,100%{transform:translate(0,0)} 50%{transform:translate(20px,-30px)} }
      `}</style>
    </div>
  );
}

const NAV_ITEMS = [
  { id: "timing", label: "Timing", icon: Clock },
  { id: "periods", label: "Periods", icon: SlidersHorizontal },
  { id: "days", label: "Days", icon: Calendar },
  { id: "subjects", label: "Subjects", icon: BookOpen },
  { id: "labs", label: "Labs", icon: FlaskConical },
  { id: "faculty", label: "Faculty", icon: Users },
  { id: "advanced", label: "Rules", icon: ShieldCheck },
  { id: "result", label: "Timetable", icon: BarChart3 },
];

/* ============================================================================
   MAIN APP — single scrolling page
============================================================================ */
export default function App() {
  // ---- core config state (unchanged shape from the previous version) ----
  const [startTime, setStartTime] = useState("09:00");
  const [endTime, setEndTime] = useState("16:30");
  const [periodDuration, setPeriodDuration] = useState(50);
  const [periodsPerDay, setPeriodsPerDay] = useState(6);
  const [breaks, setBreaks] = useState([{ id: uid("brk"), name: "Tea Break", afterPeriod: 2, duration: 15 }]);
  const [workingDays, setWorkingDays] = useState({ Monday: true, Tuesday: true, Wednesday: true, Thursday: true, Friday: true, Saturday: false });
  const [subjects, setSubjects] = useState([
    { id: uid("sub"), name: "", faculty: "", periodsPerWeek: 4, preferredSession: "Any", avoidConsecutive: true, priority: "Medium", color: SUBJECT_PALETTE[0] },
  ]);
  const [labs, setLabs] = useState([]);
  const [facultyOverrides, setFacultyOverrides] = useState({});
  const [advanced, setAdvanced] = useState(DEFAULT_ADVANCED);

  // ---- result / history state (unchanged) ----
  const [seed, setSeed] = useState(null);
  const [result, setResult] = useState(null);
  const [lockedCells, setLockedCells] = useState({});
  const [history, setHistory] = useState([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [generating, setGenerating] = useState(false);
  const [aiNote, setAiNote] = useState(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [saveStatus, setSaveStatus] = useState(null);

  // ---- theme (light/dark), persisted via artifact storage so it survives a refresh ----
  const [theme, setTheme] = useState("light");
  const [themeLoaded, setThemeLoaded] = useState(false);
  useEffect(() => {
    (async () => {
      try {
        const r = await window.storage.get("timetable:theme");
        if (r && (r.value === "light" || r.value === "dark")) setTheme(r.value);
      } catch (e) {
        // no saved preference yet — default to light
      } finally {
        setThemeLoaded(true);
      }
    })();
  }, []);
  const toggleTheme = useCallback(() => {
    setTheme((t) => {
      const next = t === "light" ? "dark" : "light";
      window.storage.set("timetable:theme", next).catch(() => {});
      return next;
    });
  }, []);

  const resultRef = useRef(null);

  const totalMinutes = Math.max(0, timeToMinutes(endTime) - timeToMinutes(startTime));
  const daySeq = useMemo(() => buildDaySequence(periodsPerDay, breaks), [periodsPerDay, breaks]);
  const scheduledMinutes = periodsPerDay * periodDuration + breaks.reduce((s, b) => s + Number(b.duration || 0), 0);
  const activeDays = ALL_DAYS.filter((d) => workingDays[d]);
  const totalWeeklyPeriods = periodsPerDay * activeDays.length;

  const requiredPeriods =
    subjects.reduce((s, sub) => s + Number(sub.periodsPerWeek || 0), 0) +
    labs.reduce((s, lab) => s + Number(lab.consecutivePeriods || 0) * Number(lab.sessionsPerWeek || 0), 0);

  const deficit = requiredPeriods - totalWeeklyPeriods;

  const facultyList = useMemo(() => {
    const names = new Set();
    subjects.forEach((s) => s.faculty && names.add(s.faculty.trim()));
    labs.forEach((l) => l.faculty && names.add(l.faculty.trim()));
    return Array.from(names).map((name) => ({
      name,
      maxPerDay: facultyOverrides[name]?.maxPerDay ?? 6,
      unavailableDays: facultyOverrides[name]?.unavailableDays ?? [],
    }));
  }, [subjects, labs, facultyOverrides]);

  const config = useMemo(
    () => ({
      days: activeDays,
      periodsPerDay,
      subjects: subjects.filter((s) => s.name.trim()),
      labs: labs.filter((l) => l.name.trim()),
      faculty: facultyList,
      advanced,
    }),
    [activeDays, periodsPerDay, subjects, labs, facultyList, advanced]
  );

  /* ---- generation (unchanged logic) ---- */
  const runGeneration = useCallback((keepLocks) => {
    setGenerating(true);
    setAiNote(null);
    const newSeed = Date.now() + Math.floor(Math.random() * 100000);
    setTimeout(() => {
      const locks = keepLocks ? lockedCells : {};
      const r = generateTimetable(config, newSeed, locks);
      setSeed(newSeed);
      setResult(r);
      setHistory((h) => {
        const trimmed = h.slice(0, historyIndex + 1);
        const updated = [...trimmed, { seed: newSeed, result: r, locks }];
        setHistoryIndex(updated.length - 1);
        return updated;
      });
      setGenerating(false);
    }, 550);
  }, [config, lockedCells, historyIndex]);

  const handleGenerateClick = () => {
    runGeneration(false);
    setTimeout(() => resultRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 80);
  };
  const regenerate = () => runGeneration(true);

  const undo = () => {
    if (historyIndex <= 0) return;
    const idx = historyIndex - 1;
    setHistoryIndex(idx); setResult(history[idx].result); setSeed(history[idx].seed);
  };
  const redo = () => {
    if (historyIndex >= history.length - 1) return;
    const idx = historyIndex + 1;
    setHistoryIndex(idx); setResult(history[idx].result); setSeed(history[idx].seed);
  };

  const toggleLock = (day, p) => {
    const key = `${day}|${p}`;
    setLockedCells((prev) => {
      const next = { ...prev };
      if (next[key]) delete next[key];
      else if (result?.grid?.[day]?.[p]) next[key] = result.grid[day][p];
      return next;
    });
  };

  /* ---- config persistence (unchanged — uses artifact storage, not localStorage) ---- */
  const saveConfig = async () => {
    try {
      const payload = { startTime, endTime, periodDuration, periodsPerDay, breaks, workingDays, subjects, labs, facultyOverrides, advanced };
      await window.storage.set("timetable:config", JSON.stringify(payload));
      setSaveStatus("saved"); setTimeout(() => setSaveStatus(null), 2000);
    } catch (e) { setSaveStatus("error"); setTimeout(() => setSaveStatus(null), 2500); }
  };
  const loadConfig = async () => {
    try {
      const r = await window.storage.get("timetable:config");
      if (!r) { setSaveStatus("empty"); setTimeout(() => setSaveStatus(null), 2000); return; }
      const payload = JSON.parse(r.value);
      setStartTime(payload.startTime); setEndTime(payload.endTime);
      setPeriodDuration(payload.periodDuration); setPeriodsPerDay(payload.periodsPerDay);
      setBreaks(payload.breaks); setWorkingDays(payload.workingDays);
      setSubjects(payload.subjects); setLabs(payload.labs);
      setFacultyOverrides(payload.facultyOverrides || {}); setAdvanced(payload.advanced || DEFAULT_ADVANCED);
      setSaveStatus("loaded"); setTimeout(() => setSaveStatus(null), 2000);
    } catch (e) { setSaveStatus("empty"); setTimeout(() => setSaveStatus(null), 2500); }
  };

  /* ---- exports (unchanged) ---- */
  const exportJSON = () => {
    const payload = { config, seed, grid: result?.grid };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = "timetable.json"; a.click();
    URL.revokeObjectURL(url);
  };
  const exportExcel = () => {
    if (!result) return;
    const header = ["Day/Period", ...Array.from({ length: periodsPerDay }, (_, i) => `Period ${i + 1}`)];
    const rows = activeDays.map((day) => [
      day,
      ...Array.from({ length: periodsPerDay }, (_, i) => {
        const e = result.grid[day][i + 1];
        return e ? `${e.name}${e.faculty ? " (" + e.faculty + ")" : ""}${e.room ? " [" + e.room + "]" : ""}` : "Free";
      }),
    ]);
    const ws = XLSX.utils.aoa_to_sheet([header, ...rows]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Timetable");
    XLSX.writeFile(wb, "timetable.xlsx");
  };
  const copyTimetable = async () => {
    if (!result) return;
    let text = "AI Smart College Timetable\n\n";
    activeDays.forEach((day) => {
      text += `${day}\n`;
      for (let p = 1; p <= periodsPerDay; p++) {
        const e = result.grid[day][p];
        text += `  P${p}: ${e ? e.name + (e.faculty ? " - " + e.faculty : "") : "Free"}\n`;
      }
      text += "\n";
    });
    try { await navigator.clipboard.writeText(text); setSaveStatus("copied"); setTimeout(() => setSaveStatus(null), 2000); }
    catch (e) { setSaveStatus("error"); setTimeout(() => setSaveStatus(null), 2000); }
  };
  const printTimetable = () => window.print();

  /* ---- AI insight (unchanged) ---- */
  const requestAIInsight = async () => {
    if (!result) return;
    setAiLoading(true); setAiNote(null);
    try {
      const summary = {
        subjects: config.subjects.map((s) => ({ name: s.name, periodsPerWeek: s.periodsPerWeek, priority: s.priority })),
        labs: config.labs.map((l) => ({ name: l.name, sessionsPerWeek: l.sessionsPerWeek, consecutivePeriods: l.consecutivePeriods })),
        days: config.days, periodsPerDay,
        busyPct: result.stats.busyPct, free: result.stats.free,
        facultyLoad: result.stats.facultyLoad,
        unplaced: result.unplaced,
      };
      const response = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 1000,
          messages: [{
            role: "user",
            content: `You are a scheduling assistant for a college timetable generator. Given this JSON summary of a generated weekly timetable, give 2-4 short, concrete, practical suggestions (max ~120 words total) to improve balance or fairness. Be specific, plain, and direct — no preamble.\n\n${JSON.stringify(summary)}`,
          }],
        }),
      });
      const data = await response.json();
      const text = (data.content || []).map((c) => c.text || "").join("\n").trim();
      setAiNote(text || "No suggestions returned.");
    } catch (e) {
      setAiNote("AI suggestions aren't available right now — the schedule itself is unaffected.");
    } finally { setAiLoading(false); }
  };

  const scrollTo = (id) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });

  /* ============================================================================
     RENDER — single page, all sections stacked/gridded, timetable at the bottom
  ============================================================================ */
  return (
    <ThemeContext.Provider value={{ theme, toggleTheme }}>
    <div className="tt-app min-h-screen w-full font-body" data-theme={theme} style={{ color: "var(--text-primary)" }}>
      <ThemeStyles />
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Manrope:wght@600;700;800&family=Inter:wght@400;500;600&display=swap');
        .font-heading { font-family: 'Manrope', sans-serif; }
        .font-body { font-family: 'Inter', sans-serif; }
        html { scroll-behavior: smooth; }
        @keyframes softGlow {
          0%, 100% { box-shadow: 0 0 0 0 rgba(16,185,129,0.35), 0 8px 20px rgba(37,99,235,0.25); }
          50% { box-shadow: 0 0 0 10px rgba(16,185,129,0), 0 8px 28px rgba(37,99,235,0.35); }
        }
        @media (prefers-reduced-motion: reduce) {
          * { animation-duration: 0.001ms !important; animation-iteration-count: 1 !important; }
        }
        @media print {
          .no-print { display: none !important; }
          body { background: white !important; }
        }
      `}</style>
      <Background />

      {/* Sticky nav (still a single page — this just jumps to sections via anchors) */}
      <header className="no-print sticky top-0 z-20 border-b header-themed backdrop-blur-xl">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2.5">
            <LogoMark />
            <div>
              <div className="font-heading text-[15px] font-bold leading-none t-primary">Smart Timetable</div>
              <div className="text-[11px] leading-none t-secondary mt-1">AI scheduling engine</div>
            </div>
          </div>
          <nav className="hidden gap-1 lg:flex">
            {NAV_ITEMS.map((n) => (
              <button key={n.id} onClick={() => scrollTo(n.id)}
                className="flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[12.5px] font-medium nav-link transition-colors">
                <n.icon size={13} /> {n.label}
              </button>
            ))}
          </nav>
          <div className="flex items-center gap-2">
            <GhostButton onClick={() => scrollTo("generate")} className="lg:hidden" icon={ArrowDown}>Generate</GhostButton>
            <ThemeToggle />
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-7xl px-4 py-8">
        {/* ================= HEADER / INTRO ================= */}
        <AnimatedCard className="mb-6 p-6 sm:p-8" delay={0}>
          <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <div
                className="mb-2 inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-[11.5px] font-semibold"
                style={{ background: "linear-gradient(90deg, var(--surface-blue), var(--surface-emerald))", color: "var(--accent-blue-text)" }}
              >
                <Sparkles size={12} /> AI Smart College Timetable Generator
              </div>
              <h1 className="font-heading text-2xl sm:text-3xl font-extrabold t-primary">
                Set it up once, generate in seconds
              </h1>
              <p className="mt-1.5 max-w-xl text-sm t-secondary">
                Fill in your timing, subjects, labs, and rules below — a constraint-solving engine places every
                class with zero conflicts, and you can reshuffle it as many times as you like.
              </p>
              <p className="mt-2 flex items-center gap-1.5 text-xs t-secondary">
                Fields marked <span className="text-rose-400">*</span> are required. Hover any <Info size={12} className="inline t-tertiary" /> icon for a quick explanation.
              </p>
            </div>
            <GhostButton onClick={loadConfig} icon={FolderOpen}>Load a saved setup</GhostButton>
          </div>
        </AnimatedCard>

        {/* ================= COMPACT SETTINGS GRID ================= */}
        <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
          {/* Timing */}
          <AnimatedCard id="timing" className="p-5 xl:col-span-1" delay={60}>
            <SectionHeading icon={Clock} title="College Timing" hint="Configure your institution's daily working hours." />
            <div className="grid grid-cols-2 gap-3">
              <div>
                <FieldLabel icon={Sunrise} required tooltip="This is when the first period of the day begins.">College Starting Time</FieldLabel>
                <TextInput type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
                <HelperText>When classes begin each day.</HelperText>
              </div>
              <div>
                <FieldLabel icon={Clock} required tooltip="This is when the last period of the day ends.">College Ending Time</FieldLabel>
                <TextInput type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
                <HelperText>When classes end each day.</HelperText>
              </div>
            </div>
            <div className="mt-3 flex items-center justify-between rounded-xl surface-blue px-3.5 py-2.5 text-sm">
              <span className="t-secondary">Total working duration</span>
              <span className="font-heading font-bold text-accent-blue">{Math.floor(totalMinutes / 60)}h {totalMinutes % 60}m</span>
            </div>
            {totalMinutes <= 0 && (
              <div className="mt-2 flex items-center gap-1.5 text-xs text-rose-500"><AlertTriangle size={13} /> End time must be after start time.</div>
            )}
          </AnimatedCard>

          {/* Periods & Breaks */}
          <AnimatedCard id="periods" className="p-5" delay={120}>
            <SectionHeading icon={SlidersHorizontal} title="Period Configuration" hint="Set the duration of each class period and breaks." />
            <div className="grid grid-cols-2 gap-3">
              <div>
                <FieldLabel icon={ListChecks} required tooltip="How many teaching periods run back-to-back in one day, not counting breaks.">Periods Per Day</FieldLabel>
                <TextInput type="number" min={1} max={12} placeholder="e.g. 6" value={periodsPerDay} onChange={(e) => setPeriodsPerDay(Number(e.target.value) || 1)} />
                <HelperText>How many class periods run each day.</HelperText>
              </div>
              <div>
                <FieldLabel icon={Timer} required tooltip="How long a single class period lasts, in minutes.">Duration of Each Period</FieldLabel>
                <TextInput type="number" min={20} max={120} placeholder="e.g. 50" value={periodDuration} onChange={(e) => setPeriodDuration(Number(e.target.value) || 1)} />
                <HelperText>Length of one class period, in minutes.</HelperText>
              </div>
            </div>
            <div className="mt-4 flex items-center justify-between">
              <span className="flex items-center gap-1.5 text-[13px] font-semibold t-primary">
                Breaks <InfoTip text="Add every break in the day — tea break, lunch, etc. Each can have its own timing and length." />
              </span>
              <button onClick={() => setBreaks((b) => [...b, { id: uid("brk"), name: "Break", afterPeriod: 2, duration: 10 }])}
                className="flex items-center gap-1 text-xs font-semibold text-blue-600 hover:text-blue-700">
                <Plus size={13} /> Add a break
              </button>
            </div>
            <HelperText>Give each break a name, and say which period it follows.</HelperText>
            <div className="mt-2 space-y-2.5">
              {breaks.map((b) => (
                <div key={b.id} className="rounded-xl border surface-card2 p-2.5">
                  <div className="flex items-center gap-1.5">
                    <input value={b.name} onChange={(e) => setBreaks((arr) => arr.map((x) => (x.id === b.id ? { ...x, name: e.target.value } : x)))}
                      className="w-full min-w-0 tt-field rounded-lg border px-2 py-1.5 text-xs" placeholder="e.g. Tea Break, Lunch" />
                    <button onClick={() => setBreaks((arr) => arr.filter((x) => x.id !== b.id))} className="shrink-0 t-tertiary hover:text-rose-500"><Trash2 size={14} /></button>
                  </div>
                  <div className="mt-1.5 flex items-center gap-3 text-[11px] t-secondary">
                    <span className="flex items-center gap-1">
                      Break after
                      <input type="number" min={1} max={periodsPerDay} value={b.afterPeriod}
                        onChange={(e) => setBreaks((arr) => arr.map((x) => (x.id === b.id ? { ...x, afterPeriod: Number(e.target.value) || 1 } : x)))}
                        title="Choose after how many periods students receive this break." className="tt-field w-12 shrink-0 rounded-lg border px-1 py-1 text-center" />
                      period(s)
                    </span>
                    <span className="flex items-center gap-1">
                      for
                      <input type="number" min={5} max={90} value={b.duration}
                        onChange={(e) => setBreaks((arr) => arr.map((x) => (x.id === b.id ? { ...x, duration: Number(e.target.value) || 5 } : x)))}
                        title="Enter the break duration in minutes." className="tt-field w-12 shrink-0 rounded-lg border px-1 py-1 text-center" />
                      min
                    </span>
                  </div>
                </div>
              ))}
            </div>
            {scheduledMinutes !== totalMinutes && totalMinutes > 0 && (
              <div className={`mt-2 text-xs ${scheduledMinutes > totalMinutes ? "text-rose-500" : "text-amber-500"}`}>
                {scheduledMinutes > totalMinutes ? `${scheduledMinutes - totalMinutes} min over the day` : `${totalMinutes - scheduledMinutes} min unused`}
              </div>
            )}
          </AnimatedCard>

          {/* Working Days */}
          <AnimatedCard id="days" className="p-5" delay={180}>
            <SectionHeading icon={Calendar} title="Working Days" hint="Choose which days of the week hold classes." />
            <FieldLabel icon={CalendarClock}>Select working days</FieldLabel>
            <div className="flex flex-wrap gap-2">
              {ALL_DAYS.map((d) => (
                <DayChip key={d} day={DAY_SHORT[d]} active={workingDays[d]} onClick={() => setWorkingDays((w) => ({ ...w, [d]: !w[d] }))} />
              ))}
            </div>
            <HelperText>Tap a day to include or exclude it from the timetable.</HelperText>
            <div className="mt-3 flex items-center justify-between rounded-xl surface-emerald px-3.5 py-2.5 text-sm">
              <span className="t-secondary">Weekly periods available</span>
              <span className="font-heading font-bold text-accent-emerald">{totalWeeklyPeriods}</span>
            </div>
            {activeDays.length === 0 && (
              <div className="mt-2 flex items-center gap-1.5 text-xs text-rose-500"><AlertTriangle size={13} /> Select at least one day.</div>
            )}
          </AnimatedCard>
        </div>

        {/* ================= SUBJECTS + LABS ================= */}
        <div className="mt-5 grid gap-5 xl:grid-cols-2">
          <AnimatedCard id="subjects" className="p-5 sm:p-6" delay={220}>
            <SectionHeading icon={BookOpen} title="Theory Subjects" hint="Add all theory subjects and define their weekly periods." />
            <div className="max-h-[560px] space-y-3.5 overflow-y-auto pr-1">
              {subjects.map((s, idx) => (
                <div key={s.id} className="rounded-2xl border surface-card2 p-3.5">
                  <div className="mb-2.5 flex items-center justify-between">
                    <span className="flex items-center gap-1.5 text-xs font-semibold t-secondary">
                      <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: s.color }} /> Subject {idx + 1}
                    </span>
                    <button onClick={() => setSubjects((arr) => arr.filter((x) => x.id !== s.id))} className="t-tertiary hover:text-rose-500"><Trash2 size={14} /></button>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <FieldLabel icon={BookOpen} required>Subject Name</FieldLabel>
                      <TextInput placeholder="e.g. Computer Networks" value={s.name} onChange={(e) => setSubjects((arr) => arr.map((x) => (x.id === s.id ? { ...x, name: e.target.value } : x)))} />
                    </div>
                    <div>
                      <FieldLabel icon={User} required>Faculty Name</FieldLabel>
                      <TextInput placeholder="e.g. Dr. Kumar" value={s.faculty} onChange={(e) => setSubjects((arr) => arr.map((x) => (x.id === s.id ? { ...x, faculty: e.target.value } : x)))} />
                    </div>
                    <div>
                      <FieldLabel icon={ListChecks} required tooltip="The total number of classes this subject should have during the week.">Periods Per Week</FieldLabel>
                      <TextInput type="number" min={1} max={30} placeholder="e.g. 5" value={s.periodsPerWeek} onChange={(e) => setSubjects((arr) => arr.map((x) => (x.id === s.id ? { ...x, periodsPerWeek: Number(e.target.value) || 1 } : x)))} />
                    </div>
                    <div>
                      <FieldLabel icon={Sunrise} tooltip="Where in the day this subject is best taught. Choose 'Any Time' if it doesn't matter.">Preferred Session</FieldLabel>
                      <SelectInput value={s.preferredSession} onChange={(e) => setSubjects((arr) => arr.map((x) => (x.id === s.id ? { ...x, preferredSession: e.target.value } : x)))}>
                        <option value="Any">Any Time</option><option value="Morning">Morning</option><option value="Afternoon">Afternoon</option>
                      </SelectInput>
                    </div>
                    <div>
                      <FieldLabel icon={AlertTriangle} tooltip="High-priority subjects get first pick of slots when periods are tight.">Priority</FieldLabel>
                      <SelectInput value={s.priority} onChange={(e) => setSubjects((arr) => arr.map((x) => (x.id === s.id ? { ...x, priority: e.target.value } : x)))}>
                        <option>High</option><option>Medium</option><option>Low</option>
                      </SelectInput>
                    </div>
                    <div>
                      <FieldLabel icon={Palette}>Colour Tag</FieldLabel>
                      <div className="flex items-center gap-1 flex-wrap pt-1">
                        {SUBJECT_PALETTE.slice(0, 6).map((c) => (
                          <button key={c} onClick={() => setSubjects((arr) => arr.map((x) => (x.id === s.id ? { ...x, color: c } : x)))}
                            className="h-6 w-6 rounded-full ring-2 ring-offset-1" style={{ backgroundColor: c, ringColor: s.color === c ? c : "transparent" }} />
                        ))}
                      </div>
                    </div>
                  </div>
                  <div className="mt-2.5">
                    <ToggleRow label="Avoid consecutive classes" hint="Keeps this subject from appearing in two back-to-back periods." checked={s.avoidConsecutive}
                      onChange={(v) => setSubjects((arr) => arr.map((x) => (x.id === s.id ? { ...x, avoidConsecutive: v } : x)))} />
                  </div>
                </div>
              ))}
            </div>
            <button
              onClick={() => setSubjects((arr) => [...arr, { id: uid("sub"), name: "", faculty: "", periodsPerWeek: 4, preferredSession: "Any", avoidConsecutive: true, priority: "Medium", color: SUBJECT_PALETTE[arr.length % SUBJECT_PALETTE.length] }])}
              className="mt-3 flex w-full items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-blue-300/50 py-2.5 text-sm font-medium text-blue-500 hover:bg-blue-500/5"
            >
              <Plus size={15} /> Add another subject
            </button>
          </AnimatedCard>

          <AnimatedCard id="labs" className="p-5 sm:p-6" delay={260}>
            <SectionHeading icon={FlaskConical} title="Laboratory Subjects" hint="Configure lab sessions and consecutive period requirements." />
            <div className="max-h-[560px] space-y-3.5 overflow-y-auto pr-1">
              {labs.map((l, idx) => (
                <div key={l.id} className="rounded-2xl border surface-card2 p-3.5">
                  <div className="mb-2.5 flex items-center justify-between">
                    <span className="flex items-center gap-1.5 text-xs font-semibold t-secondary">
                      <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: l.color }} /> Lab {idx + 1}
                    </span>
                    <button onClick={() => setLabs((arr) => arr.filter((x) => x.id !== l.id))} className="t-tertiary hover:text-rose-500"><Trash2 size={14} /></button>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div>
                      <FieldLabel icon={FlaskConical} required>Lab Name</FieldLabel>
                      <TextInput placeholder="e.g. Physics Lab" value={l.name} onChange={(e) => setLabs((arr) => arr.map((x) => (x.id === l.id ? { ...x, name: e.target.value } : x)))} />
                    </div>
                    <div>
                      <FieldLabel icon={User} required>Faculty</FieldLabel>
                      <TextInput placeholder="e.g. Dr. Rao" value={l.faculty} onChange={(e) => setLabs((arr) => arr.map((x) => (x.id === l.id ? { ...x, faculty: e.target.value } : x)))} />
                    </div>
                    <div>
                      <FieldLabel icon={ListChecks} required tooltip="Labs run as one uninterrupted block. This is how many periods long each session is.">Consecutive Periods Required</FieldLabel>
                      <TextInput type="number" min={1} max={periodsPerDay} value={l.consecutivePeriods} placeholder="e.g. 2"
                        onChange={(e) => setLabs((arr) => arr.map((x) => (x.id === l.id ? { ...x, consecutivePeriods: Number(e.target.value) || 1 } : x)))} />
                    </div>
                    <div>
                      <FieldLabel icon={CalendarClock} required tooltip="How many times this lab block should happen every week.">Sessions Per Week</FieldLabel>
                      <TextInput type="number" min={1} max={7} value={l.sessionsPerWeek} placeholder="e.g. 1"
                        onChange={(e) => setLabs((arr) => arr.map((x) => (x.id === l.id ? { ...x, sessionsPerWeek: Number(e.target.value) || 1 } : x)))} />
                    </div>
                    <div>
                      <FieldLabel icon={MapPin}>Lab Room</FieldLabel>
                      <TextInput placeholder="e.g. Lab-1" value={l.room} onChange={(e) => setLabs((arr) => arr.map((x) => (x.id === l.id ? { ...x, room: e.target.value } : x)))} />
                    </div>
                    <div>
                      <FieldLabel icon={Palette}>Colour Tag</FieldLabel>
                      <div className="flex items-center gap-1 flex-wrap pt-1">
                        {SUBJECT_PALETTE.slice(0, 6).map((c) => (
                          <button key={c} onClick={() => setLabs((arr) => arr.map((x) => (x.id === l.id ? { ...x, color: c } : x)))}
                            className="h-6 w-6 rounded-full ring-2 ring-offset-1" style={{ backgroundColor: c, ringColor: l.color === c ? c : "transparent" }} />
                        ))}
                      </div>
                    </div>
                  </div>
                  <div className="mt-2.5">
                    <FieldLabel icon={Calendar} tooltip="Optional — the engine will try these days first before falling back to any working day.">Preferred Lab Days (Optional)</FieldLabel>
                    <div className="flex flex-wrap gap-1.5">
                      {activeDays.map((d) => {
                        const active = (l.preferredDays || []).includes(d);
                        return (
                          <DayChip key={d} day={DAY_SHORT[d]} active={active}
                            onClick={() => setLabs((arr) => arr.map((x) => x.id === l.id
                              ? { ...x, preferredDays: active ? x.preferredDays.filter((p) => p !== d) : [...(x.preferredDays || []), d] }
                              : x))} />
                        );
                      })}
                    </div>
                  </div>
                </div>
              ))}
              {labs.length === 0 && <div className="rounded-xl surface-muted border p-3 text-xs t-secondary">No labs yet — this section is optional if your program has none.</div>}
            </div>
            <button
              onClick={() => setLabs((arr) => [...arr, { id: uid("lab"), name: "", faculty: "", consecutivePeriods: 2, sessionsPerWeek: 1, room: "", preferredDays: [], color: SUBJECT_PALETTE[(subjects.length + arr.length) % SUBJECT_PALETTE.length] }])}
              className="mt-3 flex w-full items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-emerald-300/50 py-2.5 text-sm font-medium text-emerald-500 hover:bg-emerald-500/5"
            >
              <Plus size={15} /> Add a lab subject
            </button>
          </AnimatedCard>
        </div>

        {/* ================= FACULTY + ADVANCED ================= */}
        <div className="mt-5 grid gap-5 xl:grid-cols-2">
          <AnimatedCard id="faculty" className="p-5 sm:p-6" delay={300}>
            <SectionHeading icon={Users} title="Faculty Information" hint="Assign faculty members and their availability." />
            {facultyList.length === 0 ? (
              <div className="rounded-xl surface-muted border p-3 text-xs t-secondary">Type a faculty name into any subject or lab above — they'll show up here automatically.</div>
            ) : (
              <div className="max-h-[440px] space-y-2.5 overflow-y-auto pr-1">
                {facultyList.map((f) => (
                  <div key={f.name} className="rounded-2xl border surface-card2 p-3.5">
                    <div className="mb-2 flex items-center gap-1.5 text-sm font-semibold t-primary"><GraduationCap size={14} className="text-blue-500" /> {f.name}</div>
                    <div className="grid gap-3 sm:grid-cols-2">
                      <div>
                        <FieldLabel icon={ListChecks} tooltip="The most classes this faculty member should teach in a single day.">Maximum Classes Per Day</FieldLabel>
                        <TextInput type="number" min={1} max={periodsPerDay} placeholder="e.g. 4" value={f.maxPerDay}
                          onChange={(e) => setFacultyOverrides((prev) => ({ ...prev, [f.name]: { ...prev[f.name], maxPerDay: Number(e.target.value) || 1, unavailableDays: prev[f.name]?.unavailableDays || [] } }))} />
                        <HelperText>Caps how many periods this teacher gets in one day.</HelperText>
                      </div>
                      <div>
                        <FieldLabel icon={Calendar} tooltip="Days this faculty member is completely unavailable to teach.">Unavailable Days</FieldLabel>
                        <div className="flex flex-wrap gap-1.5 pt-1">
                          {activeDays.map((d) => {
                            const active = f.unavailableDays.includes(d);
                            return (
                              <DayChip key={d} day={DAY_SHORT[d]} active={active}
                                onClick={() => setFacultyOverrides((prev) => {
                                  const cur = prev[f.name]?.unavailableDays || [];
                                  return { ...prev, [f.name]: { maxPerDay: prev[f.name]?.maxPerDay ?? f.maxPerDay, unavailableDays: active ? cur.filter((x) => x !== d) : [...cur, d] } };
                                })} />
                            );
                          })}
                        </div>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </AnimatedCard>

          <AnimatedCard id="advanced" className="p-5 sm:p-6" delay={340}>
            <SectionHeading icon={ShieldCheck} title="Advanced Settings" hint="Customize timetable generation preferences." />
            <div className="space-y-2">
              <ToggleRow label="No same subject twice in a row" tooltip="Stops the same subject from being scheduled in two back-to-back periods anywhere in the week." checked={advanced.noSameConsecutive} onChange={(v) => setAdvanced((a) => ({ ...a, noSameConsecutive: v }))} />
              <ToggleRow label="Avoid the first period" tooltip="Leaves period 1 free across the whole week — handy for late arrivals or assemblies." checked={advanced.avoidFirst} onChange={(v) => setAdvanced((a) => ({ ...a, avoidFirst: v }))} />
              <ToggleRow label="Avoid the last period" tooltip="Leaves the final period of the day free across the whole week." checked={advanced.avoidLast} onChange={(v) => setAdvanced((a) => ({ ...a, avoidLast: v }))} />
              <ToggleRow label="Distribute subjects evenly" tooltip="Spreads each subject's weekly periods across different days instead of bunching them together." checked={advanced.distributeEvenly} onChange={(v) => setAdvanced((a) => ({ ...a, distributeEvenly: v }))} />
              <ToggleRow label="Prefer morning labs" tooltip="Places lab blocks earlier in the day whenever there's a free consecutive slot." checked={advanced.preferMorningLabs} onChange={(v) => setAdvanced((a) => ({ ...a, preferMorningLabs: v }))} />
              <ToggleRow label="No empty slots" tooltip="Fills any leftover free period with a lower-priority subject instead of leaving it blank." checked={advanced.noEmptySlots} onChange={(v) => setAdvanced((a) => ({ ...a, noEmptySlots: v }))} />
            </div>
          </AnimatedCard>
        </div>

        {/* ================= VALIDATION + GENERATE BUTTON ================= */}
        <AnimatedCard id="generate" className="mt-5 p-6 sm:p-8 text-center" delay={380}>
          <div className="mx-auto grid max-w-2xl gap-3 sm:grid-cols-3">
            <div className="rounded-2xl surface-blue p-3.5">
              <div className="text-[11px] font-medium t-secondary">AVAILABLE / WEEK</div>
              <div className="font-heading text-xl font-bold text-accent-blue">{totalWeeklyPeriods}</div>
            </div>
            <div className="rounded-2xl surface-emerald p-3.5">
              <div className="text-[11px] font-medium t-secondary">REQUIRED / WEEK</div>
              <div className="font-heading text-xl font-bold text-accent-emerald">{requiredPeriods}</div>
            </div>
            <div className="rounded-2xl surface-muted border p-3.5">
              <div className="text-[11px] font-medium t-secondary">SUBJECTS / LABS</div>
              <div className="font-heading text-xl font-bold t-primary">{config.subjects.length} / {config.labs.length}</div>
            </div>
          </div>

          {deficit > 0 ? (
            <div className="mx-auto mt-4 max-w-2xl rounded-2xl border surface-rose p-4 text-left text-sm text-accent-rose">
              <div className="flex items-center gap-2 font-medium"><AlertTriangle size={16} /> You need {deficit} more period{deficit > 1 ? "s" : ""} to fit everything in.</div>
              <ul className="mt-1.5 list-disc pl-5 space-y-0.5">
                <li>Add another working day, or increase periods per day.</li>
                <li>Lower the periods-per-week for a lower-priority subject.</li>
                <li>Reduce a lab's sessions per week or consecutive periods.</li>
              </ul>
            </div>
          ) : (
            <div className="mx-auto mt-4 flex max-w-2xl items-center gap-2 rounded-2xl border surface-emerald border-emerald-200/60 p-3.5 text-left text-sm text-accent-emerald">
              <Check size={16} /> You have {Math.abs(deficit)} spare period{Math.abs(deficit) !== 1 ? "s" : ""} of headroom. Ready to generate.
            </div>
          )}

          <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
            <PrimaryButton onClick={handleGenerateClick} disabled={deficit > 0 || activeDays.length === 0 || generating} icon={generating ? Loader2 : Wand2}
              className={`px-9 py-4 text-base ${deficit > 0 || activeDays.length === 0 ? "" : "animate-[softGlow_2.4s_ease-in-out_infinite]"}`}>
              {generating ? "Generating…" : "Generate Timetable"}
            </PrimaryButton>
            <GhostButton onClick={saveConfig} icon={Save}>Save this setup</GhostButton>
          </div>
          <p className="mt-3 text-xs t-secondary">This builds a fresh, conflict-free timetable from everything you've entered above.</p>
          {saveStatus === "saved" && <div className="mt-2 text-xs text-emerald-600">Setup saved.</div>}
        </AnimatedCard>

        {/* ================= GENERATED TIMETABLE ================= */}
        <div ref={resultRef} id="result" className="mt-5 scroll-mt-20">
          {generating && (
            <AnimatedCard className="flex items-center gap-3 p-5" delay={0}>
              <Loader2 className="animate-spin text-blue-500" size={20} />
              <span className="text-sm t-secondary">Placing labs, balancing subjects, resolving conflicts…</span>
            </AnimatedCard>
          )}

          {!generating && result && (
            <>
              <AnimatedCard className="mb-5 p-5 sm:p-6" delay={0}>
                <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                  <div>
                    <h2 className="font-heading text-xl font-bold t-primary">Your Timetable</h2>
                    <p className="text-sm t-secondary">Lock the periods you want to keep, then regenerate to reshuffle the rest.</p>
                  </div>
                  <div className="no-print flex flex-wrap items-center gap-2">
                    <GhostButton onClick={undo} disabled={historyIndex <= 0} icon={Undo2} />
                    <GhostButton onClick={redo} disabled={historyIndex >= history.length - 1} icon={Redo2} />
                    <PrimaryButton onClick={regenerate} icon={RefreshCw} disabled={generating}>Generate again</PrimaryButton>
                  </div>
                </div>

                {/* Stats */}
                <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
                  {[
                    { label: "Weekly periods", value: result.stats.totalSlots, tone: "surface-blue text-accent-blue" },
                    { label: "Busy %", value: `${result.stats.busyPct}%`, tone: "surface-emerald text-accent-emerald" },
                    { label: "Free slots", value: result.stats.free, tone: "surface-cyan text-accent-cyan" },
                    { label: "Unresolved", value: result.unplaced.length, tone: "surface-muted t-primary" },
                  ].map((st) => (
                    <div key={st.label} className={`rounded-2xl p-3.5 ${st.tone}`}>
                      <div className="text-[11px] font-medium opacity-70">{st.label.toUpperCase()}</div>
                      <div className="font-heading text-xl font-bold">{st.value}</div>
                    </div>
                  ))}
                </div>

                {result.unplaced.length > 0 && (
                  <div className="mb-5 rounded-2xl border surface-amber p-4 text-sm text-accent-amber">
                    <div className="flex items-center gap-2 font-medium"><AlertTriangle size={16} /> Some periods couldn't be placed:</div>
                    <ul className="mt-1.5 list-disc pl-5 space-y-0.5">
                      {result.unplaced.map((u, i) => (<li key={i}>{u.name}: {u.missing} period{u.missing > 1 ? "s" : ""} short.</li>))}
                    </ul>
                  </div>
                )}

                {/* Timetable table: sticky header, zebra rows, break columns styled distinctly */}
                <div className="max-h-[560px] overflow-auto rounded-2xl border border-themed">
                  <table className="w-full border-collapse text-sm">
                    <thead className="sticky top-0 z-10 thead-themed backdrop-blur">
                      <tr>
                        <th className="border-b divider-themed p-2.5 text-left text-xs font-semibold t-secondary">DAY</th>
                        {daySeq.map((slot, i) => (
                          <th key={i} className={`border-b divider-themed p-2.5 text-xs font-semibold ${slot.type === "break" ? "surface-cyan text-accent-cyan" : "t-secondary"}`}>
                            {slot.type === "period" ? `PERIOD ${slot.index}` : slot.name.toUpperCase()}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {activeDays.map((day, rowIdx) => (
                        <tr key={day} className={`transition-colors hover:bg-blue-500/5 ${rowIdx % 2 === 0 ? "row-alt" : "row-base"}`}>
                          <td className="border-b divider-themed p-2 text-sm font-semibold t-secondary">{DAY_SHORT[day]}</td>
                          {daySeq.map((slot, i) => {
                            if (slot.type === "break") {
                              return (
                                <td key={i} className="border-b divider-themed surface-cyan p-2 text-center text-[11px] text-accent-cyan">
                                  {slot.name}<br /><span className="opacity-70">{slot.duration}m</span>
                                </td>
                              );
                            }
                            const p = slot.index;
                            const e = result.grid[day][p];
                            const key = `${day}|${p}`;
                            const locked = !!lockedCells[key];
                            return (
                              <td key={i} className="border-b divider-themed p-1.5 align-top">
                                <div
                                  className="group relative h-[62px] min-w-[100px] rounded-xl border p-2 transition-all"
                                  style={e ? { backgroundColor: e.color + "1A", borderColor: e.color + "55" } : { borderStyle: "dashed", borderColor: "#e2e8f0" }}
                                >
                                  {e ? (
                                    <>
                                      <div className="flex items-center gap-1">
                                        <span className="h-1.5 w-1.5 shrink-0 rounded-full" style={{ backgroundColor: e.color }} />
                                        <span className="truncate text-[12px] font-semibold t-primary">{e.name}</span>
                                      </div>
                                      <div className="truncate text-[10.5px] t-secondary">{e.faculty}{e.room ? ` · ${e.room}` : ""}</div>
                                      <div className="pointer-events-none absolute left-1/2 top-full z-10 mt-1.5 w-44 -translate-x-1/2 rounded-lg border tooltip-themed p-2.5 text-[11px] t-secondary opacity-0 shadow-xl transition-opacity group-hover:opacity-100">
                                        <div><span className="t-tertiary">Faculty:</span> {e.faculty || "—"}</div>
                                        <div><span className="t-tertiary">Room:</span> {e.room || "—"}</div>
                                        <div><span className="t-tertiary">Type:</span> {e.kind === "lab" ? "Lab" : "Theory"}</div>
                                      </div>
                                      <button onClick={() => toggleLock(day, p)} className="no-print absolute right-1 top-1 t-tertiary hover:text-blue-500">
                                        {locked ? <Lock size={11} /> : <Unlock size={11} className="opacity-0 group-hover:opacity-100" />}
                                      </button>
                                    </>
                                  ) : (
                                    <div className="text-[11px] t-tertiary">Free</div>
                                  )}
                                </div>
                              </td>
                            );
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </AnimatedCard>

              {/* Utilisation */}
              <div className="grid gap-5 sm:grid-cols-2">
                <AnimatedCard className="p-5" delay={0}>
                  <div className="mb-3 text-xs font-semibold t-secondary">FACULTY UTILISATION</div>
                  <div className="space-y-2.5">
                    {Object.entries(result.stats.facultyLoad).map(([name, l]) => (
                      <div key={name}>
                        <div className="flex justify-between text-xs t-secondary"><span>{name}</span><span className="font-medium">{l.count}/{l.cap}</span></div>
                        <div className="mt-1 h-1.5 rounded-full surface-muted"><div className="h-full rounded-full bg-gradient-to-r from-blue-500 to-emerald-500" style={{ width: `${Math.min(100, l.pct)}%` }} /></div>
                      </div>
                    ))}
                    {Object.keys(result.stats.facultyLoad).length === 0 && <div className="text-xs t-tertiary">No faculty yet.</div>}
                  </div>
                </AnimatedCard>
                <AnimatedCard className="p-5" delay={40}>
                  <div className="mb-3 text-xs font-semibold t-secondary">ROOM UTILISATION</div>
                  <div className="space-y-2.5">
                    {Object.entries(result.stats.roomLoad).map(([room, count]) => (
                      <div key={room}>
                        <div className="flex justify-between text-xs t-secondary"><span>{room}</span><span className="font-medium">{count} periods/week</span></div>
                        <div className="mt-1 h-1.5 rounded-full surface-muted"><div className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-cyan-500" style={{ width: `${Math.min(100, count * 8)}%` }} /></div>
                      </div>
                    ))}
                    {Object.keys(result.stats.roomLoad).length === 0 && <div className="text-xs t-tertiary">No labs yet.</div>}
                  </div>
                </AnimatedCard>
              </div>

              {/* AI insight */}
              <AnimatedCard className="mt-5 p-5" delay={0}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-sm font-semibold t-primary"><Sparkles size={16} className="text-blue-500" /> AI Insight</div>
                  <GhostButton onClick={requestAIInsight} disabled={aiLoading} icon={aiLoading ? Loader2 : Wand2} className={aiLoading ? "[&>svg]:animate-spin" : ""}>
                    {aiLoading ? "Thinking…" : "Get suggestions"}
                  </GhostButton>
                </div>
                {aiNote && <p className="mt-3 whitespace-pre-line text-sm t-secondary">{aiNote}</p>}
              </AnimatedCard>

              {/* Exports */}
              <div className="no-print mt-5 flex flex-wrap gap-2.5">
                <GhostButton onClick={exportExcel} icon={Download}>Download Excel</GhostButton>
                <GhostButton onClick={printTimetable} icon={Printer}>Print</GhostButton>
                <GhostButton onClick={copyTimetable} icon={Copy}>Copy timetable</GhostButton>
                <GhostButton onClick={exportJSON} icon={FileJson}>Export JSON</GhostButton>
                <GhostButton onClick={saveConfig} icon={Save}>Save configuration</GhostButton>
                <GhostButton onClick={loadConfig} icon={FolderOpen}>Import configuration</GhostButton>
              </div>
              {saveStatus && (
                <div className="mt-2 text-xs t-secondary">
                  {saveStatus === "saved" && "Configuration saved."}
                  {saveStatus === "loaded" && "Configuration loaded."}
                  {saveStatus === "copied" && "Copied to clipboard."}
                  {saveStatus === "empty" && "No saved configuration found."}
                  {saveStatus === "error" && "Something went wrong — try again."}
                </div>
              )}
            </>
          )}

          {!generating && !result && (
            <AnimatedCard className="p-8 text-center" delay={0}>
              <BarChart3 className="mx-auto mb-2 t-tertiary" size={28} />
              <div className="text-sm t-secondary">Your generated timetable will appear here — fill in the setup above and click "Generate Timetable".</div>
            </AnimatedCard>
          )}
        </div>
      </div>
    </div>
    </ThemeContext.Provider>
  );
}
