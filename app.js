/**
 * MicroPOS v3 — Circular Grid + Image Upload
 */

const DB_NAME = 'micropos_db';
const DB_VERSION = 1;

let db;
let profile = { id: 'default_user', shop_name: 'ร้านค้าของฉัน', settings: { currency: 'THB', daily_goal_mode: 'revenue', audio: false } };
let dailyState = { date: '', total_qty: 0, total_revenue: 0, goal_value: 1000, goal_progress: 0, streak_count: 0 };
let products = [];
let todayStr = '';
let todaySalesByProduct = {};
let chartPie = null, chartHourly = null, chartWeekly = null;
let editMode = false;

const PRODUCT_EMOJIS = ['🍉', '☕', '🧋', '🥤', '🍊', '🥐', '🍜', '🧁', '🍕', '🍔', '🍟', '🥗', '🍦', '🍪', '🍩'];
const CHART_COLORS = ['#14e08a', '#5ad1ff', '#ffd166', '#ff7a5b', '#a78bfa', '#ec4899', '#06b6d4', '#f97316', '#84cc16', '#ef4444'];

if (typeof Chart !== 'undefined') {
    Chart.defaults.color = 'rgba(255,255,255,0.4)';
    Chart.defaults.borderColor = 'rgba(255,255,255,0.04)';
}

const MOTIVATIONAL_MESSAGES = {
    0: ["เริ่มได้ดีแล้ว เฮีย สู้ ๆ ค่ะ 💪", "ออเดอร์แรกมาแล้ว! 🔥"],
    10: ["จุดพลังกำลังเพิ่ม 📈", "ยอดเยี่ยมมากค่ะ ✨"],
    25: ["ไปได้ดี มั่นใจได้ 🌟", "มาดีมาก ทะลุเป้าแน่ๆ 🚀"],
    50: ["ดีมาก! ต่อไปให้สุด 🎯", "เกินครึ่งแล้ว ลุยต่อ ⚡"],
    75: ["ใกล้แล้ว! 🏆", "อีกนิดเดียว สู้ๆ! 🏃‍♂️"],
    90: ["จะถึงเป้าแล้ว! 🧘‍♂️", "โคตรเก่งเลยเฮีย! 💖"],
    100: ["สำเร็จ! เก่งมากค่ะ 🎉🎉", "เป้าแตก ฉลองเลย! 🎊🎊"]
};

// --- BOOTSTRAP ---
document.addEventListener("DOMContentLoaded", initApp);

async function initApp() {
    try {
        todayStr = getLocalToday();
        await initDB();
        await loadProfile();
        await initDailyState();
        await loadProducts();
        if (products.length === 0) { await createDummyProducts(); await loadProducts(); }
        await loadTodaySalesData();
        renderUI();
        attachEvents();
        initCarousel();
        renderCharts();
    } catch (e) {
        console.error("Init error:", e);
        showToast("เกิดข้อผิดพลาดในการโหลดระบบ", "error");
    }
}

function getLocalToday() { return new Date().toLocaleString("en-CA", { timeZone: "Asia/Bangkok", year: 'numeric', month: '2-digit', day: '2-digit' }); }
function generateId() { return crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + Math.random().toString(36).substr(2, 9); }

// --- DATABASE ---
function initDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = e => {
            const d = e.target.result;
            if (!d.objectStoreNames.contains('products')) d.createObjectStore('products', { keyPath: 'product_id' });
            if (!d.objectStoreNames.contains('transactions')) {
                const s = d.createObjectStore('transactions', { keyPath: 'tx_id' });
                s.createIndex('timestamp', 'timestamp', { unique: false });
                s.createIndex('date', 'date', { unique: false });
            }
            if (!d.objectStoreNames.contains('dailyRecords')) d.createObjectStore('dailyRecords', { keyPath: 'date' });
            if (!d.objectStoreNames.contains('profile')) d.createObjectStore('profile', { keyPath: 'id' });
        };
        req.onsuccess = e => { db = e.target.result; resolve(); };
        req.onerror = e => reject(e.target.error);
    });
}

