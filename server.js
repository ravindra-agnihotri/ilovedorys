/**
 * FINAL CLEAN SERVER.JS — Render Compatible
 * -----------------------------------------
 * Uses ONLY Sharp for HEIC → JPEG conversion (built-in support)
 * No heic-convert, no native issues
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

/* -----------------------------------------------------
   PATHS
----------------------------------------------------- */
const PUBLIC_DIR = path.join(__dirname, "public");
const IMAGES_DIR = path.join(PUBLIC_DIR, "images");
const TMP_DIR = path.join(__dirname, "tmp_uploads");

const PRODUCTS_IMG_DIR = path.join(IMAGES_DIR, "products");
const DATA_DIR = path.join(PUBLIC_DIR, "data");
const PRODUCTS_JSON = path.join(DATA_DIR, "products.json");

const ALLOWED = /\.(jpg|jpeg|png|gif|webp|svg|heic|heif)$/i;

/* -----------------------------------------------------
   MIDDLEWARE
----------------------------------------------------- */
app.use(cors());
app.use(express.json());
app.use(express.static(PUBLIC_DIR));
app.use("/images", express.static(IMAGES_DIR));

/* -----------------------------------------------------
   ADMIN PIN CHECK
----------------------------------------------------- */
function requireAdmin(req, res, next) {
  const cookie = req.headers.cookie || "";
  if (cookie.includes("admin=4321")) return next();
  return res.status(403).json({ error: "Admin authentication required" });
}

/* -----------------------------------------------------
   ENSURE FOLDERS EXIST
----------------------------------------------------- */
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

/* -----------------------------------------------------
   MULTER (TMP UPLOADS)
----------------------------------------------------- */
const upload = multer({
  storage: multer.diskStorage({
    destination: TMP_DIR,
    filename: (req, f, cb) => cb(null, Date.now() + "-" + f.originalname)
  })
});

const uploadProductImg = multer({
  storage: multer.diskStorage({
    destination: TMP_DIR,
    filename: (req, f, cb) => cb(null, Date.now() + "-" + f.originalname)
  })
});

/* -----------------------------------------------------
   GET IMAGE LIST (NEWEST FIRST)
----------------------------------------------------- */
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

    res.json(detailed.map(x => x.file));
  } catch (err) {
    console.error("list error:", err);
    res.status(500).json({ error: "Could not read images" });
  }
});

/* -----------------------------------------------------
   UPLOAD IMAGES (HEIC supported via Sharp)
----------------------------------------------------- */
app.post("/upload", requireAdmin, upload.array("images", 20), async (req, res) => {
  if (!req.files?.length) return res.status(400).json({ error: "No files" });

  const results = [];

  for (const file of req.files) {
    try {
      const tmp = file.path;
      const buffer = await fsp.readFile(tmp);

      const safe = path.basename(file.originalname, path.extname(file.originalname))
        .replace(/\s+/g, "-")
        .replace(/[^a-zA-Z0-9-_]/g, "");

      const id = uuidv4().slice(0, 8);
      const finalName = `${safe}-${id}.jpg`;
      const finalPath = path.join(IMAGES_DIR, finalName);

      // Sharp can read HEIC directly on Ubuntu (Render)
      await sharp(buffer)
        .jpeg({ quality: 85 })
        .resize({ width: 1600, withoutEnlargement: true })
        .toFile(finalPath);

      await fsp.unlink(tmp);

      results.push({ savedAs: finalName });
    } catch (err) {
      console.error("Upload error:", err);
      results.push({ error: err.message });
    }
  }

  res.json({ uploaded: results });
});

/* -----------------------------------------------------
   DELETE IMAGE
----------------------------------------------------- */
app.post("/images/delete", requireAdmin, async (req, res) => {
  const { filename } = req.body;

  if (!filename || filename.includes("/") || filename.includes(".."))
    return res.status(400).json({ error: "Invalid filename" });

  try {
    await fsp.unlink(path.join(IMAGES_DIR, filename));
    res.json({ success: true });
  } catch {
    res.status(404).json({ error: "File not found" });
  }
});

/* -----------------------------------------------------
   PRODUCTS — READ/WRITE HELPERS
----------------------------------------------------- */
async function readProducts() {
  try {
    return JSON.parse(await fsp.readFile(PRODUCTS_JSON, "utf8"));
  } catch (err) {
    console.error("readProducts error:", err);
    return [];
  }
}

async function writeProducts(list) {
  await fsp.writeFile(PRODUCTS_JSON, JSON.stringify(list, null, 2));
}

/* -----------------------------------------------------
   GET PRODUCT LIST (NEWEST FIRST)
----------------------------------------------------- */
app.get("/products/list", async (req, res) => {
  const list = await readProducts();
  list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  res.json(list);
});

/* -----------------------------------------------------
   ADD PRODUCT (with image)
----------------------------------------------------- */
app.post("/products/add", requireAdmin, uploadProductImg.single("image"), async (req, res) => {
  try {
    const { name, description, price } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: "Name required" });

    let imageUrl = "/images/products/default-sample.png";

    if (req.file) {
      const tmp = req.file.path;
      const buffer = await fsp.readFile(tmp);

      const safe = path.basename(req.file.originalname, path.extname(req.file.originalname))
        .replace(/\s+/g, "-")
        .replace(/[^a-zA-Z0-9-_]/g, "");

      const id = uuidv4();
      const finalName = `${safe}-${id}.jpg`;
      const finalPath = path.join(PRODUCTS_IMG_DIR, finalName);

      await sharp(buffer)
        .jpeg({ quality: 85 })
        .resize({ width: 1600, withoutEnlargement: true })
        .toFile(finalPath);

      await fsp.unlink(tmp);
      imageUrl = "/images/products/" + finalName;
    }

    const list = await readProducts();
    const newProd = {
      id: uuidv4(),
      name: name.trim(),
      description: description?.trim() || "",
      price: price || "",
      image: imageUrl,
      createdAt: new Date().toISOString()
    };

    list.push(newProd);
    await writeProducts(list);

    res.json({ success: true, product: newProd });
  } catch (err) {
    console.error("add product error:", err);
    res.status(500).json({ error: "Failed" });
  }
});

/* -----------------------------------------------------
   DELETE PRODUCT
----------------------------------------------------- */
app.post("/products/delete", requireAdmin, async (req, res) => {
  const { id } = req.body;

  let list = await readProducts();
  const idx = list.findIndex(p => p.id === id);
  if (idx === -1) return res.status(404).json({ error: "Not found" });

  const removed = list.splice(idx, 1)[0];
  await writeProducts(list);

  if (removed.image?.startsWith("/images/products/")) {
    const local = removed.image.replace("/images/products/", "");
    fsp.unlink(path.join(PRODUCTS_IMG_DIR, local)).catch(() => {});
  }

  res.json({ success: true });
});

/* -----------------------------------------------------
   START SERVER
----------------------------------------------------- */
app.listen(PORT, () => {
  console.log(`🚀 Dory Bakehouse Server running on http://localhost:${PORT}`);
});
