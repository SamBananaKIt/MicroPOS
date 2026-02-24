/**
 * MicroPOS v3 — Circular Grid + Image Upload
 */

const DB_NAME = 'micropos_db';
const DB_VERSION = 1;

let db;
let profile = { id: 'default_user', shop_name: 'ร้านค้าของฉัน', settings: { currency: 'THB', daily_goal_mode: 'revenue', audio: false, unit_name: 'ชิ้น' } };
let dailyState = { date: '', total_qty: 0, total_revenue: 0, goal_value: 1000, goal_progress: 0, streak_count: 0 };
let products = [];
let todayStr = '';
let todayTx = [];
let todaySalesByProduct = {};
let lastTransactionIds = [];
let undoTimeout = null;
let currentView = 'cashier';
let lastShakeTime = 0;
const SHAKE_THRESHOLD = 15;

let intelligenceData = {
    efficiency: 100,
    projected: 0,
    trends: {},
    heatmap: new Array(24).fill(0)
};
let chartPie = null, chartHourly = null, chartWeekly = null;
let editMode = false;

const PRODUCT_EMOJIS = ['🍉', '☕', '🧋', '🥤', '🍊', '🥐', '🍜', '🧁', '🍕', '🍔', '🍟', '🥗', '🍦', '🍪', '🍩'];
const CHART_COLORS = ['#00B3C6', '#4C9AFF', '#8FD3F4', '#9BADB6'];

if (typeof Chart !== 'undefined') {
    Chart.defaults.color = '#9CA3AF';
    Chart.defaults.borderColor = 'rgba(0, 50, 80, 0.05)';
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
        await loadProducts();
        if (products.length === 0) { await createDummyProducts(); await loadProducts(); }
        await initDailyState();
        renderUI();
        attachEvents();
        initCarousel();
        initGestures();
        renderCharts();
    } catch (e) {
        console.error("App init failed", e);
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
            const sum = sample.reduce((a, v) => {
                const val = profile.settings.daily_goal_mode === 'revenue' ? (v.total_revenue || 0) : (v.total_qty || 0);
                return a + val;
            }, 0);
            avgBase = sum / sample.length;
        }
        if (avgBase < 100) avgBase = 500;
        dailyState = {
            date: todayStr,
            total_qty: 0,
            total_revenue: 0,
            total_cost: 0,
            total_profit: 0,
            goal_value: Math.max(10, Math.round(avgBase * (0.85 + Math.random() * 0.3))),
            goal_progress: 0,
            streak_count: streak
        };
        await idbOp('dailyRecords', 'readwrite', s => s.put(dailyState));
    }
    await loadTodayData();
    syncLocalCache();
    updateIntelligence();
}

async function loadTodayData() {
    const allTx = await idbOp('transactions', 'readonly', s => s.getAll());
    todayTx = allTx.filter(t => t.date === todayStr);
    todaySalesByProduct = {};
    todayTx.forEach(t => {
        const pid = t.product_id;
        const p = products.find(x => x.product_id === pid);
        if (!todaySalesByProduct[pid]) todaySalesByProduct[pid] = { count: 0, revenue: 0, profit: 0, name: p?.name || '?' };
        todaySalesByProduct[pid].count += (t.quantity || 1);
        todaySalesByProduct[pid].revenue += t.total_revenue;
        todaySalesByProduct[pid].profit += (t.profit || 0);
    });
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
    await loadTodayData();
}

// --- SELL & UNDO ---
async function undoLastSale() {
    if (!lastTransactionIds.length) return;

    // Clear toast immediately
    const toastContainer = document.getElementById('toast-container');
    if (toastContainer) toastContainer.innerHTML = '';

    try {
        const idbTx = db.transaction(['transactions', 'dailyRecords'], 'readwrite');
        const txStore = idbTx.objectStore('transactions');

        let removedQty = 0;
        let removedRev = 0;
        let removedCost = 0;
        let removedProfit = 0;
        let productId = null;

        for (const tid of lastTransactionIds) {
            const req = txStore.get(tid);
            req.onsuccess = (e) => {
                const txRecord = e.target.result;
                if (txRecord) {
                    productId = txRecord.product_id;
                    removedQty += 1;
                    removedRev += txRecord.total_revenue;
                    removedCost += txRecord.total_cost;
                    removedProfit += txRecord.profit;
                    txStore.delete(tid);
                }
            };
        }

        idbTx.oncomplete = async () => {
            if (!removedQty) return;

            dailyState.total_qty -= removedQty;
            dailyState.total_revenue -= removedRev;
            dailyState.total_cost -= removedCost;
            dailyState.total_profit -= removedProfit;
            dailyState.goal_progress = profile.settings.daily_goal_mode === 'revenue' ? dailyState.total_revenue : dailyState.total_qty;

            if (productId && todaySalesByProduct[productId]) {
                todaySalesByProduct[productId].count = Math.max(0, todaySalesByProduct[productId].count - removedQty);
                todaySalesByProduct[productId].revenue = Math.max(0, todaySalesByProduct[productId].revenue - removedRev);
            }

            await idbOp('dailyRecords', 'readwrite', s => s.put(dailyState));

            // Re-render everything from fresh DB fetch to accurately update charts
            lastTransactionIds = [];
            await loadProducts(); // Re-calculates todaySalesByProduct properly from DB
            renderProductGrid();
            if (!editMode) applyPopularityScaling();
            updateKPIs();
            updateMissionUI();
            updateTopTicker();
            updateLiveRanking();
            renderCharts();

            showToast("ยกเลิกรายการสำเร็จ ↩️");
            const bigUndo = document.getElementById('btn-big-undo');
            if (bigUndo) bigUndo.style.display = 'none';
        };
    } catch (e) {
        console.error("Undo failed", e);
    }
}

