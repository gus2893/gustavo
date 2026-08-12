"use client";

import { useEffect, useState, type FormEvent } from "react";

interface RedemptionResponse {
  readonly error?: unknown;
}

export default function JoinPage() {
  const [hydrated, setHydrated] = useState(false);
  const [status, setStatus] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => setHydrated(true), []);

  async function createAccount(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const token = new URL(window.location.href).searchParams.get("token");
    if (!token) {
      setStatus("This invitation link is invalid.");
      return;
    }

    setSubmitting(true);
    setStatus("Creating account…");
    const form = new FormData(event.currentTarget);
    try {
      const response = await fetch("/api/account/redeem", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token,
          displayName: form.get("displayName"),
          password: form.get("password"),
        }),
      });
      if (!response.ok) {
        const body = await response.json().catch((): RedemptionResponse => ({})) as RedemptionResponse;
        setStatus(typeof body.error === "string"
          ? `Account could not be created: ${body.error}.`
          : "Account could not be created.");
        return;
      }
      window.location.assign("/chat");
    } catch {
      setStatus("Account could not be created.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main>
      <header>
        <p>Invitation-only beta</p>
        <h1>Join Gustavo</h1>
        <p>Create your one account, stable Node Brain, and continuous private chat.</p>
      </header>

      <form
        aria-label="Create account"
        method="post"
        onSubmit={(event) => void createAccount(event)}
      >
        <fieldset disabled={!hydrated || submitting}>
          <legend>Create account</legend>
          <label htmlFor="display-name">Display name</label>
          <input
            autoComplete="name"
            id="display-name"
            name="displayName"
            required
          />
          <label htmlFor="passphrase">Passphrase</label>
          <input
            autoComplete="new-password"
            id="passphrase"
            minLength={12}
            name="password"
            required
            type="password"
          />
          <button type="submit">Create account</button>
        </fieldset>
      </form>
      {status && <p role="status">{status}</p>}
    </main>
  );
}
