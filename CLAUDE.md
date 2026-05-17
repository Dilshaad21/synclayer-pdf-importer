# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project: SyncLayer PDF-to-Inventory Importer

A Shopify embedded app that uses AI to parse supplier PDF catalogs and import products into Shopify inventory — with mandatory human review before any changes are applied.

## Tech Stack

- **Framework:** Shopify App Template (React Router v7), TypeScript, Vite
- **Hosting:** Vercel (Hobby Free Tier)
- **Database:** Supabase (Free Tier PostgreSQL) — replaces the default SQLite
- **AI Engine:** OpenAI SDK (`openai` v6+), model `gpt-4o-mini`
- **UI:** Shopify Polaris web components (via App Bridge)

## Critical Rules

1. **Human-in-the-Loop — non-negotiable.** Never automatically alter a merchant's inventory. Every AI extraction must go through a preview/approval state before any write is performed.
2. **OpenAI API efficiency.** Always set `temperature: 0` for extraction calls. Always set a `max_tokens` limit to cap cost. Use Structured Outputs (`response_format: json_schema` with `strict: true`) for all extraction calls — eliminates JSON parsing failures. Never stream responses unless explicitly required.
3. **Budget: $10–20/month max.** Design every feature around the free tiers of Vercel and Supabase. Avoid polling, large payloads, and unnecessary API calls.

## Current Goal

**Phase 3/4 Integration:** Build a file upload component in the Shopify Polaris UI that securely communicates with a backend route to run the AI PDF-parsing workflow.

## Commands

```bash
npm run dev              # Start local dev server via Shopify CLI (tunnel + env vars)
npm run build            # Production build
npm run setup            # prisma generate && prisma migrate deploy (run after schema changes)
npm run lint             # ESLint
npm run typecheck        # react-router typegen + tsc --noEmit
npm run graphql-codegen  # Regenerate GraphQL types into app/types/
```

There are no test commands configured in this project.

## Architecture

### Request Flow

Every authenticated page request goes through `authenticate.admin(request)` (from `app/shopify.server.ts`), which handles OAuth, session validation, and returns an `admin` GraphQL client. All routes under `app/routes/app.*` require this call in their `loader` or `action`.

### Key Files

- **`app/shopify.server.ts`** — Shopify app singleton. Source of `authenticate`, `login`, `registerWebhooks`, `sessionStorage`. Import from here, not from `@shopify/shopify-app-react-router` directly.
- **`app/db.server.ts`** — Prisma client singleton (prevents connection exhaustion during dev hot-reload).
- **`app/routes/app.tsx`** — Authenticated layout shell. Wraps all `/app/*` routes in `<AppProvider>`. Every child route must export `boundary.headers`.
- **`app/routes.ts`** — Flat-file routing via `flatRoutes()` from `@react-router/fs-routes`.

### Routing Conventions

Routes use React Router v7 flat-file conventions:
- `app/routes/app._index.tsx` → `/app` (main embedded UI)
- `app/routes/app.additional.tsx` → `/app/additional`
- `app/routes/auth.$.tsx` → `/auth/*` (OAuth, handled by Shopify)
- `app/routes/webhooks.app.uninstalled.tsx` → `/webhooks/app/uninstalled`

### Shopify Embedded App Rules

These constraints apply to all routes rendered inside the Shopify Admin iframe:

1. Use `Link` from `react-router` or `@shopify/polaris` — never `<a>` tags.
2. Use `redirect` returned from `authenticate.admin(request)` — never `redirect` from `react-router`.
3. Every route under `app/routes/app.*` must export `boundary.headers` as `headers`.

### UI Components

Uses Polaris web components (`<s-page>`, `<s-section>`, `<s-button>`, etc.) — not the React Polaris library. These are custom elements rendered by App Bridge.

### GraphQL

Admin GraphQL API version is `October25`. Use tagged template literals with `#graphql` comment for IDE support. Generated types land in `app/types/` — run `npm run graphql-codegen` after changing queries/mutations.

### Webhooks

Webhook subscriptions are declared in `shopify.app.toml`, not registered in code. Shopify syncs them on `npm run deploy`. Handler routes live at `app/routes/webhooks.*.tsx`.

### Database

Currently Prisma with SQLite (`prisma/dev.sqlite`) for local dev; target production database is Supabase PostgreSQL. The `Session` model in `prisma/schema.prisma` is required by Shopify — do not remove it. When switching to Supabase, update the `datasource` provider to `postgresql` and set `DATABASE_URL` in the environment.
