/**
 * server.js (updated)
 * - Includes endpoints:
 *    GET /images/list       -> array of filenames (existing)
 *    GET /images/history    -> [{ file, mtime, size }]
 *    GET /admin/disk-info   -> { totalBytes, usedBytes, usedPct, fileCount }
 *
 * Disk size (GB) set from admin input (user gave 5)
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

/* ----------------- CONFIG ----------------- */
// disk size in GB (user provided)
const DISK_SIZE_GB = 5;

const PUBLIC_DIR = path.join(__dirname, "public");
const IMAGES_DIR = path.join(PUBLIC_DIR, "images");
const TMP_DIR = path.join(__dirname, "tmp_uploads");
const PRODUCTS_IMG_DIR = path.join(IMAGES_DIR, "products");
const DATA_DIR = path.join(PUBLIC_DIR, "data");
const PRODUCTS_JSON = path.join(DATA_DIR, "products.json");

const ALLOWED = /\.(jpg|jpeg|png|gif|webp|svg|heic|heif)$/i;

/* ----------------- MIDDLEWARE ----------------- */
app.use(cors());
app.use(express.json());
app.use(express.static(PUBLIC_DIR));
app.use("/images", express.static(IMAGES_DIR));

function requireAdmin(req, res, next) {
  const cookie = req.headers.cookie || "";
  if (cookie.includes("admin=4321")) return next();
  return res.status(403).json({ error: "Admin authentication required" });
}

/* ----------------- INIT FOLDERS ----------------- */
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
ensureFolders();

/* ----------------- MULTER ----------------- */
const upload = multer({
  storage: multer.diskStorage({
    destination: TMP_DIR,
    filename: (req, f, cb) => cb(null, Date.now() + "-" + f.originalname)
  })
});
const uploadProducts = multer({
  storage: multer.diskStorage({
    destination: TMP_DIR,
    filename: (req, f, cb) => cb(null, Date.now() + "-" + f.originalname)
  })
});

/* ----------------- HELPERS ----------------- */

// Recursively walk directory and sum sizes; return array of {file, size, mtime}
async function walkImages(dir) {
  const results = [];
  async function walk(d) {
    const items = await fsp.readdir(d, { withFileTypes: true });
    for (const it of items) {
      const full = path.join(d, it.name);
      if (it.isDirectory()) {
        await walk(full);
      } else {
        if (ALLOWED.test(it.name.toLowerCase())) {
          const s = await fsp.stat(full);
          // relative filename to IMAGES_DIR root
          const rel = path.relative(IMAGES_DIR, full).replace(/\\/g, "/");
          results.push({ file: rel, size: s.size, mtime: s.mtime.toISOString() });
        }
      }
    }
  }
  try {
    await walk(dir);
  } catch (e) {
    // if directory doesn't exist, return empty
  }
  return results;
}

/* ----------------- ROUTES ----------------- */

/**
 * GET /images/list
 * Returns filenames (newest first) — kept for backward compatibility
 */
app.get("/images/list", async (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    const files = await fsp.readdir(IMAGES_DIR);
    const filtered = files.filter(f => ALLOWED.test(f));
    // only top-level; sort by mtime
    const detailed = await Promise.all(
      filtered.map(async file => {
        const s = await fsp.stat(path.join(IMAGES_DIR, file));
        return { file, mtime: s.mtime };
      })
    );
    detailed.sort((a, b) => b.mtime - a.mtime);
    res.json(detailed.map(i => i.file));
  } catch (err) {
    res.status(500).json({ error: "Cannot read images" });
  }
});

/**
 * GET /images/history
 * Returns a detailed list of images (recursive) with sizes & timestamps — newest first
 */
app.get("/images/history", requireAdmin, async (req, res) => {
  try {
    const arr = await walkImages(IMAGES_DIR);
    arr.sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
    res.json(arr.slice(0, 500)); // limit to 500 entries
  } catch (err) {
    console.error("history error", err);
    res.status(500).json({ error: "Failed" });
  }
});

