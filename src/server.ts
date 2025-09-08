import express from "express";
import cors from "cors";
import multer from "multer";
import { config, assertEnv } from "./config";
import { supabaseAdmin, insertGenerationTask, updateGenerationTask, getPublicUrl, downloadToBase64, signedUrl } from "./supabase";
import { randomUUID } from "crypto";
import { runImmediateGeneration, runEditGeneration } from "./genai";
import { getUserIdFromAuth } from "./auth";

assertEnv();

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true }));

const corsOptions: cors.CorsOptions = {
  origin: (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => {
    if (!origin || config.corsOrigins.includes("*") || config.corsOrigins.includes(origin)) {
      cb(null, true);
    } else {
      cb(null, false);
    }
  },
  credentials: true,
};
app.use(cors(corsOptions));

// Lightweight request logger with a request id
app.use((req, res, next) => {
  const id = (req as any).__reqId || randomUUID().slice(0, 8);
  (req as any).__reqId = id;
  const started = Date.now();
  console.log(`[req ${id}] ${req.method} ${req.path}`);
  if (Object.keys(req.query || {}).length) console.log(`[req ${id}] query`, req.query);
  res.on("finish", () => {
    const ms = Date.now() - started;
    console.log(`[req ${id}] done ${res.statusCode} in ${ms}ms`);
  });
  next();
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

// Health
app.get("/health", (_req, res) => res.json({ ok: true }));

// Debug mock Gemini endpoint (no external deps)
app.post("/mock/gemini", upload.fields([{ name: "file", maxCount: 1 }, { name: "mask", maxCount: 1 }]), async (req, res) => {
  try {
    const files = req.files as any;
    const prompt = (req.body.prompt as string) || "";
    const file = files?.file?.[0];
    if (!file) return res.status(400).json({ error: "file required" });
    // Echo back the original image as base64 to simulate flow
    const base64 = Buffer.from(file.buffer).toString("base64");
    return res.json({
      candidates: [
        { content: { parts: [{ text: prompt }, { inlineData: { mimeType: file.mimetype || "image/png", data: base64 } }] } },
      ],
    });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "Unknown error" });
  }
});

// Catalog: categories + styles
app.get("/styles", async (req, res) => {
  try {
    if (!supabaseAdmin) return res.status(500).json({ error: "Supabase not configured" });
    const categorySlug = req.query.category as string | undefined;

    const { data: categories } = await supabaseAdmin
      .from("style_categories")
      .select("id, slug, name, description, sort_order")
      .order("sort_order", { ascending: true });

    let stylesQuery = supabaseAdmin
      .from("image_styles")
      .select("id, slug, name, description, category_id, attributes, active, sort_order")
      .eq("active", true)
      .order("sort_order", { ascending: true });
    if (categorySlug) {
      const cat = categories?.find((c) => c.slug === categorySlug);
      if (cat) stylesQuery = stylesQuery.eq("category_id", (cat as any).id);
      else stylesQuery = stylesQuery.eq("category_id", "00000000-0000-0000-0000-000000000000");
    }
    const { data: styles } = await stylesQuery;

    res.json({ categories: categories || [], styles: styles || [] });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "Unknown error" });
  }
});

// Style detail + presets + filters
app.get("/styles/:slug", async (req, res) => {
  try {
    if (!supabaseAdmin) return res.status(500).json({ error: "Supabase not configured" });
    const { slug } = req.params;
    const { data: style, error } = await supabaseAdmin
      .from("image_styles")
      .select("id, slug, name, description, category_id, attributes, active, base_prompt")
      .eq("slug", slug)
      .maybeSingle();
    if (error) throw error;
    if (!style) return res.status(404).json({ error: "Not found" });

    const [{ data: presets }, { data: sf }] = await Promise.all([
      supabaseAdmin
        .from("prompt_presets")
        .select("id, slug, name, prompt_template, variables, active")
        .eq("style_id", (style as any).id)
        .eq("active", true)
        .order("name"),
      supabaseAdmin
        .from("style_filters")
        .select("default_strength, filters:filter_id(id, slug, name, type, config, active)")
        .eq("style_id", (style as any).id),
    ]);

    const filters = (sf || []).map((r: any) => ({
      default_strength: r.default_strength,
      ...r.filters,
    }));

    res.json({ style, presets: presets || [], filters });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "Unknown error" });
  }
});

