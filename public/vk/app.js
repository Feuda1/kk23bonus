const bridge = window.vkBridge;
const statusEl = document.querySelector("#status");
const phoneButton = document.querySelector("#phoneButton");
const manualForm = document.querySelector("#manualForm");
const manualPhone = document.querySelector("#manualPhone");
const launchParams = new URLSearchParams(window.location.search);

let userInfo = null;

init();

phoneButton.addEventListener("click", async () => {
  await requestVkPhone();
});

manualForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const phone = manualPhone.value.trim();
  if (!phone) {
    setStatus("Введите номер телефона.");
    return;
  }
  await registerPhone(phone);
});

async function init() {
  if (!bridge) {
    setStatus("Откройте мини-приложение внутри VK или введите номер ниже.");
    return;
  }

  try {
    await bridge.send("VKWebAppInit");
    userInfo = await bridge.send("VKWebAppGetUserInfo").catch(() => null);
    setStatus("Готово. Нажмите кнопку, чтобы подтвердить номер.");
  } catch {
    setStatus("VK Bridge не инициализировался. Можно ввести номер вручную.");
  }
}

async function requestVkPhone() {
  if (!bridge) {
    setStatus("VK Bridge недоступен. Введите номер ниже.");
    return;
  }

  setBusy(true);
  try {
    const data = await bridge.send("VKWebAppGetPhoneNumber");
    const phone = data.phone_number || data.phone || data.number;
    if (!phone) throw new Error("VK не вернул номер телефона");
    await registerPhone(phone);
  } catch (error) {
    setStatus(friendlyError(error));
  } finally {
    setBusy(false);
  }
}

async function registerPhone(phone) {
  const vkUserId = launchParams.get("vk_user_id") || userInfo?.id;
  if (!vkUserId) {
    setStatus("Не удалось определить VK ID. Откройте приложение из VK-бота.");
    return;
  }

  setBusy(true);
  setStatus("Выпускаем карту...");
  try {
    const response = await fetch("/api/vk/phone", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        vkUserId,
        phone,
        firstName: userInfo?.first_name,
        lastName: userInfo?.last_name,
      }),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || "Не удалось выпустить карту");
    setStatus(`Карта готова. PIN: ${data.guest.loyaltyCode}. Мы отправили её в сообщения VK.`);
    manualPhone.value = "";
  } catch (error) {
    setStatus(error instanceof Error ? error.message : "Не удалось выпустить карту.");
  } finally {
    setBusy(false);
  }
}

function setBusy(isBusy) {
  phoneButton.disabled = isBusy;
  manualForm.querySelector("button").disabled = isBusy;
}

function setStatus(message) {
  statusEl.textContent = message;
}

function friendlyError(error) {
  const message = error instanceof Error ? error.message : "";
  if (message.includes("User denied") || message.includes("access")) return "Доступ к телефону не выдан. Можно ввести номер ниже.";
  return "VK не передал номер. Можно ввести номер ниже.";
}
