
// server.js
import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import path from 'path';
import { fileURLToPath } from 'url';
import crypto from 'crypto';
import fs from 'fs/promises';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 5000;

// Path to constant.tsx for metadata storage
const CONSTANT_FILE_PATH = path.resolve(process.cwd(), 'constant.tsx');

// --- Configuration ---
const FRONTEND_DOMAINS = [
  "https://nexverra.in", "https://localhost:10000",
  "http://localhost:5173",
  "https://nexverra-website-1-t740.onrender.com"
];

// --- Middleware ---
app.use(cors({
  origin: FRONTEND_DOMAINS,
  credentials: true
}));
app.use(express.json({ limit: '100mb' })); // High limit for large base64 images and ZIPs

// --- MongoDB Connection ---
const MONGO_URI = process.env.MONGO_URI || 'mongodb+srv://nexverra_db_user:8HnzQCgFqlPuzq50@cluster.jesf1md.mongodb.net/?retryWrites=true&w=majority&appName=Cluster';
const JWT_SECRET = process.env.JWT_SECRET || 'your-default-jwt-secret';

// --- Mongoose Schemas ---

// ProductFile only stores the heavy binary data
const productFileSchema = new mongoose.Schema({
  productId: { type: String, required: true, unique: true },
  fileName: String,
  fileData: String, // Base64 encoded ZIP
});
const ProductFile = mongoose.model('ProductFile', productFileSchema);

const offerSchema = new mongoose.Schema({
  name: { type: String, unique: true, default: 'main-offer' },
  isActive: { type: Boolean, default: false },
  endTime: { type: Date, default: null },
});
const Offer = mongoose.model('Offer', offerSchema);

const userSchema = new mongoose.Schema({
    email: { type: String, required: true, unique: true, lowercase: true },
    username: { type: String, required: true, unique: true, lowercase: true },
    password: { type: String, required: true },
    fullName: { type: String },
    contact: { type: String },
    role: { type: String, enum: ['customer', 'admin'], default: 'customer' },
    wishlist: [{ type: String }], // Store as IDs (strings) since metadata is in JSON
    hasTemporaryPassword: { type: Boolean, default: false },
    isActive: { type: Boolean, default: true },
}, { timestamps: true });
const User = mongoose.model('User', userSchema);

const timelineEventSchema = new mongoose.Schema({
    status: { type: String, required: true },
    description: { type: String, required: true },
    date: { type: Date, default: Date.now }
});

const orderSchema = new mongoose.Schema({
    orderId: { type: String, required: true, unique: true },
    user: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    planTitle: { type: String, required: true },
    planPrice: { type: Number, required: true },
    details: { type: String, required: true },
    status: { 
        type: String, 
        enum: ['Failed', 'Pending', 'Pending Payment', 'Processing', 'Delivered', 'Refund Accepted', 'Refunded', 'Cancelled'], 
        default: 'Pending' 
    },
    // We can store a custom ZIP for an order or link to product ZIP
    downloadableFile: {
        fileName: String,
        fileData: String,
    },
    isProductOrder: { type: Boolean, default: false },
    productIds: [{ type: String }], // Store IDs as strings referring to constant.tsx
    timeline: [timelineEventSchema],
    databaseLink: { type: String, default: null },
}, { timestamps: true });
const Order = mongoose.model('Order', orderSchema);

const chatMessageSchema = new mongoose.Schema({
    sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    receiver: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
    text: { type: String, required: true },
    isRead: { type: Boolean, default: false },
}, { timestamps: true });
const ChatMessage = mongoose.model('ChatMessage', chatMessageSchema);

// --- File Sync Helpers for constant.tsx ---

async function readProductsFromConstant() {
  try {
    const data = await fs.readFile(CONSTANT_FILE_PATH, 'utf-8');
    const startMarker = 'export const products = ';
    const startIndex = data.indexOf(startMarker);
    if (startIndex === -1) return [];
    
    let jsonStr = data.substring(startIndex + startMarker.length).trim();
    if (jsonStr.endsWith(';')) jsonStr = jsonStr.slice(0, -1);
    
    // Attempt to parse. Replace common manual entry errors like trailing commas
    const cleanedJson = jsonStr.replace(/,\s*\]/g, ']').replace(/,\s*\}/g, '}');
    return JSON.parse(cleanedJson);
  } catch (err) {
    console.error("Error reading constant.tsx:", err.message);
    return [];
  }
}

async function writeProductsToConstant(products) {
  try {
    // Pretty-print JSON for human readability in the TSX file
    const content = `export const products = ${JSON.stringify(products, null, 2)};`;
    await fs.writeFile(CONSTANT_FILE_PATH, content, 'utf-8');
    console.log(`✅ [SYNC] constant.tsx updated with ${products.length} products.`);
  } catch (err) {
    console.error("Error writing to constant.tsx:", err.message);
    throw err;
  }
}

// --- Data Transformation ---

