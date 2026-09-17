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

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const expected = (diff) => 1 / (1 + Math.pow(10, -diff / 400));
const overall = (p) => (p.off + p.def) / 2;
const isActive = (p) => p.active !== false;

function playerStats(name, matches) {
  let wins = 0,
    draws = 0,
    losses = 0,
    mvpOff = 0,
    mvpDef = 0;
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
    if (m.mvpOffName === name) mvpOff++;
    if (m.mvpDefName === name) mvpDef++;
    history.push({ ...m, result });
  }
  return { wins, draws, losses, mvpOff, mvpDef, history };
}
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

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
    const offA = teamA.reduce((s, p) => s + p.off, 0);
    const offB = teamB.reduce((s, p) => s + p.off, 0);
    const defA = teamA.reduce((s, p) => s + p.def, 0);
    const defB = teamB.reduce((s, p) => s + p.def, 0);
    const balance =
      Math.abs(sumA - sumB) + 0.3 * Math.abs(offA - offB) + 0.3 * Math.abs(defA - defB);
    const repeats = repeatCost(teamA) + repeatCost(teamB);
    const score = balance + VARIETY_WEIGHT * repeats;
    options.push({ teamA, teamB, diff: balance, repeats, score, sumA, sumB });
  }
  options.sort((a, b) => a.score - b.score);
  return options.slice(0, 5);
}

const TIER_MULT = { small: 1, medium: 1.6, large: 2.3 };
const MVP_BONUS = 10;
const DEFAULT_THRESHOLDS = { small: 2, medium: 5 }; // repères de départ, avant d'avoir assez de matchs

// Seuils suggérés par terciles à partir des écarts de buts déjà enregistrés
// (hors matchs nuls). Renvoie null tant qu'il n'y a pas assez de matchs.
function autoThresholds(matches) {
  const diffs = matches
    .map((m) => Math.abs(m.diff))
    .filter((d) => Number.isFinite(d) && d > 0)
    .sort((a, b) => a - b);
  if (diffs.length < 6) return null;
  const pick = (p) => diffs[Math.min(diffs.length - 1, Math.floor(p * diffs.length))];
  return { small: pick(1 / 3), medium: pick(2 / 3), n: diffs.length };
}