function idbOp(storeName, mode, op) {
    return new Promise((resolve, reject) => {
        const tx = db.transaction(storeName, mode);
        const store = tx.objectStore(storeName);
        let req;
        try { req = op(store); } catch (err) { return reject(err); }
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

// --- BUSINESS LOGIC ---
async function loadProfile() {
    const p = await idbOp('profile', 'readonly', s => s.get('default_user'));
    if (p) profile = p; else await idbOp('profile', 'readwrite', s => s.put(profile));
}

async function initDailyState() {
    const cached = localStorage.getItem(`dailyState_${todayStr}`);
    if (cached) dailyState = JSON.parse(cached);
    const record = await idbOp('dailyRecords', 'readonly', s => s.get(todayStr));
    if (record) { dailyState = record; }
    else {
        const prev = await idbOp('dailyRecords', 'readonly', s => s.getAll());
        prev.sort((a, b) => a.date > b.date ? -1 : 1);
        let streak = 0, avgBase = 0;
        if (prev.length > 0) {
            streak = prev[0].goal_progress >= prev[0].goal_value ? prev[0].streak_count + 1 : 0;
            const sample = prev.slice(0, 7);
            avgBase = sample.reduce((a, v) => a + (profile.settings.daily_goal_mode === 'revenue' ? v.total_revenue : v.total_qty), 0) / sample.length;
        }
        if (avgBase < 100) avgBase = 500;
        dailyState = { date: todayStr, total_qty: 0, total_revenue: 0, total_cost: 0, total_profit: 0, goal_value: Math.max(10, Math.round(avgBase * (0.85 + Math.random() * 0.3))), goal_progress: 0, streak_count: streak };
        await idbOp('dailyRecords', 'readwrite', s => s.put(dailyState));
    }
    syncLocalCache();
}

function syncLocalCache() { localStorage.setItem(`dailyState_${todayStr}`, JSON.stringify(dailyState)); }

async function loadProducts() { products = (await idbOp('products', 'readonly', s => s.getAll())).filter(p => p.is_active); }

async function createDummyProducts() {
    const dummies = [
        { product_id: generateId(), name: 'แตงโมปั่น', price: 45, cost: 20, emoji: '🍉', image: null, is_active: true },
        { product_id: generateId(), name: 'กาแฟเย็น', price: 50, cost: 25, emoji: '☕', image: null, is_active: true },
        { product_id: generateId(), name: 'ชานมไข่มุก', price: 40, cost: 18, emoji: '🧋', image: null, is_active: true }
    ];
    for (let p of dummies) await idbOp('products', 'readwrite', s => s.put(p));
}

async function loadTodaySalesData() {
    todaySalesByProduct = {};
    try {
        const all = await idbOp('transactions', 'readonly', s => s.getAll());
        all.filter(t => t.date === todayStr).forEach(t => {
            if (!todaySalesByProduct[t.product_id]) { const p = products.find(x => x.product_id === t.product_id); todaySalesByProduct[t.product_id] = { count: 0, revenue: 0, name: p ? p.name : '?' }; }
            todaySalesByProduct[t.product_id].count += t.quantity;
            todaySalesByProduct[t.product_id].revenue += t.total_revenue;
        });
    } catch (e) { console.error("Sales load failed:", e); }
}

// --- SELL ---
async function sellProduct(productId, qty = 1) {
    const prod = products.find(p => p.product_id === productId);
    if (!prod) return;

    for (let i = 0; i < qty; i++) {
        const tx = { tx_id: generateId(), product_id: prod.product_id, quantity: 1, unit_price: Number(prod.price), unit_cost: Number(prod.cost), total_revenue: Number(prod.price), total_cost: Number(prod.cost), profit: Number(prod.price) - Number(prod.cost), timestamp: new Date().toISOString(), date: todayStr };

        dailyState.total_qty += 1;
        dailyState.total_revenue += tx.total_revenue;
        dailyState.total_cost += tx.total_cost;
        dailyState.total_profit += tx.profit;
        dailyState.goal_progress = profile.settings.daily_goal_mode === 'revenue' ? dailyState.total_revenue : dailyState.total_qty;

        if (!todaySalesByProduct[productId]) todaySalesByProduct[productId] = { count: 0, revenue: 0, name: prod.name };
        todaySalesByProduct[productId].count += 1;
        todaySalesByProduct[productId].revenue += tx.total_revenue;

        try {
            const idbTx = db.transaction(['transactions', 'dailyRecords'], 'readwrite');
            idbTx.objectStore('transactions').add(tx);
            idbTx.objectStore('dailyRecords').put(dailyState);
        } catch (e) { console.error("DB write failed", e); }

        updateChartsOnSale(tx);
    }

    syncLocalCache();
    updateKPIs();
    updateMissionUI();
    applyPopularityScaling();
    updateTopTicker();
    showToast(`${prod.name} x${qty} ✓`);
    if (navigator.vibrate) navigator.vibrate(40);

    // Bounce KPI
    const revEl = document.getElementById('kpi-revenue');
    if (revEl) { revEl.classList.remove('kpi-bounce'); void revEl.offsetWidth; revEl.classList.add('kpi-bounce'); }
}

// --- UI RENDERING ---
function renderUI() {
    document.getElementById('shop-name-display').textContent = profile.shop_name;
    renderProductGrid();
    updateKPIs(false);
    updateMissionUI();
    applyPopularityScaling();
    updateTopTicker();
}

function renderProductGrid() {
    const grid = document.getElementById('product-grid');
    grid.innerHTML = '';
    const CIRC = 2 * Math.PI * 40; // circumference for activity ring (r=40)

    products.forEach((p, i) => {
        const emoji = p.emoji || PRODUCT_EMOJIS[i % PRODUCT_EMOJIS.length];
        const salesData = todaySalesByProduct[p.product_id];
        const salesCount = salesData ? salesData.count : 0;

        const item = document.createElement('div');
        item.className = 'product-item';
        item.dataset.productId = p.product_id;

        let circleInner;
        if (p.image) {
            circleInner = `<img src="${p.image}" alt="${p.name}">`;
        } else {
            circleInner = `<span class="emoji-fallback">${emoji}</span>`;
        }

        const saleBadge = salesCount > 0 ? `<span class="sale-count">${salesCount}</span>` : '';

        // Activity ring SVG: starts at 0%, updated by applyPopularityScaling
        const ringSVG = `<svg class="activity-ring" viewBox="0 0 88 88">
            <circle class="ring-bg" cx="44" cy="44" r="40"/>
            <circle class="ring-fill" cx="44" cy="44" r="40" stroke-dasharray="${CIRC}" stroke-dashoffset="${CIRC}" data-circ="${CIRC}"/>
        </svg>`;

        if (editMode) {
            item.innerHTML = `
                <div class="product-circle-wrap">
                    ${ringSVG}
                    <div class="product-circle">${circleInner}<div class="edit-overlay">✏️</div></div>
                </div>
                ${saleBadge}
                <span class="product-label">${p.name}</span>
                <span class="product-price-tag">฿${p.price}</span>
            `;
        } else {
            item.innerHTML = `
                <div class="product-circle-wrap">
                    ${ringSVG}
                    <div class="product-circle">${circleInner}</div>
                </div>
                ${saleBadge}
                <span class="product-label">${p.name}</span>
                <span class="product-price-tag">฿${p.price}</span>
            `;
        }

        grid.appendChild(item);
    });
}

function updateKPIs(animate = true) {
    const revEl = document.getElementById('kpi-revenue');
    const qtyEl = document.getElementById('kpi-qty');
    const streakEl = document.getElementById('kpi-streak');
    if (animate) {
        animateValue(revEl, Number(revEl.innerText.replace(/,/g, '')), dailyState.total_revenue, 500);
        animateValue(qtyEl, Number(qtyEl.innerText.replace(/,/g, '')), dailyState.total_qty, 300);
    } else {
        revEl.innerText = dailyState.total_revenue.toLocaleString();
        qtyEl.innerText = dailyState.total_qty.toLocaleString();
    }
    streakEl.innerText = `🔥 ${dailyState.streak_count}`;
}

let lastThreshold = -1;
function updateMissionUI() {
    const curEl = document.getElementById('mission-current');
    const targetEl = document.getElementById('mission-target');
    const bar = document.getElementById('mission-progress-bar');
    if (curEl) curEl.innerText = dailyState.goal_progress.toLocaleString();
    if (targetEl) targetEl.innerText = dailyState.goal_value.toLocaleString() + (profile.settings.daily_goal_mode === 'revenue' ? '฿' : '');
    let pct = Math.min((dailyState.goal_progress / dailyState.goal_value) * 100, 100);
    if (bar) bar.style.width = `${pct}%`;

    const thresholds = [0, 10, 25, 50, 75, 90, 100].reverse();
    const hit = thresholds.find(t => pct >= t);
    if (hit !== undefined && hit !== lastThreshold) {
        lastThreshold = hit;
        const msgs = MOTIVATIONAL_MESSAGES[hit];
        const msgEl = document.getElementById('mission-message');
        if (msgEl) { msgEl.innerText = msgs[Math.floor(Math.random() * msgs.length)]; msgEl.classList.remove('animate-fade-in'); void msgEl.offsetWidth; msgEl.classList.add('animate-fade-in'); }
        if (hit === 100) triggerConfetti();
    }
}

// --- POPULARITY SCALING + ACTIVITY RING ---
function applyPopularityScaling() {
    if (editMode) return;
    const items = document.querySelectorAll('.product-item');
    if (!items.length) return;

    const counts = products.map(p => (todaySalesByProduct[p.product_id]?.count) || 0);
    const maxC = Math.max(...counts, 1);
    let topIdx = 0, topCount = 0;
    counts.forEach((c, i) => { if (c > topCount) { topCount = c; topIdx = i; } });

    items.forEach((item, i) => {
        const c = counts[i] || 0;
        // Soft scaling: 10-15% max
        const scale = 1 + (c / maxC) * 0.12;
        item.style.transform = `scale(${scale})`;

        // Activity ring: fill proportional to sales ratio
        const ringFill = item.querySelector('.ring-fill');
        if (ringFill) {
            const circ = parseFloat(ringFill.dataset.circ);
            const pct = maxC > 0 ? (c / maxC) : 0;
            ringFill.style.strokeDashoffset = circ * (1 - pct);
        }

        // Remove old badges
        item.querySelector('.hot-badge')?.remove();
        item.classList.remove('hot');

        // Update sale count badge
        const badge = item.querySelector('.sale-count');
        if (badge && c > 0) badge.textContent = c;

        if (i === topIdx && topCount > 0) {
            item.classList.add('hot');
            const hb = document.createElement('span');
            hb.className = 'hot-badge';
            hb.textContent = '🔥 #1';
            item.appendChild(hb);
        }
    });
}

// --- TOP SELLER TICKER ---
function updateTopTicker() {
    const ticker = document.getElementById('top-seller-ticker');
    const tickerText = document.getElementById('ticker-text');
    if (!ticker || !tickerText) return;

    let topName = '', topRev = 0;
    for (const id in todaySalesByProduct) {
        if (todaySalesByProduct[id].revenue > topRev) {
            topRev = todaySalesByProduct[id].revenue;
            topName = todaySalesByProduct[id].name;
        }
    }

    if (topRev > 0) {
        ticker.style.display = 'flex';
        tickerText.innerHTML = `วันนี้ขายดีสุด: <strong>${topName}</strong> (฿${topRev.toLocaleString()})`;
    } else {
        ticker.style.display = 'none';
    }
}

// --- CAROUSEL ---
function initCarousel() {
    const c = document.getElementById('analytics-carousel');
    const dots = document.querySelectorAll('.carousel-dot');
    if (!c || !dots.length) return;
    c.addEventListener('scroll', () => { const idx = Math.round(c.scrollLeft / c.clientWidth); dots.forEach((d, i) => d.classList.toggle('active', i === idx)); });
    dots.forEach(d => d.addEventListener('click', () => c.scrollTo({ left: parseInt(d.dataset.idx) * c.clientWidth, behavior: 'smooth' })));
}

// --- CHARTS ---
async function renderCharts() {
    if (typeof Chart === 'undefined') return;
    const allTx = await idbOp('transactions', 'readonly', s => s.getAll());
    const todayTx = allTx.filter(t => t.date === todayStr);
    renderPieChart(todayTx);
    renderHourlyChart(todayTx);
    renderWeeklyChart(allTx);
}

// Donut center text plugin
const donutCenterPlugin = {
    id: 'donutCenter',
    afterDraw(chart) {
        if (chart.config.type !== 'doughnut') return;
        const { ctx, chartArea } = chart;
        const total = chart.data.datasets[0].data.reduce((a, b) => a + b, 0);
        if (total === 0 || (chart.data.labels[0] === 'ยังไม่มี')) return;
        ctx.save();
        const cx = (chartArea.left + chartArea.right) / 2;
        const cy = (chartArea.top + chartArea.bottom) / 2;
        ctx.font = 'bold 18px Inter';
        ctx.fillStyle = '#14e08a';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`${total.toLocaleString()}฿`, cx, cy);
        ctx.restore();
    }
};

function renderPieChart(todayTx) {
    const rev = {};
    todayTx.forEach(t => { const p = products.find(x => x.product_id === t.product_id); rev[p ? p.name : '?'] = (rev[p ? p.name : '?'] || 0) + t.total_revenue; });
    const labels = Object.keys(rev), data = Object.values(rev);
    const ctx = document.getElementById('chart-pie');
    if (!ctx) return;
    if (chartPie) chartPie.destroy();
    chartPie = new Chart(ctx, {
        type: 'doughnut',
        data: { labels: labels.length ? labels : ['ยังไม่มี'], datasets: [{ data: data.length ? data : [1], backgroundColor: data.length ? CHART_COLORS.slice(0, labels.length) : ['rgba(255,255,255,0.06)'], borderWidth: 0, borderRadius: 4 }] },
        options: {
            responsive: true, maintainAspectRatio: false, cutout: '65%',
            plugins: {
                legend: { position: 'right', labels: { boxWidth: 8, padding: 8, font: { size: 10, family: 'Inter' } } },
                tooltip: { callbacks: { label: (c) => `${c.label}: ${c.raw.toLocaleString()} ฿` } }
            }
        },
        plugins: [donutCenterPlugin]
    });
}

function renderHourlyChart(todayTx) {
    const h = {}; for (let i = 6; i <= 23; i++) h[i] = 0;
    todayTx.forEach(t => { const hr = new Date(t.timestamp).getHours(); if (h[hr] !== undefined) h[hr] += t.total_revenue; });
    const ctx = document.getElementById('chart-hourly');
    if (!ctx) return;
    if (chartHourly) chartHourly.destroy();
    chartHourly = new Chart(ctx, { type: 'bar', data: { labels: Object.keys(h).map(x => `${x}:00`), datasets: [{ data: Object.values(h), backgroundColor: 'rgba(20,224,138,0.4)', borderRadius: 6, barThickness: 10 }] }, options: { responsive: true, maintainAspectRatio: false, scales: { x: { grid: { display: false }, ticks: { font: { size: 8 }, maxRotation: 0 } }, y: { grid: { color: 'rgba(255,255,255,0.03)' }, ticks: { font: { size: 8 } }, beginAtZero: true } }, plugins: { legend: { display: false } } } });
}

function renderWeeklyChart(allTx) {
    const days = [], revenues = [];
    for (let i = 6; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); const ds = d.toLocaleString("en-CA", { timeZone: "Asia/Bangkok", year: 'numeric', month: '2-digit', day: '2-digit' }); days.push(d.toLocaleDateString('th-TH', { weekday: 'short', timeZone: "Asia/Bangkok" })); revenues.push(allTx.filter(t => t.date === ds).reduce((s, t) => s + t.total_revenue, 0)); }
    const thisW = revenues.reduce((a, b) => a + b, 0);
    const lastWRevs = [];
    for (let i = 13; i >= 7; i--) { const d = new Date(); d.setDate(d.getDate() - i); const ds = d.toLocaleString("en-CA", { timeZone: "Asia/Bangkok", year: 'numeric', month: '2-digit', day: '2-digit' }); lastWRevs.push(allTx.filter(t => t.date === ds).reduce((s, t) => s + t.total_revenue, 0)); }
    const lastW = lastWRevs.reduce((a, b) => a + b, 0);
    const growth = lastW > 0 ? ((thisW - lastW) / lastW * 100).toFixed(1) : 0;
    const ctx = document.getElementById('chart-weekly');
    if (!ctx) return;
    if (chartWeekly) chartWeekly.destroy();
    chartWeekly = new Chart(ctx, { type: 'line', data: { labels: days, datasets: [{ data: revenues, borderColor: '#14e08a', backgroundColor: 'rgba(20,224,138,0.08)', fill: true, tension: 0.4, borderWidth: 2.5, pointBackgroundColor: '#14e08a', pointRadius: 3, pointHoverRadius: 5 }] }, options: { responsive: true, maintainAspectRatio: false, scales: { x: { grid: { display: false }, ticks: { font: { size: 10 } } }, y: { grid: { color: 'rgba(255,255,255,0.03)' }, ticks: { font: { size: 8 } }, beginAtZero: true } }, plugins: { legend: { display: false }, title: { display: true, text: `Growth: ${growth > 0 ? '+' : ''}${growth}%`, font: { size: 11, weight: '700' }, color: growth >= 0 ? '#14e08a' : '#ef4444', padding: { bottom: 4 } } } } });
}

function updateChartsOnSale(tx) {
    if (chartPie) {
        const p = products.find(x => x.product_id === tx.product_id);
        const n = p ? p.name : '?';
        const idx = chartPie.data.labels.indexOf(n);
        if (chartPie.data.labels[0] === 'ยังไม่มี') { chartPie.data.labels = [n]; chartPie.data.datasets[0].data = [tx.total_revenue]; chartPie.data.datasets[0].backgroundColor = [CHART_COLORS[0]]; }
        else if (idx >= 0) chartPie.data.datasets[0].data[idx] += tx.total_revenue;
        else { chartPie.data.labels.push(n); chartPie.data.datasets[0].data.push(tx.total_revenue); chartPie.data.datasets[0].backgroundColor.push(CHART_COLORS[chartPie.data.labels.length - 1] || '#6b7280'); }
        chartPie.update('none');
    }
    if (chartHourly) { const hr = new Date(tx.timestamp).getHours(); const idx = chartHourly.data.labels.indexOf(`${hr}:00`); if (idx >= 0) chartHourly.data.datasets[0].data[idx] += tx.total_revenue; chartHourly.update('none'); }
    if (chartWeekly) { const last = chartWeekly.data.datasets[0].data.length - 1; chartWeekly.data.datasets[0].data[last] += tx.total_revenue; chartWeekly.update('none'); }
}

// --- IMAGE HANDLING ---
function compressImage(file, maxW = 512, quality = 0.7) {
    return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
                const canvas = document.createElement('canvas');
                let w = img.width, h = img.height;
                if (w > maxW) { h = (maxW / w) * h; w = maxW; }
                canvas.width = w; canvas.height = h;
                canvas.getContext('2d').drawImage(img, 0, 0, w, h);
                resolve(canvas.toDataURL('image/jpeg', quality));
            };
            img.src = e.target.result;
        };
        reader.readAsDataURL(file);
    });
}

