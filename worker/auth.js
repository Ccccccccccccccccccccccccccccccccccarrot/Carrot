import { DurableObject } from "cloudflare:workers";

const rateWindow = 15 * 60_000;
// Keep the existing numeric expiry field for older app versions.
const sessionExpiry = 253402300799999;
const codeLifetime = 2 * 60_000;

export class FamilyAuth extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`
      CREATE TABLE IF NOT EXISTS attempts (source TEXT PRIMARY KEY, count INTEGER, expires INTEGER);
      CREATE TABLE IF NOT EXISTS codes (hash TEXT PRIMARY KEY, challenge TEXT, user TEXT, verifier TEXT, expires INTEGER);
      CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, user TEXT, verifier TEXT, expires INTEGER);
    `);
  }

  allowAttempt(source) {
    const now = Date.now();
    this.sql.exec("DELETE FROM attempts WHERE expires <= ?", now);
    const attempt = this.sql.exec("SELECT count FROM attempts WHERE source = ?", source).toArray()[0];
    if (attempt?.count >= 10) return false;
    this.sql.exec(`INSERT INTO attempts VALUES (?, 1, ?)
      ON CONFLICT(source) DO UPDATE SET count = count + 1`, source, now + rateWindow);
    return true;
  }

  issueCode(hash, challenge, user, verifier) {
    const now = Date.now();
    this.sql.exec("DELETE FROM codes WHERE expires <= ?", now);
    this.sql.exec("INSERT INTO codes VALUES (?, ?, ?, ?, ?)", hash, challenge, user, verifier, now + codeLifetime);
  }

  exchangeCode(hash, challenge, sessionHash) {
    const now = Date.now();
    return this.ctx.storage.transactionSync(() => {
      const code = this.sql.exec("SELECT user, verifier FROM codes WHERE hash = ? AND challenge = ? AND expires > ?",
        hash, challenge, now).toArray()[0];
      if (!code) return null;
      this.sql.exec("DELETE FROM codes WHERE hash = ?", hash);
      return { ...code, expiresAt: this.issueSession(sessionHash, code.user, code.verifier) };
    });
  }

  issueSession(hash, user, verifier) {
    const now = Date.now();
    const expiresAt = sessionExpiry;
    this.sql.exec("DELETE FROM sessions WHERE expires <= ?", now);
    this.sql.exec("INSERT INTO sessions VALUES (?, ?, ?, ?)", hash, user, verifier, expiresAt);
    return expiresAt;
  }

  getSession(hash) {
    return this.sql.exec("SELECT user, verifier, expires AS expiresAt FROM sessions WHERE hash = ? AND expires > ?",
      hash, Date.now()).toArray()[0] ?? null;
  }

  removeSession(hash) {
    this.sql.exec("DELETE FROM sessions WHERE hash = ?", hash);
  }
}