// Prompt presets listing
app.get("/prompts", async (req, res) => {
  try {
    if (!supabaseAdmin) return res.status(500).json({ error: "Supabase not configured" });
    const styleSlug = req.query.style as string | undefined;
    let query = supabaseAdmin
      .from("prompt_presets")
      .select("id, slug, name, prompt_template, variables, active, style:style_id(slug, name)")
      .eq("active", true)
      .order("name");
    if (styleSlug) {
      const { data: style } = await supabaseAdmin.from("image_styles").select("id").eq("slug", styleSlug).maybeSingle();
      if (style) query = query.eq("style_id", (style as any).id);
      else return res.json({ presets: [] });
    }
    const { data } = await query;
    res.json({ presets: data || [] });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "Unknown error" });
  }
});

// Generate image
app.post("/generate-image", upload.single("image"), async (req, res) => {
  try {
    const reqId = (req as any).__reqId;
    const styleSlug = (req.body.styleSlug || req.body.style || null) as string | null;
    const promptId = (req.body.promptId || null) as string | null;
    const promptText = (req.body.promptText || req.body.prompt || undefined) as string | undefined;
    const quality = (req.body.quality || null) as string | null;
    const variations = Number(req.body.variations || 1);
    let filters: any = [];
    if (req.body.filters) {
      try { filters = JSON.parse(req.body.filters); } catch {}
    }
    const file = req.file;
    const buf = file ? (file.buffer as Buffer) : null;
    const mime = file?.mimetype || null;

    console.log(`[req ${reqId}] /generate-image received`, { styleSlug, promptId, hasImage: !!buf, mime, quality, variations, filtersLen: Array.isArray(filters) ? filters.length : 0 });

    const result = await runImmediateGeneration({
      styleSlug,
      promptId,
      promptText,
      quality,
      filters,
      variations: Number.isFinite(variations) && variations > 0 ? variations : 1,
      imageBuffer: buf,
      imageMime: mime,
    });
    console.log(`[req ${reqId}] /generate-image succeeded`, { taskId: (result as any)?.taskId, outputs: (result as any)?.outputs?.length || 0 });
    res.json(result);
  } catch (e: any) {
    const reqId = (req as any).__reqId;
    console.error(`[req ${reqId}] /generate-image error`, e?.message || e);
    res.status(500).json({ error: e?.message || "Unknown error" });
  }
});

// Task detail + outputs
app.get("/tasks/:id", async (req, res) => {
  try {
    if (!supabaseAdmin) return res.status(500).json({ error: "Supabase not configured" });
    const id = req.params.id;
    const { data: task } = await supabaseAdmin.from("generation_tasks").select("*").eq("id", id).maybeSingle();
    if (!task) return res.status(404).json({ error: "Not found" });
    const { data: outputs } = await supabaseAdmin
      .from("generation_outputs")
      .select("id, index, storage_bucket, storage_path, mime, size, width, height, metadata, created_at")
      .eq("task_id", id)
      .order("index", { ascending: true });
    const withUrls = (outputs || []).map((o) => ({
      ...o,
      publicUrl: getPublicUrl({ bucket: o.storage_bucket, path: o.storage_path }),
    }));
    res.json({ task, outputs: withUrls });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "Unknown error" });
  }
});

// Compatibility endpoints for NanoBananaApi used by the Android app
// POST /v1/edits  { imageUrl?: string, maskUrl?: string, prompt: string, ... }
app.post("/v1/edits", async (req, res) => {
  try {
    const userId = getUserIdFromAuth(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    if (!supabaseAdmin) return res.status(500).json({ error: "Supabase not configured" });

    const { imageUrl, maskUrl, prompt } = req.body || {};
    if (!prompt || typeof prompt !== "string" || !prompt.trim()) {
      return res.status(400).json({ error: "prompt is required" });
    }
    if (!imageUrl || typeof imageUrl !== "string") {
      return res.status(400).json({ error: "imageUrl is required" });
    }

    // Create a task first
    const task = await insertGenerationTask({
      status: "running",
      style_id: null,
      prompt_id: null,
      prompt,
      params: { userId, provider: config.provider, compat: "v1/edits", imageUrl, maskUrl },
      input_image_path: null,
      output_text: null,
      error: null,
    });

    // Fire-and-forget background job: download image(s) and run edit
    (async () => {
      const reqId = (req as any).__reqId || task.id;
      try {
        const [imgRes, maskRes] = await Promise.all([
          fetch(imageUrl).catch(() => null),
          maskUrl ? fetch(maskUrl).catch(() => null) : Promise.resolve(null),
        ]);
        if (!imgRes || !imgRes.ok) throw new Error(`Failed to fetch imageUrl (${imgRes?.status || "no response"})`);
        const imgBuf = Buffer.from(await imgRes.arrayBuffer());
        const imgMime = (imgRes.headers.get("content-type") || "image/jpeg").split(";")[0];
        const maskBuf = maskRes && maskRes.ok ? Buffer.from(await maskRes.arrayBuffer()) : null;

        console.log(`[req ${reqId}] /v1/edits downloaded inputs`, { taskId: task.id, imgBytes: imgBuf.byteLength, hasMask: !!maskBuf });
        const { outputs, text } = await runEditGeneration({
          userId,
          prompt,
          imageBuffer: imgBuf,
          imageMime: imgMime,
          maskBuffer: maskBuf,
          taskIdHint: task.id,
        });
        await updateGenerationTask(task.id, {
          status: "succeeded",
          output_text: text || null,
          completed_at: new Date().toISOString(),
        });
        console.log(`[req ${reqId}] /v1/edits generation done`, { taskId: task.id, outputs: outputs?.length || 0 });
      } catch (err: any) {
        await updateGenerationTask(task.id, {
          status: "failed",
          error: err?.message || String(err),
          completed_at: new Date().toISOString(),
        });
        console.error(`[v1/edits] generation failed`, { taskId: task.id, error: err?.message || String(err) });
      }
    })();

    return res.json({ id: task.id, status: "running", resultUrl: null });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "Unknown error" });
  }
});

