// Aplikasi Pemantauan Dokumentasi Pembelajaran - Server
// Import dan konfigurasi awal (menambahkan crypto)
require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const ejs = require('ejs');
const cors = require('cors');
const multer = require('multer');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { PrismaClient } = require('@prisma/client');
const { format, startOfDay, endOfDay, startOfWeek, endOfWeek } = require('date-fns');
const crypto = require('crypto');
const XLSX = require('xlsx');

const prisma = new PrismaClient();
const app = express();

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, '..', 'views'));
// Pastikan template EJS tidak dicache saat development
if (String(process.env.NODE_ENV || '').toLowerCase() !== 'production') {
  app.set('view cache', false);
}
app.use('/assets', express.static(path.join(__dirname, '..', 'public', 'assets')));
app.use('/uploads', express.static(path.join(__dirname, '..', 'uploads')));

const JWT_SECRET = process.env.JWT_SECRET || 'secret-jwt';

// Pengaturan lokasi sekolah (persist di file JSON agar bisa diubah dari UI)
const SETTINGS_PATH = path.join(__dirname, '..', 'data', 'settings.json');
function loadSchoolSettings() {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, 'utf8');
    const obj = JSON.parse(raw);
    const namaSekolah = (typeof obj.namaSekolah === 'string' && obj.namaSekolah.trim().length) ? obj.namaSekolah.trim() : '';
    if (Array.isArray(obj.locations)) {
      const clean = obj.locations
        .map((p, i) => ({
          lat: Number(p.lat),
          lng: Number(p.lng),
          radius: Number(p.radius),
          name: (typeof p.name === 'string' && p.name.trim().length) ? String(p.name).trim() : `Lokasi ${i+1}`
        }))
        .filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng) && Number.isFinite(p.radius) && p.radius > 0);
      return { locations: clean, namaSekolah };
    }
    if (typeof obj.lat === 'number' && typeof obj.lng === 'number' && typeof obj.radius === 'number') {
      return { locations: [{ lat: obj.lat, lng: obj.lng, radius: obj.radius, name: 'Lokasi 1' }], namaSekolah };
    }
  } catch (e) {}
  const envLat = parseFloat(process.env.SCHOOL_LAT || '');
  const envLng = parseFloat(process.env.SCHOOL_LNG || '');
  const envRadius = parseFloat(process.env.SCHOOL_RADIUS_M || '');
  const envName = String(process.env.SCHOOL_NAME || '').trim();
  const loc = (Number.isFinite(envLat) && Number.isFinite(envLng) && Number.isFinite(envRadius))
    ? [{ lat: envLat, lng: envLng, radius: envRadius, name: 'Lokasi 1' }]
    : [];
  return { locations: loc, namaSekolah: envName };
}
function saveSchoolSettings(obj) {
  try {
    fs.mkdirSync(path.dirname(SETTINGS_PATH), { recursive: true });
    const locs = Array.isArray(obj.locations) ? obj.locations.map((p, i) => ({
      lat: Number(p.lat),
      lng: Number(p.lng),
      radius: Number(p.radius),
      name: (typeof p.name === 'string' && p.name.trim().length) ? String(p.name).trim() : `Lokasi ${i+1}`
    })) : [];
    let prev = {};
    try { prev = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8')); } catch (_) {}
    const namaSekolah = (typeof obj.namaSekolah === 'string' && obj.namaSekolah.trim().length) ? obj.namaSekolah.trim() : (typeof prev.namaSekolah === 'string' ? prev.namaSekolah : '');
    const next = { ...prev, locations: locs, namaSekolah };
    fs.writeFileSync(SETTINGS_PATH, JSON.stringify(next, null, 2));
    return true;
  } catch (e) {
    return false;
  }
}
let SCHOOL_SETTINGS = loadSchoolSettings();

// Multer storage
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const dir = path.join(__dirname, '..', 'uploads', format(new Date(), 'yyyy-MM-dd'));
    fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: (req, file, cb) => {
    const stamp = Date.now();
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `${stamp}${ext}`);
  },
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (!file.mimetype || !file.mimetype.startsWith('image/')) {
      return cb(new Error('File bukan gambar'));
    }
    cb(null, true);
  },
  limits: { fileSize: 3 * 1024 * 1024 } // maks 3MB
});

// Multer untuk impor CSV Mapel (gunakan memory storage)
const csvUpload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    const mime = (file.mimetype || '').toLowerCase();
    const name = (file.originalname || '').toLowerCase();
    const ok = mime.includes('csv') || mime.includes('excel') || mime.includes('text') || name.endsWith('.csv') || name.endsWith('.txt');
    // Terima file meski mimetype tidak standar (mis. curl kirim octet-stream)
    // agar tidak terjadi error 500 saat impor.
    cb(null, true);
  },
  limits: { fileSize: 2 * 1024 * 1024 } // maks 2MB
});

// Auth middleware (admin)
function requireAdmin(req, res, next) {
  const token = req.cookies['admin_token'];
  if (!token) return res.redirect('/admin/login');
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.admin = payload;
    next();
  } catch (e) {
    return res.redirect('/admin/login');
  }
}

// ================= GURU: Upload via link unik =================
app.get('/upload/:token', async (req, res) => {
  const token = req.params.token;
  const guru = await prisma.guru.findUnique({ where: { uploadToken: token } });
  if (!guru) return res.status(404).send('Link tidak valid');
  const mapel = await prisma.mapel.findMany();
  const kelas = await prisma.kelas.findMany();
  res.render('upload', { guru, mapel, kelas });
});

// Handler upload: tandai validitas lokasi
app.post('/api/upload/:token', upload.single('foto'), async (req, res) => {
  const token = req.params.token;
  const guru = await prisma.guru.findUnique({ where: { uploadToken: token } });
  if (!guru) return res.status(404).json({ error: 'Link tidak valid' });

  const { mapelId, kelasId, latitude, longitude } = req.body;
  // Ambil semua jamKe yang dipilih (multi-select)
  let jamKeNums = [];
  if (req.body.jamKe !== undefined) {
    const vals = Array.isArray(req.body.jamKe) ? req.body.jamKe : [req.body.jamKe];
    jamKeNums = vals.map(v => parseInt(v)).filter(v => !isNaN(v));
  }
  if (!req.file) return res.status(400).json({ error: 'File foto wajib ada' });
  if (!mapelId || !kelasId) return res.status(400).json({ error: 'Mapel dan Kelas wajib dipilih' });
  if (!jamKeNums || jamKeNums.length === 0) return res.status(400).json({ error: 'Jam Mengajar wajib dipilih' });

  const fotoPath = req.file ? path.relative(path.join(__dirname, '..'), req.file.path).replace(/\\/g, '/') : null;

  const mapel = await prisma.mapel.findUnique({ where: { id: Number(mapelId) } });
  const kelas = await prisma.kelas.findUnique({ where: { id: Number(kelasId) } });
  if (!mapel || !kelas) return res.status(400).json({ error: 'Mapel/Kelas tidak valid' });

  // Hitung validitas lokasi
  function haversine(lat1, lon1, lat2, lon2) {
    const toRad = (v) => (v * Math.PI) / 180;
    const R = 6371000; // meter
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat/2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon/2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
  }
  let isLocationValid = null;
  const pts = (SCHOOL_SETTINGS && Array.isArray(SCHOOL_SETTINGS.locations)) ? SCHOOL_SETTINGS.locations : [];
  if (pts.length > 0 && latitude && longitude) {
    const latNum = Number(latitude), lngNum = Number(longitude);
    for (const p of pts) {
      const dist = haversine(latNum, lngNum, Number(p.lat), Number(p.lng));
      if (dist <= Number(p.radius)) { isLocationValid = true; break; }
    }
    if (isLocationValid === null) isLocationValid = false;
  }

  let created;
  try {
    // Buat satu entri per jamKe yang dipilih
    const jamKeListStr = jamKeNums.join(',');
    const dataRows = jamKeNums.map(j => ({
      guruId: guru.id,
      mapelId: mapel.id,
      kelasId: kelas.id,
      fotoPath: fotoPath || '',
      latitude: latitude ? Number(latitude) : null,
      longitude: longitude ? Number(longitude) : null,
      jamKe: j,
      jamKeList: jamKeListStr,
      isLocationValid
    }));
    const result = await prisma.dokumentasi.createMany({ data: dataRows });
    created = { count: result.count };
  } catch (e) {
    const msg = String(e && e.message || '');
    if (msg.includes('Unknown arg') && (msg.includes('jamKe') || msg.includes('jamKeList'))) {
      // Fallback: sisipkan satu baris per jamKe via SQL mentah
      const jamKeListStr = jamKeNums.join(',');
      let okCount = 0;
      for (const j of jamKeNums) {
        await prisma.$executeRaw`INSERT INTO Dokumentasi (guruId, mapelId, kelasId, fotoPath, latitude, longitude, jamKe, jamKeList, isLocationValid) VALUES (${guru.id}, ${mapel.id}, ${kelas.id}, ${fotoPath || ''}, ${latitude ? Number(latitude) : null}, ${longitude ? Number(longitude) : null}, ${j}, ${jamKeListStr}, ${isLocationValid})`;
        okCount++;
      }
      created = { count: okCount };
    } else {
      throw e;
    }
  }
  res.json({ ok: true, count: created.count || 1, jamKe: jamKeNums });
});

// Error handler untuk batas ukuran file dan validasi tipe
app.use((err, req, res, next) => {
  if (err && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(400).json({ error: 'Ukuran dokumen foto maksimal 3MB' });
  }
  if (err && String(err.message || '').includes('File bukan gambar')) {
    return res.status(400).json({ error: 'File bukan gambar' });
  }
  next(err);
});

// ================= ADMIN: Auth & Pages =================
app.get('/admin/login', (req, res) => {
  res.render('admin/login');
});

app.post('/admin/login', async (req, res) => {
  const { username, password } = req.body;
  const admin = await prisma.adminUser.findUnique({ where: { username } });
  if (!admin) return res.render('admin/login', { error: 'User tidak ditemukan' });
  const match = await bcrypt.compare(password, admin.passwordHash);
  if (!match) return res.render('admin/login', { error: 'Password salah' });
  const token = jwt.sign({ id: admin.id, username: admin.username, role: admin.role || 'ADMIN' }, JWT_SECRET, { expiresIn: '12h' });
  res.cookie('admin_token', token, { httpOnly: true });
  res.redirect('/admin/dashboard');
});

app.get('/admin/logout', (req, res) => {
  res.clearCookie('admin_token');
  res.redirect('/admin/login');
});

// Dashboard
app.get('/admin/dashboard', requireAdmin, async (req, res) => {
  const now = new Date();
  const weekStart = startOfWeek(now, { weekStartsOn: 1 });
  const weekEnd = endOfWeek(now, { weekStartsOn: 1 });
  const todayStart = startOfDay(now);
  const todayEnd = endOfDay(now);

  const [totalGuru, totalKelas, totalMapel, docsThisWeek, latestDocs] = await Promise.all([
    prisma.guru.count(),
    prisma.kelas.count(),
    prisma.mapel.count(),
    prisma.dokumentasi.count({ where: { createdAt: { gte: weekStart, lte: weekEnd } } }),
    prisma.dokumentasi.findMany({ include: { guru: true, mapel: true, kelas: true }, orderBy: { createdAt: 'desc' }, take: 8 })
  ]);

  const todayDocsCount = await prisma.dokumentasi.count({ where: { createdAt: { gte: todayStart, lte: todayEnd } } });
  const todayGuruIds = await prisma.dokumentasi.findMany({ where: { createdAt: { gte: todayStart, lte: todayEnd } } , select: { guruId: true } });
  const todayActiveGuruCount = new Set(todayGuruIds.map(x => x.guruId)).size;

  // Tren dokumen 7 hari terbaru (Ahad–Sabtu label pendek)
  const dayLabels = ['Ahad','Sen','Sel','Rab','Kam','Jum','Sab'];
  const days = Array.from({ length: 7 }, (_, idx) => {
    const d = new Date(now.getTime() - (6 - idx) * 86400000);
    return { start: startOfDay(d), end: endOfDay(d), label: dayLabels[d.getDay()] };
  });
  const dailyCounts = await Promise.all(days.map(({ start, end }) => prisma.dokumentasi.count({ where: { createdAt: { gte: start, lte: end } } })));
  const docsDaily = days.map((d, i) => ({ label: d.label, count: dailyCounts[i] }));

  // Foto terbaru (tampilkan maksimal 37)
  const latestPhotosCandidate = await prisma.dokumentasi.findMany({
    orderBy: { createdAt: 'desc' },
    include: { guru: true, mapel: true, kelas: true },
    take: 100,
  });
  const latestPhotos = latestPhotosCandidate.filter(d => d.fotoPath && d.fotoPath !== '').slice(0, 37);

  // Realtime sekilas: kiriman lokasi tidak sesuai hari ini (maks 5)
  const invalidsToday = await prisma.dokumentasi.findMany({
    where: { isLocationValid: false, createdAt: { gte: todayStart, lte: todayEnd } },
    include: { guru: true, mapel: true, kelas: true },
    orderBy: { createdAt: 'desc' },
    take: 5,
  });

  // Tambahan metrik: jumlah jam hari ini (distinct jamKe dari alokasi hari ini)
  const todayIndex = now.getDay();
  const alokasiToday = await prisma.alokasiJamBelajar.findMany({ where: { hari: todayIndex } });
  const jamHariIni = new Set(alokasiToday.filter(a => typeof a.jamKe === 'number').map(a => a.jamKe)).size;

  // Tambahan metrik: jumlah guru yang kirim foto pada menit ini & yang belum
  const minuteStart = new Date(now); minuteStart.setSeconds(0, 0);
  const minuteEnd = new Date(now); minuteEnd.setSeconds(59, 999);
  const docsThisMinute = await prisma.dokumentasi.findMany({
    where: { createdAt: { gte: minuteStart, lte: minuteEnd } },
    select: { guruId: true, fotoPath: true },
  });
  const sudahFotoMinuteCount = new Set(docsThisMinute.filter(d => d.fotoPath && d.fotoPath !== '').map(d => d.guruId)).size;
  const belumFotoMinuteCount = Math.max(0, Number(totalGuru || 0) - sudahFotoMinuteCount);

  res.render('admin/dashboard', {
    totalGuru,
    totalKelas,
    totalMapel,
    docsThisWeek,
    todayDocsCount,
    todayActiveGuruCount,
    docsDaily,
    latestPhotos,
    invalidsToday,
    jamHariIni,
    sudahFotoMinuteCount,
    belumFotoMinuteCount,
  });
});

// Pemantauan Realtime
app.get('/admin/realtime', requireAdmin, async (req, res) => {
  const today = new Date();
  const todayStart = startOfDay(today);
  const todayEnd = endOfDay(today);
  const todayIndex = today.getDay(); // 0=Ahad, 1=Senin, ...

  const { page = '1', limit = '10', sort = 'terbaru', order = 'desc', q = '' } = req.query;

  // Ambil semua jadwal untuk hari ini, lengkap dengan relasi
  const jadwalHariIni = await prisma.jadwalMengajar.findMany({
    where: { hari: todayIndex },
    include: { guru: true, mapel: true, kelas: true },
    orderBy: [{ guruId: 'asc' }, { mulaiMenit: 'asc' }],
  });

  // Ambil alokasi jam untuk hari ini untuk memetakan (mulai,selesai) -> jamKe
  const alokasiHariIni = await prisma.alokasiJamBelajar.findMany({ where: { hari: todayIndex } });
  const slots = alokasiHariIni
    .filter(a => typeof a.jamKe === 'number')
    .map(a => ({ jamKe: a.jamKe, mulai: a.mulaiMenit, selesai: a.selesaiMenit }))
    .sort((a,b) => a.mulai - b.mulai);

  // Kelompokkan per (guruId, kelasId, mapelId) dan agregasi jamKe
  const groupMap = new Map();
  for (const j of jadwalHariIni) {
    const key = `${j.guruId}:${j.kelasId}:${j.mapelId}`;
    if (!groupMap.has(key)) {
      groupMap.set(key, {
        guruId: j.guruId,
        nama: j.guru.nama,
        kelasId: j.kelasId,
        kelas: j.kelas.nama,
        mapelId: j.mapelId,
        mapel: (j.mapel.kode ? j.mapel.kode : '—'),
        jamKes: [],
      });
    }
    // Tambahkan semua jamKe yang overlap dengan rentang waktu jadwal ini
    const jamSet = new Set();
    for (const s of slots) {
      // overlap jika slot.mulai < jadwal.selesai dan slot.selesai > jadwal.mulai
      if (s.mulai < j.selesaiMenit && s.selesai > j.mulaiMenit) jamSet.add(s.jamKe);
    }
    jamSet.forEach(k => groupMap.get(key).jamKes.push(k));
  }

  // Ambil kiriman dokumentasi hari ini dan tentukan kiriman terbaru per grup maupun per guru
  const submissionsToday = await prisma.dokumentasi.findMany({
    where: { createdAt: { gte: todayStart, lte: todayEnd } },
    include: { guru: true, mapel: true, kelas: true },
    orderBy: { createdAt: 'desc' },
  });
  // Pemetaan kiriman terbaru per (guru, kelas, mapel, jamKe)
  const latestByGroupJam = new Map(); // key: guruId:kelasId:mapelId:jamKe
  const latestByGroupList = new Map(); // key: guruId:kelasId:mapelId (untuk fallback jamKeList)
  const submissionsByGuru = new Map(); // kumpulkan semua kiriman per guru untuk analisis alasan
  for (const s of submissionsToday) {
    const groupKey = `${s.guruId}:${s.kelasId || ''}:${s.mapelId || ''}`;
    // kelompokkan kiriman per guru
    if (!submissionsByGuru.has(s.guruId)) submissionsByGuru.set(s.guruId, []);
    submissionsByGuru.get(s.guruId).push(s);
    // simpan dokumen terbaru per grup untuk fallback jamKeList
    if (!latestByGroupList.has(groupKey) || new Date(s.createdAt).getTime() > new Date(latestByGroupList.get(groupKey).createdAt).getTime()) {
      latestByGroupList.set(groupKey, s);
    }
    if (typeof s.jamKe === 'number') {
      const k = `${groupKey}:${s.jamKe}`;
      if (!latestByGroupJam.has(k)) latestByGroupJam.set(k, s);
    }
  }

  // Bentuk baris per grup guru–kelas–mapel, jamKe ditampilkan sebagai daftar "3,4,5,6"
  let rows = Array.from(groupMap.values()).map(grp => {
    const jamKeList = Array.from(new Set(grp.jamKes)).sort((a,b) => a-b);
    const jamKeDisplay = jamKeList.join(', ');
    // Temukan kiriman yang benar-benar cocok (guru, kelas, mapel, dan jamKe)
    let matchedDoc = null;
    for (const jke of jamKeList) {
      const k = `${grp.guruId}:${grp.kelasId}:${grp.mapelId}:${jke}`;
      const doc = latestByGroupJam.get(k);
      if (doc) {
        if (!matchedDoc || new Date(doc.createdAt).getTime() > new Date(matchedDoc.createdAt).getTime()) {
          matchedDoc = doc;
        }
      }
    }
    // Fallback: jika jamKe single tidak tersedia, cocokkan menggunakan jamKeList dari kiriman terbaru per grup
    if (!matchedDoc) {
      const gkey = `${grp.guruId}:${grp.kelasId}:${grp.mapelId}`;
      const docList = latestByGroupList.get(gkey);
      if (docList && typeof docList.jamKeList === 'string' && docList.jamKeList.trim()) {
        const uploadedJamList = docList.jamKeList.split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isInteger(n));
        const hasOverlap = uploadedJamList.some(n => jamKeList.includes(n));
        if (hasOverlap) matchedDoc = docList;
      }
    }

    const status = matchedDoc ? 'sesuai' : 'belum';
    // Detail alasan disembunyikan untuk jadwal hari ini; tampilkan hanya 'belum'
    let statusDetail = '';
    if (!matchedDoc) {
      statusDetail = '';
    }

    const fotoUrl = matchedDoc && matchedDoc.fotoPath ? (String(matchedDoc.fotoPath).startsWith('/') ? matchedDoc.fotoPath : `/${matchedDoc.fotoPath}`) : null;
    const lastAt = matchedDoc && matchedDoc.createdAt ? new Date(matchedDoc.createdAt).getTime() : 0;
    return {
      no: 0,
      nama: grp.nama,
      mapel: grp.mapel,
      kelas: grp.kelas,
      jamKe: jamKeDisplay || '—',
      status,
      statusDetail,
      guruId: grp.guruId,
      waktuKirim: matchedDoc ? matchedDoc.createdAt : null,
      lokasiValid: (matchedDoc && typeof matchedDoc.isLocationValid === 'boolean') ? matchedDoc.isLocationValid : null,
      latitude: (matchedDoc && Number.isFinite(matchedDoc.latitude)) ? matchedDoc.latitude : null,
      longitude: (matchedDoc && Number.isFinite(matchedDoc.longitude)) ? matchedDoc.longitude : null,
      mapsUrl: (matchedDoc && Number.isFinite(matchedDoc.latitude) && Number.isFinite(matchedDoc.longitude)) ? (`https://www.google.com/maps?q=${matchedDoc.latitude},${matchedDoc.longitude}`) : null,
      fotoUrl,
      lastAt,
    };
  });

  // Filtering (pencarian) berdasarkan q terhadap nama, mapel, kelas
  const query = String(q || '').trim().toLowerCase();
  if (query) {
    rows = rows.filter((r) =>
      r.nama.toLowerCase().includes(query) ||
      r.mapel.toLowerCase().includes(query) ||
      r.kelas.toLowerCase().includes(query)
    );
  }

  // Sorting
  function minJamVal(v) {
    if (typeof v === 'number') return v;
    if (typeof v === 'string') {
      const nums = v.split(',').map(s => parseInt(s.trim(), 10)).filter(n => Number.isInteger(n));
      if (nums.length) return Math.min(...nums);
    }
    return 0;
  }
  const comparators = {
    nama: (a, b) => a.nama.localeCompare(b.nama),
    mapel: (a, b) => a.mapel.localeCompare(b.mapel),
    kelas: (a, b) => a.kelas.localeCompare(b.kelas),
    jamKe: (a, b) => minJamVal(a.jamKe) - minJamVal(b.jamKe),
    status: (a, b) => a.status.localeCompare(b.status),
    terbaru: (a, b) => (a.lastAt || 0) - (b.lastAt || 0),
  };
  const cmp = comparators[sort] || comparators.nama;
  rows.sort(cmp);
  if (String(order).toLowerCase() === 'desc') rows.reverse();

  // Bangun indeks grup valid untuk analisis kiriman tidak sesuai
  const validGroupJam = new Map(); // key: guruId:kelasId:mapelId -> Set(jamKe)
  const groupsByGuru = new Map(); // guruId -> list of { kelasId, mapelId, jamKes: Set }
  for (const grp of Array.from(groupMap.values())) {
    const gkey = `${grp.guruId}:${grp.kelasId}:${grp.mapelId}`;
    const jamSet = new Set(Array.from(new Set(grp.jamKes)));
    validGroupJam.set(gkey, jamSet);
    if (!groupsByGuru.has(grp.guruId)) groupsByGuru.set(grp.guruId, []);
    groupsByGuru.get(grp.guruId).push({ kelasId: grp.kelasId, mapelId: grp.mapelId, jamKes: jamSet });
  }

  // Susun daftar kiriman yang tidak sesuai (hari ini) — gabungkan satu baris per (guru,kelas,mapel), kumpulkan semua jam dan semua alasan
  const invalidsGroupMap = new Map();
  for (const s of submissionsToday) {
    const jamProvided = [];
    if (Number.isInteger(s.jamKe)) jamProvided.push(s.jamKe);
    if (typeof s.jamKeList === 'string' && s.jamKeList.trim()) {
      s.jamKeList.split(',').forEach(x => {
        const n = parseInt(x.trim(), 10);
        if (Number.isInteger(n)) jamProvided.push(n);
      });
    }
    const jamUniq = Array.from(new Set(jamProvided));
    const groupKeyExact = `${s.guruId}:${s.kelasId}:${s.mapelId}`;
    const validJamSet = validGroupJam.get(groupKeyExact);

    let isMatch = false;
    let reason = '';
    let extraJamReason = '';
    let extraJamReason2 = '';
    if (validJamSet) {
      if (jamUniq.length === 0) {
        reason = 'jam kosong';
      } else {
        isMatch = jamUniq.some(n => validJamSet.has(n));
        if (!isMatch) reason = 'jam mengajar salah';
      }
    } else {
      const list = groupsByGuru.get(s.guruId) || [];
      if (!list.length) {
        reason = 'tidak ada jadwal guru hari ini';
      } else {
        const sameClass = list.filter(g => g.kelasId === s.kelasId);
        const sameSubject = list.filter(g => g.mapelId === s.mapelId);
        if (!sameClass.length && !sameSubject.length) reason = 'kelas salah, mapel salah';
        else if (!sameClass.length) reason = 'kelas salah';
        else if (!sameSubject.length) reason = 'mapel salah';
        else reason = '';
        // Tambahan: cek jam terhadap keseluruhan jadwal guru hari ini,
        // agar alasan "jamKe tidak cocok" tetap muncul meskipun kelas/mapel salah.
        if (jamUniq.length === 0) {
          // tidak ada jam dipilih dalam kiriman
          extraJamReason = 'jam kosong';
        } else {
          extraJamReason2 = 'jam salah';
          const unionJam = new Set();
          for (const g of list) {
            const sset = validGroupJam.get(`${s.guruId}:${g.kelasId}:${g.mapelId}`);
            if (sset) sset.forEach(v => unionJam.add(v));
          }
          const anyMatchUnion = jamUniq.some(n => unionJam.has(n));
          if (!anyMatchUnion) {
            // tidak ada jam yang cocok dengan jadwal guru pada hari ini
            extraJamReason = 'jam mengajar salah';
          }
        }
      }
    }

    if (!isMatch) {
      const k = `${s.guruId}:${s.kelasId}:${s.mapelId}`;
      const existing = invalidsGroupMap.get(k);
      const jamSet = new Set(existing?.jamSet || []);
      jamUniq.forEach(n => jamSet.add(n));
      const reasonSet = new Set(existing?.reasonSet || []);
      if (reason) reasonSet.add(reason);
      if (extraJamReason) reasonSet.add(extraJamReason);
      if (extraJamReason2) reasonSet.add(extraJamReason2);
      const fotoUrl = s.fotoPath ? (String(s.fotoPath).startsWith('/') ? s.fotoPath : `/${s.fotoPath}`) : null;
      const nextRecord = {
        waktu: existing && new Date(existing.waktu).getTime() > new Date(s.createdAt).getTime() ? existing.waktu : s.createdAt,
        waktuKirim: existing && new Date(existing.waktuKirim || 0).getTime() > new Date(s.createdAt).getTime() ? existing.waktuKirim : s.createdAt,
        guru: s.guru ? s.guru.nama : String(s.guruId),
        mapel: (s.mapel && s.mapel.kode) ? s.mapel.kode : (Number.isInteger(s.mapelId) ? String(s.mapelId) : '—'),
        kelas: s.kelas ? s.kelas.nama : (Number.isInteger(s.kelasId) ? String(s.kelasId) : '—'),
        jamSet,
        reasonSet,
        lokasiValid: (typeof s.isLocationValid === 'boolean') ? s.isLocationValid : (existing ? existing.lokasiValid : null),
        latitude: Number.isFinite(s.latitude) ? s.latitude : (existing ? existing.latitude : null),
        longitude: Number.isFinite(s.longitude) ? s.longitude : (existing ? existing.longitude : null),
        mapsUrl: (Number.isFinite(s.latitude) && Number.isFinite(s.longitude)) ? (`https://www.google.com/maps?q=${s.latitude},${s.longitude}`) : (existing ? existing.mapsUrl : null),
        fotoUrl: fotoUrl || (existing ? existing.fotoUrl : null),
      };
      invalidsGroupMap.set(k, nextRecord);
    }
  }
  // Lapisan deduplikasi tambahan: gabungkan berdasarkan label (guru, kelas, mapel) jika ID berbeda namun label sama
  const invalidsRaw = Array.from(invalidsGroupMap.values());
  const mergedByLabel = new Map(); // key: guru:kelas:mapel (label teks)
  for (const r of invalidsRaw) {
    const key = `${r.guru}:${r.kelas}:${r.mapel}`;
    const existing = mergedByLabel.get(key);
    const jamSet = new Set(existing?.jamSet || []);
    if (r.jamSet) Array.from(r.jamSet).forEach(n => jamSet.add(n));
    const reasonSet = new Set(existing?.reasonSet || []);
    if (r.reasonSet) Array.from(r.reasonSet).forEach(s => reasonSet.add(s));
    const next = {
      waktu: !existing || new Date(r.waktu).getTime() > new Date(existing.waktu).getTime() ? r.waktu : existing.waktu,
      waktuKirim: !existing || new Date(r.waktuKirim || 0).getTime() > new Date(existing.waktuKirim || 0).getTime() ? r.waktuKirim : existing.waktuKirim,
      guru: r.guru,
      mapel: r.mapel,
      kelas: r.kelas,
      jamSet,
      reasonSet,
      lokasiValid: (typeof r.lokasiValid === 'boolean') ? r.lokasiValid : (existing ? existing.lokasiValid : null),
      latitude: Number.isFinite(r.latitude) ? r.latitude : (existing ? existing.latitude : null),
      longitude: Number.isFinite(r.longitude) ? r.longitude : (existing ? existing.longitude : null),
      mapsUrl: r.mapsUrl || (existing ? existing.mapsUrl : null),
      fotoUrl: r.fotoUrl || (existing ? existing.fotoUrl : null),
    };
    mergedByLabel.set(key, next);
  }
  const invalids = Array.from(mergedByLabel.values()).map(rec => ({
    ...rec,
    jamDikirim: (rec.jamSet && rec.jamSet.size) ? Array.from(rec.jamSet).sort((a,b)=>a-b).join(', ') : '—',
    alasan: (rec.reasonSet && rec.reasonSet.size) ? Array.from(rec.reasonSet).join(', ') : 'tidak sesuai'
  })).sort((a,b) => new Date(b.waktu).getTime() - new Date(a.waktu).getTime());

  // Pagination untuk tabel utama
  const pageNum = Math.max(1, parseInt(page));
  const lim = Math.max(1, parseInt(limit));
  const totalRows = rows.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / lim));
  const startIdx = (pageNum - 1) * lim;
  const visibleRows = rows.slice(startIdx, startIdx + lim).map((row, i) => ({
    ...row,
    no: startIdx + i + 1,
  }));

  res.render('admin/realtime', {
    rows: visibleRows,
    page: pageNum,
    limit: lim,
    totalPages,
    totalRows,
    sort,
    order,
    q: query,
    invalids,
    invalidCount: invalids.length,
  });
});

