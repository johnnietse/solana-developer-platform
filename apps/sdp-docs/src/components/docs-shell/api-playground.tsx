"use client";

import { useState, useEffect } from "react";
import { ArrowRight, Copy, Check, Loader2 } from "lucide-react";

export interface PlaygroundField {
  key: string;
  label: string;
  placeholder: string;
  defaultValue?: string;
  hint?: string;
}

export interface ApiPlaygroundProps {
  title?: string;
  endpoint: string;
  method: "GET" | "POST";
  fields?: PlaygroundField[];
}

const SESSION_KEY = "sdp_playground_api_key";

export function ApiPlayground({
  title = "Try it",
  endpoint,
  method,
  fields = [],
}: ApiPlaygroundProps) {
  const [apiKey, setApiKey] = useState("");
  const [fieldValues, setFieldValues] = useState<Record<string, string>>(
    Object.fromEntries(fields.map((f) => [f.key, f.defaultValue ?? ""]))
  );
  const [response, setResponse] = useState<{ status: number; data: unknown } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [elapsed, setElapsed] = useState<number | null>(null);

  useEffect(() => {
    const stored = sessionStorage.getItem(SESSION_KEY);
    if (stored) setApiKey(stored);
  }, []);

  function handleApiKeyChange(v: string) {
    setApiKey(v);
    sessionStorage.setItem(SESSION_KEY, v);
  }

  async function run() {
    if (!apiKey.trim()) return;
    setLoading(true);
    setError(null);
    setResponse(null);
    setElapsed(null);

    const t0 = Date.now();
    try {
      let url = endpoint;
      let body: Record<string, string> | undefined;

      if (method === "POST") {
        body = {};
        for (const f of fields) {
          if (fieldValues[f.key]) body[f.key] = fieldValues[f.key];
        }
      } else {
        const params = new URLSearchParams();
        for (const f of fields) {
          if (fieldValues[f.key]) params.set(f.key, fieldValues[f.key]);
        }
        if (params.toString()) url += `?${params}`;
      }

      const res = await fetch("/api/playground", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: url, method, body, apiKey: apiKey.trim() }),
      });

      const result = await res.json();
      setElapsed(Date.now() - t0);
      setResponse(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Request failed");
    } finally {
      setLoading(false);
    }
  }

  function copyResponse() {
    if (!response) return;
    navigator.clipboard.writeText(JSON.stringify(response.data, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  }

  const responseStr = response ? JSON.stringify(response.data, null, 2) : null;
  const statusOk = response && response.status >= 200 && response.status < 300;

  return (
    <div className="api-pg">
      {/* Header */}
      <div className="api-pg-header">
        <span className="api-pg-title">{title}</span>
        <div className="api-pg-endpoint">
          <span className={`api-pg-method api-pg-method--${method.toLowerCase()}`}>{method}</span>
          <code className="api-pg-path">{endpoint}</code>
        </div>
      </div>

      {/* Form */}
      <div className="api-pg-form">
        <div className="api-pg-field">
          <label className="api-pg-label">API key</label>
          <input
            type="password"
            className="api-pg-input"
            placeholder="sk_test_…"
            value={apiKey}
            onChange={(e) => handleApiKeyChange(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </div>

        {fields.map((f) => (
          <div key={f.key} className="api-pg-field">
            <label className="api-pg-label">{f.label}</label>
            {f.hint && <span className="api-pg-hint">{f.hint}</span>}
            <input
              type="text"
              className="api-pg-input"
              placeholder={f.placeholder}
              value={fieldValues[f.key] ?? ""}
              onChange={(e) =>
                setFieldValues((prev) => ({ ...prev, [f.key]: e.target.value }))
              }
              spellCheck={false}
            />
          </div>
        ))}

        <div className="api-pg-actions">
          <button
            className="api-pg-run"
            onClick={run}
            disabled={loading || !apiKey.trim()}
          >
            {loading ? (
              <Loader2 size={13} className="api-pg-spin" aria-hidden="true" />
            ) : (
              <ArrowRight size={13} aria-hidden="true" />
            )}
            {loading ? "Sending…" : "Send request"}
          </button>
        </div>
      </div>

      {/* Response */}
      {(response || error) && (
        <div className="api-pg-response">
          <div className="api-pg-response-bar">
            {response && (
              <span className={`api-pg-status api-pg-status--${statusOk ? "ok" : "err"}`}>
                {response.status}
              </span>
            )}
            {error && <span className="api-pg-status api-pg-status--err">Error</span>}
            {elapsed !== null && (
              <span className="api-pg-elapsed">{elapsed}ms</span>
            )}
            <div style={{ flex: 1 }} />
            {response && (
              <button className="api-pg-copy" onClick={copyResponse}>
                {copied ? (
                  <Check size={11} aria-hidden="true" />
                ) : (
                  <Copy size={11} aria-hidden="true" />
                )}
                {copied ? "Copied" : "Copy"}
              </button>
            )}
          </div>
          <pre className="api-pg-pre">
            <code>{error ?? responseStr}</code>
          </pre>
        </div>
      )}
    </div>
  );
}