async function sellProduct(productId, qty = 1) {
    const prod = products.find(p => p.product_id === productId);
    if (!prod) return;

    if (undoTimeout) clearTimeout(undoTimeout);
    lastTransactionIds = [];

    for (let i = 0; i < qty; i++) {
        const tx = { tx_id: generateId(), product_id: prod.product_id, quantity: 1, unit_price: Number(prod.price), unit_cost: Number(prod.cost), total_revenue: Number(prod.price), total_cost: Number(prod.cost), profit: Number(prod.price) - Number(prod.cost), timestamp: new Date().toISOString(), date: todayStr };

        dailyState.total_qty += 1;
        dailyState.total_revenue += tx.total_revenue;
        dailyState.total_cost += tx.total_cost;
        dailyState.total_profit += tx.profit;
        dailyState.goal_progress = profile.settings.daily_goal_mode === 'revenue' ? dailyState.total_revenue : dailyState.total_qty;

        if (!todaySalesByProduct[productId]) todaySalesByProduct[productId] = { count: 0, revenue: 0, profit: 0, name: prod.name };
        todaySalesByProduct[productId].count += 1;
        todaySalesByProduct[productId].revenue += tx.total_revenue;
        todaySalesByProduct[productId].profit += tx.profit;

        try {
            const idbTx = db.transaction(['transactions', 'dailyRecords'], 'readwrite');
            idbTx.objectStore('transactions').add(tx);
            idbTx.objectStore('dailyRecords').put(dailyState);
            lastTransactionIds.push(tx.tx_id);
            todayTx.push(tx);
        } catch (e) { console.error("DB write failed", e); }

        updateChartsOnSale(tx);
    }

    syncLocalCache();
    updateKPIs();
    updateMissionUI();
    updateIntelligence();
    applyPopularityScaling();
    updateTopTicker();
    updateLiveRanking();

    // v4 UX: Show Big Undo
    const bigUndo = document.getElementById('btn-big-undo');
    if (bigUndo) {
        bigUndo.style.display = 'flex';
        if (undoTimeout) clearTimeout(undoTimeout);
        undoTimeout = setTimeout(() => {
            bigUndo.style.opacity = '0';
            setTimeout(() => { bigUndo.style.display = 'none'; bigUndo.style.opacity = '1'; }, 300);
        }, 8000);
    }

    showToast(`${prod.name} x${qty} ✓`, "success", true);
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
    updateLiveRanking();
}

function renderProductGrid() {
    const grid = document.getElementById('product-grid');
    grid.innerHTML = '';
    const CIRC = 2 * Math.PI * 40;

    // Sort products based on dropdown
    const sortMode = document.getElementById('product-sort')?.value || 'default';
    let sorted = [...products];
    switch (sortMode) {
        case 'best':
            sorted.sort((a, b) => ((todaySalesByProduct[b.product_id]?.count || 0) - (todaySalesByProduct[a.product_id]?.count || 0)));
            break;
        case 'price-asc':
            sorted.sort((a, b) => a.price - b.price);
            break;
        case 'price-desc':
            sorted.sort((a, b) => b.price - a.price);
            break;
        case 'name':
            sorted.sort((a, b) => a.name.localeCompare(b.name, 'th'));
            break;
    }

    sorted.forEach((p, i) => {
        const emoji = p.emoji || PRODUCT_EMOJIS[i % PRODUCT_EMOJIS.length];
        const salesData = todaySalesByProduct[p.product_id];
        const salesCount = salesData ? salesData.count : 0;
        const profit = salesData ? salesData.profit : 0;
        const trend = intelligenceData.trends[p.product_id] || { dod: 0, status: 'Stable' };

        const item = document.createElement('div');
        item.className = 'product-item';
        item.dataset.productId = p.product_id;
        item.setAttribute('role', 'listitem');
        item.setAttribute('aria-label', `${p.name} ราคา ${p.price} บาท`);

        let circleInner;
        if (p.image) {
            circleInner = `<img src="${p.image}" alt="${p.name}">`;
        } else {
            circleInner = `<span class="emoji-fallback">${emoji}</span>`;
        }

        const saleBadge = `<span class="sale-count" style="display: ${salesCount > 0 ? 'flex' : 'none'}">${salesCount}</span>`;

        // Trend Tag
        const trendIcon = trend.dod >= 0 ? '▲' : '▼';
        const trendColor = trend.dod >= 0 ? 'var(--primary)' : '#EF4444';
        const trendHTML = salesCount > 0 ? `<div class="trend-indicator" style="color: ${trendColor}">${trendIcon} ${Math.abs(trend.dod)}%</div>` : '';
        const statusHTML = trend.status !== 'Stable' ? `<div class="status-tag ${trend.status.toLowerCase()}">${trend.status}</div>` : '';

        // Activity ring SVG
        const ringSVG = `<svg class="activity-ring" viewBox="0 0 88 88">
            <circle class="ring-bg" cx="44" cy="44" r="40"/>
            <circle class="ring-fill" cx="44" cy="44" r="40" stroke-dasharray="${CIRC}" stroke-dashoffset="${CIRC}" data-circ="${CIRC}"/>
        </svg>`;

        item.innerHTML = `
            <div class="product-circle-wrap">
                ${ringSVG}
                <div class="product-circle">${circleInner}${editMode ? '<div class="edit-overlay">✏️</div>' : ''}</div>
                ${saleBadge}
                ${trendHTML}
                ${statusHTML}
            </div>
            <span class="product-label">${p.name}</span>
            <span class="product-price-tag">฿${p.price}</span>
        `;

        grid.appendChild(item);
    });
}