// GET /v1/jobs/:id  -> { id, status, resultUrl }
app.get("/v1/jobs/:id", async (req, res) => {
  try {
    const userId = getUserIdFromAuth(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    if (!supabaseAdmin) return res.status(500).json({ error: "Supabase not configured" });
    const id = req.params.id;
    const { data: task } = await supabaseAdmin.from("generation_tasks").select("*").eq("id", id).maybeSingle();
    if (!task) return res.status(404).json({ error: "Not found" });
    const paramsUser = (task as any).params?.userId || null;
    if (paramsUser && paramsUser !== userId) return res.status(404).json({ error: "Not found" });

    let status: any = (task as any).status;
    if (status === "running") status = "running"; // keep as-is
    if (status === "succeeded") status = "done";
    if (status === "failed") status = "failed";
    if (status === "queued") status = "queued";

    let resultUrl: string | null = null;
    if ((task as any).status === "succeeded") {
      const { data: outputs } = await supabaseAdmin
        .from("generation_outputs")
        .select("storage_bucket, storage_path, index")
        .eq("task_id", id)
        .order("index", { ascending: true })
        .limit(1);
      const first = outputs?.[0];
      if (first) resultUrl = getPublicUrl({ bucket: (first as any).storage_bucket, path: (first as any).storage_path });
    }
    return res.json({ id, status, resultUrl });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "Unknown error" });
  }
});

// Feature-parity: image edit job endpoints
// POST /api/v1/edit
app.post("/api/v1/edit", upload.fields([{ name: "file", maxCount: 1 }, { name: "mask", maxCount: 1 }]), async (req, res) => {
  try {
    const userId = getUserIdFromAuth(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    if (!supabaseAdmin) return res.status(500).json({ error: "Supabase not configured" });

    const files = req.files as any;
    const file = files?.file?.[0];
    const mask = files?.mask?.[0];
    const prompt = (req.body.prompt as string) || "";
    const clientRequestId = (req.body.client_request_id as string) || null;
    if (!file) return res.status(400).json({ error: "file is required" });
    if (!prompt) return res.status(400).json({ error: "prompt is required" });

    const buf: Buffer = file.buffer as Buffer;
    const mime = file.mimetype || "image/jpeg";
    const ext = (mime.split("/")[1] || "jpg").split("+")[0];

    const reqId = (req as any).__reqId;
    console.log(`[req ${reqId}] /api/v1/edit received`, { userId, hasMask: !!mask, sizeKB: Math.round(buf.byteLength / 1024), mime });

    const task = await insertGenerationTask({
      status: "running",
      style_id: null,
      prompt_id: null,
      prompt,
      params: { userId, clientRequestId, provider: config.provider },
      input_image_path: null,
      output_text: null,
      error: null,
    });
    console.log(`[req ${reqId}] created task`, { taskId: task.id });

    // Upload original and optional mask for record-keeping
    const originalPath = `uploads/${userId}/${task.id}.${ext}`;
    const maskPath = mask ? `uploads/${userId}/${task.id}.mask.png` : null;
    await Promise.all([
      (async () => {
        const { uploadBufferToStorage } = await import("./supabase");
        await uploadBufferToStorage({ bucket: config.imageBucket, path: originalPath, buffer: buf, contentType: mime, upsert: true });
        console.log(`[req ${reqId}] uploaded original`, { path: originalPath });
      })(),
      (async () => {
        if (!mask) return;
        const mbuf: Buffer = mask.buffer as Buffer;
        const { uploadBufferToStorage } = await import("./supabase");
        await uploadBufferToStorage({ bucket: config.imageBucket, path: maskPath!, buffer: mbuf, contentType: "image/png", upsert: true });
        console.log(`[req ${reqId}] uploaded mask`, { path: maskPath });
      })(),
    ]);

    await updateGenerationTask(task.id, { params: { ...(task.params || {}), originalPath, maskPath } as any });

    // Kick off generation in background and return immediately
    (async () => {
      try {
        const maskBuf: Buffer | null = mask ? (mask.buffer as Buffer) : null;
        console.log(`[req ${reqId}] starting background edit generation`, { taskId: task.id });
        const { outputs, text } = await runEditGeneration({
          userId,
          prompt,
          imageBuffer: buf,
          imageMime: mime,
          maskBuffer: maskBuf,
          taskIdHint: task.id,
        });
        await updateGenerationTask(task.id, {
          status: "succeeded",
          output_text: text || null,
          completed_at: new Date().toISOString(),
        });
        console.log(`[req ${reqId}] edit generation done`, { taskId: task.id, outputs: outputs?.length || 0 });
      } catch (err: any) {
        await updateGenerationTask(task.id, {
          status: "failed",
          error: err?.message || String(err),
          completed_at: new Date().toISOString(),
        });
        console.error(`[req ${reqId}] edit generation failed`, { taskId: task.id, error: err?.message || String(err) });
      }
    })();

    // quick estimate: ~35 cents per MB of input
    const estimated_cost_cents = Math.round((buf.byteLength / (1024 * 1024)) * 35);
    return res.json({ job_id: task.id, status: "accepted", estimated_cost_cents });
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "Unknown error" });
  }
});

