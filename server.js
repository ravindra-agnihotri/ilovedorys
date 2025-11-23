/**
 * server.js (updated)
 * - All previous functionality (uploads, products, history, disk-info)
 * - Adds BOTH:
 *     POST /images/delete    -> accepts { filename } or { files: [ ... ] } (requires admin)
 *     DELETE /images/delete/:filename  -> single delete via URL (requires admin)
 *
 * PLEASE replace your existing server.js with this file.
 */

const express = require("express");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const multer = require("multer");
const sharp = require("sharp");
const { v4: uuidv4 } = require("uuid");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

/* -------------------- Paths -------------------- */
const PUBLIC_DIR = path.join(__dirname, "public");
const IMAGES_DIR = path.join(PUBLIC_DIR, "images");
const TMP_DIR = path.join(__dirname, "tmp_uploads");
const PRODUCTS_IMG_DIR = path.join(IMAGES_DIR, "products");
const DATA_DIR = path.join(PUBLIC_DIR, "data");
const PRODUCTS_JSON = path.join(DATA_DIR, "products.json");

const ALLOWED = /\.(jpg|jpeg|png|gif|webp|svg|heic|heif)$/i;
const DISK_SIZE_GB = 5; // keep consistent with what you configured

/* -------------------- Middleware -------------------- */
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(PUBLIC_DIR));
app.use("/images", express.static(IMAGES_DIR));

function requireAdmin(req, res, next) {
  const cookie = (req.headers.cookie || "");
  if (cookie.includes("admin=4321")) return next();
  // Also allow X-Admin header for programmatic calls (optional)
  if (req.headers['x-admin-pin'] === '4321') return next();
  return res.status(403).json({ error: "Admin authentication required" });
}

/* -------------------- Ensure folders -------------------- */
async function ensureFolders() {
  await fsp.mkdir(IMAGES_DIR, { recursive: true });
  await fsp.mkdir(TMP_DIR, { recursive: true });
  await fsp.mkdir(PRODUCTS_IMG_DIR, { recursive: true });
  await fsp.mkdir(DATA_DIR, { recursive: true });
  try {
    await fsp.access(PRODUCTS_JSON);
  } catch {
    await fsp.writeFile(PRODUCTS_JSON, JSON.stringify([], null, 2));
  }
}
ensureFolders().catch(console.error);

/* -------------------- Multer -------------------- */
const upload = multer({
  storage: multer.diskStorage({
    destination: TMP_DIR,
    filename: (req, f, cb) => cb(null, Date.now() + "-" + f.originalname)
  })
});
const uploadProducts = upload; // reuse same config

/* -------------------- Helpers -------------------- */

// sanitize file name (prevent traversal)
function safeFilename(name) {
  if (!name) return null;
  // remove any path parts
  name = path.basename(name);
  // disallow suspicious chars
  if (name.includes("..") || name.includes("/") || name.includes("\\")) return null;
  return name;
}

async function walkImages(dir) {
  const results = [];
  async function walk(d) {
    let items;
    try {
      items = await fsp.readdir(d, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const it of items) {
      const full = path.join(d, it.name);
      if (it.isDirectory()) {
        await walk(full);
      } else {
        if (ALLOWED.test(it.name.toLowerCase())) {
          const s = await fsp.stat(full);
          const rel = path.relative(IMAGES_DIR, full).replace(/\\/g, "/");
          results.push({ file: rel, size: s.size, mtime: s.mtime.toISOString() });
        }
      }
    }
  }
  await walk(dir);
  return results;
}

/* -------------------- Routes -------------------- */

/* GET /images/list  -- top-level files (keeps compatibility) */
app.get("/images/list", async (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    const files = await fsp.readdir(IMAGES_DIR);
    const filtered = files.filter(f => ALLOWED.test(f));
    const detailed = await Promise.all(
      filtered.map(async file => {
        const s = await fsp.stat(path.join(IMAGES_DIR, file));
        return { file, mtime: s.mtime };
      })
    );
    detailed.sort((a, b) => b.mtime - a.mtime);
    res.json(detailed.map(i => i.file));
  } catch (err) {
    console.error("/images/list error", err);
    res.status(500).json({ error: "Could not read images" });
  }
});

/* GET /images/history  -- recursive details (admin) */
app.get("/images/history", requireAdmin, async (req, res) => {
  try {
    const arr = await walkImages(IMAGES_DIR);
    arr.sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
    res.json(arr.slice(0, 1000));
  } catch (err) {
    console.error("/images/history error", err);
    res.status(500).json({ error: "Failed" });
  }
});

/* GET /admin/disk-info (admin) */
app.get("/admin/disk-info", requireAdmin, async (req, res) => {
  try {
    const files = await walkImages(IMAGES_DIR);
    const usedBytes = files.reduce((s, f) => s + (f.size || 0), 0);
    const totalBytes = Number(DISK_SIZE_GB) * 1024 * 1024 * 1024;
    const usedPct = totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : 0;
    res.json({
      totalBytes,
      usedBytes,
      usedPct,
      fileCount: files.length,
      totalGB: DISK_SIZE_GB,
      usedMB: usedBytes / (1024 * 1024)
    });
  } catch (err) {
    console.error("/admin/disk-info error", err);
    res.status(500).json({ error: "Failed" });
  }
});

