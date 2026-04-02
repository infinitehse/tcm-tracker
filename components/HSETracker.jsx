"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { supabase } from "@/lib/supabase";
import { SHORT_CATS, SCORE_KEYS } from "@/lib/constants";
import * as XLSX from "xlsx";

/* ─── Helpers ─── */
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result.split(",")[1]);
    r.onerror = () => reject(new Error("Failed to read file"));
    r.readAsDataURL(file);
  });
}

function scoreColor(val) {
  if (val == null) return {};
  if (val === 100) return { color: "#22c55e", fontWeight: 700 };
  if (val >= 90) return { color: "#f59e0b", fontWeight: 600 };
  return { color: "#ef4444", fontWeight: 700 };
}

/* ─── Component ─── */
export default function HSETracker() {
  const [files, setFiles] = useState([]);
  const [previews, setPreviews] = useState([]);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState({ current: 0, total: 0, status: "" });
  const [results, setResults] = useState([]);
  const [corrections, setCorrections] = useState({});
  const [history, setHistory] = useState([]);
  const [pastCorrections, setPastCorrections] = useState([]);
  const [error, setError] = useState("");
  const [tab, setTab] = useState("upload");
  const [editingCell, setEditingCell] = useState(null);
  const [editValue, setEditValue] = useState("");
  const fileRef = useRef();
  const editRef = useRef();

  /* Load history */
  const loadHistory = useCallback(async () => {
    if (!supabase) return;
    try {
      const { data, error: err } = await supabase
        .from("inspection_scores")
        .select("*")
        .order("date", { ascending: false })
        .order("inspector_name", { ascending: true })
        .limit(500);
      if (err) throw err;
      setHistory(data || []);
    } catch (e) {
      console.error("History load failed:", e);
    }
  }, []);

  /* Load past corrections for AI learning */
  const loadCorrections = useCallback(async () => {
    if (!supabase) return;
    try {
      const { data, error: err } = await supabase
        .from("extraction_corrections")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(100);
      if (err) {
        console.warn("Corrections table may not exist yet:", err.message);
        return;
      }
      setPastCorrections(data || []);
    } catch (e) {
      console.warn("Could not load corrections:", e);
    }
  }, []);

  useEffect(() => {
    loadHistory();
    loadCorrections();
  }, [loadHistory, loadCorrections]);

  /* File handling */
  const handleFiles = (newFiles) => {
    const imgs = Array.from(newFiles).filter((f) => f.type.startsWith("image/"));
    setFiles((prev) => [...prev, ...imgs]);
    imgs.forEach((f) => {
      const reader = new FileReader();
      reader.onload = (e) =>
        setPreviews((prev) => [...prev, { name: f.name, src: e.target.result }]);
      reader.readAsDataURL(f);
    });
  };

  const removeFile = (idx) => {
    setFiles((prev) => prev.filter((_, i) => i !== idx));
    setPreviews((prev) => prev.filter((_, i) => i !== idx));
  };

  /* Build learning context from past corrections */
  const buildLearningContext = () => {
    if (pastCorrections.length === 0) return "";
    const patterns = {};
    pastCorrections.forEach((c) => {
      const key = c.category;
      if (!patterns[key]) patterns[key] = [];
      patterns[key].push({ ai: c.ai_value, correct: c.corrected_value });
    });

    let context = `\n\nIMPORTANT — LEARNING FROM PAST CORRECTIONS:
The AI has previously misread these categories. Pay extra attention:`;
    Object.entries(patterns).forEach(([cat, fixes]) => {
      const examples = fixes.slice(0, 3);
      context += `\n- "${cat}": Examples of past errors:`;
      examples.forEach((f) => {
        context += ` AI read ${f.ai}% but correct was ${f.correct}%.`;
      });
    });
    context += `\n\nDouble-check all bar chart values carefully. When a bar appears to touch the 100% line, verify the label above it.`;
    return context;
  };

  /* Extract via API route — with rate-limit handling */
  const extractAll = async () => {
    if (files.length === 0) return;
    setProcessing(true);
    setError("");
    setResults([]);
    setCorrections({});
    const extracted = [];
    const delay = (ms) => new Promise((r) => setTimeout(r, ms));
    const learningContext = buildLearningContext();

    for (let i = 0; i < files.length; i++) {
      if (i > 0) {
        for (let sec = 13; sec > 0; sec--) {
          setProgress({
            current: i + 1,
            total: files.length,
            status: `Rate limit cooldown... ${sec}s → then ${files[i].name}`,
          });
          await delay(1000);
        }
      }

      setProgress({
        current: i + 1,
        total: files.length,
        status: `Analyzing ${files[i].name}...`,
      });

      let attempts = 0;
      let success = false;

      while (attempts < 3 && !success) {
        try {
          const base64 = await fileToBase64(files[i]);
          const res = await fetch("/api/extract", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              image: base64,
              mediaType: files[i].type || "image/png",
              learningContext,
            }),
          });

          const json = await res.json();

          if (res.status === 429 || (json.error && json.error.includes("429"))) {
            attempts++;
            if (attempts < 3) {
              setProgress({
                current: i + 1,
                total: files.length,
                status: `Rate limited, retrying in 20s... (attempt ${attempts + 1}/3)`,
              });
              await delay(20000);
              continue;
            }
            throw new Error("Rate limit exceeded after 3 retries");
          }

          if (!res.ok || json.error) throw new Error(json.error || "Extraction failed");
          extracted.push({ ...json.data, _file: files[i].name, _status: "success" });
          success = true;
        } catch (e) {
          if (attempts >= 2 || !e.message.includes("Rate limit")) {
            extracted.push({ _file: files[i].name, _status: "error", _error: e.message });
            success = true;
          }
        }
      }
    }

    setResults(extracted);
    setProcessing(false);
    setTab("results");
  };

  /* ─── Edit a result cell ─── */
  const startEdit = (rowIdx, key, currentVal) => {
    setEditingCell(`${rowIdx}-${key}`);
    setEditValue(String(currentVal ?? ""));
    setTimeout(() => editRef.current?.focus(), 50);
  };

  const commitEdit = (rowIdx, key) => {
    const newVal = parseInt(editValue, 10);
    if (isNaN(newVal) || newVal < 0 || newVal > 100) {
      setEditingCell(null);
      return;
    }

    setResults((prev) => {
      const updated = [...prev];
      const row = { ...updated[rowIdx] };
      const isScoreKey = SCORE_KEYS.includes(key);
      const oldVal = isScoreKey ? row.scores?.[key] : row[key];

      if (oldVal !== newVal) {
        const corrKey = `${rowIdx}-${key}`;
        setCorrections((prev) => ({
          ...prev,
          [corrKey]: {
            original: prev[corrKey]?.original ?? oldVal,
            corrected: newVal,
            category: key,
            inspector: row.inspector_name,
            date: row.date,
            package: row.package,
          },
        }));

        if (isScoreKey) {
          row.scores = { ...row.scores, [key]: newVal };
        } else {
          row[key] = newVal;
        }
        updated[rowIdx] = row;
      }
      return updated;
    });
    setEditingCell(null);
  };

  const cancelEdit = () => {
    setEditingCell(null);
    setEditValue("");
  };

  /* Save to Supabase + save corrections for learning */
  const saveToSupabase = async () => {
    if (!supabase) {
      setError("Supabase not configured. Add credentials to .env.local");
      return;
    }
    const valid = results.filter((r) => r._status === "success");
    if (valid.length === 0) return;

    setProcessing(true);
    setError("");

    try {
      for (let i = 0; i < valid.length; i++) {
        setProgress({
          current: i + 1,
          total: valid.length,
          status: `Saving ${valid[i].inspector_name}...`,
        });

        const r = valid[i];
        const row = {
          inspector_email: r.inspector_email,
          inspector_name: r.inspector_name,
          date: r.date,
          package: r.package,
          overall_compliance: r.overall_compliance,
          ...r.scores,
        };

        const { error: err } = await supabase.from("inspection_scores").upsert(row, {
          onConflict: "inspector_email,date,package",
        });
        if (err) throw err;
      }

      // Save corrections for AI learning
      const corrEntries = Object.values(corrections).filter(
        (c) => c.original !== c.corrected
      );

      if (corrEntries.length > 0) {
        setProgress({ current: 0, total: 0, status: "Saving corrections for AI learning..." });
        for (const c of corrEntries) {
          try {
            await supabase.from("extraction_corrections").insert({
              inspector_name: c.inspector,
              date: c.date,
              package: c.package,
              category: c.category,
              ai_value: c.original,
              corrected_value: c.corrected,
            });
          } catch (e) {
            console.warn("Correction save failed:", e);
          }
        }
        await loadCorrections();
      }

      setCorrections({});
      await loadHistory();
      setTab("history");
    } catch (e) {
      setError(`Save failed: ${e.message}`);
    }
    setProcessing(false);
  };

  /* Export Excel */
  const exportExcel = (data, filename = "inspection_scores") => {
    const rows = data.map((r) => {
      const row = {
        Date: r.date,
        Inspector: r.inspector_name || r.inspector_email,
        Package: r.package,
        "Overall %": r.overall_compliance,
      };
      SCORE_KEYS.forEach((k, i) => {
        row[SHORT_CATS[i]] = r.scores?.[k] ?? r[k] ?? "";
      });
      return row;
    });
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Scores");
    ws["!cols"] = Object.keys(rows[0] || {}).map((k) => ({
      wch: Math.max(k.length, ...rows.map((r) => String(r[k] || "").length)) + 2,
    }));
    XLSX.writeFile(wb, `${filename}_${new Date().toISOString().slice(0, 10)}.xlsx`);
  };

  const correctionCount = Object.keys(corrections).filter(
    (k) => corrections[k].original !== corrections[k].corrected
  ).length;

  /* ─── RENDER ─── */
  return (
    <div style={S.root}>
      {/* Header */}
      <header style={S.header}>
        <div style={S.headerLeft}>
          <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
            <rect x="2" y="2" width="24" height="24" rx="4" stroke="#f59e0b" strokeWidth="2" />
            <path d="M8 20V12M14 20V8M20 20V14" stroke="#f59e0b" strokeWidth="2.5" strokeLinecap="round" />
          </svg>
          <div>
            <h1 style={S.headerTitle}>HSE Score Tracker</h1>
            <p style={S.headerSub}>Inspection Dashboard Analyzer</p>
          </div>
          {pastCorrections.length > 0 && (
            <div style={S.learningBadge}>
              🧠 {pastCorrections.length} correction{pastCorrections.length > 1 ? "s" : ""} learned
            </div>
          )}
        </div>
        <div style={S.headerRight}>
          <span style={S.creditLine}>Built by <strong style={{ color: "#f9fafb" }}>Amr Abousamra</strong></span>
          <span style={S.creditLine}>from <strong style={{ color: "#f59e0b" }}>Infinite HSE</strong> for Safety Solutions</span>
        </div>
      </header>

      {/* Welcome */}
      <div style={S.welcome}>
        <h2 style={S.welcomeTitle}>Welcome, Amjad</h2>
        <p style={S.welcomeDesc}>
          Upload daily HSE inspection dashboard screenshots. The AI extracts all scores automatically.
          Review and correct any values before saving — the AI learns from your corrections over time.
        </p>
      </div>

      {/* Tabs */}
      <div style={S.tabs}>
        {["upload", "results", "history"].map((t) => (
          <button
            key={t}
            style={{ ...S.tab, ...(tab === t ? S.tabActive : {}) }}
            onClick={() => setTab(t)}
          >
            {t === "upload" && "📤 Upload"}
            {t === "results" && `📊 Results${results.length ? ` (${results.length})` : ""}`}
            {t === "history" && `📋 History${history.length ? ` (${history.length})` : ""}`}
          </button>
        ))}
      </div>

      {error && (
        <div style={S.error}>
          {error}
          <button style={S.errorClose} onClick={() => setError("")}>×</button>
        </div>
      )}

      {/* ── Upload Tab ── */}
      {tab === "upload" && (
        <div style={S.section}>
          <div
            style={S.dropzone}
            onDragOver={(e) => { e.preventDefault(); e.currentTarget.style.borderColor = "#f59e0b"; }}
            onDragLeave={(e) => { e.currentTarget.style.borderColor = "#2a2d35"; }}
            onDrop={(e) => { e.preventDefault(); e.currentTarget.style.borderColor = "#2a2d35"; handleFiles(e.dataTransfer.files); }}
            onClick={() => fileRef.current?.click()}
          >
            <input ref={fileRef} type="file" multiple accept="image/*" style={{ display: "none" }}
              onChange={(e) => handleFiles(e.target.files)} />
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#4a4d55" strokeWidth="1.5">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12" />
            </svg>
            <p style={{ fontSize: 15, color: "#9ca3af" }}>Drop dashboard screenshots here or click to browse</p>
            <p style={{ fontSize: 12, color: "#4b5563" }}>Upload one screenshot per inspector per day</p>
          </div>

          {previews.length > 0 && (
            <div style={S.previewGrid}>
              {previews.map((p, i) => (
                <div key={i} style={S.previewCard}>
                  <img src={p.src} alt={p.name} style={S.previewImg} />
                  <div style={S.previewInfo}>
                    <span style={S.previewName}>{p.name}</span>
                    <button style={S.removeBtn} onClick={() => removeFile(i)}>×</button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {previews.length > 0 && (
            <div style={S.actions}>
              <button style={S.primaryBtn} onClick={extractAll} disabled={processing}>
                {processing ? (
                  <><span style={S.spinner} /> {progress.status}</>
                ) : (
                  `🔍 Extract Scores (${files.length} image${files.length > 1 ? "s" : ""})`
                )}
              </button>
              <button style={S.secondaryBtn} onClick={() => { setFiles([]); setPreviews([]); }}>
                Clear All
              </button>
            </div>
          )}
        </div>
      )}

      {/* ── Results Tab (EDITABLE) ── */}
      {tab === "results" && (
        <div style={S.section}>
          {results.length === 0 ? (
            <div style={S.empty}>No results yet. Upload and extract screenshots first.</div>
          ) : (
            <>
              <div style={{ display: "flex", gap: 8, marginBottom: 12, alignItems: "center", flexWrap: "wrap" }}>
                <span style={S.badge}>
                  {results.filter((r) => r._status === "success").length} extracted
                </span>
                {results.some((r) => r._status === "error") && (
                  <span style={{ ...S.badge, background: "#7f1d1d", color: "#fca5a5" }}>
                    {results.filter((r) => r._status === "error").length} failed
                  </span>
                )}
                {correctionCount > 0 && (
                  <span style={{ ...S.badge, background: "#7c3aed33", color: "#c4b5fd", border: "1px solid #7c3aed" }}>
                    ✏️ {correctionCount} correction{correctionCount > 1 ? "s" : ""} pending
                  </span>
                )}
                <span style={{ fontSize: 11, color: "#6b7280", marginLeft: 8 }}>
                  💡 Click any score to edit before saving
                </span>
              </div>

              <div style={S.tableWrap}>
                <table style={S.table}>
                  <thead>
                    <tr>
                      <th style={{ ...S.th, position: "sticky", left: 0, zIndex: 3, textAlign: "left" }}>Inspector</th>
                      <th style={S.th}>Date</th>
                      <th style={S.th}>Package</th>
                      <th style={S.th}>Overall</th>
                      {SHORT_CATS.map((c, i) => (
                        <th key={i} style={{ ...S.th, fontSize: 10 }}>{c}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {results.filter((r) => r._status === "success").map((r, ri) => {
                      const prev = history.find(
                        (h) => h.inspector_name === r.inspector_name && h.package === r.package && (h.date || "") < (r.date || "")
                      );
                      return (
                        <tr key={ri} style={ri % 2 === 0 ? { background: "#1a1d2310" } : {}}>
                          <td style={{ ...S.td, position: "sticky", left: 0, background: ri % 2 === 0 ? "#151720" : "#0f1117", fontWeight: 600, textAlign: "left", paddingLeft: 12, whiteSpace: "nowrap" }}>
                            {r.inspector_name || r.inspector_email}
                          </td>
                          <td style={S.td}>{r.date}</td>
                          <td style={S.td}>{r.package}</td>
                          <EditableCell cellKey={`${ri}-overall_compliance`} value={r.overall_compliance}
                            editingCell={editingCell} editValue={editValue} editRef={editRef} corrections={corrections}
                            onStart={() => startEdit(ri, "overall_compliance", r.overall_compliance)}
                            onChange={setEditValue} onCommit={() => commitEdit(ri, "overall_compliance")} onCancel={cancelEdit} />
                          {SCORE_KEYS.map((k, ki) => {
                            const val = r.scores?.[k];
                            const prevVal = prev?.[k];
                            const changed = prevVal != null && prevVal !== val;
                            const same = prevVal != null && prevVal === val && val < 100;
                            return (
                              <EditableCell key={ki} cellKey={`${ri}-${k}`} value={val}
                                editingCell={editingCell} editValue={editValue} editRef={editRef} corrections={corrections}
                                wasChanged={changed} wasSame={same} prevVal={prevVal}
                                onStart={() => startEdit(ri, k, val)}
                                onChange={setEditValue} onCommit={() => commitEdit(ri, k)} onCancel={cancelEdit} />
                            );
                          })}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {results.some((r) => r._status === "error") && (
                <div style={S.errorsBlock}>
                  <h4 style={{ color: "#fca5a5", marginBottom: 8 }}>Failed:</h4>
                  {results.filter((r) => r._status === "error").map((r, i) => (
                    <div key={i} style={{ fontSize: 12, color: "#fca5a5", marginBottom: 4 }}>📁 {r._file}: {r._error}</div>
                  ))}
                </div>
              )}

              <div style={S.actions}>
                {supabase && (
                  <button style={S.primaryBtn} onClick={saveToSupabase} disabled={processing}>
                    {processing ? (
                      <><span style={S.spinner} /> Saving...</>
                    ) : (
                      <>💾 Review Complete — Save{correctionCount > 0 ? ` (${correctionCount} corrections)` : ""}</>
                    )}
                  </button>
                )}
                <button style={S.secondaryBtn}
                  onClick={() => exportExcel(results.filter((r) => r._status === "success"))}>
                  📥 Export Excel
                </button>
              </div>
              <Legend showEdited />
            </>
          )}
        </div>
      )}

      {/* ── History Tab ── */}
      {tab === "history" && (
        <div style={S.section}>
          {!supabase ? (
            <div style={S.empty}>Supabase not configured. Add credentials to .env.local</div>
          ) : history.length === 0 ? (
            <div style={S.empty}>No historical data yet.</div>
          ) : (
            <>
              <div style={S.actions}>
                <button style={S.secondaryBtn} onClick={() => exportExcel(history, "history")}>📥 Export Full History</button>
                <button style={S.secondaryBtn} onClick={loadHistory}>🔄 Refresh</button>
              </div>
              <ReadOnlyTable data={history} history={history} />
              <Legend />
            </>
          )}
        </div>
      )}

      <footer style={S.footer}>Powered by Claude Vision + Supabase · © {new Date().getFullYear()} Infinite HSE</footer>
    </div>
  );
}

/* ─── Editable Cell ─── */
function EditableCell({ cellKey, value, editingCell, editValue, editRef, corrections, wasChanged, wasSame, prevVal, onStart, onChange, onCommit, onCancel }) {
  const isEditing = editingCell === cellKey;
  const corrInfo = corrections[cellKey];
  const edited = corrInfo && corrInfo.original !== corrInfo.corrected;

  return (
    <td
      style={{
        ...S.td, ...scoreColor(value), cursor: "pointer", position: "relative", minWidth: 52,
        ...(wasChanged && !edited ? { background: "#1e3a5f44", borderLeft: "2px solid #3b82f6" } : {}),
        ...(wasSame && !edited ? { background: "#4c1d9544", borderLeft: "2px solid #7c3aed" } : {}),
        ...(edited ? { background: "#15803d33", borderLeft: "2px solid #22c55e", outline: "1px dashed #22c55e55" } : {}),
      }}
      onClick={() => !isEditing && onStart()}
    >
      {isEditing ? (
        <input ref={editRef} type="number" min="0" max="100" value={editValue}
          onChange={(e) => onChange(e.target.value)} onBlur={onCommit}
          onKeyDown={(e) => { if (e.key === "Enter") onCommit(); if (e.key === "Escape") onCancel(); }}
          style={S.cellInput} />
      ) : (
        <>
          {value != null ? `${value}%` : "—"}
          {wasChanged && !edited && <span style={{ fontSize: 9, marginLeft: 2, color: "#60a5fa" }}>{value > prevVal ? "↑" : "↓"}</span>}
          {wasSame && !edited && <span style={{ fontSize: 9, marginLeft: 2, color: "#a78bfa" }}>═</span>}
          {edited && <span style={{ fontSize: 8, marginLeft: 2, color: "#86efac" }}>✏️{corrInfo.original}→{corrInfo.corrected}</span>}
        </>
      )}
    </td>
  );
}

/* ─── Read-only Table (History) ─── */
function ReadOnlyTable({ data, history }) {
  return (
    <div style={S.tableWrap}>
      <table style={S.table}>
        <thead>
          <tr>
            <th style={{ ...S.th, position: "sticky", left: 0, zIndex: 3, textAlign: "left" }}>Inspector</th>
            <th style={S.th}>Date</th>
            <th style={S.th}>Package</th>
            <th style={S.th}>Overall</th>
            {SHORT_CATS.map((c, i) => <th key={i} style={{ ...S.th, fontSize: 10 }}>{c}</th>)}
          </tr>
        </thead>
        <tbody>
          {data.map((r, ri) => {
            const prev = history.find(
              (h) => h.inspector_name === r.inspector_name && h.package === r.package && (h.date || "") < (r.date || "") && h !== r
            );
            return (
              <tr key={ri} style={ri % 2 === 0 ? { background: "#1a1d2310" } : {}}>
                <td style={{ ...S.td, position: "sticky", left: 0, background: ri % 2 === 0 ? "#151720" : "#0f1117", fontWeight: 600, textAlign: "left", paddingLeft: 12, whiteSpace: "nowrap" }}>
                  {r.inspector_name || r.inspector_email}
                </td>
                <td style={S.td}>{r.date}</td>
                <td style={S.td}>{r.package}</td>
                <td style={{ ...S.td, ...scoreColor(r.overall_compliance) }}>{r.overall_compliance}%</td>
                {SCORE_KEYS.map((k, ki) => {
                  const val = r[k];
                  const prevVal = prev?.[k];
                  const changed = prevVal != null && prevVal !== val;
                  const same = prevVal != null && prevVal === val && val < 100;
                  return (
                    <td key={ki} style={{ ...S.td, ...scoreColor(val),
                      ...(changed ? { background: "#1e3a5f44", borderLeft: "2px solid #3b82f6" } : {}),
                      ...(same ? { background: "#4c1d9544", borderLeft: "2px solid #7c3aed" } : {}),
                    }}>
                      {val != null ? `${val}%` : "—"}
                      {changed && <span style={{ fontSize: 9, marginLeft: 2, color: "#60a5fa" }}>{val > prevVal ? "↑" : "↓"}</span>}
                      {same && <span style={{ fontSize: 9, marginLeft: 2, color: "#a78bfa" }}>═</span>}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/* ─── Legend ─── */
function Legend({ showEdited }) {
  const items = [
    { color: "#22c55e", label: "100% Compliant" },
    { color: "#f59e0b", label: "Partially (90-99%)" },
    { color: "#ef4444", label: "Below 90%" },
    { color: "#3b82f6", label: "Changed from previous day", border: "#60a5fa" },
    { color: "#7c3aed", label: "Same score (not 100%) — suspicious" },
  ];
  if (showEdited) items.push({ color: "#22c55e", label: "Manually corrected (green dashed)", border: "#22c55e" });
  return (
    <div style={S.legend}>
      {items.map((it, i) => (
        <span key={i} style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: "#9ca3af" }}>
          <span style={{ width: 10, height: 10, borderRadius: "50%", background: it.color, display: "inline-block", ...(it.border ? { border: `2px solid ${it.border}` } : {}) }} />
          {it.label}
        </span>
      ))}
    </div>
  );
}

/* ─── Styles ─── */
const S = {
  root: { minHeight: "100vh" },
  header: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "16px 24px", borderBottom: "1px solid #1e2028", background: "#14161b" },
  headerLeft: { display: "flex", alignItems: "center", gap: 12 },
  headerRight: { display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2 },
  creditLine: { fontSize: 12, color: "#9ca3af", letterSpacing: 0.3 },
  headerTitle: { fontSize: 18, fontWeight: 700, color: "#f59e0b", fontFamily: "'Space Mono', monospace" },
  headerSub: { fontSize: 11, color: "#6b7280", letterSpacing: 1, textTransform: "uppercase" },
  learningBadge: { fontSize: 11, color: "#a78bfa", background: "#7c3aed22", padding: "4px 10px", borderRadius: 8, border: "1px solid #7c3aed44" },
  welcome: { padding: "28px 24px 20px", animation: "fadeIn 0.5s ease" },
  welcomeTitle: { fontSize: 28, fontWeight: 300, color: "#f9fafb", marginBottom: 6 },
  welcomeDesc: { fontSize: 14, color: "#6b7280", lineHeight: 1.6, maxWidth: 700 },
  tabs: { display: "flex", gap: 0, padding: "0 24px", borderBottom: "1px solid #1e2028" },
  tab: { padding: "10px 20px", fontSize: 13, color: "#6b7280", background: "transparent", border: "none", borderBottom: "2px solid transparent", cursor: "pointer" },
  tabActive: { color: "#f59e0b", borderBottomColor: "#f59e0b" },
  section: { padding: "20px 24px", animation: "fadeIn 0.3s ease" },
  dropzone: { border: "2px dashed #2a2d35", borderRadius: 12, padding: "48px 24px", textAlign: "center", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 12, transition: "border-color 0.3s" },
  previewGrid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))", gap: 12, marginTop: 16 },
  previewCard: { background: "#14161b", borderRadius: 8, overflow: "hidden", border: "1px solid #2a2d35" },
  previewImg: { width: "100%", height: 120, objectFit: "cover" },
  previewInfo: { display: "flex", justifyContent: "space-between", alignItems: "center", padding: "8px 10px" },
  previewName: { fontSize: 11, color: "#6b7280", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 150 },
  removeBtn: { width: 22, height: 22, borderRadius: "50%", border: "none", background: "#7f1d1d", color: "#fca5a5", cursor: "pointer", fontSize: 14, display: "flex", alignItems: "center", justifyContent: "center" },
  actions: { display: "flex", gap: 10, marginTop: 16, flexWrap: "wrap" },
  primaryBtn: { padding: "10px 24px", background: "#f59e0b", color: "#0f1117", border: "none", borderRadius: 8, fontSize: 14, fontWeight: 600, cursor: "pointer", display: "flex", alignItems: "center", gap: 8 },
  secondaryBtn: { padding: "10px 20px", background: "#1e2028", color: "#9ca3af", border: "1px solid #2a2d35", borderRadius: 8, fontSize: 13, cursor: "pointer" },
  spinner: { display: "inline-block", width: 14, height: 14, border: "2px solid #0f1117", borderTopColor: "transparent", borderRadius: "50%", animation: "spin 0.6s linear infinite" },
  tableWrap: { overflowX: "auto", marginTop: 16, borderRadius: 8, border: "1px solid #1e2028" },
  table: { width: "100%", borderCollapse: "collapse", fontSize: 12, whiteSpace: "nowrap" },
  th: { padding: "10px 8px", background: "#14161b", color: "#6b7280", textAlign: "center", fontWeight: 600, fontSize: 10, textTransform: "uppercase", letterSpacing: 0.5, borderBottom: "2px solid #f59e0b22", position: "sticky", top: 0, zIndex: 2 },
  td: { padding: "8px 6px", textAlign: "center", borderBottom: "1px solid #1e2028", fontSize: 12 },
  cellInput: { width: 48, padding: "2px 4px", background: "#1e2028", border: "1px solid #f59e0b", borderRadius: 4, color: "#f9fafb", fontSize: 12, textAlign: "center", outline: "none" },
  badge: { padding: "4px 10px", borderRadius: 12, fontSize: 12, background: "#14532d", color: "#86efac" },
  empty: { textAlign: "center", padding: 48, color: "#4b5563", fontSize: 14 },
  errorsBlock: { marginTop: 16, padding: 16, background: "#1a0505", border: "1px solid #7f1d1d", borderRadius: 8 },
  error: { margin: "12px 24px", padding: "10px 16px", background: "#7f1d1d", color: "#fca5a5", borderRadius: 8, fontSize: 13, display: "flex", justifyContent: "space-between", alignItems: "center" },
  errorClose: { background: "none", border: "none", color: "#fca5a5", fontSize: 18, cursor: "pointer" },
  legend: { marginTop: 16, display: "flex", gap: 16, flexWrap: "wrap", padding: 12, background: "#14161b", borderRadius: 8 },
  footer: { textAlign: "center", padding: 20, fontSize: 12, color: "#6b7280", borderTop: "1px solid #1e2028", marginTop: 32 },
};
