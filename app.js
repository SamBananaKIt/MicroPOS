/**
 * MicroPOS v2 — Ultra-Fast Offline POS
 * Design System v2: Neon Dark + Edit Mode
 */

// --- 1. CONFIG ---
const DB_NAME = 'micropos_db';
const DB_VERSION = 1;

let db;
let profile = {
    id: 'default_user',
    shop_name: 'ร้านค้าของฉัน',
    settings: { currency: 'THB', daily_goal_mode: 'revenue', audio: false }
};

let dailyState = {
    date: '', total_qty: 0, total_revenue: 0,
    goal_value: 1000, goal_progress: 0, streak_count: 0
};

let products = [];
let todayStr = '';
let todaySalesByProduct = {};
let chartPie = null, chartHourly = null, chartWeekly = null;
let editMode = false;

// Emoji map for product avatars
const PRODUCT_EMOJIS = ['🍉', '☕', '🧋', '🥤', '🍊', '🥐', '🍜', '🧁', '🍕', '🍔', '🍟', '🥗', '🍦', '🍪', '🍩'];

const CHART_COLORS = ['#14e08a', '#5ad1ff', '#ffd166', '#ff7a5b', '#a78bfa', '#ec4899', '#06b6d4', '#f97316', '#84cc16', '#ef4444'];

// Set Chart.js dark defaults
if (typeof Chart !== 'undefined') {
    Chart.defaults.color = 'rgba(255,255,255,0.4)';
    Chart.defaults.borderColor = 'rgba(255,255,255,0.04)';
}

const MOTIVATIONAL_MESSAGES = {
    0: ["เริ่มได้ดีแล้ว เฮีย สู้ ๆ ค่ะ 💪", "ออเดอร์แรกมาแล้ว! ลุยต่อเลย 🔥"],
    10: ["จุดพลังกำลังเพิ่ม 📈", "ยอดเยี่ยมมากค่ะ ✨"],
    25: ["ครึ่งทางแล้ว มั่นใจได้ 🌟", "มาดีมาก ทะลุเป้าแน่นอน 🚀"],
    50: ["ดีมาก! ต่อไปให้สุด 🎯", "เกินครึ่งทางแล้ว ลุยต่อนะคะ ⚡"],
    75: ["ใกล้แล้ว! เตรียมรับรางวัล 🏆", "อีกนิดเดียวเท่านั้น สู้ๆ! 🏃‍♂️"],
    90: ["จะถึงเป้าแล้ว! หายใจลึกๆ 🧘‍♂️", "โคตรเก่งเลยเฮีย! 💖"],
    100: ["สำเร็จ! เก่งมากค่ะ 🎉🎉", "เป้าแตกแล้วฉลองหน่อย! 🎊🎊"]
};

// --- 2. BOOTSTRAP ---
document.addEventListener("DOMContentLoaded", initApp);

