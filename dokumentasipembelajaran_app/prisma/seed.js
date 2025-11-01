require('dotenv').config();
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcrypt');

const prisma = new PrismaClient();

async function main() {
  // Admin users: superadmin and admin
  const superAdminUsername = 'superadmin';
  const superAdminPassword = 'super123'; // ganti setelah login
  const superAdminHash = await bcrypt.hash(superAdminPassword, 10);

  await prisma.adminUser.upsert({
    where: { username: superAdminUsername },
    update: {},
    create: { username: superAdminUsername, passwordHash: superAdminHash, role: 'SUPER_ADMIN' },
  });

  const adminUsername = 'admin';
  const adminPassword = 'admin123'; // ganti setelah login
  const adminHash = await bcrypt.hash(adminPassword, 10);

  await prisma.adminUser.upsert({
    where: { username: adminUsername },
    update: {},
    create: { username: adminUsername, passwordHash: adminHash, role: 'ADMIN' },
  });

  // Mapel
  const m1 = await prisma.mapel.upsert({
    where: { nama: 'Matematika' },
    update: {},
    create: { nama: 'Matematika' },
  });
  const m2 = await prisma.mapel.upsert({
    where: { nama: 'Bahasa Indonesia' },
    update: {},
    create: { nama: 'Bahasa Indonesia' },
  });

  // Kelas
  const k1 = await prisma.kelas.upsert({
    where: { nama: 'VII-A' },
    update: {},
    create: { nama: 'VII-A' },
  });
  const k2 = await prisma.kelas.upsert({
    where: { nama: 'VIII-B' },
    update: {},
    create: { nama: 'VIII-B' },
  });

  // Guru
  const g1 = await prisma.guru.upsert({
    where: { email: 'guru1@sekolah.sch.id' },
    update: {},
    create: { nama: 'Bapak Andi', email: 'guru1@sekolah.sch.id', uploadToken: 'token-andi-123' },
  });
  const g2 = await prisma.guru.upsert({
    where: { email: 'guru2@sekolah.sch.id' },
    update: {},
    create: { nama: 'Ibu Sari', email: 'guru2@sekolah.sch.id', uploadToken: 'token-sari-456' },
  });

  // Relasi MapelGuru
  await prisma.mapelGuru.upsert({
    where: { guruId_mapelId: { guruId: g1.id, mapelId: m1.id } },
    update: {},
    create: { guruId: g1.id, mapelId: m1.id },
  });
  await prisma.mapelGuru.upsert({
    where: { guruId_mapelId: { guruId: g2.id, mapelId: m2.id } },
    update: {},
    create: { guruId: g2.id, mapelId: m2.id },
  });

  // Jadwal contoh
  await prisma.jadwalMengajar.create({
    data: { guruId: g1.id, mapelId: m1.id, kelasId: k1.id, hari: 1, mulaiMenit: 480, selesaiMenit: 540 },
  }); // Senin 08:00-09:00
  await prisma.jadwalMengajar.create({
    data: { guruId: g2.id, mapelId: m2.id, kelasId: k2.id, hari: 2, mulaiMenit: 600, selesaiMenit: 660 },
  }); // Selasa 10:00-11:00

  // Isi Alokasi Jam sesuai daftar yang diberikan
  // Bersihkan alokasi sebelumnya agar tidak duplikat
  await prisma.alokasiJamBelajar.deleteMany({});

  function toMin(h, m) { return (h * 60) + m; }
  const entries = [];
  function add(hari, sh, sm, eh, em, jamKe, ket){
    entries.push({ hari, mulaiMenit: toMin(sh, sm), selesaiMenit: toMin(eh, em), jamKe, keterangan: ket });
  }

  // Senin–Kamis dan Sabtu (hari: 1,2,3,4,6)
  [1,2,3,4,6].forEach(hari => {
    add(hari, 7, 0, 7, 40, 1, 'Senin-Kamis/Sabtu');
    add(hari, 7, 40, 8, 20, 2, 'Senin-Kamis/Sabtu');
    add(hari, 8, 20, 9, 0, 3, 'Senin-Kamis/Sabtu');
    add(hari, 9, 0, 9, 40, 4, 'Senin-Kamis/Sabtu');
    // Istirahat 1
    add(hari, 9, 40, 9, 55, null, 'Istirahat 1');
    add(hari, 9, 55, 10, 30, 5, 'Senin-Kamis/Sabtu');
    add(hari, 10, 30, 11, 5, 6, 'Senin-Kamis/Sabtu');
    add(hari, 11, 5, 11, 40, 7, 'Senin-Kamis/Sabtu');
    // Istirahat 2
    add(hari, 11, 40, 12, 20, null, 'Istirahat 2');
    add(hari, 12, 20, 12, 55, 8, 'Senin-Kamis/Sabtu');
    add(hari, 12, 55, 13, 40, 9, 'Senin-Kamis/Sabtu');
    add(hari, 13, 40, 14, 25, 10, 'Senin-Kamis/Sabtu');
  });

  // Jumat (hari: 5)
  [5].forEach(hari => {
    add(hari, 7, 0, 7, 40, 1, 'Jumat');
    add(hari, 7, 40, 8, 20, 2, 'Jumat');
    add(hari, 8, 20, 9, 0, 3, 'Jumat');
    add(hari, 9, 0, 9, 40, 4, 'Jumat');
    // Istirahat 1
    add(hari, 9, 40, 9, 55, null, 'Istirahat 1');
    add(hari, 9, 55, 10, 35, 5, 'Jumat');
    add(hari, 10, 35, 11, 15, 6, 'Jumat');
  });

  await prisma.alokasiJamBelajar.createMany({ data: entries });
  console.log('Alokasi jam terisi sesuai daftar.');

  console.log('Seed selesai.');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });