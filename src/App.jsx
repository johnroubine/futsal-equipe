import React, { useState, useEffect, useMemo, useRef } from "react";
import { storage } from "./storage";

const K = 24; // vitesse d'ajustement des notes
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

function bestSplits(players) {
  // players: array of player objects present this week
  const n = players.length;
  const half = Math.floor(n / 2);
  if (n < 2) return [];
  const idxCombos = combos(
    players.map((_, i) => i),
    half
  );
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
    const diff = Math.abs(sumA - sumB) + 0.3 * Math.abs(offA - offB) + 0.3 * Math.abs(defA - defB);
    options.push({ teamA, teamB, diff, sumA, sumB });
  }
  options.sort((a, b) => a.diff - b.diff);
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

// Met à jour les notes à partir du résultat (victoire/nul/défaite) et d'un
// palier d'écart, plutôt que d'un score exact — plus robuste sur des matchs
// à 20-25 buts où l'écart final est bruité. Même signal pour attaque et
// défense de chaque équipe ; seule l'attente (notes de chacun) les différencie.
function computeUpdateFromOutcome(teamA, teamB, outcome, tier) {
  const avg = (arr, key) => arr.reduce((s, p) => s + p[key], 0) / arr.length;
  const offA = avg(teamA, "off"),
    defA = avg(teamA, "def"),
    offB = avg(teamB, "off"),
    defB = avg(teamB, "def");
  const M = outcome === "draw" ? 1 : TIER_MULT[tier] || 1;
  const sA = outcome === "A" ? 1 : outcome === "draw" ? 0.5 : 0;
  const sB = 1 - sA;

  const dOffA = K * M * (sA - expected(offA - defB));
  const dDefA = K * M * (sA - expected(defA - offB));
  const dOffB = K * M * (sB - expected(offB - defA));
  const dDefB = K * M * (sB - expected(defB - offA));

  return { dOffA, dDefA, dOffB, dDefB };
}

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
  const [diffInput, setDiffInput] = useState("");
  const [mvpOff, setMvpOff] = useState("");
  const [mvpDef, setMvpDef] = useState("");
  const [showHistory, setShowHistory] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [thresholdMode, setThresholdMode] = useState("auto"); // "auto" | "manual"
  const [manualSmall, setManualSmall] = useState(2);
  const [manualMedium, setManualMedium] = useState(5);
  const [expandedPlayerId, setExpandedPlayerId] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    (async () => {
      try {
        const p = await storage.get("futsal-players").catch(() => null);
        const m = await storage.get("futsal-matches").catch(() => null);
        const t = await storage.get("futsal-thresholds").catch(() => null);
        if (p) setPlayers(JSON.parse(p.value));
        if (m) setMatches(JSON.parse(m.value));
        if (t) {
          const cfg = JSON.parse(t.value);
          setThresholdMode(cfg.mode || "auto");
          setManualSmall(cfg.small ?? 2);
          setManualMedium(cfg.medium ?? 5);
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
    persistPlayers(players.filter((p) => p.id !== id));
    setPresent((prev) => {
      const n = new Set(prev);
      n.delete(id);
      return n;
    });
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
    if (list.length < 2) {
      setError("Sélectionne au moins 2 joueurs présents.");
      return;
    }
    setError("");
    const opts = bestSplits(list);
    setOptions(opts);
    setOptIdx(0);
    setTeamA(opts[0].teamA);
    setTeamB(opts[0].teamB);
    setDiffInput("");
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
    const diff = Number(diffInput);
    if (!Number.isFinite(diff) || diffInput.trim() === "") {
      setError("Entre une différence de buts valide (ex: 6, ou -3 si B gagne, 0 si nul).");
      return;
    }
    if (teamA.length === 0 || teamB.length === 0) {
      setError("Génère d'abord les deux équipes.");
      return;
    }
    setError("");
    const outcome = diff > 0 ? "A" : diff < 0 ? "B" : "draw";
    const absDiff = Math.abs(diff);
    const tier =
      outcome === "draw"
        ? null
        : absDiff <= effectiveThresholds.small
        ? "small"
        : absDiff <= effectiveThresholds.medium
        ? "medium"
        : "large";
    const { dOffA, dDefA, dOffB, dDefB } = computeUpdateFromOutcome(teamA, teamB, outcome, tier);
    const idsA = new Set(teamA.map((p) => p.id));
    const idsB = new Set(teamB.map((p) => p.id));
    const next = players.map((p) => {
      let off = p.off,
        def = p.def,
        games = p.games;
      if (idsA.has(p.id)) {
        off += dOffA;
        def += dDefA;
        games += 1;
      } else if (idsB.has(p.id)) {
        off += dOffB;
        def += dDefB;
        games += 1;
      } else {
        return p;
      }
      if (p.id === mvpOff) off += MVP_BONUS;
      if (p.id === mvpDef) def += MVP_BONUS;
      return { ...p, off, def, games };
    });
    const allNames = new Map([...teamA, ...teamB].map((p) => [p.id, p.name]));
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
      },
      ...matches,
    ]);
    setTeamA([]);
    setTeamB([]);
    setOptions([]);
    setDiffInput("");
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
        padding: "0 0 40px 0",
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
                      style={{ width: 16, height: 16 }}
                    />
                    <div
                      onClick={() => setExpandedPlayerId(expanded ? null : p.id)}
                      style={{ flex: 1, display: "flex", alignItems: "center", gap: 8, cursor: "pointer" }}
                    >
                      <div style={{ flex: 1, fontSize: 14, fontWeight: 600 }}>{p.name}</div>
                      <Badge tone="off">Att {Math.round(p.off)}</Badge>
                      <Badge tone="def">Déf {Math.round(p.def)}</Badge>
                      <Badge>{Math.round(overall(p))}</Badge>
                    </div>
                    <button
                      onClick={() => toggleActive(p.id)}
                      style={{
                        background: "none",
                        border: "1px solid #E1E3E8",
                        borderRadius: 5,
                        color: "#6B6C72",
                        fontSize: 11.5,
                        padding: "4px 7px",
                        fontWeight: 600,
                      }}
                      aria-label={`Archiver ${p.name}`}
                    >
                      Archiver
                    </button>
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
                      <div style={{ display: "flex", gap: 12, marginBottom: 8, color: "#001E50", fontWeight: 600 }}>
                        <span>{stats.wins}V</span>
                        <span>{stats.draws}N</span>
                        <span>{stats.losses}D</span>
                        <span style={{ color: "#6B6C72", fontWeight: 400 }}>· {p.games} match{p.games > 1 ? "s" : ""} au total</span>
                      </div>
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
        <div className="of-title" style={{ fontSize: 15, marginBottom: 10, color: "#001E50" }}>
          Séance du jour — {present.size} présent{present.size > 1 ? "s" : ""}
        </div>
        <button
          onClick={generate}
          disabled={present.size < 2}
          style={{
            background: present.size < 2 ? "#E1E3E8" : "#E1000F",
            color: present.size < 2 ? "#6B6C72" : "#FFFFFF",
            border: "none",
            borderRadius: 6,
            padding: "10px 16px",
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
                Différence de buts (positif = A gagne, négatif = B gagne, 0 = nul)
              </label>
              <input
                type="number"
                value={diffInput}
                onChange={(e) => setDiffInput(e.target.value)}
                placeholder="ex: 6 ou -3"
                style={{ width: "100%", padding: "9px 10px", borderRadius: 6, border: "1px solid #E1E3E8", fontSize: 14 }}
              />
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
    </div>
  );
}
