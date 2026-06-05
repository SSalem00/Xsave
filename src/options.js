const DEFAULT_SETTINGS = {
  gifEnabled: true,
  gifQuality: "medium",
  filenameTemplate: "{username}_{tweetid}",
};

const gifEnabledEl = document.getElementById("gifEnabled");
const gifQualityEl = document.getElementById("gifQuality");
const filenameTemplateEl = document.getElementById("filenameTemplate");
const qualityRowEl = document.getElementById("qualityRow");
const saveBtn = document.getElementById("save");
const statusEl = document.getElementById("status");

chrome.storage.sync.get(DEFAULT_SETTINGS, (settings) => {
  gifEnabledEl.checked = settings.gifEnabled;
  gifQualityEl.value = settings.gifQuality;
  filenameTemplateEl.value = settings.filenameTemplate;
  updateQualityRow();
});

gifEnabledEl.addEventListener("change", updateQualityRow);

function updateQualityRow() {
  qualityRowEl.classList.toggle("disabled", !gifEnabledEl.checked);
}

document.querySelectorAll(".token").forEach((el) => {
  el.addEventListener("click", () => {
    const token = el.dataset.token;
    const input = filenameTemplateEl;
    const start = input.selectionStart;
    const end = input.selectionEnd;
    const val = input.value;
    input.value = val.slice(0, start) + token + val.slice(end);
    input.selectionStart = input.selectionEnd = start + token.length;
    input.focus();
  });
});

saveBtn.addEventListener("click", () => {
  const settings = {
    gifEnabled: gifEnabledEl.checked,
    gifQuality: gifQualityEl.value,
    filenameTemplate: filenameTemplateEl.value.trim() || DEFAULT_SETTINGS.filenameTemplate,
  };

  chrome.storage.sync.set(settings, () => {
    statusEl.style.display = "inline";
    setTimeout(() => { statusEl.style.display = "none"; }, 2000);
  });
});
