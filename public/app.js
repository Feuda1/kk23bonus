const state = {
  guest: null,
};

const levelTitles = {
  guest: "Гость",
  regular: "Постоянный",
  own: "Свой",
};

const statusEl = document.querySelector("#status");
const guestCard = document.querySelector("#guestCard");
const historyList = document.querySelector("#historyList");

document.querySelector("#searchForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const value = document.querySelector("#searchValue").value.trim();
  if (!value) return;
  const params = new URLSearchParams();
  if (/^\d{4}$/.test(value)) {
    params.set("pin", value);
    params.set("phoneLast4", value);
  } else {
    params.set("phone", value);
  }
  const data = await request(`/api/guests/search?${params.toString()}`);
  if (!data.guest) {
    setStatus("Гость не найден");
    return;
  }
  await showGuest(data.guest);
});

document.querySelector("#registerForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = document.querySelector("#guestName").value.trim();
  const phone = document.querySelector("#guestPhone").value.trim();
  if (!name || !phone) {
    setStatus("Введите имя и телефон");
    return;
  }
  const data = await request("/api/guests", {
    method: "POST",
    body: JSON.stringify({ name, phone }),
  });
  await showGuest(data.guest);
  event.target.reset();
});

document.querySelector("#earnForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.guest) return;
  const amount = Number(document.querySelector("#earnAmount").value);
  if (!Number.isInteger(amount) || amount <= 0) {
    setStatus("Введите сумму чека");
    return;
  }
  const data = await request("/api/transactions/earn", {
    method: "POST",
    body: JSON.stringify({ guestId: state.guest.id, amount }),
  });
  await showGuest(data.guest);
  document.querySelector("#earnAmount").value = "";
  setStatus(`Начислено ${data.transaction.points} баллов`);
});

document.querySelector("#spendForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!state.guest) return;
  const points = Number(document.querySelector("#spendPoints").value);
  if (!Number.isInteger(points) || points <= 0) {
    setStatus("Введите баллы к списанию");
    return;
  }
  const data = await request("/api/pending-spend", {
    method: "POST",
    body: JSON.stringify({ guestId: state.guest.id, points }),
  });
  document.querySelector("#spendPoints").value = "";
  setStatus(`Запрос на списание ${data.pending.points} баллов отправлен в Telegram`);
});

async function showGuest(guest) {
  state.guest = guest;
  guestCard.hidden = false;
  document.querySelector("#guestTitle").textContent = guest.name;
  document.querySelector("#guestPin").textContent = guest.loyaltyCode;
  document.querySelector("#guestBalance").textContent = `${guest.balance}`;
  document.querySelector("#guestLevel").textContent = levelTitles[guest.level] ?? guest.level;
  document.querySelector("#guestTotal").textContent = `${guest.totalSpent} ₽`;
  document.querySelector("#cardPreview").src = `/api/guests/${guest.id}/card.png?ts=${Date.now()}`;
  await loadHistory(guest.id);
  setStatus(`Открыта карта ${guest.name}`);
}

async function loadHistory(guestId) {
  const data = await request(`/api/guests/${guestId}/transactions?limit=8`);
  historyList.innerHTML = "";
  if (data.transactions.length === 0) {
    historyList.textContent = "Операций пока нет";
    return;
  }
  for (const transaction of data.transactions) {
    const row = document.createElement("div");
    row.className = "historyRow";
    const title = transaction.type === "earn" ? "Начисление" : transaction.type === "spend" ? "Списание" : transaction.type;
    row.innerHTML = `<strong>${title}</strong><span>${transaction.points > 0 ? "+" : ""}${transaction.points} б.</span>`;
    historyList.append(row);
  }
}

async function request(url, options = {}) {
  setStatus("Загрузка...");
  const response = await fetch(url, {
    headers: { "content-type": "application/json" },
    ...options,
  });
  const data = await response.json();
  if (!response.ok) {
    setStatus(data.error ?? "Ошибка");
    throw new Error(data.error ?? "Request failed");
  }
  setStatus("Готово");
  return data;
}

function setStatus(message) {
  statusEl.textContent = message;
}