async function initApp() {
    try {
        todayStr = getLocalToday();
        await initDB();
        await loadProfile();
        await initDailyState();
        await loadProducts();

        if (products.length === 0) {
            await createDummyProducts();
            await loadProducts();
        }

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

function getLocalToday() {
    return new Date().toLocaleString("en-CA", { timeZone: "Asia/Bangkok", year: 'numeric', month: '2-digit', day: '2-digit' });
}

function generateId() {
    return crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + Math.random().toString(36).substr(2, 9);
}

// --- 3. DATABASE ---
function initDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = e => {
            const dbRef = e.target.result;
            if (!dbRef.objectStoreNames.contains('products')) dbRef.createObjectStore('products', { keyPath: 'product_id' });
            if (!dbRef.objectStoreNames.contains('transactions')) {
                const txStore = dbRef.createObjectStore('transactions', { keyPath: 'tx_id' });
                txStore.createIndex('timestamp', 'timestamp', { unique: false });
                txStore.createIndex('date', 'date', { unique: false });
            }
            if (!dbRef.objectStoreNames.contains('dailyRecords')) dbRef.createObjectStore('dailyRecords', { keyPath: 'date' });
            if (!dbRef.objectStoreNames.contains('profile')) dbRef.createObjectStore('profile', { keyPath: 'id' });
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

// --- 4. BUSINESS LOGIC ---
async function loadProfile() {
    const prof = await idbOp('profile', 'readonly', s => s.get('default_user'));
    if (prof) profile = prof;
    else await idbOp('profile', 'readwrite', s => s.put(profile));
}

async function initDailyState() {
    const cached = localStorage.getItem(`dailyState_${todayStr}`);
    if (cached) dailyState = JSON.parse(cached);

    const record = await idbOp('dailyRecords', 'readonly', s => s.get(todayStr));
    if (record) {
        dailyState = record;
    } else {
        const prevRecords = await idbOp('dailyRecords', 'readonly', s => s.getAll());
        prevRecords.sort((a, b) => a.date > b.date ? -1 : 1);

        let streak = 0, avgBase = 0;
        if (prevRecords.length > 0) {
            const last = prevRecords[0];
            streak = last.goal_progress >= last.goal_value ? last.streak_count + 1 : 0;
            const sample = prevRecords.slice(0, 7);
            avgBase = sample.reduce((acc, val) => acc + (profile.settings.daily_goal_mode === 'revenue' ? val.total_revenue : val.total_qty), 0) / sample.length;
        }
        if (avgBase < 100) avgBase = 500;
        const newGoal = Math.max(10, Math.round(avgBase * (0.85 + Math.random() * 0.3)));

        dailyState = { date: todayStr, total_qty: 0, total_revenue: 0, total_cost: 0, total_profit: 0, goal_value: newGoal, goal_progress: 0, streak_count: streak };
        await idbOp('dailyRecords', 'readwrite', s => s.put(dailyState));
    }
    syncLocalCache();
}

function syncLocalCache() { localStorage.setItem(`dailyState_${todayStr}`, JSON.stringify(dailyState)); }

async function loadProducts() {
    products = await idbOp('products', 'readonly', s => s.getAll());
    products = products.filter(p => p.is_active);
}

async function createDummyProducts() {
    const dummies = [
        { product_id: generateId(), name: 'น้ำแตงโมปั่น', price: 45, cost: 20, emoji: '🍉', is_active: true },
        { product_id: generateId(), name: 'กาแฟเย็น', price: 50, cost: 25, emoji: '☕', is_active: true },
        { product_id: generateId(), name: 'ชานมไข่มุก', price: 40, cost: 18, emoji: '🧋', is_active: true }
    ];
    for (let p of dummies) await idbOp('products', 'readwrite', s => s.put(p));
}

async function loadTodaySalesData() {
    todaySalesByProduct = {};
    try {
        const allTx = await idbOp('transactions', 'readonly', s => s.getAll());
        allTx.filter(t => t.date === todayStr).forEach(t => {
            if (!todaySalesByProduct[t.product_id]) {
                const prod = products.find(p => p.product_id === t.product_id);
                todaySalesByProduct[t.product_id] = { count: 0, revenue: 0, name: prod ? prod.name : '?' };
            }
            todaySalesByProduct[t.product_id].count += t.quantity;
            todaySalesByProduct[t.product_id].revenue += t.total_revenue;
        });
    } catch (e) { console.error("Failed to load sales:", e); }
}

// --- SELL ---
async function sellProduct(productId, btnEl) {
    const prod = products.find(p => p.product_id === productId);
    if (!prod) return;

    const tx = {
        tx_id: generateId(), product_id: prod.product_id, quantity: 1,
        unit_price: Number(prod.price), unit_cost: Number(prod.cost),
        total_revenue: Number(prod.price), total_cost: Number(prod.cost),
        profit: Number(prod.price) - Number(prod.cost),
        timestamp: new Date().toISOString(), date: todayStr
    };

    dailyState.total_qty += 1;
    dailyState.total_revenue += tx.total_revenue;
    dailyState.total_cost += tx.total_cost;
    dailyState.total_profit += tx.profit;
    dailyState.goal_progress = profile.settings.daily_goal_mode === 'revenue' ? dailyState.total_revenue : dailyState.total_qty;

    if (!todaySalesByProduct[productId]) todaySalesByProduct[productId] = { count: 0, revenue: 0, name: prod.name };
    todaySalesByProduct[productId].count += 1;
    todaySalesByProduct[productId].revenue += tx.total_revenue;

    updateKPIs();
    updateMissionUI();
    playMicroAnimations(btnEl);
    applyPopularityScaling();
    updateChartsOnSale(tx);

    syncLocalCache();
    try {
        const idbTx = db.transaction(['transactions', 'dailyRecords'], 'readwrite');
        idbTx.objectStore('transactions').add(tx);
        idbTx.objectStore('dailyRecords').put(dailyState);
    } catch (e) {
        console.error("DB write failed", e);
        showToast("บันทึกล้มเหลว", "error");
    }
}

// --- 5. UI RENDERING ---
function renderUI() {
    document.getElementById('shop-name-display').textContent = profile.shop_name;
    renderProductGrid();
    updateKPIs(false);
    updateMissionUI(false);
    applyPopularityScaling();
}

function renderProductGrid() {
    const grid = document.getElementById('product-grid');
    grid.innerHTML = '';

    products.forEach((p, i) => {
        const emoji = p.emoji || PRODUCT_EMOJIS[i % PRODUCT_EMOJIS.length];
        const div = document.createElement('div');
        div.className = 'product-card';
        div.dataset.productId = p.product_id;

        if (editMode) {
            div.innerHTML = `
                <div class="product-avatar">${emoji}</div>
                <p class="product-name">${p.name}</p>
                <p class="product-price">฿${p.price}</p>
                <button class="edit-btn" data-id="${p.product_id}">✏️ แก้ไข</button>
            `;
        } else {
            div.innerHTML = `
                <div class="product-avatar">${emoji}</div>
                <p class="product-name">${p.name}</p>
                <p class="product-price">฿${p.price}</p>
                <button class="sell-btn" data-id="${p.product_id}">
                    <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="3" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"></path></svg>
                    ขาย
                </button>
            `;
        }

        div.classList.add('pop');
        grid.appendChild(div);
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
    const progressBar = document.getElementById('mission-progress-bar');

    if (curEl) curEl.innerText = dailyState.goal_progress.toLocaleString();
    if (targetEl) targetEl.innerText = dailyState.goal_value.toLocaleString() + (profile.settings.daily_goal_mode === 'revenue' ? '฿' : '');

    let pct = Math.min((dailyState.goal_progress / dailyState.goal_value) * 100, 100);
    if (progressBar) progressBar.style.width = `${pct}%`;

    const thresholds = [0, 10, 25, 50, 75, 90, 100].reverse();
    const hit = thresholds.find(t => pct >= t);

    if (hit !== undefined && hit !== lastThreshold) {
        lastThreshold = hit;
        const msgs = MOTIVATIONAL_MESSAGES[hit];
        const msg = msgs[Math.floor(Math.random() * msgs.length)];
        const msgEl = document.getElementById('mission-message');
        if (msgEl) {
            msgEl.innerText = msg;
            msgEl.classList.remove('animate-fade-in');
            void msgEl.offsetWidth;
            msgEl.classList.add('animate-fade-in');
        }
        if (hit === 100) triggerConfetti();
    }
}

// --- 6. POPULARITY SCALING ---
function applyPopularityScaling() {
    if (editMode) return;
    const cards = document.querySelectorAll('.product-card');
    if (cards.length === 0) return;

    const salesCounts = products.map(p => (todaySalesByProduct[p.product_id]?.count) || 0);
    const maxSales = Math.max(...salesCounts, 1);

    let topIdx = 0, topCount = 0;
    salesCounts.forEach((c, i) => { if (c > topCount) { topCount = c; topIdx = i; } });

    cards.forEach((card, i) => {
        const count = salesCounts[i] || 0;
        const scale = 1 + (count / maxSales) * 0.12;
        card.style.transform = `scale(${scale})`;

        const oldBadge = card.querySelector('.hot-badge');
        if (oldBadge) oldBadge.remove();
        card.classList.remove('hot-product');

        if (i === topIdx && topCount > 0) {
            card.classList.add('hot-product');
            const badge = document.createElement('span');
            badge.className = 'hot-badge';
            badge.textContent = '🔥 #1';
            card.appendChild(badge);
        }
    });
}

// --- 7. CAROUSEL ---
function initCarousel() {
    const container = document.getElementById('analytics-carousel');
    const dots = document.querySelectorAll('.carousel-dot');
    if (!container || !dots.length) return;

    container.addEventListener('scroll', () => {
        const idx = Math.round(container.scrollLeft / container.clientWidth);
        dots.forEach((d, i) => d.classList.toggle('active', i === idx));
    });

    dots.forEach(dot => {
        dot.addEventListener('click', () => {
            container.scrollTo({ left: parseInt(dot.dataset.idx) * container.clientWidth, behavior: 'smooth' });
        });
    });
}

// --- 8. CHARTS ---
async function renderCharts() {
    if (typeof Chart === 'undefined') return;
    const allTx = await idbOp('transactions', 'readonly', s => s.getAll());
    const todayTx = allTx.filter(t => t.date === todayStr);
    renderPieChart(todayTx);
    renderHourlyChart(todayTx);
    renderWeeklyChart(allTx);
}

function renderPieChart(todayTx) {
    const rev = {};
    todayTx.forEach(t => {
        const p = products.find(x => x.product_id === t.product_id);
        const n = p ? p.name : 'อื่นๆ';
        rev[n] = (rev[n] || 0) + t.total_revenue;
    });

    const labels = Object.keys(rev), data = Object.values(rev);
    const ctx = document.getElementById('chart-pie');
    if (!ctx) return;
    if (chartPie) chartPie.destroy();

    chartPie = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: labels.length ? labels : ['ยังไม่มียอด'],
            datasets: [{
                data: data.length ? data : [1],
                backgroundColor: data.length ? CHART_COLORS.slice(0, labels.length) : ['rgba(255,255,255,0.06)'],
                borderWidth: 0, borderRadius: 4
            }]
        },
        options: {
            responsive: true, maintainAspectRatio: false, cutout: '65%',
            plugins: { legend: { position: 'right', labels: { boxWidth: 8, padding: 8, font: { size: 10, family: 'Inter' } } } }
        }
    });
}

function renderHourlyChart(todayTx) {
    const hourly = {};
    for (let h = 6; h <= 23; h++) hourly[h] = 0;
    todayTx.forEach(t => { const h = new Date(t.timestamp).getHours(); if (hourly[h] !== undefined) hourly[h] += t.total_revenue; });

    const ctx = document.getElementById('chart-hourly');
    if (!ctx) return;
    if (chartHourly) chartHourly.destroy();

    chartHourly = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: Object.keys(hourly).map(h => `${h}:00`),
            datasets: [{ data: Object.values(hourly), backgroundColor: 'rgba(20, 224, 138, 0.45)', borderRadius: 6, barThickness: 10 }]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            scales: {
                x: { grid: { display: false }, ticks: { font: { size: 8 }, maxRotation: 0 } },
                y: { grid: { color: 'rgba(255,255,255,0.03)' }, ticks: { font: { size: 8 } }, beginAtZero: true }
            },
            plugins: { legend: { display: false } }
        }
    });
}

