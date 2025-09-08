import { GoogleGenAI } from "@google/genai";
import mime from "mime";
import { config } from "./config.js";
import { uploadBufferToStorage, insertGenerationTask, updateGenerationTask, insertGenerationOutput, supabaseAdmin } from "./supabase.js";

export type GenerateImageOptions = {
  styleSlug?: string | null;
  promptId?: string | null;
  promptText?: string;
  quality?: string | null;
  filters?: Array<{ slug: string; value?: number | string }>;
  variations?: number;
  imageBuffer?: Buffer | null;
  imageMime?: string | null;
  userId?: string | null;
  // Optional edit-specific inputs
  maskBuffer?: Buffer | null;
  maskMime?: string | null;
};

function compilePrompt(base: string | undefined, opts: GenerateImageOptions) {
  const desc: string[] = [];
  if (base) desc.push(base);
  if (opts.quality) desc.push(`Quality: ${opts.quality}`);
  if (opts.filters?.length) {
    const f = opts.filters.map((x) => (x.value !== undefined ? `${x.slug}=${x.value}` : x.slug));
    desc.push(`Filters: ${f.join(", ")}`);
  }
  if (opts.promptText) desc.push(opts.promptText);
  return desc.filter(Boolean).join("\n");
}

async function lookupStyleAndPrompt(opts: GenerateImageOptions): Promise<{ basePrompt?: string; styleId?: string | null; promptId?: string | null }> {
  if (!supabaseAdmin) return {};
  let styleId: string | null | undefined = null;
  let promptId: string | null | undefined = null;
  let basePrompt: string | undefined;

  if (opts.styleSlug) {
    const { data: style } = await supabaseAdmin
      .from("image_styles")
      .select("id, base_prompt")
      .eq("slug", opts.styleSlug)
      .eq("active", true)
      .maybeSingle();
    if (style) {
      styleId = (style as any).id;
      basePrompt = (style as any).base_prompt || basePrompt;
    }
  }

  if (opts.promptId) {
    const { data: preset } = await supabaseAdmin
      .from("prompt_presets")
      .select("id, prompt_template")
      .eq("id", opts.promptId)
      .eq("active", true)
      .maybeSingle();
    if (preset) {
      promptId = (preset as any).id;
      basePrompt = ((preset as any).prompt_template as string) || basePrompt;
    }
  }
  return { basePrompt, styleId, promptId };
}

export async function runImmediateGeneration(opts: GenerateImageOptions) {
  if (!config.geminiApiKey) throw new Error("GEMINI_API_KEY not configured");

  const { basePrompt, styleId, promptId } = await lookupStyleAndPrompt(opts);
  const finalPrompt = compilePrompt(basePrompt, opts);

  console.log(`[genai] start immediate generation`, {
    styleSlug: opts.styleSlug,
    promptId: opts.promptId,
    hasImage: !!opts.imageBuffer,
    variations: opts.variations || 1,
  });

  const task = await insertGenerationTask({
    status: "running",
    style_id: styleId || null,
    prompt_id: promptId || null,
    prompt: finalPrompt,
    params: {
      quality: opts.quality || null,
      filters: opts.filters || [],
      variations: opts.variations || 1,
      styleSlug: opts.styleSlug || null,
    },
    input_image_path: null,
    output_text: null,
    error: null,
  });

  const ai = new GoogleGenAI({ apiKey: config.geminiApiKey });
  const configGen: any = { responseModalities: ["IMAGE", "TEXT"] as string[] };
  const model = config.genaiModel;

  const parts: any[] = [];
  if (opts.imageBuffer && opts.imageBuffer.length) {
    const mimeType = opts.imageMime || "image/jpeg";
    parts.push({ inlineData: { data: opts.imageBuffer.toString("base64"), mimeType } });
  }
  if (opts.maskBuffer && opts.maskBuffer.length) {
    const maskType = opts.maskMime || "image/png";
    parts.push({ inlineData: { data: opts.maskBuffer.toString("base64"), mimeType: maskType } });
  }
  if (finalPrompt) parts.push({ text: finalPrompt });
  const contents = [{ role: "user", parts }];

  const response = await (ai as any).models.generateContentStream({ model, config: configGen, contents });
  let textOut = "";
  let index = 0;
  const uploaded: Array<{ url?: string; path: string; bucket: string; mime?: string } | null> = [];

  try {
    for await (const chunk of response as any) {
      const parts = chunk?.candidates?.[0]?.content?.parts;
      if (!parts || !parts.length) continue;
      const first = parts[0];
      if (first?.inlineData) {
        const inline = first.inlineData;
        const buf = Buffer.from(inline.data || "", "base64");
        const mt = inline.mimeType || "image/png";
        const ext = mime.getExtension(mt) || "png";
        const filePath = `${task.id}/${index}.${ext}`;
        const up = await uploadBufferToStorage({
          bucket: config.imageBucket,
          path: filePath,
          buffer: buf,
          contentType: mt,
          upsert: true,
        });
        console.log(`[genai] saved output`, { taskId: task.id, index, mime: mt, path: up?.path });
        await insertGenerationOutput({
          task_id: task.id,
          index,
          storage_bucket: config.imageBucket,
          storage_path: up?.path || filePath,
          mime: mt,
          size: buf.byteLength,
          width: null,
          height: null,
          metadata: {},
        });
        uploaded.push({ url: up?.publicUrl, path: up?.path || filePath, bucket: config.imageBucket, mime: mt });
        index++;
      } else if ((first as any)?.fileData?.fileUri || (first as any)?.fileData?.uri || (first as any)?.media?.url || (first as any)?.url) {
        const url = (first as any)?.fileData?.fileUri || (first as any)?.fileData?.uri || (first as any)?.media?.url || (first as any)?.url;
        const mt = (first as any)?.fileData?.mimeType || (first as any)?.mimeType || null;
        await insertGenerationOutput({
          task_id: task.id,
          index,
          storage_bucket: "external-url",
          storage_path: url,
          mime: mt,
          size: null,
          width: null,
          height: null,
          metadata: { provider: "google", kind: "url" },
        });
        uploaded.push({ url, path: url, bucket: "external-url", mime: mt || undefined });
        console.log(`[genai] recorded external url`, { taskId: task.id, index, url });
        index++;
      } else if (typeof chunk?.text === "string") {
        textOut += chunk.text;
      }
    }

    await updateGenerationTask(task.id, {
      status: "succeeded",
      output_text: textOut || null,
      completed_at: new Date().toISOString(),
    });
    console.log(`[genai] task succeeded`, { taskId: task.id, images: uploaded.length });

    return { taskId: task.id, outputs: uploaded.filter(Boolean), text: textOut };
  } catch (err: any) {
    await updateGenerationTask(task.id, {
      status: "failed",
      error: err?.message || String(err),
      completed_at: new Date().toISOString(),
    });
    console.error(`[genai] task failed`, { taskId: task.id, error: err?.message || String(err) });
    throw err;
  }
}