// GET /api/v1/edit/:id
app.get("/api/v1/edit/:id", async (req, res) => {
  try {
    const userId = getUserIdFromAuth(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    if (!supabaseAdmin) return res.status(500).json({ error: "Supabase not configured" });
    const id = req.params.id;
    const { data: task } = await supabaseAdmin.from("generation_tasks").select("*").eq("id", id).maybeSingle();
    if (!task) return res.status(404).json({ error: "Not found" });
    const paramsUser = (task as any).params?.userId || null;
    if (paramsUser && paramsUser !== userId) return res.status(404).json({ error: "Not found" });

    let status: any = (task as any).status;
    if (status === "running") status = "processing";
    if (status === "succeeded") status = "done";
    if (status === "failed") status = "error";

    let result_url: string | null = null;
    if ((task as any).status === "succeeded") {
      const { data: outputs } = await supabaseAdmin
        .from("generation_outputs")
        .select("storage_bucket, storage_path, index")
        .eq("task_id", id)
        .order("index", { ascending: true })
        .limit(1);
      const first = outputs?.[0];
      if (first) result_url = getPublicUrl({ bucket: first.storage_bucket, path: first.storage_path });
    }
    return res.json({ job_id: id, status, result_url } as any);
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "Unknown error" });
  }
});

// GET /api/v1/edit/:id/result
app.get("/api/v1/edit/:id/result", async (req, res) => {
  try {
    const userId = getUserIdFromAuth(req);
    if (!userId) return res.status(401).json({ error: "Unauthorized" });
    if (!supabaseAdmin) return res.status(500).json({ error: "Supabase not configured" });
    const id = req.params.id;
    const { data: task } = await supabaseAdmin.from("generation_tasks").select("*").eq("id", id).maybeSingle();
    if (!task) return res.status(404).json({ error: "Not found" });
    const paramsUser = (task as any).params?.userId || null;
    if (paramsUser && paramsUser !== userId) return res.status(404).json({ error: "Not found" });

    if ((task as any).status !== "succeeded") return res.status(400).json({ error: "Result not available" });

    const { data: outputs } = await supabaseAdmin
      .from("generation_outputs")
      .select("storage_bucket, storage_path, size, index")
      .eq("task_id", id)
      .order("index", { ascending: true })
      .limit(1);
    const first = outputs?.[0] as any;
    if (!first) return res.status(404).json({ error: "Not found" });

    const size = Number(first.size || 0);
    if (size > 0 && size < 800_000) {
      const base64 = await downloadToBase64({ bucket: first.storage_bucket, path: first.storage_path });
      return res.json({ result_base64: base64 });
    } else {
      const url = await signedUrl({ bucket: first.storage_bucket, path: first.storage_path, expiresIn: 300 });
      return res.redirect(url || "", 302);
    }
  } catch (e: any) {
    res.status(500).json({ error: e?.message || "Unknown error" });
  }
});

app.listen(config.port, () => {
  console.log(`[backend] listening on http://localhost:${config.port}`);
});