function renderWeeklyChart(allTx) {
    const days = [], revenues = [];
    for (let i = 6; i >= 0; i--) {
        const d = new Date(); d.setDate(d.getDate() - i);
        const dateStr = d.toLocaleString("en-CA", { timeZone: "Asia/Bangkok", year: 'numeric', month: '2-digit', day: '2-digit' });
        days.push(d.toLocaleDateString('th-TH', { weekday: 'short', timeZone: "Asia/Bangkok" }));
        revenues.push(allTx.filter(t => t.date === dateStr).reduce((s, t) => s + t.total_revenue, 0));
    }

    const thisW = revenues.reduce((a, b) => a + b, 0);
    const lastWRevs = [];
    for (let i = 13; i >= 7; i--) {
        const d = new Date(); d.setDate(d.getDate() - i);
        const ds = d.toLocaleString("en-CA", { timeZone: "Asia/Bangkok", year: 'numeric', month: '2-digit', day: '2-digit' });
        lastWRevs.push(allTx.filter(t => t.date === ds).reduce((s, t) => s + t.total_revenue, 0));
    }
    const lastW = lastWRevs.reduce((a, b) => a + b, 0);
    const growth = lastW > 0 ? ((thisW - lastW) / lastW * 100).toFixed(1) : 0;

    const ctx = document.getElementById('chart-weekly');
    if (!ctx) return;
    if (chartWeekly) chartWeekly.destroy();

    chartWeekly = new Chart(ctx, {
        type: 'line',
        data: {
            labels: days,
            datasets: [{
                data: revenues, borderColor: '#14e08a', backgroundColor: 'rgba(20,224,138,0.08)',
                fill: true, tension: 0.4, borderWidth: 2.5,
                pointBackgroundColor: '#14e08a', pointRadius: 3, pointHoverRadius: 5
            }]
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            scales: {
                x: { grid: { display: false }, ticks: { font: { size: 10 } } },
                y: { grid: { color: 'rgba(255,255,255,0.03)' }, ticks: { font: { size: 8 } }, beginAtZero: true }
            },
            plugins: {
                legend: { display: false },
                title: {
                    display: true, text: `Growth: ${growth > 0 ? '+' : ''}${growth}%`, font: { size: 11, weight: '700' },
                    color: growth >= 0 ? '#14e08a' : '#ef4444', padding: { bottom: 4 }
                }
            }
        }
    });
}

