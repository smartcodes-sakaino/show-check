const TOKEN_KEY = "show-check-token";
let pollTimer = null;

const els = {
  login: document.getElementById("login"),
  app: document.getElementById("app"),
  tokenInput: document.getElementById("tokenInput"),
  loginBtn: document.getElementById("loginBtn"),
  loginError: document.getElementById("loginError"),
  statusBadge: document.getElementById("statusBadge"),
  monitoringBadge: document.getElementById("monitoringBadge"),
  roomLabel: document.getElementById("roomLabel"),
  lastChecked: document.getElementById("lastChecked"),
  lastError: document.getElementById("lastError"),
  startBtn: document.getElementById("startBtn"),
  stopBtn: document.getElementById("stopBtn"),
  roomInput: document.getElementById("roomInput"),
  saveRoomBtn: document.getElementById("saveRoomBtn"),
  roomError: document.getElementById("roomError"),
  refreshBtn: document.getElementById("refreshBtn"),
  giftList: document.getElementById("giftList"),
  logoutBtn: document.getElementById("logoutBtn"),
};

function getToken() {
  return localStorage.getItem(TOKEN_KEY) || "";
}

function setToken(token) {
  localStorage.setItem(TOKEN_KEY, token);
}

function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getToken()}`,
      ...(options.headers || {}),
    },
  });
  if (res.status === 401) {
    clearToken();
    showLogin();
    throw new Error("認証が切れました。もう一度合言葉を入力してください");
  }
  const data = await res.json();
  if (!res.ok) {
    throw new Error(data?.error || `エラーが発生しました (HTTP ${res.status})`);
  }
  return data;
}

function showLogin() {
  els.login.classList.remove("hidden");
  els.app.classList.add("hidden");
  if (pollTimer) clearInterval(pollTimer);
}

function showApp() {
  els.login.classList.add("hidden");
  els.app.classList.remove("hidden");
  refreshStatus();
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(refreshStatus, 5000);
}

const STATUS_LABEL = {
  idle: "未監視",
  polling: "配信検知待ち",
  live: "接続中",
  error: "エラー",
};

function renderStatus(data) {
  els.statusBadge.textContent = STATUS_LABEL[data.status] || data.status;
  els.statusBadge.className = `badge ${data.status}`;
  els.monitoringBadge.textContent = data.monitoring ? "監視ON" : "監視OFF";
  els.monitoringBadge.className = `badge ${data.monitoring ? "live" : ""}`;

  els.roomLabel.textContent = data.room?.roomId
    ? `${data.room.roomName || "(名前未取得)"} / room_id=${data.room.roomId}`
    : "未設定";
  els.lastChecked.textContent = data.lastCheckedAt
    ? new Date(data.lastCheckedAt).toLocaleString("ja-JP")
    : "-";
  els.lastError.textContent = data.lastError || "";

  els.giftList.innerHTML = "";
  if (!data.recentGifts || data.recentGifts.length === 0) {
    const li = document.createElement("li");
    li.textContent = "まだギフトを検知していません";
    li.className = "muted";
    els.giftList.appendChild(li);
  } else {
    for (const g of data.recentGifts) {
      const li = document.createElement("li");
      const time = new Date(g.receivedAt).toLocaleTimeString("ja-JP");
      const syncLabel = g.sheetSynced ? "シート反映済" : g.sheetError ? "シート反映失敗" : "反映中";
      li.innerHTML = `
        <div class="gname">${escapeHtml(g.senderName || "不明")} が ギフト#${escapeHtml(String(g.giftId ?? "-"))} × ${escapeHtml(String(g.num ?? "-"))}</div>
        <div class="gmeta">${time} / ${g.giftType === 2 ? "有料" : "無料"} / <span class="${g.sheetError ? "sync-ng" : ""}">${syncLabel}</span></div>
      `;
      els.giftList.appendChild(li);
    }
  }
}

function escapeHtml(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);
}

async function refreshStatus() {
  try {
    const data = await api("/status");
    renderStatus(data);
    if (data.room?.input && !els.roomInput.value) {
      els.roomInput.value = data.room.input;
    }
  } catch (err) {
    els.lastError.textContent = err.message;
  }
}

els.loginBtn.addEventListener("click", async () => {
  const token = els.tokenInput.value.trim();
  if (!token) return;
  setToken(token);
  els.loginError.textContent = "";
  try {
    await api("/status");
    showApp();
  } catch (err) {
    clearToken();
    els.loginError.textContent = "合言葉が正しくないか、通信に失敗しました";
  }
});

els.logoutBtn.addEventListener("click", () => {
  clearToken();
  showLogin();
});

els.startBtn.addEventListener("click", async () => {
  try {
    const data = await api("/monitor/start", { method: "POST" });
    renderStatus(data);
  } catch (err) {
    els.lastError.textContent = err.message;
  }
});

els.stopBtn.addEventListener("click", async () => {
  try {
    const data = await api("/monitor/stop", { method: "POST" });
    renderStatus(data);
  } catch (err) {
    els.lastError.textContent = err.message;
  }
});

els.saveRoomBtn.addEventListener("click", async () => {
  els.roomError.textContent = "";
  const input = els.roomInput.value.trim();
  if (!input) {
    els.roomError.textContent = "ルームURLまたはIDを入力してください";
    return;
  }
  try {
    const data = await api("/room", { method: "POST", body: JSON.stringify({ input }) });
    renderStatus(data);
  } catch (err) {
    els.roomError.textContent = err.message;
  }
});

els.refreshBtn.addEventListener("click", refreshStatus);

if (getToken()) {
  showApp();
} else {
  showLogin();
}
