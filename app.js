/**
 * MicroPOS - Ultra-Fast Browser-Only SPA
 * Logic Layer, Storage, UI Binding, Analytics & Charts
 */

// --- 1. CONFIG & CONSTANTS ---
const DB_NAME = 'micropos_db';
const DB_VERSION = 1;

let db;
let profile = {
    id: 'default_user',
    shop_name: 'ร้านค้าของฉัน',
    settings: { currency: 'THB', daily_goal_mode: 'revenue', audio: false }
};

let dailyState = {
    date: '',
    total_qty: 0,
    total_revenue: 0,
    goal_value: 1000,
    goal_progress: 0,
    streak_count: 0
};

let products = [];
let todayStr = '';

// Analytics state
let todaySalesByProduct = {}; // { product_id: { count, revenue, name } }
let chartPie = null;
let chartHourly = null;
let chartWeekly = null;

const CHART_COLORS = [
    '#0f3d2e', '#7ED957', '#3b82f6', '#f59e0b', '#ef4444',
    '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16', '#f97316'
];

const MOTIVATIONAL_MESSAGES = {
    0: ["เริ่มได้ดีแล้ว เฮีย สู้ ๆ ค่ะ 💪", "ออเดอร์แรกมาแล้ว! ลุยต่อเลย 🔥"],
    10: ["จุดพลังกำลังเพิ่ม 📈", "ยอดเยี่ยมมาก ไปต่อเรื่อยๆ ✨"],
    25: ["ครึ่งทางแล้ว มั่นใจได้ 🌟", "มาดีมาก ทะลุเป้าแน่นอน 🚀"],
    50: ["ดีมาก! ต่อไปให้สุด 🎯", "เกินครึ่งทางแล้ว ลุยต่อนะคะ ⚡"],
    75: ["ใกล้แล้ว! เตรียมรับรางวัล 🏆", "อีกนิดเดียวเท่านั้น สู้ๆ! 🏃‍♂️"],
    90: ["จะถึงเป้าแล้ว! หายใจลึกๆ 🧘‍♂️", "โอ้โห โคตรเก่งเลยเฮีย! 💖"],
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
        console.error("Initialization error:", e);
        showToast("เกิดข้อผิดพลาดในการโหลดระบบ", "error");
    }
}

function getLocalToday() {
    return new Date().toLocaleString("en-CA", { timeZone: "Asia/Bangkok", year: 'numeric', month: '2-digit', day: '2-digit' });
}

function generateId() {
    return crypto.randomUUID ? crypto.randomUUID() : 'id-' + Date.now() + Math.random().toString(36).substr(2, 9);
}