// Direct edit flow used by /api/v1/edit
export async function runEditGeneration(opts: {
  userId: string;
  prompt: string;
  imageBuffer: Buffer;
  imageMime: string;
  maskBuffer?: Buffer | null;
  taskIdHint?: string;
}) {
  if (!config.geminiApiKey) throw new Error("GEMINI_API_KEY not configured");
  const ai = new GoogleGenAI({ apiKey: config.geminiApiKey });
  const model = config.genaiModel;

  const instruction = opts.maskBuffer
    ? `${opts.prompt}\n\nApply edits only to regions marked in the provided mask: white=edit, black=keep.`
    : opts.prompt;

  const parts: any[] = [];
  parts.push({ text: instruction });
  parts.push({ inlineData: { data: opts.imageBuffer.toString("base64"), mimeType: opts.imageMime } });
  if (opts.maskBuffer && opts.maskBuffer.length) {
    parts.push({ inlineData: { data: opts.maskBuffer.toString("base64"), mimeType: "image/png" } });
  }

  const contents = [{ role: "user", parts }];
  const configGen: any = { responseModalities: ["IMAGE", "TEXT"] as string[] };

  const response = await (ai as any).models.generateContentStream({ model, config: configGen, contents });
  let textOut = "";
  let index = 0;
  const uploaded: Array<{ url?: string; path: string; bucket: string; mime?: string } | null> = [];

  try {
    for await (const chunk of response as any) {
      const parts = chunk?.candidates?.[0]?.content?.parts;
      if (!parts || !parts.length) continue;
      const first = parts[0];
      if (first?.inlineData) {
        const inline = first.inlineData;
        const buf = Buffer.from(inline.data || "", "base64");
        const mt = inline.mimeType || "image/png";
        const ext = mime.getExtension(mt) || "png";
        const filePath = `${opts.taskIdHint || Date.now().toString()}/${index}.${ext}`;
        const up = await uploadBufferToStorage({
          bucket: config.imageBucket,
          path: filePath,
          buffer: buf,
          contentType: mt,
          upsert: true,
        });
        console.log(`[genai] saved edit output`, { taskId: opts.taskIdHint, index, mime: mt, path: up?.path });
        await insertGenerationOutput({
          task_id: opts.taskIdHint || "",
          index,
          storage_bucket: config.imageBucket,
          storage_path: up?.path || filePath,
          mime: mt,
          size: buf.byteLength,
          width: null,
          height: null,
          metadata: {},
        });
        uploaded.push({ url: up?.publicUrl, path: up?.path || filePath, bucket: config.imageBucket, mime: mt });
        index++;
      } else if ((first as any)?.fileData?.fileUri || (first as any)?.fileData?.uri || (first as any)?.media?.url || (first as any)?.url) {
        const url = (first as any)?.fileData?.fileUri || (first as any)?.fileData?.uri || (first as any)?.media?.url || (first as any)?.url;
        const mt = (first as any)?.fileData?.mimeType || (first as any)?.mimeType || null;
        await insertGenerationOutput({
          task_id: opts.taskIdHint || "",
          index,
          storage_bucket: "external-url",
          storage_path: url,
          mime: mt,
          size: null,
          width: null,
          height: null,
          metadata: { provider: "google", kind: "url" },
        });
        uploaded.push({ url, path: url, bucket: "external-url", mime: mt || undefined });
        console.log(`[genai] recorded external url`, { taskId: opts.taskIdHint, index, url });
        index++;
      } else if (typeof chunk?.text === "string") {
        textOut += chunk.text;
      }
    }

    return { outputs: uploaded.filter(Boolean), text: textOut };
  } catch (err) {
    console.error(`[genai] edit generation failed`, { taskId: opts.taskIdHint, error: (err as any)?.message || String(err) });
    throw err;
  }
}