const transformUser = (userDoc) => {
    const userObj = userDoc.toObject();
    userObj.id = userObj._id.toString();
    delete userObj._id;
    delete userObj.__v;
    delete userObj.password;
    return userObj;
};

const transformOrder = (orderDoc) => {
    const orderObj = orderDoc.toObject();
    orderObj.id = orderObj._id.toString();
    if (orderObj.user && typeof orderObj.user === 'object' && !Array.isArray(orderObj.user)) {
      delete orderObj.user._id;
      delete orderObj.user.__v;
      delete orderObj.user.password;
    }
    if (orderObj.downloadableFile) {
        orderObj.downloadableFileName = orderObj.downloadableFile.fileName;
        delete orderObj.downloadableFile.fileData; // Don't send heavy data in list
    }
    delete orderObj._id;
    delete orderObj.__v;
    return orderObj;
};

// --- Authentication Middleware ---
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (token == null) return res.sendStatus(401);

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.sendStatus(403);
        req.user = user;
        next();
    });
};

const authenticateAdmin = (req, res, next) => {
    if (req.user.role !== 'admin') {
        return res.status(403).json({ message: 'Forbidden: Admin access required.' });
    }
    next();
};

const addUserToRequest = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];
    if (token == null) return next();

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (!err) {
            req.user = user;
        }
        next();
    });
};

// --- Routes ---

// Products (Read from constant.tsx)
app.get('/api/products', addUserToRequest, async (req, res) => {
  try {
    const products = await readProductsFromConstant();
    let productDocs = products;
    
    if (req.user) {
        const user = await User.findById(req.user.id).select('wishlist');
        const wishlistSet = new Set(user?.wishlist || []);
        productDocs = productDocs.map(p => ({
            ...p,
            wishlisted: wishlistSet.has(p.id)
        }));
    } else {
        productDocs = productDocs.map(p => ({ ...p, wishlisted: false }));
    }
    res.json(productDocs);
  } catch (error) {
    res.status(500).json({ message: 'Error fetching products', error: error.message });
  }
});

// Add Product (Metadata to constant.tsx, ZIP to Mongo)
app.post('/api/products', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { title, description, features, images, price, category, type, downloadableFile } = req.body;
    if (!title || !description || !images || !price || !category) {
      return res.status(400).json({ message: 'Missing required product fields' });
    }

    const products = await readProductsFromConstant();
    const productId = crypto.randomUUID();

    // 1. Store ZIP in MongoDB if present
    if (downloadableFile && downloadableFile.fileData) {
      await ProductFile.create({
        productId,
        fileName: downloadableFile.fileName,
        fileData: downloadableFile.fileData
      });
    }

    // 2. Prepare metadata for constant.tsx
    const newProduct = {
      id: productId,
      title,
      description,
      features: Array.isArray(features) ? features : [],
      images: Array.isArray(images) ? images : [],
      price: parseFloat(price),
      category,
      type: type || 'dashboard',
      downloadableFileName: downloadableFile?.fileName || null
    };

    products.unshift(newProduct);
    await writeProductsToConstant(products);

    res.status(201).json(newProduct);
  } catch (error) {
    console.error("Add Product Error:", error);
    res.status(500).json({ message: 'Error adding product', error: error.message });
  }
});

// Update Product
app.put('/api/products/:id', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { downloadableFile, ...metadata } = req.body;
    
    let products = await readProductsFromConstant();
    const index = products.findIndex(p => p.id === id);
    if (index === -1) return res.status(404).json({ message: 'Product not found' });

    // 1. Update ZIP in MongoDB if new data provided
    if (downloadableFile && downloadableFile.fileData) {
      await ProductFile.findOneAndUpdate(
        { productId: id },
        { fileName: downloadableFile.fileName, fileData: downloadableFile.fileData },
        { upsert: true }
      );
      metadata.downloadableFileName = downloadableFile.fileName;
    } else if (downloadableFile === null) {
      // If null explicitly sent, remove file
      await ProductFile.deleteOne({ productId: id });
      metadata.downloadableFileName = null;
    }

    // 2. Update constant.tsx
    const updatedProduct = {
      ...products[index],
      ...metadata,
      id // Ensure ID never changes
    };
    
    products[index] = updatedProduct;
    await writeProductsToConstant(products);

    res.json(updatedProduct);
  } catch (error) {
    res.status(500).json({ message: 'Error updating product', error: error.message });
  }
});

// Delete Product
app.delete('/api/products/:id', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    
    // 1. Remove ZIP from Mongo
    await ProductFile.deleteOne({ productId: id });

    // 2. Remove from constant.tsx
    let products = await readProductsFromConstant();
    const filtered = products.filter(p => p.id !== id);
    await writeProductsToConstant(filtered);

    res.status(204).send();
  } catch (error) {
    res.status(500).json({ message: 'Error deleting product', error: error.message });
  }
});