// --- 3. DATABASE WRAPPER ---
function initDB() {
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = e => {
            const dbRef = e.target.result;
            if (!dbRef.objectStoreNames.contains('products')) {
                dbRef.createObjectStore('products', { keyPath: 'product_id' });
            }
            if (!dbRef.objectStoreNames.contains('transactions')) {
                const txStore = dbRef.createObjectStore('transactions', { keyPath: 'tx_id' });
                txStore.createIndex('timestamp', 'timestamp', { unique: false });
                txStore.createIndex('date', 'date', { unique: false });
            }
            if (!dbRef.objectStoreNames.contains('dailyRecords')) {
                dbRef.createObjectStore('dailyRecords', { keyPath: 'date' });
            }
            if (!dbRef.objectStoreNames.contains('profile')) {
                dbRef.createObjectStore('profile', { keyPath: 'id' });
            }
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
        try {
            req = op(store);
        } catch (err) {
            return reject(err);
        }
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

// --- 4. BUSINESS LOGIC ---
async function loadProfile() {
    const prof = await idbOp('profile', 'readonly', s => s.get('default_user'));
    if (prof) {
        profile = prof;
    } else {
        await idbOp('profile', 'readwrite', s => s.put(profile));
    }
}

async function initDailyState() {
    const cached = localStorage.getItem(`dailyState_${todayStr}`);
    if (cached) {
        dailyState = JSON.parse(cached);
    }

    const record = await idbOp('dailyRecords', 'readonly', s => s.get(todayStr));
    if (record) {
        dailyState = record;
    } else {
        const prevRecords = await idbOp('dailyRecords', 'readonly', s => s.getAll());
        prevRecords.sort((a, b) => a.date > b.date ? -1 : 1);

        let streak = 0;
        let avgBase = 0;
        if (prevRecords.length > 0) {
            const last = prevRecords[0];
            if (last.goal_progress >= last.goal_value) streak = last.streak_count + 1;
            else streak = 0;

            const sample = prevRecords.slice(0, 7);
            const sum = sample.reduce((acc, val) => acc + (profile.settings.daily_goal_mode === 'revenue' ? val.total_revenue : val.total_qty), 0);
            avgBase = sum / sample.length;
        }

        if (avgBase < 100) avgBase = 500;

        const factor = 0.85 + (Math.random() * 0.3);
        const newGoal = Math.max(10, Math.round(avgBase * factor));

        dailyState = {
            date: todayStr,
            total_qty: 0,
            total_revenue: 0,
            total_cost: 0,
            total_profit: 0,
            goal_value: newGoal,
            goal_progress: 0,
            streak_count: streak
        };
        await idbOp('dailyRecords', 'readwrite', s => s.put(dailyState));
    }
    syncLocalCache();
}

function syncLocalCache() {
    localStorage.setItem(`dailyState_${todayStr}`, JSON.stringify(dailyState));
}

async function loadProducts() {
    products = await idbOp('products', 'readonly', s => s.getAll());
    products = products.filter(p => p.is_active);
}

async function createDummyProducts() {
    const dummies = [
        { product_id: generateId(), name: 'น้ำแตงโมปั่น', price: 45, cost: 20, is_active: true },
        { product_id: generateId(), name: 'กาแฟเย็น', price: 50, cost: 25, is_active: true },
        { product_id: generateId(), name: 'ชานมไข่มุก', price: 40, cost: 18, is_active: true }
    ];
    for (let p of dummies) {
        await idbOp('products', 'readwrite', s => s.put(p));
    }
}

// Load today's sales data for popularity & charts
async function loadTodaySalesData() {
    todaySalesByProduct = {};
    try {
        const allTx = await idbOp('transactions', 'readonly', s => s.getAll());
        const todayTx = allTx.filter(t => t.date === todayStr);
        todayTx.forEach(t => {
            if (!todaySalesByProduct[t.product_id]) {
                const prod = products.find(p => p.product_id === t.product_id);
                todaySalesByProduct[t.product_id] = {
                    count: 0,
                    revenue: 0,
                    name: prod ? prod.name : 'ไม่ทราบ'
                };
            }
            todaySalesByProduct[t.product_id].count += t.quantity;
            todaySalesByProduct[t.product_id].revenue += t.total_revenue;
        });
    } catch (e) {
        console.error("Failed to load sales data", e);
    }
}

// Main Sale Action (< 3s rule)
async function sellProduct(productId, btnEl) {
    const prod = products.find(p => p.product_id === productId);
    if (!prod) return;

    const tx = {
        tx_id: generateId(),
        product_id: prod.product_id,
        quantity: 1,
        unit_price: Number(prod.price),
        unit_cost: Number(prod.cost),
        total_revenue: Number(prod.price),
        total_cost: Number(prod.cost),
        profit: Number(prod.price) - Number(prod.cost),
        timestamp: new Date().toISOString(),
        date: todayStr
    };

    // Memory Update
    dailyState.total_qty += 1;
    dailyState.total_revenue += tx.total_revenue;
    dailyState.total_cost += tx.total_cost;
    dailyState.total_profit += tx.profit;
    dailyState.goal_progress = profile.settings.daily_goal_mode === 'revenue' ? dailyState.total_revenue : dailyState.total_qty;

    // Track per-product sales
    if (!todaySalesByProduct[productId]) {
        todaySalesByProduct[productId] = { count: 0, revenue: 0, name: prod.name };
    }
    todaySalesByProduct[productId].count += 1;
    todaySalesByProduct[productId].revenue += tx.total_revenue;

    // UI Optimistic Render & Effects
    updateKPIs();
    updateMissionUI();
    playMicroAnimations(btnEl);
    applyPopularityScaling();
    updateChartsOnSale(tx);

    // Background DB Persist
    syncLocalCache();
    try {
        const idbTx = db.transaction(['transactions', 'dailyRecords'], 'readwrite');
        idbTx.objectStore('transactions').add(tx);
        idbTx.objectStore('dailyRecords').put(dailyState);
    } catch (e) {
        console.error("DB write failed", e);
        showToast("บันทึกลงฐานข้อมูลไม่สำเร็จ", "error");
    }
}

// --- 5. UI & EFFECTS ---
function renderUI() {
    document.getElementById('shop-name-display').textContent = profile.shop_name;

    const grid = document.getElementById('product-grid');
    grid.innerHTML = '';

    products.forEach(p => {
        const div = document.createElement('div');
        div.className = "product-card bg-white rounded-2xl p-3 flex flex-col shadow-sm relative overflow-hidden group border border-gray-100";
        div.dataset.productId = p.product_id;

        div.innerHTML = `
            <div class="flex-1">
                <p class="font-bold text-gray-900 text-sm mb-1 line-clamp-2 leading-tight">${p.name}</p>
                <p class="text-sm font-black text-primary mb-3">฿${p.price}</p>
            </div>
            <button class="sell-btn w-full bg-primary text-white rounded-xl py-3 font-bold text-base shadow-sm flex justify-center items-center gap-1" data-id="${p.product_id}">
                <svg class="w-5 h-5 opacity-80" fill="none" stroke="currentColor" stroke-width="3" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" d="M12 4v16m8-8H4"></path></svg>
                ขาย
            </button>
        `;
        grid.appendChild(div);
    });

    updateKPIs(false);
    updateMissionUI(false);
    applyPopularityScaling();
}

function updateKPIs(animate = true) {
    const revEl = document.getElementById('kpi-revenue');
    const qtyEl = document.getElementById('kpi-qty');
    const streakEl = document.getElementById('kpi-streak');

    if (animate) {
        animateValue(revEl, Number(revEl.innerText.replace(/,/g, '')), dailyState.total_revenue, 400);
        qtyEl.innerText = dailyState.total_qty.toLocaleString();
    } else {
        revEl.innerText = dailyState.total_revenue.toLocaleString();
        qtyEl.innerText = dailyState.total_qty.toLocaleString();
    }
    streakEl.innerHTML = `<span class="text-sm">🔥</span>${dailyState.streak_count}`;
}

let lastThreshold = -1;
function updateMissionUI(animate = true) {
    const curEl = document.getElementById('mission-current');
    const targetEl = document.getElementById('mission-target');
    const progressBar = document.getElementById('mission-progress-bar');

    if (curEl) curEl.innerText = dailyState.goal_progress.toLocaleString();
    if (targetEl) targetEl.innerText = dailyState.goal_value.toLocaleString() + (profile.settings.daily_goal_mode === 'revenue' ? '฿' : '');

    let pct = Math.min((dailyState.goal_progress / dailyState.goal_value) * 100, 100);
    if (progressBar) progressBar.style.width = `${pct}%`;

    // Motivation Check
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

        if (hit === 100 && animate) {
            triggerConfetti();
        }
    }
}

// --- 6. DYNAMIC POPULARITY SCALING ---
function applyPopularityScaling() {
    const cards = document.querySelectorAll('.product-card');
    if (cards.length === 0) return;

    // Get sales counts
    const salesCounts = products.map(p => {
        const data = todaySalesByProduct[p.product_id];
        return data ? data.count : 0;
    });
    const maxSales = Math.max(...salesCounts, 1); // prevent /0

    // Find top seller
    let topIdx = 0;
    let topCount = 0;
    salesCounts.forEach((c, i) => {
        if (c > topCount) { topCount = c; topIdx = i; }
    });

    cards.forEach((card, i) => {
        const count = salesCounts[i] || 0;
        const scale = 1 + (count / maxSales) * 0.15; // Range 1.0 — 1.15

        card.style.transform = `scale(${scale})`;

        // Remove old badge
        const oldBadge = card.querySelector('.hot-badge');
        if (oldBadge) oldBadge.remove();
        card.classList.remove('hot-product');

        // Add badge to top seller (only if they have > 0 sales)
        if (i === topIdx && topCount > 0) {
            card.classList.add('hot-product');
            const badge = document.createElement('span');
            badge.className = 'hot-badge';
            badge.textContent = '🔥 #1';
            card.appendChild(badge);
        }
    });
}

// --- 7. ANALYTICS CAROUSEL ---
function initCarousel() {
    const container = document.getElementById('analytics-carousel');
    const dots = document.querySelectorAll('.carousel-dot');
    if (!container || dots.length === 0) return;

    // Update dots on scroll
    container.addEventListener('scroll', () => {
        const scrollLeft = container.scrollLeft;
        const slideWidth = container.clientWidth;
        const activeIdx = Math.round(scrollLeft / slideWidth);
        dots.forEach((dot, i) => {
            dot.classList.toggle('active', i === activeIdx);
        });
    });

    // Click dots to navigate
    dots.forEach(dot => {
        dot.addEventListener('click', () => {
            const idx = parseInt(dot.dataset.idx);
            container.scrollTo({ left: idx * container.clientWidth, behavior: 'smooth' });
        });
    });
}

// --- 8. CHART RENDERING ---
async function renderCharts() {
    if (typeof Chart === 'undefined') {
        console.warn("Chart.js not loaded yet, skipping charts.");
        return;
    }

    const allTx = await idbOp('transactions', 'readonly', s => s.getAll());
    const todayTx = allTx.filter(t => t.date === todayStr);

    renderPieChart(todayTx);
    renderHourlyChart(todayTx);
    renderWeeklyChart(allTx);
}

function renderPieChart(todayTx) {
    const productRevenue = {};
    todayTx.forEach(t => {
        const prod = products.find(p => p.product_id === t.product_id);
        const name = prod ? prod.name : 'อื่นๆ';
        productRevenue[name] = (productRevenue[name] || 0) + t.total_revenue;
    });

    const labels = Object.keys(productRevenue);
    const data = Object.values(productRevenue);

    const ctx = document.getElementById('chart-pie');
    if (!ctx) return;

    if (chartPie) chartPie.destroy();

    chartPie = new Chart(ctx, {
        type: 'doughnut',
        data: {
            labels: labels.length > 0 ? labels : ['ยังไม่มียอด'],
            datasets: [{
                data: data.length > 0 ? data : [1],
                backgroundColor: data.length > 0 ? CHART_COLORS.slice(0, labels.length) : ['#e5e7eb'],
                borderWidth: 0,
                borderRadius: 4
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            cutout: '60%',
            plugins: {
                legend: {
                    position: 'right',
                    labels: {
                        boxWidth: 10,
                        padding: 8,
                        font: { size: 11, family: 'Inter' }
                    }
                }
            }
        }
    });
}

function renderHourlyChart(todayTx) {
    // Group by hour
    const hourly = {};
    for (let h = 6; h <= 23; h++) {
        hourly[h] = 0;
    }
    todayTx.forEach(t => {
        const hour = new Date(t.timestamp).getHours();
        if (hourly[hour] !== undefined) hourly[hour] += t.total_revenue;
        else hourly[hour] = t.total_revenue;
    });

    const labels = Object.keys(hourly).map(h => `${h}:00`);
    const data = Object.values(hourly);

    const ctx = document.getElementById('chart-hourly');
    if (!ctx) return;

    if (chartHourly) chartHourly.destroy();

    chartHourly = new Chart(ctx, {
        type: 'bar',
        data: {
            labels,
            datasets: [{
                data,
                backgroundColor: '#0f3d2e',
                borderRadius: 6,
                barThickness: 12
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: {
                    grid: { display: false },
                    ticks: { font: { size: 9, family: 'Inter' }, maxRotation: 0 }
                },
                y: {
                    grid: { color: '#f3f4f6' },
                    ticks: { font: { size: 9, family: 'Inter' } },
                    beginAtZero: true
                }
            },
            plugins: {
                legend: { display: false }
            }
        }
    });
}

function renderWeeklyChart(allTx) {
    // Last 7 days
    const days = [];
    const revenues = [];
    for (let i = 6; i >= 0; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const dateStr = d.toLocaleString("en-CA", { timeZone: "Asia/Bangkok", year: 'numeric', month: '2-digit', day: '2-digit' });
        const dayName = d.toLocaleDateString('th-TH', { weekday: 'short', timeZone: "Asia/Bangkok" });
        days.push(dayName);
        const dayRevenue = allTx
            .filter(t => t.date === dateStr)
            .reduce((sum, t) => sum + t.total_revenue, 0);
        revenues.push(dayRevenue);
    }

    // Growth calculation
    const thisWeekTotal = revenues.reduce((a, b) => a + b, 0);
    const lastWeekRevenues = [];
    for (let i = 13; i >= 7; i--) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        const dateStr = d.toLocaleString("en-CA", { timeZone: "Asia/Bangkok", year: 'numeric', month: '2-digit', day: '2-digit' });
        const dayRevenue = allTx
            .filter(t => t.date === dateStr)
            .reduce((sum, t) => sum + t.total_revenue, 0);
        lastWeekRevenues.push(dayRevenue);
    }
    const lastWeekTotal = lastWeekRevenues.reduce((a, b) => a + b, 0);
    const growth = lastWeekTotal > 0 ? ((thisWeekTotal - lastWeekTotal) / lastWeekTotal * 100).toFixed(1) : 0;

    const ctx = document.getElementById('chart-weekly');
    if (!ctx) return;

    if (chartWeekly) chartWeekly.destroy();

    chartWeekly = new Chart(ctx, {
        type: 'line',
        data: {
            labels: days,
            datasets: [{
                data: revenues,
                borderColor: '#7ED957',
                backgroundColor: 'rgba(126, 217, 87, 0.1)',
                fill: true,
                tension: 0.4,
                borderWidth: 3,
                pointBackgroundColor: '#0f3d2e',
                pointRadius: 4,
                pointHoverRadius: 6
            }]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            scales: {
                x: {
                    grid: { display: false },
                    ticks: { font: { size: 10, family: 'Inter' } }
                },
                y: {
                    grid: { color: '#f3f4f6' },
                    ticks: { font: { size: 9, family: 'Inter' } },
                    beginAtZero: true
                }
            },
            plugins: {
                legend: { display: false },
                title: {
                    display: true,
                    text: `Growth: ${growth > 0 ? '+' : ''}${growth}%`,
                    font: { size: 11, weight: '600', family: 'Inter' },
                    color: growth >= 0 ? '#16a34a' : '#ef4444',
                    padding: { bottom: 4 }
                }
            }
        }
    });
}

// Smoothly update charts after each sale
function updateChartsOnSale(tx) {
    // Update pie chart data
    if (chartPie) {
        const prod = products.find(p => p.product_id === tx.product_id);
        const name = prod ? prod.name : 'อื่นๆ';
        const idx = chartPie.data.labels.indexOf(name);

        if (chartPie.data.labels[0] === 'ยังไม่มียอด') {
            chartPie.data.labels = [name];
            chartPie.data.datasets[0].data = [tx.total_revenue];
            chartPie.data.datasets[0].backgroundColor = [CHART_COLORS[0]];
        } else if (idx >= 0) {
            chartPie.data.datasets[0].data[idx] += tx.total_revenue;
        } else {
            chartPie.data.labels.push(name);
            chartPie.data.datasets[0].data.push(tx.total_revenue);
            chartPie.data.datasets[0].backgroundColor.push(CHART_COLORS[chartPie.data.labels.length - 1] || '#6b7280');
        }
        chartPie.update('none');
    }

    // Update hourly chart
    if (chartHourly) {
        const hour = new Date(tx.timestamp).getHours();
        const hourLabel = `${hour}:00`;
        const idx = chartHourly.data.labels.indexOf(hourLabel);
        if (idx >= 0) {
            chartHourly.data.datasets[0].data[idx] += tx.total_revenue;
        }
        chartHourly.update('none');
    }

    // Update weekly (last bar is today)
    if (chartWeekly) {
        const lastIdx = chartWeekly.data.datasets[0].data.length - 1;
        chartWeekly.data.datasets[0].data[lastIdx] += tx.total_revenue;
        chartWeekly.update('none');
    }
}

// --- 9. EVENTS ---
function attachEvents() {
    document.getElementById('product-grid').addEventListener('click', e => {
        const btn = e.target.closest('.sell-btn');
        if (btn && btn.dataset.id) {
            sellProduct(btn.dataset.id, btn);
        }
    });

    document.getElementById('btn-settings').addEventListener('click', async () => {
        await exportData();
    });

    const addBtn = document.getElementById('btn-add-product');
    if (addBtn) {
        addBtn.addEventListener('click', () => {
            promptAddProduct();
        });
    }
}

// --- 10. MICRO-ANIMATIONS ---
function playMicroAnimations(btn) {
    const revEl = document.getElementById('kpi-revenue');
    if (revEl) {
        revEl.classList.remove('kpi-bounce');
        void revEl.offsetWidth;
        revEl.classList.add('kpi-bounce');
    }

    if (navigator.vibrate) {
        navigator.vibrate(50);
    }
}

function animateValue(obj, start, end, duration) {
    let startTimestamp = null;
    const step = (timestamp) => {
        if (!startTimestamp) startTimestamp = timestamp;
        const progress = Math.min((timestamp - startTimestamp) / duration, 1);
        const current = Math.floor(progress * (end - start) + start);
        obj.innerHTML = current.toLocaleString();
        if (progress < 1) {
            window.requestAnimationFrame(step);
        } else {
            obj.innerHTML = end.toLocaleString();
        }
    };
    window.requestAnimationFrame(step);
}

function triggerConfetti() {
    if (typeof confetti === 'function') {
        confetti({ particleCount: 120, spread: 80, origin: { y: 0.7 } });
    }
}

// --- 11. UTILITIES ---
function showToast(msg, type = "info") {
    const container = document.getElementById('toast-container');
    const el = document.createElement('div');
    el.className = `px-4 py-2 rounded-lg shadow-lg text-sm text-white font-medium toast-anim ${type === 'error' ? 'bg-red-500' : 'bg-gray-800'}`;
    el.innerText = msg;
    container.appendChild(el);
    setTimeout(() => el.remove(), 3000);
}

async function promptAddProduct() {
    const name = prompt("ชื่อสินค้า:");
    if (!name) return;
    const price = parseFloat(prompt("ราคาขาย:"));
    if (isNaN(price)) return;
    const cost = parseFloat(prompt("ต้นทุน:") || 0);

    const p = {
        product_id: generateId(),
        name,
        price,
        cost,
        is_active: true
    };
    await idbOp('products', 'readwrite', s => s.put(p));
    showToast("เพิ่มสินค้าแล้ว");
    await loadProducts();
    renderUI();
    renderCharts();
}

async function exportData() {
    try {
        const txs = await idbOp('transactions', 'readonly', s => s.getAll());
        const json = JSON.stringify(txs, null, 2);
        const blob = new Blob([json], { type: "application/json" });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `micropos-export-${todayStr}.json`;
        link.click();
        showToast("ส่งออกข้อมูลสำเร็จ!");
    } catch (e) {
        showToast("ส่งออกข้อมูลล้มเหลว", "error");
    }
}
