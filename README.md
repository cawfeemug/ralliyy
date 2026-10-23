# Ralliyy

Live polls and Q&A for small sessions. A host creates a session; participants join anonymously by a 6-character code or QR code.

Status: in development. Hosts create a session, participants join by code or QR code, vote in live polls, and ask and upvote questions that the host can hide (milestone M3).

## Run it locally

Needs [Docker Desktop](https://www.docker.com/products/docker-desktop/) running.

```sh
docker compose up --build
```

Then open http://localhost:3000. Check http://localhost:3000/healthz returns `{"status":"ok","db":"ok"}`.

Stop with `Ctrl+C`, or `docker compose down`. Data stays in the `pgdata` volume; `docker compose down -v` wipes it.

## Run the tests

Needs Node.js 22 and the Compose database running (`docker compose up -d db`).

```sh
cp .env.example .env
npm install
npm test
```

## Stack

Node.js 22, Express 5, PostgreSQL 16 through `pg` with plain SQL migrations in `migrations/`, Docker Compose for local development, GitHub Actions for CI. Migrations run automatically when the server starts.
