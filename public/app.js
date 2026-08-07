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
  historyDateSelect: document.getElementById("historyDateSelect"),
  historyError: document.getElementById("historyError"),
  historyResult: document.getElementById("historyResult"),
  historyGrandTotal: document.getElementById("historyGrandTotal"),
  historyList: document.getElementById("historyList"),
  copyHistoryBtn: document.getElementById("copyHistoryBtn"),
  copyHistoryStatus: document.getElementById("copyHistoryStatus"),
  historyCopyText: document.getElementById("historyCopyText"),
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
  loadHistoryDates();
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
      li.className = "gift-log-item";
      const time = new Date(g.receivedAt).toLocaleTimeString("ja-JP");
      const syncLabel = g.sheetSynced ? "シート反映済" : g.sheetError ? "シート反映失敗" : "反映中";
      const totalGLabel = g.totalG != null ? `${g.totalG.toLocaleString("ja-JP")}G` : "?G";
      const giftLabel = g.giftName || `ギフト#${g.giftId ?? "-"}`;
      const img = g.giftImage
        ? `<img src="${escapeHtml(g.giftImage)}" alt="" class="gift-thumb" />`
        : `<div class="gift-thumb gift-thumb-empty"></div>`;
      li.innerHTML = `
        ${img}
        <div class="gift-log-body">
          <div class="gname">${escapeHtml(g.senderName || "不明")} が ${totalGLabel}</div>
          <div class="gmeta">${escapeHtml(giftLabel)} × ${escapeHtml(String(g.num ?? "-"))} ・ ${time} ・ <span class="${g.sheetError ? "sync-ng" : ""}">${syncLabel}</span></div>
        </div>
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

async function loadHistoryDates() {
  els.historyError.textContent = "";
  try {
    const dates = await api("/history/dates");
    const current = els.historyDateSelect.value;
    els.historyDateSelect.innerHTML = '<option value="">日付を選択…</option>';
    for (const d of dates) {
      const opt = document.createElement("option");
      opt.value = d.date;
      opt.textContent = `${d.date} (${d.count}件)`;
      els.historyDateSelect.appendChild(opt);
    }
    if (current && [...els.historyDateSelect.options].some((o) => o.value === current)) {
      els.historyDateSelect.value = current;
    }
  } catch (err) {
    els.historyError.textContent = err.message;
  }
}

function renderHistorySummary(data) {
  els.historyGrandTotal.textContent = data.grandTotalG.toLocaleString("ja-JP");
  els.historyList.innerHTML = "";

  const copyLines = [`${data.date} のギフト集計`, ""];

  if (data.senders.length === 0) {
    const li = document.createElement("li");
    li.textContent = "この日のギフトはありません";
    li.className = "muted";
    els.historyList.appendChild(li);
  } else {
    for (const sender of data.senders) {
      copyLines.push(`${sender.senderName}: ${sender.totalG.toLocaleString("ja-JP")}G`);

      const li = document.createElement("li");
      li.className = "history-sender";
      const row = document.createElement("div");
      row.className = "gname history-sender-row";
      row.innerHTML = `<span>${escapeHtml(sender.senderName)}</span><span>${sender.totalG.toLocaleString("ja-JP")}G</span>`;

      const breakdown = document.createElement("ul");
      breakdown.className = "history-breakdown hidden";
      for (const item of sender.breakdown) {
        const bli = document.createElement("li");
        const name = item.giftName || `ギフト#${item.giftId}`;
        bli.textContent = `${name} × ${item.num} = ${item.totalG.toLocaleString("ja-JP")}G`;
        breakdown.appendChild(bli);
      }

      row.addEventListener("click", () => breakdown.classList.toggle("hidden"));
      li.appendChild(row);
      li.appendChild(breakdown);
      els.historyList.appendChild(li);
    }
  }

  copyLines.push("", `合計: ${data.grandTotalG.toLocaleString("ja-JP")}G`);
  els.historyCopyText.value = copyLines.join("\n");
  els.historyResult.classList.remove("hidden");
  els.copyHistoryStatus.textContent = "";
}

els.historyDateSelect.addEventListener("change", async () => {
  const date = els.historyDateSelect.value;
  els.historyError.textContent = "";
  els.historyResult.classList.add("hidden");
  if (!date) return;
  try {
    const data = await api(`/history/summary?date=${encodeURIComponent(date)}`);
    renderHistorySummary(data);
  } catch (err) {
    els.historyError.textContent = err.message;
  }
});

els.copyHistoryBtn.addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(els.historyCopyText.value);
    els.copyHistoryStatus.textContent = "コピーしました";
  } catch {
    els.historyCopyText.classList.remove("hidden");
    els.historyCopyText.focus();
    els.historyCopyText.select();
    els.copyHistoryStatus.textContent = "自動コピーできませんでした。選択された内容を手動でコピーしてください";
  }
});

if (getToken()) {
  showApp();
} else {
  showLogin();
}
