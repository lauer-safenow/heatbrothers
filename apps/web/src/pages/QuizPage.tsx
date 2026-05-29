import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import "./QuizPage.css";

interface CountryEntry { code: string; count: number; }
interface ZoneEntry { id: string; name: string; image: string | null; count: number; }

interface QuizData {
  mode: "country" | "zone";
  timePeriod: "today" | "this week" | "this month";
  // country mode
  eventType?: string;
  displayName?: string;
  countries?: CountryEntry[];
  // zone mode
  zones?: ZoneEntry[];
  correctIndex: number;
}

type Phase = "loading" | "question" | "reveal" | "exiting";

interface QuizRecord {
  timestamp: number;
  correct: boolean;
  unanswered?: boolean;
  label: string;
  options: string;
  quiz: QuizData;
}

const HISTORY_KEY = "heatbrothers-quiz-history";
const MAX_HISTORY = 50;

function loadHistory(): QuizRecord[] {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]"); } catch { return []; }
}

function appendRecord(record: QuizRecord, prev: QuizRecord[]): QuizRecord[] {
  const next = [record, ...prev].slice(0, MAX_HISTORY);
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(next)); } catch {}
  return next;
}

function relativeTime(ts: number): string {
  const m = Math.floor((Date.now() - ts) / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

const regionNames = new Intl.DisplayNames(["en"], { type: "region" });

function countryFlag(cc: string): string {
  if (cc.length !== 2) return "🏳";
  const offset = 0x1f1e6 - 65;
  const a = cc.charCodeAt(0);
  const b = cc.charCodeAt(1);
  if (a < 65 || a > 90 || b < 65 || b > 90) return "🏳";
  return String.fromCodePoint(a + offset, b + offset);
}

function getCountryName(code: string): string {
  try { return regionNames.of(code.toUpperCase()) ?? code; } catch { return code; }
}

function CountTween({ target, active }: { target: number; active: boolean }) {
  const [val, setVal] = useState(0);
  const rafRef = useRef<number>(0);

  useEffect(() => {
    if (!active) { setVal(0); return; }
    const delayId = setTimeout(() => {
      const duration = 1400;
      const start = performance.now();
      function step(now: number) {
        const p = Math.min((now - start) / duration, 1);
        setVal(Math.round(target * (1 - Math.pow(1 - p, 3))));
        if (p < 1) rafRef.current = requestAnimationFrame(step);
        else setVal(target);
      }
      rafRef.current = requestAnimationFrame(step);
    }, 500);
    return () => { clearTimeout(delayId); cancelAnimationFrame(rafRef.current); };
  }, [target, active]);

  return <>{val.toLocaleString()}</>;
}

export function QuizPage() {
  const navigate = useNavigate();
  const [phase, setPhase] = useState<Phase>("loading");
  const [quiz, setQuiz] = useState<QuizData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [questionKey, setQuestionKey] = useState(0);
  const [namesVisible, setNamesVisible] = useState(false);
  const [copied, setCopied] = useState(false);
  const [guessedIndex, setGuessedIndex] = useState<number | null>(null);
  const [showConfetti, setShowConfetti] = useState(false);
  const [history, setHistory] = useState<QuizRecord[]>(() => loadHistory());
  const [showHistory, setShowHistory] = useState(false);
  const initialLoadDone = useRef(false);
  const guessedIndexRef = useRef<number | null>(null);
  const prevPhaseRef = useRef<Phase>("loading");

  const confettiData = useMemo(() =>
    Array.from({ length: 72 }, (_, i) => ({
      id: i,
      left: Math.random() * 100,
      delay: Math.random() * 0.7,
      duration: 0.9 + Math.random() * 1.1,
      color: ["#FF6B6B","#4ECDC4","#FFE66D","#A8E6CF","#FFB347","#C3A6FF","#70D6FF"][i % 7],
      width: 6 + Math.random() * 8,
      height: 7 + Math.random() * 7,
    })),
  []);

  const fetchQuiz = useCallback(() => {
    setNamesVisible(false);
    setGuessedIndex(null);
    guessedIndexRef.current = null;
    setShowConfetti(false);
    setError(null);
    setPhase("loading");

    // Only on the very first load: check for a shared quiz in the URL
    if (!initialLoadDone.current) {
      initialLoadDone.current = true;
      const qParam = new URLSearchParams(window.location.search).get("q");
      if (qParam) {
        try {
          const decoded = JSON.parse(decodeURIComponent(qParam)) as QuizData;
          window.history.replaceState(null, "", window.location.pathname);
          setQuiz(decoded);
          setQuestionKey((k) => k + 1);
          setPhase("question");
          return;
        } catch {
          // malformed param — fall through to API fetch
        }
      }
    }

    fetch("/api/quiz")
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); })
      .then((d: QuizData & { error?: string }) => {
        if (d.error) throw new Error(d.error);
        setQuiz(d);
        setQuestionKey((k) => k + 1);
        setPhase("question");
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  function handleCardClick(i: number) {
    if (phase !== "question" || guessedIndex !== null || !quiz) return;
    guessedIndexRef.current = i;
    setGuessedIndex(i);
    setNamesVisible(true);
    const correct = i === quiz.correctIndex;
    const label = quiz.mode === "zone"
      ? `Activity — ${quiz.timePeriod}`
      : `${quiz.displayName ?? quiz.eventType} — ${quiz.timePeriod}`;
    const options = quiz.mode === "zone"
      ? (quiz.zones ?? []).map((z) => z.name.slice(0, 3)).join(" · ")
      : (quiz.countries ?? []).map((c) => c.code).join(" · ");
    setHistory((prev) => appendRecord({ timestamp: Date.now(), correct, label, options, quiz }, prev));
    if (correct) {
      setShowConfetti(true);
      setTimeout(() => setShowConfetti(false), 3000);
    }
    setTimeout(() => setPhase("reveal"), correct ? 1200 : 900);
  }

  function replayQuiz(record: QuizRecord) {
    setShowHistory(false);
    setQuiz(record.quiz);
    setQuestionKey((k) => k + 1);
    setNamesVisible(false);
    setGuessedIndex(null);
    guessedIndexRef.current = null;
    setShowConfetti(false);
    setPhase("question");
  }

  function handleShare() {
    if (!quiz) return;
    const url = `${window.location.origin}${window.location.pathname}?q=${encodeURIComponent(JSON.stringify(quiz))}`;
    navigator.clipboard.writeText(url).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  }

  useEffect(() => { fetchQuiz(); }, [fetchQuiz]);

  // Blend in names at 5s
  useEffect(() => {
    if (phase !== "question") return;
    const t = setTimeout(() => setNamesVisible(true), 5_000);
    return () => clearTimeout(t);
  }, [phase, questionKey]);

  // 12s question timer
  useEffect(() => {
    if (phase !== "question") return;
    const t = setTimeout(() => setPhase("reveal"), 12_000);
    return () => clearTimeout(t);
  }, [phase, questionKey]);

  // 6s reveal timer
  useEffect(() => {
    if (phase !== "reveal") return;
    const t = setTimeout(() => setPhase("exiting"), 6_000);
    return () => clearTimeout(t);
  }, [phase]);

  // Fade out then load next question
  useEffect(() => {
    if (phase !== "exiting") return;
    const t = setTimeout(fetchQuiz, 600);
    return () => clearTimeout(t);
  }, [phase, fetchQuiz]);

  // Save unanswered record when timer auto-reveals without a guess
  useEffect(() => {
    if (phase === "reveal" && prevPhaseRef.current === "question" && guessedIndexRef.current === null && quiz) {
      const label = quiz.mode === "zone"
        ? `Activity — ${quiz.timePeriod}`
        : `${quiz.displayName ?? quiz.eventType} — ${quiz.timePeriod}`;
      const options = quiz.mode === "zone"
        ? (quiz.zones ?? []).map((z) => z.name.slice(0, 3)).join(" · ")
        : (quiz.countries ?? []).map((c) => c.code).join(" · ");
      setHistory((prev) => appendRecord({ timestamp: Date.now(), correct: false, unanswered: true, label, options, quiz }, prev));
    }
    prevPhaseRef.current = phase;
  }, [phase, quiz]);

  const revealed = phase === "reveal" || phase === "exiting";
  // Zone names always visible; country names blend in at 5s or immediately on guess
  const showNames = quiz?.mode === "zone" || namesVisible || revealed || guessedIndex !== null;

  const items = quiz?.mode === "zone" ? (quiz.zones ?? []) : (quiz?.countries ?? []);

  function getLabel(i: number): string {
    if (!quiz) return "";
    if (quiz.mode === "zone") return quiz.zones![i].name;
    return getCountryName(quiz.countries![i].code);
  }

  function getCount(i: number): number {
    return items[i]?.count ?? 0;
  }

  return (
    <div className="quiz-page">
      <button className="quiz-back" onClick={() => navigate("/")}>←</button>
      <button className="quiz-share" onClick={handleShare} title="Copy link to this question">
        {copied ? "✓" : "🔗"}
      </button>
      <button className="quiz-history-btn" onClick={() => setShowHistory((v) => !v)} title="Question history">
        📋
      </button>

      {history.length > 0 && (() => {
        const correct = history.filter((r) => r.correct).length;
        const wrong = history.filter((r) => !r.correct && !r.unanswered).length;
        const unanswered = history.filter((r) => r.unanswered).length;
        return (
          <div className="quiz-score">
            <span className="quiz-score-correct">✓ {correct}</span>
            {wrong > 0 && <><span className="quiz-score-sep"> · </span><span className="quiz-score-wrong">✗ {wrong}</span></>}
            {unanswered > 0 && <><span className="quiz-score-sep"> · </span><span className="quiz-score-unanswered">— {unanswered}</span></>}
          </div>
        );
      })()}

      {showHistory && (
        <div className="quiz-history-panel">
          <div className="quiz-history-header">
            <span className="quiz-history-title">History</span>
            <button className="quiz-history-close" onClick={() => setShowHistory(false)}>×</button>
          </div>
          <div className="quiz-history-list">
            {history.length === 0 ? (
              <div className="quiz-history-empty">No questions yet</div>
            ) : (
              history.map((r, i) => (
                <div key={i} className={`quiz-history-item${r.correct ? " quiz-history-item--correct" : r.unanswered ? " quiz-history-item--unanswered" : " quiz-history-item--wrong"}`}>
                  <span className="quiz-history-icon">{r.correct ? "✓" : r.unanswered ? "—" : "✗"}</span>
                  <div className="quiz-history-info">
                    <span className="quiz-history-label">{r.label}</span>
                    {r.options && <span className="quiz-history-options">{r.options}</span>}
                    <span className="quiz-history-time">{relativeTime(r.timestamp)}</span>
                  </div>
                  <button className="quiz-history-replay" onClick={() => replayQuiz(r)} title="Replay">↩</button>
                </div>
              ))
            )}
          </div>
        </div>
      )}

      <div className={`quiz-content${phase === "exiting" ? " quiz-content--out" : ""}`}>
        {phase === "loading" && !error && (
          <div className="quiz-status">Loading…</div>
        )}

        {error && (
          <div className="quiz-status quiz-error-box">
            <p>{error}</p>
            <button className="quiz-retry" onClick={fetchQuiz}>Try again</button>
          </div>
        )}

        {quiz && phase !== "loading" && (
          <>
            <div className="quiz-question">
              <span className="quiz-q-lead">
                {quiz.mode === "zone"
                  ? "Which of these zones had the most"
                  : "Which of these countries has seen the most"}
              </span>
              <span className="quiz-q-type">{quiz.displayName}</span>
              <span className="quiz-q-tail">{quiz.timePeriod}?</span>
            </div>

            <div className="quiz-grid">
              {items.map((item, i) => {
                const correct = i === quiz.correctIndex;
                const isZone = quiz.mode === "zone";
                const zoneItem = isZone ? (item as ZoneEntry) : null;
                const countryItem = !isZone ? (item as CountryEntry) : null;

                const hasGuessed = guessedIndex !== null && !revealed;
                const isClickable = phase === "question" && guessedIndex === null;
                const showCorrect = (hasGuessed && correct) || (revealed && correct);
                const showWrong = revealed && !correct;
                const showGuessedWrong = hasGuessed && i === guessedIndex && !correct;
                const cardClass = [
                  "quiz-card",
                  isClickable ? "quiz-card--clickable" : "",
                  showCorrect ? "quiz-card--correct" : "",
                  showWrong ? "quiz-card--wrong" : "",
                  showGuessedWrong ? "quiz-card--guessed-wrong" : "",
                  showGuessedWrong ? "quiz-card--shake" : "",
                ].filter(Boolean).join(" ");

                return (
                  <div
                    key={isZone ? zoneItem!.id : countryItem!.code}
                    className={cardClass}
                    onClick={() => handleCardClick(i)}
                  >
                    {isZone ? (
                      zoneItem!.image
                        ? <img className="quiz-zone-img" src={zoneItem!.image} alt={zoneItem!.name} />
                        : <span className="quiz-flag">🏢</span>
                    ) : (
                      <span className="quiz-flag">{countryFlag(countryItem!.code)}</span>
                    )}

                    <span className={`quiz-cname${showNames ? " quiz-cname--on" : ""}`}>
                      {getLabel(i)}
                    </span>

                    <span className={`quiz-count${revealed ? " quiz-count--on" : ""}`}>
                      <CountTween target={getCount(i)} active={revealed} />
                    </span>
                  </div>
                );
              })}
            </div>

            <div className="quiz-progress-wrap">
              {phase === "question" && (
                <div className="quiz-bar quiz-bar--question" key={`q-${questionKey}`} />
              )}
              {revealed && (
                <div className="quiz-bar quiz-bar--next" key={`r-${questionKey}`} />
              )}
            </div>
          </>
        )}
      </div>

      {showConfetti && (
        <div className="confetti-container" aria-hidden>
          {confettiData.map((p) => (
            <div
              key={p.id}
              className="confetti-piece"
              style={{
                left: `${p.left}%`,
                width: `${p.width}px`,
                height: `${p.height}px`,
                backgroundColor: p.color,
                animationDelay: `${p.delay}s`,
                animationDuration: `${p.duration}s`,
              }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
