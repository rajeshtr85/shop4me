/**
 * Shop4Me /go redirect + click logging
 *
 * Supports:
 *   /go?to=<url>                   (redirects to "to")
 *   /go?asin=<ASIN>&tag=<tag>      (builds amazon.in dp link)
 * Optional logging params:
 *   &src=<string> &created_by=<email> &created_at=<iso> &asin=<ASIN>
 *
 * Notes:
 * - Uses Firebase Admin SDK (server-side). No Firestore rules needed for the function itself.
 * - If you DON'T want logging, set ENABLE_LOGGING = false below.
 */

const { onRequest } = require("firebase-functions/v2/https");
const logger = require("firebase-functions/logger");
const admin = require("firebase-admin");

admin.initializeApp();
const db = admin.firestore();

// ---- Config ----
const ENABLE_LOGGING = true;
const DEFAULT_AFF_TAG = "shop4me0e-21";
const AMAZON_HOST = "https://www.amazon.in";

// Basic allowlist: only redirect to Amazon (and a couple of safe add-ons if you want)
const ALLOWLIST_HOSTS = new Set([
  "www.amazon.in",
  "amazon.in",
  "amzn.to",
  "m.amazon.in"
]);

function safeUrl(raw) {
  try {
    const u = new URL(raw);
    return u;
  } catch (_) {
    return null;
  }
}

function isAllowedTarget(urlObj) {
  if (!urlObj) return false;
  const host = (urlObj.hostname || "").toLowerCase();
  return ALLOWLIST_HOSTS.has(host);
}

function extractAsin(s) {
  if (!s) return "";
  const str = String(s).trim();

  // Common patterns: /dp/ASIN, /gp/product/ASIN, /product/ASIN
  const m1 = str.match(/\/(?:dp|gp\/product|product)\/([A-Z0-9]{10})(?:[/?]|$)/i);
  if (m1 && m1[1]) return m1[1].toUpperCase();

  // Fallback: any 10-char alphanum token
  const m2 = str.match(/([A-Z0-9]{10})(?:[/?]|$)/i);
  if (m2 && m2[1]) return m2[1].toUpperCase();

  return "";
}

function buildAmazonAffiliateUrl({ asin, tag }) {
  const t = (tag || DEFAULT_AFF_TAG).trim() || DEFAULT_AFF_TAG;
  return `${AMAZON_HOST}/dp/${encodeURIComponent(asin)}?tag=${encodeURIComponent(t)}`;
}

exports.go = onRequest({ region: "asia-south1" }, async (req, res) => {
  // Avoid caches
  res.set("Cache-Control", "no-store, max-age=0");

  try {
    // 1) Direct URL redirect
    let to = (req.query.to || "").toString().trim();
    // 2) Or build from ASIN
    const asinParam = (req.query.asin || "").toString().trim();
    const tagParam = (req.query.tag || "").toString().trim();

    let targetUrl = "";

    if (to) {
      // If missing protocol, reject (or you can auto-prefix https://)
      if (!/^https?:\/\//i.test(to)) {
        return res.status(400).send("Invalid 'to' URL (must start with http/https).");
      }
      const u = safeUrl(to);
      if (!isAllowedTarget(u)) {
        return res.status(400).send("Target host not allowed.");
      }
      targetUrl = u.toString();
    } else {
      const asin = extractAsin(asinParam);
      if (!asin) {
        return res.status(400).send("Missing target. Provide ?to=<url> or ?asin=<ASIN>.");
      }
      targetUrl = buildAmazonAffiliateUrl({ asin, tag: tagParam });
    }

    // Optional: click logging
    if (ENABLE_LOGGING) {
      const now = admin.firestore.FieldValue.serverTimestamp();
      const ip =
        (req.headers["x-forwarded-for"] || "").toString().split(",")[0].trim() ||
        req.ip ||
        "";
      const ua = (req.headers["user-agent"] || "").toString();

      const asinForLog =
        extractAsin(req.query.asin || "") ||
        extractAsin(targetUrl) ||
        "";

      const docData = {
        targetUrl,
        asin: asinForLog || null,
        tag: (tagParam || DEFAULT_AFF_TAG) || DEFAULT_AFF_TAG,
        src: (req.query.src || "").toString().slice(0, 120) || null,
        created_by: (req.query.created_by || "").toString().slice(0, 200) || null,
        created_at: (req.query.created_at || "").toString().slice(0, 80) || null,
        ip: ip || null,
        userAgent: ua || null,
        ts: now
      };

      // Writes to: clicks/<autoId>
      db.collection("clicks").add(docData).catch((e) => {
        logger.warn("Click log failed:", e?.message || e);
      });
    }

    // Redirect
    return res.redirect(302, targetUrl);
  } catch (e) {
    logger.error("go() error:", e?.message || e);
    return res.status(500).send("Server error");
  }
});
