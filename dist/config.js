import dotenv from "dotenv";
dotenv.config();
export const config = {
    port: Number(process.env.PORT || 4000),
    geminiApiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "",
    genaiModel: process.env.GENAI_MODEL || "gemini-2.5-flash-image-preview",
    supabaseUrl: process.env.SUPABASE_URL || "",
    supabaseServiceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || "",
    imageBucket: process.env.SUPABASE_IMAGE_BUCKET || "gen-images",
    // Additional controls for feature-parity endpoints
    devToken: process.env.DEV_TOKEN || "dev-token",
    provider: (process.env.PROVIDER || "gemini"),
    // Pinata configuration (IPFS)
    pinataJwt: process.env.PINATA_JWT || "",
    pinataUploadEndpoint: process.env.PINATA_UPLOAD_ENDPOINT || "https://uploads.pinata.cloud/v3/files",
    pinataPinEndpoint: process.env.PINATA_PIN_ENDPOINT || "https://api.pinata.cloud/pinning/pinFileToIPFS",
    pinataGatewayBase: process.env.PINATA_GATEWAY_BASE || "https://gateway.pinata.cloud/ipfs",
    // Prefer pinning to IPFS (public) over private uploads
    pinataPreferIpfs: (process.env.PINATA_PREFER_IPFS || "true").toLowerCase() !== "false",
    corsOrigins: (process.env.CORS_ORIGINS || "*")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
};
export function assertEnv() {
    if (!config.geminiApiKey)
        console.warn("GEMINI_API_KEY is not set; /generate-image will fail");
    if (!config.supabaseUrl)
        console.warn("SUPABASE_URL is not set; DB/storage features will fail");
    if (!config.supabaseServiceRoleKey)
        console.warn("SUPABASE_SERVICE_ROLE_KEY is not set; DB/storage features will fail");
    if (!config.pinataJwt)
        console.warn("PINATA_JWT is not set; image uploads to Pinata will fail");
}
