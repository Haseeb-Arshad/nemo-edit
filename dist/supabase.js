import { createClient } from "@supabase/supabase-js";
import { config } from "./config.js";
export const supabaseAdmin = config.supabaseUrl && config.supabaseServiceRoleKey
    ? createClient(config.supabaseUrl, config.supabaseServiceRoleKey)
    : null;
function isPinataEnabled() {
    return !!config.pinataJwt;
}
export async function uploadBufferToStorage(opts) {
    const { bucket, path, buffer, contentType } = opts;
    if (isPinataEnabled()) {
        const filename = path.split("/").pop() || "file";
        const type = contentType || "application/octet-stream";
        const form = new FormData();
        const blob = new Blob([new Uint8Array(buffer)], { type });
        form.append("file", blob, filename);
        if (config.pinataPreferIpfs) {
            // Pin directly to public IPFS so gateway links work immediately
            const resp = await fetch(config.pinataPinEndpoint, {
                method: "POST",
                headers: { Authorization: `Bearer ${config.pinataJwt}` },
                body: form,
            });
            if (!resp.ok) {
                const text = await resp.text().catch(() => "");
                throw new Error(`Pinata pinFileToIPFS failed: ${resp.status} ${text}`);
            }
            const json = await resp.json();
            const cid = json?.IpfsHash || json?.cid || json?.data?.cid;
            if (!cid)
                throw new Error("Pinata pinFileToIPFS did not return a CID");
            const pinataPath = `${cid}/${filename}`;
            const publicUrl = `${config.pinataGatewayBase}/${cid}?filename=${encodeURIComponent(filename)}`;
            console.log(`[storage] pinata pinned to IPFS`, { cid, filename });
            return { path: pinataPath, publicUrl };
        }
        else {
            // Use Uploads API (may be private by default)
            const resp = await fetch(config.pinataUploadEndpoint, {
                method: "POST",
                headers: { Authorization: `Bearer ${config.pinataJwt}` },
                body: form,
            });
            if (!resp.ok) {
                const text = await resp.text().catch(() => "");
                throw new Error(`Pinata upload failed: ${resp.status} ${text}`);
            }
            const json = await resp.json();
            const cid = json?.data?.cid || json?.cid || json?.IpfsHash;
            if (!cid)
                throw new Error("Pinata upload did not return a CID");
            const pinataPath = `${cid}/${filename}`;
            const publicUrl = `${config.pinataGatewayBase}/${cid}?filename=${encodeURIComponent(filename)}`;
            console.log(`[storage] pinata upload ok`, { cid, filename });
            return { path: pinataPath, publicUrl };
        }
    }
    else {
        if (!supabaseAdmin)
            throw new Error("Supabase not configured");
        const { data, error } = await supabaseAdmin.storage
            .from(bucket)
            .upload(path, buffer, {
            contentType: contentType || "application/octet-stream",
            upsert: !!opts.upsert,
        });
        if (error)
            throw error;
        const { data: pub } = supabaseAdmin.storage.from(bucket).getPublicUrl(path);
        console.log(`[storage] supabase upload ok`, { bucket, path });
        return { path: data?.path || path, publicUrl: pub?.publicUrl };
    }
}
export async function signedUrl(opts) {
    // For Pinata/IPFS, public gateway URLs are already public; return constructed URL
    if (opts.bucket === "external-url") {
        return opts.path;
    }
    if (isPinataEnabled()) {
        const { path } = opts;
        const [cid, ...rest] = path.split("/");
        const filename = rest.join("/") || "file";
        return `${config.pinataGatewayBase}/${cid}?filename=${encodeURIComponent(filename)}`;
    }
    if (!supabaseAdmin)
        throw new Error("Supabase not configured");
    const { bucket, path, expiresIn = 3600 } = opts;
    const { data, error } = await supabaseAdmin.storage.from(bucket).createSignedUrl(path, expiresIn);
    if (error)
        throw error;
    return data.signedUrl;
}
export function getPublicUrl(opts) {
    if (opts.bucket === "external-url") {
        return opts.path;
    }
    if (isPinataEnabled()) {
        const [cid, ...rest] = opts.path.split("/");
        const filename = rest.join("/") || "file";
        return `${config.pinataGatewayBase}/${cid}?filename=${encodeURIComponent(filename)}`;
    }
    if (!supabaseAdmin)
        throw new Error("Supabase not configured");
    const { data } = supabaseAdmin.storage.from(opts.bucket).getPublicUrl(opts.path);
    return data.publicUrl;
}
export async function downloadToBase64(opts) {
    if (opts.bucket === "external-url") {
        const res = await fetch(opts.path);
        if (!res.ok)
            throw new Error(`Fetch failed: ${res.status}`);
        const arr = Buffer.from(await res.arrayBuffer());
        return arr.toString("base64");
    }
    if (isPinataEnabled()) {
        const url = getPublicUrl(opts);
        const res = await fetch(url);
        if (!res.ok)
            throw new Error(`Fetch failed: ${res.status}`);
        const arr = Buffer.from(await res.arrayBuffer());
        return arr.toString("base64");
    }
    if (!supabaseAdmin)
        throw new Error("Supabase not configured");
    const { data, error } = await supabaseAdmin.storage.from(opts.bucket).download(opts.path);
    if (error)
        throw error;
    const arr = Buffer.from(await data.arrayBuffer());
    return arr.toString("base64");
}
export async function insertGenerationTask(payload) {
    if (!supabaseAdmin)
        throw new Error("Supabase not configured");
    const { data, error } = await supabaseAdmin
        .from("generation_tasks")
        .insert(payload)
        .select("*")
        .single();
    if (error)
        throw error;
    return data;
}
export async function updateGenerationTask(id, patch) {
    if (!supabaseAdmin)
        throw new Error("Supabase not configured");
    const { data, error } = await supabaseAdmin
        .from("generation_tasks")
        .update(patch)
        .eq("id", id)
        .select("*")
        .single();
    if (error)
        throw error;
    return data;
}
export async function insertGenerationOutput(payload) {
    if (!supabaseAdmin)
        throw new Error("Supabase not configured");
    const { data, error } = await supabaseAdmin
        .from("generation_outputs")
        .insert({ ...payload, metadata: payload.metadata || null })
        .select("*")
        .single();
    if (error)
        throw error;
    return data;
}