// Print: Rekap Invalid (A4 Landscape, margin 1cm)
app.get('/admin/realtime/print-invalid', requireAdmin, async (req, res) => {
  const today = new Date();
  const todayStart = startOfDay(today);
  const todayEnd = endOfDay(today);
  const todayIndex = today.getDay();
  const titleDate = today.toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  // Ambil jadwal hari ini
  const jadwalHariIni = await prisma.jadwalMengajar.findMany({
    where: { hari: todayIndex },
    include: { guru: true, mapel: true, kelas: true },
    orderBy: [{ guruId: 'asc' }, { mulaiMenit: 'asc' }],
  });
  const alokasiHariIni = await prisma.alokasiJamBelajar.findMany({ where: { hari: todayIndex } });
  const slots = alokasiHariIni
    .filter(a => typeof a.jamKe === 'number')
    .map(a => ({ jamKe: a.jamKe, mulai: a.mulaiMenit, selesai: a.selesaiMenit }))
    .sort((a,b) => a.mulai - b.mulai);

  // Group jadwal
  const groupMap = new Map();
  for (const j of jadwalHariIni) {
    const key = `${j.guruId}:${j.kelasId}:${j.mapelId}`;
    if (!groupMap.has(key)) {
      groupMap.set(key, { guruId: j.guruId, kelasId: j.kelasId, mapelId: j.mapelId, jamKes: [] });
    }
    const jamSet = new Set();
    for (const s of slots) {
      if (s.mulai < j.selesaiMenit && s.selesai > j.mulaiMenit) jamSet.add(s.jamKe);
    }
    jamSet.forEach(k => groupMap.get(key).jamKes.push(k));
  }

  const validGroupJam = new Map();
  const groupsByGuru = new Map();
  for (const grp of Array.from(groupMap.values())) {
    const gkey = `${grp.guruId}:${grp.kelasId}:${grp.mapelId}`;
    const jamSet = new Set(Array.from(new Set(grp.jamKes)));
    validGroupJam.set(gkey, jamSet);
    if (!groupsByGuru.has(grp.guruId)) groupsByGuru.set(grp.guruId, []);
    groupsByGuru.get(grp.guruId).push({ kelasId: grp.kelasId, mapelId: grp.mapelId, jamKes: jamSet });
  }

  // Submissions hari ini
  const submissionsToday = await prisma.dokumentasi.findMany({
    where: { createdAt: { gte: todayStart, lte: todayEnd } },
    include: { guru: true, mapel: true, kelas: true },
    orderBy: { createdAt: 'desc' },
  });

  // Bangun invalids seperti di halaman realtime
  const invalidsGroupMap = new Map();
  for (const s of submissionsToday) {
    const jamProvided = [];
    if (Number.isInteger(s.jamKe)) jamProvided.push(s.jamKe);
    if (typeof s.jamKeList === 'string' && s.jamKeList.trim()) {
      s.jamKeList.split(',').forEach(x => { const n = parseInt(x.trim(), 10); if (Number.isInteger(n)) jamProvided.push(n); });
    }
    const jamUniq = Array.from(new Set(jamProvided));
    const groupKeyExact = `${s.guruId}:${s.kelasId}:${s.mapelId}`;
    const validJamSet = validGroupJam.get(groupKeyExact);

    let isMatch = false;
    let reason = '';
    let extraJamReason = '';
    let extraJamReason2 = '';
    if (validJamSet) {
      if (jamUniq.length === 0) {
        reason = 'jam kosong';
      } else {
        isMatch = jamUniq.some(n => validJamSet.has(n));
        if (!isMatch) reason = 'jam mengajar salah';
      }
    } else {
      const list = groupsByGuru.get(s.guruId) || [];
      if (!list.length) {
        reason = 'tidak ada jadwal guru hari ini';
      } else {
        const sameClass = list.filter(g => g.kelasId === s.kelasId);
        const sameSubject = list.filter(g => g.mapelId === s.mapelId);
        if (!sameClass.length && !sameSubject.length) reason = 'kelas salah, mapel salah';
        else if (!sameClass.length) reason = 'kelas salah';
        else if (!sameSubject.length) reason = 'mapel salah';
        else reason = '';
        if (jamUniq.length === 0) {
          extraJamReason = 'jam kosong';
        } else {
          extraJamReason2 = 'jam salah';
          const unionJam = new Set();
          for (const g of list) {
            const sset = validGroupJam.get(`${s.guruId}:${g.kelasId}:${g.mapelId}`);
            if (sset) sset.forEach(v => unionJam.add(v));
          }
          const anyMatchUnion = jamUniq.some(n => unionJam.has(n));
          if (!anyMatchUnion) extraJamReason = 'jam mengajar salah';
        }
      }
    }
    if (!isMatch) {
      const key = `${s.guru ? s.guru.nama : s.guruId}:${s.kelas ? s.kelas.nama : (Number.isInteger(s.kelasId) ? s.kelasId : '—')}:${(s.mapel && s.mapel.kode) ? s.mapel.kode : (Number.isInteger(s.mapelId) ? s.mapelId : '—')}`;
      const existing = invalidsGroupMap.get(key);
      const jamSet = new Set(existing?.jamSet || []);
      jamUniq.forEach(n => jamSet.add(n));
      const reasonSet = new Set(existing?.reasonSet || []);
      if (reason) reasonSet.add(reason);
      if (extraJamReason) reasonSet.add(extraJamReason);
      if (extraJamReason2) reasonSet.add(extraJamReason2);
      const fotoUrl = s.fotoPath ? (String(s.fotoPath).startsWith('/') ? s.fotoPath : `/${s.fotoPath}`) : null;
      const next = {
        waktu: !existing || new Date(s.createdAt).getTime() > new Date(existing.waktu).getTime() ? s.createdAt : existing.waktu,
        waktuKirim: !existing || new Date(s.createdAt).getTime() > new Date(existing.waktuKirim || 0).getTime() ? s.createdAt : existing.waktuKirim,
        guru: s.guru ? s.guru.nama : String(s.guruId),
        kelas: s.kelas ? s.kelas.nama : (Number.isInteger(s.kelasId) ? String(s.kelasId) : '—'),
        mapel: (s.mapel && s.mapel.kode) ? s.mapel.kode : (Number.isInteger(s.mapelId) ? String(s.mapelId) : '—'),
        jamSet,
        reasonSet,
        lokasiValid: (typeof s.isLocationValid === 'boolean') ? s.isLocationValid : (existing ? existing.lokasiValid : null),
        latitude: Number.isFinite(s.latitude) ? s.latitude : (existing ? existing.latitude : null),
        longitude: Number.isFinite(s.longitude) ? s.longitude : (existing ? existing.longitude : null),
        mapsUrl: (Number.isFinite(s.latitude) && Number.isFinite(s.longitude)) ? (`https://www.google.com/maps?q=${s.latitude},${s.longitude}`) : (existing ? existing.mapsUrl : null),
        fotoUrl: fotoUrl || (existing ? existing.fotoUrl : null),
      };
      invalidsGroupMap.set(key, next);
    }
  }
  const invalids = Array.from(invalidsGroupMap.values()).map(rec => ({
    ...rec,
    jamDikirim: (rec.jamSet && rec.jamSet.size) ? Array.from(rec.jamSet).sort((a,b)=>a-b).join(', ') : '—',
    alasan: (rec.reasonSet && rec.reasonSet.size) ? Array.from(rec.reasonSet).join(', ') : 'tidak sesuai'
  })).sort((a,b) => new Date(b.waktu).getTime() - new Date(a.waktu).getTime());

  res.render('admin/realtime_print_invalid', {
    titleDate,
    invalids,
    school: (SCHOOL_SETTINGS && SCHOOL_SETTINGS.namaSekolah) ? SCHOOL_SETTINGS.namaSekolah : ''
  });
});

// Print: Rekap Valid (A4 Landscape, margin 1cm)
app.get('/admin/realtime/print-valid', requireAdmin, async (req, res) => {
  const today = new Date();
  const todayStart = startOfDay(today);
  const todayEnd = endOfDay(today);
  const todayIndex = today.getDay();
  const titleDate = today.toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  // Ambil jadwal hari ini
  const jadwalHariIni = await prisma.jadwalMengajar.findMany({ where: { hari: todayIndex } });
  const alokasiHariIni = await prisma.alokasiJamBelajar.findMany({ where: { hari: todayIndex } });
  const slots = alokasiHariIni
    .filter(a => typeof a.jamKe === 'number')
    .map(a => ({ jamKe: a.jamKe, mulai: a.mulaiMenit, selesai: a.selesaiMenit }))
    .sort((a,b) => a.mulai - b.mulai);

  const groupMap = new Map();
  for (const j of jadwalHariIni) {
    const key = `${j.guruId}:${j.kelasId}:${j.mapelId}`;
    if (!groupMap.has(key)) groupMap.set(key, { guruId: j.guruId, kelasId: j.kelasId, mapelId: j.mapelId, jamKes: [] });
    const jamSet = new Set();
    for (const s of slots) { if (s.mulai < j.selesaiMenit && s.selesai > j.mulaiMenit) jamSet.add(s.jamKe); }
    jamSet.forEach(k => groupMap.get(key).jamKes.push(k));
  }
  const validGroupJam = new Map();
  for (const grp of Array.from(groupMap.values())) {
    const gkey = `${grp.guruId}:${grp.kelasId}:${grp.mapelId}`;
    validGroupJam.set(gkey, new Set(Array.from(new Set(grp.jamKes))));
  }

  // Submissions hari ini
  const submissionsToday = await prisma.dokumentasi.findMany({
    where: { createdAt: { gte: todayStart, lte: todayEnd } },
    include: { guru: true, mapel: true, kelas: true },
    orderBy: { createdAt: 'desc' },
  });

  // Agregasi valid per label (guru, kelas, mapel)
  const validsMap = new Map();
  for (const s of submissionsToday) {
    const jamProvided = [];
    if (Number.isInteger(s.jamKe)) jamProvided.push(s.jamKe);
    if (typeof s.jamKeList === 'string' && s.jamKeList.trim()) {
      s.jamKeList.split(',').forEach(x => { const n = parseInt(x.trim(), 10); if (Number.isInteger(n)) jamProvided.push(n); });
    }
    const jamUniq = Array.from(new Set(jamProvided));
    const gkeyExact = `${s.guruId}:${s.kelasId}:${s.mapelId}`;
    const validSet = validGroupJam.get(gkeyExact);
    let isValid = false;
    if (validSet && jamUniq.length) {
      isValid = jamUniq.some(n => validSet.has(n));
    }
    if (isValid) {
      const labelKey = `${s.guru ? s.guru.nama : s.guruId}:${s.kelas ? s.kelas.nama : (Number.isInteger(s.kelasId) ? s.kelasId : '—')}:${(s.mapel && s.mapel.kode) ? s.mapel.kode : (Number.isInteger(s.mapelId) ? s.mapelId : '—')}`;
      const existing = validsMap.get(labelKey);
      const jamSet = new Set(existing?.jamSet || []);
      jamUniq.forEach(n => jamSet.add(n));
      const fotoUrl = s.fotoPath ? (String(s.fotoPath).startsWith('/') ? s.fotoPath : `/${s.fotoPath}`) : null;
      const next = {
        waktu: !existing || new Date(s.createdAt).getTime() > new Date(existing.waktu).getTime() ? s.createdAt : existing.waktu,
        waktuKirim: !existing || new Date(s.createdAt).getTime() > new Date(existing.waktuKirim || 0).getTime() ? s.createdAt : existing.waktuKirim,
        guru: s.guru ? s.guru.nama : String(s.guruId),
        kelas: s.kelas ? s.kelas.nama : (Number.isInteger(s.kelasId) ? String(s.kelasId) : '—'),
        mapel: (s.mapel && s.mapel.kode) ? s.mapel.kode : (Number.isInteger(s.mapelId) ? String(s.mapelId) : '—'),
        jamSet,
        lokasiValid: (typeof s.isLocationValid === 'boolean') ? s.isLocationValid : (existing ? existing.lokasiValid : null),
        latitude: Number.isFinite(s.latitude) ? s.latitude : (existing ? existing.latitude : null),
        longitude: Number.isFinite(s.longitude) ? s.longitude : (existing ? existing.longitude : null),
        mapsUrl: (Number.isFinite(s.latitude) && Number.isFinite(s.longitude)) ? (`https://www.google.com/maps?q=${s.latitude},${s.longitude}`) : (existing ? existing.mapsUrl : null),
        fotoUrl: fotoUrl || (existing ? existing.fotoUrl : null),
      };
      validsMap.set(labelKey, next);
    }
  }
  const valids = Array.from(validsMap.values()).map(rec => ({
    ...rec,
    jamDikirim: (rec.jamSet && rec.jamSet.size) ? Array.from(rec.jamSet).sort((a,b)=>a-b).join(', ') : '—'
  })).sort((a,b) => new Date(b.waktu).getTime() - new Date(a.waktu).getTime());

  res.render('admin/realtime_print_valid', {
    titleDate,
    valids,
    school: (SCHOOL_SETTINGS && SCHOOL_SETTINGS.namaSekolah) ? SCHOOL_SETTINGS.namaSekolah : ''
  });
});

// Data Guru
app.get('/admin/guru', requireAdmin, async (req, res) => {
  const { page = '1', limit = '10', q = '', sort = 'nama', order = 'asc' } = req.query;
  // Backfill: pastikan MapelGuru mencerminkan seluruh pasangan (guru,mapel) yang memiliki jadwal
  try {
    const pairs = await prisma.jadwalMengajar.findMany({ select: { guruId: true, mapelId: true } });
    const uniq = new Set(pairs.map(p => `${p.guruId}:${p.mapelId}`));
    for (const key of Array.from(uniq)) {
      const [gid, mid] = key.split(':').map(Number);
      try {
        await prisma.mapelGuru.upsert({
          where: { guruId_mapelId: { guruId: gid, mapelId: mid } },
          update: {},
          create: { guruId: gid, mapelId: mid },
        });
      } catch (_) {}
    }
  } catch (_) {}
  // Tarik alokasi untuk memetakan menit -> jamKe
  const alokasi = await prisma.alokasiJamBelajar.findMany();
  const slotToJam = new Map();
  for (const a of alokasi) {
    if (typeof a.jamKe === 'number') {
      slotToJam.set(`${a.hari}:${a.mulaiMenit}:${a.selesaiMenit}`, a.jamKe);
    }
  }
  const guru = await prisma.guru.findMany({
    include: { jadwal: true, mapelGuru: { include: { mapel: true } } },
    orderBy: { nama: 'asc' },
  });
  let enriched = guru.map((g) => {
    const totalMapel = g.mapelGuru.length;
    // Total Jam dihitung dari jumlah slot jamKe unik (selaras dengan Grid)
    const jamSet = new Set();
    for (const j of g.jadwal) {
      const mapped = slotToJam.get(`${j.hari}:${j.mulaiMenit}:${j.selesaiMenit}`);
      if (typeof mapped === 'number') {
        jamSet.add(`${j.hari}:${mapped}`);
      }
      // Catatan: entri yang tidak terpetakan ke jamKe (mis. di luar alokasi/istirahat) diabaikan agar konsisten dengan tampilan Grid
    }
    const totalJam = jamSet.size;
    // Pengampu ditampilkan sebagai kode mapel saja (fallback ke nama jika kode kosong)
    const pengampuList = g.mapelGuru.map((mg) => (mg.mapel && mg.mapel.kode) ? mg.mapel.kode : ((mg.mapel && mg.mapel.nama) ? mg.mapel.nama : null)).filter(Boolean);
    const pengampu = Array.from(new Set(pengampuList)).join(', ');
    const uploadLink = `${process.env.APP_BASE_URL || 'http://localhost:3000'}/upload/${g.uploadToken}`;
    return { ...g, totalMapel, totalJam, pengampu, uploadLink };
  });
  const query = String(q || '').trim().toLowerCase();
  if (query) {
    enriched = enriched.filter((g) =>
      g.nama.toLowerCase().includes(query) ||
      (g.email ? g.email.toLowerCase().includes(query) : false)
    );
  }
  // Sorting
  const sortKey = String(sort || 'nama');
  const dir = String(order).toLowerCase() === 'desc' ? -1 : 1;
  enriched.sort((a, b) => {
    let va, vb;
    switch (sortKey) {
      case 'totalMapel':
        va = a.totalMapel; vb = b.totalMapel; break;
      case 'totalJam':
        va = Number(a.totalJam); vb = Number(b.totalJam); break;
      case 'nama':
      default:
        va = (a.nama || '').toLowerCase(); vb = (b.nama || '').toLowerCase();
    }
    if (va < vb) return -1 * dir;
    if (va > vb) return 1 * dir;
    return 0;
  });
  const pageNum = Math.max(1, parseInt(page));
  const lim = Math.max(1, parseInt(limit));
  const totalRows = enriched.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / lim));
  const startIdx = (pageNum - 1) * lim;
  const visibleRows = enriched.slice(startIdx, startIdx + lim).map((row, i) => ({
    ...row,
    no: startIdx + i + 1,
  }));
  res.render('admin/guru', { guru: visibleRows, page: pageNum, limit: lim, totalPages, totalRows, q: query, sort: sortKey, order: dir === -1 ? 'desc' : 'asc' });
});

