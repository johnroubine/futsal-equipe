import React, { useState, useEffect, useMemo, useRef } from "react";
import { storage } from "./storage";

// K adaptatif : un joueur récent bouge vite (on ne sait rien de lui), un
// joueur avec beaucoup de matchs bouge plus lentement — mais jamais figé :
// le plancher K_MIN laisse une méforme se refléter en quelques séances.
const K_MAX = 44;
const K_MIN = 20;
const K_SCALE = 8; // nombre de matchs sur lequel le K se resserre
const kFor = (p) => K_MIN + (K_MAX - K_MIN) / (1 + (p.games || 0) / K_SCALE);
const START = 1000;

const expected = (diff) => 1 / (1 + Math.pow(10, -diff / 400));
// Une seule note par joueur. Les anciennes données portaient une note
// d'attaque et une de défense : on prend leur moyenne pour la reprise.
const overall = (p) =>
  Number.isFinite(p.rating) ? p.rating : ((p.off ?? START) + (p.def ?? START)) / 2;
const isActive = (p) => p.active !== false;

// Poids de l'ampleur de la victoire, en continu plutôt qu'en paliers. Un
// découpage en trois tranches rendait le résultat très sensible à la
// position des frontières : avec les écarts réellement observés, une
// victoire à 5 buts pouvait valoir ×1 ou ×1,6 selon le réglage. La forme
// logarithmique supprime cet effet de seuil et exploite tout le score.
// C = 2,2 a été calibré pour conserver la vitesse moyenne de l'ancien
// système sur l'historique existant. Un nul ou une victoire d'un but
// valent 1 : au-delà, l'ampleur compte, avec un rendement décroissant.
const MARGIN_C = 2.2;
const MARGIN_CAP = 2.5;
const marginMult = (diff) => {
  const d = Math.abs(diff);
  if (d <= 1) return 1;
  return Math.min(MARGIN_CAP, 1 + Math.log(d) / MARGIN_C);
};

function playerStats(name, matches) {
  let wins = 0,
    draws = 0,
    losses = 0,
    mvpOff = 0,
    mvpDef = 0,
    pm = 0;
  const history = [];
  for (const m of matches) {
    const inA = m.teamA.includes(name);
    const inB = m.teamB.includes(name);
    if (!inA && !inB) continue;
    let result;
    if (m.outcome === "draw") {
      result = "Nul";
      draws++;
    } else if ((inA && m.outcome === "A") || (inB && m.outcome === "B")) {
      result = "Victoire";
      wins++;
    } else {
      result = "Défaite";
      losses++;
    }
    // Différentiel de buts vu du joueur : positif s'il était du bon côté.
    if (Number.isFinite(m.diff)) pm += inA ? m.diff : -m.diff;
    if (m.mvpOffName === name) mvpOff++;
    if (m.mvpDefName === name) mvpDef++;
    history.push({ ...m, result });
  }
  // Séries de victoires. history va du plus récent au plus ancien, donc on
  // le parcourt à l'envers pour suivre le fil du temps. Un nul casse la
  // série au même titre qu'une défaite : une série, ce sont des victoires.
  let bestStreak = 0,
    run = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].result === "Victoire") {
      run += 1;
      if (run > bestStreak) bestStreak = run;
    } else run = 0;
  }
  let currentStreak = 0;
  for (const m of history) {
    if (m.result === "Victoire") currentStreak += 1;
    else break;
  }
  return { wins, draws, losses, mvpOff, mvpDef, pm, history, bestStreak, currentStreak };
}

// Paliers façon Unreal Tournament, transposés au futsal : enchaîner 5
// victoires y est déjà rare, là où le jeu demandait 25 frags pour Godlike.
const STREAK_TIERS = [
  { n: 10, label: "Wicked Sick" },
  { n: 8, label: "Godlike" },
  { n: 6, label: "Unstoppable" },
  { n: 5, label: "Dominating" },
  { n: 4, label: "Rampage" },
  { n: 3, label: "Killing Spree" },
];
const streakTier = (n) => STREAK_TIERS.find((t) => n >= t.n) || null;

// Incertitude affichée à côté de la note : large pour un nouveau, resserrée
// avec l'expérience. Traduit visuellement ce que fait le K adaptatif.
const uncertainty = (p) => Math.round(150 / Math.sqrt((p.games || 0) + 2) / 5) * 5;

// Forme récente : variation de la note combinée sur les N derniers matchs
// joués, calculée depuis les notes enregistrées après chaque match.
function recentForm(playerId, history, window = 5) {
  const snaps = [];
  for (const m of history) {
    const r = m.ratingsAfter && m.ratingsAfter[playerId];
    if (r) snaps.push(Number.isFinite(r.rating) ? r.rating : (r.off + r.def) / 2);
    if (snaps.length > window) break;
  }
  if (snaps.length < 2) return null;
  // history est du plus récent au plus ancien
  return snaps[0] - snaps[snaps.length - 1];
}
// ---- Statistiques de paires (duos et rivalités) ----
// Avec 20 joueurs dont 10 par séance, deux joueurs donnés ne sont dans la
// même équipe qu'un match sur dix environ : après 20 séances une paire n'a
// joué ensemble que 2 fois en moyenne. Un simple « plus de victoires »
// sacrerait donc la paire la plus chanceuse. D'où deux garde-fous : un
// minimum de matchs pour apparaître, et un lissage vers 50 % qui fait qu'une
// paire à 3/3 reste au coude à coude avec une paire à 9/12 au lieu de
// l'écraser, et une paire à 2 matchs n'apparaît pas du tout.
// Les six angles de l'onglet Affinités, avec leur pictogramme.
const AFF_VIEWS = [
  {
    key: "best",
    label: "Meilleurs",
    icon: "\u{1F91D}",
    desc: "les paires qui gagnent le plus souvent quand elles sont dans la m\u00eame \u00e9quipe",
  },
  {
    key: "worst",
    label: "Pires",
    icon: "\u{1F480}",
    desc: "les paires maudites : ensemble, \u00e7a ne passe pas",
  },
  {
    key: "nemesis",
    label: "B\u00eates noires",
    icon: "\u{1F479}",
    desc: "celui contre qui un joueur perd le plus souvent en face \u00e0 face",
  },
  {
    key: "explosive",
    label: "Explosifs",
    icon: "\u{1F4A5}",
    desc: "buts marqu\u00e9s en moyenne par leur \u00e9quipe quand ils jouent ensemble",
  },
  {
    key: "tight",
    label: "Duels serr\u00e9s",
    icon: "\u2694\ufe0f",
    desc: "les adversaires les plus proches du 50/50 : les vraies rivalit\u00e9s",
  },
  {
    key: "never",
    label: "Jamais vus",
    icon: "\u{1F47B}",
    desc: "les joueurs rod\u00e9s qui ne se sont jamais retrouv\u00e9s dans la m\u00eame \u00e9quipe",
  },
];
const affView0 = (key) => AFF_VIEWS.find((v) => v.key === key) || AFF_VIEWS[0];

const PAIR_MIN = 3; // matchs ensemble avant d'entrer au classement
const PAIR_PRIOR = 4; // force du lissage vers 50 %
const TIGHT_MIN = 5; // confrontations avant de parler de « rivalité serrée »
const smoothedRate = (w, d, n) => (w + 0.5 * d + PAIR_PRIOR * 0.5) / (n + PAIR_PRIOR);

// `activeNames` : un Set des noms encore à l'effectif. Les joueurs archivés
// (et ceux supprimés dont le nom traîne encore dans l'historique) sont
// écartés de toutes ces statistiques, pour que les podiums ne soient pas
// trustés par des paires qui ne rejoueront jamais.
function pairStats(matches, activeNames = null) {
  const mates = new Map(); // coéquipiers
  const foes = new Map(); // adversaires
  const keep = (n) => !activeNames || activeNames.has(n);
  const get = (map, key, init) => {
    if (!map.has(key)) map.set(key, init());
    return map.get(key);
  };

  for (const m of matches) {
    if (!Array.isArray(m.teamA) || !Array.isArray(m.teamB)) continue;
    const diff = Number.isFinite(m.diff) ? m.diff : 0;

    // Coéquipiers : toutes les paires à l'intérieur de chaque équipe.
    for (const [fullTeam, res, pm] of [
      [m.teamA, m.outcome === "draw" ? "d" : m.outcome === "A" ? "w" : "l", diff],
      [m.teamB, m.outcome === "draw" ? "d" : m.outcome === "B" ? "w" : "l", -diff],
    ]) {
      const team = fullTeam.filter(keep);
      for (let i = 0; i < team.length; i++) {
        for (let j = i + 1; j < team.length; j++) {
          const [n1, n2] = [team[i], team[j]].sort();
          const e = get(mates, `${n1}||${n2}`, () => ({
            a: n1,
            b: n2,
            w: 0,
            d: 0,
            l: 0,
            pm: 0,
            gf: 0, // buts marqués par leur équipe
            ga: 0, // buts encaissés
            nScored: 0, // matchs où le score détaillé est connu
          }));
          e[res] += 1;
          e.pm += pm;
          if (Number.isFinite(m.goalsA) && Number.isFinite(m.goalsB)) {
            const isA = fullTeam === m.teamA;
            e.gf += isA ? m.goalsA : m.goalsB;
            e.ga += isA ? m.goalsB : m.goalsA;
            e.nScored += 1;
          }
        }
      }
    }

    // Adversaires : toutes les paires à cheval sur les deux équipes.
    for (const pa of m.teamA.filter(keep)) {
      for (const pb of m.teamB.filter(keep)) {
        const [n1, n2] = [pa, pb].sort();
        const e = get(foes, `${n1}||${n2}`, () => ({
          a: n1,
          b: n2,
          aWins: 0,
          bWins: 0,
          draws: 0,
        }));
        if (m.outcome === "draw") e.draws += 1;
        else {
          // n1 est-il du côté vainqueur ?
          const n1OnA = n1 === pa;
          const n1Won = (m.outcome === "A") === n1OnA;
          if (n1Won) e.aWins += 1;
          else e.bWins += 1;
        }
      }
    }
  }

  // Duos : classés par taux de victoire lissé.
  const duos = [...mates.values()]
    .map((e) => {
      const n = e.w + e.d + e.l;
      return { ...e, n, rate: n === 0 ? 0 : (e.w + 0.5 * e.d) / n, score: smoothedRate(e.w, e.d, n) };
    })
    .filter((e) => e.n >= PAIR_MIN);

  // Rivalités : on retient le point de vue de celui qui perd le plus.
  const rivalries = [...foes.values()]
    .map((e) => {
      const n = e.aWins + e.bWins + e.draws;
      const aIsVictim = e.aWins <= e.bWins;
      const victim = aIsVictim ? e.a : e.b;
      const nemesis = aIsVictim ? e.b : e.a;
      const vWins = Math.min(e.aWins, e.bWins);
      const nWins = Math.max(e.aWins, e.bWins);
      return {
        victim,
        nemesis,
        vWins,
        nWins,
        draws: e.draws,
        n,
        // taux de défaite lissé de la victime face à sa bête noire
        score: smoothedRate(nWins, e.draws, n),
      };
    })
    .filter((e) => e.n >= PAIR_MIN);

  const frequentDuos = [...mates.values()]
    .map((e) => ({ ...e, n: e.w + e.d + e.l }))
    .sort((x, y) => y.n - x.n);

  // Duos les plus prolifiques : buts marqués en moyenne quand ils sont
  // ensemble. Ne compte que les matchs dont le score détaillé est connu.
  const explosive = [...mates.values()]
    .filter((e) => e.nScored >= PAIR_MIN)
    .map((e) => ({ ...e, n: e.w + e.d + e.l, gfAvg: e.gf / e.nScored, gaAvg: e.ga / e.nScored }))
    .sort((x, y) => y.gfAvg - x.gfAvg || y.nScored - x.nScored);

  // Rivalités les plus serrées : il faut plus de confrontations que pour un
  // podium, sinon un 1-1 ressort comme le duel du siècle.
  const tightest = [...foes.values()]
    .map((e) => {
      const n = e.aWins + e.bWins + e.draws;
      const rate = n === 0 ? 0.5 : (e.aWins + 0.5 * e.draws) / n;
      return { ...e, n, rate, gap: Math.abs(rate - 0.5) };
    })
    .filter((e) => e.n >= TIGHT_MIN)
    .sort((x, y) => x.gap - y.gap || y.n - x.n);

  return { duos, rivalries, frequentDuos, explosive, tightest, mates, foes };
}