function updateKPIs(animate = true) {
    const revEl = document.getElementById('kpi-revenue');
    const qtyEl = document.getElementById('kpi-qty');
    const streakEl = document.getElementById('kpi-streak');
    const unitEl = document.getElementById('kpi-unit-name');
    if (unitEl) unitEl.textContent = profile.settings.unit_name || 'ชิ้น';
    const effEl = document.getElementById('kpi-efficiency');
    if (effEl) {
        const val = intelligenceData.efficiency;
        effEl.textContent = `${Math.round(val)}%`;
        effEl.style.color = val >= 100 ? '#14e08a' : '#94a3b8';
    }
    const projEl = document.getElementById('kpi-projection');
    if (projEl) {
        projEl.textContent = `฿${Math.round(intelligenceData.projected).toLocaleString()}`;
    }

    // v4 Hero Update
    const heroEff = document.getElementById('hero-efficiency');
    const heroProj = document.getElementById('hero-projection');
    const heroStatus = document.getElementById('hero-status');

    if (heroEff) {
        const val = Math.round(intelligenceData.efficiency);
        heroEff.textContent = `${val}%`;
        heroEff.style.color = val >= 100 ? 'var(--accent-success)' : 'var(--text-muted)';
    }
    if (heroProj) {
        heroProj.textContent = `Projected ฿${Math.round(intelligenceData.projected).toLocaleString()}`;
    }
    if (heroStatus) {
        const val = intelligenceData.efficiency;
        if (val >= 110) heroStatus.textContent = "🚀 พีคมาก เฮีย! วันนี้ร้านมาแรงค่ะ";
        else if (val >= 100) heroStatus.textContent = "✅ ทะลุเป้าแบบมาตรฐาน ดีมากค่ะ";
        else if (val >= 80) heroStatus.textContent = "📈 กำลังขึ้นค่ะ อีกนิสจะถึงเป้าเฉลี่ย";
        else heroStatus.textContent = "☕ พักจิบแฟ แล้วลุยต่อค่ะ เดี๋ยวก็ดีขึ้นนะ";
    }

    if (animate) {
        animateValue(revEl, Number(revEl.innerText.replace(/,/g, '')), dailyState.total_revenue, 500);
        animateValue(qtyEl, Number(qtyEl.innerText.replace(/,/g, '')), dailyState.total_qty, 300);
    } else {
        if (revEl) revEl.innerText = dailyState.total_revenue.toLocaleString();
        if (qtyEl) qtyEl.innerText = dailyState.total_qty.toLocaleString();
    }
    if (streakEl) streakEl.innerText = `🔥 ${dailyState.streak_count}`;
}