// Bulk Delete
app.delete('/api/products', authenticateToken, authenticateAdmin, async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || !Array.isArray(ids)) return res.status(400).json({ message: 'IDs required' });
    
    await ProductFile.deleteMany({ productId: { $in: ids } });
    
    let products = await readProductsFromConstant();
    const filtered = products.filter(p => !ids.includes(p.id));
    await writeProductsToConstant(filtered);

    res.status(204).send();
  } catch (error) {
    res.status(500).json({ message: 'Error bulk deleting products', error: error.message });
  }
});

// Downloads (From MongoDB)
app.get('/api/orders/:id/download', authenticateToken, async (req, res) => {
    try {
        const order = await Order.findById(req.params.id);
        if (!order) return res.status(404).json({ message: 'Order not found' });
        
        // Auth check
        if (order.user.toString() !== req.user.id && req.user.role !== 'admin') {
            return res.sendStatus(403);
        }

        let fileName, fileData;

        // If order has a custom file attached
        if (order.downloadableFile?.fileData) {
          fileName = order.downloadableFile.fileName;
          fileData = order.downloadableFile.fileData;
        } else {
          // Otherwise look up product ZIPs from MongoDB
          const productsInOrder = order.isProductOrder ? order.productIds : [];
          if (productsInOrder.length > 0) {
            const firstProductFile = await ProductFile.findOne({ productId: productsInOrder[0] });
            if (firstProductFile) {
              fileName = firstProductFile.fileName;
              fileData = firstProductFile.fileData;
            }
          }
        }

        if (!fileData) return res.status(404).json({ message: 'No deliverable file found.' });

        const buffer = Buffer.from(fileData, 'base64');
        res.setHeader('Content-Type', 'application/zip');
        res.setHeader('Content-Disposition', `attachment; filename="${fileName || 'download.zip'}"`);
        res.send(buffer);
    } catch (err) {
        res.status(500).json({ message: 'Download failure', error: err.message });
    }
});

// --- Auth Routes ---

app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const user = await User.findOne({ email: email.toLowerCase() });
        if (!user || !(await bcrypt.compare(password, user.password))) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }
        
        const payload = { id: user._id.toString(), role: user.role, email: user.email };
        const token = jwt.sign(payload, JWT_SECRET, { expiresIn: '24h' });
        
        const userPayload = transformUser(user);
        res.json({ token, user: userPayload });
    } catch (err) {
        res.status(500).json({ message: 'Login error' });
    }
});

app.get('/api/auth/me', authenticateToken, async (req, res) => {
    try {
        const user = await User.findById(req.user.id);
        if (!user) return res.status(404).json({ message: 'Not found' });
        res.json(transformUser(user));
    } catch (err) {
        res.sendStatus(500);
    }
});

// --- Other Features (Offers, Orders, Chats) ---
// Note: These follow the patterns established in your previous server.js 
// but use the productIds (strings) for order tracking.

app.get('/api/offer', async (req, res) => {
  const offer = await Offer.findOne({ name: 'main-offer' }) || await Offer.create({ name: 'main-offer' });
  res.json({ isOfferActive: offer.isActive, offerEndTime: offer.endTime ? offer.endTime.getTime() : null });
});

app.post('/api/offer/toggle', authenticateToken, authenticateAdmin, async (req, res) => {
  const offer = await Offer.findOne({ name: 'main-offer' });
  offer.isActive = !offer.isActive;
  offer.endTime = offer.isActive ? new Date(Date.now() + 12 * 60 * 60 * 1000) : null;
  await offer.save();
  res.json({ isOfferActive: offer.isActive, offerEndTime: offer.endTime ? offer.endTime.getTime() : null });
});

// (Simplified Order logic for the hybrid storage)
app.post('/api/orders', async (req, res) => {
  // Logic to handle user creation if not logged in and order saving
  // similar to your existing code but linking productIds as strings
  res.status(501).json({ message: "Order placement integration in progress" });
});

app.get('/api/orders/my', authenticateToken, async (req, res) => {
  const orders = await Order.find({ user: req.user.id }).sort({ createdAt: -1 });
  res.json(orders.map(transformOrder));
});

// --- Admin Features ---
app.get('/api/admin/orders', authenticateToken, authenticateAdmin, async (req, res) => {
  const orders = await Order.find().populate('user', 'fullName email').sort({ createdAt: -1 });
  res.json(orders.map(transformOrder));
});

// SPA Serving
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Startup
mongoose.connect(MONGO_URI).then(async () => {
  console.log('🍃 MongoDB Connected');
  
  // Seed admin if none exists
  const adminCount = await User.countDocuments({ role: 'admin' });
  if (adminCount === 0) {
    const hashed = await bcrypt.hash('password', 12);
    await User.create({
      email: 'admin-demo@nexverra.com',
      username: 'admin-demo',
      password: hashed,
      fullName: 'Demo Admin',
      role: 'admin'
    });
    console.log('✅ Admin seeded: admin-demo@nexverra.com / password');
  }

  app.listen(PORT, () => {
    console.log(`🚀 Hybrid API running at http://localhost:${PORT}`);
    console.log(`📂 Metadata: constant.tsx | 📁 Binaries: MongoDB`);
  });
});
