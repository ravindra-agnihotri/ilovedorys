/**
 * server.js (updated)
 * - Serves public files
 * - Serves images from public/images
 * - /images/list, /images/history
 * - Uploads (POST /upload) with sharp (HEIC conversion optional)
 * - Products API: GET /products/list, POST /products/add, POST /products/delete
 *   -> now supports fields: name, description, price, category, rating, image
 * - Delete routes for images: POST /images/delete and DELETE /images/delete/:filename
 *
 * Note: This file expects the folders to exist or will create them:
 *   - public/
 *   - public/images/
 *   - public/images/products/
 *   - public/data/products.json
 *
 * Restart server after replacing file.
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

/* -------------------- PATHS -------------------- */
const PUBLIC_DIR = path.join(__dirname, "public");
const IMAGES_DIR = path.join(PUBLIC_DIR, "images");
const PRODUCTS_IMG_DIR = path.join(IMAGES_DIR, "products");
const DATA_DIR = path.join(PUBLIC_DIR, "data");
const PRODUCTS_JSON = path.join(DATA_DIR, "products.json");
const TMP_DIR = path.join(__dirname, "tmp_uploads");

/* -------------------- SETTINGS -------------------- */
const ALLOWED = /\.(jpg|jpeg|png|gif|webp|svg|heic|heif)$/i;
const DISK_SIZE_GB = 5;

/* -------------------- MIDDLEWARE -------------------- */
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(PUBLIC_DIR));
app.use("/images", express.static(IMAGES_DIR));

/* -------------------- ADMIN GUARD -------------------- */
function requireAdmin(req, res, next) {
  const cookie = req.headers.cookie || "";
  if (cookie.includes("admin=4321")) return next();
  if (req.headers["x-admin-pin"] === "4321") return next();
  return res.status(403).json({ error: "Admin authentication required" });
}

/* -------------------- ENSURE FOLDERS -------------------- */
async function ensureFolders() {
  await fsp.mkdir(IMAGES_DIR, { recursive: true });
  await fsp.mkdir(PRODUCTS_IMG_DIR, { recursive: true });
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await fsp.mkdir(TMP_DIR, { recursive: true });
  try {
    await fsp.access(PRODUCTS_JSON);
  } catch {
    await fsp.writeFile(PRODUCTS_JSON, JSON.stringify([], null, 2), "utf8");
  }
}
ensureFolders().catch(console.error);

/* -------------------- MULTER -------------------- */
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, TMP_DIR),
  filename: (req, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});
const upload = multer({ storage });

/* -------------------- HELPERS -------------------- */
function safeFilename(name) {
  if (!name) return null;
  const bn = path.basename(name);
  if (bn.includes("..") || bn.includes("/") || bn.includes("\\")) return null;
  return bn;
}