/**
 * GET /admin/disk-info
 * Returns disk usage info (based on sum of files in public/images and configured disk size)
 */
app.get("/admin/disk-info", requireAdmin, async (req, res) => {
  try {
    const files = await walkImages(IMAGES_DIR);
    const usedBytes = files.reduce((s, f) => s + (f.size || 0), 0);
    const totalBytes = Number(DISK_SIZE_GB) * 1024 * 1024 * 1024; // GB -> bytes
    const usedPct = totalBytes > 0 ? Math.round((usedBytes / totalBytes) * 100) : 0;
    res.json({
      totalBytes,
      usedBytes,
      usedPct,
      fileCount: files.length
    });
  } catch (err) {
    console.error('disk-info error', err);
    res.status(500).json({ error: 'Failed' });
  }
});

/* ----------------- UPLOAD / DELETE / PRODUCTS (existing handlers) ----------------- */

/* Upload images (Sharp handles everything on server) */
app.post("/upload", requireAdmin, upload.array("images", 20), async (req, res) => {
  if (!req.files?.length) return res.status(400).json({ error: "No files" });
  const results = [];
  for (const file of req.files) {
    try {
      const tmp = file.path;
      const buffer = await fsp.readFile(tmp);
      const safe = path.basename(file.originalname, path.extname(file.originalname))
        .replace(/\s+/g, "-").replace(/[^a-zA-Z0-9-_]/g, "");
      const id = uuidv4().slice(0, 8);
      const finalName = `${safe}-${id}.jpg`;
      const finalPath = path.join(IMAGES_DIR, finalName);
      await sharp(buffer).jpeg({ quality: 85 }).resize({ width: 1600, withoutEnlargement: true }).toFile(finalPath);
      await fsp.unlink(tmp);
      results.push({ savedAs: finalName });
    } catch (err) {
      console.error('upload error', err);
      results.push({ error: err.message });
    }
  }
  res.json({ uploaded: results });
});

/* Delete image (gallery only) */
app.post("/images/delete", requireAdmin, async (req, res) => {
  const { filename } = req.body;
  if (!filename || filename.includes("/") || filename.includes("..")) return res.status(400).json({ error: "Invalid filename" });
  try {
    await fsp.unlink(path.join(IMAGES_DIR, filename));
    res.json({ success: true });
  } catch {
    res.status(404).json({ error: "File not found" });
  }
});

/* Products helpers (same as before) */
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
      const tmp = req.file.path; const buffer = await fsp.readFile(tmp);
      const safe = path.basename(req.file.originalname, path.extname(req.file.originalname)).replace(/\s+/g, "-").replace(/[^a-zA-Z0-9-_]/g, "");
      const id = uuidv4(); const finalName = `${safe}-${id}.jpg`; const finalPath = path.join(PRODUCTS_IMG_DIR, finalName);
      await sharp(buffer).jpeg({ quality: 85 }).resize({ width: 1600, withoutEnlargement: true }).toFile(finalPath);
      await fsp.unlink(tmp); imageUrl = "/images/products/" + finalName;
    }
    const list = await readProducts();
    const newProd = { id: uuidv4(), name: name.trim(), description: (description||"").trim(), price: price || "", image: imageUrl, createdAt: new Date().toISOString() };
    list.push(newProd); await writeProducts(list);
    res.json({ success: true, product: newProd });
  } catch (err) {
    console.error('add product error', err); res.status(500).json({ error: 'Failed' });
  }
});

app.post("/products/delete", requireAdmin, async (req, res) => {
  const { id } = req.body;
  let list = await readProducts(); const idx = list.findIndex(p => p.id === id);
  if (idx === -1) return res.status(404).json({ error: 'Not found' });
  const removed = list.splice(idx, 1)[0]; await writeProducts(list);
  if (removed.image?.startsWith("/images/products/")) fsp.unlink(path.join(PRODUCTS_IMG_DIR, removed.image.replace("/images/products/", ""))).catch(()=>{});
  res.json({ success: true });
});

/* ----------------- START ----------------- */
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
