import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

await loadDotEnv(path.join(__dirname, ".env"));

const HERMES_CATEGORY_URL = process.env.HERMES_CATEGORY_URL ||
  "https://www.hermes.com/tw/zh/category/leather-goods/bags-and-clutches/womens-bags-and-clutches/";
const WEBHOOK_URL = process.env.HERMES_DISCORD_WEBHOOK_URL;
const DRY_RUN = truthy(process.env.DRY_RUN);
const SEND_TEST_NOTIFICATION = truthy(process.env.SEND_TEST_NOTIFICATION);
const NOTIFY_ON_FIRST_RUN = truthy(process.env.HERMES_NOTIFY_ON_FIRST_RUN || process.env.NOTIFY_ON_FIRST_RUN);
const STATE_PATH = path.resolve(__dirname, process.env.HERMES_STATE_PATH || "hermes-state.json");

const TARGET_BAGS = [
  { label: "Lindy 26", pattern: /\blindy\b[\s\S]*\b26\b/i },
  { label: "Mini Lindy", pattern: /(?:mini[\s\S]*lindy|lindy[\s\S]*mini|lindy[\s\S]*迷你|迷你[\s\S]*lindy)/i },
  { label: "Herbag Mini", pattern: /herbag[\s\S]*(?:mini|迷你|20)/i },
  { label: "Herbag 31", pattern: /herbag[\s\S]*31/i },
  { label: "Evelyne Mini", pattern: /evelyne[\s\S]*(?:mini|迷你|16)/i },
  { label: "Evelyne 29", pattern: /evelyne[\s\S]*29/i },
  { label: "Constance", pattern: /constance/i },
  { label: "Picotin", pattern: /picotin/i },
  { label: "Garden 30", pattern: /garden[\s\S]*30/i },
  { label: "Halzan", pattern: /halzan/i },
  { label: "Verrou", pattern: /verrou/i },
  { label: "Roulis", pattern: /roulis/i },
  { label: "Kelly Dance", pattern: /kelly[\s\S]*dance/i }
];

if (!DRY_RUN && !WEBHOOK_URL) {
  throw new Error("HERMES_DISCORD_WEBHOOK_URL is required unless DRY_RUN=true.");
}

if (SEND_TEST_NOTIFICATION) {
  await sendDiscordTestNotification();
  console.log("Sent Hermes Discord test notification.");
  process.exit(0);
}

const previousState = await readState(STATE_PATH);
const seenInStock = new Set(previousState.inStockIds || []);
const allProducts = await fetchHermesProducts(HERMES_CATEGORY_URL);
const targetProducts = allProducts
  .map((product) => ({ ...product, target: matchTarget(product.name) }))
  .filter((product) => product.target && product.inStock);

const nextState = {
  checkedAt: new Date().toISOString(),
  categoryUrl: HERMES_CATEGORY_URL,
  targetLabels: TARGET_BAGS.map((target) => target.label),
  inStockIds: targetProducts.map((product) => product.id).sort(),
  products: targetProducts
};

const firstRun = !previousState.checkedAt;
const newInStock = targetProducts.filter((product) => !seenInStock.has(product.id));
const shouldNotify = newInStock.length > 0 && (!firstRun || NOTIFY_ON_FIRST_RUN);

if (DRY_RUN) {
  console.log(JSON.stringify({
    checkedAt: nextState.checkedAt,
    firstRun,
    totalProducts: allProducts.length,
    matchingTargetProducts: targetProducts.length,
    newInStock: newInStock.length,
    newInStockProducts: newInStock
  }, null, 2));
} else if (shouldNotify) {
  await sendDiscordNotification(newInStock);
}

if (stateContentChanged(previousState, nextState)) {
  await writeState(STATE_PATH, nextState);
}

async function fetchHermesProducts(categoryUrl) {
  const response = await fetch(categoryUrl, {
    headers: {
      "accept": "text/html,application/xhtml+xml",
      "accept-language": "zh-TW,zh;q=0.9,en-US;q=0.8,en;q=0.7",
      "cache-control": "no-cache",
      "user-agent": "Mozilla/5.0 Hermes bag availability monitor (+personal Discord notification)"
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${categoryUrl}: ${response.status} ${response.statusText}`);
  }

  return parseHermesProducts(await response.text(), categoryUrl);
}

function parseHermesProducts(html, categoryUrl) {
  const products = [];
  const blockPattern = /<div\b[^>]*class=["'][^"']*\bproduct-item-meta\b[^"']*["'][^>]*id=["']product-item-meta-([^"']+)["'][^>]*>[\s\S]*?(?=<div\b[^>]*class=["'][^"']*\bproduct-item-meta\b|<\/body>|$)/gi;
  let match;

  while ((match = blockPattern.exec(html)) !== null) {
    const block = match[0];
    const id = decodeHtml(match[1]);
    const href = readAttr(block, "href");
    const title = readAttr(block, "title");
    const name = cleanText(block.match(/<span\b[^>]*class=["'][^"']*\bproduct-title\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/i)?.[1] || title.split(",")[0]);
    const color = cleanText(title.split(",").slice(1).join(","));
    const price = cleanText(block).match(/NT\$\s*[\d,]+/)?.[0] || "";
    const unavailable = /(缺貨|售罄|暫無庫存|not available|out of stock|sold out)/i.test(cleanText(block));

    if (!id || !href || !name || !price) continue;

    products.push({
      id,
      name,
      color,
      price,
      status: unavailable ? "out_of_stock" : "in_stock",
      inStock: !unavailable,
      url: new URL(href, categoryUrl).toString()
    });
  }

  return dedupeProducts(products);
}

function matchTarget(name) {
  return TARGET_BAGS.find((target) => target.pattern.test(name))?.label || "";
}

function dedupeProducts(products) {
  const byId = new Map();

  for (const product of products) {
    byId.set(product.id, product);
  }

  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
}

async function sendDiscordNotification(productsToSend) {
  for (const chunk of chunkArray(productsToSend, 10)) {
    const response = await fetch(WEBHOOK_URL, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        username: "Hermes Bag Monitor",
        content: `Hermes target bag${chunk.length === 1 ? "" : "s"} listed in stock.`,
        embeds: chunk.map((product) => ({
          title: `${product.target}: ${product.name}`,
          url: product.url,
          description: [product.price, product.color].filter(Boolean).join("\n"),
          color: 0xc8a45d,
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
      username: "Hermes Bag Monitor",
      content: "Hermes bag monitor test: Discord webhook is connected."
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

function readAttr(html, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = html.match(new RegExp(`${escaped}\\s*=\\s*["']([^"']+)["']`, "i"));
  return match ? decodeHtml(match[1]) : "";
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