/* Upload images (admin) */
app.post("/upload", requireAdmin, upload.array("images", 50), async (req, res) => {
  if (!req.files?.length) return res.status(400).json({ error: "No files" });
  const results = [];
  for (const file of req.files) {
    try {
      const tmp = file.path;
      const buffer = await fsp.readFile(tmp);
      const base = path.basename(file.originalname, path.extname(file.originalname))
        .replace(/\s+/g, "-").replace(/[^a-zA-Z0-9-_]/g, "");
      const id = uuidv4().slice(0, 8);
      const finalName = `${base}-${id}.jpg`;
      const finalPath = path.join(IMAGES_DIR, finalName);

      await sharp(buffer)
        .jpeg({ quality: 85 })
        .resize({ width: 1600, withoutEnlargement: true })
        .toFile(finalPath);

      await fsp.unlink(tmp).catch(() => {});
      results.push({ savedAs: finalName });

    } catch (err) {
      console.error("upload processing error", err);
      results.push({ error: err.message });
    }
  }
  res.json({ uploaded: results });
});

/* ------------------ DELETE ROUTES ------------------ */

/**
 * POST /images/delete
 * Accepts either:
 *  - { filename: "..." }        (single)
 *  - { files: ["a.jpg","b.png"] }  (batch)
 *
 * Requires admin.
 */
app.post("/images/delete", requireAdmin, express.json(), async (req, res) => {
  const { filename, files } = req.body || {};
  const toDelete = [];

  if (filename) toDelete.push(filename);
  if (Array.isArray(files)) toDelete.push(...files);

  if (toDelete.length === 0) {
    return res.status(400).json({ error: "No filename(s) provided" });
  }

  const results = { deleted: [], errors: [] };

  for (const raw of toDelete) {
    const safe = safeFilename(raw);
    if (!safe) {
      results.errors.push({ file: raw, error: "Invalid filename" });
      continue;
    }
    const full = path.join(IMAGES_DIR, safe);
    try {
      await fsp.unlink(full);
      results.deleted.push(safe);
    } catch (err) {
      results.errors.push({ file: safe, error: err.code || err.message });
    }
  }

  res.json(results);
});

/**
 * DELETE /images/delete/:filename
 * Single-file delete via URL (admin)
 */
app.delete("/images/delete/:filename", requireAdmin, async (req, res) => {
  const raw = req.params.filename;
  const safe = safeFilename(raw);
  if (!safe) return res.status(400).json({ error: "Invalid filename" });
  const full = path.join(IMAGES_DIR, safe);
  try {
    await fsp.unlink(full);
    res.json({ success: true, deleted: safe });
  } catch (err) {
    res.status(404).json({ error: "Not found", details: err.message });
  }
});

/* ------------------ PRODUCTS (unchanged) ------------------ */

async function readProducts() {
  try { return JSON.parse(await fsp.readFile(PRODUCTS_JSON, "utf8")); } catch { return []; }
}
async function writeProducts(v) { await fsp.writeFile(PRODUCTS_JSON, JSON.stringify(v, null, 2)); }

app.get("/products/list", async (req, res) => {
  const list = await readProducts();
  list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(list);
});

app.post("/products/add", requireAdmin, uploadProducts.single("image"), async (req, res) => {
  try {
    const { name, description, price } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: "Name required" });

    let imageUrl = "/images/products/default-sample.png";
    if (req.file) {
      const tmp = req.file.path;
      const buffer = await fsp.readFile(tmp);
      const safe = path.basename(req.file.originalname, path.extname(req.file.originalname))
        .replace(/\s+/g, "-").replace(/[^a-zA-Z0-9-_]/g, "");
      const id = uuidv4();
      const finalName = `${safe}-${id}.jpg`;
      const finalPath = path.join(PRODUCTS_IMG_DIR, finalName);
      await sharp(buffer)
        .jpeg({ quality: 85 })
        .resize({ width: 1600, withoutEnlargement: true })
        .toFile(finalPath);
      await fsp.unlink(tmp).catch(()=>{});
      imageUrl = "/images/products/" + finalName;
    }

    const list = await readProducts();
    const newProd = { id: uuidv4(), name: name.trim(), description: (description||"").trim(), price: price || "", image: imageUrl, createdAt: new Date().toISOString() };
    list.push(newProd);
    await writeProducts(list);

    res.json({ success: true, product: newProd });
  } catch (err) {
    console.error("products/add error", err);
    res.status(500).json({ error: "Failed" });
  }
});

app.post("/products/delete", requireAdmin, express.json(), async (req, res) => {
  try {
    const { id } = req.body;
    let products = await readProducts();
    const idx = products.findIndex(p => p.id === id);
    if (idx === -1) return res.status(404).json({ error: "product not found" });
    const [removed] = products.splice(idx, 1);
    await writeProducts(products);
    if (removed && removed.image && removed.image.startsWith("/images/products/")) {
      const filename = removed.image.replace("/images/products/", "");
      fsp.unlink(path.join(PRODUCTS_IMG_DIR, filename)).catch(()=>{});
    }
    res.json({ success: true });
  } catch (err) {
    console.error("products/delete error", err);
    res.status(500).json({ error: "delete failed" });
  }
});

/* -------------------- Start server -------------------- */
app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
