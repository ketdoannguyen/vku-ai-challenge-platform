import { useEffect, useState } from "react";
import { api, ApiClientError } from "../api/client";
import { Loading } from "../components/ui";

interface Health {
  status: string;
  mongo: string;
}

/** Trang kỹ thuật: xác nhận API + Mongo sống qua cùng origin. */
export function HealthPage() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .get<Health>("/health")
      .then(setHealth)
      .catch((e: unknown) =>
        setError(e instanceof ApiClientError ? `${e.status} — ${e.message}` : "Không gọi được /api/health"),
      );
  }, []);

  return (
    <div className="page">
      <h1>System health</h1>
      {error && <p className="error-box">{error}</p>}
      {!error && !health && <Loading />}
      {health && (
        <div className="card">
          <p>
            API: <span className="status-badge success">alive</span>
          </p>
          <p>
            Mongo:{" "}
            <span className={`status-badge ${health.mongo === "reachable" ? "success" : "danger"}`}>
              {health.mongo}
            </span>
          </p>
          <p>
            Overall:{" "}
            <span className={`status-badge ${health.status === "ok" ? "success" : "warning"}`}>
              {health.status}
            </span>
          </p>
        </div>
      )}
    </div>
  );
}