// Jadwal Mengajar
app.get('/admin/jadwal', requireAdmin, async (req, res) => {
  const { page = '1', limit = '10', sort = 'guru', order = 'asc', q = '' } = req.query;
  const [jadwalRaw, guru, mapel, kelas, alokasi] = await Promise.all([
    prisma.jadwalMengajar.findMany({
      include: { guru: true, mapel: true, kelas: true },
      orderBy: [{ hari: 'asc' }, { mulaiMenit: 'asc' }],
    }),
    prisma.guru.findMany({ orderBy: { nama: 'asc' } }),
    prisma.mapel.findMany({ orderBy: { nama: 'asc' } }),
    prisma.kelas.findMany({ orderBy: [{ tingkat: 'asc' }, { nama: 'asc' }] }),
    prisma.alokasiJamBelajar.findMany(),
  ]);

  // Pemetaan slot waktu ke jamKe berdasarkan Alokasi Jam Belajar
  const slotToJam = new Map();
  for (const a of alokasi) {
    if (typeof a.jamKe === 'number') {
      slotToJam.set(`${a.hari}:${a.mulaiMenit}:${a.selesaiMenit}`, a.jamKe);
    }
  }

  // Hitung jamKe: coba dari alokasi; fallback ke penomoran per (guru,hari)
  const counter = new Map();
  const jadwal = jadwalRaw.map(j => {
    const mapped = slotToJam.get(`${j.hari}:${j.mulaiMenit}:${j.selesaiMenit}`);
    if (typeof mapped === 'number') {
      return { ...j, jamKe: mapped };
    }
    const key = `${j.guruId}:${j.hari}`;
    const n = (counter.get(key) || 0) + 1;
    counter.set(key, n);
    return { ...j, jamKe: n };
  });

  // Bentuk rows untuk tabel dan aksi edit/hapus
  let rowsBase = jadwal.map(j => ({
    id: j.id,
    guruId: j.guruId,
    mapelId: j.mapelId,
    kelasId: j.kelasId,
    hari: j.hari,
    mulaiMenit: j.mulaiMenit,
    selesaiMenit: j.selesaiMenit,
    guruNama: j.guru.nama,
    tingkat: j.kelas.tingkat || '',
    kelasNama: j.kelas.nama,
    mapelNama: j.mapel.nama,
    jamKe: j.jamKe,
    no: 0,
  }));

  // Filter pencarian
  const query = String(q || '').trim().toLowerCase();
  if (query) {
    rowsBase = rowsBase.filter(r =>
      r.guruNama.toLowerCase().includes(query) ||
      r.tingkat.toLowerCase().includes(query) ||
      r.kelasNama.toLowerCase().includes(query) ||
      r.mapelNama.toLowerCase().includes(query)
    );
  }

  // Kelompokkan per (guruId, kelasId, hari, mapelId), gabungkan jamKe berurutan
  const groupMap = new Map();
  for (const r of rowsBase) {
    const key = `${r.guruId}:${r.kelasId}:${r.hari}:${r.mapelId}`;
    let g = groupMap.get(key);
    if (!g) {
      g = {
        id: r.id, // ambil id pertama sebagai representasi baris
        guruId: r.guruId,
        mapelId: r.mapelId,
        kelasId: r.kelasId,
        hari: r.hari,
        mulaiMenit: r.mulaiMenit,
        selesaiMenit: r.selesaiMenit,
        guruNama: r.guruNama,
        tingkat: r.tingkat,
        kelasNama: r.kelasNama,
        mapelNama: r.mapelNama,
        jamList: [],
        no: 0,
      };
      groupMap.set(key, g);
    }
    if (Number.isFinite(r.jamKe)) g.jamList.push(Number(r.jamKe));
    // Update rentang waktu minimal/maksimal
    g.mulaiMenit = Math.min(g.mulaiMenit, r.mulaiMenit);
    g.selesaiMenit = Math.max(g.selesaiMenit, r.selesaiMenit);
  }
  let rows = Array.from(groupMap.values()).map(g => {
    const unique = Array.from(new Set((g.jamList || []).map(Number)));
    const jamSorted = unique.slice().sort((a,b)=>a-b);
    return { ...g, jamKe: jamSorted.join(',') };
  });

  // Sorting
  const tingkatOrder = { 'X': 1, 'XI': 2, 'XII': 3 };
  const comparators = {
    guru: (a, b) => a.guruNama.localeCompare(b.guruNama),
    tingkat: (a, b) => (tingkatOrder[a.tingkat] || 99) - (tingkatOrder[b.tingkat] || 99),
    kelas: (a, b) => a.kelasNama.localeCompare(b.kelasNama),
    mapel: (a, b) => a.mapelNama.localeCompare(b.mapelNama),
    jamKe: (a, b) => {
      const firstA = String(a.jamKe || '').split(',').map(n=>parseInt(n,10)).filter(n=>!isNaN(n)).sort((x,y)=>x-y)[0] || 0;
      const firstB = String(b.jamKe || '').split(',').map(n=>parseInt(n,10)).filter(n=>!isNaN(n)).sort((x,y)=>x-y)[0] || 0;
      return firstA - firstB;
    },
  };
  const cmp = comparators[sort] || comparators.guru;
  rows.sort(cmp);
  if (String(order).toLowerCase() === 'desc') rows.reverse();

  // Paginasi
  const pageNum = Math.max(1, parseInt(page));
  const lim = Math.max(1, parseInt(limit));
  const totalRows = rows.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / lim));
  const startIdx = (pageNum - 1) * lim;
  const visible = rows.slice(startIdx, startIdx + lim).map((r, i) => ({ ...r, no: startIdx + i + 1 }));

  res.render('admin/jadwal', {
    rows: visible,
    page: pageNum,
    limit: lim,
    totalPages,
    totalRows,
    q,
    sort,
    order,
    guru,
    mapel,
    kelas,
    importedAsc: req.query.importedAsc || undefined,
    skippedAsc: req.query.skippedAsc || undefined,
    failedAsc: req.query.failedAsc || undefined,
    bulkDeleted: req.query.bulkDeleted || undefined,
    bulkFailed: req.query.bulkFailed || undefined,
  });
});

// Form grid input Jadwal per Guru (rows = hari, cols = jam pelajaran)
app.get('/admin/jadwal/input-grid', requireAdmin, async (req, res) => {
  const [guru, mapel, kelas, alokasi] = await Promise.all([
    prisma.guru.findMany({ orderBy: { nama: 'asc' } }),
    prisma.mapel.findMany({ orderBy: { nama: 'asc' } }),
    prisma.kelas.findMany({ orderBy: [{ tingkat: 'asc' }, { nama: 'asc' }] }),
    prisma.alokasiJamBelajar.findMany(),
  ]);

  // Persiapan label waktu per kolom jam dan penanda istirahat
  const toHHMM = (m) => `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;
  const maxJam = 10;

  // Ambil label waktu untuk setiap jamKe dari seluruh alokasi (abaikan hari)
  const jamTimeMap = new Map();
  const breakSet = new Set();
  for (const a of alokasi) {
    if (typeof a.jamKe === 'number' && a.jamKe >= 1 && a.jamKe <= 12) {
      if (!jamTimeMap.has(a.jamKe)) {
        jamTimeMap.set(a.jamKe, { mulaiMenit: a.mulaiMenit, selesaiMenit: a.selesaiMenit });
      }
    } else {
      // Slot istirahat (tanpa jamKe)
      const key = `${a.mulaiMenit}-${a.selesaiMenit}`;
      breakSet.add(key);
    }
  }
  const jamLabels = Array.from({ length: maxJam }, (_, i) => {
    const slot = jamTimeMap.get(i + 1);
    return slot ? `${toHHMM(slot.mulaiMenit)}–${toHHMM(slot.selesaiMenit)}` : null;
  });
  const breaks = Array.from(breakSet).map(k => {
    const [mulai, selesai] = k.split('-').map(n => parseInt(n, 10));
    return `${toHHMM(mulai)}–${toHHMM(selesai)}`;
  });

  // Prefill grid jika guruId diberikan (edit jadwal seperti input grid)
  const selectedGuruIdRaw = req.query.guruId;
  const selectedGuruId = parseInt(String(selectedGuruIdRaw || ''), 10);
  let prefillGrid = {};
  let selectedGuruName = '';
  if (Number.isInteger(selectedGuruId)) {
    // Mapping alokasi per hari:jamKe -> waktu untuk mendeteksi jamKe dari jadwal
    const alokasiMap = new Map();
    for (const a of alokasi) {
      if (typeof a.jamKe !== 'number') continue;
      alokasiMap.set(`${a.hari}:${a.jamKe}`, { mulaiMenit: a.mulaiMenit, selesaiMenit: a.selesaiMenit });
    }
    const jadwalGuru = await prisma.jadwalMengajar.findMany({ where: { guruId: selectedGuruId } });
    for (const j of jadwalGuru) {
      let foundJamKe = null;
      for (let ke = 1; ke <= maxJam; ke++) {
        const slot = alokasiMap.get(`${j.hari}:${ke}`);
        if (slot && slot.mulaiMenit === j.mulaiMenit && slot.selesaiMenit === j.selesaiMenit) {
          foundJamKe = ke; break;
        }
      }
      if (foundJamKe !== null) {
        prefillGrid[`${j.hari}:${foundJamKe}`] = { kelasId: j.kelasId, mapelId: j.mapelId };
      }
    }
    const gObj = (guru || []).find(g => g.id === selectedGuruId);
    selectedGuruName = gObj ? gObj.nama : '';
  }

  res.render('admin/jadwal_grid', {
    guru,
    mapel,
    kelas,
    maxJam,
    jamLabels,
    breaks,
    selectedGuruId: Number.isInteger(selectedGuruId) ? selectedGuruId : undefined,
    selectedGuruName: selectedGuruName || undefined,
    prefillGrid,
    created: req.query.created || undefined,
    skipped: req.query.skipped || undefined,
    missing: req.query.missing || undefined,
    failed: req.query.failed || undefined,
  });
});

// Template CSV untuk impor Jadwal Pelajaran
app.get('/admin/jadwal/template.csv', requireAdmin, async (req, res) => {
  return res.status(404).send('Template CSV Jadwal dinonaktifkan.');
});

// Fallback endpoint tanpa ekstensi untuk template Jadwal
app.get('/admin/jadwal/template', requireAdmin, async (req, res) => {
  return res.status(404).send('Template CSV Jadwal dinonaktifkan.');
});

app.post('/admin/jadwal', requireAdmin, async (req, res) => {
  const { guruId, mapelId, kelasId, hari, mulai, selesai } = req.body;
  function toMinutes(hhmm) {
    const [h, m] = String(hhmm).split(':').map(Number);
    return (h * 60) + (m || 0);
  }
  if (!guruId || !mapelId || !kelasId || typeof hari === 'undefined' || !mulai || !selesai) {
    return res.status(400).send('Lengkapi form jadwal.');
  }
  try {
    await prisma.jadwalMengajar.create({
      data: {
        guruId: Number(guruId),
        mapelId: Number(mapelId),
        kelasId: Number(kelasId),
        hari: Number(hari),
        mulaiMenit: toMinutes(mulai),
        selesaiMenit: toMinutes(selesai),
      },
    });
    // Sinkronisasi pengampu mapel untuk Data Guru
    try {
      await prisma.mapelGuru.upsert({
        where: { guruId_mapelId: { guruId: Number(guruId), mapelId: Number(mapelId) } },
        update: {},
        create: { guruId: Number(guruId), mapelId: Number(mapelId) },
      });
    } catch (_) {}
    res.redirect('/admin/jadwal');
  } catch (e) {
    res.status(500).send('Gagal menyimpan jadwal: ' + e.message);
  }
});

// Halaman Input Jadwal (Form) dengan cekbox jam ke
app.get('/admin/jadwal/input-form', requireAdmin, async (req, res) => {
  const [guru, mapel, kelas, alokasi] = await Promise.all([
    prisma.guru.findMany({ orderBy: { nama: 'asc' } }),
    prisma.mapel.findMany({ orderBy: { nama: 'asc' } }),
    prisma.kelas.findMany({ orderBy: [{ tingkat: 'asc' }, { nama: 'asc' }] }),
    prisma.alokasiJamBelajar.findMany(),
  ]);
  // Distinct tingkat dari kelas
  const tingkatList = Array.from(new Set((kelas || []).map(k => k.tingkat).filter(t => t != null))).sort((a, b) => a - b);
  const toHHMM = (m) => `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;
  const maxJam = 10;
  // Buat label waktu per hari untuk setiap jam Ke
  const jamLabelsByDay = {};
  for (let h=1; h<=6; h++) jamLabelsByDay[h] = Array.from({ length: maxJam }, () => null);
  for (const a of alokasi) {
    if (typeof a.jamKe === 'number' && a.jamKe >= 1 && a.jamKe <= maxJam) {
      jamLabelsByDay[a.hari][a.jamKe - 1] = `${toHHMM(a.mulaiMenit)}–${toHHMM(a.selesaiMenit)}`;
    }
  }

  const selectedGuruId = parseInt(String(req.query.guruId || ''), 10);
  let rows = [];
  if (Number.isInteger(selectedGuruId)) {
    const all = await prisma.jadwalMengajar.findMany({
      where: { guruId: selectedGuruId },
      include: { guru: true, mapel: true, kelas: true },
      orderBy: [{ hari: 'asc' }, { mulaiMenit: 'asc' }],
    });
    rows = all.map(a => ({
      id: a.id,
      guruId: a.guruId,
      guruNama: a.guru?.nama || (guru.find(g => g.id === a.guruId)?.nama || '-'),
      tingkat: a.kelas?.tingkat || (kelas.find(k => k.id === a.kelasId)?.tingkat || null),
      kelasId: a.kelasId,
      kelasNama: a.kelas?.nama || (kelas.find(k => k.id === a.kelasId)?.nama || '-'),
      mapelId: a.mapelId,
      mapelNama: a.mapel?.nama || (mapel.find(m => m.id === a.mapelId)?.nama || '-'),
      hari: a.hari,
      mulaiMenit: a.mulaiMenit,
      selesaiMenit: a.selesaiMenit,
    }));
  }

  res.render('admin/jadwal_form', {
    guru,
    mapel,
    kelas,
    tingkatList,
    jamLabelsByDay,
    rows,
    selectedGuruId: Number.isInteger(selectedGuruId) ? selectedGuruId : undefined,
    created: req.query.created || undefined,
    skipped: req.query.skipped || undefined,
    missing: req.query.missing || undefined,
    failed: req.query.failed || undefined,
  });
});

// Simpan jadwal dari form dengan cekbox jam ke
app.post('/admin/jadwal/input-form', requireAdmin, async (req, res) => {
  try {
    const guruId = parseInt(String(req.body.guruId || ''), 10);
    const kelasId = parseInt(String(req.body.kelasId || ''), 10);
    const mapelId = parseInt(String(req.body.mapelId || ''), 10);
    const hari = parseInt(String(req.body.hari || ''), 10);
    let jamKeList = req.body.jamKe || req.body['jamKe[]'] || [];
    if (!Array.isArray(jamKeList)) jamKeList = [jamKeList];
    const jamKeNums = jamKeList
      .map(v => parseInt(String(v), 10))
      .filter(n => Number.isInteger(n) && n >= 1 && n <= 10);

    if (!Number.isInteger(guruId) || !Number.isInteger(kelasId) || !Number.isInteger(mapelId) || !Number.isInteger(hari)) {
      return res.status(400).send('Lengkapi form: guru, tingkat/kelas, mapel, hari, jam ke.');
    }
    if (!jamKeNums.length) {
      return res.status(400).send('Pilih minimal satu Jam Ke.');
    }

    // Mapping alokasi untuk hari terpilih
    const alokasi = await prisma.alokasiJamBelajar.findMany({ where: { hari } });
    const alokasiMap = new Map();
    for (const a of alokasi) {
      if (typeof a.jamKe !== 'number') continue;
      alokasiMap.set(a.jamKe, { mulaiMenit: a.mulaiMenit, selesaiMenit: a.selesaiMenit });
    }

    let created = 0, skipped = 0, missing = 0, failed = 0;
    for (const jamKe of jamKeNums) {
      const slot = alokasiMap.get(jamKe);
      if (!slot) { missing++; continue; }
      try {
        const exists = await prisma.jadwalMengajar.findFirst({
          where: { guruId, hari, mulaiMenit: slot.mulaiMenit, selesaiMenit: slot.selesaiMenit },
        });
        if (exists) { skipped++; continue; }
        await prisma.jadwalMengajar.create({
          data: { guruId, mapelId, kelasId, hari, mulaiMenit: slot.mulaiMenit, selesaiMenit: slot.selesaiMenit },
        });
        created++;
      } catch (e) {
        failed++;
      }
    }

    // Pastikan relasi MapelGuru tersinkron
    try {
      await prisma.mapelGuru.upsert({
        where: { guruId_mapelId: { guruId, mapelId } },
        update: {},
        create: { guruId, mapelId },
      });
    } catch (_) {}

    return res.redirect(`/admin/jadwal/input-form?guruId=${guruId}&created=${created}&skipped=${skipped}&missing=${missing}&failed=${failed}`);
  } catch (e) {
    return res.status(500).send('Gagal menyimpan jadwal dari form: ' + (e && e.message ? e.message : e));
  }
});

// Simpan input grid Jadwal per Guru
app.post('/admin/jadwal/input-grid', requireAdmin, async (req, res) => {
  try {
    const guruId = parseInt(String(req.body.guruId || ''));
    if (!Number.isInteger(guruId)) return res.status(400).send('Guru wajib dipilih.');

    // Tarik alokasi jam untuk mapping waktu
    const alokasi = await prisma.alokasiJamBelajar.findMany();
    const alokasiMap = new Map();
    for (const a of alokasi) {
      if (typeof a.jamKe !== 'number') continue;
      alokasiMap.set(`${a.hari}:${a.jamKe}`, { mulaiMenit: a.mulaiMenit, selesaiMenit: a.selesaiMenit });
    }

    let created = 0, skipped = 0, missing = 0, failed = 0;
    const upsertMapelSet = new Set();
    // Loop hanya hari Senin–Sabtu (1–6) sesuai permintaan
    for (let hari = 1; hari <= 6; hari++) {
      for (let jamKe = 1; jamKe <= 10; jamKe++) {
        const kelasIdRaw = req.body[`kelas_${hari}_${jamKe}`];
        const mapelIdRaw = req.body[`mapel_${hari}_${jamKe}`];
        const kelasId = parseInt(String(kelasIdRaw || ''));
        const mapelId = parseInt(String(mapelIdRaw || ''));
        if (!Number.isInteger(kelasId) || !Number.isInteger(mapelId)) continue; // kosong
        upsertMapelSet.add(mapelId);

        const slot = alokasiMap.get(`${hari}:${jamKe}`);
        if (!slot) { missing++; continue; }

        try {
          // Cek duplikat jadwal untuk guru pada waktu yang sama
          const exists = await prisma.jadwalMengajar.findFirst({
            where: { guruId, hari, mulaiMenit: slot.mulaiMenit, selesaiMenit: slot.selesaiMenit },
          });
          if (exists) { skipped++; continue; }

          await prisma.jadwalMengajar.create({
            data: { guruId, mapelId, kelasId, hari, mulaiMenit: slot.mulaiMenit, selesaiMenit: slot.selesaiMenit },
          });
          created++;
        } catch (e) {
          failed++;
        }
      }
    }
    // Sinkronisasi semua mapel yang dipilih di grid ke MapelGuru
    try {
      for (const mid of Array.from(upsertMapelSet)) {
        await prisma.mapelGuru.upsert({
          where: { guruId_mapelId: { guruId, mapelId: Number(mid) } },
          update: {},
          create: { guruId, mapelId: Number(mid) },
        });
      }
    } catch (_) {}
    return res.redirect(`/admin/jadwal/input-grid?created=${created}&skipped=${skipped}&missing=${missing}&failed=${failed}`);
  } catch (e) {
    return res.status(500).send('Gagal menyimpan jadwal grid: ' + (e && e.message ? e.message : e));
  }
});

app.post('/admin/jadwal/delete/:id', requireAdmin, async (req, res) => {
  try {
    const idNum = Number(req.params.id);
    const rec = await prisma.jadwalMengajar.findUnique({ where: { id: idNum } });
    if (rec) {
      await prisma.jadwalMengajar.delete({ where: { id: idNum } });
      const remain = await prisma.jadwalMengajar.findFirst({ where: { guruId: rec.guruId, mapelId: rec.mapelId } });
      if (!remain) {
        try {
          await prisma.mapelGuru.delete({ where: { guruId_mapelId: { guruId: rec.guruId, mapelId: rec.mapelId } } });
        } catch (_) {}
      }
    }
    res.redirect('/admin/jadwal');
  } catch (e) {
    res.status(500).send('Gagal menghapus jadwal: ' + e.message);
  }
});

// Bulk delete Jadwal
app.post('/admin/jadwal/bulk-delete', requireAdmin, async (req, res) => {
  try {
    let ids = req.body.ids || req.body['ids[]'];
    if (!ids) return res.redirect('/admin/jadwal');
    if (!Array.isArray(ids)) ids = [ids];
    const idNums = ids.map(v => Number(String(v))).filter(n => Number.isInteger(n));
    if (idNums.length === 0) return res.redirect('/admin/jadwal');
    // Ambil pasangan (guruId,mapelId) sebelum dihapus untuk pembersihan MapelGuru
    const pairs = await prisma.jadwalMengajar.findMany({
      where: { id: { in: idNums } },
      select: { guruId: true, mapelId: true },
    });
    const result = await prisma.jadwalMengajar.deleteMany({ where: { id: { in: idNums } } });
    const deleted = typeof result === 'number' ? result : (result && result.count) ? result.count : 0;
    // Bersihkan MapelGuru jika tidak ada jadwal tersisa untuk pasangan tersebut
    try {
      const uniq = new Set(pairs.map(p => `${p.guruId}:${p.mapelId}`));
      for (const key of Array.from(uniq)) {
        const [gid, mid] = key.split(':').map(Number);
        const remain = await prisma.jadwalMengajar.findFirst({ where: { guruId: gid, mapelId: mid } });
        if (!remain) {
          try {
            await prisma.mapelGuru.delete({ where: { guruId_mapelId: { guruId: gid, mapelId: mid } } });
          } catch (_) {}
        }
      }
    } catch (_) {}
    res.redirect(`/admin/jadwal?bulkDeleted=${deleted}&bulkFailed=0`);
  } catch (e) {
    res.redirect('/admin/jadwal?bulkDeleted=0&bulkFailed=1');
  }
});

app.post('/admin/jadwal/edit/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const { guruId, mapelId, kelasId, hari, mulai, selesai } = req.body;
  function toMinutes(hhmm) {
    const [h, m] = String(hhmm).split(':').map(Number);
    return (h * 60) + (m || 0);
  }

  try {
    const gid = parseInt(String(guruId));
    const mid = parseInt(String(mapelId));
    const kid = parseInt(String(kelasId));
    const day = parseInt(String(hari));

    // Dukung multi jamKe[] dari modal edit
    let jamKeList = req.body.jamKe || req.body['jamKe[]'] || [];
    if (!Array.isArray(jamKeList)) jamKeList = [jamKeList];
    const jamKeNums = jamKeList
      .map(v => parseInt(String(v), 10))
      .filter(n => Number.isInteger(n) && n >= 1 && n <= 10);

    if (jamKeNums.length > 0) {
      // Validasi field dasar
      if (!Number.isInteger(gid) || !Number.isInteger(mid) || !Number.isInteger(kid) || !Number.isInteger(day)) {
        return res.status(400).send('Lengkapi form edit jadwal (guru/mapel/kelas/hari).');
      }
      // Tarik alokasi untuk hari terpilih
      const alokasi = await prisma.alokasiJamBelajar.findMany({ where: { hari: day } });
      const alokasiMap = new Map(); // jamKe -> {mulaiMenit, selesaiMenit}
      for (const a of alokasi) {
        if (typeof a.jamKe !== 'number') continue;
        alokasiMap.set(a.jamKe, { mulaiMenit: a.mulaiMenit, selesaiMenit: a.selesaiMenit });
      }

      // Buat/Update record untuk semua jamKe terpilih
      for (const ke of jamKeNums) {
        const slot = alokasiMap.get(ke);
        if (!slot) continue; // jamKe tidak punya slot waktu
        const existing = await prisma.jadwalMengajar.findFirst({
          where: { guruId: gid, hari: day, mulaiMenit: slot.mulaiMenit, selesaiMenit: slot.selesaiMenit },
        });
        if (existing) {
          await prisma.jadwalMengajar.update({
            where: { id: existing.id },
            data: { guruId: gid, mapelId: mid, kelasId: kid, hari: day, mulaiMenit: slot.mulaiMenit, selesaiMenit: slot.selesaiMenit },
          });
        } else {
          await prisma.jadwalMengajar.create({
            data: { guruId: gid, mapelId: mid, kelasId: kid, hari: day, mulaiMenit: slot.mulaiMenit, selesaiMenit: slot.selesaiMenit },
          });
        }
      }

      // Hapus record grup yang tidak lagi dipilih (rapikan grup target)
      const groupRecords = await prisma.jadwalMengajar.findMany({ where: { guruId: gid, mapelId: mid, kelasId: kid, hari: day } });
      for (const rec of groupRecords) {
        let foundJam = null;
        for (const [ke, slot] of alokasiMap.entries()) {
          if (slot.mulaiMenit === rec.mulaiMenit && slot.selesaiMenit === rec.selesaiMenit) { foundJam = ke; break; }
        }
        if (foundJam && !jamKeNums.includes(foundJam)) {
          await prisma.jadwalMengajar.delete({ where: { id: rec.id } });
        }
      }

      // Dedup: pastikan satu record per slot waktu dalam grup yang sama
      const refreshed = await prisma.jadwalMengajar.findMany({ where: { guruId: gid, mapelId: mid, kelasId: kid, hari: day } });
      const byTime = new Map();
      for (const rec of refreshed) {
        const key = `${rec.mulaiMenit}-${rec.selesaiMenit}`;
        if (byTime.has(key)) {
          // Hapus duplikat yang memiliki slot waktu identik
          try { await prisma.jadwalMengajar.delete({ where: { id: rec.id } }); } catch (_) {}
        } else {
          byTime.set(key, rec.id);
        }
      }
      // Pastikan MapelGuru terbuat untuk pasangan guru-mapel ini
      try {
        await prisma.mapelGuru.upsert({
          where: { guruId_mapelId: { guruId: gid, mapelId: mid } },
          update: {},
          create: { guruId: gid, mapelId: mid },
        });
      } catch (_) {}
      return res.redirect('/admin/jadwal');
    }

    // Fallback: update satu record berdasarkan HH:MM (tanpa jamKe[])
    if (!guruId || !mapelId || !kelasId || typeof hari === 'undefined' || !mulai || !selesai) {
      return res.status(400).send('Lengkapi form edit jadwal.');
    }
    await prisma.jadwalMengajar.update({
      where: { id },
      data: {
        guruId: Number(guruId),
        mapelId: Number(mapelId),
        kelasId: Number(kelasId),
        hari: Number(hari),
        mulaiMenit: toMinutes(mulai),
        selesaiMenit: toMinutes(selesai),
      },
    });
    res.redirect('/admin/jadwal');
  } catch (e) {
    res.status(500).send('Gagal mengedit jadwal: ' + e.message);
  }
});