function triggerImageUpload(productId) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.className = 'hidden-input';
    input.addEventListener('change', async () => {
        if (!input.files[0]) return;
        const base64 = await compressImage(input.files[0]);
        const prod = products.find(p => p.product_id === productId);
        if (prod) {
            prod.image = base64;
            await idbOp('products', 'readwrite', s => s.put(prod));
            await loadProducts();
            renderProductGrid();
            showToast("อัปเดตรูปสำเร็จ ✅");
        }
        input.remove();
    });
    document.body.appendChild(input);
    input.click();
}

// --- EDIT MODE ---
function toggleEditMode() {
    editMode = !editMode;
    const grid = document.getElementById('product-grid');
    const editBar = document.getElementById('edit-bar');
    const settingsBtn = document.getElementById('btn-settings');
    const addBtn = document.getElementById('btn-add-product');

    if (editMode) {
        grid.classList.add('edit-mode');
        editBar.style.display = 'flex';
        settingsBtn.classList.add('active');
        if (addBtn) addBtn.style.display = 'none';
    } else {
        grid.classList.remove('edit-mode');
        editBar.style.display = 'none';
        settingsBtn.classList.remove('active');
        if (addBtn) addBtn.style.display = '';
    }
    renderProductGrid();
    if (!editMode) applyPopularityScaling();
}

