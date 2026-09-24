// Loads .env.local (written by `vercel env pull`) when present.
try {
  process.loadEnvFile(".env.local");
} catch {
  // No file: rely on the real environment.
}