// Alokasi Jam Belajar
app.get('/admin/alokasi', requireAdmin, async (req, res) => {
  const { page = '1', limit = '10', sort = 'hari', order = 'asc', q = '' } = req.query;
  const hariMap = ['Ahad','Senin','Selasa','Rabu','Kamis','Jumat','Sabtu'];

  // Filter hari via query (days can be CSV or multiple values)
  const daysParam = req.query.days;
  let selectedDays = [];
  if (Array.isArray(daysParam)) {
    selectedDays = daysParam
      .map(d => parseInt(d))
      .filter(n => Number.isInteger(n) && n >= 1 && n <= 6);
  } else {
    const csv = String(daysParam || '').trim();
    if (csv) {
      selectedDays = csv.split(',')
        .map(d => parseInt(d))
        .filter(n => Number.isInteger(n) && n >= 1 && n <= 6);
    }
  }

  const all = await prisma.alokasiJamBelajar.findMany();

  // Bentuk rows untuk tabel
  let rows = all.map(a => ({
    id: a.id,
    hari: a.hari,
    jamKe: typeof a.jamKe === 'number' ? a.jamKe : null,
    mulaiMenit: a.mulaiMenit,
    selesaiMenit: a.selesaiMenit,
    keterangan: a.keterangan || '',
    no: 0,
  }));

  // Filter berdasarkan hari jika dipilih
  if (selectedDays.length) {
    rows = rows.filter(r => selectedDays.includes(r.hari));
  }

  // Filter berdasarkan jamKe (1–10) jika dipilih melalui query 'jam'
  const jamParam = req.query.jam;
  let selectedJam = [];
  if (Array.isArray(jamParam)) {
    selectedJam = jamParam
      .map(d => parseInt(d))
      .filter(n => Number.isInteger(n) && n >= 1 && n <= 10);
  } else {
    const csvJam = String(jamParam || '').trim();
    if (csvJam) {
      selectedJam = csvJam.split(',')
        .map(d => parseInt(d))
        .filter(n => Number.isInteger(n) && n >= 1 && n <= 10);
    }
  }
  if (selectedJam.length) {
    rows = rows.filter(r => (typeof r.jamKe === 'number') && selectedJam.includes(r.jamKe));
  }

  // Filter pencarian
  const query = String(q || '').trim().toLowerCase();
  if (query) {
    rows = rows.filter(r =>
      (hariMap[r.hari] || '').toLowerCase().includes(query) ||
      String(r.jamKe || '').includes(query) ||
      r.keterangan.toLowerCase().includes(query)
    );
  }

  // Sorting
  const comparators = {
    // Secondary sort untuk konsistensi tampilan
    hari: (a, b) => (a.hari - b.hari) || ((a.jamKe || 0) - (b.jamKe || 0)) || (a.mulaiMenit - b.mulaiMenit) || (a.selesaiMenit - b.selesaiMenit),
    jamKe: (a, b) => ((a.jamKe || 0) - (b.jamKe || 0)) || (a.hari - b.hari) || (a.mulaiMenit - b.mulaiMenit),
    mulai: (a, b) => (a.mulaiMenit - b.mulaiMenit) || (a.hari - b.hari) || ((a.jamKe || 0) - (b.jamKe || 0)),
    selesai: (a, b) => (a.selesaiMenit - b.selesaiMenit) || (a.hari - b.hari) || ((a.jamKe || 0) - (b.jamKe || 0)),
    keterangan: (a, b) => (a.keterangan || '').localeCompare(b.keterangan || '') || (a.hari - b.hari) || ((a.jamKe || 0) - (b.jamKe || 0)) || (a.mulaiMenit - b.mulaiMenit),
  };
  const sortKey = String(sort || 'hari');
  const dir = String(order).toLowerCase() === 'desc' ? -1 : 1;
  const cmp = comparators[sortKey] || comparators.hari;
  rows.sort((a, b) => dir * cmp(a, b));
  // Debug: log current sort params and first 10 day indices to verify sorting behavior
  try {
    const sample = rows.slice(0, 10).map(r => r.hari);
    console.log(`[Alokasi] sortKey=${sortKey} order=${order} dir=${dir} sampleHariFirst10=` + JSON.stringify(sample));
  } catch (_) {}

  // Paginasi (parsing defensif)
  const pageNumRaw = parseInt(String(page), 10);
  const pageNum = Number.isFinite(pageNumRaw) && pageNumRaw > 0 ? pageNumRaw : 1;
  const limitRaw = parseInt(String(limit), 10);
  const lim = Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : 10;
  const totalRows = rows.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / lim));
  const startIdx = (pageNum - 1) * lim;
  const visible = rows.slice(startIdx, startIdx + lim).map((r, i) => ({ ...r, no: startIdx + i + 1 }));

  // Jika ada query edit, ambil data yang akan diedit
  let editing = null;
  const editIdParam = req.query.edit;
  if (typeof editIdParam !== 'undefined') {
    const editId = parseInt(String(editIdParam));
    if (Number.isInteger(editId)) {
      try {
        const e = await prisma.alokasiJamBelajar.findUnique({ where: { id: editId } });
        if (e) editing = e;
      } catch (_) {}
    }
  }

  res.render('admin/alokasi', {
    alokasi: visible,
    page: pageNum,
    limit: lim,
    totalPages,
    totalRows,
    sort,
    order,
    q: query,
    selectedDays,
    selectedJam,
    editing,
    bulkDeleted: req.query.bulkDeleted || undefined,
    bulkFailed: req.query.bulkFailed || undefined,
  });
});

// Endpoint JSON detail alokasi jam berdasarkan ID
app.get('/admin/alokasi/:id', requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'ID tidak valid' });
    const a = await prisma.alokasiJamBelajar.findUnique({ where: { id } });
    if (!a) return res.status(404).json({ error: 'Data tidak ditemukan' });
    res.json({
      id: a.id,
      hari: a.hari,
      jamKe: (typeof a.jamKe === 'number') ? a.jamKe : null,
      mulaiMenit: a.mulaiMenit,
      selesaiMenit: a.selesaiMenit,
      keterangan: a.keterangan || ''
    });
  } catch (e) {
    res.status(500).json({ error: 'Gagal mengambil data: ' + (e && e.message ? e.message : e) });
  }
});

app.post('/admin/alokasi', requireAdmin, async (req, res) => {
  const { hari, mulai, selesai, keterangan, jamKe } = req.body;
  function toMinutes(hhmm) {
    const [h, m] = String(hhmm).split(':').map(Number);
    return (h * 60) + (m || 0);
  }
  const selectedDays = Array.isArray(hari) ? hari : (hari ? [hari] : []);
  if (!selectedDays.length || !mulai || !selesai) {
    return res.status(400).send('Lengkapi form alokasi.');
  }
  const mulaiMenit = toMinutes(mulai);
  const selesaiMenit = toMinutes(selesai);
  if (selesaiMenit <= mulaiMenit) {
    return res.status(400).send('Waktu selesai harus lebih besar dari waktu mulai.');
  }
  const jamKeNum = Number(jamKe);
  if (!Number.isInteger(jamKeNum) || jamKeNum < 1 || jamKeNum > 12) {
    return res.status(400).send('Jam Ke harus antara 1 hingga 12.');
  }
  try {
    const payloads = selectedDays.map(d => ({
      hari: Number(d),
      mulaiMenit,
      selesaiMenit,
      jamKe: jamKeNum,
      keterangan: keterangan || null,
    }));
    // Buat entri untuk setiap hari yang dipilih; abaikan duplicate jika ada constraint unik
    await Promise.all(payloads.map(p =>
      prisma.alokasiJamBelajar.create({ data: p }).catch(e => {
        if (e && e.code === 'P2002') {
          return null; // skip duplicate jika terdeteksi oleh database
        }
        throw e;
      })
    ));
    res.redirect('/admin/alokasi');
  } catch (e) {
    res.status(500).send('Gagal menyimpan alokasi: ' + (e && e.message ? e.message : e));
  }
});

// Terapkan preset Alokasi Jam sesuai gambar yang diunggah (Senin–Kamis & Sabtu; Jumat)
// Endpoint preset alokasi jam dinonaktifkan (dihapus). Jika diakses, kembalikan 404.
app.post('/admin/alokasi/preset', requireAdmin, (req, res) => {
  res.status(404).send('Preset alokasi jam tidak tersedia.');
});

app.post('/admin/alokasi/delete/:id', requireAdmin, async (req, res) => {
  try {
    await prisma.alokasiJamBelajar.delete({ where: { id: Number(req.params.id) } });
    res.redirect('/admin/alokasi');
  } catch (e) {
    res.status(500).send('Gagal menghapus alokasi: ' + e.message);
  }
});

// Bulk delete Alokasi
app.post('/admin/alokasi/bulk-delete', requireAdmin, async (req, res) => {
  try {
    let ids = req.body.ids || req.body['ids[]'];
    if (!ids) return res.redirect('/admin/alokasi');
    if (!Array.isArray(ids)) ids = [ids];
    const idNums = ids.map(v => Number(String(v))).filter(n => Number.isInteger(n));
    if (idNums.length === 0) return res.redirect('/admin/alokasi');
    const result = await prisma.alokasiJamBelajar.deleteMany({ where: { id: { in: idNums } } });
    const deleted = typeof result === 'number' ? result : (result && result.count) ? result.count : 0;
    res.redirect(`/admin/alokasi?bulkDeleted=${deleted}&bulkFailed=0`);
  } catch (e) {
    res.redirect('/admin/alokasi?bulkDeleted=0&bulkFailed=1');
  }
});

// Laporan CSV (mendukung rentang tanggal)
app.get('/admin/laporan.csv', requireAdmin, async (req, res) => {
  const { tanggal = '', start: startQ = '', end: endQ = '', guruId = '', kelasId = '', hari = '', jamKe = '' } = req.query;
  let start, end, refDate;
  if (startQ || endQ) {
    const s = startQ ? new Date(String(startQ)) : new Date();
    const e = endQ ? new Date(String(endQ)) : new Date();
    start = startOfDay(s);
    end = endOfDay(e);
    refDate = e;
  } else {
    const d = tanggal ? new Date(String(tanggal)) : new Date();
    start = startOfDay(d);
    end = endOfDay(d);
    refDate = d;
  }

  const semuaGuru = await prisma.guru.findMany({ orderBy: { nama: 'asc' } });
  const semuaKelas = await prisma.kelas.findMany({ orderBy: { nama: 'asc' } });

  const effectiveDay = (hari !== '' && hari !== undefined && hari !== 'all') ? Math.max(0, Math.min(6, parseInt(hari))) : (refDate.getDay());
  const jadwalHari = await prisma.jadwalMengajar.findMany({
    where: { hari: effectiveDay },
    orderBy: { mulaiMenit: 'asc' },
  });
  const byGuru = jadwalHari.reduce((acc, j) => { (acc[j.guruId] ||= []).push(j); return acc; }, {});
  Object.values(byGuru).forEach(list => list.sort((a,b) => a.mulaiMenit - b.mulaiMenit));
  const jamInfoByGuru = {};
  for (const [gidStr, list] of Object.entries(byGuru)) {
    const gid = Number(gidStr);
    jamInfoByGuru[gid] = list.map((j, idx) => ({ kelasId: j.kelasId, jamKe: idx + 1 }));
  }

  const kelasById = Object.fromEntries(semuaKelas.map(k => [k.id, k.nama]));

  const guruIdNum = guruId ? parseInt(guruId) : null;
  const kelasIdNum = kelasId ? parseInt(kelasId) : null;
  const jamKeNum = jamKe ? parseInt(jamKe) : null;

  let guruSumber = semuaGuru;
  if (guruIdNum) {
    guruSumber = guruSumber.filter(g => g.id === guruIdNum);
  }
  if (kelasIdNum || jamKeNum || (hari !== '' && hari !== undefined)) {
    guruSumber = guruSumber.filter(g => {
      const jamList = jamInfoByGuru[g.id] || [];
      if ((hari !== '' && hari !== undefined && hari !== 'all') && jamList.length === 0) return false;
      const okKelas = kelasIdNum ? jamList.some(x => x.kelasId === kelasIdNum) : true;
      const okJamKe = jamKeNum ? jamList.some(x => x.jamKe === jamKeNum) : true;
      return okKelas && okJamKe;
    });
  }

  const submissionsRange = await prisma.dokumentasi.findMany({
    where: { createdAt: { gte: start, lte: end } },
    select: { guruId: true },
  });
  const sudah = new Set(submissionsRange.map((s) => s.guruId));

  let csv = 'Guru,Status\r\n';
  for (const g of guruSumber) {
    const status = sudah.has(g.id) ? 'SUDAH' : 'BELUM';
    const nama = `"${String(g.nama).replace(/"/g,'""')}"`;
    csv += `${nama},${status}\r\n`;
  }
  const fname = (startQ || endQ)
    ? `laporan_${format(start,'yyyy-MM-dd')}_to_${format(end,'yyyy-MM-dd')}.csv`
    : `laporan_${format(refDate,'yyyy-MM-dd')}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
  res.send(csv);
});

// Laporan XLSX (Valid dengan foto, mendukung semua data atau rentang tanggal)
app.get('/admin/laporan.xlsx', requireAdmin, async (req, res) => {
  const { mode = 'valid1', tanggal = '', start: startQ = '', end: endQ = '', guruId = '', kelasId = '', hari = '', jamKe = '' } = req.query;
  let start, end, useAll = false;
  if (startQ || endQ) {
    const s = startQ ? new Date(String(startQ)) : new Date('1970-01-01');
    const e = endQ ? new Date(String(endQ)) : new Date();
    start = startOfDay(s);
    end = endOfDay(e);
  } else if (tanggal) {
    const d = new Date(String(tanggal));
    start = startOfDay(d);
    end = endOfDay(d);
  } else {
    // Untuk mode valid, default ke semua data agar tidak hanya hari ini
    useAll = String(mode).startsWith('valid');
    start = startOfDay(new Date('1970-01-01'));
    end = endOfDay(new Date());
  }

  const alokasiAllRekap = await prisma.alokasiJamBelajar.findMany();
  const slotsByHari = new Map();
  for (const a of alokasiAll) {
    if (typeof a.jamKe !== 'number') continue;
    const arr = slotsByHari.get(a.hari) || [];
    arr.push({ jamKe: a.jamKe, mulai: a.mulaiMenit, selesai: a.selesaiMenit });
    slotsByHari.set(a.hari, arr);
  }
  for (const arr of Array.from(slotsByHari.values())) { arr.sort((a,b)=>a.mulai-b.mulai); }

  const jadwalAll = await prisma.jadwalMengajar.findMany();
  const validJamByDayGroup = new Map();
  for (const j of jadwalAll) {
    const arr = slotsByHari.get(j.hari) || [];
    const jamSet = new Set();
    for (const s of arr) { if (s.mulai < j.selesaiMenit && s.selesai > j.mulaiMenit) jamSet.add(s.jamKe); }
    validJamByDayGroup.set(`${j.hari}:${j.guruId}:${j.kelasId}:${j.mapelId}`, jamSet);
  }

  const where = useAll ? {} : { createdAt: { gte: start, lte: end } };
  let docs = await prisma.dokumentasi.findMany({ where, include: { guru: true, mapel: true, kelas: true }, orderBy: { createdAt: 'desc' } });
  // hanya yang memiliki foto
  docs = docs.filter(s => s.fotoPath);

  // Filter opsional
  const guruIdNum = guruId ? parseInt(guruId) : null;
  const kelasIdNum = kelasId ? parseInt(kelasId) : null;
  const jamKeNum = jamKe ? parseInt(jamKe) : null;
  const hariFilter = (hari && hari !== 'all') ? Math.max(0, Math.min(6, parseInt(hari))) : null;
  if (guruIdNum) docs = docs.filter(s => s.guruId === guruIdNum);
  if (kelasIdNum) docs = docs.filter(s => s.kelasId === kelasIdNum);
  if (jamKeNum) {
    docs = docs.filter(s => {
      const jamList = [];
      if (Number.isInteger(s.jamKe)) jamList.push(s.jamKe);
      if (typeof s.jamKeList === 'string' && s.jamKeList.trim()) {
        s.jamKeList.split(',').forEach(x => { const n = parseInt(x.trim(), 10); if (Number.isInteger(n)) jamList.push(n); });
      }
      return jamList.includes(jamKeNum);
    });
  }
  if (hariFilter !== null) docs = docs.filter(s => new Date(s.createdAt).getDay() === hariFilter);

  // Hitung valid sesuai jadwal
  const valids = [];
  for (const s of docs) {
    const day = new Date(s.createdAt).getDay();
    const key = `${day}:${s.guruId}:${s.kelasId}:${s.mapelId}`;
    const validSet = validJamByDayGroup.get(key);
    const jamProvided = [];
    if (Number.isInteger(s.jamKe)) jamProvided.push(s.jamKe);
    if (typeof s.jamKeList === 'string' && s.jamKeList.trim()) {
      s.jamKeList.split(',').forEach(x => { const n = parseInt(x.trim(), 10); if (Number.isInteger(n)) jamProvided.push(n); });
    }
    const jamUniq = Array.from(new Set(jamProvided));
    const isValid = validSet && jamUniq.length ? jamUniq.some(n => validSet.has(n)) : false;
    if (isValid) {
      const fotoUrl = s.fotoPath ? (String(s.fotoPath).startsWith('/') ? s.fotoPath : `/${s.fotoPath}`) : null;
      const absFoto = fotoUrl ? (req.protocol + '://' + req.get('host') + fotoUrl) : '';
      valids.push({
        waktu: s.createdAt,
        guru: s.guru ? s.guru.nama : String(s.guruId),
        kelas: s.kelas ? s.kelas.nama : (Number.isInteger(s.kelasId) ? String(s.kelasId) : '—'),
        mapel: s.mapel ? (s.mapel.kode || s.mapel.nama || '') : (Number.isInteger(s.mapelId) ? String(s.mapelId) : '—'),
        jamDikirim: jamUniq.length ? jamUniq.sort((a,b)=>a-b).join(', ') : '—',
        latitude: Number.isFinite(s.latitude) ? s.latitude : '',
        longitude: Number.isFinite(s.longitude) ? s.longitude : '',
        fotoUrl: absFoto,
      });
    }
  }

  // Buat workbook XLSX
  const rows = valids.map(v => ({
    'Waktu': new Date(v.waktu).toLocaleString('id-ID'),
    'Nama Guru': v.guru,
    'Mapel': v.mapel,
    'Kelas': v.kelas,
    'Jam Dikirim': v.jamDikirim,
    'Latitude': v.latitude,
    'Longitude': v.longitude,
    'Foto URL': v.fotoUrl,
  }));
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.json_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, 'Valid');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const fname = useAll
    ? `laporan_valid_semua.xlsx`
    : `laporan_valid_${format(start,'yyyy-MM-dd')}_to_${format(end,'yyyy-MM-dd')}.xlsx`;
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${fname}"`);
  res.send(buf);
});

// Print laporan valid (semua data, dengan foto) — tampilan seperti realtime
app.get('/admin/laporan/print-valid', requireAdmin, async (req, res) => {
  try {
    const { tanggal = '', start: startQ = '', end: endQ = '', guruId = '', kelasId = '', hari = '', jamKe = '', q = '', mode: modeQ = 'valid1' } = req.query;
    const mode = String(modeQ || 'valid1');

    let start, end, useAll = false;
    if (startQ || endQ) {
      const s = startQ ? new Date(String(startQ)) : new Date('1970-01-01');
      const e = endQ ? new Date(String(endQ)) : new Date();
      start = startOfDay(s);
      end = endOfDay(e);
    } else if (tanggal) {
      const d = new Date(String(tanggal));
      start = startOfDay(d);
      end = endOfDay(d);
    } else {
      useAll = String(mode).startsWith('valid');
      start = startOfDay(new Date('1970-01-01'));
      end = endOfDay(new Date());
    }

    const alokasiAll = await prisma.alokasiJamBelajar.findMany();
    const slotsByHari = new Map();
    for (const a of alokasiAll) {
      if (typeof a.jamKe !== 'number') continue;
      const arr = slotsByHari.get(a.hari) || [];
      arr.push({ jamKe: a.jamKe, mulai: a.mulaiMenit, selesai: a.selesaiMenit });
      slotsByHari.set(a.hari, arr);
    }
    for (const arr of Array.from(slotsByHari.values())) { arr.sort((a,b)=>a.mulai-b.mulai); }

    const jadwalAll = await prisma.jadwalMengajar.findMany();
    const validJamByDayGroup = new Map();
    for (const j of jadwalAll) {
      const arr = slotsByHari.get(j.hari) || [];
      const jamSet = new Set();
      for (const s of arr) { if (s.mulai < j.selesaiMenit && s.selesai > j.mulaiMenit) jamSet.add(s.jamKe); }
      validJamByDayGroup.set(`${j.hari}:${j.guruId}:${j.kelasId}:${j.mapelId}`, jamSet);
    }

    const where = useAll ? {} : { createdAt: { gte: start, lte: end } };
    let docs = await prisma.dokumentasi.findMany({ where, include: { guru: true, mapel: true, kelas: true }, orderBy: { createdAt: 'desc' } });
    docs = docs.filter(s => s.fotoPath);

    const guruIdNum = guruId ? parseInt(guruId) : null;
    const kelasIdNum = kelasId ? parseInt(kelasId) : null;
    const jamKeNum = jamKe ? parseInt(jamKe) : null;
    const hariFilter = (hari && hari !== 'all') ? Math.max(0, Math.min(6, parseInt(hari))) : null;

    if (guruIdNum) docs = docs.filter(s => s.guruId === guruIdNum);
    if (kelasIdNum) docs = docs.filter(s => s.kelasId === kelasIdNum);
    if (jamKeNum) {
      docs = docs.filter(s => {
        const jamList = [];
        if (Number.isInteger(s.jamKe)) jamList.push(s.jamKe);
        if (typeof s.jamKeList === 'string' && s.jamKeList.trim()) {
          s.jamKeList.split(',').forEach(x => { const n = parseInt(x.trim(), 10); if (Number.isInteger(n)) jamList.push(n); });
        }
        return jamList.includes(jamKeNum);
      });
    }
    if (hariFilter !== null) docs = docs.filter(s => new Date(s.createdAt).getDay() === hariFilter);
    if (q && String(q).trim()) {
      const ql = String(q).trim().toLowerCase();
      docs = docs.filter(s => {
        const g = s.guru && s.guru.nama ? s.guru.nama.toLowerCase() : '';
        const k = s.kelas && s.kelas.nama ? s.kelas.nama.toLowerCase() : '';
        const m = s.mapel && (s.mapel.kode || s.mapel.nama) ? String(s.mapel.kode || s.mapel.nama).toLowerCase() : '';
        return g.includes(ql) || k.includes(ql) || m.includes(ql);
      });
    }

    // Agregasi per hari–guru–kelas–mapel untuk menghindari duplikasi
    const agg = new Map(); // key -> { latestDoc, jamSet }
    for (const s of docs) {
      const day = new Date(s.createdAt).getDay();
      const key = `${day}:${s.guruId}:${s.kelasId}:${s.mapelId}`;
      const validSet = validJamByDayGroup.get(key);
      const jamProvided = [];
      if (Number.isInteger(s.jamKe)) jamProvided.push(s.jamKe);
      if (typeof s.jamKeList === 'string' && s.jamKeList.trim()) {
        s.jamKeList.split(',').forEach(x => { const n = parseInt(x.trim(), 10); if (Number.isInteger(n)) jamProvided.push(n); });
      }
      const jamUniq = Array.from(new Set(jamProvided));
      const isValid = validSet && jamUniq.length ? jamUniq.some(n => validSet.has(n)) : false;
      if (!isValid) continue;
      const cur = agg.get(key) || { latestDoc: null, jamSet: new Set() };
      jamUniq.forEach(n => cur.jamSet.add(n));
      if (!cur.latestDoc || new Date(s.createdAt) > new Date(cur.latestDoc.createdAt)) {
        cur.latestDoc = s;
      }
      agg.set(key, cur);
    }

    const valids = Array.from(agg.values()).map(({ latestDoc, jamSet }) => {
      const s = latestDoc;
      const fotoUrl = s.fotoPath ? (String(s.fotoPath).startsWith('/') ? s.fotoPath : `/${s.fotoPath}`) : null;
      return {
        waktu: s.createdAt,
        guru: s.guru ? s.guru.nama : String(s.guruId),
        kelas: s.kelas ? s.kelas.nama : (Number.isInteger(s.kelasId) ? String(s.kelasId) : '—'),
        mapel: s.mapel ? (s.mapel.kode || s.mapel.nama || '') : (Number.isInteger(s.mapelId) ? String(s.mapelId) : '—'),
        jamDikirim: jamSet.size ? Array.from(jamSet).sort((a,b)=>a-b).join(', ') : '—',
        latitude: Number.isFinite(s.latitude) ? s.latitude : null,
        longitude: Number.isFinite(s.longitude) ? s.longitude : null,
        fotoUrl,
      };
    });

    const titleDate = useAll
      ? 'Semua Data'
      : `${format(start,'dd MMM yyyy')} s.d. ${format(end,'dd MMM yyyy')}`;
    const school = (SCHOOL_SETTINGS && SCHOOL_SETTINGS.namaSekolah) ? SCHOOL_SETTINGS.namaSekolah : '';
    res.render('admin/realtime_print_valid', { titleDate, school, valids });
  } catch (e) {
    res.status(500).send('Terjadi kesalahan saat membuat print laporan valid');
  }
});