let lastThreshold = -1;
function updateMissionUI() {
    const curEl = document.getElementById('mission-current');
    const targetEl = document.getElementById('mission-target');
    const bar = document.getElementById('mission-progress-bar');
    if (curEl) {
        const startVal = Number(curEl.innerText.replace(/,/g, '')) || 0;
        animateValue(curEl, startVal, dailyState.goal_progress, 600);
    }
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

// --- POPULARITY SCALING (PROFIT-BASED) + ACTIVITY RING ---
function applyPopularityScaling() {
    if (editMode) return;
    const items = document.querySelectorAll('.product-item');
    if (!items.length) return;

    // 1. Find the highest profit globally today
    let maxP = 0;
    let topId = null;
    for (const id in todaySalesByProduct) {
        if (todaySalesByProduct[id].profit > maxP) {
            maxP = todaySalesByProduct[id].profit;
            topId = id;
        }
    }
    if (maxP === 0) maxP = 1;

    items.forEach((item) => {
        const pid = item.dataset.productId;
        const pVal = todaySalesByProduct[pid]?.profit || 0;
        const c = todaySalesByProduct[pid]?.count || 0;

        // Scale circle by Profit proportionality (v4 boost)
        const scale = 1 + (pVal / maxP) * 0.25;
        item.style.transform = `scale(${scale})`;

        // Activity ring: still based on sales frequency for "momentum" feel
        const ringFill = item.querySelector('.ring-fill');
        if (ringFill) {
            const circ = parseFloat(ringFill.dataset.circ);
            const counts = Object.values(todaySalesByProduct).map(s => s.count);
            const maxC = Math.max(...counts, 1);
            const pct = c / maxC;
            ringFill.style.strokeDashoffset = circ * (1 - pct);
        }

        // Badges
        item.querySelector('.hot-badge')?.remove();
        item.classList.remove('hot');

        const badge = item.querySelector('.sale-count');
        if (badge) {
            badge.textContent = c;
            badge.style.display = c > 0 ? 'flex' : 'none';
        }

        if (pid === topId && maxP > 0) {
            item.classList.add('hot');
            const hb = document.createElement('span');
            hb.className = 'hot-badge';
            hb.textContent = '🔥 #1 Profit';
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

// --- LIVE RANKING ---
let prevRankOrder = [];

function updateLiveRanking() {
    const section = document.getElementById('ranking-section');
    const list = document.getElementById('ranking-list');
    if (!section || !list) return;

    // Build sorted ranking by PROFIT
    const ranked = [];
    for (const id in todaySalesByProduct) {
        ranked.push({ id, name: todaySalesByProduct[id].name, count: todaySalesByProduct[id].count, profit: todaySalesByProduct[id].profit });
    }
    ranked.sort((a, b) => b.profit - a.profit);

    if (ranked.length === 0 || ranked[0].profit === 0) {
        section.style.display = 'none';
        return;
    }
    section.style.display = '';

    const maxProfit = ranked[0].profit;
    const newOrder = ranked.map(r => r.id);
    const champChanged = prevRankOrder.length > 0 && prevRankOrder[0] !== newOrder[0];

    // Check if order changed or list needs rebuild
    const orderSame = prevRankOrder.length === newOrder.length && prevRankOrder.every((id, i) => id === newOrder[i]);
    const existingItems = list.querySelectorAll('.rank-item');

    if (!orderSame || existingItems.length !== ranked.length) {
        // Rebuild list
        list.innerHTML = '';
        const medals = ['🏆', '🥈', '🥉'];

        ranked.forEach((item, i) => {
            const rank = i + 1;
            const pct = (item.profit / maxProfit) * 100;
            const el = document.createElement('div');
            el.className = `rank-item rank-${rank <= 3 ? rank : 'other'}`;
            el.dataset.productId = item.id; // Add product ID for swipe-to-delete
            el.innerHTML = `
                <div class="rank-num">${rank <= 3 ? medals[rank - 1] : rank}</div>
                <div class="rank-info">
                    <div class="rank-name">${item.name}</div>
                    <div class="rank-bar-track"><div class="rank-bar-fill" style="width:${pct}%"></div></div>
                </div>
                <span class="rank-qty">฿${Math.round(item.profit).toLocaleString()}</span>
            `;
            list.appendChild(el);
        });
    } else {
        ranked.forEach((item, i) => {
            const el = existingItems[i];
            if (!el) return;
            const pct = (item.profit / maxProfit) * 100;
            el.querySelector('.rank-bar-fill').style.width = `${pct}%`;
            el.querySelector('.rank-qty').textContent = `฿${Math.round(item.profit).toLocaleString()}`;
        });
    }

    // Champion change pop effect
    if (champChanged && typeof confetti === 'function') {
        confetti({ particleCount: 30, spread: 50, origin: { y: 0.9 }, colors: ['#14e08a', '#ffd166'] });
    }

    prevRankOrder = newOrder;
}

// --- CAROUSEL ---
function initCarousel() {
    const c = document.getElementById('analytics-carousel');
    const track = c ? c.querySelector('.carousel-track') : null;
    const dots = document.querySelectorAll('.carousel-dot');
    if (!c || !dots.length) return;

    // Add swipe hint animation on load
    if (track) {
        track.classList.add('swipe-hint');
        setTimeout(() => track.classList.remove('swipe-hint'), 2000);
    }

    c.addEventListener('scroll', () => { const idx = Math.round(c.scrollLeft / c.clientWidth); dots.forEach((d, i) => d.classList.toggle('active', i === idx)); });
    dots.forEach(d => d.addEventListener('click', () => c.scrollTo({ left: parseInt(d.dataset.idx) * c.clientWidth, behavior: 'smooth' })));
}

// --- NAVIGATION & GESTURES ---
function switchView(viewName) {
    currentView = viewName;
    document.querySelectorAll('.app-view').forEach(v => v.classList.remove('active'));
    document.getElementById(`view-${viewName}`).classList.add('active');

    document.querySelectorAll('.nav-item').forEach(item => {
        item.classList.toggle('active', item.dataset.view === viewName);
    });

    if (viewName === 'brain') {
        renderCharts();
        updateIntelligence();
    }
    if (navigator.vibrate) navigator.vibrate(20);
}

function initGestures() {
    // Shake-to-Undo
    if (window.DeviceMotionEvent) {
        window.addEventListener('devicemotion', (e) => {
            const acc = e.accelerationIncludingGravity;
            if (!acc) return;
            const total = Math.sqrt(acc.x * acc.x + acc.y * acc.y + acc.z * acc.z);
            const now = Date.now();
            if (total > SHAKE_THRESHOLD && (now - lastShakeTime > 2000)) {
                if (lastTransactionIds.length > 0) {
                    lastShakeTime = now;
                    if (navigator.vibrate) navigator.vibrate([100, 50, 100]);
                    undoLastSale();
                }
            }
        });
    }

    // Nav Click
    document.querySelectorAll('.nav-item').forEach(btn => {
        btn.onclick = () => switchView(btn.dataset.view);
    });

    // Big Undo Click
    const bigUndo = document.getElementById('btn-big-undo');
    if (bigUndo) bigUndo.onclick = undoLastSale;

    // Swipe-to-Delete on Ranking items
    const list = document.getElementById('ranking-list');
    if (list) {
        let startX = 0;
        list.addEventListener('touchstart', e => { startX = e.touches[0].clientX; }, { passive: true });
        list.addEventListener('touchend', async e => {
            const item = e.target.closest('.rank-item');
            if (!item) return;
            const diff = startX - e.changedTouches[0].clientX;
            if (diff > 100) { // Swipe left 100px
                const pid = item.dataset.productId;
                item.style.transform = 'translateX(-100%)';
                item.style.opacity = '0';
                if (navigator.vibrate) navigator.vibrate(50);
                setTimeout(() => undoProductSale(pid), 300);
            }
        });
    }
}

async function undoProductSale(productId) {
    const allTx = await idbOp('transactions', 'readonly', s => s.getAll());
    const todayTx = allTx.filter(t => t.date === todayStr);
    const txs = todayTx.filter(t => t.product_id === productId);
    if (txs.length === 0) return;
    const lastTx = txs[txs.length - 1];
    lastTransactionIds = [lastTx.tx_id];
    await undoLastSale();
}

// --- CHARTS ---
async function renderCharts() {
    if (typeof Chart === 'undefined') return;
    const carousel = document.getElementById('analytics-carousel');
    const scrollPos = carousel ? carousel.scrollLeft : 0;
    const allTx = await idbOp('transactions', 'readonly', s => s.getAll());
    const todayTx = allTx.filter(t => t.date === todayStr);
    renderPieChart(todayTx);
    renderHourlyChart(todayTx);
    renderWeeklyChart(allTx);
    // Restore carousel position after chart re-render
    if (carousel) requestAnimationFrame(() => carousel.scrollLeft = scrollPos);
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
        const unit = profile.settings.unit_name || 'ชิ้น';
        ctx.font = 'bold 18px Inter';
        ctx.fillStyle = '#00B3C6';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(`${total.toLocaleString()} ${unit}`, cx, cy);
        ctx.restore();
    }
};

function renderPieChart(todayTx) {
    const qty = {};
    todayTx.forEach(t => { const p = products.find(x => x.product_id === t.product_id); const name = p ? p.name : '?'; qty[name] = (qty[name] || 0) + t.quantity; });
    const labels = Object.keys(qty), data = Object.values(qty);
    const unit = profile.settings.unit_name || 'ชิ้น';
    const ctx = document.getElementById('chart-pie');
    if (!ctx) return;
    if (chartPie) chartPie.destroy();
    chartPie = new Chart(ctx, {
        type: 'doughnut',
        data: { labels: labels.length ? labels : ['ยังไม่มี'], datasets: [{ data: data.length ? data : [1], backgroundColor: data.length ? CHART_COLORS.slice(0, labels.length) : ['rgba(255,255,255,0.06)'], borderWidth: 0, borderRadius: 4 }] },
        options: {
            responsive: true, maintainAspectRatio: false, cutout: '65%',
            plugins: {
                legend: { position: 'right', labels: { boxWidth: 8, padding: 8, font: { size: 10, family: 'Inter' }, color: '#6B8796' } },
                tooltip: { callbacks: { label: (c) => `${c.label}: ${c.raw.toLocaleString()} ${unit}` }, bodyFont: { family: 'Inter' }, titleFont: { family: 'Inter' } }
            }
        },
        plugins: [donutCenterPlugin]
    });
}

function renderHourlyChart(todayTx) {
    const h = {}; for (let i = 6; i <= 23; i++) h[i] = 0;
    todayTx.forEach(t => { const hr = new Date(t.timestamp).getHours(); if (h[hr] !== undefined) h[hr] += t.quantity; });
    const unit = profile.settings.unit_name || 'ชิ้น';
    const ctx = document.getElementById('chart-hourly');
    if (!ctx) return;
    if (chartHourly) chartHourly.destroy();
    chartHourly = new Chart(ctx, {
        type: 'bar',
        data: { labels: Object.keys(h).map(x => `${x}:00`), datasets: [{ data: Object.values(h), backgroundColor: 'rgba(0, 179, 198, 0.4)', borderRadius: 6, barThickness: 10 }] },
        options: {
            responsive: true, maintainAspectRatio: false,
            scales: {
                x: { grid: { display: false }, border: { display: false }, ticks: { font: { size: 9, family: 'Inter', weight: '600' }, color: '#9CA3AF', maxRotation: 0 } },
                y: { grid: { color: 'rgba(0,50,80,0.05)', drawBorder: false }, border: { display: false }, ticks: { font: { size: 9, family: 'Inter' }, color: '#9CA3AF', stepSize: 1 }, beginAtZero: true }
            },
            plugins: { legend: { display: false }, tooltip: { callbacks: { label: (c) => `${c.raw} ${unit}` }, bodyFont: { family: 'Inter' }, titleFont: { family: 'Inter' } } }
        }
    });
}

function renderWeeklyChart(allTx) {
    const days = [], quantities = [];
    const unit = profile.settings.unit_name || 'ชิ้น';
    for (let i = 6; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); const ds = d.toLocaleString("en-CA", { timeZone: "Asia/Bangkok", year: 'numeric', month: '2-digit', day: '2-digit' }); days.push(d.toLocaleDateString('th-TH', { weekday: 'short', timeZone: "Asia/Bangkok" })); quantities.push(allTx.filter(t => t.date === ds).reduce((s, t) => s + t.quantity, 0)); }
    const thisW = quantities.reduce((a, b) => a + b, 0);
    const lastWQty = [];
    for (let i = 13; i >= 7; i--) { const d = new Date(); d.setDate(d.getDate() - i); const ds = d.toLocaleString("en-CA", { timeZone: "Asia/Bangkok", year: 'numeric', month: '2-digit', day: '2-digit' }); lastWQty.push(allTx.filter(t => t.date === ds).reduce((s, t) => s + t.quantity, 0)); }
    const lastW = lastWQty.reduce((a, b) => a + b, 0);
    const growth = lastW > 0 ? ((thisW - lastW) / lastW * 100).toFixed(1) : 0;
    const ctx = document.getElementById('chart-weekly');
    if (!ctx) return;
    if (chartWeekly) chartWeekly.destroy();
    chartWeekly = new Chart(ctx, {
        type: 'line',
        data: { labels: days, datasets: [{ data: quantities, borderColor: '#00B3C6', backgroundColor: 'rgba(0, 179, 198, 0.1)', fill: true, tension: 0.4, borderWidth: 2.5, pointBackgroundColor: '#00B3C6', pointRadius: 3, pointHoverRadius: 5 }] },
        options: {
            responsive: true, maintainAspectRatio: false,
            scales: {
                x: { grid: { display: false }, border: { display: false }, ticks: { font: { size: 10, family: 'Inter', weight: '600' }, color: '#9CA3AF' } },
                y: { grid: { color: 'rgba(0,50,80,0.05)' }, border: { display: false }, ticks: { font: { size: 9, family: 'Inter' }, color: '#9CA3AF', stepSize: 1 }, beginAtZero: true }
            },
            plugins: {
                legend: { display: false },
                tooltip: { callbacks: { label: (c) => `${c.raw} ${unit}` }, bodyFont: { family: 'Inter' }, titleFont: { family: 'Inter' } },
                title: { display: true, text: `Growth: ${growth > 0 ? '+' : ''}${growth}%`, font: { size: 11, weight: '700', family: 'Inter' }, color: growth >= 0 ? '#00B3C6' : '#ef4444', padding: { bottom: 4 } }
            }
        }
    });
}

function updateChartsOnSale(tx) {
    if (chartPie) {
        const p = products.find(x => x.product_id === tx.product_id);
        const n = p ? p.name : '?';
        const idx = chartPie.data.labels.indexOf(n);
        if (chartPie.data.labels[0] === 'ยังไม่มี') { chartPie.data.labels = [n]; chartPie.data.datasets[0].data = [tx.quantity]; chartPie.data.datasets[0].backgroundColor = [CHART_COLORS[0]]; }
        else if (idx >= 0) chartPie.data.datasets[0].data[idx] += tx.quantity;
        else { chartPie.data.labels.push(n); chartPie.data.datasets[0].data.push(tx.quantity); chartPie.data.datasets[0].backgroundColor.push(CHART_COLORS[chartPie.data.labels.length - 1] || '#6b7280'); }
        chartPie.update('none');
    }
    if (chartHourly) { const hr = new Date(tx.timestamp).getHours(); const idx = chartHourly.data.labels.indexOf(`${hr}:00`); if (idx >= 0) chartHourly.data.datasets[0].data[idx] += tx.quantity; chartHourly.update('none'); }
    if (chartWeekly) { const last = chartWeekly.data.datasets[0].data.length - 1; chartWeekly.data.datasets[0].data[last] += tx.quantity; chartWeekly.update('none'); }
}

// --- INTELLIGENCE ENGINE ---
async function updateIntelligence() {
    const allTx = await idbOp('transactions', 'readonly', s => s.getAll());
    const history = await idbOp('dailyRecords', 'readonly', s => s.getAll());

    // 1. Efficiency Score
    const lookback7 = history.slice(-7);
    const lookback3 = history.slice(-3);
    const avg7 = lookback7.length > 0 ? (lookback7.reduce((s, d) => s + d.total_revenue, 0) / lookback7.length) : 0;
    const avg3 = lookback3.length > 0 ? (lookback3.reduce((s, d) => s + d.total_revenue, 0) / lookback3.length) : 0;

    let baseline = avg7 > 0 ? avg7 : avg3;
    let score = baseline > 0 ? (dailyState.total_revenue / baseline) * 100 : 100;
    intelligenceData.efficiency = Math.min(Math.max(score, 0), 300);

    // 2. Momentum Prediction (Minute-based)
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const elapsedMins = (now - startOfDay) / (1000 * 60);

    if (elapsedMins >= 30) {
        intelligenceData.projected = (dailyState.total_revenue / elapsedMins) * 1440;
    } else {
        intelligenceData.projected = 0;
    }

    // 3. Trends & Life Cycle (Deep logic)
    const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
    const yStr = yesterday.toISOString().split('T')[0];
    const d3Str = new Date(now.getTime() - 3 * 86400000).toISOString().split('T')[0];
    const d7Str = new Date(now.getTime() - 7 * 86400000).toISOString().split('T')[0];

    const yTx = allTx.filter(t => t.date === yStr);
    const last3Tx = allTx.filter(t => t.date >= d3Str && t.date < todayStr);
    const last7Tx = allTx.filter(t => t.date >= d7Str && t.date < todayStr);

    products.forEach(p => {
        const pid = p.product_id;
        const todayC = todaySalesByProduct[pid]?.count || 0;
        const yC = yTx.filter(t => t.product_id === pid).length;
        const avg3 = last3Tx.filter(t => t.product_id === pid).length / 3;
        const avg7 = last7Tx.filter(t => t.product_id === pid).length / 7;

        const dod = yC > 0 ? Math.round(((todayC - yC) / yC) * 100) : (todayC > 0 ? 100 : 0);
        const growth = avg7 > 0 ? ((todayC - avg7) / avg7) * 100 : (todayC > 0 ? 100 : 0);

        let status = 'Stable';
        if (growth > 10) status = 'Rising';
        else if (growth < -10) status = 'Cooling';
        if (todayC < avg3 && avg3 > 0 && todayC < avg3 * 0.5) status = 'Declining';

        intelligenceData.trends[pid] = {
            dod: Math.min(Math.max(dod, -100), 300),
            status: status
        };
    });

    // 4. Heatmap
    intelligenceData.heatmap = new Array(24).fill(0);
    todayTx.forEach(t => {
        const hr = new Date(t.timestamp).getHours();
        intelligenceData.heatmap[hr]++;
    });

    renderHeatmap();
    renderProductGrid();
}

function renderHeatmap() {
    const container = document.getElementById('heat-map-container');
    if (!container) return;
    container.innerHTML = '';
    const max = Math.max(...intelligenceData.heatmap, 1);
    intelligenceData.heatmap.forEach((val, hr) => {
        const cell = document.createElement('div');
        cell.className = 'heat-cell';
        const opacity = (val / max);
        cell.style.background = `rgba(20, 224, 138, ${0.1 + opacity * 0.9})`;
        cell.setAttribute('data-time', `${hr}:00`);
        container.appendChild(cell);
    });
}

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
                const ctx = canvas.getContext('2d');
                ctx.drawImage(img, 0, 0, w, h);
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

// --- PRODUCT MODAL (ADD & EDIT) ---
let modalProductId = null;
let modalImageBase64 = null;

// Cropper State
let cropImgObj = null;
let cropScale = 1;
let cropX = 0, cropY = 0;
let isDraggingCrop = false;
let startX = 0, startY = 0;

function resetCropper() {
    cropImgObj = null;
    document.getElementById('crop-controls').style.display = 'none';
}

function initCropper(base64) {
    cropImgObj = new Image();
    cropImgObj.onload = () => {
        const minDim = Math.min(cropImgObj.width, cropImgObj.height);
        cropScale = 140 / minDim;
        cropX = 0;
        cropY = 0;

        const zoomInput = document.getElementById('crop-zoom');
        if (zoomInput) {
            zoomInput.min = cropScale * 0.5;
            zoomInput.max = cropScale * 3;
            zoomInput.value = cropScale;
        }
        document.getElementById('crop-controls').style.display = 'block';
        drawCrop();
    };
    cropImgObj.src = base64;
}

function drawCrop() {
    if (!cropImgObj) return;
    let canvas = document.getElementById('crop-canvas');
    if (!canvas) {
        const preview = document.getElementById('modal-img-preview');
        preview.innerHTML = '<canvas id="crop-canvas" width="140" height="140"></canvas>';
        canvas = document.getElementById('crop-canvas');
        attachCropEvents(canvas);
    }
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#F4F8FB';
    ctx.fillRect(0, 0, 140, 140);

    const w = cropImgObj.width * cropScale;
    const h = cropImgObj.height * cropScale;
    const dx = (140 - w) / 2 + cropX;
    const dy = (140 - h) / 2 + cropY;

    ctx.drawImage(cropImgObj, dx, dy, w, h);
}

function attachCropEvents(canvas) {
    canvas.addEventListener('pointerdown', e => {
        isDraggingCrop = true;
        startX = e.clientX - cropX;
        startY = e.clientY - cropY;
        canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', e => {
        if (!isDraggingCrop) return;
        cropX = e.clientX - startX;
        cropY = e.clientY - startY;
        drawCrop();
    });
    canvas.addEventListener('pointerup', () => isDraggingCrop = false);

    const zoomInput = document.getElementById('crop-zoom');
    if (zoomInput) {
        // Prevent duplicate listeners, simple overwrite
        zoomInput.oninput = (e) => {
            cropScale = parseFloat(e.target.value);
            drawCrop();
        };
    }
}

function getFinalImage() {
    if (cropImgObj) {
        const canvas = document.getElementById('crop-canvas');
        if (canvas) return canvas.toDataURL('image/jpeg', 0.8);
    }
    return modalImageBase64;
}

function openProductModal(productId = null) {
    modalProductId = productId;
    resetCropper();

    const modal = document.getElementById('product-modal');
    const title = document.getElementById('modal-title');
    const nameInput = document.getElementById('modal-input-name');
    const priceInput = document.getElementById('modal-input-price');
    const costInput = document.getElementById('modal-input-cost');
    const imgPreview = document.getElementById('modal-img-preview');
    const deleteBtn = document.getElementById('btn-modal-delete');

    if (productId) {
        const prod = products.find(p => p.product_id === productId);
        if (!prod) return;
        title.innerText = "แก้ไขสินค้า";
        nameInput.value = prod.name;
        priceInput.value = prod.price;
        costInput.value = prod.cost || '';
        modalImageBase64 = prod.image || null;
        if (prod.image) {
            imgPreview.innerHTML = `<img src="${prod.image}" style="width:100%; height:100%; object-fit:cover;">`;
        } else {
            imgPreview.innerHTML = prod.emoji || '📷';
        }
        deleteBtn.style.display = 'block';
    } else {
        title.innerText = "เพิ่มสินค้าใหม่";
        nameInput.value = '';
        priceInput.value = '';
        costInput.value = '';
        modalImageBase64 = null;
        imgPreview.innerHTML = '📷';
        deleteBtn.style.display = 'none';
    }

    modal.style.display = 'flex';
    nameInput.focus();
}

function closeProductModal() {
    document.getElementById('product-modal').style.display = 'none';
}

async function saveProductModal() {
    const name = document.getElementById('modal-input-name').value.trim();
    const price = parseFloat(document.getElementById('modal-input-price').value);
    const cost = parseFloat(document.getElementById('modal-input-cost').value) || 0;

    if (!name || isNaN(price)) {
        showToast("กรุณากรอกชื่อและราคาให้ครบ", "error");
        return;
    }

    const finalImage = getFinalImage();

    if (modalProductId) {
        const prod = products.find(p => p.product_id === modalProductId);
        if (prod) {
            prod.name = name;
            prod.price = price;
            prod.cost = cost;
            prod.image = finalImage;
            await idbOp('products', 'readwrite', s => s.put(prod));
            showToast("อัปเดตสำเร็จ ✅");
        }
    } else {
        const newId = generateId();
        const emoji = PRODUCT_EMOJIS[products.length % PRODUCT_EMOJIS.length];
        await idbOp('products', 'readwrite', s => s.put({
            product_id: newId, name, price, cost, emoji, image: finalImage, is_active: true
        }));
        showToast("เพิ่มสินค้าแล้ว ✅");
    }

    closeProductModal();
    await loadProducts();
    renderProductGrid();
    if (!editMode) applyPopularityScaling();
    renderCharts();
}

async function deleteProductModal() {
    if (!modalProductId) return;
    const prod = products.find(p => p.product_id === modalProductId);
    if (!prod) return;

    if (confirm(`คุณแน่ใจหรือไม่ที่จะลบ "${prod.name}" ?`)) {
        prod.is_active = false;
        await idbOp('products', 'readwrite', s => s.put(prod));
        closeProductModal();
        await loadProducts();
        renderProductGrid();
        showToast("ลบสินค้าแล้ว");
    }
}

// Attach image uploader to modal
function triggerModalImageUpload() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.className = 'hidden-input';
    input.addEventListener('change', async () => {
        if (!input.files[0]) return;
        const base64 = await compressImage(input.files[0], 800); // Allow higher res before crop
        initCropper(base64);
        input.remove();
    });
    document.body.appendChild(input);
    input.click();
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
        if (item && item.dataset.productId) openProductModal(item.dataset.productId);
    });

    // Gear button: tap = Settings, long-press = Edit Mode
    let gearLongPress = null;
    let gearTriggered = false;
    const gearBtn = document.getElementById('btn-settings');

    gearBtn.addEventListener('pointerdown', () => {
        gearTriggered = false;
        gearLongPress = setTimeout(() => {
            gearTriggered = true;
            toggleEditMode();
        }, 500);
    });
    gearBtn.addEventListener('pointerup', () => {
        clearTimeout(gearLongPress);
        if (!gearTriggered) openSettingsModal();
    });
    gearBtn.addEventListener('pointerleave', () => clearTimeout(gearLongPress));

    const addBtn = document.getElementById('btn-add-product');
    if (addBtn) addBtn.addEventListener('click', () => openProductModal());
    const editAddBtn = document.getElementById('edit-add-product');
    if (editAddBtn) editAddBtn.addEventListener('click', () => openProductModal());
    const editDone = document.getElementById('edit-done');
    if (editDone) editDone.addEventListener('click', toggleEditMode);

    // Sort dropdown
    const sortSelect = document.getElementById('product-sort');
    if (sortSelect) sortSelect.addEventListener('change', () => { renderProductGrid(); if (!editMode) applyPopularityScaling(); });

    // Product Modal Events
    const modalCancelBtn = document.getElementById('btn-modal-cancel');
    if (modalCancelBtn) modalCancelBtn.addEventListener('click', closeProductModal);
    const modalSaveBtn = document.getElementById('btn-modal-save');
    if (modalSaveBtn) modalSaveBtn.addEventListener('click', saveProductModal);
    const modalDeleteBtn = document.getElementById('btn-modal-delete');
    if (modalDeleteBtn) modalDeleteBtn.addEventListener('click', deleteProductModal);
    const modalImgUpload = document.getElementById('modal-img-upload');
    if (modalImgUpload) modalImgUpload.addEventListener('click', triggerModalImageUpload);

    // Settings Modal Events
    document.getElementById('btn-settings-cancel')?.addEventListener('click', closeSettingsModal);
    document.getElementById('btn-settings-save')?.addEventListener('click', saveSettings);
    document.getElementById('btn-export-data')?.addEventListener('click', exportData);
    document.getElementById('btn-import-data')?.addEventListener('click', importData);
    document.getElementById('btn-reset-today')?.addEventListener('click', resetToday);

    // Goal mode toggles
    document.getElementById('settings-mode-revenue')?.addEventListener('click', () => {
        document.getElementById('settings-mode-revenue').classList.add('active');
        document.getElementById('settings-mode-qty').classList.remove('active');
    });
    document.getElementById('settings-mode-qty')?.addEventListener('click', () => {
        document.getElementById('settings-mode-qty').classList.add('active');
        document.getElementById('settings-mode-revenue').classList.remove('active');
    });

    // Unit preset buttons
    document.querySelectorAll('.unit-preset-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            document.getElementById('settings-unit-name').value = btn.dataset.unit;
        });
    });
}

