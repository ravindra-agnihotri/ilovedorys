/**
 * FINAL SERVER.JS (Updated & Stable)
 * -----------------------------------
 * Features:
 *  ✓ Serves /public
 *  ✓ Upload images → /public/images
 *  ✓ Deletes gallery images (admin only)
 *  ✓ HEIC → JPG support
 *  ✓ Sharp compression
 *  ✓ Product management
 *  ✓ Admin PIN middleware
 */

const express = require("express");
const fs = require("fs");
const fsp = fs.promises;
const path = require("path");
const multer = require("multer");
const sharp = require("sharp");
const heicConvert = require("heic-convert");
const { v4: uuidv4 } = require("uuid");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

/* -------------------------------------------
   DIRECTORIES
------------------------------------------- */
const PUBLIC_DIR = path.join(__dirname, "public");
const IMAGES_DIR = path.join(PUBLIC_DIR, "images");
const TMP_DIR = path.join(__dirname, "tmp_uploads");

const PRODUCTS_IMG_DIR = path.join(IMAGES_DIR, "products");
const DATA_DIR = path.join(PUBLIC_DIR, "data");
const PRODUCTS_JSON = path.join(DATA_DIR, "products.json");

const ALLOWED = /\.(jpg|jpeg|png|gif|webp|svg|heic|heif)$/i;

/* -------------------------------------------
   MIDDLEWARE
------------------------------------------- */
app.use(cors());
app.use(express.json());
app.use(express.static(PUBLIC_DIR));
app.use("/images", express.static(IMAGES_DIR));

/* -------------------------------------------
   ADMIN PIN MIDDLEWARE
------------------------------------------- */
function requireAdmin(req, res, next) {
    const cookie = req.headers.cookie || "";
    if (cookie.includes("admin=4321")) return next();
    return res.status(403).json({ error: "Admin authentication required" });
}

/* -------------------------------------------
   INIT DIRECTORIES
------------------------------------------- */
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

/* -------------------------------------------
   MULTER UPLOAD (TEMP FILES)
------------------------------------------- */
const upload = multer({
    storage: multer.diskStorage({
        destination: TMP_DIR,
        filename: (req, file, cb) =>
            cb(null, `${Date.now()}-${file.originalname}`)
    })
});

const uploadProductImg = multer({
    storage: multer.diskStorage({
        destination: TMP_DIR,
        filename: (req, file, cb) =>
            cb(null, `${Date.now()}-${file.originalname}`)
    })
});

/* -------------------------------------------
   GET LIST OF IMAGES (Newest first)
------------------------------------------- */
app.get("/images/list", async (req, res) => {
    res.set("Cache-Control", "no-store");

    try {
        const files = await fsp.readdir(IMAGES_DIR);

        const filtered = files.filter(f => ALLOWED.test(f));

        const detailed = await Promise.all(
            filtered.map(async file => {
                const stats = await fsp.stat(path.join(IMAGES_DIR, file));
                return { file, mtime: stats.mtime };
            })
        );

        detailed.sort((a, b) => b.mtime - a.mtime);

        res.json(detailed.map(i => i.file));
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Cannot read images" });
    }
});

/* -------------------------------------------
   UPLOAD IMAGES (multi)
------------------------------------------- */
app.post("/upload", requireAdmin, upload.array("images", 20), async (req, res) => {
    if (!req.files?.length)
        return res.status(400).json({ error: "No files received" });

    const results = [];

    for (const file of req.files) {
        try {
            const tmpPath = file.path;
            const buffer = await fsp.readFile(tmpPath);

            const ext = path.extname(file.originalname).toLowerCase().slice(1);
            const safe = path.basename(file.originalname, path.extname(file.originalname))
                .replace(/\s+/g, "-")
                .replace(/[^a-zA-Z0-9-_]/g, "");

            const id = uuidv4().slice(0, 8);
            let finalName = `${safe}-${id}.jpg`;
            let finalPath = path.join(IMAGES_DIR, finalName);

            if (ext === "heic" || ext === "heif") {
                const converted = await heicConvert({
                    buffer,
                    format: "JPEG",
                    quality: 1
                });

                await sharp(converted)
                    .resize({ width: 1600, withoutEnlargement: true })
                    .jpeg({ quality: 85 })
                    .toFile(finalPath);
            } else {
                await sharp(buffer)
                    .resize({ width: 1600, withoutEnlargement: true })
                    .jpeg({ quality: 85 })
                    .toFile(finalPath);
            }

            await fsp.unlink(tmpPath);

            results.push({ savedAs: finalName });
        } catch (err) {
            console.error("UPLOAD FAILED:", err);
            results.push({ error: err.message });
        }
    }

    res.json({ uploaded: results });
});