// Vue personnelle : le coéquipier avec qui un joueur gagne le plus, et
// l'adversaire contre qui il perd le plus. Seuil plus bas que les podiums
// généraux, parce qu'on ne compare qu'au sein des paires d'un seul joueur.
const SOLO_MIN = 2;
function playerAffinities(name, mates, foes) {
  let bestAlly = null;
  for (const e of mates.values()) {
    if (e.a !== name && e.b !== name) continue;
    const n = e.w + e.d + e.l;
    if (n < SOLO_MIN) continue;
    const score = smoothedRate(e.w, e.d, n);
    if (!bestAlly || score > bestAlly.score) {
      bestAlly = { who: e.a === name ? e.b : e.a, w: e.w, d: e.d, l: e.l, n, score };
    }
  }
  let worstFoe = null;
  for (const e of foes.values()) {
    if (e.a !== name && e.b !== name) continue;
    const n = e.aWins + e.bWins + e.draws;
    if (n < SOLO_MIN) continue;
    const isA = e.a === name;
    const mine = isA ? e.aWins : e.bWins;
    const theirs = isA ? e.bWins : e.aWins;
    const score = smoothedRate(theirs, e.draws, n);
    if (!worstFoe || score > worstFoe.score) {
      worstFoe = {
        who: isA ? e.b : e.a,
        wins: mine,
        losses: theirs,
        draws: e.draws,
        n,
        score,
      };
    }
  }
  // Un allié qui ne fait pas gagner plus souvent qu'il ne fait perdre n'est
  // pas un allié, et un adversaire à 2V-2D n'est pas une bête noire : on
  // n'affiche que les bilans réellement marqués.
  if (bestAlly && bestAlly.w <= bestAlly.l) bestAlly = null;
  if (worstFoe && worstFoe.losses <= worstFoe.wins) worstFoe = null;
  return { bestAlly, worstFoe };
}

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// Rejoue tout l'historique depuis zéro. Indispensable dès qu'on touche à un
// match passé : son résultat change les notes qui suivent, donc celles de
// tous les matchs postérieurs. L'état de notation est tenu par NOM et non
// par identifiant, pour que les joueurs supprimés de l'effectif pèsent
// quand même dans les moyennes d'équipe des matchs où ils jouaient — sans
// quoi on recalculerait des matchs avec des équipes incomplètes.
// Avec une marge continue, le résultat ne dépend plus d'un palier stocké :
// rejouer l'historique redonne exactement les mêmes notes.
function replayHistory(players, matches) {
  const chrono = [...matches].reverse(); // du plus ancien au plus récent
  const nameToId = new Map(players.map((p) => [p.name, p.id]));
  const state = new Map();
  const st = (name) => {
    if (!state.has(name)) state.set(name, { name, rating: START, games: 0 });
    return state.get(name);
  };

  const rebuilt = chrono.map((m) => {
    if (!Array.isArray(m.teamA) || !Array.isArray(m.teamB) || !m.teamA.length || !m.teamB.length) {
      return m;
    }
    const diff = Number.isFinite(m.diff) ? m.diff : 0;
    const outcome = diff > 0 ? "A" : diff < 0 ? "B" : "draw";

    const teamA = m.teamA.map(st);
    const teamB = m.teamB.map(st);
    const { M, errA, errB } = computeErrorsFromOutcome(teamA, teamB, outcome, diff);

    const ratingsAfter = {};
    for (const [team, err] of [
      [teamA, errA],
      [teamB, errB],
    ]) {
      for (const p of team) {
        p.rating += kFor(p) * M * err;
        p.games += 1;
        if (p.name === m.mvpOffName) p.rating += MVP_BONUS;
        if (p.name === m.mvpDefName) p.rating += MVP_BONUS;
        const id = nameToId.get(p.name);
        if (id) ratingsAfter[id] = { rating: p.rating };
      }
    }
    return { ...m, outcome, ratingsAfter };
  });

  const nextPlayers = players.map((p) => {
    const s = state.get(p.name);
    return s
      ? { ...p, rating: s.rating, games: s.games }
      : { ...p, rating: START, games: 0 };
  });

  return { players: nextPlayers, matches: rebuilt.reverse() };
}

function combos(arr, k) {
  const res = [];
  const cur = [];
  function go(start) {
    if (cur.length === k) {
      res.push([...cur]);
      return;
    }
    for (let i = start; i < arr.length; i++) {
      cur.push(arr[i]);
      go(i + 1);
      cur.pop();
    }
  }
  go(0);
  return res;
}

const VARIETY_WEIGHT = 7; // en "points Elo équivalents" par binôme récemment répété

// Poids des binômes ayant déjà joué ensemble lors des derniers matchs :
// plus le match est récent, plus le binôme pèse. Sert à départager les
// répartitions d'équilibre équivalent en faveur du brassage.
function recentPairWeights(matches, depth = 4) {
  const w = new Map();
  matches.slice(0, depth).forEach((m, i) => {
    const weight = (depth - i) / depth; // 1 pour le dernier match, puis décroissant
    for (const team of [m.teamA, m.teamB]) {
      for (let a = 0; a < team.length; a++) {
        for (let b = a + 1; b < team.length; b++) {
          const key = [team[a], team[b]].sort().join("||");
          w.set(key, (w.get(key) || 0) + weight);
        }
      }
    }
  });
  return w;
}

function bestSplits(players, pairWeights = new Map()) {
  // players: array of player objects present this week
  const n = players.length;
  const half = Math.floor(n / 2);
  if (n < 2) return [];
  const idxCombos = combos(
    players.map((_, i) => i),
    half
  );
  const repeatCost = (team) => {
    let c = 0;
    for (let a = 0; a < team.length; a++) {
      for (let b = a + 1; b < team.length; b++) {
        const key = [team[a].name, team[b].name].sort().join("||");
        c += pairWeights.get(key) || 0;
      }
    }
    return c;
  };
  const seen = new Set();
  const options = [];
  for (const combo of idxCombos) {
    const setA = new Set(combo);
    const restIdx = players.map((_, i) => i).filter((i) => !setA.has(i));
    if (restIdx.length !== n - half) continue;
    const key = [...combo].sort((a, b) => a - b).join(",");
    const complementKey = [...restIdx].sort((a, b) => a - b).join(",");
    const dedupeKey = key < complementKey ? key : complementKey;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    const teamA = combo.map((i) => players[i]);
    const teamB = restIdx.map((i) => players[i]);
    const sumA = teamA.reduce((s, p) => s + overall(p), 0);
    const sumB = teamB.reduce((s, p) => s + overall(p), 0);
    const balance = Math.abs(sumA - sumB);
    const repeats = repeatCost(teamA) + repeatCost(teamB);
    const score = balance + VARIETY_WEIGHT * repeats;
    options.push({ teamA, teamB, diff: balance, repeats, score, sumA, sumB });
  }
  options.sort((a, b) => a.score - b.score);
  return options.slice(0, 5);
}

// Poids du vote MVP, ajouté à la note du joueur élu. Avec une note unique,
// être élu meilleur attaquant ET meilleur défenseur cumule les deux bonus.
// 15 représente un peu moins d'un résultat de match type : assez pour
// récompenser une grosse soirée, pas assez pour écraser le résultat.
const MVP_BONUS = 15;

// Renvoie le multiplicateur d'ampleur et l'erreur de chaque équipe
// (performance observée − attendue). Le delta d'un joueur vaut ensuite
// err × son K personnel × ce multiplicateur.
function computeErrorsFromOutcome(teamA, teamB, outcome, diff) {
  const avg = (arr) => arr.reduce((s, p) => s + overall(p), 0) / arr.length;
  const rA = avg(teamA),
    rB = avg(teamB);
  const M = marginMult(diff);
  const sA = outcome === "A" ? 1 : outcome === "draw" ? 0.5 : 0;
  const sB = 1 - sA;

  return { M, errA: sA - expected(rA - rB), errB: sB - expected(rB - rA) };
}

// Petite courbe de progression (attaque en rouge, défense en bleu) tracée à
// partir des notes enregistrées après chaque match.
const Sparkline = ({ series, width = 300, height = 64 }) => {
  const all = series.flatMap((s) => s.values);
  if (all.length < 2) return null;
  const min = Math.min(...all);
  const max = Math.max(...all);
  const span = max - min || 1;
  const pad = 4;
  const x = (i, n) => pad + (i * (width - 2 * pad)) / Math.max(1, n - 1);
  const y = (v) => height - pad - ((v - min) / span) * (height - 2 * pad);
  return (
    <svg viewBox={`0 0 ${width} ${height}`} style={{ width: "100%", height, display: "block" }}>
      {series.map((s) => (
        <polyline
          key={s.label}
          fill="none"
          stroke={s.color}
          strokeWidth="2"
          strokeLinejoin="round"
          points={s.values.map((v, i) => `${x(i, s.values.length)},${y(v)}`).join(" ")}
        />
      ))}
    </svg>
  );
};