function updateChartsOnSale(tx) {
    if (chartPie) {
        const p = products.find(x => x.product_id === tx.product_id);
        const name = p ? p.name : 'อื่นๆ';
        const idx = chartPie.data.labels.indexOf(name);
        if (chartPie.data.labels[0] === 'ยังไม่มียอด') {
            chartPie.data.labels = [name];
            chartPie.data.datasets[0].data = [tx.total_revenue];
            chartPie.data.datasets[0].backgroundColor = [CHART_COLORS[0]];
        } else if (idx >= 0) { chartPie.data.datasets[0].data[idx] += tx.total_revenue; }
        else {
            chartPie.data.labels.push(name);
            chartPie.data.datasets[0].data.push(tx.total_revenue);
            chartPie.data.datasets[0].backgroundColor.push(CHART_COLORS[chartPie.data.labels.length - 1] || '#6b7280');
        }
        chartPie.update('none');
    }
    if (chartHourly) {
        const h = new Date(tx.timestamp).getHours();
        const idx = chartHourly.data.labels.indexOf(`${h}:00`);
        if (idx >= 0) chartHourly.data.datasets[0].data[idx] += tx.total_revenue;
        chartHourly.update('none');
    }
    if (chartWeekly) {
        const last = chartWeekly.data.datasets[0].data.length - 1;
        chartWeekly.data.datasets[0].data[last] += tx.total_revenue;
        chartWeekly.update('none');
    }
}

