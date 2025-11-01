(function(){
  // Tema gelap/terang
  const root = document.documentElement;
  try { const saved = localStorage.getItem('admin_theme'); if (saved === 'dark') root.classList.add('dark'); } catch(e){}
  const themeBtn = document.getElementById('themeBtn');
  if (themeBtn) {
    themeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      root.classList.toggle('dark');
      try { localStorage.setItem('admin_theme', root.classList.contains('dark') ? 'dark' : 'light'); } catch(e){}
    });
  }

  // Sidebar toggles: sidebar button (pojok kiri) + header hamburger (mobile)
  const sidebarBtn = document.getElementById('sidebarToggle');
  let headerBtn = document.getElementById('headerSidebarToggle');
  if (!headerBtn) {
    const btn = document.createElement('button');
    btn.id = 'headerSidebarToggle';
    btn.type = 'button';
    btn.className = 'hamburger-btn';
    btn.textContent = '☰';
    // Default: append to body (visible meski .main-top disembunyikan di mobile)
    document.body.appendChild(btn);
    headerBtn = btn;
  }
  // Reposisi tombol tergantung viewport
  function placeHeaderButton(){
    if (!headerBtn) return;
    const isMobile = window.innerWidth <= 980;
    if (isMobile) {
      if (headerBtn.parentElement !== document.body) document.body.appendChild(headerBtn);
    } else {
      const mt = document.querySelector('.main-top');
      if (mt && headerBtn.parentElement !== mt) mt.prepend(headerBtn);
    }
  }
  placeHeaderButton();
  window.addEventListener('resize', placeHeaderButton);
  try { if (localStorage.getItem('sidebar_collapsed') === '1') root.classList.add('sidebar-collapsed'); } catch(e){}
  // Backdrop overlay untuk sidebar mobile
  let sidebarBackdrop = document.getElementById('sidebarBackdrop');
  function ensureSidebarBackdrop(){
    if (!sidebarBackdrop) {
      sidebarBackdrop = document.createElement('div');
      sidebarBackdrop.id = 'sidebarBackdrop';
      sidebarBackdrop.className = 'sidebar-backdrop';
      document.body.appendChild(sidebarBackdrop);
      sidebarBackdrop.addEventListener('click', () => {
        root.classList.remove('sidebar-open');
      });
    }
  }
  const handleToggle = (e) => {
    e.preventDefault();
    const isMobile = window.innerWidth <= 980;
    if (isMobile) {
      ensureSidebarBackdrop();
      const willOpen = !root.classList.contains('sidebar-open');
      root.classList.toggle('sidebar-open', willOpen);
    } else {
      root.classList.toggle('sidebar-collapsed');
      try { localStorage.setItem('sidebar_collapsed', root.classList.contains('sidebar-collapsed') ? '1' : '0'); } catch(e){}
    }
  };
  if (sidebarBtn) sidebarBtn.addEventListener('click', handleToggle);
  if (headerBtn) headerBtn.addEventListener('click', handleToggle);
  // Tutup sidebar via ESC di mobile
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && window.innerWidth <= 980) {
      root.classList.remove('sidebar-open');
    }
  });

  // Highlight menu aktif
  const links = document.querySelectorAll('.sidebar nav a');
  const path = location.pathname.replace(/\/+$/, '');
  links.forEach(a => {
    const href = a.getAttribute('href').replace(/\/+$/, '');
    if (href === path) a.classList.add('active');
  });

  // Tampilkan nama halaman di bar atas (main-top) atau sebagai badge di kiri atas
  (function(){
    const segments = path.split('/').filter(Boolean);
    const last = segments[segments.length - 1] || 'dashboard';
    const names = {
      dashboard: 'Dashboard',
      realtime: 'Realtime',
      guru: 'Data Guru',
      mapel: 'Mapel',
      kelas: 'Kelas',
      jadwal: 'Jadwal',
      alokasi: 'Alokasi Jam',
      laporan: 'Laporan',
      galeri: 'Galeri',
      pengaturan: 'Pengaturan Akun'
    };
    const pageLabel = names[last] || 'Admin';
    const mainTop = document.querySelector('.main-top');
    if (mainTop) {
      let nameEl = mainTop.querySelector('.page-name');
      if (!nameEl) {
        nameEl = document.createElement('span');
        nameEl.className = 'page-name';
        mainTop.prepend(nameEl);
      }
      nameEl.textContent = pageLabel;
    }
  })();

  // Handler global untuk dropdown "Tampilkan" (limit pagination)
  document.addEventListener('DOMContentLoaded', function(){
    const selects = document.querySelectorAll('select[id^="limitSelect"]');
    selects.forEach(function(sel){
      if (sel.dataset.limitBound === '1') return;
      sel.dataset.limitBound = '1';
      sel.addEventListener('change', function(){
        const params = new URLSearchParams(window.location.search);
        params.set('limit', this.value);
        params.set('page', '1');
        const url = window.location.pathname + '?' + params.toString();
        window.location.href = url;
      });
    });
  });

  // Jam real-time (jika elemen ada)
  const liveTime = document.getElementById('liveTime');
  if (liveTime) { const tick = () => liveTime.textContent = new Date().toLocaleTimeString('id-ID', { hour12:false }); tick(); setInterval(tick, 1000); }

  // Ripple effect pada button dan link pills
  function addRipple(el) {
    el.style.position = 'relative'; el.style.overflow = 'hidden';
    el.addEventListener('click', function (e) {
      const rect = el.getBoundingClientRect();
      const ripple = document.createElement('span');
      const size = Math.max(rect.width, rect.height);
      ripple.style.width = ripple.style.height = size + 'px';
      ripple.style.left = (e.clientX - rect.left - size/2) + 'px';
      ripple.style.top  = (e.clientY - rect.top  - size/2) + 'px';
      ripple.className = 'ripple';
      el.appendChild(ripple);
      setTimeout(() => ripple.remove(), 600);
    });
  }
  document.querySelectorAll('button, .links a, .sidebar nav a').forEach(addRipple);

  // Login helpers
  document.addEventListener('DOMContentLoaded', () => {
    const userInput = document.getElementById('userInput');
    const passInput = document.getElementById('password');
    const toggle = document.getElementById('togglePass');
    const loginBtn = document.getElementById('loginBtn');
    const remember = document.getElementById('rememberUser');
  
    // Floating label
    [userInput, passInput].forEach((inp) => {
      if (!inp) return;
      inp.addEventListener('input', () => {
        inp.parentElement.classList.toggle('has-value', !!inp.value);
      });
    });
  
    // Toggle password
    if (toggle && passInput) {
      toggle.addEventListener('click', () => {
        const isText = passInput.type === 'text';
        passInput.type = isText ? 'password' : 'text';
        toggle.innerText = isText ? 'Lihat' : 'Sembunyikan';
      });
    }
  
    // Remember user + loading animasi
    try {
      const lastUser = localStorage.getItem('last_admin_user');
      if (lastUser && userInput) {
        userInput.value = lastUser;
        userInput.parentElement.classList.add('has-value');
      }
      if (remember && localStorage.getItem('remember_admin_user') === '1') {
        remember.checked = true;
      }
  
      const form = document.querySelector('.auth-form');
      if (form && loginBtn) {
        form.addEventListener('submit', () => {
          loginBtn.classList.add('loading');
          if (remember?.checked) {
            localStorage.setItem('remember_admin_user', '1');
            localStorage.setItem('last_admin_user', userInput?.value || '');
          } else {
            localStorage.removeItem('remember_admin_user');
          }
        });
      }
    } catch(e) {}
  });

  // Masker waktu HH:MM untuk form Alokasi (Tambah & Edit)
  document.addEventListener('DOMContentLoaded', () => {
    const forms = Array.from(document.querySelectorAll('form.form-alokasi, form.form-alokasi-edit'));
    if (!forms.length) return;

    forms.forEach((form) => {
      const startEl = form.querySelector('input.time-input[name="mulai"]');
      const endEl = form.querySelector('input.time-input[name="selesai"]');
    const re = /^(?:[01]\d|2[0-3]):(?:[0-5]\d)$/;

    const fmt = (val) => {
      const digits = String(val || '').replace(/\D/g, '').slice(0, 4);
      if (digits.length >= 3) return `${digits.slice(0,2)}:${digits.slice(2)}`;
      return digits;
    };
    const toMin = (s) => {
      const m = String(s || '').match(/^(\d{2}):(\d{2})$/);
      if (!m) return NaN;
      return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
    };

      [startEl, endEl].forEach((el) => {
        if (!el) return;
        el.setAttribute('inputmode', 'numeric');
        el.setAttribute('maxlength', '5');
        el.setAttribute('placeholder', 'HH:MM');
        el.setAttribute('pattern', '^(?:[01]\\d|2[0-3]):(?:[0-5]\\d)$');
        el.setAttribute('title', 'Masukkan waktu 24 jam: HH:MM');
        el.addEventListener('input', () => {
          const v = fmt(el.value);
          if (v !== el.value) el.value = v;
          el.setCustomValidity('');
        });
        el.addEventListener('blur', () => {
          const v = el.value;
          if (!re.test(v)) {
            el.setCustomValidity('Format waktu harus HH:MM (00-23:00-59)');
          } else {
            el.setCustomValidity('');
          }
        });
      });

      form.addEventListener('submit', () => {
        const s = startEl?.value || '';
        const e = endEl?.value || '';
        if (re.test(s) && re.test(e)) {
          const sm = toMin(s);
          const em = toMin(e);
          if (!Number.isNaN(sm) && !Number.isNaN(em) && em <= sm) {
            endEl?.setCustomValidity('Waktu selesai harus lebih besar dari waktu mulai');
          } else {
            endEl?.setCustomValidity('');
          }
        }
      });
    });
  });

  // Intersep submit Tambah Alokasi untuk menampilkan toast dan reload
  document.addEventListener('DOMContentLoaded', () => {
    if (!location.pathname.endsWith('/admin/alokasi')) return;
    const addForm = document.querySelector('form.form-alokasi');
    const addModal = document.getElementById('alokasiModal');
    if (addForm && addModal) {
      addForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          const formData = new FormData(addForm);
          const resp = await fetch(addForm.getAttribute('action') || '/admin/alokasi', {
            method: 'POST',
            body: new URLSearchParams([...formData.entries()])
          });
          if (!resp.ok) {
            const txt = await resp.text();
            throw new Error(txt || resp.statusText);
          }
          // Tutup modal, tampilkan toast, lalu reload untuk daftar terbaru
          addModal.classList.add('hidden');
          showToast('Berhasil disimpan');
          try { sessionStorage.setItem('admin_toast', 'Berhasil disimpan'); } catch(e){}
          window.location.reload();
        } catch(err) {
          showToast('Gagal menyimpan', { type: 'error', duration: 3000 });
          alert('Gagal menyimpan: ' + (err && err.message ? err.message : err));
        }
      });
    }
  });
  const userInput = document.querySelector('input[name="username"]');
  const form = document.querySelector('form[action="/admin/login"]');
  if (userInput && form) {
    try {
      const lastUser = localStorage.getItem('last_admin_user');
      if (lastUser) userInput.value = lastUser;
      form.addEventListener('submit', () => localStorage.setItem('last_admin_user', userInput.value));
    } catch(e){}
  }

  // Hilangkan tombol Sidebar/Tema yang duplikat & hapus blok dashboard kedua
  document.addEventListener('DOMContentLoaded', () => {
    // Bind tema aman: hanya satu tombol (di header)
    const themeBtn = document.getElementById('themeToggle');
    if (themeBtn) {
      themeBtn.addEventListener('click', () => {
        document.documentElement.classList.toggle('dark');
        try {
          const isDark = document.documentElement.classList.contains('dark');
          localStorage.setItem('admin_theme', isDark ? 'dark' : 'light');
        } catch(e) {}
      });
    }
  
    // Sidebar toggle: handled globally di atas; blok duplikat dihapus
    // JANGAN hapus elemen secara massal lagi (hindari kekacauan)
    // Hapus kode lama yang menghapus .page-header/.metrics-grid/tombol duplikat.
    document.addEventListener('DOMContentLoaded', () => {
      const authBtn = document.getElementById('loginBtn');
      if (authBtn) {
        authBtn.addEventListener('click', (e) => {
          const circle = document.createElement('span');
          const rect = authBtn.getBoundingClientRect();
          const size = Math.max(rect.width, rect.height);
          circle.style.width = circle.style.height = `${size}px`;
          circle.style.left = `${e.clientX - rect.left - size / 2}px`;
          circle.style.top = `${e.clientY - rect.top - size / 2}px`;
          circle.className = 'ripple-circle';
          authBtn.appendChild(circle);
          setTimeout(() => circle.remove(), 600);
        });
      }
    });
  });

  // Handler modal Edit Alokasi: close via backdrop, tombol X, atau Batal
  document.addEventListener('DOMContentLoaded', () => {
    const backdrop = document.getElementById('editModalBackdrop');
    if (!backdrop) return; // Modal hanya ada saat query ?edit=...
    const closeButtons = backdrop.querySelectorAll('[data-modal-close]');
    const modal = backdrop.querySelector('.modal');
    const editForm = backdrop.querySelector('form.form-alokasi-edit');

    function closeModalPreserveParams() {
      try {
        const params = new URLSearchParams(window.location.search);
        params.delete('edit');
        const next = params.toString();
        window.location.search = next ? next : '';
      } catch(e) {
        window.location.href = '/admin/alokasi';
      }
    }

    // Simpan flag toast agar muncul setelah reload pasca submit server-rendered edit
    if (editForm) {
      editForm.addEventListener('submit', () => {
        try { sessionStorage.setItem('admin_toast', 'Berhasil disimpan'); } catch(e){}
      });
    }

    closeButtons.forEach(btn => {
      btn.addEventListener('click', (e) => { e.preventDefault(); closeModalPreserveParams(); });
    });

    backdrop.addEventListener('click', (e) => {
      if (e.target === backdrop) closeModalPreserveParams();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeModalPreserveParams();
    });
  });

  // Klik baris tabel untuk membuka modal edit (menetapkan ?edit=<id>)
  document.addEventListener('DOMContentLoaded', () => {
    // Hanya aktif di halaman Alokasi
    if (!location.pathname.endsWith('/admin/alokasi')) return;
    const rows = Array.from(document.querySelectorAll('.table-realtime tbody tr.row-edit'));
    rows.forEach((tr) => {
      tr.style.cursor = 'pointer';
      tr.addEventListener('click', async (e) => {
        const t = e.target;
        if (t.closest('.table-actions')) return; // biarkan tombol/tautan asli bekerja
        const id = tr.getAttribute('data-edit-id');
        if (!id) return;
        e.preventDefault();
        openEditAlokasiModalAjax(id);
      });
    });
    // Intersep klik "Edit" agar membuka modal AJAX
    document.querySelectorAll('.table-actions a.pill-link').forEach((a) => {
      if (/\?edit=\d+/.test(a.getAttribute('href') || '')) {
        a.addEventListener('click', (e) => {
          e.preventDefault();
          const tr = a.closest('tr.row-edit');
          const id = tr?.getAttribute('data-edit-id');
          if (id) openEditAlokasiModalAjax(id);
        });
      }
    });
  });

  // Tampilkan toast pasca reload jika ada pesan disimpan di sessionStorage
  document.addEventListener('DOMContentLoaded', () => {
    try {
      const msg = sessionStorage.getItem('admin_toast');
      if (msg) {
        showToast(msg);
        sessionStorage.removeItem('admin_toast');
      }
    } catch(e) {}
  });

  // Notifikasi untuk halaman Pengaturan: parse query & flash server
  document.addEventListener('DOMContentLoaded', () => {
    const isSettings = location.pathname.replace(/\/+$/,'').endsWith('/admin/pengaturan');
    if (!isSettings) return;
    const params = new URLSearchParams(location.search);
    const show = (text, type='success') => { if (text) showToast(text, { type }); };

    // Dari query string (aksi user add/reset/delete)
    if (params.has('userAdded')) show('User baru ditambahkan.', 'success');
    if (params.has('resetOk')) show('Password user berhasil direset.', 'success');
    if (params.has('deletedOk')) show('User berhasil dihapus.', 'success');
    const errMsg = params.get('errorMsg');
    if (errMsg) show(decodeURIComponent(errMsg), 'error');

    // Bersihkan query agar tidak muncul lagi saat refresh
    ['userAdded','resetOk','deletedOk','errorMsg'].forEach((k) => params.delete(k));
    const newUrl = location.pathname + (params.toString() ? ('?' + params.toString()) : '');
    try { history.replaceState(null, '', newUrl); } catch(e) {}

    // Dari flash server (ubah password & lokasi)
    try {
      const flashEl = document.getElementById('serverFlash');
      if (flashEl) {
        const d = JSON.parse(flashEl.textContent || '{}');
        if (d && d.success) show(String(d.success), 'success');
        if (d && d.error) show(String(d.error), 'error');
        if (d && d.successLokasi) show(String(d.successLokasi), 'success');
        if (d && d.errorLokasi) show(String(d.errorLokasi), 'error');
      }
    } catch(e) {}
  });

  // Intersep form Reset/Hapus user di Pengaturan untuk notifikasi instan
  document.addEventListener('DOMContentLoaded', () => {
    const isSettings = location.pathname.replace(/\/+$/,'').endsWith('/admin/pengaturan');
    if (!isSettings) return;
    const table = document.querySelector('.table-realtime');
    if (!table) return;

    // Helper: renumber kolom No setelah penghapusan
    const renumber = () => {
      const rows = Array.from(table.querySelectorAll('tbody tr'));
      rows.forEach((tr, i) => {
        const cell = tr.querySelector('td');
        if (cell) cell.textContent = String(i + 1);
      });
    };

    // Reset Password
    table.querySelectorAll('form[action*="/admin/pengaturan/user/reset/"]').forEach((form) => {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        // Konfirmasi sebelum reset password
        const tr = form.closest('tr');
        const nameCell = tr ? tr.querySelector('td:nth-child(2)') : null; // asumsi kolom ke-2 adalah username
        const nama = nameCell ? nameCell.textContent.trim() : null;
        const question = nama ? `Yakin reset password user \"${nama}\"?` : 'Yakin reset password user ini?';
        const ok = window.confirm(`${question}`);
        if (!ok) return;
        try {
          const fd = new FormData(form);
          const resp = await fetch(form.action, { method: 'POST', body: new URLSearchParams([...fd.entries()]) });
          if (!resp.ok) throw new Error(await resp.text());
          // Bersihkan input dan tampilkan toast
          const inp = form.querySelector('input[name="passwordBaru"]');
          if (inp) inp.value = '';
          showToast('Password user berhasil direset');
        } catch(err) {
          showToast('Gagal reset password', { type: 'error', duration: 3000 });
        }
      });
    });

    // Tidak ada fitur hapus pada Pengaturan; aman jika tidak menemukan form
  });
  // Hapus tombol duplikat (jika ada markup lama)
  ['sidebarToggle', 'themeToggle'].forEach((id) => {
    const nodes = Array.from(document.querySelectorAll(`#${id}`));
    nodes.forEach((n, i) => {
      if (i > 0) n.remove();
    });
  });
  
  // Hapus blok Page Header & Metrics yang muncul lebih dari sekali
  Array.from(document.querySelectorAll('.page-header'))
    .slice(1)
    .forEach((el) => el.remove());
  Array.from(document.querySelectorAll('.metrics-grid'))
    .slice(1)
    .forEach((el) => el.remove());
  
  // Animasi angka pada kartu metrik
  const animateCount = (el, to, duration = 800) => {
    const start = 0;
    const startTime = performance.now();
    const step = (now) => {
      const progress = Math.min((now - startTime) / duration, 1);
      const value = Math.floor(start + (to - start) * progress);
      el.textContent = value;
      if (progress < 1) requestAnimationFrame(step);
    };
    document.querySelectorAll('.metric-value').forEach((el) => {
      const target = parseInt(el.getAttribute('data-count') || el.textContent || '0', 10);
      animateCount(el, target);
    });
  
  // Isi aktivitas terbaru (contoh dinamis; bisa diganti data nyata)
  const recent = [
    { text: 'Guru A mengirim dokumentasi', time: '10:12' },
    { text: 'Guru B menambahkan foto kelas', time: '09:58' },
    { text: 'Guru C memperbarui jadwal', time: '09:30' }
  ];
  const list = document.getElementById('recentActivity');
  if (list) {
    recent.forEach((r) => {
      const li = document.createElement('li');
      const spanText = document.createElement('span');
      const spanTime = document.createElement('span');
      spanText.textContent = r.text;
      spanTime.textContent = r.time;
      spanTime.className = 'muted';
      li.appendChild(spanText);
      li.appendChild(spanTime);
      list.appendChild(li);
    });
  }
  
  // Grafik aktivitas sederhana tanpa library
  const canvas = document.getElementById('activityChart');
  if (canvas) {
    const ctx = canvas.getContext('2d');
    const w = canvas.width;
    const h = canvas.height;
    const days = 7;
    const data = Array.from({ length: days }, () => Math.floor(Math.random() * 10) + 1);
    const max = Math.max(...data);
    const pad = 16;
    const stepX = (w - pad * 2) / (days - 1);
  
    // Background soft gradient
    const grad = ctx.createLinearGradient(0, 0, 0, h);
    grad.addColorStop(0, 'rgba(33,150,243,0.25)');
    grad.addColorStop(1, 'rgba(33,150,243,0.0)');
  
    ctx.clearRect(0, 0, w, h);
  
    // Area fill
    ctx.beginPath();
    data.forEach((v, i) => {
      const x = pad + i * stepX;
      const y = h - pad - (v / max) * (h - pad * 2);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.lineTo(w - pad, h - pad);
    ctx.lineTo(pad, h - pad);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
  
    // Line
    ctx.beginPath();
    ctx.lineWidth = 2;
    ctx.strokeStyle = '#2196f3';
    data.forEach((v, i) => {
      const x = pad + i * stepX;
      const y = h - pad - (v / max) * (h - pad * 2);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
    ctx.stroke();
  
    // Points
    ctx.fillStyle = '#2196f3';
    data.forEach((v, i) => {
      const x = pad + i * stepX;
      const y = h - pad - (v / max) * (h - pad * 2);
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fill();
    });
  }
  }
})();

// Util: Toast notifikasi sederhana
function showToast(message, opts) {
  const options = Object.assign({ type: 'success', duration: 2200 }, opts || {});
  let container = document.getElementById('toastContainer');
  if (!container) {
    container = document.createElement('div');
    container.id = 'toastContainer';
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  const toast = document.createElement('div');
  toast.className = 'toast ' + (options.type === 'error' ? 'toast-error' : 'toast-success');
  toast.textContent = message;
  container.appendChild(toast);
  // Auto-hide
  setTimeout(() => { toast.classList.add('hide'); }, options.duration);
  toast.addEventListener('animationend', () => {
    if (toast.classList.contains('hide')) {
      toast.remove();
      if (container.childElementCount === 0) container.remove();
    }
  });
}

// ===== Modal AJAX Edit Alokasi =====
function openEditAlokasiModalAjax(id) {
  fetch(`/admin/alokasi/${encodeURIComponent(id)}`)
    .then((res) => {
      if (!res.ok) throw new Error('Gagal memuat data');
      return res.json();
    })
    .then((data) => {
      const overlay = document.createElement('div');
      overlay.className = 'modal-backdrop';
      overlay.id = 'editModalBackdropAjax';
      const hariMap = ['Ahad','Senin','Selasa','Rabu','Kamis','Jumat','Sabtu'];
      const toHHMM = (m) => {
        const h = String(Math.floor(m/60)).padStart(2,'0');
        const mi = String(m%60).padStart(2,'0');
        return `${h}:${mi}`;
      };
      overlay.innerHTML = `
        <div class="modal" role="dialog" aria-modal="true" aria-labelledby="editModalTitleAjax">
          <div class="modal-header">
            <h3 id="editModalTitleAjax" style="margin:0;">Edit Alokasi (ID ${data.id})</h3>
            <button type="button" class="modal-close" title="Tutup" aria-label="Tutup" data-modal-close>&times;</button>
          </div>
          <form method="post" action="/admin/alokasi/edit/${data.id}" class="form-alokasi-edit">
            <div class="field">
              <label>Hari</label>
              <select name="hari" required class="select-input">
                ${hariMap.map((nm, i) => `<option value="${i}" ${data.hari===i?'selected':''}>${nm}</option>`).join('')}
              </select>
            </div>
            <div class="field">
              <label>Mulai</label>
              <input type="text" name="mulai" required class="time-input" inputmode="numeric" maxlength="5" pattern="^([01]\\d|2[0-3]):([0-5]\\d)$" value="${toHHMM(data.mulaiMenit)}">
            </div>
            <div class="field">
              <label>Selesai</label>
              <input type="text" name="selesai" required class="time-input" inputmode="numeric" maxlength="5" pattern="^([01]\\d|2[0-3]):([0-5]\\d)$" value="${toHHMM(data.selesaiMenit)}">
            </div>
            <div class="field">
              <label>Jam Ke</label>
              <select name="jamKe" class="select-input">
                <option value="">(kosongkan untuk istirahat)</option>
                ${Array.from({length:12}, (_,i)=>i+1).map((n)=>`<option value="${n}" ${data.jamKe===n?'selected':''}>${n}</option>`).join('')}
              </select>
            </div>
            <div class="field field-wide">
              <label>Keterangan</label>
              <input type="text" name="keterangan" placeholder="opsional" value="${data.keterangan || ''}">
            </div>
            <div class="field field-actions" style="display:flex; gap:8px;">
              <button type="submit">Simpan</button>
              <a class="pill-link" href="#" data-modal-close>Batal</a>
            </div>
          </form>
        </div>
      `;
      document.body.appendChild(overlay);
      // Close handlers
      const close = () => { try { overlay.remove(); } catch(e) {} };
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
      overlay.querySelectorAll('[data-modal-close]').forEach((btn) => btn.addEventListener('click', (e) => { e.preventDefault(); close(); }));
      document.addEventListener('keydown', function esc(e){ if (e.key === 'Escape') { close(); document.removeEventListener('keydown', esc); } });

      // Apply time input mask/validation untuk form baru
      (function applyMask(form){
        const startEl = form.querySelector('input.time-input[name="mulai"]');
        const endEl = form.querySelector('input.time-input[name="selesai"]');
        const re = /^(?:[01]\d|2[0-3]):(?:[0-5]\d)$/;
        const fmt = (val) => {
          const digits = String(val || '').replace(/\D/g, '').slice(0, 4);
          if (digits.length >= 3) return `${digits.slice(0,2)}:${digits.slice(2)}`;
          return digits;
        };
        const toMin = (s) => {
          const m = String(s || '').match(/^(\d{2}):(\d{2})$/);
          if (!m) return NaN;
          return parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
        };
        [startEl, endEl].forEach((el) => {
          if (!el) return;
          el.setAttribute('inputmode', 'numeric');
          el.setAttribute('maxlength', '5');
          el.setAttribute('placeholder', 'HH:MM');
          el.setAttribute('pattern', '^(?:[01]\\d|2[0-3]):(?:[0-5]\\d)$');
          el.setAttribute('title', 'Masukkan waktu 24 jam: HH:MM');
          el.addEventListener('input', () => {
            const v = fmt(el.value);
            if (v !== el.value) el.value = v;
            el.setCustomValidity('');
          });
          el.addEventListener('blur', () => {
            const v = el.value;
            if (!re.test(v)) {
              el.setCustomValidity('Format waktu harus HH:MM (00-23:00-59)');
            } else {
              el.setCustomValidity('');
            }
          });
        });
        form.addEventListener('submit', async (e) => {
          e.preventDefault();
          const s = startEl?.value || '';
          const t = endEl?.value || '';
          if (re.test(s) && re.test(t)) {
            const sm = toMin(s);
            const em = toMin(t);
            if (!Number.isNaN(sm) && !Number.isNaN(em) && em <= sm) {
              endEl?.setCustomValidity('Waktu selesai harus lebih besar dari waktu mulai');
              endEl?.reportValidity();
              return;
            } else {
              endEl?.setCustomValidity('');
            }
          }
          // Submit via fetch untuk pengalaman mulus
          try {
            const formData = new FormData(form);
            const resp = await fetch(form.getAttribute('action'), { method: 'POST', body: new URLSearchParams([...formData.entries()]) });
            if (!resp.ok) {
              const txt = await resp.text();
              alert('Gagal menyimpan: ' + (txt || resp.statusText));
              return;
            }
            // Ambil data terbaru dan update baris tabel
            const updated = await fetch(`/admin/alokasi/${encodeURIComponent(id)}`).then(r => r.json());
            const tr = document.querySelector(`tr.row-edit[data-edit-id="${id}"]`);
            if (tr) {
              const cells = tr.querySelectorAll('td');
              const toID = (m) => { const h = String(Math.floor(m/60)).padStart(2,'0'); const mi = String(m%60).padStart(2,'0'); return `${h}.${mi}`; };
              // Kolom 0 adalah checkbox; jangan ditimpa.
              cells[1].textContent = hariMap[updated.hari];
              cells[2].textContent = (typeof updated.jamKe === 'number') ? updated.jamKe : '-';
              cells[3].textContent = toID(updated.mulaiMenit);
              cells[4].textContent = toID(updated.selesaiMenit);
              cells[5].textContent = updated.keterangan || '-';
            }
            // Tampilkan notifikasi
            showToast('Berhasil disimpan');
            close();
          } catch(err) {
            alert('Terjadi kesalahan: ' + (err && err.message ? err.message : err));
          }
        });
  })(overlay.querySelector('form.form-alokasi-edit'));
    })
    .catch((err) => alert('Gagal membuka data: ' + (err && err.message ? err.message : err)));
}

// ===== Bulk Delete & Master Checkbox Handlers for Admin Tables =====
(function(){
  function setupBulkDelete(masterId, buttonId, formId){
    const master = document.getElementById(masterId);
    const btn = document.getElementById(buttonId);
    const form = document.getElementById(formId);
    const rowChecks = Array.from(document.querySelectorAll('.row-check'));
    if (!btn || !form || rowChecks.length === 0) return;

    if (master) {
      master.addEventListener('change', function(){
        rowChecks.forEach(ch => { ch.checked = master.checked; });
        master.indeterminate = false;
      });
    }

    rowChecks.forEach(ch => {
      ch.addEventListener('change', function(){
        if (!master) return;
        const allChecked = rowChecks.every(c => c.checked);
        const anyChecked = rowChecks.some(c => c.checked);
        master.indeterminate = !allChecked && anyChecked;
        master.checked = allChecked;
      });
    });

    btn.addEventListener('click', function(){
      const selected = Array.from(document.querySelectorAll('.row-check:checked')).map(el => el.value);
      if (selected.length === 0) {
        alert('Pilih minimal satu baris terlebih dahulu.');
        return;
      }
      if (!confirm('Hapus data terpilih?')) return;
      form.innerHTML = '';
      selected.forEach(id => {
        const inp = document.createElement('input');
        inp.type = 'hidden';
        inp.name = 'ids[]';
        inp.value = String(id);
        form.appendChild(inp);
      });
      form.submit();
    });
  }

  setupBulkDelete('masterCheckJadwal', 'bulkDeleteJadwalBtn', 'bulkDeleteJadwalForm');
  setupBulkDelete('masterCheckMapel', 'bulkDeleteMapelBtn', 'bulkDeleteMapelForm');
  setupBulkDelete('masterCheckKelas', 'bulkDeleteKelasBtn', 'bulkDeleteKelasForm');
  setupBulkDelete('masterCheckAlokasi', 'bulkDeleteAlokasiBtn', 'bulkDeleteAlokasiForm');
  setupBulkDelete('masterCheckGaleri', 'bulkDeleteGaleriBtn', 'bulkDeleteGaleriForm');
})();

// ===== Jadwal: Modal edit rapi dengan data terisi otomatis =====
document.addEventListener('DOMContentLoaded', () => {
  const editButtons = Array.from(document.querySelectorAll('.btn-edit-jadwal'));
  if (!editButtons.length) return;
  editButtons.forEach(btn => {
    btn.addEventListener('click', () => openEditJadwalModal(btn));
  });
});

function openEditJadwalModal(btn){
  const opts = (window.JADWAL_OPTIONS || {});
  const guruOpts = Array.isArray(opts.guru) ? opts.guru : [];
  const kelasOpts = Array.isArray(opts.kelas) ? opts.kelas : [];
  const mapelOpts = Array.isArray(opts.mapel) ? opts.mapel : [];
  const hariMap = Array.isArray(opts.hariMap) ? opts.hariMap : ['Ahad','Senin','Selasa','Rabu','Kamis','Jumat','Sabtu'];

  const id = btn.dataset.id;
  const guruId = btn.dataset.guruId;
  const kelasId = btn.dataset.kelasId;
  const mapelId = btn.dataset.mapelId;
  const hari = btn.dataset.hari;
  const jamKe = btn.dataset.jamKe;
  const mulai = btn.dataset.mulai;
  const selesai = btn.dataset.selesai;

  const backdrop = document.createElement('div'); backdrop.className = 'modal-backdrop';
  const modal = document.createElement('div'); modal.className = 'modal';
  const header = document.createElement('div'); header.className = 'modal-header';
  header.innerHTML = '<h3 style="margin:0;">Edit Jadwal</h3><button class="modal-close" data-modal-close aria-label="Tutup">×</button>';
  const form = document.createElement('form'); form.className = 'form-jadwal-edit'; form.method = 'post'; form.action = '/admin/jadwal/edit/' + encodeURIComponent(id);

  const selectHtml = (name, items, selected, label) => {
    const optsHtml = items.map(it => `<option value="${it.id}">${it.kode ? `${it.kode} - ` : ''}${it.nama}</option>`).join('');
    const wrap = document.createElement('div');
    const lab = document.createElement('label'); lab.textContent = label; wrap.appendChild(lab);
    const sel = document.createElement('select'); sel.name = name; sel.required = true; sel.innerHTML = optsHtml; wrap.appendChild(sel);
    setTimeout(() => { sel.value = String(selected); }, 0);
    return wrap;
  };

  form.appendChild(selectHtml('guruId', guruOpts, guruId, 'Nama Guru'));
  form.appendChild(selectHtml('kelasId', kelasOpts, kelasId, 'Kelas'));
  form.appendChild(selectHtml('mapelId', mapelOpts, mapelId, 'Mapel'));
  // Hari
  const hariWrap = document.createElement('div');
  const hariLab = document.createElement('label'); hariLab.textContent = 'Hari'; hariWrap.appendChild(hariLab);
  const hariSel = document.createElement('select'); hariSel.name = 'hari'; hariSel.required = true;
  for (let h=1; h<=6; h++){ const opt = document.createElement('option'); opt.value = String(h); opt.textContent = hariMap[h]; hariSel.appendChild(opt); }
  hariWrap.appendChild(hariSel); setTimeout(() => { hariSel.value = String(hari); }, 0);
  form.appendChild(hariWrap);

  // Jam Ke sebagai cekbox (multi pilihan)
  const jamWrap = document.createElement('div');
  const jamLab = document.createElement('label'); jamLab.textContent = 'Jam Ke'; jamWrap.appendChild(jamLab);
  const jamList = document.createElement('div'); jamList.className = 'jam-list-mini';
  const jamNums = String(jamKe || '')
    .split(',')
    .map(n => parseInt(n, 10))
    .filter(n => Number.isInteger(n));
  for (let j=1; j<=10; j++){
    const lab = document.createElement('label'); lab.className = 'jam-item-mini'; lab.htmlFor = `edit_jam_${j}`;
    const chk = document.createElement('input'); chk.type = 'checkbox'; chk.className = 'jam-check-mini'; chk.id = `edit_jam_${j}`; chk.name = 'jamKe[]'; chk.value = String(j);
    if (jamNums.includes(j)) chk.checked = true;
    const span = document.createElement('span'); span.textContent = String(j);
    lab.appendChild(chk); lab.appendChild(span); jamList.appendChild(lab);
  }
  jamWrap.appendChild(jamList);
  form.appendChild(jamWrap);

  // Biarkan multi pilihan untuk Jam Ke (hapus pembatasan satu pilihan)

  // Informasi waktu (read-only)
  const info = document.createElement('div'); info.className = 'field-wide';
  info.innerHTML = `<div style="font-size:13px; color:#6b7280;">Waktu: <strong>${mulai}–${selesai}</strong></div>`;
  form.appendChild(info);

  // Hidden waktu untuk kompatibilitas server
  const hidMulai = document.createElement('input'); hidMulai.type = 'hidden'; hidMulai.name = 'mulai'; hidMulai.value = mulai; form.appendChild(hidMulai);
  const hidSelesai = document.createElement('input'); hidSelesai.type = 'hidden'; hidSelesai.name = 'selesai'; hidSelesai.value = selesai; form.appendChild(hidSelesai);

  // Validasi: wajib pilih minimal satu Jam Ke untuk mencegah fallback edit by id
  form.addEventListener('submit', function(e){
    const anyChecked = form.querySelectorAll('input[name="jamKe[]"]:checked').length > 0;
    if (!anyChecked) {
      e.preventDefault();
      alert('Pilih minimal satu Jam Ke sebelum menyimpan.');
    }
  });

  const actions = document.createElement('div'); actions.className = 'field-actions';
  actions.innerHTML = '<button type="submit">Simpan</button> <button type="button" class="pill-link" data-modal-close>Batal</button>';
  form.appendChild(actions);

  modal.appendChild(header); modal.appendChild(form); backdrop.appendChild(modal); document.body.appendChild(backdrop);

  function close(){ backdrop.remove(); }
  backdrop.addEventListener('click', (e) => { if (e.target === backdrop) close(); });
  backdrop.querySelectorAll('[data-modal-close]').forEach(el => el.addEventListener('click', close));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      const fd = new FormData(form);
      // Pastikan jamKe[] terset (jika tidak memilih, gunakan nilai lama CSV)
      const selectedJam = fd.getAll('jamKe[]');
      if (!selectedJam.length && jamNums.length) {
        jamNums.forEach(v => fd.append('jamKe[]', String(v)));
      }
      const resp = await fetch(form.action, { method: 'POST', body: new URLSearchParams([...fd.entries()]) });
      if (!resp.ok) throw new Error(await resp.text());
      close();
      showToast('Berhasil disimpan');
      try { sessionStorage.setItem('admin_toast', 'Berhasil disimpan'); } catch(e){}
      window.location.reload();
    } catch(err) {
      showToast('Gagal menyimpan', { type: 'error', duration: 3000 });
      alert('Gagal menyimpan: ' + (err && err.message ? err.message : err));
    }
  });
}
