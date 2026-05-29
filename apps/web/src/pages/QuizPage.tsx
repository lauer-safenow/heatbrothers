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
  const initialLoadDone = useRef(false);

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
    setGuessedIndex(i);
    setNamesVisible(true);
    const correct = i === quiz.correctIndex;
    if (correct) {
      setShowConfetti(true);
      setTimeout(() => setShowConfetti(false), 3000);
    }
    setTimeout(() => setPhase("reveal"), correct ? 1200 : 900);
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