/* -------------------------------------------
   DELETE IMAGE (Admin only)
------------------------------------------- */
app.post("/images/delete", requireAdmin, async (req, res) => {
    try {
        const { filename } = req.body;

        if (!filename || typeof filename !== "string")
            return res.status(400).json({ error: "filename required" });

        if (filename.includes("/") || filename.includes(".."))
            return res.status(400).json({ error: "Invalid filename" });

        const filePath = path.join(IMAGES_DIR, filename);

        if (!filePath.startsWith(IMAGES_DIR))
            return res.status(400).json({ error: "Invalid path" });

        try {
            await fsp.unlink(filePath);
            return res.json({ success: true, deleted: filename });
        } catch {
            return res.status(404).json({ error: "File not found" });
        }
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Delete failed" });
    }
});

/* -------------------------------------------
   PRODUCT HELPERS
------------------------------------------- */
async function readProducts() {
    try {
        const raw = await fsp.readFile(PRODUCTS_JSON, "utf8");
        return JSON.parse(raw || "[]");
    } catch {
        return [];
    }
}

async function writeProducts(arr) {
    await fsp.writeFile(PRODUCTS_JSON, JSON.stringify(arr, null, 2));
}

/* -------------------------------------------
   GET PRODUCTS
------------------------------------------- */
app.get("/products/list", async (req, res) => {
    const list = await readProducts();
    list.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json(list);
});

/* -------------------------------------------
   ADD PRODUCT
------------------------------------------- */
app.post("/products/add", requireAdmin, uploadProductImg.single("image"), async (req, res) => {
    try {
        const { name, description, price } = req.body;

        if (!name?.trim())
            return res.status(400).json({ error: "Product name required" });

        const id = uuidv4();
        let imageUrl = "/images/products/default-sample.png";

        if (req.file) {
            const tmp = req.file.path;
            const buffer = await fsp.readFile(tmp);

            const safe = path.basename(req.file.originalname, path.extname(req.file.originalname))
                .replace(/\s+/g, "-")
                .replace(/[^a-zA-Z0-9-_]/g, "");

            const out = path.join(PRODUCTS_IMG_DIR, `${safe}-${id}.jpg`);

            await sharp(buffer)
                .resize({ width: 1600, withoutEnlargement: true })
                .jpeg({ quality: 85 })
                .toFile(out);

            await fsp.unlink(tmp);

            imageUrl = "/images/products/" + path.basename(out);
        }

        const list = await readProducts();
        const newProduct = {
            id,
            name: name.trim(),
            description: description?.trim() || "",
            price: price || "",
            image: imageUrl,
            createdAt: new Date().toISOString()
        };

        list.push(newProduct);
        await writeProducts(list);

        res.json({ success: true, product: newProduct });
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Product save failed" });
    }
});

/* -------------------------------------------
   DELETE PRODUCT
------------------------------------------- */
app.post("/products/delete", requireAdmin, async (req, res) => {
    const { id } = req.body;

    let list = await readProducts();
    const idx = list.findIndex(p => p.id === id);

    if (idx === -1)
        return res.status(404).json({ error: "Product not found" });

    const [removed] = list.splice(idx, 1);
    await writeProducts(list);

    // delete image file
    if (removed.image?.startsWith("/images/products/")) {
        const fname = removed.image.replace("/images/products/", "");
        const fpath = path.join(PRODUCTS_IMG_DIR, fname);
        fsp.unlink(fpath).catch(() => {});
    }

    res.json({ success: true });
});

/* -------------------------------------------
   START SERVER
------------------------------------------- */
app.listen(PORT, () =>
    console.log(`🚀 Server running at http://localhost:${PORT}`)
);
