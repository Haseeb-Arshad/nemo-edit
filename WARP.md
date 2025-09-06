# WARP.md

This file provides guidance to WARP (warp.dev) when working with code in this repository.

## Development Commands

- Install deps
  ```sh
  npm install
  ```
- Dev server (watches TS via tsx). Note: requires src/ TypeScript sources; if missing, use production start.
  ```sh
  npm run dev
  ```
- Build TypeScript to dist/
  ```sh
  npm run build
  ```
- Start from built JS (uses dist/server.js)
  ```sh
  npm run start
  ```

Testing and linting
- No test or lint scripts are defined in package.json at this time.

Useful local requests (PowerShell/curl)
- Health
  ```sh
  curl http://localhost:4000/health
  ```
- Generate image (multipart form; uses field name "image")
  ```sh
  curl -X POST http://localhost:4000/generate-image \
    -F "promptText=A cat astronaut" \
    -F "quality=high" \
    -F "variations=1" \
    -F "image=@C:/path/to/example.png;type=image/png"
  ```
- Edit job (requires Authorization: Bearer DEV_TOKEN). Returns job_id and status.
  ```sh
  $env:AUTH_TOKEN="{{DEV_TOKEN}}"; \
  curl -H "Authorization: Bearer $env:AUTH_TOKEN" \
       -F "prompt=Remove background" \
       -F "file=@C:/path/to/example.jpg;type=image/jpeg" \
       http://localhost:4000/api/v1/edit
  ```
- Poll job status
  ```sh
  curl -H "Authorization: Bearer {{DEV_TOKEN}}" http://localhost:4000/api/v1/edit/{job_id}
  ```
- Fetch job result (JSON base64 for small files; 302 redirect to signed URL for large)
  ```sh
  curl -H "Authorization: Bearer {{DEV_TOKEN}}" http://localhost:4000/api/v1/edit/{job_id}/result
  ```

## Environment Configuration

Copy .env.example to .env and set:
- PORT (default 4000)
- GEMINI_API_KEY (or GOOGLE_API_KEY)
- SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY
- SUPABASE_IMAGE_BUCKET (default gen-images)
- CORS_ORIGINS (comma-separated; "*" allowed)
- Pinata/IPFS (optional, preferred storage): PINATA_JWT, PINATA_UPLOAD_ENDPOINT, PINATA_PIN_ENDPOINT, PINATA_GATEWAY_BASE, PINATA_PREFER_IPFS
- DEV_TOKEN (used by edit endpoints auth)
- PROVIDER (default gemini)

Notes
- If GEMINI_API_KEY is not set, /generate-image will fail.
- If SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY are not set, DB/storage features will fail.
- If PINATA_JWT is not set, uploads fall back to Supabase Storage.

## API Surface (high level)

- GET /health — health check
- GET /styles?category=slug — categories + active styles
- GET /styles/:slug — style detail, presets, and filters
- GET /prompts?style=slug — active prompt presets
- POST /generate-image — streaming image+text generation; optional image input
- GET /tasks/:id — task detail + output URLs
- POST /api/v1/edit — authenticated edit job (Bearer DEV_TOKEN)
- GET /api/v1/edit/:id — job status (processing/done/error)
- GET /api/v1/edit/:id/result — job result (base64 or 302 to signed URL)
- POST /mock/gemini — local mock endpoint that echoes uploaded file as base64

## Architecture Overview

Runtime
- Node.js + Express service written in TypeScript (compiled to dist/).
- Multer handles uploads in memory (25MB limit).
- CORS origins controlled via CORS_ORIGINS.

Configuration (dist/config.js)
- Loads environment via dotenv.
- Provides config: port, API keys, storage bucket, CORS origins, DEV_TOKEN, provider, Pinata settings. assertEnv() logs warnings for missing critical config.

Auth (dist/auth.js)
- getUserIdFromAuth() extracts Bearer token; when token === DEV_TOKEN, returns a synthetic user id ("dev-user"). Used to protect edit job endpoints.

GenAI integration (dist/genai.js)
- Uses @google/genai to stream IMAGE and TEXT parts.
- compilePrompt() merges base prompts from styles/presets with request inputs (quality, filters, promptText).
- runImmediateGeneration():
  - Looks up optional style and prompt preset in DB to build the base prompt.
  - Creates a generation_tasks row (status=running), streams responses, and for each image part:
    - Uploads to storage (Pinata/IPFS preferred when configured, else Supabase Storage).
    - Inserts generation_outputs rows with storage details.
  - Accumulates text output and marks task succeeded/failed accordingly.
- runEditGeneration(): similar to immediate flow but tailored for edit jobs, supports an optional mask image and writes outputs under the hinted task id.

Storage and DB (dist/supabase.js)
- supabaseAdmin created with service role key when configured.
- uploadBufferToStorage():
  - If PINATA_JWT present: uses pinFileToIPFS (preferred) or Uploads API, returns gateway URL and path (cid/filename).
  - Else: uploads to Supabase Storage bucket and returns public URL.
- signedUrl() and getPublicUrl(): return access URLs for either Pinata gateway or Supabase Storage.
- downloadToBase64(): fetches bytes and returns base64 (works for external URLs, Pinata, or Supabase Storage).
- DB helpers: insertGenerationTask, updateGenerationTask, insertGenerationOutput.

HTTP Server (dist/server.js)
- Request logger with per-request id, basic timing, and query logging.
- Endpoints:
  - Catalog: /styles, /styles/:slug, /prompts — read from tables (style_categories, image_styles, style_filters, prompt_presets).
  - Generation: /generate-image — accepts multipart (image), optional styleSlug/promptId/promptText/quality/filters/variations.
  - Tasks: /tasks/:id — joins outputs and returns public URLs.
  - Edit flow: /api/v1/edit (POST), /api/v1/edit/:id, /api/v1/edit/:id/result — authenticated via DEV_TOKEN.
  - Mock: /mock/gemini — no external deps; useful for local testing.

## Data Model Expectations (Supabase)

The code references the following tables (create accordingly in Supabase):
- generation_tasks
- generation_outputs
- image_styles
- style_categories
- prompt_presets
- style_filters (join to filters)

See README for setup details. If a supabase/schema.sql file exists, apply it in the Supabase SQL Editor.

## Project Notes

- Source code is expected under src/ with TypeScript entry at src/server.ts (per npm run dev). This repository currently contains compiled JS under dist/. If src/ is not present locally, use npm run start for development.
- When PINATA_JWT is configured and PINATA_PREFER_IPFS is true (default), images are pinned to IPFS and served via the configured gateway; otherwise Supabase Storage is used.
- For large outputs, result endpoint redirects to a short-lived signed URL; small outputs (< ~800KB) are returned as base64 JSON.