// Laporan (halaman tampilan)
app.get('/admin/laporan/print-invalid', requireAdmin, async (req, res) => {
  try {
    const { tanggal = '', start: startQ = '', end: endQ = '', guruId = '', kelasId = '', hari = '', jamKe = '', q = '' } = req.query;

    let start, end, useAll = false;
    if (startQ || endQ) {
      const s = startQ ? new Date(String(startQ)) : new Date('1970-01-01');
      const e = endQ ? new Date(String(endQ)) : new Date();
      start = startOfDay(s);
      end = endOfDay(e);
    } else if (tanggal) {
      const d = new Date(String(tanggal));
      start = startOfDay(d);
      end = endOfDay(d);
    } else {
      useAll = true;
      start = startOfDay(new Date('1970-01-01'));
      end = endOfDay(new Date());
    }

    const alokasiAll = await prisma.alokasiJamBelajar.findMany();
    const slotsByHari = new Map();
    for (const a of alokasiAll) {
      if (typeof a.jamKe !== 'number') continue;
      const arr = slotsByHari.get(a.hari) || [];
      arr.push({ jamKe: a.jamKe, mulai: a.mulaiMenit, selesai: a.selesaiMenit });
      slotsByHari.set(a.hari, arr);
    }
    for (const arr of Array.from(slotsByHari.values())) { arr.sort((a,b)=>a.mulai-b.mulai); }

    const jadwalAll = await prisma.jadwalMengajar.findMany();
    const validJamByDayGroup = new Map();
    const groupsByGuruByDay = new Map();
    for (const j of jadwalAll) {
      const arr = slotsByHari.get(j.hari) || [];
      const jamSet = new Set();
      for (const s of arr) { if (s.mulai < j.selesaiMenit && s.selesai > j.mulaiMenit) jamSet.add(s.jamKe); }
      validJamByDayGroup.set(`${j.hari}:${j.guruId}:${j.kelasId}:${j.mapelId}`, jamSet);
      const mapG = groupsByGuruByDay.get(j.hari) || new Map();
      const list = mapG.get(j.guruId) || [];
      list.push({ kelasId: j.kelasId, mapelId: j.mapelId, jamKes: jamSet });
      mapG.set(j.guruId, list);
      groupsByGuruByDay.set(j.hari, mapG);
    }

    const where = useAll ? {} : { createdAt: { gte: start, lte: end } };
    let docs = await prisma.dokumentasi.findMany({ where, include: { guru: true, mapel: true, kelas: true }, orderBy: { createdAt: 'desc' } });

    const guruIdNum = guruId ? parseInt(guruId) : null;
    const kelasIdNum = kelasId ? parseInt(kelasId) : null;
    const jamKeNum = jamKe ? parseInt(jamKe) : null;
    const hariFilter = (hari && hari !== 'all') ? Math.max(0, Math.min(6, parseInt(hari))) : null;

    if (guruIdNum) docs = docs.filter(s => s.guruId === guruIdNum);
    if (kelasIdNum) docs = docs.filter(s => s.kelasId === kelasIdNum);
    if (jamKeNum) {
      docs = docs.filter(s => {
        const jamList = [];
        if (Number.isInteger(s.jamKe)) jamList.push(s.jamKe);
        if (typeof s.jamKeList === 'string' && s.jamKeList.trim()) {
          s.jamKeList.split(',').forEach(x => { const n = parseInt(x.trim(), 10); if (Number.isInteger(n)) jamList.push(n); });
        }
        return jamList.includes(jamKeNum);
      });
    }
    if (hariFilter !== null) docs = docs.filter(s => new Date(s.createdAt).getDay() === hariFilter);
    if (q && String(q).trim()) {
      const ql = String(q).trim().toLowerCase();
      docs = docs.filter(s => {
        const g = s.guru && s.guru.nama ? s.guru.nama.toLowerCase() : '';
        const k = s.kelas && s.kelas.nama ? s.kelas.nama.toLowerCase() : '';
        const m = s.mapel && (s.mapel.kode || s.mapel.nama) ? String(s.mapel.kode || s.mapel.nama).toLowerCase() : '';
        return g.includes(ql) || k.includes(ql) || m.includes(ql);
      });
    }

    const invalidsGroupMap = new Map();
    for (const s of docs) {
      const jamProvided = [];
      if (Number.isInteger(s.jamKe)) jamProvided.push(s.jamKe);
      if (typeof s.jamKeList === 'string' && s.jamKeList.trim()) {
        s.jamKeList.split(',').forEach(x => { const n = parseInt(x.trim(), 10); if (Number.isInteger(n)) jamProvided.push(n); });
      }
      const jamUniq = Array.from(new Set(jamProvided));
      const day = new Date(s.createdAt).getDay();
      const keyExact = `${day}:${s.guruId}:${s.kelasId}:${s.mapelId}`;
      const validJamSet = validJamByDayGroup.get(keyExact);

      let isMatch = false;
      let reason = '';
      let extraJamReason = '';
      let extraJamReason2 = '';
      if (validJamSet) {
        if (jamUniq.length === 0) {
          reason = 'jam kosong';
        } else {
          isMatch = jamUniq.some(n => validJamSet.has(n));
          if (!isMatch) reason = 'jam mengajar salah';
        }
      } else {
        const mapG = groupsByGuruByDay.get(day) || new Map();
        const list = mapG.get(s.guruId) || [];
        if (!list.length) {
          reason = 'tidak ada jadwal guru hari ini';
        } else {
          const sameClass = list.filter(g => g.kelasId === s.kelasId);
          const sameSubject = list.filter(g => g.mapelId === s.mapelId);
          if (!sameClass.length && !sameSubject.length) reason = 'kelas salah, mapel salah';
          else if (!sameClass.length) reason = 'kelas salah';
          else if (!sameSubject.length) reason = 'mapel salah';
          else reason = '';
          if (jamUniq.length === 0) {
            extraJamReason = 'jam kosong';
          } else {
            extraJamReason2 = 'jam salah';
            const unionJam = new Set();
            for (const g of list) { g.jamKes && g.jamKes.forEach(v => unionJam.add(v)); }
            const anyMatchUnion = jamUniq.some(n => unionJam.has(n));
            if (!anyMatchUnion) extraJamReason = 'jam mengajar salah';
          }
        }
      }
      if (!isMatch) {
        const key = `${s.guru ? s.guru.nama : s.guruId}:${s.kelas ? s.kelas.nama : (Number.isInteger(s.kelasId) ? s.kelasId : '—')}:${(s.mapel && s.mapel.kode) ? s.mapel.kode : (Number.isInteger(s.mapelId) ? s.mapelId : '—')}`;
        const existing = invalidsGroupMap.get(key);
        const jamSet = new Set(existing?.jamSet || []);
        jamUniq.forEach(n => jamSet.add(n));
        const reasonSet = new Set(existing?.reasonSet || []);
        if (reason) reasonSet.add(reason);
        if (extraJamReason) reasonSet.add(extraJamReason);
        if (extraJamReason2) reasonSet.add(extraJamReason2);
        const fotoUrl = s.fotoPath ? (String(s.fotoPath).startsWith('/') ? s.fotoPath : `/${s.fotoPath}`) : null;
        const next = {
          waktu: !existing || new Date(s.createdAt).getTime() > new Date(existing.waktu || 0).getTime() ? s.createdAt : existing?.waktu,
          waktuKirim: !existing || new Date(s.createdAt).getTime() > new Date(existing.waktuKirim || 0).getTime() ? s.createdAt : existing?.waktuKirim,
          guru: s.guru ? s.guru.nama : String(s.guruId),
          kelas: s.kelas ? s.kelas.nama : (Number.isInteger(s.kelasId) ? String(s.kelasId) : '—'),
          mapel: (s.mapel && (s.mapel.kode || s.mapel.nama)) ? (s.mapel.kode || s.mapel.nama) : (Number.isInteger(s.mapelId) ? String(s.mapelId) : '—'),
          jamSet,
          reasonSet,
          lokasiValid: (typeof s.isLocationValid === 'boolean') ? s.isLocationValid : (existing ? existing.lokasiValid : null),
          latitude: Number.isFinite(s.latitude) ? s.latitude : (existing ? existing.latitude : null),
          longitude: Number.isFinite(s.longitude) ? s.longitude : (existing ? existing.longitude : null),
          mapsUrl: (Number.isFinite(s.latitude) && Number.isFinite(s.longitude)) ? (`https://www.google.com/maps?q=${s.latitude},${s.longitude}`) : (existing ? existing.mapsUrl : null),
          fotoUrl: fotoUrl || (existing ? existing.fotoUrl : null),
        };
        invalidsGroupMap.set(key, next);
      }
    }

    const invalids = Array.from(invalidsGroupMap.values()).map(rec => ({
      ...rec,
      jamDikirim: (rec.jamSet && rec.jamSet.size) ? Array.from(rec.jamSet).sort((a,b)=>a-b).join(', ') : '—',
      alasan: (rec.reasonSet && rec.reasonSet.size) ? Array.from(rec.reasonSet).join(', ') : 'tidak sesuai'
    })).sort((a,b) => new Date(b.waktu || 0).getTime() - new Date(a.waktu || 0).getTime());

    const titleDate = useAll
      ? 'Semua Data'
      : `${format(start,'dd MMM yyyy')} s.d. ${format(end,'dd MMM yyyy')}`;
    const school = (SCHOOL_SETTINGS && SCHOOL_SETTINGS.namaSekolah) ? SCHOOL_SETTINGS.namaSekolah : '';
    res.render('admin/realtime_print_invalid', { titleDate, school, invalids });
  } catch (e) {
    res.status(500).send('Terjadi kesalahan saat membuat print laporan invalid');
  }
});

// Print Rekap Detail (A4 Landscape)
app.get('/admin/laporan/print-rekap', requireAdmin, async (req, res) => {
  try {
    const { tanggal = '', start: startQ = '', end: endQ = '', guruId = '', kelasId = '', hari = '', jamKe = '', q = '', sort = 'nama', order = 'asc' } = req.query;

    let start, end, refDate;
    if (startQ || endQ) {
      const s = startQ ? new Date(String(startQ)) : new Date();
      const e = endQ ? new Date(String(endQ)) : new Date();
      start = startOfDay(s);
      end = endOfDay(e);
      refDate = e;
    } else {
      const d = tanggal ? new Date(String(tanggal)) : new Date();
      start = startOfDay(d);
      end = endOfDay(d);
      refDate = d;
    }

    const semuaGuru = await prisma.guru.findMany({ orderBy: { nama: 'asc' } });
    const semuaKelas = await prisma.kelas.findMany({ orderBy: { nama: 'asc' } });
    const semuaMapel = await prisma.mapel.findMany({ orderBy: { nama: 'asc' } });
    const kelasById = Object.fromEntries(semuaKelas.map(k => [k.id, k.nama]));
    const mapelById = Object.fromEntries(semuaMapel.map(m => [m.id, m.nama]));

    let hariFilter = null;
    if (typeof hari !== 'undefined' && String(hari) !== '' && String(hari) !== 'all') {
      hariFilter = Math.max(0, Math.min(6, parseInt(hari)));
    }
    const hariUsed = (hariFilter === null) ? refDate.getDay() : hariFilter;

    const jadwalHari = await prisma.jadwalMengajar.findMany({
      where: { hari: hariUsed },
      orderBy: { mulaiMenit: 'asc' },
    });
    const alokasiHari = await prisma.alokasiJamBelajar.findMany({ where: { hari: hariUsed } });
    const slots = alokasiHari
      .filter(a => typeof a.jamKe === 'number')
      .map(a => ({ jamKe: a.jamKe, mulai: a.mulaiMenit, selesai: a.selesaiMenit }))
      .sort((a,b) => a.mulai - b.mulai);
    const byGuru = jadwalHari.reduce((acc, j) => { (acc[j.guruId] ||= []).push(j); return acc; }, {});
    Object.values(byGuru).forEach(list => list.sort((a,b) => a.mulaiMenit - b.mulaiMenit));
    const jamInfoByGuru = {};
    for (const [gidStr, list] of Object.entries(byGuru)) {
      const gid = Number(gidStr);
      const info = [];
      for (const j of list) {
        const jamSet = new Set();
        for (const s of slots) {
          if (s.mulai < j.selesaiMenit && s.selesai > j.mulaiMenit) jamSet.add(s.jamKe);
        }
        jamSet.forEach(k => info.push({ kelasId: j.kelasId, mapelId: j.mapelId, jamKe: k }));
      }
      jamInfoByGuru[gid] = info;
    }

    const guruIdNum = guruId ? parseInt(guruId) : null;
    const kelasIdNum = kelasId ? parseInt(kelasId) : null;
    const jamKeNum = jamKe ? parseInt(jamKe) : null;

    let guruSumber = semuaGuru;
    if (guruIdNum) {
      guruSumber = guruSumber.filter(g => g.id === guruIdNum);
    }
    if (kelasIdNum || jamKeNum || (typeof hari !== 'undefined' && String(hari) !== '')) {
      guruSumber = guruSumber.filter(g => {
        const jamList = jamInfoByGuru[g.id] || [];
        if ((String(hari) !== '' && String(hari) !== 'all') && jamList.length === 0) return false;
        const okKelas = kelasIdNum ? jamList.some(x => x.kelasId === kelasIdNum) : true;
        const okJamKe = jamKeNum ? jamList.some(x => x.jamKe === jamKeNum) : true;
        return okKelas && okJamKe;
      });
    }

    const submissionsTodayGroups = await prisma.dokumentasi.findMany({
      where: { createdAt: { gte: start, lte: end } },
      select: { guruId: true, kelasId: true, mapelId: true },
    });
    const submittedGroupKeys = new Set(
      submissionsTodayGroups.map((s) => `${s.guruId}:${s.kelasId || ''}:${s.mapelId || ''}`)
    );

    const docsRangeForDetail = await prisma.dokumentasi.findMany({
      where: { createdAt: { gte: start, lte: end } },
      include: { guru: true, mapel: true, kelas: true },
      orderBy: { createdAt: 'desc' },
    });
    const latestDocByGroup = new Map();
    for (const s of docsRangeForDetail) {
      const key = `${s.guruId}:${s.kelasId}:${s.mapelId}`;
      const prev = latestDocByGroup.get(key);
      if (!prev || new Date(s.createdAt).getTime() > new Date(prev.createdAt).getTime()) {
        latestDocByGroup.set(key, s);
      }
    }

    let rows = [];
    for (const g of guruSumber) {
      const jamList = jamInfoByGuru[g.id] || [];
      const groupMap = new Map();
      for (const x of jamList) {
        const key = `${x.kelasId}:${x.mapelId}`;
        if (!groupMap.has(key)) groupMap.set(key, { kelasId: x.kelasId, mapelId: x.mapelId, jamKes: [] });
        groupMap.get(key).jamKes.push(x.jamKe);
      }
      for (const grp of groupMap.values()) {
        if (kelasIdNum && grp.kelasId !== kelasIdNum) continue;
        if (jamKeNum && !grp.jamKes.includes(jamKeNum)) continue;
        const uniqJam = Array.from(new Set(grp.jamKes)).sort((a,b) => a-b);
        const jamKeDisplay = uniqJam.join(', ');
        const toHHMM = (m) => `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;
        const timesByJam = new Map(slots.map(s => [s.jamKe, `${toHHMM(s.mulai)}–${toHHMM(s.selesai)}`]));
        const jamTimesDisplay = uniqJam.map(k => timesByJam.get(k) ? `${k} (${timesByJam.get(k)})` : String(k)).join(', ');
        const status = submittedGroupKeys.has(`${g.id}:${grp.kelasId}:${grp.mapelId}`) ? 'SUDAH' : 'BELUM';

        const latest = latestDocByGroup.get(`${g.id}:${grp.kelasId}:${grp.mapelId}`);
        const waktuKirim = latest ? latest.createdAt : null;
        const fotoStatus = latest && latest.fotoPath ? 'SUDAH' : 'BELUM';
        const lokasiValidLabel = (latest && typeof latest.isLocationValid === 'boolean')
          ? (latest.isLocationValid ? 'Valid' : 'Tidak Valid')
          : '—';
        const mapsUrl = (latest && Number.isFinite(latest.latitude) && Number.isFinite(latest.longitude))
          ? `https://www.google.com/maps?q=${latest.latitude},${latest.longitude}`
          : null;

        rows.push({
          nama: g.nama || '',
          status,
          mapel: mapelById[grp.mapelId] || '-',
          kelas: kelasById[grp.kelasId] || '-',
          jamKe: jamKeDisplay || '-',
          jamTimes: jamTimesDisplay,
          waktuKirim,
          fotoStatus,
          lokasiValid: lokasiValidLabel,
          mapsUrl,
        });
      }
    }

    const rawQ = String(q || '').trim();
    const query = rawQ.toLowerCase();
    if (query) {
      rows = rows.filter(r =>
        r.nama.toLowerCase().includes(query) ||
        r.status.toLowerCase().includes(query)
      );
    }

    function minJamVal(s) {
      const arr = String(s || '').split(',').map(t => parseInt(t.trim(), 10)).filter(n => Number.isInteger(n));
      return arr.length ? Math.min(...arr) : Number.MAX_SAFE_INTEGER;
    }
    const comparators = {
      nama: (a, b) => a.nama.localeCompare(b.nama),
      status: (a, b) => a.status.localeCompare(b.status),
      mapel: (a, b) => String(a.mapel || '').localeCompare(String(b.mapel || '')),
      kelas: (a, b) => String(a.kelas || '').localeCompare(String(b.kelas || '')),
      jamKe: (a, b) => minJamVal(a.jamKe) - minJamVal(b.jamKe),
    };
    const sortKey = String(sort || 'nama');
    const dir = String(order).toLowerCase() === 'desc' ? -1 : 1;
    const cmp = comparators[sortKey] || comparators.nama;
    rows.sort((a, b) => dir * cmp(a, b));

    const titleDate = `${format(start,'dd MMM yyyy')} s.d. ${format(end,'dd MMM yyyy')}`;
    const school = (SCHOOL_SETTINGS && SCHOOL_SETTINGS.namaSekolah) ? SCHOOL_SETTINGS.namaSekolah : '';
    res.render('admin/laporan_print_rekap', { titleDate, school, rows });
  } catch (e) {
    res.status(500).send('Terjadi kesalahan saat membuat print rekap detail');
  }
});