async function editProduct(productId) {
    const prod = products.find(p => p.product_id === productId);
    if (!prod) return;

    const action = prompt("เลือก:\n1 = แก้ชื่อ/ราคา\n2 = เปลี่ยนรูป\n3 = เปลี่ยน Emoji\n4 = ลบสินค้า", "1");
    if (action === null) return;

    if (action === '1') {
        const name = prompt("ชื่อสินค้า:", prod.name);
        if (name === null) return;
        const price = parseFloat(prompt("ราคาขาย:", prod.price));
        if (isNaN(price)) return;
        const cost = parseFloat(prompt("ต้นทุน:", prod.cost) || prod.cost);
        prod.name = name; prod.price = price; prod.cost = cost;
        await idbOp('products', 'readwrite', s => s.put(prod));
        await loadProducts();
        renderProductGrid();
        showToast("อัปเดตแล้ว ✅");
    } else if (action === '2') {
        triggerImageUpload(productId);
    } else if (action === '3') {
        const emoji = prompt("Emoji ใหม่:", prod.emoji || '🍉');
        if (emoji) { prod.emoji = emoji; prod.image = null; await idbOp('products', 'readwrite', s => s.put(prod)); await loadProducts(); renderProductGrid(); showToast("เปลี่ยน Emoji แล้ว ✅"); }
    } else if (action === '4') {
        if (confirm(`ลบ "${prod.name}" ?`)) {
            prod.is_active = false;
            await idbOp('products', 'readwrite', s => s.put(prod));
            await loadProducts();
            renderProductGrid();
            showToast("ลบสินค้าแล้ว");
        }
    }
}