// --- SETTINGS MODAL ---
function openSettingsModal() {
    const modal = document.getElementById('settings-modal');
    document.getElementById('settings-shop-name').value = profile.shop_name;
    document.getElementById('settings-goal-value').value = dailyState.goal_value;
    document.getElementById('settings-unit-name').value = profile.settings.unit_name || 'ชิ้น';
    const isRevenue = profile.settings.daily_goal_mode === 'revenue';
    document.getElementById('settings-mode-revenue').classList.toggle('active', isRevenue);
    document.getElementById('settings-mode-qty').classList.toggle('active', !isRevenue);
    modal.style.display = 'flex';
}

function closeSettingsModal() {
    document.getElementById('settings-modal').style.display = 'none';
}

async function saveSettings() {
    const shopName = document.getElementById('settings-shop-name').value.trim();
    const goalValue = parseInt(document.getElementById('settings-goal-value').value);
    const isRevenue = document.getElementById('settings-mode-revenue').classList.contains('active');

    if (shopName) profile.shop_name = shopName;
    profile.settings.daily_goal_mode = isRevenue ? 'revenue' : 'qty';
    const unitName = document.getElementById('settings-unit-name').value.trim();
    if (unitName) profile.settings.unit_name = unitName;
    await idbOp('profile', 'readwrite', s => s.put(profile));

    if (!isNaN(goalValue) && goalValue > 0) {
        dailyState.goal_value = goalValue;
        dailyState.goal_progress = isRevenue ? dailyState.total_revenue : dailyState.total_qty;
        await idbOp('dailyRecords', 'readwrite', s => s.put(dailyState));
        syncLocalCache();
    }

    document.getElementById('shop-name-display').textContent = profile.shop_name;
    updateKPIs();
    updateMissionUI();
    renderCharts();
    closeSettingsModal();
    showToast("บันทึกการตั้งค่าแล้ว ✅");
}