app.get('/admin/laporan', requireAdmin, async (req, res) => {
  const { tanggal = '', start: startQ = '', end: endQ = '', page = '1', limit = '20', q = '', sort = 'nama', order = 'asc', guruId = '', kelasId = '', hari = '', jamKe = '', mode: modeQ = 'rekap' } = req.query;
  const mode = String(modeQ || 'rekap');
  let start, end, refDate;
  if (startQ || endQ) {
    const s = startQ ? new Date(String(startQ)) : new Date();
    const e = endQ ? new Date(String(endQ)) : new Date();
    start = startOfDay(s);
    end = endOfDay(e);
    refDate = e;
  } else {
    const d = tanggal ? new Date(String(tanggal)) : new Date();
    start = startOfDay(d);
    end = endOfDay(d);
    refDate = d;
  }

  // Referensi untuk filter UI
  const semuaGuru = await prisma.guru.findMany({ orderBy: { nama: 'asc' } });
  const semuaKelas = await prisma.kelas.findMany({ orderBy: { nama: 'asc' } });
  const semuaMapel = await prisma.mapel.findMany({ orderBy: { nama: 'asc' } });
  // Peta kelasId -> nama untuk display
  const kelasById = Object.fromEntries(semuaKelas.map(k => [k.id, k.nama]));
  // Peta mapelId -> nama untuk display
  const mapelById = Object.fromEntries(semuaMapel.map(m => [m.id, m.nama]));

  // Mode Rekap: susun per tanggal dalam rentang [start, end]
  let hariFilter = null;
  if (typeof hari !== 'undefined' && String(hari) !== '' && String(hari) !== 'all') {
    hariFilter = Math.max(0, Math.min(6, parseInt(hari)));
  }

  const guruIdNum = guruId ? parseInt(guruId) : null;
  const kelasIdNum = kelasId ? parseInt(kelasId) : null;
  const jamKeNum = jamKe ? parseInt(jamKe) : null;

  // Batasi sumber guru lebih awal bila ada filter guru
  let guruSumber = semuaGuru;
  if (guruIdNum) {
    guruSumber = guruSumber.filter(g => g.id === guruIdNum);
  }

  // Slot per hari (alokasi jam belajar)
  const alokasiAll = await prisma.alokasiJamBelajar.findMany();
  const slotsByHariRekap = new Map();
  for (const a of alokasiAll) {
    if (typeof a.jamKe !== 'number') continue;
    const arr = slotsByHariRekap.get(a.hari) || [];
    arr.push({ jamKe: a.jamKe, mulai: a.mulaiMenit, selesai: a.selesaiMenit });
    slotsByHariRekap.set(a.hari, arr);
  }
  for (const arr of Array.from(slotsByHariRekap.values())) { arr.sort((a,b)=>a.mulai-b.mulai); }

  // Jadwal mengajar seluruh hari
  const jadwalAllRekap = await prisma.jadwalMengajar.findMany();

  // Precompute: jam info per hari per guru
  const jamInfoByGuruByHari = new Map(); // hari -> Map(guruId -> [{kelasId,mapelId,jamKe}...])
  for (let h = 0; h < 7; h++) {
    const listJ = jadwalAllRekap.filter(j => j.hari === h).sort((a,b)=>a.mulaiMenit-b.mulaiMenit);
    const slots = slotsByHariRekap.get(h) || [];
    const byGuru = listJ.reduce((acc, j) => { (acc[j.guruId] ||= []).push(j); return acc; }, {});
    const jamInfo = {};
    for (const [gidStr, list] of Object.entries(byGuru)) {
      const gid = Number(gidStr);
      const info = [];
      for (const j of list) {
        const jamSet = new Set();
        for (const s of slots) {
          if (s.mulai < j.selesaiMenit && s.selesai > j.mulaiMenit) jamSet.add(s.jamKe);
        }
        jamSet.forEach(k => info.push({ kelasId: j.kelasId, mapelId: j.mapelId, jamKe: k }));
      }
      jamInfo[gid] = info;
    }
    jamInfoByGuruByHari.set(h, jamInfo);
  }

  // Peta waktu (HH:MM–HH:MM) per hari per jamKe
  const toHHMM = (m) => `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;
  const timesByHari = new Map(); // hari -> Map(jamKe -> label waktu)
  for (let h = 0; h < 7; h++) {
    const slots = slotsByHariRekap.get(h) || [];
    timesByHari.set(h, new Map(slots.map(s => [s.jamKe, `${toHHMM(s.mulai)}–${toHHMM(s.selesai)}`])));
  }

  // Dokumentasi dalam rentang, untuk status dan detail per tanggal
  const dokumentasiRangeRekap = await prisma.dokumentasi.findMany({
    where: { createdAt: { gte: start, lte: end } },
    include: { guru: true, mapel: true, kelas: true },
    orderBy: { createdAt: 'desc' },
  });
  const submittedByDateGroup = new Set(); // key: YYYY-MM-DD:guruId:kelasId:mapelId
  const latestDocByDateGroup = new Map();
  function ymd(d){ const dt = new Date(d); return `${dt.getFullYear()}-${String(dt.getMonth()+1).padStart(2,'0')}-${String(dt.getDate()).padStart(2,'0')}`; }
  for (const s of dokumentasiRangeRekap) {
    const dateStr = ymd(s.createdAt);
    const key = `${dateStr}:${s.guruId}:${s.kelasId}:${s.mapelId}`;
    submittedByDateGroup.add(key);
    if (!latestDocByDateGroup.has(key)) {
      latestDocByDateGroup.set(key, s); // karena orderBy desc, entri pertama adalah terbaru untuk tanggal tersebut
    }
  }

  // Susun daftar tanggal dari start ke end
  const dayList = [];
  {
    let cur = new Date(start);
    cur = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate());
    const endDay = new Date(end.getFullYear(), end.getMonth(), end.getDate());
    while (cur.getTime() <= endDay.getTime()) {
      dayList.push(new Date(cur));
      cur.setDate(cur.getDate() + 1);
    }
  }

  // Bangun baris rekap per tanggal
  let rows = [];
  for (const dayDate of dayList) {
    const day = dayDate.getDay();
    if (hariFilter !== null && day !== hariFilter) continue;
    const jamInfoByGuru = jamInfoByGuruByHari.get(day) || {};
    const timesByJam = timesByHari.get(day) || new Map();

    for (const g of guruSumber) {
      const jamList = jamInfoByGuru[g.id] || [];
      if (!jamList.length) continue; // guru tidak mengajar di hari ini

      // Kelompokkan per kelas-mapel
      const groupMap = new Map();
      for (const x of jamList) {
        const key = `${x.kelasId}:${x.mapelId}`;
        if (!groupMap.has(key)) groupMap.set(key, { kelasId: x.kelasId, mapelId: x.mapelId, jamKes: [] });
        groupMap.get(key).jamKes.push(x.jamKe);
      }

      for (const grp of groupMap.values()) {
        if (kelasIdNum && grp.kelasId !== kelasIdNum) continue;
        if (jamKeNum && !grp.jamKes.includes(jamKeNum)) continue;
        const uniqJam = Array.from(new Set(grp.jamKes)).sort((a,b) => a-b);
        const jamKeDisplay = uniqJam.join(', ');
        const jamTimesDisplay = uniqJam.map(k => timesByJam.get(k) ? `${k} (${timesByJam.get(k)})` : String(k)).join(', ');

        const dateStr = ymd(dayDate);
        const status = submittedByDateGroup.has(`${dateStr}:${g.id}:${grp.kelasId}:${grp.mapelId}`) ? 'SUDAH' : 'BELUM';
        const latest = latestDocByDateGroup.get(`${dateStr}:${g.id}:${grp.kelasId}:${grp.mapelId}`);
        const waktuKirim = latest ? latest.createdAt : null;
        const fotoStatus = latest && latest.fotoPath ? 'SUDAH' : 'BELUM';
        const lokasiValidLabel = (latest && typeof latest.isLocationValid === 'boolean')
          ? (latest.isLocationValid ? 'Valid' : 'Tidak Valid')
          : '—';
        const mapsUrl = (latest && Number.isFinite(latest.latitude) && Number.isFinite(latest.longitude))
          ? `https://www.google.com/maps?q=${latest.latitude},${latest.longitude}`
          : null;

        rows.push({
          groupKey: `${g.id}:${grp.kelasId}:${grp.mapelId}`,
          nama: g.nama || '',
          status,
          mapel: mapelById[grp.mapelId] || '-',
          kelas: kelasById[grp.kelasId] || '-',
          jamKe: jamKeDisplay || '-',
          jamCount: uniqJam.length,
          jamTimes: jamTimesDisplay,
          hariLabel: ['Ahad','Senin','Selasa','Rabu','Kamis','Jumat','Sabtu'][day],
          tanggalLabel: format(dayDate, 'dd MMM yyyy'),
          waktuKirim,
          fotoStatus,
          lokasiValid: lokasiValidLabel,
          mapsUrl,
        });
      }
    }
  }

  // Pencarian bebas
  const rawQ = String(q || '').trim();
  const query = rawQ.toLowerCase();
  if (query) {
    rows = rows.filter(r =>
      r.nama.toLowerCase().includes(query) ||
      r.status.toLowerCase().includes(query)
    );
  }

  // Sorting
  function minJamVal(s) {
    const arr = String(s || '').split(',').map(t => parseInt(t.trim(), 10)).filter(n => Number.isInteger(n));
    return arr.length ? Math.min(...arr) : Number.MAX_SAFE_INTEGER;
  }
  const comparators = {
    nama: (a, b) => a.nama.localeCompare(b.nama),
    status: (a, b) => a.status.localeCompare(b.status),
    mapel: (a, b) => String(a.mapel || '').localeCompare(String(b.mapel || '')),
    kelas: (a, b) => String(a.kelas || '').localeCompare(String(b.kelas || '')),
    jamKe: (a, b) => minJamVal(a.jamKe) - minJamVal(b.jamKe),
  };
  const sortKey = String(sort || 'nama');
  const dir = String(order).toLowerCase() === 'desc' ? -1 : 1;
  const cmp = comparators[sortKey] || comparators.nama;
  rows.sort((a, b) => dir * cmp(a, b));

  // Paginasi
  const pageNum = Math.max(1, parseInt(page));
  const lim = Math.max(1, parseInt(limit));
  const totalRows = rows.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / lim));
  const startIdx = (pageNum - 1) * lim;
  const visible = rows.slice(startIdx, startIdx + lim);

  // Rekaman valid dalam rentang tanggal (mengikuti logika valid Realtime, tanpa menampilkan invalid)
  const alokasiAllValid = await prisma.alokasiJamBelajar.findMany();
  const slotsByHariValid = new Map();
  for (const a of alokasiAllValid) {
    if (typeof a.jamKe !== 'number') continue;
    const arr = slotsByHariValid.get(a.hari) || [];
    arr.push({ jamKe: a.jamKe, mulai: a.mulaiMenit, selesai: a.selesaiMenit });
    slotsByHariValid.set(a.hari, arr);
  }
  for (const arr of Array.from(slotsByHariValid.values())) { arr.sort((a,b)=>a.mulai-b.mulai); }

  const jadwalAllValid = await prisma.jadwalMengajar.findMany();
  const validJamByDayGroup = new Map(); // key: hari:guruId:kelasId:mapelId -> Set jamKe
  for (const j of jadwalAllValid) {
    const arr = slotsByHariValid.get(j.hari) || [];
    const jamSet = new Set();
    for (const s of arr) { if (s.mulai < j.selesaiMenit && s.selesai > j.mulaiMenit) jamSet.add(s.jamKe); }
    validJamByDayGroup.set(`${j.hari}:${j.guruId}:${j.kelasId}:${j.mapelId}`, new Set(Array.from(jamSet)));
  }

  const dokumentasiRange = await prisma.dokumentasi.findMany({
    where: { createdAt: { gte: start, lte: end } },
    include: { guru: true, mapel: true, kelas: true },
    orderBy: { createdAt: 'desc' },
  });
  const rekamanValid = [];
  for (const s of dokumentasiRange) {
    const day = new Date(s.createdAt).getDay();
    const key = `${day}:${s.guruId}:${s.kelasId}:${s.mapelId}`;
    const validSet = validJamByDayGroup.get(key);
    const jamProvided = [];
    if (Number.isInteger(s.jamKe)) jamProvided.push(s.jamKe);
    if (typeof s.jamKeList === 'string' && s.jamKeList.trim()) {
      s.jamKeList.split(',').forEach(x => { const n = parseInt(x.trim(), 10); if (Number.isInteger(n)) jamProvided.push(n); });
    }
    const jamUniq = Array.from(new Set(jamProvided));
    const isValid = validSet && jamUniq.length ? jamUniq.some(n => validSet.has(n)) : false;
    if (isValid) {
      const fotoUrl = s.fotoPath ? (String(s.fotoPath).startsWith('/') ? s.fotoPath : `/${s.fotoPath}`) : null;
      rekamanValid.push({
        id: s.id,
        waktu: s.createdAt,
        guru: s.guru ? s.guru.nama : String(s.guruId),
        kelas: s.kelas ? s.kelas.nama : (Number.isInteger(s.kelasId) ? String(s.kelasId) : '—'),
        mapel: (s.mapel && s.mapel.kode) ? s.mapel.kode : (Number.isInteger(s.mapelId) ? String(s.mapelId) : '—'),
        jamDikirim: jamUniq.length ? jamUniq.sort((a,b)=>a-b).join(', ') : '—',
        latitude: Number.isFinite(s.latitude) ? s.latitude : null,
        longitude: Number.isFinite(s.longitude) ? s.longitude : null,
        fotoUrl,
      });
    }
  }

  // Mode 'semua' dihapus. Gunakan tiga mode: 'rekap', 'valid', dan 'invalid' saja.

  // Mode valid — tampilkan semua data valid yang memiliki foto
  let validDataRows = [];
  let validTotalRows = 0;
  let validTotalPages = 1;
  if (mode === 'valid') {
    const useAllValid = (!startQ && !endQ && !tanggal);
    let docs = await prisma.dokumentasi.findMany({
      where: useAllValid ? {} : { createdAt: { gte: start, lte: end } },
      include: { guru: true, mapel: true, kelas: true },
      orderBy: { createdAt: 'desc' },
    });
    docs = docs.filter(s => s.fotoPath);
    if (guruIdNum) docs = docs.filter(s => s.guruId === guruIdNum);
    if (kelasIdNum) docs = docs.filter(s => s.kelasId === kelasIdNum);
    if (jamKeNum) {
      docs = docs.filter(s => {
        const jamList = [];
        if (Number.isInteger(s.jamKe)) jamList.push(s.jamKe);
        if (typeof s.jamKeList === 'string' && s.jamKeList.trim()) {
          s.jamKeList.split(',').forEach(x => { const n = parseInt(x.trim(), 10); if (Number.isInteger(n)) jamList.push(n); });
        }
        return jamList.includes(jamKeNum);
      });
    }
    if (hariFilter !== null) {
      docs = docs.filter(s => new Date(s.createdAt).getDay() === hariFilter);
    }
    if (q && String(q).trim()) {
      const ql = String(q).trim().toLowerCase();
      docs = docs.filter(s => {
        const g = s.guru && s.guru.nama ? s.guru.nama.toLowerCase() : '';
        const k = s.kelas && s.kelas.nama ? s.kelas.nama.toLowerCase() : '';
        const m = s.mapel && (s.mapel.kode || s.mapel.nama) ? String(s.mapel.kode || s.mapel.nama).toLowerCase() : '';
        return g.includes(ql) || k.includes(ql) || m.includes(ql);
      });
    }

    // Hitung valid sesuai jadwal
    const validDocs = [];
    for (const s of docs) {
      const day = new Date(s.createdAt).getDay();
      const key = `${day}:${s.guruId}:${s.kelasId}:${s.mapelId}`;
      const validSet = validJamByDayGroup.get(key);
      const jamProvided = [];
      if (Number.isInteger(s.jamKe)) jamProvided.push(s.jamKe);
      if (typeof s.jamKeList === 'string' && s.jamKeList.trim()) {
        s.jamKeList.split(',').forEach(x => { const n = parseInt(x.trim(), 10); if (Number.isInteger(n)) jamProvided.push(n); });
      }
      const jamUniq = Array.from(new Set(jamProvided));
      const isValid = validSet && jamUniq.length ? jamUniq.some(n => validSet.has(n)) : false;
      if (isValid) {
        validDocs.push(s);
      }
    }

    // Agregasi per hari–guru–kelas–mapel untuk menghindari duplikasi
    const aggValid = new Map(); // key -> { latestDoc, jamSet }
    for (const s of validDocs) {
      const day = new Date(s.createdAt).getDay();
      const key = `${day}:${s.guruId}:${s.kelasId}:${s.mapelId}`;
      const v = aggValid.get(key) || { latestDoc: null, jamSet: new Set() };
      const jamProvided = [];
      if (Number.isInteger(s.jamKe)) jamProvided.push(s.jamKe);
      if (typeof s.jamKeList === 'string' && s.jamKeList.trim()) {
        s.jamKeList.split(',').forEach(x => { const n = parseInt(x.trim(), 10); if (Number.isInteger(n)) jamProvided.push(n); });
      }
      jamProvided.forEach(n => v.jamSet.add(n));
      if (!v.latestDoc || new Date(s.createdAt) > new Date(v.latestDoc.createdAt)) {
        v.latestDoc = s;
      }
      aggValid.set(key, v);
    }
    const aggValidList = Array.from(aggValid.values()).map(v => {
      const s = v.latestDoc;
      const fotoUrl = s.fotoPath ? (String(s.fotoPath).startsWith('/') ? s.fotoPath : `/${s.fotoPath}`) : null;
      const jamText = v.jamSet.size ? Array.from(v.jamSet).sort((a,b)=>a-b).join(', ') : '—';
      return {
        id: s.id,
        waktu: s.createdAt,
        waktuLabel: new Date(s.createdAt).toLocaleString('id-ID'),
        guru: s.guru ? s.guru.nama : String(s.guruId),
        kelas: s.kelas ? s.kelas.nama : (Number.isInteger(s.kelasId) ? String(s.kelasId) : '—'),
        mapel: s.mapel ? (s.mapel.kode || s.mapel.nama || '') : (Number.isInteger(s.mapelId) ? String(s.mapelId) : '—'),
        jamDikirim: jamText,
        latitude: Number.isFinite(s.latitude) ? s.latitude : null,
        longitude: Number.isFinite(s.longitude) ? s.longitude : null,
        lokasiValid: (typeof s.isLocationValid === 'boolean') ? (s.isLocationValid ? 'Valid' : 'Tidak Valid') : '—',
        mapsUrl: (Number.isFinite(s.latitude) && Number.isFinite(s.longitude)) ? (`https://www.google.com/maps?q=${s.latitude},${s.longitude}`) : null,
        fotoUrl,
      };
    });

    // Sorting hasil agregasi (mode valid)
    function minJamVal(s) {
      const arr = String(s || '').split(',').map(t => parseInt(t.trim(), 10)).filter(n => Number.isInteger(n));
      return arr.length ? Math.min(...arr) : Number.MAX_SAFE_INTEGER;
    }
    const comparatorsValid = {
      guru: (a, b) => String(a.guru || '').localeCompare(String(b.guru || '')),
      mapel: (a, b) => String(a.mapel || '').localeCompare(String(b.mapel || '')),
      kelas: (a, b) => String(a.kelas || '').localeCompare(String(b.kelas || '')),
      jamDikirim: (a, b) => minJamVal(a.jamDikirim) - minJamVal(b.jamDikirim),
      waktu: (a, b) => new Date(a.waktu).getTime() - new Date(b.waktu).getTime(),
    };
    const sortKeyValid = String(sort || '');
    const dirValid = String(order).toLowerCase() === 'desc' ? -1 : 1;
    const cmpValid = comparatorsValid[sortKeyValid];
    if (cmpValid) aggValidList.sort((a, b) => dirValid * cmpValid(a, b));

    // Paginasi hasil agregasi
    validTotalRows = aggValidList.length;
    validTotalPages = Math.max(1, Math.ceil(validTotalRows / lim));
    const startIdxValid = (pageNum - 1) * lim;
    const visibleValid = aggValidList.slice(startIdxValid, startIdxValid + lim);

    validDataRows = visibleValid;
  }

  // Mode invalid — tampilkan semua data tidak sesuai dengan alasan
  let invalidDataRows = [];
  let invalidTotalRows = 0;
  let invalidTotalPages = 1;
  if (mode === 'invalid') {
    let docs = dokumentasiRange.slice();
    // Filter by guru, kelas, jamKe, hari, q
    if (guruIdNum) docs = docs.filter(s => s.guruId === guruIdNum);
    if (kelasIdNum) docs = docs.filter(s => s.kelasId === kelasIdNum);
    if (jamKeNum) {
      docs = docs.filter(s => {
        const jamList = [];
        if (Number.isInteger(s.jamKe)) jamList.push(s.jamKe);
        if (typeof s.jamKeList === 'string' && s.jamKeList.trim()) {
          s.jamKeList.split(',').forEach(x => { const n = parseInt(x.trim(), 10); if (Number.isInteger(n)) jamList.push(n); });
        }
        return jamList.includes(jamKeNum);
      });
    }
    if (hariFilter !== null) {
      docs = docs.filter(s => new Date(s.createdAt).getDay() === hariFilter);
    }
    if (q && String(q).trim()) {
      const ql = String(q).trim().toLowerCase();
      docs = docs.filter(s => {
        const g = s.guru && s.guru.nama ? s.guru.nama.toLowerCase() : '';
        const k = s.kelas && s.kelas.nama ? s.kelas.nama.toLowerCase() : '';
        const m = s.mapel && (s.mapel.kode || s.mapel.nama) ? String(s.mapel.kode || s.mapel.nama).toLowerCase() : '';
        return g.includes(ql) || k.includes(ql) || m.includes(ql);
      });
    }

    const invalidDocs = [];
    for (const s of docs) {
      const jamProvided = [];
      if (Number.isInteger(s.jamKe)) jamProvided.push(s.jamKe);
      if (typeof s.jamKeList === 'string' && s.jamKeList.trim()) {
        s.jamKeList.split(',').forEach(x => { const n = parseInt(x.trim(), 10); if (Number.isInteger(n)) jamProvided.push(n); });
      }
      const jamUniq = Array.from(new Set(jamProvided));
      const day = new Date(s.createdAt).getDay();
      const validSet = validJamByDayGroup.get(`${day}:${s.guruId}:${s.kelasId}:${s.mapelId}`);

      let isMatch = false;
      let reason = '';
      let extraJamReason = '';
      let extraJamReason2 = '';
      if (validSet) {
        if (jamUniq.length === 0) {
          reason = 'jam kosong';
        } else {
          isMatch = jamUniq.some(n => validSet.has(n));
          if (!isMatch) reason = 'jam mengajar salah';
        }
      } else {
        const list = jadwalAll.filter(j => j.hari === day && j.guruId === s.guruId);
        if (!list.length) {
          reason = 'tidak ada jadwal guru hari ini';
        } else {
          const sameClass = list.filter(g => g.kelasId === s.kelasId);
          const sameSubject = list.filter(g => g.mapelId === s.mapelId);
          if (!sameClass.length && !sameSubject.length) reason = 'kelas salah, mapel salah';
          else if (!sameClass.length) reason = 'kelas salah';
          else if (!sameSubject.length) reason = 'mapel salah';
          else reason = '';
          if (jamUniq.length === 0) {
            extraJamReason = 'jam kosong';
          } else {
            extraJamReason2 = 'jam salah';
            const unionJam = new Set();
            for (const g of list) {
              const sset = validJamByDayGroup.get(`${day}:${s.guruId}:${g.kelasId}:${g.mapelId}`);
              if (sset) sset.forEach(v => unionJam.add(v));
            }
            const anyMatchUnion = jamUniq.some(n => unionJam.has(n));
            if (!anyMatchUnion) {
              extraJamReason = 'jam mengajar salah';
            }
          }
        }
      }

      if (!isMatch) {
        const reasons = [];
        if (reason) reasons.push(reason);
        if (extraJamReason) reasons.push(extraJamReason);
        if (extraJamReason2) reasons.push(extraJamReason2);
        const alasan = reasons.length ? Array.from(new Set(reasons)).join(', ') : 'tidak sesuai';
        invalidDocs.push({
          id: s.id,
          waktu: s.createdAt,
          waktuLabel: new Date(s.createdAt).toLocaleString('id-ID'),
          guru: s.guru ? s.guru.nama : String(s.guruId),
          kelas: s.kelas ? s.kelas.nama : (Number.isInteger(s.kelasId) ? String(s.kelasId) : '—'),
          mapel: s.mapel ? (s.mapel.kode || s.mapel.nama || '') : (Number.isInteger(s.mapelId) ? String(s.mapelId) : '—'),
          jamDikirim: jamUniq.length ? jamUniq.sort((a,b)=>a-b).join(', ') : '—',
          fotoStatus: s.fotoPath ? 'SUDAH' : 'BELUM',
          latitude: Number.isFinite(s.latitude) ? s.latitude : null,
          longitude: Number.isFinite(s.longitude) ? s.longitude : null,
          lokasiValid: (typeof s.isLocationValid === 'boolean') ? (s.isLocationValid ? 'Valid' : 'Tidak Valid') : '—',
          mapsUrl: (Number.isFinite(s.latitude) && Number.isFinite(s.longitude)) ? (`https://www.google.com/maps?q=${s.latitude},${s.longitude}`) : null,
          alasan,
          fotoUrl: s.fotoPath ? (String(s.fotoPath).startsWith('/') ? s.fotoPath : `/${s.fotoPath}`) : null,
        });
      }
    }

    // Agregasi untuk menghindari duplikasi per hari–guru–kelas–mapel
    const aggInvalid = new Map(); // key -> { latest, jamSet, reasonSet }
    for (const s of invalidDocs) {
      const day = new Date(s.waktu).getDay();
      const key = `${day}:${s.guru}:${s.kelas}:${s.mapel}`;
      const v = aggInvalid.get(key) || { latest: null, jamSet: new Set(), reasonSet: new Set() };
      const jamList = String(s.jamDikirim || '').split(',').map(t => parseInt(t.trim(),10)).filter(n => Number.isInteger(n));
      jamList.forEach(n => v.jamSet.add(n));
      String(s.alasan || '').split(',').map(t => t.trim()).filter(Boolean).forEach(r => v.reasonSet.add(r));
      if (!v.latest || new Date(s.waktu) > new Date(v.latest.waktu)) {
        v.latest = s;
      }
      aggInvalid.set(key, v);
    }
    const aggInvalidList = Array.from(aggInvalid.values()).map(v => {
      const s = v.latest;
      const jamText = v.jamSet.size ? Array.from(v.jamSet).sort((a,b)=>a-b).join(', ') : '—';
      const alasanText = v.reasonSet.size ? Array.from(v.reasonSet).join(', ') : 'tidak sesuai';
      return { ...s, jamDikirim: jamText, alasan: alasanText };
    });

    // Sorting hasil agregasi (mode invalid)
    function minJamVal(s) {
      const arr = String(s || '').split(',').map(t => parseInt(t.trim(), 10)).filter(n => Number.isInteger(n));
      return arr.length ? Math.min(...arr) : Number.MAX_SAFE_INTEGER;
    }
    const comparatorsInvalid = {
      guru: (a, b) => String(a.guru || '').localeCompare(String(b.guru || '')),
      mapel: (a, b) => String(a.mapel || '').localeCompare(String(b.mapel || '')),
      kelas: (a, b) => String(a.kelas || '').localeCompare(String(b.kelas || '')),
      jamDikirim: (a, b) => minJamVal(a.jamDikirim) - minJamVal(b.jamDikirim),
      waktu: (a, b) => new Date(a.waktu).getTime() - new Date(b.waktu).getTime(),
      alasan: (a, b) => String(a.alasan || '').localeCompare(String(b.alasan || '')),
    };
    const sortKeyInvalid = String(sort || '');
    const dirInvalid = String(order).toLowerCase() === 'desc' ? -1 : 1;
    const cmpInvalid = comparatorsInvalid[sortKeyInvalid];
    if (cmpInvalid) aggInvalidList.sort((a, b) => dirInvalid * cmpInvalid(a, b));

    // Paginasi hasil agregasi
    invalidTotalRows = aggInvalidList.length;
    invalidTotalPages = Math.max(1, Math.ceil(invalidTotalRows / lim));
    const startIdxInvalid = (pageNum - 1) * lim;
    const visibleInvalid = aggInvalidList.slice(startIdxInvalid, startIdxInvalid + lim);
    invalidDataRows = visibleInvalid;
  }

  res.render('admin/laporan', {
    start: format(start, 'yyyy-MM-dd'),
    end: format(end, 'yyyy-MM-dd'),
    rekap: visible,
    rekamanValid,
    page: pageNum,
    limit: lim,
    totalPages,
    totalRows,
    q: rawQ,
    sort: sortKey,
    order: String(order).toLowerCase(),
    guruList: semuaGuru,
    kelasList: semuaKelas,
    guruId: guruIdNum || '',
    hari: hariFilter === null ? 'all' : String(hariFilter),
    jamKe: jamKeNum || '',
    kelasId: kelasIdNum || '',
    bulkDeleted: req.query.bulkDeleted || undefined,
    bulkFailed: req.query.bulkFailed || undefined,
    mode,
    validData: validDataRows,
    validTotalRows,
    validTotalPages,
    invalidData: typeof invalidDataRows !== 'undefined' ? invalidDataRows : [],
    invalidTotalRows: typeof invalidTotalRows !== 'undefined' ? invalidTotalRows : 0,
    invalidTotalPages: typeof invalidTotalPages !== 'undefined' ? invalidTotalPages : 1,
  });
});

// Hapus bulk dokumentasi berdasarkan checkbox pada rentang tanggal
app.post('/admin/laporan/bulk-delete-dokumentasi', requireAdmin, async (req, res) => {
  try {
    const startQ = req.body.start || '';
    const endQ = req.body.end || '';
    let ids = req.body.ids || req.body['ids[]'];
    let groupKeys = req.body.groupKeys || req.body['groupKeys[]'];

    let targetIds = [];
    if (groupKeys) {
      if (!Array.isArray(groupKeys)) groupKeys = [groupKeys];
      const start = startQ ? startOfDay(new Date(String(startQ))) : startOfDay(new Date());
      const end = endQ ? endOfDay(new Date(String(endQ))) : endOfDay(new Date());

      const alokasiAll = await prisma.alokasiJamBelajar.findMany();
      const slotsByHari = new Map();
      for (const a of alokasiAll) {
        if (typeof a.jamKe !== 'number') continue;
        const arr = slotsByHari.get(a.hari) || [];
        arr.push({ jamKe: a.jamKe, mulai: a.mulaiMenit, selesai: a.selesaiMenit });
        slotsByHari.set(a.hari, arr);
      }
      for (const arr of Array.from(slotsByHari.values())) { arr.sort((a,b)=>a.mulai-b.mulai); }

      const jadwalAll = await prisma.jadwalMengajar.findMany();
      const validJamByDayGroup = new Map();
      for (const j of jadwalAll) {
        const arr = slotsByHari.get(j.hari) || [];
        const jamSet = new Set();
        for (const s of arr) { if (s.mulai < j.selesaiMenit && s.selesai > j.mulaiMenit) jamSet.add(s.jamKe); }
        validJamByDayGroup.set(`${j.hari}:${j.guruId}:${j.kelasId}:${j.mapelId}`, jamSet);
      }

      const dokumentasiRange = await prisma.dokumentasi.findMany({
        where: { createdAt: { gte: start, lte: end } },
        select: { id: true, createdAt: true, guruId: true, kelasId: true, mapelId: true, jamKe: true, jamKeList: true }
      });

      for (const s of dokumentasiRange) {
        const day = new Date(s.createdAt).getDay();
        const key = `${day}:${s.guruId}:${s.kelasId}:${s.mapelId}`;
        const validSet = validJamByDayGroup.get(key);
        if (!validSet) continue;
        const jamProvided = [];
        if (Number.isInteger(s.jamKe)) jamProvided.push(s.jamKe);
        if (typeof s.jamKeList === 'string' && s.jamKeList.trim()) {
          s.jamKeList.split(',').forEach(x => { const n = parseInt(x.trim(), 10); if (Number.isInteger(n)) jamProvided.push(n); });
        }
        const jamUniq = Array.from(new Set(jamProvided));
        const isValid = jamUniq.length ? jamUniq.some(n => validSet.has(n)) : false;
        const gkey = `${s.guruId}:${s.kelasId}:${s.mapelId}`;
        if (isValid && groupKeys.includes(gkey)) {
          targetIds.push(s.id);
        }
      }
    } else if (ids) {
      if (!Array.isArray(ids)) ids = [ids];
      targetIds = ids.map(v => Number(String(v))).filter(n => Number.isInteger(n));
    }

    if (!targetIds || targetIds.length === 0) {
      return res.redirect(`/admin/laporan?start=${encodeURIComponent(startQ)}&end=${encodeURIComponent(endQ)}&bulkDeleted=0&bulkFailed=1`);
    }

    let deleted = 0, failed = 0;
    for (const id of targetIds) {
      try {
        const s = await prisma.dokumentasi.findUnique({ where: { id } });
        if (s && s.fotoPath) {
          const rel = String(s.fotoPath).replace(/^\//,'').replace(/\\/g,'/');
          const fpath = path.join(__dirname, '..', rel);
          try { if (fs.existsSync(fpath)) fs.unlinkSync(fpath); } catch (_) {}
        }
        await prisma.dokumentasi.delete({ where: { id } });
        deleted++;
      } catch (e) {
        failed++;
      }
    }
    return res.redirect(`/admin/laporan?start=${encodeURIComponent(startQ)}&end=${encodeURIComponent(endQ)}&bulkDeleted=${deleted}&bulkFailed=${failed}`);
  } catch (e) {
    return res.redirect(`/admin/laporan?bulkDeleted=0&bulkFailed=1`);
  }
});

// Pengaturan (ubah password admin)
app.get('/admin/pengaturan', requireAdmin, async (req, res) => {
  const isSuperAdmin = String(req.admin?.role || '').toUpperCase() === 'SUPER_ADMIN';
  const users = await prisma.adminUser.findMany({ orderBy: { username: 'asc' } });
  res.render('admin/pengaturan', {
    lokasi: SCHOOL_SETTINGS,
    isSuperAdmin,
    users,
    currentAdminId: req.admin?.id,
    userAdded: req.query.userAdded || undefined,
    resetOk: req.query.resetOk || undefined,
    deletedOk: req.query.deletedOk || undefined,
    errorMsg: req.query.errorMsg || undefined,
  });
});

app.post('/admin/pengaturan', requireAdmin, async (req, res) => {
  const isSuperAdmin = String(req.admin?.role || '').toUpperCase() === 'SUPER_ADMIN';
  const { passwordBaru } = req.body;
  if (!isSuperAdmin) {
    const users = await prisma.adminUser.findMany({ orderBy: { username: 'asc' } });
    return res.render('admin/pengaturan', { error: 'Hanya Super Admin yang dapat mengubah password.', lokasi: SCHOOL_SETTINGS, isSuperAdmin, users, currentAdminId: req.admin?.id });
  }
  if (!passwordBaru || passwordBaru.length < 6) {
    const users = await prisma.adminUser.findMany({ orderBy: { username: 'asc' } });
    return res.render('admin/pengaturan', { error: 'Minimal 6 karakter.', lokasi: SCHOOL_SETTINGS, isSuperAdmin, users, currentAdminId: req.admin?.id });
  }
  const hash = await bcrypt.hash(passwordBaru, 10);
  await prisma.adminUser.update({
    where: { id: req.admin.id },
    data: { passwordHash: hash },
  });
  const users = await prisma.adminUser.findMany({ orderBy: { username: 'asc' } });
  res.render('admin/pengaturan', { success: 'Password diperbarui.', lokasi: SCHOOL_SETTINGS, isSuperAdmin, users, currentAdminId: req.admin?.id });
});

// Kelola Admin User: tambah, reset, hapus
app.post('/admin/pengaturan/user/add', requireAdmin, async (req, res) => {
  const isSuperAdmin = String(req.admin?.role || '').toUpperCase() === 'SUPER_ADMIN';
  if (!isSuperAdmin) return res.redirect('/admin/pengaturan?errorMsg=Hanya%20Super%20Admin%20dapat%20menambah%20user');
  const { username, password } = req.body;
  const uname = String(username || '').trim();
  if (!uname || !password || String(password).length < 6) {
    return res.redirect('/admin/pengaturan?errorMsg=Isi%20username%20dan%20password%20(min%206%20karakter)');
  }
  try {
    const hash = await bcrypt.hash(String(password), 10);
    await prisma.adminUser.create({ data: { username: uname, passwordHash: hash, role: 'ADMIN' } });
    return res.redirect('/admin/pengaturan?userAdded=1');
  } catch (e) {
    const msg = (e && e.code === 'P2002') ? 'Username%20sudah%20digunakan' : ('Gagal%20menambah%20user:%20' + encodeURIComponent(e.message || String(e)));
    return res.redirect('/admin/pengaturan?errorMsg=' + msg);
  }
});

app.post('/admin/pengaturan/user/reset/:id', requireAdmin, async (req, res) => {
  const isSuperAdmin = String(req.admin?.role || '').toUpperCase() === 'SUPER_ADMIN';
  if (!isSuperAdmin) return res.redirect('/admin/pengaturan?errorMsg=Hanya%20Super%20Admin%20dapat%20reset%20password');
  const id = parseInt(String(req.params.id));
  const { passwordBaru } = req.body;
  if (!Number.isInteger(id) || !passwordBaru || String(passwordBaru).length < 6) {
    return res.redirect('/admin/pengaturan?errorMsg=Password%20minimal%206%20karakter');
  }
  try {
    const hash = await bcrypt.hash(String(passwordBaru), 10);
    await prisma.adminUser.update({ where: { id }, data: { passwordHash: hash } });
    return res.redirect('/admin/pengaturan?resetOk=1');
  } catch (e) {
    return res.redirect('/admin/pengaturan?errorMsg=' + encodeURIComponent('Gagal reset password: ' + (e.message || String(e))));
  }
});

app.post('/admin/pengaturan/user/delete/:id', requireAdmin, async (req, res) => {
  const isSuperAdmin = String(req.admin?.role || '').toUpperCase() === 'SUPER_ADMIN';
  if (!isSuperAdmin) return res.redirect('/admin/pengaturan?errorMsg=Hanya%20Super%20Admin%20dapat%20menghapus%20user');
  const id = parseInt(String(req.params.id));
  if (!Number.isInteger(id)) return res.redirect('/admin/pengaturan?errorMsg=ID%20tidak%20valid');
  try {
    if (id === req.admin.id) return res.redirect('/admin/pengaturan?errorMsg=Tidak%20dapat%20menghapus%20akun%20sendiri');
    await prisma.adminUser.delete({ where: { id } });
    return res.redirect('/admin/pengaturan?deletedOk=1');
  } catch (e) {
    return res.redirect('/admin/pengaturan?errorMsg=' + encodeURIComponent('Gagal menghapus user: ' + (e.message || String(e))));
  }
});

// Pengaturan lokasi sekolah (lat, lng, radius meter)
app.post('/admin/pengaturan/lokasi', requireAdmin, (req, res) => {
  const toArr = (v) => Array.isArray(v) ? v : (typeof v === 'undefined' ? [] : [v]);
  const latInputs = toArr(req.body['lat[]'] || req.body.lat);
  const lngInputs = toArr(req.body['lng[]'] || req.body.lng);
  const radInputs = toArr(req.body['radius[]'] || req.body.radius);
  const nameInputs = toArr(req.body['name[]'] || req.body.name);
  const n = Math.max(latInputs.length, lngInputs.length, radInputs.length);
  const locations = [];
  for (let i = 0; i < n; i++) {
    const lt = parseFloat(String(latInputs[i] || ''));
    const lg = parseFloat(String(lngInputs[i] || ''));
    const rd = parseFloat(String(radInputs[i] || ''));
    const nm = String(nameInputs[i] || '').trim();
    if (Number.isFinite(lt) && Number.isFinite(lg) && Number.isFinite(rd) && rd > 0) {
      locations.push({ lat: lt, lng: lg, radius: rd, name: nm || `Lokasi ${i+1}` });
    }
  }
  if (!locations.length) {
    const isSuperAdmin = String(req.admin?.role || '').toUpperCase() === 'SUPER_ADMIN';
    return res.render('admin/pengaturan', { errorLokasi: 'Tambahkan minimal satu titik lokasi yang valid.', lokasi: SCHOOL_SETTINGS, isSuperAdmin });
  }
  const next = { locations };
  const ok = saveSchoolSettings(next);
  if (ok) {
    SCHOOL_SETTINGS = next;
    const isSuperAdmin = String(req.admin?.role || '').toUpperCase() === 'SUPER_ADMIN';
    return res.render('admin/pengaturan', { successLokasi: 'Lokasi sekolah diperbarui.', lokasi: SCHOOL_SETTINGS, isSuperAdmin });
  }
  const isSuperAdmin = String(req.admin?.role || '').toUpperCase() === 'SUPER_ADMIN';
  return res.render('admin/pengaturan', { errorLokasi: 'Gagal menyimpan pengaturan lokasi.', lokasi: SCHOOL_SETTINGS, isSuperAdmin });
});

// Root
app.get('/', (req, res) => {
  res.redirect('/admin/dashboard');
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server berjalan di http://localhost:${PORT}`);
});

app.post('/admin/guru/add', requireAdmin, async (req, res) => {
  const { nama, email } = req.body;
  if (!nama || !nama.trim()) {
    return res.status(400).send('Nama wajib diisi.');
  }
  // generate token unik
  async function genUniqueToken() {
    while (true) {
      const token = 'token-' + crypto.randomBytes(12).toString('hex');
      const exists = await prisma.guru.findUnique({ where: { uploadToken: token } });
      if (!exists) return token;
    }
  }
  try {
    const token = await genUniqueToken();
    await prisma.guru.create({
      data: {
        nama: nama.trim(),
        email: email && email.trim() ? email.trim() : null,
        uploadToken: token,
        aktif: true,
      },
    });
    res.redirect('/admin/guru');
  } catch (e) {
    res.status(500).send('Gagal menambah guru: ' + e.message);
  }
});

app.post('/admin/guru/reset-token/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  async function genUniqueToken() {
    while (true) {
      const token = 'token-' + crypto.randomBytes(12).toString('hex');
      const exists = await prisma.guru.findUnique({ where: { uploadToken: token } });
      if (!exists) return token;
    }
  }
  try {
    const tokenBaru = await genUniqueToken();
    await prisma.guru.update({
      where: { id },
      data: { uploadToken: tokenBaru },
    });
    res.redirect('/admin/guru');
  } catch (e) {
    res.status(500).send('Gagal reset token: ' + e.message);
  }
});

// Edit data Guru
app.post('/admin/guru/edit/:id', requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    const nama = String(req.body.nama || '').trim();
    const email = String(req.body.email || '').trim();
    if (!nama) {
      return res.status(400).send('Nama wajib diisi');
    }
    await prisma.guru.update({
      where: { id },
      data: { nama, email: email || null },
    });
    res.redirect('/admin/guru');
  } catch (e) {
    res.status(500).send('Gagal edit guru: ' + e.message);
  }
});

// Hapus data Guru
app.post('/admin/guru/delete/:id', requireAdmin, async (req, res) => {
  try {
    const id = Number(req.params.id);
    await prisma.guru.delete({ where: { id } });
    res.redirect('/admin/guru');
  } catch (e) {
    res.status(500).send('Gagal hapus guru: ' + e.message);
  }
});

// Bulk delete Guru
app.post('/admin/guru/bulk-delete', requireAdmin, async (req, res) => {
  try {
    let ids = req.body.ids || req.body['ids[]'];
    if (!ids) return res.redirect('/admin/guru');
    if (!Array.isArray(ids)) ids = [ids];
    const idNums = ids
      .map((v) => Number(String(v)))
      .filter((n) => Number.isInteger(n));
    if (idNums.length === 0) return res.redirect('/admin/guru');
    await prisma.guru.deleteMany({ where: { id: { in: idNums } } });
    res.redirect('/admin/guru');
  } catch (e) {
    res.status(500).send('Gagal hapus massal: ' + e.message);
  }
});

// Template CSV untuk impor Data Guru
app.get('/admin/guru/template.csv', requireAdmin, async (req, res) => {
  const sample = [
    'nama,email',
    'Budi Santoso,budi.santoso@example.com',
    'Siti Aminah,siti.aminah@example.com',
    'Ahmad Fauzi,ahmad.fauzi@example.com',
    'Dewi Lestari,dewi.lestari@example.com',
    'Rudi Hartono,rudi.hartono@example.com'
  ].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="template_guru.csv"');
  res.send(sample);
});

// Fallback endpoint tanpa ekstensi untuk template Guru
app.get('/admin/guru/template', requireAdmin, async (req, res) => {
  const sample = [
    'nama,email',
    'Budi Santoso,budi.santoso@example.com',
    'Siti Aminah,siti.aminah@example.com',
    'Ahmad Fauzi,ahmad.fauzi@example.com',
    'Dewi Lestari,dewi.lestari@example.com',
    'Rudi Hartono,rudi.hartono@example.com'
  ].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="template_guru.csv"');
  res.send(sample);
});

// Impor CSV Data Guru
app.post('/admin/guru/import', requireAdmin, csvUpload.single('file'), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).send('File CSV wajib diunggah');
    }
    let text = req.file.buffer.toString('utf-8');
    // Hilangkan BOM jika ada
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const lines = text.split(/\r\n|\n|\r/).filter(l => l.trim().length > 0);
    if (lines.length === 0) return res.redirect('/admin/guru');

    // Deteksi delimiter: gunakan ';' jika lebih banyak dari ','
    const first = lines[0];
    const useSemicolon = (first.match(/;/g) || []).length > (first.match(/,/g) || []).length;
    const delimiter = useSemicolon ? ';' : ',';

    // Parse header
    const splitLine = (line) => line.split(new RegExp(delimiter + '(?=(?:[^\"]*\"[^\"]*\")*[^\"]*$)'));
    const header = splitLine(first).map(h => h.trim().replace(/^"|"$/g, '').toLowerCase());
    let idxNama = header.indexOf('nama');
    let idxEmail = header.indexOf('email');
    // Deteksi apakah baris pertama adalah header
    const hasHeader = (idxNama !== -1) || (idxEmail !== -1);
    let startIdx = hasHeader ? 1 : 0;
    if (!hasHeader) {
      // Asumsi: kolom pertama nama, kedua email (opsional)
      idxNama = 0; idxEmail = 1;
    }
    const normalizeEmail = (s) => {
      const e = String(s || '').trim();
      if (!e) return null;
      const lower = e.toLowerCase();
      if (lower === '@example.com' || lower === 'example@example.com' || lower === 'email@example.com') return null;
      const simple = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
      if (!simple.test(e)) return null;
      return lower;
    };

    async function genUniqueToken() {
      while (true) {
        const token = 'token-' + crypto.randomBytes(12).toString('hex');
        const exists = await prisma.guru.findUnique({ where: { uploadToken: token } });
        if (!exists) return token;
      }
    }

    let imported = 0, skipped = 0, failed = 0;
    for (let i = startIdx; i < lines.length; i++) {
      const cols = splitLine(lines[i]).map(v => v.trim().replace(/^"|"$/g, ''));
      const nama = (cols[idxNama] || '').trim();
      const emailRaw = (typeof idxEmail !== 'undefined' && idxEmail >= 0) ? (cols[idxEmail] || '').trim() : '';
      const email = normalizeEmail(emailRaw);
      if (!nama) { skipped++; continue; }
      try {
        const token = await genUniqueToken();
        await prisma.guru.create({
          data: {
            nama,
            email: email ? email : null,
            uploadToken: token,
            aktif: true,
          }
        });
        imported++;
      } catch (e) {
        if (e && e.code === 'P2002') { // unik email atau token bentrok
          skipped++;
        } else {
          failed++;
        }
      }
    }
    res.redirect(`/admin/guru?imported=${imported}&skipped=${skipped}&failed=${failed}`);
  } catch (e) {
    res.status(500).send('Gagal impor CSV: ' + e.message);
  }
});
// Galeri dengan filter guru/mapel + rentang tanggal
app.get('/admin/galeri', requireAdmin, async (req, res) => {
  const { tanggal, start, end, guruId, mapelId } = req.query;
  let startDate, endDate;
  if (start || end) {
    const s = start ? new Date(String(start)) : new Date();
    const e = end ? new Date(String(end)) : new Date();
    startDate = startOfDay(s);
    endDate = endOfDay(e);
  } else {
    const date = tanggal ? new Date(String(tanggal)) : new Date();
    startDate = startOfDay(date);
    endDate = endOfDay(date);
  }

  const where = { createdAt: { gte: startDate, lte: endDate }, fotoPath: { not: '' } };
  if (guruId) where.guruId = Number(guruId);
  if (mapelId) where.mapelId = Number(mapelId);

  const [docsRaw, guru, mapel] = await Promise.all([
    prisma.dokumentasi.findMany({
      where,
      include: { guru: true, mapel: true, kelas: true },
      orderBy: { createdAt: 'desc' }
    }),
    prisma.guru.findMany({ orderBy: { nama: 'asc' } }),
    prisma.mapel.findMany({ orderBy: { nama: 'asc' } })
  ]);

  // Tampilkan hanya satu foto terbaru per guru dalam rentang (atau satu foto jika guru dipilih)
  let docs = [];
  if (guruId) {
    docs = docsRaw.slice(0, 1);
  } else {
    const byGuru = new Map();
    for (const d of docsRaw) {
      const key = d.guruId;
      if (!byGuru.has(key)) byGuru.set(key, d);
    }
    docs = Array.from(byGuru.values());
  }

  res.render('admin/galeri', {
    docs,
    tanggal: tanggal ? format(new Date(String(tanggal)), 'yyyy-MM-dd') : '',
    start: format(startDate, 'yyyy-MM-dd'),
    end: format(endDate, 'yyyy-MM-dd'),
    guru,
    mapel,
    selectedGuruId: guruId ? Number(guruId) : '',
    selectedMapelId: mapelId ? Number(mapelId) : '',
    bulkDeleted: req.query.bulkDeleted || undefined,
    bulkFailed: req.query.bulkFailed || undefined,
    canDelete: String(req.admin?.role || '').toUpperCase() === 'SUPER_ADMIN',
  });
});

// Bulk delete Galeri Foto Harian (hapus file fisik dan kosongkan fotoPath)
app.post('/admin/galeri/bulk-delete', requireAdmin, async (req, res) => {
  try {
    const isSuperAdmin = String(req.admin?.role || '').toUpperCase() === 'SUPER_ADMIN';
    if (!isSuperAdmin) return res.redirect('/admin/galeri?bulkDeleted=0&bulkFailed=1');

    let ids = req.body.ids || req.body['ids[]'];
    if (!ids) return res.redirect('/admin/galeri');
    if (!Array.isArray(ids)) ids = [ids];
    const idNums = ids.map(v => Number(String(v))).filter(n => Number.isInteger(n));
    if (idNums.length === 0) return res.redirect('/admin/galeri');

    // Ambil path foto untuk dihapus dari filesystem
    const rows = await prisma.dokumentasi.findMany({
      where: { id: { in: idNums } },
      select: { id: true, fotoPath: true }
    });

    // Hapus file fisik dengan penanganan path absolut/relatif
    let filesDeleted = 0;
    let filesFailed = 0;
    await Promise.allSettled(rows.map(async (r) => {
      const raw = String(r.fotoPath || '').trim();
      if (!raw) return;
      const rel = raw.replace(/^[\\/]+/, '');
      const full = path.isAbsolute(raw) ? raw : path.join(__dirname, '..', rel);
      try {
        await fs.promises.unlink(full);
        filesDeleted++;
      } catch (_) {
        filesFailed++;
      }
    }));

    // Jangan hapus entri DB; kosongkan fotoPath agar Galeri tidak menampilkan
    await prisma.dokumentasi.updateMany({
      where: { id: { in: idNums } },
      data: { fotoPath: '' }
    });

    res.redirect(`/admin/galeri?bulkDeleted=${filesDeleted}&bulkFailed=${filesFailed}`);
  } catch (e) {
    res.redirect('/admin/galeri?bulkDeleted=0&bulkFailed=1');
  }
});