// --- 9. EDIT MODE ---
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

    const name = prompt("ชื่อสินค้า:", prod.name);
    if (name === null) return;
    const price = parseFloat(prompt("ราคาขาย:", prod.price));
    if (isNaN(price)) return;
    const cost = parseFloat(prompt("ต้นทุน:", prod.cost) || prod.cost);
    const emojiInput = prompt("Emoji สินค้า:", prod.emoji || '🍉');

    prod.name = name;
    prod.price = price;
    prod.cost = cost;
    if (emojiInput) prod.emoji = emojiInput;

    await idbOp('products', 'readwrite', s => s.put(prod));
    await loadProducts();
    renderProductGrid();
    showToast("อัปเดตสินค้าแล้ว ✅");
}

// --- 10. EVENTS ---
function attachEvents() {
    document.getElementById('product-grid').addEventListener('click', e => {
        const sellBtn = e.target.closest('.sell-btn');
        if (sellBtn && sellBtn.dataset.id) return sellProduct(sellBtn.dataset.id, sellBtn);

        const editBtn = e.target.closest('.edit-btn');
        if (editBtn && editBtn.dataset.id) return editProduct(editBtn.dataset.id);
    });

    document.getElementById('btn-settings').addEventListener('click', toggleEditMode);

    const addBtn = document.getElementById('btn-add-product');
    if (addBtn) addBtn.addEventListener('click', () => promptAddProduct());

    const editAddBtn = document.getElementById('edit-add-product');
    if (editAddBtn) editAddBtn.addEventListener('click', () => promptAddProduct());

    const editDone = document.getElementById('edit-done');
    if (editDone) editDone.addEventListener('click', toggleEditMode);
}

// --- 11. ANIMATIONS ---
function playMicroAnimations(btn) {
    const revEl = document.getElementById('kpi-revenue');
    if (revEl) {
        revEl.classList.remove('kpi-bounce');
        void revEl.offsetWidth;
        revEl.classList.add('kpi-bounce');
    }
    if (navigator.vibrate) navigator.vibrate(40);
}

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

function triggerConfetti() {
    if (typeof confetti === 'function') confetti({ particleCount: 120, spread: 80, origin: { y: 0.7 } });
}

// --- 12. UTILITIES ---
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
    const emoji = prompt("Emoji สินค้า (เช่น 🍕):", PRODUCT_EMOJIS[products.length % PRODUCT_EMOJIS.length]);

    await idbOp('products', 'readwrite', s => s.put({
        product_id: generateId(), name, price, cost, emoji: emoji || '🍉', is_active: true
    }));
    showToast("เพิ่มสินค้าแล้ว ✅");
    await loadProducts();
    renderProductGrid();
    if (!editMode) applyPopularityScaling();
    renderCharts();
}

async function exportData() {
    try {
        const txs = await idbOp('transactions', 'readonly', s => s.getAll());
        const blob = new Blob([JSON.stringify(txs, null, 2)], { type: "application/json" });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `micropos-export-${todayStr}.json`;
        link.click();
        showToast("ส่งออกข้อมูลสำเร็จ!");
    } catch (e) { showToast("ส่งออกล้มเหลว", "error"); }
}