// --- EVENTS ---
let longPressTimer = null;
let longPressTriggered = false;

function attachEvents() {
    const grid = document.getElementById('product-grid');

    // Tap & Long Press handling
    grid.addEventListener('pointerdown', (e) => {
        const item = e.target.closest('.product-item');
        if (!item || editMode) return;

        const id = item.dataset.productId;
        longPressTriggered = false;

        // Visual tap feedback
        item.classList.add('tapped');

        longPressTimer = setTimeout(() => {
            longPressTriggered = true;
            item.classList.remove('tapped');
            const qty = parseInt(prompt("จำนวนที่ต้องการขาย:", "5"));
            if (!isNaN(qty) && qty > 0) sellProduct(id, qty);
        }, 500);
    });

    grid.addEventListener('pointerup', (e) => {
        const item = e.target.closest('.product-item');
        if (item) item.classList.remove('tapped');

        if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }

        if (!longPressTriggered && !editMode) {
            const itm = e.target.closest('.product-item');
            if (itm && itm.dataset.productId) sellProduct(itm.dataset.productId, 1);
        }
    });

    grid.addEventListener('pointerleave', () => {
        if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
    }, true);

    // Edit mode tap
    grid.addEventListener('click', (e) => {
        if (!editMode) return;
        const item = e.target.closest('.product-item');
        if (item && item.dataset.productId) editProduct(item.dataset.productId);
    });

    document.getElementById('btn-settings').addEventListener('click', toggleEditMode);
    const addBtn = document.getElementById('btn-add-product');
    if (addBtn) addBtn.addEventListener('click', () => promptAddProduct());
    const editAddBtn = document.getElementById('edit-add-product');
    if (editAddBtn) editAddBtn.addEventListener('click', () => promptAddProduct());
    const editDone = document.getElementById('edit-done');
    if (editDone) editDone.addEventListener('click', toggleEditMode);
}