// ================= ADMIN: Mapel =================
app.get('/admin/mapel', requireAdmin, async (req, res) => {
  const { page = '1', limit = '10', sort = 'nama', order = 'asc', q = '' } = req.query;
  const all = await prisma.mapel.findMany();

  let rows = all.map(m => ({ id: m.id, nama: m.nama || '', kode: m.kode || '', no: 0 }));

  const query = String(q || '').trim().toLowerCase();
  if (query) {
    rows = rows.filter(r => r.nama.toLowerCase().includes(query) || r.kode.toLowerCase().includes(query));
  }

  const comparators = {
    nama: (a, b) => a.nama.localeCompare(b.nama),
    kode: (a, b) => a.kode.localeCompare(b.kode),
  };
  const cmp = comparators[sort] || comparators.nama;
  rows.sort(cmp);
  if (String(order).toLowerCase() === 'desc') rows.reverse();

  const pageNum = Math.max(1, parseInt(page));
  const lim = Math.max(1, parseInt(limit));
  const totalRows = rows.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / lim));
  const startIdx = (pageNum - 1) * lim;
  const visible = rows.slice(startIdx, startIdx + lim).map((r, i) => ({ ...r, no: startIdx + i + 1 }));

  res.render('admin/mapel', {
    mapel: visible,
    page: pageNum,
    limit: lim,
    totalPages,
    totalRows,
    q,
    sort,
    order,
    imported: req.query.imported || undefined,
    skipped: req.query.skipped || undefined,
    failed: req.query.failed || undefined,
    bulkDeleted: req.query.bulkDeleted || undefined,
    bulkFailed: req.query.bulkFailed || undefined,
  });
});
app.post('/admin/mapel', requireAdmin, async (req, res) => {
  const { nama, kode } = req.body;
  if (!nama || !nama.trim()) return res.status(400).send('Nama mapel wajib diisi.');
  if (!kode || !kode.trim()) return res.status(400).send('Kode mapel wajib diisi.');
  try {
    await prisma.mapel.create({ data: { nama: nama.trim(), kode: kode.trim() } });
    res.redirect('/admin/mapel');
  } catch (e) {
    if (e && e.code === 'P2002') {
      return res.status(400).send('Nama atau kode mapel sudah digunakan.');
    }
    res.status(500).send('Gagal menambah mapel: ' + e.message);
  }
});
app.post('/admin/mapel/edit/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const { nama, kode } = req.body;
  if (!nama || !nama.trim()) return res.status(400).send('Nama mapel wajib diisi.');
  if (!kode || !kode.trim()) return res.status(400).send('Kode mapel wajib diisi.');
  try {
    await prisma.mapel.update({ where: { id }, data: { nama: nama.trim(), kode: kode.trim() } });
    res.redirect('/admin/mapel');
  } catch (e) {
    if (e && e.code === 'P2002') {
      return res.status(400).send('Nama atau kode mapel sudah digunakan.');
    }
    res.status(500).send('Gagal mengedit mapel: ' + e.message);
  }
});
app.post('/admin/mapel/delete/:id', requireAdmin, async (req, res) => {
  try {
    await prisma.mapel.delete({ where: { id: Number(req.params.id) } });
    res.redirect('/admin/mapel');
  } catch (e) {
    res.status(500).send('Gagal menghapus mapel: ' + e.message);
  }
});

// Bulk delete Mapel
app.post('/admin/mapel/bulk-delete', requireAdmin, async (req, res) => {
  try {
    let ids = req.body.ids || req.body['ids[]'];
    if (!ids) return res.redirect('/admin/mapel');
    if (!Array.isArray(ids)) ids = [ids];
    const idNums = ids.map(v => Number(String(v))).filter(n => Number.isInteger(n));
    if (idNums.length === 0) return res.redirect('/admin/mapel');
    const result = await prisma.mapel.deleteMany({ where: { id: { in: idNums } } });
    const deleted = typeof result === 'number' ? result : (result && result.count) ? result.count : 0;
    res.redirect(`/admin/mapel?bulkDeleted=${deleted}&bulkFailed=0`);
  } catch (e) {
    res.redirect('/admin/mapel?bulkDeleted=0&bulkFailed=1');
  }
});

// Template CSV untuk impor Mapel
app.get('/admin/mapel/template.csv', requireAdmin, async (req, res) => {
  const sample = [
    'nama,kode',
    'Matematika,MAT',
    'Bahasa Indonesia,BIN',
    'Fisika,FIS',
    'Kimia,KIM',
    'Biologi,BIO',
    'Sejarah,SEJ',
    'Geografi,GEO',
    'Ekonomi,EKO',
    'Sosiologi,SOS',
    'Bahasa Inggris,ENG'
  ].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="template_mapel.csv"');
  res.send(sample);
});

// Fallback endpoint tanpa ekstensi, untuk menghindari kemungkinan rewrite masalah ekstensi
app.get('/admin/mapel/template', requireAdmin, async (req, res) => {
  const sample = [
    'nama,kode',
    'Matematika,MAT',
    'Bahasa Indonesia,BIN',
    'Fisika,FIS',
    'Kimia,KIM',
    'Biologi,BIO',
    'Sejarah,SEJ',
    'Geografi,GEO',
    'Ekonomi,EKO',
    'Sosiologi,SOS',
    'Bahasa Inggris,ENG'
  ].join('\n');
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="template_mapel.csv"');
  res.send(sample);
});

// Impor CSV Mapel
app.post('/admin/mapel/import', requireAdmin, csvUpload.single('file'), async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).send('File CSV wajib diunggah');
    }
    let text = req.file.buffer.toString('utf-8');
    // Hilangkan BOM jika ada
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const lines = text.split(/\r?\n/).filter(l => l.trim().length > 0);
    if (lines.length === 0) return res.redirect('/admin/mapel');

    // Deteksi delimiter: gunakan ';' jika lebih banyak dari ','
    const first = lines[0];
    const useSemicolon = (first.match(/;/g) || []).length > (first.match(/,/g) || []).length;
    const delimiter = useSemicolon ? ';' : ',';

    // Parse header
    const splitLine = (line) => line.split(new RegExp(delimiter + '(?=(?:[^\"]*\"[^\"]*\")*[^\"]*$)'));
    const header = splitLine(first).map(h => h.trim().replace(/^"|"$/g, '').toLowerCase());
    let idxNama = header.indexOf('nama');
    let idxKode = header.indexOf('kode');
    const startIdx = 1;
    if (idxNama === -1 && idxKode === -1) {
      // Asumsikan kolom pertama nama, kedua kode
      idxNama = 0; idxKode = 1;
    }

    let imported = 0, skipped = 0, failed = 0;
    for (let i = startIdx; i < lines.length; i++) {
      const cols = splitLine(lines[i]).map(v => v.trim().replace(/^"|"$/g, ''));
      const nama = (cols[idxNama] || '').trim();
      const kode = (typeof idxKode !== 'undefined' && idxKode >= 0) ? (cols[idxKode] || '').trim() : '';
      if (!nama) { skipped++; continue; }
      try {
        await prisma.mapel.create({ data: { nama, kode: kode || null } });
        imported++;
      } catch (e) {
        if (e && e.code === 'P2002') {
          skipped++;
        } else {
          failed++;
        }
      }
    }
    res.redirect(`/admin/mapel?imported=${imported}&skipped=${skipped}&failed=${failed}`);
  } catch (e) {
    res.status(500).send('Gagal impor CSV: ' + e.message);
  }
});

// ================= ADMIN: Kelas =================
app.get('/admin/kelas', requireAdmin, async (req, res) => {
  const { page = '1', limit = '20', sort = 'tingkat', order = 'asc', q = '' } = req.query;
  const all = await prisma.kelas.findMany();

  // Bentuk baris untuk tabel
  let rows = all.map(k => ({
    id: k.id,
    nama: k.nama || '',
    tingkat: k.tingkat || '',
    kode: k.kode || '',
    no: 0,
  }));

  // Filter pencarian
  const query = String(q || '').trim().toLowerCase();
  if (query) {
    rows = rows.filter(r =>
      r.nama.toLowerCase().includes(query) ||
      r.kode.toLowerCase().includes(query) ||
      r.tingkat.toLowerCase().includes(query)
    );
  }

  // Sorting
  const tingkatOrder = { 'X': 1, 'XI': 2, 'XII': 3 };
  const comparators = {
    tingkat: (a, b) => (tingkatOrder[a.tingkat] || 99) - (tingkatOrder[b.tingkat] || 99),
    nama: (a, b) => a.nama.localeCompare(b.nama),
    kode: (a, b) => a.kode.localeCompare(b.kode),
  };
  const cmp = comparators[sort] || comparators.tingkat;
  rows.sort(cmp);
  if (String(order).toLowerCase() === 'desc') rows.reverse();

  // Paginasi
  const pageNum = Math.max(1, parseInt(page));
  const lim = Math.max(1, parseInt(limit));
  const totalRows = rows.length;
  const totalPages = Math.max(1, Math.ceil(totalRows / lim));
  const startIdx = (pageNum - 1) * lim;
  const visible = rows.slice(startIdx, startIdx + lim).map((r, i) => ({ ...r, no: startIdx + i + 1 }));

  res.render('admin/kelas', {
    kelas: visible,
    page: pageNum,
    limit: lim,
    totalPages,
    totalRows,
    q,
    sort,
    order,
    bulkDeleted: req.query.bulkDeleted || undefined,
    bulkFailed: req.query.bulkFailed || undefined,
  });
});
app.post('/admin/kelas', requireAdmin, async (req, res) => {
  const { nama, tingkat, kode } = req.body;
  if (!nama || !nama.trim()) return res.status(400).send('Nama kelas wajib diisi.');
  if (!tingkat || !tingkat.trim()) return res.status(400).send('Tingkat kelas wajib diisi.');
  if (!kode || !kode.trim()) return res.status(400).send('Kode kelas wajib diisi.');
  try {
    await prisma.kelas.create({ data: { nama: nama.trim(), tingkat: tingkat.trim(), kode: kode.trim() } });
    res.redirect('/admin/kelas');
  } catch (e) {
    if (e && e.code === 'P2002') {
      return res.status(400).send('Nama kelas sudah digunakan.');
    }
    res.status(500).send('Gagal menambah kelas: ' + e.message);
  }
});
app.post('/admin/kelas/edit/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const { nama, tingkat, kode } = req.body;
  if (!nama || !nama.trim()) return res.status(400).send('Nama kelas wajib diisi.');
  if (!tingkat || !tingkat.trim()) return res.status(400).send('Tingkat kelas wajib diisi.');
  if (!kode || !kode.trim()) return res.status(400).send('Kode kelas wajib diisi.');
  try {
    await prisma.kelas.update({ where: { id }, data: { nama: nama.trim(), tingkat: tingkat.trim(), kode: kode.trim() } });
    res.redirect('/admin/kelas');
  } catch (e) {
    if (e && e.code === 'P2002') {
      return res.status(400).send('Nama kelas sudah digunakan.');
    }
    res.status(500).send('Gagal mengedit kelas: ' + e.message);
  }
});
app.post('/admin/kelas/delete/:id', requireAdmin, async (req, res) => {
  try {
    await prisma.kelas.delete({ where: { id: Number(req.params.id) } });
    res.redirect('/admin/kelas');
  } catch (e) {
    res.status(500).send('Gagal menghapus kelas: ' + e.message);
  }
});

// Bulk delete Kelas
app.post('/admin/kelas/bulk-delete', requireAdmin, async (req, res) => {
  try {
    let ids = req.body.ids || req.body['ids[]'];
    if (!ids) return res.redirect('/admin/kelas');
    if (!Array.isArray(ids)) ids = [ids];
    const idNums = ids.map(v => Number(String(v))).filter(n => Number.isInteger(n));
    if (idNums.length === 0) return res.redirect('/admin/kelas');
    const result = await prisma.kelas.deleteMany({ where: { id: { in: idNums } } });
    const deleted = typeof result === 'number' ? result : (result && result.count) ? result.count : 0;
    res.redirect(`/admin/kelas?bulkDeleted=${deleted}&bulkFailed=0`);
  } catch (e) {
    res.redirect('/admin/kelas?bulkDeleted=0&bulkFailed=1');
  }
});

// Edit Alokasi Jam
app.post('/admin/alokasi/edit/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const { hari, mulai, selesai, jamKe, keterangan } = req.body;
  function toMinutes(hhmm) {
    const [h, m] = String(hhmm).split(':').map(Number);
    return (h * 60) + (m || 0);
  }
  try {
    const hariNum = Number(hari);
    if (!Number.isInteger(hariNum) || hariNum < 0 || hariNum > 6) {
      return res.status(400).send('Hari tidak valid.');
    }
    if (!mulai || !selesai) {
      return res.status(400).send('Waktu mulai dan selesai wajib diisi.');
    }
    const mulaiMenit = toMinutes(mulai);
    const selesaiMenit = toMinutes(selesai);
    if (selesaiMenit <= mulaiMenit) {
      return res.status(400).send('Waktu selesai harus lebih besar dari waktu mulai.');
    }
    let jamKeVal = null;
    if (jamKe !== undefined && jamKe !== null && String(jamKe).trim() !== '') {
      const j = Number(jamKe);
      if (!Number.isInteger(j) || j < 1 || j > 12) {
        return res.status(400).send('Jam Ke harus antara 1 hingga 12 atau dikosongkan untuk istirahat.');
      }
      jamKeVal = j;
    }

    await prisma.alokasiJamBelajar.update({
      where: { id },
      data: {
        hari: hariNum,
        mulaiMenit,
        selesaiMenit,
        jamKe: jamKeVal,
        keterangan: keterangan || null,
      },
    });
    res.redirect('/admin/alokasi');
  } catch (e) {
    res.status(500).send('Gagal mengedit alokasi: ' + (e && e.message ? e.message : e));
  }
});

// Import Jadwal dari aSc Timetables (CSV/TSV sederhana)
app.post('/admin/jadwal/import-asc', requireAdmin, csvUpload.single('file'), async (req, res) => {
  // Dinonaktifkan sesuai permintaan: kembalikan 404 agar tidak dapat diakses
  return res.status(404).send('Fitur impor Jadwal aSc dinonaktifkan.');
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).send('File tidak ditemukan.');
    }
    const text = req.file.buffer.toString('utf8');
    const lines = text.split(/\r?\n/).filter(l => l.trim() !== '');
    if (lines.length < 2) return res.redirect('/admin/jadwal?failedAsc=1');

    // Deteksi delimiter: koma, titik koma, atau tab
    const headerLine = lines[0];
    const delim = (headerLine.includes('\t')) ? '\t' : (headerLine.includes(';') ? ';' : ',');
    const split = (line) => line.split(new RegExp(delim)).map(s => s.trim().replace(/^"|"$/g, ''));

    const header = split(headerLine).map(h => h.toLowerCase());
    const idxDay = header.findIndex(h => /day|hari/.test(h));
    const idxStart = header.findIndex(h => /start|awal|begin|from/.test(h));
    const idxEnd = header.findIndex(h => /end|selesai|finish|to/.test(h));
    const idxClass = header.findIndex(h => /class|kelas/.test(h));
    const idxTeacher = header.findIndex(h => /teacher|guru/.test(h));
    const idxSubject = header.findIndex(h => /subject|mapel|lesson/.test(h));
    if ([idxDay, idxStart, idxEnd, idxClass, idxTeacher, idxSubject].some(i => i < 0)) {
      return res.status(400).send('Header CSV tidak sesuai. Harus memuat kolom Day, Start, End, Class, Teacher, Subject.');
    }

    const dayIndex = (s) => {
      const v = String(s || '').trim().toLowerCase();
      const map = {
        'ahad': 0, 'minggu': 0, 'sunday': 0, 'sun': 0,
        'senin': 1, 'monday': 1, 'mon': 1,
        'selasa': 2, 'tuesday': 2, 'tue': 2,
        'rabu': 3, 'wednesday': 3, 'wed': 3,
        'kamis': 4, 'thursday': 4, 'thu': 4,
        'jumat': 5, 'friday': 5, 'fri': 5,
        'sabtu': 6, 'saturday': 6, 'sat': 6,
      };
      return (v in map) ? map[v] : null;
    };
    const toMinutes = (hhmmRaw) => {
      const s = String(hhmmRaw || '').trim().replace(/\./g, ':');
      const m = s.match(/^(\d{1,2}):(\d{2})$/);
      if (!m) return null;
      const h = parseInt(m[1], 10);
      const mi = parseInt(m[2], 10);
      if (isNaN(h) || isNaN(mi)) return null;
      return (h * 60) + mi;
    };
    const ensureGuru = async (nama) => {
      if (!nama) return null;
      let g = await prisma.guru.findFirst({ where: { nama } });
      if (!g) {
        const tok = (crypto.randomUUID ? crypto.randomUUID() : ('tok_' + Date.now() + '_' + Math.random().toString(36).slice(2)));
        g = await prisma.guru.create({ data: { nama, uploadToken: tok } });
      }
      return g;
    };
    const ensureMapel = async (nama) => {
      if (!nama) return null;
      let m = await prisma.mapel.findFirst({ where: { nama } });
      if (!m) m = await prisma.mapel.create({ data: { nama } });
      return m;
    };
    const ensureKelas = async (nama) => {
      if (!nama) return null;
      let k = await prisma.kelas.findFirst({ where: { nama } });
      if (!k) k = await prisma.kelas.create({ data: { nama } });
      return k;
    };

    let imported = 0, skipped = 0, failed = 0;
    for (let i = 1; i < lines.length; i++) {
      const cols = split(lines[i]);
      if (!cols.length || cols.every(c => !c)) continue;
      const day = dayIndex(cols[idxDay]);
      const start = toMinutes(cols[idxStart]);
      const end = toMinutes(cols[idxEnd]);
      const kelasNama = cols[idxClass];
      const guruNama = cols[idxTeacher];
      const mapelNama = cols[idxSubject];
      if (day === null || start === null || end === null || !kelasNama || !guruNama || !mapelNama) { failed++; continue; }
      try {
        const g = await ensureGuru(guruNama);
        const m = await ensureMapel(mapelNama);
        const k = await ensureKelas(kelasNama);
        if (!g || !m || !k) { failed++; continue; }

        // Cek duplikat jadwal
        const exists = await prisma.jadwalMengajar.findFirst({
          where: { guruId: g.id, mapelId: m.id, kelasId: k.id, hari: day, mulaiMenit: start, selesaiMenit: end },
        });
        if (exists) { skipped++; continue; }

        await prisma.jadwalMengajar.create({
          data: { guruId: g.id, mapelId: m.id, kelasId: k.id, hari: day, mulaiMenit: start, selesaiMenit: end },
        });
        // Optional: relasi MapelGuru
        await prisma.mapelGuru.upsert({
          where: { guruId_mapelId: { guruId: g.id, mapelId: m.id } },
          update: {},
          create: { guruId: g.id, mapelId: m.id },
        });
        imported++;
      } catch (e) {
        failed++;
      }
    }
    return res.redirect(`/admin/jadwal?importedAsc=${imported}&skippedAsc=${skipped}&failedAsc=${failed}`);
  } catch (e) {
    return res.status(500).send('Gagal impor aSc Timetables: ' + (e && e.message ? e.message : e));
  }
});

// Tampilan Jadwal Guru (Grid), filter per Guru dan per Kelas
app.get('/admin/jadwal/view-grid', requireAdmin, async (req, res) => {
  try {
    const { guruId = '', kelasId = '' } = req.query;
    const [guru, mapel, kelas, alokasi, jadwalRaw] = await Promise.all([
      prisma.guru.findMany({ orderBy: { nama: 'asc' } }),
      prisma.mapel.findMany({ orderBy: { nama: 'asc' } }),
      prisma.kelas.findMany({ orderBy: [{ tingkat: 'asc' }, { nama: 'asc' }] }),
      prisma.alokasiJamBelajar.findMany(),
      prisma.jadwalMengajar.findMany({ include: { guru: true, mapel: true, kelas: true } }),
    ]);

    const toHHMM = (m) => `${String(Math.floor(m/60)).padStart(2,'0')}:${String(m%60).padStart(2,'0')}`;
    const maxJam = 10;

    // Jam labels (abaikan hari untuk label, ambil per jamKe)
    const jamTimeMap = new Map();
    const breakSet = new Set();
    const slotToJam = new Map();
    for (const a of alokasi) {
      if (typeof a.jamKe === 'number' && a.jamKe >= 1 && a.jamKe <= 12) {
        if (!jamTimeMap.has(a.jamKe)) jamTimeMap.set(a.jamKe, { mulaiMenit: a.mulaiMenit, selesaiMenit: a.selesaiMenit });
        slotToJam.set(`${a.hari}:${a.mulaiMenit}:${a.selesaiMenit}`, a.jamKe);
      } else {
        const key = `${a.mulaiMenit}-${a.selesaiMenit}`;
        breakSet.add(key);
      }
    }
    const jamLabels = Array.from({ length: maxJam }, (_, i) => {
      const slot = jamTimeMap.get(i + 1);
      return slot ? `${toHHMM(slot.mulaiMenit)}–${toHHMM(slot.selesaiMenit)}` : null;
    });
    const breaks = Array.from(breakSet).map(k => {
      const [mulai, selesai] = k.split('-').map(n => parseInt(n, 10));
      return `${toHHMM(mulai)}–${toHHMM(selesai)}`;
    });

    // Filter jadwal dan petakan ke grid hari:jamKe
    let gid = parseInt(String(guruId || ''));
    let kid = parseInt(String(kelasId || ''));
    let hasGuru = Number.isInteger(gid);
    let hasKelas = Number.isInteger(kid);

    // Default: jika tidak ada guru dipilih, pilih guru teratas
    if (!hasGuru && Array.isArray(guru) && guru.length) {
      gid = guru[0].id;
      hasGuru = true;
    }

    const filtered = jadwalRaw.filter(j => {
      if (hasGuru && j.guruId !== gid) return false;
      if (hasKelas && j.kelasId !== kid) return false;
      return true;
    });

    const grid = {}; // key: "hari:jamKe" -> array of items
    filtered.forEach(j => {
      const jamKe = slotToJam.get(`${j.hari}:${j.mulaiMenit}:${j.selesaiMenit}`);
      if (!Number.isInteger(jamKe)) return;
      const key = `${j.hari}:${jamKe}`;
      (grid[key] ||= []).push({
        guruId: j.guruId, guruNama: j.guru.nama,
        kelasId: j.kelasId, kelasNama: j.kelas.nama,
        mapelId: j.mapelId, mapelNama: j.mapel.nama, mapelKode: j.mapel.kode,
      });
    });

    // Ringkasan total jam (sesuai logika Data Guru: hitung slot unik per hari:jamKe)
    const countDistinctSlots = (rows) => {
      const set = new Set();
      for (const j of rows) {
        const ke = slotToJam.get(`${j.hari}:${j.mulaiMenit}:${j.selesaiMenit}`);
        if (Number.isInteger(ke)) {
          set.add(`${j.hari}:${ke}`);
        } else {
          // fallback jika slot belum dipetakan
          set.add(`${j.hari}:${j.mulaiMenit}:${j.selesaiMenit}`);
        }
      }
      return set.size;
    };

    const totalJamGuru = hasGuru ? countDistinctSlots(jadwalRaw.filter(j => j.guruId === gid)) : 0;
    const totalJamGuruDiKelas = (hasGuru && hasKelas) ? countDistinctSlots(jadwalRaw.filter(j => j.guruId === gid && j.kelasId === kid)) : null;
    const totalJamKelas = hasKelas ? countDistinctSlots(jadwalRaw.filter(j => j.kelasId === kid)) : 0;

    const selectedGuruName = hasGuru ? ((guru || []).find(g => g.id === gid)?.nama || null) : null;
    const selectedKelasName = hasKelas ? ((kelas || []).find(k => k.id === kid)?.nama || null) : null;

    // Total Mapel guru (sinkron dengan Data Guru) dari relasi MapelGuru
    let totalMapelGuru = 0;
    if (hasGuru) {
      try {
        totalMapelGuru = await prisma.mapelGuru.count({ where: { guruId: gid } });
      } catch (_) {}
    }

    res.render('admin/jadwal_grid_view', {
      guru, mapel, kelas,
      selectedGuruId: hasGuru ? gid : null,
      selectedKelasId: hasKelas ? kid : null,
      maxJam, jamLabels, breaks,
      grid,
      summary: {
        totalJamGuru,
        totalJamKelas,
        totalJamGuruDiKelas,
        totalMapelGuru,
        selectedGuruName,
        selectedKelasName,
      },
    });
  } catch (e) {
    res.status(500).send('Gagal memuat Jadwal Guru (Grid): ' + (e && e.message ? e.message : e));
  }
});