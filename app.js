/**
 * MicroPOS - Ultra-Fast Browser-Only SPA
 * Logic Layer, Storage, and UI Binding
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
    goal_value: 1000, // naive default
    goal_progress: 0,
    streak_count: 0
};

let products = [];
let todayStr = '';

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

        // Setup initial dummy products if empty
        if (products.length === 0) {
            await createDummyProducts();
            await loadProducts();
        }

        renderUI();
        attachEvents();
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
    // Read cached fast state if available
    const cached = localStorage.getItem(`dailyState_${todayStr}`);
    if (cached) {
        dailyState = JSON.parse(cached);
    }

    const record = await idbOp('dailyRecords', 'readonly', s => s.get(todayStr));
    if (record) {
        dailyState = record;
    } else {
        // Run Daily Reset / Goal Generation
        const prevRecords = await idbOp('dailyRecords', 'readonly', s => s.getAll());
        prevRecords.sort((a, b) => a.date > b.date ? -1 : 1);

        let streak = 0;
        let avgBase = 0;
        if (prevRecords.length > 0) {
            const last = prevRecords[0];
            // If the last active day met the goal, maintain streak
            if (last.goal_progress >= last.goal_value) streak = last.streak_count + 1;
            else streak = 0;

            // Calculate 7 day average
            const sample = prevRecords.slice(0, 7);
            const sum = sample.reduce((acc, val) => acc + (profile.settings.daily_goal_mode === 'revenue' ? val.total_revenue : val.total_qty), 0);
            avgBase = sum / sample.length;
        }

        // naive fallback if new
        if (avgBase < 100) avgBase = 500;

        // random goal +/- 15%
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

// Main Sale Action (< 3s rule)
async function sellProduct(productId, btnEl) {
    const prod = products.find(p => p.product_id === productId);
    if (!prod) return;

    // 1. Transaction creation
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

    // 2. Memory Update
    dailyState.total_qty += 1;
    dailyState.total_revenue += tx.total_revenue;
    dailyState.total_cost += tx.total_cost;
    dailyState.total_profit += tx.profit;
    dailyState.goal_progress = profile.settings.daily_goal_mode === 'revenue' ? dailyState.total_revenue : dailyState.total_qty;

    // 3. UI Optimistic Render & Effects
    updateKPIs();
    updateMissionUI();
    playMicroAnimations(btnEl);

    // 4. Background DB Persist (Atomic)
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

    // Render Products
    const grid = document.getElementById('product-grid');
    grid.innerHTML = '';

    products.forEach(p => {
        const div = document.createElement('div');
        div.className = "bg-white border border-gray-100 rounded-xl p-3 flex flex-col items-center shadow-sm relative";
        div.innerHTML = `
            <div class="w-16 h-16 bg-gray-50 rounded-full flex items-center justify-center mb-2 font-bold text-xl text-primary/30">
                ${p.name.substring(0, 2)}
            </div>
            <p class="font-medium text-gray-800 text-sm mb-1 text-center line-clamp-1">${p.name}</p>
            <p class="text-xs text-green-600 font-bold mb-3">฿${p.price}</p>
            <button class="w-full bg-primary text-white rounded-lg py-2 font-semibold text-sm ripple-btn btn-scale shadow-sm flex justify-center items-center gap-1" data-id="${p.product_id}">
                <svg class="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 6v6m0 0v6m0-6h6m-6 0H6"></path></svg>
                ขาย
            </button>
        `;
        grid.appendChild(div);
    });

    updateKPIs(false);
    updateMissionUI(false);
}

function updateKPIs(animate = true) {
    const revEl = document.getElementById('kpi-revenue');
    const qtyEl = document.getElementById('kpi-qty');
    const streakEl = document.getElementById('kpi-streak');

    if (animate) {
        animateValue(revEl, Number(revEl.innerText.replace(/,/g, '')), dailyState.total_revenue, 400);
        animateValue(qtyEl, Number(qtyEl.innerText.replace(/,/g, '')), dailyState.total_qty, 400);
    } else {
        revEl.innerText = dailyState.total_revenue.toLocaleString();
        qtyEl.innerText = dailyState.total_qty.toLocaleString();
    }
    streakEl.innerHTML = `<span class="text-sm">🔥</span>${dailyState.streak_count}`;
}

let lastThreshold = -1;
function updateMissionUI(animate = true) {
    const curEl = document.getElementById('mission-current');
    document.getElementById('mission-target').innerText = dailyState.goal_value.toLocaleString() + (profile.settings.daily_goal_mode === 'revenue' ? '฿' : '');

    if (animate) {
        animateValue(curEl, Number(curEl.innerText.replace(/,/g, '').replace('฿', '')), dailyState.goal_progress, 600);
    } else {
        curEl.innerText = dailyState.goal_progress.toLocaleString();
    }

    // Progress bar
    let pct = Math.min((dailyState.goal_progress / dailyState.goal_value) * 100, 100);
    document.getElementById('mission-progress-bar').style.width = `${pct}%`;

    // Motivation Check
    const thresholds = [0, 10, 25, 50, 75, 90, 100].reverse();
    const hit = thresholds.find(t => pct >= t);

    if (hit !== undefined && hit !== lastThreshold) {
        lastThreshold = hit;
        const msgs = MOTIVATIONAL_MESSAGES[hit];
        const msg = msgs[Math.floor(Math.random() * msgs.length)];

        const msgEl = document.getElementById('mission-message');
        msgEl.innerText = msg;

        // Re-trigger fade
        msgEl.classList.remove('animate-fade-in');
        void msgEl.offsetWidth;
        msgEl.classList.add('animate-fade-in');

        if (hit === 100 && animate) {
            triggerConfetti();
        }
    }
}

// Helpers
function attachEvents() {
    document.getElementById('product-grid').addEventListener('click', e => {
        const btn = e.target.closest('button');
        if (btn && btn.dataset.id) {
            sellProduct(btn.dataset.id, btn);
        }
    });

    document.getElementById('btn-settings').addEventListener('click', async () => {
        await exportData();
    });

    document.getElementById('btn-add-product').addEventListener('click', () => {
        promptAddProduct();
    });
}

function playMicroAnimations(btn) {
    // Add ripple
    const circle = document.createElement('span');
    const diameter = Math.max(btn.clientWidth, btn.clientHeight);
    const radius = diameter / 2;
    circle.style.width = circle.style.height = `${diameter}px`;
    circle.style.left = `${btn.clientWidth / 2 - radius}px`;
    circle.style.top = `${btn.clientHeight / 2 - radius}px`;
    circle.className = 'absolute rounded-full bg-white/40 scale-0 animate-[ripple_400ms_ease-out]';
    btn.appendChild(circle);
    setTimeout(() => circle.remove(), 400);

    // Number pop on KPI
    const revEl = document.getElementById('kpi-revenue');
    revEl.classList.remove('animate-count-up');
    void revEl.offsetWidth;
    revEl.classList.add('animate-count-up');
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

function showToast(msg, type = "info") {
    const container = document.getElementById('toast-container');
    const el = document.createElement('div');
    el.className = `px-4 py-2 rounded-lg shadow-lg text-sm text-white font-medium toast-anim ${type === 'error' ? 'bg-red-500' : 'bg-gray-800'}`;
    el.innerText = msg;
    container.appendChild(el);
    setTimeout(() => el.remove(), 3000);
}

// Add simple style rule for ripple dynamically
const style = document.createElement('style');
style.textContent = `
    @keyframes ripple {
        to { transform: scale(4); opacity: 0; }
    }
    .animate-fade-in {
        animation: fadeIn 0.5s ease-in-out;
    }
    @keyframes fadeIn {
        from { opacity: 0; transform: translateY(5px); }
        to { opacity: 1; transform: translateY(0); }
    }
`;
document.head.appendChild(style);

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