async function walkImages(dir) {
  const results = [];
  async function walk(d) {
    let items;
    try {
      items = await fsp.readdir(d, { withFileTypes: true });
    } catch {
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

/* -------------------- ROUTES -------------------- */

/* GET /images/list - top-level image filenames (newest first) */
app.get("/images/list", async (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    const files = await fsp.readdir(IMAGES_DIR);
    const filtered = files.filter(f => ALLOWED.test(f));
    const detailed = await Promise.all(filtered.map(async (file) => {
      const s = await fsp.stat(path.join(IMAGES_DIR, file));
      return { file, mtime: s.mtime };
    }));
    detailed.sort((a, b) => b.mtime - a.mtime);
    res.json(detailed.map(i => i.file));
  } catch (err) {
    console.error("/images/list error", err);
    res.status(500).json({ error: "Could not read images" });
  }
});

/* GET /images/history - recursive list (admin) */
app.get("/images/history", requireAdmin, async (req, res) => {
  try {
    const arr = await walkImages(IMAGES_DIR);
    arr.sort((a, b) => new Date(b.mtime) - new Date(a.mtime));
    res.json(arr);
  } catch (err) {
    console.error("/images/history error", err);
    res.status(500).json({ error: "Failed" });
  }
});

/* GET /admin/disk-info - admin */
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

/* POST /upload - admin-only upload images (compress with sharp) */
app.post("/upload", requireAdmin, upload.array("images", 50), async (req, res) => {
  if (!req.files?.length) return res.status(400).json({ error: "No files" });
  const results = [];
  for (const file of req.files) {
    try {
      const tmp = file.path;
      const buffer = await fsp.readFile(tmp);
      const base = path.basename(file.originalname, path.extname(file.originalname)).replace(/\s+/g, "-").replace(/[^a-zA-Z0-9-_]/g, "");
      const id = uuidv4().slice(0, 8);
      const finalName = `${base}-${id}.jpg`; // save as jpg for consistency
      const finalPath = path.join(IMAGES_DIR, finalName);

      await sharp(buffer)
        .resize({ width: 1600, withoutEnlargement: true })
        .jpeg({ quality: 85 })
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

/* ------------------ IMAGE DELETE ROUTES ------------------ */

/* POST /images/delete -> accepts { filename } or { files: [] } (admin) */
app.post("/images/delete", requireAdmin, express.json(), async (req, res) => {
  const { filename, files } = req.body || {};
  const toDelete = [];
  if (filename) toDelete.push(filename);
  if (Array.isArray(files)) toDelete.push(...files);
  if (!toDelete.length) return res.status(400).json({ error: "No filename(s) provided" });

  const results = { deleted: [], errors: [] };
  for (const raw of toDelete) {
    const safe = safeFilename(raw);
    if (!safe) { results.errors.push({ file: raw, error: "Invalid filename" }); continue; }
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

/* DELETE /images/delete/:filename -> single delete (admin) */
app.delete("/images/delete/:filename", requireAdmin, async (req, res) => {
  const raw = req.params.filename;
  const safe = safeFilename(raw);
  if (!safe) return res.status(400).json({ error: "Invalid filename" });
  try {
    await fsp.unlink(path.join(IMAGES_DIR, safe));
    res.json({ success: true, deleted: safe });
  } catch (err) {
    res.status(404).json({ error: "Not found", details: err.message });
  }
});

/* ------------------ PRODUCTS API ------------------ */

/* helper read/write */
async function readProducts() {
  try { const raw = await fsp.readFile(PRODUCTS_JSON, "utf8"); return JSON.parse(raw || "[]"); } catch { return []; }
}
async function writeProducts(v) { await fsp.writeFile(PRODUCTS_JSON, JSON.stringify(v, null, 2), "utf8"); }

/* GET /products/list -> returns products, newest first */
app.get("/products/list", async (req, res) => {
  try {
    const list = await readProducts();
    list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json(list);
  } catch (err) {
    console.error("/products/list error", err);
    res.status(500).json({ error: "Failed" });
  }
});

/**
 * POST /products/add
 * Accepts multipart/form-data:
 *  - name, description, price, category, rating
 *  - image (file, optional)
 */
const prodUpload = multer({ storage }).single("image");

app.post("/products/add", requireAdmin, (req, res) => {
  prodUpload(req, res, async function (err) {
    if (err) {
      console.error("prod upload error", err);
      return res.status(500).json({ error: "Upload failed" });
    }
    try {
      const { name = "", description = "", price = "", category = "", rating = "" } = req.body;
      if (!name.trim()) return res.status(400).json({ error: "Product name required" });

      // prepare product object
      const id = uuidv4();
      let imageUrl = "/images/products/default-sample.png"; // fallback

      // if an image file uploaded with field 'image', process it
      if (req.file) {
        const tmpPath = req.file.path;
        const buffer = await fsp.readFile(tmpPath);
        const baseName = path.basename(req.file.originalname, path.extname(req.file.originalname)).replace(/\s+/g, "-").replace(/[^a-zA-Z0-9-_]/g, "");
        const outName = `${baseName}-${id}.jpg`;
        const outPath = path.join(PRODUCTS_IMG_DIR, outName);

        await sharp(buffer)
          .resize({ width: 1600, withoutEnlargement: true })
          .jpeg({ quality: 85 })
          .toFile(outPath);

        await fsp.unlink(tmpPath).catch(() => {});
        imageUrl = `/images/products/${outName}`;
      }

      // read existing products, push new
      const products = await readProducts();
      const newProduct = {
        id,
        name: String(name).trim(),
        description: String(description || "").trim(),
        price: String(price || "").trim(),
        category: String(category || "").trim() || "Uncategorized",
        rating: rating ? Number(rating) : 0,
        image: imageUrl,
        createdAt: new Date().toISOString()
      };
      products.push(newProduct);
      await writeProducts(products);
      res.json({ success: true, product: newProduct });
    } catch (err) {
      console.error("/products/add error", err);
      res.status(500).json({ error: "Could not save product" });
    }
  });
});

/* POST /products/delete -> requires { id } (admin) */
app.post("/products/delete", requireAdmin, express.json(), async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: "id required" });
    let products = await readProducts();
    const idx = products.findIndex(p => p.id === id);
    if (idx === -1) return res.status(404).json({ error: "product not found" });
    const [removed] = products.splice(idx, 1);
    await writeProducts(products);
    // delete product image if located in products folder
    if (removed && removed.image && removed.image.startsWith("/images/products/")) {
      const filename = removed.image.replace("/images/products/", "");
      fsp.unlink(path.join(PRODUCTS_IMG_DIR, filename)).catch(() => {});
    }
    res.json({ success: true });
  } catch (err) {
    console.error("/products/delete error", err);
    res.status(500).json({ error: "delete failed" });
  }
});

/* -------------------- INFO -------------------- */
app.get("/_info", (req, res) => res.send("Dory Bakehouse server running"));

/* -------------------- START -------------------- */
app.listen(PORT, () => console.log(`Server running at http://localhost:${PORT}`));
