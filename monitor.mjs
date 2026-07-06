import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

await loadDotEnv(path.join(__dirname, ".env"));

const DEFAULT_URLS = [
  "https://www.chromehearts.com/baccarat",
  "https://www.chromehearts.com/scents",
  "https://www.chromehearts.com/boxers-leggings",
  "https://www.chromehearts.com/intimates",
  "https://www.chromehearts.com/socks"
];

const WEBHOOK_URL = process.env.DISCORD_WEBHOOK_URL;
const DRY_RUN = truthy(process.env.DRY_RUN);
const SEND_TEST_NOTIFICATION = truthy(process.env.SEND_TEST_NOTIFICATION);
const NOTIFY_ON_FIRST_RUN = truthy(process.env.NOTIFY_ON_FIRST_RUN);
const STATE_PATH = path.resolve(__dirname, process.env.STATE_PATH || "state.json");
const URLS = (process.env.CHROME_HEARTS_URLS || DEFAULT_URLS.join(","))
  .split(",")
  .map((url) => url.trim())
  .filter(Boolean);

if (!DRY_RUN && !WEBHOOK_URL) {
  throw new Error("DISCORD_WEBHOOK_URL is required unless DRY_RUN=true.");
}

if (SEND_TEST_NOTIFICATION) {
  await sendDiscordTestNotification();
  console.log("Sent Discord test notification.");
  process.exit(0);
}

const previousState = await readState(STATE_PATH);
const seenInStock = new Set(previousState.inStockIds || []);
const products = [];

for (const url of URLS) {
  products.push(...(await fetchCategoryProducts(url)));
}

const uniqueProducts = dedupeProducts(products);
const inStockProducts = uniqueProducts.filter((product) => product.inStock);
const nextState = {
  checkedAt: new Date().toISOString(),
  urls: URLS,
  inStockIds: inStockProducts.map((product) => product.id).sort(),
  products: uniqueProducts
};

const firstRun = !previousState.checkedAt;
const newInStock = inStockProducts.filter((product) => !seenInStock.has(product.id));
const shouldNotify = newInStock.length > 0 && (!firstRun || NOTIFY_ON_FIRST_RUN);

if (DRY_RUN) {
  console.log(JSON.stringify({
    checkedAt: nextState.checkedAt,
    firstRun,
    totalProducts: uniqueProducts.length,
    inStockProducts: inStockProducts.length,
    newInStock: newInStock.length,
    newInStockProducts: newInStock
  }, null, 2));
} else if (shouldNotify) {
  await sendDiscordNotification(newInStock);
}

if (stateContentChanged(previousState, nextState)) {
  await writeState(STATE_PATH, nextState);
}

