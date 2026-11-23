import { defineRailway, postgres, preserve, project, service, volume } from "railway/iac";

export default defineRailway(() => {
  const Postgres = postgres("Postgres", { region: "europe-west4-drams3a" });
  Postgres.networking = { privateNetworkEndpoint: "postgres" };
  const postgresVolume = volume("postgres-volume", { alerts: { usage: { "100": {}, "80": {}, "95": {} } }, allowOnlineResize: true, region: "europe-west4-drams3a", sizeMB: 5000 });
  const moneylensBackend = service("moneylens backend", {
    replicas: { "europe-west4-drams3a": 1 },
    networking: { privateNetworkEndpoint: "moneylens-backend" },
    env: { DATABASE_URL: preserve(), NODE_ENV: preserve(), SEMANTIC_AUTO_ACCEPT: preserve() },
    build: "npx prisma generate && npm run build",
    start: "node dist/main.js",
    preDeploy: "npx prisma migrate deploy",
    healthcheck: "/api/health",
  });
  const ocr = service("ocr", {
    replicas: { "europe-west4-drams3a": 1 },
    healthcheck: "/health",
    env: { PADDLE_OCR_TOKEN: preserve(), PORT: preserve() },
  });


  return project("moneylens", {
    resources: [Postgres, moneylensBackend, ocr, postgresVolume],
  });
});
