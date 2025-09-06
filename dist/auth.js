import { config } from "./config";
export function getUserIdFromAuth(req) {
    const auth = req.header("authorization") || "";
    const m = auth.match(/^Bearer\s+(.+)$/i);
    const token = m?.[1];
    if (!token)
        return null;
    if (token === config.devToken)
        return "dev-user";
    return null;
}
