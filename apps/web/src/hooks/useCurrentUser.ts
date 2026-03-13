import { useEffect, useState } from "react";

interface CurrentUser {
  user: string | null;
  email: string | null;
  name: string | null;
}

let cached: CurrentUser | null = null;

export function useCurrentUser() {
  const [data, setData] = useState<CurrentUser | null>(cached);
  const [loading, setLoading] = useState(!cached);

  useEffect(() => {
    if (cached) return;
    fetch("/api/me")
      .then((r) => r.json())
      .then((d: CurrentUser) => {
        cached = d;
        setData(d);
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, []);

  return { ...data, loading };
}
