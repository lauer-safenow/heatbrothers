import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import "./FeatureRequestPage.css";

const VOTES_KEY = "fr_votes";

function loadVotes(): Set<number> {
  try { return new Set(JSON.parse(localStorage.getItem(VOTES_KEY) ?? "[]")); } catch { return new Set(); }
}

function saveVote(id: number) {
  const votes = loadVotes();
  votes.add(id);
  localStorage.setItem(VOTES_KEY, JSON.stringify([...votes]));
}

function removeVote(id: number) {
  const votes = loadVotes();
  votes.delete(id);
  localStorage.setItem(VOTES_KEY, JSON.stringify([...votes]));
}

interface FeatureRequest {
  id: number;
  requestor: string;
  description: string;
  upvotes: number;
  created_at: number;
}

export function FeatureRequestPage() {
  const navigate = useNavigate();
  const [requests, setRequests] = useState<FeatureRequest[]>([]);
  const [voted, setVoted] = useState<Set<number>>(loadVotes);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function load() {
    const res = await fetch("/api/feature-requests");
    const data = await res.json();
    setRequests(data.requests);
  }

  useEffect(() => { load(); }, []);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim() || !description.trim()) return;
    setSubmitting(true);
    await fetch("/api/feature-requests", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ requestor: name.trim(), description: description.trim() }),
    });
    setName("");
    setDescription("");
    setSubmitting(false);
    load();
  }

  async function toggleVote(id: number) {
    if (voted.has(id)) {
      await fetch(`/api/feature-requests/${id}/unvote`, { method: "POST" });
      removeVote(id);
    } else {
      await fetch(`/api/feature-requests/${id}/upvote`, { method: "POST" });
      saveVote(id);
    }
    setVoted(loadVotes());
    load();
  }

  return (
    <div className="fr-page">
      <div className="fr-header">
        <button className="fr-back" onClick={() => navigate("/")}>&#8592; Home</button>
        <h1 className="fr-title">Feature Requests</h1>
      </div>

      <form className="fr-form" onSubmit={handleSubmit}>
        <input
          className="fr-input"
          placeholder="Your name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={80}
        />
        <textarea
          className="fr-textarea"
          placeholder="What do you want?"
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          rows={3}
          maxLength={500}
        />
        <button
          className="fr-submit"
          type="submit"
          disabled={submitting || !name.trim() || !description.trim()}
        >
          {submitting ? "Submitting…" : "Submit"}
        </button>
      </form>

      <div className="fr-list">
        {requests.length === 0 && <div className="fr-empty">No requests yet. Be the first!</div>}
        {requests.map((r) => {
          const hasVoted = voted.has(r.id);
          return (
            <div key={r.id} className="fr-card">
              <button
                className={`fr-upvote${hasVoted ? " fr-upvoted" : ""}`}
                onClick={() => toggleVote(r.id)}
                title={hasVoted ? "Withdraw vote" : "Upvote"}
              >
                &#9650; <span className="fr-upvote-count">{r.upvotes}</span>
              </button>
              <div className="fr-card-body">
                <div className="fr-card-desc">{r.description}</div>
                <div className="fr-card-meta">by {r.requestor}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