async function fetchCategoryProducts(categoryUrl) {
  const response = await fetch(categoryUrl, {
    headers: {
      "accept": "text/html,application/xhtml+xml",
      "accept-language": "en-US,en;q=0.9",
      "cache-control": "no-cache",
      "user-agent": "Mozilla/5.0 Chrome Hearts stock monitor (+personal Discord notification)"
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${categoryUrl}: ${response.status} ${response.statusText}`);
  }

  const html = await response.text();
  const categoryName = readTitle(html) || new URL(categoryUrl).pathname.replaceAll("/", "");
  return parseProducts(html, categoryUrl, categoryName);
}

function parseProducts(html, categoryUrl, categoryName) {
  const metadataProducts = parseMetadataProducts(html, categoryUrl, categoryName);
  if (metadataProducts.length > 0) return metadataProducts;

  const products = [];
  const anchorPattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  let match;

  while ((match = anchorPattern.exec(html)) !== null) {
    const attrs = match[1];
    const body = match[2];
    const text = cleanText(body);

    if (!/\$[\d,.]+/.test(text)) continue;
    if (/^(terms|privacy|general|contact)\b/i.test(text)) continue;

    const href = readAttr(attrs, "href");
    const url = href ? new URL(href, categoryUrl).toString() : categoryUrl;
    const price = text.match(/\$[\d,.]+(?:\s*-\s*\$?[\d,.]+)?/)?.[0] || "";
    const unavailable = /\b(out of stock|sold out|unavailable|coming soon)\b/i.test(text);
    const beforePrice = text.slice(0, text.indexOf(price)).trim();
    const name = beforePrice || text.replace(price, "").trim();

    if (!name || name.length > 120) continue;

    products.push({
      id: stableId(url, name, price),
      name,
      price,
      status: unavailable ? "out_of_stock" : "in_stock",
      inStock: !unavailable,
      category: categoryName,
      url
    });
  }

  return products;
}

function parseMetadataProducts(html, categoryUrl, categoryName) {
  const products = [];
  const productPattern = /<div\s+class=["'][^"']*\bproduct\b[^"']*["'][^>]*data-pid=["'][^"']+["'][^>]*>[\s\S]*?(?=<div\s+class=["'][^"']*\bproduct\b[^"']*["'][^>]*data-pid=["']|<\/body>|$)/gi;
  let match;

  while ((match = productPattern.exec(html)) !== null) {
    const block = match[0];
    const metadata = block.match(/<span\s+class=["'][^"']*\bproduct-metadata\b[^"']*["']([^>]*)>/i)?.[1];
    if (!metadata) continue;

    const pid = readAttr(metadata, "data-pid");
    const name = readAttr(metadata, "data-name");
    const price = normalizePrice(readAttr(metadata, "data-price"));
    const category = readAttr(metadata, "data-category") || categoryName;
    const href = readFirstHref(block);
    const url = href ? new URL(href, categoryUrl).toString() : categoryUrl;
    const unavailable = /\b(out of stock|sold out|unavailable|coming soon)\b/i.test(cleanText(block));

    if (!pid || !name || !price) continue;

    products.push({
      id: pid,
      name,
      price,
      status: unavailable ? "out_of_stock" : "in_stock",
      inStock: !unavailable,
      category,
      url
    });
  }

  return products;
}

function dedupeProducts(products) {
  const byId = new Map();

  for (const product of products) {
    const existing = byId.get(product.id);
    if (!existing || (!existing.inStock && product.inStock)) {
      byId.set(product.id, product);
    }
  }

  return [...byId.values()].sort((a, b) => {
    return `${a.category} ${a.name}`.localeCompare(`${b.category} ${b.name}`);
  });
}

async function sendDiscordNotification(productsToSend) {
  for (const chunk of chunkArray(productsToSend, 10)) {
    const response = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "Chrome Hearts Monitor",
        content: `New Chrome Hearts item${chunk.length === 1 ? "" : "s"} available to purchase.`,
        embeds: chunk.map((product) => ({
          title: product.name,
          url: product.url,
          description: `${product.price}\n${product.category}`,
          color: 0x111111,
          timestamp: new Date().toISOString()
        }))
      })
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Discord webhook failed: ${response.status} ${body}`);
    }
  }
}

async function sendDiscordTestNotification() {
  const response = await fetch(WEBHOOK_URL, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: "Chrome Hearts Monitor",
      content: "Chrome Hearts monitor test: Discord webhook is connected."
    })
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Discord webhook failed: ${response.status} ${body}`);
  }
}

async function readState(filePath) {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

async function writeState(filePath, state) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(state, null, 2)}\n`);
}

function cleanText(html) {
  return decodeHtml(html.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function readTitle(html) {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  return title ? cleanText(title).replace(/\s*\|\s*Chrome Hearts\s*$/i, "") : "";
}

function readAttr(attrs, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = attrs.match(new RegExp(`${escaped}\\s*=\\s*["']([^"']+)["']`, "i"));
  return match ? decodeHtml(match[1]) : "";
}

function readFirstHref(html) {
  const preferred = html.match(/<a\b[^>]*class=["'][^"']*\bpdp-link-image\b[^"']*["'][^>]*href=["']([^"']+)["']/i)?.[1];
  if (preferred) return decodeHtml(preferred);

  const fallback = html.match(/<a\b[^>]*href=["']([^"']+)["']/i)?.[1];
  return fallback ? decodeHtml(fallback) : "";
}

function normalizePrice(price) {
  return price.replace(/\.00\b/g, "");
}

function decodeHtml(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ");
}

function stableId(url, name, price) {
  return `${url}#${name}#${price}`.toLowerCase().replace(/\s+/g, "-");
}

function truthy(value) {
  return /^(1|true|yes|on)$/i.test(value || "");
}

function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function stateContentChanged(previousState, nextState) {
  return JSON.stringify(stripVolatileState(previousState)) !== JSON.stringify(stripVolatileState(nextState));
}

function stripVolatileState(state) {
  const { checkedAt, ...stableState } = state || {};
  return stableState;
}

async function loadDotEnv(filePath) {
  let text;
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }

  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex === -1) continue;

    const key = trimmed.slice(0, equalsIndex).trim();
    const rawValue = trimmed.slice(equalsIndex + 1).trim();
    const value = rawValue.replace(/^["']|["']$/g, "");

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}