// --- DATA EXPORT / IMPORT ---
async function exportData() {
    try {
        const txs = await idbOp('transactions', 'readonly', s => s.getAll());
        const prods = await idbOp('products', 'readonly', s => s.getAll());
        const dailyRecords = await idbOp('dailyRecords', 'readonly', s => s.getAll());
        const exportObj = {
            exported_at: new Date().toISOString(),
            profile, products: prods, daily_records: dailyRecords, transactions: txs
        };
        const blob = new Blob([JSON.stringify(exportObj, null, 2)], { type: "application/json" });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = `micropos-backup-${todayStr}.json`;
        link.click();
        URL.revokeObjectURL(link.href);
        showToast(`ส่งออกสำเร็จ! (${txs.length} รายการ) 📤`);
    } catch (e) { console.error("Export failed:", e); showToast("ส่งออกล้มเหลว", "error"); }
}

function importData() {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.json';
    input.addEventListener('change', async () => {
        if (!input.files[0]) return;
        try {
            const data = JSON.parse(await input.files[0].text());
            if (!data.transactions || !data.products) { showToast("ไฟล์ไม่ถูกต้อง", "error"); return; }
            if (!confirm(`นำเข้า ${data.transactions.length} รายการขาย + ${data.products.length} สินค้า?\n\n⚠️ ข้อมูลเก่าจะถูกแทนที่`)) return;
            for (const prod of data.products) await idbOp('products', 'readwrite', s => s.put(prod));
            for (const tx of data.transactions) await idbOp('transactions', 'readwrite', s => s.put(tx));
            if (data.daily_records) for (const dr of data.daily_records) await idbOp('dailyRecords', 'readwrite', s => s.put(dr));
            if (data.profile) { profile = data.profile; await idbOp('profile', 'readwrite', s => s.put(profile)); }
            await loadProducts(); await loadTodaySalesData(); await initDailyState();
            renderUI(); renderCharts(); closeSettingsModal();
            showToast("นำเข้าสำเร็จ! 📥");
        } catch (e) { console.error("Import failed:", e); showToast("นำเข้าล้มเหลว", "error"); }
        input.remove();
    });
    document.body.appendChild(input); input.click();
}