const Badge = ({ children, tone = "default" }) => {
  const tones = {
    default: { background: "#E7ECEE", color: "#001E50" },
    off: { background: "#FBE1E2", color: "#B4000F" },
    def: { background: "#DCE3F2", color: "#001E50" },
  };
  return (
    <span
      style={{
        ...tones[tone],
        fontFamily: "'Manrope', sans-serif",
        borderRadius: 4,
        padding: "2px 7px",
        fontSize: 12.5,
        fontWeight: 700,
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {children}
    </span>
  );
};

export default function App() {
  const [players, setPlayers] = useState([]);
  const [matches, setMatches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [newName, setNewName] = useState("");
  const [present, setPresent] = useState(new Set());
  const [optIdx, setOptIdx] = useState(0);
  const [options, setOptions] = useState([]);
  const [teamA, setTeamA] = useState([]);
  const [teamB, setTeamB] = useState([]);
  const [selSwap, setSelSwap] = useState(null);
  const [scoreA, setScoreA] = useState("");
  const [scoreB, setScoreB] = useState("");
  const [mvpOff, setMvpOff] = useState("");
  const [mvpDef, setMvpDef] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [expandedPlayerId, setExpandedPlayerId] = useState(null);
  const [undo, setUndo] = useState(null);
  const [renamingId, setRenamingId] = useState(null);
  const [renameValue, setRenameValue] = useState("");
  const [tab, setTab] = useState("seance"); // "seance" | "classement"
  const [recordSort, setRecordSort] = useState("wins"); // "wins" | "streak" | "pm" | "pct" | "games"
  const [affView, setAffView] = useState("best"); // "best" | "worst" | "nemesis"
  const [editingId, setEditingId] = useState(null); // match en cours de correction
  const [editMode, setEditMode] = useState("score"); // "score" | "margin"
  const [editA, setEditA] = useState("");
  const [editB, setEditB] = useState("");
  const [editMargin, setEditMargin] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const p = await storage.get("futsal-players").catch(() => null);
        const m = await storage.get("futsal-matches").catch(() => null);
        const u = await storage.get("futsal-undo").catch(() => null);
        let loadedPlayers = p ? JSON.parse(p.value) : [];
        let loadedMatches = m ? JSON.parse(m.value) : [];

        // Reprise des données d'avant la note unique : les joueurs portaient
        // une note d'attaque et une de défense, calculées par paliers
        // d'écart. On rejoue tout l'historique sous le nouveau modèle pour
        // repartir d'un classement cohérent, puis on l'enregistre.
        const needsMigration =
          loadedPlayers.length > 0 && loadedPlayers.some((x) => !Number.isFinite(x.rating));
        if (needsMigration) {
          const r = replayHistory(loadedPlayers, loadedMatches);
          loadedPlayers = r.players.map(({ off, def, ...rest }) => rest);
          loadedMatches = r.matches;
          // Une seule ligne par appel : le portage vers la version web
          // réécrit ces appels de stockage ligne par ligne.
          await storage.set("futsal-players", JSON.stringify(loadedPlayers)).catch(() => {});
          await storage.set("futsal-matches", JSON.stringify(loadedMatches)).catch(() => {});
          setNotice(
            "Classement recalculé : une note unique par joueur, et l'ampleur des victoires compte désormais en continu."
          );
        }
        setPlayers(loadedPlayers);
        setMatches(loadedMatches);
        if (u) {
          const snap = JSON.parse(u.value);
          if (snap && Array.isArray(snap.players)) setUndo(snap);
        }
      } catch (e) {
        setError("Chargement impossible, on repart d'une base vide.");
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const persistPlayers = async (next) => {
    setPlayers(next);
    try {
      await storage.set("futsal-players", JSON.stringify(next));
    } catch (e) {
      setError("Échec de la sauvegarde de l'effectif.");
    }
  };
  const persistMatches = async (next) => {
    setMatches(next);
    try {
      await storage.set("futsal-matches", JSON.stringify(next));
    } catch (e) {
      setError("Échec de la sauvegarde de l'historique.");
    }
  };

  const persistUndo = async (snap) => {
    setUndo(snap);
    try {
      await storage.set("futsal-undo", JSON.stringify(snap));
    } catch (e) {
      // l'annulation est un confort : si la sauvegarde échoue, on n'alerte pas
    }
  };

  const fileInputRef = useRef(null);

  const exportData = () => {
    const payload = {
      exportedAt: new Date().toISOString(),
      players,
      matches,
    };
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const date = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `futsal-export-${date}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const importData = (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (!Array.isArray(data.players) || !Array.isArray(data.matches)) {
          setError("Fichier invalide : structure inattendue.");
          return;
        }
        if (
          !window.confirm(
            `Importer ce fichier remplacera l'effectif actuel (${players.length} joueurs) et l'historique (${matches.length} matchs) par ceux du fichier (${data.players.length} joueurs, ${data.matches.length} matchs). Continuer ?`
          )
        )
          return;
        persistPlayers(data.players);
        persistMatches(data.matches);
        setError("");
      } catch (err) {
        setError("Impossible de lire ce fichier (JSON invalide).");
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  // Une seule pile d'annulation pour les deux cas : enregistrement d'un
  // match et correction de l'historique. Le snapshot porte l'effectif ET la
  // liste des matchs, donc restaurer revient à remettre les deux en place.
  const undoLast = () => {
    if (!undo || !Array.isArray(undo.players) || !Array.isArray(undo.matches)) {
      setError("Rien à annuler.");
      return;
    }
    setError("");
    persistPlayers(undo.players);
    persistMatches(undo.matches);
    persistUndo(null);
    closeEditor();
  };

  const openEditor = (m) => {
    setEditingId(m.id);
    const known = Number.isFinite(m.goalsA) && Number.isFinite(m.goalsB);
    setEditMode(known ? "score" : "margin");
    setEditA(known ? String(m.goalsA) : "");
    setEditB(known ? String(m.goalsB) : "");
    setEditMargin(Number.isFinite(m.diff) ? String(m.diff) : "");
    setError("");
  };

  const closeEditor = () => {
    setEditingId(null);
    setEditA("");
    setEditB("");
    setEditMargin("");
  };

  // Applique une liste de matchs modifiée : on rejoue tout l'historique pour
  // que les notes redeviennent cohérentes, et on garde de quoi annuler.
  const applyHistoryChange = (nextMatches) => {
    const replayed = replayHistory(players, nextMatches);
    persistUndo({ players, matches, savedAt: new Date().toISOString(), kind: "edit" });
    persistPlayers(replayed.players);
    persistMatches(replayed.matches);
    closeEditor();
  };

  const saveMatchEdit = (m) => {
    let goalsA, goalsB, diff;
    if (editMode === "score") {
      const gA = Number(editA);
      const gB = Number(editB);
      if (
        editA.trim() === "" ||
        editB.trim() === "" ||
        !Number.isFinite(gA) ||
        !Number.isFinite(gB) ||
        gA < 0 ||
        gB < 0
      ) {
        setError("Entre le score des deux équipes (deux nombres positifs ou zéro).");
        return;
      }
      goalsA = gA;
      goalsB = gB;
      diff = gA - gB;
    } else {
      const d = Number(editMargin);
      if (editMargin.trim() === "" || !Number.isFinite(d)) {
        setError("Entre un écart valide (positif si A gagne, négatif si B gagne, 0 si nul).");
        return;
      }
      // Mode écart seul : on retire le score détaillé plutôt que d'inventer
      // des buts, sinon les duos explosifs seraient calculés sur du vide.
      goalsA = undefined;
      goalsB = undefined;
      diff = d;
    }
    setError("");
    const updated = { ...m, goalsA, goalsB, diff };
    if (goalsA === undefined) {
      delete updated.goalsA;
      delete updated.goalsB;
    }
    // On efface le palier pour qu'il soit réévalué avec le nouvel écart ;
    // tous les autres matchs gardent le leur et sont rejoués à l'identique.
    delete updated.tier;
    applyHistoryChange(matches.map((x) => (x.id === m.id ? updated : x)));
  };

  const deleteMatch = (m) => {
    const when = new Date(m.date).toLocaleDateString("fr-FR", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    });
    if (
      !window.confirm(
        `Supprimer le match du ${when} ? Toutes les notes seront recalculées sans lui. L'action reste annulable juste après.`
      )
    )
      return;
    setError("");
    applyHistoryChange(matches.filter((x) => x.id !== m.id));
  };

  const renamePlayer = (id, rawName) => {
    const name = rawName.trim();
    const old = players.find((p) => p.id === id);
    if (!old || !name || name === old.name) return;
    if (players.some((p) => p.id !== id && p.name === name)) {
      setError("Un autre joueur porte déjà ce nom.");
      return;
    }
    setError("");
    persistPlayers(players.map((p) => (p.id === id ? { ...p, name } : p)));
    // L'historique stocke les noms : on le réécrit pour ne pas perdre le passé.
    const swap = (n) => (n === old.name ? name : n);
    persistMatches(
      matches.map((m) => ({
        ...m,
        teamA: m.teamA.map(swap),
        teamB: m.teamB.map(swap),
        mvpOffName: m.mvpOffName ? swap(m.mvpOffName) : m.mvpOffName,
        mvpDefName: m.mvpDefName ? swap(m.mvpDefName) : m.mvpDefName,
      }))
    );
    setRenamingId(null);
    setRenameValue("");
  };

  const addPlayer = () => {
    const name = newName.trim();
    if (!name) return;
    persistPlayers([...players, { id: uid(), name, off: START, def: START, games: 0, active: true }]);
    setNewName("");
  };

  const toggleActive = (id) => {
    persistPlayers(players.map((p) => (p.id === id ? { ...p, active: !isActive(p) } : p)));
    setPresent((prev) => {
      const n = new Set(prev);
      n.delete(id);
      return n;
    });
  };

  const removePlayer = (id) => {
    const p = players.find((x) => x.id === id);
    if (
      p &&
      !window.confirm(
        `Supprimer définitivement ${p.name} ? Sa fiche et ses notes seront perdues (son nom restera dans l'historique des matchs).`
      )
    )
      return;
    persistPlayers(players.filter((x) => x.id !== id));
    setPresent((prev) => {
      const n = new Set(prev);
      n.delete(id);
      return n;
    });
  };

  const clearPresent = () => {
    setPresent(new Set());
    setTeamA([]);
    setTeamB([]);
    setOptions([]);
    setSelSwap(null);
  };

  const togglePresent = (id) => {
    setPresent((prev) => {
      const n = new Set(prev);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
    setTeamA([]);
    setTeamB([]);
    setOptions([]);
  };

  const generate = () => {
    const list = players.filter((p) => present.has(p.id));
    if (list.length < 4) {
      setError("Sélectionne au moins 4 joueurs présents.");
      return;
    }
    if (list.length % 2 !== 0) {
      setError(
        `${list.length} joueurs sélectionnés : il en faut un nombre pair pour former deux équipes égales (10 pour du 5 contre 5).`
      );
      return;
    }
    setError("");
    const opts = bestSplits(list, recentPairWeights(matches));
    setOptions(opts);
    setOptIdx(0);
    setTeamA(opts[0].teamA);
    setTeamB(opts[0].teamB);
    setScoreA("");
    setScoreB("");
    setMvpOff("");
    setMvpDef("");
  };

  const cycleOption = () => {
    if (options.length < 2) return;
    const next = (optIdx + 1) % options.length;
    setOptIdx(next);
    setTeamA(options[next].teamA);
    setTeamB(options[next].teamB);
  };

  const clickSwap = (player, side) => {
    if (!selSwap) {
      setSelSwap({ player, side });
      return;
    }
    if (selSwap.side === side) {
      setSelSwap({ player, side });
      return;
    }
    // swap between the two sides
    if (side === "B") {
      setTeamA(teamA.map((p) => (p.id === selSwap.player.id ? player : p)));
      setTeamB(teamB.map((p) => (p.id === player.id ? selSwap.player : p)));
    } else {
      setTeamB(teamB.map((p) => (p.id === selSwap.player.id ? player : p)));
      setTeamA(teamA.map((p) => (p.id === player.id ? selSwap.player : p)));
    }
    setSelSwap(null);
  };


  const saveResult = () => {
    const gA = Number(scoreA);
    const gB = Number(scoreB);
    if (
      scoreA.trim() === "" ||
      scoreB.trim() === "" ||
      !Number.isFinite(gA) ||
      !Number.isFinite(gB) ||
      gA < 0 ||
      gB < 0
    ) {
      setError("Entre le score des deux équipes (deux nombres positifs ou zéro).");
      return;
    }
    if (teamA.length === 0 || teamB.length === 0) {
      setError("Génère d'abord les deux équipes.");
      return;
    }
    setError("");
    const diff = gA - gB;
    const outcome = diff > 0 ? "A" : diff < 0 ? "B" : "draw";
    const { M, errA, errB } = computeErrorsFromOutcome(teamA, teamB, outcome, diff);
    const idsA = new Set(teamA.map((p) => p.id));
    const idsB = new Set(teamB.map((p) => p.id));
    const ratingsAfter = {};
    const next = players.map((p) => {
      const inA = idsA.has(p.id);
      if (!inA && !idsB.has(p.id)) return p;
      let rating = overall(p) + kFor(p) * M * (inA ? errA : errB);
      if (p.id === mvpOff) rating += MVP_BONUS;
      if (p.id === mvpDef) rating += MVP_BONUS;
      ratingsAfter[p.id] = { rating };
      return { ...p, rating, games: p.games + 1 };
    });
    const allNames = new Map([...teamA, ...teamB].map((p) => [p.id, p.name]));
    // Snapshot d'avant-match, pour pouvoir annuler la dernière saisie.
    persistUndo({ players, matches, savedAt: new Date().toISOString(), kind: "match" });
    persistPlayers(next);
    persistMatches([
      {
        id: uid(),
        date: new Date().toISOString(),
        teamA: teamA.map((p) => p.name),
        teamB: teamB.map((p) => p.name),
        goalsA: gA,
        goalsB: gB,
        diff,
        outcome,
        mvpOffName: allNames.get(mvpOff) || null,
        mvpDefName: allNames.get(mvpDef) || null,
        ratingsAfter,
      },
      ...matches,
    ]);
    setTeamA([]);
    setTeamB([]);
    setOptions([]);
    setPresent(new Set());
    setScoreA("");
    setScoreB("");
    setMvpOff("");
    setMvpDef("");
    setSelSwap(null);
  };

  const leaderboard = useMemo(
    () => [...players].filter(isActive).sort((a, b) => overall(b) - overall(a)),
    [players]
  );
  const archived = useMemo(
    () => [...players].filter((p) => !isActive(p)).sort((a, b) => a.name.localeCompare(b.name)),
    [players]
  );
  const ranked = useMemo(() => {
    return [...players].filter(isActive).sort((a, b) => overall(b) - overall(a));
  }, [players]);

  // Bilan V/N/D par joueur actif. Le pourcentage compte un nul comme un
  // demi-succès, et se calcule sur les matchs effectivement joués.
  const records = useMemo(() => {
    const rows = players.filter(isActive).map((p) => {
      const s = playerStats(p.name, matches);
      const played = s.wins + s.draws + s.losses;
      const pct = played === 0 ? null : ((s.wins + 0.5 * s.draws) / played) * 100;
      const pmAvg = played === 0 ? null : s.pm / played;
      return { id: p.id, name: p.name, ...s, played, pct, pmAvg };
    });
    rows.sort((a, b) => {
      if (recordSort === "wins") return b.wins - a.wins || b.played - a.played;
      if (recordSort === "games") return b.played - a.played || b.wins - a.wins;
      if (recordSort === "streak")
        return b.bestStreak - a.bestStreak || b.wins - a.wins || b.played - a.played;
      if (recordSort === "pm") {
        if (a.pmAvg === null && b.pmAvg === null) return a.name.localeCompare(b.name);
        if (a.pmAvg === null) return 1;
        if (b.pmAvg === null) return -1;
        return b.pmAvg - a.pmAvg || b.played - a.played;
      }
      // "pct" : les joueurs sans match joué passent en dernier
      if (a.pct === null && b.pct === null) return a.name.localeCompare(b.name);
      if (a.pct === null) return 1;
      if (b.pct === null) return -1;
      return b.pct - a.pct || b.played - a.played;
    });
    return rows;
  }, [players, matches, recordSort]);

  // Duos et rivalités. Calculés sur tout l'historique, y compris les joueurs
  // archivés : un duo mythique reste un duo mythique même si l'un a arrêté.
  const affinites = useMemo(() => {
    const activeNames = new Set(players.filter(isActive).map((p) => p.name));
    const r = pairStats(matches, activeNames);
    // Jamais-vus : paires de joueurs actifs qui n'ont jamais été coéquipiers.
    // On n'exige pas qu'ils soient tous deux rodés, mais on écarte les joueurs
    // qui ont à peine joué, sinon un nouveau venu remplit toute la liste.
    const eligible = players.filter((p) => isActive(p) && (p.games || 0) >= PAIR_MIN);
    const never = [];
    for (let i = 0; i < eligible.length; i++) {
      for (let j = i + 1; j < eligible.length; j++) {
        const [n1, n2] = [eligible[i].name, eligible[j].name].sort();
        if (!r.mates.has(`${n1}||${n2}`)) {
          never.push({ a: n1, b: n2, games: Math.min(eligible[i].games, eligible[j].games) });
        }
      }
    }
    never.sort((x, y) => y.games - x.games);
    return { ...r, never, totalPairs: r.frequentDuos.length };
  }, [matches, players]);

  const affList = useMemo(() => {
    if (affView === "nemesis") {
      return [...affinites.rivalries].sort((a, b) => b.score - a.score || b.n - a.n).slice(0, 10);
    }
    if (affView === "explosive") return affinites.explosive.slice(0, 10);
    if (affView === "tight") return affinites.tightest.slice(0, 10);
    if (affView === "never") return affinites.never.slice(0, 12);
    const sorted = [...affinites.duos].sort((a, b) => b.score - a.score || b.n - a.n);
    return (affView === "worst" ? sorted.reverse() : sorted).slice(0, 10);
  }, [affinites, affView]);

  if (loading) {
    return (
      <div style={{ fontFamily: "system-ui", padding: 24, color: "#001E50" }}>
        Chargement…
      </div>
    );
  }

  return (
    <div
      style={{
        fontFamily: "'Manrope', system-ui, sans-serif",
        background: "#F7F8FA",
        color: "#16171A",
        minHeight: "100%",
        padding: "0 0 96px 0",
      }}
    >
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Manrope:wght@500;600;700;800&family=Roboto+Mono:wght@500;700&display=swap');
        .of-title { font-family: 'Manrope', sans-serif; letter-spacing: -0.01em; }
        button { cursor: pointer; font-family: inherit; }
        input[type=text], input[type=number] { font-family: inherit; }
      `}</style>

      <div style={{ background: "#001E50", padding: "13px 18px 0", position: "relative" }}>
        <div
          style={{
            position: "absolute",
            top: 13,
            right: 18,
            width: 20,
            height: 20,
            borderRadius: "50%",
            background: "radial-gradient(circle, #E1000F 0 33%, #FFFFFF 33% 66%, #001E50 66% 100%)",
            boxShadow: "0 0 0 1px rgba(255,255,255,0.3)",
          }}
        />
        <div className="of-title" style={{ color: "#FFFFFF", fontSize: 15.5, fontWeight: 800 }}>
          Futsal — équipes équilibrées
        </div>
        <div style={{ color: "#8FA3C8", fontSize: 11.5, marginTop: 2 }}>
          {leaderboard.length} joueurs actifs
        </div>
        <div style={{ display: "flex", marginTop: 11 }}>
          {[
            { key: "seance", label: "Séance" },
            { key: "classement", label: "Classement" },
            { key: "bilan", label: "Bilan" },
            { key: "affinites", label: "Affinités" },
          ].map((t) => (
            <button
              key={t.key}
              onClick={() => setTab(t.key)}
              style={{
                flex: 1,
                background: "none",
                border: "none",
                borderBottom: tab === t.key ? "2px solid #E1000F" : "2px solid transparent",
                color: tab === t.key ? "#FFFFFF" : "#8FA3C8",
                fontWeight: 700,
                fontSize: 12.5,
                padding: "0 0 9px",
              }}
            >
              {t.label}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div style={{ background: "#FBE9C9", color: "#7A4B00", padding: "8px 20px", fontSize: 13 }}>
          {error}
        </div>
      )}

      {notice && (
        <div
          style={{
            background: "#E7ECF5",
            color: "#001E50",
            padding: "9px 20px",
            fontSize: 12.5,
            display: "flex",
            gap: 10,
            alignItems: "flex-start",
          }}
        >
          <div style={{ flex: 1 }}>{notice}</div>
          <button
            onClick={() => setNotice("")}
            style={{
              background: "none",
              border: "none",
              color: "#001E50",
              fontSize: 14,
              fontWeight: 700,
              padding: 0,
            }}
            aria-label="Masquer"
          >
            ✕
          </button>
        </div>
      )}

      {tab === "classement" && (
        <section style={{ padding: "18px 20px" }}>
          <div className="of-title" style={{ fontSize: 15, marginBottom: 10, color: "#001E50" }}>
            Classement
          </div>
          {ranked.length === 0 ? (
            <div style={{ fontSize: 13, color: "#6B6C72" }}>
              Aucun joueur actif pour l'instant.
            </div>
          ) : (
            <div>
              {ranked.map((p, i) => (
                <div
                  key={p.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    borderBottom: "1px solid #F0F1F4",
                    padding: "10px 2px",
                  }}
                >
                  <div
                    style={{
                      width: 22,
                      fontFamily: "'Roboto Mono', monospace",
                      fontSize: 12.5,
                      fontWeight: 700,
                      color: i < 3 ? "#001E50" : "#A8ABB2",
                    }}
                  >
                    {i + 1}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 700, color: "#16171A" }}>{p.name}</div>
                    {(() => {
                      const form = recentForm(p.id, playerStats(p.name, matches).history);
                      return (
                        <div style={{ fontSize: 10, fontWeight: 600, color: "#A8ABB2", marginTop: 1 }}>
                          ± {uncertainty(p)} · {p.games} match{p.games > 1 ? "s" : ""}
                          {form !== null && Math.abs(form) >= 1
                            ? ` · forme ${form > 0 ? "↑ +" : "↓ "}${Math.round(form)}`
                            : ""}
                        </div>
                      );
                    })()}
                  </div>
                  <div
                    style={{
                      width: 54,
                      textAlign: "right",
                      fontFamily: "'Roboto Mono', monospace",
                      fontSize: 17,
                      fontWeight: 700,
                      color: "#001E50",
                    }}
                  >
                    {Math.round(overall(p))}
                  </div>
                </div>
              ))}
            </div>
          )}
          <div style={{ fontSize: 11.5, color: "#6B6C72", marginTop: 10, lineHeight: 1.5 }}>
            Joueurs actifs uniquement. Tout le monde part de 1000 ; la note monte ou descend selon
            le résultat et l'ampleur du score, en tenant compte de la force des deux équipes. Le ±
            indique la marge d'incertitude : elle se resserre à mesure que le joueur accumule des
            matchs.
          </div>
        </section>
      )}

      {tab === "bilan" && (
        <section style={{ padding: "18px 20px" }}>
          <div className="of-title" style={{ fontSize: 15, marginBottom: 10, color: "#001E50" }}>
            Bilan victoires / défaites
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
              gap: 6,
              marginBottom: 12,
            }}
          >
            {[
              { key: "wins", label: "Victoires" },
              { key: "streak", label: "Série" },
              { key: "pm", label: "+/- moyen" },
              { key: "pct", label: "% vict." },
              { key: "games", label: "Matchs" },
            ].map((s) => (
              <button
                key={s.key}
                onClick={() => setRecordSort(s.key)}
                style={{
                  padding: "8px 4px",
                  borderRadius: 6,
                  border: recordSort === s.key ? "2px solid #001E50" : "1px solid #E1E3E8",
                  background: recordSort === s.key ? "#E7ECF5" : "#FFFFFF",
                  fontWeight: 600,
                  fontSize: 11.5,
                }}
              >
                {s.label}
              </button>
            ))}
          </div>

          {records.length === 0 ? (
            <div style={{ fontSize: 13, color: "#6B6C72" }}>Aucun joueur actif pour l'instant.</div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {records.map((r, i) => (
                <div
                  key={r.id}
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    background: "#FFFFFF",
                    border: "1px solid #E1E3E8",
                    borderRadius: 8,
                    padding: "8px 10px",
                  }}
                >
                  <div
                    style={{
                      width: 22,
                      fontSize: 13,
                      fontWeight: 700,
                      color: i < 3 ? "#E1000F" : "#6B6C72",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {i + 1}
                  </div>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 14, fontWeight: 600 }}>{r.name}</div>
                    <div style={{ fontSize: 11.5, color: "#6B6C72", marginTop: 1 }}>
                      {r.played === 0
                        ? "aucun match joué"
                        : `${r.wins}V · ${r.draws}N · ${r.losses}D sur ${r.played} match${r.played > 1 ? "s" : ""}`}
                      {matches.length > 0
                        ? ` · présence ${Math.round((r.played / matches.length) * 100)} %`
                        : ""}
                    </div>
                  </div>
                  {(() => {
                    // La valeur de droite suit le tri choisi : on met en avant
                    // le chiffre sur lequel le classement est fait.
                    const tier = streakTier(r.bestStreak);
                    let big, small, color;
                    if (recordSort === "streak") {
                      big = r.bestStreak > 0 ? `${r.bestStreak}` : "—";
                      small = tier ? tier.label : r.bestStreak > 0 ? "d'affilée" : "";
                      color = tier ? "#B2790A" : "#001E50";
                    } else if (recordSort === "pm") {
                      big =
                        r.pmAvg === null ? "—" : `${r.pmAvg >= 0 ? "+" : ""}${r.pmAvg.toFixed(1)}`;
                      small = r.pct === null ? "" : `${Math.round(r.pct)} % vict.`;
                      color = r.pmAvg === null ? "#6B6C72" : r.pmAvg >= 0 ? "#001E50" : "#B4000F";
                    } else if (recordSort === "pct") {
                      big = r.pct === null ? "—" : `${Math.round(r.pct)}%`;
                      small = `${r.wins}V`;
                      color = "#001E50";
                    } else if (recordSort === "games") {
                      big = `${r.played}`;
                      small = "matchs";
                      color = "#001E50";
                    } else {
                      big = `${r.wins}`;
                      small = r.pct === null ? "victoires" : `${Math.round(r.pct)} % vict.`;
                      color = "#001E50";
                    }
                    return (
                      <div style={{ textAlign: "right", minWidth: 62 }}>
                        <div
                          style={{
                            fontSize: 15,
                            fontWeight: 700,
                            color,
                            fontVariantNumeric: "tabular-nums",
                          }}
                        >
                          {big}
                        </div>
                        <div
                          style={{
                            fontSize: 10.5,
                            color: recordSort === "streak" && tier ? "#B2790A" : "#6B6C72",
                            fontWeight: recordSort === "streak" && tier ? 700 : 400,
                          }}
                        >
                          {small}
                        </div>
                      </div>
                    );
                  })()}
                </div>
              ))}
            </div>
          )}
          {(() => {
            const top = records.reduce(
              (best, r) => (!best || r.bestStreak > best.bestStreak ? r : best),
              null
            );
            if (!top || top.bestStreak < 2) return null;
            const tier = streakTier(top.bestStreak);
            const live = records.filter((r) => r.currentStreak >= 2);
            return (
              <div
                style={{
                  marginTop: 14,
                  background: "#F4F5F8",
                  border: "1px solid #DDE0E6",
                  borderRadius: 8,
                  padding: "10px 12px",
                  fontSize: 12,
                  color: "#3A3B41",
                }}
              >
                <strong style={{ color: "#001E50" }}>Série record</strong> — {top.name},{" "}
                {top.bestStreak} victoires d'affilée
                {tier ? (
                  <strong style={{ color: "#B2790A" }}> « {tier.label} »</strong>
                ) : null}
                .
                {live.length > 0 ? (
                  <div style={{ marginTop: 4, color: "#6B6C72" }}>
                    En cours :{" "}
                    {live
                      .sort((a, b) => b.currentStreak - a.currentStreak)
                      .map((r) => `${r.name} (${r.currentStreak})`)
                      .join(", ")}
                  </div>
                ) : null}
              </div>
            );
          })()}
          <div style={{ fontSize: 11.5, color: "#6B6C72", marginTop: 10, lineHeight: 1.5 }}>
            Classement par nombre total de victoires. La <strong>série</strong> est la plus longue
            suite de victoires consécutives, un nul la casse au même titre qu'une défaite ; les
            paliers reprennent ceux d'Unreal Tournament, transposés au futsal (3 = Killing Spree,
            5 = Dominating, 8 = Godlike, 10 = Wicked Sick). Le <strong>+/- moyen</strong> est
            l'écart de buts moyen des matchs joués, vu du côté du joueur : il tient compte de
            l'ampleur des résultats, pas seulement du gagnant. Le nul compte comme un demi-succès
            dans le pourcentage. Attention aux petits échantillons : tout cela est très bruité en
            dessous d'une dizaine de matchs, et dépend aussi des coéquipiers.
          </div>
        </section>
      )}

      {tab === "affinites" && (
        <section style={{ padding: "18px 20px" }}>
          <div className="of-title" style={{ fontSize: 15, marginBottom: 10, color: "#001E50" }}>
            Affinités
          </div>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, minmax(0, 1fr))",
              gap: 6,
              marginBottom: 12,
            }}
          >
            {AFF_VIEWS.map((s) => (
              <button
                key={s.key}
                onClick={() => setAffView(s.key)}
                style={{
                  padding: "7px 4px",
                  borderRadius: 6,
                  border: affView === s.key ? "2px solid #001E50" : "1px solid #E1E3E8",
                  background: affView === s.key ? "#E7ECF5" : "#FFFFFF",
                  fontWeight: 600,
                  fontSize: 11.5,
                  lineHeight: 1.25,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  gap: 2,
                }}
              >
                <span style={{ fontSize: 17 }} aria-hidden="true">
                  {s.icon}
                </span>
                {s.label}
              </button>
            ))}
          </div>

          <div
            style={{
              display: "flex",
              gap: 8,
              alignItems: "flex-start",
              background: "#F4F5F8",
              border: "1px solid #DDE0E6",
              borderRadius: 8,
              padding: "8px 10px",
              marginBottom: 12,
            }}
          >
            <span style={{ fontSize: 16, lineHeight: 1.2 }} aria-hidden="true">
              {affView0(affView).icon}
            </span>
            <div style={{ fontSize: 11.5, color: "#3A3B41", lineHeight: 1.4 }}>
              <strong style={{ color: "#001E50" }}>{affView0(affView).label}</strong> —{" "}
              {affView0(affView).desc}
            </div>
          </div>

          {affList.length === 0 ? (
            <div style={{ fontSize: 13, color: "#6B6C72", lineHeight: 1.5 }}>
              {affView === "never"
                ? "Toutes les paires de joueurs rodés ont déjà joué ensemble au moins une fois — beau brassage."
                : affView === "explosive"
                ? `Il faut au moins ${PAIR_MIN} matchs avec le score détaillé saisi pour qu'une paire apparaisse ici. Les matchs enregistrés avant la saisie du score complet ne comptent pas.`
                : affView === "tight"
                ? `Il faut au moins ${TIGHT_MIN} confrontations entre deux joueurs pour parler de rivalité serrée.`
                : `Pas encore assez de données : il faut qu'une paire ait joué au moins ${PAIR_MIN} matchs${
                    affView === "nemesis" ? " l'un contre l'autre" : " ensemble"
                  } pour apparaître ici.`}
              {affinites.totalPairs > 0 && affView !== "never"
                ? ` Paire la plus assidue pour l'instant : ${affinites.frequentDuos[0].a} et ${affinites.frequentDuos[0].b}, ${affinites.frequentDuos[0].n} match${
                    affinites.frequentDuos[0].n > 1 ? "s" : ""
                  } ensemble.`
                : ""}
            </div>
          ) : (
            <div>
              {affList.map((e, i) => {
                // Chaque vue a sa propre ligne : titre, détail, valeur à droite.
                let title, detail, value, valueColor;
                if (affView === "nemesis") {
                  title = (
                    <>
                      {e.victim} <span style={{ color: "#8A8D95", fontWeight: 500 }}>subit</span>{" "}
                      {e.nemesis}
                    </>
                  );
                  detail = `${e.vWins}V · ${e.draws}N · ${e.nWins}D sur ${e.n} confrontation${
                    e.n > 1 ? "s" : ""
                  }`;
                  value = `${Math.round((e.nWins / Math.max(1, e.n)) * 100)}%`;
                  valueColor = "#B4000F";
                } else if (affView === "explosive") {
                  title = `${e.a} + ${e.b}`;
                  detail = `${e.gaAvg.toFixed(1)} encaissés · sur ${e.nScored} match${
                    e.nScored > 1 ? "s" : ""
                  } au score connu`;
                  value = e.gfAvg.toFixed(1);
                  valueColor = "#001E50";
                } else if (affView === "tight") {
                  title = (
                    <>
                      {e.a} <span style={{ color: "#8A8D95", fontWeight: 500 }}>contre</span> {e.b}
                    </>
                  );
                  detail = `${e.aWins} — ${e.bWins}${e.draws ? ` · ${e.draws}N` : ""} sur ${
                    e.n
                  } confrontations`;
                  value = `${Math.round(e.rate * 100)}%`;
                  valueColor = "#001E50";
                } else if (affView === "never") {
                  title = `${e.a} + ${e.b}`;
                  detail = "jamais dans la même équipe";
                  value = "—";
                  valueColor = "#A8ABB2";
                } else {
                  title = `${e.a} + ${e.b}`;
                  detail = `${e.w}V · ${e.d}N · ${e.l}D sur ${e.n} match${
                    e.n > 1 ? "s" : ""
                  } ensemble · +/- ${e.pm >= 0 ? "+" : ""}${e.pm}`;
                  value = `${Math.round(((e.w + 0.5 * e.d) / e.n) * 100)}%`;
                  valueColor = affView === "worst" ? "#B4000F" : "#001E50";
                }
                return (
                  <div
                    key={i}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      borderBottom: "1px solid #F0F1F4",
                      padding: "10px 2px",
                    }}
                  >
                    <div
                      style={{
                        width: 22,
                        fontFamily: "'Roboto Mono', monospace",
                        fontSize: 12.5,
                        fontWeight: 700,
                        color: i < 3 ? "#001E50" : "#A8ABB2",
                      }}
                    >
                      {i + 1}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 14, fontWeight: 700, color: "#16171A" }}>{title}</div>
                      <div
                        style={{ fontSize: 10.5, fontWeight: 600, color: "#A8ABB2", marginTop: 1 }}
                      >
                        {detail}
                      </div>
                    </div>
                    <div
                      style={{
                        textAlign: "right",
                        fontFamily: "'Roboto Mono', monospace",
                        fontSize: 15,
                        fontWeight: 700,
                        color: valueColor,
                      }}
                    >
                      {value}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          {affinites.frequentDuos.length > 0 && (
            <div
              style={{
                marginTop: 14,
                background: "#F4F5F8",
                border: "1px solid #DDE0E6",
                borderRadius: 8,
                padding: "10px 12px",
                fontSize: 12,
                color: "#3A3B41",
              }}
            >
              <strong style={{ color: "#001E50" }}>Inséparables</strong> —{" "}
              {affinites.frequentDuos[0].a} et {affinites.frequentDuos[0].b} ont joué{" "}
              {affinites.frequentDuos[0].n} fois dans la même équipe, le record du groupe.
            </div>
          )}

          <div style={{ fontSize: 11.5, color: "#6B6C72", marginTop: 10, lineHeight: 1.5 }}>
            À prendre pour ce que c'est : du chambrage, pas de la science. Deux joueurs ne sont
            coéquipiers qu'environ un match sur dix, donc ces paires reposent sur très peu de
            matchs — le pourcentage affiché est le taux brut, mais le classement applique un
            lissage pour qu'une paire à 3 matchs ne coiffe pas une paire qui en a dix. Il faut une
            bonne cinquantaine de séances avant que ces podiums veuillent dire quelque chose.
            {affView === "explosive"
              ? " Les duos explosifs ne comptent que les matchs dont le score complet a été saisi."
              : ""}
          </div>
        </section>
      )}

      {tab === "seance" && (
        <>

      {/* PANNEAU DE SCORE (remonté au-dessus de l'effectif) */}
      <section style={{ padding: "14px 20px 4px" }}>
        {teamA.length > 0 && (
          <div>
            <div
              style={{
                background: "#F4F5F8",
                border: "1px solid #DDE0E6",
                borderRadius: 10,
                overflow: "hidden",
              }}
            >
              <div style={{ display: "flex", alignItems: "stretch", padding: "14px 14px 8px" }}>
                {[
                  { label: "Équipe A", team: teamA, side: "A", color: "#001E50" },
                  { label: "Équipe B", team: teamB, side: "B", color: "#B4000F" },
                ].map(({ label, team, side, color }, i) => (
                  <React.Fragment key={side}>
                    {i === 1 && (
                      <div
                        style={{
                          width: 46,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          fontSize: 11,
                          fontWeight: 800,
                          color: "#B0B3BA",
                        }}
                      >
                        VS
                      </div>
                    )}
                    <div style={{ flex: 1, textAlign: i === 1 ? "right" : "left" }}>
                      <div
                        style={{
                          fontSize: 10,
                          fontWeight: 800,
                          letterSpacing: "0.1em",
                          textTransform: "uppercase",
                          color: "#8A8D95",
                        }}
                      >
                        {label}
                      </div>
                      <div
                        style={{
                          fontFamily: "'Roboto Mono', monospace",
                          fontSize: 26,
                          fontWeight: 700,
                          color,
                          lineHeight: 1.1,
                        }}
                      >
                        {Math.round(team.reduce((s, p) => s + overall(p), 0))}
                      </div>
                    </div>
                  </React.Fragment>
                ))}
              </div>
              <div style={{ display: "flex", padding: "0 14px 12px", fontSize: 13 }}>
                {[
                  { team: teamA, side: "A" },
                  { team: teamB, side: "B" },
                ].map(({ team, side }, i) => (
                  <div key={side} style={{ flex: 1, textAlign: i === 1 ? "right" : "left" }}>
                    {team.map((p) => (
                      <div
                        key={p.id}
                        onClick={() => clickSwap(p, side)}
                        style={{
                          padding: "4px 6px",
                          borderRadius: 5,
                          fontWeight: 600,
                          color: "#3A3B41",
                          background:
                            selSwap && selSwap.player.id === p.id ? "#FBE1E2" : "transparent",
                          cursor: "pointer",
                        }}
                      >
                        {p.name}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
              <div
                style={{
                  borderTop: "1px solid #DDE0E6",
                  padding: "8px 14px",
                  fontSize: 10.5,
                  color: "#8A8D95",
                  textAlign: "center",
                }}
              >
                {options[optIdx]
                  ? `écart d'équilibre ${Math.round(options[optIdx].diff)} pts · ${
                      options[optIdx].repeats > 0
                        ? "quelques binômes récents reconduits"
                        : "aucun binôme récent reconduit"
                    }`
                  : "compo ajustée manuellement"}
                {" · touche un joueur de chaque côté pour permuter"}
              </div>
            </div>

            {options.length > 1 && (
              <button
                onClick={cycleOption}
                style={{
                  marginTop: 10,
                  background: "none",
                  border: "1px solid #001E50",
                  color: "#001E50",
                  borderRadius: 6,
                  padding: "9px 12px",
                  fontSize: 13,
                  fontWeight: 600,
                }}
              >
                Autre proposition ({optIdx + 1}/{options.length})
              </button>
            )}

            <div style={{ marginTop: 14 }}>
              <label style={{ fontSize: 12, color: "#6B6C72", display: "block", marginBottom: 6 }}>
                Score final
              </label>
              <div style={{ display: "flex", alignItems: "flex-end", gap: 10 }}>
                {[
                  { v: scoreA, set: setScoreA, lab: "Équipe A", color: "#001E50" },
                  { v: scoreB, set: setScoreB, lab: "Équipe B", color: "#B4000F" },
                ].map(({ v, set, lab, color }, i) => (
                  <React.Fragment key={lab}>
                    {i === 1 && (
                      <div style={{ fontSize: 16, fontWeight: 800, color: "#B0B3BA", paddingBottom: 10 }}>
                        —
                      </div>
                    )}
                    <div style={{ flex: 1 }}>
                      <div
                        style={{
                          fontSize: 10,
                          fontWeight: 800,
                          letterSpacing: "0.08em",
                          textTransform: "uppercase",
                          color: "#8A8D95",
                          marginBottom: 3,
                        }}
                      >
                        {lab}
                      </div>
                      <input
                        type="number"
                        inputMode="numeric"
                        min="0"
                        value={v}
                        onChange={(e) => set(e.target.value)}
                        placeholder="0"
                        style={{
                          width: "100%",
                          padding: "11px 10px",
                          borderRadius: 6,
                          border: "1px solid #E1E3E8",
                          fontFamily: "'Roboto Mono', monospace",
                          fontSize: 20,
                          fontWeight: 700,
                          color,
                          textAlign: "center",
                        }}
                      />
                    </div>
                  </React.Fragment>
                ))}
              </div>
              {scoreA.trim() !== "" && scoreB.trim() !== "" && (
                <div style={{ fontSize: 12, color: "#001E50", fontWeight: 600, marginTop: 6 }}>
                  {Number(scoreA) === Number(scoreB)
                    ? "Match nul"
                    : `Victoire ${Number(scoreA) > Number(scoreB) ? "A" : "B"} de ${Math.abs(
                        Number(scoreA) - Number(scoreB)
                      )} but${Math.abs(Number(scoreA) - Number(scoreB)) > 1 ? "s" : ""}`}
                </div>
              )}

              <label style={{ fontSize: 12, color: "#6B6C72", display: "block", margin: "12px 0 4px" }}>
                MVP offensif (optionnel)
              </label>
              <select
                value={mvpOff}
                onChange={(e) => setMvpOff(e.target.value)}
                style={{ width: "100%", padding: "8px 8px", borderRadius: 6, border: "1px solid #E1E3E8", fontSize: 13 }}
              >
                <option value="">Aucun</option>
                {[...teamA, ...teamB].map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>

              <label style={{ fontSize: 12, color: "#6B6C72", display: "block", margin: "10px 0 4px" }}>
                MVP défensif (optionnel)
              </label>
              <select
                value={mvpDef}
                onChange={(e) => setMvpDef(e.target.value)}
                style={{ width: "100%", padding: "8px 8px", borderRadius: 6, border: "1px solid #E1E3E8", fontSize: 13 }}
              >
                <option value="">Aucun</option>
                {[...teamA, ...teamB].map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <div style={{ fontSize: 11.5, color: "#6B6C72", marginTop: 5 }}>
                Chaque titre de MVP ajoute un bonus à la note du joueur élu. Être désigné dans les
                deux catégories cumule les deux bonus.
              </div>

              <button
                onClick={saveResult}
                style={{
                  marginTop: 12,
                  width: "100%",
                  background: "#001E50",
                  color: "#FFFFFF",
                  border: "none",
                  borderRadius: 6,
                  padding: "10px 10px",
                  fontWeight: 700,
                  fontSize: 14,
                }}
              >
                Enregistrer le résultat
              </button>
            </div>
          </div>
        )}
      </section>

      {/* ROSTER */}
      <section style={{ padding: "18px 20px" }}>
        <div className="of-title" style={{ fontSize: 15, marginBottom: 10, color: "#001E50" }}>
          Effectif
        </div>
        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && addPlayer()}
            placeholder="Nom du joueur"
            style={{
              flex: 1,
              padding: "9px 10px",
              borderRadius: 6,
              border: "1px solid #E1E3E8",
              fontSize: 14,
            }}
          />
          <button
            onClick={addPlayer}
            style={{
              background: "#001E50",
              color: "#FFFFFF",
              border: "none",
              borderRadius: 6,
              padding: "0 16px",
              fontWeight: 600,
              fontSize: 14,
            }}
          >
            Ajouter
          </button>
        </div>

        {players.length === 0 ? (
          <div style={{ fontSize: 13, color: "#6B6C72" }}>
            Ajoute tes ~20 joueurs habituels. Chacun démarre à 1000.
          </div>
        ) : (
          <div>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                padding: "0 2px 6px",
                borderBottom: "1px solid #E4E6EA",
                fontSize: 9.5,
                fontWeight: 800,
                letterSpacing: "0.06em",
                textTransform: "uppercase",
                color: "#A8ABB2",
              }}
            >
              <span style={{ width: 26, flexShrink: 0 }} />
              <span style={{ flex: 1 }}>Joueur</span>
              <span style={{ width: 46, textAlign: "right" }}>Note</span>
              <span style={{ width: 14 }} />
            </div>
            {leaderboard.map((p) => {
              const expanded = expandedPlayerId === p.id;
              const stats = expanded ? playerStats(p.name, matches) : null;
              return (
                <div key={p.id}>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      background: present.has(p.id) ? "#EBF0F9" : "transparent",
                      borderBottom: "1px solid #F0F1F4",
                      padding: "9px 2px",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={present.has(p.id)}
                      onChange={() => togglePresent(p.id)}
                      style={{ width: 22, height: 22, margin: "2px", flexShrink: 0 }}
                    />
                    {renamingId === p.id ? (
                      <>
                        <input
                          type="text"
                          value={renameValue}
                          autoFocus
                          onChange={(e) => setRenameValue(e.target.value)}
                          onKeyDown={(e) => e.key === "Enter" && renamePlayer(p.id, renameValue)}
                          style={{
                            flex: 1,
                            padding: "6px 8px",
                            borderRadius: 5,
                            border: "1px solid #E1E3E8",
                            fontSize: 14,
                          }}
                        />
                        <button
                          onClick={() => renamePlayer(p.id, renameValue)}
                          style={{
                            background: "#001E50",
                            color: "#FFFFFF",
                            border: "none",
                            borderRadius: 5,
                            fontSize: 11.5,
                            padding: "5px 8px",
                            fontWeight: 700,
                          }}
                        >
                          OK
                        </button>
                        <button
                          onClick={() => {
                            setRenamingId(null);
                            setRenameValue("");
                          }}
                          style={{
                            background: "none",
                            border: "none",
                            color: "#6B6C72",
                            fontSize: 13,
                            padding: "0 4px",
                          }}
                        >
                          ✕
                        </button>
                      </>
                    ) : (
                      <>
                    <div
                      onClick={() => setExpandedPlayerId(expanded ? null : p.id)}
                      style={{ flex: 1, minWidth: 0, cursor: "pointer" }}
                    >
                      <div style={{ fontSize: 14, fontWeight: 700, color: "#16171A" }}>{p.name}</div>
                      {(() => {
                        const form = recentForm(p.id, playerStats(p.name, matches).history);
                        return (
                          <div style={{ fontSize: 10, fontWeight: 600, color: "#A8ABB2", marginTop: 1 }}>
                            ± {uncertainty(p)}
                            {form !== null && Math.abs(form) >= 1
                              ? ` · ${form > 0 ? "↑ +" : "↓ "}${Math.round(form)}`
                              : ""}
                          </div>
                        );
                      })()}
                    </div>
                    <div
                      style={{
                        width: 46,
                        textAlign: "right",
                        fontFamily: "'Roboto Mono', monospace",
                        fontSize: 15,
                        fontWeight: 700,
                        color: "#001E50",
                      }}
                    >
                      {Math.round(overall(p))}
                    </div>
                    <div
                      onClick={() => setExpandedPlayerId(expanded ? null : p.id)}
                      style={{ width: 14, color: "#A8ABB2", fontSize: 12, cursor: "pointer", textAlign: "right" }}
                      aria-label={`Détails de ${p.name}`}
                    >
                      {expanded ? "▾" : "▸"}
                    </div>
                      </>
                    )}
                  </div>

                  {expanded && (
                    <div
                      style={{
                        background: "#F7FAFB",
                        border: "1px solid #E1E3E8",
                        borderTop: "none",
                        borderRadius: "0 0 8px 8px",
                        padding: 10,
                        fontSize: 12.5,
                      }}
                    >
                      <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
                        <button
                          onClick={() => {
                            setRenamingId(p.id);
                            setRenameValue(p.name);
                          }}
                          style={{
                            flex: 1,
                            background: "none",
                            border: "1px solid #E1E3E8",
                            borderRadius: 6,
                            color: "#001E50",
                            fontSize: 12.5,
                            padding: "9px 8px",
                            fontWeight: 600,
                          }}
                        >
                          Renommer
                        </button>
                        <button
                          onClick={() => toggleActive(p.id)}
                          style={{
                            flex: 1,
                            background: "none",
                            border: "1px solid #E1E3E8",
                            borderRadius: 6,
                            color: "#6B6C72",
                            fontSize: 12.5,
                            padding: "9px 8px",
                            fontWeight: 600,
                          }}
                        >
                          Archiver
                        </button>
                      </div>
                      <div style={{ display: "flex", gap: 12, marginBottom: 8, color: "#001E50", fontWeight: 600 }}>
                        <span>{stats.wins}V</span>
                        <span>{stats.draws}N</span>
                        <span>{stats.losses}D</span>
                        <span style={{ color: "#6B6C72", fontWeight: 400 }}>· {p.games} match{p.games > 1 ? "s" : ""} au total</span>
                      </div>
                      <div style={{ color: "#6B6C72", marginBottom: 8 }}>
                        Note :{" "}
                        <strong style={{ color: "#001E50" }}>{Math.round(overall(p))}</strong> (±{" "}
                        {uncertainty(p)})
                        {(() => {
                          const form = recentForm(p.id, stats.history);
                          if (form === null || Math.abs(form) < 1) return null;
                          return (
                            <>
                              {" · forme "}
                              <strong style={{ color: form > 0 ? "#001E50" : "#B4000F" }}>
                                {form > 0 ? `↑ +${Math.round(form)}` : `↓ ${Math.round(form)}`}
                              </strong>
                            </>
                          );
                        })()}
                      </div>
                      <div style={{ color: "#6B6C72", marginBottom: 8 }}>
                        +/- moyen :{" "}
                        {stats.history.length === 0
                          ? "—"
                          : `${stats.pm / stats.history.length >= 0 ? "+" : ""}${(
                              stats.pm / stats.history.length
                            ).toFixed(1)} but${Math.abs(stats.pm / stats.history.length) >= 2 ? "s" : ""} par match`}
                      </div>
                      {stats.bestStreak >= 2 && (
                        <div style={{ color: "#6B6C72", marginBottom: 8 }}>
                          Meilleure série :{" "}
                          <strong style={{ color: "#001E50" }}>
                            {stats.bestStreak} victoires d'affilée
                          </strong>
                          {streakTier(stats.bestStreak) ? (
                            <strong style={{ color: "#B2790A" }}>
                              {" "}
                              « {streakTier(stats.bestStreak).label} »
                            </strong>
                          ) : null}
                          {stats.currentStreak >= 2 ? ` · en cours : ${stats.currentStreak}` : ""}
                        </div>
                      )}
                      <div style={{ color: "#6B6C72", marginBottom: 8 }}>
                        Présence :{" "}
                        {matches.length === 0
                          ? "—"
                          : `${Math.round((stats.history.length / matches.length) * 100)} % (${stats.history.length}/${matches.length} séances)`}
                      </div>
                      {(() => {
                        const { bestAlly, worstFoe } = playerAffinities(
                          p.name,
                          affinites.mates,
                          affinites.foes
                        );
                        if (!bestAlly && !worstFoe) return null;
                        return (
                          <div style={{ color: "#6B6C72", marginBottom: 8 }}>
                            {bestAlly && (
                              <div>
                                Meilleur allié :{" "}
                                <strong style={{ color: "#001E50" }}>{bestAlly.who}</strong> (
                                {bestAlly.w}V · {bestAlly.d}N · {bestAlly.l}D ensemble)
                              </div>
                            )}
                            {worstFoe && (
                              <div>
                                Bête noire :{" "}
                                <strong style={{ color: "#B4000F" }}>{worstFoe.who}</strong> (
                                {worstFoe.wins}V · {worstFoe.draws}N · {worstFoe.losses}D contre
                                lui)
                              </div>
                            )}
                          </div>
                        );
                      })()}
                      {(() => {
                        const vals = [];
                        for (const m of [...stats.history].reverse()) {
                          const r = m.ratingsAfter && m.ratingsAfter[p.id];
                          if (r)
                            vals.push(
                              Number.isFinite(r.rating) ? r.rating : (r.off + r.def) / 2
                            );
                        }
                        if (vals.length < 2) return null;
                        return (
                          <div style={{ marginBottom: 10 }}>
                            <div style={{ color: "#6B6C72", marginBottom: 2 }}>
                              Progression de la note
                            </div>
                            <Sparkline series={[{ label: "note", values: vals, color: "#001E50" }]} />
                          </div>
                        );
                      })()}
                      <div style={{ display: "flex", gap: 10, marginBottom: 10 }}>
                        <Badge tone="off">MVP att. × {stats.mvpOff}</Badge>
                        <Badge tone="def">MVP déf. × {stats.mvpDef}</Badge>
                      </div>
                      {stats.history.length === 0 ? (
                        <div style={{ color: "#6B6C72" }}>Aucun match enregistré pour l'instant.</div>
                      ) : (
                        <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                          {stats.history.map((m) => (
                            <div key={m.id} style={{ borderTop: "1px solid #E1E3E8", paddingTop: 5 }}>
                              <div style={{ color: "#6B6C72" }}>
                                {new Date(m.date).toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" })}
                                {" · "}
                                <strong style={{ color: "#001E50" }}>{m.result}</strong>
                                {Number.isFinite(m.goalsA) && Number.isFinite(m.goalsB)
                                  ? ` ${
                                      m.teamA.includes(p.name)
                                        ? `${m.goalsA}-${m.goalsB}`
                                        : `${m.goalsB}-${m.goalsA}`
                                    }`
                                  : m.outcome !== "draw"
                                  ? ` (écart ${Math.abs(m.diff)})`
                                  : ""}
                              </div>
                              {(m.mvpOffName === p.name || m.mvpDefName === p.name) && (
                                <div style={{ color: "#B2790A" }}>
                                  {m.mvpOffName === p.name ? "MVP offensif" : ""}
                                  {m.mvpOffName === p.name && m.mvpDefName === p.name ? " · " : ""}
                                  {m.mvpDefName === p.name ? "MVP défensif" : ""}
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {archived.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <button
              onClick={() => setShowArchived((s) => !s)}
              style={{ background: "none", border: "none", color: "#6B6C72", fontSize: 13, fontWeight: 600, padding: 0 }}
            >
              {showArchived ? "▾" : "▸"} Joueurs archivés ({archived.length})
            </button>
            {showArchived && (
              <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
                {archived.map((p) => (
                  <div
                    key={p.id}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      background: "#EDF2F4",
                      border: "1px solid #E1E3E8",
                      borderRadius: 8,
                      padding: "8px 10px",
                    }}
                  >
                    <div style={{ flex: 1, fontSize: 14, color: "#6B6C72" }}>{p.name}</div>
                    <button
                      onClick={() => toggleActive(p.id)}
                      style={{
                        background: "none",
                        border: "1px solid #001E50",
                        color: "#001E50",
                        borderRadius: 5,
                        fontSize: 11.5,
                        padding: "4px 7px",
                        fontWeight: 600,
                      }}
                    >
                      Réactiver
                    </button>
                    <button
                      onClick={() => removePlayer(p.id)}
                      style={{
                        background: "none",
                        border: "none",
                        color: "#A14B36",
                        fontSize: 13,
                        padding: "0 4px",
                      }}
                      aria-label={`Supprimer définitivement ${p.name}`}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </section>

      {/* SEANCE */}
      <section style={{ padding: "6px 20px 18px" }}>
        <div className="of-title" style={{ fontSize: 15, marginBottom: 6, color: "#001E50" }}>
          Séance du jour — {present.size}/10 sélectionné{present.size > 1 ? "s" : ""}
        </div>
        {present.size > 0 && (
          <div style={{ fontSize: 12, color: "#6B6C72", marginBottom: 10 }}>
            {players
              .filter((p) => present.has(p.id))
              .map((p) => p.name)
              .join(", ")}
            {" · "}
            <span
              onClick={clearPresent}
              style={{ color: "#B4000F", fontWeight: 600, cursor: "pointer" }}
            >
              vider la sélection
            </span>
          </div>
        )}
        <button
          onClick={generate}
          disabled={present.size < 4}
          style={{
            background: present.size < 4 ? "#E1E3E8" : "#E1000F",
            color: present.size < 4 ? "#6B6C72" : "#FFFFFF",
            border: "none",
            borderRadius: 6,
            padding: "13px 16px",
            fontWeight: 700,
            fontSize: 14,
            width: "100%",
          }}
        >
          Générer les équipes équilibrées
        </button>

      </section>

      {/* BACKUP */}
      <section style={{ padding: "6px 20px" }}>
        <div className="of-title" style={{ fontSize: 15, marginBottom: 8, color: "#001E50" }}>
          Sauvegarde
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={exportData}
            style={{
              flex: 1,
              background: "#001E50",
              color: "#FFFFFF",
              border: "none",
              borderRadius: 6,
              padding: "9px 10px",
              fontWeight: 700,
              fontSize: 13.5,
            }}
          >
            Exporter (JSON)
          </button>
          <button
            onClick={() => fileInputRef.current && fileInputRef.current.click()}
            style={{
              flex: 1,
              background: "none",
              border: "1px solid #001E50",
              color: "#001E50",
              borderRadius: 6,
              padding: "9px 10px",
              fontWeight: 700,
              fontSize: 13.5,
            }}
          >
            Importer
          </button>
          <input ref={fileInputRef} type="file" accept="application/json" onChange={importData} style={{ display: "none" }} />
        </div>
        <div style={{ fontSize: 11.5, color: "#6B6C72", marginTop: 6 }}>
          L'export télécharge un fichier avec l'effectif, l'historique et les seuils — utile pour garder une copie ou migrer vers un autre support. L'import remplace les données actuelles par celles du fichier.
        </div>
      </section>

      {/* HISTORY */}
      <section style={{ padding: "6px 20px" }}>
        <button
          onClick={() => setShowHistory((s) => !s)}
          style={{
            background: "none",
            border: "none",
            color: "#001E50",
            fontWeight: 700,
            fontSize: 14,
            padding: 0,
          }}
        >
          {showHistory ? "▾" : "▸"} Historique ({matches.length})
        </button>
        {undo && (
          <div style={{ marginTop: 8 }}>
            <button
              onClick={undoLast}
              style={{
                background: "none",
                border: "1px solid #E1000F",
                color: "#B4000F",
                borderRadius: 6,
                padding: "8px 12px",
                fontSize: 13,
                fontWeight: 700,
              }}
            >
              {undo.kind === "edit" ? "Annuler la correction" : "Annuler le dernier match"}
            </button>
            <div style={{ fontSize: 11.5, color: "#6B6C72", marginTop: 5 }}>
              Remet l'effectif et l'historique dans l'état d'avant la dernière action. Un seul
              niveau d'annulation : la prochaine saisie ou correction écrase celui-ci.
            </div>
          </div>
        )}
        {showHistory && (
          <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
            {matches.length === 0 && (
              <div style={{ fontSize: 13, color: "#6B6C72" }}>Aucun match enregistré pour l'instant.</div>
            )}
            {matches.map((m, mi) => (
              <div
                key={m.id}
                style={{ background: "#FFFFFF", border: "1px solid #E1E3E8", borderRadius: 8, padding: 9, fontSize: 12.5 }}
              >
                <div style={{ color: "#6B6C72", marginBottom: 3 }}>
                  {new Date(m.date).toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" })}
                </div>
                <div style={{ fontWeight: m.outcome === "A" ? 700 : 400 }}>
                  {Number.isFinite(m.goalsA) ? (
                    <strong style={{ fontFamily: "'Roboto Mono', monospace", marginRight: 6 }}>
                      {m.goalsA}
                    </strong>
                  ) : null}
                  {m.teamA.join(", ")} {m.outcome === "A" ? "✓" : ""}
                </div>
                <div style={{ fontWeight: m.outcome === "B" ? 700 : 400 }}>
                  {Number.isFinite(m.goalsB) ? (
                    <strong style={{ fontFamily: "'Roboto Mono', monospace", marginRight: 6 }}>
                      {m.goalsB}
                    </strong>
                  ) : null}
                  {m.teamB.join(", ")} {m.outcome === "B" ? "✓" : ""}
                </div>
                <div style={{ color: "#6B6C72", marginTop: 3 }}>
                  {m.outcome === "draw"
                    ? "Match nul"
                    : `Écart ${Math.abs(m.diff)} but${Math.abs(m.diff) > 1 ? "s" : ""}`}
                  {m.mvpOffName ? ` · MVP att. ${m.mvpOffName}` : ""}
                  {m.mvpDefName ? ` · MVP déf. ${m.mvpDefName}` : ""}
                  {!Number.isFinite(m.goalsA) ? " · score détaillé non renseigné" : ""}
                </div>

                {editingId === m.id ? (
                  <div
                    style={{
                      marginTop: 8,
                      paddingTop: 8,
                      borderTop: "1px solid #E1E3E8",
                    }}
                  >
                    <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                      {[
                        { key: "score", label: "Score complet" },
                        { key: "margin", label: "Écart seul" },
                      ].map((o) => (
                        <button
                          key={o.key}
                          onClick={() => setEditMode(o.key)}
                          style={{
                            flex: 1,
                            padding: "7px 4px",
                            borderRadius: 6,
                            border:
                              editMode === o.key ? "2px solid #001E50" : "1px solid #E1E3E8",
                            background: editMode === o.key ? "#E7ECF5" : "#FFFFFF",
                            fontWeight: 600,
                            fontSize: 11.5,
                          }}
                        >
                          {o.label}
                        </button>
                      ))}
                    </div>

                    {editMode === "score" ? (
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <input
                          type="number"
                          inputMode="numeric"
                          min="0"
                          value={editA}
                          onChange={(e) => setEditA(e.target.value)}
                          placeholder="A"
                          style={{
                            flex: 1,
                            padding: "9px 8px",
                            borderRadius: 6,
                            border: "1px solid #E1E3E8",
                            fontFamily: "'Roboto Mono', monospace",
                            fontSize: 16,
                            fontWeight: 700,
                            color: "#001E50",
                            textAlign: "center",
                          }}
                        />
                        <span style={{ color: "#B0B3BA", fontWeight: 800 }}>—</span>
                        <input
                          type="number"
                          inputMode="numeric"
                          min="0"
                          value={editB}
                          onChange={(e) => setEditB(e.target.value)}
                          placeholder="B"
                          style={{
                            flex: 1,
                            padding: "9px 8px",
                            borderRadius: 6,
                            border: "1px solid #E1E3E8",
                            fontFamily: "'Roboto Mono', monospace",
                            fontSize: 16,
                            fontWeight: 700,
                            color: "#B4000F",
                            textAlign: "center",
                          }}
                        />
                      </div>
                    ) : (
                      <>
                        <input
                          type="number"
                          inputMode="numeric"
                          value={editMargin}
                          onChange={(e) => setEditMargin(e.target.value)}
                          placeholder="ex : 6, ou -3 si B gagne"
                          style={{
                            width: "100%",
                            padding: "9px 10px",
                            borderRadius: 6,
                            border: "1px solid #E1E3E8",
                            fontSize: 14,
                          }}
                        />
                        <div style={{ fontSize: 11, color: "#6B6C72", marginTop: 4 }}>
                          Positif si A gagne, négatif si B gagne, 0 pour un nul. Le score détaillé
                          de ce match sera effacé plutôt que deviné.
                        </div>
                      </>
                    )}

                    <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
                      <button
                        onClick={() => saveMatchEdit(m)}
                        style={{
                          flex: 1,
                          background: "#001E50",
                          color: "#FFFFFF",
                          border: "none",
                          borderRadius: 6,
                          padding: "10px 8px",
                          fontWeight: 700,
                          fontSize: 12.5,
                        }}
                      >
                        Enregistrer
                      </button>
                      <button
                        onClick={closeEditor}
                        style={{
                          background: "none",
                          border: "1px solid #E1E3E8",
                          color: "#6B6C72",
                          borderRadius: 6,
                          padding: "10px 12px",
                          fontWeight: 600,
                          fontSize: 12.5,
                        }}
                      >
                        Annuler
                      </button>
                      <button
                        onClick={() => deleteMatch(m)}
                        style={{
                          background: "none",
                          border: "1px solid #E1000F",
                          color: "#B4000F",
                          borderRadius: 6,
                          padding: "10px 12px",
                          fontWeight: 600,
                          fontSize: 12.5,
                        }}
                      >
                        Supprimer
                      </button>
                    </div>
                    <div style={{ fontSize: 11, color: "#6B6C72", marginTop: 6 }}>
                      Les notes de ce match seront recalculées ; les matchs précédents ne bougent
                      pas.
                    </div>
                  </div>
                ) : mi === 0 ? (
                  <button
                    onClick={() => openEditor(m)}
                    style={{
                      marginTop: 6,
                      background: "none",
                      border: "1px solid #E1E3E8",
                      color: "#001E50",
                      borderRadius: 5,
                      padding: "5px 9px",
                      fontSize: 11.5,
                      fontWeight: 600,
                    }}
                  >
                    Corriger
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </section>

        </>
      )}

      {tab === "seance" && present.size > 0 && teamA.length === 0 && (
        <div
          style={{
            position: "fixed",
            left: 0,
            right: 0,
            bottom: 0,
            background: "#001E50",
            padding: "10px 16px",
            display: "flex",
            alignItems: "center",
            gap: 12,
            boxShadow: "0 -2px 10px rgba(0,0,0,0.18)",
            zIndex: 20,
          }}
        >
          <div style={{ color: "#FFFFFF", fontSize: 13, fontWeight: 700, whiteSpace: "nowrap" }}>
            {present.size}/10
            <span style={{ color: "#A9B8D6", fontWeight: 500 }}>
              {present.size % 2 !== 0 ? " (nombre impair)" : ""}
            </span>
          </div>
          <button
            onClick={generate}
            disabled={present.size < 4}
            style={{
              flex: 1,
              background: present.size < 4 ? "#3C5580" : "#E1000F",
              color: "#FFFFFF",
              border: "none",
              borderRadius: 6,
              padding: "12px 10px",
              fontWeight: 700,
              fontSize: 14,
            }}
          >
            Générer les équipes
          </button>
          <button
            onClick={clearPresent}
            style={{
              background: "none",
              border: "1px solid #3C5580",
              color: "#A9B8D6",
              borderRadius: 6,
              padding: "12px 10px",
              fontSize: 12.5,
              fontWeight: 600,
            }}
          >
            Vider
          </button>
        </div>
      )}
    </div>
  );
}