// --- HELPERS ---
function animateValue(obj, start, end, duration) {
    let t0 = null;
    const step = (ts) => {
        if (!t0) t0 = ts;
        const p = Math.min((ts - t0) / duration, 1);
        obj.innerText = Math.floor(p * (end - start) + start).toLocaleString();
        if (p < 1) requestAnimationFrame(step);
        else obj.innerText = end.toLocaleString();
    };
    requestAnimationFrame(step);
}

function triggerConfetti() { if (typeof confetti === 'function') confetti({ particleCount: 120, spread: 80, origin: { y: 0.7 } }); }

function showToast(msg, type = "info") {
    const c = document.getElementById('toast-container');
    const el = document.createElement('div');
    el.className = `toast ${type === 'error' ? 'toast-error' : 'toast-info'}`;
    el.innerText = msg;
    c.appendChild(el);
    setTimeout(() => el.remove(), 3000);
}

async function promptAddProduct() {
    const name = prompt("ชื่อสินค้า:");
    if (!name) return;
    const price = parseFloat(prompt("ราคาขาย:"));
    if (isNaN(price)) return;
    const cost = parseFloat(prompt("ต้นทุน:") || 0);
    const emoji = prompt("Emoji สินค้า:", PRODUCT_EMOJIS[products.length % PRODUCT_EMOJIS.length]);

    const newId = generateId();
    await idbOp('products', 'readwrite', s => s.put({ product_id: newId, name, price, cost, emoji: emoji || '🍉', image: null, is_active: true }));
    showToast("เพิ่มสินค้าแล้ว ✅");
    await loadProducts();
    renderProductGrid();
    if (!editMode) applyPopularityScaling();
    renderCharts();

    // Prompt for image upload
    if (confirm("ต้องการเพิ่มรูปสินค้าเลยไหม?")) triggerImageUpload(newId);
}

async function exportData() {
    try {
        const txs = await idbOp('transactions', 'readonly', s => s.getAll());
        const blob = new Blob([JSON.stringify(txs, null, 2)], { type: "application/json" });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `micropos-export-${todayStr}.json`;
        link.click();
        showToast("ส่งออกสำเร็จ!");
    } catch (e) { showToast("ส่งออกล้มเหลว", "error"); }
}