// Renvoie les termes d'erreur (performance observée − attendue) par équipe.
// Le delta de chaque joueur est ensuite errX × son K personnel × le
// multiplicateur d'écart, ce qui laisse les nouveaux bouger plus vite.
function computeErrorsFromOutcome(teamA, teamB, outcome, tier) {
  const avg = (arr, key) => arr.reduce((s, p) => s + p[key], 0) / arr.length;
  const offA = avg(teamA, "off"),
    defA = avg(teamA, "def"),
    offB = avg(teamB, "off"),
    defB = avg(teamB, "def");
  const M = outcome === "draw" ? 1 : TIER_MULT[tier] || 1;
  const sA = outcome === "A" ? 1 : outcome === "draw" ? 0.5 : 0;
  const sB = 1 - sA;

  return {
    M,
    errOffA: sA - expected(offA - defB),
    errDefA: sA - expected(defA - offB),
    errOffB: sB - expected(offB - defA),
    errDefB: sB - expected(defB - offA),
  };
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
  const [winner, setWinner] = useState(null); // "A" | "draw" | "B"
  const [marginInput, setMarginInput] = useState("");
  const [mvpOff, setMvpOff] = useState("");
  const [mvpDef, setMvpDef] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [thresholdMode, setThresholdMode] = useState("auto"); // "auto" | "manual"
  const [manualSmall, setManualSmall] = useState(2);
  const [manualMedium, setManualMedium] = useState(5);
  const [expandedPlayerId, setExpandedPlayerId] = useState(null);
  const [undo, setUndo] = useState(null);
  const [renamingId, setRenamingId] = useState(null);
  const [renameValue, setRenameValue] = useState("");
  const [tab, setTab] = useState("seance"); // "seance" | "classement"
  const [sortKey, setSortKey] = useState("overall"); // "off" | "def" | "overall"
  const [recordSort, setRecordSort] = useState("pct"); // "pct" | "wins" | "games"
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const p = await storage.get("futsal-players").catch(() => null);
        const m = await storage.get("futsal-matches").catch(() => null);
        const t = await storage.get("futsal-thresholds").catch(() => null);
        const u = await storage.get("futsal-undo").catch(() => null);
        if (p) setPlayers(JSON.parse(p.value));
        if (m) setMatches(JSON.parse(m.value));
        if (t) {
          const cfg = JSON.parse(t.value);
          setThresholdMode(cfg.mode || "auto");
          setManualSmall(cfg.small ?? 2);
          setManualMedium(cfg.medium ?? 5);
        }
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
  const persistThresholds = async (mode, small, medium) => {
    setThresholdMode(mode);
    setManualSmall(small);
    setManualMedium(medium);
    try {
      await storage.set("futsal-thresholds", JSON.stringify({ mode, small, medium }));
    } catch (e) {
      setError("Échec de la sauvegarde des seuils.");
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
      thresholds: { mode: thresholdMode, small: manualSmall, medium: manualMedium },
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
        if (data.thresholds) {
          persistThresholds(data.thresholds.mode || "auto", data.thresholds.small ?? 2, data.thresholds.medium ?? 5);
        }
        setError("");
      } catch (err) {
        setError("Impossible de lire ce fichier (JSON invalide).");
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  };

  const undoLastMatch = () => {
    if (!undo || !Array.isArray(undo.players) || matches.length === 0) {
      setError("Rien à annuler.");
      return;
    }
    setError("");
    persistPlayers(undo.players);
    persistMatches(matches.slice(1));
    persistUndo(null);
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
    setWinner(null);
    setMarginInput("");
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

  const autoTh = useMemo(() => autoThresholds(matches), [matches]);
  const effectiveThresholds =
    thresholdMode === "manual"
      ? { small: manualSmall, medium: manualMedium, n: null }
      : autoTh || { ...DEFAULT_THRESHOLDS, n: 0 };

  const saveResult = () => {
    if (!winner) {
      setError("Choisis qui a gagné (ou match nul).");
      return;
    }
    const margin = winner === "draw" ? 0 : Number(marginInput);
    if (winner !== "draw" && (!Number.isFinite(margin) || marginInput.trim() === "" || margin <= 0)) {
      setError("Entre un écart de buts valide (un nombre positif).");
      return;
    }
    if (teamA.length === 0 || teamB.length === 0) {
      setError("Génère d'abord les deux équipes.");
      return;
    }
    setError("");
    const diff = winner === "A" ? margin : winner === "B" ? -margin : 0;
    const outcome = winner;
    const absDiff = Math.abs(diff);
    const tier =
      outcome === "draw"
        ? null
        : absDiff <= effectiveThresholds.small
        ? "small"
        : absDiff <= effectiveThresholds.medium
        ? "medium"
        : "large";
    const { M, errOffA, errDefA, errOffB, errDefB } = computeErrorsFromOutcome(
      teamA,
      teamB,
      outcome,
      tier
    );
    const idsA = new Set(teamA.map((p) => p.id));
    const idsB = new Set(teamB.map((p) => p.id));
    const ratingsAfter = {};
    const next = players.map((p) => {
      const k = kFor(p) * M;
      let off = p.off,
        def = p.def,
        games = p.games;
      if (idsA.has(p.id)) {
        off += k * errOffA;
        def += k * errDefA;
        games += 1;
      } else if (idsB.has(p.id)) {
        off += k * errOffB;
        def += k * errDefB;
        games += 1;
      } else {
        return p;
      }
      if (p.id === mvpOff) off += MVP_BONUS;
      if (p.id === mvpDef) def += MVP_BONUS;
      ratingsAfter[p.id] = { off, def };
      return { ...p, off, def, games };
    });
    const allNames = new Map([...teamA, ...teamB].map((p) => [p.id, p.name]));
    // Snapshot d'avant-match, pour pouvoir annuler la dernière saisie.
    persistUndo({ players, matchId: null, savedAt: new Date().toISOString() });
    persistPlayers(next);
    persistMatches([
      {
        id: uid(),
        date: new Date().toISOString(),
        teamA: teamA.map((p) => p.name),
        teamB: teamB.map((p) => p.name),
        diff,
        outcome,
        tier,
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
    setWinner(null);
    setMarginInput("");
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
    const value = (p) => (sortKey === "off" ? p.off : sortKey === "def" ? p.def : overall(p));
    return [...players].filter(isActive).sort((a, b) => value(b) - value(a));
  }, [players, sortKey]);

  // Bilan V/N/D par joueur actif. Le pourcentage compte un nul comme un
  // demi-succès, et se calcule sur les matchs effectivement joués.
  const records = useMemo(() => {
    const rows = players.filter(isActive).map((p) => {
      const s = playerStats(p.name, matches);
      const played = s.wins + s.draws + s.losses;
      const pct = played === 0 ? null : ((s.wins + 0.5 * s.draws) / played) * 100;
      return { id: p.id, name: p.name, ...s, played, pct };
    });
    rows.sort((a, b) => {
      if (recordSort === "wins") return b.wins - a.wins || b.played - a.played;
      if (recordSort === "games") return b.played - a.played || b.wins - a.wins;
      // "pct" : les joueurs sans match joué passent en dernier
      if (a.pct === null && b.pct === null) return a.name.localeCompare(b.name);
      if (a.pct === null) return 1;
      if (b.pct === null) return -1;
      return b.pct - a.pct || b.played - a.played;
    });
    return rows;
  }, [players, matches, recordSort]);

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
        @import url('https://fonts.googleapis.com/css2?family=Manrope:wght@500;600;700&display=swap');
        .of-title { font-family: 'Manrope', sans-serif; letter-spacing: -0.01em; }
        button { cursor: pointer; font-family: inherit; }
        input[type=text], input[type=number] { font-family: inherit; }
      `}</style>

      <div style={{ background: "#001E50", padding: "22px 20px 26px", position: "relative" }}>
        <div
          style={{
            position: "absolute",
            top: 20,
            right: 20,
            width: 24,
            height: 24,
            borderRadius: "50%",
            background: "radial-gradient(circle, #E1000F 0 33%, #FFFFFF 33% 66%, #001E50 66% 100%)",
            boxShadow: "0 0 0 1px rgba(255,255,255,0.3)",
          }}
        />
        <div className="of-title" style={{ color: "#FFFFFF", fontSize: 26, fontWeight: 700 }}>
          Futsal — équipes équilibrées
        </div>
        <div style={{ color: "#A9B8D6", fontSize: 13, marginTop: 4 }}>
          {leaderboard.length} joueurs actifs · notes attaque / défense séparées
        </div>
        <div style={{ width: 44, height: 3, background: "#E1000F", marginTop: 10 }} />
      </div>

      {error && (
        <div style={{ background: "#FBE9C9", color: "#7A4B00", padding: "8px 20px", fontSize: 13 }}>
          {error}
        </div>
      )}

      {/* TABS */}
      <div style={{ display: "flex", borderBottom: "1px solid #E1E3E8", background: "#FFFFFF" }}>
        {[
          { key: "seance", label: "Séance" },
          { key: "classement", label: "Classement" },
          { key: "bilan", label: "Bilan V/D" },
        ].map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            style={{
              flex: 1,
              background: "none",
              border: "none",
              borderBottom: tab === t.key ? "3px solid #E1000F" : "3px solid transparent",
              color: tab === t.key ? "#001E50" : "#6B6C72",
              fontWeight: 700,
              fontSize: 14,
              padding: "12px 0",
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === "classement" && (
        <section style={{ padding: "18px 20px" }}>
          <div className="of-title" style={{ fontSize: 15, marginBottom: 10, color: "#001E50" }}>
            Classement
          </div>
          <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
            {[
              { key: "off", label: "Attaque" },
              { key: "def", label: "Défense" },
              { key: "overall", label: "Combiné" },
            ].map((s) => (
              <button
                key={s.key}
                onClick={() => setSortKey(s.key)}
                style={{
                  flex: 1,
                  padding: "8px 6px",
                  borderRadius: 6,
                  border: sortKey === s.key ? "2px solid #001E50" : "1px solid #E1E3E8",
                  background: sortKey === s.key ? "#E7ECF5" : "#FFFFFF",
                  fontWeight: 600,
                  fontSize: 13,
                }}
              >
                {s.label}
              </button>
            ))}
          </div>

          {ranked.length === 0 ? (
            <div style={{ fontSize: 13, color: "#6B6C72" }}>
              Aucun joueur actif pour l'instant.
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {ranked.map((p, i) => (
                <div
                  key={p.id}
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
                  <div style={{ flex: 1, fontSize: 14, fontWeight: 600 }}>{p.name}</div>
                  <Badge tone={sortKey === "off" ? "off" : undefined}>Att {Math.round(p.off)}</Badge>
                  <Badge tone={sortKey === "def" ? "def" : undefined}>Déf {Math.round(p.def)}</Badge>
                  <Badge>{Math.round(overall(p))}</Badge>
                </div>
              ))}
            </div>
          )}
          <div style={{ fontSize: 11.5, color: "#6B6C72", marginTop: 8 }}>
            Classement des joueurs actifs uniquement. Le tri en cours est mis en évidence.
          </div>
        </section>
      )}

      {tab === "bilan" && (
        <section style={{ padding: "18px 20px" }}>
          <div className="of-title" style={{ fontSize: 15, marginBottom: 10, color: "#001E50" }}>
            Bilan victoires / défaites
          </div>
          <div style={{ display: "flex", gap: 6, marginBottom: 12 }}>
            {[
              { key: "pct", label: "% victoires" },
              { key: "wins", label: "Victoires" },
              { key: "games", label: "Matchs joués" },
            ].map((s) => (
              <button
                key={s.key}
                onClick={() => setRecordSort(s.key)}
                style={{
                  flex: 1,
                  padding: "8px 6px",
                  borderRadius: 6,
                  border: recordSort === s.key ? "2px solid #001E50" : "1px solid #E1E3E8",
                  background: recordSort === s.key ? "#E7ECF5" : "#FFFFFF",
                  fontWeight: 600,
                  fontSize: 12.5,
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
                  <div
                    style={{
                      fontSize: 15,
                      fontWeight: 700,
                      color: r.pct === null ? "#6B6C72" : "#001E50",
                      fontVariantNumeric: "tabular-nums",
                    }}
                  >
                    {r.pct === null ? "—" : `${Math.round(r.pct)} %`}
                  </div>
                </div>
              ))}
            </div>
          )}
          <div style={{ fontSize: 11.5, color: "#6B6C72", marginTop: 8 }}>
            Le pourcentage compte un match nul comme un demi-succès, calculé sur les matchs
            réellement joués. Attention aux petits échantillons : un joueur à 2 matchs peut
            afficher 100 % sans que ce soit représentatif.
          </div>
        </section>
      )}

      {tab === "seance" && (
        <>

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
            Ajoute tes ~20 joueurs habituels. Chacun démarre à 1000 en attaque et en défense.
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
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
                      background: present.has(p.id) ? "#E7ECF5" : "#FFFFFF",
                      border: "1px solid #E1E3E8",
                      borderRadius: expanded ? "8px 8px 0 0" : 8,
                      padding: "8px 10px",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={present.has(p.id)}
                      onChange={() => togglePresent(p.id)}
                      style={{ width: 22, height: 22, margin: "4px 2px", flexShrink: 0 }}
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
                      style={{ flex: 1, display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}
                    >
                      <div style={{ flex: 1, fontSize: 14, fontWeight: 600 }}>{p.name}</div>
                      <Badge tone="off">Att {Math.round(p.off)}</Badge>
                      <Badge tone="def">Déf {Math.round(p.def)}</Badge>
                      <Badge>{Math.round(overall(p))}</Badge>
                    </div>
                    <div
                      onClick={() => setExpandedPlayerId(expanded ? null : p.id)}
                      style={{ color: "#6B6C72", fontSize: 13, padding: "6px 2px", cursor: "pointer" }}
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
                        Présence :{" "}
                        {matches.length === 0
                          ? "—"
                          : `${Math.round((stats.history.length / matches.length) * 100)} % (${stats.history.length}/${matches.length} séances)`}
                      </div>
                      {(() => {
                        const chrono = [...stats.history].reverse();
                        const offVals = [],
                          defVals = [];
                        for (const m of chrono) {
                          const r = m.ratingsAfter && m.ratingsAfter[p.id];
                          if (r) {
                            offVals.push(r.off);
                            defVals.push(r.def);
                          }
                        }
                        if (offVals.length < 2) return null;
                        return (
                          <div style={{ marginBottom: 10 }}>
                            <div style={{ color: "#6B6C72", marginBottom: 2 }}>
                              Progression (attaque en rouge, défense en bleu)
                            </div>
                            <Sparkline
                              series={[
                                { label: "off", values: offVals, color: "#E1000F" },
                                { label: "def", values: defVals, color: "#001E50" },
                              ]}
                            />
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
                                {m.outcome !== "draw" ? ` (écart ${Math.abs(m.diff)})` : ""}
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

        {teamA.length > 0 && (
          <div style={{ marginTop: 14 }}>
            <div style={{ display: "flex", gap: 10 }}>
              {[
                { label: "Équipe A", team: teamA, side: "A" },
                { label: "Équipe B", team: teamB, side: "B" },
              ].map(({ label, team, side }) => {
                const sum = team.reduce((s, p) => s + overall(p), 0);
                return (
                  <div key={side} style={{ flex: 1, background: "#FFFFFF", border: "1px solid #E1E3E8", borderRadius: 8, padding: 10 }}>
                    <div style={{ fontSize: 12, fontWeight: 700, color: "#6B6C72", marginBottom: 6 }}>
                      {label} · {Math.round(sum)}
                    </div>
                    {team.map((p) => (
                      <div
                        key={p.id}
                        onClick={() => clickSwap(p, side)}
                        style={{
                          padding: "6px 6px",
                          borderRadius: 5,
                          fontSize: 13,
                          marginBottom: 3,
                          background: selSwap && selSwap.player.id === p.id ? "#FBE1E2" : "transparent",
                        }}
                      >
                        {p.name}
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
            <div style={{ fontSize: 11, color: "#6B6C72", marginTop: 6 }}>
              Touche un joueur de chaque équipe pour permuter leurs places.
              {options[optIdx]
                ? ` Écart d'équilibre ${Math.round(options[optIdx].diff)} pts · ${
                    options[optIdx].repeats > 0
                      ? "quelques binômes des dernières semaines reconduits"
                      : "aucun binôme récent reconduit"
                  }.`
                : ""}
            </div>

            {options.length > 1 && (
              <button
                onClick={cycleOption}
                style={{
                  marginTop: 8,
                  background: "none",
                  border: "1px solid #001E50",
                  color: "#001E50",
                  borderRadius: 6,
                  padding: "7px 12px",
                  fontSize: 13,
                  fontWeight: 600,
                }}
              >
                Autre proposition ({optIdx + 1}/{options.length})
              </button>
            )}

            <div style={{ marginTop: 14 }}>
              <label style={{ fontSize: 12, color: "#6B6C72", display: "block", marginBottom: 4 }}>
                Résultat
              </label>
              <div style={{ display: "flex", gap: 6 }}>
                {[
                  { key: "A", label: "A gagne" },
                  { key: "draw", label: "Nul" },
                  { key: "B", label: "B gagne" },
                ].map((o) => (
                  <button
                    key={o.key}
                    onClick={() => {
                      setWinner(o.key);
                      if (o.key === "draw") setMarginInput("");
                    }}
                    style={{
                      flex: 1,
                      padding: "8px 6px",
                      borderRadius: 6,
                      border: winner === o.key ? "2px solid #001E50" : "1px solid #E1E3E8",
                      background: winner === o.key ? "#E7ECF5" : "#FFFFFF",
                      fontWeight: 600,
                      fontSize: 13,
                    }}
                  >
                    {o.label}
                  </button>
                ))}
              </div>

              {winner && winner !== "draw" && (
                <>
                  <label style={{ fontSize: 12, color: "#6B6C72", display: "block", margin: "10px 0 4px" }}>
                    Écart de buts
                  </label>
                  <input
                    type="number"
                    inputMode="numeric"
                    min="1"
                    value={marginInput}
                    onChange={(e) => setMarginInput(e.target.value)}
                    placeholder="ex: 6"
                    style={{ width: "100%", padding: "9px 10px", borderRadius: 6, border: "1px solid #E1E3E8", fontSize: 14 }}
                  />
                </>
              )}
              <div style={{ fontSize: 11.5, color: "#6B6C72", marginTop: 5 }}>
                Seuils actuels — petit ≤ {effectiveThresholds.small}, moyen ≤ {effectiveThresholds.medium}
                {effectiveThresholds.n
                  ? ` (terciles sur ${effectiveThresholds.n} match${effectiveThresholds.n > 1 ? "s" : ""})`
                  : thresholdMode === "manual"
                  ? " (réglage manuel)"
                  : " (valeurs par défaut — encore trop peu de matchs pour calculer des terciles)"}
              </div>

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

      {/* SETTINGS */}
      <section style={{ padding: "6px 20px" }}>
        <button
          onClick={() => setShowSettings((s) => !s)}
          style={{
            background: "none",
            border: "none",
            color: "#001E50",
            fontWeight: 700,
            fontSize: 14,
            padding: 0,
          }}
        >
          {showSettings ? "▾" : "▸"} Réglages des seuils d'écart
        </button>
        {showSettings && (
          <div style={{ marginTop: 10, background: "#FFFFFF", border: "1px solid #E1E3E8", borderRadius: 8, padding: 12 }}>
            <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
              {[
                { key: "auto", label: "Automatique (terciles)" },
                { key: "manual", label: "Manuel" },
              ].map((o) => (
                <button
                  key={o.key}
                  onClick={() => persistThresholds(o.key, manualSmall, manualMedium)}
                  style={{
                    flex: 1,
                    padding: "8px 6px",
                    borderRadius: 6,
                    border: thresholdMode === o.key ? "2px solid #001E50" : "1px solid #E1E3E8",
                    background: thresholdMode === o.key ? "#E7ECF5" : "#FFFFFF",
                    fontWeight: 600,
                    fontSize: 13,
                  }}
                >
                  {o.label}
                </button>
              ))}
            </div>

            {thresholdMode === "auto" ? (
              <div style={{ fontSize: 12.5, color: "#6B6C72" }}>
                {autoTh
                  ? `Calculés sur ${autoTh.n} match${autoTh.n > 1 ? "s" : ""} : petit ≤ ${autoTh.small}, moyen ≤ ${autoTh.medium}. Les seuils se remettent à jour à chaque match enregistré — plus vous en jouez, plus ils sont fiables (une douzaine de matchs donne des terciles solides).`
                  : `Il faut au moins 6 matchs enregistrés pour calculer des terciles (${matches.length}/6 pour l'instant). En attendant, les valeurs par défaut sont utilisées : petit ≤ ${DEFAULT_THRESHOLDS.small}, moyen ≤ ${DEFAULT_THRESHOLDS.medium}.`}
              </div>
            ) : (
              <div>
                <label style={{ fontSize: 12, color: "#6B6C72", display: "block", marginBottom: 4 }}>
                  Petit écart si ≤
                </label>
                <input
                  type="number"
                  value={manualSmall}
                  onChange={(e) => persistThresholds("manual", Number(e.target.value), manualMedium)}
                  style={{ width: 80, padding: "7px 8px", borderRadius: 6, border: "1px solid #E1E3E8" }}
                />
                <label style={{ fontSize: 12, color: "#6B6C72", display: "block", margin: "10px 0 4px" }}>
                  Moyen écart si ≤
                </label>
                <input
                  type="number"
                  value={manualMedium}
                  onChange={(e) => persistThresholds("manual", manualSmall, Number(e.target.value))}
                  style={{ width: 80, padding: "7px 8px", borderRadius: 6, border: "1px solid #E1E3E8" }}
                />
                <div style={{ fontSize: 11.5, color: "#6B6C72", marginTop: 8 }}>
                  Au-delà de ce deuxième seuil, l'écart est considéré comme large.
                </div>
              </div>
            )}
          </div>
        )}
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
        {undo && matches.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <button
              onClick={undoLastMatch}
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
              Annuler le dernier match
            </button>
            <div style={{ fontSize: 11.5, color: "#6B6C72", marginTop: 5 }}>
              Restaure les notes d'avant le dernier résultat enregistré et le retire de
              l'historique. Disponible pour le dernier match seulement.
            </div>
          </div>
        )}
        {showHistory && (
          <div style={{ marginTop: 10, display: "flex", flexDirection: "column", gap: 6 }}>
            {matches.length === 0 && (
              <div style={{ fontSize: 13, color: "#6B6C72" }}>Aucun match enregistré pour l'instant.</div>
            )}
            {matches.map((m) => (
              <div
                key={m.id}
                style={{ background: "#FFFFFF", border: "1px solid #E1E3E8", borderRadius: 8, padding: 9, fontSize: 12.5 }}
              >
                <div style={{ color: "#6B6C72", marginBottom: 3 }}>
                  {new Date(m.date).toLocaleDateString("fr-FR", { day: "2-digit", month: "short", year: "numeric" })}
                </div>
                <div style={{ fontWeight: m.outcome === "A" ? 700 : 400 }}>
                  {m.teamA.join(", ")} {m.outcome === "A" ? "✓" : ""}
                </div>
                <div style={{ fontWeight: m.outcome === "B" ? 700 : 400 }}>
                  {m.teamB.join(", ")} {m.outcome === "B" ? "✓" : ""}
                </div>
                <div style={{ color: "#6B6C72", marginTop: 3 }}>
                  {m.outcome === "draw"
                    ? "Match nul"
                    : `Écart ${Math.abs(m.diff)} (${m.tier === "small" ? "petit" : m.tier === "medium" ? "moyen" : "large"})`}
                  {m.mvpOffName ? ` · MVP att. ${m.mvpOffName}` : ""}
                  {m.mvpDefName ? ` · MVP déf. ${m.mvpDefName}` : ""}
                </div>
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