async function resetToday() {
    if (!confirm("⚠️ รีเซ็ตยอดขายวันนี้ทั้งหมด?\n\nข้อมูลจะถูกลบถาวร")) return;
    try {
        const allTx = await idbOp('transactions', 'readonly', s => s.getAll());
        for (const tx of allTx.filter(t => t.date === todayStr)) await idbOp('transactions', 'readwrite', s => s.delete(tx.tx_id));
        dailyState.total_qty = 0; dailyState.total_revenue = 0; dailyState.total_cost = 0;
        dailyState.total_profit = 0; dailyState.goal_progress = 0;
        await idbOp('dailyRecords', 'readwrite', s => s.put(dailyState)); syncLocalCache();
        todaySalesByProduct = {};
        renderUI(); renderCharts(); closeSettingsModal();
        showToast("รีเซ็ตยอดวันนี้เรียบร้อย 🗑️");
    } catch (e) { console.error("Reset failed:", e); showToast("รีเซ็ตล้มเหลว", "error"); }
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

function showToast(msg, type = "info", showUndo = false) {
    const c = document.getElementById('toast-container');
    const el = document.createElement('div');
    el.className = `toast ${type === 'error' ? 'toast-error' : 'toast-info'} ${showUndo ? 'toast-undo' : ''}`;
    if (showUndo) {
        el.innerHTML = `<span>${msg}</span> <button class="undo-btn" onclick="undoLastSale()">ย้อนกลับ ↩️</button>`;
    } else { el.innerText = msg; }
    c.appendChild(el);
    const timeout = setTimeout(() => el.remove(), showUndo ? 7000 : 3000);
    if (showUndo) undoTimeout = timeout;
}

